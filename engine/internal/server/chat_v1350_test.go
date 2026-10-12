// chat_v1350_test.go — v1.35.0 THE UNBROKEN TURN pins (the user's report:
// closing/reopening the panel mid-turn and leaving the app mid-turn both
// interrupted the bot; the law: once a turn starts, nothing ends it but
// the user). The engine half is THE TURN PULSE: the open door may abort
// only a STALE turn — a turn that pulsed any event within the window is
// LIVE and a new sender gets the honest busy answer.
package server

import (
	"os"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

func TestV1350_TurnPulse(t *testing.T) {
	// no pulse ever recorded → stale (the pre-gate behavior for exotic
	// paths: the door opens for a genuinely wedged lock)
	if !turnStale("v1350-never-pulsed") {
		t.Fatal("a session with no pulse must read stale (the door stays open for wedges)")
	}

	// a fresh pulse → LIVE (the door stays shut; a new sender gets the
	// honest busy answer instead of aborting the running turn)
	markTurnEvent("v1350-live")
	if turnStale("v1350-live") {
		t.Fatal("a turn that pulsed just now must read ALIVE")
	}

	// the pulse decays: a turn silent past the window is stale again —
	// the wedge shape the open door was built for
	markTurnEvent("v1350-ancient")
	turnActMu.Lock()
	turnActivity["v1350-ancient"] = time.Now().Add(-turnStaleAfter - time.Second)
	turnActMu.Unlock()
	if !turnStale("v1350-ancient") {
		t.Fatal("a turn silent past the window must read stale")
	}

	// the release clears the entry — a finished turn can never look alive
	markTurnEvent("v1350-done")
	releaseTurnPulse("v1350-done")
	if !turnStale("v1350-done") {
		t.Fatal("a released turn must read stale (no zombie aliveness)")
	}
}

func TestV1350_TakeoverStillOwnerGated(t *testing.T) {
	sender := &websocket.Conn{}
	other := &websocket.Conn{}

	// the pulse gate NESTS inside the owner gate: a sender that owns the
	// in-flight turn never takes over, pulse or not
	tc := registerTurnCancel("v1350-owner", func() {}, sender)
	defer releaseTurnCancel("v1350-owner", tc)
	markTurnEvent("v1350-owner")
	defer releaseTurnPulse("v1350-owner")
	if takeoverStaleTurn("v1350-owner", sender) {
		t.Fatal("the owner's own double-send must NOT take over (unchanged)")
	}
	if !takeoverStaleTurn("v1350-owner", other) {
		t.Fatal("a foreign sender still passes the OWNER gate (the pulse decides next)")
	}
}

// TestV1350_UnbrokenTurnSourcePins — the client half ships THREE laws that
// must stay in the tree: (1) the client never fabricates a terminal on
// ladder exhaustion (the turn stays armed, the honest indicator runs, the
// revive poll keeps reconnecting); (2) the replay_done truth-arm re-arms a
// live turn from the transcript's truth (no terminal after the user echo);
// (3) the engine's open door aborts ONLY a stale turn.
func TestV1350_UnbrokenTurnSourcePins(t *testing.T) {
	cp, err := os.ReadFile("web/chatpanel.js")
	if err != nil {
		t.Skip("chatpanel source not readable")
	}
	s := string(cp)
	if !strings.Contains(s, "v1.35.0 THE UNBROKEN TURN") {
		t.Fatal("the unbroken-turn law must be on the record in chatpanel.js")
	}
	if strings.Contains(s, "Connection to the engine dropped mid-reply and could not be re-established") {
		t.Fatal("the client-fabricated terminal bubble must be GONE (the wire fact is not a turn fact)")
	}
	if !strings.Contains(s, "the turn continues engine-side, reconnecting") {
		t.Fatal("the honest reconnect indicator must replace the fabricated bubble")
	}
	if !strings.Contains(s, "v1.35.0 THE TRUTH ARM") {
		t.Fatal("the replay_done truth-arm must be on the record (the reload mid-turn re-arm)")
	}
	if !strings.Contains(s, "state._terminalSeen") {
		t.Fatal("the terminal ledger (_terminalSeen) must exist (the arm reads it)")
	}

	chat, err := os.ReadFile("chat.go")
	if err != nil {
		t.Skip("chat source not readable")
	}
	g := string(chat)
	// the nested gate: the owner gate stays intact (v1.29.3's pins), the
	// pulse decides INSIDE it — a live turn keeps the lock
	if !strings.Contains(g, "if takeoverStaleTurn(sessionID, sender) {") {
		t.Fatal("the v1.29.3 owner gate must stay intact")
	}
	if !strings.Contains(g, "if turnStale(sessionID) {") {
		t.Fatal("the pulse gate must nest inside the owner gate")
	}
	if !strings.Contains(g, "turnStaleAfter = 120 * time.Second") {
		t.Fatal("the stale window must be the 120s stall-chip twin")
	}
	if !strings.Contains(g, "markTurnEvent(sessionID)") {
		t.Fatal("the turn pulse must be marked (handleTurn + forwardEvents)")
	}
}
