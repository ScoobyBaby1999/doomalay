package server

// v1.10.2 THE NO-FIRST-BYTE GUARD — the D1 regression tests. The black-hole
// signature: progress/status heartbeats forever, zero LLM events. The guard
// must fire on that — and must NOT fire once real evidence lands (the
// v0.80.1 no-kill directive: slow-but-alive turns keep going forever).

import (
	"testing"
	"time"
)

func TestGuardFiresOnHeartbeatOnlyStream(t *testing.T) {
	events := make(chan map[string]any)
	errs := make(chan error)
	go func() {
		defer close(events)
		defer close(errs)
		// the observed black hole: status, then heartbeats forever
		events <- map[string]any{"type": "status", "state": "running"}
		for i := 0; i < 30; i++ {
			events <- map[string]any{"type": "progress", "message": "still working"}
			time.Sleep(50 * time.Millisecond)
		}
	}()

	firedCancel := make(chan struct{})
	out, fired := guardFirstByte(events, 1, func() { close(firedCancel) })
	go func() { for range errs {} }() // drain like forwardEvents does

	var notice bool
	deadline := time.After(5 * time.Second)
	for {
		select {
		case ev, ok := <-out:
			if !ok {
				if !fired() {
					t.Fatal("stream ended without the guard firing (black hole would hang forever)")
				}
				if !notice {
					t.Fatal("guard fired but no notice event streamed")
				}
				select {
				case <-firedCancel:
				case <-time.After(time.Second):
					t.Fatal("onFire (the space-call cancel) never ran — the errs drain would deadlock")
				}
				return
			}
			if ev["type"] == "notice" {
				notice = true
			}
		case <-deadline:
			t.Fatal("guard never fired on a heartbeat-only stream")
		}
	}
}

func TestGuardDisarmsOnLLMEvidence(t *testing.T) {
	events := make(chan map[string]any)
	go func() {
		defer close(events)
		events <- map[string]any{"type": "status", "state": "running"}
		events <- map[string]any{"type": "progress", "message": "still working"}
		// first REAL evidence at 300ms — inside the 2s guard window
		time.Sleep(300 * time.Millisecond)
		events <- map[string]any{"type": "thinking", "text": "hmm"}
		// then a SLOW silent stretch far beyond the window — must pass
		// through untouched (the no-kill directive)
		time.Sleep(2500 * time.Millisecond)
		events <- map[string]any{"type": "assistant_delta", "text": "answer"}
	}()

	out, fired := guardFirstByte(events, 2, nil)
	var sawDelta bool
	for ev := range out {
		if ev["type"] == "assistant_delta" {
			sawDelta = true
		}
	}
	if fired() {
		t.Fatal("guard fired on an ALIVE turn — the no-kill directive violation")
	}
	if !sawDelta {
		t.Fatal("guard ate the post-evidence events")
	}
}

func TestGuardDisabled(t *testing.T) {
	events := make(chan map[string]any)
	go func() {
		defer close(events)
		for i := 0; i < 5; i++ {
			events <- map[string]any{"type": "progress", "message": "still working"}
		}
	}()
	out, fired := guardFirstByte(events, 0, nil)
	n := 0
	for range out {
		n++
	}
	if n != 5 || fired() {
		t.Fatalf("killAfterSec=0 must pass everything through: n=%d fired=%v", n, fired())
	}
}
