package llm

import (
	"bufio"
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// TestWaitNotices (v0.24): a provider that accepts the SSE request and then
// streams NOTHING (only keepalive comments — the live-observed NVIDIA
// kimi-k3 behavior: 139-151s silent gaps with keepalives trickling) must
// produce live "waiting for <model> · Ns" progress chunks so the UI never
// sits on a dead "thinking…".
func TestWaitNotices(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(200)
		fl := w.(http.Flusher)
		// keepalives for 60s, zero data frames
		for i := 0; i < 120; i++ {
			fl.Flush()
			<-time.After(500 * time.Millisecond)
		}
	}))
	defer srv.Close()

	ch := make(chan ChatChunk, 64)
	req := ChatRequest{
		Model:    "nvidia/moonshotai/kimi-k3",
		Provider: "nvidia",
		BaseURL:  srv.URL,
		Messages: []Message{{Role: "user", Content: "hi"}},
	}

	var progress []string
	done := make(chan struct{})
	go func() {
		defer close(done)
		for ev := range ch {
			if ev.Type == "progress" {
				progress = append(progress, ev.Text)
			}
		}
	}()

	start := time.Now()
	_, _ = scanSSE(context.Background(), req, nil, ch, func(reasoning, content string) {})
	_ = start
	close(ch)
	<-done

	if len(progress) < 3 {
		t.Fatalf("expected >= 3 wait notices on a silent stream, got %d: %v", len(progress), progress)
	}
	t.Logf("notices: %v", progress)
	want := "waiting for kimi-k3"
	if got := progress[0]; len(got) < len(want) || got[:len(want)] != want {
		t.Fatalf("first notice should start with %q, got %q", want, progress[0])
	}
}

// TestFriendlyHTTPErrors (v0.24): the user's spec — 429 / capacity /
// model-gone errors get actionable text with a switch-model suggestion.
func TestFriendlyHTTPErrors(t *testing.T) {
	cases := []struct {
		status int
		body   string
		want   string
	}{
		{429, `{"error":"rate limit exceeded"}`, "429"},
		{429, `rate limited`, "429"},
		{404, `{"detail":"Function 'x': Not found for account 'y'"}', `, "no longer available"},
		{503, `service unavailable`, "provider error"},
	}
	for _, c := range cases {
		got := friendlyHTTPError(c.status, c.body, "nvidia")
		if !containsStr(got, c.want) {
			t.Errorf("friendlyHTTPError(%d,…) = %q, want substring %q", c.status, got, c.want)
		}
	}
}

// TestLooksLikeIntentOnly (v0.24): the auto-proceed nudge detector.
func TestLooksLikeIntentOnly(t *testing.T) {
	yes := []string{
		"I will now demonstrate all the capabilities of this app.",
		"Let me start by showing you the calculator tool.",
		"Here's my plan:\n1. calculate\n2. zip\nShall I proceed?",
	}
	no := []string{
		"How can I assist you today?",
		"The result is 42.",
	}
	for _, s := range yes {
		if !looksLikeIntentOnly(s) {
			t.Errorf("expected INTENT for %q", s)
		}
	}
	for _, s := range no {
		if looksLikeIntentOnly(s) {
			t.Errorf("expected NO intent for %q", s)
		}
	}
}

func containsStr(hay, needle string) bool {
	for i := 0; i+len(needle) <= len(hay); i++ {
		if hay[i:i+len(needle)] == needle {
			return true
		}
	}
	return false
}

// silence-check helper: bufio import guard (kept for future SSE assertions)
var _ = bufio.NewScanner
