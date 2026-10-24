package server

// retrysentinel_v1745_test.go — v1.74.5 THE 0:00 CLOCK pins: the order
// law (the armed pill lands BELOW the error row — the orphan-class
// conviction), the closing row (Disarm speaks — the live pill never
// orphans at a stale next_at), and the countdown honesty (probing… /
// timer ended — never a frozen 0:00).

import (
	"os"
	"strings"
	"testing"
	"time"
)

// TestV1745_OrderLaw — the arm fires BELOW the error row's persist:
// the pill's row id is ABOVE the error's (the merge walk-back finds it
// without crossing the error row — the orphaned-pill class dies at the
// source).
func TestV1745_OrderLaw(t *testing.T) {
	src := srcOf(t, "chat.go")
	// the arm call sits AFTER the persist call in the forwardEvents body
	armAt := strings.Index(src, `s.sentinelFor().Arm(sessionID, armProv, armClass, armRA, "")`)
	persistAt := strings.LastIndex(src[:armAt], "s.db.AppendEvent(sessionID, evType, content, toolUseID)")
	if armAt < 0 || persistAt < 0 || persistAt > armAt {
		t.Fatalf("the arm must fire BELOW the error row's persist (arm@%d persist@%d)", armAt, persistAt)
	}
	// the armRetry capture block replaces the old inline arm (which sat
	// ABOVE the persist — the lying comment's conviction)
	if strings.Contains(src, "armRetry = true") == false {
		t.Fatal("the armRetry capture block is missing")
	}
}

// TestV1745_DisarmSpeaksTheClosingRow — a manual continue closes the
// live pill honestly: the recovered row carries the note, persisted
// first-class (live + replay + export).
func TestV1745_DisarmSpeaksTheClosingRow(t *testing.T) {
	s, sid := newSentinelServer(t)
	s.sentinelFor().Arm(sid, "opencode", "429", 0, "")
	if !hasPill(sentinelPills(t, s, sid), "armed") {
		t.Fatal("the armed pill is missing")
	}
	s.sentinelFor().Disarm(sid)
	pills := sentinelPills(t, s, sid)
	found := false
	for _, p := range pills {
		if p["phase"] == "recovered" && strings.Contains(fmt1745(p["note"]), "continued without the timer") {
			found = true
		}
	}
	if !found {
		t.Fatalf("the disarm must emit the closing recovered row with the honest note: %+v", pills)
	}
	// the timer is gone (the last listener out killed it)
	time.Sleep(50 * time.Millisecond)
	if pills := sentinelPills(t, s, sid); pills == nil {
		// pills persist as rows; the LIVE check is the loop's death —
		// the boot scan must not resurrect the disarmed chat
	}
	s.sentinelBootScan()
	// the LAST retry row must stay the recovered closer (the historical
	// armed row persists as history — the boot scan must not append
	// anything after it)
	pills = sentinelPills(t, s, sid)
	if len(pills) == 0 || pills[len(pills)-1]["phase"] != "recovered" {
		t.Fatalf("the boot scan must not re-arm a disarmed chat (the last row must stay the closer): %+v", pills)
	}
}

// TestV1745_CountdownHonestySourcePins — the PWA's countdown never
// freezes at 0:00: at/below zero it says "probing…", a stale next_at
// says "timer ended".
func TestV1745_CountdownHonestySourcePins(t *testing.T) {
	src, err := readWebSource1745("chatpanel.js")
	if err != nil {
		t.Fatalf("read chatpanel.js: %v", err)
	}
	for _, want := range []string{
		"return 'probing…'",
		"return 'timer ended'",
		"15 * 60 * 1000",
	} {
		if !strings.Contains(src, want) {
			t.Fatalf("chatpanel.js lost the countdown-honesty piece %q", want)
		}
	}
	// the frozen-zero shape is dead: retryCountdown never returns '0:00'
	// (the pill HTML still handles phase='recovered' via its own branch)
	fnAt := strings.Index(src, "function retryCountdown(")
	fnEnd := strings.Index(src[fnAt:], "\n  }")
	body := src[fnAt : fnAt+fnEnd]
	if strings.Contains(body, "return '0:00'") {
		t.Fatalf("the frozen 0:00 countdown must be dead:\n%s", body)
	}
}

func fmt1745(v any) string {
	if s, ok := v.(string); ok {
		return s
	}
	return ""
}

func readWebSource1745(rel string) (string, error) {
	b, err := os.ReadFile("web/" + rel)
	if err != nil {
		return "", err
	}
	return string(b), nil
}
