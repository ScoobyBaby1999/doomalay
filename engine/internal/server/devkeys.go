// devkeys.go — v0.48 (task 5): the dev-build-only "use public key" feature.
//
// The assistant holds a set of PROVIDER keys the community may share for
// testing (the user's call: they are already public/compromised — the gate
// is the DEV BUILD, not secrecy). POST /api/dev/use-public-keys installs
// them into the vault with the exact same post-processing as a manual key
// save (brain env push, remote-brain fan-out, live catalog resync) so the
// providers panel immediately shows them as validated.
//
// The endpoint 404s on release builds (buildinfo.Dev == false).
package server

import (
	"net/http"

	"github.com/ScoobyBaby1999/doomalay/engine/internal/buildinfo"
	"github.com/ScoobyBaby1999/doomalay/engine/internal/llm"
)

// devPublicKeys are the assistant's held provider keys (env var → key).
// Dev-build only — release builds never serve them.
var devPublicKeys = map[string]string{
	"OPENCODE_ZEN_API_KEY":  "sk-cyLb39BOXfSSz3mLDOwPXAH34CaY8cmpwUHWFTmZHEiuJz0kRr5dV58NsjerrLVM",
	"PRIVATEMODEAI_API_KEY": "76277df9-5fd3-4fcc-8173-5705e83bc067",
	"NVIDIA_API_KEY":        "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",
}

// handleDevUsePublicKeys is POST /api/dev/use-public-keys — installs the
// shared public provider keys (dev builds only).
func (s *Server) handleDevUsePublicKeys(w http.ResponseWriter, r *http.Request) {
	if !buildinfo.Dev {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	if s.vault == nil {
		writeError(w, http.StatusInternalServerError, "vault not initialized")
		return
	}
	installed := make([]string, 0, len(devPublicKeys))
	for env, key := range devPublicKeys {
		provider := devPublicProvider(env)
		if err := s.vault.Set(env, provider, key, ""); err != nil {
			writeError(w, http.StatusInternalServerError, "vault set "+env+": "+err.Error())
			return
		}
		installed = append(installed, env)
	}
	// same post-processing as handleKeysSet: push to the local brain, fan
	// out to remote HF sandboxes, and resync the live model catalog.
	if s.brain != nil {
		s.brain.SetEnv(s.vault.AsEnv())
		llm.SetGitHubToken(s.vault.AsEnv()["GITHUB_TOKEN"])
	}
	s.fanOutRemoteEnv()
	go llm.BuildCatalogV2(s.vault.AsEnv(), true)
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":        true,
		"installed": installed,
	})
}

// devPublicProvider maps an env var to its provider slug (the same pairing
// as secrets.PROVIDER_KEY_ALLOWLIST).
func devPublicProvider(env string) string {
	switch env {
	case "OPENCODE_ZEN_API_KEY":
		return "opencode"
	case "PRIVATEMODEAI_API_KEY":
		return "privatemodeai"
	case "NVIDIA_API_KEY":
		return "nvidia"
	}
	return "dev"
}
