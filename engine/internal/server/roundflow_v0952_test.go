package server

// v0.95.2 THE SEGMENTED FLOW WAVE — the brain-path round synthesizer pins.
//
// The live bug (the user's export): on multi-round tool turns the brain
// emits NO segment events — narration streamed before a tool call glommed
// into the previous round's still-open bubble at its old position high up
// the transcript ("the final response replaces the previous final response
// in the previous final response's location while it spams tools down the
// chatlog, having its final output remain all the way up top").
//
// synthesizeRounds wraps the brain stream with the v0.93.3 round contract:
// tool_use closes the open segment FIRST (assistant {round:true} +
// round_end), terminal status/error closes the final segment BEFORE the
// terminal ships.

import (
        "reflect"
        "testing"
        "time"
)

func v0952Feed(t *testing.T, evs []map[string]any) []map[string]any {
        t.Helper()
        in := make(chan map[string]any, len(evs))
        for _, e := range evs {
                in <- e
        }
        close(in)
        s := &Server{}
        out := s.synthesizeRounds("sess", in)
        var got []map[string]any
        for ev := range out {
                got = append(got, ev)
        }
        return got
}

func v0952Types(evs []map[string]any) []string {
        var out []string
        for _, e := range evs {
                t := e["type"].(string)
                if t == "assistant" {
                        if r, ok := e["round"].(bool); ok && r {
                                t = "assistant_round"
                        }
                }
                out = append(out, t)
        }
        return out
}

// THE CHAIN: narration → tool → result → final narration → idle must close
// every segment at its boundary (the user's exact scenario).
func TestV0952BrainRoundSynthesis(t *testing.T) {
        got := v0952Feed(t, []map[string]any{
                {"type": "status", "state": "running"},
                {"type": "assistant_delta", "text": "Let me run step 1."},
                {"type": "tool_use", "name": "calculator"},
                {"type": "tool_result", "name": "calculator", "text": "22"},
                {"type": "assistant_delta", "text": "The result is 22."},
                {"type": "status", "state": "idle"},
        })
        want := []string{
                "status", "assistant_delta",
                "assistant_round", "round_end", // ← the segment closed BEFORE the pill
                "tool_use", "tool_result",
                "assistant_delta", // the final narration streams…
                "assistant_round", // …and closes BEFORE idle
                "status",
        }
        if types := v0952Types(got); !reflect.DeepEqual(types, want) {
                t.Fatalf("wire order:\n got  %v\n want %v", types, want)
        }
        // The synthesized segments carry the accumulated text.
        if got[2]["text"] != "Let me run step 1." {
                t.Fatalf("segment 1 text: %v", got[2]["text"])
        }
        if got[7]["text"] != "The result is 22." {
                t.Fatalf("final segment text: %v", got[7]["text"])
        }
}

// NO-OP: a plain single-segment turn (no tools) synthesizes nothing before
// the terminal — the final segment closes, nothing else changes.
func TestV0952SingleSegmentTurn(t *testing.T) {
        got := v0952Feed(t, []map[string]any{
                {"type": "assistant_delta", "text": "Hello!"},
                {"type": "assistant_delta", "text": " Hi."},
                {"type": "status", "state": "idle"},
        })
        want := []string{"assistant_delta", "assistant_delta", "assistant_round", "status"}
        if types := v0952Types(got); !reflect.DeepEqual(types, want) {
                t.Fatalf("wire order:\n got  %v\n want %v", types, want)
        }
        if got[2]["text"] != "Hello! Hi." {
                t.Fatalf("segment text: %v", got[2]["text"])
        }
}

// NO-OP: a tool call with NO narration synthesizes nothing (no empty
// segments — the pill renders alone).
func TestV0952SilentToolCall(t *testing.T) {
        got := v0952Feed(t, []map[string]any{
                {"type": "tool_use", "name": "calculator"},
                {"type": "tool_result", "name": "calculator", "text": "22"},
                {"type": "assistant_delta", "text": "It is 22."},
                {"type": "status", "state": "idle"},
        })
        want := []string{"tool_use", "tool_result", "assistant_delta", "assistant_round", "status"}
        if types := v0952Types(got); !reflect.DeepEqual(types, want) {
                t.Fatalf("wire order:\n got  %v\n want %v", types, want)
        }
}

// The error boundary closes the open segment before the error ships (an
// aborted mid-segment turn leaves a complete block, not a dangling stream).
func TestV0952ErrorBoundaryClosesSegment(t *testing.T) {
        got := v0952Feed(t, []map[string]any{
                {"type": "assistant_delta", "text": "Working on it…"},
                {"type": "error", "message": "provider dropped"},
        })
        want := []string{"assistant_delta", "assistant_round", "error"}
        if types := v0952Types(got); !reflect.DeepEqual(types, want) {
                t.Fatalf("wire order:\n got  %v\n want %v", types, want)
        }
}

// Non-terminal status (running) is NOT a boundary.
func TestV0952RunningStatusNotBoundary(t *testing.T) {
        got := v0952Feed(t, []map[string]any{
                {"type": "status", "state": "running"},
                {"type": "assistant_delta", "text": "hi"},
                {"type": "status", "state": "idle"},
        })
        want := []string{"status", "assistant_delta", "assistant_round", "status"}
        if types := v0952Types(got); !reflect.DeepEqual(types, want) {
                t.Fatalf("wire order:\n got  %v\n want %v", types, want)
        }
}

// The channel closes cleanly on empty input (a dead brain stream must not
// hang the forwarder).
func TestV0952EmptyStream(t *testing.T) {
        done := make(chan []map[string]any, 1)
        go func() { done <- v0952Feed(t, nil) }()
        select {
        case got := <-done:
                if len(got) != 0 {
                        t.Fatalf("expected empty, got %v", got)
                }
        case <-time.After(2 * time.Second):
                t.Fatalf("synthesizeRounds hung on an empty stream")
        }
}
