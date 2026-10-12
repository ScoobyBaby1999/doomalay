// webstatic.go — v1.32.2 THE HONEST VALIDATOR (PLAN-V133 §2).
//
// The "no-cache-on-everything" finding, paid honestly: since v0.88.2 every
// static response carries `Cache-Control: no-cache` (the OTA law — the
// ota-first overlay serves patches at the SAME URLs, so a max-age/immutable
// lifetime would serve stale bytes after a patch until the TTL expired).
// But no-cache only REVALIDATES — and the embedded tree carried NO validator
// at all (embed.FS files have a zero ModTime → no Last-Modified, no ETag),
// so every revalidation was a FULL 200 body. Every reload re-downloaded the
// whole PWA from the engine's own loopback.
//
// THE FIX IS THE VALIDATOR, not the lifetime:
//
//   - a strong sha256 ETag per path (the embedded bytes are immutable →
//     computed once, cached; overlay bytes are keyed by path+size+mtime so
//     a patch flips the ETag on the next request — the OTA correctness is
//     structural),
//   - our own RFC 7232 WEAK If-None-Match gate → 304 (Go's ServeContent
//     preconditions would do, but the gate is OURS to pin: ETag + Vary +
//     Cache-Control on the 304, never a body, never a Content-Encoding),
//   - gzip variants for compressible text assets (lazy-cached; the gzip
//     representation carries its OWN validator, W/"<hash>-gz", per RFC
//     7232's content-coding rule — a client that cached the identity
//     representation never 304s against the gzip one), and
//   - `Vary: Accept-Encoding` so every cache between here and the WebView
//     keys the two representations apart.
//
// max-age/immutable stays OUT (the will-NOT boundary): it returns with the
// bundler wave's content-hashed filenames, where a new build means new URLs
// and the OTA overlay stops racing the browser cache.
package server

import (
        "bytes"
        "compress/gzip"
        "crypto/sha256"
        "encoding/hex"
        "io/fs"
        "mime"
        "net/http"
        "path"
        "strconv"
        "strings"
        "sync"
        "time"
)

// ── validators ──────────────────────────────────────────────────────

// sha256Hex — the lowercase-hex digest of the exact served bytes. The SAME
// digest the OTA manifest pins (internal/ota) and the download verify runs —
// one hash, three consumers.
func sha256Hex(b []byte) string {
        sum := sha256.Sum256(b)
        return hex.EncodeToString(sum[:])
}

// etagIdentity — the strong validator for the identity representation.
func etagIdentity(b []byte) string { return `"` + sha256Hex(b) + `"` }

// etagGzip — the WEAK validator for the gzip representation. RFC 7232: an
// ETag is content-coding aware; a different representation gets a different
// validator, and weak validators are the honest shape for a derived body.
func etagGzip(hexOfIdentity string) string { return `W/"` + hexOfIdentity + `-gz"` }

// inmMatch — the If-None-Match gate, RFC 7232 WEAK comparison: W/ prefixes
// are stripped on BOTH sides before comparing, "*" matches anything, and
// the header is a comma-separated list.
func inmMatch(header, etag string) bool {
        header = strings.TrimSpace(header)
        if header == "" {
                return false
        }
        if header == "*" {
                return true
        }
        ours := strings.TrimPrefix(etag, `W/`)
        for _, part := range strings.Split(header, ",") {
                part = strings.TrimSpace(part)
                if part == "*" {
                        return true
                }
                if strings.TrimPrefix(part, `W/`) == ours && part != "" {
                        return true
                }
        }
        return false
}

// ── gzip variants (lazy, cached) ────────────────────────────────────

// gzMinBytes — below this the gzip variant costs more than it saves.
const gzMinBytes = 512

// gzCache — the gzip representations. Embedded assets are immutable → the
// entry lives forever (bounded by the tree itself, ~1-2MB compressed).
// Overlay entries key on path|size|mtime → a patch re-computes naturally.
var gzCache sync.Map // key string → []byte

// compressible — the types worth gzipping on a loopback (text shapes that
// dominate the PWA tree). Images/fonts/wasm already carry their own
// compression; never double-pay.
func compressible(ctype string) bool {
        if strings.HasPrefix(ctype, "text/") {
                return true
        }
        switch ctype {
        case "application/javascript", "application/json", "image/svg+xml",
                "application/xml", "application/wasm":
                return true
        }
        return false
}

// gzipVariant returns the cached gzip bytes for the asset, or nil when the
// type/size says don't bother.
func gzipVariant(key string, ctype string, b []byte) []byte {
        if len(b) < gzMinBytes || !compressible(ctype) {
                return nil
        }
        if v, ok := gzCache.Load(key); ok {
                return v.([]byte)
        }
        var buf bytes.Buffer
        zw, err := gzip.NewWriterLevel(&buf, gzip.BestSpeed)
        if err != nil {
                return nil
        }
        if _, err := zw.Write(b); err != nil {
                return nil
        }
        if err := zw.Close(); err != nil {
                return nil
        }
        gz := buf.Bytes()
        gzCache.Store(key, gz)
        return gz
}

// ── the MIME table (the FileServer sniffed .mjs as text/plain) ──────

func init() {
        mime.AddExtensionType(".mjs", "text/javascript")
        mime.AddExtensionType(".wasm", "application/wasm")
}

// staticCT — the content type for one asset ("" lets ServeContent sniff).
func staticCT(name string) string {
        return mime.TypeByExtension(path.Ext(name))
}

// ── THE single gate every static byte passes ────────────────────────

// serveAssetBytes answers one GET/HEAD for the exact asset bytes, with the
// full v1.32.2 policy: no-cache (the OTA law), the sha256 validators, the
// weak INM gate → 304, and the gzip variant with its own validator + Vary.
// The 200 body rides ServeContent (Range support preserved from the old
// FileServer path).
func serveAssetBytes(w http.ResponseWriter, r *http.Request, name string, data []byte) {
        ctype := staticCT(name)
        if ctype != "" {
                w.Header().Set("Content-Type", ctype)
        }
        w.Header().Set("Cache-Control", "no-cache")

        acceptsGzip := strings.Contains(r.Header.Get("Accept-Encoding"), "gzip")
        var gz []byte
        if acceptsGzip {
                // the cache key carries the identity hash — the same bytes always
                // yield the same variant, and different bytes can never collide
                gz = gzipVariant(sha256Hex(data), ctype, data)
        }
        if gz != nil {
                w.Header().Set("Vary", "Accept-Encoding")
        }

        etag := etagIdentity(data)
        if gz != nil {
                etag = etagGzip(sha256Hex(data))
        }
        w.Header().Set("ETag", etag)

        // THE GATE: our own weak comparison — a hit writes the bare 304
        // (validators + cache policy, never a body, never a Content-Encoding).
        if r.Method == http.MethodGet || r.Method == http.MethodHead {
                if inmMatch(r.Header.Get("If-None-Match"), etag) {
                        w.WriteHeader(http.StatusNotModified)
                        return
                }
        }

        if gz != nil {
                w.Header().Set("Content-Encoding", "gzip")
                http.ServeContent(w, r, name, time.Time{}, bytes.NewReader(gz))
                return
        }
        http.ServeContent(w, r, name, time.Time{}, bytes.NewReader(data))
}

// ── the embedded tree handler ───────────────────────────────────────

// staticHandler serves the embedded web tree with the validator policy —
// the replacement for http.FileServer(http.FS(distFS)) at the "/" route.
// The OTA overlay wraps it unchanged (overlay hits answer through
// serveAssetBytes too — see otaapi.go).
type staticHandler struct{ root fs.FS }

func (h staticHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
        if r.Method != http.MethodGet && r.Method != http.MethodHead {
                w.Header().Set("Allow", "GET, HEAD")
                http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
                return
        }
        p := strings.TrimPrefix(r.URL.Path, "/")
        if p == "" {
                p = "index.html"
        }
        // the traversal guard: fs.ValidPath rejects ".", "..", empty and
        // slash-anchored segments — the same law http.FileServer enforced.
        if !fs.ValidPath(p) || strings.HasPrefix(p, "/") {
                http.NotFound(w, r)
                return
        }
        data, err := fs.ReadFile(h.root, p)
        if err != nil {
                http.NotFound(w, r)
                return
        }
        serveAssetBytes(w, r, p, data)
}

// ── the PrivateMode wasm route (its ETag; its max-age rule untouched) ──

// serveWasmAsset — the vendored PM wasm is pre-gzipped on disk (5.9MB) and
// served with Content-Encoding: gzip + max-age=86400 (the v0.15 contract).
// v1.32.2 adds the ONE thing it was missing: a validator, so post-TTL
// revalidations are 304s instead of full re-downloads.
func serveWasmAsset(w http.ResponseWriter, r *http.Request, wasmGz []byte) {
        etag := etagIdentity(wasmGz)
        w.Header().Set("ETag", etag)
        if inmMatch(r.Header.Get("If-None-Match"), etag) {
                w.WriteHeader(http.StatusNotModified)
                return
        }
        w.Header().Set("Content-Type", "application/wasm")
        w.Header().Set("Content-Encoding", "gzip")
        w.Header().Set("Cache-Control", "public, max-age=86400")
        w.Header().Set("Content-Length", strconv.Itoa(len(wasmGz)))
        if r.Method == http.MethodGet {
                _, _ = w.Write(wasmGz)
        }
}
