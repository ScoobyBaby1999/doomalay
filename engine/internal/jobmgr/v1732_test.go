package jobmgr

// v1732 pins — v1.73.2 THE JOB LAYER (PLAN-V173 §v1.73.2): the lane
// lifecycle. THE USER'S ARCHITECTURE (verbatim): "Wouldn't it make more
// sense if that long tool call gets its own pid with its own allocated
// resources, goes on for however long and then returns when its done?
// … a model can try one tool call, do other methods, decide weather to
// kill the old pid tool call or not."
//
// The law (MCP Tasks, the researched spec shape): working →
// completed|failed|cancelled, terminal states NEVER transition. The kill
// is cooperative ("stopping doesn't guarantee the server stops" — Claude
// Code's own honesty). The settled ring delivers exactly once.

import (
        "encoding/json"
        "strings"
        "testing"
        "time"
)

// TestV1732_LaneLifecycle — Begin→Settle once; Status answers working
// (with the honest elapsed) then terminal (with the text + duration);
// the settled ring carries the job.
func TestV1732_LaneLifecycle(t *testing.T) {
        m := Default()
        j := m.Begin("v1732-life", "web_fetch", `{"url":"https://example.com"}`, func() {}, time.Now())
        if !strings.HasPrefix(j.ID, "j_") {
                t.Fatalf("the lane id is the j_ handle: %q", j.ID)
        }
        if j.State != StateWorking {
                t.Fatalf("a fresh lane is working: %q", j.State)
        }
        got, ok := m.Status(j.ID)
        if !ok || got.State != StateWorking || got.DurationMS < 0 {
                t.Fatalf("status answers working with the honest elapsed: %+v", got)
        }
        time.Sleep(5 * time.Millisecond)
        m.Settle(j.ID, StateCompleted, "the fetched page text")
        got, _ = m.Status(j.ID)
        if got.State != StateCompleted || got.Text != "the fetched page text" {
                t.Fatalf("status answers the terminal state + text: %+v", got)
        }
        if got.DurationMS < 5 {
                t.Fatalf("the terminal duration is the honest elapsed, got %dms", got.DurationMS)
        }
        ring := m.DrainSettled("v1732-life")
        if len(ring) != 1 || ring[0].ID != j.ID || ring[0].State != StateCompleted {
                t.Fatalf("the settled ring carries the lane: %+v", ring)
        }
        if again := m.DrainSettled("v1732-life"); len(again) != 0 {
                t.Fatalf("the ring delivers EXACTLY ONCE, got %d again", len(again))
        }
}

// TestV1732_NeverTransitionLaw — a cancelled lane STAYS cancelled even
// when the work runs to completion (MCP's Tasks law; the kill's honesty
// depends on it: "you will not hear from it again").
func TestV1732_NeverTransitionLaw(t *testing.T) {
        m := Default()
        j := m.Begin("v1732-never", "termux", `{}`, func() {}, time.Now())
        ok, wasWorking := m.Kill(j.ID)
        if !ok || !wasWorking {
                t.Fatalf("kill answers ok+wasWorking for a working lane")
        }
        got, _ := m.Status(j.ID)
        if got.State != StateCancelled {
                t.Fatalf("the killed lane is cancelled: %q", got.State)
        }
        if !strings.Contains(got.Text, "best-effort") {
                t.Fatalf("the kill text says the stop is best-effort: %q", got.Text)
        }
        // the late natural completion NEVER transitions the state
        m.Settle(j.ID, StateCompleted, "the work actually finished quietly")
        got, _ = m.Status(j.ID)
        if got.State != StateCancelled {
                t.Fatalf("THE NEVER-TRANSITION LAW: a cancelled lane stays cancelled, got %q", got.State)
        }
        // the kill's own settle rang ONCE (the cancelled delivery — the user
        // sees the stopped row); the late completion adds NOTHING: the second
        // drain is empty (the ring delivers exactly once).
        ring := m.DrainSettled("v1732-never")
        if len(ring) != 1 || ring[0].State != StateCancelled {
                t.Fatalf("the kill rings the cancelled delivery once: %+v", ring)
        }
        if again := m.DrainSettled("v1732-never"); len(again) != 0 {
                t.Fatalf("the late completion never re-rings: %+v", again)
        }
        // the capacity guard releases on kill (the lane is terminal)
        if m.AtCapacity("v1732-never") {
                t.Fatalf("the killed lane releases its capacity slot")
        }
}

// TestV1732_CapacityGuard — the 9th concurrent lane per chat refuses
// (the runaway guard); a settled lane frees its slot.
func TestV1732_CapacityGuard(t *testing.T) {
        m := Default()
        sess := "v1732-cap"
        var ids []string
        for i := 0; i < MaxPerSession; i++ {
                if m.AtCapacity(sess) {
                        t.Fatalf("capacity reached early at lane %d", i)
                }
                ids = append(ids, m.Begin(sess, "calculator", `{}`, func() {}, time.Now()).ID)
        }
        if !m.AtCapacity(sess) {
                t.Fatalf("the %dlane guard must refuse the next", MaxPerSession)
        }
        m.Settle(ids[0], StateCompleted, "done")
        if m.AtCapacity(sess) {
                t.Fatalf("a settled lane frees its slot")
        }
}

// TestV1732_SinkFiresOnce — the completion rail: Settle fires the event
// sink exactly once with the full JSON payload (the chat "job" row).
func TestV1732_SinkFiresOnce(t *testing.T) {
        m := Default()
        var got []string
        m.setSink(func(sessionID, content string) {
                if sessionID == "v1732-sink" {
                        got = append(got, content)
                }
        })
        t.Cleanup(func() { m.setSink(nil) })
        j := m.Begin("v1732-sink", "web_search", `{"query":"patient flow"}`, func() {}, time.Now())
        m.Settle(j.ID, StateFailed, "error: the search upstream refused")
        m.Settle(j.ID, StateCompleted, "a second settle never fires")
        if len(got) != 1 {
                t.Fatalf("the sink fires exactly once, got %d", len(got))
        }
        var payload map[string]any
        if err := json.Unmarshal([]byte(got[0]), &payload); err != nil {
                t.Fatalf("the sink payload is the job JSON: %v", err)
        }
        if payload["id"] != j.ID || payload["tool"] != "web_search" || payload["state"] != StateFailed {
                t.Fatalf("the payload carries id/tool/state: %+v", payload)
        }
        if _, has := payload["duration_ms"]; !has {
                t.Fatalf("the payload carries duration_ms")
        }
        if payload["session_id"] != "v1732-sink" {
                t.Fatalf("the payload carries the session: %+v", payload["session_id"])
        }
}

// TestV1732_TicketText — the researched three-part law: (1) the handle,
// (2) keep working, (3) do NOT poll + the job_status/job_kill handles.
func TestV1732_TicketText(t *testing.T) {
        j := &Job{ID: "j_deadbeef", Tool: "web_fetch"}
        txt := TicketText(j, 10*time.Second)
        for _, want := range []string{
                "JOB_STARTED", "j_deadbeef", "web_fetch",
                "Keep working", "do NOT need to poll",
                `job_status {"id":"j_deadbeef"}`, `job_kill {"id":"j_deadbeef"}`,
                "best-effort",
        } {
                if !strings.Contains(txt, want) {
                        t.Fatalf("the ticket must carry %q:\n%s", want, txt)
                }
        }
}

// TestV1732_SettledBlock — ONE shape on every surface: the verb per
// state (finished/FAILED/was stopped), the honest duration, the clamp.
func TestV1732_SettledBlock(t *testing.T) {
        jobs := []Job{
                {ID: "j_a", Tool: "web_fetch", State: StateCompleted, DurationMS: 12400, Text: "the page"},
                {ID: "j_b", Tool: "termux", State: StateFailed, DurationMS: 400, Text: "error: refused"},
                {ID: "j_c", Tool: "calculator", State: StateCancelled, DurationMS: 100},
        }
        block := SettledBlock(jobs, 0)
        for _, want := range []string{
                "delivered automatically", "j_a (web_fetch) finished after 12.4s", "the page",
                "j_b (termux) FAILED after 0.4s", "error: refused",
                "j_c (calculator) was stopped after 0.1s",
        } {
                if !strings.Contains(block, want) {
                        t.Fatalf("the block must carry %q:\n%s", want, block)
                }
        }
        // the clamp is rune-safe
        long := strings.Repeat("é", 50)
        clamped := Job{ID: "j_d", Tool: "t", State: StateCompleted, DurationMS: 1, Text: long}.Line(10)
        if !strings.HasSuffix(clamped, "…(clamped)") || strings.Contains(clamped, strings.Repeat("é", 11)) {
                t.Fatalf("the clamp is rune-safe: %q", clamped)
        }
}

// TestV1732_GraceEnv — the window reads DOOMALAY_JOB_GRACE_MS; 0
// disables the layer (the control arm).
func TestV1732_GraceEnv(t *testing.T) {
        t.Setenv("DOOMALAY_JOB_GRACE_MS", "250")
        if g := Grace(); g != 250*time.Millisecond {
                t.Fatalf("the env window reads: %v", g)
        }
        t.Setenv("DOOMALAY_JOB_GRACE_MS", "0")
        if GraceEnabled() {
                t.Fatalf("0 disables the layer")
        }
        t.Setenv("DOOMALAY_JOB_GRACE_MS", "garbage")
        if g := Grace(); g != 10*time.Second {
                t.Fatalf("a garbage value falls back to the 10s default: %v", g)
        }
}
