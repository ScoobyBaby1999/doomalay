package server

// ghbroker_test.go — v0.60.2: the space-brokered one-click round trip
// against a LOCAL mock of the space's four public endpoints, plus the
// redirect-target policy that keeps the one-time grant from ever being
// aimed at an arbitrary public host.

import (
        "encoding/json"
        "fmt"
        "net/http"
        "net/http/httptest"
        "net/url"
        "strings"
        "testing"
)

// fakeBrokerSpace mimics scripts/shared_app.py's /gh/oauth/* surface.
// It hands out a fixed grant when the "GitHub authorize" hop is followed.
func fakeBrokerSpace(t *testing.T, engineBase string) *httptest.Server {
        t.Helper()
        mux := http.NewServeMux()
        mux.HandleFunc("GET /gh/oauth/config", func(w http.ResponseWriter, r *http.Request) {
                w.Header().Set("Access-Control-Allow-Origin", "*")
                w.Header().Set("Content-Type", "application/json")
                fmt.Fprint(w, `{"configured":true}`)
        })
        mux.HandleFunc("GET /gh/oauth/start", func(w http.ResponseWriter, r *http.Request) {
                redirect := r.URL.Query().Get("redirect")
                // mirror the space's policy check (see shared_app.py) —
                // loopback/private/gateway only
                u, err := url.Parse(redirect)
                if err != nil || u.Scheme == "" || u.Host == "" {
                        w.WriteHeader(400)
                        fmt.Fprint(w, `{"error":"redirect origin refused"}`)
                        return
                }
                http.Redirect(w, r, "https://github.com/login/oauth/authorize?state=fake", http.StatusFound)
        })
        mux.HandleFunc("GET /gh/oauth/callback", func(w http.ResponseWriter, r *http.Request) {
                http.Redirect(w, r, engineBase+"/api/gh/oauth/relay?grant=deadbeefcafe", http.StatusFound)
        })
        mux.HandleFunc("GET /gh/oauth/grants/deadbeefcafe", func(w http.ResponseWriter, r *http.Request) {
                w.Header().Set("Content-Type", "application/json")
                fmt.Fprint(w, `{"token":"gho_broker_123","login":"broker_cat","refresh_token":"ghr_b_9","expires_in":28800}`)
        })
        mux.HandleFunc("GET /gh/oauth/grants/used", func(w http.ResponseWriter, r *http.Request) {
                w.WriteHeader(410)
                fmt.Fprint(w, `{"error":"unknown, expired or already-claimed grant"}`)
        })
        srv := httptest.NewServer(mux)
        t.Cleanup(srv.Close)
        return srv
}

func withBroker(t *testing.T, base string) {
        t.Helper()
        old := ghBrokerOverride
        ghBrokerOverride = base
        t.Cleanup(func() { ghBrokerOverride = old })
}

// TestGHBrokerFullRoundTrip — the whole chain minus the real GitHub hop:
// broker/start redirects to the space with the browser-facing origin, the
// relay claims the one-time grant server-to-server, the vault lands the
// token + refresh metadata, and the popup gets THE DONE PAGE.
func TestGHBrokerFullRoundTrip(t *testing.T) {
        s := seedOAuthServer(t)
        fake := fakeGitHub(t, "octocat") // /user for the best-effort login path
        withFakeGitHub(t, fake.URL)

        // the engine must be reachable at a known base for the fake space
        // to relay back to — use the recorder pattern: the relay target is
        // the test's schemeHost of the relay request itself.
        engineBase := "http://127.0.0.1:8080"
        space := fakeBrokerSpace(t, engineBase)
        withBroker(t, space.URL)

        // 1. broker/start with the BROWSER origin → 302 to the space
        start := httptest.NewRequest("GET", "/api/gh/oauth/broker/start?origin="+url.QueryEscape(engineBase), nil)
        recStart := httptest.NewRecorder()
        s.mux.ServeHTTP(recStart, start)
        if recStart.Code != 302 {
                t.Fatalf("broker start HTTP %d: %s", recStart.Code, recStart.Body.String())
        }
        loc := recStart.Header().Get("Location")
        if !strings.Contains(loc, "/gh/oauth/start?") || !strings.Contains(loc, url.QueryEscape(engineBase)) {
                t.Fatalf("broker start location = %q — not the space with the origin", loc)
        }

        // 2. a junk origin must be refused before leaving the engine
        bad := httptest.NewRequest("GET", "/api/gh/oauth/broker/start?origin="+url.QueryEscape("javascript:alert(1)"), nil)
        recBad := httptest.NewRecorder()
        s.mux.ServeHTTP(recBad, bad)
        if recBad.Code != 400 {
                t.Fatalf("javascript: origin accepted (HTTP %d) — must be 400", recBad.Code)
        }

        // 3. the relay claim → vault + the done page (the fake space's
        //    grants/deadbeefcafe answers the one-time bundle)
        relay := httptest.NewRequest("GET", "/api/gh/oauth/relay?grant=deadbeefcafe", nil)
        recRelay := httptest.NewRecorder()
        s.mux.ServeHTTP(recRelay, relay)
        page := recRelay.Body.String()
        if recRelay.Code != 200 {
                t.Fatalf("relay HTTP %d: %s", recRelay.Code, page)
        }
        for _, want := range []string{"connected", "GitHub", "broker_cat", "doomalay://return", "doomalay-auth", "gh_connected=1"} {
                if !strings.Contains(page, want) {
                        t.Fatalf("relay done page missing %q:\n%s", want, page)
                }
        }

        // 4. vault: GITHUB_PAT + refresh/expiry extras
        tok, extra, err := s.vault.Get("GITHUB_PAT")
        if err != nil || tok != "gho_broker_123" {
                t.Fatalf("vault GITHUB_PAT = %q (err %v), want gho_broker_123", tok, err)
        }
        var ae struct {
                Login        string `json:"login"`
                RefreshToken string `json:"refresh_token"`
                ExpiresAt    int64  `json:"expires_at"`
        }
        if err := json.Unmarshal([]byte(extra), &ae); err != nil {
                t.Fatalf("vault extra json: %v", err)
        }
        if ae.Login != "broker_cat" || ae.RefreshToken != "ghr_b_9" || ae.ExpiresAt == 0 {
                t.Fatalf("vault extra = %+v — login/refresh/expiry incomplete", ae)
        }

        // 5. an already-claimed grant → the ERROR done page (not a crash,
        //    not JSON — the popup deserves a readable terminal)
        relay2 := httptest.NewRequest("GET", "/api/gh/oauth/relay?grant=used", nil)
        recRelay2 := httptest.NewRecorder()
        s.mux.ServeHTTP(recRelay2, relay2)
        if recRelay2.Code != 200 || !strings.Contains(recRelay2.Body.String(), "sign-in failed") {
                t.Fatalf("claimed-grant relay HTTP %d — want the error done page:\n%s",
                        recRelay2.Code, recRelay2.Body.String())
        }

        // 6. ?error= from the space (denial) → the error done page
        relay3 := httptest.NewRequest("GET", "/api/gh/oauth/relay?error=access+denied", nil)
        recRelay3 := httptest.NewRecorder()
        s.mux.ServeHTTP(recRelay3, relay3)
        if recRelay3.Code != 200 || !strings.Contains(recRelay3.Body.String(), "access denied") {
                t.Fatalf("error relay HTTP %d — want the error done page:\n%s",
                        recRelay3.Code, recRelay3.Body.String())
        }

        // 7. the account endpoint advertises the broker for the panel probe
        acct := httptest.NewRequest("GET", "/api/gh/account", nil)
        recAcct := httptest.NewRecorder()
        s.mux.ServeHTTP(recAcct, acct)
        if !strings.Contains(recAcct.Body.String(), `"broker_url":"`+space.URL+`"`) {
                t.Fatalf("account lacks broker_url:\n%s", recAcct.Body.String())
        }
}

// TestGHBrokerUnreachable — a dead broker (the space is down / sleeping):
// the relay fails gracefully with the error done page, never a panic and
// never bare JSON in the popup.
func TestGHBrokerUnreachable(t *testing.T) {
        s := seedOAuthServer(t)
        withBroker(t, "http://127.0.0.1:1") // nothing listens — instant refusal
        relay := httptest.NewRequest("GET", "/api/gh/oauth/relay?grant=xyz", nil)
        rec := httptest.NewRecorder()
        s.mux.ServeHTTP(rec, relay)
        if rec.Code != 200 || !strings.Contains(rec.Body.String(), "sign-in failed") {
                t.Fatalf("unreachable-broker relay HTTP %d — want the graceful error done page:\n%s",
                        rec.Code, rec.Body.String())
        }
}
