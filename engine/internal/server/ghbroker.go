// ghbroker.go — v0.60.2: THE GITHUB SPACE BROKER (the legacy one-click,
// ported). The user's verdict on the device flow: "we want complete access
// over one repo, not the entire account" + no code entry. The legacy
// doomalaysocreate space proved the pattern years ago: a server-side OAuth
// App whose secret lives in the SPACE's env — /login → GitHub → space
// callback → server-side exchange → one-time grant → redirect to the
// caller. One click, works from ANY origin, no code to type.
//
// THE UPGRADE over the legacy flow: the space brokers the live GitHub APP
// (the ONE app, Iv23liDzVTw7zphxo5Hv — the broker path needs its own
// non-loopback callback registered on the Space) instead of a classic
// OAuth App — so GitHub's authorize screen offers "Only select
// repositories": complete access over ONE repo, nothing account-wide
// (the repo-level grant the user demanded).
//
// THE CHAIN (every hop a full-page navigation in the popup the panel
// opened — the app tab itself never moves):
//
//   popup → GET <engine>/api/gh/oauth/broker/start?origin=<app origin>
//         → 302 <space>/gh/oauth/start?redirect=<origin>
//         → 302 github.com/login/oauth/authorize?… (the ONE user click:
//           Install & Authorize + repo selection)
//         → 302 <space>/gh/oauth/callback?code&state   (secret exchange
//           happens INSIDE the space — it never touches any browser)
//         → 302 <origin>/api/gh/oauth/relay?grant=<one-time code>
//   relay → engine claims the grant server-to-server (netx) → vault
//         → THE DONE PAGE (postMessage + self-close + doomalay://return —
//           v0.60.1's home-coming, same as every other flow now)
//
// WHY THE ORIGIN COMES FROM THE FRONTEND (?origin=): behind a rewriting
// gateway schemeHost(r) reconstructs localhost:8080 (the v0.59 lesson) —
// only the page knows the origin the BROWSER can navigate back to. The
// space independently validates the redirect target (loopback / private
// nets / the gateway platform) so the grant relay can never be aimed at
// an arbitrary public host by a crafted link.
package server

import (
        "context"
        "encoding/json"
        "io"
        "net/http"
        "net/url"
        "strings"
        "time"
)

// ghBrokerOverride points the broker at a different base (tests,
// self-hosters). Empty = the community shared space (same Space that runs
// the shared chat sandbox).
var ghBrokerOverride = getenvDefault("DOOMALAY_GH_BROKER", "")

// ghBrokerBaseURL is the space that holds the GitHub App secret.
func ghBrokerBaseURL() string {
        if ghBrokerOverride != "" {
                return strings.TrimSuffix(ghBrokerOverride, "/")
        }
        return sharedSpaceBaseURL()
}

// handleGHBrokerStart is GET /api/gh/oauth/broker/start?origin=<app origin>
// — the popup's first hop. Pure redirector: the secret, the state and the
// exchange all live on the space.
func (s *Server) handleGHBrokerStart(w http.ResponseWriter, r *http.Request) {
        base := ghBrokerBaseURL()
        if base == "" {
                writeError(w, http.StatusServiceUnavailable, "no GitHub broker configured (set DOOMALAY_GH_BROKER)")
                return
        }
        origin := r.URL.Query().Get("origin")
        // the browser-facing origin of THIS app instance (the frontend
        // passes window.location.origin — see the header note). Sanity:
        // absolute http(s) URL only; the space does the real validation.
        if u, err := url.Parse(origin); err != nil || u.Scheme == "" || u.Host == "" ||
                (u.Scheme != "http" && u.Scheme != "https") || len(origin) > 200 {
                writeError(w, http.StatusBadRequest, "origin must be the app's http(s) origin (e.g. http://127.0.0.1:8080)")
                return
        }
        q := url.Values{}
        q.Set("redirect", origin)
        http.Redirect(w, r, base+"/gh/oauth/start?"+q.Encode(), http.StatusFound)
}

// handleGHBrokerRelay is GET /api/gh/oauth/relay?grant=… — the space sends
// the popup here after the exchange. The engine claims the one-time grant
// SERVER-TO-SERVER (the token never crosses a browser URL) and lands the
// vault + the done page. ?error=… (a denial / exchange failure on the
// space) renders the error done page in the same popup.
func (s *Server) handleGHBrokerRelay(w http.ResponseWriter, r *http.Request) {
        if e := r.URL.Query().Get("error"); e != "" {
                oauthDonePage(w, "GitHub", "", "GitHub sign-in failed: "+e,
                        "gh_error="+url.QueryEscape(e))
                return
        }
        grant := r.URL.Query().Get("grant")
        if grant == "" || len(grant) > 128 {
                oauthDonePage(w, "GitHub", "", "missing broker grant (restart the sign-in)", "")
                return
        }
        base := ghBrokerBaseURL()
        if base == "" {
                oauthDonePage(w, "GitHub", "", "no GitHub broker configured on this engine", "")
                return
        }
        if s.vault == nil {
                oauthDonePage(w, "GitHub", "", "vault not initialized", "")
                return
        }
        ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
        defer cancel()
        req, err := http.NewRequestWithContext(ctx, "GET",
                base+"/gh/oauth/grants/"+url.PathEscape(grant), nil)
        if err != nil {
                oauthDonePage(w, "GitHub", "", "claim request: "+err.Error(), "")
                return
        }
        req.Header.Set("User-Agent", "doomalay-engine")
        resp, err := oauthHTTP.Do(req)
        if err != nil {
                oauthDonePage(w, "GitHub", "", "could not reach the broker space: "+err.Error(), "")
                return
        }
        defer resp.Body.Close()
        out, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
        if resp.StatusCode != http.StatusOK {
                oauthDonePage(w, "GitHub", "", "broker refused the grant (HTTP "+resp.Status+") — "+strings.TrimSpace(string(out)), "")
                return
        }
        var claim struct {
                Token        string `json:"token"`
                Login        string `json:"login"`
                RefreshToken string `json:"refresh_token"`
                ExpiresIn    int64  `json:"expires_in"`
        }
        if err := json.Unmarshal(out, &claim); err != nil || claim.Token == "" {
                oauthDonePage(w, "GitHub", "", "broker grant malformed or already claimed (restart the sign-in)", "")
                return
        }
        ae := accountExtra{Login: claim.Login, RefreshToken: claim.RefreshToken}
        if claim.ExpiresIn > 0 {
                ae.ExpiresAt = time.Now().Add(time.Duration(claim.ExpiresIn) * time.Second).Unix()
        }
        // a brokered GitHub-App token still answers /user — best-effort,
        // exactly like the self-hosted callback (a hiccup must not fail).
        if ae.Login == "" {
                if login, err := forgeLoginFor("github", claim.Token); err == nil {
                        ae.Login = login
                }
        }
        extra, _ := json.Marshal(ae)
        if err := s.vault.Set("GITHUB_PAT", "github", claim.Token, string(extra)); err != nil {
                oauthDonePage(w, "GitHub", "", "vault: "+err.Error(), "")
                return
        }
        suffix := "gh_connected=1&gh_login=" + url.QueryEscape(ae.Login)
        oauthDonePage(w, "GitHub", ae.Login, "", "/?"+suffix)
}
