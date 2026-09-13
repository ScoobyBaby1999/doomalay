package server

import (
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/ScoobyBaby1999/doomalay/engine/internal/netx"
)

// probe.go — GET /api/probe-embed?url=...
//
// v0.13 fix for the redirect regressions:
//   - portal.privatemode.ai / build.nvidia.com deep links carry
//     X-Frame-Options: DENY / SAMEORIGIN + CSP frame-ancestors → the WebView
//     renders "net::ERR_BLOCKED_BY_RESPONSE" instantly inside the iframe.
//   - opencode.ai/auth renders in the iframe but is an OAuth redirect chain
//     (opencode.ai → auth.opencode.ai → Google) — login can never complete
//     embedded, and Google answers 403 "you do not have access to this page".
//
// The engine probes the URL BEFORE the app builds an iframe:
//   - follows redirects (max 5), like a browser would
//   - inspects X-Frame-Options + CSP frame-ancestors on the FINAL response
//   - detects cross-domain redirect chains (OAuth-style flows)
// Response: {"embeddable": bool, "reason": "...", "final_url": "...", "status": int, "cross_domain_redirect": bool}
//
// The frontend then decides: embeddable → in-app iframe browser; blocked →
// a clean "open in the real browser" card (Chrome handles login + key
// creation fine) with the key-paste screen waiting underneath.
//
// 100% dynamic — no hardcoded per-provider embed flags.

var probeClient = &http.Client{
	// NO automatic redirects — we walk each hop manually so every host in
	// the chain is inspected (SSO subdomain moves, identity-provider hops).
	CheckRedirect: func(req *http.Request, via []*http.Request) error {
		return http.ErrUseLastResponse
	},
	Timeout: 12 * time.Second,
	// v0.14: netx transport — without this, the probe failed on Android
	// (pure-Go DNS) and the frontend fell back to a best-effort iframe,
	// which rendered the ERR_BLOCKED_BY_RESPONSE white screen.
	Transport: netx.Transport(),
}

// embedProbeResult is the verdict for a URL.
type embedProbeResult struct {
	Embeddable          bool   `json:"embeddable"`
	Reason              string `json:"reason,omitempty"`
	FinalURL            string `json:"final_url"`
	Status              int    `json:"status"`
	CrossDomainRedirect bool   `json:"cross_domain_redirect"`
}

// handleProbeEmbed is GET /api/probe-embed?url=<https://...>
func (s *Server) handleProbeEmbed(w http.ResponseWriter, r *http.Request) {
	raw := r.URL.Query().Get("url")
	if raw == "" {
		writeError(w, 400, "url query param is required")
		return
	}
	target, err := url.Parse(raw)
	if err != nil || (target.Scheme != "http" && target.Scheme != "https") {
		writeError(w, 400, "url must be a valid http(s) URL")
		return
	}

	result := probeEmbed(target.String())
	writeJSON(w, 200, result)
}

// probeEmbed fetches the URL (browser-like headers) and judges embeddability.
// Redirect hops are followed MANUALLY (max 5) so every host in the chain is
// checked — OAuth/SSO moves (opencode.ai → auth.opencode.ai → accounts.google.com)
// can never complete inside a cross-origin iframe.
func probeEmbed(target string) embedProbeResult {
	res := embedProbeResult{FinalURL: target, Embeddable: true, Reason: "no framing restrictions detected"}

	url := target
	hopHosts := []string{hostOf(target)}
	var resp *http.Response
	for hop := 0; hop <= 5; hop++ {
		req, err := http.NewRequest("GET", url, nil)
		if err != nil {
			return embedProbeResult{FinalURL: target, Embeddable: false, Reason: "build request: " + err.Error()}
		}
		// Browser-ish headers: many portals behave differently (or block) for
		// empty/default UAs. This mirrors what the WebView would send.
		req.Header.Set("User-Agent", "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36")
		req.Header.Set("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8")
		req.Header.Set("Accept-Language", "en-US,en;q=0.9")

		r, err := probeClient.Do(req)
		if err != nil {
			// Network failure — can't judge. Let the iframe try (it may work
			// from the WebView even when the engine's egress differs), but keep
			// the escape hatch visible.
			if resp != nil {
				resp.Body.Close()
			}
			return embedProbeResult{FinalURL: target, Embeddable: true, Reason: "probe unreachable: " + err.Error()}
		}
		resp = r
		res.Status = resp.StatusCode
		res.FinalURL = url

		// Follow the redirect manually.
		if resp.StatusCode >= 300 && resp.StatusCode < 400 {
			loc := resp.Header.Get("Location")
			resp.Body.Close()
			if loc == "" {
				break
			}
			next, err := absoluteURL(url, loc)
			if err != nil {
				break
			}
			hopHosts = append(hopHosts, hostOf(next))
			url = next
			continue
		}
		defer resp.Body.Close()
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4096)) // drain a little; body unused
		break
	}

	// ── Redirect-chain analysis ──
	origHost := hostOf(target)
	for _, h := range hopHosts[1:] {
		if h == "" || h == origHost || isCosmeticSubdomain(h, origHost) {
			continue
		}
		if isIdentityProvider(h) {
			res.CrossDomainRedirect = true
			res.Embeddable = false
			res.Reason = "redirects to a third-party sign-in (" + h + ") that can't complete inside the app"
			return res
		}
		if !sameRegistrableDomain(h, origHost) {
			res.CrossDomainRedirect = true
			res.Embeddable = false
			res.Reason = "redirects to a sign-in page on " + h + " (cross-domain login can't complete inside the app)"
			return res
		}
		// Same registrable domain but a DIFFERENT meaningful subdomain —
		// an SSO move (opencode.ai → auth.opencode.ai). The login form may
		// render, but OAuth buttons / cookie partitioning break completion.
		res.Embeddable = false
		res.Reason = "redirects to its sign-in page (" + h + ") — complete the login in the browser"
		res.CrossDomainRedirect = true
		return res
	}

	// ── Final-response headers ──
	xfos := strings.TrimSpace(resp.Header.Get("X-Frame-Options"))
	if xfos != "" {
		directive := strings.ToUpper(strings.Fields(xfos)[0])
		switch directive {
		case "DENY", "SAMEORIGIN":
			res.Embeddable = false
			res.Reason = "site blocks embedding (X-Frame-Options: " + directive + ")"
			return res
		case "ALLOW-FROM", "ALLOWALL", "ALLOW-ALL":
			if directive != "ALLOWALL" && directive != "ALLOW-ALL" {
				res.Embeddable = false
				res.Reason = "site only allows embedding from its own origin"
				return res
			}
		}
	}

	if csp := resp.Header.Get("Content-Security-Policy"); csp != "" {
		for _, policy := range strings.Split(csp, ";") {
			policy = strings.TrimSpace(policy)
			if !strings.HasPrefix(strings.ToLower(policy), "frame-ancestors") {
				continue
			}
			directives := strings.Fields(policy)[1:]
			blocked := false
			allowed := false
			for _, d := range directives {
				switch strings.ToLower(d) {
				case "'none'":
					blocked = true
				case "'self'":
					// 'self' blocks us (we're cross-origin).
				case "*":
					allowed = true
				}
			}
			if blocked || (!allowed && len(directives) > 0) {
				res.Embeddable = false
				res.Reason = "site blocks embedding (CSP frame-ancestors)"
				return res
			}
		}
	}

	// 403/401 on GET without cookies → the page requires a login the iframe
	// can't complete either (same session partitioning problems).
	if resp.StatusCode == 401 || resp.StatusCode == 403 {
		res.Embeddable = false
		res.Reason = fmt.Sprintf("page requires sign-in (HTTP %d)", resp.StatusCode)
		return res
	}

	return res
}

// absoluteURL resolves a Location header against the current URL.
func absoluteURL(current, loc string) (string, error) {
	base, err := url.Parse(current)
	if err != nil {
		return "", err
	}
	ref, err := url.Parse(loc)
	if err != nil {
		return "", err
	}
	return base.ResolveReference(ref).String(), nil
}

// isCosmeticSubdomain: www/apex equivalence (www.nvidia.com == nvidia.com).
func isCosmeticSubdomain(h, orig string) bool {
	norm := func(s string) string {
		s = strings.TrimPrefix(strings.ToLower(s), "www.")
		return s
	}
	return norm(h) == norm(orig)
}

// isIdentityProvider reports whether a hop host is a third-party login
// (Google/Microsoft/Apple/GitHub SSO) — OAuth inside an iframe always 403s.
var identityProviders = []string{
	"accounts.google.com", "login.microsoftonline.com", "login.live.com",
	"appleid.apple.com", "github.com/login", "auth0.com", "okta.com",
}

func isIdentityProvider(host string) bool {
	h := strings.ToLower(host)
	for _, idp := range identityProviders {
		if h == idp || strings.HasSuffix(h, "."+idp) {
			return true
		}
		// github.com/login is a path — handle github.com specially.
		if idp == "github.com/login" && h == "github.com" {
			return true
		}
	}
	return false
}

// hostOf extracts the hostname from a URL string ("" on error).
func hostOf(u string) string {
	parsed, err := url.Parse(u)
	if err != nil {
		return ""
	}
	return strings.ToLower(parsed.Hostname())
}

// sameRegistrableDomain compares hosts by their last two labels
// (opencode.ai == auth.opencode.ai; nvidia.com != privatemode.ai).
func sameRegistrableDomain(a, b string) bool {
	if a == b {
		return true
	}
	ra, rb := registrable(a), registrable(b)
	return ra != "" && ra == rb
}

func registrable(host string) string {
	// Strip a leading "www." — cosmetic only.
	host = strings.TrimPrefix(host, "www.")
	parts := strings.Split(host, ".")
	if len(parts) < 2 {
		return host
	}
	// Handle common two-part TLDs minimally (co.uk, com.au, ...).
	twoPart := map[string]bool{"co": true, "com": true, "org": true, "net": true, "gov": true, "ac": true, "edu": true}
	if len(parts) >= 3 && twoPart[parts[len(parts)-2]] {
		return strings.Join(parts[len(parts)-3:], ".")
	}
	return strings.Join(parts[len(parts)-2:], ".")
}
