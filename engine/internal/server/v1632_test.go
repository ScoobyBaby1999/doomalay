package server

// v1632_test.go — v1.63.2 THE LIVING WIRE pins (PLAN-V163 §2).
//
// THE CONVICTION: the pump's /api/event SSE connection had NO liveness law
// — a silently-dead connection (mobile network switch, NAT timeout, the
// serve's own reload) blocked in ReadString FOREVER while the turn kept
// running serve-side; the durable probe honestly answered "still running"
// and the user watched a static thinking pill for minutes ("one chat has
// the thinking pill for so long, another gets a direct reply" — whichever
// connection survived).
//
// THE LAWS PINNED HERE:
//
//   (a) THE RECONNECT — a connection that dies MID-TURN (frames delivered,
//       socket closed) reconnects and the turn COMPLETES: every frame lands
//       in order, the terminal arrives, zero events lost;
//   (b) THE HONEST WAIT — a quiet-but-alive turn (the durable record has no
//       idle marker) answers each probe tick with an honest elapsed progress
//       ping ("still working… Ns in this turn"), then the off-wire idle
//       lands the answer + terminal;
//   (c) THE INTERRUPTED OUTCOME — an idle marker carrying outcome=interrupted
//       is an HONEST FAILURE (never the empty-text success the old code
//       answered).

import (
        "context"
        "net/http"
        "net/http/httptest"
        "strings"
        "sync"
        "testing"
        "time"

        "github.com/ScoobyBaby1999/doomalay/engine/internal/ocserve"
)

// v1632Pump runs one pump against the fake and collects the events.
func v1632Pump(t *testing.T, m *ocserve.Manager, serveSess, chatID string, turnStartedAt int64) []map[string]any {
        t.Helper()
        var (
                mu   sync.Mutex
                evts []map[string]any
        )
        out := make(chan map[string]any, 128)
        done := make(chan struct{})
        go func() {
                for ev := range out {
                        mu.Lock()
                        evts = append(evts, ev)
                        mu.Unlock()
                }
                close(done)
        }()
        s := &Server{}
        recycled, err := s.ocServePump(context.Background(), m, serveSess, chatID, "opencode/big-pickle", out, turnStartedAt)
        close(out)
        <-done
        if recycled {
                t.Fatalf("the pump must not recycle on these shapes")
        }
        if err != nil {
                t.Fatalf("the pump must finish clean: %v", err)
        }
        mu.Lock()
        defer mu.Unlock()
        return evts
}

// TestV1632_MidTurnReconnect pins (a): the connection dies mid-turn after
// the reasoning + first text delta; the reconnect delivers the rest — the
// collected events carry EVERY frame in order and the idle terminal.
func TestV1632_MidTurnReconnect(t *testing.T) {
        t.Setenv("DOOMALAY_OPENCODE_SERVE_PASSWORD", "rig-pw")
        fake := &fakeServe{streamCuts: 1, streamCutAfter: 3}
        srv := httptest.NewServer(http.HandlerFunc(fake.handler))
        defer srv.Close()
        m := ocserve.New("", "key", nil)
        m.SetBaseURL(srv.URL)

        frames := []string{
                `data: {"id":"r0","type":"server.connected","data":{}}`,
                `data: {"id":"r1","type":"session.reasoning.delta","data":{"sessionID":"ses_lw","delta":"pondering"}}`,
                `data: {"id":"r2","type":"session.text.delta","data":{"sessionID":"ses_lw","delta":"part one, "}}`,
                `data: {"id":"r3","type":"session.text.delta","data":{"sessionID":"ses_lw","delta":"part two"}}`,
                `data: {"id":"r4","type":"session.step.ended","data":{"sessionID":"ses_lw","finish":"stop"}}`,
                `data: {"id":"r5","type":"session.execution.succeeded","data":{"sessionID":"ses_lw"}}`,
        }
        fake.mu.Lock()
        fake.sse = frames
        fake.mu.Unlock()

        evts := v1632Pump(t, m, "ses_lw", "chat-lw", time.Now().UnixMilli())

        var think, text string
        terminal := false
        for _, ev := range evts {
                switch ev["type"] {
                case "thinking":
                        think += ev["text"].(string)
                case "assistant_delta":
                        text += ev["text"].(string)
                case "status":
                        if ev["state"] == "idle" {
                                terminal = true
                        }
                }
        }
        if think != "pondering" {
                t.Fatalf("(a) the pre-cut reasoning frame must land: %q", think)
        }
        if text != "part one, part two" {
                t.Fatalf("(a) the text must survive the cut WHOLE (pre-cut + post-reconnect): %q", text)
        }
        if !terminal {
                t.Fatalf("(a) the terminal must land on the reconnected wire")
        }
        fake.mu.Lock()
        conns := fake.eventConns
        fake.mu.Unlock()
        if conns < 2 {
                t.Fatalf("(a) the reconnect must happen — the first connection died mid-turn, saw %d connections", conns)
        }
}

// TestV1632_HonestWait pins (b): a quiet-but-alive turn emits the elapsed
// progress pings on every probe tick (the thinking pill NEVER sits static),
// then the off-wire idle lands the answer + terminal.
func TestV1632_HonestWait(t *testing.T) {
        t.Setenv("DOOMALAY_OPENCODE_SERVE_PASSWORD", "rig-pw")
        oldProbe := ocServeSilenceProbe
        ocServeSilenceProbe = 120 * time.Millisecond
        defer func() { ocServeSilenceProbe = oldProbe }()

        fake := &fakeServe{stillRunningProbes: 2}
        srv := httptest.NewServer(http.HandlerFunc(fake.handler))
        defer srv.Close()
        m := ocserve.New("", "key", nil)
        m.SetBaseURL(srv.URL)
        fake.mu.Lock()
        fake.lastSess = "ses_qt"
        fake.sessions = map[string]bool{"ses_qt": true}
        // the durable record (the direct-pump shape: no prompt rides — the
        // records pre-exist like a turn the serve already settled)
        fake.v1592Msg("ses_qt", map[string]any{"type": "assistant", "text": "the quiet-turn answer", "time": map[string]any{"created": time.Now().UnixMilli()}})
        fake.v1592Msg("ses_qt", map[string]any{"type": "idle", "outcome": "succeeded", "time": map[string]any{"created": time.Now().UnixMilli()}})
        fake.mu.Unlock()

        started := time.Now().UnixMilli()
        evts := v1632Pump(t, m, "ses_qt", "chat-qt", started)

        pings := 0
        var answer string
        terminal := false
        for _, ev := range evts {
                switch ev["type"] {
                case "progress":
                        msg, _ := ev["message"].(string)
                        if strings.Contains(msg, "still working") && strings.Contains(msg, "in this turn") {
                                pings++
                        }
                case "assistant":
                        answer, _ = ev["text"].(string)
                case "status":
                        if ev["state"] == "idle" {
                                terminal = true
                        }
                }
        }
        if pings < 2 {
                t.Fatalf("(b) each quiet probe tick must ping the honest wait (≥2 expected, got %d)", pings)
        }
        if answer != "the quiet-turn answer" {
                t.Fatalf("(b) the off-wire answer must land once the ladder drains: %q", answer)
        }
        if !terminal {
                t.Fatalf("(b) the off-wire idle terminal must land")
        }
}

// TestV1632_InterruptedOutcome pins (c): outcome=interrupted is an honest
// failure with a human message — never the empty-text success.
func TestV1632_InterruptedOutcome(t *testing.T) {
        t.Setenv("DOOMALAY_OPENCODE_SERVE_PASSWORD", "rig-pw")
        oldProbe := ocServeSilenceProbe
        ocServeSilenceProbe = 120 * time.Millisecond
        defer func() { ocServeSilenceProbe = oldProbe }()

        fake := &fakeServe{interrupted: true}
        srv := httptest.NewServer(http.HandlerFunc(fake.handler))
        defer srv.Close()
        m := ocserve.New("", "key", nil)
        m.SetBaseURL(srv.URL)
        fake.mu.Lock()
        fake.lastSess = "ses_iv"
        fake.sessions = map[string]bool{"ses_iv": true}
        // the durable record: the serve settled the turn INTERRUPTED (the
        // direct-pump shape — no prompt rides in this test)
        fake.v1592Msg("ses_iv", map[string]any{"type": "idle", "outcome": "interrupted", "time": map[string]any{"created": time.Now().UnixMilli()}})
        fake.mu.Unlock()

        evts := v1632Pump(t, m, "ses_iv", "chat-iv", time.Now().UnixMilli())

        var errMsg string
        errSeen, terminal := false, false
        for _, ev := range evts {
                switch ev["type"] {
                case "error":
                        errSeen = true
                        errMsg, _ = ev["message"].(string)
                case "status":
                        if ev["state"] == "error" {
                                terminal = true
                        }
                }
        }
        if !errSeen || !terminal {
                t.Fatalf("(c) an interrupted turn must answer the honest error + terminal (err=%v terminal=%v)", errSeen, terminal)
        }
        if !strings.Contains(errMsg, "interrupted") {
                t.Fatalf("(c) the error must speak the interruption honestly: %q", errMsg)
        }
}

// TestV1632_StepStartedPing pins the step line: a session.step.started
// frame rides as an ephemeral progress ping (the turn visibly moves).
func TestV1632_StepStartedPing(t *testing.T) {
        t.Setenv("DOOMALAY_OPENCODE_SERVE_PASSWORD", "rig-pw")
        fake := &fakeServe{}
        srv := httptest.NewServer(http.HandlerFunc(fake.handler))
        defer srv.Close()
        m := ocserve.New("", "key", nil)
        m.SetBaseURL(srv.URL)
        fake.mu.Lock()
        fake.sse = []string{
                `data: {"id":"s0","type":"server.connected","data":{}}`,
                `data: {"id":"s1","type":"session.step.started","data":{"sessionID":"ses_ss"}}`,
                `data: {"id":"s2","type":"session.execution.succeeded","data":{"sessionID":"ses_ss"}}`,
        }
        fake.mu.Unlock()

        evts := v1632Pump(t, m, "ses_ss", "chat-ss", time.Now().UnixMilli())
        sawStep := false
        for _, ev := range evts {
                if ev["type"] == "progress" {
                        if msg, _ := ev["message"].(string); strings.Contains(msg, "new step started") {
                                sawStep = true
                        }
                }
        }
        if !sawStep {
                t.Fatalf("the step.started frame must ride as a progress ping: %v", evts)
        }
}
