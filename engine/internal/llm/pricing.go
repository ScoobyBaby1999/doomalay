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
        "sync"
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
var priceCacheMu sync.RWMutex

// LookupPrice returns the rate for a model slot (provider-prefixed or
// bare). v1.14.1 THE LEDGER: the models.dev snapshot is the PRIMARY source
// (verified per-model rates); the curated rules below are the FALLBACK for
// models the snapshot doesn't know (opencode/privatemodeai publish nothing
// to models.dev). Unknown models get Free=false with zero rates + Source
// "unpriced" — callers show tokens but no invented dollar figure.
func LookupPrice(modelSlot string) Price {
        m := strings.ToLower(strings.TrimSpace(modelSlot))
        if m == "" {
                return Price{Source: "unpriced"}
        }
        priceCacheMu.RLock()
        p, ok := priceCache[m]
        priceCacheMu.RUnlock()
        if ok {
                return p
        }
        var out Price
        if in, o, ok := SpecPrice(modelSlot); ok {
                out = Price{InputPerM: in, OutputPerM: o, Source: "models.dev"}
        }
        if out.Source == "" {
                for _, r := range priceRules {
                        if strings.Contains(m, r.pattern) {
                                out = r.price
                                break
                        }
                }
        }
        if out.Source == "" {
                out = Price{Source: "unpriced"}
        }
        priceCacheMu.Lock()
        priceCache[m] = out
        priceCacheMu.Unlock()
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

// ContextLimitFor returns the context window for a model slot. v1.14.1:
// the models.dev snapshot is the PRIMARY source (a real documented window
// beats every guess); the curated ctxRules are the FALLBACK, and the
// 65536 default is the last resort. The auto-compact trigger and the
// context ring both consume this — they inherit the accuracy for free.
func ContextLimitFor(modelSlot string) int {
        if ctx, ok := SpecContext(modelSlot); ok {
                return ctx
        }
        m := strings.ToLower(strings.TrimSpace(modelSlot))
        for _, r := range ctxRules {
                if strings.Contains(m, r.pattern) {
                        return r.limit
                }
        }
        return 65536 // conservative default
}

// EstimateTokens approximates the token count of a text. v1.14.1 THE
// LEDGER: a REAL cl100k_base BPE count (embedded, offline) replaced the
// chars/3.8 guess — code, CJK, and punctuation-dense text were counted
// wrong by up to 2x. CountTokens degrades to the heuristic if the BPE
// ever fails to load.
func EstimateTokens(s string) int {
        return CountTokens(s)
}

// EstimateTokensN is the byte-count form — used where only a SIZE exists
// (usage.go's char tallies over stored events), so no BPE run is possible.
// Stays heuristic by nature (≈ chars/3.8 for English + code).
func EstimateTokensN(n int) int {
        if n == 0 {
                return 0
        }
        return n*10/38 + 1
}
