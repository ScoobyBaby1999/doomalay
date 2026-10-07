package llm

// workspacetool_test.go — v0.76.5 THE WORKSPACE HAND ON THE DIRECT PATH.
// Locks in the two mechanical composition facts:
//
//  1. MANIFEST GATING: a request with WorkspaceToolFn armed carries the
//     workspace tool in the mcpbus manifest; one without does not.
//  2. THE MANIFEST BLOCK: WorkspaceManifest rides the system message
//     (runNativeToolsTurn prepends it) and stays absent when empty.

import (
	"context"

	"github.com/ScoobyBaby1999/doomalay/engine/internal/mcpbus"
	"strings"
	"testing"
)

func TestV765WorkspaceManifestGatesOnArmed(t *testing.T) {
	// v1.13.3 THE GUT: the protocol-prose composition died with the
	// ACTION parser; the mcpbus manifest now carries the gating — the
	// workspace tool rides the tools[] manifest only when the server
	// armed the closure, with the write verbs in its description.
	armed := ChatRequest{
		Provider:        "nvidia",
		Messages:        []Message{{Role: "user", Content: "push a file to my repo"}},
		WorkspaceToolFn: func(ctx context.Context, argJSON string) string { return "OBSERVATION:\nok" },
	}
	found := false
	for _, s := range mcpbus.SpecsFor(mcpGates(armed)) {
		fn, _ := s["function"].(map[string]any)
		if fn != nil && fn["name"] == "workspace" {
			found = true
			desc := fn["description"].(string)
			if !strings.Contains(desc, "put") || !strings.Contains(desc, "pr") {
				t.Fatalf("the write verbs (put/pr) must ride the workspace description")
			}
			// the manifest block rides the SYSTEM message (runNativeToolsTurn prepends
			// req.WorkspaceManifest) — the model reads repos before tools.
		}
	}
	if !found {
		t.Fatalf("armed request must advertise the workspace tool")
	}

	unarmed := ChatRequest{
		Provider: "nvidia",
		Messages: []Message{{Role: "user", Content: "hi"}},
	}
	for _, s := range mcpbus.SpecsFor(mcpGates(unarmed)) {
		fn, _ := s["function"].(map[string]any)
		if fn != nil && fn["name"] == "workspace" {
			t.Fatalf("unarmed request must NOT advertise the workspace tool")
		}
	}
}
