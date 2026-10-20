package server

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/ScoobyBaby1999/doomalay/engine/internal/pmstate"
)

// v1.44.5 THE BRAIN — the local PM bridge battery (offline): the
// api-key-fallback=never law + the honest error shapes. The full
// streaming shape is the live gate (pm_v1445_live_test.go, pmlive).
func TestV1445_LocalBridge_KeyGate(t *testing.T) {
	s, vault := newPMServer(t)
	if err := vault.Set(pmstate.KeyEnvVar, "privatemodeai", "pm-bridge-key-1", ""); err != nil {
		t.Fatalf("set key: %v", err)
	}
	post := func(auth string, body string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodPost, "/api/pm/local/v1/chat/completions", bytes.NewBufferString(body))
		if auth != "" {
			req.Header.Set("Authorization", "Bearer "+auth)
		}
		rec := httptest.NewRecorder()
		s.handlePMLocalChat(rec, req)
		return rec
	}
	// The api-key-fallback=never law: only the vault's exact key.
	if rec := post("pm-bridge-key-1", `{"model":"m","messages":[]}`); rec.Code == 401 {
		t.Fatalf("the vault's own key must pass the gate (it fails later at the exchange, not here): %d %s", rec.Code, rec.Body.String())
	}
	if rec := post("wrong-key", `{"model":"m"}`); rec.Code != 401 {
		t.Fatalf("wrong key: %d", rec.Code)
	}
	if rec := post("", `{"model":"m"}`); rec.Code != 401 {
		t.Fatalf("missing key: %d", rec.Code)
	}
	if rec := post("pm-bridge-key-1", ``); rec.Code != 400 {
		t.Fatalf("empty body: %d", rec.Code)
	}
	// The honest error mentions the law.
	if !bytes.Contains(post("x", "{}").Body.Bytes(), []byte("api-key-fallback=never")) {
		t.Fatalf("the 401 must name the law: %s", post("x", "{}").Body.String())
	}
}

func TestV1445_LocalBridge_NoKeyIs503(t *testing.T) {
	s, _ := newPMServer(t)
	req := httptest.NewRequest(http.MethodPost, "/api/pm/local/v1/chat/completions", bytes.NewBufferString(`{"model":"m"}`))
	req.Header.Set("Authorization", "Bearer anything")
	rec := httptest.NewRecorder()
	s.handlePMLocalChat(rec, req)
	if rec.Code != 503 {
		t.Fatalf("no PM key in the vault: %d %s", rec.Code, rec.Body.String())
	}
}

func TestV1445_LocalBridge_NoVaultIs500(t *testing.T) {
	s := &Server{}
	req := httptest.NewRequest(http.MethodPost, "/api/pm/local/v1/chat/completions", bytes.NewBufferString(`{}`))
	rec := httptest.NewRecorder()
	s.handlePMLocalChat(rec, req)
	if rec.Code != 500 {
		t.Fatalf("no vault: %d", rec.Code)
	}
}
