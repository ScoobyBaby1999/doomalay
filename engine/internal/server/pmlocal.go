package server

import (
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"

	"github.com/ScoobyBaby1999/doomalay/engine/internal/pm/privatemode"
	"github.com/ScoobyBaby1999/doomalay/engine/internal/pmstate"
)

// v1.44.5 THE BRAIN (PLAN-V144 §5) — the engine's LOCAL PM bridge.
//
// The Python brain (litellm) cannot speak PM's E2E-encryption protocol,
// and the old answer — brain/pmproxy.mjs, a Node shim running the
// vendored npm SDK with a 6MB wasm on the side — retires this phase.
// The ENGINE is the protocol speaker now (v1.44.3 THE WIRE): it exposes
// the plain OpenAI-compatible wire on its own port for the co-located
// brain:
//
//      POST /api/pm/local/v1/chat/completions
//      Authorization: Bearer <the vault's PrivateMode key>
//
// Per-request key passthrough with the official proxy's
// --api-key-fallback=never law: the bridge serves ONLY the vault's PM
// key (constant-time compare; a wrong key is 401 — never a fallback to
// any other credential). The body rides the pinned client (TOFU pin,
// renewal, drift laws — pmstate owns them); stream:true answers SSE
// (decrypted events reframed), anything else answers the plain OpenAI
// JSON. HF-space brains (no co-located engine) skip PM honestly at
// registration — the catalog's {DOOMALAY_ENGINE_URL} placeholder stays
// unfilled there.

// pmLocalMaxBody caps the bridge's request body (chat histories can be
// large, but not unbounded — 32MB is ~8M tokens of JSON).
const pmLocalMaxBody = 32 << 20

// handlePMLocalChat is POST /api/pm/local/v1/chat/completions — the
// brain's PM bridge: plain OpenAI on the engine port, E2E-encrypted
// upstream through the pinned client.
func (s *Server) handlePMLocalChat(w http.ResponseWriter, r *http.Request) {
	if s.vault == nil || s.pm == nil {
		writeError(w, 500, "pm bridge not initialized (vault missing)")
		return
	}
	key, _, err := s.vault.Get(pmstate.KeyEnvVar)
	if err != nil {
		writeError(w, 503, "no PrivateMode key in the vault — connect the provider first")
		return
	}
	// The api-key-fallback=never law: constant-time exact match against
	// the vault's PM key; anything else is the honest 401.
	passthrough := strings.TrimSpace(strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer "))
	if len(passthrough) == 0 || subtle.ConstantTimeCompare([]byte(passthrough), []byte(key)) != 1 {
		writeError(w, 401, "the engine's PM bridge serves only the vault's PrivateMode key (api-key-fallback=never)")
		return
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, pmLocalMaxBody))
	if err != nil {
		writeError(w, 400, "read body: "+err.Error())
		return
	}
	if len(body) == 0 {
		writeError(w, 400, "empty request body")
		return
	}
	var shape struct {
		Stream bool   `json:"stream"`
		Model  string `json:"model"`
	}
	_ = json.Unmarshal(body, &shape) // best-effort shape probe; the gateway validates for real

	client, err := s.pm.Client(r.Context())
	if err != nil {
		if errors.Is(err, pmstate.ErrNoKey) {
			writeError(w, 503, err.Error())
			return
		}
		if errors.Is(err, pmstate.ErrPMDeploymentChanged) {
			writeError(w, 409, err.Error())
			return
		}
		writeError(w, 502, "pm bridge: "+err.Error())
		return
	}

	if shape.Stream {
		s.pmLocalStream(w, r, client, body)
		return
	}
	decrypted, err := client.ChatCompletions(r.Context(), body)
	if err != nil {
		s.pmLocalUpstreamError(w, err)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(decrypted)
}

// pmLocalStream pipes one streamed chat: decrypted events → SSE frames
// → the brain, ending with the [DONE] sentinel on a clean upstream end.
func (s *Server) pmLocalStream(w http.ResponseWriter, r *http.Request, client *privatemode.Client, body []byte) {
	stream, err := client.StreamChatCompletions(r.Context(), body)
	if err != nil {
		s.pmLocalUpstreamError(w, err)
		return
	}
	defer stream.Close()
	flusher, _ := w.(http.Flusher)
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.WriteHeader(http.StatusOK)
	for {
		chunk, err := stream.Next()
		if errors.Is(err, io.EOF) {
			_, _ = io.WriteString(w, "data: [DONE]\n\n")
			if flusher != nil {
				flusher.Flush()
			}
			return
		}
		if err != nil {
			// mid-stream cut: the honest SSE error frame (litellm surfaces it)
			msg := fmt.Sprintf("data: {\"error\":{\"message\":\"pm bridge stream cut: %s\",\"type\":\"pm_bridge\"}}\n\n", sanitizeSSE(err.Error()))
			_, _ = io.WriteString(w, msg)
			_, _ = io.WriteString(w, "data: [DONE]\n\n")
			if flusher != nil {
				flusher.Flush()
			}
			return
		}
		_, _ = io.WriteString(w, "data: ")
		_, _ = w.Write(chunk)
		_, _ = io.WriteString(w, "\n\n")
		if flusher != nil {
			flusher.Flush()
		}
	}
}

// pmLocalUpstreamError surfaces a failed PM call with its DECRYPTED body
// and status (the vendored client decrypts encrypted error bodies).
func (s *Server) pmLocalUpstreamError(w http.ResponseWriter, err error) {
	var rerr *privatemode.ResponseError
	if errors.As(err, &rerr) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(rerr.StatusCode)
		_, _ = w.Write(rerr.Body)
		return
	}
	writeError(w, 502, "pm bridge: "+err.Error())
}

// sanitizeSSE keeps an error string from breaking out of its SSE frame.
func sanitizeSSE(s string) string {
	s = strings.ReplaceAll(s, "\n", " ")
	s = strings.ReplaceAll(s, "\r", " ")
	if len(s) > 400 {
		s = s[:400] + "…"
	}
	return s
}
