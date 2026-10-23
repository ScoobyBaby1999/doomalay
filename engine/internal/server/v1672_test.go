package server

// v1672 pins — v1.67 THE PATIENT CANVAS's engine laws:
//   · the SSE mid-stream error frame branch exists + wraps 429 as the
//     sentinel class (THE LOUD 429's root: the frame used to die as an
//     empty shell — the live end-to-end pin is the rig's LEG C1);
//   · ocClosePendingPills closes every unresolved use honestly;
//   · the stall conviction's fail events carry the honest oc_stalled shape
//     and NEVER arm the auto-retry (a stalled command would only stall
//     again — the user taps);
//   · the wall-walk exhaustion arms the sentinel (retry_class rides);
//   · the 429 fail path prepends the visible arm line.

import (
        "os"
        "strings"
        "testing"
)

func srcOf(t *testing.T, name string) string {
        t.Helper()
        b, err := os.ReadFile(name)
        if err != nil {
                t.Fatalf("read %s: %v", name, err)
        }
        return string(b)
}

// TestV1672_SSEErrorFrameBranch — the mid-stream error frame
// (data:{"error":{"code":429,...}}) is parsed + classified (the source law;
// the LIVE end-to-end pin is the rig's LEG C1: the frame surfaced WITH
// retry_class → the sentinel armed → the pill showed).
func TestV1672_SSEErrorFrameBranch(t *testing.T) {
        src := srcOf(t, "../llm/chat.go")
        if !strings.Contains(src, "openAIStreamError") {
                t.Fatalf("the stream error frame must be a first-class shape")
        }
        if !strings.Contains(src, `chunk.Error != nil && chunk.Error.Message != ""`) {
                t.Fatalf("the frame branch must fire on the error payload")
        }
        if !strings.Contains(src, `wrapRetryable(fmt.Errorf("%s", raw), "429", req.Provider, 0)`) {
                t.Fatalf("the 429 frame must wrap as the sentinel class (the pill + auto-continue)")
        }
}

// TestV1672_ClosePendingPills — the zombie turn's orphaned pills close with
// the honest why, keyed by their own call IDs.
func TestV1672_ClosePendingPills(t *testing.T) {
        out := make(chan map[string]any, 8)
        toolNames := map[string]string{"call_1": "bash", "call_2": "read"}
        used := map[string]bool{"call_1": true, "call_2": true}
        results := map[string]bool{"call_2": true} // call_2 already closed
        ocClosePendingPills("chat", "opencode/m", toolNames, used, results, out, "the command never returned within 5 minute(s) — the turn was cancelled")
        close(out)
        var got []map[string]any
        for ev := range out {
                got = append(got, ev)
        }
        if len(got) != 1 {
                t.Fatalf("exactly the ONE unresolved pill closes (got %d events)", len(got))
        }
        ev := got[0]
        if ev["type"] != "tool_result" || ev["name"] != "bash" || ev["tool_use_id"] != "call_1" {
                t.Fatalf("the close rides the pill's own call id: %v", ev)
        }
        if !strings.Contains(ev["text"].(string), "never returned") {
                t.Fatalf("the close names the why: %v", ev["text"])
        }
}

// TestV1672_StallFailEvents — the stall conviction's fail pair carries the
// oc_stalled kind + the honest message and never arms the auto-retry.
func TestV1672_StallFailEvents(t *testing.T) {
        events := ocServeFailEvents("chat", "oc_stalled", "OpenCode: the turn stalled — no output for 5 minute(s). Try again", 0)
        if len(events) != 2 {
                t.Fatalf("the fail pair (error + terminal) — got %d", len(events))
        }
        if events[0]["error"] != "oc_stalled" {
                t.Fatalf("the kind must be oc_stalled: %v", events[0]["error"])
        }
        if events[1]["state"] != "error" {
                t.Fatalf("the terminal must be the error state: %v", events[1]["state"])
        }
        if _, has := events[0]["retry_class"]; has {
                t.Fatalf("a stall conviction never arms the auto-retry (the user taps; a stalled command would only stall again)")
        }
}

// TestV1672_WallWalledArmsSentinel — the wall-walk exhaustion terminal
// carries the sentinel's machine fields (the source law; the live pin is
// the rig's LEG C2).
func TestV1672_WallWalledArmsSentinel(t *testing.T) {
        src := srcOf(t, "ocserveturn.go")
        if !strings.Contains(src, `"oc_free_walled", "message": "OpenCode's free-tier windows are all full right now`) {
                t.Fatalf("the walled terminal text must live in the turn source")
        }
        if !strings.Contains(src, `"retry_class": "429", "retry_provider": "opencode"`) {
                t.Fatalf("the walled terminal must arm the sentinel (retry_class + provider ride the event)")
        }
}

// TestV1672_RateLimitFailEventsArm — ocServeFailEvents' 429 path carries
// the arm + the visible progress line (the "uninsightful wait" fix).
func TestV1672_RateLimitFailEventsArm(t *testing.T) {
        events := ocServeFailEvents("chat", "provider.error", "rate limit exceeded upstream", 429)
        if len(events) != 3 {
                t.Fatalf("the 429 path prepends the arm's progress line (3 events) — got %d", len(events))
        }
        if events[0]["type"] != "progress" {
                t.Fatalf("the FIRST event must be the visible arm line: %v", events[0]["type"])
        }
        if msg, _ := events[0]["message"].(string); !strings.Contains(msg, "auto-retry timer is armed") {
                t.Fatalf("the arm line names the timer: %v", events[0]["message"])
        }
        if events[1]["retry_class"] != "429" || events[1]["retry_provider"] != "opencode" {
                t.Fatalf("the error carries the sentinel fields: %v", events[1])
        }
}

// TestV1672_InterruptedIsTerminal — the serve's interrupted frame is a
// first-class terminal (the stall ceiling's interrupt + every serve-side
// stop end the turn honestly).
func TestV1672_InterruptedIsTerminal(t *testing.T) {
        src := srcOf(t, "../ocserve/ocserve.go")
        if !strings.Contains(src, `e.Type == "session.execution.interrupted"`) {
                t.Fatalf("the interrupted frame must be a terminal in IsTerminal")
        }
        turnSrc := srcOf(t, "ocserveturn.go")
        if !strings.Contains(turnSrc, `case "session.execution.interrupted":`) {
                t.Fatalf("the pump must own the interrupted terminal (the honest failure path)")
        }
        if !strings.Contains(turnSrc, "ocServeStallCeilingDur") {
                t.Fatalf("the stall ceiling must live in the turn source")
        }
        if !strings.Contains(turnSrc, "DOOMALAY_OC_STALL_CEILING_MS") {
                t.Fatalf("the ceiling must be env-rigged (DOOMALAY_OC_STALL_CEILING_MS)")
        }
}
