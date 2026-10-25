package llm

// mcpbridge_v1751_test.go — v1.75.1 THE SINGLE VOICE (the trippy
// transcript conviction).
//
// The UNBOUNDED LANES rewrite (v1.74) added a tool_result emission inside
// busExecute while nativetools' v1.13.2 handoff kept its caller-side copy —
// every bus-executed tool call's result rode the chat TWICE, byte-identical.
// The user's real-device transcript (doomalay-trippy, 4 turns, 10 logical
// tool calls) showed 20 result rows: every pill's result doubled, every
// JOB_STARTED ticket doubled, every job_status answer doubled — "after many
// tool looks and reasoning, 2 final outputs appear instead of one" (simple
// tool-free asks rendered one output, isolating the native bus path).
//
// THE PIN: a native tool_call through the real MCP bus emits its tool_result
// EXACTLY ONCE, and the emission carries the honest clock (v1.73.3's
// duration_ms, amputated by the same rewrite, restored by the same wave).

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"
)

func TestV1751_SingleVoiceResult(t *testing.T) {
	calls := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(200)
		fl := w.(http.Flusher)
		calls++
		if calls == 1 {
			_, _ = w.Write([]byte(`data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"calculator","arguments":"{\"expr\":\"37*14\"}"}}]}}]}` + "\n\n"))
			_, _ = w.Write([]byte(`data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}` + "\n\n"))
		} else {
			_, _ = w.Write([]byte(`data: {"choices":[{"delta":{"content":"37*14 = 518 exactly"}}]}` + "\n\n"))
			_, _ = w.Write([]byte(`data: {"choices":[{"delta":{},"finish_reason":"stop"}]}` + "\n\n"))
		}
		_, _ = w.Write([]byte("data: [DONE]\n\n"))
		fl.Flush()
	}))
	defer srv.Close()

	req := ChatRequest{
		Model:    "together/meta-llama-4",
		Provider: "together",
		BaseURL:  srv.URL,
		Messages: []Message{{Role: "user", Content: "what is 37*14? use the calculator"}},
	}
	ch, errs := Chat(context.Background(), req)

	resultCount := 0
	resultText := ""
	var answerText string
	sawUse, sawIdle := false, false
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
				resultCount++
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
	if !sawUse || !sawIdle || !strings.Contains(answerText, "518") {
		t.Fatalf("golden path: use=%v idle=%v answer=%q", sawUse, sawIdle, answerText)
	}
	if !strings.Contains(resultText, "518") {
		t.Fatalf("calculator result should carry 518, got %q", resultText)
	}
	// THE SINGLE VOICE: one logical call — exactly ONE tool_result chunk.
	// The trippy conviction: the doubled emission put 20 result rows in a
	// 10-call transcript (every result, every ticket, every status answer).
	if resultCount != 1 {
		t.Fatalf("THE SINGLE VOICE broken: the calculator call emitted %d tool_result chunks (want exactly 1) — every extra copy doubles the chat's result rows", resultCount)
	}
}

func TestV1751_HonestClockRidesTheVoice(t *testing.T) {
	// The restored v1.73.3 law: busExecute's single emission carries the
	// per-call duration (the ToolRunner's own clock). A source-shaped pin
	// (the e2e duration for an in-process calculator is legitimately ~0 —
	// "0 is honest", so the runtime assertion is structural: the chunk
	// field exists and the emission sets it from the runner's result).
	src := srcOfV1751(t, "mcpbridge.go")
	if !strings.Contains(src, `ch <- ChatChunk{Type: "tool_result", Text: res.Observation, Name: action, DurationMS: res.DurationMs}`) {
		t.Fatalf("the single voice must carry the honest clock: DurationMS from the runner's result (v1.73.3 restored)")
	}
	if !strings.Contains(src, `ch <- ChatChunk{Type: "tool_result", Text: "error: " + res.Err.Error(), Name: action, DurationMS: res.DurationMs}`) {
		t.Fatalf("the degrade path's honest error result must ride the same single voice (the caller no longer emits)")
	}
	native := srcOfV1751(t, "nativetools.go")
	if strings.Contains(native, "// v1.13.2 THE HANDOFF: emit tool_result for the UI") {
		t.Fatalf("the caller-side copy must be dead — the v1.13.2 handoff comment marked the emission that doubled every result")
	}
}

// srcOfV1751 reads one of this package's source files (the source-pin
// helper — same law as the server package's srcOf).
func srcOfV1751(t *testing.T, name string) string {
	t.Helper()
	b, err := os.ReadFile(name)
	if err != nil {
		t.Fatalf("read %s: %v", name, err)
	}
	return string(b)
}
