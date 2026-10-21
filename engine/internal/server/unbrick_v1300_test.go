package server

// unbrick_v1300_test.go — v1.30.0 THE UNBRICKED TURN (found by the
// v1300 real-model replication): the v1.23.3 stream-emitter shape
// deadlocked EVERY emitter-armed turn after its events flushed —
// close(streamCh) waited on streamFromDirectProxy's return →
// forwardEvents → close(events) → streamWG → the pump → close(streamCh).
// The symptom: the turn lock never released; every later send on the
// session busy-rejected FOREVER (the "turn gets interrupted" disease's
// deepest face).
//
// THE PIN: an emitter-armed turn (termux bound + a real tool round
// through the executing fake bridge) must RETURN from
// streamFromDirectProxy promptly after its terminal status — the old
// code hung forever.

import (
        "context"
        "net/http"
        "net/http/httptest"
        "os/exec"
        "strings"
        "sync/atomic"
        "testing"
        "time"

        "github.com/ScoobyBaby1999/doomalay/engine/internal/store"
)

// TestV1300_UnbrickedTurn_EmitterArmedTurnReturns — the deadlock pin.
func TestV1300_UnbrickedTurn_EmitterArmedTurnReturns(t *testing.T) {
        var hits int32
        // the stub LLM: round 1 = a termux exec tool call; round 2 = the answer
        srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
                n := atomic.AddInt32(&hits, 1)
                w.Header().Set("Content-Type", "text/event-stream")
                fl := w.(http.Flusher)
                if n == 1 {
                        for _, f := range []string{
                                `data: {"choices":[{"delta":{"content":"Running it."}}]}`,
                                `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_u1","type":"function","function":{"name":"termux","arguments":"{\"action\":\"exec\",\"args\":\"{\\\"command\\\":\\\"echo unbrick-ok\\\"}\"}"}}]}}]}`,
                                `data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}`,
                        } {
                                _, _ = w.Write([]byte(f + "\n\n"))
                        }
                } else {
                        for _, f := range []string{
                                `data: {"choices":[{"delta":{"content":"Done: unbrick-ok."}}]}`,
                                `data: {"choices":[{"delta":{},"finish_reason":"stop"}]}`,
                        } {
                                _, _ = w.Write([]byte(f + "\n\n"))
                        }
                }
                fl.Flush()
        }))
        defer srv.Close()
        t.Setenv("DOOMALAY_BASE_URL_GROQ", srv.URL)

        fb := newFakeArmBridge(t)
        s := newArmServer(t, fb)
        if s.vault == nil {
                t.Fatalf("vault missing")
        }
        if err := s.vault.Set("GROQ_API_KEY", "groq", "stub-key-for-unbrick-test", ""); err != nil {
                t.Fatalf("vault key: %v", err)
        }
        root := t.TempDir()
        if err := s.db.CreateSession(&store.Session{ID: "unbrick", Title: "t", Model: "groq/stub-model", Provider: "groq", Termux: true, Sandbox: "quick"}); err != nil {
                t.Fatalf("session: %v", err)
        }
        ws := &store.Workspace{Kind: "termux", Name: "device", Access: "full", Meta: `{"termux_path":"` + root + `"}`}
        if err := s.db.CreateWorkspace(ws); err != nil {
                t.Fatalf("ws: %v", err)
        }
        if err := s.db.BindWorkspace("unbrick", ws.ID); err != nil {
                t.Fatalf("bind: %v", err)
        }
        sess, err := s.db.GetSession("unbrick")
        if err != nil || sess == nil {
                t.Fatalf("get session: %v", err)
        }
        // the emitter arm is the essence: Termux + a bound root (the pump
        // goroutine exists for the turn, whether or not chunks arrive — the
        // old cycle hung even with ZERO stream chunks)
        if len(s.sessionTermuxRoots("unbrick")) == 0 {
                t.Fatalf("the termux roots must arm the emitter")
        }

        // sanity: the fake bridge really executes (the exec runs through it)
        _ = exec.Command("bash", "-c", "true").Run()

        terminal := false
        done := make(chan struct{})
        go func() {
                s.streamFromDirectProxy(context.Background(), nil, "unbrick", sess, "run it", "", "", "", &terminal, nil) // v1.50.5: the continueSpec param
                close(done)
        }()
        select {
        case <-done:
                // THE TURN RETURNED — the cycle is dead
        case <-time.After(20 * time.Second):
                t.Fatalf("THE UNBRICKED TURN REGRESSION: streamFromDirectProxy never returned (the v1.23.3 close-cycle deadlock)")
        }

        // the turn actually completed: the tool round ran + the answer landed
        evs, _ := s.db.ListEvents("unbrick", 0)
        var sawUse, sawResult, sawAnswer, sawTerminal bool
        for _, ev := range evs {
                switch ev.EventType {
                case "tool_use":
                        sawUse = true
                case "tool_result":
                        if strings.Contains(ev.Content, "unbrick-ok") {
                                sawResult = true
                        }
                case "assistant":
                        if strings.Contains(ev.Content, "unbrick-ok") {
                                sawAnswer = true
                        }
                case "status":
                        if strings.Contains(ev.Content, `"idle"`) {
                                sawTerminal = true
                        }
                }
        }
        if !sawUse || !sawResult {
                t.Fatalf("the tool round never ran: use=%v result=%v", sawUse, sawResult)
        }
        if !sawAnswer || !sawTerminal {
                t.Fatalf("the turn never finished: answer=%v terminal=%v", sawAnswer, sawTerminal)
        }
        if !terminal {
                t.Fatalf("the terminal flag must flip")
        }
        if atomic.LoadInt32(&hits) != 2 {
                t.Fatalf("expected 2 LLM rounds, got %d", hits)
        }
}
