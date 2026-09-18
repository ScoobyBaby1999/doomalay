package server

// v29_test.go — v0.29 engine behaviors: the GLOBAL custom placeholders
// (app_settings-backed API + merge precedence into personas and triggers)
// and the string-valued trigger rework (built-in globals {name} {model}
// {provider} as trigger keys, legacy numeric trigger JSON compatibility).

import (
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/ScoobyBaby1999/doomalay/engine/internal/config"
	"github.com/ScoobyBaby1999/doomalay/engine/internal/store"
)

func seedV29Session(t *testing.T) (*Server, string) {
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
		ID: "v29", Title: "Scooby", Provider: "anthropic",
		Model: "anthropic/claude-sonnet-4", SlidingWindow: 40,
	}
	if err := db.CreateSession(sess); err != nil {
		t.Fatalf("create: %v", err)
	}
	s := New(&config.Config{DataDir: dir}, db, nil)
	return s, "v29"
}

// TestPlaceholdersAPI — the global-placeholder CRUD round-trip.
func TestPlaceholdersAPI(t *testing.T) {
	s, _ := seedV29Session(t)

	// empty to start
	rec := httptest.NewRecorder()
	s.mux.ServeHTTP(rec, httptest.NewRequest("GET", "/api/placeholders", nil))
	if rec.Code != 200 {
		t.Fatalf("GET status %d", rec.Code)
	}
	var got struct {
		Placeholders map[string]string `json:"placeholders"`
	}
	json.NewDecoder(rec.Body).Decode(&got)
	if len(got.Placeholders) != 0 {
		t.Fatalf("expected empty globals, got %v", got.Placeholders)
	}

	// set two globals
	for _, body := range []string{
		`{"key":"mood","value":"playful"}`,
		`{"key":"level","value":"7"}`,
	} {
		rec = httptest.NewRecorder()
		s.mux.ServeHTTP(rec, httptest.NewRequest("PUT", "/api/placeholders", strings.NewReader(body)))
		if rec.Code != 200 {
			t.Fatalf("PUT %s → %d: %s", body, rec.Code, rec.Body.String())
		}
	}

	// built-in keys rejected
	rec = httptest.NewRecorder()
	s.mux.ServeHTTP(rec, httptest.NewRequest("PUT", "/api/placeholders", strings.NewReader(`{"key":"model","value":"x"}`)))
	if rec.Code != 400 {
		t.Fatalf("built-in key must be rejected, got %d", rec.Code)
	}

	// read back
	rec = httptest.NewRecorder()
	s.mux.ServeHTTP(rec, httptest.NewRequest("GET", "/api/placeholders", nil))
	got.Placeholders = nil // json.Decode MERGES into a live map — reset first
	json.NewDecoder(rec.Body).Decode(&got)
	if got.Placeholders["mood"] != "playful" || got.Placeholders["level"] != "7" {
		t.Fatalf("globals not persisted: %v", got.Placeholders)
	}

	// delete one
	rec = httptest.NewRecorder()
	s.mux.ServeHTTP(rec, httptest.NewRequest("DELETE", "/api/placeholders/mood", nil))
	if rec.Code != 200 {
		t.Fatalf("DELETE status %d", rec.Code)
	}
	rec = httptest.NewRecorder()
	s.mux.ServeHTTP(rec, httptest.NewRequest("GET", "/api/placeholders", nil))
	got.Placeholders = nil
	json.NewDecoder(rec.Body).Decode(&got)
	if _, ok := got.Placeholders["mood"]; ok {
		t.Fatalf("mood should be gone: %v", got.Placeholders)
	}
	if got.Placeholders["level"] != "7" {
		t.Fatalf("level should remain: %v", got.Placeholders)
	}
}

// TestPlaceholderMergePrecedence — the chat's LOCAL value wins over the
// GLOBAL one on the same key; the merged map is what substitutes into the
// system prompt.
func TestPlaceholderMergePrecedence(t *testing.T) {
	s, sid := seedV29Session(t)
	if err := s.setGlobalPlaceholder("mood", "playful"); err != nil {
		t.Fatalf("global set: %v", err)
	}
	sess, err := s.db.GetSession(sid)
	if err != nil || sess == nil {
		t.Fatalf("get session: %v", err)
	}
	sess.Placeholders = `{"mood":"grumpy","local_only":"yes"}`
	if err := s.db.UpdateSession(sess); err != nil {
		t.Fatalf("update: %v", err)
	}

	merged := s.mergedPlaceholders(sess)
	if merged["mood"] != "grumpy" {
		t.Fatalf("local must win: %v", merged)
	}
	if merged["local_only"] != "yes" {
		t.Fatalf("local-only key missing: %v", merged)
	}

	// the local value must WIN over the global one in substitution: give
	// the chat a persona that REFERENCES {mood} and {local_only}.
	sess.Personas = `[{"id":"p1","name":"P","text":"mood is {mood}, local is {local_only}","mode":"always"}]`
	if err := s.db.UpdateSession(sess); err != nil {
		t.Fatalf("update personas: %v", err)
	}
	prompt := s.systemPromptFor(sess)
	if !strings.Contains(prompt, "mood is grumpy") {
		t.Fatalf("local must beat global: %s", prompt)
	}
	if !strings.Contains(prompt, "local is yes") {
		t.Fatalf("local-only key must substitute: %s", prompt)
	}

	// a fresh session with NO local map still sees the globals
	sess2 := &store.Session{ID: "v29b", Title: "Second", SlidingWindow: 40}
	if err := s.db.CreateSession(sess2); err != nil {
		t.Fatalf("create 2: %v", err)
	}
	if m := s.mergedPlaceholders(sess2); m["mood"] != "playful" {
		t.Fatalf("globals must reach every chat: %v", m)
	}
}

// TestTriggerStringValues — v0.29: trigger values are strings; {name},
// {model}, {provider} and text customs compare as strings; numeric
// customs + metrics still compare numerically; legacy numeric JSON still
// parses.
func TestTriggerStringValues(t *testing.T) {
	s, sid := seedV29Session(t)
	sess, _ := s.db.GetSession(sid)
	ph := map[string]string{"level": "7", "vibe": "spooky"}

	tt := []struct {
		name    string
		trig    string
		metrics personaMetrics
		want    bool
	}{
		{"provider equals", `{"key":"provider","op":"=","value":"anthropic"}`, personaMetrics{}, true},
		{"provider equals case-insensitive", `{"key":"provider","op":"=","value":"Anthropic"}`, personaMetrics{}, true},
		{"provider not-equals", `{"key":"provider","op":"!=","value":"openai"}`, personaMetrics{}, true},
		{"name equals", `{"key":"name","op":"=","value":"scooby"}`, personaMetrics{}, true},
		{"model equals", `{"key":"model","op":"=","value":"claude-sonnet-4"}`, personaMetrics{}, true},
		{"string ordering is false", `{"key":"provider","op":">","value":"anthropic"}`, personaMetrics{}, false},
		{"legacy numeric value", `{"key":"messages","op":">","value":10}`, personaMetrics{Messages: 11}, true},
		{"legacy numeric value not met", `{"key":"messages","op":">","value":10}`, personaMetrics{Messages: 5}, false},
		{"numeric custom", `{"key":"level","op":">","value":"6"}`, personaMetrics{}, true},
		{"numeric custom equal", `{"key":"level","op":"=","value":"7"}`, personaMetrics{}, true},
		{"numeric custom wrong", `{"key":"level","op":"<","value":"7"}`, personaMetrics{}, false},
		{"text custom equals", `{"key":"vibe","op":"=","value":"spooky"}`, personaMetrics{}, true},
		{"text custom not equals", `{"key":"vibe","op":"!=","value":"spooky"}`, personaMetrics{}, false},
		{"text custom ordering false", `{"key":"vibe","op":"<","value":"zzz"}`, personaMetrics{}, false},
		{"missing key false", `{"key":"nope","op":"=","value":"x"}`, personaMetrics{}, false},
	}
	for _, tc := range tt {
		var trig PersonaTrigger
		if err := json.Unmarshal([]byte(tc.trig), &trig); err != nil {
			t.Fatalf("%s: unmarshal: %v", tc.name, err)
		}
		got := s.triggerSatisfied(sess, &trig, ph, tc.metrics)
		if got != tc.want {
			t.Errorf("%s: triggerSatisfied(%s) = %v, want %v", tc.name, tc.trig, got, tc.want)
		}
	}

	// the marshaled form round-trips values as strings
	trig := PersonaTrigger{Key: "messages", Op: ">", Value: "10"}
	b, _ := json.Marshal(trig)
	if !strings.Contains(string(b), `"value":"10"`) {
		t.Fatalf("value should marshal as a string: %s", b)
	}
}

// TestPersonaToolsPlaceholdersScope — placeholder_set's scope switch:
// default local; explicit global lands in app_settings and is visible to
// persona_list on ANOTHER chat.
func TestPersonaToolsPlaceholdersScope(t *testing.T) {
	s, sid := seedV29Session(t)

	// default = local
	out := s.runPersonaTool(sid, "placeholder_set", `{"key":"mood","value":"playful"}`)
	if !strings.Contains(out, "this chat") {
		t.Fatalf("default scope should be local: %s", out)
	}
	// explicit global
	out = s.runPersonaTool(sid, "placeholder_set", `{"key":"tone","value":"warm","scope":"global"}`)
	if !strings.Contains(out, "every chat") {
		t.Fatalf("global scope observation: %s", out)
	}
	gp := s.globalPlaceholders()
	if gp["tone"] != "warm" {
		t.Fatalf("global placeholder not persisted: %v", gp)
	}

	// a different chat's persona_list sees the GLOBAL map; the local map
	// shows on its OWN chat
	out = s.runPersonaTool("v29", "persona_list", "")
	if !strings.Contains(out, `"mood":"playful"`) {
		t.Fatalf("local placeholder missing from its own chat's persona_list: %s", out)
	}
	if !strings.Contains(out, `"tone":"warm"`) {
		t.Fatalf("global placeholder missing from persona_list: %s", out)
	}
	sess2 := &store.Session{ID: "v29c", Title: "Third", SlidingWindow: 40}
	if err := s.db.CreateSession(sess2); err != nil {
		t.Fatalf("create 3: %v", err)
	}
	out = s.runPersonaTool("v29c", "persona_list", "")
	if !strings.Contains(out, `"tone":"warm"`) {
		t.Fatalf("global placeholder missing from ANOTHER chat's persona_list: %s", out)
	}
	if strings.Contains(out, `"mood":"playful"`) {
		t.Fatalf("local placeholder leaked into another chat: %s", out)
	}
}
