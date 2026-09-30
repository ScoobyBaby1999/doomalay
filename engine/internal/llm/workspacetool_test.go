package llm

// workspacetool_test.go — v0.76.5 THE WORKSPACE HAND ON THE DIRECT PATH.
// Locks in the two mechanical composition facts:
//
//  1. PROTOCOL COMPOSITION: a request with WorkspaceToolFn armed carries
//     the workspace ACTION protocol; one without does not.
//  2. THE MANIFEST BLOCK: WorkspaceManifest prepends ABOVE the protocol
//     blocks (the brain twin's _build_system_prompt shape) and stays
//     absent when empty.

import (
	"context"
	"strings"
	"testing"
)

func TestV765WorkspaceProtocolComposesWhenArmed(t *testing.T) {
	armed := ChatRequest{
		Provider:        "nvidia",
		Messages:        []Message{{Role: "user", Content: "push a file to my repo"}},
		WorkspaceToolFn: func(ctx context.Context, argJSON string) string { return "OBSERVATION:\nok" },
		WorkspaceManifest: "CONNECTED CLOUD WORKSPACES (this chat's repos — act on them with the workspace tool):\n" +
			"- me/app [github] access=full (workspace ref: aaaa00000001 or 'me/app')",
	}
	sys := composeTurnSystem(armed)
	if !strings.Contains(sys, "ACTION: workspace") {
		t.Fatalf("armed request must carry the workspace ACTION protocol")
	}
	if !strings.Contains(sys, `"action": "put"`) || !strings.Contains(sys, `"action": "pr"`) {
		t.Fatalf("the write verbs (put/pr) must ride the protocol")
	}
	// the manifest block rides ABOVE the protocol (model reads repos first)
	if !strings.Contains(sys, "CONNECTED CLOUD WORKSPACES") {
		t.Fatalf("the manifest must compose into the turn system")
	}
	if strings.Index(sys, "CONNECTED CLOUD WORKSPACES") > strings.Index(sys, "ACTION: workspace") {
		t.Fatalf("the manifest must precede the ACTION protocol")
	}

	unarmed := ChatRequest{
		Provider: "nvidia",
		Messages: []Message{{Role: "user", Content: "hi"}},
	}
	sys2 := composeTurnSystem(unarmed)
	if strings.Contains(sys2, "ACTION: workspace") {
		t.Fatalf("unarmed request must NOT advertise the workspace tool")
	}
}
