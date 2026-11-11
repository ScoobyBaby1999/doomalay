package server

// chat_v1762_test.go — v1.76.2 THE STALL SENTINEL, server-side pins
// (PLAN-V176 §v1.76.2): guardBrainStall turns the bridge's typed stall
// sentinel into a PERSISTED error event that rides the wrapped stream
// AFTER the buffered events (order law) — the dead spinner dies — and
// passes non-stall errors through untouched.

import (
	"errors"
	"fmt"
	"testing"

	"github.com/ScoobyBaby1999/doomalay/engine/internal/brain"
)

func TestV1762_GuardInjectsHonestErrorAfterBufferedEvents(t *testing.T) {
	events := make(chan map[string]any, 4)
	errs := make(chan error, 1)
	events <- map[string]any{"type": "thinking", "text": "one"}
	events <- map[string]any{"type": "assistant_delta", "text": "two"}
	errs <- fmt.Errorf("%w: no SSE bytes for 45s (test shape)", brain.ErrStreamStalled)
	close(events)
	close(errs)

	out, outErrs := guardBrainStall(events, errs)

	var got []map[string]any
	for ev := range out {
		got = append(got, ev)
	}
	if len(got) != 3 {
		t.Fatalf("wrapped stream = %d events, want 3 (2 buffered + the honest error)", len(got))
	}
	if got[0]["type"] != "thinking" || got[1]["type"] != "assistant_delta" {
		t.Fatalf("order law violated: buffered events must ride first, got %+v", got[:2])
	}
	last := got[2]
	if last["type"] != "error" || last["error"] != "brain_stall" {
		t.Fatalf("the stall must land as the persisted error event, got %+v", last)
	}
	if msg, _ := last["message"].(string); msg == "" {
		t.Fatal("the error event must carry the honest message")
	}
	if e := <-outErrs; !errors.Is(e, brain.ErrStreamStalled) {
		t.Fatalf("outErrs = %v, want the sentinel for the log", e)
	}
}

func TestV1762_GuardPassesNonStallThrough(t *testing.T) {
	events := make(chan map[string]any, 1)
	errs := make(chan error, 1)
	plain := errors.New("connection reset by peer")
	events <- map[string]any{"type": "thinking", "text": "one"}
	errs <- plain
	close(events)
	close(errs)

	out, outErrs := guardBrainStall(events, errs)

	n := 0
	for range out {
		n++
	}
	if n != 1 {
		t.Fatalf("wrapped stream = %d, want 1 (no synthetic injection)", n)
	}
	if e := <-outErrs; e != plain {
		t.Fatalf("outErrs = %v, want the passthrough error", e)
	}
}

func TestV1762_GuardCleanStreamUnchanged(t *testing.T) {
	events := make(chan map[string]any, 2)
	errs := make(chan error, 1)
	events <- map[string]any{"type": "assistant_delta", "text": "hi"}
	close(events)
	close(errs) // clean end: no error value at all

	out, outErrs := guardBrainStall(events, errs)

	n := 0
	for range out {
		n++
	}
	if n != 1 {
		t.Fatalf("wrapped stream = %d, want 1", n)
	}
	if e := <-outErrs; e != nil {
		t.Fatalf("outErrs = %v, want nil (clean end)", e)
	}
}
