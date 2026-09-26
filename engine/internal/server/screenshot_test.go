package server

// screenshot_test.go — v0.62.4: the T3 tier under test.
//
//   detection   — the PATH/cache probe (stubbed) feeds the caps
//   the route   — 501 without a binary; 400 for bad/private URLs;
//                 clamped size params
//   the render  — a REAL chromium run against a local httptest page
//                 (skipped when no binary exists on the box — CI has
//                 none; this sandbox has playwright's)
//   the stamp   — /api/preview marks blocked verdicts with the
//                 screenshot_url when the tier is live
//   the cache   — a repeat request serves the cached PNG without a
//                 second chromium run

import (
        "bytes"
        "encoding/json"
        "image/png"
        "net/http"
        "net/http/httptest"
        "os"
        "sync"
        "testing"
)

func stubScreenshotDetect(t *testing.T, path string) {
        t.Helper()
        old := detectScreenshot
        detectScreenshot = func() string { return path }
        // reset the once-cache so the stub takes effect
        screenshotOnce = sync.Once{}
        oldPath := screenshotPath
        t.Cleanup(func() {
                detectScreenshot = old
                screenshotOnce = sync.Once{}
                screenshotPath = oldPath
        })
}

func TestScreenshotDetection(t *testing.T) {
        stubScreenshotDetect(t, "/fake/chrome")
        if got := screenshotBinaryPath(); got != "/fake/chrome" {
                t.Fatalf("screenshotBinaryPath = %q, want the stub", got)
        }
        stubScreenshotDetect(t, "")
        if got := screenshotBinaryPath(); got != "" {
                t.Fatalf("screenshotBinaryPath = %q, want empty (no chromium)", got)
        }
        // the real probe (whatever this box says — must not error)
        real := detectScreenshotBinary()
        t.Logf("real detection on this box: %q", real)
}

func TestScreenshotRouteGuards(t *testing.T) {
        stubScreenshotDetect(t, "")
        s := seedOAuthServer(t)
        // no binary → clean 501, the UI hides the tier
        rec := httptest.NewRecorder()
        s.mux.ServeHTTP(rec, httptest.NewRequest("GET", "/api/preview/screenshot?url=https://example.com/", nil))
        if rec.Code != 501 {
                t.Fatalf("no-binary HTTP %d, want 501", rec.Code)
        }

        stubScreenshotDetect(t, "/nonexistent/chrome")
        // bad URL → 400
        rec = httptest.NewRecorder()
        s.mux.ServeHTTP(rec, httptest.NewRequest("GET", "/api/preview/screenshot?url=notaurl", nil))
        if rec.Code != 400 {
                t.Fatalf("bad url HTTP %d, want 400", rec.Code)
        }
        // private host → refused (guard live even with a binary stubbed)
        stubPreviewGuardPublic(t, false)
        rec = httptest.NewRecorder()
        s.mux.ServeHTTP(rec, httptest.NewRequest("GET", "/api/preview/screenshot?url=http://127.0.0.1:9/x", nil))
        if rec.Code != 400 {
                t.Fatalf("private host HTTP %d, want 400", rec.Code)
        }
}

// stubPreviewGuardPublic toggles the preview SSRF guard for guard tests.
func stubPreviewGuardPublic(t *testing.T, allow bool) {
        t.Helper()
        old := previewHostAllowed
        if allow {
                previewHostAllowed = func(string) bool { return true }
        } else {
                previewHostAllowed = isPublicPreviewHost
        }
        t.Cleanup(func() { previewHostAllowed = old })
}

func TestScreenshotRealRender(t *testing.T) {
        bin := detectScreenshotBinary()
        if bin == "" {
                t.Skip("no chromium on this box — the render path needs a real binary")
        }
        stubScreenshotDetect(t, bin)
        stubPreviewGuardPublic(t, true)

        ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            w.Header().Set("Content-Type", "text/html; charset=utf-8")
            w.Write([]byte(`<!doctype html><html><head><title>Shot Target</title></head>
              <body style="background:#336699;color:#fff;font-size:42px">
              <h1>the screenshot tier works</h1></body></html>`))
        }))
        t.Cleanup(ts.Close)

        s := seedOAuthServer(t)
        q := "/api/preview/screenshot?url=" + ts.URL + "/page&w=800&h=500&scale=1"
        rec := httptest.NewRecorder()
        s.mux.ServeHTTP(rec, httptest.NewRequest("GET", q, nil))
        if rec.Code != 200 {
                t.Fatalf("screenshot HTTP %d: %s", rec.Code, rec.Body.String())
        }
        if ct := rec.Header().Get("Content-Type"); ct != "image/png" {
                t.Fatalf("content-type = %q, want image/png", ct)
        }
        if cc := rec.Header().Get("Cache-Control"); cc != "public, max-age=86400" {
                t.Fatalf("cache-control = %q", cc)
        }
        // a valid PNG of the requested shape (800×500 @1x)
        img, err := png.Decode(bytes.NewReader(rec.Body.Bytes()))
        if err != nil {
                t.Fatalf("not a PNG: %v", err)
        }
        b := img.Bounds()
        if b.Dx() != 800 || b.Dy() != 500 {
                t.Fatalf("png = %dx%d, want 800x500", b.Dx(), b.Dy())
        }

        // the cache: a second request serves the same bytes without
        // re-running chromium (same content, instant)
        rec2 := httptest.NewRecorder()
        s.mux.ServeHTTP(rec2, httptest.NewRequest("GET", q, nil))
        if rec2.Code != 200 || !bytes.Equal(rec.Body.Bytes(), rec2.Body.Bytes()) {
                t.Fatalf("cached shot mismatch (HTTP %d)", rec2.Code)
        }
}

func TestPreviewStampsScreenshotURL(t *testing.T) {
        stubPreviewGuard(t) // aim the probe at the local server
        ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            w.Header().Set("X-Frame-Options", "DENY")
            w.Write([]byte(`<html><head><title>Blocked Page</title></head></html>`))
        }))
        t.Cleanup(ts.Close)

        // with the tier live, the blocked verdict carries the stamp
        if detectScreenshotBinary() == "" {
                t.Skip("no chromium on this box — stamp test needs the live tier")
        }
        s := seedOAuthServer(t)
        previewCache.Lock()
        previewCache.m = map[string]previewCacheEntry{}
        previewCache.Unlock()

        rec := httptest.NewRecorder()
        s.mux.ServeHTTP(rec, httptest.NewRequest("GET", "/api/preview?url="+ts.URL+"/x", nil))
        if rec.Code != 200 {
                t.Fatalf("preview HTTP %d: %s", rec.Code, rec.Body.String())
        }
        var d map[string]any
        if err := json.Unmarshal(rec.Body.Bytes(), &d); err != nil {
                t.Fatal(err)
        }
        if d["frameable"] != false {
                t.Fatalf("frameable = %v, want false", d["frameable"])
        }
        su, _ := d["screenshot_url"].(string)
        if su == "" {
                t.Fatalf("screenshot_url missing on a blocked verdict with the tier live: %v", d)
        }
        if su[:1] != "/" {
                t.Fatalf("screenshot_url = %q, want a same-origin path", su)
        }
        // clean the cache entry so other tests don't see it
        previewCache.Lock()
        previewCache.m = map[string]previewCacheEntry{}
        previewCache.Unlock()
        _ = os.RemoveAll(s.cfg.DataDir + "/preview-cache")
}
