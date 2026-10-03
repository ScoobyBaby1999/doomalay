package server

// v0.95.1 THE ISOLATION WAVE — the engine-side guard test.
//
// Live leak (the user's export, 2026-10-03): two nvidia chats —
// scooby/deepseek's transcript carried ANOTHER chat's turn ("Hello! I'm
// Nemotron…", and its model noticed "the user said 'Hi' twice"). The send
// frame carried NO session identity, so a client cross-bind executed chat
// A's turn inside chat B's event log.
//
// The guard: a frame that names a session must match the socket's session
// or it is REJECTED (error event, nothing persisted). Absent session_id
// remains the legacy shape (allowed). This test pins both sides of that
// contract plus the no-persistence-of-model-overrides hardening.

import (
        "encoding/json"
        "fmt"
        "net/http/httptest"
        "strings"
        "testing"
        "time"

        "github.com/gorilla/websocket"

        "github.com/ScoobyBaby1999/doomalay/engine/internal/store"
)

func v0951Dial(t *testing.T, s *Server, sessionID string) (*websocket.Conn, *httptest.Server) {
        t.Helper()
        srv := httptest.NewServer(s.mux)
        t.Cleanup(srv.Close)
        wsURL := "ws" + strings.TrimPrefix(srv.URL, "http") + "/api/chat?session_id=" + sessionID
        conn, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
        if err != nil {
                t.Fatalf("dial %s: %v", wsURL, err)
        }
        t.Cleanup(func() { conn.Close() })
        _ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
        return conn, srv
}

// v0951ReadUntil reads frames until one matches pred (or the deadline).
func v0951ReadUntil(t *testing.T, conn *websocket.Conn, pred func(map[string]any) bool) map[string]any {
        t.Helper()
        deadline := time.Now().Add(5 * time.Second)
        for time.Now().Before(deadline) {
                _ = conn.SetReadDeadline(time.Now().Add(2 * time.Second))
                _, raw, err := conn.ReadMessage()
                if err != nil {
                        t.Fatalf("read frame: %v", err)
                }
                var ev map[string]any
                if err := json.Unmarshal(raw, &ev); err != nil {
                        continue
                }
                if pred(ev) {
                        return ev
                }
        }
        t.Fatalf("no matching frame before deadline")
        return nil
}

func v0951CountEvents(t *testing.T, s *Server, sessionID, eventType string) int {
        t.Helper()
        evs, err := s.db.ListEvents(sessionID, 0)
        if err != nil {
                t.Fatalf("list events: %v", err)
        }
        n := 0
        for _, e := range evs {
                if e.EventType == eventType {
                        n++
                }
        }
        return n
}

// THE GUARD: a frame naming a DIFFERENT session is rejected — nothing is
// executed, nothing is persisted to either log (beyond the wire error).
func TestV0951SessionMismatchFrameRejected(t *testing.T) {
        s := newSearchTestServer(t)
        if err := s.db.CreateSession(&store.Session{ID: "sessA", Title: "A", Model: "nvidia/m1", Provider: "nvidia", Sandbox: "quick"}); err != nil {
                t.Fatalf("create A: %v", err)
        }
        if err := s.db.CreateSession(&store.Session{ID: "sessB", Title: "B", Model: "nvidia/m2", Provider: "nvidia", Sandbox: "quick"}); err != nil {
                t.Fatalf("create B: %v", err)
        }

        conn, _ := v0951Dial(t, s, "sessA")

        // The poisoned frame: a send for B, travelling over A's socket.
        _ = conn.SetWriteDeadline(time.Now().Add(2 * time.Second))
        if err := conn.WriteMessage(websocket.TextMessage, []byte(
                `{"type":"send","message":"hi","session_id":"sessB","model":"nvidia/m2","provider":"nvidia"}`)); err != nil {
                t.Fatalf("write poisoned frame: %v", err)
        }

        ev := v0951ReadUntil(t, conn, func(e map[string]any) bool { return e["type"] == "error" })
        if !strings.Contains(fmt.Sprint(ev["text"]), "session mismatch") {
                t.Fatalf("expected session-mismatch error, got: %v", ev)
        }

        // Nothing executed: no user event in EITHER log.
        if n := v0951CountEvents(t, s, "sessA", "user"); n != 0 {
                t.Fatalf("poisoned frame executed in A's log: %d user events", n)
        }
        if n := v0951CountEvents(t, s, "sessB", "user"); n != 0 {
                t.Fatalf("poisoned frame executed in B's log: %d user events", n)
        }
        // B's session config untouched by the override rider.
        sess, err := s.db.GetSession("sessB")
        if err != nil || sess == nil {
                t.Fatalf("get B: %v", err)
        }
        if sess.Model != "nvidia/m2" {
                t.Fatalf("B's model rewritten by the rejected frame: %q", sess.Model)
        }
}

// THE CONTRACT: a frame naming the socket's OWN session proceeds normally
// (the user event lands in that session's log) — the guard must not break
// the honest path.
func TestV0951MatchingFrameProceeds(t *testing.T) {
        s := newSearchTestServer(t)
        if err := s.db.CreateSession(&store.Session{ID: "sessA", Title: "A", Model: "nvidia/m1", Provider: "nvidia", Sandbox: "quick"}); err != nil {
                t.Fatalf("create A: %v", err)
        }

        conn, _ := v0951Dial(t, s, "sessA")
        _ = conn.SetWriteDeadline(time.Now().Add(2 * time.Second))
        if err := conn.WriteMessage(websocket.TextMessage, []byte(
                `{"type":"send","message":"hello there","session_id":"sessA","model":"nvidia/m1","provider":"nvidia","effort":"high"}`)); err != nil {
                t.Fatalf("write frame: %v", err)
        }

        // The user event must arrive on the wire AND persist.
        v0951ReadUntil(t, conn, func(e map[string]any) bool { return e["type"] == "user" })

        // Drain the turn to its terminal status so the turn goroutine never
        // outlives the test's tempdir (its later emits would log readonly-db
        // noise against the cleaned-up store).
        v0951ReadUntil(t, conn, func(e map[string]any) bool {
                return e["type"] == "status"
        })

        deadline := time.Now().Add(3 * time.Second)
        for time.Now().Before(deadline) {
                if v0951CountEvents(t, s, "sessA", "user") == 1 {
                        return
                }
                time.Sleep(50 * time.Millisecond)
        }
        t.Fatalf("valid frame's user event never persisted")
}

// v0.95.1: the send frame NEVER persists session config. The model override
// rides the turn (per-turn copy) — the session's saved model stays put (the
// UI persists real switches via PATCH /api/sessions).
func TestV0951SendFrameDoesNotPersistModel(t *testing.T) {
        s := newSearchTestServer(t)
        if err := s.db.CreateSession(&store.Session{ID: "sessA", Title: "A", Model: "nvidia/m1", Provider: "nvidia", Sandbox: "quick"}); err != nil {
                t.Fatalf("create A: %v", err)
        }

        conn, _ := v0951Dial(t, s, "sessA")
        _ = conn.SetWriteDeadline(time.Now().Add(2 * time.Second))
        if err := conn.WriteMessage(websocket.TextMessage, []byte(
                `{"type":"send","message":"hi","session_id":"sessA","model":"nvidia/DIFFERENT-model","provider":"nvidia"}`)); err != nil {
                t.Fatalf("write frame: %v", err)
        }
        v0951ReadUntil(t, conn, func(e map[string]any) bool { return e["type"] == "user" })
        // Drain the turn to terminal (see the twin in the matching-frame test).
        v0951ReadUntil(t, conn, func(e map[string]any) bool { return e["type"] == "status" })

        // Let the turn settle (it will fail provider-side — no key — but the
        // session row must NEVER have picked up the override model).
        deadline := time.Now().Add(3 * time.Second)
        for time.Now().Before(deadline) {
                sess, err := s.db.GetSession("sessA")
                if err != nil || sess == nil {
                        t.Fatalf("get A: %v", err)
                }
                if sess.Model != "nvidia/m1" {
                        t.Fatalf("send frame rewrote the session model: %q (the leak amplifier)", sess.Model)
                }
                // the turn reached a terminal state — check once more then stop
                if v0951HasTerminal(t, s, "sessA") {
                        break
                }
                time.Sleep(100 * time.Millisecond)
        }
        sess, _ := s.db.GetSession("sessA")
        if sess.Model != "nvidia/m1" {
                t.Fatalf("send frame rewrote the session model: %q (the leak amplifier)", sess.Model)
        }
}

func v0951HasTerminal(t *testing.T, s *Server, sessionID string) bool {
        t.Helper()
        evs, err := s.db.ListEvents(sessionID, 0)
        if err != nil {
                return false
        }
        for _, e := range evs {
                if e.EventType == "status" && strings.Contains(e.Content, `"error"`) {
                        return true
                }
                if e.EventType == "status" && strings.Contains(e.Content, `"idle"`) {
                        return true
                }
        }
        return false
}
