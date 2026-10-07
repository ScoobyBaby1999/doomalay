package llm

// chat_v0823_test.go — THE ANSWER-FORCE NET + THE TURN-END NET, v1.13.3
// THE GUT edition (rewritten at TURN level — the round-level
// runReActRoundWithRetry tests died with the ACTION parser).
//
// The contracts (v0.82.3):
//   - a silent round (no calls, no visible content) is NOT a final answer
//     — ONE nudge round runs with thinking disabled;
//   - a still-silent turn ends through the turn-end net: the reasoning
//     tail becomes the reply under the honest prefix; a no-reasoning
//     silent turn gets the honest empty note. Never a silent screen.

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// TestV823_GiveUpEmitsReasoningTail — reasoning-only twice (the nudge
// round included): the turn ends with the reasoning tail as the reply
// under the honest prefix.
func TestV823_GiveUpEmitsReasoningTail(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(200)
		fl := w.(http.Flusher)
		for _, f := range []string{
			`data: {"choices":[{"delta":{"reasoning_content":"Let me count the repos. "}}]}`,
			`data: {"choices":[{"delta":{"reasoning_content":"There are exactly 7 repos. "}}]}`,
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
		Model: "nvidia/x", Provider: "nvidia", BaseURL: srv.URL,
		Messages: []Message{{Role: "user", Content: "count my repos"}},
	}
	ch, _ := Chat(t.Context(), req)
	var reply string
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
			case c.Type == "assistant_delta":
				reply += c.Text
			case c.Type == "status" && c.State == "idle":
				sawIdle = true
			}
		case <-deadline:
			t.Fatal("turn never completed")
		}
	}
	if !sawIdle {
		t.Fatalf("turn must end idle")
	}
	if !strings.Contains(reply, "finished its reasoning without sending a visible reply") {
		t.Fatalf("the honest prefix must ride the reasoning tail, got %q", reply)
	}
	if !strings.Contains(reply, "7 repos") {
		t.Fatalf("the reasoning tail carries the answer, got %q", reply)
	}
}

// TestV823_GenuinelyEmptyTwice — nothing at all, twice (nudge included):
// the honest empty note, never a silent screen.
func TestV823_GenuinelyEmptyTwice(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(200)
		fl := w.(http.Flusher)
		for _, f := range []string{
			`data: {"choices":[{"delta":{}}]}`,
			`data: [DONE]`,
		} {
			_, _ = w.Write([]byte(f + "\n\n"))
			fl.Flush()
		}
	}))
	defer srv.Close()

	req := ChatRequest{
		Model: "nvidia/x", Provider: "nvidia", BaseURL: srv.URL,
		Messages: []Message{{Role: "user", Content: "say hi"}},
	}
	ch, _ := Chat(t.Context(), req)
	var reply string
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
			case c.Type == "assistant_delta":
				reply += c.Text
			case c.Type == "status" && c.State == "idle":
				sawIdle = true
			}
		case <-deadline:
			t.Fatal("turn never completed")
		}
	}
	if !sawIdle {
		t.Fatalf("turn must end idle")
	}
	if !strings.Contains(reply, "empty response") {
		t.Fatalf("the honest empty note must land, got %q", reply)
	}
}
