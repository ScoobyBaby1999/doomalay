package llm

// chat_v1141_test.go — v1.14.1 THE LEDGER: the spec-driven output floor on
// the wire, the finish_reason capture, and the 92% context guard.

import (
        "context"
        "encoding/json"
        "net/http"
        "net/http/httptest"
        "strings"
        "testing"
)

// captureServer returns an httptest SSE server that records every request
// body and answers with one content chunk + [DONE].
func captureServer(t *testing.T, bodies *[]string) *httptest.Server {
        t.Helper()
        return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
                buf := make([]byte, r.ContentLength)
                _, _ = r.Body.Read(buf)
                *bodies = append(*bodies, string(buf))
                w.Header().Set("Content-Type", "text/event-stream")
                w.WriteHeader(200)
                _, _ = w.Write([]byte(`data: {"choices":[{"delta":{"content":"ok"}}]}` + "\n\n"))
                _, _ = w.Write([]byte("data: [DONE]\n\n"))
        }))
}

// TestV1141_FloorUsesSpecOutput — the floor hook sends the MODEL's
// documented output cap (snapshot: 65536 for nemotron-3.5-lightning), not
// the flat 16384.
func TestV1141_FloorUsesSpecOutput(t *testing.T) {
        var bodies []string
        srv := captureServer(t, &bodies)
        defer srv.Close()

        ch := make(chan ChatChunk, 64)
        req := ChatRequest{
                Model: "nvidia/nvidia/nemotron-3.5-lightning", Provider: "nvidia",
                BaseURL: srv.URL, Messages: []Message{{Role: "user", Content: "write it"}},
        }
        if _, err := scanSSE(context.Background(), req, nil, ch, nil); err != nil {
                t.Fatalf("scanSSE: %v", err)
        }
        close(ch)
        if len(bodies) == 0 {
                t.Fatal("no request captured")
        }
        var body map[string]any
        if err := json.Unmarshal([]byte(bodies[0]), &body); err != nil {
                t.Fatalf("body: %v", err)
        }
        mt, ok := body["max_tokens"].(float64)
        if !ok {
                t.Fatalf("max_tokens missing from the wire body: %v", body["max_tokens"])
        }
        if int(mt) != 65536 {
                t.Fatalf("wire max_tokens = %d, want 65536 (the model's documented output cap)", int(mt))
        }
}

// TestV1141_FloorFallbackFlat — a snapshot-blind model keeps the flat
// provider floor (16384 for nvidia).
func TestV1141_FloorFallbackFlat(t *testing.T) {
        var bodies []string
        srv := captureServer(t, &bodies)
        defer srv.Close()

        ch := make(chan ChatChunk, 64)
        req := ChatRequest{
                Model: "nvidia/model-not-in-any-snapshot-xyz", Provider: "nvidia",
                BaseURL: srv.URL, Messages: []Message{{Role: "user", Content: "hi"}},
        }
        if _, err := scanSSE(context.Background(), req, nil, ch, nil); err != nil {
                t.Fatalf("scanSSE: %v", err)
        }
        close(ch)
        var body map[string]any
        _ = json.Unmarshal([]byte(bodies[0]), &body)
        if got := int(body["max_tokens"].(float64)); got != 16384 {
                t.Fatalf("wire max_tokens = %d, want 16384 (flat fallback)", got)
        }
}

// TestV1141_NoFloorWithoutProviderGate — hosts NOT in the floor table keep
// their server default (never cap a host that would have given more).
func TestV1141_NoFloorWithoutProviderGate(t *testing.T) {
        var bodies []string
        srv := captureServer(t, &bodies)
        defer srv.Close()

        ch := make(chan ChatChunk, 64)
        req := ChatRequest{
                Model: "openai/gpt-4o", Provider: "openrouter",
                BaseURL: srv.URL, Messages: []Message{{Role: "user", Content: "hi"}},
        }
        if _, err := scanSSE(context.Background(), req, nil, ch, nil); err != nil {
                t.Fatalf("scanSSE: %v", err)
        }
        close(ch)
        var body map[string]any
        _ = json.Unmarshal([]byte(bodies[0]), &body)
        if _, exists := body["max_tokens"]; exists {
                t.Fatalf("max_tokens must stay absent for ungated providers, got %v", body["max_tokens"])
        }
}

// TestV1141_FinishReasonCaptured — the terminal verdict rides the Usage,
// and the length class flags output_cut (plus the visible cap note).
func TestV1141_FinishReasonCaptured(t *testing.T) {
        srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
                w.Header().Set("Content-Type", "text/event-stream")
                w.WriteHeader(200)
                _, _ = w.Write([]byte(`data: {"choices":[{"delta":{"content":"partial answer"}}]}` + "\n\n"))
                _, _ = w.Write([]byte(`data: {"choices":[{"delta":{},"finish_reason":"length"}],"usage":{"prompt_tokens":10,"completion_tokens":5}}` + "\n\n"))
                _, _ = w.Write([]byte("data: [DONE]\n\n"))
        }))
        defer srv.Close()

        ch := make(chan ChatChunk, 64)
        req := ChatRequest{
                Model: "openai/gpt-4o", Provider: "openrouter",
                BaseURL: srv.URL, Messages: []Message{{Role: "user", Content: "long task"}},
        }
        var deltas strings.Builder
        usage, err := scanSSE(context.Background(), req, nil, ch, func(_, content string) {
                deltas.WriteString(content)
        })
        if err != nil {
                t.Fatalf("scanSSE: %v", err)
        }
        close(ch)
        if usage.FinishReason != "length" {
                t.Errorf("FinishReason = %q, want length", usage.FinishReason)
        }
        if !usage.OutputCut {
                t.Error("OutputCut must flag on finish_reason=length")
        }
        if !strings.Contains(deltas.String(), "token cap") {
                t.Errorf("the length honesty note must ride the visible stream, got %q", deltas.String())
        }
}

// TestV1141_MergeUsage_LastRoundWins — the turn's terminal state is the
// FINAL round's, with tokens summed across rounds.
func TestV1141_MergeUsage_LastRoundWins(t *testing.T) {
        r1 := &Usage{InputTokens: 100, OutputTokens: 20, FinishReason: "tool_calls"}
        r2 := &Usage{InputTokens: 150, OutputTokens: 30, FinishReason: "stop"}
        m := mergeUsage(r1, r2)
        if m.InputTokens != 250 || m.OutputTokens != 50 {
                t.Errorf("mergeUsage sums tokens wrong: %+v", m)
        }
        if m.FinishReason != "stop" || m.OutputCut {
                t.Errorf("the LAST round's verdict must win: %+v", m)
        }
        r3 := &Usage{InputTokens: 10, OutputTokens: 5, FinishReason: "length", OutputCut: true}
        m2 := mergeUsage(m, r3)
        if m2.FinishReason != "length" || !m2.OutputCut {
                t.Errorf("a length-cut final round must win: %+v", m2)
        }
}

// TestV1141_ContextGuard — fires past 92% of a spec-known window with the
// real numbers; stays silent under it; stays silent for heuristic windows.
func TestV1141_ContextGuard(t *testing.T) {
        // openai/gpt-4-classic: snapshot ctx 8192. 92% = 7536 tokens.
        // ~2 tokens per repetition: 5000 reps ≈ 10000 tokens, safely over.
        big := strings.Repeat("hello world ", 5000)
        ch := make(chan ChatChunk, 8)
        req := ChatRequest{Model: "openai/gpt-4-classic", Messages: []Message{{Role: "user", Content: big}}}
        emitContextGuard(context.Background(), ch, req)
        select {
        case c := <-ch:
                if c.Type != "progress" || !strings.Contains(c.Text, "context guard") {
                        t.Fatalf("guard chunk wrong shape: %+v", c)
                }
                if !strings.Contains(c.Text, "8.2k") || !strings.Contains(c.Text, "%") {
                        t.Errorf("the guard must speak the actual numbers (humanized): %q", c.Text)
                }
        default:
                t.Fatal("the guard must fire past 92% of a spec-known window")
        }

        // Under the threshold: silence.
        ch2 := make(chan ChatChunk, 8)
        req2 := ChatRequest{Model: "openai/gpt-4-classic", Messages: []Message{{Role: "user", Content: "hi"}}}
        emitContextGuard(context.Background(), ch2, req2)
        select {
        case c := <-ch2:
                t.Fatalf("guard must stay quiet under the threshold, got %+v", c)
        default:
        }

        // Unknown window (heuristic only): silence — no invented denominator.
        ch3 := make(chan ChatChunk, 8)
        req3 := ChatRequest{Model: "definitely/not-a-real-model-xyz", Messages: []Message{{Role: "user", Content: big}}}
        emitContextGuard(context.Background(), ch3, req3)
        select {
        case c := <-ch3:
                t.Fatalf("guard must skip heuristic windows, got %+v", c)
        default:
        }
}
