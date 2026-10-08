// Package ota is the v1.17.4 THE LIVE UPDATE delta engine (PLAN-V117
// §v1.17.4): download only what changed, never the whole APK.
//
// Pure stdlib, zero engine dependencies — the primitives:
//
//   - FetchManifest: HTTP GET the patch manifest (15s timeout, redirects
//     OK, 1MB size cap on the read).
//   - ComputePlan: a pure diff of a manifest against the LIVE stack (the
//     caller supplies the live-hash function; the server's live stack is
//     "the <dataDir>/ota overlay file if present, else the embedded web/
//     asset").
//   - DownloadFile: stream one file to dest+".tmp", hash WHILE streaming,
//     sha256-verify EVERY downloaded byte, cap the size, rename on
//     success, delete the .tmp on ANY failure (corrupt = gone + honest
//     error — a half-written file is never left behind).
//   - FileURL: resolve a manifest entry's download URL from the manifest
//     URL (the GitHub release "latest" shape maps to the raw
//     raw.githubusercontent.com tree at the manifest's ref; anything else
//     — local stubs, offline mirrors — resolves relative to the
//     manifest's own directory).
//
// THE HONESTY LAW (this wave's): unreachable / corrupt / engine-required
// are STATES the caller reports, never silent failures. The engine binary
// itself is NEVER hot-patched — the server enforces that via the manifest's
// min_engine gate before anything downloads.
package ota

import (
        "context"
        "crypto/sha256"
        "encoding/hex"
        "encoding/json"
        "errors"
        "fmt"
        "io"
        "net/http"
        "net/url"
        "os"
        "path"
        "strings"
        "time"
)

// FileEntry is one patchable file in the manifest. Path is repo-root
// relative (e.g. "engine/internal/server/web/index.html") — the ONLY root
// the engine can patch (the server filters everything else out and
// reports it as skipped).
type FileEntry struct {
        Path   string `json:"path"`
        SHA256 string `json:"sha256"`
        Size   int64  `json:"size"`
}

// Manifest is the release's patch manifest (JSON keys version/ref/
// min_engine/files). min_engine is the gate: when it semver-exceeds the
// running engine's buildinfo.Version the update needs the full APK.
type Manifest struct {
        Version   string       `json:"version"`
        Ref       string       `json:"ref"`
        MinEngine string       `json:"min_engine"`
        Files     []FileEntry `json:"files"`
}

// Plan is the computed delta: what must download, what already matches,
// and the byte total (used against the plan cap).
type Plan struct {
        Changed    []FileEntry
        Unchanged  int
        TotalBytes int64
}

const (
        // ManifestMaxBytes caps the manifest read (a real manifest is ~25KB
        // for the whole web tree; 1MB is a generous ceiling that still stops
        // a hostile mirror from feeding us a memory bomb).
        ManifestMaxBytes = 1 << 20 // 1MB
        // FileMaxBytes is the per-file download cap (default when a caller
        // passes maxSize <= 0). The biggest real asset (the PM wasm, gzipped)
        // is ~5.9MB.
        FileMaxBytes = 10 << 20 // 10MB
        // fetchTimeout bounds one manifest HTTP round-trip (redirects
        // included). 15s: honest on a slow carrier, dead on a dead mirror.
        fetchTimeout = 15 * time.Second
        // fileTimeout bounds one file download (10MB on a slow carrier is
        // well under this; a dead mirror trips it).
        fileTimeout = 60 * time.Second
        // DefaultRef is the fallback ref when a manifest carries none (the
        // raw-URL resolution needs a branch or tag).
        DefaultRef = "main"
)

// FetchManifest GETs the manifest JSON. http.Client follows redirects by
// default (the GitHub "releases/latest/download/…" URL 302s to the newest
// tag's asset); the 15s timeout covers the whole exchange; the body read
// is capped at ManifestMaxBytes.
func FetchManifest(ctx context.Context, manifestURL string) (*Manifest, error) {
        if manifestURL == "" {
                return nil, errors.New("ota: empty manifest URL")
        }
        client := &http.Client{Timeout: fetchTimeout}
        cctx, cancel := context.WithTimeout(ctx, fetchTimeout)
        defer cancel()
        req, err := http.NewRequestWithContext(cctx, http.MethodGet, manifestURL, nil)
        if err != nil {
                return nil, fmt.Errorf("ota: manifest request: %w", err)
        }
        resp, err := client.Do(req)
        if err != nil {
                return nil, fmt.Errorf("ota: manifest fetch: %w", err)
        }
        defer resp.Body.Close()
        if resp.StatusCode != http.StatusOK {
                return nil, fmt.Errorf("ota: manifest HTTP %d", resp.StatusCode)
        }
        body, err := io.ReadAll(io.LimitReader(resp.Body, ManifestMaxBytes+1))
        if err != nil {
                return nil, fmt.Errorf("ota: manifest read: %w", err)
        }
        if len(body) > ManifestMaxBytes {
                return nil, fmt.Errorf("ota: manifest exceeds the %d byte cap", ManifestMaxBytes)
        }
        var m Manifest
        if err := json.Unmarshal(body, &m); err != nil {
                return nil, fmt.Errorf("ota: manifest JSON: %w", err)
        }
        if strings.TrimSpace(m.Version) == "" {
                return nil, errors.New("ota: manifest missing version")
        }
        return &m, nil
}

// ComputePlan diffs the manifest against the live stack. liveHash returns
// the sha256 of the live bytes for a manifest path, and false when the
// path has no live file (the manifest entry then counts as changed — a
// new file must download). Hash comparison is case-insensitive hex.
// The function is pure: no I/O, no clock, no mutation of m.
func ComputePlan(m *Manifest, liveHash func(path string) (string, bool)) *Plan {
        p := &Plan{Changed: []FileEntry{}}
        if m == nil {
                return p
        }
        for _, f := range m.Files {
                if h, ok := liveHash(f.Path); ok && strings.EqualFold(h, f.SHA256) {
                        p.Unchanged++
                } else {
                        p.Changed = append(p.Changed, f)
                        p.TotalBytes += f.Size
                }
        }
        return p
}

// DownloadFile streams url to destPath atomically: bytes land in
// destPath+".tmp" while a sha256 runs over the SAME stream (every
// downloaded byte is verified — never trust, then write), the size is
// capped at maxSize (<= 0 → FileMaxBytes), and only a fully verified
// stream renames onto destPath. ANY failure (transport drop, size cap,
// hash mismatch) deletes the .tmp — a corrupt file is gone, and the
// error says why.
func DownloadFile(ctx context.Context, fileURL, destPath, wantSHA string, maxSize int64) error {
        if maxSize <= 0 {
                maxSize = FileMaxBytes
        }
        wantSHA = strings.ToLower(strings.TrimSpace(wantSHA))
        if wantSHA == "" {
                // THE LAW: sha256-verify EVERY downloaded byte — a download with
                // no expected hash is a download we refuse.
                return errors.New("ota: refusing to download without a sha256 to verify")
        }
        tmp := destPath + ".tmp"
        ok := false
        defer func() {
                if !ok {
                        _ = os.Remove(tmp)
                }
        }()

        client := &http.Client{Timeout: fileTimeout}
        cctx, cancel := context.WithTimeout(ctx, fileTimeout)
        defer cancel()
        req, err := http.NewRequestWithContext(cctx, http.MethodGet, fileURL, nil)
        if err != nil {
                return fmt.Errorf("ota: request %s: %w", fileURL, err)
        }
        resp, err := client.Do(req)
        if err != nil {
                return fmt.Errorf("ota: fetch %s: %w", fileURL, err)
        }
        defer resp.Body.Close()
        if resp.StatusCode != http.StatusOK {
                return fmt.Errorf("ota: file HTTP %d (%s)", resp.StatusCode, fileURL)
        }
        // Early cap: trust Content-Length when the mirror sends one.
        if resp.ContentLength > maxSize {
                return fmt.Errorf("ota: %s is %d bytes (cap %d)", path.Base(destPath), resp.ContentLength, maxSize)
        }

        if err := os.MkdirAll(path.Dir(destPath), 0o755); err != nil {
                return fmt.Errorf("ota: mkdir %s: %w", path.Dir(destPath), err)
        }
        f, err := os.Create(tmp)
        if err != nil {
                return fmt.Errorf("ota: create %s: %w", tmp, err)
        }
        hasher := sha256.New()
        // LimitReader maxSize+1: one byte over the cap proves oversize.
        n, copyErr := io.Copy(io.MultiWriter(f, hasher), io.LimitReader(resp.Body, maxSize+1))
        closeErr := f.Close()
        if copyErr != nil {
                return fmt.Errorf("ota: stream %s: %w", fileURL, copyErr)
        }
        if closeErr != nil {
                return fmt.Errorf("ota: close %s: %w", tmp, closeErr)
        }
        if n > maxSize {
                return fmt.Errorf("ota: %s is %d bytes, over the %d cap", path.Base(destPath), n, maxSize)
        }
        sum := hex.EncodeToString(hasher.Sum(nil))
        if sum != wantSHA {
                return fmt.Errorf("ota: sha256 mismatch for %s (downloaded %s, manifest %s) — corrupt download, deleted",
                        path.Base(destPath), sum, wantSHA)
        }
        if err := os.Rename(tmp, destPath); err != nil {
                return fmt.Errorf("ota: apply %s: %w", destPath, err)
        }
        ok = true
        return nil
}

// FileURL resolves the download URL for one manifest entry from the
// manifest's own URL. Two legal shapes:
//
//   - a github.com release manifest (…/{owner}/{repo}/releases/…) or a
//     raw.githubusercontent.com manifest (…/{owner}/{repo}/…) → the file
//     rides the raw tree: https://raw.githubusercontent.com/{owner}/{repo}/{ref}/{path}
//     (release assets are FLAT — a nested repo path can never be one, so
//     the raw tree is the only honest source; ref defaults to main).
//   - anything else (a local stub, an offline mirror) → the manifest's
//     own directory + "/" + path (mirrors serving the repo layout work
//     for free).
func FileURL(manifestURL, ref, filePath string) string {
        if u, err := url.Parse(manifestURL); err == nil && u.Host != "" {
                segs := strings.Split(strings.TrimPrefix(u.Path, "/"), "/")
                switch {
                case u.Host == "github.com" && len(segs) >= 4 && segs[2] == "releases":
                        return rawURL(segs[0], segs[1], ref, filePath)
                case u.Host == "raw.githubusercontent.com" && len(segs) >= 2:
                        return rawURL(segs[0], segs[1], ref, filePath)
                }
        }
        // Fallback: the manifest's own directory (a mirror or stub serving
        // the repo tree at the manifest's base).
        base := manifestURL
        if i := strings.LastIndex(manifestURL, "/"); i >= 0 {
                base = manifestURL[:i+1]
        }
        return base + filePath
}

func rawURL(owner, repo, ref, filePath string) string {
        if strings.TrimSpace(ref) == "" {
                ref = DefaultRef
        }
        return "https://raw.githubusercontent.com/" + owner + "/" + repo + "/" + ref + "/" + filePath
}

// SHA256 hashes bytes to lowercase hex — the shared hashing helper for
// the server's live-stack hash (overlay file / embedded asset) so the
// manifest comparison and the download verification run the SAME code.
func SHA256(b []byte) string {
        sum := sha256.Sum256(b)
        return hex.EncodeToString(sum[:])
}
