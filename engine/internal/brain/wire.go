// wire.go — v1.76.1 THE PATIENT BRIDGE WIRE (PLAN-V176).
//
// The reusable component layer for the local brain bridge: env-knobbed
// timeouts + one http.Client factory. Every network-facing method on Brain
// draws its client from HERE — never http.DefaultClient (which waits
// forever: a zero-value timeout is a bug, live-convicted by the Wi-Fi
// black-hole class where the local brain's own provider call stalls and
// nothing in the bridge ever gives up).
//
// Shapes (one factory, three users — the remote-twin convention of
// per-call construction, so knobs are read live and tests inject clients):
//
//	probe  — total timeout, DisableKeepAlives (a stale pooled socket must
//	         never answer a health check with a false positive)
//	models — total timeout (one bounded JSON fetch)
//	chat   — NO total timeout (a long streaming AI answer is legitimate),
//	         ResponseHeaderTimeout instead: if the brain never even starts
//	         replying, the request fails cleanly instead of hanging forever
//
// Knobs are seconds, mirroring stallKillSeconds (DOOMALAY_HF_STALL_KILL):
// integer seconds via env, invalid/absent → the documented default.
package brain

import (
        "net/http"
        "os"
        "strconv"
        "strings"
        "time"
)

// Env knobs (seconds; ""/invalid → default).
const (
        knobProbeTimeout  = "DOOMALAY_BRAIN_PROBE_TIMEOUT"  // health probes, default 10
        knobHeaderTimeout = "DOOMALAY_BRAIN_HEADER_TIMEOUT" // chat response-start, default 30
        knobStallKill     = "DOOMALAY_BRAIN_STALL_KILL"    // v1.76.2 stream watchdog, default 45, 0 = disabled
        knobBootTimeout   = "DOOMALAY_BRAIN_BOOT_TIMEOUT"   // v1.76.5 startup health window, default 10
)

// Defaults (documented in PLAN-V176; the 45s stall sits 20s above the
// brain's own 25s progress heartbeat — agent.py v0.76.6 — so slow
// multi-minute tool turns never trip it; only a frozen stream does).
const (
        defaultProbeTimeoutSecs  = 10
        defaultHeaderTimeoutSecs = 30
        defaultStallKillSecs     = 45
        defaultBootTimeoutSecs    = 10
)

// brainKnobSeconds reads an integer-seconds env knob; absent, invalid, or
// negative → def. (0 is a meaningful value only where documented — the
// stall kill's "disabled".)
func brainKnobSeconds(env string, def int) int {
        if v := os.Getenv(env); v != "" {
                if n, err := strconv.Atoi(strings.TrimSpace(v)); err == nil && n >= 0 {
                        return n
                }
        }
        return def
}

func brainProbeTimeout() time.Duration {
        return time.Duration(brainKnobSeconds(knobProbeTimeout, defaultProbeTimeoutSecs)) * time.Second
}

func brainHeaderTimeout() time.Duration {
        return time.Duration(brainKnobSeconds(knobHeaderTimeout, defaultHeaderTimeoutSecs)) * time.Second
}

// brainStallKill returns seconds; 0 = the watchdog is disabled (the pure
// v0.80.1 no-kill mode, opt-in for turns that must never be cut).
func brainStallKill() int {
        return brainKnobSeconds(knobStallKill, defaultStallKillSecs)
}

func brainBootTimeout() time.Duration {
        return time.Duration(brainKnobSeconds(knobBootTimeout, defaultBootTimeoutSecs)) * time.Second
}

// brainClientOptions shapes one dedicated brain client.
type brainClientOptions struct {
        totalTimeout      time.Duration // whole-request cap; 0 = none (streaming)
        headerTimeout     time.Duration // cap on waiting for response headers
        disableKeepAlives bool          // probes: never reuse a socket
}

// newBrainClient builds one client off a DefaultTransport clone (keeps the
// stdlib's proxy/HTTP2 defaults) with the phase-specific timeouts applied.
func newBrainClient(o brainClientOptions) *http.Client {
        tr := http.DefaultTransport.(*http.Transport).Clone()
        if o.headerTimeout > 0 {
                tr.ResponseHeaderTimeout = o.headerTimeout
        }
        tr.DisableKeepAlives = o.disableKeepAlives
        return &http.Client{Transport: tr, Timeout: o.totalTimeout}
}

// The three production shapes (one truth each; Brain fields override for
// tests — the injection seam).

func newBrainProbeClient() *http.Client {
        return newBrainClient(brainClientOptions{
                totalTimeout:      brainProbeTimeout(),
                disableKeepAlives: true,
        })
}

func newBrainModelsClient() *http.Client {
        return newBrainClient(brainClientOptions{totalTimeout: brainProbeTimeout()})
}

func newBrainChatClient() *http.Client {
        return newBrainClient(brainClientOptions{headerTimeout: brainHeaderTimeout()})
}

// probeClient / modelsClient / chatClient resolve the client for a call:
// the Brain's injected override when present (tests), else the production
// shape (built per call, knobs read live — the remote-twin convention).
func (b *Brain) probeClient() *http.Client {
        if b != nil && b.probeCli != nil {
                return b.probeCli
        }
        return newBrainProbeClient()
}

func (b *Brain) modelsClient() *http.Client {
        if b != nil && b.modelsCli != nil {
                return b.modelsCli
        }
        return newBrainModelsClient()
}

func (b *Brain) chatClient() *http.Client {
        if b != nil && b.chatCli != nil {
                return b.chatCli
        }
        return newBrainChatClient()
}
