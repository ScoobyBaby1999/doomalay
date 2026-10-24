// debug.go — v1.73.0 DEBUG ENDPOINT
//
// GET /api/chat/debug/{sid} — per-turn timeline + per-tool phases

package server

import (
	"net/http"

	"github.com/ScoobyBaby1999/doomalay/engine/internal/store"
)

func (s *Server) handleChatDebug(w http.ResponseWriter, r *http.Request) {
	sid := r.PathValue("sid")
	if sid == "" {
		writeError(w, 400, "session_id required")
		return
	}
	
	sess, err := s.db.GetSession(sid)
	if err != nil || sess == nil {
		writeError(w, 404, "session not found")
		return
	}
	
	// Load persisted turn state
	var turnState store.TurnState
	if s.db != nil {
		turnState, _ = s.db.LoadTurnState(sid)
	}
	
	// Load event log for this session
	var events []*store.Event
	if s.db != nil {
		events, _ = s.db.ListEvents(sid, 0)
	}
	
	// Build debug response
	resp := map[string]any{
		"session_id":      sid,
		"session_title":   sess.Title,
		"turn_state":      turnState,
		"event_log":       events,
		"current_round":   turnState.Round,
		"fsm_phase":       turnState.FSMPhase,
		"partial_output":  turnState.PartialOut,
		"tool_results":    turnState.ToolResults,
	}
	
	writeJSON(w, 200, resp)
}