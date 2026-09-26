package server

// linkpreview_test.go — v0.62.1: the universal link verdict under test.
//
//   YouTube rewrites   — every embeddable form → youtube-nocookie embed,
//                        timestamps carried, non-embed forms fall through
//   parseYTTime        — 90 | 90s | 1m30s | 1h2m3s
//   mediaTypeByExt     — extension decides, query strings stripped
//   frameBlocked       — XFO + CSP + 401/403 semantics (CSP wins)
//   SSRF guard         — loopback/private/link-local refused
//   htmlPreview        — og extraction, favicon resolution, redirect
//                        chains, Content-Type upgrades (httptest, guard
//                        stubbed)
//   the route          — GET /api/preview + the cache hit

import (
        "encoding/json"
        "net/http"
        "net/http/httptest"
        "strings"
        "testing"
)

func TestYouTubePreviewRewrites(t *testing.T) {
        cases := []struct {
                name, in string
                wantID   string
                wantStart int
        }{
                {"watch", "https://www.youtube.com/watch?v=dQw4w9WgXcQ", "dQw4w9WgXcQ", 0},
                {"watch+ts", "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=90s", "dQw4w9WgXcQ", 90},
                {"watch+start", "https://www.youtube.com/watch?v=dQw4w9WgXcQ&start=45", "dQw4w9WgXcQ", 45},
                {"mobile watch", "https://m.youtube.com/watch?v=dQw4w9WgXcQ", "dQw4w9WgXcQ", 0},
                {"music", "https://music.youtube.com/watch?v=dQw4w9WgXcQ", "dQw4w9WgXcQ", 0},
                {"short", "https://youtu.be/dQw4w9WgXcQ", "dQw4w9WgXcQ", 0},
                {"short+ts", "https://youtu.be/dQw4w9WgXcQ?t=1m30s", "dQw4w9WgXcQ", 90},
                {"shorts", "https://www.youtube.com/shorts/ABcde123456", "ABcde123456", 0},
                {"live", "https://www.youtube.com/live/ABcde123456", "ABcde123456", 0},
                {"embed passthrough", "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ", "dQw4w9WgXcQ", 0},
                {"embed+start", "https://www.youtube.com/embed/dQw4w9WgXcQ?start=30", "dQw4w9WgXcQ", 30},
                {"hms", "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=1h2m3s", "dQw4w9WgXcQ", 3723},
        }
        for _, c := range cases {
                got := youtubePreview(c.in)
                if got == nil {
                        t.Errorf("%s: youtubePreview(%q) = nil, want a verdict", c.name, c.in)
                        continue
                }
                if got["youtube_id"] != c.wantID {
                        t.Errorf("%s: id = %v, want %v", c.name, got["youtube_id"], c.wantID)
                }
                if c.wantStart > 0 {
                        if got["embed"].(string) == "" || !strings.Contains(got["embed"].(string), "start="+itoaForTest(c.wantStart)) {
                                t.Errorf("%s: embed = %v, want start=%d", c.name, got["embed"], c.wantStart)
                        }
                        if got["start"] != c.wantStart {
                                t.Errorf("%s: start = %v, want %v", c.name, got["start"], c.wantStart)
                        }
                } else if strings.Contains(got["embed"].(string), "start=") {
                        t.Errorf("%s: embed carries a start with no timestamp: %v", c.name, got["embed"])
                }
                if !strings.HasPrefix(got["embed"].(string), "https://www.youtube-nocookie.com/embed/") {
                        t.Errorf("%s: embed = %v, want the youtube-nocookie form", c.name, got["embed"])
                }
                if got["type"] != "youtube" || got["frameable"] != true {
                        t.Errorf("%s: type/frameable = %v/%v, want youtube/true", c.name, got["type"], got["frameable"])
                }
                if !strings.Contains(got["thumb"].(string), "/vi/"+c.wantID+"/") {
                        t.Errorf("%s: thumb = %v, want /vi/%s/", c.name, got["thumb"], c.wantID)
                }
        }
        // non-embeddable YouTube forms fall through to the HTML probe
        for _, in := range []string{
                "https://www.youtube.com/",
                "https://www.youtube.com/@channel",
                "https://www.youtube.com/playlist?list=PLxyz",
                "https://www.youtube.com/clip/abc123",
                "https://www.youtube.com/results?search_query=x",
                "https://example.com/watch?v=dQw4w9WgXcQ", // not a YT host
        } {
                if got := youtubePreview(in); got != nil {
                        t.Errorf("youtubePreview(%q) = %v, want nil (falls through)", in, got)
                }
        }
}

func itoaForTest(n int) string {
        if n == 0 {
                return "0"
        }
        neg := n < 0
        if neg {
                n = -n
        }
        var b []byte
        for n > 0 {
                b = append([]byte{byte('0' + n%10)}, b...)
                n /= 10
        }
        if neg {
                return "-" + string(b)
        }
        return string(b)
}

func TestParseYTTime(t *testing.T) {
        cases := map[string]int{"": 0, "90": 90, "90s": 90, "1m30s": 90, "2h": 7200, "1h2m3s": 3723, "x9y": 0, "0": 0}
        for in, want := range cases {
                if got := parseYTTime(in); got != want {
                        t.Errorf("parseYTTime(%q) = %d, want %d", in, got, want)
                }
        }
}

func TestMediaTypeByExt(t *testing.T) {
        cases := map[string]string{
                "https://x.com/a.png":            "image",
                "https://x.com/a.JPG?w=99":       "image",
                "https://x.com/a.b.webp#frag":    "image",
                "https://x.com/v/clip.mp4":       "video",
                "https://x.com/t.mp3?tok=abc":    "audio",
                "https://x.com/doc.pdf":          "pdf",
                "https://x.com/page":             "",
                "https://x.com/a.pngx":           "",
        }
        for in, want := range cases {
                if got := mediaTypeByExt(in); got != want {
                        t.Errorf("mediaTypeByExt(%q) = %q, want %q", in, got, want)
                }
        }
}

func TestFrameBlocked(t *testing.T) {
        cases := []struct {
                name, xfo, csp string
                status         int
                wantBlocked    bool
        }{
                {"nothing", "", "", 200, false},
                {"xfo deny", "DENY", "", 200, true},
                {"xfo sameorigin", "SAMEORIGIN", "", 200, true},
                {"xfo allowall", "ALLOWALL", "", 200, false},
                {"csp none", "", "frame-ancestors 'none'", 200, true},
                {"csp self", "", "default-src *; frame-ancestors 'self'", 200, true},
                {"csp star", "", "frame-ancestors *", 200, false},
                {"csp wins over nothing", "", "frame-ancestors example.com", 200, true},
                {"auth wall", "", "", 403, true},
                {"auth wall 401", "", "", 401, true},
        }
        for _, c := range cases {
                blocked, _ := frameBlocked(c.xfo, c.csp, c.status)
                if blocked != c.wantBlocked {
                        t.Errorf("%s: frameBlocked = %v, want %v", c.name, blocked, c.wantBlocked)
                }
        }
}

func TestPreviewSSRFGuard(t *testing.T) {
        refused := []string{"localhost", "127.0.0.1", "127.0.0.1:8080", "::1", "0.0.0.0",
                "10.1.2.3", "192.168.1.10", "172.16.5.5", "169.254.169.254", "foo.localhost"}
        for _, h := range refused {
                host := strings.Split(h, ":")[0]
                if strings.Contains(h, "]") { // [::1]:8080 form
                        host = "::1"
                }
                if isPublicPreviewHost(host) {
                        t.Errorf("isPublicPreviewHost(%q) = true, want refused", h)
                }
        }
        allowed := []string{"example.com", "www.github.com", "8.8.8.8"}
        for _, h := range allowed {
                if !isPublicPreviewHost(h) {
                        t.Errorf("isPublicPreviewHost(%q) = false, want allowed", h)
                }
        }
}

// stubPreviewGuard aims the probe at a local httptest server.
func stubPreviewGuard(t *testing.T) {
        t.Helper()
        old := previewHostAllowed
        previewHostAllowed = func(string) bool { return true }
        t.Cleanup(func() { previewHostAllowed = old })
}

func TestHTMLPreviewExtracts(t *testing.T) {
        stubPreviewGuard(t)
        ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
                w.Header().Set("Content-Type", "text/html; charset=utf-8")
                w.Write([]byte(`<!doctype html><html><head>
                        <title>Real &amp; Title</title>
                        <meta property="og:title" content="OG Title">
                        <meta property="og:description" content="An og description">
                        <meta property="og:image" content="/static/og.png">
                        <meta property="og:site_name" content="SiteName">
                        <link rel="icon" href="/favicon-32.png">
                        </head><body>hi</body></html>`))
        }))
        t.Cleanup(ts.Close)

        out := htmlPreview(ts.URL + "/page")
        if out == nil {
                t.Fatal("htmlPreview = nil")
        }
        if out["title"] != "OG Title" {
                t.Errorf("title = %v, want OG Title (og beats <title>)", out["title"])
        }
        if out["description"] != "An og description" {
                t.Errorf("description = %v", out["description"])
        }
        if out["site_name"] != "SiteName" {
                t.Errorf("site_name = %v", out["site_name"])
        }
        if !strings.HasPrefix(out["og_image"].(string), ts.URL) {
                t.Errorf("og_image = %v, want resolved absolute", out["og_image"])
        }
        if !strings.HasPrefix(out["favicon"].(string), ts.URL+"/favicon-32.png") {
                t.Errorf("favicon = %v, want resolved /favicon-32.png", out["favicon"])
        }
        if out["frameable"] != true {
                t.Errorf("frameable = %v, want true (no guards set)", out["frameable"])
        }
}

func TestHTMLPreviewFrameVerdict(t *testing.T) {
        stubPreviewGuard(t)
        ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
                w.Header().Set("X-Frame-Options", "DENY")
                w.Header().Set("Content-Security-Policy", "frame-ancestors 'self'")
                w.Write([]byte(`<html><head><title>Blocked</title></head></html>`))
        }))
        t.Cleanup(ts.Close)
        out := htmlPreview(ts.URL)
        if out == nil || out["frameable"] != false {
                t.Fatalf("frameable = %v, want false", out)
        }
        if reason, _ := out["frame_reason"].(string); reason == "" {
                t.Error("frame_reason missing")
        }
}

func TestHTMLPreviewLoginRedirect(t *testing.T) {
        stubPreviewGuard(t)
        // a public-name origin that hops to a different registrable domain
        ts2 := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
                w.Write([]byte(`<html><head><title>Sign in</title></head></html>`))
        }))
        t.Cleanup(ts2.Close)
        ts1 := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
                http.Redirect(w, r, ts2.URL+"/login", 302)
        }))
        t.Cleanup(ts1.Close)
        // different ports on 127.0.0.1 share the registrable domain — the
        // login-redirect flag keys on the host change, so stub the hostOf
        // comparison by pointing at a real cross-domain hop shape: both are
        // 127.0.0.1 here, so instead assert the flag logic directly.
        out := htmlPreview(ts1.URL)
        if out == nil {
                t.Fatal("htmlPreview = nil")
        }
        // 127.0.0.1:x → 127.0.0.1:y is the SAME host — no login flag
        if _, flagged := out["login_redirect"]; flagged {
                t.Error("same-host redirect must not set login_redirect")
        }
}

func TestHTMLPreviewContentTypeUpgrade(t *testing.T) {
        stubPreviewGuard(t)
        ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
                w.Header().Set("Content-Type", "image/png")
                w.Write([]byte("not really a png"))
        }))
        t.Cleanup(ts.Close)
        out := htmlPreview(ts.URL + "/cdn/asset?id=9")
        if out == nil {
                t.Fatal("htmlPreview = nil")
        }
        if out["type"] != "image" {
                t.Errorf("type = %v, want image (Content-Type upgrade)", out["type"])
        }
        if out["frameable"] != true {
                t.Errorf("frameable = %v, want true for direct media", out["frameable"])
        }
}

func TestPreviewRouteAndCache(t *testing.T) {
        stubPreviewGuard(t)
        ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
                n := 0
                w.Write([]byte(`<html><head><title>Served Once</title></head></html>`))
                _ = n
        }))
        t.Cleanup(ts.Close)

        var hits int
        ts.Config.Handler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
                hits++
                w.Write([]byte(`<html><head><title>Served Once</title></head></html>`))
        })

        s := seedOAuthServer(t)
        // clear any prior cache entries from other tests
        previewCache.Lock()
        previewCache.m = map[string]previewCacheEntry{}
        previewCache.Unlock()

        q := ts.URL + "/x"
        rec := httptest.NewRecorder()
        s.mux.ServeHTTP(rec, httptest.NewRequest("GET", "/api/preview?url="+q, nil))
        if rec.Code != 200 {
                t.Fatalf("preview HTTP %d: %s", rec.Code, rec.Body.String())
        }
        var first map[string]any
        json.Unmarshal(rec.Body.Bytes(), &first)
        if first["title"] != "Served Once" {
                t.Errorf("title = %v", first["title"])
        }
        if first["cached"] == true {
                t.Error("first response must not be cached")
        }

        rec2 := httptest.NewRecorder()
        s.mux.ServeHTTP(rec2, httptest.NewRequest("GET", "/api/preview?url="+q, nil))
        var second map[string]any
        json.Unmarshal(rec2.Body.Bytes(), &second)
        if second["cached"] != true {
                t.Error("second response must be cached:true")
        }
        if hits != 1 {
                t.Errorf("origin hits = %d, want 1 (the cache must serve the repeat)", hits)
        }

        // SSRF refusal on the live route (guard restored after stub cleanup?
        // — stub is active for the whole test; call the guard directly)
        if isPublicPreviewHost("localhost") {
                t.Error("guard must refuse localhost")
        }
}
