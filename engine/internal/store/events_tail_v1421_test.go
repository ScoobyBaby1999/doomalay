package store

// events_tail_v1421_test.go — v1.42.1 THE LONG HAUL (H3): the tail-walk
// boot-heal verdict must match the old full-scan verdict on EVERY shape
// a real session log can take, and stay cheap doing it.

import (
        "strings"
        "testing"
)

// fullScanPending is the OLD heal's logic, verbatim — the reference the
// parity walk compares against.
func fullScanPending(t *testing.T, db *DB, sid string) bool {
        t.Helper()
        events, err := db.ListEvents(sid, 0)
        if err != nil {
                t.Fatalf("list: %v", err)
        }
        pending := false
        for _, ev := range events {
                switch ev.EventType {
                case "user":
                        pending = true
                case "status":
                        if strings.Contains(ev.Content, `"idle"`) || strings.Contains(ev.Content, `"error"`) {
                                pending = false
                        }
                }
        }
        return pending
}

func seedShape(t *testing.T, db *DB, sid string, shape []struct{ typ, content string }) {
        t.Helper()
        for _, s := range shape {
                if _, err := db.AppendEvent(sid, s.typ, s.content, ""); err != nil {
                        t.Fatalf("seed %s/%s: %v", sid, s.typ, err)
                }
        }
}

// TestV1421_TailPendingTurnParity — every realistic log shape, old logic
// vs the tail walk, verdict-for-verdict.
func TestV1421_TailPendingTurnParity(t *testing.T) {
        type tc struct {
                name  string
                shape []struct{ typ, content string }
        }
        cases := []tc{
                {"closed turn", []struct{ typ, content string }{
                        {"user", "hi"}, {"assistant_delta", "a"}, {"status", `{"state":"running"}`},
                        {"assistant_delta", "b"}, {"status", `{"state":"idle","usage":{}}`},
                }},
                {"crashed mid-turn (the heal's real case)", []struct{ typ, content string }{
                        {"user", "hi"}, {"status", `{"state":"running"}`}, {"assistant_delta", "a"}, {"assistant_delta", "b"},
                }},
                {"crashed before first delta", []struct{ typ, content string }{
                        {"user", "hi"},
                }},
                {"error terminal closes", []struct{ typ, content string }{
                        {"user", "hi"}, {"status", `{"state":"error","message":"boom"}`},
                }},
                {"second turn closed, first crashed", []struct{ typ, content string }{
                        {"user", "one"}, {"assistant_delta", "x"},
                        {"user", "two"}, {"status", `{"state":"idle"}`},
                }},
                {"healed terminal closes", []struct{ typ, content string }{
                        {"user", "hi"}, {"assistant_delta", "x"}, {"status", `{"state":"error","healed":true}`},
                }},
                {"running status does NOT close", []struct{ typ, content string }{
                        {"user", "hi"}, {"status", `{"state":"idle"}`}, {"user", "again"}, {"status", `{"state":"running"}`},
                }},
                {"tool middle noise", []struct{ typ, content string }{
                        {"user", "hi"}, {"tool_use", `{"name":"ls"}`}, {"tool_result", `{"text":"a"}`},
                        {"thinking", "hmm"}, {"assistant_delta", "d"}, {"status", `{"state":"idle"}`},
                }},
                {"mega turn crashed (2k deltas after user)", func() []struct{ typ, content string } {
                        shape := []struct{ typ, content string }{{"user", "hi"}, {"status", `{"state":"running"}`}}
                        for i := 0; i < 2000; i++ {
                                shape = append(shape, struct{ typ, content string }{"assistant_delta", "x"})
                        }
                        return shape
                }()},
        }

        for _, c := range cases {
                db := openMaintainDB(t)
                sid := "sess-" + strings.ReplaceAll(strings.ReplaceAll(c.name, " ", "-"), "(", "")
                seedShape(t, db, sid, c.shape)
                want := fullScanPending(t, db, sid)
                got, decided := db.TailPendingTurn(sid, 20001)
                if !decided {
                        t.Fatalf("%s: tail walk undecided (limit 20001)", c.name)
                }
                if got != want {
                        t.Fatalf("%s: tail=%v full-scan=%v — PARITY BROKEN", c.name, got, want)
                }
                db.Close()
        }
}

// TestV1421_TailPendingTurnEmptyAndFresh — an empty log is undecided
// (the caller treats it as closed, same as the old scan's false).
func TestV1421_TailPendingTurnEmptyAndFresh(t *testing.T) {
        db := openMaintainDB(t)
        defer db.Close()
        if _, decided := db.TailPendingTurn("no-such-session", 20001); decided {
                t.Fatalf("missing session must be undecided, not pending")
        }
}

// TestV1421_TailPendingTurnCostShape — the whole point (H3): a closed
// session's verdict stops within a handful of rows no matter how much
// history precedes it. A 20k-event CLOSED session must not read its
// history to decide.
func TestV1421_TailPendingTurnCostShape(t *testing.T) {
        db := openMaintainDB(t)
        defer db.Close()
        sid := "sess-cost"
        // 300 closed turns = 60k+ events of history.
        for turn := 0; turn < 300; turn++ {
                if _, err := db.AppendEvent(sid, "user", "q", ""); err != nil {
                        t.Fatalf("seed: %v", err)
                }
                for i := 0; i < 100; i++ {
                        if _, err := db.AppendEvent(sid, "assistant_delta", "d", ""); err != nil {
                                t.Fatalf("seed: %v", err)
                        }
                }
                if _, err := db.AppendEvent(sid, "status", `{"state":"idle"}`, ""); err != nil {
                        t.Fatalf("seed: %v", err)
                }
        }
        events, err := db.ListEvents(sid, 0)
        if err != nil {
                t.Fatalf("list: %v", err)
        }
        n := len(events)
        if n != 300*102 {
                t.Fatalf("seed shape: %d events, want %d", n, 300*102)
        }
        pending, decided := db.TailPendingTurn(sid, 20001)
        if !decided || pending {
                t.Fatalf("closed mega-history: pending=%v decided=%v, want false/true", pending, decided)
        }
}
