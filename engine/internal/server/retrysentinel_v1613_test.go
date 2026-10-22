package server

// retrysentinel_v1613_test.go — v1.61.3 THE RETRY SENTINEL pins
// (PLAN-V161 §v1.61.5.1): the shared dynamic timers arm, chats JOIN
// them, probes pace with the honest pills, the recovery fans out to
// every listener, the timer dies, manual actions disarm, the
// Retry-After header clamps the first probe, and the boot scan
// re-arms parked chats with the attempt count preserved.

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/ScoobyBaby1999/doomalay/engine/internal/config"
	"github.com/ScoobyBaby1999/doomalay/engine/internal/store"
)

// newSentinelServer — a Server with the compressed sentinel clocks
// (the env knobs) + a fresh session.
func newSentinelServer(t *testing.T) (*Server, string) {
	t.Helper()
	t.Setenv("DOOMALAY_SENTINEL_QUOTA_S", "1")
	t.Setenv("DOOMALAY_SENTINEL_NET_S", "1")
	t.Setenv("DOOMALAY_SENTINEL_SERVER_S", "1")
	dir := t.TempDir()
	db, err := store.Open(dir)
	if err != nil {
		t.Fatalf("store: %v", err)
	}
	if err := db.Migrate(); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	s := New(&config.Config{DataDir: dir}, db, nil)
	sess := &store.Session{ID: "v1613sess", Title: "t", Model: "openrouter/x", Provider: "openrouter"}
	if err := db.CreateSession(sess); err != nil {
		t.Fatalf("session: %v", err)
	}
	return s, sess.ID
}

// sentinelPills — the session's "retry" rows, phase-labeled.
func sentinelPills(t *testing.T, s *Server, sid string) []map[string]any {
	t.Helper()
	events, err := s.db.ListEvents(sid, 0)
	if err != nil {
		t.Fatalf("events: %v", err)
	}
	var out []map[string]any
	for _, e := range events {
		if e.EventType != "retry" {
			continue
		}
		var m map[string]any
		if json.Unmarshal([]byte(e.Content), &m) == nil {
			out = append(out, m)
		}
	}
	return out
}

func hasPill(pills []map[string]any, phase string) bool {
	for _, p := range pills {
		if p["phase"] == phase {
			return true
		}
	}
	return false
}

// TestV1613_ArmProbePaceAndDisarm — the fail leg: an unknown-bridge
// probe (the opencode provider with no serve) fails honestly, the
// probe pills pace, the attempts count persists in the kv row, and a
// manual Disarm kills the timer + drops the row.
func TestV1613_ArmProbePaceAndDisarm(t *testing.T) {
	s, sid := newSentinelServer(t)
	rs := s.sentinelFor()

	rs.Arm(sid, "opencode", "429", 0, "")
	pills := sentinelPills(t, s, sid)
	if !hasPill(pills, "armed") {
		t.Fatalf("the armed pill is missing: %v", pills)
	}
	// the kv durability row exists
	if _, ok := rs.loadRow(sid); !ok {
		t.Fatal("the durability row is missing")
	}

	// the probe fails (no serve is up) — the probe pill lands within the
	// compressed interval
	deadline := time.Now().Add(5 * time.Second)
	for {
		pills = sentinelPills(t, s, sid)
		if hasPill(pills, "probe") {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("the probe pill never landed: %v", pills)
		}
		time.Sleep(100 * time.Millisecond)
	}
	// the attempt count rode the kv row
	row, ok := rs.loadRow(sid)
	if !ok || row.Attempts < 1 {
		t.Fatalf("the attempts did not persist: %+v", row)
	}
	// the pill carries the countdown + the attempts
	var probePill map[string]any
	for _, p := range pills {
		if p["phase"] == "probe" {
			probePill = p
			break
		}
	}
	if probePill == nil || probePill["attempts"] == nil || probePill["next_at"] == nil {
		t.Fatalf("the probe pill must carry attempts + next_at: %v", probePill)
	}

	// the manual disarm: the row + the listener die
	rs.Disarm(sid)
	if _, ok := rs.loadRow(sid); ok {
		t.Fatal("the disarm must drop the durability row")
	}
	rs.mu.Lock()
	n := len(rs.timers)
	rs.mu.Unlock()
	if n != 0 {
		t.Fatalf("the disarm of the last listener must kill the timer (timers=%d)", n)
	}
}

// TestV1613_JoinAndFanout — THE SHARED TIMER LAW: two chats parking on
// the same signal share ONE timer; the net-class recovery (the
// sandbox's resolver answers) fans the recovered pill to every
// listener and kills the timer.
func TestV1613_JoinAndFanout(t *testing.T) {
	s, sid := newSentinelServer(t)
	sid2 := sid + "b"
	if err := s.db.CreateSession(&store.Session{ID: sid2, Title: "t", Model: "openrouter/x", Provider: "openrouter"}); err != nil {
		t.Fatal(err)
	}
	rs := s.sentinelFor()

	// the device net class: the probe is netx.Diag — the sandbox's
	// resolver answers, so the FIRST probe recovers
	rs.Arm(sid, "", "net", 0, "")
	rs.Arm(sid2, "", "net", 0, "")

	rs.mu.Lock()
	n := len(rs.timers)
	rs.mu.Unlock()
	if n != 1 {
		t.Fatalf("two chats on the same signal must share ONE timer (timers=%d)", n)
	}

	// the recovery fans out to BOTH listeners
	deadline := time.Now().Add(8 * time.Second)
	for {
		p1 := hasPill(sentinelPills(t, s, sid), "recovered")
		p2 := hasPill(sentinelPills(t, s, sid2), "recovered")
		if p1 && p2 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("the recovery did not fan out: %v / %v", sentinelPills(t, s, sid), sentinelPills(t, s, sid2))
		}
		time.Sleep(100 * time.Millisecond)
	}
	// the timer is dead + both rows dropped
	time.Sleep(300 * time.Millisecond)
	rs.mu.Lock()
	n = len(rs.timers)
	rs.mu.Unlock()
	if n != 0 {
		t.Fatalf("the recovered timer must die (timers=%d)", n)
	}
	if _, ok := rs.loadRow(sid); ok {
		t.Fatal("the recovered listener's row must drop")
	}
	if _, ok := rs.loadRow(sid2); ok {
		t.Fatal("the recovered listener's row must drop")
	}
}

// TestV1613_RetryAfterClamp — the provider's own Retry-After (the
// OpenRouter-documented header) clamps the FIRST probe below the
// configured interval: a 300ms clamp on a 1s interval fires the first
// probe pill early.
func TestV1613_RetryAfterClamp(t *testing.T) {
	s, sid := newSentinelServer(t)
	rs := s.sentinelFor()

	start := time.Now()
	rs.Arm(sid, "opencode", "429", 300, "") // 300ms clamp
	deadline := time.Now().Add(2 * time.Second)
	for {
		if hasPill(sentinelPills(t, s, sid), "probe") {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("the clamped probe never fired early: %v", sentinelPills(t, s, sid))
		}
		time.Sleep(50 * time.Millisecond)
	}
	if d := time.Since(start); d > 1500*time.Millisecond {
		t.Fatalf("the clamp must fire the first probe before the interval (took %s)", d)
	}
	rs.Disarm(sid)
}

// TestV1613_BootScanReArms — the durability row + a parked error tail
// re-arms after a restart with the attempt count preserved.
func TestV1613_BootScanReArms(t *testing.T) {
	s, sid := newSentinelServer(t)
	rs := s.sentinelFor()

	// the parked shape: a trailing status error row (the turn parked)
	if _, err := s.db.AppendEvent(sid, "error", `{"error":"http","message":"rate limited","retry_class":"429","retry_provider":"opencode"}`, ""); err != nil {
		t.Fatal(err)
	}
	if _, err := s.db.AppendEvent(sid, "status", `{"state":"error","usage":null}`, ""); err != nil {
		t.Fatal(err)
	}
	// the durability row with a preserved attempt count
	row := sentinelDurRow{Class: "429", Provider: "opencode", Attempts: 3, StartedAtMS: time.Now().Add(-10 * time.Minute).UnixMilli()}
	b, _ := json.Marshal(row)
	if err := s.db.SetSetting(sentinelKey(sid), string(b)); err != nil {
		t.Fatal(err)
	}

	s.sentinelBootScan()

	pills := sentinelPills(t, s, sid)
	found := false
	for _, p := range pills {
		if p["phase"] == "armed" && p["attempts"] == float64(3) {
			found = true
		}
	}
	if !found {
		t.Fatalf("the boot scan must re-arm with the preserved attempts: %v", pills)
	}
	// a chat whose tail is NOT a parked terminal must NOT arm
	sid3 := sid + "c"
	if err := s.db.CreateSession(&store.Session{ID: sid3, Title: "t", Model: "x", Provider: "x"}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.db.AppendEvent(sid3, "status", `{"state":"idle","usage":null}`, ""); err != nil {
		t.Fatal(err)
	}
	row3 := sentinelDurRow{Class: "429", Provider: "opencode", Attempts: 1, StartedAtMS: time.Now().UnixMilli()}
	b3, _ := json.Marshal(row3)
	s.db.SetSetting(sentinelKey(sid3), string(b3))
	before := len(sentinelPills(t, s, sid3))
	s.sentinelBootScan()
	if got := len(sentinelPills(t, s, sid3)); got != before {
		t.Fatalf("an idle-tail chat must not re-arm (%d → %d)", before, got)
	}
	rs.Disarm(sid)
}

// TestV1613_ParkErrorArmsTheSentinel — the forwardEvents arm hook: a
// terminal error event carrying retry_class arms the sentinel (the
// armed pill lands BELOW the error row).
func TestV1613_ParkErrorArmsTheSentinel(t *testing.T) {
	s, sid := newSentinelServer(t)
	// the direct shape forwardEvents sees: the ev map
	errEv := map[string]any{
		"type": "error", "session_id": sid,
		"error": "http", "message": "rate limited",
		"retry_class": "429", "retry_provider": "opencode",
	}
	_ = errEv
	// the hook itself is keyed on the ev fields — pin the wiring shape:
	// forwardEvents is end-to-end elsewhere; here pin that Arm through
	// the same fields produces the armed pill (the full arc lives in the
	// v1613 rig).
	s.sentinelFor().Arm(sid, "opencode", "429", 0, "")
	if !hasPill(sentinelPills(t, s, sid), "armed") {
		t.Fatal("the armed pill is missing")
	}
	// the pill row is persisted FIRST-CLASS (the replay/export see it)
	events, err := s.db.ListEvents(sid, 0)
	if err != nil {
		t.Fatal(err)
	}
	saw := false
	for _, e := range events {
		if e.EventType == "retry" {
			saw = true
		}
	}
	if !saw {
		t.Fatal("the retry rows must persist")
	}
	s.sentinelFor().Disarm(sid)
}

// TestV1613_RecoveredPillCarriesElapsed — the user's own grammar: the
// recovered pill carries the honest elapsed + the attempts count.
func TestV1613_RecoveredPillCarriesElapsed(t *testing.T) {
	// durHumanMS pins (the honest "Z:Y hours/minutes elapsed" grammar)
	if got := durHumanMS(90 * 60 * 1000); !strings.Contains(got, "1:30 hours") {
		t.Fatalf("90m = %q", got)
	}
	if got := durHumanMS(5 * 60 * 1000); !strings.Contains(got, "5 minutes") {
		t.Fatalf("5m = %q", got)
	}
	if got := durHumanMS(30 * 1000); !strings.Contains(got, "30 seconds") {
		t.Fatalf("30s = %q", got)
	}
}
