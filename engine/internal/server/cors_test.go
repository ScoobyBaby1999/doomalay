package server

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/ScoobyBaby1999/doomalay/engine/internal/config"
	"github.com/ScoobyBaby1999/doomalay/engine/internal/store"
)

// v0.30.1 (red-team fix): same-origin CORS-mode requests through a reverse
// proxy / tunnel must pass the CORS middleware. The localhost.run red-team
// found /vendor/pm/* returning 403 because module scripts (<script
// type="module">) always send Origin — through the tunnel that origin is
// the proxy host, which the localhost-only allowlist rejected → the PM SDK
// never loaded → the boot watchdog killed the app with the recovery screen.

// probeCORS runs one request through the middleware and returns status + body.
func probeCORS(t *testing.T, method, path, origin, host string) (int, string) {
	t.Helper()
	dir := t.TempDir()
	db, err := store.Open(dir)
	if err != nil {
		t.Fatalf("store: %v", err)
	}
	if err := db.Migrate(); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	s := New(&config.Config{DataDir: dir}, db, nil)

	// A static route exercises the real middleware chain without touching
	// API handlers (the PM wasm route needs the embedded asset; the health
	// route is exempt from auth, which is what we want to isolate CORS).
	var gotStatus int
	var gotBody string
	handler := s.corsMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotStatus, gotBody = 200, "ok"
		w.WriteHeader(200)
		_, _ = w.Write([]byte("ok"))
	}))

	req := httptest.NewRequest(method, path, nil)
	if origin != "" {
		req.Header.Set("Origin", origin)
	}
	req.Host = host
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if gotStatus == 0 {
		// The middleware rejected before the handler ran.
		return rec.Code, rec.Body.String()
	}
	return rec.Code, gotBody
}

// TestCORSSameOriginThroughProxy — the tunnel scenario: the page and the
// request share the proxy host (module scripts always send Origin).
func TestCORSSameOriginThroughProxy(t *testing.T) {
	cases := []struct {
		origin string
		host   string
		want   int
	}{
		// The red-team's exact tunnel: Origin == Host (both the proxy host).
		{"https://75249e288c9375.lhr.life", "75249e288c9375.lhr.life", 200},
		// LAN access: the engine itself is the origin (was 403 before).
		{"http://192.168.1.5:8080", "192.168.1.5:8080", 200},
		// Default-port equivalences.
		{"https://tunnel.example.com", "tunnel.example.com:443", 200},
		{"http://box.lan", "box.lan:80", 200},
		// localhost still allowed by the allowlist itself.
		{"http://localhost:8080", "localhost:8080", 200},
		// MISMATCHED hosts stay blocked.
		{"https://evil.example.com", "75249e288c9375.lhr.life", 403},
		{"https://75249e288c9375.lhr.life", "evil.example.com", 403},
		{"https://192.168.1.5.evil.com", "192.168.1.5:8080", 403},
		// No Origin at all (curl / same-origin classic requests) — passes.
		{"", "75249e288c9375.lhr.life", 200},
	}
	for _, c := range cases {
		code, _ := probeCORS(t, "GET", "/vendor/pm/pmsdk.js", c.origin, c.host)
		if code != c.want {
			t.Errorf("CORS origin=%q host=%q: got %d, want %d", c.origin, c.host, code, c.want)
		}
	}
}

// TestCORSPreflightThroughProxy — OPTIONS preflights from the proxied PWA
// must answer 200 (the app POSTs/PATCHes through the tunnel too).
func TestCORSPreflightThroughProxy(t *testing.T) {
	code, _ := probeCORS(t, "OPTIONS", "/api/sessions", "https://75249e288c9375.lhr.life", "75249e288c9375.lhr.life")
	if code != 200 {
		t.Fatalf("preflight through proxy: got %d, want 200", code)
	}
}

// TestIsSameOrigin — unit-level: host/port matching rules.
func TestIsSameOrigin(t *testing.T) {
	cases := []struct {
		origin string
		host   string
		want   bool
	}{
		{"https://a.b.c", "a.b.c", true},
		{"https://a.b.c", "A.B.C", true}, // case-insensitive host
		{"https://a.b.c:443", "a.b.c", true},
		{"https://a.b.c", "a.b.c:443", true},
		{"http://a.b.c:8080", "a.b.c:8080", true},
		{"http://a.b.c:8080", "a.b.c:9090", false},
		{"https://x.y", "a.b.c", false},
		{"https://a.b.c.evil.com", "a.b.c", false},
		{"https://a.b.c", "a.b.c.evil.com", false},
		{"://bad origin", "a.b.c", false},
		{"", "", false},
	}
	for _, c := range cases {
		r := httptest.NewRequest("GET", "/x", nil)
		r.Host = c.host
		if got := isSameOrigin(r, c.origin); got != c.want {
			t.Errorf("isSameOrigin(%q, %q) = %v, want %v", c.origin, c.host, got, c.want)
		}
	}
}

// TestVersionReported — /api/health + /api/capabilities must report the
// buildinfo version (the red-team found "0.1.0" on a v0.28.0 build).
func TestVersionReported(t *testing.T) {
	dir := t.TempDir()
	db, err := store.Open(dir)
	if err != nil {
		t.Fatalf("store: %v", err)
	}
	if err := db.Migrate(); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	s := New(&config.Config{DataDir: dir}, db, nil)

	for _, path := range []string{"/api/health", "/api/capabilities"} {
		req := httptest.NewRequest("GET", path, nil)
		rec := httptest.NewRecorder()
		s.mux.ServeHTTP(rec, req)
		if rec.Code != 200 {
			t.Fatalf("%s: got %d, want 200", path, rec.Code)
		}
		if !strings.Contains(rec.Body.String(), `"version"`) {
			t.Fatalf("%s: no version field in response", path)
		}
	}
}
