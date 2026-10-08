package llm

import (
        "context"
        "io"
        "net/http"
        "net/http/httptest"
        "strings"
        "testing"
        "time"
)

// nativetools_v1136_test.go — v1.13.6 THE REDTEAM's engine-side regression
// pins (PLAN-V113 §6): the honesty line, execution side + THE THIRD CARRIER.
//
// THE BUG (found by the v1.13.6 red-team rig): when a tool_call's arguments
// arrived CUT OFF or malformed, the honesty branches emitted "The call was
// NOT executed. Re-send…" as the tool_result — and then the execution loop
// ran the SAME wire entry anyway (bus-coerced to "{}"), producing a SECOND
// contradictory role:"tool" message for one call_id. The model then saw
// both "not executed" and an execution result and could loop on the
// contradiction.
//
// THE FIX: wireToolCall carries Skip/SkipText — a skipped call's fault text
// IS the tool's answer. One call_id, one tool message, never executed.
//
// Contracts:
//  1. CUT OFF args → exactly one tool_use pill + one tool_result chunk with
//     the fault text; the round-2 wire carries exactly ONE role:"tool"
//     message; the tool NEVER executed (no observation, no result value).
//  2. Unrecoverable malformed args → same contract.
//  3. OpenRouter turns (WebSearch on, plugin-eligible model) run the TOOL
//     LOOP, never the one-round plugin path.
//
// TestV1136_OpenRouterRunsTheToolLoop pins THE THIRD CARRIER fix: an
// openrouter turn with WebSearch ON (the server's always-on default,
// sess.WebSearch || true) must run the MCP tool loop — NOT the one-round
// provider-plugin path. Under the old plugin-first routing these turns
// NEVER reached the bus (the rig's S12 finding: 5/5 openrouter sessions
// answered with zero tool pills).
func TestV1136_OpenRouterRunsTheToolLoop(t *testing.T) {
        var round1Body string
        n := 0
        srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
                body, _ := io.ReadAll(r.Body)
                n++
                w.Header().Set("Content-Type", "text/event-stream")
                w.WriteHeader(200)
                fl := w.(http.Flusher)
                if n == 1 {
                        round1Body = string(body)
                        _, _ = w.Write([]byte(`data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_or1","type":"function","function":{"name":"calculator","arguments":"{\"expr\":\"6*7\"}"}}]}}]}` + "\n\n"))
                        _, _ = w.Write([]byte(`data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}` + "\n\n"))
                } else {
                        _, _ = w.Write([]byte(`data: {"choices":[{"delta":{"content":"6*7 = 42 exactly"}}]}` + "\n\n"))
                        _, _ = w.Write([]byte(`data: {"choices":[{"delta":{},"finish_reason":"stop"}]}` + "\n\n"))
                }
                _, _ = w.Write([]byte("data: [DONE]\n\n"))
                fl.Flush()
        }))
        defer srv.Close()

        ch, errs := Chat(context.Background(), ChatRequest{
                Model:     "openrouter/meta-llama/llama-3.3-70b-instruct",
                Provider:  "openrouter",
                BaseURL:   srv.URL,
                WebSearch: true, // the server's always-on default — the trap the fix removes
                Messages:  []Message{{Role: "user", Content: "compute 6*7 with the calculator"}},
        })

        var sawUse, sawResult, sawAnswer, sawIdle bool
        var resultText, answerText string
        deadline := time.After(20 * time.Second)
collect:
        for {
                select {
                case c, ok := <-ch:
                        if !ok {
                                break collect
                        }
                        switch {
                        case c.Type == "tool_use" && c.Name == "calculator":
                                sawUse = true
                        case c.Type == "tool_result" && c.Name == "calculator":
                                sawResult = true
                                resultText = c.Text
                        case c.Type == "assistant_delta":
                                answerText += c.Text
                                sawAnswer = true
                        case c.Type == "status" && c.State == "idle":
                                sawIdle = true
                        case c.Type == "error":
                                t.Fatalf("unexpected error chunk: %+v", c)
                        }
                case e, ok := <-errs:
                        _ = ok
                        if e != nil {
                                t.Fatalf("unexpected error: %v", e)
                        }
                case <-deadline:
                        t.Fatal("turn never completed")
                }
        }

        if !sawUse || !sawResult || !sawAnswer || !sawIdle {
                t.Fatalf("openrouter must run the TOOL LOOP: use=%v result=%v answer=%v idle=%v", sawUse, sawResult, sawAnswer, sawIdle)
        }
        if !strings.Contains(resultText, "42") || !strings.Contains(answerText, "42") {
                t.Fatalf("the calculator result should flow through, got result=%q answer=%q", resultText, answerText)
        }
        // the loop arms the mcpbus manifest and NEVER the plugin fragment
        if !strings.Contains(round1Body, `"tools"`) {
                t.Fatalf("round 1 should carry the tools manifest, got %.300s", round1Body)
        }
        if strings.Contains(round1Body, `"plugins"`) {
                t.Fatalf("the plugin fragment must not ride the tool-loop request, got %.300s", round1Body)
        }
}

func TestV1136_MalformedArgsNotExecuted(t *testing.T) {
        // ── Scenario A: arguments CUT OFF mid-string (the token-cap class) ──
        t.Run("cut off", func(t *testing.T) {
                var round2Body string
                n := 0
                srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
                        body, _ := io.ReadAll(r.Body)
                        n++
                        w.Header().Set("Content-Type", "text/event-stream")
                        w.WriteHeader(200)
                        fl := w.(http.Flusher)
                        if n == 1 {
                                // round 1 — the model emits a call whose arguments are cut
                                // MID-STRING (the provider's output cap ate the tail).
                                _, _ = w.Write([]byte(`data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_cut","type":"function","function":{"name":"calculator","arguments":"{\"expr\":\"37*1"}}]}}]}` + "\n\n"))
                                _, _ = w.Write([]byte(`data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}` + "\n\n"))
                        } else {
                                round2Body = string(body)
                                _, _ = w.Write([]byte(`data: {"choices":[{"delta":{"content":"understood — the call never ran; I'll re-send it complete."}}]}` + "\n\n"))
                                _, _ = w.Write([]byte(`data: {"choices":[{"delta":{},"finish_reason":"stop"}]}` + "\n\n"))
                        }
                        _, _ = w.Write([]byte("data: [DONE]\n\n"))
                        fl.Flush()
                }))
                defer srv.Close()

                ch, errs := Chat(context.Background(), ChatRequest{
                        Model:    "together/meta-llama-4",
                        Provider: "together",
                        BaseURL:  srv.URL,
                        Messages: []Message{{Role: "user", Content: "compute 37*14 with the calculator"}},
                })

                var usePills, resultChunks int
                var resultText, answerText string
                var sawIdle bool
                deadline := time.After(20 * time.Second)
collect:
                for {
                        select {
                        case c, ok := <-ch:
                                if !ok {
                                        break collect
                                }
                                switch {
                                case c.Type == "tool_use" && c.Name == "calculator":
                                        usePills++
                                case c.Type == "tool_result" && c.Name == "calculator":
                                        resultChunks++
                                        resultText = c.Text
                                case c.Type == "assistant_delta":
                                        answerText += c.Text
                                case c.Type == "status" && c.State == "idle":
                                        sawIdle = true
                                case c.Type == "error":
                                        t.Fatalf("unexpected error chunk: %+v", c)
                                }
                        case e, ok := <-errs:
                                _ = ok
                                if e != nil {
                                        t.Fatalf("unexpected error: %v", e)
                                }
                        case <-deadline:
                                t.Fatal("turn never completed")
                        }
                }

                // ONE fault report, never a second execution-shaped result.
                if usePills != 1 || resultChunks != 1 {
                        t.Fatalf("cut-off: expected exactly 1 tool_use pill + 1 tool_result, got %d/%d", usePills, resultChunks)
                }
                if !strings.Contains(resultText, "CUT OFF") || !strings.Contains(resultText, "NOT executed") {
                        t.Fatalf("fault text should carry the honesty verdict, got %q", resultText)
                }
                // The wire round 2: exactly ONE role:"tool" entry — the fault text —
                // and NO execution result (no 518, no OBSERVATION) for call_cut.
                if round2Body == "" {
                        t.Fatal("round 2 never reached the provider — history stalled")
                }
                if n := strings.Count(round2Body, `"role":"tool"`); n != 1 {
                        t.Fatalf("round 2 must carry exactly ONE role:tool message (the fault text), got %d", n)
                }
                if !strings.Contains(round2Body, "CUT OFF") {
                        t.Fatalf("round 2's tool message should be the fault text, got %.400s", round2Body)
                }
                if strings.Contains(round2Body, "518") || strings.Contains(round2Body, "OBSERVATION") {
                        t.Fatalf("the skipped call must NEVER execute — round 2 shows an execution result: %.400s", round2Body)
                }
                if !sawIdle || !strings.Contains(answerText, "re-send") {
                        t.Fatalf("turn should complete with the model acknowledging the re-send ask: idle=%v answer=%q", sawIdle, answerText)
                }
        })

        // ── Scenario B: unrecoverable malformed arguments ──
        t.Run("malformed", func(t *testing.T) {
                var round2Body string
                n := 0
                srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
                        body, _ := io.ReadAll(r.Body)
                        n++
                        w.Header().Set("Content-Type", "text/event-stream")
                        w.WriteHeader(200)
                        fl := w.(http.Flusher)
                        if n == 1 {
                                // round 1 — arguments that are neither valid, cut, nor repairable.
                                _, _ = w.Write([]byte(`data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_bad","type":"function","function":{"name":"calculator","arguments":"{\"expr\": 37*14}"}}]}}]}` + "\n\n"))
                                _, _ = w.Write([]byte(`data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}` + "\n\n"))
                        } else {
                                round2Body = string(body)
                                _, _ = w.Write([]byte(`data: {"choices":[{"delta":{"content":"right — I'll re-emit the call properly."}}]}` + "\n\n"))
                                _, _ = w.Write([]byte(`data: {"choices":[{"delta":{},"finish_reason":"stop"}]}` + "\n\n"))
                        }
                        _, _ = w.Write([]byte("data: [DONE]\n\n"))
                        fl.Flush()
                }))
                defer srv.Close()

                ch, errs := Chat(context.Background(), ChatRequest{
                        Model:    "together/meta-llama-4",
                        Provider: "together",
                        BaseURL:  srv.URL,
                        Messages: []Message{{Role: "user", Content: "compute 37*14 with the calculator"}},
                })

                var usePills, resultChunks int
                var resultText string
                var sawIdle bool
                deadline := time.After(20 * time.Second)
collect:
                for {
                        select {
                        case c, ok := <-ch:
                                if !ok {
                                        break collect
                                }
                                switch {
                                case c.Type == "tool_use" && c.Name == "calculator":
                                        usePills++
                                case c.Type == "tool_result" && c.Name == "calculator":
                                        resultChunks++
                                        resultText = c.Text
                                case c.Type == "status" && c.State == "idle":
                                        sawIdle = true
                                case c.Type == "error":
                                        t.Fatalf("unexpected error chunk: %+v", c)
                                }
                        case e, ok := <-errs:
                                _ = ok
                                if e != nil {
                                        t.Fatalf("unexpected error: %v", e)
                                }
                        case <-deadline:
                                t.Fatal("turn never completed")
                        }
                }

                if usePills != 1 || resultChunks != 1 {
                        t.Fatalf("malformed: expected exactly 1 tool_use pill + 1 tool_result, got %d/%d", usePills, resultChunks)
                }
                if !strings.Contains(resultText, "malformed") {
                        t.Fatalf("fault text should name the malformed verdict, got %q", resultText)
                }
                if n := strings.Count(round2Body, `"role":"tool"`); n != 1 {
                        t.Fatalf("round 2 must carry exactly ONE role:tool message, got %d", n)
                }
                if strings.Contains(round2Body, "518") || strings.Contains(round2Body, "OBSERVATION") {
                        t.Fatalf("the skipped call must NEVER execute: %.400s", round2Body)
                }
                if !sawIdle {
                        t.Fatal("turn never went idle")
                }
        })
}
