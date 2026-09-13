package server

import (
	"encoding/json"
	"net/http"
	"strings"

	"github.com/ScoobyBaby1999/doomalay/engine/internal/llm"
	"github.com/ScoobyBaby1999/doomalay/engine/internal/secrets"
)

// handleKeysList is GET /api/keys — returns which providers have keys set.
// NEVER returns the key values themselves (only the env_var + provider name).
func (s *Server) handleKeysList(w http.ResponseWriter, r *http.Request) {
	if s.vault == nil {
		writeJSON(w, 200, map[string]any{})
		return
	}
	keys := s.vault.List()
	// Reshape as {env_var: {provider, has_key, has_extra}} for the PWA.
	out := map[string]any{}
	for _, k := range keys {
		out[k.EnvVar] = map[string]any{
			"provider":  k.Provider,
			"env_var":   k.EnvVar,
			"has_key":   k.HasKey,
			"has_extra": k.HasExtra,
		}
	}
	writeJSON(w, 200, out)
}

// handleKeysSet is POST /api/keys — stores (or updates) a provider API key.
// Body: {"provider": "openrouter", "key": "sk-...", "extra": "...", "env_var": "OPENROUTER_API_KEY"}
// The env_var must be in the secrets.PROVIDER_KEY_ALLOWLIST.
func (s *Server) handleKeysSet(w http.ResponseWriter, r *http.Request) {
	if s.vault == nil {
		writeError(w, 500, "vault not initialized")
		return
	}
	var req struct {
		Provider string `json:"provider"`
		EnvVar   string `json:"env_var"`
		Key      string `json:"key"`
		Extra    string `json:"extra"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, 400, "invalid JSON: "+err.Error())
		return
	}
	if req.Key == "" {
		writeError(w, 400, "key is required")
		return
	}
	// Default env_var from provider if not specified.
	if req.EnvVar == "" && req.Provider != "" {
		for env, prov := range secrets.PROVIDER_KEY_ALLOWLIST {
			if prov == req.Provider && !strings.HasSuffix(env, "_EXTRA") {
				req.EnvVar = env
				break
			}
		}
	}
	if !secrets.IsAllowed(req.EnvVar) {
		writeError(w, 400, "env_var "+req.EnvVar+" not in allowlist")
		return
	}
	if err := s.vault.Set(req.EnvVar, req.Provider, req.Key, req.Extra); err != nil {
		writeError(w, 500, "vault set: "+err.Error())
		return
	}
	// Push updated keys to the brain.
	if s.brain != nil {
		s.brain.SetEnv(s.vault.AsEnv())
	}
	writeJSON(w, 200, map[string]any{"ok": true, "provider": req.Provider, "env_var": req.EnvVar})
}

// handleKeysDelete is DELETE /api/keys/{envVar} — removes a provider key.
func (s *Server) handleKeysDelete(w http.ResponseWriter, r *http.Request) {
	if s.vault == nil {
		writeError(w, 500, "vault not initialized")
		return
	}
	envVar := r.PathValue("envVar")
	if envVar == "" {
		// Fall back to query param for older clients.
		envVar = r.URL.Query().Get("env_var")
	}
	if envVar == "" {
		writeError(w, 400, "env_var is required")
		return
	}
	if err := s.vault.Delete(envVar); err != nil {
		writeError(w, 404, err.Error())
		return
	}
	if s.brain != nil {
		s.brain.SetEnv(s.vault.AsEnv())
	}
	writeJSON(w, 200, map[string]any{"ok": true})
}

// handleKeysValidate is GET /api/keys/validate?env_var=X — checks the stored
// key against the provider. Returns {state: valid|invalid|unverified, valid,
// model_count, reason}. "invalid" is only reported when the provider itself
// rejected the key (v0.12: previously a wrong base URL or an unsupported
// auth style made every key look invalid).
func (s *Server) handleKeysValidate(w http.ResponseWriter, r *http.Request) {
	if s.vault == nil {
		writeError(w, 500, "vault not initialized")
		return
	}
	envVar := r.URL.Query().Get("env_var")
	if envVar == "" {
		writeError(w, 400, "env_var query param is required")
		return
	}
	if _, _, err := s.vault.Get(envVar); err != nil {
		writeJSON(w, 200, map[string]any{"state": "invalid", "valid": false, "reason": "no key set for " + envVar})
		return
	}
	// Pass the full env map so extra vars (e.g. CLOUDFLARE_ACCOUNT_ID)
	// are available to the validator.
	result := llm.ValidateKey(envVar, s.vault.AsEnv())
	writeJSON(w, 200, result)
}

// handleKeysValue is GET /api/keys/value?env_var=PRIVATEMODEAI_API_KEY —
// returns the PLAINTEXT key, but ONLY for PrivateMode (v0.15).
//
// WHY: PrivateMode's API requires their E2E-encryption protocol (attestation
// + WASM crypto) — the engine cannot speak it, so PM chat turns run in the
// WebView through the official privatemode-ai SDK, which needs the key.
// This is exactly how PM's own web app works (the key lives client-side).
// Scope is deliberately PM-only; CORS blocks foreign origins; same-origin
// only in practice (the engine binds 127.0.0.1).
func (s *Server) handleKeysValue(w http.ResponseWriter, r *http.Request) {
	if s.vault == nil {
		writeError(w, 500, "vault not initialized")
		return
	}
	envVar := r.URL.Query().Get("env_var")
	if envVar != "PRIVATEMODEAI_API_KEY" {
		writeError(w, 403, "key values are only exposed for the PrivateMode SDK bridge")
		return
	}
	key, _, err := s.vault.Get(envVar)
	if err != nil {
		writeJSON(w, 200, map[string]any{"has_key": false})
		return
	}
	writeJSON(w, 200, map[string]any{"has_key": true, "key": key})
}
