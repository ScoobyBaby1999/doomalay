package llm

// chat_v0817_test.go — THE FINAL-ANSWER NET, v1.13.3 THE GUT edition
// (rewritten at TURN level — the round-level runReActRoundStream tests died
// with the ACTION parser).
//
// User report (v0.81.7): "Privatemodeai and possibly Nvidia still has an
// issue where they finish the reasoning but don't follow up with a reply…
// the bot finished its reasoning but then just stopped." A round that
// streams THINKING and finishes with zero content is NOT a final answer —
// the answer-force net nudges once with thinking disabled and the turn
// still ends with a REPLY, never silence.

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// TestV817_ReasoningOnlyStreamFlushesAnswer — a 200 SSE stream carrying
// ONLY reasoning_content deltas (the deepseek-style shape NVIDIA serves)
// ends with a REPLY (the answer-force nudge round), not silence and not
// the empty-response error.
func TestV817_ReasoningOnlyStreamFlushesAnswer(t *testing.T) {
	calls := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(200)
		fl := w.(http.Flusher)
		calls++
		if calls == 1 {
			frames := []string{
				`data: {"choices":[{"delta":{"reasoning_content":"The user asked about the repo. "}}]}`,
				`data: {"choices":[{"delta":{"reasoning_content":"I should list the files first. "}}]}`,
				`data: {"choices":[{"delta":{"reasoning_content":"The answer is 42 files total."}}]}`,
				`data: {"choices":[{"delta":{}}]}`,
				`data: [DONE]`,
			}
			for _, f := range frames {
				_, _ = w.Write([]byte(f + "\n\n"))
				fl.Flush()
				<-time.After(2 * time.Millisecond)
			}
			return
		}
		// the answer-force nudge round (thinking disabled) — the reply arrives
		for _, f := range []string{
			`data: {"choices":[{"delta":{"content":"42 files total — from my reasoning."}}]}`,
			`data: {"choices":[{"delta":{}}]}`,
			`data: [DONE]`,
		} {
			_, _ = w.Write([]byte(f + "\n\n"))
			fl.Flush()
			<-time.After(2 * time.Millisecond)
		}
	}))
	defer srv.Close()

	req := ChatRequest{
		Model:    "nvidia/deepseek-ai/deepseek-r1",
		Provider: "nvidia",
		BaseURL:  srv.URL,
		Messages: []Message{{Role: "user", Content: "how many files"}},
	}
	ch, errs := Chat(t.Context(), req)

	var answer string
	var progressNotes []string
	var sawIdle, sawError bool
	deadline := time.After(20 * time.Second)
collect:
	for {
		select {
		case c, ok := <-ch:
			if !ok {
				break collect
			}
			switch {
			case c.Type == "assistant_delta":
				answer += c.Text
			case c.Type == "progress":
				progressNotes = append(progressNotes, c.Text)
			case c.Type == "status" && c.State == "idle":
				sawIdle = true
			case c.Type == "error":
				sawError = true
			}
		case e, ok := <-errs:
			_ = ok
			if e != nil {
				t.Fatalf("err: %v", e)
			}
		case <-deadline:
			t.Fatal("turn never completed")
		}
	}
	if sawError {
		t.Fatalf("the reasoning-only net must not surface an error chunk")
	}
	if !sawIdle {
		t.Fatalf("turn must end idle")
	}
	if !strings.Contains(answer, "42") {
		t.Fatalf("the net must end with a reply carrying the answer, got %q", answer)
	}
	joined := strings.Join(progressNotes, "\n")
	if !strings.Contains(joined, "asking again") && !strings.Contains(joined, "reasoning ended") {
		t.Fatalf("the answer-force nudge should announce itself, got %q", joined)
	}
	if calls < 2 {
		t.Fatalf("the nudge round must actually run (calls=%d)", calls)
	}
}

// TestV817_NormalStreamUnchanged — reasoning followed by content is the
// ordinary shape: the content IS the answer, no nudge fires.
func TestV817_NormalStreamUnchanged(t *testing.T) {
	calls := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(200)
		fl := w.(http.Flusher)
		calls++
		for _, f := range []string{
			`data: {"choices":[{"delta":{"reasoning_content":"thinking briefly"}}]}`,
			`data: {"choices":[{"delta":{"content":"FINAL: the answer."}}]}`,
			`data: [DONE]`,
		} {
			_, _ = w.Write([]byte(f + "\n\n"))
			fl.Flush()
			<-time.After(2 * time.Millisecond)
		}
	}))
	defer srv.Close()

	req := ChatRequest{
		Model: "nvidia/x", Provider: "nvidia", BaseURL: srv.URL,
		Messages: []Message{{Role: "user", Content: "q"}},
	}
	ch, _ := Chat(t.Context(), req)
	var answer string
	deadline := time.After(20 * time.Second)
collect:
	for {
		select {
		case c, ok := <-ch:
			if !ok {
				break collect
			}
			if c.Type == "assistant_delta" {
				answer += c.Text
			}
		case <-deadline:
			t.Fatal("turn never completed")
		}
	}
	if strings.TrimSpace(answer) != "FINAL: the answer." {
		t.Fatalf("normal round changed: %q", answer)
	}
	if calls != 1 {
		t.Fatalf("no nudge should fire on the ordinary shape (calls=%d)", calls)
	}
}
