package llm

// nativetools_v0823_test.go — THE ANSWER-FORCE NET on the native-tools
// path (the Nvidia quick-chat route). The user: "I think Nvidia does this
// too." This path had NO net at all — a reasoning-only round with zero
// tool calls ended the turn silently ("final answer — already streamed"
// assumed content existed). Now: contentSeen guards, ONE nudge round
// with thinking disabled, and the turn-end net answers.
//
// The fake server speaks the OpenAI tools SSE shape.

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

// TestV823_NativeTools_ReasoningOnlyRoundGetsNudged — round 1 streams
// reasoning + usage but NO content and NO tool_calls; the turn must run a
// second (nudged) round whose content becomes the reply.
func TestV823_NativeTools_ReasoningOnlyRoundGetsNudged(t *testing.T) {
	var calls int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := atomic.AddInt32(&calls, 1)
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(200)
		fl := w.(http.Flusher)
		if n == 1 {
			// reasoning-only round: thinking deltas + usage, zero content,
			// zero tool_calls — the silent-stop shape
			for _, f := range []string{
				`data: {"choices":[{"delta":{"reasoning_content":"I will summarize which tools worked next."}}]}`,
				`data: {"choices":[{"delta":{},"finish_reason":"stop"}]}`,
				`data: {"choices":[],"usage":{"prompt_tokens":900,"completion_tokens":120}}`,
			} {
				_, _ = w.Write([]byte(f + "\n\n"))
			}
			fl.Flush()
			return
		}
		// the nudged round: plain content, no tools
		for _, f := range []string{
			`data: {"choices":[{"delta":{"content":"THE SUMMARY: all tools pass."}}]}`,
			`data: {"choices":[{"delta":{},"finish_reason":"stop"}]}`,
			`data: {"choices":[],"usage":{"prompt_tokens":950,"completion_tokens":30}}`,
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
		Messages: []Message{{Role: "user", Content: "summarize the tests"}},
	}
	go func() {
		runNativeToolsTurn(context.Background(), ch, errs, req)
		close(ch)
		close(errs)
	}()
	var got string
	var sawNudgeProgress bool
	for ev := range ch {
		if ev.Type == "assistant_delta" {
			got += ev.Text
		}
		if ev.Type == "progress" && strings.Contains(ev.Text, "thinking off") {
			sawNudgeProgress = true
		}
	}
	for e := range errs {
		if e != nil {
			t.Fatalf("err: %v", e)
		}
	}
	if atomic.LoadInt32(&calls) != 2 {
		t.Fatalf("expected 2 rounds (reasoning-only + nudge), got %d", calls)
	}
	if !sawNudgeProgress {
		t.Fatalf("the nudge progress hint never fired")
	}
	if !strings.Contains(got, "THE SUMMARY") {
		t.Fatalf("the nudged content should be the reply, got: %q", got)
	}
	if strings.Contains(got, "(the model finished its reasoning") {
		t.Fatalf("synth prefix leaked though the nudge worked: %q", got)
	}
}

// TestV823_NativeTools_StillSilentTurnEndNet — both rounds reasoning-only:
// the reasoning tail becomes the reply under the honest prefix.
func TestV823_NativeTools_StillSilentTurnEndNet(t *testing.T) {
	var calls int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&calls, 1)
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(200)
		fl := w.(http.Flusher)
		for _, f := range []string{
			`data: {"choices":[{"delta":{"reasoning_content":"planning to write the summary now"}}]}`,
			`data: {"choices":[],"usage":{"prompt_tokens":50,"completion_tokens":10}}`,
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
		Messages: []Message{{Role: "user", Content: "summarize"}},
	}
	go func() {
		runNativeToolsTurn(context.Background(), ch, errs, req)
		close(ch)
		close(errs)
	}()
	var got string
	for ev := range ch {
		if ev.Type == "assistant_delta" {
			got += ev.Text
		}
	}
	for e := range errs {
		if e != nil {
			t.Fatalf("err: %v", e)
		}
	}
	if atomic.LoadInt32(&calls) != 2 {
		t.Fatalf("expected 2 rounds, got %d", calls)
	}
	if !strings.Contains(got, "(the model finished its reasoning") || !strings.Contains(got, "planning to write the summary") {
		t.Fatalf("the turn-end net should synthesize from the reasoning tail, got: %q", got)
	}
}
