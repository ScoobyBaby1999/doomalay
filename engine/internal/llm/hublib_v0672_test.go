package llm

// hublib_v0672_test.go — v0.67.2 THE LIBRARY ON THE DIRECT PATH.
// Locks in the three mechanical facts the quick-chat library needs:
//
//  1. PROTOCOL COMPOSITION: a request with HublibToolFn armed carries
//     the hublib ACTION protocol in its composed turn system; one
//     without does not (the model can't call a tool it was never
//     offered).
//  2. ALIAS CANONICALIZATION: "library"/"hub"/"browse_library"… map to
//     the hublib tool (the models' natural names for it), while the
//     template-specific aliases stay template tools.
//  3. ACTION ROUTING: "ACTION: hublib {…}" routes the raw argJSON to
//     the armed Fn, returns its OBSERVATION verbatim, and emits the
//     tool_use/tool_result chunks (the chat pills).

import (
	"context"
	"strings"
	"testing"
)

func TestHublibProtocolComposesWhenArmed(t *testing.T) {
	armed := ChatRequest{
		Provider:     "nvidia",
		Messages:     []Message{{Role: "user", Content: "hi"}},
		HublibToolFn: func(ctx context.Context, argJSON string) string { return "OBSERVATION:\nok" },
	}
	sys := composeTurnSystem(armed)
	if !strings.Contains(sys, "ACTION: hublib") {
		t.Fatalf("armed request must carry the hublib ACTION protocol; got system prompt:\n%.400s", sys)
	}
	if !strings.Contains(sys, "Be opportunistic") {
		t.Fatalf("the opportunistic discipline must ride the hublib protocol")
	}

	unarmed := ChatRequest{
		Provider: "nvidia",
		Messages: []Message{{Role: "user", Content: "hi"}},
	}
	sys2 := composeTurnSystem(unarmed)
	if strings.Contains(sys2, "ACTION: hublib") {
		t.Fatalf("unarmed request must NOT advertise the hublib tool")
	}
}

func TestHublibAliasCanonicalization(t *testing.T) {
	for _, alias := range []string{"library", "hub", "public_hub", "hub_library", "browse_hub", "browse_library", "search_library"} {
		if got := canonicalToolName(alias); got != "hublib" {
			t.Fatalf("alias %q must canonicalize to hublib, got %q", alias, got)
		}
	}
	// the template-specific aliases stay template tools.
	for _, alias := range []string{"templates", "list_templates", "template_library"} {
		if got := canonicalToolName(alias); got != "template_list" {
			t.Fatalf("template alias %q must stay template_list, got %q", alias, got)
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
	// the ACTION runner path used by the ReAct loop.
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
