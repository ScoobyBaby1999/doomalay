package server

// injected_v1642_test.go — v1.64.2 THE LOUD INJECTION, server side (PLAN-V164 §2).
//
// The wire law end-to-end: a system-injected prompt persists as an
// "injected" chat event carrying {message, code:"injected"} (the replay
// lift reads it back), the tail-read treats it as bookkeeping (it is the
// PROMPT'S COPY, never a conversational turn), and every export format
// carries the row (the user's law: "the system should never inject a
// prompt without making it clear for both the frontend and the chat
// transcript").

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/ScoobyBaby1999/doomalay/engine/internal/config"
	"github.com/ScoobyBaby1999/doomalay/engine/internal/store"
)

// TestV1642_InjectedRow_PersistsAndLifts — emitInjectedRow persists the
// {message, code} payload exactly like the notice law; the PWA's replay
// lift reads message back out.
func TestV1642_InjectedRow_PersistsAndLifts(t *testing.T) {
	s := newV074TestServer(t, "http://unused.test")
	if err := s.db.CreateSession(&store.Session{ID: "inj-chat", Title: "Inj Chat", Provider: "nvidia"}); err != nil {
		t.Fatalf("create session: %v", err)
	}
	s.emitInjectedRow(nil, "inj-chat", "(proceed — execute the plan you just announced, with your tools, now.)")

	evs, err := s.db.ListEvents("inj-chat", 0)
	if err != nil {
		t.Fatalf("events: %v", err)
	}
	var found bool
	for _, ev := range evs {
		if ev.EventType != "injected" {
			continue
		}
		found = true
		var payload map[string]string
		if err := json.Unmarshal([]byte(ev.Content), &payload); err != nil {
			t.Fatalf("injected content not JSON: %q (%v)", ev.Content, err)
		}
		if payload["code"] != "injected" {
			t.Errorf("code = %q, want injected", payload["code"])
		}
		if !strings.Contains(payload["message"], "proceed — execute the plan") {
			t.Errorf("message = %q, want the injected prompt verbatim", payload["message"])
		}
	}
	if !found {
		t.Fatal("no injected event persisted — the injection is silent again")
	}
}

// TestV1642_TailRead_SkipsInjectedRows — an injected row is the PROMPT'S
// COPY, not a conversational turn: continueTailIsAssistant must skip it
// (an injected row sitting on top of an assistant row still reads the
// CUT shape — the seam nudge rides).
func TestV1642_TailRead_SkipsInjectedRows(t *testing.T) {
	events := []*store.Event{
		{EventType: "user", Content: "go"},
		{EventType: "assistant_delta", Content: "the reply was cut mid-str"},
		{EventType: "injected", Content: `{"message":"(your previous reply was cut off mid-stream…)"}`},
	}
	if !continueTailIsAssistant(events) {
		t.Fatal("an injected row on top of an assistant tail must read the CUT shape (the seam nudge rides)")
	}
}

// seedInjectedExportSession — one chat with a user turn, an injected row,
// and the assistant answer, on a real mux (the {id} PathValue law).
func seedInjectedExportSession(t *testing.T) (*Server, string) {
	t.Helper()
	dir := t.TempDir()
	db, err := store.Open(dir)
	if err != nil {
		t.Fatalf("store: %v", err)
	}
	if err := db.Migrate(); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	sess := &store.Session{ID: "inj-export", Title: "Inj Export", Provider: "nvidia", Sandbox: "quick"}
	if err := db.CreateSession(sess); err != nil {
		t.Fatalf("create: %v", err)
	}
	if _, err := db.AppendEvent("inj-export", "user", "search the web for the latest bun release", ""); err != nil {
		t.Fatalf("append user: %v", err)
	}
	payload, _ := json.Marshal(map[string]string{"message": "(proceed — execute the plan you just announced, with your tools, now.)", "code": "injected"})
	if _, err := db.AppendEvent("inj-export", "injected", string(payload), ""); err != nil {
		t.Fatalf("append injected: %v", err)
	}
	if _, err := db.AppendEvent("inj-export", "assistant", "done — here is the answer.", ""); err != nil {
		t.Fatalf("append assistant: %v", err)
	}
	s := New(&config.Config{DataDir: dir}, db, nil)
	return s, "inj-export"
}

// TestV1642_ExportCarriesInjectedRows — every export format speaks the
// injected rows ("system injected:" verbatim — never a silent injection).
func TestV1642_ExportCarriesInjectedRows(t *testing.T) {
	s, sid := seedInjectedExportSession(t)
	get := func(format string) string {
		req := httptest.NewRequest("GET", "/api/sessions/"+sid+"/export."+format, nil)
		rec := httptest.NewRecorder()
		s.mux.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("export %s -> %d: %s", format, rec.Code, rec.Body.String())
		}
		return rec.Body.String()
	}
	if md := get("md"); !strings.Contains(md, "system injected:") || !strings.Contains(md, "(proceed — execute the plan you just announced") {
		t.Errorf("md export lost the injected row:\n%s", md)
	}
	if txt := get("txt"); !strings.Contains(txt, "[system injected] (proceed — execute the plan") {
		t.Errorf("txt export lost the injected row:\n%s", txt)
	}
	if csvOut := get("csv"); !strings.Contains(csvOut, "injected") {
		t.Errorf("csv export lost the injected row type:\n%s", csvOut)
	}
	if html := get("html"); !strings.Contains(html, "system injected:") {
		t.Errorf("html export lost the injected row:\n%s", html)
	}
	_ = http.StatusOK
}

// TestV1642_ExportFoldSurvivesDeltaClobber — THE REGRESSION PIN (the live
// rig's conviction): the delta case overwrites rows[len(rows)-1] with the
// accumulator, so an injected row riding BETWEEN assistant deltas was
// CLOBBERED the moment the next delta landed (the fold ate the injection).
// The injected case breaks the accumulator (the tool row's law) — the
// injected row survives and the post-injection deltas open a NEW assistant
// row (an injected prompt is a user-side row; it ends the reply run).
func TestV1642_ExportFoldSurvivesDeltaClobber(t *testing.T) {
	events := []*store.Event{
		{Seq: 1, EventType: "user", Content: "patch the timers please"},
		{Seq: 2, EventType: "status", Content: `{"state":"running"}`},
		{Seq: 3, EventType: "assistant_delta", Content: "I will now read the three timer regions."},
		{Seq: 4, EventType: "injected", Content: `{"code":"injected","message":"(proceed — execute the plan you just announced, with your tools, now.)"}`},
		{Seq: 5, EventType: "assistant_delta", Content: "THE ANSWER after the loud proceed."},
		{Seq: 6, EventType: "assistant", Content: "I will now read the three timer regions.THE ANSWER after the loud proceed."},
		{Seq: 7, EventType: "status", Content: `{"state":"idle"}`},
	}
	rows := foldEvents(events)
	var inj, assistants int
	for _, r := range rows {
		if r.Type == "injected" {
			inj++
			if !strings.Contains(r.Text, "proceed — execute the plan") {
				t.Errorf("the injected row lost its message: %q", r.Text)
			}
		}
		if r.Type == "assistant" && !r.Hidden {
			assistants++
		}
	}
	if inj != 1 {
		t.Fatalf("the injected row was CLOBBERED by the next assistant_delta (want exactly 1, got %d)", inj)
	}
	if assistants != 2 {
		t.Fatalf("the accumulator break must split the reply run (announcement / answer = 2 assistant rows, got %d)", assistants)
	}
}
