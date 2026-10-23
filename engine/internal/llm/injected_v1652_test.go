package llm

// injected_v1642_test.go — v1.65.2 THE LOUD INJECTION pins (PLAN-V165 §2).
//
// THE USER'S LAW: the system must never inject a prompt silently — every
// injection renders (the injected chunk → the hiccup box's new state →
// the transcript + the exports) and the texts are DYNAMIC (the proceed
// carries the announcement's tail; the anti-simplification order carries
// the call VERBATIM).

import (
        "context"
        "net/http"
        "net/http/httptest"
        "strings"
	"time"
        "sync/atomic"
        "testing"
)

// TestV1652_RetryDirectiveFor_VerbatimLaw — the anti-simplification order
// carries the call VERBATIM ("add the tool it did verbatim back to it"),
// clamps honestly at 480 bytes, and keeps the const order as its tail.
func TestV1652_RetryDirectiveFor_VerbatimLaw(t *testing.T) {
        got := RetryDirectiveFor("termux", `{"action":"exec","args":{"command":"cal 10 2026"}}`)
        if !strings.Contains(got, "verbatim, as you sent it: termux {\"action\":\"exec\"") {
                t.Errorf("the verbatim call is missing: %q", got)
        }
        if !strings.Contains(got, "cal 10 2026") {
                t.Errorf("the call's own content is missing: %q", got)
        }
        if !strings.Contains(got, RetrySameCallDirective) {
                t.Errorf("the anti-simplification order tail is missing: %q", got)
        }
        // the clamp: a 50KB truncated call must not flood the observation
        big := RetryDirectiveFor("workspace", `{"action":"put","content":"`+strings.Repeat("x", 50000)+`"}`)
        if len(big) > 700 {
                t.Errorf("the verbatim echo must clamp at ~480 bytes, got %d", len(big))
        }
        if !strings.Contains(big, "…[your full call rides this conversation]") {
                t.Errorf("the honest clamp marker is missing: %q", big[len(big)-120:])
        }
        // the empty fallback: the bare const order
        if got := RetryDirectiveFor("", ""); got != RetrySameCallDirective {
                t.Errorf("empty call should answer the bare order, got %q", got)
        }
}

// TestV1652_ProceedInjectionText_DynamicTail — the proceed nudge carries the
// announcement's TAIL for context ("proceed and print the tail of the
// message for context"); a bare announcement answers the generic-simple
// arm.
func TestV1652_ProceedInjectionText_DynamicTail(t *testing.T) {
        ann := "I will now read the three timer regions in chatpanel.js, patch the scheduleUpdate guard, then verify the walk."
        got := ProceedInjectionText(ann)
        if !strings.Contains(got, "proceed") || !strings.Contains(got, "execute the plan you just announced") {
                t.Errorf("the proceed order is missing: %q", got)
        }
        if !strings.Contains(got, "for context: \"") {
                t.Errorf("the context arm is missing: %q", got)
        }
        if !strings.Contains(got, "verify the walk.") {
                t.Errorf("the announcement's tail is missing: %q", got)
        }
        // a HUGE announcement: only the tail ~220 rides
        huge := ProceedInjectionText(strings.Repeat("word ", 4000))
        if len(huge) > 420 {
                t.Errorf("the tail clamp failed: %d", len(huge))
        }
        // the empty announcement: the generic-simple arm
        if got := ProceedInjectionText(""); got != "(proceed — execute the announced plan with your tools now)" {
                t.Errorf("empty announcement should answer the generic order, got %q", got)
        }
}

// TestV1652_EmitInjected_Chunk — the law speaks ChatChunk{Type:"injected"}
// with the exact prompt, never blocks, never speaks an empty text.
func TestV1652_EmitInjected_Chunk(t *testing.T) {
        ch := make(chan ChatChunk, 4)
        EmitInjected(ch, "(proceed — execute the announced plan with your tools now)")
        select {
        case ev := <-ch:
                if ev.Type != "injected" {
                        t.Errorf("type = %q, want injected", ev.Type)
                }
                if !strings.Contains(ev.Text, "proceed") {
                        t.Errorf("text = %q", ev.Text)
                }
        default:
                t.Fatal("the injected chunk never fired")
        }
        // empty text: silent (no noise rows)
        EmitInjected(ch, "   ")
        select {
        case ev := <-ch:
                t.Errorf("an empty injection spoke: %+v", ev)
        default:
        }
        // non-blocking: a full channel never stalls the turn
        full := make(chan ChatChunk, 1)
        full <- ChatChunk{Type: "progress"}
        done := make(chan struct{})
        go func() {
                EmitInjected(full, "must not block")
                close(done)
        }()
        select {
        case <-done:
        case <-time.After(2 * time.Second):
                t.Fatal("EmitInjected blocked on a full channel")
        }
}

// TestV1652_Proceed_LoudIntegration — the v1294 harness + the loud law:
// the proceed round must ALSO speak the injected chunk carrying the
// DYNAMIC text (the announcement's tail rides for context).
func TestV1652_Proceed_LoudIntegration(t *testing.T) {
        var calls int32
        srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
                n := atomic.AddInt32(&calls, 1)
                w.Header().Set("Content-Type", "text/event-stream")
                w.WriteHeader(200)
                fl := w.(http.Flusher)
                switch n {
                case 1:
                        for _, f := range []string{
                                `data: {"choices":[{"delta":{"content":"Let me check the timers first, then patch the guard region carefully."}}]}`,
                                `data: {"choices":[{"delta":{},"finish_reason":"stop"}]}`,
                        } {
                                _, _ = w.Write([]byte(f + "\n\n"))
                        }
                case 2:
                        // round 2 must PROVE the injection rode: the request body carries
                        // the dynamic proceed text with the announcement's tail.
                        var body strings.Builder
                        buf := make([]byte, 4096)
                        for {
                                nr, err := r.Body.Read(buf)
                                if nr > 0 {
                                        body.Write(buf[:nr])
                                }
                                if err != nil {
                                        break
                                }
                        }
                        if !strings.Contains(body.String(), "for context:") {
                                t.Errorf("the proceed round's request never carried the dynamic tail: %q", body.String())
                        }
                        for _, f := range []string{
                                `data: {"choices":[{"delta":{"content":"THE ANSWER after the loud proceed."}}]}`,
                                `data: {"choices":[{"delta":{},"finish_reason":"stop"}]}`,
                        } {
                                _, _ = w.Write([]byte(f + "\n\n"))
                        }
                default:
                        for _, f := range []string{
                                `data: {"choices":[{"delta":{"content":"unexpected round"}}]}`,
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
                        return "OBSERVATION:\nsearched"
                },
        }
        go func() {
                runNativeToolsTurn(context.Background(), ch, errs, req)
                close(ch)
                close(errs)
        }()
        var injectedText string
        var injectedCount int
        for ev := range ch {
                if ev.Type == "injected" {
                        injectedCount++
                        injectedText = ev.Text
                }
        }
        for e := range errs {
                if e != nil {
                        t.Fatalf("err: %v", e)
                }
        }
        if injectedCount != 1 {
                t.Fatalf("the proceed injection must speak EXACTLY ONE injected row, got %d", injectedCount)
        }
        if !strings.Contains(injectedText, "proceed") || !strings.Contains(injectedText, "for context:") {
                t.Errorf("the injected row does not carry the dynamic proceed text: %q", injectedText)
        }
        if !strings.Contains(injectedText, "guard region carefully.") {
                t.Errorf("the announcement's tail never rode the injection: %q", injectedText)
        }
}
