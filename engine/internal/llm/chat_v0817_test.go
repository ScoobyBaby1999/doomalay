package llm

// chat_v0817_test.go — THE FINAL-ANSWER NET, the direct-path twin
// (v0.81.7). User report: "Privatemodeai and possibly Nvidia still has an
// issue where they finish the reasoning but don't follow up with a reply…
// the bot finished its reasoning but then just stopped. No reply after the
// reasoning." A round that streams THINKING and finishes with zero content
// used to return an empty answer → the empty-round retry → the visible
// "empty response" ERROR — a complaint, not a reply, and the reasoning
// (which usually contains the answer the model never sent) was thrown
// away. The net flushes the reasoning tail as the answer under an honest
// prefix — completeSync's reasoning-only fallback, twinned on the
// streaming path.

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// TestV817_ReasoningOnlyStreamFlushesAnswer — a 200 SSE stream carrying
// ONLY reasoning_content deltas (the deepseek-style shape NVIDIA serves)
// ends with a REPLY, not silence and not the empty-response error.
func TestV817_ReasoningOnlyStreamFlushesAnswer(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(200)
		fl := w.(http.Flusher)
		frames := []string{
			`data: {"choices":[{"delta":{"reasoning_content":"The user asked about the repo. "}}]}`,
			`data: {"choices":[{"delta":{"reasoning_content":"I should list the files first. "}}]}`,
			`data: {"choices":[{"delta":{"reasoning_content":"The answer is 42 files total."}}]}`,
			`data: {"choices":[{"delta":{}},{"delta":{}}],"usage":{"prompt_tokens":10,"completion_tokens":20}}`,
			`data: [DONE]`,
		}
		for _, f := range frames {
			_, _ = w.Write([]byte(f + "\n\n"))
			fl.Flush()
			<-time.After(5 * time.Millisecond)
		}
	}))
	defer srv.Close()

	ch := make(chan ChatChunk, 64)
	req := ChatRequest{
		Model:    "nvidia/deepseek-ai/deepseek-r1",
		Provider: "nvidia",
		BaseURL:  srv.URL,
		Messages: []Message{{Role: "user", Content: "how many files"}},
	}
	answer, _, emitted, err := runReActRoundStream(context.Background(), req, ch)
	close(ch)
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	// THE NET: the reasoning tail became the answer under the honest prefix
	if !strings.Contains(answer, "the model finished its reasoning without sending a visible reply") {
		t.Fatalf("answer missing the honest prefix: %q", answer)
	}
	if !strings.Contains(answer, "The answer is 42 files total.") {
		t.Fatalf("answer missing the reasoning tail: %q", answer)
	}
	if !emitted {
		t.Fatalf("the flushed reasoning must count as emitted (retry safety)")
	}
	// the reply STREAMED (assistant_delta on the channel)
	sawDelta := false
	for ev := range ch {
		if ev.Type == "assistant_delta" && strings.Contains(ev.Text, "42 files") {
			sawDelta = true
		}
	}
	if !sawDelta {
		t.Fatalf("no assistant_delta carried the flushed reply")
	}
}

// TestV817_NormalStreamUnchanged — a round with CONTENT never triggers
// the net (the answer is exactly the streamed content, no prefix).
func TestV817_NormalStreamUnchanged(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(200)
		fl := w.(http.Flusher)
		frames := []string{
			`data: {"choices":[{"delta":{"reasoning_content":"thinking briefly"}}]}`,
			`data: {"choices":[{"delta":{"content":"FINAL: the answer."}}]}`,
			`data: [DONE]`,
		}
		for _, f := range frames {
			_, _ = w.Write([]byte(f + "\n\n"))
			fl.Flush()
			<-time.After(5 * time.Millisecond)
		}
	}))
	defer srv.Close()

	ch := make(chan ChatChunk, 64)
	req := ChatRequest{
		Model: "nvidia/x", Provider: "nvidia", BaseURL: srv.URL,
		Messages: []Message{{Role: "user", Content: "q"}},
	}
	answer, _, _, err := runReActRoundStream(context.Background(), req, ch)
	close(ch)
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if strings.TrimSpace(answer) != "FINAL: the answer." {
		t.Fatalf("normal round changed: %q", answer)
	}
}
