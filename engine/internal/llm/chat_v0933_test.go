package llm

// chat_v0933_test.go — THE TOOL-CHAIN FLOW WAVE pins.
//
// The user's report this wave answers: "When tools are chained. Final output
// text seems to generate until the next chain of reasoning and actions
// starts, then it dissapears as if it wasn't there… the final reply does
// stream but streams in the wrong location… It should flow like a chat —
// many responses that remain in the position they should be and stream with
// the conversation."
//
// Root cause (both paths):
//   · ACTION path — the preamble hold either swallowed the narration whole
//     or flushed it as "final" and then assistant_reset WIPED it when the
//     ACTION parsed (the vanish).
//   · Native path — the prose streamed raw into one open bubble that the
//     tool pills then dragged downward; the final answer appended to the
//     SAME bubble (the wrong location).
//
// The fix: ROUND SEGMENTS. The narration before a tool call emits as its
// own assistant_delta block finalized by a round_end chunk; the UI closes
// the block so the next round opens a NEW bubble.assistant_reset is retired
// for the leak case (the text STAYS).

import (
        "context"
        "net/http"
        "net/http/httptest"
        "strings"
        "testing"
        "time"
)

// TestV933_ActionPathRoundSegments — a ReAct round that narrates then calls
// a tool: the narration EMITS, a round_end closes the segment, the ACTION
// line itself never shows.
func TestV933_ActionPathRoundSegments(t *testing.T) {
        srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
                w.Header().Set("Content-Type", "text/event-stream")
                w.WriteHeader(200)
                fl := w.(http.Flusher)
                _, _ = w.Write([]byte("data: {\"choices\":[{\"delta\":{\"content\":\"Let me check the time first.\\n\"}}]}\n\n"))
                _, _ = w.Write([]byte("data: {\"choices\":[{\"delta\":{\"content\":\"ACTION: time_now {\\\"tz\\\":\\\"UTC\\\"}\\n\"}}]}\n\n"))
                _, _ = w.Write([]byte("data: [DONE]\n\n"))
                fl.Flush()
        }))
        defer srv.Close()

        ch := make(chan ChatChunk, 64)
        req := ChatRequest{
                // privatemodeai rides the ACTION protocol (not native tools) — the
                // user's exact provider for the vanish report.
                Model: "privatemodeai/glm-latest", Provider: "privatemodeai",
                BaseURL: srv.URL, Messages: []Message{{Role: "user", Content: "what time is it"}},
        }
        answer, _, _, _, err := runReActRoundStream(context.Background(), req, ch)
        close(ch)
        if err != nil {
                t.Fatalf("err: %v", err)
        }
        var deltas []string
        var roundEnds, resets int
        for c := range ch {
                switch c.Type {
                case "assistant_delta":
                        deltas = append(deltas, c.Text)
                case "round_end":
                        roundEnds++
                case "assistant_reset":
                        resets++
                }
        }
        joined := strings.Join(deltas, "")
        if !strings.Contains(joined, "Let me check the time first.") {
                t.Fatalf("the narration must STAY visible, got deltas=%q", joined)
        }
        if strings.Contains(joined, "ACTION:") {
                t.Fatalf("the ACTION line itself must stay hidden, got %q", joined)
        }
        if roundEnds != 1 {
                t.Fatalf("exactly one round_end expected (got %d)", roundEnds)
        }
        if resets != 0 {
                t.Fatalf("assistant_reset is retired for this case (got %d)", resets)
        }
        if !strings.Contains(answer, "ACTION: time_now") {
                t.Fatalf("the protocol answer must still carry the ACTION for parseAction, got %q", answer)
        }
}

// TestV933_LongPreambleLeakKeepsText — the >700B bound flushes the preamble
// as if final and the ACTION parses later: the OLD flow wiped everything
// (assistant_reset). The text STAYS now (round_end finalizes the block).
func TestV933_LongPreambleLeakKeepsText(t *testing.T) {
        long := strings.Repeat("I am narrating my plan in a very long preamble. ", 20) // >700B
        srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
                w.Header().Set("Content-Type", "text/event-stream")
                w.WriteHeader(200)
                fl := w.(http.Flusher)
                _, _ = w.Write([]byte("data: {\"choices\":[{\"delta\":{\"content\":\"" + long + "\\n\"}}]}\n\n"))
                _, _ = w.Write([]byte("data: {\"choices\":[{\"delta\":{\"content\":\"ACTION: time_now {}\\n\"}}]}\n\n"))
                _, _ = w.Write([]byte("data: [DONE]\n\n"))
                fl.Flush()
        }))
        defer srv.Close()

        ch := make(chan ChatChunk, 64)
        req := ChatRequest{
                Model: "privatemodeai/glm-latest", Provider: "privatemodeai",
                BaseURL: srv.URL, Messages: []Message{{Role: "user", Content: "go"}},
        }
        _, _, _, _, err := runReActRoundStream(context.Background(), req, ch)
        close(ch)
        if err != nil {
                t.Fatalf("err: %v", err)
        }
        var text strings.Builder
        var resets int
        for c := range ch {
                if c.Type == "assistant_delta" {
                        text.WriteString(c.Text)
                }
                if c.Type == "assistant_reset" {
                        resets++
                }
        }
        if !strings.Contains(text.String(), "narrating my plan") {
                t.Fatalf("the flushed preamble must SURVIVE the late ACTION (the vanish bug), got %q", text.String()[:80])
        }
        if resets != 0 {
                t.Fatalf("no wipe — the leak backstop now finalizes (got %d resets)", resets)
        }
}

// TestV933_NativePathRoundEnd — the native tool_calls path: a round with
// prose + calls emits round_end BEFORE the tool pills, so the UI closes the
// prose block (the mistral "no output text, just chained tools" + the
// wrong-location final answer).
func TestV933_NativePathRoundEnd(t *testing.T) {
        reqCount := 0
        srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
                reqCount++
                w.Header().Set("Content-Type", "text/event-stream")
                w.WriteHeader(200)
                fl := w.(http.Flusher)
                if reqCount == 1 {
                        // round 1: prose + a calculator call
                        _, _ = w.Write([]byte(`data: {"choices":[{"delta":{"content":"Let me compute that."}}]}` + "\n\n"))
                        _, _ = w.Write([]byte(`data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","type":"function","function":{"name":"calculator","arguments":"{\"expr\":\"17*23\"}"}}]}}]}` + "\n\n"))
                        _, _ = w.Write([]byte(`data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}` + "\n\n"))
                } else {
                        // round 2 (after the tool result): the final answer
                        _, _ = w.Write([]byte(`data: {"choices":[{"delta":{"content":"17 × 23 = 391."}}]}` + "\n\n"))
                        _, _ = w.Write([]byte(`data: {"choices":[{"delta":{},"finish_reason":"stop"}]}` + "\n\n"))
                }
                _, _ = w.Write([]byte("data: [DONE]\n\n"))
                fl.Flush()
        }))
        defer srv.Close()

        req := ChatRequest{
                Model: "mistral/codestral-latest", Provider: "mistral",
                BaseURL: srv.URL, Messages: []Message{{Role: "user", Content: "17*23?"}},
        }
        ch, errs := Chat(context.Background(), req)
        var order []string // the WIRE ORDER is the assertion target
        deadline := time.After(15 * time.Second)
collect:
        for {
                select {
                case c, ok := <-ch:
                        if !ok {
                                break collect
                        }
                        switch c.Type {
                        case "assistant_delta":
                                order = append(order, "Δ:"+clip(c.Text, 14))
                        case "round_end":
                                order = append(order, "ROUND_END")
                        case "tool_use":
                                order = append(order, "TOOL:"+c.Name)
                        case "tool_result":
                                order = append(order, "RESULT")
                        case "status":
                                if c.State == "error" {
                                        t.Fatalf("unexpected error status: %+v", c)
                                }
                        }
                case e, ok := <-errs:
                        if ok && e != nil {
                                t.Fatalf("errs: %v", e)
                        }
                case <-deadline:
                        t.Fatal("timeout")
                }
        }
        joined := strings.Join(order, " | ")
        // the flow: prose Δ → ROUND_END → TOOL → RESULT → final Δ (a NEW block)
        if !strings.Contains(joined, "Δ:Let me compute") || !strings.Contains(joined, "ROUND_END | TOOL:calculator") {
                t.Fatalf("the prose must close its block BEFORE the tool pill. order=%s", joined)
        }
        if !strings.Contains(joined, "RESULT | Δ:17 × 23") {
                t.Fatalf("the final answer must stream AFTER the tool result (its own block). order=%s", joined)
        }
        if strings.Count(joined, "ROUND_END") != 1 {
                t.Fatalf("exactly one round_end (the final round has no calls). order=%s", joined)
        }
}

func clip(s string, n int) string {
        if len(s) > n {
                return s[:n]
        }
        return s
}
