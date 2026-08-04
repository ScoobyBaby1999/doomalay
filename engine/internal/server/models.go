package server

import (
        "net/http"
)

// handleModels is GET /api/models — proxies to the brain's /models endpoint.
// The brain returns the provider catalog + syncStatus (dynamic, no static
// lists on the frontend). If the brain is down, returns an empty catalog
// with an error so the PWA can show "no providers configured."
func (s *Server) handleModels(w http.ResponseWriter, r *http.Request) {
        if s.brain == nil || !s.brain.Healthy() {
                writeJSON(w, 200, map[string]any{
                        "providers":   []any{},
                        "models":      []any{},
                        "syncStatus":  []any{},
                        "totalModels": 0,
                        "error":       "brain not running — install python + brain/requirements.txt",
                })
                return
        }
        data, err := s.brain.Models(r.Context())
        if err != nil {
                writeError(w, 502, "brain models: "+err.Error())
                return
        }
        w.Header().Set("Content-Type", "application/json")
        w.WriteHeader(200)
        w.Write(data)
}
