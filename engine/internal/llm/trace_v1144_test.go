package llm

// trace_v1144_test.go — v1.14.4 THE TRACE: the stream lifecycle lands on
// the hook bus (first token, delta heads, tool-call fragments, the finish
// verdict with usage + tallies), riding a real SSE stub end to end.

import (
        "context"
        "net/http"
        "net/http/httptest"
        "sync"
        "testing"

        "github.com/ScoobyBaby1999/doomalay/engine/internal/obs"
)

type eventTap struct {
        mu     sync.Mutex
        kinds  map[obs.Kind]int
        last   map[obs.Kind]obs.Event
        unsub  func()
}

func newEventTap() *eventTap {
        t := &eventTap{kinds: map[obs.Kind]int{}, last: map[obs.Kind]obs.Event{}}
        t.unsub = obs.Subscribe("test-tap", func(e obs.Event) {
                t.mu.Lock()
                defer t.mu.Unlock()
                t.kinds[e.Kind]++
                t.last[e.Kind] = e
        })
        return t
}

func (t *eventTap) count(k obs.Kind) int {
        t.mu.Lock()
        defer t.mu.Unlock()
        return t.kinds[k]
}

func (t *eventTap) event(k obs.Kind) obs.Event {
        t.mu.Lock()
        defer t.mu.Unlock()
        return t.last[k]
}

// traceStub streams: 2 reasoning deltas, 1 content delta, one tool_call
// spread over 2 fragments, usage, and a finish_reason.
func traceStub() *httptest.Server {
        return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
                w.Header().Set("Content-Type", "text/event-stream")
                w.WriteHeader(200)
                lines := []string{
                        `data: {"choices":[{"delta":{"reasoning_content":"think one "}}]}`,
                        `data: {"choices":[{"delta":{"reasoning_content":"think two"}}]}`,
                        `data: {"choices":[{"delta":{"content":"visible text"}}]}`,
                        `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"web_search","arguments":"{\"q\":"}}]}}]}`,
                        `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\"doomalay\"}"}}]}}]}`,
                        `data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":11,"completion_tokens":7}}`,
                        `data: [DONE]`,
                }
                for _, l := range lines {
                        _, _ = w.Write([]byte(l + "\n\n"))
                }
        }))
}

func TestV1144_StreamLifecycleTraced(t *testing.T) {
        obs.SetDeltaTraceForTest(1)
        defer obs.SetDeltaTraceForTest(-1)

        tap := newEventTap()
        defer tap.unsub()

        srv := traceStub()
        defer srv.Close()

        ch := make(chan ChatChunk, 64)
        req := ChatRequest{
                Model: "trace-model", Provider: "traceprov", SessionID: "sess-trace",
                BaseURL: srv.URL, Messages: []Message{{Role: "user", Content: "go"}},
        }
        // production scopes the ctx in llm.Chat — mirror that here
        ctx := obs.TurnScope(context.Background(), "sess-trace")
        usage, calls, err := scanSSECollect(ctx, req, nil, ch, func(reasoning, content string) {})
        close(ch)
        if err != nil {
                t.Fatalf("scanSSECollect: %v", err)
        }
        if usage.InputTokens != 11 || usage.OutputTokens != 7 || usage.FinishReason != "stop" {
                t.Fatalf("usage/finish wrong: %+v", usage)
        }
        if len(calls) != 1 || calls[0].Name != "web_search" || calls[0].Arguments != `{"q":"doomalay"}` {
                t.Fatalf("assembled call wrong: %+v", calls)
        }

        // The lifecycle on the bus:
        if tap.count(obs.StreamOpen) != 1 {
                t.Errorf("StreamOpen missing")
        }
        if tap.count(obs.FirstToken) != 1 {
                t.Errorf("FirstToken must fire exactly once, got %d", tap.count(obs.FirstToken))
        }
        if tap.count(obs.ReasoningDelta) != 2 {
                t.Errorf("ReasoningDelta count = %d, want 2", tap.count(obs.ReasoningDelta))
        }
        if tap.count(obs.ContentDelta) != 1 {
                t.Errorf("ContentDelta count = %d, want 1", tap.count(obs.ContentDelta))
        }
        if tap.count(obs.ToolCallDelta) != 2 {
                t.Errorf("ToolCallDelta count = %d, want 2 (the two fragments)", tap.count(obs.ToolCallDelta))
        }
        fin := tap.event(obs.Finish)
        if fin.Kind == "" {
                t.Fatal("Finish event missing")
        }
        if fin.Data["finish_reason"] != "stop" || fin.Data["output_cut"] != false {
                t.Errorf("Finish verdict wrong: %+v", fin.Data)
        }
        if fin.Data["input_tokens"] != 11 || fin.Data["output_tokens"] != 7 {
                t.Errorf("Finish usage wrong: %+v", fin.Data)
        }
        if fin.Data["reasoning_deltas"] != 2 || fin.Data["content_deltas"] != 1 || fin.Data["tool_call_deltas"] != 2 {
                t.Errorf("Finish tallies wrong: %+v", fin.Data)
        }
        if fin.SessionID != "sess-trace" {
                t.Errorf("session not on the event: %q", fin.SessionID)
        }
        // gate 1: heads, not full text
        rd := tap.event(obs.ReasoningDelta)
        if head, _ := rd.Data["head"].(string); len(head) == 0 || len(head) > 70 {
                t.Errorf("ReasoningDelta head wrong: %q", head)
        }
        if _, hasFull := rd.Data["text"]; hasFull {
                t.Errorf("gate 1 must not carry full text")
        }
}

func TestV1144_GateZeroKeepsCounts(t *testing.T) {
        obs.SetDeltaTraceForTest(0)
        defer obs.SetDeltaTraceForTest(-1)

        tap := newEventTap()
        defer tap.unsub()

        srv := traceStub()
        defer srv.Close()

        ch := make(chan ChatChunk, 64)
        req := ChatRequest{
                Model: "trace-model", Provider: "traceprov", SessionID: "sess-gate0",
                BaseURL: srv.URL, Messages: []Message{{Role: "user", Content: "go"}},
        }
        _, _, err := scanSSECollect(context.Background(), req, nil, ch, nil)
        close(ch)
        if err != nil {
                t.Fatalf("scanSSECollect: %v", err)
        }
        if tap.count(obs.ReasoningDelta) != 0 || tap.count(obs.ContentDelta) != 0 {
                t.Errorf("gate 0 must drop delta events")
        }
        fin := tap.event(obs.Finish)
        if fin.Data["reasoning_deltas"] != 2 || fin.Data["content_deltas"] != 1 {
                t.Errorf("gate 0 keeps the tallies on Finish: %+v", fin.Data)
        }
}
