package llm

// websearch_test.go — v0.27.1: the Bing fallback engine + structured fetch
// formatters, fixture-based (no network). The live engine-chain behavior
// was verified manually against the real endpoints; these tests pin the
// PARSING so a markup/Bing-redirect change fails loudly instead of
// silently returning zero results (which, pre-fallback, killed search).

import (
	"encoding/base64"
	"encoding/json"
	"strings"
	"testing"
)

// bingSERPFixture mirrors the real www.bing.com/search markup: <li
// class="b_algo"> blocks whose h2 anchors point through the /ck/a tracking
// redirect (with &amp;-escaped query params), b_lineclamp snippets, and a
// cite fallback. Structurally trimmed from a live capture (2026-09).
const bingSERPFixture = `
<html><body><ol id="b_results">
<li class="b_algo" data-id iid=SERP.1>
  <link rel="stylesheet" href="https://r.bing.com/rp/x.css" type="text/css"/>
  <h2><a target="_blank" href="https://www.bing.com/ck/a?!&amp;&amp;p=cb40ab0873ffc5c54a5428e28523834ae7bbe16e0241487eb220fc36f617b26dJmltdHM9MTc4OTYwMzIwMA&amp;ptn=3&amp;ver=2&amp;hsh=4&amp;fclid=0ad8fdf7-014b-6dbc-30d4-ea2000c36cb5&amp;u=a1aHR0cHM6Ly9naXRodWIuY29tL1Njb29ieUJhYnkxOTk5L2Rvb21hbGF5&amp;ntb=1" h="ID=SERP,5">doomalay · GitHub</a></h2>
  <p class="b_lineclamp2 b_algoSlug">Private on-device AI workspace — engine, brain and apps <strong>ScoobyBaby1999</strong>/doomalay</p>
  <cite>https://github.com › ScoobyBaby1999 › doomalay</cite>
</li>
<li class="b_algo" data-id iid=SERP.2>
  <div class="b_caption"><h2><a href="https://example.com/direct/no-redirect">Direct Link No Redirect</a></h2></div>
  <div class="b_caption"><p class="b_lineclamp4">A plain direct result with a <em>marked-up</em> snippet.</p></div>
  <cite>example.com</cite>
</li>
<li class="b_algo" data-id iid=SERP.3>
  <h2><a href="https://www.bing.com/ck/a?&amp;u=a1aHR0cHM6Ly9odWdnaW5nZmFjZS5jby9zcGFjZXMvU2Nvb2J5QmFieTE5OTkvZG9vbWFsYXlzb2NyZWF0ZQ==">Doomalaysocreate - a Hugging Face Space</a></h2>
  <cite>huggingface.co</cite>
</li>
<li class="b_algo" data-id iid=SERP.4>
  <div class="b_tpcn"><a class="tilk" aria-label="github.com" RedirectUrl="" tabindex="-1" href="https://github.com/huggingface"><div class="tpic"><div class="cico siteicon"></div></div></a></div>
  <div class="b_algoheader"><a href="https://github.com/huggingface" h="ID=SERP,5"><h2 class="">Hugging Face &#183; GitHub</h2></a></div>
  <div class="b_caption"><p class="b_lineclamp3" data-rslinkclamp-iid="">The org hub on GitHub.</p></div>
</li>
<li class="b_pag">…pagination chrome, not a result…</li>
</ol></body></html>`

func bingCkA(target string) string {
	return "https://www.bing.com/ck/a?!&&p=abc&u=a1" +
		base64.RawURLEncoding.EncodeToString([]byte(target))
}

func TestBingParseDecodesTrackingRedirects(t *testing.T) {
	results := bingParse(bingSERPFixture, 8)
	if len(results) != 4 {
		t.Fatalf("expected 3 results, got %d: %+v", len(results), results)
	}
	if results[0].Title != "doomalay · GitHub" {
		t.Errorf("result 0 title = %q", results[0].Title)
	}
	if results[0].URL != "https://github.com/ScoobyBaby1999/doomalay" {
		t.Errorf("result 0 url not decoded from ck/a: %q", results[0].URL)
	}
	if !strings.Contains(results[0].Snippet, "Private on-device AI workspace") {
		t.Errorf("result 0 snippet = %q", results[0].Snippet)
	}
	if results[1].URL != "https://example.com/direct/no-redirect" {
		t.Errorf("direct href should pass through untouched, got %q", results[1].URL)
	}
	if !strings.Contains(results[1].Snippet, "plain direct result") {
		t.Errorf("result 1 snippet (b_lineclamp4) = %q", results[1].Snippet)
	}
	// result 2 has no b_lineclamp <p> — the cite text becomes the snippet
	if results[2].URL != "https://huggingface.co/spaces/ScoobyBaby1999/doomalaysocreate" {
		t.Errorf("result 2 url = %q", results[2].URL)
	}
	if !strings.Contains(results[2].Snippet, "huggingface.co") {
		t.Errorf("result 2 cite-fallback snippet = %q", results[2].Snippet)
	}
}

func TestDecodeBingRedirect(t *testing.T) {
	cases := []struct {
		in, want string
	}{
		{"https://example.com/plain", "https://example.com/plain"},
		{bingCkA("https://github.com/a/b"), "https://github.com/a/b"},
		{bingCkA("http://neverserved.example/x"), "http://neverserved.example/x"},
		// u= present but not base64 of an http(s) URL → pass through
		{"https://www.bing.com/ck/a?u=a1AAAA", "https://www.bing.com/ck/a?u=a1AAAA"},
		// no u param at all
		{"https://www.bing.com/ck/a?!&&p=1", "https://www.bing.com/ck/a?!&&p=1"},
	}
	for _, c := range cases {
		if got := decodeBingRedirect(c.in); got != c.want {
			t.Errorf("decodeBingRedirect(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestHtmlUnescapeAttr(t *testing.T) {
	if got := htmlUnescapeAttr("https://x.com/ck/a?!&amp;&amp;p=1&amp;u=a1aHR0cA"); got != "https://x.com/ck/a?!&&p=1&u=a1aHR0cA" {
		t.Errorf("ampersand unescape failed: %q", got)
	}
	if got := htmlUnescapeAttr("plain"); got != "plain" {
		t.Errorf("plain mangled: %q", got)
	}
}

const githubRepoFixture = `{
  "full_name": "ScoobyBaby1999/doomalay",
  "description": "Private on-device AI workspace: Go engine + Python brain + apps",
  "html_url": "https://github.com/ScoobyBaby1999/doomalay",
  "homepage": "",
  "language": "Go",
  "stargazers_count": 3,
  "forks_count": 1,
  "open_issues_count": 7,
  "topics": ["ai", "android", "go"],
  "license": {"name": "MIT License"},
  "default_branch": "main",
  "pushed_at": "2026-09-17T05:00:00Z",
  "created_at": "2026-06-01T00:00:00Z",
  "visibility": "private"
}`

func TestFormatGitHubRepo(t *testing.T) {
	var r githubRepoInfo
	if err := json.Unmarshal([]byte(githubRepoFixture), &r); err != nil {
		t.Fatal(err)
	}
	out := formatGitHubRepo(r, "")
	for _, want := range []string{
		"GitHub repository: ScoobyBaby1999/doomalay",
		"Description: Private on-device AI workspace",
		"Language: Go · Stars: 3 · Forks: 1 · Open issues: 7",
		"Topics: ai, android, go",
		"License: MIT License",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("formatted repo missing %q:\n%s", want, out)
		}
	}
	if strings.Contains(out, "Homepage:") {
		t.Errorf("empty homepage should be omitted:\n%s", out)
	}
	// subtree path note
	out2 := formatGitHubRepo(r, "tree/main/engine")
	if !strings.Contains(out2, `"tree/main/engine"`) {
		t.Errorf("extra path note missing:\n%s", out2)
	}
}

const hfSpaceFixture = `{
  "id": "ScoobyBaby1999/doomalaysocreate",
  "author": "ScoobyBaby1999",
  "description": "Create personalized content instantly online",
  "sdk": "docker",
  "likes": 1,
  "tags": ["docker", "space"],
  "lastModified": "2026-08-30T12:00:00Z",
  "runtime": {"stage": "RUNNING"}
}`

func TestFormatHFSpace(t *testing.T) {
	var r hfSpaceInfo
	if err := json.Unmarshal([]byte(hfSpaceFixture), &r); err != nil {
		t.Fatal(err)
	}
	out := formatHFSpace(r, "ScoobyBaby1999", "doomalaysocreate")
	for _, want := range []string{
		"Hugging Face Space: ScoobyBaby1999/doomalaysocreate (by ScoobyBaby1999)",
		"Description: Create personalized content instantly online",
		"URL: https://huggingface.co/spaces/ScoobyBaby1999/doomalaysocreate",
		"SDK: docker · Likes: 1 · Runtime stage: RUNNING",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("formatted space missing %q:\n%s", want, out)
		}
	}
}

func TestClampMaybe(t *testing.T) {
	s := strings.Repeat("x", 300)
	if got := clampMaybe(s, 100); len(got) != 100+len("\n…[truncated]") {
		t.Errorf("clampMaybe length = %d", len(got))
	}
	if got := clampMaybe("short", 100); got != "short" {
		t.Errorf("clampMaybe mangled short string: %q", got)
	}
	if got := clampMaybe(s, 0); len(got) != len(s) {
		t.Errorf("maxChars<=0 should mean no cap, got %d", len(got))
	}
}

// The DDG decoder must survive the ladder change untouched — it still runs
// first on every search.
func TestDecodeDDGRedirectStillWorks(t *testing.T) {
	in := "//duckduckgo.com/l/?uddg=https%3A%2F%2Fgithub.com%2Fa%2Fb&rut=xyz"
	if got := decodeDDGRedirect(in); got != "https://github.com/a/b" {
		t.Errorf("decodeDDGRedirect = %q", got)
	}
	if got := decodeDDGRedirect("//example.com/x"); got != "https://example.com/x" {
		t.Errorf("protocol-relative = %q", got)
	}
}
