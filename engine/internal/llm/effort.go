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
//        10-minute TTL cache, stale-on-error (an offline build degrades to the
//        blanket fallbacks instead of losing the effort button).
//
//      SOURCE 3 (never-blank blanket): providerDefaultLevels — per-provider
//      conservative ladders, ONLY for models OpenRouter doesn't know at all.
//
//      SOURCE 4 (last resort): the curated reasoning_catalog.json — demoted
//      from v0.13's primary spot to the final fallback (its VERIFIED request
//      bodies still drive the translation for providers outside the shape map,
//      e.g. Cloudflare).
//
// The REQUEST translation is a small per-PROVIDER param-shape map. This is
// structural API knowledge (HOW each provider spells the knob), NOT model
// data — the only static thing left, by design:
//
//      openrouter                     → reasoning:{effort} (enum models) /
//                                       reasoning:{enabled:true} (toggle models)
//      openai / deepseek / groq /     → top-level reasoning_effort
//      together / mistral / xai-style
//      nvidia                         → per model: reasoning_effort when the OR
//                                       family exposes it, else
//                                       chat_template_kwargs:{thinking|enable_thinking}
//      privatemodeai                  → kimi family: chat_template_kwargs:{thinking:bool};
//                                       glm/gpt-oss family: reasoning_effort
//      anthropic                      → top-level effort (Claude 4.5+; the
//                                       thinking:{budget_tokens} form is being
//                                       phased out per research 3-c)
//      github-models                  → never send (undocumented; a 400
//                                       blacklists the slot)
//      cloudflare / unlisted          → curated-catalog body translation
//
// Values pass through a coercion map (research 3-c: minimal→low, medium→high,
// xhigh→high, none→low) plus a nearest-ladder fallback, so a level the model
// doesn't offer never reaches the wire. The v0.26 400-retry-without-param +
// engine-lifetime blacklist in chat.go stays as the safety net for anything
// the dynamic data still gets wrong.

package llm

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"
)

//go:embed catalog/reasoning_catalog.json
var reasoningCatalogJSON []byte

// reasoningCatalog is the parsed curated catalog.
type reasoningCatalog struct {
	Reasoning map[string]reasoningEntry `json:"reasoning"`
	WebSearch map[string]webSearchEntry `json:"web_search"`
}

type reasoningEntry struct {
	Body         json.RawMessage `json:"body"`
	EffortLevels []string        `json:"effort_levels"`
	Note         string          `json:"note"`
}

type webSearchEntry struct {
	Native bool            `json:"native"`
	Body   json.RawMessage `json:"body"`
}

var (
	reasoningOnce sync.Once
	reasoningCur  *reasoningCatalog
	reasoningErr  error
)

// loadReasoningCatalog parses the embedded JSON. Comment keys ("//", "//1",
// …) carry STRING values that fail strict unmarshaling into entry structs —
// parse each section as a raw map and keep only entries that decode cleanly.
func loadReasoningCatalog() (*reasoningCatalog, error) {
	reasoningOnce.Do(func() {
		c := reasoningCatalog{
			Reasoning: map[string]reasoningEntry{},
			WebSearch: map[string]webSearchEntry{},
		}
		var raw struct {
			Reasoning map[string]json.RawMessage `json:"reasoning"`
			WebSearch map[string]json.RawMessage `json:"web_search"`
		}
		if err := json.Unmarshal(reasoningCatalogJSON, &raw); err != nil {
			reasoningErr = fmt.Errorf("parse reasoning_catalog: %w", err)
			return
		}
		for k, v := range raw.Reasoning {
			var e reasoningEntry
			if err := json.Unmarshal(v, &e); err != nil {
				continue // comment key or unknown shape — skip
			}
			c.Reasoning[k] = e
		}
		for k, v := range raw.WebSearch {
			var e webSearchEntry
			if err := json.Unmarshal(v, &e); err != nil {
				continue
			}
			// Entries with only a "note" (no native flag) are comments' kin —
			// keep them; the flag defaults false which is the safe direction.
			c.WebSearch[k] = e
		}
		reasoningCur = &c
	})
	return reasoningCur, reasoningErr
}

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
		// Strip ":free"/":batch" — only when the ':' sits in the MODEL
		// segment (after the last '/'), so vendor slugs survive.
		if seg := id[strings.LastIndexByte(id, '/')+1:]; strings.Contains(seg, ":") {
			id = id[:len(id)-(len(seg)-strings.IndexByte(seg, ':'))]
		}
		if _, dup := out[id]; dup {
			continue // first occurrence wins (base before variants)
		}
		m.ID = id
		out[id] = &m
	}
	return out
}

// matchOREntry resolves a provider's raw model id against the registry.
// Deterministic rank ladder (lower = better):
//
//	0 exact canonical id            ("moonshotai/kimi-k2.6" — the OR provider's own ids)
//	1 exact last-segment + vendor   ("moonshotai/kimi-k2.6" on NIM → "moonshotai/kimi-k2.6")
//	2 exact last-segment            ("kimi-k2.6" on PM → "moonshotai/kimi-k2.6")
//	3 exact family                  (MakeFamily on both sides)
//	4 our-segment ⊇ entry-segment   ("nemotron-3.5-lightning-30b-a3b" ⊇ "nemotron-3.5-lightning" — longest entry segment wins)
//	5 entry-segment ⊇ our-segment   (shortest entry segment wins)
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

	// 2. OpenRouter reasoning registry (family match). A MATCHED entry is
	// authoritative even when its reasoning object is nil — "OpenRouter
	// knows this family and it has no reasoning knob" beats any blanket.
	reg := fetchOpenRouterRegistry()
	orEntry := matchOREntry(reg, rawModel)
	if orEntry != nil {
		applyORReasoning(spec, orEntry)
		spec.Levels = filterNativeLevels(provider, spec.Levels) // research-verified wire vocabulary
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

	// 3. Provider default blanket — only for models OR doesn't know.
	if levels, ok := providerDefaultLevels[provider]; ok {
		spec.Levels = append([]string{}, levels...)
		spec.Default = providerDefaultEffort[provider]
		spec.CanDisable = true
		spec.Param = effortParamFor(provider, rawModel, spec, nil)
		spec.Source = "provider-default"
		return spec.withDefault()
	}

	// 4. Curated catalog — the last resort.
	if entry, ok := resolveReasoningEntry(provider, rawModel); ok && len(entry.EffortLevels) > 0 {
		spec.Levels = canonicalLevels(entry.EffortLevels)
		spec.CanDisable = true
		spec.Param = "catalog"
		spec.Source = "catalog"
		return spec.withDefault()
	}
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

// providerDefaultLevels — SOURCE 3: the never-blank blanket, v0.42 semantics
// (ONLY for models the OpenRouter registry doesn't know — it used to cover
// every model on these providers, which is exactly the "wrong for most
// models" complaint). A wrong param is still safe: chat.go's 400-resilience
// retries without it and blacklists the (provider, model) pair.
var providerDefaultLevels = map[string][]string{
	"nvidia":        {"on", "off"},
	"privatemodeai": {"on", "off"},
	"opencode":      {"low", "high"},
	"opencode-zen":  {"low", "high"},
	"opencode-go":   {"low", "high"},
	"cloudflare":    {"on", "off"},
}

// providerDefaultEffort is the blanket's default level per provider.
var providerDefaultEffort = map[string]string{
	"nvidia":        "on",
	"privatemodeai": "on",
	"opencode":      "high",
	"opencode-zen":  "high",
	"opencode-go":   "high",
	"cloudflare":    "on",
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
	return "catalog"
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
var providerNativeLevels = map[string]map[string]bool{
	"deepseek":  {"none": true, "low": true, "high": true, "max": true},
	"anthropic": {"low": true, "medium": true, "high": true, "xhigh": true, "max": true},
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
	// "catalog" — Cloudflare + unlisted providers keep the v0.13 curated
	// body translation (verified shapes: CTK toggle flip / enum replace /
	// reasoning.enabled swap).
	return catalogEffortBody(provider, rawModel, level)
}

// catalogEffortBody is the v0.13 curated-catalog translation, unchanged —
// the fallback for providers outside the shape map.
func catalogEffortBody(provider, rawModel, level string) map[string]any {
	entry, ok := resolveReasoningEntry(provider, rawModel)
	if !ok || !entry.hasBody() {
		return nil
	}
	var body map[string]any
	if err := json.Unmarshal(entry.Body, &body); err != nil {
		return nil
	}
	// (a) toggle models — flip the first boolean inside chat_template_kwargs.
	if ctk, isMap := body["chat_template_kwargs"].(map[string]any); isMap {
		for k, v := range ctk {
			if _, isBool := v.(bool); isBool {
				ctk[k] = level != "off"
				break
			}
		}
		return body
	}
	// (b) enum models — replace reasoning_effort with the level when allowed.
	if _, hasRE := body["reasoning_effort"]; hasRE {
		if len(entry.EffortLevels) > 0 {
			for _, allowed := range entry.EffortLevels {
				if allowed == level {
					body["reasoning_effort"] = level
					return body
				}
			}
			return body // level not offered — keep the catalog default
		}
		body["reasoning_effort"] = level
		return body
	}
	// (c) reasoning:{enabled:true}-style — swap to effort.
	if r, isMap := body["reasoning"].(map[string]any); isMap {
		r["effort"] = level
		return body
	}
	return body
}

// hasBody reports whether the entry carries a non-empty body object.
func (e reasoningEntry) hasBody() bool {
	s := strings.TrimSpace(string(e.Body))
	return s != "" && s != "{}"
}

// resolveReasoningEntry walks the curated catalog key ladder:
// provider/model → provider/<last-seg> → provider/* → logical → family → *.
func resolveReasoningEntry(provider, rawModel string) (reasoningEntry, bool) {
	cat, err := loadReasoningCatalog()
	if err != nil || cat == nil {
		return reasoningEntry{}, false
	}
	logical := lastSegment(rawModel)
	family := MakeFamily(rawModel)
	keys := []string{
		provider + "/" + rawModel,
		provider + "/" + logical,
		provider + "/*",
		logical,
		family,
		"*",
	}
	for _, k := range keys {
		if entry, ok := cat.Reasoning[k]; ok {
			return entry, true
		}
	}
	return reasoningEntry{}, false
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

// supportsNativeWebSearch checks the curated web_search section:
// provider/model → provider/<last-seg> → provider/* → "*".
// Only OpenRouter gets a native body (plugins:[{id:"web"}]).
func supportsNativeWebSearch(provider, rawModel string) (bool, map[string]any) {
	cat, err := loadReasoningCatalog()
	if err != nil || cat == nil {
		return false, nil
	}
	logical := lastSegment(rawModel)
	keys := []string{
		provider + "/" + rawModel,
		provider + "/" + logical,
		provider + "/*",
		"*",
	}
	for _, k := range keys {
		if entry, ok := cat.WebSearch[k]; ok {
			if !entry.Native {
				return false, nil
			}
			var body map[string]any
			if len(entry.Body) > 0 {
				_ = json.Unmarshal(entry.Body, &body)
			}
			return true, body
		}
	}
	return false, nil
}

// NativeWebSearchBody returns the request fragment enabling the provider's
// NATIVE web search (OpenRouter plugins). nil → use the injected tool loop.
func NativeWebSearchBody(provider, rawModel string) map[string]any {
	if provider != "openrouter" {
		return nil // only OpenRouter has a native plugin (verified)
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

// lastSegment returns the text after the final "/" (or the whole string).
func lastSegment(id string) string {
	if i := strings.LastIndex(id, "/"); i >= 0 {
		return id[i+1:]
	}
	return id
}
