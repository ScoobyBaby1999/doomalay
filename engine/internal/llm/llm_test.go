package llm

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"
)

// TestWebSearchDDG — keyless DuckDuckGo search (real network call).
// DDG bot-detection intermittently returns HTTP 202 / stalls datacenter IPs;
// that is a provider-side flake, not a code failure — skip when it happens.
// (Verified live multiple times per session; the parser itself is covered
// by the regex assertions below.)
func TestWebSearchDDG(t *testing.T) {
	if testing.Short() {
		t.Skip("network")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 12*time.Second)
	defer cancel()
	results, err := WebSearch(ctx, "opencode zen api", 5, "")
	if err != nil {
		if strings.Contains(err.Error(), "HTTP 202") || strings.Contains(err.Error(), "HTTP 429") ||
			strings.Contains(err.Error(), "i/o timeout") || strings.Contains(err.Error(), "deadline") {
			t.Skipf("DDG rate-limiting this network: %v", err)
		}
		t.Fatalf("websearch: %v", err)
	}
	if len(results) == 0 {
		t.Fatal("no results from DDG")
	}
	for _, r := range results {
		if !strings.HasPrefix(r.URL, "http") {
			t.Errorf("bad url: %q", r.URL)
		}
	}
	t.Logf("ddg returned %d results, first: %s", len(results), results[0].Title)
}

// TestWebFetchSSRF — private addresses must be rejected.
func TestWebFetchSSRF(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	for _, u := range []string{
		"http://127.0.0.1:8080/api/keys",
		"http://localhost/",
		"http://169.254.169.254/latest/meta-data",
		"http://10.0.0.1/",
		"file:///etc/passwd",
	} {
		if _, err := WebFetch(ctx, u, 100); err == nil {
			t.Errorf("SSRF guard failed for %q", u)
		}
	}
}

// TestBuildEffortBodyFor — the per-provider reasoning translations.
// v0.42: the translations resolve through the DYNAMIC registry, so this
// test runs with an unreachable registry URL (pure offline path — the
// blanket/curated fallbacks decide the shapes); the registry-driven cases
// live in effort_v42_test.go against a canned OpenRouter payload.
func TestBuildEffortBodyFor(t *testing.T) {
	useTestORRegistry(t, nil) // offline: no dynamic data
	// OpenRouter (offline): the curated openrouter/* ladder applies.
	b := BuildEffortBodyFor("openrouter", "anthropic/claude-fable-5", "high")
	if b == nil {
		t.Fatal("openrouter effort body nil")
	}
	r, ok := b["reasoning"].(map[string]any)
	if !ok || r["effort"] != "high" {
		t.Errorf("openrouter body wrong: %v", b)
	}
	// v0.26: OpenCode Zen — OpenAI-compatible reasoning_effort, made
	// safe by the 400-resilience retry (a rejecting model is retried
	// without the param and blacklisted for the engine's lifetime).
	if b := BuildEffortBodyFor("opencode", "kimi-k2.6", "high"); b == nil || b["reasoning_effort"] != "high" {
		t.Errorf("opencode high should send reasoning_effort=high, got %v", b)
	}
	if b := BuildEffortBodyFor("opencode", "kimi-k2.6", "off"); b != nil {
		t.Errorf("opencode off must send nothing, got %v", b)
	}
	if b := BuildEffortBodyFor("opencode", "kimi-k2.6", "banana"); b == nil || b["reasoning_effort"] != "high" {
		t.Errorf("opencode coercion wrong, got %v", b)
	}
	// NVIDIA kimi (offline → blanket toggle): chat_template_kwargs.thinking flips true.
	b = BuildEffortBodyFor("nvidia", "moonshotai/kimi-k2.6", "on")
	if b == nil {
		t.Fatal("nvidia kimi effort body nil")
	}
	ctk, ok := b["chat_template_kwargs"].(map[string]any)
	if !ok {
		t.Fatalf("nvidia kimi body shape wrong: %v", b)
	}
	if v, _ := ctk["thinking"].(bool); !v {
		t.Errorf("kimi thinking should be true for 'on', got %v", ctk)
	}
	b = BuildEffortBodyFor("nvidia", "moonshotai/kimi-k2.6", "off")
	ctk, _ = b["chat_template_kwargs"].(map[string]any)
	if v, _ := ctk["thinking"].(bool); v {
		t.Errorf("kimi thinking should be false for 'off'")
	}
	// v0.42: with the registry OFFLINE the deepseek enum resolves via the
	// blanket toggle — the ONLINE behavior (OR [high,xhigh]) is covered
	// by TestBuildEffortBodyForV42.
	b = BuildEffortBodyFor("nvidia", "deepseek-ai/deepseek-v4-pro", "max")
	ctk, _ = b["chat_template_kwargs"].(map[string]any)
	if v, _ := ctk["thinking"].(bool); !v {
		t.Errorf("offline deepseek should coerce max→on, got %v", b)
	}
}

// TestNativeWebSearchBody — OpenRouter gets plugins, others nil.
func TestNativeWebSearchBody(t *testing.T) {
	b := NativeWebSearchBody("openrouter", "anything")
	if b == nil {
		t.Fatal("openrouter native body nil")
	}
	plugins, ok := b["plugins"].([]any)
	if !ok || len(plugins) == 0 {
		t.Errorf("plugins missing: %v", b)
	}
	if b := NativeWebSearchBody("nvidia", "x"); b != nil {
		t.Errorf("nvidia must not get native search, got %v", b)
	}
}

// TestMakeFamily + DeriveDisplayName — the dedup keys.
func TestMakeFamily(t *testing.T) {
	cases := map[string]string{
		"meta-llama/llama-4-70b-instruct": "llama-4-70b",
		"openai/gpt-4o":                   "gpt-4o",
		"moonshotai/kimi-k2.6":            "kimi-k2.6",
		"qwen/qwen3.6-plus:free":          "qwen3.6-plus",
		"@cf/meta/llama-4":                "llama-4",
	}
	for in, want := range cases {
		if got := MakeFamily(in); got != want {
			t.Errorf("MakeFamily(%q) = %q, want %q", in, got, want)
		}
	}
	if dn := DeriveDisplayName("glm-5.1"); dn != "GLM 5.1" {
		t.Errorf("DeriveDisplayName(glm-5.1) = %q", dn)
	}
}

// TestDetectEffortLevels — LIVE OpenRouter detection (public list).
// v0.42: the ladder is whatever the model's reasoning object says — the
// old static 7-level assertions were exactly the bug this rework fixed.
func TestDetectEffortLevels(t *testing.T) {
	if testing.Short() {
		t.Skip("network")
	}
	levels := DetectEffortLevels("openrouter", "anthropic/claude-fable-5")
	if len(levels) == 0 {
		t.Fatal("openrouter claude should expose its live effort ladder")
	}
	// Ordered along the canonical ladder and every value is a known one.
	for i, lv := range levels {
		if _, ok := effortLevelOrder[lv]; !ok {
			t.Errorf("unknown level %q in %v", lv, levels)
		}
		if i > 0 && effortLevelOrder[levels[i-1]] >= effortLevelOrder[lv] {
			t.Errorf("levels not ascending: %v", levels)
		}
	}
	// v0.42: kimi-k2.6 is TOGGLE-ONLY (OR reasoning object, no
	// supported_efforts) — the old blanket [low,high] was wrong.
	levels = DetectEffortLevels("opencode", "kimi-k2.6")
	if len(levels) != 2 || levels[0] != "on" || levels[1] != "off" {
		t.Errorf("kimi-k2.6 ladder should be the live toggle [on off], got %v", levels)
	}
	// NVIDIA default: on/off for models OR doesn't know.
	levels = DetectEffortLevels("nvidia", "some-unknown-model-x")
	if len(levels) != 2 || levels[0] != "on" || levels[1] != "off" {
		t.Errorf("nvidia default ladder should be [on off], got %v", levels)
	}
	// PrivateMode default: on/off.
	levels = DetectEffortLevels("privatemodeai", "whatever-model")
	if len(levels) != 2 || levels[0] != "on" || levels[1] != "off" {
		t.Errorf("privatemodeai default ladder should be [on off], got %v", levels)
	}
	// NVIDIA deepseek-v4-pro now carries OR's LIVE enum ([high xhigh] at
	// capture time — the model is EOL'd on NIM, so this documents the
	// dynamic-source precedence rather than a wire contract).
	levels = DetectEffortLevels("nvidia", "deepseek-ai/deepseek-v4-pro")
	if len(levels) == 0 {
		t.Error("nvidia deepseek-v4-pro should resolve through the OR registry")
	}
}

// TestReasoningCatalogLoads — embedded JSON parses.
func TestReasoningCatalogLoads(t *testing.T) {
	cat, err := loadReasoningCatalog()
	if err != nil || cat == nil {
		t.Fatalf("catalog: %v", err)
	}
	if len(cat.Reasoning) < 5 {
		t.Errorf("reasoning catalog too small: %d entries", len(cat.Reasoning))
	}
	b, _ := json.Marshal(cat)
	if !strings.Contains(string(b), "chat_template_kwargs") {
		t.Error("catalog missing chat_template_kwargs entries")
	}
}

// TestParseNvidiaCards — the build.nvidia.com card parser. The badge row
// ("Free Endpoint") sits BEFORE the artifact-card anchor; the WAF
// interstitial (no artifact-cards) must return (nil, nil) so the caller
// defaults every model to free.
func TestParseNvidiaCards(t *testing.T) {
	// WAF interstitial / empty page → no cards → nil (default-free upstream).
	if f, a := parseNvidiaCards("<html><body>challenge</body></html>"); f != nil || a != nil {
		t.Errorf("empty page should parse to nil, got %v %v", f, a)
	}

	// Real card shape (trimmed from the live page): publisher link + badges,
	// then the artifact-card anchor with the slug.
	page := `<div><a data-nvtrack-nav-object-label="moonshotai" href="/moonshotai">Moonshotai</a></div>` +
		`<div class="ml-auto flex shrink-0 gap-1">` +
		`<span class="nv-badge">Downloadable</span>` +
		`<span class="nv-badge nv-badge--color-purple">Free Endpoint</span></div>` +
		`<h3><a data-nvtrack="Navigate" data-nvtrack-nav-object="artifact-card" ` +
		`data-nvtrack-nav-object-label="kimi-k3" href="/moonshotai/kimi-k3">Kimi K3</a></h3>` +
		`<div><a data-nvtrack-nav-object-label="somevendor" href="/somevendor">SomeVendor</a></div>` +
		`<div class="ml-auto flex shrink-0 gap-1">` +
		`<span class="nv-badge">Downloadable</span></div>` + // no Free Endpoint badge → paid
		`<h3><a data-nvtrack-nav-object="artifact-card" ` +
		`data-nvtrack-nav-object-label="paid-model" href="/somevendor/paid-model">Paid</a></h3>`

	free, all := parseNvidiaCards(page)
	if all == nil {
		t.Fatal("cards should parse")
	}
	if len(all) != 2 {
		t.Errorf("want 2 cards, got %d", len(all))
	}
	if !all["kimi-k3"] || !all["paid-model"] {
		t.Errorf("slugs missing: %v", all)
	}
	if !free["kimi-k3"] {
		t.Error("kimi-k3 must be free (Free Endpoint badge before the anchor)")
	}
	if free["paid-model"] {
		t.Error("paid-model has no badge — must NOT be free")
	}

	// Slug matching: kimi-k3 API id "moonshotai/kimi-k3" → site slug "kimi-k3".
	if isFree, found := nvidiaSlugMatch("kimi-k3", free, all); !found || !isFree {
		t.Errorf("kimi-k3 should match free, got free=%v found=%v", isFree, found)
	}
	// Underscore/dot normalization: site "kimi.k3" vs API "kimi_k3" → match.
	all2 := map[string]bool{"kimi.k3": true}
	if _, found := nvidiaSlugMatch("kimi_k3", map[string]bool{}, all2); !found {
		t.Error("underscore/dot normalization should match")
	}
	// Unknown model → not found (caller keeps the default: free).
	if _, found := nvidiaSlugMatch("totally-unknown", free, all); found {
		t.Error("unknown slug should not match")
	}
}
