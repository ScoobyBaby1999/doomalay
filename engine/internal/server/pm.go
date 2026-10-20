package server

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"github.com/ScoobyBaby1999/doomalay/engine/internal/llm"
	"github.com/ScoobyBaby1999/doomalay/engine/internal/pm/privatemode"
	"github.com/ScoobyBaby1999/doomalay/engine/internal/pmstate"
)

// v1.44.2 THE PIN (PLAN-V144-THE-NATIVE-PM.md §2) — the engine's PM pin
// surface. The one-shot WASM oracle (the app's vendored npm SDK at
// provider connect — the only thing licensed to run Edgeless's
// attestation verifier) reports its verdict here; the engine pins its
// own fresh attest fetch, TOFU-gated, honestly surfaced. The endpoints
// never return secret material.

// pmTransportAdapter adapts *pmstate.Manager to llm.PMTransport (Go
// interfaces are invariant in method result types: the manager's Client
// returns the concrete *privatemode.Client, whose StreamChatCompletions
// returns the concrete stream — both adapt explicitly here — v1.44.3
// THE WIRE).
type pmTransportAdapter struct {
	m *pmstate.Manager
}

func (a pmTransportAdapter) Client(ctx context.Context) (llm.PMClient, error) {
	c, err := a.m.Client(ctx)
	if err != nil {
		return nil, err
	}
	return pmClientAdapter{c: c}, nil
}

func (a pmTransportAdapter) DropSecret() { a.m.DropSecret() }

// pmClientAdapter wraps the concrete vendored client for llm.PMClient.
type pmClientAdapter struct {
	c *privatemode.Client
}

func (a pmClientAdapter) StreamChatCompletions(ctx context.Context, body []byte) (llm.PMStream, error) {
	s, err := a.c.StreamChatCompletions(ctx, body)
	if err != nil {
		return nil, err
	}
	return pmStreamAdapter{s: s}, nil
}

func (a pmClientAdapter) ChatCompletions(ctx context.Context, body []byte) ([]byte, error) {
	return a.c.ChatCompletions(ctx, body)
}

// pmStreamAdapter wraps the concrete decrypted-SSE stream for llm.PMStream.
type pmStreamAdapter struct {
	s *privatemode.ChatCompletionsStream
}

func (a pmStreamAdapter) Next() ([]byte, error) { return a.s.Next() }

func (a pmStreamAdapter) Close() error { return a.s.Close() }

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

// ── v1.44.3 THE WIRE: the handshake tickets ──────────────────────
//
// The standing /api/keys/value plaintext hole DIES in this phase: the
// raw key is served ONLY against a fresh single-use ticket, minted by
// the oracle (pmsdk.js) immediately before the wasm handshake needs
// it. 60s TTL, one use, engine-memory only. The turn path needs the
// raw key NOWHERE anymore — llm.Chat speaks PM natively through the
// pinned client; the WebView bridge (until v1.44.4 THE STRIP) and the
// connect-time oracle are the only key consumers, and both mint.

const pmTicketTTL = 60 * time.Second

// handlePMHandshakeTicket is POST /api/pm/handshake-ticket — mints the
// scoped single-use ticket the SDK bridge redeems at /api/keys/value.
func (s *Server) handlePMHandshakeTicket(w http.ResponseWriter, r *http.Request) {
	if s.vault == nil || s.pm == nil {
		writeError(w, 500, "pm pin not initialized (vault missing)")
		return
	}
	if _, _, err := s.vault.Get(pmstate.KeyEnvVar); err != nil {
		writeError(w, 400, "no PrivateMode API key saved — connect the provider first")
		return
	}
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		writeError(w, 500, "ticket entropy: "+err.Error())
		return
	}
	ticket := hex.EncodeToString(buf)
	now := time.Now()
	s.pmTickets.Store(ticket, now.Add(pmTicketTTL))
	// Opportunistic sweep: expired tickets never accumulate.
	s.pmTickets.Range(func(k, v any) bool {
		if exp, ok := v.(time.Time); ok && now.After(exp) {
			s.pmTickets.Delete(k)
		}
		return true
	})
	writeJSON(w, 200, map[string]any{"ticket": ticket, "expires_in": int(pmTicketTTL.Seconds())})
}

// consumePMTicket redeems a handshake ticket: single use, expiry-checked.
func (s *Server) consumePMTicket(ticket string) bool {
	if ticket == "" {
		return false
	}
	v, loaded := s.pmTickets.LoadAndDelete(ticket)
	if !loaded {
		return false
	}
	exp, ok := v.(time.Time)
	return ok && time.Now().Before(exp)
}
