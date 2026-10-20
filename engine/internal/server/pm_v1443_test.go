package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/ScoobyBaby1999/doomalay/engine/internal/pmstate"
)

// v1.44.3 THE WIRE — the handshake-ticket battery: the standing
// /api/keys/value plaintext hole is dead; the key is served ONLY against
// a fresh single-use ticket.

func mintTicket(t *testing.T, s *Server) string {
	t.Helper()
	rec := httptest.NewRecorder()
	s.handlePMHandshakeTicket(rec, httptest.NewRequest(http.MethodPost, "/api/pm/handshake-ticket", nil))
	if rec.Code != 200 {
		t.Fatalf("mint: %d %s", rec.Code, rec.Body.String())
	}
	var out struct {
		Ticket     string `json:"ticket"`
		ExpiresInS int    `json:"expires_in"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(out.Ticket) != 64 || out.ExpiresInS != 60 {
		t.Fatalf("ticket shape: %+v", out)
	}
	return out.Ticket
}

func TestV1443_Ticket_ValueEndpointGated(t *testing.T) {
	s, vault := newPMServer(t)
	if err := vault.Set(pmstate.KeyEnvVar, "privatemodeai", "pm-key-value-1", ""); err != nil {
		t.Fatalf("set key: %v", err)
	}
	// Bare GET: 403 — the standing hole is dead.
	rec := httptest.NewRecorder()
	s.handleKeysValue(rec, httptest.NewRequest(http.MethodGet, "/api/keys/value?env_var=PRIVATEMODEAI_API_KEY", nil))
	if rec.Code != 403 {
		t.Fatalf("bare GET must 403, got %d: %s", rec.Code, rec.Body.String())
	}
	// Mint → redeem once (200, the key) → the SAME ticket again: 403.
	ticket := mintTicket(t, s)
	rec = httptest.NewRecorder()
	s.handleKeysValue(rec, httptest.NewRequest(http.MethodGet, "/api/keys/value?env_var=PRIVATEMODEAI_API_KEY&ticket="+ticket, nil))
	if rec.Code != 200 {
		t.Fatalf("redeem: %d %s", rec.Code, rec.Body.String())
	}
	var kv struct {
		HasKey bool   `json:"has_key"`
		Key    string `json:"key"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &kv); err != nil || !kv.HasKey || kv.Key != "pm-key-value-1" {
		t.Fatalf("redeem body: %s", rec.Body.String())
	}
	rec = httptest.NewRecorder()
	s.handleKeysValue(rec, httptest.NewRequest(http.MethodGet, "/api/keys/value?env_var=PRIVATEMODEAI_API_KEY&ticket="+ticket, nil))
	if rec.Code != 403 {
		t.Fatalf("single use violated: %d", rec.Code)
	}
	// A bogus ticket: 403.
	rec = httptest.NewRecorder()
	s.handleKeysValue(rec, httptest.NewRequest(http.MethodGet, "/api/keys/value?env_var=PRIVATEMODEAI_API_KEY&ticket=deadbeef", nil))
	if rec.Code != 403 {
		t.Fatalf("bogus ticket: %d", rec.Code)
	}
}

func TestV1443_Ticket_ExpiryAndNoKey(t *testing.T) {
	s, vault := newPMServer(t)
	// No PM key: mint refuses (400).
	rec := httptest.NewRecorder()
	s.handlePMHandshakeTicket(rec, httptest.NewRequest(http.MethodPost, "/api/pm/handshake-ticket", nil))
	if rec.Code != 400 {
		t.Fatalf("mint without key must 400, got %d", rec.Code)
	}
	if err := vault.Set(pmstate.KeyEnvVar, "privatemodeai", "pm-key-value-2", ""); err != nil {
		t.Fatalf("set key: %v", err)
	}
	// An expired ticket: mint then age it past the TTL.
	ticket := mintTicket(t, s)
	s.pmTickets.Store(ticket, time.Now().Add(-time.Second))
	rec = httptest.NewRecorder()
	s.handleKeysValue(rec, httptest.NewRequest(http.MethodGet, "/api/keys/value?env_var=PRIVATEMODEAI_API_KEY&ticket="+ticket, nil))
	if rec.Code != 403 {
		t.Fatalf("expired ticket must 403, got %d", rec.Code)
	}
	// A non-PM env var stays rejected regardless of tickets.
	rec = httptest.NewRecorder()
	s.handleKeysValue(rec, httptest.NewRequest(http.MethodGet, "/api/keys/value?env_var=OPENROUTER_API_KEY&ticket="+mintTicket(t, s), nil))
	if rec.Code != 403 {
		t.Fatalf("non-PM env var: %d", rec.Code)
	}
}
