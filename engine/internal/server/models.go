package server

import (
	"encoding/json"
	"net/http"

	"github.com/ScoobyBaby1999/doomalay/engine/internal/llm"
)

// handleModels is GET /api/models — the provider catalog + LIVE model sync
// with the logical (model-view) catalog.
//
// v1.55.3 THE LIVING CATALOG: the brain proxy is GONE. The engine's own Go
// build is ALWAYS the truth — every provider's list is fetched live from
// the provider's own API and enriched from the LIVE models.dev registry
// (the user's law: "no static lists, not even fallback"); the brain's
// static catalogs (its old-shape /models with the embedded
// models_catalog.json) never reach the PWA again, and desktop + Android
// now serve byte-identical catalogs. hf — the one provider the brain had
// that the Go catalog lacked — joined the ENGINE catalog this wave.
//
//   - providers: the catalog configs (provider cards)
//   - models:    flat "provider/id" list (v0.12 compat)
//   - groups:    per-provider model groups (provider view)
//   - logical:   family-grouped models with host routes (model view)
//   - syncStatus + totalModels + syncedAt
//
// ?refresh=1 forces a live re-sync (bypasses the 10-minute cache).
// The served key state (hasApiKey per group / syncStatus / host route) is
// ALWAYS re-derived from the live vault (ApplyLiveKeyState) — a key saved
// via POST /api/keys shows up on the very next poll.
func (s *Server) handleModels(w http.ResponseWriter, r *http.Request) {
	refresh := r.URL.Query().Get("refresh") == "1"

	var keys map[string]string
	if s.vault != nil {
		keys = s.vault.AsEnv()
	} else {
		keys = map[string]string{}
	}
	resp := llm.ApplyLiveKeyState(llm.BuildCatalogV2(keys, refresh), keys)
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(resp)
}
