package server

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"sync"

	"github.com/gorilla/websocket"

	"github.com/ScoobyBaby1999/doomalay/engine/internal/store"
)

// chat.go implements the WebSocket chat endpoint — the heart of the V0 bug-fix.
//
// FLOW:
//  1. PWA opens WS /api/chat?session_id=<id>
//  2. Engine subscribes — replays existing chat_events (since=0) so the PWA
//     reconstructs state on reconnect (idempotent: dedup by seq client-side).
//  3. PWA sends a JSON message: {"type":"send","message":"...","model":...}
//  4. Engine acquires the per-session _turn_lock (non-blocking; rejects if busy).
//     V0 FIX: the lock is released in `defer` — never gets stuck.
//  5. Engine calls brain.Chat() with the message + session config.
//  6. As the brain streams SSE events back, the engine:
//       a. Appends each event to chat_events (V0 FIX: backend-writes-events-
//          as-it-emits — not the frontend at turn-end).
//       b. Forwards each event to the PWA over the WS.
//  7. On the brain's terminal event (status:idle / error), the engine releases
//     the lock.
//
// The PWA's streamWorker parses each WS frame and updates the per-session
// Zustand slice (sessions.ts) — only the changed session re-renders.

var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool { return true }, // CORS handles origin
}

// sessionLocks guards one-in-flight-turn per session (the V0 stuck-busy fix).
var (
	sessionLocksMu sync.Mutex
	sessionLocks   = make(map[string]chan struct{})
)

// lockSession acquires the per-session turn lock. Returns a release function
// and false if already locked (busy).
func lockSession(id string) (release func(), ok bool) {
	sessionLocksMu.Lock()
	ch, exists := sessionLocks[id]
	if !exists {
		ch = make(chan struct{}, 1)
		sessionLocks[id] = ch
	}
	sessionLocksMu.Unlock()
	select {
	case ch <- struct{}{}:
		return func() { <-ch }, true
	default:
		return nil, false
	}
}

// handleChatWS is GET /api/chat?session_id=<id> — the WebSocket chat endpoint.
func (s *Server) handleChatWS(w http.ResponseWriter, r *http.Request) {
	sessionID := r.URL.Query().Get("session_id")
	if sessionID == "" {
		writeError(w, 400, "session_id is required")
		return
	}
	// Verify the session exists.
	sess, err := s.db.GetSession(sessionID)
	if err != nil {
		writeError(w, 500, "get session: "+err.Error())
		return
	}
	if sess == nil {
		writeError(w, 404, "session not found")
		return
	}

	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("ws upgrade: %v", err)
		return
	}
	defer conn.Close()

	// Replay existing events (since=0) so a reconnecting PWA sees full history.
	// V0 idempotency: the PWA dedups by seq.
	existing, err := s.db.ListEvents(sessionID, 0)
	if err != nil {
		log.Printf("list events: %v", err)
	} else {
		for _, ev := range existing {
			b, _ := ev.ToJSON()
			if err := conn.WriteMessage(websocket.TextMessage, b); err != nil {
				return
			}
		}
	}

	// Read loop: handle PWA messages (send / stop).
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()

	for {
		_, raw, err := conn.ReadMessage()
		if err != nil {
			return // PWA disconnected
		}
		var msg map[string]any
		if err := json.Unmarshal(raw, &msg); err != nil {
			continue
		}
		msgType, _ := msg["type"].(string)
		switch msgType {
		case "send":
			go s.handleTurn(ctx, conn, sessionID, sess, msg)
		case "stop":
			cancel() // aborts the in-flight brain.Chat (ctx cancellation)
		}
	}
}

// handleTurn runs one chat turn: acquire lock → call brain → persist + forward events → release lock.
func (s *Server) handleTurn(ctx context.Context, conn *websocket.Conn, sessionID string, sess *store.Session, msg map[string]any) {
	// V0 FIX: per-session turn lock, non-blocking acquire, release in defer.
	release, ok := lockSession(sessionID)
	if !ok {
		s.emit(conn, sessionID, "error", `{"error":"busy","message":"agent already processing"}`, "")
		return
	}
	defer release()

	// Persist the user's message immediately (V0 FIX: backend writes events).
	userText, _ := msg["message"].(string)
	if _, err := s.db.AppendEvent(sessionID, "user", userText, ""); err != nil {
		log.Printf("persist user msg: %v", err)
	}
	s.emit(conn, sessionID, "user", userText, "")

	// Build the brain request.
	brainReq := map[string]any{
		"session_id":    sessionID,
		"message":       userText,
		"model":         sess.Model,
		"provider":      sess.Provider,
		"effort":        sess.Effort,
		"mode":          sess.Mode,
		"web_search":    sess.WebSearch,
		"deep_research": sess.DeepResearch,
		"system_prompt": "", // TODO: build from mode + workspace + memory
	}
	if v, ok := msg["model"].(string); ok && v != "" {
		brainReq["model"] = v // allow per-message override
	}

	// Stream from the brain.
	if s.brain == nil || !s.brain.Healthy() {
		s.emit(conn, sessionID, "error", `{"error":"brain_offline","message":"Python brain not running. Install python + brain/requirements.txt to enable chat."}`, "")
		s.emit(conn, sessionID, "status", `{"state":"error","usage":null}`, "")
		return
	}

	events, errs, err := s.brain.Chat(ctx, brainReq)
	if err != nil {
		s.emit(conn, sessionID, "error", `{"error":"brain","message":"`+err.Error()+`"}`, "")
		s.emit(conn, sessionID, "status", `{"state":"error","usage":null}`, "")
		return
	}

	for ev := range events {
		// Normalize the event into the wire format + persist.
		evType, _ := ev["type"].(string)
		// Extract text/content for persistence.
		var content string
		switch evType {
		case "thinking", "assistant_delta", "tool_result", "title", "error":
			if t, ok := ev["text"].(string); ok {
				content = t
			}
		case "tool_use":
			name, _ := ev["name"].(string)
			summary, _ := ev["summary"].(string)
			content = name
			if summary != "" {
				content += " " + summary
			}
		case "status":
			// Store the full status object as JSON (state + usage).
			state, _ := ev["state"].(string)
			usage := ev["usage"]
			statusObj := map[string]any{"state": state}
			if usage != nil {
				statusObj["usage"] = usage
			}
			b, _ := json.Marshal(statusObj)
			content = string(b)
		}
		toolUseID, _ := ev["tool_use_id"].(string)

		// V0 FIX: persist the event AS IT EMITS (not at turn-end).
		persisted, err := s.db.AppendEvent(sessionID, evType, content, toolUseID)
		if err != nil {
			log.Printf("persist event: %v", err)
			continue
		}
		// Forward to PWA with the assigned seq + id.
		out := map[string]any{
			"i":          persisted.ID,
			"ts":         persisted.CreatedAt,
			"type":       evType,
			"session_id": sessionID,
		}
		for k, v := range ev {
			if k == "type" {
				continue
			}
			out[k] = v
		}
		out["seq"] = persisted.Seq
		b, _ := json.Marshal(out)
		if err := conn.WriteMessage(websocket.TextMessage, b); err != nil {
			return
		}

		// Auto-name on first turn (V0 FIX: flag-after-success).
		if evType == "status" {
			state, _ := ev["state"].(string)
			if state == "idle" {
				// Try LLM title if not yet set + not manually renamed.
				if sess.Title == "New Chat" && !sess.ManuallyRenamed {
					go s.maybeAutoTitle(sessionID, sess, userText)
				}
			}
		}
	}
	if err := <-errs; err != nil {
		log.Printf("brain stream error: %v", err)
	}
}

// maybeAutoTitle derives a title from the first user message (immediate,
// synchronous) and tries an LLM title (async, best-effort). V0 FIX: the
// "title generated" flag is set only AFTER a successful title write.
func (s *Server) maybeAutoTitle(sessionID string, sess *store.Session, firstMsg string) {
	// Immediate: truncate the first user message.
	if firstMsg == "" {
		return
	}
	title := firstMsg
	if len(title) > 48 {
		title = title[:48]
	}
	if err := s.db.SetSessionTitle(sessionID, title, true); err == nil {
		// Emit a title event so the PWA updates the sidebar.
		s.emit(nil, sessionID, "title", title, "")
	}
	// TODO: async LLM title via brain (best-effort, 20s timeout, falls back to truncation).
}

// emit sends a JSON event to the WebSocket (or no-op if conn is nil).
func (s *Server) emit(conn *websocket.Conn, sessionID, evType, content, toolUseID string) {
	persisted, err := s.db.AppendEvent(sessionID, evType, content, toolUseID)
	if err != nil {
		log.Printf("emit persist: %v", err)
		return
	}
	if conn == nil {
		return
	}
	out := map[string]any{
		"i":          persisted.ID,
		"ts":         persisted.CreatedAt,
		"type":       evType,
		"session_id": sessionID,
		"seq":        persisted.Seq,
	}
	switch evType {
	case "user", "thinking", "assistant_delta", "tool_result", "title", "error":
		out["text"] = content
	case "tool_use":
		out["name"] = content
	case "status":
		out["state"] = content
	}
	if toolUseID != "" {
		out["tool_use_id"] = toolUseID
	}
	b, _ := json.Marshal(out)
	_ = conn.WriteMessage(websocket.TextMessage, b)
}
