package llm

// chat_v0823_test.go — THE ANSWER-FORCE NETS (the direct-path twin of
// scripts/v0823-answer-force-test.mjs; user report: "notice how the LLM
// just stopped responding… it said it will give a summary, then didn't…
// I'm using privatemodeai, but I think Nvidia does this too").
//
// v0.81.7's net caught the reasoning-only round and synthesized the
// honest prefix + last thought — but the model never actually replied,
// and nothing retried with thinking DISABLED. v0.82.3: the netted round
// returns its note; runReActRoundWithRetry runs ONE nudge round with
// Effort "off" (the documented per-family disable — kimi
// chat_template_kwargs.thinking:false, Moonshot's "instant mode") and the
// final-answer instruction appended; only a second failure falls back to
// the synthesized note.

import (
        "context"
        "encoding/json"
        "io"
        "net/http"
        "net/http/httptest"
        "strings"
        "sync/atomic"
        "testing"
        "time"
)

func v823SSE(w http.ResponseWriter, frames []string) {
        w.Header().Set("Content-Type", "text/event-stream")
        w.WriteHeader(200)
        fl := w.(http.Flusher)
        for _, f := range frames {
                _, _ = w.Write([]byte(f + "\n\n"))
                fl.Flush()
                <-time.After(2 * time.Millisecond)
        }
}

// TestV823_AnswerForceNudge — the reasoning-only round triggers ONE nudge
// round with thinking disabled; the nudged round's content becomes the
// reply (a REAL answer, no synth prefix).
func TestV823_AnswerForceNudge(t *testing.T) {
        var bodies []string
        var calls int32
        srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
                raw, _ := io.ReadAll(r.Body)
                bodies = append(bodies, string(raw))
                n := atomic.AddInt32(&calls, 1)
                if n == 1 {
                        // THE USER'S SHAPE: reasoning-only, zero content
                        v823SSE(w, []string{
                                `data: {"choices":[{"delta":{"reasoning_content":"I will now summarize which tools worked and which failed."}}]}`,
                                `data: {"choices":[{"delta":{},"finish_reason":"stop"}]}`,
                                `data: {"choices":[],"usage":{"prompt_tokens":5000,"completion_tokens":200}}`,
                        })
                        return
                }
                // the nudged round: instant mode — content only
                v823SSE(w, []string{
                        `data: {"choices":[{"delta":{"content":"THE SUMMARY: everything works except grep line numbers."}}]}`,
                        `data: {"choices":[],"usage":{"prompt_tokens":5100,"completion_tokens":40}}`,
                })
        }))
        defer srv.Close()

        ch := make(chan ChatChunk, 64)
        req := ChatRequest{
                Model:    "privatemodeai/kimi-k2.6",
                Provider: "privatemodeai",
                Effort:   "med",
                BaseURL:  srv.URL,
                Messages: []Message{{Role: "user", Content: "test everything and summarize"}},
        }
        answer, _, err := runReActRoundWithRetry(context.Background(), req, ch)
        close(ch)
        if err != nil {
                t.Fatalf("err: %v", err)
        }
        if atomic.LoadInt32(&calls) != 2 {
                t.Fatalf("expected exactly 2 rounds (reasoning-only + nudge), got %d", calls)
        }
        // THE REAL REPLY wins — no synth prefix
        if !strings.Contains(answer, "THE SUMMARY") {
                t.Fatalf("the nudged round's content should be the reply, got: %q", answer)
        }
        if strings.Contains(answer, "(the model finished its reasoning") {
                t.Fatalf("the synth prefix leaked though the nudge worked: %q", answer)
        }
        // THE ANSWER-FORCE SHAPE: round 2 carries the kimi disable + the nudge text
        if len(bodies) < 2 {
                t.Fatalf("expected 2 request bodies, got %d", len(bodies))
        }
        var body2 map[string]any
        if err := json.Unmarshal([]byte(bodies[1]), &body2); err != nil {
                t.Fatalf("round-2 body unmarshal: %v", err)
        }
        ctk, _ := body2["chat_template_kwargs"].(map[string]any)
        if ctk == nil || ctk["thinking"] != false {
                t.Fatalf("round-2 body missing chat_template_kwargs.thinking=false (kimi instant mode): %s", bodies[1])
        }
        if !strings.Contains(bodies[1], "Reply NOW with your FINAL answer as plain text") {
                t.Fatalf("round-2 body missing the final-answer nudge: %s", bodies[1])
        }
        // round 1 kept the normal shape (no disable — the effort ladder sends
        // nothing for "med", and NO thinking:false may appear)
        if strings.Contains(bodies[0], "thinking\":false") {
                t.Fatalf("round-1 body must not carry the disable: %s", bodies[0])
        }
}

// TestV823_AnswerForceGiveUp — both rounds reasoning-only: the synthesized
// note still reaches the user (emitted once, as the reply).
func TestV823_AnswerForceGiveUp(t *testing.T) {
        var calls int32
        srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
                atomic.AddInt32(&calls, 1)
                v823SSE(w, []string{
                        `data: {"choices":[{"delta":{"reasoning_content":"planning to summarize the tool test results"}}]}`,
                        `data: {"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":20}}`,
                })
        }))
        defer srv.Close()

        ch := make(chan ChatChunk, 64)
        req := ChatRequest{
                Model:    "privatemodeai/kimi-k2.6",
                Provider: "privatemodeai",
                Effort:   "med",
                BaseURL:  srv.URL,
                Messages: []Message{{Role: "user", Content: "summarize"}},
        }
        answer, _, err := runReActRoundWithRetry(context.Background(), req, ch)
        close(ch)
        if err != nil {
                t.Fatalf("err: %v", err)
        }
        if !strings.Contains(answer, "(the model finished its reasoning") {
                t.Fatalf("the give-up path should emit the synthesized note, got: %q", answer)
        }
        sawDelta := false
        for ev := range ch {
                if ev.Type == "assistant_delta" && strings.Contains(ev.Text, "the model finished its reasoning") {
                        sawDelta = true
                }
        }
        if !sawDelta {
                t.Fatalf("the note must be emitted as the reply (assistant_delta)")
        }
}

// TestV823_GenuinelyEmptyTwice — no reasoning, no content, twice: the
// diagnosable error still surfaces (the old contract survives).
func TestV823_GenuinelyEmptyTwice(t *testing.T) {
        var calls int32
        srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
                atomic.AddInt32(&calls, 1)
                v823SSE(w, []string{
                        `data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":1}}`,
                })
        }))
        defer srv.Close()

        ch := make(chan ChatChunk, 64)
        req := ChatRequest{
                Model:    "nvidia/deepseek-ai/deepseek-r1",
                Provider: "nvidia",
                BaseURL:  srv.URL,
                Messages: []Message{{Role: "user", Content: "hi"}},
        }
        _, _, err := runReActRoundWithRetry(context.Background(), req, ch)
        close(ch)
        if err == nil {
                t.Fatalf("the genuinely-empty-twice case should surface errEmptyRound")
        }
        sawErr := false
        for ev := range ch {
                if ev.Type == "error" && ev.Error == "empty_response" {
                        sawErr = true
                }
        }
        if !sawErr {
                t.Fatalf("the empty_response error must reach the channel")
        }
        if atomic.LoadInt32(&calls) != 2 {
                t.Fatalf("expected 2 rounds (empty + nudged empty), got %d", calls)
        }
}
