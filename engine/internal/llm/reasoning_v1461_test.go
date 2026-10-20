package llm

// reasoning_v1461_test.go — v1.46.1 THE ALIAS LAW pins. The live-captured
// wire shapes from the 2026-10-20 probe against the real PM deployment
// (vllm-0.31.0-tp4-ep-2e04e944, glm-5.3 + gpt-oss-120b, plain + tool
// rounds, streaming + non-streaming): EVERY reasoning delta carries BOTH
// spellings byte-equal —
//
//      {"delta": {"reasoning": "The", "reasoning_content": "The"}}
//      {"delta": {"reasoning": " user", "reasoning_content": " user"}}
//
// The old merge (Reasoning + ReasoningOR) concatenated the pair, doubling
// every word of PM-native reasoning (the user's "every word appears twice"
// report). These pins hold the alias law: byte-equal pair = ONE copy;
// single-spelling senders untouched; unknown both-different deltas keep
// every byte.

import (
        "context"
        "net/http"
        "net/http/httptest"
        "testing"

        "github.com/ScoobyBaby1999/doomalay/engine/internal/obs"
)

// scanOnly serves frames as an OpenAI-compatible SSE stream and drives the
// STANDARD chunk parser (the exact parser the PM synthetic body feeds —
// chat.go's pmSSEBody synthesizes `data: <payload>\n\n` frames from the
// decrypted PM events, so this harness sees the identical bytes the engine
// sees on a PM-native turn).
func scanOnly(t *testing.T, frames []string, onDelta func(reasoning, content string)) (*Usage, error) {
        t.Helper()
        srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
                w.Header().Set("Content-Type", "text/event-stream")
                w.WriteHeader(200)
                fl := w.(http.Flusher)
                for _, f := range frames {
                        _, _ = w.Write([]byte("data: " + f + "\n\n"))
                        fl.Flush()
                }
                _, _ = w.Write([]byte("data: [DONE]\n\n"))
                fl.Flush()
        }))
        defer srv.Close()
        obs.SetDeltaTraceForTest(0)
        ch := make(chan ChatChunk, 64)
        go func() {
                for range ch {
                } // drain; the deltas ride onDelta
        }()
        defer close(ch)
        req := ChatRequest{
                Model: "m", Provider: "openrouter", BaseURL: srv.URL,
                Messages: []Message{{Role: "user", Content: "hi"}},
        }
        usage, _, err := scanSSECollect(context.Background(), req, nil, ch, onDelta)
        return usage, err
}

func TestMergeWireReasoningAliasPair(t *testing.T) {
        cases := []struct {
                name, rc, r, want string
        }{
                // The live PM shape: both spellings, byte-equal, on EVERY delta.
                {"pm alias pair first token", "The", "The", "The"},
                {"pm alias pair with leading space", " user", " user", " user"},
                {"pm alias pair multiline", "\n\nOkay", "\n\nOkay", "\n\nOkay"},
                {"pm alias pair empty strings", "", "", ""},
                // Single-spelling senders — byte-identical behavior to pre-v1.46.1.
                {"openrouter reasoning only", "", "The model is thinking", "The model is thinking"},
                {"nim reasoning_content only", "The model is thinking", "", "The model is thinking"},
                // Unobserved shape: both spellings, DIFFERENT text — keep every
                // byte (the historical merge, so no wire text is ever dropped).
                {"both non-empty different", "alpha", "beta", "alphabeta"},
        }
        for _, c := range cases {
                if got := mergeWireReasoning(c.rc, c.r); got != c.want {
                        t.Errorf("%s: mergeWireReasoning(%q, %q) = %q, want %q", c.name, c.rc, c.r, got, c.want)
                }
        }
}

// TestScanSSEPMAliasPairNoDoubling drives the FULL standard chunk parser
// with the exact PM SSE frames captured live (probe chunks 2-4 + the answer
// + the terminal chunks) and asserts the canonical reasoning channel reads
// like the model's actual thinking — no word twice.
func TestScanSSEPMAliasPairNoDoubling(t *testing.T) {
        frames := []string{
                // chunk 1 — the role chunk (content "" parses as no delta)
                `{"choices":[{"delta":{"content":"","role":"assistant"},"finish_reason":null,"index":0}],"usage":{"completion_tokens":0,"prompt_tokens":24,"total_tokens":24}}`,
                // chunks 2-5 — the alias pair, byte-equal, live-captured
                `{"choices":[{"delta":{"reasoning":"The","reasoning_content":"The"},"finish_reason":null,"index":0}],"usage":{"completion_tokens":1,"prompt_tokens":24,"total_tokens":25}}`,
                `{"choices":[{"delta":{"reasoning":" user","reasoning_content":" user"},"finish_reason":null,"index":0}],"usage":{"completion_tokens":2,"prompt_tokens":24,"total_tokens":26}}`,
                `{"choices":[{"delta":{"reasoning":" is","reasoning_content":" is"},"finish_reason":null,"index":0}],"usage":{"completion_tokens":3,"prompt_tokens":24,"total_tokens":27}}`,
                `{"choices":[{"delta":{"reasoning":" asking","reasoning_content":" asking"},"finish_reason":null,"index":0}],"usage":{"completion_tokens":4,"prompt_tokens":24,"total_tokens":28}}`,
                // chunk 52 — the answer delta (single content field, live-captured)
                `{"choices":[{"delta":{"content":"Four"},"finish_reason":null,"index":0}],"usage":{"completion_tokens":55,"prompt_tokens":24,"total_tokens":79}}`,
                // chunk 53 — finish
                `{"choices":[{"delta":{},"finish_reason":"stop","index":0}],"usage":{"completion_tokens":56,"prompt_tokens":24,"total_tokens":80}}`,
        }
        var reason, content string
        _, err := scanOnly(t, frames, func(r, c string) {
                reason += r
                content += c
        })
        if err != nil {
                t.Fatalf("scan: %v", err)
        }
        // THE LAW: the reasoning is the model's thinking ONCE — the old merge
        // produced "TheThe user user is is asking asking" here.
        if want := "The user is asking"; reason != want {
                t.Errorf("reasoning = %q, want %q (the alias pair must merge to ONE copy)", reason, want)
        }
        if want := "Four"; content != want {
                t.Errorf("content = %q, want %q", content, want)
        }
}

// TestScanSSESingleSpellingUnchanged pins the zero-regression law: the
// single-spelling senders (OpenRouter's reasoning, NIM's
// reasoning_content) stream exactly as before v1.46.1.
func TestScanSSESingleSpellingUnchanged(t *testing.T) {
        orFrames := []string{
                `{"choices":[{"delta":{"reasoning":"thinking hard"},"index":0}]}`,
                `{"choices":[{"delta":{"content":"hi"},"index":0}]}`,
        }
        var reason, content string
        if _, err := scanOnly(t, orFrames, func(r, c string) { reason += r; content += c }); err != nil {
                t.Fatalf("scan: %v", err)
        }
        if reason != "thinking hard" || content != "hi" {
                t.Errorf("openrouter shape regressed: reasoning=%q content=%q", reason, content)
        }

        nimFrames := []string{
                `{"choices":[{"delta":{"reasoning_content":"thinking hard"},"index":0}]}`,
                `{"choices":[{"delta":{"content":"hi"},"index":0}]}`,
        }
        reason, content = "", ""
        if _, err := scanOnly(t, nimFrames, func(r, c string) { reason += r; content += c }); err != nil {
                t.Fatalf("scan: %v", err)
        }
        if reason != "thinking hard" || content != "hi" {
                t.Errorf("nim shape regressed: reasoning=%q content=%q", reason, content)
        }
}
