package brain

// bridge_v1762_test.go — v1.76.2 THE STALL SENTINEL pins (PLAN-V176
// §v1.76.2): a stream that goes silent mid-turn dies cleanly at the knob
// (typed sentinel + MarkUnhealthy), 0 disables (the pure no-kill mode),
// heartbeats keep healthy slow turns alive, and BYTES — not lines — feed
// the watchdog (a slow-dripping long line is a live stream).

import (
        "context"
        "errors"
        "fmt"
        "net/http"
        "net/http/httptest"
        "testing"
        "time"
)

// TestV1762_StallKillsDeadStream — THE conviction shape: the brain streams
// one event, then the connection freezes (the provider black-hole class).
// The watchdog kills the stream at the knob, the typed sentinel rides errs,
// the channels close (no goroutine sleeps on a dead socket), and the brain
// flips dead for the quiet 15s re-probe.
func TestV1762_StallKillsDeadStream(t *testing.T) {
        t.Setenv("DOOMALAY_BRAIN_STALL_KILL", "1")
        hold := make(chan struct{})
        srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
                w.Header().Set("Content-Type", "text/event-stream")
                fmt.Fprintf(w, "data: {\"type\":\"thinking\",\"text\":\"one\"}\n\n")
                w.(http.Flusher).Flush()
                <-hold // the stream freezes mid-turn — no more bytes, ever
        }))
        defer srv.Close()
        defer close(hold)

        b := &Brain{url: srv.URL, healthy: true}
        events, errs, err := b.Chat(context.Background(), map[string]any{"message": "hi"})
        if err != nil {
                t.Fatalf("Chat: %v", err)
        }
        var got []map[string]any
        deadline := time.After(5 * time.Second)
        var stall error
        for events != nil || errs != nil {
                select {
                case ev, ok := <-events:
                        if !ok {
                                events = nil
                                continue
                        }
                        got = append(got, ev)
                case e, ok := <-errs:
                        if !ok {
                                errs = nil
                                continue
                        }
                        stall = e
                case <-deadline:
                        t.Fatal("the stall sentinel never fired — the stream hung forever (the old bug)")
                }
        }
        if len(got) != 1 {
                t.Fatalf("events = %d, want 1 (the frozen stream's only word)", len(got))
        }
        if !errors.Is(stall, ErrStreamStalled) {
                t.Fatalf("errs = %v, want the ErrStreamStalled sentinel", stall)
        }
        if b.Healthy() {
                t.Fatal("a stalled stream must flip the brain unhealthy for the quiet re-probe")
        }
}

// TestV1762_ZeroDisablesTheSentinel — 0 = the pure v0.80.1 no-kill mode:
// no watchdog, no sentinel; the parent ctx (the user's Stop) is the only
// canceller, and a user stop must NOT flip the brain dead.
func TestV1762_ZeroDisablesTheSentinel(t *testing.T) {
        t.Setenv("DOOMALAY_BRAIN_STALL_KILL", "0")
        hold := make(chan struct{})
        srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
                w.Header().Set("Content-Type", "text/event-stream")
                fmt.Fprintf(w, "data: {\"type\":\"thinking\",\"text\":\"one\"}\n\n")
                w.(http.Flusher).Flush()
                <-hold
        }))
        defer srv.Close()
        defer close(hold)

        b := &Brain{url: srv.URL, healthy: true}
        ctx, cancel := context.WithCancel(context.Background())
        events, errs, err := b.Chat(ctx, map[string]any{"message": "hi"})
        if err != nil {
                t.Fatalf("Chat: %v", err)
        }
        select {
        case <-events:
        case <-time.After(2 * time.Second):
                t.Fatal("first event never arrived")
        }
        cancel() // the user's Stop

        var streamErr error
        deadline := time.After(3 * time.Second)
        for events != nil || errs != nil {
                select {
                case _, ok := <-events:
                        if !ok {
                                events = nil
                                continue
                        }
                case e, ok := <-errs:
                        if !ok {
                                errs = nil
                                continue
                        }
                        streamErr = e
                case <-deadline:
                        t.Fatal("ctx-cancelled stream never closed")
                }
        }
        if errors.Is(streamErr, ErrStreamStalled) {
                t.Fatal("watchdog disabled (0): the sentinel must never fire")
        }
        if streamErr == nil {
                t.Log("note: ctx cancel may surface as a nil-error clean close or context.Canceled — either is honest")
        }
        if !b.Healthy() {
                t.Fatal("a user Stop must not flip the brain dead")
        }
}

// TestV1762_HeartbeatKeepsStreamAlive — the heartbeat margin law at micro
// scale: events arriving every 500ms under a 2s kill window never trip the
// sentinel (the real pair: 25s brain heartbeat vs the 45s default).
func TestV1762_HeartbeatKeepsStreamAlive(t *testing.T) {
        t.Setenv("DOOMALAY_BRAIN_STALL_KILL", "2")
        srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
                w.Header().Set("Content-Type", "text/event-stream")
                for i := 0; i < 6; i++ {
                        fmt.Fprintf(w, "data: {\"type\":\"progress\",\"text\":\"beat %d\"}\n\n", i)
                        w.(http.Flusher).Flush()
                        time.Sleep(500 * time.Millisecond)
                }
                fmt.Fprintf(w, "data: [DONE]\n\n")
                w.(http.Flusher).Flush()
        }))
        defer srv.Close()

        b := &Brain{url: srv.URL, healthy: true}
        events, errs, err := b.Chat(context.Background(), map[string]any{"message": "hi"})
        if err != nil {
                t.Fatalf("Chat: %v", err)
        }
        n := 0
        for range events {
                n++
        }
        if e := <-errs; errors.Is(e, ErrStreamStalled) || e != nil {
                t.Fatalf("heartbeat-paced stream must complete clean, errs = %v", e)
        }
        if n != 6 {
                t.Fatalf("events = %d, want 6 (a slow but LIVE turn)", n)
        }
        if !b.Healthy() {
                t.Fatal("a healthy slow turn must keep the brain flagged alive")
        }
}

// TestV1762_ByteDripIsAlive — the BYTES-not-lines law: one line arriving
// a byte at a time (100ms apart, 1.9s total > the 1s window) is a LIVE
// stream and must never trip the sentinel (the feedReader pins this;
// a line-level feed would kill it).
func TestV1762_ByteDripIsAlive(t *testing.T) {
        t.Setenv("DOOMALAY_BRAIN_STALL_KILL", "1")
        srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
                w.Header().Set("Content-Type", "text/event-stream")
                line := []byte("data: {\"type\":\"x\"}\n\n")
                for i := 0; i < len(line); i++ {
                        _, _ = w.Write(line[i : i+1])
                        w.(http.Flusher).Flush()
                        time.Sleep(100 * time.Millisecond)
                }
                fmt.Fprintf(w, "data: [DONE]\n\n")
                w.(http.Flusher).Flush()
        }))
        defer srv.Close()

        b := &Brain{url: srv.URL, healthy: true}
        events, errs, err := b.Chat(context.Background(), map[string]any{"message": "hi"})
        if err != nil {
                t.Fatalf("Chat: %v", err)
        }
        n := 0
        for range events {
                n++
        }
        if e := <-errs; e != nil {
                t.Fatalf("byte-dripped line must complete clean, errs = %v", e)
        }
        if n != 1 {
                t.Fatalf("events = %d, want 1", n)
        }
        if !b.Healthy() {
                t.Fatal("the drip was alive — the brain must stay flagged")
        }
}

// TestV1762_WatchdogComponent — the sentinel's own laws: trips once
// without feed, survives constant feeding, kill() releases it.
func TestV1762_WatchdogComponent(t *testing.T) {
        tripped := make(chan struct{})
        w := newStreamWatchdog(60*time.Millisecond, func() { close(tripped) })
        select {
        case <-tripped:
        case <-time.After(2 * time.Second):
                t.Fatal("unfed watchdog never tripped")
        }
        if !w.didTrip() {
                t.Fatal("didTrip must report the fire")
        }
        w.kill()

        tripped2 := make(chan struct{})
        w2 := newStreamWatchdog(100*time.Millisecond, func() { close(tripped2) })
        // feed every 30ms for 300ms — the window (100ms) must never elapse
        for i := 0; i < 10; i++ {
                w2.feed()
                time.Sleep(30 * time.Millisecond)
                if w2.didTrip() {
                        t.Fatal("watchdog tripped WHILE being fed — feed must reset the window")
                }
        }
        w2.kill() // stop feeding → the sentinel may arm, but we've released it
        select {
        case <-tripped2:
                t.Fatal("fed watchdog tripped — feed must reset the window")
        default:
        }
}
