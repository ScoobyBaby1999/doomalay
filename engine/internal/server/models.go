package server

import (
        "encoding/json"
        "net/http"

        "github.com/ScoobyBaby1999/doomalay/engine/internal/llm"
)

// handleModels is GET /api/models — returns the provider catalog + sync status.
// If the Python brain is available, proxies to it (the brain uses litellm for
// richer sync). If the brain is down, syncs /v1/models directly from Go
// (the Android APK path — no Python needed).
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

        // Brain unavailable — use the direct Go LLM catalog + sync.
        if s.vault == nil {
                // No vault → return the catalog with no keys.
                catalog, _ := llm.LoadCatalog()
                resp := &llm.ModelsResponse{
                        Providers:   catalog,
                        Models:      []llm.ModelInfo{},
                        SyncStatus:  []llm.SyncStatus{},
                        TotalModels: 0,
                }
                writeJSON(w, 200, resp)
                return
        }

        keys := s.vault.AsEnv()
        resp := llm.SyncModels(keys, refresh)
        w.Header().Set("Content-Type", "application/json")
        json.NewEncoder(w).Encode(resp)
}
