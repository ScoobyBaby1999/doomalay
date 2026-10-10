package server

// v1220_test.go — PLAN-V122 §3 THE MIRROR: the Preamble system.
// The persona/preamble split, the placeholder vocabulary, the OFF state,
// the artifact no-duplication rule, the storage round-trip.

import (
        "strings"
        "testing"
        "time"

        "github.com/ScoobyBaby1999/doomalay/engine/internal/config"
        "github.com/ScoobyBaby1999/doomalay/engine/internal/store"
)

func newMirrorServer(t *testing.T) *Server {
        t.Helper()
        dir := t.TempDir()
        db, err := store.Open(dir)
        if err != nil {
                t.Fatalf("store: %v", err)
        }
        if err := db.Migrate(); err != nil {
                t.Fatalf("migrate: %v", err)
        }
        return New(&config.Config{DataDir: dir}, db, nil)
}

func mirrorSession(t *testing.T, s *Server, id string) *store.Session {
        t.Helper()
        sess := &store.Session{ID: id, Title: "Mirror " + id, Model: "nvidia/testmodel", Provider: "nvidia", Sandbox: "quick"}
        if err := s.db.CreateSession(sess); err != nil {
                t.Fatalf("put: %v", err)
        }
        got, err := s.db.GetSession(id)
        if err != nil || got == nil {
                t.Fatalf("get: %v %v", got, err)
        }
        return got
}

func countSub(s, sub string) int {
        return strings.Count(s, sub)
}

// THE DEFAULT COMPOSITION: preamble (identity line + the machinery blocks)
// then the persona — every block lands exactly once (the no-duplication law).
func TestV1220DefaultComposition(t *testing.T) {
        s := newMirrorServer(t)
        sess := mirrorSession(t, s, "m1")
        prompt := s.systemPromptFor(sess)

        if !strings.Contains(prompt, "You are testmodel, hosted via") {
                t.Fatalf("the identity line is gone: %.200s", prompt)
        }
        if !strings.Contains(prompt, "Today is "+time.Now().Format("Monday, 2 January 2006")) {
                t.Fatalf("the date line is missing")
        }
        if !strings.Contains(prompt, "PUBLIC REPO ACCESS") {
                t.Fatalf("{repo_access} did not expand")
        }
        if !strings.Contains(prompt, "artifact system") {
                t.Fatalf("the artifact protocol is missing")
        }
        if !strings.Contains(prompt, "## This chat's controls") {
                t.Fatalf("{controls} did not expand")
        }
        if !strings.Contains(prompt, "## Your session") {
                t.Fatalf("{session} did not expand")
        }
        if !strings.Contains(prompt, "The Doomalay Library") {
                t.Fatalf("{library} did not expand")
        }
        // THE NO-DUPLICATION LAW: the library block expands ONCE (the default
        // persona no longer carries it — the preamble owns it), the artifact
        // protocol appears once (the default persona teaches it; {artifacts}
        // yields).
        if n := countSub(prompt, "## The Doomalay Library"); n != 1 {
                t.Fatalf("library block duplicated: %d", n)
        }
        if n := countSub(prompt, "artifact system"); n != 1 {
                t.Fatalf("artifact block duplicated: %d", n)
        }
        // the persona lands AFTER the machinery
        if strings.Index(prompt, "## Identity") < strings.Index(prompt, "## Your session") {
                t.Fatalf("the persona must come after the preamble blocks")
        }
}

// THE OFF STATE: the persona IS the prompt — zero machinery.
func TestV1220PreambleOff(t *testing.T) {
        s := newMirrorServer(t)
        sess := mirrorSession(t, s, "m2")
        sess.PreambleSel = PreambleSelOff
        prompt := s.systemPromptFor(sess)
        if strings.Contains(prompt, "hosted via") || strings.Contains(prompt, "## This chat's controls") ||
                strings.Contains(prompt, "## Your session") || strings.Contains(prompt, "PUBLIC REPO ACCESS") {
                t.Fatalf("preamble off must compose the persona only: %.300s", prompt)
        }
        if !strings.Contains(prompt, "## Identity") {
                t.Fatalf("the persona is missing")
        }
}

// A CUSTOM PREAMBLE: the user's template rides; the block placeholders
// expand; {model}/{date} substitute; the persona follows.
func TestV1220CustomPreamble(t *testing.T) {
        s := newMirrorServer(t)
        sess := mirrorSession(t, s, "m3")
        sess.Preambles = `[{"id":"pre_1","name":"Lean","text":"BRIEFING for {model} on {date}.\n{session}\n{controls}"}]`
        sess.PreambleSel = "pre_1"
        prompt := s.systemPromptFor(sess)
        if !strings.Contains(prompt, "BRIEFING for testmodel on ") {
                t.Fatalf("the custom preamble text did not ride: %.200s", prompt)
        }
        if !strings.Contains(prompt, "## Your session") || !strings.Contains(prompt, "## This chat's controls") {
                t.Fatalf("the custom preamble's block slots did not expand")
        }
        // {repo_access}/{library}/{artifacts} were NOT in the template — absent
        if strings.Contains(prompt, "PUBLIC REPO ACCESS") {
                t.Fatalf("repo_access must not appear when the template omits it")
        }
        // the persona still follows
        if !strings.Contains(prompt, "## Identity") {
                t.Fatalf("the persona is missing under a custom preamble")
        }
}

// A STALE selection falls back to the app default (a deleted preamble
// never wedges a chat).
func TestV1220StaleSelFallsBackToDefault(t *testing.T) {
        s := newMirrorServer(t)
        sess := mirrorSession(t, s, "m4")
        sess.PreambleSel = "pre_gone"
        prompt := s.systemPromptFor(sess)
        if !strings.Contains(prompt, "PUBLIC REPO ACCESS") || !strings.Contains(prompt, "## This chat's controls") {
                t.Fatalf("a stale selection must fall back to the default preamble")
        }
}

// THE ARTIFACT SKIP RULE: a custom persona that teaches the artifact
// protocol does not get {artifacts} twice.
func TestV1220ArtifactSkipRule(t *testing.T) {
        s := newMirrorServer(t)
        sess := mirrorSession(t, s, "m5")
        sess.Personas = `[{"id":"p1","name":"Artist","text":"## Identity\nI teach artifacts: use the artifact system blocks.\n\n## Style\nTerse.","mode":"always"}]`
        prompt := s.systemPromptFor(sess)
        if n := countSub(prompt, "artifact system"); n != 1 {
                t.Fatalf("the persona's own artifact teaching must not duplicate: %d", n)
        }
}

// THE {date} VOCABULARY: a persona (not just the preamble) may use it.
func TestV1220DatePlaceholder(t *testing.T) {
        s := newMirrorServer(t)
        sess := mirrorSession(t, s, "m6")
        sess.Personas = `[{"id":"p1","name":"Dated","text":"## Identity\nToday is {date}, remember it.","mode":"always"}]`
        prompt := s.systemPromptFor(sess)
        if !strings.Contains(prompt, "Today is "+time.Now().Format("Monday, 2 January 2006")+", remember it.") {
                t.Fatalf("{date} did not substitute inside a persona")
        }
}

// THE STORAGE ROUND-TRIP: the PATCH sanitizes both keys (the off marker
// is not a storable row; a stale id falls back to ''; the caps hold).
func TestV1220PreamblePatchRoundTrip(t *testing.T) {
        s := newMirrorServer(t)
        createSessionRaw(t, s, `{"id":"m7","title":"RT","provider":"nvidia","model":"m"}`)

        code, body := patchSessionRaw(t, s, "m7",
                `{"preambles":"[{\"id\":\"pre_1\",\"name\":\"Mine\",\"text\":\"MY BRIEF {session}\"}]","preamble_sel":"pre_1"}`)
        if code != 200 {
                t.Fatalf("patch HTTP %d: %s", code, body)
        }
        sess, _ := s.db.GetSession("m7")
        if sess.PreambleSel != "pre_1" || !strings.Contains(sess.Preambles, "MY BRIEF") {
                t.Fatalf("round-trip failed: sel=%q pre=%s", sess.PreambleSel, sess.Preambles)
        }

        // a stale selection falls back to '' (the default)
        code, _ = patchSessionRaw(t, s, "m7", `{"preamble_sel":"pre_gone"}`)
        if code != 200 {
                t.Fatalf("patch2 HTTP %d", code)
        }
        sess, _ = s.db.GetSession("m7")
        if sess.PreambleSel != "" {
                t.Fatalf("a stale sel must fall back to '', got %q", sess.PreambleSel)
        }

        // the OFF marker selects honestly
        code, _ = patchSessionRaw(t, s, "m7", `{"preamble_sel":"off"}`)
        if code != 200 {
                t.Fatalf("patch3 HTTP %d", code)
        }
        sess, _ = s.db.GetSession("m7")
        if sess.PreambleSel != "off" {
                t.Fatalf("off must store as off, got %q", sess.PreambleSel)
        }
        prompt := s.systemPromptFor(sess)
        if strings.Contains(prompt, "## This chat's controls") {
                t.Fatalf("the off selection must compose lean")
        }
}
