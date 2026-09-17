// websearch.go — keyless web search + page fetch for chat (quick chat path),
// ported from the old backend's web_tools.py:
//   - DuckDuckGo HTML endpoint (no API key, no rate limits that matter)
//   - Tavily when a TAVILY_API_KEY is present in the vault (better quality)
//   - web_fetch with an SSRF guard (private/link-local/metadata IPs rejected,
//     redirects re-validated per hop) and HTML→text extraction
//
// The chat path (chat.go) drives these through the ReAct "ACTION:" protocol
// for providers without native search — same as the old app.

package llm

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/ScoobyBaby1999/doomalay/engine/internal/netx"
)

// SearchResult is one web hit.
type SearchResult struct {
	Title   string `json:"title"`
	URL     string `json:"url"`
	Snippet string `json:"snippet"`
}

// WebSearch runs a query through the keyless engine ladder:
// Tavily (if key) → DuckDuckGo HTML → DuckDuckGo Lite → Bing.
// v0.27.1: DDG rate-limits whole carrier IP ranges (observed live: three
// consecutive HTTP 502s from a phone killed the search entirely and the
// model burned six rounds retrying) — Bing is the independent fallback.
// Returns up to max results; the error (when all engines fail) names each
// engine so the observation the model reads is diagnosable.
func WebSearch(ctx context.Context, query string, max int, tavilyKey string) ([]SearchResult, error) {
	if max <= 0 {
		max = 5
	}
	if tavilyKey != "" {
		if results, err := tavilySearch(ctx, query, max, tavilyKey); err == nil && len(results) > 0 {
			return results, nil
		}
	}
	var errs []string
	anyAnswered := false // an engine responded fine; the query just matched nothing
	for _, host := range []string{"https://html.duckduckgo.com/html/", "https://lite.duckduckgo.com/lite/"} {
		results, err := ddgScrape(ctx, host, query, max)
		if err == nil && len(results) > 0 {
			return results, nil
		}
		if err == nil {
			anyAnswered = true
			errs = append(errs, "duckduckgo: no results")
		} else {
			errs = append(errs, "duckduckgo: "+err.Error())
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(900 * time.Millisecond):
		}
	}
	if results, err := bingSearch(ctx, query, max); err == nil && len(results) > 0 {
		return results, nil
	} else if err == nil {
		anyAnswered = true
		errs = append(errs, "bing: no results")
	} else {
		errs = append(errs, "bing: "+err.Error())
	}
	// Engines answered but nothing matched → EMPTY SUCCESS. The model then
	// sees "(no results … may be private/nonexistent)" instead of a fake
	// network failure it would retry (the old code 502'd this case).
	if anyAnswered {
		return []SearchResult{}, nil
	}
	return nil, fmt.Errorf("all search engines failed — %s", strings.Join(errs, "; "))
}

// tavilySearch POSTs to api.tavily.com/search (the old backend's primary).
func tavilySearch(ctx context.Context, query string, max int, apiKey string) ([]SearchResult, error) {
	payload := map[string]any{
		"api_key":        apiKey,
		"query":          query,
		"max_results":    max,
		"search_depth":   "basic",
		"include_answer": false,
	}
	status, body, err := httpPostJSON("https://api.tavily.com/search", "", payload, nil)
	if err != nil {
		return nil, err
	}
	if status != 200 {
		return nil, fmt.Errorf("tavily HTTP %d", status)
	}
	var resp struct {
		Results []struct {
			Title   string `json:"title"`
			URL     string `json:"url"`
			Content string `json:"content"`
		} `json:"results"`
	}
	if err := json.Unmarshal(body, &resp); err != nil {
		return nil, err
	}
	out := make([]SearchResult, 0, len(resp.Results))
	for _, r := range resp.Results {
		out = append(out, SearchResult{
			Title:   clamp(r.Title, 160),
			URL:     r.URL,
			Snippet: clamp(r.Content, 400),
		})
	}
	return out, nil
}

var (
	ddgResultRe = regexp.MustCompile(`(?s)<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>(.*?)</a>`)
	ddgSnipRe   = regexp.MustCompile(`(?s)class="result__snippet"[^>]*>(.*?)</a>`)
	// lite.duckduckgo.com markup (v0.20 fallback endpoint)
	ddgLiteResultRe = regexp.MustCompile(`(?s)<a[^>]*class="result-link"[^>]*href="([^"]+)"[^>]*>(.*?)</a>`)
	ddgLiteSnipRe   = regexp.MustCompile(`(?s)class="result-snippet"[^>]*>(.*?)</td>`)
	tagRe           = regexp.MustCompile(`<[^>]+>`)
)

// (duckDuckGoSearch's old 3-attempt retry loop was folded into WebSearch's
// engine ladder in v0.27.1 — the third attempt now goes to a different
// engine instead of re-hitting the rate-limited one.)

func ddgScrape(ctx context.Context, host, query string, max int) ([]SearchResult, error) {
	u := host + "?q=" + url.QueryEscape(query)
	req, err := http.NewRequestWithContext(ctx, "GET", u, nil)
	if err != nil {
		return nil, err
	}
	// v0.27.1: browser UA — the old "doomalay-research/1.0" bot marker was
	// exactly what DDG's rate-limiter keyed on (502s from carrier IPs).
	req.Header.Set("User-Agent", browserUA)
	req.Header.Set("Accept-Language", "en-US,en;q=0.9")
	// v0.14: netx transport — DoH fallback so search works on Android.
	client := &http.Client{Timeout: 15 * time.Second, Transport: netx.Transport()}
	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("ddg: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("ddg HTTP %d", resp.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 2<<20))
	if err != nil {
		return nil, err
	}
	page := string(body)

	titles := ddgResultRe.FindAllStringSubmatch(page, max)
	snips := ddgSnipRe.FindAllStringSubmatch(page, max)
	// v0.20: lite.duckduckgo.com pages use a different markup
	if len(titles) == 0 {
		titles = ddgLiteResultRe.FindAllStringSubmatch(page, max)
		snips = ddgLiteSnipRe.FindAllStringSubmatch(page, max)
	}
	out := make([]SearchResult, 0, len(titles))
	for i, m := range titles {
		href := decodeDDGRedirect(m[1])
		title := strings.TrimSpace(tagRe.ReplaceAllString(m[2], ""))
		if href == "" || title == "" {
			continue
		}
		snippet := ""
		if i < len(snips) && len(snips[i]) > 1 {
			snippet = strings.TrimSpace(tagRe.ReplaceAllString(snips[i][1], ""))
		}
		out = append(out, SearchResult{
			Title:   clamp(title, 160),
			URL:     href,
			Snippet: clamp(snippet, 400),
		})
	}
	return out, nil
}

// decodeDDGRedirect unwraps DDG's //duckduckgo.com/l/?uddg=<urlencoded> links.
func decodeDDGRedirect(href string) string {
	if strings.Contains(href, "uddg=") {
		if i := strings.Index(href, "uddg="); i >= 0 {
			enc := href[i+5:]
			if j := strings.Index(enc, "&"); j >= 0 {
				enc = enc[:j]
			}
			if dec, err := url.QueryUnescape(enc); err == nil {
				return dec
			}
		}
	}
	if strings.HasPrefix(href, "//") {
		return "https:" + href
	}
	return href
}

// ── Bing fallback engine (v0.27.1) ─────────────────────────────────────────
//
// Scrapes https://www.bing.com/search?q=... — keyless, independent of DDG's
// rate limiter, server-rendered so the markup is stable:
//
//      <li class="b_algo">… <h2><a href="URL">Title</a></h2>
//                           <p class="…b_lineclamp…">snippet</p> <cite>display url</cite>
//
// Bing wraps result URLs in its tracking redirect
// https://www.bing.com/ck/a?!&&p=…&u=a1<base64url> — decodeBingRedirect
// unwraps the u= parameter (strip the "a1" version prefix, base64url-decode).

var (
	bingBlockRe = regexp.MustCompile(`(?s)<li class="b_algo".*?</li>`)
	// the result link + title come in TWO shapes depending on UA/variant:
	//   desktop: <h2…><a href="URL"…>Title</a></h2>
	//   mobile:  <a href="URL"…><h2…>Title</h2></a>
	// (the mobile page's first anchor is a "tilk" attribution link that
	// wraps no h2 — only the a>writing-h2 shape is the real result link)
	bingH2ARe  = regexp.MustCompile(`(?s)<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>(.*?)</a>`)
	bingAH2Re  = regexp.MustCompile(`(?s)<a[^>]*href="([^"]+)"[^>]*>\s*<h2[^>]*>(.*?)</h2>`)
	bingSnipRe = regexp.MustCompile(`(?s)<p[^>]*class="[^"]*b_lineclamp[^"]*"[^>]*>(.*?)</p>`)
	bingCiteRe = regexp.MustCompile(`(?s)<cite[^>]*>(.*?)</cite>`)
)

// bingSearch scrapes Bing's result page (keyless fallback engine).
func bingSearch(ctx context.Context, query string, max int) ([]SearchResult, error) {
	u := "https://www.bing.com/search?q=" + url.QueryEscape(query) +
		"&count=" + strconv.Itoa(max*2) + "&setlang=en-US"
	req, err := http.NewRequestWithContext(ctx, "GET", u, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", browserUA)
	req.Header.Set("Accept-Language", "en-US,en;q=0.9")
	client := &http.Client{Timeout: 15 * time.Second, Transport: netx.Transport()}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if err != nil {
		return nil, err
	}
	return bingParse(string(body), max), nil
}

// bingParse extracts results from a Bing SERP page (pure function — unit
// tested against a saved fixture).
func bingParse(page string, max int) []SearchResult {
	out := []SearchResult{}
	for _, block := range bingBlockRe.FindAllString(page, max) {
		m := bingH2ARe.FindStringSubmatch(block)
		if len(m) == 0 {
			m = bingAH2Re.FindStringSubmatch(block) // mobile variant
		}
		if len(m) == 0 {
			continue
		}
		href := htmlUnescapeAttr(m[1])
		url_ := decodeBingRedirect(href)
		title := strings.TrimSpace(htmlUnescapeAttr(tagRe.ReplaceAllString(m[2], "")))
		if url_ == "" || title == "" {
			continue
		}
		snippet := ""
		if sm := bingSnipRe.FindStringSubmatch(block); len(sm) > 1 {
			snippet = strings.TrimSpace(htmlUnescapeAttr(tagRe.ReplaceAllString(sm[1], "")))
		}
		if snippet == "" {
			if cm := bingCiteRe.FindStringSubmatch(block); len(cm) > 1 {
				snippet = strings.TrimSpace(htmlUnescapeAttr(tagRe.ReplaceAllString(cm[1], "")))
			}
		}
		out = append(out, SearchResult{
			Title:   clamp(title, 160),
			URL:     url_,
			Snippet: clamp(snippet, 400),
		})
	}
	return out
}

// decodeBingRedirect unwraps https://www.bing.com/ck/a?...&u=a1<base64url>.
// Non-tracking hrefs pass through untouched.
func decodeBingRedirect(href string) string {
	if !strings.Contains(href, "/ck/a") {
		return strings.TrimSpace(href)
	}
	u, err := url.Parse(href)
	if err != nil {
		return strings.TrimSpace(href)
	}
	enc := u.Query().Get("u")
	if enc == "" {
		return strings.TrimSpace(href)
	}
	enc = strings.TrimPrefix(enc, "a1") // version marker prefix
	// Bing pads inconsistently ("a1…==" or unpadded) — normalize to raw
	enc = strings.TrimRight(enc, "=")
	if dec, err := base64.RawURLEncoding.DecodeString(enc); err == nil {
		if s := string(dec); strings.HasPrefix(s, "http") {
			return s
		}
	}
	return strings.TrimSpace(href)
}

// htmlUnescapeAttr decodes HTML entities in scraped attributes AND titles
// (&amp; most importantly — Bing doubles them up in ck/a URLs; titles carry
// numeric refs like &#183;).
var htmlEntRe = regexp.MustCompile(`&[a-zA-Z#0-9]+;`)

func htmlUnescapeAttr(s string) string {
	if !strings.Contains(s, "&") {
		return s
	}
	return htmlEntRe.ReplaceAllStringFunc(s, func(e string) string {
		switch e {
		case "&amp;":
			return "&"
		case "&lt;":
			return "<"
		case "&gt;":
			return ">"
		case "&quot;":
			return "\""
		case "&#39;", "&apos;":
			return "'"
		case "&nbsp;":
			return " "
		}
		// numeric refs: &#183; · &#x00B7; · &#8212; —
		if strings.HasPrefix(e, "&#") {
			hex := strings.HasPrefix(e, "&#x") || strings.HasPrefix(e, "&#X")
			digits := strings.TrimSuffix(e[2:], ";")
			digits = strings.TrimPrefix(strings.TrimPrefix(digits, "x"), "X")
			base := 10
			if hex {
				base = 16
			}
			if n, err := strconv.ParseInt(digits, base, 32); err == nil && n > 0 && n < 0x110000 {
				return string(rune(n))
			}
		}
		return e
	})
}

// ── web_fetch (SSRF-guarded) ───────────────────────────────────────────────

// ssrfClient rejects private / link-local / metadata IPs at connect time and
// re-validates every redirect hop (max 4).
var ssrfClient = &http.Client{
	Timeout: 15 * time.Second,
	CheckRedirect: func(req *http.Request, via []*http.Request) error {
		if len(via) >= 4 {
			return fmt.Errorf("too many redirects")
		}
		if err := assertPublicURL(req.URL.String()); err != nil {
			return err
		}
		return nil
	},
	// v0.14: netx transport — DoH fallback dialer (Android egress). The
	// SSRF policy is enforced by assertPublicURL below (per-hop) which
	// itself uses netx.LookupIP so the guard resolves the same set of
	// public IPs the dialer will actually connect to.
	Transport: netx.Transport(),
}

// assertPublicURL validates that a URL's host resolves to a public address
// (SSRF guard — same policy as the old backend's ssrfguard).
func assertPublicURL(raw string) error {
	u, err := url.Parse(raw)
	if err != nil {
		return err
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return fmt.Errorf("scheme %q not allowed", u.Scheme)
	}
	host := u.Hostname()
	if host == "localhost" || strings.HasSuffix(host, ".localhost") || strings.HasSuffix(host, ".local") {
		return fmt.Errorf("local host blocked")
	}
	// v0.14: netx lookup (system → DoH) so the guard works on Android too —
	// net.LookupIP alone fails there (pure-Go resolver) and would block
	// every fetch with a spurious "resolve" error.
	ips := netx.LookupIP(context.Background(), host)
	if len(ips) == 0 {
		return fmt.Errorf("resolve %s: no address", host)
	}
	for _, ip := range ips {
		if !isPublicIP(ip) {
			return fmt.Errorf("private address blocked for %s", host)
		}
	}
	return nil
}

func isPublicIP(ip net.IP) bool {
	if ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast() ||
		ip.IsLinkLocalMulticast() || ip.IsUnspecified() || ip.IsMulticast() {
		return false
	}
	// Cloud metadata endpoints (169.254.169.254 covered by link-local, but be explicit).
	if ip.Equal(net.ParseIP("169.254.169.254")) {
		return false
	}
	return ip.To4() != nil || ip.To16() != nil
}

// WebFetch downloads a page and extracts readable text (script/style stripped,
// tags → newlines, whitespace collapsed). Capped at maxChars (24K default —
// same cap as the old backend's WEB_FETCH_MAX_CHARS).
//
// v0.27.1 STRUCTURED FALLBACKS: two hosts serve JS-shell pages or hard 404s
// to anonymous fetches but expose clean keyless JSON APIs. On fetch failure
// (or, for HF spaces, always — the page is an SPA shell with no content):
//
//	github.com/{owner}/{repo}…   → api.github.com/repos/{owner}/{repo}
//	huggingface.co/spaces/{o}/{n} → huggingface.co/api/spaces/{o}/{n}
//
// The fallbacks return readable text or a precise error ("private, renamed
// or deleted") — the old behavior surfaced a bare "HTTP 404"/"HTTP 502" the
// model could only guess at (observed live: it concluded "GitHub blocks
// automated requests" for what was actually a private repo and burned six
// rounds retrying).
func WebFetch(ctx context.Context, rawURL string, maxChars int) (string, error) {
	if err := assertPublicURL(rawURL); err != nil {
		return "", err
	}
	if maxChars <= 0 {
		maxChars = 24000
	}
	// HF spaces: the page is a client-rendered shell — the API is strictly
	// better, so it goes FIRST for that host.
	if txt, ok, err := structuredFetch(ctx, rawURL, maxChars, true); ok {
		return txt, err
	}
	req, err := http.NewRequestWithContext(ctx, "GET", rawURL, nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("User-Agent", browserUA)
	resp, err := ssrfClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		// second chance: a known-host JSON API may still describe the
		// target (public repo whose HTML fetch failed, private repo, …).
		// A precise "private/renamed/deleted" error beats a bare status.
		if txt, ok, ferr := structuredFetch(ctx, rawURL, maxChars, false); ok {
			if ferr == nil {
				return txt, nil
			}
			return "", ferr
		}
		return "", fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 2<<20))
	if err != nil {
		return "", err
	}
	return htmlToText(string(body), maxChars), nil
}

// structuredFetch resolves github.com / huggingface.co URLs through their
// keyless JSON APIs. prefer=true runs even when the page fetch would work
// (HF spaces); prefer=false runs only as a failure fallback (GitHub pages
// render server-side and are fine when reachable).
// ok=false → URL not one of the known shapes (caller proceeds normally).
func structuredFetch(ctx context.Context, rawURL string, maxChars int, prefer bool) (string, bool, error) {
	u, err := url.Parse(rawURL)
	if err != nil {
		return "", false, nil
	}
	host := strings.ToLower(u.Hostname())
	segs := strings.Split(strings.Trim(u.Path, "/"), "/")

	switch {
	case host == "github.com" && len(segs) >= 2 && !prefer:
		owner, repo := segs[0], strings.TrimSuffix(segs[1], ".git")
		api := "https://api.github.com/repos/" + url.PathEscape(owner) + "/" + url.PathEscape(repo)
		var r githubRepoInfo
		if err := fetchJSONAPI(ctx, api, &r); err != nil {
			if strings.Contains(err.Error(), "404") {
				return "", true, fmt.Errorf("github repository %s/%s not found — it is private, renamed, or deleted (anonymous requests cannot see private repositories)", owner, repo)
			}
			if strings.Contains(err.Error(), "rate limit") {
				// GitHub's unauthenticated API is 60 req/h per IP — shared
				// carrier/cloud IPs burn that constantly. The page itself
				// already told us the status (that's why we're here), so report
				// what we know instead of hiding behind a bare status.
				return "", true, fmt.Errorf("github repository %s/%s is not visible to anonymous access (private, renamed, or deleted); the public metadata API is rate-limited on this network and could not confirm details — a GITHUB_TOKEN in the vault would lift that limit", owner, repo)
			}
			return "", false, nil // API unreachable → caller keeps the original error
		}
		extra := ""
		if len(segs) > 2 {
			extra = strings.Join(segs[2:], "/")
		}
		return clampMaybe(formatGitHubRepo(r, extra), maxChars), true, nil

	case host == "huggingface.co" && len(segs) >= 3 && segs[0] == "spaces":
		owner, name := segs[1], segs[2]
		api := "https://huggingface.co/api/spaces/" + url.PathEscape(owner) + "/" + url.PathEscape(name)
		var r hfSpaceInfo
		if err := fetchJSONAPI(ctx, api, &r); err != nil {
			if strings.Contains(err.Error(), "404") {
				return "", true, fmt.Errorf("huggingface space %s/%s not found — it is private, renamed, or deleted", owner, name)
			}
			return "", false, nil
		}
		return clampMaybe(formatHFSpace(r, owner, name), maxChars), true, nil
	}
	return "", false, nil
}

// githubRepoInfo mirrors api.github.com/repos/{owner}/{repo} (the fields the
// observation actually uses).
type githubRepoInfo struct {
	FullName    string   `json:"full_name"`
	Description string   `json:"description"`
	HTMLURL     string   `json:"html_url"`
	Homepage    string   `json:"homepage"`
	Language    string   `json:"language"`
	Stars       int      `json:"stargazers_count"`
	Forks       int      `json:"forks_count"`
	OpenIssues  int      `json:"open_issues_count"`
	Topics      []string `json:"topics"`
	License     struct {
		Name string `json:"name"`
	} `json:"license"`
	DefaultBranch string `json:"default_branch"`
	PushedAt      string `json:"pushed_at"`
	CreatedAt     string `json:"created_at"`
	Visibility    string `json:"visibility"`
}

// formatGitHubRepo renders the repo metadata as model-readable text.
// extraPath is the path below /{owner}/{repo} when the request targeted a
// file or subtree (resolved through metadata, not the raw page).
func formatGitHubRepo(r githubRepoInfo, extraPath string) string {
	var b strings.Builder
	fmt.Fprintf(&b, "GitHub repository: %s\n", r.FullName)
	if r.Description != "" {
		fmt.Fprintf(&b, "Description: %s\n", r.Description)
	}
	fmt.Fprintf(&b, "URL: %s\n", r.HTMLURL)
	if r.Homepage != "" {
		fmt.Fprintf(&b, "Homepage: %s\n", r.Homepage)
	}
	fmt.Fprintf(&b, "Language: %s · Stars: %d · Forks: %d · Open issues: %d\n", r.Language, r.Stars, r.Forks, r.OpenIssues)
	if len(r.Topics) > 0 {
		fmt.Fprintf(&b, "Topics: %s\n", strings.Join(r.Topics, ", "))
	}
	if r.License.Name != "" {
		fmt.Fprintf(&b, "License: %s\n", r.License.Name)
	}
	fmt.Fprintf(&b, "Default branch: %s · Created: %s · Last push: %s\n", r.DefaultBranch, r.CreatedAt, r.PushedAt)
	if extraPath != "" {
		fmt.Fprintf(&b, "(Requested path %q was resolved through the repository metadata API.)\n", extraPath)
	}
	return b.String()
}

// hfSpaceInfo mirrors huggingface.co/api/spaces/{owner}/{name}.
type hfSpaceInfo struct {
	ID           string   `json:"id"`
	Author       string   `json:"author"`
	Description  string   `json:"description"`
	SDK          string   `json:"sdk"`
	Likes        int      `json:"likes"`
	Tags         []string `json:"tags"`
	LastModified string   `json:"lastModified"`
	Runtime      struct {
		Stage string `json:"stage"`
	} `json:"runtime"`
}

// formatHFSpace renders the space metadata as model-readable text.
func formatHFSpace(r hfSpaceInfo, owner, name string) string {
	var b strings.Builder
	fmt.Fprintf(&b, "Hugging Face Space: %s (by %s)\n", r.ID, r.Author)
	if r.Description != "" {
		fmt.Fprintf(&b, "Description: %s\n", r.Description)
	}
	fmt.Fprintf(&b, "URL: https://huggingface.co/spaces/%s/%s\n", owner, name)
	fmt.Fprintf(&b, "SDK: %s · Likes: %d · Runtime stage: %s\n", r.SDK, r.Likes, r.Runtime.Stage)
	if len(r.Tags) > 0 {
		fmt.Fprintf(&b, "Tags: %s\n", strings.Join(r.Tags, ", "))
	}
	if r.LastModified != "" {
		fmt.Fprintf(&b, "Last modified: %s\n", r.LastModified)
	}
	return b.String()
}

// clampMaybe applies the maxChars cap to structured-fetch output.
func clampMaybe(s string, maxChars int) string {
	if maxChars > 0 && len(s) > maxChars {
		return s[:maxChars] + "\n…[truncated]"
	}
	return s
}

// fetchJSONAPI GETs a keyless public JSON API through the SSRF-guarded
// client. Error text carries the status (+ a body snippet — GitHub's 403
// rate-limit page explains itself; callers must tell "rate limited" apart
// from "not found") so callers can react to 404s.
func fetchJSONAPI(ctx context.Context, apiURL string, out any) error {
	req, err := http.NewRequestWithContext(ctx, "GET", apiURL, nil)
	if err != nil {
		return err
	}
	req.Header.Set("User-Agent", browserUA)
	req.Header.Set("Accept", "application/json")
	// Optional: a GITHUB_TOKEN in the vault lifts api.github.com from
	// 60 req/h (per IP — carrier CGNAT + shared cloud IPs exhaust this)
	// to 5,000 req/h. Keyless when absent, better when present.
	if strings.Contains(apiURL, "api.github.com/") && githubToken != "" {
		req.Header.Set("Authorization", "Bearer "+githubToken)
	}
	resp, err := ssrfClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return err
	}
	if resp.StatusCode != 200 {
		msg := strings.TrimSpace(string(body))
		if i := strings.Index(msg, "\""); i >= 0 { // cheap one-line JSON extraction
			if m := jsonMsgRe.FindStringSubmatch(msg); len(m) > 1 {
				msg = m[1]
			}
		}
		if len(msg) > 140 {
			msg = msg[:140]
		}
		if msg != "" {
			return fmt.Errorf("HTTP %d (%s)", resp.StatusCode, msg)
		}
		return fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	return json.Unmarshal(body, out)
}

var jsonMsgRe = regexp.MustCompile(`"message"\s*:\s*"([^"]+)"`)

// githubToken is the optional vault-provided GitHub API token
// (SetGitHubToken — called by the server at startup and on key changes).
var githubToken string

// SetGitHubToken arms the api.github.com fallback with a vault token.
func SetGitHubToken(tok string) { githubToken = strings.TrimSpace(tok) }

var (
	scriptStyleRe = regexp.MustCompile(`(?s)<(script|style|noscript)[^>]*>.*?</(script|style|noscript)>`)
	breakRe       = regexp.MustCompile(`(?i)<(br|/p|/div|/li|/h[1-6])[^>]*>`)
	spaceRe       = regexp.MustCompile(`[ \t]+`)
	newlineRe     = regexp.MustCompile(`\n{3,}`)
)

// htmlToText converts HTML to readable text (old backend's extractor).
func htmlToText(html string, maxChars int) string {
	s := scriptStyleRe.ReplaceAllString(html, "")
	s = breakRe.ReplaceAllString(s, "\n")
	s = tagRe.ReplaceAllString(s, "")
	s = strings.ReplaceAll(s, "&nbsp;", " ")
	s = strings.ReplaceAll(s, "&amp;", "&")
	s = strings.ReplaceAll(s, "&lt;", "<")
	s = strings.ReplaceAll(s, "&gt;", ">")
	s = strings.ReplaceAll(s, "&quot;", "\"")
	s = spaceRe.ReplaceAllString(s, " ")
	s = newlineRe.ReplaceAllString(s, "\n\n")
	s = strings.TrimSpace(s)
	if len(s) > maxChars {
		s = s[:maxChars] + "\n…[truncated]"
	}
	return s
}

// FormatSearchResults renders results as numbered lines for the model:
// "1. Title - URL\n   snippet".
func FormatSearchResults(results []SearchResult) string {
	var b strings.Builder
	for i, r := range results {
		fmt.Fprintf(&b, "%d. %s - %s\n   %s\n", i+1, r.Title, r.URL, clamp(r.Snippet, 300))
	}
	return b.String()
}

func clamp(s string, n int) string {
	s = strings.TrimSpace(s)
	if len(s) > n {
		return s[:n] + "…"
	}
	return s
}
