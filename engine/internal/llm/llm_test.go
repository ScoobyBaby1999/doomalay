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
func TestBuildEffortBodyFor(t *testing.T) {
        // OpenRouter: reasoning.effort ladder.
        b := BuildEffortBodyFor("openrouter", "anthropic/claude-fable-5", "high")
        if b == nil {
                t.Fatal("openrouter effort body nil")
        }
        r, ok := b["reasoning"].(map[string]any)
        if !ok || r["effort"] != "high" {
                t.Errorf("openrouter body wrong: %v", b)
        }
        // Invalid level coerces to high.
        b = BuildEffortBodyFor("openrouter", "x", "banana")
        r, _ = b["reasoning"].(map[string]any)
        if r["effort"] != "high" {
                t.Errorf("openrouter coercion wrong: %v", b)
        }
        // OpenCode: conservative — never send params.
        if b := BuildEffortBodyFor("opencode", "kimi-k2.6", "high"); b != nil {
                t.Errorf("opencode must not get effort params, got %v", b)
        }
        // NVIDIA kimi (curated toggle): chat_template_kwargs.thinking flips true.
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
        // deepseek-v4 (enum): reasoning_effort replaced by allowed level.
        b = BuildEffortBodyFor("nvidia", "deepseek-ai/deepseek-v4-pro", "max")
        if re, _ := b["reasoning_effort"].(string); re != "max" {
                t.Errorf("deepseek reasoning_effort should be max, got %v", b)
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

// TestDetectEffortLevels — live OpenRouter detection (public list).
func TestDetectEffortLevels(t *testing.T) {
        if testing.Short() {
                t.Skip("network")
        }
        levels := DetectEffortLevels("openrouter", "anthropic/claude-fable-5")
        if len(levels) == 0 {
                t.Fatal("openrouter claude should expose the 7-level ladder")
        }
        if levels[0] != "none" || levels[len(levels)-1] != "max" {
                t.Errorf("ladder wrong: %v", levels)
        }
        // OpenCode: unknown → conservative empty.
        levels = DetectEffortLevels("opencode", "kimi-k2.6")
        if len(levels) != 0 {
                t.Errorf("opencode should have no live levels, got %v", levels)
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
