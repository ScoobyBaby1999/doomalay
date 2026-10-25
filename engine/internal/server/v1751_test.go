package server

// v1751_test.go — v1.75.1 THE SINGLE VOICE + THE RESTORED CLOCK (the
// trippy transcript conviction), the server-side source pins.
//
// The UNBOUNDED LANES rewrite (v1.74) doubled every bus tool_result
// (busExecute + the nativetools caller) AND amputated the v1.73.3 honest
// clock on the native path (the ChatChunk.DurationMS field, the converter's
// top-level lift, and the persisted-replay lift all vanished). This pin
// guards the restored laws at their source:
//   - nativetools' caller-side emission is DEAD (the single voice lives in
//     busExecute);
//   - the converter lifts chunk.DurationMS onto every tool_result event;
//   - the persist folds duration_ms INSIDE the replayed tool_result JSON.

import (
	"strings"
	"testing"
)

func TestV1751_TheSingleVoiceAndTheClock(t *testing.T) {
	native := srcOf(t, "../llm/nativetools.go")
	if strings.Contains(native, "// v1.13.2 THE HANDOFF: emit tool_result for the UI") {
		t.Fatalf("THE SINGLE VOICE broken: the nativetools caller still emits its own tool_result — every bus result rides the chat twice (the trippy conviction)")
	}
	if !strings.Contains(native, "v1.75.1 THE SINGLE VOICE") {
		t.Fatalf("the nativetools call site must teach the single-voice law (the comment is the pin)")
	}

	chat := srcOf(t, "chat.go")
	if !strings.Contains(chat, `ev["duration_ms"] = chunk.DurationMS`) {
		t.Fatalf("THE HONEST CLOCK broken: the converter no longer lifts the per-call duration onto the live tool_result event (v1.73.3)")
	}
	if !strings.Contains(chat, `toolEv["duration_ms"] = v`) {
		t.Fatalf("THE HONEST CLOCK broken: the persist no longer folds duration_ms inside the replayed tool_result JSON (v1.73.3)")
	}

	bridge := srcOf(t, "../llm/mcpbridge.go")
	if !strings.Contains(bridge, `ch <- ChatChunk{Type: "tool_result", Text: res.Observation, Name: action, DurationMS: res.DurationMs}`) {
		t.Fatalf("the single voice in busExecute must carry the runner's honest duration")
	}
}
