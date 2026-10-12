package llm

// proceed_v1294_test.go — v1.29.4 THE PROCEED + THE HONEST CLAMP
// (PLAN-V130 §4). The announcement-exit disease: a round that narrates
// intent with no tool calls ended the turn; the loop now appends the
// announcement + ONE mechanical proceed instruction and continues.

import (
        "context"
        "net/http"
        "net/http/httptest"
        "strings"
        "sync/atomic"
        "testing"
)

func TestV1294_ShouldProceed_Matrix(t *testing.T) {
        cases := []struct {
                name string
                in   string
                want bool
        }{
                {"the transcript's exact shape", "No more recon narration — executing for real now. Let me check the timers.", true},
                {"i will now", "I will now read the code regions I need to patch.", true},
                {"let me", "Let me start by pulling the actual code.", true},
                {"a real answer is not an announcement", "The timer fires every 500ms via setInterval; the render guard checks isOwner(state) before painting; the flush requires ownership and a settled replay window. In summary, the panel uses three timers: the open-flush poll (100ms), the activity watchdog (500ms), and the reconnect check (100ms tries).", false},
                {"empty", "", false},
                {"whitespace only", "   ", false},
        }
        for _, c := range cases {
                if got := shouldProceed(c.in); got != c.want {
                        t.Errorf("%s: shouldProceed(%q) = %v, want %v", c.name, c.in, got, c.want)
                }
        }
        if maxProceeds != 2 {
                t.Errorf("maxProceeds = %d, want 2 (the third announcement IS the answer)", maxProceeds)
        }
}

func TestV1294_ClampMarked(t *testing.T) {
        if got := ClampMarked("short", 100); got != "short" {
                t.Errorf("short text changed: %q", got)
        }
        long := strings.Repeat("x", 10000)
        got := ClampMarked(long, 24000)
        if len(got) != 10000 {
                t.Errorf("unclamped: %d", len(got))
        }
        got = ClampMarked(long, 6000)
        if !strings.Contains(got, "[truncated: first 6000 of 10000 bytes shown]") {
                t.Errorf("the honest marker is missing: %q", got[len(got)-80:])
        }
        if len(got) > 6100 {
                t.Errorf("clamp overshot: %d", len(got))
        }
}

// TestV1294_Proceed_Integration — round 1 ANNOUNCES the plan (prose, no
// calls): the loop must NOT end the turn — it appends the announcement +
// the proceed instruction and runs round 2, which calls the tool; round 3
// answers. The old behavior: the turn ended at round 1 (the announcement
// was the final answer).
func TestV1294_Proceed_Integration(t *testing.T) {
        var calls int32
        srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
                n := atomic.AddInt32(&calls, 1)
                w.Header().Set("Content-Type", "text/event-stream")
                w.WriteHeader(200)
                fl := w.(http.Flusher)
                switch n {
                case 1:
                        // the announcement: visible prose, zero tool calls — the
                        // Doobie transcript's "Let me read the code regions" shape
                        for _, f := range []string{
                                `data: {"choices":[{"delta":{"content":"Let me check the timers in chatpanel.js first, then I will patch the scheduleUpdate region."}}]}`,
                                `data: {"choices":[{"delta":{},"finish_reason":"stop"}]}`,
                        } {
                                _, _ = w.Write([]byte(f + "\n\n"))
                        }
                case 2:
                        // the proceed round: the model executes — a real tool call
                        for _, f := range []string{
                                `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"hublib","arguments":"{\"action\":\"search\",\"q\":\"timers\"}"}}]}}]}`,
                                `data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}`,
                        } {
                                _, _ = w.Write([]byte(f + "\n\n"))
                        }
                default:
                        // the final answer after the observation
                        for _, f := range []string{
                                `data: {"choices":[{"delta":{"content":"THE ANSWER: three timers, all guarded."}}]}`,
                                `data: {"choices":[{"delta":{},"finish_reason":"stop"}]}`,
                        } {
                                _, _ = w.Write([]byte(f + "\n\n"))
                        }
                }
                fl.Flush()
        }))
        defer srv.Close()

        ch := make(chan ChatChunk, 64)
        errs := make(chan error, 4)
        req := ChatRequest{
                Model:    "nvidia/nemotron-51b",
                Provider: "nvidia",
                BaseURL:  srv.URL,
                Messages: []Message{{Role: "user", Content: "patch the timers"}},
                // ONE armed tool — the proceed requires something to execute
                HublibToolFn: func(ctx context.Context, argJSON string) string {
                        return "OBSERVATION:\nthe hub library searched: timers → 3 results"
                },
        }
        go func() {
                runNativeToolsTurn(context.Background(), ch, errs, req)
                close(ch)
                close(errs)
        }()
        var got string
        var sawProceedProgress bool
        var sawToolResult bool
        for ev := range ch {
                if ev.Type == "assistant_delta" {
                        got += ev.Text
                }
                if ev.Type == "progress" && strings.Contains(ev.Text, "proceeding to execution") {
                        sawProceedProgress = true
                }
                if ev.Type == "tool_result" && strings.Contains(ev.Text, "3 results") {
                        sawToolResult = true
                }
        }
        for e := range errs {
                if e != nil {
                        t.Fatalf("err: %v", e)
                }
        }
        if n := atomic.LoadInt32(&calls); n != 3 {
                t.Fatalf("expected 3 rounds (announcement → proceed+call → answer), got %d", n)
        }
        if !sawProceedProgress {
                t.Fatalf("the proceed progress hint never fired")
        }
        if !sawToolResult {
                t.Fatalf("the tool never executed (the proceed round should call it)")
        }
        if !strings.Contains(got, "THE ANSWER") {
                t.Fatalf("the final answer should be the reply, got: %q", got)
        }
}

// TestV1294_Proceed_Bounded — three announcement rounds in a row: the
// proceed fires at most TWICE; the third announcement ends the turn (the
// no-infinite-narration law).
func TestV1294_Proceed_Bounded(t *testing.T) {
        var calls int32
        srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
                atomic.AddInt32(&calls, 1)
                w.Header().Set("Content-Type", "text/event-stream")
                w.WriteHeader(200)
                fl := w.(http.Flusher)
                for _, f := range []string{
                        `data: {"choices":[{"delta":{"content":"I will now begin the work. Let me start."}}]}`,
                        `data: {"choices":[{"delta":{},"finish_reason":"stop"}]}`,
                } {
                        _, _ = w.Write([]byte(f + "\n\n"))
                }
                fl.Flush()
        }))
        defer srv.Close()

        ch := make(chan ChatChunk, 64)
        errs := make(chan error, 4)
        req := ChatRequest{
                Model:    "nvidia/nemotron-51b",
                Provider: "nvidia",
                BaseURL:  srv.URL,
                Messages: []Message{{Role: "user", Content: "do it"}},
                HublibToolFn: func(ctx context.Context, argJSON string) string {
                        return "OBSERVATION:\nok"
                },
        }
        go func() {
                runNativeToolsTurn(context.Background(), ch, errs, req)
                close(ch)
                close(errs)
        }()
        var proceedHints int
        for ev := range ch {
                if ev.Type == "progress" && strings.Contains(ev.Text, "proceeding to execution") {
                        proceedHints++
                }
        }
        for e := range errs {
                if e != nil {
                        t.Fatalf("err: %v", e)
                }
        }
        if proceedHints != 2 {
                t.Fatalf("expected exactly 2 proceed rounds (the bound), got %d", proceedHints)
        }
        if n := atomic.LoadInt32(&calls); n != 3 {
                t.Fatalf("expected 3 rounds (announce → proceed → announce+proceed → the third ends), got %d", n)
        }
}

// TestV1294_Proceed_NoToolsNoNudge — tools DISABLED (ToolsDisabled: the
// provider/blacklist shape): the proceed must not fire (nothing to
// execute — the nudge would be noise); the announcement ends the turn
// as before. Note: ungated built-ins (web_search…) ride specs whenever
// tools are enabled at all, so "no tools" means ToolsDisabled here.
func TestV1294_Proceed_NoToolsNoNudge(t *testing.T) {
        var calls int32
        srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
                atomic.AddInt32(&calls, 1)
                w.Header().Set("Content-Type", "text/event-stream")
                w.WriteHeader(200)
                fl := w.(http.Flusher)
                for _, f := range []string{
                        `data: {"choices":[{"delta":{"content":"Let me check the files now."}}]}`,
                        `data: {"choices":[{"delta":{},"finish_reason":"stop"}]}`,
                } {
                        _, _ = w.Write([]byte(f + "\n\n"))
                }
                fl.Flush()
        }))
        defer srv.Close()

        ch := make(chan ChatChunk, 64)
        errs := make(chan error, 4)
        req := ChatRequest{
                Model:         "nvidia/nemotron-51b",
                Provider:      "nvidia",
                BaseURL:       srv.URL,
                Messages:      []Message{{Role: "user", Content: "hi"}},
                ToolsDisabled: true,
        }
        go func() {
                runNativeToolsTurn(context.Background(), ch, errs, req)
                close(ch)
                close(errs)
        }()
        var proceedHints int
        for ev := range ch {
                if ev.Type == "progress" && strings.Contains(ev.Text, "proceeding to execution") {
                        proceedHints++
                }
        }
        for e := range errs {
                if e != nil {
                        t.Fatalf("err: %v", e)
                }
        }
        if proceedHints != 0 {
                t.Fatalf("no tools armed — the proceed must stay silent, got %d", proceedHints)
        }
}
