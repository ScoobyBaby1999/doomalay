package server

// v30_test.go — v0.30 engine behaviors: the per-chat TWEAKS kv store
// (GET/PUT /api/sessions/{id}/tweaks — size cap + JSON validation) and
// the chat BACKGROUND image endpoint (PUT/GET/DELETE round-trip, rev
// bumping, mime sniffing, the 4MB cap, and the session-delete cleanup
// that keeps kv rows from outliving their chat).

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/ScoobyBaby1999/doomalay/engine/internal/config"
	"github.com/ScoobyBaby1999/doomalay/engine/internal/store"
)

func seedV30Session(t *testing.T, id string) *Server {
	t.Helper()
	dir := t.TempDir()
	db, err := store.Open(dir)
	if err != nil {
		t.Fatalf("store: %v", err)
	}
	if err := db.Migrate(); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	if err := db.CreateSession(&store.Session{
		ID: id, Title: "V30", Provider: "nvidia",
		Model: "nvidia/nvidia/nemotron-3-super", SlidingWindow: 40,
	}); err != nil {
		t.Fatalf("create: %v", err)
	}
	return New(&config.Config{DataDir: dir}, db, nil)
}

// TestTweaksRoundTrip — the tweak blob saves and reads back exactly; a
// chat that never customized anything gets the empty object.
func TestTweaksRoundTrip(t *testing.T) {
	s := seedV30Session(t, "v30a")

	rec := httptest.NewRecorder()
	s.mux.ServeHTTP(rec, httptest.NewRequest("GET", "/api/sessions/v30a/tweaks", nil))
	if rec.Code != 200 {
		t.Fatalf("GET status %d", rec.Code)
	}
	var got struct {
		Tweaks map[string]any `json:"tweaks"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(got.Tweaks) != 0 {
		t.Fatalf("expected empty tweaks on a fresh chat, got %v", got.Tweaks)
	}

	blob := `{"chatScheme":"rose","fmtOverrides":{"a1":"#ff0055"},"chatTextSize":80,"bg":{"type":"color","color":"#101020"}}`
	rec = httptest.NewRecorder()
	s.mux.ServeHTTP(rec, httptest.NewRequest("PUT", "/api/sessions/v30a/tweaks", strings.NewReader(blob)))
	if rec.Code != 200 {
		t.Fatalf("PUT status %d body %s", rec.Code, rec.Body.String())
	}

	rec = httptest.NewRecorder()
	s.mux.ServeHTTP(rec, httptest.NewRequest("GET", "/api/sessions/v30a/tweaks", nil))
	if rec.Code != 200 {
		t.Fatalf("GET after PUT status %d", rec.Code)
	}
	var back struct {
		Tweaks json.RawMessage `json:"tweaks"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&back); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if strings.TrimSpace(string(back.Tweaks)) != strings.TrimSpace(blob) {
		t.Fatalf("tweaks did not round-trip:\n got %s\nwant %s", back.Tweaks, blob)
	}
}

// TestTweaksValidation — invalid JSON 400s; oversized blobs 413; unknown
// sessions 404 (tweaks must never attach to a chat that doesn't exist).
func TestTweaksValidation(t *testing.T) {
	s := seedV30Session(t, "v30b")

	rec := httptest.NewRecorder()
	s.mux.ServeHTTP(rec, httptest.NewRequest("PUT", "/api/sessions/v30b/tweaks", strings.NewReader(`{nope`)))
	if rec.Code != 400 {
		t.Fatalf("invalid JSON: status %d, want 400", rec.Code)
	}

	big := `{"x":"` + strings.Repeat("a", 70<<10) + `"}`
	rec = httptest.NewRecorder()
	s.mux.ServeHTTP(rec, httptest.NewRequest("PUT", "/api/sessions/v30b/tweaks", strings.NewReader(big)))
	if rec.Code != 413 {
		t.Fatalf("oversized: status %d, want 413", rec.Code)
	}

	rec = httptest.NewRecorder()
	s.mux.ServeHTTP(rec, httptest.NewRequest("GET", "/api/sessions/ghost/tweaks", nil))
	if rec.Code != 404 {
		t.Fatalf("unknown session GET: status %d, want 404", rec.Code)
	}
	rec = httptest.NewRecorder()
	s.mux.ServeHTTP(rec, httptest.NewRequest("PUT", "/api/sessions/ghost/tweaks", strings.NewReader(`{}`)))
	if rec.Code != 404 {
		t.Fatalf("unknown session PUT: status %d, want 404", rec.Code)
	}
}

// a 2×2 red PNG — a real image with real magic bytes.
var tinyPNG = []byte{
	0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, // PNG signature
	0, 0, 0, 13, 'I', 'H', 'D', 'R', 0, 0, 0, 2, 0, 0, 0, 2, 8, 2, 0, 0, 0,
}

// TestBackgroundRoundTrip — upload, read back byte-exact with the sniffed
// content type, re-upload bumps the rev (the client's ?v= cache-buster).
func TestBackgroundRoundTrip(t *testing.T) {
	s := seedV30Session(t, "v30c")

	// no background yet → 404
	rec := httptest.NewRecorder()
	s.mux.ServeHTTP(rec, httptest.NewRequest("GET", "/api/sessions/v30c/background", nil))
	if rec.Code != 404 {
		t.Fatalf("fresh chat background: status %d, want 404", rec.Code)
	}

	// upload
	rec = httptest.NewRecorder()
	s.mux.ServeHTTP(rec, httptest.NewRequest("PUT", "/api/sessions/v30c/background", bytes.NewReader(tinyPNG)))
	if rec.Code != 200 {
		t.Fatalf("PUT background: status %d body %s", rec.Code, rec.Body.String())
	}
	var up struct {
		Rev  int    `json:"rev"`
		Mime string `json:"mime"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&up); err != nil {
		t.Fatalf("decode put: %v", err)
	}
	if up.Rev != 1 || up.Mime != "image/png" {
		t.Fatalf("put resp = %+v, want rev 1 + image/png", up)
	}

	// read back — bytes + content type + immutable cache header
	rec = httptest.NewRecorder()
	s.mux.ServeHTTP(rec, httptest.NewRequest("GET", "/api/sessions/v30c/background?v=1", nil))
	if rec.Code != 200 {
		t.Fatalf("GET background: status %d", rec.Code)
	}
	body, _ := io.ReadAll(rec.Body)
	if !bytes.Equal(body, tinyPNG) {
		t.Fatalf("background bytes differ (%d vs %d)", len(body), len(tinyPNG))
	}
	if ct := rec.Header().Get("Content-Type"); ct != "image/png" {
		t.Fatalf("content type %q, want image/png", ct)
	}
	if cc := rec.Header().Get("Cache-Control"); !strings.Contains(cc, "immutable") {
		t.Fatalf("cache-control %q, want immutable (per-?v=rev URLs are forever-valid)", cc)
	}

	// re-upload → rev bumps
	rec = httptest.NewRecorder()
	s.mux.ServeHTTP(rec, httptest.NewRequest("PUT", "/api/sessions/v30c/background", bytes.NewReader(tinyPNG)))
	if err := json.NewDecoder(rec.Body).Decode(&up); err != nil {
		t.Fatalf("decode re-put: %v", err)
	}
	if up.Rev != 2 {
		t.Fatalf("re-upload rev = %d, want 2", up.Rev)
	}

	// non-image bytes → 415
	rec = httptest.NewRecorder()
	s.mux.ServeHTTP(rec, httptest.NewRequest("PUT", "/api/sessions/v30c/background", strings.NewReader("definitely not an image")))
	if rec.Code != 415 {
		t.Fatalf("non-image: status %d, want 415", rec.Code)
	}

	// delete → gone
	rec = httptest.NewRecorder()
	s.mux.ServeHTTP(rec, httptest.NewRequest("DELETE", "/api/sessions/v30c/background", nil))
	if rec.Code != 200 {
		t.Fatalf("DELETE background: status %d", rec.Code)
	}
	rec = httptest.NewRecorder()
	s.mux.ServeHTTP(rec, httptest.NewRequest("GET", "/api/sessions/v30c/background", nil))
	if rec.Code != 404 {
		t.Fatalf("GET after DELETE: status %d, want 404", rec.Code)
	}
}

// TestSessionDeleteCleansTweaks — a deleted chat must not leak its tweak
// + background rows (they'd orphan in app_settings forever otherwise).
func TestSessionDeleteCleansTweaks(t *testing.T) {
	s := seedV30Session(t, "v30d")

	put := httptest.NewRecorder()
	s.mux.ServeHTTP(put, httptest.NewRequest("PUT", "/api/sessions/v30d/tweaks", strings.NewReader(`{"chatTextSize":70}`)))
	if put.Code != 200 {
		t.Fatalf("put tweaks: %d", put.Code)
	}
	s.mux.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("PUT", "/api/sessions/v30d/background", bytes.NewReader(tinyPNG)))

	rec := httptest.NewRecorder()
	s.mux.ServeHTTP(rec, httptest.NewRequest("DELETE", "/api/sessions/v30d", nil))
	if rec.Code != 200 {
		t.Fatalf("delete session: status %d", rec.Code)
	}

	// the session is gone; the kv rows went with it
	if raw, err := s.db.GetSetting("chat.tweaks.v30d"); err == nil && strings.TrimSpace(raw) != "" {
		t.Fatalf("tweaks row survived the session delete: %q", raw)
	}
	if raw, err := s.db.GetSetting("chat.bg.v30d"); err == nil && strings.TrimSpace(raw) != "" {
		t.Fatalf("background row survived the session delete: %q", raw)
	}
}
