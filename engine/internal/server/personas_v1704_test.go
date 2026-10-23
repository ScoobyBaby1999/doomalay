package server

// personas_v1704_test.go — v1.70.4 pins (the campaign's persona
// convictions): persona_set with an id that matches NOTHING refuses
// loudly (never a silent duplicate create), and a NAME-shaped id edits
// the persona it names (the model's natural addressing when the census
// is fresh enough to show names).

import (
	"strings"
	"testing"

	"github.com/ScoobyBaby1999/doomalay/engine/internal/store"
)

func TestV1704_PersonaSetUnknownIDRefuses(t *testing.T) {
	s := newV073Server(t)
	if err := s.db.CreateSession(&store.Session{ID: "v1704-p", Title: "P", Provider: "nvidia", Sandbox: "quick"}); err != nil {
		t.Fatalf("session: %v", err)
	}
	// create one persona first
	out := s.runPersonaTool("v1704-p", "persona_set", `{"name":"Auditor","text":"You audit things."}`)
	if !strings.Contains(out, "created") {
		t.Fatalf("create must succeed: %s", out)
	}
	// an id that matches nothing refuses (the campaign's duplicate-"Persona" conviction)
	out = s.runPersonaTool("v1704-p", "persona_set", `{"id":"self-test-auditor","text":"x"}`)
	if !strings.Contains(out, "error:") || !strings.Contains(out, "no persona with id") {
		t.Fatalf("unknown id must refuse loudly, got: %s", out)
	}
	// a NAME-shaped id edits the named persona (the model's natural addressing)
	out = s.runPersonaTool("v1704-p", "persona_set", `{"id":"Auditor","text":"You audit harder.","activate":true}`)
	if !strings.Contains(out, "PERSONA ACTIVE — Auditor") {
		t.Fatalf("name-as-id must edit + activate the named persona, got: %s", out)
	}
	// and the census honestly shows it now
	out = s.runPersonaTool("v1704-p", "persona_list", `{}`)
	if !strings.Contains(out, "Auditor") {
		t.Fatalf("persona_list must show the persona: %s", out)
	}
}
