// otaapi.go — v1.17.4 THE LIVE UPDATE: the engine-side delta OTA surface
// (PLAN-V117 §v1.17.4). Download only what changed, never the whole APK.
//
// THE THREE ENDPOINTS (registered in their own block in routes(), next to
// the static overlay):
//
//      GET  /api/ota/status    → the cached manifest + a live-computed plan:
//                                 {enabled, state, current_version, manifest,
//                                  checked_at, last_error?}
//      POST /api/ota/check     → force a manifest refetch, same shape
//      POST /api/ota/download  → execute the plan: refetch + download every
//                                 changed file to <dataDir>/ota/<web-rel> with
//                                 sha256 verification + atomic rename
//
// THE STATE LADDER (honesty law — every problem is a STATE, never a
// silent failure):
//
//      disabled               DOOMALAY_OTA_DISABLE=1 or no URL (enabled:false)
//      unreachable            the manifest fetch failed (last_error says why)
//      engine_update_required manifest.min_engine semver > buildinfo.Version
//                             — the engine binary is NEVER hot-patched; the
//                             only path is the full APK
//      update_available       plan has changed files (bytes capped at 20MB)
//      current                everything matches the live stack
//
// THE APPLY MECHANISM: the static handler that serves the embedded web/
// tree is wrapped (server.go → s.otaOverlay) with an ota-first check — a
// file at <dataDir>/ota/<web-relative-path> wins over the embedded bytes,
// so pure web-asset patches go live WITHOUT an engine restart. The live
// hash used by the plan is the SAME stack (overlay file → embedded), so
// after a successful download the status honestly flips to current.
//
// THE GUARDS:
//   - only paths under engine/internal/server/web/ are patchable; any
//     other manifest path is excluded from the plan with an honest
//     `skipped` count (a hostile manifest cannot write outside the tree).
//   - traversal-guarded everywhere: a manifest entry (or request URL)
//     with "..", "." or "//" segments never resolves to a disk file.
//   - per-file cap 10MB, whole-plan cap 20MB, manifest read cap 1MB.
//   - sha256 verification of EVERY downloaded byte (internal/ota).
package server

import (
        "context"
        "fmt"
        "io/fs"
        "net/http"
        "os"
        "path"
        "path/filepath"
        "strconv"
        "strings"
        "sync"
        "time"

        "github.com/ScoobyBaby1999/doomalay/engine/internal/buildinfo"
        "github.com/ScoobyBaby1999/doomalay/engine/internal/config"
        "github.com/ScoobyBaby1999/doomalay/engine/internal/ota"
)

// The only patchable root: manifest paths are repo-root-relative, and the
// engine can only hot-patch the embedded web tree it serves itself.
const otaWebPrefix = "engine/internal/server/web/"

const (
        // otaStatusTTL bounds how stale a GET /api/ota/status answer may be
        // (POST /check and POST /download always refetch). The background
        // refresher (5 min) keeps the cache warm between polls.
        otaStatusTTL = 60 * time.Second
        // otaTotalCap caps one plan's download total. A delta bigger than
        // this is a full-APK-sized update — the honest refusal says so.
        otaTotalCap = 20 << 20 // 20MB
        // otaFileCap is the per-file cap (mirrors ota.FileMaxBytes; repeated
        // here so the status narrative can quote it).
        otaFileCap = 10 << 20 // 10MB
        // otaCheckPeriod is the background refresher's tick.
        otaCheckPeriod = 5 * time.Minute
)

// otaManager is the per-server OTA state (Server.ota; nil = disabled).
// The manifest cache is mutex-guarded with in-flight dedup (the termux
// probe pattern): concurrent status polls share ONE fetch, and the mutex
// is never held across the network call. Failures cache too — a dead
// mirror answering every poll with a fresh 15s timeout would starve the
// PWA.
type otaManager struct {
        url  string // the manifest URL (config: default release URL / env / yaml)
        root string // <dataDir>/ota — where patches land and live

        mu      sync.Mutex
        man     *ota.Manifest
        at      time.Time // when the last fetch attempt finished (success or not)
        lastErr string    // "" when the last fetch succeeded
        flight  chan struct{}
}

// newOtaManager builds the manager (nil = disabled: the kill switch, or
// no URL — direct-constructed test configs carry no URL and must never
// touch the network).
func newOtaManager(cfg *config.Config) *otaManager {
        if cfg.OTADisable || cfg.OTAURL == "" {
                return nil
        }
        return &otaManager{
                url:  cfg.OTAURL,
                root: filepath.Join(cfg.DataDir, "ota"),
        }
}

// ── the background refresher ───────────────────────────────────────────

// otaBackground runs on its own goroutine from New(): one check at boot
// (never blocking — it is already off the boot path) then every 5 min.
// Every failure lands in the cache as the honest unreachable state.
func (s *Server) otaBackground() {
        s.otaRefresh(false)
        t := time.NewTicker(otaCheckPeriod)
        defer t.Stop()
        for range t.C {
                s.otaRefresh(false)
        }
}

// otaManifestCached returns (manifest, checkedAt, lastErr) from the cache,
// fetching on miss/staleness; force=true ignores freshness (POST /check,
// POST /download). Concurrent callers SHARE one in-flight fetch (the
// waiters join its result) and the mutex is never held across the
// network call — the termux probe law, applied to the manifest.
func (s *Server) otaManifestCached(force bool) (*ota.Manifest, time.Time, string) {
        m := s.ota
        m.mu.Lock()
        if !force && m.man != nil && time.Since(m.at) < otaStatusTTL {
                man, at, err := m.man, m.at, m.lastErr
                m.mu.Unlock()
                return man, at, err
        }
        if m.flight != nil {
                // Join the in-flight fetch; its result is fresh by construction.
                flight := m.flight
                m.mu.Unlock()
                <-flight
                m.mu.Lock()
                man, at, err := m.man, m.at, m.lastErr
                m.mu.Unlock()
                return man, at, err
        }
        flight := make(chan struct{})
        m.flight = flight
        m.mu.Unlock()

        // The fetch runs OUTSIDE the mutex, on its own deadline (not a
        // caller's context — a canceled poll must not poison the cache fill).
        man, err := ota.FetchManifest(context.Background(), m.url)
        lastErr := ""
        if err != nil {
                man, lastErr = nil, err.Error()
        }

        m.mu.Lock()
        m.man, m.at, m.lastErr, m.flight = man, time.Now(), lastErr, nil
        at := m.at
        close(flight)
        m.mu.Unlock()
        return man, at, lastErr
}

// otaRefresh fills the cache without a request (the background path).
func (s *Server) otaRefresh(force bool) {
        s.otaManifestCached(force)
}

// ── the plan: live hash + patchability ────────────────────────────────

// otaPatchable maps a repo-root-relative manifest path to its web-relative
// disk path under <dataDir>/ota/. Only clean paths under
// engine/internal/server/web/ qualify: any "..", "." or "//" segment, any
// backslash, any absolute path → not patchable (the caller reports it in
// the honest `skipped` count; nothing is ever written or served).
func otaPatchable(repoPath string) (string, bool) {
        if !strings.HasPrefix(repoPath, otaWebPrefix) {
                return "", false
        }
        rel := strings.TrimPrefix(repoPath, otaWebPrefix)
        if rel == "" || strings.ContainsRune(rel, '\\') || strings.ContainsRune(rel, 0) {
                return "", false
        }
        if path.Clean(rel) != rel {
                // any ".", ".." or "//" segment — never resolve this to disk
                return "", false
        }
        if strings.HasPrefix(rel, "/") || strings.HasPrefix(rel, "..") {
                return "", false
        }
        return rel, true
}

// otaLiveHash is the live-stack hash for one manifest path: the overlay
// file at <dataDir>/ota/<rel> if present, ELSE the embedded web/ asset.
// ("", false) when neither exists (a new file → the plan counts it as
// changed). This is the exact stack the static overlay serves, so the
// plan can never disagree with what the user's browser gets.
func (s *Server) otaLiveHash(repoPath string) (string, bool) {
        rel, ok := otaPatchable(repoPath)
        if !ok {
                return "", false
        }
        if b, err := os.ReadFile(filepath.Join(s.cfg.DataDir, "ota", filepath.FromSlash(rel))); err == nil {
                return ota.SHA256(b), true
        }
        if b, err := fs.ReadFile(webFS, "web/"+rel); err == nil {
                return ota.SHA256(b), true
        }
        return "", false
}

// otaPlan diffs a manifest against the live stack, skipping non-patchable
// entries (returned as the skipped count — outside the web tree, or a
// traversal-shaped path from a hostile manifest).
func (s *Server) otaPlan(m *ota.Manifest) (*ota.Plan, int) {
        filtered := &ota.Manifest{Version: m.Version, Ref: m.Ref, MinEngine: m.MinEngine}
        skipped := 0
        for _, f := range m.Files {
                if _, ok := otaPatchable(f.Path); ok {
                        filtered.Files = append(filtered.Files, f)
                } else {
                        skipped++
                }
        }
        return ota.ComputePlan(filtered, s.otaLiveHash), skipped
}

// ── the state ladder ───────────────────────────────────────────────────

// semverGreater reports whether a (e.g. "v1.17.4") strictly exceeds b
// (e.g. "1.16.0"). Tiny, no deps: optional "v" prefix, dot-separated
// numeric fields (missing = 0, non-numeric = 0), and semver's
// pre-release rule — "1.17.4-rc1" < "1.17.4". buildinfo carries no v
// prefix by default; CI stamps the release tag (with) — both parse.
func semverGreater(a, b string) bool {
        av, apre := splitSemver(a)
        bv, bpre := splitSemver(b)
        for i := 0; i < 3; i++ {
                if av[i] != bv[i] {
                        return av[i] > bv[i]
                }
        }
        // Numerically equal: a plain release exceeds a pre-release; anything
        // else is equal, not greater.
        if apre != bpre {
                return !apre
        }
        return false
}

func splitSemver(v string) ([3]int, bool) {
        v = strings.TrimSpace(strings.TrimPrefix(strings.TrimPrefix(v, "v"), "V"))
        var pre bool
        if i := strings.IndexAny(v, "-+"); i >= 0 {
                pre = v[i] == '-'
                v = v[:i]
        }
        var out [3]int
        for i, part := range strings.SplitN(v, ".", 3) {
                if i > 2 {
                        break
                }
                n, err := strconv.Atoi(strings.TrimSpace(part))
                if err != nil || n < 0 {
                        n = 0
                }
                out[i] = n
        }
        return out, pre
}

// otaStatusPayload assembles the /api/ota/status answer. force=true
// refetches the manifest first (POST /check).
func (s *Server) otaStatusPayload(force bool) map[string]any {
        if s.ota == nil {
                // Honest: the kill switch (or no URL) — enabled:false, zero network.
                return map[string]any{
                        "enabled":         false,
                        "state":           "disabled",
                        "current_version": buildinfo.Version,
                        "manifest":        nil,
                        "checked_at":      int64(0),
                }
        }
        m, at, lastErr := s.otaManifestCached(force)
        checkedAt := int64(0)
        if !at.IsZero() {
                checkedAt = at.Unix()
        }
        if m == nil {
                // Honest: the fetch failed — unreachable is a STATE, the
                // manifest is absent, and last_error says why.
                return map[string]any{
                        "enabled":         true,
                        "state":           "unreachable",
                        "current_version": buildinfo.Version,
                        "manifest":        nil,
                        "checked_at":      checkedAt,
                        "last_error":      lastErr,
                }
        }
        plan, skipped := s.otaPlan(m)
        state := "current"
        if semverGreater(m.MinEngine, buildinfo.Version) {
                state = "engine_update_required"
        } else if len(plan.Changed) > 0 {
                state = "update_available"
        }
        return map[string]any{
                "enabled":         true,
                "state":           state,
                "current_version": buildinfo.Version,
                "manifest": map[string]any{
                        "version":       m.Version,
                        "ref":           m.Ref,
                        "min_engine":    m.MinEngine,
                        "files":         len(m.Files),
                        "changed":       len(plan.Changed),
                        "changed_bytes": plan.TotalBytes,
                        "skipped":       skipped,
                },
                "checked_at": checkedAt,
                "last_error": "",
        }
}

// ── the handlers ───────────────────────────────────────────────────────

// handleOtaStatus is GET /api/ota/status — the cached manifest + the
// live-computed plan (the plan is recomputed per call so a successful
// download flips the state to current with no cache games).
func (s *Server) handleOtaStatus(w http.ResponseWriter, r *http.Request) {
        writeJSON(w, http.StatusOK, s.otaStatusPayload(false))
}

// handleOtaCheck is POST /api/ota/check — force a manifest refetch, then
// the same status shape.
func (s *Server) handleOtaCheck(w http.ResponseWriter, r *http.Request) {
        writeJSON(w, http.StatusOK, s.otaStatusPayload(true))
}

// handleOtaDownload is POST /api/ota/download — execute the plan:
// refetch the manifest, download every changed (patchable) file to
// <dataDir>/ota/<web-rel> (sha256-verified, atomic, .tmp-cleaned), then
// answer {ok, downloaded, bytes, state:"current"} — the ota-first static
// overlay is already serving the new bytes.
func (s *Server) handleOtaDownload(w http.ResponseWriter, r *http.Request) {
        if s.ota == nil {
                writeJSON(w, http.StatusBadRequest, map[string]any{
                        "ok": false, "state": "disabled",
                        "error": "ota disabled (DOOMALAY_OTA_DISABLE) or no manifest URL configured",
                })
                return
        }
        m, _, lastErr := s.otaManifestCached(true)
        if m == nil {
                writeJSON(w, http.StatusBadGateway, map[string]any{
                        "ok": false, "state": "unreachable",
                        "error": "manifest unreachable: " + lastErr,
                })
                return
        }
        if semverGreater(m.MinEngine, buildinfo.Version) {
                // THE ENGINE IS NEVER HOT-PATCHED: a manifest whose min_engine
                // exceeds this binary refuses the delta — the only path is the
                // full APK. Honest refusal, never a partial download.
                writeJSON(w, http.StatusConflict, map[string]any{
                        "ok": false, "state": "engine_update_required",
                        "error": fmt.Sprintf("this update needs engine %s (running %s) — install the full APK release", m.MinEngine, buildinfo.Version),
                })
                return
        }

        plan, _ := s.otaPlan(m)
        if len(plan.Changed) == 0 {
                writeJSON(w, http.StatusOK, map[string]any{
                        "ok": true, "downloaded": 0, "bytes": int64(0), "state": "current",
                })
                return
        }
        if plan.TotalBytes > otaTotalCap {
                writeJSON(w, http.StatusRequestEntityTooLarge, map[string]any{
                        "ok": false, "state": "update_available",
                        "error": fmt.Sprintf("delta is %d bytes, over the %d byte cap — this is a full-APK-sized update", plan.TotalBytes, otaTotalCap),
                })
                return
        }

        downloaded, bytes := 0, int64(0)
        for _, f := range plan.Changed {
                rel, _ := otaPatchable(f.Path) // plan.Changed is pre-filtered; the map is a belt-and-braces guard
                if rel == "" {
                        continue
                }
                fileURL := ota.FileURL(s.ota.url, m.Ref, f.Path)
                dest := filepath.Join(s.ota.root, filepath.FromSlash(rel))
                if err := ota.DownloadFile(r.Context(), fileURL, dest, f.SHA256, otaFileCap); err != nil {
                        // Honest per-file failure: which file, why, and that nothing
                        // corrupt landed (the .tmp is already deleted). Files that
                        // landed before this one stay landed — the next status
                        // recomputes the plan against exactly what is on disk.
                        writeJSON(w, http.StatusBadGateway, map[string]any{
                                "ok": false, "state": "update_available",
                                "error": fmt.Sprintf("%s: %v", f.Path, err),
                        })
                        return
                }
                downloaded++
                bytes += f.Size
        }
        writeJSON(w, http.StatusOK, map[string]any{
                "ok":        true,
                "downloaded": downloaded,
                "bytes":     bytes,
                "state":     "current",
        })
}

// ── THE APPLY MECHANISM: the ota-first static overlay ─────────────────

// otaOverlay wraps the embedded-PWA file server: a downloaded patch at
// <dataDir>/ota/<web-relative-path> wins over the embedded bytes. THIS is
// how a delta goes live without an engine restart. The traversal guard:
// only clean relative paths (no "..", ".", "//", no backslash) resolve to
// a disk file; everything else falls through to the embedded handler,
// which has its own (http.FileServer) protections.
func (s *Server) otaOverlay(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
                if r.Method == http.MethodGet || r.Method == http.MethodHead {
                        if rel, ok := otaRequestRel(r.URL.Path); ok {
                                root := filepath.Join(s.cfg.DataDir, "ota")
                                for _, cand := range otaCandidates(rel) {
                                        disk := filepath.Join(root, filepath.FromSlash(cand))
                                        if fi, err := os.Stat(disk); err == nil && fi.Mode().IsRegular() {
                                                if f, err := os.Open(disk); err == nil {
                                                        defer f.Close()
                                                        if fi, err := f.Stat(); err == nil && fi.Mode().IsRegular() {
                                                                // ServeContent sets the content-type from the
                                                                // file's extension — the same mapping the
                                                                // embedded FileServer uses — and honors range
                                                                // requests; noCacheFS (the outer wrapper)
                                                                // forces revalidation.
                                                                http.ServeContent(w, r, path.Base(disk), fi.ModTime(), f)
                                                                return
                                                        }
                                                }
                                        }
                                }
                        }
                }
                next.ServeHTTP(w, r)
        })
}

// otaRequestRel cleans a request URL path into a web-relative path for
// the overlay lookup. ("", true) for the root (the caller then tries
// index.html — http.FileServer's directory-index behavior); ("", false)
// for anything not clean/relative (traversal-shaped, backslashes, or
// NUL).
func otaRequestRel(p string) (string, bool) {
        if p == "" || strings.ContainsRune(p, 0) {
                return "", false
        }
        if strings.Contains(p, "\\") {
                return "", false
        }
        p = strings.TrimPrefix(p, "/")
        if p == "" {
                return "", true // "/" → index.html
        }
        if path.Clean(p) != p {
                return "", false // ".", ".." or "//" segments — never a disk file
        }
        if strings.HasPrefix(p, "/") || strings.HasPrefix(p, "..") {
                return "", false
        }
        return p, true
}

// otaCandidates lists the overlay paths a request may hit: the cleaned
// relative path, plus its directory index (http.FileServer serves
// <dir>/index.html for <dir>/ — the overlay keeps the same behavior so a
// patched index.html at "/" resolves).
func otaCandidates(rel string) []string {
        if rel == "" {
                return []string{"index.html"}
        }
        return []string{rel, path.Join(rel, "index.html")}
}
