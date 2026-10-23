package server

// skillhead_v1296_test.go — v1.29.6 THE PERSISTED SKILL (PLAN-V130 §6):
// the loaded skill's head persists on the session row and rides every
// turn as a lead-in (the follow-through fix — the old behavior
// evaporated the methodology at turn end, so the bot "didn't stop to
// use lib before implementation of an actionable plan").

import (
	"strings"
	"testing"

	"github.com/ScoobyBaby1999/doomalay/engine/internal/store"
)

// TestV1296_SkillHead_RidesHistory — the head injects as a lead-in
// while the lib gate is on; a lib-off chat never injects.
func TestV1296_SkillHead_RidesHistory(t *testing.T) {
	dir := t.TempDir()
	db, err := store.Open(dir)
	if err != nil {
		t.Fatalf("store: %v", err)
	}
	if err := db.Migrate(); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	sess := &store.Session{ID: "sk1", Title: "t", SlidingWindow: 40, LibAuto: true, SkillName: "git-ops", SkillHead: "## Methodology\n1. read the repo first\n2. branch before edit"}
	if err := db.CreateSession(sess); err != nil {
		t.Fatalf("create: %v", err)
	}
	db.AppendEvent("sk1", "user", "do the work", "")
	db.AppendEvent("sk1", "assistant", "done", "")

	s := &Server{db: db}
	// sessionLibOn needs the tweaks path — LibAuto=true + no tweaks row = ON
	h := s.buildHistoryCompacted("sk1", sess, 40)
	found := false
	for _, m := range h {
		if strings.HasPrefix(m.Content, "[active skill: git-ops") {
			found = true
			if !strings.Contains(m.Content, "read the repo first") {
				t.Fatalf("the head body should ride: %.80s", m.Content)
			}
			if !strings.Contains(m.Content, "[end of skill head]") {
				t.Fatalf("the head should close honestly")
			}
		}
	}
	if !found {
		t.Fatalf("the skill lead-in never rode: %+v", h)
	}
	// order: the lead-in precedes the live messages
	if h[0].Role != "user" || !strings.HasPrefix(h[0].Content, "[active skill:") {
		t.Fatalf("the lead-in should ride first (no compact note), got: %.40s", h[0].Content)
	}

	// the lib gate OFF → no injection (the pill's semantics: loads refuse)
	sess.LibAuto = false
	sess.TemplateAuto = false
	sess.SkillsAuto = false
	if err := db.UpdateSession(sess); err != nil {
		t.Fatalf("update: %v", err)
	}
	h = s.buildHistoryCompacted("sk1", sess, 40)
	for _, m := range h {
		if strings.Contains(m.Content, "[active skill:") {
			t.Fatalf("a lib-off chat must never inject the skill head")
		}
	}

	// the compact note leads FIRST, the skill head second
	sess.LibAuto = true
	sess.CompactSummary = "SUMMARY"
	sess.CompactSeq = 1
	if err := db.UpdateSession(sess); err != nil {
		t.Fatalf("update: %v", err)
	}
	h = s.buildHistoryCompacted("sk1", sess, 40)
	if !strings.HasPrefix(h[0].Content, "[conversation so far") {
		t.Fatalf("the compact note leads first: %.40s", h[0].Content)
	}
	if len(h) < 2 || !strings.HasPrefix(h[1].Content, "[active skill:") {
		t.Fatalf("the skill head rides second: %.40s", h[1].Content)
	}
}

// TestV1296_SkillHead_LoadPersists — the skills load path writes the
// head onto the session row (name + the stripped head + the honest
// persistence line).
func TestV1296_SkillHead_LoadPersists(t *testing.T) {
	s := newSkillsTestServer(t)
	sess := &store.Session{ID: "sk2", Title: "t", LibAuto: true}
	if err := s.db.CreateSession(sess); err != nil {
		t.Fatalf("create: %v", err)
	}

	out, errStr := s.skillsDispatch("load", func(k string) string {
		if k == "skill" {
			return "brainstorming"
		}
		return ""
	}, "sk2")
	if errStr != "" {
		t.Fatalf("load: %s", errStr)
	}
	if !strings.Contains(out, "stays armed for this chat's turns") {
		t.Fatalf("the honest persistence line, got:\n%s", out)
	}
	got, gerr := s.db.GetSession("sk2")
	if gerr != nil || got == nil {
		t.Fatalf("session re-read: %v", gerr)
	}
	if got.SkillName == "" {
		t.Fatalf("the name should persist: %q", got.SkillName)
	}
	if !strings.Contains(got.SkillHead, "Brainstorming") {
		t.Fatalf("the head should persist: %.60s", got.SkillHead)
	}
	if strings.Contains(got.SkillHead, "name: brainstorming") {
		t.Fatalf("the frontmatter strips")
	}
}
