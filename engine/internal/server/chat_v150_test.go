package server

// chat_v150_test.go — v1.49 THE UNLOST MIND (PLAN-V149): the Go battery.
// The pins (all against the PRODUCTION builders — buildHistoryCompacted,
// not the test-only buildHistory):
//   §2 THE ONE TRUTH    — a >6KB tool_result rides the history WHOLE
//   §3 THE HONEST MASK  — hide events mask the model-facing history
//   §4 THE SINGLE VOICE — a streamed reply folds to EXACTLY ONCE
//   §5 THE CONTINUE     — the tail-read law (cut vs died-before-content)

import (
	"fmt"
	"strings"
	"testing"

	"github.com/ScoobyBaby1999/doomalay/engine/internal/store"
)

func v150Server(t *testing.T) (*Server, *store.Session) {
	t.Helper()
	dir := t.TempDir()
	db, err := store.Open(dir)
	if err != nil {
		t.Fatalf("store: %v", err)
	}
	if err := db.Migrate(); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	sess := &store.Session{ID: "v150", Title: "t", SlidingWindow: 40}
	if err := db.CreateSession(sess); err != nil {
		t.Fatalf("create: %v", err)
	}
	return &Server{db: db}, sess
}

// §2: a 40KB tool result rides the PRODUCTION history builder whole —
// the 6,000-byte cross-turn clamp and the 12-pair stub law are dead.
func TestV150_WholeResultRides(t *testing.T) {
	s, sess := v150Server(t)
	big := strings.Repeat("FINDING: the caps live in skills.go\n", 1400) // ~42KB
	db := s.db
	db.AppendEvent("v150", "user", "read the file", "")
	db.AppendEvent("v150", "tool_use", toolUseEv(t, "workspace", `{"action":"read","what":"skills.go"}`), "")
	db.AppendEvent("v150", "tool_result", toolResultEv(t, "workspace", big), "")
	db.AppendEvent("v150", "assistant", "found the caps", "")

	h := s.buildHistoryCompacted("v150", sess, 40)
	var rode string
	for _, m := range h {
		if m.Role == "tool" {
			rode = m.Content
		}
	}
	if rode == "" {
		t.Fatalf("the tool result never rode the history")
	}
	if len(rode) != len(big) {
		t.Fatalf("v1.50.2 whole law: the result rode at %d bytes, want %d (no clamp, no stub)", len(rode), len(big))
	}
	if strings.Contains(rode, "[truncated") || strings.Contains(rode, "[ran ") {
		t.Fatalf("v1.50.2: no clamp marker, no stub — got a marker anyway: %.60s", rode)
	}
}

// §3: hide events mask the model-facing history — the retry/edit/regenerate
// dead turn leaves the context (the chat-repeating-itself root cause).
func TestV150_HonestMask(t *testing.T) {
	s, sess := v150Server(t)
	db := s.db
	db.AppendEvent("v150", "user", "hello", "")
	db.AppendEvent("v150", "assistant", "hi", "")

	// a failed turn: user M + partial assistant + error — then the client
	// masks the whole tail (the retry shape) and re-sends M.
	db.AppendEvent("v150", "user", "do the thing", "")
	db.AppendEvent("v150", "assistant", "partial work", "")
	db.AppendEvent("v150", "error", `{"error":"x","message":"boom"}`, "")
	// resolve the three event ids from the log
	events, err := db.ListEvents("v150", 0)
	if err != nil {
		t.Fatal(err)
	}
	var ids []int64
	for _, ev := range events {
		if ev.Content == "do the thing" || ev.Content == "partial work" || ev.EventType == "error" {
			ids = append(ids, ev.ID)
		}
	}
	if len(ids) != 3 {
		t.Fatalf("seed: expected 3 maskable ids, got %d", len(ids))
	}
	idJSON := fmt.Sprintf("[%d,%d,%d]", ids[0], ids[1], ids[2])
	db.AppendEvent("v150", "hide", idJSON, "")
	// the re-sent message (the retry's second copy)
	db.AppendEvent("v150", "user", "do the thing", "")

	h := s.buildHistoryCompacted("v150", sess, 40)
	users := 0
	for _, m := range h {
		if m.Role == "user" && m.Content == "do the thing" {
			users++
		}
		if m.Role == "assistant" && m.Content == "partial work" {
			t.Fatalf("v1.50.3 honest mask: the masked partial still rides the model history")
		}
	}
	if users != 1 {
		t.Fatalf("v1.50.3 honest mask: the user message rides %d times, want exactly 1 (the repeat disease)", users)
	}
}

// §4: a streamed reply (deltas + seal) folds to EXACTLY ONCE through the
// PRODUCTION builder — no fragments, no duplicate full copy.
func TestV150_SingleVoice(t *testing.T) {
	s, sess := v150Server(t)
	db := s.db
	db.AppendEvent("v150", "user", "tell me a story", "")
	for _, d := range []string{"Once ", "upon ", "a ", "time ", "there ", "was ", "a bot."} {
		db.AppendEvent("v150", "assistant_delta", d, "")
	}
	db.AppendEvent("v150", "assistant", "Once upon a time there was a bot.", "")

	h := s.buildHistoryCompacted("v150", sess, 40)
	count := 0
	for _, m := range h {
		if m.Role == "assistant" {
			count++
			if m.Content != "Once upon a time there was a bot." {
				t.Fatalf("v1.50.4 single voice: fragment leaked: %q", m.Content)
			}
		}
	}
	if count != 1 {
		t.Fatalf("v1.50.4 single voice: the reply rides %d times, want exactly 1", count)
	}
}

// §5: the tail-read law — the cut shape arms the seam nudge; the
// died-before-content shape does not.
func TestV150_ContinueTailRead(t *testing.T) {
	// cut shape: partial assistant content, then the terminal bookkeeping
	cut := []*store.Event{
		{ID: 1, EventType: "user", Content: "go"},
		{ID: 2, EventType: "assistant_delta", Content: "partial"},
		{ID: 3, EventType: "status", Content: `{"state":"error"}`},
		{ID: 4, EventType: "error", Content: `{"error":"net","message":"cut"}`},
	}
	if !continueTailIsAssistant(cut) {
		t.Fatalf("the cut shape must read assistant (the seam nudge rides)")
	}

	// died-before-content: the turn failed with no reply
	died := []*store.Event{
		{ID: 1, EventType: "user", Content: "go"},
		{ID: 2, EventType: "error", Content: `{"error":"401","message":"bad key"}`},
		{ID: 3, EventType: "status", Content: `{"state":"error"}`},
	}
	if continueTailIsAssistant(died) {
		t.Fatalf("the died-before-content shape must read user-side (no nudge — the model just answers)")
	}

	// a sealed-but-cut reply (finish_reason length): assistant tail
	sealed := []*store.Event{
		{ID: 1, EventType: "user", Content: "go"},
		{ID: 2, EventType: "assistant", Content: "the answer begins..."},
		{ID: 3, EventType: "status", Content: `{"state":"idle","usage":{"finish_reason":"length","output_cut":true}}`},
	}
	if !continueTailIsAssistant(sealed) {
		t.Fatalf("the length-cut shape must read assistant (continue from the seal)")
	}

	// empty log — user-side by default
	if continueTailIsAssistant(nil) {
		t.Fatalf("an empty log must read user-side")
	}
}
