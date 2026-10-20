package server

import (
	"encoding/json"
	"errors"
	"net/http"

	"github.com/ScoobyBaby1999/doomalay/engine/internal/pmstate"
)

// v1.44.2 THE PIN (PLAN-V144-THE-NATIVE-PM.md §2) — the engine's PM pin
// surface. The one-shot WASM oracle (the app's vendored npm SDK at
// provider connect — the only thing licensed to run Edgeless's
// attestation verifier) reports its verdict here; the engine pins its
// own fresh attest fetch, TOFU-gated, honestly surfaced. The endpoints
// never return secret material.

// handlePMState is GET /api/pm/state — the honest pin surface for the
// connect UI's pill: {key_present, pinned, verified, secret_expires_in,
// pinned_at}.
func (s *Server) handlePMState(w http.ResponseWriter, r *http.Request) {
	if s.vault == nil || s.pm == nil {
		writeError(w, 500, "pm pin not initialized (vault missing)")
		return
	}
	writeJSON(w, 200, s.pm.Status())
}

// handlePMBootstrap is POST /api/pm/bootstrap — the one-shot WASM
// oracle's report. Body: {verified, manifest?, secret_id?,
// secret_data?, exp_unix?}. The engine fetches its own attest doc and
// pins the mesh CA it extracts; verified=true ONLY when the oracle's
// verify() succeeded in the same window. The oracle's exported secret
// seeds the pin when valid.
func (s *Server) handlePMBootstrap(w http.ResponseWriter, r *http.Request) {
	if s.vault == nil || s.pm == nil {
		writeError(w, 500, "pm pin not initialized (vault missing)")
		return
	}
	var res pmstate.OracleResult
	if err := json.NewDecoder(r.Body).Decode(&res); err != nil {
		writeError(w, 400, "invalid JSON: "+err.Error())
		return
	}
	st, err := s.pm.Bootstrap(r.Context(), res)
	if err != nil {
		if errors.Is(err, pmstate.ErrNoKey) {
			writeError(w, 400, err.Error())
			return
		}
		writeError(w, 502, err.Error())
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true, "pinned": st.Pinned, "verified": st.Verified})
}

// handlePMReverify is POST /api/pm/reverify — clears the pin (the
// honest reset). The UI's next PM action re-runs the wasm oracle
// (fresh verify) which re-pins via bootstrap; a headless engine
// re-pins TOFU (verified=false) on its next PM turn.
func (s *Server) handlePMReverify(w http.ResponseWriter, r *http.Request) {
	if s.vault == nil || s.pm == nil {
		writeError(w, 500, "pm pin not initialized (vault missing)")
		return
	}
	if err := s.pm.Reverify(); err != nil {
		writeError(w, 500, err.Error())
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true, "pinned": false})
}
