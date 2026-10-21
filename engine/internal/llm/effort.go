// effort.go — the DYNAMIC per-model effort/reasoning registry (v0.42).
//
// History: v0.13 ported the Python backend's reasoning_catalog.json
// (curated, static). v0.26 added per-provider blanket defaults so the effort
// bubble always appeared. Both were LIES for most models: NVIDIA's blanket
// handed ["on","off"] to ~80 models that have no thinking knob at all, the
// curated 7-level OpenRouter ladder ignored each model's ACTUAL allowed
// values, and PrivateMode's kimi-2.6 deprecation left the PM group with ids
// the static catalog never knew — the user's "effort toggles disappeared on
// kimi 2.6 via privatemodeai" bug.
//
// v0.42 (user item #6): effort modes are now read PROGRAMMATICALLY from the
// sources that host them — no static model lists, ever:
//
//      SOURCE 1 (per provider): the provider's OWN live model surface. None of
//      the current providers expose effort data on their /v1/models listings
//      (PrivateMode's new tasks[] says WHAT a model does — generate/transcribe/
//      embed — not how its reasoning is dialed), so this is the LiveEffortInfo
//      hook the fetchers can fill; it sits at the TOP of the precedence chain
//      because a provider speaking about itself always wins.
//
//      SOURCE 2 (per model family): OpenRouter's public
//      GET /api/v1/models → per-model "reasoning" object:
//        { mandatory, default_enabled, supported_efforts[], default_effort,
//          supports_max_tokens } — plus supported_parameters[] ("reasoning_effort"
//        = the model accepts the top-level enum form). Machine-readable, keyless,
//        CORS-open, ~450 entries covering every family we route (moonshotai/*,
//        z-ai/*, nvidia/*, deepseek/*, openai/*, anthropic/*, x-ai/*, google/*).
//        Metadata belongs to the MODEL FAMILY, not the route, so a kimi-k2.6 on
//        PrivateMode or NVIDIA inherits moonshotai/kimi-k2.6's surface.
//        Matching ladder: exact id → exact last-segment → family → last-segment
//        prefix ("nvidia/nemotron-3.5-lightning-30b-a3b" ⊇ "nemotron-3.5-lightning").
//        10-minute TTL cache, stale-on-error (an offline build answers
//        honestly with no ladder — the no-static law).
//
//      v1.55.4 THE NO-STATIC LAW: SOURCE 3 (the per-provider blankets) and
//      SOURCE 4 (the curated reasoning_catalog.json) are DEAD — an unknown
//      model honestly answers "no knob" (levels []), never an invented
//      ladder. The REQUEST translation below stays: it is structural API
//      knowledge (HOW each provider spells the knob), never a model list.
//

package llm

import (
        "encoding/json"
        "sort"
        "strings"
        "sync"
        "time"
)



// ── SOURCE 2: the OpenRouter reasoning registry ────────────────────────────

// orReasoning is the per-model reasoning object from OpenRouter's public
// /api/v1/models list — THE machine-readable effort surface.
type orReasoning struct {
        Mandatory         bool     `json:"mandatory"`           // reasoning cannot be disabled — hide 'off'
        DefaultEnabled    *bool    `json:"default_enabled"`     // reasoning on unless asked off (nil = omitted → on for toggles)
        SupportedEfforts  []string `json:"supported_efforts"`   // ALLOWED effort values (omitted = toggle-only)
        DefaultEffort     string   `json:"default_effort"`      // the model's own default level
        SupportsMaxTokens bool     `json:"supports_max_tokens"` // reasoning:{max_tokens} budget accepted
}

// orModelMeta is the subset of an OpenRouter models entry the registry
// uses (benchmarks feed the family metadata / logical sorting in models_v2).
type orModelMeta struct {
        ID                  string       `json:"id"`
        ContextLength       int64        `json:"context_length"`
        SupportedParameters []string     `json:"supported_parameters"`
        Reasoning           *orReasoning `json:"reasoning"`
        Architecture        struct {
                InputModalities []string `json:"input_modalities"`
        } `json:"architecture"`
        Pricing struct {
                Prompt     string `json:"prompt"`
                Completion string `json:"completion"`
        } `json:"pricing"`
        Benchmarks struct {
                ArtificialAnalysis struct {
                        IntelligenceIndex float64 `json:"intelligence_index"`
                        CodingIndex       float64 `json:"coding_index"`
                        AgenticIndex      float64 `json:"agentic_index"`
                } `json:"artificial_analysis"`
                DesignArena []struct {
                        Category string `json:"category"`
                        Rank     int    `json:"rank"`
                } `json:"design_arena"`
        } `json:"benchmarks"`
}

// openRouterModelsURL is a package var so the unit tests can point the
// registry at an httptest server (canned payload — NO network in tests).
var openRouterModelsURL = "https://openrouter.ai/api/v1/models?output_modalities=text"

var (
        orRegMu    sync.Mutex
        orRegCache map[string]*orModelMeta // canonical id → entry (read-only after build)
        orRegAt    time.Time
)

const liveCapabilityTTL = 10 * time.Minute

// fetchOpenRouterRegistry pulls (or serves from cache) the public OpenRouter
// models list keyed by canonical id. 10-minute TTL; on fetch failure the
// stale cache is kept rather than returning nothing (the blanket fallbacks
// take over only when there has never been a successful fetch).
func fetchOpenRouterRegistry() map[string]*orModelMeta {
        orRegMu.Lock()
        defer orRegMu.Unlock()
        if orRegCache != nil && time.Since(orRegAt) < liveCapabilityTTL {
                return orRegCache
        }
        out := map[string]*orModelMeta{}
        if body, err := httpGetJSON(openRouterModelsURL, ""); err == nil {
                if parsed := parseOpenRouterModels(body); len(parsed) > 0 {
                        out = parsed
                }
        }
        if len(out) == 0 && orRegCache != nil {
                return orRegCache // stale-on-error
        }
        orRegCache, orRegAt = out, time.Now()
        return out
}

// parseOpenRouterModels is the PURE registry parser (unit-tested against a
// canned payload). Canonicalization: "~" alias ids collapse to the base id
// and ":free"/":batch" route variants collapse onto their base entry — the
// registry is keyed by the model, not the route.
func parseOpenRouterModels(body []byte) map[string]*orModelMeta {
        out := map[string]*orModelMeta{}
        if len(body) == 0 {
                return out
        }
        var resp struct {
                Data []orModelMeta `json:"data"`
        }
        if err := json.Unmarshal(body, &resp); err != nil {
                return out
        }
        for i := range resp.Data {
                m := resp.Data[i]
                if m.ID == "" {
                        continue
                }
                id := strings.TrimPrefix(m.ID, "~")
                // v0.93.1 THE :FREE SLUG TRUTH — the suffix STAYS.
                //
                // The old code stripped ":free"/":batch" here so a family
                // collapsed to one entry — right when OpenRouter hosted the
                // SAME model as both a paid base and a :free variant. That
                // world is gone (live-verified 2026-10-02): the free tier is
                // now EXCLUSIVE — `qwen/qwen3.8-27b:free` EXISTS while plain
                // `qwen/qwen3.8-27b` 404s ("No endpoints found"), and for the
                // big legacy pairs (deepseek-r1, llama-3.3-70b) the :free
                // variant was retired while the base is PAID. Stripping the
                // suffix made the app call slugs OpenRouter no longer serves —
                // the user's "most models say they are no longer available
                // for my account" + "even the free model says the quota is
                // reached" reports, both from one line.
                //
                // Keeping the true slug: the catalog's host routes carry the
                // REAL callable id; MakeFamily already strips ":free" for
                // family grouping, so X + X:free group correctly with two
                // routes (free + paid) — the user picks the free one and the
                // wire sees exactly what OpenRouter expects.
                if _, dup := out[id]; dup {
                        continue // first occurrence wins (deterministic order below)
                }
                m.ID = id
                out[id] = &m
        }
        return out
}

// matchOREntry resolves a provider's raw model id against the registry.
// Deterministic rank ladder (lower = better):
//
//      0 exact canonical id            ("moonshotai/kimi-k2.6" — the OR provider's own ids)
//      1 exact last-segment + vendor   ("moonshotai/kimi-k2.6" on NIM → "moonshotai/kimi-k2.6")
//      2 exact last-segment            ("kimi-k2.6" on PM → "moonshotai/kimi-k2.6")
//      3 exact family                  (MakeFamily on both sides)
//      4 our-segment ⊇ entry-segment   ("nemotron-3.5-lightning-30b-a3b" ⊇ "nemotron-3.5-lightning" — longest entry segment wins)
//      5 entry-segment ⊇ our-segment   (shortest entry segment wins)
//
// Steps 4/5 require ≥5 chars so tiny slugs can never prefix-match. Matching
// is case-insensitive (Together ships CamelCase ids).
func matchOREntry(reg map[string]*orModelMeta, rawModel string) *orModelMeta {
        if len(reg) == 0 || rawModel == "" {
                return nil
        }
        ours := strings.ToLower(strings.TrimSpace(rawModel))
        ourSeg := lastSegment(ours)
        ourFam := MakeFamily(ours)
        ourVendor := ""
        if i := strings.LastIndex(ours, "/"); i > 0 {
                ourVendor = ours[:i]
        }

        ids := make([]string, 0, len(reg))
        for id := range reg {
                ids = append(ids, id)
        }
        sort.Strings(ids) // deterministic iteration

        bestRank, bestLen := 99, 0
        var best *orModelMeta
        consider := func(rank, ln int, e *orModelMeta) {
                if rank < bestRank || (rank == bestRank && ln > bestLen) {
                        bestRank, bestLen, best = rank, ln, e
                }
        }
        for _, id := range ids {
                e := reg[id]
                seg := lastSegment(id)
                fam := MakeFamily(id)
                switch {
                case id == ours:
                        consider(0, len(id), e)
                case seg == ourSeg:
                        if ourVendor != "" && strings.HasPrefix(id, ourVendor+"/") {
                                consider(1, len(id), e)
                        } else {
                                consider(2, len(id), e)
                        }
                case ourFam != "" && fam == ourFam:
                        consider(3, len(id), e)
                case len(seg) >= 5 && strings.HasPrefix(ourSeg, seg):
                        consider(4, len(seg), e) // longest (most specific) prefix wins
                case len(ourSeg) >= 5 && len(seg) > len(ourSeg) && strings.HasPrefix(seg, ourSeg):
                        // Rank 5 uses ln inverted (shortest wins) — encode via a
                        // large base so a smaller ln still compares greater.
                        consider(5, 1000-len(seg), e)
                }
        }
        return best
}

// ── The resolved effort surface ────────────────────────────────────────────

// EffortSpec is the fully-resolved effort surface for one (provider, model)
// — what /api/models advertises per model and what BuildEffortBodyFor
// translates into a request body.
type EffortSpec struct {
        Levels         []string `json:"levels"`         // ordered, dynamic; [] = no knob (hide the button)
        Default        string   `json:"default"`        // the model's own default level ("" → Levels[0])
        Mandatory      bool     `json:"mandatory"`      // reasoning cannot be disabled — hide 'off'
        CanDisable     bool     `json:"canDisable"`     // an explicit disable is expressible
        SupportsBudget bool     `json:"supportsBudget"` // reasoning.max_tokens accepted (OR supports_max_tokens)
        Param          string   `json:"param"`          // shape map key: reasoning | reasoning_effort | chat_template_kwargs | effort | "" | catalog
        Source         string   `json:"source"`         // provider-live | openrouter | provider-default | catalog
}

// LiveEffortInfo is a provider's OWN live effort surface (SOURCE 1). No
// current fetcher fills it — see the header comment — but the precedence
// chain and the merge tests exercise it so a future provider surface slots
// in at the top without touching the resolution code.
type LiveEffortInfo struct {
        Levels    []string
        Default   string
        Mandatory bool
        Param     string
        // v1.55.4: the registry's budget_tokens reasoning control (Claude's
        // reasoning.max_tokens dial) — the budget knob survives the live cut.
        SupportsBudget bool
}

// ResolveEffort resolves (provider, model) → EffortSpec from the dynamic
// registry chain.
func ResolveEffort(provider, rawModel string) *EffortSpec {
        return ResolveEffortWithLive(provider, rawModel, nil)
}

// ResolveEffortWithLive is ResolveEffort with a provider-own-surface
// override at the top of the precedence chain.
func ResolveEffortWithLive(provider, rawModel string, live *LiveEffortInfo) *EffortSpec {
        spec := &EffortSpec{Levels: []string{}, CanDisable: true}

        // 1. Provider's own live surface.
        if live != nil && len(live.Levels) > 0 {
                spec.Levels = canonicalLevels(live.Levels)
                spec.Default = live.Default
                spec.Mandatory = live.Mandatory
                spec.CanDisable = !live.Mandatory
                spec.Param = live.Param
                spec.Source = "provider-live"
                return spec.withDefault()
        }

        // 1.5 v1.55.4 THE LIVE REGISTRY: models.dev's OWN reasoning_options for
        // this exact model — the live per-model truth (effort enums with the
        // exact documented values, on/off toggles, budget-token dials). This
        // covers the chat-time path and every provider the catalog merge
        // enriches; the docs-verified PM surfaces the old static table pinned
        // now ride the registry's own data (kimi → toggle, glm → low/high/max,
        // gpt-oss → low/medium/high — verified against the live doc).
        if dm := LookupDevModel(provider, rawModel); dm != nil {
                if e := devLiveEffort(dm); e != nil {
                        spec.Levels = canonicalLevels(e.Levels)
                        spec.Default = e.Default
                        spec.Mandatory = e.Mandatory
                        spec.CanDisable = !e.Mandatory
                        spec.SupportsBudget = e.SupportsBudget
                        spec.Param = effortParamFor(provider, rawModel, spec, nil)
                        spec.Source = "provider-live"
                        return spec.withDefault()
                }
        }

        // 2. OpenRouter reasoning registry (family match). A MATCHED entry is
        // authoritative even when its reasoning object is nil — "OpenRouter
        // knows this family and it has no reasoning knob" beats any blanket.
        reg := fetchOpenRouterRegistry()
        orEntry := matchOREntry(reg, rawModel)
        if orEntry != nil {
                applyORReasoning(spec, orEntry)
                spec.Levels = filterNativeLevels(provider, spec.Levels) // research-verified wire vocabulary
                // v0.69: the native filter can drop the model's OWN default
                // (PM glm-5.3: OR default "max" — the deployed PM enum is
                // the standard ladder, so "max" never survives the filter).
                // Snap the default onto the filtered ladder so the UI never
                // preselects a level the wire rejects.
                if len(spec.Levels) > 0 && spec.Default != "" && !hasString(spec.Levels, spec.Default) {
                        spec.Default = coerceLevel(provider, spec.Default, spec)
                }
                spec.Source = "openrouter"
                spec.Param = effortParamFor(provider, rawModel, spec, orEntry)
                return spec.withDefault()
        }
        // For the OpenRouter provider itself the registry IS the provider's
        // own model list: an id missing from a NON-EMPTY live list does not
        // exist — no effort knob, no curated blanket. (An EMPTY registry
        // means the fetch never succeeded — offline — and the fallbacks
        // below keep the button alive.)
        if provider == "openrouter" && len(reg) > 0 {
                return spec.withDefault()
        }

        // v1.55.4 THE NO-STATIC LAW: the per-provider blankets + the curated
        // reasoning catalog are DEAD — an unknown model honestly answers "no
        // knob" (levels []). The wire-vocab tables below stay: they are
        // PROTOCOL shapes (how a level serializes per provider), never model
        // lists.
        return spec.withDefault()
}

// applyORReasoning folds an OpenRouter reasoning object into a spec:
//   - supported_efforts present → the enum, canonically ordered, with the
//     model's default_effort;
//   - reasoning present but NO supported_efforts → toggle-only
//     (["on","off"], default on when default_enabled, off otherwise);
//   - mandatory + no enum → always-on, no knob (levels [] — the frontend
//     hides the button);
//   - reasoning nil → no reasoning at all (levels []).
func applyORReasoning(spec *EffortSpec, m *orModelMeta) {
        r := m.Reasoning
        if r == nil {
                spec.Levels = []string{}
                spec.Mandatory, spec.CanDisable, spec.SupportsBudget = false, false, false
                return
        }
        spec.Mandatory = r.Mandatory
        spec.CanDisable = !r.Mandatory
        spec.SupportsBudget = r.SupportsMaxTokens
        if len(r.SupportedEfforts) > 0 {
                spec.Levels = canonicalLevels(r.SupportedEfforts)
                spec.Default = r.DefaultEffort
                return
        }
        if r.Mandatory {
                // Always thinking, no dial — the honest answer is "no knob".
                spec.Levels = []string{}
                return
        }
        spec.Levels = []string{"on", "off"}
        // default_enabled is a POINTER: an explicit false (gemma-4-31b-it)
        // means off; an OMITTED field means the provider ships reasoning on
        // by default (live-observed: NIM nemotron streams reasoning_content
        // without any param).
        if r.DefaultEnabled != nil && !*r.DefaultEnabled {
                spec.Default = "off"
        } else {
                spec.Default = "on"
        }
}

// withDefault fills an empty Default with the most sensible level (the first
// non-"off" entry) so callers always have a concrete pick.
func (s *EffortSpec) withDefault() *EffortSpec {
        if s.Default != "" {
                return s
        }
        for _, lv := range s.Levels {
                if lv != "off" && lv != "none" {
                        s.Default = lv
                        return s
                }
        }
        if len(s.Levels) > 0 {
                s.Default = s.Levels[0]
        }
        return s
}

// DetectEffortLevels — kept for the pre-v0.42 callers; the EffortSpec
// carries everything now.
func DetectEffortLevels(provider, rawModel string) []string {
        return ResolveEffort(provider, rawModel).Levels
}

// ── The per-PROVIDER param-shape map (structural API knowledge) ───────────

// effortParamFor picks the request shape for provider+model from the
// spec + the matched OR entry. Providers not covered here (cloudflare,
// future ones) fall back to the curated-catalog translation ("catalog").
func effortParamFor(provider, rawModel string, spec *EffortSpec, orEntry *orModelMeta) string {
        if len(spec.Levels) == 0 {
                return "" // no knob — nothing to dial
        }
        enum := hasEnumLevels(spec.Levels)
        orHasRE := orEntry != nil && hasString(orEntry.SupportedParameters, "reasoning_effort")
        switch provider {
        case "openrouter":
                return "reasoning" // {effort} on enum models, {enabled:true} on toggles
        case "opencode", "opencode-zen", "opencode-go":
                // v0.26 semantics preserved: zen is OpenAI-compatible and the
                // 400-resilience + blacklist make an unverified param safe.
                return "reasoning_effort"
        case "openai", "deepseek", "groq", "together", "mistral", "xai", "perplexity", "cohere":
                if enum {
                        return "reasoning_effort"
                }
                return "" // toggle-shaped models have no OpenAI-style dial — send nothing
        case "nvidia":
                if orHasRE || enum {
                        return "reasoning_effort" // NIM canonical API (docs: snippets translate it to chat_template_kwargs)
                }
                return "chat_template_kwargs" // kimi/gemma/nemotron thinking toggles
        case "privatemodeai":
                // PM docs (research 3-c): kimi → chat_template_kwargs:{thinking};
                // glm-5.3/flash + gpt-oss → reasoning_effort. Kimi stays a toggle
                // even when the OR family carries an enum — that is the verified
                // PM surface, and the frontend SDK bridge sends the same shape.
                if isKimiFamily(rawModel) {
                        return "chat_template_kwargs"
                }
                if enum {
                        return "reasoning_effort"
                }
                return "chat_template_kwargs" // gemma-style enable_thinking toggles
        case "anthropic":
                return "effort" // Claude 4.5+; thinking:{budget_tokens} is being phased out
        case "github-models", "github":
                return "" // conservative — undocumented, a 400 blacklists the slot
        }
        return "" // v1.55.4: unlisted providers send nothing (the curated catalog is dead)
}

// isKimiFamily reports whether the model belongs to the kimi family (the
// PM thinking-toggle shape key).
func isKimiFamily(rawModel string) bool {
        s := strings.ToLower(rawModel)
        return strings.Contains(s, "kimi")
}

// hasEnumLevels reports whether the levels are an effort enum (anything
// beyond the on/off toggle vocabulary).
func hasEnumLevels(levels []string) bool {
        for _, lv := range levels {
                switch lv {
                case "", "on", "off":
                        continue
                default:
                        return true
                }
        }
        return false
}

// ctkThinkingKey picks the chat_template_kwargs boolean for a model family:
// kimi → "thinking" (NIM + PM docs), gemma/glm → "enable_thinking" (NIM
// docs), everything else → "thinking" (the nemotron-3.5 catalog note
// live-verified the thinking toggle on that family too).
func ctkThinkingKey(rawModel string) string {
        s := strings.ToLower(rawModel)
        if strings.Contains(s, "gemma") || strings.Contains(s, "glm-5.1") {
                return "enable_thinking"
        }
        return "thinking"
}

// ── Level coercion (research 3-c) ──────────────────────────────────────────

// effortLevelOrder is the canonical ladder position for sorting + coercion.
var effortLevelOrder = map[string]int{
        "none": 0, "minimal": 1, "low": 2, "medium": 3, "high": 4,
        "xhigh": 5, "max": 6, "on": 7, "off": 8,
}

// canonicalLevels dedupes + orders levels ascending along the ladder
// (unknown levels keep their relative order at the end).
func canonicalLevels(levels []string) []string {
        seen := map[string]bool{}
        var out []string
        for _, lv := range levels {
                lv = strings.ToLower(strings.TrimSpace(lv))
                if lv == "" || seen[lv] {
                        continue
                }
                seen[lv] = true
                out = append(out, lv)
        }
        sort.SliceStable(out, func(i, j int) bool {
                oi, oki := effortLevelOrder[out[i]]
                oj, okj := effortLevelOrder[out[j]]
                if oki && okj {
                        return oi < oj
                }
                if oki != okj {
                        return oki // known levels sort before unknown ones
                }
                return false
        })
        if out == nil {
                out = []string{}
        }
        return out
}

// effortCoerceMap — research 3-c compat translations for levels a model
// doesn't offer natively (DeepSeek: minimal→low, medium→high, xhigh→high;
// Claude: minimal→low, none rejected→low; PM glm: none→max is handled by the
// provider-level set below). Applied before the positional fallback.
var effortCoerceMap = map[string]string{
        "minimal": "low",
        "medium":  "high",
        "xhigh":   "high",
        "none":    "low",
        "on":      "high",
        "off":     "low",
}

// providerNativeLevels restricts a provider's wire vocabulary where research
// 3-c verified the exact native set (a level outside it never reaches that
// provider's API — it is filtered from the advertised ladder and coerced
// if a stale session still asks for it). Applied at RESOLUTION time so the
// advertised levels ARE the sendable ones.
// v0.69 (user report, live 2026-09-29): privatemodeai joins — the DEPLOYED
// validator rejects OR's glm-5.3 vocabulary ("max" → 400 literal_error,
// allowed: 'none','minimal',… the standard ladder) even though PM's own
// models page still documents low/high/max. The PM enum is the standard
// five; everything else (kimi's toggle, gpt-oss's low/medium/high) passes
// through unchanged — the filter only REMOVES non-native levels.
var providerNativeLevels = map[string]map[string]bool{
        "deepseek":      {"none": true, "low": true, "high": true, "max": true},
        "anthropic":     {"low": true, "medium": true, "high": true, "xhigh": true, "max": true},
        // v0.83.2: 'max' JOINS the PM vocabulary — the current docs make it
        // glm's default (low/high/max; none maps to max), superseding the
        // v0.69 live 400 on 'max' (the deployed surface evolved). The
        // pm-docs table bypasses this filter anyway; it stays as the OR-
        // inheritance guard for UNLISTED PM ids, and max now survives it.
        "privatemodeai": {"none": true, "minimal": true, "low": true, "medium": true, "high": true, "max": true},
}

// filterNativeLevels intersects a spec's enum levels with the provider's
// native vocabulary (toggle ladders and unknown providers pass through; a
// filter that would empty the ladder keeps the original — never hide the
// button over a vocabulary quibble).
func filterNativeLevels(provider string, levels []string) []string {
        native, ok := providerNativeLevels[provider]
        if !ok || !hasEnumLevels(levels) {
                return levels
        }
        var out []string
        for _, lv := range levels {
                if native[lv] {
                        out = append(out, lv)
                }
        }
        if len(out) == 0 {
                return levels
        }
        return out
}

// coerceLevel maps a requested level onto the model's allowed set (+
// provider-native filter). Toggle targets collapse to on/off; enum targets
// try the explicit research coercion map, then the smallest allowed level
// ABOVE the requested position, then the largest below.
func coerceLevel(provider, requested string, spec *EffortSpec) string {
        allowed := spec.Levels // already provider-native-filtered at resolution
        if hasString(allowed, requested) {
                return requested
        }
        if !hasEnumLevels(allowed) {
                // Toggle target: off-ish levels turn it off, everything else on.
                if requested == "off" || requested == "none" {
                        return "off"
                }
                return "on"
        }
        // Enum target: explicit research translation first.
        if mapped, ok := effortCoerceMap[requested]; ok && hasString(allowed, mapped) {
                return mapped
        }
        pos, known := effortLevelOrder[requested]
        if !known {
                pos = effortLevelOrder["high"] // "on"-ish unknowns sit at high
        }
        var above, below string
        for _, lv := range allowed {
                p, ok := effortLevelOrder[lv]
                if !ok {
                        continue
                }
                if p >= pos && (above == "" || p < effortLevelOrder[above]) {
                        above = lv
                }
                if p <= pos && (below == "" || p > effortLevelOrder[below]) {
                        below = lv
                }
        }
        if above != "" {
                return above
        }
        if below != "" {
                return below
        }
        return spec.Default
}

// ── Request building ───────────────────────────────────────────────────────

// BuildEffortBodyFor returns the request-body fragment dialing reasoning at
// the chosen effort level for provider/model. v0.42: consults the dynamic
// registry for the model's allowed levels + shape, coerces the level onto
// that set, and translates through the per-provider shape map. "med" is the
// session-default sentinel (unset) — it sends nothing, exactly like "".
func BuildEffortBodyFor(provider, rawModel, level string) map[string]any {
        if level == "" || level == "med" {
                return nil
        }
        spec := ResolveEffort(provider, rawModel)
        if len(spec.Levels) == 0 {
                return nil // no knob — never send a param this model rejects
        }

        if level == "off" {
                if !spec.CanDisable {
                        return nil // mandatory — never send a disable
                }
                switch spec.Param {
                case "chat_template_kwargs":
                        // Documented disable (PM + NIM kimi: "to disable reasoning
                        // extend your request with chat_template_kwargs:{thinking:false}").
                        return map[string]any{"chat_template_kwargs": map[string]any{ctkThinkingKey(rawModel): false}}
                case "reasoning_effort":
                        if hasString(spec.Levels, "none") {
                                return map[string]any{"reasoning_effort": "none"}
                        }
                        return nil // no disable enum — rely on the provider default
                }
                return nil // openrouter & friends: no documented disable shape
        }

        chosen := level
        if !hasString(spec.Levels, chosen) {
                chosen = coerceLevel(provider, level, spec)
        }
        if chosen == "" || chosen == "off" {
                return nil
        }
        // v0.26 OpenCode semantics: a toggle-only family (levels [on,off])
        // reaching an ENUM shape — zen is OpenAI-compatible and unlisted, so
        // reasoning_effort=high is the best-effort dial; the 400-resilience
        // + blacklist in chat.go make an unverified param safe. (The
        // openrouter shape uses {enabled:true} below instead; CTK shapes
        // consume the boolean directly.)
        if chosen == "on" && (spec.Param == "reasoning_effort" || spec.Param == "effort") {
                chosen = "high"
        }

        switch spec.Param {
        case "reasoning":
                if hasEnumLevels(spec.Levels) {
                        return map[string]any{"reasoning": map[string]any{"effort": chosen}}
                }
                // Toggle-only OR model: the documented form is reasoning:{enabled}.
                return map[string]any{"reasoning": map[string]any{"enabled": true}}
        case "reasoning_effort":
                return map[string]any{"reasoning_effort": chosen}
        case "effort":
                return map[string]any{"effort": chosen}
        case "chat_template_kwargs":
                key := ctkThinkingKey(rawModel) // kimi/nemotron → thinking, gemma/glm-5.1 → enable_thinking
                return map[string]any{"chat_template_kwargs": map[string]any{key: chosen != "off" && chosen != "none"}}
        case "":
                return nil // conservative providers (github-models, toggle on OpenAI-style)
        }
        // v1.55.4: the curated catalog body translation is dead (no static
        // lists); unlisted providers conservatively send nothing — the
        // 400-resilience + blacklist stay as the belt.
        return nil
}

// hasString is a tiny case-insensitive-free membership test (levels are
// canonicalized to lowercase before reaching here).
func hasString(list []string, want string) bool {
        for _, v := range list {
                if v == want {
                        return true
                }
        }
        return false
}

// ── Native web search (unchanged v0.13 surface) ────────────────────────────

// supportsNativeWebSearch answers the STRUCTURAL law (v1.55.4: the curated
// web_search section of the old reasoning catalog is dead — its per-model
// entries were legacy copies of the same structural truth): OpenRouter is
// the one provider with a NATIVE chat-completions web plugin; everyone
// else answers false and the turn rides the client-side web_tools loop.
func supportsNativeWebSearch(provider, rawModel string) (bool, map[string]any) {
	if provider != "openrouter" {
		return false, nil
	}
	return true, map[string]any{"plugins": []any{map[string]any{"id": "web"}}}
}

func NativeWebSearchBody(provider, rawModel string) map[string]any {
        if provider != "openrouter" {
                return nil // only OpenRouter has a native plugin (verified)
        }
        if openRouterFreeTierModel(rawModel) {
                return nil // paid plugin on a free model → the free tool loop instead
        }
        native, body := supportsNativeWebSearch(provider, rawModel)
        if !native {
                // OpenRouter default: the native web plugin.
                return map[string]any{"plugins": []any{map[string]any{"id": "web"}}}
        }
        if body == nil {
                return map[string]any{"plugins": []any{map[string]any{"id": "web"}}}
        }
        return body
}

// openRouterFreeTierModel reports whether the OpenRouter model id is
// free-tier: a `:free` suffix, the free router itself, or an exact
// zero-priced registry entry (the lyria/stealth preview class). EXACT
// lookup only — the fuzzy family matcher could misread a paid pick as its
// :free sibling and strip a paying user's native search.
func openRouterFreeTierModel(rawModel string) bool {
        m := strings.TrimSpace(rawModel)
        if m == "openrouter/free" || strings.HasSuffix(m, ":free") {
                return true
        }
        if e := fetchOpenRouterRegistry()[m]; e != nil {
                return parsePrice(e.Pricing.Prompt) == 0 && parsePrice(e.Pricing.Completion) == 0
        }
        return false
}

// lastSegment returns the text after the final "/" (or the whole string).
func lastSegment(id string) string {
        if i := strings.LastIndex(id, "/"); i >= 0 {
                return id[i+1:]
        }
        return id
}
