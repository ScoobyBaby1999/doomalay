package server

// oauth_test.go — v0.52: the OAuth egress + round-trip tests.
//
// WHY THESE EXIST (the live v0.51 bug): every OAuth/token-exchange call
// used a bare http.Client, so on devices whose /etc/resolv.conf names a
// dead local resolver the exchange died with
//   `lookup huggingface.co on [::1]:53: connection refused`
// while everything routed through netx kept working. These tests pin:
//   1. the exchange functions actually complete against a local endpoint
//      (they ride oauthHTTP / netx — a bare client is invisible here, so
//      the value is the round-trip itself: form shape, JSON contract,
//      error paths, vault writes);
//   2. the one-time setup path: config accepts secret-only (client id
//      falls back to the built-in), start refuses without a secret, and
//      the full start→callback→vault round-trip lands the PAT.

import (
        "encoding/json"
        "net/http"
        "net/http/httptest"
        "net/url"
        "strings"
        "testing"

        "github.com/ScoobyBaby1999/doomalay/engine/internal/config"
        "github.com/ScoobyBaby1999/doomalay/engine/internal/store"
)

// fakeGitHub spins a local stand-in for api.github.com +
// github.com/login/oauth/access_token.
func fakeGitHub(t *testing.T, wantLogin string) *httptest.Server {
        t.Helper()
        mux := http.NewServeMux()
        mux.HandleFunc("POST /login/oauth/access_token", func(w http.ResponseWriter, r *http.Request) {
                if err := r.ParseForm(); err != nil {
                        w.WriteHeader(400)
                        return
                }
                if r.Form.Get("client_id") == "" || r.Form.Get("client_secret") == "" || r.Form.Get("code") == "" {
                        w.Header().Set("Content-Type", "application/json")
                        w.WriteHeader(200)
                        w.Write([]byte(`{"error":"incorrect_client_credentials","error_description":"missing id/secret/code"}`))
                        return
                }
                w.Header().Set("Content-Type", "application/json")
                w.Write([]byte(`{"access_token":"gho_test123","refresh_token":"ghr_test456","expires_in":28800}`))
        })
        mux.HandleFunc("GET /user", func(w http.ResponseWriter, r *http.Request) {
                if r.Header.Get("Authorization") != "Bearer gho_test123" {
                        w.WriteHeader(401)
                        return
                }
                w.Header().Set("Content-Type", "application/json")
                w.Write([]byte(`{"login":"` + wantLogin + `"}`))
        })
        srv := httptest.NewServer(mux)
        t.Cleanup(srv.Close)
        return srv
}

// withFakeGitHub points the OAuth plumbing at the fake for the test's
// lifetime and restores the real endpoints after.
func withFakeGitHub(t *testing.T, base string) {
        t.Helper()
        oldAPI, oldTok := forgeAPIBase, ghTokenEndpoint
        forgeAPIBase, ghTokenEndpoint = base, base+"/login/oauth/access_token"
        t.Cleanup(func() { forgeAPIBase, ghTokenEndpoint = oldAPI, oldTok })
}

func seedOAuthServer(t *testing.T) *Server {
        t.Helper()
        dir := t.TempDir()
        db, err := store.Open(dir)
        if err != nil {
                t.Fatalf("store: %v", err)
        }
        if err := db.Migrate(); err != nil {
                t.Fatalf("migrate: %v", err)
        }
        return New(&config.Config{DataDir: dir}, db, nil)
}

// TestGHOAuthConfigSecretOnly — the v0.52 one-time setup contract: the
// client id is OPTIONAL (built-in default fills in), the secret REQUIRED.
func TestGHOAuthConfigSecretOnly(t *testing.T) {
        s := seedOAuthServer(t)

        // no secret → 400
        req := httptest.NewRequest("POST", "/api/workspaces/oauth/github/config",
                strings.NewReader(`{}`))
        rec := httptest.NewRecorder()
        s.mux.ServeHTTP(rec, req)
        if rec.Code != 400 {
                t.Fatalf("config without secret = HTTP %d, want 400", rec.Code)
        }

        // secret only → 200, and status now reports configured + the built-in id
        req2 := httptest.NewRequest("POST", "/api/workspaces/oauth/github/config",
                strings.NewReader(`{"client_secret":"sekrit"}`))
        rec2 := httptest.NewRecorder()
        s.mux.ServeHTTP(rec2, req2)
        if rec2.Code != 200 {
                t.Fatalf("config secret-only = HTTP %d: %s", rec2.Code, rec2.Body.String())
        }

        req3 := httptest.NewRequest("GET", "/api/workspaces/oauth/github/status", nil)
        rec3 := httptest.NewRecorder()
        s.mux.ServeHTTP(rec3, req3)
        if rec3.Code != 200 {
                t.Fatalf("status HTTP %d", rec3.Code)
        }
        var st struct {
                Configured bool   `json:"configured"`
                HasSecret  bool   `json:"has_secret"`
                ClientID   string `json:"client_id"`
                SignedIn   bool   `json:"signed_in"`
        }
        if err := json.Unmarshal(rec3.Body.Bytes(), &st); err != nil {
                t.Fatalf("status json: %v", err)
        }
        if !st.Configured || !st.HasSecret {
                t.Fatalf("status = configured:%v has_secret:%v — the one-time setup did not stick", st.Configured, st.HasSecret)
        }
        if st.ClientID != ghOAuthDefaultClientID {
                t.Fatalf("client_id = %q, want the built-in %q", st.ClientID, ghOAuthDefaultClientID)
        }
}

// TestGHOAuthStartNeedsSetup — the pre-setup state must fail with a
// message that NAMES the one-time box (the old "isn't configured yet"
// read like a bug).
func TestGHOAuthStartNeedsSetup(t *testing.T) {
        s := seedOAuthServer(t)
        req := httptest.NewRequest("GET", "/api/workspaces/oauth/github/start?redirect=/", nil)
        rec := httptest.NewRecorder()
        s.mux.ServeHTTP(rec, req)
        if rec.Code != 400 {
                t.Fatalf("start without setup = HTTP %d, want 400", rec.Code)
        }
        var body struct {
                Error string `json:"error"`
        }
        _ = json.Unmarshal(rec.Body.Bytes(), &body)
        if !strings.Contains(body.Error, "one-time") || !strings.Contains(body.Error, "client secret") {
                t.Fatalf("start error does not point at the one-time setup box: %q", body.Error)
        }
}

// TestGHOAuthFullRoundTrip — config (secret-only) → start (302 + state)
// → callback (exchange + /user + vault) → ?gh_connected=1 redirect.
func TestGHOAuthFullRoundTrip(t *testing.T) {
        fake := fakeGitHub(t, "octocat")
        withFakeGitHub(t, fake.URL)
        s := seedOAuthServer(t)

        // 1. one-time setup (secret only)
        cfg := httptest.NewRequest("POST", "/api/workspaces/oauth/github/config",
                strings.NewReader(`{"client_secret":"sekrit"}`))
        recCfg := httptest.NewRecorder()
        s.mux.ServeHTTP(recCfg, cfg)
        if recCfg.Code != 200 {
                t.Fatalf("config HTTP %d: %s", recCfg.Code, recCfg.Body.String())
        }

        // 2. start → 302 github authorize with state
        start := httptest.NewRequest("GET", "/api/workspaces/oauth/github/start?redirect=/", nil)
        recStart := httptest.NewRecorder()
        s.mux.ServeHTTP(recStart, start)
        if recStart.Code != 302 {
                t.Fatalf("start HTTP %d, want 302", recStart.Code)
        }
        loc, err := url.Parse(recStart.Header().Get("Location"))
        if err != nil || !strings.Contains(loc.String(), "github.com/login/oauth/authorize") {
                t.Fatalf("start location = %q (err %v) — not the authorize page", recStart.Header().Get("Location"), err)
        }
        state := loc.Query().Get("state")
        if state == "" {
                t.Fatal("authorize redirect carries no state")
        }

        // 3. callback → exchange against the FAKE github → vault + redirect home
        cb := httptest.NewRequest("GET", "/api/github/oauth/callback?code=abc&state="+url.QueryEscape(state), nil)
        recCB := httptest.NewRecorder()
        s.mux.ServeHTTP(recCB, cb)
        if recCB.Code != 302 {
                t.Fatalf("callback HTTP %d: %s", recCB.Code, recCB.Body.String())
        }
        back := recCB.Header().Get("Location")
        if !strings.Contains(back, "gh_connected=1") || !strings.Contains(back, "gh_login=octocat") {
                t.Fatalf("callback redirect = %q — missing connected/login flags", back)
        }

        // 4. the PAT + its refresh metadata landed in the vault
        if s.vault == nil {
                t.Fatal("vault missing")
        }
        tok, extra, err := s.vault.Get("GITHUB_PAT")
        if err != nil || tok != "gho_test123" {
                t.Fatalf("vault GITHUB_PAT = %q (err %v), want gho_test123", tok, err)
        }
        var ae struct {
                Login        string `json:"login"`
                RefreshToken string `json:"refresh_token"`
                ExpiresAt    int64  `json:"expires_at"`
        }
        if err := json.Unmarshal([]byte(extra), &ae); err != nil {
                t.Fatalf("vault extra json: %v", err)
        }
        if ae.Login != "octocat" || ae.RefreshToken != "ghr_test456" || ae.ExpiresAt == 0 {
                t.Fatalf("vault extra = %+v — login/refresh/expiry incomplete", ae)
        }

        // 5. replayed state must be rejected (one-shot)
        cb2 := httptest.NewRequest("GET", "/api/github/oauth/callback?code=abc&state="+url.QueryEscape(state), nil)
        recCB2 := httptest.NewRecorder()
        s.mux.ServeHTTP(recCB2, cb2)
        if recCB2.Code != 400 {
                t.Fatalf("replayed state HTTP %d, want 400", recCB2.Code)
        }
}

// TestHFExchangeCodeRoundTrip — the HF code→token POST against a local
// endpoint: PKCE form shape + the access_token contract. This is the
// exact call that died on-device with the bare client (netx now carries
// it — see hfExchangeCode).
func TestHFExchangeCodeRoundTrip(t *testing.T) {
        mux := http.NewServeMux()
        mux.HandleFunc("POST /oauth/token", func(w http.ResponseWriter, r *http.Request) {
                if err := r.ParseForm(); err != nil {
                        w.WriteHeader(400)
                        return
                }
                if r.Form.Get("grant_type") != "authorization_code" ||
                        r.Form.Get("code_verifier") == "" || r.Form.Get("code") == "" ||
                        r.Form.Get("redirect_uri") == "" || r.Form.Get("client_id") == "" {
                        w.WriteHeader(400)
                        w.Write([]byte(`{"error":"invalid_request"}`))
                        return
                }
                w.Header().Set("Content-Type", "application/json")
                w.Write([]byte(`{"access_token":"hf_oauth_test","token_type":"bearer"}`))
        })
        srv := httptest.NewServer(mux)
        t.Cleanup(srv.Close)

        old := hfTokenEndpoint
        hfTokenEndpoint = srv.URL + "/oauth/token"
        t.Cleanup(func() { hfTokenEndpoint = old })

        tok, err := hfExchangeCode("c0de", "verifier-verifier", "http://127.0.0.1:8080/api/hf/oauth/callback")
        if err != nil {
                t.Fatalf("hfExchangeCode: %v", err)
        }
        if tok != "hf_oauth_test" {
                t.Fatalf("token = %q, want hf_oauth_test", tok)
        }

        // an error body must surface, not silently pass
        hfTokenEndpoint = srv.URL + "/definitely-not-a-path"
        if _, err := hfExchangeCode("c0de", "v", "r"); err == nil {
                t.Fatal("exchange against a dead path must fail")
        }
}
