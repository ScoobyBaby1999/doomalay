package server

import (
	"io"
	"net/http"
)

// handleTemplates is GET /api/templates — proxies to the brain's /templates.
// Returns the full template library (sophisticated roles + dynamic variables).
// If the brain is down, returns an empty list.
func (s *Server) handleTemplates(w http.ResponseWriter, r *http.Request) {
	if s.brain == nil || !s.brain.Healthy() {
		writeJSON(w, 200, map[string]any{"templates": []any{}})
		return
	}
	resp, err := http.Get(s.brain.URL() + "/templates")
	if err != nil {
		writeError(w, 502, "brain templates: "+err.Error())
		return
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(resp.StatusCode)
	w.Write(body)
}

// handleTemplateGet is GET /api/templates/{id} — proxies to the brain.
func (s *Server) handleTemplateGet(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if id == "" {
		writeError(w, 400, "template id is required")
		return
	}
	if s.brain == nil || !s.brain.Healthy() {
		writeError(w, 503, "brain not available")
		return
	}
	resp, err := http.Get(s.brain.URL() + "/templates/" + id)
	if err != nil {
		writeError(w, 502, "brain template: "+err.Error())
		return
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(resp.StatusCode)
	w.Write(body)
}
