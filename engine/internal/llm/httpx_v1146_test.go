// v1.14.6 THE SOLID STREAM — the cross-bot leak regression pins.
//
// The user hit tools generating for all bots of the same provider across
// relatively fresh chats. Root cause: opencodeSessionID was scoped PER API
// KEY — every chat sharing a key shared one upstream Zen session identity
// (x-session-id), so one chat's context bled into the others'. These tests
// pin the per-chat scope: unique per session id, stable per session,
// per-key fallback only for sessionless (probe) paths.
package llm

import "testing"

func TestOpencodeSessionIDPerChatScope(t *testing.T) {
	// Two chats, one key → DIFFERENT upstream session identities.
	a := opencodeSessionID("chat:session-aaa")
	b := opencodeSessionID("chat:session-bbb")
	if a == b {
		t.Fatalf("two chats on one key share an upstream session id: %q", a)
	}

	// Same chat → stable identity (restart-safe by construction: the scope
	// is the DB session id, deterministic sha256 — pin that determinism).
	if a != opencodeSessionID("chat:session-aaa") {
		t.Fatalf("per-chat id not stable for the same session")
	}

	// Sessionless paths (probes) keep the legacy per-key identity, stable.
	p1 := opencodeSessionID("key:sk-test")
	p2 := opencodeSessionID("key:sk-test")
	if p1 != p2 {
		t.Fatalf("probe path lost its per-key stability: %q vs %q", p1, p2)
	}
	if p1 == a {
		t.Fatalf("probe identity collided with a chat identity")
	}

	// Different keys on the sessionless path never collide either.
	if p1 == opencodeSessionID("key:sk-other") {
		t.Fatalf("probe ids collide across keys")
	}
}

func TestProviderExtraHeadersOpencodeScope(t *testing.T) {
	// The header builder routes the chat's session id into the per-chat
	// scope and the empty id into the per-key fallback.
	h1 := providerExtraHeaders("opencode", "sk-test", "session-aaa")
	h2 := providerExtraHeaders("opencode", "sk-test", "session-bbb")
	hp := providerExtraHeaders("opencode", "sk-test", "")

	if h1["x-session-id"] == "" || h2["x-session-id"] == "" || hp["x-session-id"] == "" {
		t.Fatalf("x-session-id missing from a header set: %q %q %q",
			h1["x-session-id"], h2["x-session-id"], hp["x-session-id"])
	}
	if h1["x-session-id"] == h2["x-session-id"] {
		t.Fatalf("two chats on one key share x-session-id %q — the leak shape", h1["x-session-id"])
	}
	if h1["x-session-id"] == hp["x-session-id"] {
		t.Fatalf("chat header collided with the probe fallback id")
	}

	// The v0.35 authentic identity set still rides along.
	for _, k := range []string{"User-Agent", "x-opencode-client", "x-opencode-project", "x-opencode-session", "x-opencode-request"} {
		if h1[k] == "" {
			t.Fatalf("opencode header %q went missing", k)
		}
	}

	// Non-opencode providers still get nothing.
	if got := providerExtraHeaders("nvidia", "nvapi-x", "session-aaa"); got != nil {
		t.Fatalf("non-opencode provider got extra headers: %v", got)
	}
}
