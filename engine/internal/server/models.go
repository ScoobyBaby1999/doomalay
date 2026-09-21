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
// v0.42: the served key state (hasApiKey per group / syncStatus / host
// route) is ALWAYS re-derived from the live vault (ApplyLiveKeyState) — a
// key saved via POST /api/keys shows up on the very next poll, and the
// response is marked Partial while the key-triggered resync lands the
// models (never a stale startup snapshot).
func (s *Server) handleModels(w http.ResponseWriter, r *http.Request) {
	refresh := r.URL.Query().Get("refresh") == "1"

	// If the brain is available, proxy to it.
	if s.brain != nil && s.brain.Healthy() {
		data, err := s.brain.Models(r.Context())
		if err != nil {
			writeError(w, 502, "brain models: "+err.Error())
			return
		}
		// v0.38 SHAPE RECONCILIATION: the brain's /models speaks the
		// OLD shape (providers/models only — no groups, no logical),
		// so a healthy brain left the model browser with ZERO logical
		// models (compare drawer, model tab, star flows all starved).
		// Fill the missing sections from the engine's own v2 catalog
		// (same key set, cached) — the brain's providers/models still
		// win when present.
		var brainResp map[string]json.RawMessage
		if json.Unmarshal(data, &brainResp) == nil {
			_, hasLogical := brainResp["logical"]
			_, hasGroups := brainResp["groups"]
			if !hasLogical || !hasGroups {
				var keys map[string]string
				if s.vault != nil {
					keys = s.vault.AsEnv()
				} else {
					keys = map[string]string{}
				}
				eng := llm.ApplyLiveKeyState(llm.BuildCatalogV2(keys, false), keys) // v0.42: live key flags
				if b, err := json.Marshal(eng); err == nil {
					var engResp map[string]json.RawMessage
					if json.Unmarshal(b, &engResp) == nil {
						for _, section := range []string{"groups", "logical"} {
							if _, present := brainResp[section]; !present {
								if v, ok := engResp[section]; ok {
									brainResp[section] = v
								}
							}
						}
						if merged, err := json.Marshal(brainResp); err == nil {
							data = merged
						}
					}
				}
			}
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
	resp := llm.ApplyLiveKeyState(llm.BuildCatalogV2(keys, refresh), keys) // v0.42: live key flags
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(resp)
}
