package server

// v28_test.go — v0.28 engine behaviors: real-token usage reading, the
// client-driven compaction endpoint, per-chat compaction controls, the
// whole-chat sliding window, and the persona self-management tools
// (the bot's hands for its own personality).

import (
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/ScoobyBaby1999/doomalay/engine/internal/config"
	"github.com/ScoobyBaby1999/doomalay/engine/internal/store"
)

func seedV28Session(t *testing.T) (*Server, string, string) {
	t.Helper()
	dir := t.TempDir()
	db, err := store.Open(dir)
	if err != nil {
		t.Fatalf("store: %v", err)
	}
	if err := db.Migrate(); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	sess := &store.Session{
		ID: "v28", Title: "V28", Provider: "nvidia",
		Model: "nvidia/nvidia/nemotron-3-super", Sandbox: "quick",
		SlidingWindow: 40, CompactEnabled: true, CompactThresholdPct: 70,
	}
	if err := db.CreateSession(sess); err != nil {
		t.Fatalf("create: %v", err)
	}
	s := New(&config.Config{DataDir: dir}, db, nil)
	return s, "v28", dir
}

// TestLastUsageInput — the provider's REAL input tokens (what the model
// actually received last turn) must beat char estimates in BOTH the
// usage endpoint and the compaction trigger.
func TestLastUsageInput(t *testing.T) {
	s, sid, _ := seedV28Session(t)
	db := s.db
	db.AppendEvent(sid, "user", "q", "")
	db.AppendEvent(sid, "status", `{"state":"idle","usage":{"input_tokens":120,"output_tokens":30}}`, "")
	db.AppendEvent(sid, "user", "q2", "")
	db.AppendEvent(sid, "status", `{"state":"idle","usage":{"input_tokens":480,"output_tokens":90}}`, "")
	db.AppendEvent(sid, "status", `{"state":"idle"}`, "") // no usage — ignored
	events, _ := db.ListEvents(sid, 0)
	if got := lastUsageInput(events); got != 480 {
		t.Fatalf("lastUsageInput = %d, want 480 (the LAST status with usage)", got)
	}
}

// TestUsageRealTokens — the usage endpoint's context fill uses the real
// input tokens when they exceed the char estimate (the ring climbs).
func TestUsageRealTokens(t *testing.T) {
	s, sid, _ := seedV28Session(t)
	db := s.db
	db.AppendEvent(sid, "user", "short", "")
	db.AppendEvent(sid, "assistant", "tiny reply", "")
	db.AppendEvent(sid, "status", `{"state":"idle","usage":{"input_tokens":45000,"output_tokens":800}}`, "")

	req := httptest.NewRequest("GET", "/api/sessions/"+sid+"/usage", nil)
	rec := httptest.NewRecorder()
	s.mux.ServeHTTP(rec, req)
	if rec.Code != 200 {
		t.Fatalf("usage HTTP %d", rec.Code)
	}
	var u struct {
		Context struct {
			UsedTokens       int  `json:"usedTokens"`
			FillPct          int  `json:"fillPct"`
			CompactEnabled   bool `json:"compactEnabled"`
			CompactThreshold int  `json:"compactThreshold"`
		} `json:"context"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &u); err != nil {
		t.Fatalf("usage body: %v", err)
	}
	if u.Context.UsedTokens < 45000 {
		t.Fatalf("context usedTokens = %d, want >= 45000 (real tokens beat the estimate)", u.Context.UsedTokens)
	}
	if u.Context.FillPct < 30 {
		t.Fatalf("fillPct = %d, want >= 30 with a 128k window", u.Context.FillPct)
	}
	if !u.Context.CompactEnabled || u.Context.CompactThreshold != 70 {
		t.Fatalf("default controls wrong: %+v", u.Context)
	}
}

// TestSessionCompactEndpoint — POST /api/sessions/{id}/compact (the PM
// path's client-driven compaction): folds older turns into the summary,
// keeps the requested live tail, and persists the cut point.
func TestSessionCompactEndpoint(t *testing.T) {
	s, sid, _ := seedV28Session(t)
	db := s.db
	for i := 0; i < 12; i++ {
		db.AppendEvent(sid, "user", "turn "+string(rune('a'+i)), "")
		db.AppendEvent(sid, "assistant", "reply "+string(rune('a'+i)), "")
	}

	body := `{"summary":"early turns: greetings","keep_messages":4}`
	req := httptest.NewRequest("POST", "/api/sessions/"+sid+"/compact", strings.NewReader(body))
	rec := httptest.NewRecorder()
	s.mux.ServeHTTP(rec, req)
	if rec.Code != 200 {
		t.Fatalf("compact HTTP %d: %s", rec.Code, rec.Body.String())
	}

	sess, _ := db.GetSession(sid)
	if sess.CompactSeq <= 0 {
		t.Fatalf("CompactSeq = %d, want a cut inside the 24 events", sess.CompactSeq)
	}
	if !strings.Contains(sess.CompactSummary, "greetings") {
		t.Fatalf("summary not stored: %q", sess.CompactSummary)
	}
	// keep_messages=4 folded rows → the cut keeps the last 4 user/assistant
	// events live: 24 total, cut before the 20th-from-end message row.
	// (+1 = the compact summary note itself, folded in as a leading user msg.)
	h := s.buildHistoryCompacted(sid, sess, 40)
	folded := 0
	for _, m := range h {
		if strings.Contains(m.Content, "[conversation so far") {
			continue // the summary note rides along but isn't a live row
		}
		if m.Role == "user" || m.Role == "assistant" {
			folded++
		}
	}
	if folded != 4 {
		t.Fatalf("live folded rows = %d, want 4 (keep_messages)", folded)
	}
	// a second compact folding MORE (keep 2) also works; keeping more than
	// is live → 409 (nothing to compact)
	body2 := `{"summary":"again","keep_messages":2}`
	req2 := httptest.NewRequest("POST", "/api/sessions/"+sid+"/compact", strings.NewReader(body2))
	rec2 := httptest.NewRecorder()
	s.mux.ServeHTTP(rec2, req2)
	if rec2.Code != 200 {
		t.Fatalf("second compact HTTP %d: %s", rec2.Code, rec2.Body.String())
	}
	sess2, _ := db.GetSession(sid)
	if !strings.Contains(sess2.CompactSummary, "again") {
		t.Fatalf("appended summary missing: %q", sess2.CompactSummary)
	}
	req3 := httptest.NewRequest("POST", "/api/sessions/"+sid+"/compact", strings.NewReader(`{"summary":"x","keep_messages":24}`))
	rec3 := httptest.NewRecorder()
	s.mux.ServeHTTP(rec3, req3)
	if rec3.Code != 409 {
		t.Fatalf("over-keep compact should 409, got %d", rec3.Code)
	}
}

// TestCompactionControls — the per-chat on/off + threshold honored by
// maybeCompact's arm check, and the clamps on absurd values.
func TestCompactionControls(t *testing.T) {
	// direct unit behavior on compactThresholdFor
	sn := &store.Session{CompactThresholdPct: 0}
	if got := compactThresholdFor(sn); got != 70 {
		t.Fatalf("default threshold = %d, want 70", got)
	}
	sn.CompactThresholdPct = 3 // absurd → clamped
	if got := compactThresholdFor(sn); got != 10 {
		t.Fatalf("low clamp = %d, want 10", got)
	}
	sn.CompactThresholdPct = 500
	if got := compactThresholdFor(sn); got != 95 {
		t.Fatalf("high clamp = %d, want 95", got)
	}
}

// TestSlidingWindowWholeChat — -1 means NO window: the whole log rides.
func TestSlidingWindowWholeChat(t *testing.T) {
	s, sid, _ := seedV28Session(t)
	db := s.db
	for i := 0; i < 10; i++ {
		db.AppendEvent(sid, "user", "u"+string(rune('0'+i)), "")
		db.AppendEvent(sid, "assistant", "a"+string(rune('0'+i)), "")
	}
	sess, _ := db.GetSession(sid)
	h := s.buildHistoryCompacted(sid, sess, -1)
	if len(h) != 20 {
		t.Fatalf("whole-chat history = %d messages, want 20", len(h))
	}
	h = s.buildHistoryCompacted(sid, sess, 6)
	if len(h) != 6 {
		t.Fatalf("windowed history = %d messages, want 6", len(h))
	}
}

// TestPersonaTools — the bot's self-management tools, against a live
// session store: list, create (inactive), activate (single active),
// placeholder set, and the deactivate-all switch.
func TestPersonaTools(t *testing.T) {
	s, sid, _ := seedV28Session(t)
	db := s.db

	// seed the Default persona the UI always writes
	specs := []map[string]any{{"id": "p_default", "name": "Default", "text": "base", "mode": "always"}}
	raw, _ := json.Marshal(specs)
	sess, _ := db.GetSession(sid)
	sess.Personas = string(raw)
	db.UpdateSession(sess)

	// 1. list
	out := s.runPersonaTool(sid, "persona_list", "{}")
	if !strings.Contains(out, "Default") || !strings.Contains(out, "personas") {
		t.Fatalf("persona_list: %s", out)
	}

	// 2. create — starts INACTIVE
	out = s.runPersonaTool(sid, "persona_set", `{"name":"Pirate","text":"Arr, {name} be ye","activate":false}`)
	if !strings.Contains(out, "inactive") {
		t.Fatalf("persona_set should report inactive start: %s", out)
	}
	sess, _ = db.GetSession(sid)
	var list []map[string]any
	json.Unmarshal([]byte(sess.Personas), &list)
	if len(list) != 2 {
		t.Fatalf("want 2 personas, got %d", len(list))
	}
	var pirateID string
	for _, p := range list {
		if p["name"] == "Pirate" {
			pirateID, _ = p["id"].(string)
			if p["mode"] != "inactive" {
				t.Fatalf("new persona mode = %v, want inactive", p["mode"])
			}
		}
	}
	if pirateID == "" {
		t.Fatalf("pirate id missing: %v", list)
	}

	// 3. activate — single-active: Default demotes
	out = s.runPersonaTool(sid, "persona_activate", `{"id":"`+pirateID+`"}`)
	if !strings.Contains(out, "always-active") {
		t.Fatalf("persona_activate: %s", out)
	}
	sess, _ = db.GetSession(sid)
	json.Unmarshal([]byte(sess.Personas), &list)
	for _, p := range list {
		if p["name"] == "Default" && p["mode"] != "inactive" {
			t.Fatalf("Default not demoted: %v", p)
		}
		if p["name"] == "Pirate" && p["mode"] != "always" {
			t.Fatalf("Pirate not always: %v", p)
		}
	}

	// 4. placeholder set + read back
	out = s.runPersonaTool(sid, "placeholder_set", `{"key":"mood","value":"playful"}`)
	if !strings.Contains(out, "mood") {
		t.Fatalf("placeholder_set: %s", out)
	}
	out = s.runPersonaTool(sid, "persona_list", "{}")
	if !strings.Contains(out, "playful") {
		t.Fatalf("placeholder not visible in persona_list: %s", out)
	}

	// 5. deactivate all → the app default
	out = s.runPersonaTool(sid, "persona_activate", `{"id":""}`)
	if !strings.Contains(out, "deactivated") {
		t.Fatalf("deactivate-all: %s", out)
	}
	sess, _ = db.GetSession(sid)
	json.Unmarshal([]byte(sess.Personas), &list)
	for _, p := range list {
		if p["mode"] == "always" {
			t.Fatalf("an always persona survived deactivate-all: %v", p)
		}
	}

	// 6. the tool router serves them on the PM bridge too
	req := httptest.NewRequest("GET", "/api/tools/local?name=persona_list&args=%7B%7D&session="+sid, nil)
	rec := httptest.NewRecorder()
	s.mux.ServeHTTP(rec, req)
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), "Default") {
		t.Fatalf("tools/local persona_list HTTP %d: %s", rec.Code, rec.Body.String())
	}
}
