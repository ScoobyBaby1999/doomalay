// pricing.go — v0.20 the COST TRACKER (ported from the HF space's
// pricing.py concept: per-model $/M-token rates applied to real usage).
//
// The engine already receives exact token usage from every provider's
// final SSE chunk (chunk.usage) and persists it inside status events.
// This module turns those tokens into money: a curated rate table for
// the providers the app ships with, family-pattern matching (any
// "nemotron-*" model matches the nemotron rate), and a conservative
// "unpriced" fallback that shows tokens without inventing a dollar
// figure.
//
// NOTE ON NVIDIA NIM: the developer tier the app targets is FREE —
// the $ figures are list prices, shown for awareness, not billing.
// PrivateMode AI prices are their published per-token rates.
package llm

import (
        "strings"
)

// Price is a per-model rate in USD per 1M tokens.
type Price struct {
        InputPerM  float64
        OutputPerM float64
        Free       bool   // the user's tier pays $0 (NVIDIA dev tier)
        Source     string // where the number came from
}

// priceRules — ordered: FIRST matching rule wins (substring on the
// lowercased model id, so "nvidia/nvidia/nemotron-3.5-lightning" hits
// the nemotron rule).
var priceRules = []struct {
        pattern string
        price   Price
}{
        // NVIDIA NIM models (list prices; the developer tier is free)
        {"nemotron-3.5-lightning", Price{0.10, 0.40, true, "NVIDIA list (dev tier free)"}},
        {"nemotron-3-super", Price{0.60, 1.80, true, "NVIDIA list (dev tier free)"}},
        {"nemotron-3-ultra", Price{2.40, 9.00, true, "NVIDIA list (dev tier free)"}},
        {"nemotron", Price{0.60, 1.80, true, "NVIDIA list (dev tier free)"}},
        {"llama-3.1-nemotron", Price{0.60, 1.80, true, "NVIDIA list (dev tier free)"}},
        {"kimi-k2", Price{0.60, 2.50, false, "Moonshot list"}},
        {"kimi-k3", Price{0.60, 2.50, false, "Moonshot list"}},
        {"deepseek", Price{0.27, 1.10, false, "DeepSeek list"}},
        {"gpt-oss-120b", Price{0.10, 0.50, false, "OpenAI open-weights list"}},
        {"glm-5", Price{0.50, 2.00, false, "Zhipu list"}},
        {"glm", Price{0.50, 2.00, false, "Zhipu list"}},
        {"qwen", Price{0.40, 1.20, false, "Alibaba list"}},
        {"llama", Price{0.35, 0.90, false, "Meta-hosted list"}},
        {"mistral", Price{0.50, 1.50, false, "Mistral list"}},
        {"mixtral", Price{0.50, 1.50, false, "Mistral list"}},
        {"gpt-4o-mini", Price{0.15, 0.60, false, "OpenAI list"}},
        {"gpt-4o", Price{2.50, 10.00, false, "OpenAI list"}},
        {"gpt-4.1", Price{2.00, 8.00, false, "OpenAI list"}},
        {"o4-mini", Price{1.10, 4.40, false, "OpenAI list"}},
        {"claude", Price{3.00, 15.00, false, "Anthropic list"}},
        {"gemini-2.5-flash", Price{0.30, 2.50, false, "Google list"}},
        {"gemini", Price{1.25, 5.00, false, "Google list"}},
}

var priceCache = map[string]Price{}

// LookupPrice returns the rate for a model slot (provider-prefixed or
// bare). Unknown models get Free=false with zero rates + Source
// "unpriced" — callers show tokens but no invented dollar figure.
func LookupPrice(modelSlot string) Price {
        m := strings.ToLower(strings.TrimSpace(modelSlot))
        if m == "" {
                return Price{Source: "unpriced"}
        }
        if p, ok := priceCache[m]; ok {
                return p
        }
        var out Price
        for _, r := range priceRules {
                if strings.Contains(m, r.pattern) {
                        out = r.price
                        break
                }
        }
        if out.Source == "" {
                out = Price{Source: "unpriced"}
        }
        priceCache[m] = out
        return out
}

// CostFor computes the USD cost of a turn.
// Returns (cost, priced) — priced=false when the model has no rate.
func CostFor(modelSlot string, inputTokens, outputTokens int) (float64, bool) {
        p := LookupPrice(modelSlot)
        if p.Source == "unpriced" {
                return 0, false
        }
        return float64(inputTokens)/1_000_000*p.InputPerM + float64(outputTokens)/1_000_000*p.OutputPerM, true
}

// ContextLimitFor estimates a model's context window (tokens) from its
// slot — used by the auto-compact trigger. Conservative defaults.
var ctxRules = []struct {
        pattern string
        limit   int
}{
        {"lightning-30b", 131072},
        {"nemotron-3-super", 131072},
        {"nemotron-3-ultra", 131072},
        {"nemotron", 131072},
        {"kimi-k2", 262144},
        {"kimi-k3", 262144},
        {"glm-5", 131072},
        {"gpt-oss-120b", 131072},
        {"deepseek", 131072},
        {"llama-3", 131072},
        {"gpt-4o", 128000},
        {"gemini", 1000000},
        {"claude", 200000},
}

// ContextLimitFor returns the estimated context window for a model slot.
func ContextLimitFor(modelSlot string) int {
        m := strings.ToLower(strings.TrimSpace(modelSlot))
        for _, r := range ctxRules {
                if strings.Contains(m, r.pattern) {
                        return r.limit
                }
        }
        return 65536 // conservative default
}

// EstimateTokens approximates the token count of a text (≈ chars/3.8 for
// English + code; good enough for compact triggers, never for billing).
func EstimateTokens(s string) int {
        return EstimateTokensN(len(s))
}

// EstimateTokensN is EstimateTokens over a known byte count.
func EstimateTokensN(n int) int {
        if n == 0 {
                return 0
        }
        return n*10/38 + 1
}
