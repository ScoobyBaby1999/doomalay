package server

// chat_v1153_test.go — v1.15.3 THE TRIM pins (PLAN-V115 §v1.15.3).
//
// 1. buildHistory is BOUNDED: a long session's turn history reads a tail,
//    not the whole log — and the window + hidden filter + delta fold stay
//    EXACT (the full-walk behavior preserved).
// 2. The map reaper: idle sessions' locks/pipes leave the maps; a session
//    with a turn in flight is never reaped (the running turn's pipe must
//    stay reachable for the resume swap).

import (
        "encoding/json"
        "fmt"
        "os"
        "path/filepath"
        "strings"
        "testing"

        "github.com/ScoobyBaby1999/doomalay/engine/internal/store"
)

// seedEvents appends count events: alternating user/assistant pairs.
func seedEvents(t *testing.T, db *store.DB, sid string, pairs int) {
        t.Helper()
        for i := 0; i < pairs; i++ {
                if _, err := db.AppendEvent(sid, "user", fmt.Sprintf("u%d", i), ""); err != nil {
                        t.Fatalf("seed user: %v", err)
                }
                if _, err := db.AppendEvent(sid, "assistant", fmt.Sprintf("a%d", i), ""); err != nil {
                        t.Fatalf("seed assistant: %v", err)
                }
        }
}

func newTestServerV1153(t *testing.T) *Server {
        t.Helper()
        dir := t.TempDir()
        db, err := store.Open(dir)
        if err != nil {
                t.Fatalf("store: %v", err)
        }
        if err := db.Migrate(); err != nil {
                t.Fatalf("migrate: %v", err)
        }
        return &Server{db: db}
}

// TestV1153_BuildHistoryBoundedWindow — a 500-pair session with window 40
// returns exactly the LAST 40 messages, in order, from the tail walk.
func TestV1153_BuildHistoryBoundedWindow(t *testing.T) {
        s := newTestServerV1153(t)
        sid := "sess-bounded"
        seedEvents(t, s.db, sid, 500)

        msgs := s.buildHistory(sid, 40)
        if len(msgs) != 40 {
                t.Fatalf("window 40 on a 500-pair session: got %d messages, want 40", len(msgs))
        }
        if msgs[0].Content != "u480" || msgs[1].Content != "a480" {
                t.Fatalf("the window must hold the LAST messages: got %q,%q", msgs[0].Content, msgs[1].Content)
        }
        if msgs[38].Content != "u499" || msgs[39].Content != "a499" {
                t.Fatalf("window tail wrong: %q,%q", msgs[38].Content, msgs[39].Content)
        }
}

// TestV1153_BuildHistorySmallSessionShortWindow — a session smaller than
// the window returns everything (the tail reaches the head).
func TestV1153_BuildHistorySmallSessionShortWindow(t *testing.T) {
        s := newTestServerV1153(t)
        sid := "sess-small"
        seedEvents(t, s.db, sid, 3)
        msgs := s.buildHistory(sid, 40)
        if len(msgs) != 6 {
                t.Fatalf("3 pairs with window 40: got %d messages, want 6", len(msgs))
        }
}

// TestV1153_BuildHistoryHiddenMasking — hidden ids drop their messages
// BEFORE the window slice (the v0.37 contract, preserved by the tail walk).
func TestV1153_BuildHistoryHiddenMasking(t *testing.T) {
        s := newTestServerV1153(t)
        sid := "sess-hidden"
        seedEvents(t, s.db, sid, 5)
        // hide the LAST pair (u4/a4)
        events, _ := s.db.ListEvents(sid, 0)
        var ids []int64
        for _, ev := range events {
                if ev.Content == "u4" || ev.Content == "a4" {
                        ids = append(ids, ev.ID)
                }
        }
        b, _ := json.Marshal(ids)
        if _, err := s.db.AppendEvent(sid, "hide", string(b), ""); err != nil {
                t.Fatalf("seed hide: %v", err)
        }
        msgs := s.buildHistory(sid, 40)
        for _, m := range msgs {
                if m.Content == "u4" || m.Content == "a4" {
                        t.Fatalf("hidden message survived: %+v", m)
                }
        }
        if len(msgs) != 8 {
                t.Fatalf("5 pairs - 1 hidden pair + hide row: got %d messages, want 8", len(msgs))
        }
}

// TestV1153_BuildHistoryDeltaExactness — a pre-v0.13-style delta session:
// each assistant_delta is its OWN message (FoldedDone semantics: "so later
// deltas don't append"), so the bounded TAIL walk must return EXACTLY what
// the full walk returns — the pin is equivalence, not a fold.
func TestV1153_BuildHistoryDeltaFoldFallback(t *testing.T) {
        s := newTestServerV1153(t)
        sid := "sess-deltas"
        // one user event, then a LONG delta run (tail limit = window*3+64 —
        // make the run longer than the first tail so the truncation triggers)
        if _, err := s.db.AppendEvent(sid, "user", "fold me", ""); err != nil {
                t.Fatal(err)
        }
        for i := 0; i < 400; i++ {
                if _, err := s.db.AppendEvent(sid, "assistant_delta", fmt.Sprintf("d%d ", i), ""); err != nil {
                        t.Fatal(err)
                }
        }
        // a final full assistant event (the modern shape) AFTER the run
        if _, err := s.db.AppendEvent(sid, "assistant", "the modern reply", ""); err != nil {
                t.Fatal(err)
        }
        // FoldedDone semantics (llm.Message): each assistant_delta is its OWN
        // message — the bounded walk must match the full walk's output.
        msgs := s.buildHistory(sid, 40)
        if len(msgs) != 40 {
                t.Fatalf("delta session window 40: got %d messages, want 40", len(msgs))
        }
        if msgs[39].Role != "assistant" || msgs[39].Content != "the modern reply" {
                t.Fatalf("the last message must be the modern assistant event, got %+v", msgs[39])
        }
        if msgs[38].Content != "d399 " {
                t.Fatalf("the second-to-last must be the LAST delta (d399), got %q", msgs[38].Content)
        }
        // window 2 → the last delta + the modern reply
        msgs2 := s.buildHistory(sid, 2)
        if len(msgs2) != 2 || msgs2[1].Content != "the modern reply" || msgs2[0].Content != "d399 " {
                t.Fatalf("window 2: got %+v", msgs2)
        }
}

// TestV1153_ReapIdleNotBusy — the reaper: an idle session's entries leave
// the maps; a BUSY session (lock held) keeps its pipe.
func TestV1153_ReapIdleNotBusy(t *testing.T) {
        // idle session: pipe + lock exist, socket cleared
        p := pipeFor("sess-reap")
        gen := p.swap(nil) // no conn — pipe present with ws nil
        if gen == 0 {
                t.Fatal("swap should bump the generation")
        }
        if _, ok := lockSession("sess-reap"); !ok {
                t.Fatal("lockSession should acquire a fresh lock")
        }
        release := func() {}
        _ = release
        // release it so the session is idle
        sessionLocksMu.Lock()
        ch := sessionLocks["sess-reap"]
        sessionLocksMu.Unlock()
        <-ch // drain the token we just took

        reapIdleChat("sess-reap", p)
        chatPipesMu.Lock()
        _, pipeStill := chatPipes["sess-reap"]
        chatPipesMu.Unlock()
        sessionLocksMu.Lock()
        _, lockStill := sessionLocks["sess-reap"]
        sessionLocksMu.Unlock()
        if pipeStill || lockStill {
                t.Fatalf("idle session reaped: pipe in map=%v lock in map=%v (want both GONE)", pipeStill, lockStill)
        }

        // busy session: hold the lock, try to reap — nothing leaves
        p2 := pipeFor("sess-busy")
        p2.swap(nil)
        releaseBusy, ok := lockSession("sess-busy")
        if !ok {
                t.Fatal("lock acquire failed")
        }
        reapIdleChat("sess-busy", p2)
        chatPipesMu.Lock()
        _, pipeKept := chatPipes["sess-busy"]
        chatPipesMu.Unlock()
        if !pipeKept {
                t.Fatal("a BUSY session's pipe was reaped — the running turn's live feed would be orphaned")
        }
        releaseBusy()
        // now idle again → reap works
        reapIdleChat("sess-busy", p2)
        chatPipesMu.Lock()
        _, pipeRemains := chatPipes["sess-busy"]
        chatPipesMu.Unlock()
        if pipeRemains {
                t.Fatal("after release the reaper should clear the pipe")
        }
}

// TestV1153_NoActionGrammarInPersonas — the session-facing default personas
// no longer teach the DELETED ACTION grammar (source pin; the v1.13.3 sweep
// missed the frontend twins until v1.15.3).
func TestV1153_NoActionGrammarInPersonas(t *testing.T) {
        for _, src := range []string{
                "web/persona.js",
                "web/chatpanel.js",
        } {
                b, err := os.ReadFile(filepath.Join("web", filepath.Base(src)))
                if err != nil {
                        // the test runs from internal/server — the web dir is two levels up
                        b, err = os.ReadFile(filepath.Join("..", "..", "server", "web", filepath.Base(src)))
                        if err != nil {
                                t.Skipf("source not readable: %v", err)
                        }
                }
                s := string(b)
                for _, banned := range []string{"ACTION line format", "ACTION: skills", "ACTION: persona_set", "ACTION: json_tool"} {
                        if strings.Contains(s, banned) {
                                t.Errorf("%s still teaches the deleted ACTION grammar (%q)", src, banned)
                        }
                }
        }
}
