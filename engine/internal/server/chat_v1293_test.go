// chat_v1293_test.go — v1.29.3 THE OPEN DOOR pins (the user's Nvidia
// report: an interrupted turn held the per-session lock forever and every
// later send ate "agent already processing"; the fix = the takeover gate
// + the bounded wait + the honest busy message + the deeper probe ladder).
package server

import (
        "os"
        "strings"
        "testing"
        "time"

        "github.com/gorilla/websocket"
)

// TestV1293_TakeoverGate — the gate is "NO registered turn belongs to the
// sender's conn". The OWNER is recorded at turn start; the pipe's current
// socket is NOT consulted (a resumed client swaps into the same pipe, so
// the pipe's ws IS the new sender by the time the second send arrives —
// the live rig convicted that shape). A sender owning the in-flight turn
// never takes over (a same-conn double-send stays an instant reject).
func TestV1293_TakeoverGate(t *testing.T) {
        sender := &websocket.Conn{}
        other := &websocket.Conn{}

        // no registered turn → takeover (the held lock belongs to nobody alive)
        if !takeoverStaleTurn("sess-tk-1", sender) {
                t.Fatal("an unowned held lock should take over")
        }

        // a turn owned by ANOTHER conn → takeover (the interrupted-turn shape)
        tc := registerTurnCancel("sess-tk-2", func() {}, other)
        defer releaseTurnCancel("sess-tk-2", tc)
        if !takeoverStaleTurn("sess-tk-2", sender) {
                t.Fatal("a foreign-owned held turn should take over")
        }

        // the sender OWNS the in-flight turn → no takeover
        if takeoverStaleTurn("sess-tk-2", other) {
                t.Fatal("the owner's own double-send must NOT take over")
        }

        // nil sender (defensive) → never
        if takeoverStaleTurn("sess-tk-3", nil) {
                t.Fatal("nil sender must never take over")
        }
}

// TestV1293_LockSessionWait — the bounded wait acquires once the holder
// releases (the abort's hand-off window) and refuses after the deadline.
func TestV1293_LockSessionWait(t *testing.T) {
        release, ok := lockSession("sess-wait-1")
        if !ok {
                t.Fatal("setup: lockSession should acquire a fresh lock")
        }

        // release after 120ms — the wait (1s) must catch the hand-off
        go func() {
                time.Sleep(120 * time.Millisecond)
                release()
        }()
        r2, ok := lockSessionWait("sess-wait-1", 1*time.Second)
        if !ok {
                t.Fatal("lockSessionWait should acquire after the holder released")
        }
        r2()

        // a held lock with a 100ms window → honest refuse
        hold, ok := lockSession("sess-wait-2")
        if !ok {
                t.Fatal("setup: second session lock should acquire")
        }
        defer hold()
        if _, ok := lockSessionWait("sess-wait-2", 100*time.Millisecond); ok {
                t.Fatal("lockSessionWait must refuse after the deadline on a held lock")
        }
}

// TestV1293_OpenDoorSourcePins — the busy path carries the honest message
// (the old "agent already processing" was a dead end) and the takeover
// actually sits in handleTurn's busy branch; the ladder cap is 12.
func TestV1293_OpenDoorSourcePins(t *testing.T) {
        chat, err := os.ReadFile("chat.go")
        if err != nil {
                t.Skip("source not readable")
        }
        s := string(chat)
        if !strings.Contains(s, `"the previous turn is still running — tap Stop to end it, or wait for it to finish"`) {
                t.Fatal("the busy reject must carry the actionable message")
        }
        if strings.Contains(s, `{"error":"busy","message":"agent already processing"}`) {
                t.Fatal("the dead-end busy message must be gone from the wire")
        }
        if !strings.Contains(s, "if takeoverStaleTurn(sessionID, sender) {") ||
                !strings.Contains(s, "abortTurn(sessionID)") ||
                !strings.Contains(s, "lockSessionWait(sessionID, 3*time.Second)") {
                t.Fatal("handleTurn's busy branch must gate + abort + bounded-wait")
        }
        llm, err := os.ReadFile("../llm/catalog.go")
        if err != nil {
                t.Skip("llm source not readable")
        }
        if !strings.Contains(string(llm), "const probeCandidateCap = 12") {
                t.Fatal("the probe ladder cap must be 12 (the rotten-head reach)")
        }
        if !strings.Contains(string(llm), "model-level errors only; the key itself was never rejected") {
                t.Fatal("the all-inconclusive verdict must say the key was never rejected")
        }
}
