package server

// server_v1523_test.go — v1.52.3 THE HEALED SEAM pins.
//
// The trippy (2).md log's final turn died mid-tool-call to an engine
// restart ("interrupted by engine restart" ×2 in one session; the turn's
// 5,600 events produced zero durable output). The boot heal appended only
// a terminal status — the DANGLING tool_use stayed unanswered, and the
// history fold (foldSlots) DROPS unanswered uses entirely: the model's
// context lost even the knowledge that it made the call, and provider
// wires that validate the tool_use→tool_result chain got an invalid
// shape the moment a continue resumed the turn.

import (
	"strings"
	"testing"

	"github.com/ScoobyBaby1999/doomalay/engine/internal/store"
)

func v1523Server(t *testing.T) (*Server, *store.Session) {
	t.Helper()
	dir := t.TempDir()
	db, err := store.Open(dir)
	if err != nil {
		t.Fatalf("store: %v", err)
	}
	if err := db.Migrate(); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	sess := &store.Session{ID: "v1523", Title: "t", SlidingWindow: 40}
	if err := db.CreateSession(sess); err != nil {
		t.Fatalf("create: %v", err)
	}
	return &Server{db: db}, sess
}

// The interrupted mid-tool-call shape: user → tool_use (workspace, never
// answered) → RESTART. The heal must answer the call with the never-ran
// truth and close the turn — and the PRODUCTION history builder must
// carry the pair (not drop it).
func TestV1523_HealAnswersDanglingToolUse(t *testing.T) {
	s, sess := v1523Server(t)
	db := s.db
	db.AppendEvent("v1523", "user", "read the repo and fix the bug", "")
	db.AppendEvent("v1523", "assistant", "on it — reading the file", "")
	db.AppendEvent("v1523", "tool_use", toolUseEv(t, "workspace", `{"action":"read","path":"big.go"}`), "")
	// …engine dies HERE — no tool_result, no terminal…
	db.AppendEvent("v1523", "tool_use", toolUseEv(t, "termux", `{"action":"exec","command":"go test"}`), "")
	db.AppendEvent("v1523", "tool_result", toolResultEv(t, "termux", "EXEC DONE ok"), "")   // answered before the second call
	db.AppendEvent("v1523", "tool_use", toolUseEv(t, "workspace", `{"action":"tree"}`), "") // dangling

	s.healInterruptedTurns()

	events, err := db.ListEvents("v1523", 0)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	var synth, healed int
	for _, ev := range events {
		if ev.EventType == "tool_result" && strings.Contains(ev.Content, "interrupted by engine restart") {
			synth++
		}
		if ev.EventType == "status" && strings.Contains(ev.Content, `"healed":true`) {
			healed++
			if !strings.Contains(ev.Content, `"hint":"continue"`) {
				t.Fatalf("the healed terminal must carry the continue hint: %s", ev.Content)
			}
		}
	}
	if synth != 2 {
		t.Fatalf("the heal must answer BOTH dangling calls (workspace read + workspace tree), got %d", synth)
	}
	if healed != 1 {
		t.Fatalf("the healed terminal must land exactly once, got %d", healed)
	}
	// the synthesized rows must land BEFORE the terminal (they belong to
	// the interrupted turn)
	var lastSynth, termAt int = -1, -1
	for i, ev := range events {
		if ev.EventType == "tool_result" && strings.Contains(ev.Content, "interrupted by engine restart") {
			lastSynth = i
		}
		if ev.EventType == "status" && strings.Contains(ev.Content, `"healed":true`) {
			termAt = i
		}
	}
	if lastSynth > termAt {
		t.Fatalf("synthesized results must precede the terminal: synth@%d term@%d", lastSynth, termAt)
	}

	// THE SEAM CARRIES THE TRUTH: the production history builder pairs
	// every tool_use with its result — nothing dropped, nothing dangling.
	h := s.buildHistoryCompacted("v1523", sess, 40)
	var uses, results int
	var neverRanSeen bool
	for _, m := range h {
		if m.Role == "assistant" && len(m.ToolCalls) > 0 {
			uses++
		}
		if m.Role == "tool" {
			results++
			if strings.Contains(m.Content, "interrupted by engine restart") {
				neverRanSeen = true
			}
		}
	}
	if uses != 3 || results != 3 {
		t.Fatalf("the healed seam: 3 tool calls must ride as 3 answered pairs, got uses=%d results=%d", uses, results)
	}
	if !neverRanSeen {
		t.Fatal("the never-ran truth must ride the model-facing history")
	}
}

// A turn interrupted BEFORE any tool call heals with zero synthesized
// rows (nothing to answer) — the plain terminal still lands.
func TestV1523_HealWithoutToolsIsUnchanged(t *testing.T) {
	s, _ := v1523Server(t)
	db := s.db
	db.AppendEvent("v1523", "user", "just chatting", "")
	db.AppendEvent("v1523", "assistant_delta", "answering…", "")

	s.healInterruptedTurns()

	events, _ := db.ListEvents("v1523", 0)
	for _, ev := range events {
		if ev.EventType == "tool_result" {
			t.Fatalf("no tool calls were made — no synthesized results may appear: %s", ev.Content)
		}
	}
	var healed bool
	for _, ev := range events {
		if ev.EventType == "status" && strings.Contains(ev.Content, `"healed":true`) {
			healed = true
		}
	}
	if !healed {
		t.Fatal("the healed terminal must still land")
	}
}

// A CLOSED session is never touched by the heal.
func TestV1523_HealIgnoresClosedTurns(t *testing.T) {
	s, _ := v1523Server(t)
	db := s.db
	db.AppendEvent("v1523", "user", "done turn", "")
	db.AppendEvent("v1523", "assistant", "bye", "")
	db.AppendEvent("v1523", "status", `{"state":"idle","usage":null}`, "")

	s.healInterruptedTurns()

	events, _ := db.ListEvents("v1523", 0)
	if len(events) != 3 {
		t.Fatalf("a closed session must not gain rows, got %d", len(events))
	}
}
