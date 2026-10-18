// chat_v1400_test.go — v1.40.0 THE UNBROKEN STREAM pins (the user's law:
// bots keep working when the app backgrounds and when the internet dies;
// the returning user sees everything that happened in their absence).
// This file grows with the wave's phases; v1.39.2 THE AWAKE ENGINE's pin:
// the busy gauge is the engine's OWN truth — Kotlin's 5s poll rides it to
// acquire the PARTIAL_WAKE_LOCK only while turns live.
package server

import (
	"encoding/json"
	"net/http/httptest"
	"sync"
	"testing"
)

func TestV1400_TurnGauge(t *testing.T) {
	// isolate the gauge state for this test
	turnGaugeMu.Lock()
	savedN, savedS := turnGaugeN, turnGaugeSessions
	turnGaugeN = 0
	turnGaugeSessions = map[string]struct{}{}
	turnGaugeMu.Unlock()
	defer func() {
		turnGaugeMu.Lock()
		turnGaugeN, turnGaugeSessions = savedN, savedS
		turnGaugeMu.Unlock()
	}()

	turnGaugeInc("v1400-a")
	turnGaugeInc("v1400-b")
	turnGaugeInc("v1400-a") // same session, second concurrent turn
	turnGaugeMu.Lock()
	n, sess := turnGaugeN, len(turnGaugeSessions)
	turnGaugeMu.Unlock()
	if n != 3 || sess != 2 {
		t.Fatalf("gauge must count concurrent turns per session: got n=%d sessions=%d, want 3/2", n, sess)
	}

	// the handleEngineBusy shape: the endpoint answers the live truth
	s := &Server{}
	rec := httptest.NewRecorder()
	s.handleEngineBusy(rec, httptest.NewRequest("GET", "/api/engine/busy", nil))
	if rec.Code != 200 {
		t.Fatalf("busy endpoint status %d, want 200", rec.Code)
	}
	var body struct {
		Turns    int      `json:"turns"`
		Sessions []string `json:"sessions"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("busy endpoint body not JSON: %v", err)
	}
	if body.Turns != 3 || len(body.Sessions) != 2 {
		t.Fatalf("busy endpoint must report the live gauge: got %+v, want turns=3 sessions=2", body)
	}
	if body.Sessions[0] != "v1400-a" || body.Sessions[1] != "v1400-b" {
		t.Fatalf("busy endpoint sessions must be sorted: got %v", body.Sessions)
	}

	// dec drains per session-turn (two for the double-session)
	turnGaugeDec("v1400-a")
	turnGaugeDec("v1400-a")
	turnGaugeDec("v1400-b")
	turnGaugeMu.Lock()
	n, sess = turnGaugeN, len(turnGaugeSessions)
	turnGaugeMu.Unlock()
	if n != 0 || sess != 0 {
		t.Fatalf("gauge must drain to zero: got n=%d sessions=%d", n, sess)
	}

	// the floor: a stray dec can never make the gauge negative (Kotlin's
	// poll would read it as busy forever)
	turnGaugeDec("v1400-stray")
	turnGaugeMu.Lock()
	n = turnGaugeN
	turnGaugeMu.Unlock()
	if n != 0 {
		t.Fatalf("gauge must never go negative: got %d", n)
	}
}

func TestV1400_TurnGaugeConcurrent(t *testing.T) {
	turnGaugeMu.Lock()
	savedN, savedS := turnGaugeN, turnGaugeSessions
	turnGaugeN = 0
	turnGaugeSessions = map[string]struct{}{}
	turnGaugeMu.Unlock()
	defer func() {
		turnGaugeMu.Lock()
		turnGaugeN, turnGaugeSessions = savedN, savedS
		turnGaugeMu.Unlock()
	}()

	// the parallel-bots shape: many sessions hammering the gauge at once
	// (the engine's true concurrency model) must never lose a count
	var wg sync.WaitGroup
	const rounds = 200
	for i := 0; i < rounds; i++ {
		wg.Add(2)
		go func() { defer wg.Done(); turnGaugeInc("v1400-race") }()
		go func() { defer wg.Done(); turnGaugeDec("v1400-race") }()
	}
	wg.Wait()
	turnGaugeMu.Lock()
	n := turnGaugeN
	turnGaugeMu.Unlock()
	if n < 0 || n > rounds {
		t.Fatalf("racing gauge out of range: %d (want 0..%d)", n, rounds)
	}
	// and the steady-state drain lands at exactly zero
	for i := 0; i < n; i++ {
		turnGaugeDec("v1400-race")
	}
	turnGaugeMu.Lock()
	n = turnGaugeN
	turnGaugeMu.Unlock()
	if n != 0 {
		t.Fatalf("post-drain gauge must be zero: %d", n)
	}
}
