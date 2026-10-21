package llm

// chat_v1521_test.go — v1.52.1 THE DNS RUNG pins.
//
// The trippy (2).md log (Oct 21, glm-5.3-flash @ nvidia) convicted the DNS
// class as terminal: the device's resolver (system + DNS-over-HTTPS) dropped
// for ~3 minutes and the SAME user message died 5 consecutive times with
//   netx: no address for "integrate.api.nvidia.com" (system resolver and
//   DNS-over-HTTPS both failed)
// every one of them an instant terminal error — the pause ladder never ran,
// the user re-sent 5 times (the duplication bug v1.52.2 fixes), and the
// transcript filled with raw transport JSON. DNS death on a phone is a
// walking outage; the ladder's fresh dial is the documented cure.

import "testing"

// TestV1521_DNSClassIsTransient — the exact strings from the user's log (and
// the standard Go resolver shapes) classify as TRANSIENT so the pause ladder
// retries them; auth/protocol errors still never do.
func TestV1521_DNSClassIsTransient(t *testing.T) {
        // the verbatim trippy-log shapes
        live := `netx: no address for "integrate.api.nvidia.com" (system resolver and DNS-over-HTTPS both failed)`
        if !isTransientNetErr(contextStringError(live)) {
                t.Fatal("the trippy log's verbatim DNS death must classify as transient — the ladder must own it")
        }
        for _, s := range []string{
                `Post "https://integrate.api.nvidia.com/v1/chat/completions": netx: no address for "integrate.api.nvidia.com" (system resolver and DNS-over-HTTPS both failed)`,
                `dial tcp: lookup integrate.api.nvidia.com: no such host`,
                `dial tcp: lookup api.mistral.ai on 10.0.2.3:53: server misbehaving`,
                `lookup api.openai.com: SERVFAIL`,
                `request failed: send: netx: no address for "openrouter.ai" (system resolver and DNS-over-HTTPS both failed)`,
        } {
                if !isTransientNetErrorString(s) {
                        t.Fatalf("DNS-class error must be transient: %q", s)
                }
        }
        // the non-transient classes stay non-transient (the v0.93.2 law holds)
        for _, s := range []string{
                `401: invalid api key`,
                `404: this model is no longer available`,
                `400: bad request shape`,
        } {
                if isTransientNetErrorString(s) {
                        t.Fatalf("auth/protocol error must stay terminal: %q", s)
                }
        }
}
