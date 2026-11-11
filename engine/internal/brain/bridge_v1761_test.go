package brain

// bridge_v1761_test.go — v1.76.1 THE PATIENT BRIDGE WIRE pins
// (PLAN-V176 §v1.76.1): the dedicated clients replace http.DefaultClient,
// Models rides netx.RetryDo (transient 5xx ladder survives, transport
// exhaustion flips the brain dead with the honest retried-Nx error),
// Chat wires MarkUnhealthy on transport failure and heals on a 200,
// and the probe client actually enforces its timeout.

import (
        "context"
        "fmt"
        "net"
        "net/http"
        "net/http/httptest"
        "strings"
        "sync"
        "testing"
        "time"
)

// deadPortV1761 returns a localhost URL whose port refuses connections
// (the "brain process died" transport class — the same shape as the live
// W5 redteam's dial tcp ::1:9090).
func deadPortV1761(t *testing.T) string {
        t.Helper()
        l, err := net.Listen("tcp", "127.0.0.1:0")
        if err != nil {
                t.Fatalf("listen: %v", err)
        }
        u := "http://" + l.Addr().String()
        _ = l.Close()
        return u
}

// TestV1761_ModelsRetriesTransient5xx — a 1-second-provider-hiccup-shaped
// 503 ladder must survive: two 503s then a 200 answers, with the provider
// keys riding every attempt (the per-attempt request builder is the only
// place they exist now).
func TestV1761_ModelsRetriesTransient5xx(t *testing.T) {
        var mu sync.Mutex
        hits := 0
        srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
                mu.Lock()
                hits++
                n := hits
                mu.Unlock()
                if r.Header.Get("X-Env-OPENROUTER_API_KEY") != "test-key-1" {
                        t.Errorf("X-Env header missing on attempt %d", n)
                }
                if n < 3 {
                        w.WriteHeader(503) // the transient class
                        return
                }
                w.Header().Set("Content-Type", "application/json")
                _, _ = w.Write([]byte(`{"providers":{},"totalModels":1}`))
        }))
        defer srv.Close()

        b := &Brain{url: srv.URL, healthy: true, env: map[string]string{"OPENROUTER_API_KEY": "test-key-1"}}
        out, err := b.Models(context.Background())
        if err != nil {
                t.Fatalf("Models after transient 5xx ladder: %v", err)
        }
        if got := string(out); !strings.Contains(got, "totalModels") {
                t.Fatalf("body = %s", got)
        }
        mu.Lock()
        defer mu.Unlock()
        if hits != modelsRetryAttempts {
                t.Fatalf("hits = %d, want %d (two 503s then the 200)", hits, modelsRetryAttempts)
        }
}

// TestV1761_ModelsMarksUnhealthyOnTransportDeath — every attempt refused =
// the brain is unreachable: the honest (retried Nx) error surfaces AND the
// flag flips (the v0.44.1 mechanism finally wired to its own failure class).
func TestV1761_ModelsMarksUnhealthyOnTransportDeath(t *testing.T) {
        b := &Brain{url: deadPortV1761(t), healthy: true}
        _, err := b.Models(context.Background())
        if err == nil {
                t.Fatal("dead port Models: want error")
        }
        if !strings.Contains(err.Error(), "retried") {
                t.Fatalf("error should carry the retried-Nx honesty, got: %v", err)
        }
        if b.Healthy() {
                t.Fatal("transport-exhausted Models must flip the brain unhealthy")
        }
}

// TestV1761_ModelsKeepsFlagOnAnswered5xx — a brain that ANSWERS with an
// error (non-200) is alive; the flag must NOT flip (the remote twin's
// split: transport death ≠ application error).
func TestV1761_ModelsKeepsFlagOnAnswered5xx(t *testing.T) {
        srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
                w.WriteHeader(http.StatusNotFound) // validation class: never retried, never flips
        }))
        defer srv.Close()

        b := &Brain{url: srv.URL, healthy: true}
        _, err := b.Models(context.Background())
        if err == nil {
                t.Fatal("404 Models: want error")
        }
        if !b.Healthy() {
                t.Fatal("an answered 404 must not flip the brain unhealthy")
        }
}

// TestV1761_ChatDoFailureMarksUnhealthy — the local twin of the remote
// brain's v0.46 law: transport failure on /chat flips the flag (the POST
// itself is never retried — THE NON-IDEMPOTENCE LAW).
func TestV1761_ChatDoFailureMarksUnhealthy(t *testing.T) {
        b := &Brain{url: deadPortV1761(t), healthy: true}
        _, _, err := b.Chat(context.Background(), map[string]any{"message": "hi"})
        if err == nil {
                t.Fatal("dead port Chat: want error")
        }
        if b.Healthy() {
                t.Fatal("Chat transport failure must flip the brain unhealthy")
        }
}

// TestV1761_ChatSuccessHeals — the heal race, modeled honestly: Chat
// gates on Healthy() up front, so the heal only ever fires when the brain
// flaps WHILE a turn is mid-flight (another call's transport failure
// flips the flag, this Chat's 200 answers later). The flag must return
// to healthy — without waiting for the 15s re-probe.
func TestV1761_ChatSuccessHeals(t *testing.T) {
        arrived := make(chan struct{})
        release := make(chan struct{})
        srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
                close(arrived) // the request is in flight — the gate has passed
                <-release
                w.Header().Set("Content-Type", "text/event-stream")
                fmt.Fprintf(w, "data: {\"type\":\"status\",\"state\":\"idle\"}\n\n")
                fmt.Fprintf(w, "data: [DONE]\n\n")
        }))
        defer srv.Close()

        b := &Brain{url: srv.URL, healthy: true}
        type res struct {
                events <-chan map[string]any
                errs    <-chan error
                err     error
        }
        out := make(chan res, 1)
        go func() {
                events, errs, err := b.Chat(context.Background(), map[string]any{"message": "hi"})
                out <- res{events, errs, err}
        }()

        <-arrived          // mid-flight…
        b.MarkUnhealthy()  // …another failure flips the flag (dead-port probe arms the 15s re-probe)
        if b.Healthy() {
                t.Fatal("mid-flight flap: flag must be false right after MarkUnhealthy")
        }
        close(release) // the brain answers 200

        r := <-out
        if r.err != nil {
                t.Fatalf("Chat: %v", r.err)
        }
        n := 0
        for range r.events {
                n++
        }
        if n != 1 {
                t.Fatalf("events = %d, want 1", n)
        }
        if e := <-r.errs; e != nil {
                t.Fatalf("errs = %v, want nil", e)
        }
        if !b.Healthy() {
                t.Fatal("the 200 answer must heal the flag without the re-probe")
        }
}

// TestV1761_ProbeRespectsTimeout — the probe client's timeout must
// actually apply: a black-holed /health (accepts, never answers) fails
// in milliseconds, not forever (the old bare http.Get hung on dead
// sockets). The injected client is the test seam.
func TestV1761_ProbeRespectsTimeout(t *testing.T) {
        srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
                time.Sleep(2 * time.Second) // black-hole: connection open, answer never comes
                w.WriteHeader(200)
        }))
        defer srv.Close()

        b := &Brain{url: srv.URL, healthy: false, probeCli: &http.Client{Timeout: 100 * time.Millisecond}}
        start := time.Now()
        if b.probeHealth() {
                t.Fatal("black-holed probe must fail, not answer")
        }
        if el := time.Since(start); el > time.Second {
                t.Fatalf("probe took %s — the client timeout never applied", el)
        }
}

// TestV1761_WaitHealthyFailsFastOnDeadPort — the boot-time health window
// polls through the dedicated probe client (timeout per attempt).
func TestV1761_WaitHealthyFailsFastOnDeadPort(t *testing.T) {
        b := &Brain{url: deadPortV1761(t), healthy: false, probeCli: &http.Client{Timeout: 50 * time.Millisecond}}
        if err := b.waitHealthy(300 * time.Millisecond); err == nil {
                t.Fatal("dead port: want health-wait error")
        }
}

// TestV1761_WaitHealthySucceedsOnLiveBrain — the live shape still boots
// (same happy path as before, now through the probe client).
func TestV1761_WaitHealthySucceedsOnLiveBrain(t *testing.T) {
        srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
                w.WriteHeader(200)
        }))
        defer srv.Close()

        b := &Brain{url: srv.URL, healthy: false}
        if err := b.waitHealthy(2 * time.Second); err != nil {
                t.Fatalf("live brain: %v", err)
        }
        if !b.Healthy() {
                t.Fatal("successful health wait must flip healthy")
        }
}

// TestV1761_KnobSeconds — the env-knob parsing law (stallKillSeconds
// convention): int seconds, absent/invalid/negative → default, 0 a
// meaningful value only where documented.
func TestV1761_KnobSeconds(t *testing.T) {
        const knob = "DOOMALAY_TEST_KNOB_V1761"
        if got := brainKnobSeconds(knob, 10); got != 10 {
                t.Fatalf("absent knob: got %d, want 10", got)
        }
        t.Setenv(knob, "7")
        if got := brainKnobSeconds(knob, 10); got != 7 {
                t.Fatalf("valid knob: got %d, want 7", got)
        }
        t.Setenv(knob, "0") // meaningful: the stall-kill disable
        if got := brainKnobSeconds(knob, 10); got != 0 {
                t.Fatalf("zero knob: got %d, want 0", got)
        }
        t.Setenv(knob, "not-a-number")
        if got := brainKnobSeconds(knob, 10); got != 10 {
                t.Fatalf("invalid knob: got %d, want 10", got)
        }
        t.Setenv(knob, "-3")
        if got := brainKnobSeconds(knob, 10); got != 10 {
                t.Fatalf("negative knob: got %d, want 10", got)
        }
}

// TestV1761_ProductionClientShapes — the three shapes: chat has NO total
// timeout (streaming is legitimate) but DOES have a header timeout; probe
// disables keep-alives; models carries a total timeout.
func TestV1761_ProductionClientShapes(t *testing.T) {
        chat := newBrainChatClient()
        if chat.Timeout != 0 {
                t.Fatalf("chat client total timeout = %s, must be 0 (streaming)", chat.Timeout)
        }
        tr, ok := chat.Transport.(*http.Transport)
        if !ok || tr.ResponseHeaderTimeout != brainHeaderTimeout() {
                t.Fatalf("chat client must carry ResponseHeaderTimeout=%s", brainHeaderTimeout())
        }
        probe := newBrainProbeClient()
        if probe.Timeout != brainProbeTimeout() {
                t.Fatalf("probe timeout = %s, want %s", probe.Timeout, brainProbeTimeout())
        }
        if ptr, ok := probe.Transport.(*http.Transport); !ok || !ptr.DisableKeepAlives {
                t.Fatal("probe client must disable keep-alives (stale sockets must never answer health)")
        }
        models := newBrainModelsClient()
        if models.Timeout != brainProbeTimeout() {
                t.Fatalf("models timeout = %s, want %s", models.Timeout, brainProbeTimeout())
        }
}

// TestV1761_ClientSeams — injected clients win; nil falls back to the
// production shapes.
func TestV1761_ClientSeams(t *testing.T) {
        injected := &http.Client{Timeout: time.Second}
        b := &Brain{url: "http://127.0.0.1:1", probeCli: injected, chatCli: injected, modelsCli: injected}
        if b.probeClient() != injected || b.chatClient() != injected || b.modelsClient() != injected {
                t.Fatal("injected clients must win")
        }
        b2 := &Brain{url: "http://127.0.0.1:1"}
        if b2.probeClient().Timeout != brainProbeTimeout() {
                t.Fatal("nil seam must fall back to the production probe shape")
        }
}
