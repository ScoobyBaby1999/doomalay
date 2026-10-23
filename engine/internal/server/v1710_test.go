package server

// v1710 pins — v1.71 THE HONEST RECONCILE's engine laws (the device
// conviction "doomalay-sky": 14 logical tool calls, 93 tool events in the
// log — every prior turn's pills replayed into each new turn, plus the
// oc_stalled death loop where the interrupt freed the turn but the wedged
// session's tool state survived into every later turn):
//   · THE TURN ANCHOR — the mid-turn reconcile's window is time-anchored
//     to the turn's own start; a prior turn's tool part NEVER re-emits,
//     whatever the idle-marker situation (the pocket serve writes no idle
//     rows for interrupted turns — the old newest-idle trim alone saw the
//     whole session as the window);
//   · THE STALL RECYCLE — the oc_stalled conviction deletes the wedged
//     serve session + forgets the binding (the bash zombie dies with it)
//     and the honest message names the fresh session.

import (
        "strings"
        "testing"

        "github.com/ScoobyBaby1999/doomalay/engine/internal/ocserve"
)

func v1710Msg(typ string, created int64, toolIDs ...string) ocserve.ServeMessage {
        m := ocserve.ServeMessage{Type: typ}
        m.Time.Created = created
        for _, id := range toolIDs {
                part := ocserve.ServeContentPart{Type: "tool", ID: id, Name: "bash"}
                m.Content = append(m.Content, part)
        }
        return m
}

func v1710PartIDs(msgs []ocserve.ServeMessage) []string {
        var ids []string
        for _, m := range msgs {
                for _, p := range m.Content {
                        if p.ID != "" {
                                ids = append(ids, p.ID)
                        }
                }
        }
        return ids
}

// TestV1710_AnchorTurnWindow_PriorTurnNeverReemits — the device shape: a
// transcript whose turns left NO idle rows (interrupted turns) — the prior
// turn's tool-bearing messages are dropped from the window unconditionally.
func TestV1710_AnchorTurnWindow_PriorTurnNeverReemits(t *testing.T) {
        turnStart := int64(1_000_000)
        msgs := []ocserve.ServeMessage{
                v1710Msg("user", turnStart-60_000, ""),
                v1710Msg("assistant", turnStart-59_000, "call_prior_a"), // a prior turn's completed tool
                v1710Msg("user", turnStart-30_000, ""),
                v1710Msg("assistant", turnStart-29_000, "call_prior_b"), // another prior turn's tool
                v1710Msg("user", turnStart-500, ""),                     // THIS turn's prompt
                v1710Msg("assistant", turnStart+1_000, "call_this"),     // this turn's tool
        }
        // NO idle rows anywhere — the pocket conviction's exact shape.
        got := ocAnchorTurnWindow(msgs, turnStart)
        ids := v1710PartIDs(got)
        if len(ids) != 1 || ids[0] != "call_this" {
                t.Fatalf("only THIS turn's part may ride the anchored window (no idle rows anywhere): %v", ids)
        }
}

// TestV1710_AnchorTurnWindow_IdleBeltHolds — the idle trim still cuts
// WITHIN the anchored window (the belt shape keeps its old behavior).
func TestV1710_AnchorTurnWindow_IdleBeltHolds(t *testing.T) {
        turnStart := int64(1_000_000)
        msgs := []ocserve.ServeMessage{
                v1710Msg("user", turnStart-500, ""),
                v1710Msg("assistant", turnStart+1_000, "call_before_idle"), // this turn, before its idle
                v1710Msg("idle", turnStart+2_000, ""),                      // this turn's own idle marker
                v1710Msg("user", turnStart+3_000, ""),                      // a NEXT turn already in the fetch
                v1710Msg("assistant", turnStart+4_000, "call_after_idle"),
        }
        got := ocAnchorTurnWindow(msgs, turnStart)
        for _, m := range got {
                if m.Type == "idle" {
                        t.Fatalf("the belt must cut at the newest idle — the idle row itself never rides")
                }
        }
        ids := v1710PartIDs(got)
        if len(ids) != 1 || ids[0] != "call_after_idle" {
                t.Fatalf("the belt still cuts within the anchored window: %v", ids)
        }
}

// TestV1710_AnchorTurnWindow_ZeroGraceAndTheSafeAnswer — NO grace (the
// engine and the serve share the host clock; turnStartedAt is stamped
// BEFORE the prompt POST — every part of THIS turn is created ≥ it): a part
// stamped seconds before the turn's start is a PRIOR turn's and drops, and
// a message with NO stamps at all drops too (the safe answer: a missed
// recovery beats the quadratic replay).
func TestV1710_AnchorTurnWindow_ZeroGraceAndTheSafeAnswer(t *testing.T) {
        turnStart := int64(1_000_000)
        msgs := []ocserve.ServeMessage{
                v1710Msg("assistant", turnStart-1, "call_just_before"), // even 1ms before — a prior turn's
                v1710Msg("assistant", turnStart-30_000, "call_old"),    // far before — dropped
                {Type: "assistant"},                                    // no stamps — dropped, safely
                v1710Msg("assistant", turnStart+0, "call_this"),        // this turn's — stays
        }
        got := ocAnchorTurnWindow(msgs, turnStart)
        ids := v1710PartIDs(got)
        if len(ids) != 1 || ids[0] != "call_this" {
                t.Fatalf("only parts created at/after the turn's start survive (zero grace): %v", ids)
        }
}

// TestV1710_StallRecycle_SourceLaw — the stall-ceiling conviction owns the
// recycle (the live end-to-end pin is the v1710 rig's LEG C): the wedged
// serve session is DELETED, the binding forgotten, and the honest message
// names the fresh session.
func TestV1710_StallRecycle_SourceLaw(t *testing.T) {
        src := srcOf(t, "ocserveturn.go")
        if !strings.Contains(src, "m.DeleteSession(serveSess)") {
                t.Fatalf("the stall conviction must DELETE the wedged serve session")
        }
        if !strings.Contains(src, "s.ocServeForgetSession(sessionID)") {
                t.Fatalf("the stall conviction must forget the chat's serve binding")
        }
        if !strings.Contains(src, "the stuck session was discarded — your next message starts a fresh one") {
                t.Fatalf("the honest message must name the fresh session")
        }
}
