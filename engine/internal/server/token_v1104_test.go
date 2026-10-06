package server

// v1.10.4 TOKEN HONESTY — D2 regression tests: the OAuth expiry must be
// CAPTURED (both exchange paths), STORED (vault extra JSON), and SERVED
// (/api/hf/account expires_at / expires_in_hours / expired) so the silent
// 8-hour 401 can never happen again unnoticed.

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/ScoobyBaby1999/doomalay/engine/internal/hub"
)

func TestTokenMetaFromExtraBothShapes(t *testing.T) {
	// legacy bare username (the token-paste path)
	m := hub.TokenMetaFromExtra("alice")
	if m.User != "alice" || m.Kind != "" || m.ExpiresAt != 0 {
		t.Fatalf("bare shape: %+v", m)
	}
	// the new JSON shape (the OAuth path)
	js := `{"user":"bob","kind":"oauth","expires_at":1730000000}`
	m = hub.TokenMetaFromExtra(js)
	if m.User != "bob" || m.Kind != "oauth" || m.ExpiresAt != 1730000000 {
		t.Fatalf("json shape: %+v", m)
	}
	// empty
	if (hub.TokenMetaFromExtra("") != hub.TokenMeta{}) {
		t.Fatal("empty extra must parse to the zero meta")
	}
}

func TestHfAccountExpiryFields(t *testing.T) {
	mock := newAgeMockHF(t, http.StatusOK, `{}`)
	s := newV074TestServer(t, mock.URL)
	if rec := hubReq(t, s, "POST", "/api/hub/auth/connect", map[string]string{"token": "goodtoken"}); rec.Code != 200 {
		t.Fatalf("connect: %d", rec.Code)
	}
	rec := hubReq(t, s, "GET", "/api/hf/account", nil)
	if rec.Code != 200 {
		t.Fatalf("account: %d %s", rec.Code, rec.Body.String())
	}
	var acc struct {
		Connected   bool    `json:"connected"`
		User        string  `json:"user"`
		Auth        string  `json:"auth"`
		ExpiresAt   int64   `json:"expires_at"`
		ExpireInHrs float64 `json:"expires_in_hours"`
		Expired     bool    `json:"expired"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &acc); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if !acc.Connected || acc.User != "mockuser" {
		t.Fatalf("connected=%v user=%q", acc.Connected, acc.User)
	}
	// the token-paste path has NO expiry — the fields exist but read zero
	if acc.ExpiresAt != 0 || acc.Expired {
		t.Fatalf("pasted token must have no expiry: %+v", acc)
	}
}

func TestHfAccountExpiredOAuth(t *testing.T) {
	// A mock HF whose whoami REFUSES everyone — simulating the dead oauth token.
	mock := newAgeMockHF(t, http.StatusOK, `{}`)
	s := newV074TestServer(t, mock.URL)
	// Seed the vault with an OAuth-shaped extra whose timestamp is past.
	past := time.Now().Add(-time.Hour).Unix()
	extra, _ := json.Marshal(map[string]any{"user": "expireduser", "kind": "oauth", "expires_at": past})
	if err := s.vault.Set("DOOMALAY_HF_TOKEN", "huggingface", "hf_oauth_expired_token", string(extra)); err != nil {
		t.Fatalf("vault: %v", err)
	}
	rec := hubReq(t, s, "GET", "/api/hf/account", nil)
	var acc struct {
		Auth    string `json:"auth"`
		Expired bool   `json:"expired"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &acc); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if acc.Auth != "oauth" {
		t.Fatalf("auth = %q, want oauth", acc.Auth)
	}
	if !acc.Expired {
		t.Fatal("an expired OAuth token must report expired=true (the reconnect trigger)")
	}
}

func TestHfAccountLiveOAuthNotExpired(t *testing.T) {
	// whoami answers + a future timestamp → not expired, hours reported.
	mock := newAgeMockHF(t, http.StatusOK, `{}`)
	s := newV074TestServer(t, mock.URL)
	future := time.Now().Add(4 * time.Hour).Unix()
	extra, _ := json.Marshal(map[string]any{"user": "mockuser", "kind": "oauth", "expires_at": future})
	if err := s.vault.Set("DOOMALAY_HF_TOKEN", "huggingface", "goodtoken", string(extra)); err != nil {
		t.Fatalf("vault: %v", err)
	}
	rec := hubReq(t, s, "GET", "/api/hf/account", nil)
	var acc struct {
		Auth        string  `json:"auth"`
		Expired     bool    `json:"expired"`
		ExpireInHrs float64 `json:"expires_in_hours"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &acc); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if acc.Expired {
		t.Fatal("a live OAuth token must not report expired")
	}
	if acc.ExpireInHrs < 3.9 || acc.ExpireInHrs > 4.1 {
		t.Fatalf("expires_in_hours = %.2f, want ~4", acc.ExpireInHrs)
	}
}

func TestHfExchangeCodeCapturesExpiry(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /oauth/token", func(w http.ResponseWriter, r *http.Request) {
		_ = r.ParseForm()
		if r.PostForm.Get("grant_type") != "authorization_code" {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"access_token":"hf_oauth_test","expires_in":28800,"token_type":"bearer"}`))
	})
	ts := httptest.NewServer(mux)
	defer ts.Close()

	old := hfTokenEndpoint
	hfTokenEndpoint = ts.URL + "/oauth/token"
	defer func() { hfTokenEndpoint = old }()

	tok, expiresIn, err := hfExchangeCode("c", "v", "http://localhost/cb")
	if err != nil {
		t.Fatalf("exchange: %v", err)
	}
	if tok != "hf_oauth_test" {
		t.Fatalf("token = %q", tok)
	}
	if expiresIn != 28800 {
		t.Fatalf("expiresIn = %d, want 28800 (8h) — the D2 discard regression", expiresIn)
	}
}
