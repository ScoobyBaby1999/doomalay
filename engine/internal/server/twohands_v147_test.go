package server

// fleet_v1472_test.go + djournal_v1471_test.go shapes — v1.47 THE TWO
// HANDS (PLAN-V147 §1/§2): the integration battery over the REAL server
// runners against a REAL store (the harness law: temp dirs, no network).
// The mcpbus dispatch itself is pinned by the def-count test.

import (
	"context"
	"encoding/json"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/ScoobyBaby1999/doomalay/engine/internal/config"
	"github.com/ScoobyBaby1999/doomalay/engine/internal/mcpbus"
	"github.com/ScoobyBaby1999/doomalay/engine/internal/store"
)

func newTestServerV147(t *testing.T) *Server {
	t.Helper()
	dir := t.TempDir()
	db, err := store.Open(dir)
	if err != nil {
		t.Fatalf("store: %v", err)
	}
	if err := db.Migrate(); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	return &Server{db: db, cfg: &config.Config{DataDir: dir}}
}

func seedSessionV147(t *testing.T, s *Server, id, title, provider, model string) *store.Session {
	t.Helper()
	sess := &store.Session{ID: id, Title: title, Provider: provider, Model: model,
		Effort: "max", Mode: "auto", WebSearch: true, Sandbox: "quick"}
	if err := s.db.CreateSession(sess); err != nil {
		t.Fatalf("create session: %v", err)
	}
	return sess
}

func seedEventV147(t *testing.T, s *Server, sid, typ, content string) {
	t.Helper()
	if _, err := s.db.AppendEvent(sid, typ, content, ""); err != nil {
		t.Fatalf("seed event: %v", err)
	}
}

func seedCanvasV147(t *testing.T, s *Server, id, name string, sessionIDs []string) {
	t.Helper()
	icons := make([]map[string]any, 0, len(sessionIDs))
	for i, sid := range sessionIDs {
		icons = append(icons, map[string]any{"id": "icon-" + id + "-" + string(rune('a'+i)), "sessionId": sid})
	}
	stateBytes, _ := json.Marshal(map[string]any{"icons": icons, "savedAt": "2026-10-20"})
	state := string(stateBytes)
	if _, err := s.db.UpsertCanvas(id, &name, nil, &state); err != nil {
		t.Fatalf("seed canvas: %v", err)
	}
}

// ── v1.47.1 THE JOURNAL HAND: the runner against a real DataDir ─────

func TestV1471_DjournalRunnerWriteReadExport(t *testing.T) {
	s := newTestServerV147(t)
	sid := "sess-j"
	seedSessionV147(t, s, sid, "Journal Chat", "privatemodeai", "glm-5.3")

	ctx := context.Background()
	// 1. write (the bare-string tolerance: models sometimes send just words)
	out := s.runDjournalAction(ctx, sid, `{"action":"write","text":"the rig is green","mood":"good","tags":"work,ship"}`)
	if !strings.Contains(out, "Saved journal entry") || !strings.Contains(out, "🙂") {
		t.Fatalf("write observation: %s", out)
	}
	// 2. read today
	out = s.runDjournalAction(ctx, sid, `{"action":"read","target":"today"}`)
	if !strings.Contains(out, "the rig is green") {
		t.Fatalf("read today: %s", out)
	}
	// 3. the state file lives under <DataDir>/journal/
	if _, err := os.Stat(s.djournalStatePath()); err != nil {
		t.Fatalf("the diary must live under DataDir/journal: %v", err)
	}
	// 4. export json — the artifact drawer card + the state-dir file
	out = s.runDjournalAction(ctx, sid, `{"action":"export","format":"json"}`)
	if !strings.Contains(out, "Saved as artifact \"export.json\"") {
		t.Fatalf("export must sink the artifact: %s", out)
	}
	// the artifact row exists in the session's drawer
	if _, err := s.findArtifactByName(sid, "export.json"); err != nil {
		t.Fatalf("the export artifact must land in the drawer: %v", err)
	}
	// 5. the bare-string tolerance (a diary line without JSON)
	out = s.runDjournalAction(ctx, sid, "just the words I want to journal")
	if !strings.Contains(out, "Saved journal entry") {
		t.Fatalf("bare string must become a write: %s", out)
	}
	// 6. the review
	out = s.runDjournalAction(ctx, sid, `{"action":"review","period":"week"}`)
	if !strings.Contains(out, "Journal review — week") || !strings.Contains(out, "avg mood") {
		t.Fatalf("review: %s", out)
	}
}

func TestV1471_DjournalDefAndSummaryRegistered(t *testing.T) {
	// the Def is in the manifest (GateNone — always armed)
	specs := mcpbus.SpecsFor(mcpbus.Gates{})
	found := false
	for _, sp := range specs {
		fn, _ := sp["function"].(map[string]any)
		if fn != nil && fn["name"] == "djournal" {
			found = true
			props, _ := fn["parameters"].(map[string]any)
			if props == nil {
				t.Fatal("djournal spec missing parameters")
			}
		}
	}
	if !found {
		t.Fatal("djournal missing from the always-armed manifest")
	}
	// the pill body law: the action + operand head
	if got := mcpbus.DefaultSummary("djournal", `{"action":"read","target":"today"}`); got != "read today" {
		t.Errorf("djournal summary = %q, want 'read today'", got)
	}
}

// ── v1.47.2 THE FLEET HAND: roster + detail over the store ──────────

func TestV1472_FleetRosterRunningFirstAndFilter(t *testing.T) {
	s := newTestServerV147(t)
	ctx := context.Background()
	seedSessionV147(t, s, "sess-a", "Alpha Bot", "nvidia", "nemotron")
	seedSessionV147(t, s, "sess-b", "Research Chat", "privatemodeai", "glm-5.3")
	seedSessionV147(t, s, "sess-c", "Journal Chat", "openrouter", "minimax")
	seedCanvasV147(t, s, "canvas-work", "Work", []string{"sess-a", "sess-b"})
	seedCanvasV147(t, s, "canvas-home", "Home", []string{"sess-c"})
	seedEventV147(t, s, "sess-a", "user", "run the rig")
	seedEventV147(t, s, "sess-a", "assistant", "the rig is green")
	seedEventV147(t, s, "sess-a", "status", `{"state":"idle","usage":{"input_tokens":120,"output_tokens":30,"reasoning_tokens":12}}`)

	// sess-b RUNNING (the turn gauge — the engine's own truth)
	turnGaugeInc("sess-b")
	defer turnGaugeDec("sess-b")

	out := s.runFleetAction(ctx, "sess-c", `{"action":"roster"}`)
	// the running chat leads
	ra := strings.Index(out, "Research Chat")
	rb := strings.Index(out, "Alpha Bot")
	if ra < 0 || rb < 0 || ra > rb {
		t.Fatalf("the RUNNING chat must lead the roster:\n%s", out)
	}
	if !strings.Contains(out, "RUNNING") || !strings.Contains(out, "canvas \"Work\"") {
		t.Fatalf("roster rows must carry state + canvas:\n%s", out)
	}
	if !strings.Contains(out, "1 turn") {
		t.Fatalf("the user-event count rides the row:\n%s", out)
	}

	// the filter narrows (name/model/provider/canvas)
	out = s.runFleetAction(ctx, "sess-c", `{"action":"roster","q":"glm"}`)
	if strings.Contains(out, "Alpha Bot") || !strings.Contains(out, "Research Chat") {
		t.Fatalf("q=glm must narrow to the glm chat:\n%s", out)
	}
	out = s.runFleetAction(ctx, "sess-c", `{"action":"roster","q":"home"}`)
	if !strings.Contains(out, "Journal Chat") {
		t.Fatalf("q=home must match by canvas name:\n%s", out)
	}
	// no-match honesty
	out = s.runFleetAction(ctx, "sess-c", `{"action":"roster","q":"zebra"}`)
	if !strings.Contains(out, "no chats match") {
		t.Fatalf("no-match must be honest:\n%s", out)
	}
}

func TestV1472_FleetDetailCurrentActionsAndProgress(t *testing.T) {
	s := newTestServerV147(t)
	ctx := context.Background()
	seedSessionV147(t, s, "sess-r", "Rig Chat", "nvidia", "nemotron")
	seedCanvasV147(t, s, "canvas-lab", "Lab", []string{"sess-r"})
	seedEventV147(t, s, "sess-r", "user", "run the rig please")
	seedEventV147(t, s, "sess-r", "assistant", "starting now")
	seedEventV147(t, s, "sess-r", "status", `{"state":"idle","usage":{"input_tokens":3593,"output_tokens":81,"reasoning_tokens":64}}`)
	// a personas JSON so the identity block resolves a name
	sess, _ := s.db.GetSession("sess-r")
	sess.Personas = `[{"id":"p1","name":"Rigger","text":"you rig things","mode":"always"}]`
	if err := s.db.UpdateSession(sess); err != nil {
		t.Fatalf("update session: %v", err)
	}

	turnGaugeInc("sess-r")
	defer turnGaugeDec("sess-r")

	out := s.runFleetAction(ctx, "sess-other", `{"action":"detail","target":"Rig"}`)
	for _, want := range []string{
		"fleet — detail: Rig Chat",
		"model: nvidia/nemotron · effort: max",
		"persona: Rigger (always)",
		"canvas: \"Lab\"",
		"state: RUNNING — a turn is in flight right now",
		"recent events (oldest first):",
		"user: run the rig please",
		"status: idle",
		"last turn usage: 3,593 in / 81 out (🧠 64 thinking)",
		"turns: 1",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("detail missing %q:\n%s", want, out)
		}
	}
	// the THIS-IS-YOU mark
	out = s.runFleetAction(ctx, "sess-r", `{"action":"detail","target":"sess-r"}`)
	if !strings.Contains(out, "THIS IS YOU") {
		t.Errorf("the caller's own chat is marked:\n%s", out)
	}
	// the target can be the id
	out = s.runFleetAction(ctx, "sess-other", `{"action":"detail","target":"sess-r"}`)
	if !strings.Contains(out, "fleet — detail: Rig Chat") {
		t.Errorf("detail by id:\n%s", out)
	}
}

func TestV1472_FleetDefRegisteredAndHonestHelp(t *testing.T) {
	specs := mcpbus.SpecsFor(mcpbus.Gates{})
	found := false
	for _, sp := range specs {
		fn, _ := sp["function"].(map[string]any)
		if fn != nil && fn["name"] == "fleet" {
			found = true
		}
	}
	if !found {
		t.Fatal("fleet missing from the always-armed manifest")
	}
	if got := mcpbus.DefaultSummary("fleet", `{"action":"detail","target":"Rig"}`); got != "detail Rig" {
		t.Errorf("fleet summary = %q, want 'detail Rig'", got)
	}
	s := newTestServerV147(t)
	out := s.runFleetAction(context.Background(), "x", `{"action":"frobnicate"}`)
	if !strings.Contains(out, "unknown action") {
		t.Errorf("unknown fleet action must teach the grammar: %s", out)
	}
}

func TestV1472_FleetAmbiguityHonesty(t *testing.T) {
	s := newTestServerV147(t)
	ctx := context.Background()
	seedSessionV147(t, s, "s1", "Rig One", "nvidia", "n1")
	seedSessionV147(t, s, "s2", "Rig Two", "nvidia", "n2")
	out := s.runFleetAction(ctx, "s1", `{"action":"detail","target":"Rig"}`)
	if !strings.Contains(out, "ambiguous") || !strings.Contains(out, "Rig One (s1)") {
		t.Fatalf("a prefix hitting two chats must say so honestly:\n%s", out)
	}
	// no-target honesty
	out = s.runFleetAction(ctx, "s1", `{"action":"detail"}`)
	if !strings.Contains(out, "detail needs a target") {
		t.Fatalf("no-target must teach the roster first:\n%s", out)
	}
}

// relTime smoke: the relative clock never lies about "never".
func TestV1472_RelTimeNever(t *testing.T) {
	if got := relTime(0, time.Now()); got != "never" {
		t.Errorf("relTime(0) = %q, want never", got)
	}
}
