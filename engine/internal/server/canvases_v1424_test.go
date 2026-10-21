package server

// canvases_v1424_test.go — v1.42.4 THE LEDGER (PLAN-V142 §3.2 W2): the
// multi-canvas CRUD surface, rig-proven at the Go layer:
//
//   (1)  the empty ledger lists clean (shape, not null);
//   (2)  POST creates (id minted when absent, defaults honest);
//   (3)  GET returns the full row with state as RAW JSON;
//   (4)  GET missing → 404;
//   (5)  PUT updates partial fields (absent state keeps the row's);
//   (6)  PUT on a MISSING id upserts (the idempotent migration retry);
//   (7)  the 4MB state cap (413 at the door);
//   (8)  a non-JSON state is refused (the json_valid CHECK backstop);
//   (9)  thumbs: PNG + JPEG magic sniffed, wrong magic 415, the 64KB
//        cap 413, missing canvas 404, GET echoes bytes + content-type;
//   (10) DELETE is idempotent (missing deletes ok:true);
//   (11) the digest: icon ids + session ids across canvases;
//   (12) /api/storage/usage counts the canvases;
//   (13) the migration shape: a real state.v2-shaped blob round-trips
//        verbatim (icons with sessionId + dots + savedAt);
//   (14) concurrent PUTs on one id converge (last-write-wins, one row);
//   (15) the store layer's json_valid guard (direct corrupt write dies).

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"sync"
	"testing"
)

func v1424Get(t *testing.T, s *Server, path string) (int, map[string]any, []byte) {
	t.Helper()
	req := httptest.NewRequest("GET", path, nil)
	w := httptest.NewRecorder()
	s.mux.ServeHTTP(w, req)
	var body map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &body)
	return w.Code, body, w.Body.Bytes()
}

func v1424Send(t *testing.T, s *Server, method, path string, payload any) (int, map[string]any) {
	t.Helper()
	var rdr *bytes.Reader
	switch p := payload.(type) {
	case nil:
		rdr = bytes.NewReader(nil)
	case []byte:
		rdr = bytes.NewReader(p)
	default:
		jb, _ := json.Marshal(payload)
		rdr = bytes.NewReader(jb)
	}
	req := httptest.NewRequest(method, path, rdr)
	if _, ok := payload.([]byte); ok {
		req.Header.Set("Content-Type", "application/octet-stream")
	} else if payload != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	w := httptest.NewRecorder()
	s.mux.ServeHTTP(w, req)
	var body map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &body)
	return w.Code, body
}

// a realistic state.v2-shaped WorldState blob (what worlds.js sends).
func v1424State(savedAt float64) map[string]any {
	return map[string]any{
		"offset":        map[string]any{"x": -120.5, "y": 88.25},
		"scale":         0.85,
		"currentFamily": "aurora",
		"icons": []any{
			map[string]any{"id": "chat_alpha", "type": "chat", "sessionId": "sess-1", "x": 10, "y": 20},
			map[string]any{"id": "chat_beta", "type": "chat", "x": 30, "y": 40},
			map[string]any{"id": "web_gamma", "type": "web", "sessionId": "sess-2", "x": 50, "y": 60},
		},
		"dots":    []any{map[string]any{"id": "dot-1", "members": []any{"web_gamma"}}},
		"savedAt": savedAt,
	}
}

func TestV1424_EmptyLedgerListsClean(t *testing.T) {
	s := newLongHaulServer(t)
	code, body, _ := v1424Get(t, s, "/api/canvases")
	if code != 200 {
		t.Fatalf("list code = %d", code)
	}
	rows, _ := body["canvases"].([]any)
	if rows == nil || len(rows) != 0 {
		t.Fatalf("empty ledger must be [], got %v", body["canvases"])
	}
}

func TestV1424_CreateDefaultsAndMinting(t *testing.T) {
	s := newLongHaulServer(t)
	code, body := v1424Send(t, s, "POST", "/api/canvases", map[string]any{})
	if code != 201 {
		t.Fatalf("create code = %d body=%v", code, body)
	}
	c, _ := body["canvas"].(map[string]any)
	if c == nil || c["id"] == "" || c["id"].(string) == "" {
		t.Fatalf("id must be minted, got %v", body)
	}
	if c["name"] != "Canvas" {
		t.Fatalf("default name, got %v", c["name"])
	}
	// explicit id + name + state rides verbatim
	code, body = v1424Send(t, s, "POST", "/api/canvases", map[string]any{
		"id": "default", "name": "Main", "state": v1424State(1000),
	})
	if code != 201 {
		t.Fatalf("create2 code = %d", code)
	}
	c2, _ := body["canvas"].(map[string]any)
	st, _ := c2["state"].(map[string]any)
	if st == nil || st["currentFamily"] != "aurora" {
		t.Fatalf("state must ride as raw JSON, got %v", c2["state"])
	}
}

func TestV1424_GetFullRowAndMissing404(t *testing.T) {
	s := newLongHaulServer(t)
	v1424Send(t, s, "POST", "/api/canvases", map[string]any{"id": "a1", "state": v1424State(2000)})
	code, body, _ := v1424Get(t, s, "/api/canvases/a1")
	if code != 200 {
		t.Fatalf("get code = %d", code)
	}
	c, _ := body["canvas"].(map[string]any)
	st, _ := c["state"].(map[string]any)
	if st == nil || st["savedAt"].(float64) != 2000 {
		t.Fatalf("state round-trip broken: %v", c["state"])
	}
	code, _, _ = v1424Get(t, s, "/api/canvases/nope")
	if code != 404 {
		t.Fatalf("missing must 404, got %d", code)
	}
}

func TestV1424_PutPartialKeepsState(t *testing.T) {
	s := newLongHaulServer(t)
	v1424Send(t, s, "POST", "/api/canvases", map[string]any{"id": "a1", "name": "Before", "state": v1424State(3000)})
	// rename-only PUT: state absent → row's state survives
	code, body := v1424Send(t, s, "PUT", "/api/canvases/a1", map[string]any{"name": "After"})
	if code != 200 {
		t.Fatalf("put code = %d", code)
	}
	c, _ := body["canvas"].(map[string]any)
	if c["name"] != "After" {
		t.Fatalf("rename lost: %v", c["name"])
	}
	st, _ := c["state"].(map[string]any)
	if st == nil || st["savedAt"].(float64) != 3000 {
		t.Fatalf("absent state must keep row value, got %v", c["state"])
	}
	// full-state PUT replaces
	code, body = v1424Send(t, s, "PUT", "/api/canvases/a1", map[string]any{"state": v1424State(4000)})
	if code != 200 {
		t.Fatalf("put2 code = %d", code)
	}
	c, _ = body["canvas"].(map[string]any)
	st, _ = c["state"].(map[string]any)
	if st["savedAt"].(float64) != 4000 {
		t.Fatalf("state replace broken: %v", c["state"])
	}
}

func TestV1424_PutUpsertsMissing(t *testing.T) {
	s := newLongHaulServer(t)
	// the idempotent migration retry: PUT on a missing id CREATES
	code, body := v1424Send(t, s, "PUT", "/api/canvases/default", map[string]any{"name": "Migrated", "state": v1424State(5000)})
	if code != 200 {
		t.Fatalf("upsert-put code = %d body=%v", code, body)
	}
	code, body, _ = v1424Get(t, s, "/api/canvases/default")
	if code != 200 {
		t.Fatalf("row must exist after upsert-put: %d", code)
	}
	c, _ := body["canvas"].(map[string]any)
	if c["name"] != "Migrated" {
		t.Fatalf("upsert name: %v", c["name"])
	}
}

func TestV1424_StateCap413(t *testing.T) {
	s := newLongHaulServer(t)
	// the pad rides INSIDE state (the WorldState shape) — over the 4MB cap
	huge := map[string]any{"state": map[string]any{"savedAt": 1, "icons": []any{}, "pad": string(bytes.Repeat([]byte("x"), 4<<20))}}
	code, body := v1424Send(t, s, "PUT", "/api/canvases/big", huge)
	if code != 413 {
		t.Fatalf("over-cap state must 413, got %d %v", code, body)
	}
	// the POST door enforces the same cap
	code, _ = v1424Send(t, s, "POST", "/api/canvases", huge)
	if code != 413 {
		t.Fatalf("over-cap state via POST must 413, got %d", code)
	}
}

func TestV1424_NonJSONStateRefused(t *testing.T) {
	s := newLongHaulServer(t)
	// the json_valid CHECK is the DB boundary; the handler's JSON decode
	// of the outer body catches this shape first — both must refuse.
	req := httptest.NewRequest("PUT", "/api/canvases/a1", bytes.NewReader([]byte(`{"state": "not json {"}`)))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	s.mux.ServeHTTP(w, req)
	if w.Code != 400 {
		t.Fatalf("string state must 400 (raw-JSON contract), got %d", w.Code)
	}
}

func TestV1424_Thumbs(t *testing.T) {
	s := newLongHaulServer(t)
	v1424Send(t, s, "POST", "/api/canvases", map[string]any{"id": "t1"})
	// PNG magic
	png := append([]byte{0x89, 'P', 'N', 'G', 0x0D, 0x0A, 0x1A, 0x0A}, bytes.Repeat([]byte{1}, 256)...)
	code, body := v1424Send(t, s, "PUT", "/api/canvases/t1/thumb", png)
	if code != 200 || body["content_type"] != "image/png" {
		t.Fatalf("png thumb: %d %v", code, body)
	}
	// GET echoes bytes
	req := httptest.NewRequest("GET", "/api/canvases/t1/thumb", nil)
	w := httptest.NewRecorder()
	s.mux.ServeHTTP(w, req)
	if w.Code != 200 || w.Header().Get("Content-Type") != "image/png" || !bytes.Equal(w.Body.Bytes(), png) {
		t.Fatalf("thumb get broken: %d %s len=%d", w.Code, w.Header().Get("Content-Type"), w.Body.Len())
	}
	// JPEG magic
	jpg := append([]byte{0xFF, 0xD8, 0xFF, 0xE0}, bytes.Repeat([]byte{2}, 64)...)
	code, body = v1424Send(t, s, "PUT", "/api/canvases/t1/thumb", jpg)
	if code != 200 || body["content_type"] != "image/jpeg" {
		t.Fatalf("jpeg thumb: %d %v", code, body)
	}
	// wrong magic → 415 (Content-Type header LIES; bytes decide)
	req = httptest.NewRequest("PUT", "/api/canvases/t1/thumb", bytes.NewReader([]byte("<html>not an image</html>")))
	req.Header.Set("Content-Type", "image/png")
	w = httptest.NewRecorder()
	s.mux.ServeHTTP(w, req)
	if w.Code != 415 {
		t.Fatalf("fake png must 415, got %d", w.Code)
	}
	// >64KB → 413
	big := append([]byte{0x89, 'P', 'N', 'G', 0x0D, 0x0A, 0x1A, 0x0A}, bytes.Repeat([]byte{9}, 65<<10)...)
	code, _ = v1424Send(t, s, "PUT", "/api/canvases/t1/thumb", big)
	if code != 413 {
		t.Fatalf("over-cap thumb must 413, got %d", code)
	}
	// missing canvas → 404
	code, _ = v1424Send(t, s, "PUT", "/api/canvases/ghost/thumb", png)
	if code != 404 {
		t.Fatalf("ghost thumb must 404, got %d", code)
	}
	// thumb GET on a canvas without one → 404 (one honest shape)
	code, _, _ = v1424Get(t, s, "/api/canvases/nothumb")
	_ = code
	req = httptest.NewRequest("GET", "/api/canvases/nothumb/thumb", nil)
	w = httptest.NewRecorder()
	s.mux.ServeHTTP(w, req)
	if w.Code != 404 {
		t.Fatalf("no-thumb get must 404, got %d", w.Code)
	}
}

func TestV1424_DeleteIdempotent(t *testing.T) {
	s := newLongHaulServer(t)
	v1424Send(t, s, "POST", "/api/canvases", map[string]any{"id": "d1"})
	code, body := v1424Send(t, s, "DELETE", "/api/canvases/d1", nil)
	if code != 200 || body["ok"] != true {
		t.Fatalf("delete: %d %v", code, body)
	}
	code, body = v1424Send(t, s, "DELETE", "/api/canvases/d1", nil)
	if code != 200 || body["ok"] != true {
		t.Fatalf("delete must be idempotent: %d %v", code, body)
	}
	code, _, _ = v1424Get(t, s, "/api/canvases/d1")
	if code != 404 {
		t.Fatalf("deleted row must 404, got %d", code)
	}
}

func TestV1424_Digest(t *testing.T) {
	s := newLongHaulServer(t)
	v1424Send(t, s, "POST", "/api/canvases", map[string]any{"id": "c1", "state": v1424State(1)})
	// a second canvas with its own icons (an icon on ANY canvas is live)
	v1424Send(t, s, "POST", "/api/canvases", map[string]any{"id": "c2", "state": map[string]any{
		"icons": []any{map[string]any{"id": "web_zeta", "sessionId": "sess-9"}},
	}})
	code, body, _ := v1424Get(t, s, "/api/canvases?digest=1")
	if code != 200 {
		t.Fatalf("digest code = %d", code)
	}
	rows, _ := body["canvases"].([]any)
	if len(rows) != 2 {
		t.Fatalf("digest rows = %d", len(rows))
	}
	joined := map[string]bool{}
	for _, r := range rows {
		d, _ := r.(map[string]any)
		for _, id := range d["icon_ids"].([]any) {
			joined[id.(string)] = true
		}
		for _, id := range d["session_ids"].([]any) {
			joined["s:"+id.(string)] = true
		}
	}
	for _, want := range []string{"chat_alpha", "chat_beta", "web_gamma", "web_zeta", "s:sess-1", "s:sess-2", "s:sess-9"} {
		if !joined[want] {
			t.Fatalf("digest missing %s: %v", want, joined)
		}
	}
	// the PLAIN list stays summary-shaped (no ids leak into it)
	_, body, _ = v1424Get(t, s, "/api/canvases")
	for _, r := range body["canvases"].([]any) {
		if _, has := r.(map[string]any)["icon_ids"]; has {
			t.Fatalf("plain list must not carry digests: %v", r)
		}
		if ic := r.(map[string]any)["icon_count"].(float64); ic != 3 && ic != 1 {
			t.Fatalf("icon_count probe broken: %v", r)
		}
	}
}

func TestV1424_UsageCountsCanvases(t *testing.T) {
	s := newLongHaulServer(t)
	v1424Send(t, s, "POST", "/api/canvases", map[string]any{"id": "a"})
	v1424Send(t, s, "POST", "/api/canvases", map[string]any{"id": "b"})
	code, body, _ := v1424Get(t, s, "/api/storage/usage")
	if code != 200 {
		t.Fatalf("usage code = %d", code)
	}
	e, _ := body["engine"].(map[string]any)
	if e == nil || e["canvases"].(float64) != 2 {
		t.Fatalf("usage canvases = %v", e)
	}
}

func TestV1424_MigrationShapeRoundTrip(t *testing.T) {
	s := newLongHaulServer(t)
	// the EXACT state.v2 shape (icons + dots + savedAt + camera + family)
	state := v1424State(1234567890)
	code, _ := v1424Send(t, s, "PUT", "/api/canvases/default", map[string]any{"name": "default", "state": state})
	if code != 200 {
		t.Fatalf("migration put: %d", code)
	}
	code, body, _ := v1424Get(t, s, "/api/canvases/default")
	c, _ := body["canvas"].(map[string]any)
	st, _ := c["state"].(map[string]any)
	icons, _ := st["icons"].([]any)
	if len(icons) != 3 {
		t.Fatalf("icons round-trip: %d", len(icons))
	}
	first, _ := icons[0].(map[string]any)
	if first["sessionId"] != "sess-1" {
		t.Fatalf("sessionId must survive: %v", first)
	}
	dots, _ := st["dots"].([]any)
	if len(dots) != 1 {
		t.Fatalf("dots round-trip: %d", len(dots))
	}
	if st["currentFamily"] != "aurora" {
		t.Fatalf("family must survive: %v", st["currentFamily"])
	}
}

func TestV1424_ConcurrentPutsConverge(t *testing.T) {
	s := newLongHaulServer(t)
	v1424Send(t, s, "POST", "/api/canvases", map[string]any{"id": "race"})
	var wg sync.WaitGroup
	for i := 0; i < 12; i++ {
		wg.Add(1)
		go func(n int) {
			defer wg.Done()
			v1424Send(t, s, "PUT", "/api/canvases/race", map[string]any{"state": v1424State(float64(n))})
		}(i)
	}
	wg.Wait()
	code, body, _ := v1424Get(t, s, "/api/canvases?digest=1")
	if code != 200 {
		t.Fatalf("after-race list: %d", code)
	}
	rows, _ := body["canvases"].([]any)
	count := 0
	for _, r := range rows {
		if r.(map[string]any)["id"] == "race" {
			count++
		}
	}
	if count != 1 {
		t.Fatalf("concurrent puts must converge on ONE row, got %d", count)
	}
}

func TestV1424_StoreLayerJsonValidGuard(t *testing.T) {
	s := newLongHaulServer(t)
	// a corrupt state must die AT THE DB BOUNDARY (the CHECK constraint)
	poison := "not json {"
	if _, err := s.db.UpsertCanvas("poison", nil, nil, &poison); err == nil {
		t.Fatalf("json_valid CHECK must refuse corrupt state")
	}
	// and a VALID one passes
	fine := `{"savedAt":1}`
	if _, err := s.db.UpsertCanvas("fine", nil, nil, &fine); err != nil {
		t.Fatalf("valid state refused: %v", err)
	}
}

// TestV1424_StateOnlyPutNeverClobbersName — the contract the Worlds
// sync rides: a state-only PUT (no name/sort fields) must NEVER rename
// or re-sort a user-titled canvas. THE LEDGER's core honesty law.
func TestV1424_StateOnlyPutNeverClobbersName(t *testing.T) {
	s := newLongHaulServer(t)
	name := "My Main World"
	sortv := int64(7)
	if _, err := s.db.UpsertCanvas("w1", &name, &sortv, nil); err != nil {
		t.Fatalf("birth: %v", err)
	}
	// 20 state-only syncs (the drag-rate cadence)
	for i := 0; i < 20; i++ {
		st := `{"savedAt":` + fmt.Sprint(i) + `,"icons":[]}`
		c, err := s.db.UpsertCanvas("w1", nil, nil, &st)
		if err != nil {
			t.Fatalf("sync %d: %v", i, err)
		}
		if c.Name != name || c.Sort != 7 {
			t.Fatalf("sync %d clobbered name/sort: %q/%d", i, c.Name, c.Sort)
		}
	}
	// and the mirror: a rename-only PUT never drops state
	if _, err := s.db.UpsertCanvas("w1", strPtr("Renamed"), nil, nil); err != nil {
		t.Fatalf("rename: %v", err)
	}
	c, _ := s.db.GetCanvas("w1")
	if c.State == "" || c.Name != "Renamed" {
		t.Fatalf("rename dropped state: %q", c.State)
	}
}

func strPtr(s string) *string { return &s }

func TestV1424_ListOrderSortAscUpdatedDesc(t *testing.T) {
	s := newLongHaulServer(t)
	v1424Send(t, s, "POST", "/api/canvases", map[string]any{"id": "z", "sort": 10})
	v1424Send(t, s, "POST", "/api/canvases", map[string]any{"id": "a", "sort": 1})
	v1424Send(t, s, "POST", "/api/canvases", map[string]any{"id": "m", "sort": 5})
	_, body, _ := v1424Get(t, s, "/api/canvases")
	rows, _ := body["canvases"].([]any)
	if rows[0].(map[string]any)["id"] != "a" || rows[1].(map[string]any)["id"] != "m" || rows[2].(map[string]any)["id"] != "z" {
		t.Fatalf("order must be sort-asc, got %v", rows)
	}
	// savedAt probe present in the row
	if _, has := rows[0].(map[string]any)["saved_at"]; !has {
		t.Fatalf("rows must carry saved_at: %v", rows[0])
	}
	// has_thumb probe
	if rows[0].(map[string]any)["has_thumb"] != false {
		t.Fatalf("has_thumb probe: %v", rows[0])
	}
}

func TestV1424_SavedAtProbe(t *testing.T) {
	s := newLongHaulServer(t)
	v1424Send(t, s, "POST", "/api/canvases", map[string]any{"id": "sa", "state": v1424State(7777)})
	_, body, _ := v1424Get(t, s, "/api/canvases")
	rows, _ := body["canvases"].([]any)
	if got := rows[0].(map[string]any)["saved_at"].(float64); got != 7777 {
		t.Fatalf("saved_at probe = %v, want 7777", got)
	}
	// a state WITHOUT savedAt probes 0 (poison tolerance, not an error)
	v1424Send(t, s, "POST", "/api/canvases", map[string]any{"id": "nsa", "state": map[string]any{"icons": []any{}}})
	_, body, _ = v1424Get(t, s, "/api/canvases")
	for _, r := range body["canvases"].([]any) {
		if r.(map[string]any)["id"] == "nsa" && r.(map[string]any)["saved_at"].(float64) != 0 {
			t.Fatalf("missing savedAt must probe 0: %v", r)
		}
	}
	// shell row (no state at all) also probes 0 with icon_count 0
	v1424Send(t, s, "POST", "/api/canvases", map[string]any{"id": "shell"})
	_, body, _ = v1424Get(t, s, "/api/canvases")
	for _, r := range body["canvases"].([]any) {
		rm := r.(map[string]any)
		if rm["id"] == "shell" && (rm["saved_at"].(float64) != 0 || rm["icon_count"].(float64) != 0) {
			t.Fatalf("shell row probes: %v", rm)
		}
	}
}

// TestV1427_StateBytesProbe — v1.42.7 THE MANAGER: the list row carries
// the stored state's size (the manager rows' size line). A shell row (no
// state) probes 0 — poison tolerance, the saved_at law's twin.
func TestV1427_StateBytesProbe(t *testing.T) {
	s := newLongHaulServer(t)
	v1424Send(t, s, "POST", "/api/canvases", map[string]any{"id": "sz", "state": v1424State(1)})
	_, body, _ := v1424Get(t, s, "/api/canvases")
	rows, _ := body["canvases"].([]any)
	var withState float64 = -1
	for _, r := range rows {
		if r.(map[string]any)["id"] == "sz" {
			withState = r.(map[string]any)["state_bytes"].(float64)
		}
	}
	if withState <= 0 {
		t.Fatalf("state_bytes must be > 0 for a stored state, got %v", withState)
	}
	// shell row (no state) probes 0
	v1424Send(t, s, "POST", "/api/canvases", map[string]any{"id": "shelldb"})
	_, body, _ = v1424Get(t, s, "/api/canvases")
	for _, r := range body["canvases"].([]any) {
		rm := r.(map[string]any)
		if rm["id"] == "shelldb" && rm["state_bytes"].(float64) != 0 {
			t.Fatalf("shell row state_bytes must be 0: %v", rm)
		}
	}
	// a rename-only PUT keeps the state (its bytes still present)
	v1424Send(t, s, "PUT", "/api/canvases/sz", map[string]any{"name": "renamed"})
	_, body, _ = v1424Get(t, s, "/api/canvases")
	for _, r := range body["canvases"].([]any) {
		rm := r.(map[string]any)
		if rm["id"] == "sz" && (rm["name"] != "renamed" || rm["state_bytes"].(float64) <= 0) {
			t.Fatalf("rename must keep state bytes: %v", rm)
		}
	}
}

func TestV1424_CreatedAtImmutableOnUpsert(t *testing.T) {
	s := newLongHaulServer(t)
	_, body := v1424Send(t, s, "POST", "/api/canvases", map[string]any{"id": "birth"})
	born, _ := body["canvas"].(map[string]any)["created_at"].(float64)
	_, body = v1424Send(t, s, "PUT", "/api/canvases/birth", map[string]any{"name": "renamed"})
	after, _ := body["canvas"].(map[string]any)["created_at"].(float64)
	if born == 0 || after != born {
		t.Fatalf("created_at must be immutable across upserts: %v → %v", born, after)
	}
	// updated_at ADVANCES (the row's pulse)
	upd, _ := body["canvas"].(map[string]any)["updated_at"].(float64)
	if upd < born {
		t.Fatalf("updated_at must advance: %v", upd)
	}
}

func TestV1424_PutInvalidIDRejected(t *testing.T) {
	s := newLongHaulServer(t)
	// a URL-encoded slash rides the path value unescaped ("a/b") — the
	// traversal guard must refuse it at the door. (A literal /a/b never
	// routes here: {id} is single-segment, so the PWA catch-all 404s it.)
	req := httptest.NewRequest("PUT", "/api/canvases/a%2Fb", bytes.NewReader([]byte(`{"name":"x"}`)))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	s.mux.ServeHTTP(w, req)
	if w.Code != 400 {
		t.Fatalf("slashed id must 400, got %d", w.Code)
	}
	req2 := httptest.NewRequest("PUT", "/api/canvases/a%5Cb", bytes.NewReader([]byte(`{"name":"x"}`)))
	req2.Header.Set("Content-Type", "application/json")
	w2 := httptest.NewRecorder()
	s.mux.ServeHTTP(w2, req2)
	if w2.Code != 400 {
		t.Fatalf("backslashed id must 400, got %d", w2.Code)
	}
}

// TestV1540_ImportedProbe — the list's $.imported.from JSON1 probe (the
// v1.54 provenance chip's backing): an imported world's row carries the
// source name; a home-grown world's row carries "".
func TestV1540_ImportedProbe(t *testing.T) {
	s := newLongHaulServer(t)
	// a home-grown world (no imported stamp)
	code, body := v1424Send(t, s, "POST", "/api/canvases", map[string]any{
		"name":  "Home Grown",
		"state": v1424State(1),
	})
	if code != 200 && code != 201 {
		t.Fatalf("create code = %d", code)
	}
	// an imported world (the v1.42.8 stamp shape)
	st := v1424State(2)
	st["imported"] = map[string]any{"from": "Aurora World", "author": "alice", "at": "2026-10-21T00:00:00Z", "appVersion": "1.42.8"}
	code, _ = v1424Send(t, s, "POST", "/api/canvases", map[string]any{
		"name":  "Downloaded World",
		"state": st,
	})
	if code != 200 && code != 201 {
		t.Fatalf("create 2 code = %d", code)
	}
	code, body, _ = v1424Get(t, s, "/api/canvases")
	if code != 200 {
		t.Fatalf("list code = %d", code)
	}
	rows, _ := body["canvases"].([]any)
	if len(rows) != 2 {
		t.Fatalf("rows = %d", len(rows))
	}
	seen := map[string]string{}
	for _, r := range rows {
		m, _ := r.(map[string]any)
		if m == nil {
			continue
		}
		seen[m["name"].(string)], _ = m["imported"].(string)
	}
	if seen["Home Grown"] != "" {
		t.Fatalf("home-grown row carries imported = %q", seen["Home Grown"])
	}
	if seen["Downloaded World"] != "Aurora World" {
		t.Fatalf("imported row carries imported = %q, want Aurora World", seen["Downloaded World"])
	}
}
