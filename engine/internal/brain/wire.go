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
//      probe  — total timeout, DisableKeepAlives (a stale pooled socket must
//               never answer a health check with a false positive)
//      models — total timeout (one bounded JSON fetch)
//      chat   — NO total timeout (a long streaming AI answer is legitimate),
//               ResponseHeaderTimeout instead: if the brain never even starts
//               replying, the request fails cleanly instead of hanging forever
//
// Knobs are seconds, mirroring stallKillSeconds (DOOMALAY_HF_STALL_KILL):
// integer seconds via env, invalid/absent → the documented default.
package brain

import (
        "errors"
        "io"
        "net/http"
        "os"
        "strconv"
        "strings"
        "sync/atomic"
        "time"
)

// ErrStreamStalled — the v1.76.2 stall sentinel. When the no-bytes
// watchdog kills a frozen SSE stream, this typed error (wrapped via %w,
// matched via errors.Is) rides the errs channel so the server layer can
// turn it into an honest, persisted error event instead of a dead
// spinner. Transport-level failures stay their own class.
var ErrStreamStalled = errors.New("brain stream stalled")

// streamWatchdog — the no-BYTES stall sentinel (v1.76.2, PLAN-V176
// §v1.76.2). The Python side deliberately has no kill (the v0.80.1
// no-kill law, litellm timeout=86400) — the engine is the only place a
// watchdog can live. The remote twin got one in v1.10.2 (guardFirstByte,
// the first-byte class); the local bridge now gets the between-bytes
// class: a stream that produced NOTHING for the whole window is a frozen
// connection (the brain's own 25s progress heartbeat — agent.py v0.76.6 —
// keeps healthy multi-minute tool turns 20s clear of the 45s default).
type streamWatchdog struct {
        timeout time.Duration
        onTrip  func()
        fed     chan struct{}
        stop    chan struct{}
        tripped atomic.Bool
}

// newStreamWatchdog arms the sentinel; onTrip fires (once) the instant the
// timeout elapses with no feed. feed resets the window; stop releases the
// goroutine. Byte-level discipline is the CALLER's law — feed on every
// Read that returns n > 0 (see feedReader): a slow-dripping long line is
// still a LIVE stream and must never trip it.
func newStreamWatchdog(timeout time.Duration, onTrip func()) *streamWatchdog {
        w := &streamWatchdog{
                timeout: timeout,
                onTrip:  onTrip,
                fed:     make(chan struct{}, 1),
                stop:    make(chan struct{}),
        }
        go func() {
                timer := time.NewTimer(w.timeout)
                defer timer.Stop()
                for {
                        select {
                        case <-w.stop:
                                return
                        case <-w.fed:
                                timer.Reset(w.timeout) // pending timer — the reset-only-in-this-goroutine law
                        case <-timer.C:
                                w.tripped.Store(true)
                                w.onTrip()
                                return
                        }
                }
        }()
        return w
}

// feed resets the stall window (coalescing: a pending feed signal is
// enough — byte storms never queue).
func (w *streamWatchdog) feed() {
        select {
        case w.fed <- struct{}{}:
        default:
        }
}

// didTrip reports whether the sentinel fired (used to classify the read
// error after the stream dies).
func (w *streamWatchdog) didTrip() bool { return w.tripped.Load() }

// kill releases the watchdog goroutine (stream end, [DONE], ctx done).
func (w *streamWatchdog) kill() { close(w.stop) }

// feedReader wraps a body so every Read that yields bytes feeds the
// watchdog — the byte-level (not line-level) honesty law: a 100KB tool
// result arriving 1KB at a time over a slow link is ALIVE, even though
// bufio.Scanner would not yield a single line until the last byte lands.
type feedReader struct {
        r    io.Reader
        feed func()
}

func newFeedReader(r io.Reader, feed func()) io.Reader {
        return &feedReader{r: r, feed: feed}
}

func (f *feedReader) Read(p []byte) (int, error) {
        n, err := f.r.Read(p)
        if n > 0 {
                f.feed()
        }
        return n, err
}

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
