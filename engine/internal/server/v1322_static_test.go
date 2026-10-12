// v1322_static_test.go — v1.32.2 THE HONEST VALIDATOR battery (PLAN-V133 §2).
//
// The no-cache-on-everything finding, proven fixed:
//   - every static response carries the OTA-law Cache-Control: no-cache
//   - every static response now carries a sha256 ETag (the validator the
//     embedded tree NEVER had — revalidations were full 200s)
//   - our own RFC 7232 weak If-None-Match gate answers 304 (no body, no
//     Content-Encoding)
//   - gzip variants carry their OWN validator (W/"<hash>-gz") + Vary —
//     a client that cached identity never 304s against gzip
//   - THE OTA CORRECTNESS PROOF: an overlay patch flips the ETag, the
//     stale validator misses, the patch bytes land on the reload
//   - Range requests still work (the ServeContent 200 path)
package server

import (
        "bytes"
        "compress/gzip"
        "io"
        "io/fs"
        "net/http"
        "net/http/httptest"
        "os"
        "path/filepath"
        "strings"
        "testing"

        "github.com/ScoobyBaby1999/doomalay/engine/internal/config"
)

// subtree — the embedded web tree as an fs.FS (the same view routes() uses).
func subtree() fs.FS {
        sub, err := fs.Sub(webFS, "web")
        if err != nil {
                panic(err)
        }
        return sub
}

func get(h http.Handler, target string, hdr map[string]string) *httptest.ResponseRecorder {
        req := httptest.NewRequest(http.MethodGet, target, nil)
        for k, v := range hdr {
                req.Header.Set(k, v)
        }
        w := httptest.NewRecorder()
        h.ServeHTTP(w, req)
        return w
}

// ── the embedded tree: ETag + 304 ───────────────────────────────────

func TestV1322_StaticETagAnd304(t *testing.T) {
        h := staticHandler{root: subtree()}
        w := get(h, "/index.html", nil)
        if w.Code != 200 {
                t.Fatalf("index.html: got %d want 200", w.Code)
        }
        etag := w.Header().Get("ETag")
        if etag == "" || !strings.HasPrefix(etag, `"`) || !strings.HasSuffix(etag, `"`) {
                t.Fatalf("index.html carried no strong quoted ETag: %q", etag)
        }
        if cc := w.Header().Get("Cache-Control"); cc != "no-cache" {
                t.Fatalf("the OTA law broke: Cache-Control %q != no-cache", cc)
        }
        // the exact validator revalidates → 304, no body
        w2 := get(h, "/index.html", map[string]string{"If-None-Match": etag})
        if w2.Code != http.StatusNotModified {
                t.Fatalf("exact If-None-Match: got %d want 304", w2.Code)
        }
        if b, _ := io.ReadAll(w2.Body); len(b) != 0 {
                t.Fatalf("a 304 carried a body (%d bytes) — the validator gate leaks", len(b))
        }
        if cc := w2.Header().Get("Cache-Control"); cc != "no-cache" {
                t.Fatalf("the 304 lost the OTA law: %q", cc)
        }
        if w2.Header().Get("ETag") != etag {
                t.Fatalf("the 304 lost the ETag")
        }
        // the WEAK comparison law: W/"<etag>" matches the strong etag (RFC 7232)
        w3 := get(h, "/index.html", map[string]string{"If-None-Match": `W/` + etag})
        if w3.Code != http.StatusNotModified {
                t.Fatalf("weak W/-prefixed If-None-Match: got %d want 304", w3.Code)
        }
        // a stale validator misses → the full 200 comes back
        w4 := get(h, "/index.html", map[string]string{"If-None-Match": `"deadbeef` + strings.Repeat("0", 56) + `"`})
        if w4.Code != 200 || len(w4.Body.Bytes()) == 0 {
                t.Fatalf("stale validator: got %d want 200 with a body", w4.Code)
        }
}

// ── the gzip variant: own validator + Vary ──────────────────────────

func TestV1322_StaticGzipVariant(t *testing.T) {
        h := staticHandler{root: subtree()}
        // chatpanel.js is a large text asset — always compressible
        w := get(h, "/chatpanel.js", map[string]string{"Accept-Encoding": "gzip"})
        if w.Code != 200 {
                t.Fatalf("chatpanel.js: %d", w.Code)
        }
        if ce := w.Header().Get("Content-Encoding"); ce != "gzip" {
                t.Fatalf("the gzip variant did not engage: Content-Encoding %q", ce)
        }
        if vary := w.Header().Get("Vary"); !strings.Contains(vary, "Accept-Encoding") {
                t.Fatalf("the gzip response lost Vary: %q", vary)
        }
        gzEtag := w.Header().Get("ETag")
        if !strings.HasPrefix(gzEtag, `W/"`) || !strings.HasSuffix(gzEtag, `-gz"`) {
                t.Fatalf("the gzip validator is not the W/-gz shape: %q", gzEtag)
        }
        // the body gunzips to the identity bytes
        zr, err := gzip.NewReader(bytes.NewReader(w.Body.Bytes()))
        if err != nil {
                t.Fatalf("the gzip body is not gzip: %v", err)
        }
        gzBody, _ := io.ReadAll(zr)
        plain := get(h, "/chatpanel.js", nil).Body.Bytes()
        if !bytes.Equal(gzBody, plain) {
                t.Fatalf("the gzip variant gunzipped to different bytes (%d vs %d)", len(gzBody), len(plain))
        }
        // THE RFC 7232 CONTENT-CODING LAW: a client that cached IDENTITY (and
        // still accepts gzip) revalidates against the -gz validator — MISS,
        // the full 200 gz body lands (never a cross-representation 304)
        w2 := get(h, "/chatpanel.js", map[string]string{
                "Accept-Encoding": "gzip",
                "If-None-Match":   `"` + strings.TrimPrefix(strings.TrimSuffix(gzEtag, `-gz"`), `W/"`) + `"`,
        })
        if w2.Code != 200 {
                t.Fatalf("identity validator matched the gzip representation: %d — the content-coding law broke", w2.Code)
        }
        // the gzip validator revalidates → 304
        w3 := get(h, "/chatpanel.js", map[string]string{"Accept-Encoding": "gzip", "If-None-Match": gzEtag})
        if w3.Code != http.StatusNotModified {
                t.Fatalf("the gzip validator missed its own revalidation: %d", w3.Code)
        }
        if w3.Header().Get("Content-Encoding") != "" {
                t.Fatalf("a 304 carried Content-Encoding — the gate leaks the representation")
        }
}

// ── THE OTA CORRECTNESS PROOF ───────────────────────────────────────

func TestV1322_OverlayPatchFlipsETag(t *testing.T) {
        dir := t.TempDir()
        s := &Server{cfg: &config.Config{DataDir: dir}}
        h := noCacheFS{s.otaOverlay(staticHandler{root: subtree()})}

        const asset = "/vendor/format/marked.min.js"
        w1 := get(h, asset, nil)
        if w1.Code != 200 {
                t.Fatalf("pre-patch: %d", w1.Code)
        }
        etag1 := w1.Header().Get("ETag")
        if etag1 == "" {
                t.Fatalf("pre-patch: no ETag")
        }
        // the embedded answer revalidates cleanly BEFORE the patch
        if w := get(h, asset, map[string]string{"If-None-Match": etag1}); w.Code != 304 {
                t.Fatalf("pre-patch revalidation: %d want 304", w.Code)
        }

        // THE PATCH: what handleOtaDownload produces — verified bytes renamed
        // onto <dataDir>/ota/<web-relative-path>
        patch := []byte("// THE PATCHED MARKED — v1.32.2 proof payload\n" + strings.Repeat("x", 4096))
        dst := filepath.Join(dir, "ota", "vendor", "format")
        if err := os.MkdirAll(dst, 0o755); err != nil {
                t.Fatal(err)
        }
        if err := os.WriteFile(filepath.Join(dst, "marked.min.js"), patch, 0o644); err != nil {
                t.Fatal(err)
        }

        // the patched bytes land at the SAME URL, with a NEW validator
        w2 := get(h, asset, map[string]string{"If-None-Match": etag1})
        if w2.Code != 200 {
                t.Fatalf("post-patch: the cached client's stale validator got %d want 200 (the patch MUST arrive)", w2.Code)
        }
        if !bytes.Equal(w2.Body.Bytes(), patch) {
                t.Fatalf("post-patch: the served bytes are not the patch")
        }
        etag2 := w2.Header().Get("ETag")
        if etag2 == "" || etag2 == etag1 {
                t.Fatalf("post-patch: the ETag did not flip (%q vs %q)", etag2, etag1)
        }
        // the new validator revalidates → 304; the old one keeps missing
        if w := get(h, asset, map[string]string{"If-None-Match": etag2}); w.Code != 304 {
                t.Fatalf("post-patch revalidation: %d want 304", w.Code)
        }
}

// ── the shape laws ──────────────────────────────────────────────────

func TestV1322_TraversalRejected(t *testing.T) {
        h := staticHandler{root: subtree()}
        for _, p := range []string{"/../server.go", "/..%2fserver.go", "/a/../../webstatic.go", "/vendor/../server.go"} {
                if w := get(h, p, nil); w.Code != 404 {
                        t.Fatalf("traversal %s: got %d want 404", p, w.Code)
                }
        }
}

func TestV1322_RootServesIndex(t *testing.T) {
        h := staticHandler{root: subtree()}
        w := get(h, "/", nil)
        if w.Code != 200 || !strings.Contains(w.Body.String(), "<!DOCTYPE html>") && !strings.Contains(w.Body.String(), "<!doctype html>") {
                t.Fatalf("/ did not serve index.html: %d (%d bytes)", w.Code, len(w.Body.Bytes()))
        }
}

func TestV1322_RangeStillWorks(t *testing.T) {
        h := staticHandler{root: subtree()}
        w := get(h, "/chatpanel.js", map[string]string{"Range": "bytes=0-9"})
        if w.Code != http.StatusPartialContent {
                t.Fatalf("Range: got %d want 206", w.Code)
        }
        if len(w.Body.Bytes()) != 10 {
                t.Fatalf("Range: got %d bytes want 10", len(w.Body.Bytes()))
        }
}

func TestV1322_MjsMimeType(t *testing.T) {
        h := staticHandler{root: subtree()}
        w := get(h, "/vendor/virtual-core.mjs", nil)
        if ct := w.Header().Get("Content-Type"); !strings.Contains(ct, "text/javascript") {
                t.Fatalf(".mjs served as %q (the old FileServer sniffed text/plain)", ct)
        }
}

func TestV1322_NoCacheOnEverything(t *testing.T) {
        h := noCacheFS{staticHandler{root: subtree()}}
        for _, p := range []string{"/", "/app.js", "/theme.js", "/vendor/pixi/pixi.min.js", "/config/families.json"} {
                w := get(h, p, nil)
                if w.Code != 200 {
                        t.Fatalf("%s: %d", p, w.Code)
                }
                if cc := w.Header().Get("Cache-Control"); cc != "no-cache" {
                        t.Fatalf("%s: Cache-Control %q — the OTA law broke", p, cc)
                }
                if w.Header().Get("ETag") == "" {
                        t.Fatalf("%s: no ETag — the honest validator is missing", p)
                }
        }
}

// ── the wasm route's validator ──────────────────────────────────────

func TestV1322_WasmValidator(t *testing.T) {
        // a stand-in for the pre-gzipped wasm (the policy is byte-agnostic)
        body := []byte(strings.Repeat("wasm-bytes-", 2048))
        h := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { serveWasmAsset(w, r, body) })
        w := get(h, "/vendor/pm/privatemode.wasm", nil)
        if w.Code != 200 || w.Header().Get("Content-Encoding") != "gzip" {
                t.Fatalf("wasm 200 shape broke: %d %q", w.Code, w.Header().Get("Content-Encoding"))
        }
        etag := w.Header().Get("ETag")
        if etag == "" {
                t.Fatalf("the wasm route carries no validator")
        }
        if cc := w.Header().Get("Cache-Control"); cc != "public, max-age=86400" {
                t.Fatalf("the v0.15 max-age contract broke: %q", cc)
        }
        if w2 := get(h, "/vendor/pm/privatemode.wasm", map[string]string{"If-None-Match": etag}); w2.Code != 304 {
                t.Fatalf("the wasm validator missed its own revalidation: %d", w2.Code)
        }
}

// ── the inmMatch unit laws ──────────────────────────────────────────

func TestV1322_InmWeakComparison(t *testing.T) {
        etag := `"abc123"`
        if !inmMatch(`"abc123"`, etag) {
                t.Fatal("exact match failed")
        }
        if !inmMatch(`W/"abc123"`, etag) {
                t.Fatal("weak-on-request match failed (RFC 7232)")
        }
        if !inmMatch(`W/"abc123"`, `W/"abc123"`) {
                t.Fatal("weak-on-both match failed")
        }
        if inmMatch(`"abc124"`, etag) {
                t.Fatal("different validator matched")
        }
        if inmMatch(``, etag) {
                t.Fatal("empty header matched")
        }
        if !inmMatch(`*`, etag) {
                t.Fatal("* failed")
        }
        if !inmMatch(`"zzz", "abc123"`, etag) {
                t.Fatal("list match failed")
        }
        if inmMatch(`"zzz", "abc124"`, etag) {
                t.Fatal("list non-match matched")
        }
}
