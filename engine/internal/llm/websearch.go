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
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"regexp"
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

// WebSearch runs a query through Tavily (if key) → DuckDuckGo (keyless).
// Returns up to max results.
func WebSearch(ctx context.Context, query string, max int, tavilyKey string) ([]SearchResult, error) {
	if max <= 0 {
		max = 5
	}
	if tavilyKey != "" {
		if results, err := tavilySearch(ctx, query, max, tavilyKey); err == nil && len(results) > 0 {
			return results, nil
		}
	}
	return duckDuckGoSearch(ctx, query, max)
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

// duckDuckGoSearch scrapes https://html.duckduckgo.com/html/?q=... —
// keyless, matches the old backend's regexes exactly.
// v0.20: retry + alternate endpoints — under parallel swarm load DDG
// rate-limits (5xx/403) and a single-shot scrape failed whole tutorials.
func duckDuckGoSearch(ctx context.Context, query string, max int) ([]SearchResult, error) {
	var lastErr error
	for attempt := 0; attempt < 3; attempt++ {
		if attempt > 0 {
			select {
			case <-ctx.Done():
				return nil, ctx.Err()
			case <-time.After(time.Duration(attempt) * 900 * time.Millisecond):
			}
		}
		host := "https://html.duckduckgo.com/html/"
		if attempt == 1 {
			host = "https://lite.duckduckgo.com/lite/"
		}
		results, err := ddgScrape(ctx, host, query, max)
		if err == nil && len(results) > 0 {
			return results, nil
		}
		lastErr = err
		if err == nil {
			lastErr = fmt.Errorf("ddg: no results")
		}
	}
	if lastErr == nil {
		lastErr = fmt.Errorf("ddg: no results")
	}
	return nil, lastErr
}

func ddgScrape(ctx context.Context, host, query string, max int) ([]SearchResult, error) {
	u := host + "?q=" + url.QueryEscape(query)
	req, err := http.NewRequestWithContext(ctx, "GET", u, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "Mozilla/5.0 (compatible; doomalay-research/1.0)")
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
func WebFetch(ctx context.Context, rawURL string, maxChars int) (string, error) {
	if err := assertPublicURL(rawURL); err != nil {
		return "", err
	}
	if maxChars <= 0 {
		maxChars = 24000
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
		return "", fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 2<<20))
	if err != nil {
		return "", err
	}
	return htmlToText(string(body), maxChars), nil
}

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
