package server

// termuxphoenix_v1747_test.go — v1.74.7 THE PHOENIX HEART pins (PLAN-V175):
// the health gauge's laws, the ladder's throttle + single-flight, the
// observation teach's ladder, and the status snapshot — all pinned against
// the boonboon transcript's dead-shell conviction (13 blind retries, zero
// honesty).

import (
	"strings"
	"testing"
	"time"
)

// TestV1747_GaugeResetsAndConvicts — a delivered outcome resets the gauge;
// two consecutive never-executed outcomes convict (the ladder fires
// asynchronously; the gauge's count is the pinned truth).
func TestV1747_GaugeResetsAndConvicts(t *testing.T) {
	s := &Server{}
	if got := s.termuxPhoenixNoteLine(); got != "" {
		t.Fatalf("a cold gauge teaches nothing: %q", got)
	}
	// a delivered result stamps the OK clock
	s.termuxPhoenixObserveOK()
	s.termuxPhoenixMu.Lock()
	consec, okSet := s.termuxPhoenix.consecutive, !s.termuxPhoenix.lastOK.IsZero()
	s.termuxPhoenixMu.Unlock()
	if consec != 0 || !okSet {
		t.Fatalf("the OK observation must reset + stamp: consec=%d okSet=%v", consec, okSet)
	}
	// one fail: the gauge bumps, no conviction line yet (the throttle may
	// or may not have fired the ladder — the CONSECUTIVE count is the law)
	s.termuxPhoenixMu.Lock()
	s.termuxPhoenix.lastAt = time.Now().Add(-time.Hour) // the throttle is cold — the ladder MAY fire
	s.termuxPhoenixMu.Unlock()
	s.termux = nil // neuter the ladder spawn (nil bridge → the ladder settles honestly)
	s.termuxPhoenixObserveFail()
	s.termuxPhoenixMu.Lock()
	consec = s.termuxPhoenix.consecutive
	s.termuxPhoenixMu.Unlock()
	if consec != 1 {
		t.Fatalf("one fail bumps the gauge to 1, got %d", consec)
	}
	// the note line speaks at the conviction threshold even before any
	// ladder settles (the transcript's teach: the model learns the state)
	s.termuxPhoenixObserveFail()
	s.termuxPhoenixMu.Lock()
	consec = s.termuxPhoenix.consecutive
	s.termuxPhoenixMu.Unlock()
	if consec != 2 {
		t.Fatalf("two consecutive fails convict at 2, got %d", consec)
	}
	if line := s.termuxPhoenixNoteLine(); !strings.Contains(line, "shell appears DEAD") {
		t.Fatalf("the conviction teaches the dead shell: %q", line)
	}
	// a delivered result resets — the conviction teach dies with it (the
	// ladder's OWN state is a separate honest record: zero it here so the
	// gauge-reset law is pinned deterministically, free of the spawned
	// ladder's async settle)
	s.termuxPhoenixMu.Lock()
	s.termuxPhoenix.lastAt = time.Time{}
	s.termuxPhoenix.running = false
	s.termuxPhoenixMu.Unlock()
	s.termuxPhoenixObserveOK()
	if line := s.termuxPhoenixNoteLine(); strings.Contains(line, "DEAD") {
		t.Fatalf("an OK resets the teach: %q", line)
	}
}

// TestV1747_ThrottleAndSingleFlight — one ladder at a time, ≥90s between
// ladder starts: a second MaybeRevive while running (or inside the
// throttle window) is a no-op.
func TestV1747_ThrottleAndSingleFlight(t *testing.T) {
	s := &Server{}
	s.termuxPhoenixMu.Lock()
	s.termuxPhoenix.running = true // a ladder is in flight
	s.termuxPhoenixMu.Unlock()
	s.termuxPhoenixMaybeRevive() // must return without touching anything
	s.termuxPhoenixMu.Lock()
	attempts := s.termuxPhoenix.attempts
	s.termuxPhoenixMu.Unlock()
	if attempts != 0 {
		t.Fatalf("single-flight: a running ladder refuses a second, got attempts=%d", attempts)
	}
	// throttle: not running, but the last ladder started <90s ago
	s.termuxPhoenixMu.Lock()
	s.termuxPhoenix.running = false
	s.termuxPhoenix.lastAt = time.Now().Add(-10 * time.Second)
	s.termuxPhoenixMu.Unlock()
	s.termuxPhoenixMaybeRevive()
	s.termuxPhoenixMu.Lock()
	attempts = s.termuxPhoenix.attempts
	s.termuxPhoenixMu.Unlock()
	if attempts != 0 {
		t.Fatalf("the 90s throttle paces the ladder, got attempts=%d", attempts)
	}
	// past the window: the ladder starts (attempts=1, running=true — the
	// real ladder's probes run against a nil client and settle honestly)
	s.termuxPhoenixMu.Lock()
	s.termuxPhoenix.lastAt = time.Now().Add(-95 * time.Second)
	s.termuxPhoenixMu.Unlock()
	s.termuxPhoenixMaybeRevive()
	// the ladder runs synchronously inside MaybeRevive on this goroutine —
	// wait for the settle (bounded)
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		s.termuxPhoenixMu.Lock()
		running, attempts := s.termuxPhoenix.running, s.termuxPhoenix.attempts
		s.termuxPhoenixMu.Unlock()
		if !running && attempts == 1 {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	s.termuxPhoenixMu.Lock()
	running, attempts, lastErr := s.termuxPhoenix.running, s.termuxPhoenix.attempts, s.termuxPhoenix.lastError
	s.termuxPhoenixMu.Unlock()
	if running || attempts != 1 {
		t.Fatalf("past the throttle the ladder runs once: running=%v attempts=%d", running, attempts)
	}
	// the nil client's honest verdict
	if !strings.Contains(lastErr, "bridge") {
		t.Fatalf("the nil-bridge ladder settles honestly: %q", lastErr)
	}
}

// TestV1747_StatusSnapshot — the additive status fields speak the gauge +
// the ladder's record (the /api/termux/status consumer's contract).
func TestV1747_StatusSnapshot(t *testing.T) {
	s := &Server{}
	s.termuxPhoenixObserveOK()
	s.termuxPhoenixMu.Lock()
	s.termuxPhoenix.attempts = 2
	s.termuxPhoenix.lastOKL = true
	s.termuxPhoenix.lastError = ""
	s.termuxPhoenixMu.Unlock()
	snap := s.termuxPhoenixSnapshot()
	if snap.Consecutive != 0 || snap.ReviveAttempts != 2 || !snap.ReviveLastOK || snap.LastOKAt == 0 {
		t.Fatalf("the snapshot speaks the gauge + the ladder: %+v", snap)
	}
}

// TestV1747_NoteLineLadder — the teach line names the in-flight ladder,
// the successful revival, and the failed ladder's fix.
func TestV1747_NoteLineLadder(t *testing.T) {
	s := &Server{}
	s.termuxPhoenixMu.Lock()
	s.termuxPhoenix.consecutive = 3
	s.termuxPhoenix.running = true
	s.termuxPhoenix.attempts = 2
	s.termuxPhoenixMu.Unlock()
	line := s.termuxPhoenixNoteLine()
	if !strings.Contains(line, "auto-revive ladder is RUNNING") || !strings.Contains(line, "attempt 2") {
		t.Fatalf("the in-flight teach names the attempt: %q", line)
	}
	s.termuxPhoenixMu.Lock()
	s.termuxPhoenix.running = false
	s.termuxPhoenix.lastAt = time.Now()
	s.termuxPhoenix.lastOKL = true
	s.termuxPhoenixMu.Unlock()
	line = s.termuxPhoenixNoteLine()
	if !strings.Contains(line, "BROUGHT IT BACK") {
		t.Fatalf("the revival teach says it's back: %q", line)
	}
	s.termuxPhoenixMu.Lock()
	s.termuxPhoenix.lastOKL = false
	s.termuxPhoenix.lastError = "Android likely holds it in the stopped state"
	s.termuxPhoenixMu.Unlock()
	line = s.termuxPhoenixNoteLine()
	if !strings.Contains(line, "could not revive") || !strings.Contains(line, "stopped state") {
		t.Fatalf("the failed-ladder teach names the state + the fix: %q", line)
	}
}

// TestV1747_SourcePins — the wave's laws in the source: the run choke
// point feeds the gauge, the probe cache feeds it too, the streaming
// timeout carries the note, and the keepalive loop exists with its
// constructive quiet gate.
func TestV1747_SourcePins(t *testing.T) {
	runSrc := srcOf(t, "termuxtool.go")
	for _, want := range []string{
		"s.termuxPhoenixObserveFail()",
		"s.termuxPhoenixObserveOK()",
	} {
		if !strings.Contains(runSrc, want) {
			t.Fatalf("the run choke point must feed the gauge: %q", want)
		}
	}
	apiSrc := srcOf(t, "termuxapi.go")
	for _, want := range []string{
		"s.termuxPhoenixObserveFail()",
		"phoenix_revive_running",
	} {
		if !strings.Contains(apiSrc, want) {
			t.Fatalf("the status route must observe + speak the phoenix: %q", want)
		}
	}
	streamSrc := srcOf(t, "termuxstreamrun.go")
	if !strings.Contains(streamSrc, "termuxPhoenixNoteLine()") {
		t.Fatal("the streaming timeout carries the phoenix note")
	}
	phxSrc := srcOf(t, "termuxphoenix.go")
	for _, want := range []string{
		"termuxPhoenixKeepaliveFresh",
		"lastOK.IsZero()",
		"$HOME/.doomalay/alive",
	} {
		if !strings.Contains(phxSrc, want) {
			t.Fatalf("the phoenix file pins its own laws: %q", want)
		}
	}
	srvSrc := srcOf(t, "server.go")
	if !strings.Contains(srvSrc, "go s.termuxPhoenixKeepalive()") {
		t.Fatal("the keepalive loop starts with the server")
	}
}
