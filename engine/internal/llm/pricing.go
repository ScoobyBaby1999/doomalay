// pricing.go — v0.20 the COST TRACKER (ported from the HF space's
// pricing.py concept: per-model $/M-token rates applied to real usage).
//
// The engine already receives exact token usage from every provider's
// final SSE chunk (chunk.usage) and persists it inside status events.
// v1.55.4 THE NO-STATIC LAW: this module turns those tokens into money
// through the LIVE models.dev registry ONLY (the curated family-pattern
// rate table is DEAD — "no static lists, not even fallback"); a model the
// registry doesn't know is honestly "unpriced": tokens without an
// invented dollar figure.
//
// NOTE ON NVIDIA NIM: the developer tier the app targets is FREE —
// the $ figures are list prices, shown for awareness, not billing.
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
        // v1.55.4 THE NO-STATIC LAW: the curated price rules are DEAD — an
        // unknown model is honestly unpriced (the live registry is the only
        // source; callers show tokens but no invented dollar figure).
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

// ContextLimitFor returns the context window for a model slot. v1.55.4
// THE NO-STATIC LAW: the curated ctxRules table is DEAD — the LIVE
// registry is the only per-model source; an unknown model answers the
// conservative 65536 floor (a safety constant, never a list — auto-compact
// then triggers early, which is safe on every window size).
func ContextLimitFor(modelSlot string) int {
        if ctx, ok := SpecContext(modelSlot); ok {
                return ctx
        }
        return 65536 // conservative floor
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
