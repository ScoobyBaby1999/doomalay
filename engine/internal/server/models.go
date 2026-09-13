package server

import (
	"encoding/json"
	"net/http"

	"github.com/ScoobyBaby1999/doomalay/engine/internal/llm"
)

// handleModels is GET /api/models — the provider catalog + LIVE model sync
// with the logical (model-view) catalog.
//
// If the Python brain is available, proxies to it (richer litellm sync).
// If the brain is down (the Android APK path), builds the v2 catalog in Go:
//   - providers: the catalog configs (provider cards)
//   - models:    flat "provider/id" list (v0.12 compat)
//   - groups:    per-provider model groups (provider view)
//   - logical:   family-grouped models with host routes (model view)
//   - syncStatus + totalModels + syncedAt
//
// ?refresh=1 forces a live re-sync (bypasses the 10-minute cache).
func (s *Server) handleModels(w http.ResponseWriter, r *http.Request) {
	refresh := r.URL.Query().Get("refresh") == "1"

	// If the brain is available, proxy to it.
	if s.brain != nil && s.brain.Healthy() {
		data, err := s.brain.Models(r.Context())
		if err != nil {
			writeError(w, 502, "brain models: "+err.Error())
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(200)
		w.Write(data)
		return
	}

	// Brain unavailable — build the dynamic catalog in Go.
	var keys map[string]string
	if s.vault != nil {
		keys = s.vault.AsEnv()
	} else {
		keys = map[string]string{}
	}
	resp := llm.BuildCatalogV2(keys, refresh)
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(resp)
}
