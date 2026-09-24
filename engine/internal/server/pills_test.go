package server

// pills_test.go — v0.52 THE 3 PILLS: the template_auto / skills_auto
// session caps round-trip (create → PATCH → GET → the fields the
// turn builders read). The pill label press PATCHes these; the engine
// gates the template/skills tools on them.

import (
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/ScoobyBaby1999/doomalay/engine/internal/config"
	"github.com/ScoobyBaby1999/doomalay/engine/internal/store"
)

func seedPillsServer(t *testing.T) (*Server, string) {
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

	// create with the toggles ON (a chat created while the pills were on)
	req := httptest.NewRequest("POST", "/api/sessions",
		strings.NewReader(`{"id":"pills1","title":"Pills","provider":"nvidia",
		  "model":"m","template_auto":true,"skills_auto":true}`))
	rec := httptest.NewRecorder()
	s.mux.ServeHTTP(rec, req)
	if rec.Code != 201 {
		t.Fatalf("create HTTP %d: %s", rec.Code, rec.Body.String())
	}
	return s, "pills1"
}

func TestPillsCapsRoundTrip(t *testing.T) {
	s, sid := seedPillsServer(t)

	// GET reflects the created state
	get := httptest.NewRequest("GET", "/api/sessions/"+sid, nil)
	rec := httptest.NewRecorder()
	s.mux.ServeHTTP(rec, get)
	if rec.Code != 200 {
		t.Fatalf("get HTTP %d", rec.Code)
	}
	var sess struct {
		TemplateAuto bool `json:"TemplateAuto"`
		SkillsAuto   bool `json:"SkillsAuto"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &sess); err != nil {
		t.Fatalf("json: %v", err)
	}
	if !sess.TemplateAuto || !sess.SkillsAuto {
		t.Fatalf("created caps = template:%v skills:%v — want both on", sess.TemplateAuto, sess.SkillsAuto)
	}

	// PATCH flips them (the pill label press)
	patch := httptest.NewRequest("PATCH", "/api/sessions/"+sid,
		strings.NewReader(`{"template_auto":false,"skills_auto":true}`))
	rec2 := httptest.NewRecorder()
	s.mux.ServeHTTP(rec2, patch)
	if rec2.Code != 200 {
		t.Fatalf("patch HTTP %d: %s", rec2.Code, rec2.Body.String())
	}

	// the store round-trip keeps them (GetSession re-reads the columns)
	stored, err := s.db.GetSession(sid)
	if err != nil || stored == nil {
		t.Fatalf("store get: %v", err)
	}
	if stored.TemplateAuto {
		t.Fatal("TemplateAuto survived the PATCH-off — the column did not persist")
	}
	if !stored.SkillsAuto {
		t.Fatal("SkillsAuto lost after PATCH — the column did not persist")
	}
}

// TestPillsMigrationOnOldDB — a v0.51 database (no template_auto column)
// migrates in place and reads the toggles as off (the pills' default).
func TestPillsMigrationOnOldDB(t *testing.T) {
	dir := t.TempDir()
	db, err := store.Open(dir)
	if err != nil {
		t.Fatalf("store: %v", err)
	}
	if err := db.Migrate(); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	// create a session, then drop the v0.52 columns to simulate a v0.51 DB
	if _, err := db.Exec(`ALTER TABLE chat_sessions DROP COLUMN template_auto`); err != nil {
		t.Fatalf("drop template_auto: %v", err)
	}
	if _, err := db.Exec(`ALTER TABLE chat_sessions DROP COLUMN skills_auto`); err != nil {
		t.Fatalf("drop skills_auto: %v", err)
	}
	if err := db.Migrate(); err != nil { // re-migrate: the columns come back
		t.Fatalf("re-migrate: %v", err)
	}
	sess := &store.Session{ID: "old", Title: "v0.51 chat"}
	if err := db.CreateSession(sess); err != nil {
		t.Fatalf("create: %v", err)
	}
	got, err := db.GetSession("old")
	if err != nil || got == nil {
		t.Fatalf("get: %v", err)
	}
	if got.TemplateAuto || got.SkillsAuto {
		t.Fatalf("migrated caps = template:%v skills:%v — want off (defaults)", got.TemplateAuto, got.SkillsAuto)
	}
}
