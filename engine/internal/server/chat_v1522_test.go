package server

// chat_v1522_test.go — v1.52.2 THE NO-DUP SEND pins.
//
// The trippy (2).md log convicted the disease: a ~3-minute DNS outage killed
// the same send five times in a row, and every tap (plus every dead-socket
// queue replay) persisted a NEW user row — 5 identical messages + raw error
// JSON pairs stacked in the transcript while history bloated. The cure (the
// v1.50.5 law): a re-send of the FAILED turn's own text is a CONTINUE in
// disguise — sendIsFailedRepeat decides, nothing re-persists.

import (
	"fmt"
	"testing"

	"github.com/ScoobyBaby1999/doomalay/engine/internal/store"
)

func v1522Server(t *testing.T) (*Server, *store.Session) {
	t.Helper()
	dir := t.TempDir()
	db, err := store.Open(dir)
	if err != nil {
		t.Fatalf("store: %v", err)
	}
	if err := db.Migrate(); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	sess := &store.Session{ID: "v1522", Title: "t", SlidingWindow: 40}
	if err := db.CreateSession(sess); err != nil {
		t.Fatalf("create: %v", err)
	}
	return &Server{db: db}, sess
}

// The shape matrix: which tails convert a same-text send into a continue.
func TestV1522_SendIsFailedRepeat(t *testing.T) {
	s, _ := v1522Server(t)
	db := s.db
	db.AppendEvent("v1522", "user", "hello", "")
	db.AppendEvent("v1522", "assistant", "hi", "")
	db.AppendEvent("v1522", "status", `{"state":"idle","usage":null}`, "")

	// 1) a failed turn + the SAME text → continue (the convicted 5× shape)
	db.AppendEvent("v1522", "user", "push the glow feature", "")
	db.AppendEvent("v1522", "error", `{"error":"llm","message":"netx: no address for \"integrate.api.nvidia.com\" (system resolver and DNS-over-HTTPS both failed)"}`, "")
	db.AppendEvent("v1522", "status", `{"state":"error","usage":null}`, "")
	if !s.sendIsFailedRepeat("v1522", "push the glow feature") {
		t.Fatal("the convicted shape: same text after a failed turn must be a continue-in-disguise")
	}
	// a different text → fresh send
	if s.sendIsFailedRepeat("v1522", "actually do something else") {
		t.Fatal("a different text is a fresh send — must persist")
	}

	// 2) the SAME text after a COMPLETED turn → a genuine new question
	db.AppendEvent("v1522", "user", "tell me a joke", "")
	db.AppendEvent("v1522", "assistant", "why did the chicken…", "")
	db.AppendEvent("v1522", "status", `{"state":"idle","usage":null}`, "")
	if s.sendIsFailedRepeat("v1522", "tell me a joke") {
		t.Fatal("a repeat send after a COMPLETED turn is a new question — must persist")
	}

	// 3) the cut shape: partial content then error + same text → continue
	db.AppendEvent("v1522", "user", "write the essay", "")
	db.AppendEvent("v1522", "assistant_delta", "Once upon a", "")
	db.AppendEvent("v1522", "error", `{"error":"stream","message":"cut mid-stream"}`, "")
	db.AppendEvent("v1522", "status", `{"state":"error","usage":null}`, "")
	if !s.sendIsFailedRepeat("v1522", "write the essay") {
		t.Fatal("the cut shape: same text after a failed partial turn must resume as continue")
	}

	// 4) empty/blank text never converts
	if s.sendIsFailedRepeat("v1522", "") || s.sendIsFailedRepeat("v1522", "   ") {
		t.Fatal("empty/blank text is never a failed-repeat")
	}
}

// The flood shape: the user row buried under 5,600 content rows — the
// trippy log's real geometry (a 400-tail window would miss it; the
// 8000-row window must not).
func TestV1522_FloodTailFindsTheUserRow(t *testing.T) {
	s, _ := v1522Server(t)
	db := s.db
	db.AppendEvent("v1522", "user", "diagnose the repo", "")
	for i := 0; i < 5600; i++ {
		db.AppendEvent("v1522", "assistant_delta", fmt.Sprintf("delta %d ", i), "")
	}
	db.AppendEvent("v1522", "error", `{"error":"stream","message":"interrupted"}`, "")
	db.AppendEvent("v1522", "status", `{"state":"error","usage":null}`, "")
	if !s.sendIsFailedRepeat("v1522", "diagnose the repo") {
		t.Fatal("the flood shape: the user row under 5,600 deltas must still be found (8000-row window)")
	}
	if s.sendIsFailedRepeat("v1522", "a different ask entirely") {
		t.Fatal("a different text over the same flood is a fresh send")
	}
}

// The busy shape's guard: lastInflightUserText names the running turn's
// own request so the reject can answer honestly without a second row.
func TestV1522_LastInflightUserText(t *testing.T) {
	s, _ := v1522Server(t)
	db := s.db
	if got := s.lastInflightUserText("v1522"); got != "" {
		t.Fatalf("no user rows yet: got %q, want empty", got)
	}
	db.AppendEvent("v1522", "user", "first message", "")
	db.AppendEvent("v1522", "assistant", "answer", "")
	db.AppendEvent("v1522", "status", `{"state":"idle","usage":null}`, "")
	db.AppendEvent("v1522", "user", "the in-flight request", "")
	if got := s.lastInflightUserText("v1522"); got != "the in-flight request" {
		t.Fatalf("lastInflightUserText = %q, want the running turn's row", got)
	}
}
