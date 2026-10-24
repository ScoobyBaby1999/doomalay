package server

// v1731 pins — v1.73.1 THE NET ARM (PLAN-V173 §v1.73.1):
// the timer handler picks up NETWORK interrupts through the serve path.
// The conviction: ocServeFailEvents knew ONLY the 429 class — a net
// interrupt (the phone's egress dies mid-turn; the serve's provider call
// answers ECONNRESET / timeout / DNS / undici's "fetch failed") landed as
// a bare oc_bridge_error with NO retry_class, so the chat never joined
// the continuation timer, no visual queue, no auto-continue. The user's
// report verbatim: "our timer handler doesn't pick up network interrupts
// and add the chat to the continuation timer with a visual queue or
// hint."
//
// The fix: ONE truth with the turn-level ladder — netx.IsTransient (the
// same regex that runs the pause ladder, now carrying the Node/undici
// forms) plus the gateway statuses 502/503/504. Auth/stall/interrupted
// never arm (their own laws: the v1.71.2 recycle owns the stall; a stop
// is a stop; auth is auth). The 429 class still wins the ordering.

import (
	"strings"
	"testing"

	"github.com/ScoobyBaby1999/doomalay/engine/internal/netx"
)

// TestV1731_NetInterruptArms — a serve-side network failure carries the
// sentinel's machine fields + the visible arm line (the net wording).
func TestV1731_NetInterruptArms(t *testing.T) {
	events := ocServeFailEvents("chat", "provider.error", "fetch failed: getaddrinfo ENOTFOUND api.opencode.ai: Temporary failure in name resolution", 0)
	if len(events) != 3 {
		t.Fatalf("the net path prepends the arm's progress line (3 events) — got %d", len(events))
	}
	if events[0]["type"] != "progress" {
		t.Fatalf("the FIRST event must be the visible arm line: %v", events[0]["type"])
	}
	if msg, _ := events[0]["message"].(string); !strings.Contains(msg, "network interrupted") || !strings.Contains(msg, "no tap needed") {
		t.Fatalf("the net arm line names the signal + the auto-continue: %v", events[0]["message"])
	}
	errEv := events[1]
	if errEv["retry_class"] != "net" || errEv["retry_provider"] != "opencode" {
		t.Fatalf("the error carries the sentinel fields (net|opencode): %v", errEv)
	}
	if errEv["error"] != "oc_bridge_error" {
		t.Fatalf("the kind stays the honest bridge error (the message carries the truth): %v", errEv["error"])
	}
	if events[2]["state"] != "error" {
		t.Fatalf("the terminal must be the error state: %v", events[2]["state"])
	}
}

// TestV1731_TransportForms — every real-world net shape classifies:
// Go-side forms, Node/undici forms, the raw errno codes.
func TestV1731_TransportForms(t *testing.T) {
	netMessages := []string{
		"fetch failed",                               // undici's generic net-level TypeError
		"read ECONNRESET",                            // the errno form
		"connect ETIMEDOUT 140.82.121.5:443",         // the errno timeout form
		"getaddrinfo ENOTFOUND api.opencode.ai",      // Node DNS miss
		"getaddrinfo EAI_AGAIN api.opencode.ai",      // Node DNS again-later
		"socket hang up",                             // Node's mid-stream drop
		"unexpected EOF",                             // the live-convicted Go form
		"dial tcp 140.82.121.5:443: i/o timeout",     // the device chatlog form
		"context deadline exceeded (Client.Timeout)", // the kenny form
		"connection reset by peer",                   // the TLS bad-record cousin
		"resolve raw.githubusercontent.com: no address",
	}
	for _, m := range netMessages {
		events := ocServeFailEvents("chat", "provider.error", m, 0)
		if len(events) != 3 || events[1]["retry_class"] != "net" {
			t.Fatalf("net-class message %q must arm (net): %v", m, events)
		}
	}
	// the gateway statuses with a NEUTRAL message (the status branch is the
	// only matcher for 504) — 502/503/504 are the RFC gateway classes.
	for _, st := range []int{502, 503, 504} {
		events := ocServeFailEvents("chat", "provider.error", "upstream error", st)
		if len(events) != 3 || events[1]["retry_class"] != "net" {
			t.Fatalf("gateway status %d must arm (net): %v", st, events)
		}
	}
}

// TestV1731_NeverArms — auth / stall / interrupted / non-net messages
// never arm (their own laws; the v1672 stall pin keeps its truth).
func TestV1731_NeverArms(t *testing.T) {
	cases := []struct {
		kind, msg string
		status    int
	}{
		{"provider.auth", "OpenCode rejected the bridge key", 401},
		{"oc_stalled", "the turn stalled — no output for 5 minute(s)", 0},
		{"interrupted", "the turn was interrupted on the serve", 0},
		{"provider.error", "model not found for account", 404},
		{"provider.error", "you have exceeded your organization's monthly limit of 1000000 prompt tokens", 401},
		{"provider.error", "invalid api key", 401},
	}
	for _, c := range cases {
		events := ocServeFailEvents("chat", c.kind, c.msg, c.status)
		for _, e := range events {
			if _, has := e["retry_class"]; has {
				t.Fatalf("%q (kind %q, status %d) must NEVER arm: %v", c.msg, c.kind, c.status, e)
			}
		}
	}
}

// TestV1731_Ordering429Wins — a message that reads rate-limited stays the
// 429 class (the net branch never overrides the quota verdict).
func TestV1731_Ordering429Wins(t *testing.T) {
	events := ocServeFailEvents("chat", "provider.error", "rate limit exceeded upstream (HTTP 503)", 429)
	if len(events) != 3 || events[1]["retry_class"] != "429" {
		t.Fatalf("the 429 verdict wins the ordering: %v", events)
	}
	if msg, _ := events[0]["message"].(string); !strings.Contains(msg, "rate-limited") {
		t.Fatalf("the 429 arm line keeps its wording: %v", events[0]["message"])
	}
}

// TestV1731_NetxNodeForms — netx.IsTransient (the ONE truth) carries the
// Node/undici forms; the validation classes never match.
func TestV1731_NetxNodeForms(t *testing.T) {
	for _, m := range []string{
		"fetch failed", "read ECONNRESET", "connect ETIMEDOUT", "socket hang up",
		"getaddrinfo ENOTFOUND api.opencode.ai", "getaddrinfo EAI_AGAIN api.opencode.ai",
		"connect ECONNREFUSED 127.0.0.1:443",
	} {
		if !netx.IsTransient(jsonErr(m)) {
			t.Fatalf("netx.IsTransient must carry the Node forms: %q", m)
		}
	}
	for _, m := range []string{
		"invalid api key", "model not found for account", "you have exceeded your organization's monthly limit",
		"this model is not available in your region", "unsupported parameter",
	} {
		if netx.IsTransient(jsonErr(m)) {
			t.Fatalf("a validation class must never match as transient: %q", m)
		}
	}
}

// TestV1731_SentinelAcceptsNetClass — the sentinel arms + pills the net
// class through the same machinery the fail events feed (chat.go's
// retry_class switch); the pill is the visual queue.
func TestV1731_SentinelAcceptsNetClass(t *testing.T) {
	s, sid := newSentinelServer(t)
	rs := s.sentinelFor()
	rs.Arm(sid, "opencode", "net", 0, "")
	pills := sentinelPills(t, s, sid)
	if !hasPill(pills, "armed") {
		t.Fatalf("the net arm must land the visible pill (the queue/hint): %v", pills)
	}
	var class, provider string
	for _, p := range pills {
		if c, _ := p["class"].(string); c == "net" {
			class = "net"
			if pr, _ := p["provider"].(string); pr != "" {
				provider = pr
			}
		}
	}
	if class != "net" || provider != "opencode" {
		t.Fatalf("the pill must carry the net|opencode signal: %v", pills)
	}
	// the arming switch the events feed (source law — the live pin is the
	// rig's LEG A: the probe succeeds → the auto-continue fires, no tap).
	src := srcOf(t, "chat.go")
	// v1.74.5 THE ORDER LAW renamed the locals (the arm moved below the
	// error row's persist); the switch still feeds the generic arm.
	if !strings.Contains(src, `s.sentinelFor().Arm(sessionID, armProv, armClass, armRA, "")`) {
		t.Fatalf("the retry_class switch must feed the sentinel (the generic arm)")
	}
}

// jsonErr wraps a message as an error (netx reads .Error()).
func jsonErr(msg string) error {
	return &netTestErr{msg}
}

type netTestErr struct{ s string }

func (e *netTestErr) Error() string { return e.s }
