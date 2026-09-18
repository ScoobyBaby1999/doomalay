package server

import (
	"net/http"

	"github.com/ScoobyBaby1999/doomalay/engine/internal/buildinfo"
)

// handleHealth is GET /api/health — liveness probe.
func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, 200, map[string]any{
		"status":  "ok",
		"version": buildinfo.Version,
		"mode":    s.cfg.Mode,
		"brain":   s.brain != nil && s.brain.Healthy(),
	})
}
