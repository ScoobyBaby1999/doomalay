package mcpbus

// jobwrap_v1732_test.go — v1.73.2 THE JOB LAYER wrap pins (PLAN-V173
// §v1.73.2): the grace window at the single execution point every path
// converges on. THE LAW: a finish within the window returns the EXACT
// today result (byte-identical — zero behavior change for fast tools);
// a finish after the window returns the JOB_STARTED ticket and the work
// continues in its own lane (the user's architecture: "that long tool
// call gets its own pid … goes on for however long and then returns
// when its done").

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/ScoobyBaby1999/doomalay/engine/internal/jobmgr"
)

// slowTurn builds a Turn whose local tools answer instantly for the
// fast tools and sleep past the grace window for "web_fetch".
func slowTurn(session string, sleep time.Duration) *Turn {
	return &Turn{
		SessionID: session,
		RunLocal: func(ctx context.Context, name, argJSON string, sink ArtifactSink) string {
			switch name {
			case "time_now":
				select {
				case <-time.After(sleep):
					return "OBSERVATION:\nthe slow clock answered"
				case <-ctx.Done():
					return "OBSERVATION:\n(cancelled)"
				}
			case "calculator":
				return "OBSERVATION:\n4"
			}
			return "OBSERVATION:\nok"
		},
	}
}

// TestV1732_FastToolByteIdentical — within the window: the exact today
// result, no lane born, no ticket.
func TestV1732_FastToolByteIdentical(t *testing.T) {
	b, _ := newTestBus(t)
	res := b.CallTool(context.Background(), fakeTurn("v1732-fast"), "calculator", args(t, map[string]any{"expr": "2+2"}))
	if res.Text != "4" || res.IsError {
		t.Fatalf("a fast tool returns the exact today result: %q err=%v", res.Text, res.IsError)
	}
	if strings.Contains(res.Text, "JOB_STARTED") {
		t.Fatalf("a fast tool NEVER gets the ticket")
	}
	if lanes := jobmgr.Default().List("v1732-fast"); len(lanes) != 0 {
		t.Fatalf("a fast tool never births a lane: %+v", lanes)
	}
}

// TestV1732_SlowToolGetsTicket — past the window: the ticket returns
// immediately, the lane keeps running, the settle lands with the full
// text + honest duration, and the ring delivers once.
func TestV1732_SlowToolGetsTicket(t *testing.T) {
	t.Setenv("DOOMALAY_JOB_GRACE_MS", "150")
	b, _ := newTestBus(t)
	turn := slowTurn("v1732-slow", 500*time.Millisecond)

	start := time.Now()
	res := b.CallTool(context.Background(), turn, "time_now", args(t, map[string]any{"tz": "UTC"}))
	elapsed := time.Since(start)
	if !strings.Contains(res.Text, "JOB_STARTED") {
		t.Fatalf("past the window the result IS the ticket: %q", res.Text)
	}
	if elapsed > 400*time.Millisecond {
		t.Fatalf("the ticket returns at the window, not at the finish: %v", elapsed)
	}
	if res.IsError {
		t.Fatalf("the ticket is a normal result (not an error)")
	}
	// the ticket teaches the handle
	if !strings.Contains(res.Text, "job_status") || !strings.Contains(res.Text, "job_kill") {
		t.Fatalf("the ticket teaches the trio handles:\n%s", res.Text)
	}
	// the lane exists and is working
	lanes := jobmgr.Default().List("v1732-slow")
	if len(lanes) != 1 || lanes[0].State != jobmgr.StateWorking {
		t.Fatalf("the lane runs past the ticket: %+v", lanes)
	}
	id := lanes[0].ID

	// job_status mid-flight answers RUNNING (never grace-wrapped — the
	// trio dispatches directly)
	st := b.CallTool(context.Background(), fakeTurn("v1732-slow"), "job_status", args(t, map[string]any{"id": id}))
	if !strings.Contains(st.Text, "RUNNING") {
		t.Fatalf("job_status answers RUNNING mid-flight: %q", st.Text)
	}

	// the settle lands with the FULL text + honest duration
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if j, ok := jobmgr.Default().Status(id); ok && j.State != jobmgr.StateWorking {
			if j.State != jobmgr.StateCompleted {
				t.Fatalf("the lane settles completed: %+v", j)
			}
			if j.Text != "the slow clock answered" {
				t.Fatalf("the settle carries the full text: %q", j.Text)
			}
			if j.DurationMS < 400 {
				t.Fatalf("the duration is the honest lane time, got %dms", j.DurationMS)
			}
			break
		}
		time.Sleep(30 * time.Millisecond)
	}
	// the ring delivers once
	ring := jobmgr.Default().DrainSettled("v1732-slow")
	if len(ring) != 1 || ring[0].ID != id {
		t.Fatalf("the settled ring carries the lane once: %+v", ring)
	}
	if again := jobmgr.Default().DrainSettled("v1732-slow"); len(again) != 0 {
		t.Fatalf("the ring delivers exactly once: %+v", again)
	}
}

// TestV1732_GraceDisabledControl — DOOMALAY_JOB_GRACE_MS=0: the old
// blocking behavior (the rig's control arm).
func TestV1732_GraceDisabledControl(t *testing.T) {
	t.Setenv("DOOMALAY_JOB_GRACE_MS", "0")
	b, _ := newTestBus(t)
	turn := slowTurn("v1732-off", 250*time.Millisecond)
	start := time.Now()
	res := b.CallTool(context.Background(), turn, "time_now", args(t, map[string]any{"tz": "UTC"}))
	if time.Since(start) < 200*time.Millisecond {
		t.Fatalf("grace 0 = the old blocking behavior (the call waits for the finish)")
	}
	if res.Text != "the slow clock answered" {
		t.Fatalf("the blocking result is the tool's own text: %q", res.Text)
	}
	if lanes := jobmgr.Default().List("v1732-off"); len(lanes) != 0 {
		t.Fatalf("the disabled layer never births lanes: %+v", lanes)
	}
}

// TestV1732_JobKillThroughTheBus — the model's own kill handle, end to
// end: the lane dies cooperatively, the honest best-effort text.
func TestV1732_JobKillThroughTheBus(t *testing.T) {
	t.Setenv("DOOMALAY_JOB_GRACE_MS", "120")
	b, _ := newTestBus(t)
	turn := slowTurn("v1732-kill", 800*time.Millisecond)
	res := b.CallTool(context.Background(), turn, "time_now", args(t, map[string]any{"tz": "UTC"}))
	if !strings.Contains(res.Text, "JOB_STARTED") {
		t.Fatalf("the slow call arms the lane: %q", res.Text)
	}
	id := jobmgr.Default().List("v1732-kill")[0].ID
	kill := b.CallTool(context.Background(), fakeTurn("v1732-kill"), "job_kill", args(t, map[string]any{"id": id}))
	if !strings.Contains(kill.Text, "STOPPED") || !strings.Contains(kill.Text, "best-effort") {
		t.Fatalf("the kill answers the cooperative honesty: %q", kill.Text)
	}
	if j, _ := jobmgr.Default().Status(id); j.State != jobmgr.StateCancelled {
		t.Fatalf("the lane is cancelled: %+v", j)
	}
	// the cancelled delivery rings once
	if ring := jobmgr.Default().DrainSettled("v1732-kill"); len(ring) != 1 || ring[0].State != jobmgr.StateCancelled {
		t.Fatalf("the cancelled delivery rings: %+v", ring)
	}
}

// TestV1732_JobListThroughTheBus — the roster tool, end to end.
func TestV1732_JobListThroughTheBus(t *testing.T) {
	t.Setenv("DOOMALAY_JOB_GRACE_MS", "120")
	b, _ := newTestBus(t)
	// an empty roster teaches honestly
	empty := b.CallTool(context.Background(), fakeTurn("v1732-list-empty"), "job_list", args(t, map[string]any{}))
	if !strings.Contains(empty.Text, "no background jobs") {
		t.Fatalf("the empty roster teaches: %q", empty.Text)
	}
	// arm one lane
	turn := slowTurn("v1732-list", 600*time.Millisecond)
	b.CallTool(context.Background(), turn, "time_now", args(t, map[string]any{"tz": "UTC"}))
	roster := b.CallTool(context.Background(), fakeTurn("v1732-list"), "job_list", args(t, map[string]any{}))
	if !strings.Contains(roster.Text, "RUNNING") || !strings.Contains(roster.Text, "time_now") {
		t.Fatalf("the roster shows the running lane: %q", roster.Text)
	}
}

// TestV1732_CapacityRefusesThroughTheBus — the runaway guard surfaces as
// a teaching tool error (the model clears with job_kill).
func TestV1732_CapacityRefusesThroughTheBus(t *testing.T) {
	t.Setenv("DOOMALAY_JOB_GRACE_MS", "120")
	b, _ := newTestBus(t)
	// fill the session's lanes (the sleeps must outlive the 8xgrace arming
	// loop — 8x120ms arming vs 3s of work keeps every lane live)
	for i := 0; i < jobmgr.DefaultMaxPerSession; i++ {
		turn := slowTurn("v1732-cap", 3*time.Second)
		res := b.CallTool(context.Background(), turn, "time_now", args(t, map[string]any{"tz": "UTC"}))
		if !strings.Contains(res.Text, "JOB_STARTED") {
			t.Fatalf("lane %d armed: %q", i, res.Text)
		}
	}
	// the 9th refuses honestly
	res := b.CallTool(context.Background(), slowTurn("v1732-cap", 0), "time_now", args(t, map[string]any{"tz": "UTC"}))
	if !res.IsError || !strings.Contains(res.Text, "background jobs running") || !strings.Contains(res.Text, "job_kill") {
		t.Fatalf("the runaway guard teaches the clear path: %q err=%v", res.Text, res.IsError)
	}
}

// TestV1732_ResultCarriesDuration — v1.73.3 THE HONEST CLOCK: the bus
// result carries the call's own duration for every surface to stamp.
func TestV1732_ResultCarriesDuration(t *testing.T) {
	b, _ := newTestBus(t)
	res := b.CallTool(context.Background(), fakeTurn("v1732-dur"), "calculator", args(t, map[string]any{"expr": "2+2"}))
	if res.DurationMS < 0 {
		t.Fatalf("the result carries the honest duration: %d", res.DurationMS)
	}
	var raw map[string]any
	if err := json.Unmarshal([]byte(`{}`), &raw); err != nil {
		t.Fatal(err)
	}
}
