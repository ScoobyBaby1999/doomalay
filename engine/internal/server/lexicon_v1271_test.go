package server

// lexicon_v1271_test.go — v1.27.1 THE FULL LEXICON pins (PLAN-V126 §3).
//
// 1. THE HARD REFUSE law: built-ins + the five MIRROR block names are
//    never custom keys — the HTTP PUT, the bot's placeholder_set and the
//    session PATCH all refuse (a custom {session} would shadow the live
//    block, because customs substitute FIRST).
// 2. The blocks preview endpoint renders the same five builders the turn
//    path runs, capped, with the {artifacts} collapse rule intact.

import (
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/ScoobyBaby1999/doomalay/engine/internal/store"
)

func newLexiconServer(t *testing.T) *Server {
	t.Helper()
	dir := t.TempDir()
	db, err := store.Open(dir)
	if err != nil {
		t.Fatalf("store: %v", err)
	}
	if err := db.Migrate(); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	return &Server{db: db}
}

// TestV1271_ReservedKeyLaw — every built-in and every block name is
// refused by the shared law; a free key passes.
func TestV1271_ReservedKeyLaw(t *testing.T) {
	if len(placeholderBuiltins) != 7 {
		t.Fatalf("builtin vocabulary drifted: %v", placeholderBuiltins)
	}
	if len(placeholderBlocks) != 6 { // v1.58.2: {tools} joins the MIRROR blocks
		t.Fatalf("block vocabulary drifted: %v", placeholderBlocks)
	}
	for _, k := range append(append([]string{}, placeholderBuiltins...), placeholderBlocks...) {
		if _, bad := isReservedPlaceholderKey(k); !bad {
			t.Fatalf("%s must be reserved", k)
		}
	}
	for _, k := range []string{"mood", "brand", "level_7", "tone"} {
		if class, bad := isReservedPlaceholderKey(k); bad {
			t.Fatalf("%s must be free (got class %q)", k, class)
		}
	}
}

// TestV1271_PutRefusesBlocks — the global PUT door: a block name gets the
// honest 400; a free key stores.
func TestV1271_PutRefusesBlocks(t *testing.T) {
	s := newLexiconServer(t)
	for _, key := range placeholderBlocks {
		req := httptest.NewRequest("PUT", "/api/placeholders", strings.NewReader(`{"key":"`+key+`","value":"x"}`))
		rec := httptest.NewRecorder()
		s.handlePlaceholdersSet(rec, req)
		if rec.Code != 400 {
			t.Fatalf("PUT %s: want 400, got %d (%s)", key, rec.Code, rec.Body.String())
		}
		if !strings.Contains(rec.Body.String(), "live preamble block") {
			t.Fatalf("PUT %s: the error must name the class, got %s", key, rec.Body.String())
		}
	}
	// date is a built-in (the old front-end missed it — the engine never did)
	req := httptest.NewRequest("PUT", "/api/placeholders", strings.NewReader(`{"key":"date","value":"x"}`))
	rec := httptest.NewRecorder()
	s.handlePlaceholdersSet(rec, req)
	if rec.Code != 400 || !strings.Contains(rec.Body.String(), "built-in") {
		t.Fatalf("PUT date must refuse as built-in, got %d %s", rec.Code, rec.Body.String())
	}
	// a free key rides
	req = httptest.NewRequest("PUT", "/api/placeholders", strings.NewReader(`{"key":"brand","value":"Acme"}`))
	rec = httptest.NewRecorder()
	s.handlePlaceholdersSet(rec, req)
	if rec.Code != 200 {
		t.Fatalf("PUT brand: want 200, got %d (%s)", rec.Code, rec.Body.String())
	}
}

// TestV1271_BotDoorRefuses — the bot's placeholder_set obeys the same law.
func TestV1271_BotDoorRefuses(t *testing.T) {
	s := newLexiconServer(t)
	sess := &store.Session{ID: "s-lex1", Title: "Lippy"}
	if err := s.db.CreateSession(sess); err != nil {
		t.Fatalf("create: %v", err)
	}
	for _, key := range []string{"session", "library", "name", "date"} {
		if err := s.setPlaceholder(sess, key, "x", "local"); err == nil {
			t.Fatalf("setPlaceholder %s (local) must refuse", key)
		}
		if err := s.setPlaceholder(sess, key, "x", "global"); err == nil {
			t.Fatalf("setPlaceholder %s (global) must refuse", key)
		}
	}
	if err := s.setPlaceholder(sess, "mood", "playful", "local"); err != nil {
		t.Fatalf("free key must store: %v", err)
	}
}

// TestV1271_PatchSanitizesLocals — the PATCH door strips reserved keys
// from the incoming local map (existing shadowers die on the next write);
// everything else rides verbatim.
func TestV1271_PatchSanitizesLocals(t *testing.T) {
	s := newLexiconServer(t)
	sess := &store.Session{ID: "s-lex2", Title: "Scooby"}
	if err := s.db.CreateSession(sess); err != nil {
		t.Fatalf("create: %v", err)
	}
	raw := `{"mood":"playful","session":"hi","library":"x","brand":"Acme"}`
	got := sanitizeLocalPlaceholders(raw)
	var m map[string]string
	if err := json.Unmarshal([]byte(got), &m); err != nil {
		t.Fatalf("sanitize output must stay a JSON map: %v", got)
	}
	if _, ok := m["session"]; ok {
		t.Fatalf("session must be stripped: %s", got)
	}
	if _, ok := m["library"]; ok {
		t.Fatalf("library must be stripped: %s", got)
	}
	if m["mood"] != "playful" || m["brand"] != "Acme" {
		t.Fatalf("free keys must survive: %s", got)
	}
	// a malformed blob rides untouched (parsePlaceholders degrades later)
	if got := sanitizeLocalPlaceholders("not json"); got != "not json" {
		t.Fatalf("malformed must ride verbatim, got %s", got)
	}
	// end-to-end: PATCH the session, the stored map is clean
	req := httptest.NewRequest("PATCH", "/api/sessions/"+sess.ID, strings.NewReader(`{"placeholders":"{\"session\":\"x\",\"mood\":\"calm\"}"}`))
	req.SetPathValue("id", sess.ID)
	rec := httptest.NewRecorder()
	s.handleSessionsUpdate(rec, req)
	if rec.Code != 200 {
		t.Fatalf("PATCH: want 200, got %d (%s)", rec.Code, rec.Body.String())
	}
	fresh, err := s.db.GetSession(sess.ID)
	if err != nil {
		t.Fatalf("reload: %v", err)
	}
	stored := parsePlaceholders(fresh)
	if _, ok := stored["session"]; ok {
		t.Fatalf("stored map must not carry the shadower: %v", stored)
	}
	if stored["mood"] != "calm" {
		t.Fatalf("stored map lost the free key: %v", stored)
	}
}

// TestV1272_GetCarriesVocabulary — THE TIE: the GET payload carries the
// whole vocabulary from the shared slices (the client's PH_VOCAB cache
// feeds off this — no more hand-maintained client lists).
func TestV1272_GetCarriesVocabulary(t *testing.T) {
	s := newLexiconServer(t)
	req := httptest.NewRequest("GET", "/api/placeholders", nil)
	rec := httptest.NewRecorder()
	s.handlePlaceholdersGet(rec, req)
	if rec.Code != 200 {
		t.Fatalf("GET: want 200, got %d", rec.Code)
	}
	var out struct {
		Builtin []string `json:"builtin"`
		Blocks  []string `json:"blocks"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(out.Builtin) != 7 || len(out.Blocks) != 6 { // v1.58.2: {tools} joins
		t.Fatalf("vocabulary drifted: builtin=%v blocks=%v", out.Builtin, out.Blocks)
	}
	for _, want := range []string{"date", "session", "repo_access"} {
		found := false
		for _, k := range append(out.Builtin, out.Blocks...) {
			if k == want {
				found = true
			}
		}
		if !found {
			t.Fatalf("%s missing from the GET vocabulary", want)
		}
	}
}

// TestV1273_DateTrigger — {date} joins the trigger vocabulary: the
// weekday string compares case-insensitively with = / != (the "activate
// on Monday" pattern); ordering ops stay false; the stored persona
// actually activates when satisfied.
func TestV1273_DateTrigger(t *testing.T) {
	s := newLexiconServer(t)
	today := time.Now().Format("Monday")
	// the case-insensitive = path (the stored value rides lowercase)
	trig := `[
                {"id":"a","name":"Base","text":"BASE","mode":"always"},
                {"id":"d","name":"Weekday","text":"DATED","mode":"trigger","trigger":{"key":"date","op":"=","value":"` + strings.ToLower(today) + `"}}
        ]`
	sess := &store.Session{ID: "s-lex4", Title: "Lippy", Personas: trig}
	if err := s.db.CreateSession(sess); err != nil {
		t.Fatalf("create: %v", err)
	}
	// satisfied today → the date persona fires (case-insensitive)
	got := s.resolveActivePersonaMerged(parsePersonas(sess), sess, personaMetrics{})
	if got == nil || got.ID != "d" {
		t.Fatalf("the date trigger must fire on %s, got %+v", today, got)
	}
	// != the wrong weekday also fires
	trigNE := `[{"id":"n","name":"NotSun","text":"NE","mode":"always"},{"id":"m","name":"NE","text":"M","mode":"trigger","trigger":{"key":"date","op":"!=","value":"Xday"}}]`
	sessNE := &store.Session{ID: "s-lex5", Title: "Lippy", Personas: trigNE}
	if got := s.resolveActivePersonaMerged(parsePersonas(sessNE), sessNE, personaMetrics{}); got == nil || got.ID != "m" {
		t.Fatalf("date != Xday must fire, got %+v", got)
	}
	// == a weekday that never exists stays silent — the always persona rides
	trigWrong := `[{"id":"w","name":"Base","text":"B","mode":"always"},{"id":"f","name":"Fool","text":"F","mode":"trigger","trigger":{"key":"date","op":"=","value":"Foolsday"}}]`
	sessW := &store.Session{ID: "s-lex6", Title: "Lippy", Personas: trigWrong}
	if got := s.resolveActivePersonaMerged(parsePersonas(sessW), sessW, personaMetrics{}); got == nil || got.ID != "w" {
		t.Fatalf("an unsatisfied date trigger must NOT activate, got %+v", got)
	}
	// ordering on a weekday never fires (a weekday has no order)
	trigOrd := `[{"id":"o","name":"Base","text":"B","mode":"always"},{"id":"p","name":"Ord","text":"O","mode":"trigger","trigger":{"key":"date","op":"<","value":"Monday"}}]`
	sessO := &store.Session{ID: "s-lex7", Title: "Lippy", Personas: trigOrd}
	if got := s.resolveActivePersonaMerged(parsePersonas(sessO), sessO, personaMetrics{}); got == nil || got.ID != "o" {
		t.Fatalf("date < Monday must never fire, got %+v", got)
	}
}

// TestV1271_BlocksEndpoint — the preview renders the five builders, capped,
// with the {artifacts} collapse rule evaluated exactly like the turn path.
func TestV1271_BlocksEndpoint(t *testing.T) {
	s := newLexiconServer(t)
	sess := &store.Session{ID: "s-lex3", Title: "Crippy", Model: "nvidia/moonshotai/kimi-k2.6", Provider: "nvidia"}
	if err := s.db.CreateSession(sess); err != nil {
		t.Fatalf("create: %v", err)
	}
	req := httptest.NewRequest("GET", "/api/sessions/"+sess.ID+"/blocks", nil)
	req.SetPathValue("id", sess.ID)
	rec := httptest.NewRecorder()
	s.handleSessionBlocks(rec, req)
	if rec.Code != 200 {
		t.Fatalf("GET blocks: want 200, got %d (%s)", rec.Code, rec.Body.String())
	}
	var out struct {
		Blocks map[string]struct {
			Text      string `json:"text"`
			Chars     int    `json:"chars"`
			Truncated bool   `json:"truncated"`
			Collapsed bool   `json:"collapsed"`
		} `json:"blocks"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode: %v", err)
	}
	for _, k := range placeholderBlocks {
		b, ok := out.Blocks[k]
		if !ok {
			t.Fatalf("block %s missing from the payload", k)
		}
		if b.Collapsed {
			continue
		}
		if len([]rune(b.Text)) > blockPreviewCap {
			t.Fatalf("block %s preview exceeds the cap: %d", k, len(b.Text))
		}
		// v1.58.2: {tools} may honestly render EMPTY (native chats collapse it —
		// the serve-only merged catalog; the same exception as {artifacts})
		if b.Chars == 0 && k != "artifacts" && k != "tools" {
			t.Fatalf("block %s renders empty (chars=0)", k)
		}
	}
	// the default personas teach artifacts themselves → the slot collapses
	if !out.Blocks["artifacts"].Collapsed {
		t.Fatalf("artifacts must report collapsed for a default persona")
	}
	// 404 on a missing chat
	req = httptest.NewRequest("GET", "/api/sessions/s-nope/blocks", nil)
	req.SetPathValue("id", "s-nope")
	rec = httptest.NewRecorder()
	s.handleSessionBlocks(rec, req)
	if rec.Code != 404 {
		t.Fatalf("missing session: want 404, got %d", rec.Code)
	}
}
