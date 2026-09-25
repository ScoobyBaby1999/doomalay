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
        "time"

        "github.com/ScoobyBaby1999/doomalay/engine/internal/config"
        "github.com/ScoobyBaby1999/doomalay/engine/internal/hub"
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

// TestGHOAuthStartNeedsSetup — without a secret the one-tap redirect
// must fail with a message that NAMES the device-code flow (the
// v0.55 production path for secretless installs).
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
        if !strings.Contains(body.Error, "device-code flow") || !strings.Contains(body.Error, "github.com/login/device") {
                t.Fatalf("start error does not point at the device flow: %q", body.Error)
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

        // 3. callback → exchange against the FAKE github → vault + THE DONE
        // PAGE (v0.60: no more 302 into the app — the terminal page
        // postMessages the popup home and deep-links the APK back).
        cb := httptest.NewRequest("GET", "/api/github/oauth/callback?code=abc&state="+url.QueryEscape(state), nil)
        recCB := httptest.NewRecorder()
        s.mux.ServeHTTP(recCB, cb)
        if recCB.Code != 200 {
                t.Fatalf("callback HTTP %d: %s", recCB.Code, recCB.Body.String())
        }
        page := recCB.Body.String()
        for _, want := range []string{
                "connected",           // the headline
                "GitHub",               // the provider
                "octocat",              // who signed in
                "doomalay-auth",        // the postMessage payload type
                "doomalay://return",    // the APK deep link
                "gh_connected=1",       // the plain-link landing query
                "window.close()",       // the popup self-close
                "postMessage",          // the popup → opener sync
        } {
                if !strings.Contains(page, want) {
                        t.Fatalf("done page missing %q:\n%s", want, page)
                }
        }
        // and NO auto-redirect into the app — that was the v0.59 bug
        // (the full app loading in the system browser / SPA root reload).
        if strings.Contains(page, "http-equiv=\"refresh\"") || strings.Contains(page, "location.replace") {
                t.Fatalf("done page must not auto-navigate into the app:\n%s", page)
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

// TestOAuthDonePage — the v0.60 HOME-COMING contract, direct: the error
// flavor renders the failure + retry hint and NEVER auto-navigates, and
// both flavors carry the deep link + the postMessage payload (the popup
// path's whole job) + the landing-query link (the same-tab path's).
func TestOAuthDonePage(t *testing.T) {
        rec := httptest.NewRecorder()
        oauthDonePage(rec, "Hugging Face", "probe tester", "", "hf_connected=1&hf_user=probe+tester")
        page := rec.Body.String()
        for _, want := range []string{
                "connected", "Hugging Face", "probe tester",
                "doomalay://return", "doomalay-auth",
                "hf_connected=1", "window.close()", "postMessage",
        } {
                if !strings.Contains(page, want) {
                        t.Fatalf("success done page missing %q:\n%s", want, page)
                }
        }
        // HTML-escaping: a login with markup must not inject
        rec2 := httptest.NewRecorder()
        oauthDonePage(rec2, "GitHub", "<script>x</script>", "", "")
        if strings.Contains(rec2.Body.String(), "<script>x</script>") {
                t.Fatal("login is not HTML-escaped on the done page")
        }
        // the error flavor: message + retry hint + landing query, no close-only
        rec3 := httptest.NewRecorder()
        oauthDonePage(rec3, "GitHub", "", "bad_verification_code", "gh_error=bad_verification_code")
        err := rec3.Body.String()
        for _, want := range []string{"sign-in failed", "bad_verification_code", "press the connect button", "gh_error=bad_verification_code"} {
                if !strings.Contains(err, want) {
                        t.Fatalf("error done page missing %q:\n%s", want, err)
                }
        }
        // the payload json must carry the error for the panel to surface
        if !strings.Contains(err, "\"error\":\"bad_verification_code\"") {
                t.Fatalf("error done page payload lacks the error field:\n%s", err)
        }
}

// TestGHOAuthCallbackDeniedServesDonePage — GitHub's ?error= (user pressed
// Deny) must land on the friendly terminal page, not a JSON blob. The
// error branch fires before state validation, so no setup is needed.
func TestGHOAuthCallbackDeniedServesDonePage(t *testing.T) {
        s := seedOAuthServer(t)
        cb := httptest.NewRequest("GET", "/api/github/oauth/callback?error=access_denied&error_description=The+user+has+denied+your+application+access.&state=whatever", nil)
        recCB := httptest.NewRecorder()
        s.mux.ServeHTTP(recCB, cb)
        body := recCB.Body.String()
        if recCB.Code != 200 || !strings.Contains(body, "denied your application") || !strings.Contains(body, "doomalay://return") {
                t.Fatalf("denied callback HTTP %d — want the done page naming the denial + the return link:\n%s", recCB.Code, body)
        }
}

// TestGHDeviceFlowRoundTrip — the v0.55 production path. A local fake
// GitHub serves both halves: POST /login/device/code and the device-grant
// polling on /login/oauth/access_token (authorization_pending once, then
// the token). Pins the contract that makes shipped builds work for
// everyone: the poll carries client_id + device_code + the device grant
// type and NO client_secret.
func TestGHDeviceFlowRoundTrip(t *testing.T) {
        var pollCalls int
        var sawSecret string
        // a fresh fake: the device endpoints + /user (no redirect exchange —
        // the redirect path is covered by TestGHOAuthFullRoundTrip)
        mux := http.NewServeMux()
        mux.HandleFunc("POST /login/device/code", func(w http.ResponseWriter, r *http.Request) {
                if err := r.ParseForm(); err != nil || r.Form.Get("client_id") == "" {
                        w.WriteHeader(400)
                        return
                }
                w.Header().Set("Content-Type", "application/json")
                w.Write([]byte(`{"device_code":"dev_code_40_chars_xxxxxxxxxxxxxxxx","user_code":"WDJB-MJHT","verification_uri":"/login/device","expires_in":900,"interval":1}`))
        })
        mux.HandleFunc("POST /login/oauth/access_token", func(w http.ResponseWriter, r *http.Request) {
                if err := r.ParseForm(); err != nil {
                        w.WriteHeader(400)
                        return
                }
                // the device grant must ride client_id + device_code ONLY —
                // a client_secret in the poll would leak the app pair.
                sawSecret = r.Form.Get("client_secret")
                if r.Form.Get("grant_type") != "urn:ietf:params:oauth:grant-type:device_code" ||
                        r.Form.Get("client_id") == "" || r.Form.Get("device_code") == "" {
                        w.Header().Set("Content-Type", "application/json")
                        w.Write([]byte(`{"error":"invalid_request","error_description":"bad device grant form"}`))
                        return
                }
                pollCalls++
                if pollCalls == 1 {
                        w.Header().Set("Content-Type", "application/json")
                        w.Write([]byte(`{"error":"authorization_pending","error_description":"user has not yet entered the code"}`))
                        return
                }
                w.Header().Set("Content-Type", "application/json")
                w.Write([]byte(`{"access_token":"gho_dev123","expires_in":0}`))
        })
        mux.HandleFunc("GET /user", func(w http.ResponseWriter, r *http.Request) {
                if r.Header.Get("Authorization") != "Bearer gho_dev123" {
                        w.WriteHeader(401)
                        return
                }
                w.Header().Set("Content-Type", "application/json")
                w.Write([]byte(`{"login":"devcat"}`))
        })
        fake := httptest.NewServer(mux)
        t.Cleanup(fake.Close)

        oldDev, oldAPI, oldTok := ghDeviceCodeEndpoint, forgeAPIBase, ghTokenEndpoint
        ghDeviceCodeEndpoint = fake.URL + "/login/device/code"
        forgeAPIBase, ghTokenEndpoint = fake.URL, fake.URL+"/login/oauth/access_token"
        t.Cleanup(func() {
                ghDeviceCodeEndpoint, forgeAPIBase, ghTokenEndpoint = oldDev, oldAPI, oldTok
        })
        // reset the shared store so a prior test's flow can't shadow this one
        ghDeviceStore.Lock()
        ghDeviceStore.cur = nil
        ghDeviceStore.Unlock()

        s := seedOAuthServer(t)

        // 1. start — the engine relays the user_code + verification_uri
        start := httptest.NewRequest("POST", "/api/workspaces/oauth/github/device/start", nil)
        recStart := httptest.NewRecorder()
        s.mux.ServeHTTP(recStart, start)
        if recStart.Code != 200 {
                t.Fatalf("device start HTTP %d: %s", recStart.Code, recStart.Body.String())
        }
        var d struct {
                UserCode        string `json:"user_code"`
                VerificationURI string `json:"verification_uri"`
                Interval        int    `json:"interval"`
        }
        if err := json.Unmarshal(recStart.Body.Bytes(), &d); err != nil {
                t.Fatalf("device start json: %v", err)
        }
        if d.UserCode != "WDJB-MJHT" || !strings.Contains(d.VerificationURI, "/login/device") {
                t.Fatalf("device start = %+v — bad code/uri", d)
        }

        // 2. poll the status endpoint until the background poller resolves
        //    (interval=1s: pending → connected within a few seconds)
        var st struct {
                Status string `json:"status"`
                Login  string `json:"login"`
        }
        deadline := time.Now().Add(15 * time.Second)
        for time.Now().Before(deadline) {
                req := httptest.NewRequest("GET", "/api/workspaces/oauth/github/device/status", nil)
                rec := httptest.NewRecorder()
                s.mux.ServeHTTP(rec, req)
                if rec.Code != 200 {
                        t.Fatalf("device status HTTP %d", rec.Code)
                }
                if err := json.Unmarshal(rec.Body.Bytes(), &st); err != nil {
                        t.Fatalf("device status json: %v", err)
                }
                if st.Status == "connected" || st.Status == "error" || st.Status == "expired" {
                        break
                }
                time.Sleep(300 * time.Millisecond)
        }
        if st.Status != "connected" {
                t.Fatalf("device status = %q (login %q), want connected", st.Status, st.Login)
        }
        if st.Login != "devcat" {
                t.Fatalf("device login = %q, want devcat", st.Login)
        }

        // 3. the secretless contract: the poll must not carry a secret
        if sawSecret != "" {
                t.Fatalf("device poll carried client_secret %q — the device grant must be secretless", sawSecret)
        }

        // 4. the token landed in the vault, same shape as the redirect flow
        tok, extra, err := s.vault.Get("GITHUB_PAT")
        if err != nil || tok != "gho_dev123" {
                t.Fatalf("vault GITHUB_PAT = %q (err %v), want gho_dev123", tok, err)
        }
        var ae struct {
                Login string `json:"login"`
        }
        if err := json.Unmarshal([]byte(extra), &ae); err != nil || ae.Login != "devcat" {
                t.Fatalf("vault extra = %s (err %v) — login missing", extra, err)
        }
}


// TestHFDeviceFlowRoundTrip — the v0.59 gateway-safe HF sign-in. A local
// fake HF serves all three halves: POST /oauth/device (start), the
// device-grant polling on /oauth/token (authorization_pending once, then
// the token), and /api/whoami-v2 (the account lookup). Pins the
// secretless poll form and the vault write (same TokenEnvVar shape as the
// redirect flow, so hfToken() picks it up identically).
func TestHFDeviceFlowRoundTrip(t *testing.T) {
        var pollCalls int
        var sawSecret string
        mux := http.NewServeMux()
        mux.HandleFunc("POST /oauth/device", func(w http.ResponseWriter, r *http.Request) {
                if err := r.ParseForm(); err != nil || r.Form.Get("client_id") == "" {
                        w.WriteHeader(400)
                        return
                }
                w.Header().Set("Content-Type", "application/json")
                // interval:1 → fast polls so the test resolves in seconds
                w.Write([]byte(`{"device_code":"hf_dev_code_1234","user_code":"HF42-CODE","verification_uri":"https://hf.co/oauth/device","expires_in":300,"interval":1}`))
        })
        mux.HandleFunc("POST /oauth/token", func(w http.ResponseWriter, r *http.Request) {
                if err := r.ParseForm(); err != nil {
                        w.WriteHeader(400)
                        return
                }
                // the device grant must carry client_id + device_code ONLY — a
                // secret (or a code_verifier) has no business in this poll.
                sawSecret = r.Form.Get("client_secret")
                if r.Form.Get("grant_type") != "urn:ietf:params:oauth:grant-type:device_code" ||
                        r.Form.Get("client_id") == "" || r.Form.Get("device_code") == "" {
                        w.Header().Set("Content-Type", "application/json")
                        w.Write([]byte(`{"error":"invalid_request","error_description":"bad device grant form"}`))
                        return
                }
                pollCalls++
                if pollCalls == 1 {
                        w.Header().Set("Content-Type", "application/json")
                        w.Write([]byte(`{"error":"authorization_pending","error_description":"Device code pending, not yet approved"}`))
                        return
                }
                w.Header().Set("Content-Type", "application/json")
                w.Write([]byte(`{"access_token":"hf_oauth_dev1"}`))
        })
        mux.HandleFunc("GET /api/whoami-v2", func(w http.ResponseWriter, r *http.Request) {
                if r.Header.Get("Authorization") != "Bearer hf_oauth_dev1" {
                        w.WriteHeader(401)
                        return
                }
                w.Header().Set("Content-Type", "application/json")
                w.Write([]byte(`{"type":"user","name":"devhug"}`))
        })
        fake := httptest.NewServer(mux)
        t.Cleanup(fake.Close)

        oldDev, oldTok := hfDeviceCodeEndpoint, hfTokenEndpoint
        hfDeviceCodeEndpoint = fake.URL + "/oauth/device"
        hfTokenEndpoint = fake.URL + "/oauth/token"
        t.Cleanup(func() { hfDeviceCodeEndpoint, hfTokenEndpoint = oldDev, oldTok })
        // the poller's WhoAmI rides the hub client → point it at the fake too
        hfDeviceStore.Lock()
        hfDeviceStore.cur = nil
        hfDeviceStore.Unlock()

        s := seedOAuthServer(t)
        s.cfg.Hub.HFBase = fake.URL

        // 1. start — the engine relays the user_code + verification_uri
        start := httptest.NewRequest("POST", "/api/hf/oauth/device/start", nil)
        recStart := httptest.NewRecorder()
        s.mux.ServeHTTP(recStart, start)
        if recStart.Code != 200 {
                t.Fatalf("device start HTTP %d: %s", recStart.Code, recStart.Body.String())
        }
        var d struct {
                UserCode        string `json:"user_code"`
                VerificationURI string `json:"verification_uri"`
                Interval        int    `json:"interval"`
        }
        if err := json.Unmarshal(recStart.Body.Bytes(), &d); err != nil {
                t.Fatalf("device start json: %v", err)
        }
        if d.UserCode != "HF42-CODE" || !strings.Contains(d.VerificationURI, "hf.co") {
                t.Fatalf("device start = %+v — bad code/uri", d)
        }
        if d.Interval != 1 {
                t.Fatalf("device interval = %d, want 1 (mock-driven)", d.Interval)
        }

        // 2. poll the status endpoint until the background poller resolves
        var st struct {
                Status string `json:"status"`
                User   string `json:"user"`
                Error  string `json:"error"`
        }
        deadline := time.Now().Add(15 * time.Second)
        for time.Now().Before(deadline) {
                req := httptest.NewRequest("GET", "/api/hf/oauth/device/status", nil)
                rec := httptest.NewRecorder()
                s.mux.ServeHTTP(rec, req)
                if rec.Code != 200 {
                        t.Fatalf("device status HTTP %d", rec.Code)
                }
                if err := json.Unmarshal(rec.Body.Bytes(), &st); err != nil {
                        t.Fatalf("device status json: %v", err)
                }
                if st.Status == "connected" || st.Status == "error" || st.Status == "expired" {
                        break
                }
                time.Sleep(300 * time.Millisecond)
        }
        if st.Status != "connected" {
                t.Fatalf("device status = %q (user %q, err %q), want connected", st.Status, st.User, st.Error)
        }
        if st.User != "devhug" {
                t.Fatalf("device user = %q, want devhug", st.User)
        }

        // 3. the secretless contract: the poll must not carry a secret
        if sawSecret != "" {
                t.Fatalf("device poll carried client_secret %q — the grant must be secretless", sawSecret)
        }

        // 4. the token landed in the vault, same shape as the redirect flow
        tok, extra, err := s.vault.Get(hub.TokenEnvVar)
        if err != nil || tok != "hf_oauth_dev1" {
                t.Fatalf("vault %s = %q (err %v), want hf_oauth_dev1", hub.TokenEnvVar, tok, err)
        }
        if extra != "devhug" {
                t.Fatalf("vault extra = %q, want devhug", extra)
        }
}
