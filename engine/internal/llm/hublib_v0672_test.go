package llm

// hublib_v0672_test.go — v0.67.2 THE LIBRARY ON THE DIRECT PATH, v1.13.3
// THE GUT edition. Locks in the mechanical facts the quick-chat library
// needs:
//
//  1. MANIFEST GATING: a request with HublibToolFn armed carries the
//     hublib tool in the mcpbus manifest; one without does not (the
//     model can't call a tool it was never offered).
//  2. ACTION ROUTING: a hublib call routes the raw argJSON to the armed
//     Fn (the direct-dispatch fallback path), returns its OBSERVATION
//     verbatim, and emits the tool_use/tool_result chunks (the pills).
//     (The MCP bus path carries the same contract — mcpbus_test.go.)
//
// (v1.13.3: the ALIAS CANONICALIZATION test died with the alias layer —
// native tool_calls carry exact manifest names; a hallucinated name gets
// the honest unknown-tool teaching and self-corrects in one round.)

import (
	"context"
	"strings"
	"testing"

	"github.com/ScoobyBaby1999/doomalay/engine/internal/mcpbus"
)

func TestHublibManifestGatesOnArmed(t *testing.T) {
	armed := ChatRequest{
		Provider:     "nvidia",
		Messages:     []Message{{Role: "user", Content: "find me a research skill"}},
		HublibToolFn: func(ctx context.Context, argJSON string) string { return "OBSERVATION:\nok" },
	}
	specs := mcpbus.SpecsFor(mcpGates(armed))
	found := false
	for _, s := range specs {
		fn, _ := s["function"].(map[string]any)
		if fn != nil && fn["name"] == "hublib" {
			found = true
			if !strings.Contains(fn["description"].(string), "PUBLIC HUB") {
				t.Fatalf("hublib description drifted")
			}
		}
	}
	if !found {
		t.Fatalf("armed request must advertise the hublib tool")
	}

	unarmed := ChatRequest{Provider: "nvidia", Messages: []Message{{Role: "user", Content: "hi"}}}
	for _, s := range mcpbus.SpecsFor(mcpGates(unarmed)) {
		fn, _ := s["function"].(map[string]any)
		if fn != nil && fn["name"] == "hublib" {
			t.Fatalf("unarmed request must NOT advertise the hublib tool")
		}
	}
}

func TestHublibActionRoutesToFn(t *testing.T) {
	called := ""
	ch := make(chan ChatChunk, 8)
	req := ChatRequest{
		Provider: "nvidia",
		Messages: []Message{{Role: "user", Content: "hi"}},
		HublibToolFn: func(ctx context.Context, argJSON string) string {
			called = argJSON
			return "OBSERVATION:\nHUB SKILLS: - one item"
		},
	}
	// the direct-dispatch runner (the bus fallback path's executor).
	obs := executeAction(context.Background(), req, ch, "hublib", `{"action":"search","q":"research"}`, &[]SearchResult{})
	close(ch)
	if called != `{"action":"search","q":"research"}` {
		t.Fatalf("hublib must route the raw argJSON to the Fn; Fn saw %q", called)
	}
	if !strings.Contains(obs, "HUB SKILLS") {
		t.Fatalf("the Fn's observation must ride back verbatim; got %q", obs)
	}
	// the tool_use/tool_result chunks (the chat pills) both fired.
	sawUse, sawRes := false, false
	for c := range ch {
		if c.Type == "tool_use" && c.Name == "hublib" {
			sawUse = true
		}
		if c.Type == "tool_result" && c.Name == "hublib" {
			sawRes = true
		}
	}
	if !sawUse || !sawRes {
		t.Fatalf("hublib must emit tool_use + tool_result chunks (pills); use=%v res=%v", sawUse, sawRes)
	}
}

func TestHublibUnarmedDoesNotRun(t *testing.T) {
	// an unarmed request naming hublib gets the honest unknown-tool
	// observation — the Fn is nil, nothing runs.
	ch := make(chan ChatChunk, 8)
	req := ChatRequest{Provider: "nvidia", Messages: []Message{{Role: "user", Content: "hi"}}}
	obs := executeAction(context.Background(), req, ch, "hublib", "{}", &[]SearchResult{})
	close(ch)
	if strings.Contains(obs, "HUB SKILLS") {
		t.Fatalf("unarmed hublib must not run anything")
	}
	if !strings.Contains(obs, "error") {
		t.Fatalf("unarmed hublib must answer with the honest error observation; got %q", obs)
	}
}
