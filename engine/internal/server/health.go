package server

import "net/http"

// handleHealth is GET /api/health — liveness probe.
func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, 200, map[string]any{
		"status":  "ok",
		"version": "0.1.0",
		"mode":    s.cfg.Mode,
		"brain":   s.brain != nil && s.brain.Healthy(),
	})
}
