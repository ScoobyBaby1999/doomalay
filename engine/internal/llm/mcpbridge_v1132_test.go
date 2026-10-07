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

// mcpbridge_v1132_test.go — v1.13.2 THE HANDOFF (PLAN-V113 §2).
//
// Two contracts:
//  1. THE GOLDEN PATH: a native tool_call executes through the MCP bus
//     (the real protocol, the real calculator) and the event sequence
//     is the old one — tool_use pill, tool_result, final answer.
//  2. THE HONEST DEGRADE: a provider that 400s tools is blacklisted and
//     the turn reruns cleanly WITHOUT tools (the ACTION text protocol
//     no longer absorbs this case).

func TestV1132_MCPGoldenPath(t *testing.T) {
	calls := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		if calls == 0 && !strings.Contains(string(body), `"tools"`) {
			t.Errorf("round 1 should carry the mcpbus tools manifest")
		}
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
		t.Fatalf("golden path: use=%v result=%v answer=%v idle=%v", sawUse, sawResult, sawAnswer, sawIdle)
	}
	if !strings.Contains(resultText, "518") {
		t.Fatalf("calculator result should carry 518 through the MCP bus, got %q", resultText)
	}
	if !strings.Contains(answerText, "518") {
		t.Fatalf("final answer should reflect the tool result, got %q", answerText)
	}
}

func TestV1132_ToolsRejectedDegradesHonestly(t *testing.T) {
	// (v1.13.3: the ACTION kill-switch is gone with the grammar — this
	// contract (the honest tool-less degrade) is now the ONLY behavior.)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		w.Header().Set("Content-Type", "text/event-stream")
		if strings.Contains(string(body), `"tools"`) {
			// the capability-gap 400 (tools-bearing request)
			w.WriteHeader(400)
			_, _ = w.Write([]byte(`{"error":{"message":"this model does not support tools or function calling"}}`))
			return
		}
		w.WriteHeader(200)
		fl := w.(http.Flusher)
		_, _ = w.Write([]byte(`data: {"choices":[{"delta":{"content":"I can still answer plainly: 518"}}]}` + "\n\n"))
		_, _ = w.Write([]byte(`data: {"choices":[{"delta":{},"finish_reason":"stop"}]}` + "\n\n"))
		_, _ = w.Write([]byte("data: [DONE]\n\n"))
		fl.Flush()
	}))
	defer srv.Close()

	req := ChatRequest{
		Model:    "together/meta-llama-4",
		Provider: "together",
		BaseURL:  srv.URL,
		Messages: []Message{{Role: "user", Content: "what is 37*14?"}},
	}
	ch, errs := Chat(context.Background(), req)

	var sawNotice, sawAnswer, sawIdle bool
	var answerText string
	var sawPanicChunk bool
	deadline := time.After(20 * time.Second)
collect:
	for {
		select {
		case c, ok := <-ch:
			if !ok {
				break collect
			}
			switch {
			case c.Type == "progress" && strings.Contains(c.Text, "rejected tool calling"):
				sawNotice = true
			case c.Type == "assistant_delta":
				answerText += c.Text
				sawAnswer = true
			case c.Type == "status" && c.State == "idle":
				sawIdle = true
			case c.Type == "error":
				sawPanicChunk = true
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
	if sawPanicChunk {
		t.Fatalf("the honest degrade must not surface an error chunk")
	}
	if !sawNotice || !sawAnswer || !sawIdle {
		t.Fatalf("honest degrade: notice=%v answer=%v idle=%v", sawNotice, sawAnswer, sawIdle)
	}
	if !strings.Contains(answerText, "518") {
		t.Fatalf("tool-less answer should still arrive, got %q", answerText)
	}
}
