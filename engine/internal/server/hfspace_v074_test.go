package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/ScoobyBaby1999/doomalay/engine/internal/config"
	"github.com/ScoobyBaby1999/doomalay/engine/internal/secrets"
	"github.com/ScoobyBaby1999/doomalay/engine/internal/store"
)

// ── v0.74: the account-age pattern table ──────────────────────────────────

func TestIsAccountAgeErrorPatterns(t *testing.T) {
	// Every phrasing HF (or its proxies) has been observed using for the
	// 30-day account-age refusal on /api/repos/create.
	yes := []string{
		"Account must be at least 30 days old to create a Space",
		"Your account is less than 30 days old",
		"accounts younger than 30 days cannot create ZeroGPU Spaces",
		"You have reached the creation limit: account is too young (30-day rule)",
		"The account age requirement is 30 days",
		"Spaces creation requires a 30-day old account",
		"younger than 30 days",
		"newer than 30 days",
		"older than 30 days is required",
		"THIRTY DAYS minimum account age",
		"Your account must be at least 30 days old",
	}
	for _, s := range yes {
		if !isAccountAgeError(s) {
			t.Errorf("isAccountAgeError(%q) = false, want true", s)
		}
	}
	// Things that must NOT be mistaken for the age rule.
	no := []string{
		"Free HF accounts can host 2 ZeroGPU Spaces — you've used both",
		"ZeroGPU Spaces are limited to 2 per free account",
		"this operation requires a PRO subscription",
		"space quota exceeded for flavor cpu-basic",
		"already exists",
		"rate limit reached, retry in 30 seconds",
		"",
	}
	for _, s := range no {
		if isAccountAgeError(s) {
			t.Errorf("isAccountAgeError(%q) = true, want false", s)
		}
	}
}

// newAgeMockHF builds a mock HF whose space-create endpoint refuses with
// the 30-day account-age rule (self-contained — the shared mockHubHF stays
// untouched for the other waves).
func newAgeMockHF(t *testing.T, createStatus int, createBody string) *httptest.Server {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/whoami-v2", func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer goodtoken" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"type":"user","name":"mockuser"}`))
	})
	mux.HandleFunc("POST /api/repos/create", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(createStatus)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(createBody))
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv
}

func newV074TestServer(t *testing.T, hfBase string) *Server {
	t.Helper()
	dir := t.TempDir()
	db, err := store.Open(dir)
	if err != nil {
		t.Fatalf("store: %v", err)
	}
	if err := db.Migrate(); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	cfg := &config.Config{DataDir: dir}
	cfg.Hub.HFBase = hfBase
	return New(cfg, db, nil)
}

// ── v0.74: the age gate maps to a coded 403 ───────────────────────────────

func TestHFSpaceCreateAgeGate(t *testing.T) {
	mock := newAgeMockHF(t, http.StatusForbidden,
		`{"error":"You must have a Hugging Face account for at least 30 days to create a ZeroGPU Space. PRO accounts bypass this."}`)
	s := newV074TestServer(t, mock.URL)

	if rec := hubReq(t, s, "POST", "/api/hub/auth/connect", map[string]string{"token": "goodtoken"}); rec.Code != 200 {
		t.Fatalf("connect = %d body %s", rec.Code, rec.Body.String())
	}

	rec := hubReq(t, s, "POST", "/api/hf/space/create", map[string]any{"name": "agetest"})
	if rec.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403 (the age gate) — body %s", rec.Code, rec.Body.String())
	}
	var body struct {
		Error string `json:"error"`
		Code  string `json:"code"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode body: %v", err)
	}
	if body.Code != "account_age" {
		t.Errorf("code = %q, want account_age", body.Code)
	}
	if !strings.Contains(body.Error, "30+ days") {
		t.Errorf("error text should mention 30+ days, got %q", body.Error)
	}
}

// Non-age failures pass through untouched (the old behavior — the raw
// message with its status, no code field).
func TestHFSpaceCreateNonAgePassthrough(t *testing.T) {
	mock := newAgeMockHF(t, http.StatusPaymentRequired,
		`{"error":"ZeroGPU Spaces are limited to 2 per free account"}`)
	s := newV074TestServer(t, mock.URL)

	if rec := hubReq(t, s, "POST", "/api/hub/auth/connect", map[string]string{"token": "goodtoken"}); rec.Code != 200 {
		t.Fatalf("connect = %d body %s", rec.Code, rec.Body.String())
	}

	rec := hubReq(t, s, "POST", "/api/hf/space/create", map[string]any{"name": "quotatest"})
	if rec.Code != http.StatusPaymentRequired {
		t.Fatalf("status = %d, want 402 (the quota path, untouched)", rec.Code)
	}
	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode body: %v", err)
	}
	if _, has := body["code"]; has {
		t.Errorf("quota errors must stay uncoded (raw passthrough), got code %v", body["code"])
	}
}

// ── v0.74: the third-party env filter ────────────────────────────────────

func TestThirdPartyRemoteEnvFilter(t *testing.T) {
	s := newV074TestServer(t, "")
	// A vault with one of everything: provider keys, an EXTRA field, the
	// HF token, and things that must NEVER cross to a third-party space.
	set := map[string]struct {
		key   string
		extra string
	}{
		"NVIDIA_API_KEY":            {key: "nvapi-ok"},
		"PRIVATEMODEAI_API_KEY":     {key: "pm-ok"},
		"OPENAI_API_KEY":            {key: "sk-ok"},
		"CLOUDFLARE_API_KEY":        {key: "cf-ok", extra: "cf-account"},
		"DOOMALAY_HF_TOKEN":         {key: "hf-tok-ok"},
		"GITHUB_PAT":                {key: "ghp_MUST_NOT_CROSS"},
		"GITEA_TOKEN":               {key: "gitea_MUST_NOT_CROSS"},
		"HF_SPACE_SCOOBYBABY1999_X": {key: "spacetok_MUST_NOT_CROSS"},
	}
	for envVar, e := range set {
		if err := s.vault.Set(envVar, "test", e.key, e.extra); err != nil {
			t.Fatalf("vault set %s: %v", envVar, err)
		}
	}

	got := s.thirdPartyRemoteEnv()

	for _, k := range []string{"NVIDIA_API_KEY", "PRIVATEMODEAI_API_KEY", "OPENAI_API_KEY", "CLOUDFLARE_API_KEY", "DOOMALAY_HF_TOKEN"} {
		if got[k] == "" {
			t.Errorf("third-party env lost %s (BYOK set must cross)", k)
		}
	}
	if got["CLOUDFLARE_API_KEY_EXTRA"] != "cf-account" {
		t.Errorf("CLOUDFLARE_API_KEY_EXTRA (allowlisted extra) missing: %q", got["CLOUDFLARE_API_KEY_EXTRA"])
	}
	for _, k := range []string{"GITHUB_PAT", "GITEA_TOKEN", "HF_SPACE_SCOOBYBABY1999_X"} {
		if v, ok := got[k]; ok {
			t.Errorf("third-party env LEAKED %s=%q — vault secrets beyond the BYOK set + HF tokens must never cross", k, v)
		}
	}
	// Sanity: every returned key is allowlisted (or its EXTRA), or an HF token.
	for k := range got {
		base := strings.TrimSuffix(k, "_EXTRA")
		if _, allow := secrets.PROVIDER_KEY_ALLOWLIST[base]; allow {
			continue
		}
		if k == "DOOMALAY_HF_TOKEN" || k == "HF_TOKEN" || k == "HUGGINGFACE_TOKEN" {
			continue
		}
		t.Errorf("third-party env contains non-allowlisted key %q", k)
	}
}
