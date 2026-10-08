package server

// otaapi_test.go — v1.17.4 THE LIVE UPDATE: /api/ota/* + the ota-first
// static overlay, against a local stub of the release (manifest + files).
//
// The round-trip is the pin that matters: status=update_available →
// download → THE ACTUAL WEB ROUTE SERVES THE PATCHED BYTES →
// status=current. Plus the honest failure ladder: corrupt hash (refused,
// nothing landed, embedded still served), the min_engine gate (download
// refused — the engine binary is never hot-patched), unreachable (a
// STATE, HTTP 200), traversal (skipped, never written, never served),
// and the kill switch.

import (
        "crypto/sha256"
        "encoding/hex"
        "encoding/json"
        "fmt"
        "io/fs"
        "net/http"
        "net/http/httptest"
        "os"
        "path/filepath"
        "strings"
        "sync"
        "testing"

        "github.com/ScoobyBaby1999/doomalay/engine/internal/buildinfo"
        "github.com/ScoobyBaby1999/doomalay/engine/internal/config"
        "github.com/ScoobyBaby1999/doomalay/engine/internal/store"
)

func otaHash(b []byte) string {
        sum := sha256.Sum256(b)
        return hex.EncodeToString(sum[:])
}

// otaEmbeddedHash reads the REAL embedded web asset and hashes it — the
// "unchanged" manifest entries are built from it so the plan diff is real.
func otaEmbeddedHash(t *testing.T, rel string) string {
        t.Helper()
        b, err := fs.ReadFile(webFS, "web/"+rel)
        if err != nil {
                t.Fatalf("embedded web/%s: %v", rel, err)
        }
        return otaHash(b)
}

func newOtaTestServer(t *testing.T, otaURL string, disable bool) *Server {
        t.Helper()
        dir := t.TempDir()
        db, err := store.Open(dir)
        if err != nil {
                t.Fatalf("store: %v", err)
        }
        if err := db.Migrate(); err != nil {
                t.Fatalf("migrate: %v", err)
        }
        cfg := &config.Config{DataDir: dir, OTAURL: otaURL, OTADisable: disable}
        return New(cfg, db, nil)
}

// otaStub serves the release contract locally: GET /patch-manifest.json
// plus GET /<repo-relative-path> for every file it carries. The manifest
// hit counter pins the cache + force-refetch behavior.
type otaStub struct {
        srv      *httptest.Server
        mu       sync.Mutex
        manifest string
        files    map[string][]byte
        hits     int
}

func newOtaStub(t *testing.T, manifest string, files map[string][]byte) *otaStub {
        t.Helper()
        st := &otaStub{manifest: manifest, files: files}
        mux := http.NewServeMux()
        mux.HandleFunc("GET /patch-manifest.json", func(w http.ResponseWriter, r *http.Request) {
                st.mu.Lock()
                st.hits++
                st.mu.Unlock()
                w.Header().Set("Content-Type", "application/json")
                _, _ = w.Write([]byte(st.manifest))
        })
        mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
                st.mu.Lock()
                b, ok := st.files[strings.TrimPrefix(r.URL.Path, "/")]
                st.mu.Unlock()
                if !ok {
                        http.NotFound(w, r)
                        return
                }
                _, _ = w.Write(b)
        })
        st.srv = httptest.NewServer(mux)
        t.Cleanup(st.srv.Close)
        return st
}

func (st *otaStub) manifestHits() int {
        st.mu.Lock()
        defer st.mu.Unlock()
        return st.hits
}

func otaStatus(t *testing.T, s *Server, method, path string) (int, map[string]any) {
        t.Helper()
        req := httptest.NewRequest(method, path, nil)
        rec := httptest.NewRecorder()
        s.mux.ServeHTTP(rec, req)
        var out map[string]any
        if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
                t.Fatalf("%s %s response not JSON (%d): %s", method, path, rec.Code, rec.Body.String())
        }
        return rec.Code, out
}

// otaWebGet hits the ACTUAL static web route through the mux (the overlay
// path — no /api/).
func otaWebGet(t *testing.T, s *Server, urlPath string) (int, string) {
        t.Helper()
        req := httptest.NewRequest(http.MethodGet, urlPath, nil)
        rec := httptest.NewRecorder()
        s.mux.ServeHTTP(rec, req)
        return rec.Code, rec.Body.String()
}

// otaNoTmpLeftovers asserts no .tmp survived anywhere under the data dir.
func otaNoTmpLeftovers(t *testing.T, dir string) {
        t.Helper()
        _ = filepath.Walk(dir, func(p string, fi os.FileInfo, err error) error {
                if err == nil && !fi.IsDir() && strings.HasSuffix(p, ".tmp") {
                        t.Errorf("leftover .tmp after the operation: %s", p)
                }
                return nil
        })
}

// ── THE ROUND TRIP ─────────────────────────────────────────────────────

// Full loop: one changed file (new bytes + hash), one unchanged file (the
// REAL embedded hash of lattice.js) → update_available → download → the
// web route serves the patched atoms.js bytes → status flips to current.
func TestV1174_OtaFullRoundTrip(t *testing.T) {
        newAtoms := []byte("// atoms.js — patched by THE LIVE UPDATE (v1.17.4 test stub)\nwindow.__otaPatched = true;\n")
        unchangedHash := otaEmbeddedHash(t, "lattice.js")
        manifest := fmt.Sprintf(`{
          "version": "v1.17.4-test", "ref": "v1.17.4-test", "min_engine": "1.16.0",
          "files": [
            {"path": "engine/internal/server/web/atoms.js", "sha256": %q, "size": %d},
            {"path": "engine/internal/server/web/lattice.js", "sha256": %q, "size": 900}
          ]
        }`, otaHash(newAtoms), len(newAtoms), unchangedHash)
        st := newOtaStub(t, manifest, map[string][]byte{
                "engine/internal/server/web/atoms.js": newAtoms,
        })
        s := newOtaTestServer(t, st.srv.URL+"/patch-manifest.json", false)

        // Before: the web route serves the EMBEDDED atoms.js.
        code, before := otaWebGet(t, s, "/atoms.js")
        if code != 200 {
                t.Fatalf("atoms.js before: HTTP %d", code)
        }
        if strings.Contains(before, "__otaPatched") {
                t.Fatal("the embedded atoms.js must not already carry the patch marker")
        }

        // 1. status → update_available, changed=1, honest manifest summary.
        code, out := otaStatus(t, s, http.MethodGet, "/api/ota/status")
        if code != 200 {
                t.Fatalf("status: HTTP %d: %v", code, out)
        }
        if out["state"] != "update_available" || out["enabled"] != true {
                t.Fatalf("state should be update_available: %v", out)
        }
        if out["current_version"] != buildinfo.Version {
                t.Fatalf("current_version must be buildinfo.Version: %v", out)
        }
        man := out["manifest"].(map[string]any)
        if man["version"] != "v1.17.4-test" || man["ref"] != "v1.17.4-test" || man["min_engine"] != "1.16.0" {
                t.Fatalf("manifest summary must round-trip: %v", man)
        }
        if man["files"].(float64) != 2 || man["changed"].(float64) != 1 {
                t.Fatalf("files=2 changed=1: %v", man)
        }
        if man["changed_bytes"].(float64) != float64(len(newAtoms)) {
                t.Fatalf("changed_bytes must be the changed file's size: %v", man)
        }
        if man["skipped"].(float64) != 0 {
                t.Fatalf("nothing skipped here: %v", man)
        }
        if out["last_error"] != "" {
                t.Fatalf("last_error should be empty: %v", out)
        }

        // 2. download → ok, downloaded=1, bytes, state current.
        code, out = otaStatus(t, s, http.MethodPost, "/api/ota/download")
        if code != 200 {
                t.Fatalf("download: HTTP %d: %v", code, out)
        }
        if out["ok"] != true || out["downloaded"].(float64) != 1 || out["state"] != "current" {
                t.Fatalf("download should land 1 file and flip current: %v", out)
        }
        if out["bytes"].(float64) != float64(len(newAtoms)) {
                t.Fatalf("download bytes must be the changed size: %v", out)
        }

        // 3. THE APPLY MECHANISM: the actual web route now serves the
        //    patched bytes — no engine restart, no cache games.
        code, after := otaWebGet(t, s, "/atoms.js")
        if code != 200 || !strings.Contains(after, "__otaPatched") {
                t.Fatalf("the web route must serve the patched bytes (HTTP %d): %q", code, after[:min(len(after), 200)])
        }
        // 4. status → current (the live hash now matches the manifest).
        code, out = otaStatus(t, s, http.MethodGet, "/api/ota/status")
        if code != 200 || out["state"] != "current" {
                t.Fatalf("status after download should be current: %v", out)
        }
        if out["manifest"].(map[string]any)["changed"].(float64) != 0 {
                t.Fatalf("changed must be 0 after apply: %v", out)
        }

        // 5. no .tmp leftovers; a re-download is a no-op saying current.
        otaNoTmpLeftovers(t, s.cfg.DataDir)
        code, out = otaStatus(t, s, http.MethodPost, "/api/ota/download")
        if code != 200 || out["downloaded"].(float64) != 0 || out["state"] != "current" {
                t.Fatalf("re-download with nothing changed: %v", out)
        }
}

// THE ROOT ROUTE still serves the embedded index.html (the overlay falls
// through when nothing patched it).
func TestV1174_OtaOverlayFallsThroughToEmbedded(t *testing.T) {
        manifest := `{"version":"v1.17.4-test","ref":"v1.17.4-test","min_engine":"1.16.0","files":[]}`
        st := newOtaStub(t, manifest, nil)
        s := newOtaTestServer(t, st.srv.URL+"/patch-manifest.json", false)

        code, body := otaWebGet(t, s, "/")
        if code != 200 || !strings.Contains(body, "<!DOCTYPE html>") {
                t.Fatalf("/ must serve the embedded index.html (HTTP %d)", code)
        }
        // An untouched asset rides the embedded path too.
        code, body = otaWebGet(t, s, "/lattice.js")
        if code != 200 || len(body) == 0 {
                t.Fatalf("/lattice.js must serve the embedded asset (HTTP %d)", code)
        }
        // An overlay file with an unknown name never existed — 404 through
        // the embedded FileServer.
        code, _ = otaWebGet(t, s, "/does-not-exist.js")
        if code != 404 {
                t.Fatalf("an unknown asset must 404 (got %d)", code)
        }
}

// ── the honest failure ladder ──────────────────────────────────────────

// Corrupt hash: the stub serves bytes whose sha256 does NOT match the
// manifest → download refuses with the mismatch reason, NOTHING lands,
// and the web route keeps serving the embedded bytes.
func TestV1174_OtaCorruptHashRefused(t *testing.T) {
        evil := []byte("// these bytes are NOT what the manifest promised\n")
        manifest := fmt.Sprintf(`{
          "version": "v1.17.4-test", "ref": "v1.17.4-test", "min_engine": "1.16.0",
          "files": [{"path": "engine/internal/server/web/atoms.js", "sha256": %q, "size": %d}]
        }`, strings.Repeat("0", 64), len(evil))
        st := newOtaStub(t, manifest, map[string][]byte{
                "engine/internal/server/web/atoms.js": evil,
        })
        s := newOtaTestServer(t, st.srv.URL+"/patch-manifest.json", false)

        code, out := otaStatus(t, s, http.MethodGet, "/api/ota/status")
        if code != 200 || out["state"] != "update_available" {
                t.Fatalf("status should see the (lying) update: %v", out)
        }
        code, out = otaStatus(t, s, http.MethodPost, "/api/ota/download")
        if code != http.StatusBadGateway {
                t.Fatalf("a corrupt download must be an honest error (got HTTP %d): %v", code, out)
        }
        if out["ok"] != false || !strings.Contains(out["error"].(string), "mismatch") {
                t.Fatalf("the error must name the mismatch: %v", out)
        }
        // Nothing landed; the embedded asset still serves.
        if _, err := os.Stat(filepath.Join(s.cfg.DataDir, "ota", "atoms.js")); !os.IsNotExist(err) {
                t.Fatal("a corrupt file must NOT land (corrupt = gone)")
        }
        code, body := otaWebGet(t, s, "/atoms.js")
        if code != 200 || strings.Contains(body, "NOT what the manifest promised") {
                t.Fatalf("the embedded atoms.js must still serve (HTTP %d)", code)
        }
        otaNoTmpLeftovers(t, s.cfg.DataDir)
        // And the status stays honestly at update_available.
        code, out = otaStatus(t, s, http.MethodGet, "/api/ota/status")
        if code != 200 || out["state"] != "update_available" {
                t.Fatalf("state after a corrupt refusal: %v", out)
        }
}

// min_engine gate: a manifest that needs a future engine →
// engine_update_required, download REFUSED (the engine binary is never
// hot-patched), nothing lands.
func TestV1174_OtaMinEngineGate(t *testing.T) {
        newAtoms := []byte("window.__neverLands = true;\n")
        manifest := fmt.Sprintf(`{
          "version": "v1.17.4-test", "ref": "v1.17.4-test", "min_engine": "v99.0.0",
          "files": [{"path": "engine/internal/server/web/atoms.js", "sha256": %q, "size": %d}]
        }`, otaHash(newAtoms), len(newAtoms))
        st := newOtaStub(t, manifest, map[string][]byte{
                "engine/internal/server/web/atoms.js": newAtoms,
        })
        s := newOtaTestServer(t, st.srv.URL+"/patch-manifest.json", false)

        code, out := otaStatus(t, s, http.MethodGet, "/api/ota/status")
        if code != 200 || out["state"] != "engine_update_required" {
                t.Fatalf("a future min_engine must gate the state: %v", out)
        }
        if out["manifest"].(map[string]any)["min_engine"] != "v99.0.0" {
                t.Fatalf("min_engine must round-trip: %v", out)
        }
        code, out = otaStatus(t, s, http.MethodPost, "/api/ota/download")
        if code != http.StatusConflict {
                t.Fatalf("the download must be refused (got HTTP %d): %v", code, out)
        }
        if out["ok"] != false || !strings.Contains(out["error"].(string), buildinfo.Version) {
                t.Fatalf("the refusal must name the running version honestly: %v", out)
        }
        if _, err := os.Stat(filepath.Join(s.cfg.DataDir, "ota", "atoms.js")); !os.IsNotExist(err) {
                t.Fatal("a gated download must land nothing")
        }
        // The gate beats "changed files exist": the manifest summary still
        // reports the delta (the PWA can show what's waiting), but the state
        // is the engine gate.
        if out["state"] != "engine_update_required" {
                t.Fatalf("download refusal state: %v", out)
        }
}

// Unreachable: a dead manifest URL → HTTP 200 with state "unreachable"
// and last_error (a STATE, never a 500, never silent).
func TestV1174_OtaUnreachableIsAStateNotAnError(t *testing.T) {
        s := newOtaTestServer(t, "http://127.0.0.1:1/patch-manifest.json", false)
        code, out := otaStatus(t, s, http.MethodGet, "/api/ota/status")
        if code != 200 {
                t.Fatalf("unreachable must answer HTTP 200 (got %d): %v", code, out)
        }
        if out["state"] != "unreachable" || out["enabled"] != true {
                t.Fatalf("state should be unreachable: %v", out)
        }
        if out["manifest"] != nil {
                t.Fatalf("no manifest when unreachable: %v", out)
        }
        if out["last_error"] == "" {
                t.Fatalf("last_error must say why: %v", out)
        }
        if out["current_version"] != buildinfo.Version {
                t.Fatalf("current_version is known even when the mirror is dead: %v", out)
        }
        // A download against a dead mirror is an honest 502, not a crash.
        code, out = otaStatus(t, s, http.MethodPost, "/api/ota/download")
        if code != http.StatusBadGateway || out["ok"] != false || out["state"] != "unreachable" {
                t.Fatalf("download against a dead mirror: HTTP %d %v", code, out)
        }
}

// Traversal: manifest entries shaped like "../evil.js" or
// "engine/internal/server/web/../../evil2.js" are NOT patchable → skipped
// (counted honestly), never downloaded, never written, never served.
func TestV1174_OtaTraversalEntriesSkipped(t *testing.T) {
        manifest := `{
          "version": "v1.17.4-test", "ref": "v1.17.4-test", "min_engine": "1.16.0",
          "files": [
            {"path": "../evil.js", "sha256": "aa", "size": 10},
            {"path": "engine/internal/server/web/../../evil2.js", "sha256": "bb", "size": 20},
            {"path": "/abs/evil3.js", "sha256": "cc", "size": 30},
            {"path": "brain/server_android.py", "sha256": "dd", "size": 40}
          ]
        }`
        st := newOtaStub(t, manifest, map[string][]byte{
                "../evil.js":                         []byte("EVIL"),
                "engine/internal/server/web/../evil.js": []byte("EVIL"),
        })
        s := newOtaTestServer(t, st.srv.URL+"/patch-manifest.json", false)

        code, out := otaStatus(t, s, http.MethodGet, "/api/ota/status")
        if code != 200 {
                t.Fatalf("status: HTTP %d: %v", code, out)
        }
        man := out["manifest"].(map[string]any)
        if man["files"].(float64) != 4 || man["skipped"].(float64) != 4 || man["changed"].(float64) != 0 {
                t.Fatalf("all four hostile/foreign entries must be skipped: %v", man)
        }
        if out["state"] != "current" {
                t.Fatalf("nothing patchable changed → current (skipped is not an update): %v", out)
        }
        // The download is a no-op; nothing lands anywhere under the data dir.
        code, out = otaStatus(t, s, http.MethodPost, "/api/ota/download")
        if code != 200 || out["ok"] != true || out["downloaded"].(float64) != 0 {
                t.Fatalf("download must land nothing: %v", out)
        }
        evilFiles := 0
        _ = filepath.Walk(t.TempDir(), func(p string, fi os.FileInfo, err error) error {
                if err == nil && !fi.IsDir() && strings.Contains(filepath.Base(p), "evil") {
                        evilFiles++
                        t.Errorf("an evil file landed: %s", p)
                }
                return nil
        })
        // A traversal-shaped REQUEST never resolves to a disk file either
        // (the guard runs on the request path too; the embedded FileServer's
        // own protections answer behind it).
        for _, p := range []string{"/../evil.js", "/..%2fevil.js", "/a/../evil.js"} {
                code, _ = otaWebGet(t, s, p)
                if code == 200 {
                        t.Errorf("request %q must never serve 200 from the overlay", p)
                }
        }
        _ = evilFiles
}

// The kill switch: DOOMALAY_OTA_DISABLE → enabled:false, state disabled,
// zero network (the stub would be hit otherwise — its counter proves it).
func TestV1174_OtaDisabledKillSwitch(t *testing.T) {
        manifest := `{"version":"v1.17.4-test","ref":"v1.17.4-test","min_engine":"1.16.0","files":[]}`
        st := newOtaStub(t, manifest, nil)
        s := newOtaTestServer(t, st.srv.URL+"/patch-manifest.json", true)

        code, out := otaStatus(t, s, http.MethodGet, "/api/ota/status")
        if code != 200 || out["enabled"] != false || out["state"] != "disabled" {
                t.Fatalf("the kill switch must answer disabled: %v", out)
        }
        if out["manifest"] != nil {
                t.Fatalf("no manifest when disabled: %v", out)
        }
        if st.manifestHits() != 0 {
                t.Fatalf("disabled means ZERO network (stub was hit %d times)", st.manifestHits())
        }
        code, out = otaStatus(t, s, http.MethodPost, "/api/ota/download")
        if code != http.StatusBadRequest || out["ok"] != false {
                t.Fatalf("download when disabled: HTTP %d %v", code, out)
        }
}

// POST /check forces a manifest refetch (the stub's hit counter pins the
// cache discipline); GET status inside the TTL rides the cache.
func TestV1174_OtaCheckForcesRefetch(t *testing.T) {
        unchanged := otaEmbeddedHash(t, "lattice.js")
        manifest := fmt.Sprintf(`{"version":"v1.17.4-test","ref":"v1.17.4-test","min_engine":"1.16.0",
          "files":[{"path":"engine/internal/server/web/lattice.js","sha256":%q,"size":900}]}`,
                unchanged)
        st := newOtaStub(t, manifest, nil)
        s := newOtaTestServer(t, st.srv.URL+"/patch-manifest.json", false)

        // Boot's background fetch + the first status share at most ONE fetch
        // (single-flight); whatever raced, we have hits <= 1 here.
        first := st.manifestHits()
        if first > 1 {
                t.Fatalf("boot + first status must share one fetch (single-flight), got %d", first)
        }
        // A second GET rides the cache (fresh within the TTL).
        _, _ = otaStatus(t, s, http.MethodGet, "/api/ota/status")
        if st.manifestHits() != first {
                t.Fatalf("GET status inside the TTL must ride the cache (hits %d → %d)", first, st.manifestHits())
        }
        // POST /check forces a refetch.
        _, out := otaStatus(t, s, http.MethodPost, "/api/ota/check")
        if st.manifestHits() < first+1 {
                t.Fatalf("POST /check must refetch (hits %d)", st.manifestHits())
        }
        if out["state"] != "current" {
                t.Fatalf("the unchanged file → current: %v", out)
        }
}

// ── semver compare (the min_engine gate's engine) ──────────────────────

func TestV1174_SemverGreater(t *testing.T) {
        cases := []struct {
                a, b string
                want bool
        }{
                {"v99.0.0", "1.16.0", true},
                {"v1.17.4", "v1.16.0", true},
                {"1.17", "1.16.9", true},    // missing fields = 0 → 1.17.0 > 1.16.9
                {"1.17.4", "1.17.4", false}, // equal is not greater
                {"v1.16.0", "1.16.0", false},
                {"1.15.9", "1.16.0", false},
                {"", "1.16.0", false},            // empty = 0.0.0
                {"not.a.version", "1.16.0", false},
                {"v1.17.4-rc1", "1.17.4", false},  // a pre-release minimum never gates the plain release
                {"1.17.4", "1.17.4-rc1", true},    // the plain release exceeds the pre-release
                {"v1.17.4-rc1", "1.17.4-rc1", false},
        }
        for _, c := range cases {
                if got := semverGreater(c.a, c.b); got != c.want {
                        t.Errorf("semverGreater(%q, %q) = %v, want %v", c.a, c.b, got, c.want)
                }
        }
}

// ── env wiring: DOOMALAY_OTA_URL → config → server ────────────────────

func TestV1174_OtaEnvURLFlowsToTheServer(t *testing.T) {
        unchanged := otaEmbeddedHash(t, "lattice.js")
        manifest := fmt.Sprintf(`{"version":"v1.17.4-env","ref":"v1.17.4-env","min_engine":"1.16.0",
          "files":[{"path":"engine/internal/server/web/lattice.js","sha256":%q,"size":900}]}`,
                unchanged)
        st := newOtaStub(t, manifest, nil)

        t.Setenv("DOOMALAY_CONFIG", filepath.Join(t.TempDir(), "nonexistent.yaml"))
        t.Setenv("DOOMALAY_OTA_URL", st.srv.URL+"/patch-manifest.json")
        cfg, err := config.Load("", config.Overrides{DataDir: t.TempDir()})
        if err != nil {
                t.Fatalf("Load: %v", err)
        }
        if cfg.OTAURL != st.srv.URL+"/patch-manifest.json" {
                t.Fatalf("DOOMALAY_OTA_URL must flow into cfg.OTAURL: %q", cfg.OTAURL)
        }

        dir := t.TempDir()
        db, err := store.Open(dir)
        if err != nil {
                t.Fatalf("store: %v", err)
        }
        if err := db.Migrate(); err != nil {
                t.Fatalf("migrate: %v", err)
        }
        s := New(cfg, db, nil)
        code, out := otaStatus(t, s, http.MethodGet, "/api/ota/status")
        if code != 200 || out["state"] != "current" {
                t.Fatalf("the env-wired stub should answer current (unchanged file): %v", out)
        }
}
