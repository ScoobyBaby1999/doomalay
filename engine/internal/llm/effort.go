// effort.go — the per-model effort/reasoning adapter (ported from the
// doomalaysocreate Python backend: effort_detector.py + reasoning_catalog.json).
//
// Every host exposes "deep thinking" differently:
//   - OpenRouter:      {"reasoning": {"effort": LEVEL}} — 7-level ladder
//                      (none,minimal,low,medium,high,xhigh,max), live-detected
//                      from the public /api/v1/models list (supported_parameters).
//   - NVIDIA NIM:      top-level "reasoning_effort" (deepseek-v4, nemotron-3) or
//                      "chat_template_kwargs":{"thinking"|"enable_thinking": bool}
//                      (kimi-k2.6, gemma-4, glm-5.1) — curated per model.
//   - Cloudflare:      per-model reasoning_effort OR chat_template_kwargs.
//   - GitHub Models:   no knob — some models reason natively (levels = []).
//   - OpenCode Zen/Go: UNKNOWN — conservative: never send reasoning params
//                      (a 400 blacklists the model for the session).
//   - PrivateMode AI:  chat_template_kwargs for kimi; native for others.
//
// Resolution order (exactly like the old backend):
//   1. LIVE: OpenRouter public models list (supported_parameters contains
//      "reasoning" / "reasoning_effort" / "include_reasoning") → 7-level ladder.
//   2. LIVE: GitHub Models public catalog (capabilities contains "reasoning")
//      → native reasoning, no knob → [] levels (frontend hides the button).
//   3. CURATED: reasoning_catalog.json — keys tried in order:
//      "provider/model" → "provider/<last-segment>" → "provider/*" →
//      logical name → family → "*".
//
// The catalog is data, not code — editing JSON changes behavior, zero recompile.

package llm

import (
	_ "embed"
	"encoding/json"
	"fmt"
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

// ── Live capability caches (OpenRouter + GitHub public catalogs) ──────────

// openRouterModelMeta is the subset of OpenRouter's /api/v1/models entries
// we use for capability detection.
type openRouterModelMeta struct {
	ID                  string   `json:"id"`
	ContextLength       int64    `json:"context_length"`
	SupportedParameters []string `json:"supported_parameters"`
	InputModalities     []string `json:"architecture.input_modalities"`
	Architecture        struct {
		InputModalities []string `json:"input_modalities"`
	} `json:"architecture"`
}

// openRouterModelsResponse is OpenRouter's models list shape.
type openRouterModelsResponse struct {
	Data []struct {
		ID                  string   `json:"id"`
		ContextLength       int64    `json:"context_length"`
		SupportedParameters []string `json:"supported_parameters"`
		Architecture        struct {
			InputModalities []string `json:"input_modalities"`
		} `json:"architecture"`
	} `json:"data"`
}

// githubModelsCatalogEntry is GitHub Models' public catalog shape.
type githubModelsCatalogEntry struct {
	ID         string   `json:"id"`
	Caps       []string `json:"capabilities"`
	Modalities []string `json:"supported_input_modalities"`
	Limits     struct {
		MaxInputTokens int64 `json:"max_input_tokens"`
	} `json:"limits"`
}

var (
	orMetaMu    sync.Mutex
	orMetaCache map[string]openRouterModelMeta
	orMetaAt    time.Time
	ghMetaMu    sync.Mutex
	ghMetaCache map[string]githubModelsCatalogEntry
	ghMetaAt    time.Time
)

const liveCapabilityTTL = 10 * time.Minute

// fetchOpenRouterMeta pulls the PUBLIC OpenRouter models list (no key needed)
// and indexes it by raw id. This is the "family registry" trick from the old
// backend: metadata belongs to the model family, available even when the user
// has no OpenRouter key.
func fetchOpenRouterMeta() map[string]openRouterModelMeta {
	orMetaMu.Lock()
	defer orMetaMu.Unlock()
	if orMetaCache != nil && time.Since(orMetaAt) < liveCapabilityTTL {
		return orMetaCache
	}
	var out map[string]openRouterModelMeta
	body, err := httpGetJSON("https://openrouter.ai/api/v1/models?output_modalities=text", "")
	if err == nil {
		var resp openRouterModelsResponse
		if json.Unmarshal(body, &resp) == nil {
			out = make(map[string]openRouterModelMeta, len(resp.Data))
			for _, m := range resp.Data {
				out[m.ID] = openRouterModelMeta{
					ID:                  m.ID,
					ContextLength:       m.ContextLength,
					SupportedParameters: m.SupportedParameters,
					InputModalities:     m.Architecture.InputModalities,
				}
			}
		}
	}
	if out == nil {
		// keep stale cache on failure rather than nothing
		if orMetaCache != nil {
			return orMetaCache
		}
		out = map[string]openRouterModelMeta{}
	}
	orMetaCache = out
	orMetaAt = time.Now()
	return out
}

// fetchGitHubMeta pulls GitHub Models' public catalog (no auth) and indexes
// by id + last path segment.
func fetchGitHubMeta() map[string]githubModelsCatalogEntry {
	ghMetaMu.Lock()
	defer ghMetaMu.Unlock()
	if ghMetaCache != nil && time.Since(ghMetaAt) < liveCapabilityTTL {
		return ghMetaCache
	}
	var out map[string]githubModelsCatalogEntry
	body, err := httpGetJSON("https://models.github.ai/catalog/models", "")
	if err == nil {
		var entries []githubModelsCatalogEntry
		if json.Unmarshal(body, &entries) == nil {
			out = make(map[string]githubModelsCatalogEntry, len(entries)*2)
			for _, e := range entries {
				out[e.ID] = e
				if seg := lastSegment(e.ID); seg != e.ID {
					out[seg] = e
				}
			}
		}
	}
	if out == nil {
		if ghMetaCache != nil {
			return ghMetaCache
		}
		out = map[string]githubModelsCatalogEntry{}
	}
	ghMetaCache = out
	ghMetaAt = time.Now()
	return out
}

// OpenRouter's 7-level effort ladder.
var openRouterLadder = []string{"none", "minimal", "low", "medium", "high", "xhigh", "max"}

// ModelCapabilities is the per-model capability roll-up the frontend consumes.
type ModelCapabilities struct {
	Effort       bool     `json:"effort"`
	EffortParam  string   `json:"effort_param,omitempty"` // "reasoning" | "reasoning_effort" | "chat_template_kwargs" | ""
	EffortLevels []string `json:"effort_levels"`
	WebSearch    bool     `json:"web_search"`
	Tools        bool     `json:"tools"`
	Vision       bool     `json:"vision"`
	Audio        bool     `json:"audio"`
}

// DetectEffortLevels returns the effort ladder for a model on a provider.
// Resolution: OpenRouter live → GitHub live → curated catalog.
func DetectEffortLevels(provider, rawModel string) []string {
	caps := detectModelCaps(provider, rawModel)
	return caps.EffortLevels
}

// providerDefaultLevels — v0.26: per-PROVIDER effort defaults so the
// effort bubble ALWAYS appears with the right shape, even for models
// without a curated entry (the user spec: "We need to programmatically
// and dynamically view the provider, the model, and then determine its
// effort modes based on that"):
//
//   - NVIDIA NIM:   ~95% of models expose thinking on/off
//     (chat_template_kwargs); the reasoning_effort models
//     (deepseek-v4, nemotron-3.x) carry curated entries.
//   - PrivateMode:  on/off (kimi thinking toggle; verified per docs).
//   - OpenCode Zen: low/high by default — the models are OpenAI-compatible
//     proxies; a wrong param is retried without the effort
//     body once (see the 400-resilience in chat.go) and
//     blacklisted for the engine's lifetime, so exposing
//     levels is safe even for unlisted models.
//   - Cloudflare:   on/off unless curated.
var providerDefaultLevels = map[string][]string{
	"nvidia":        {"on", "off"},
	"privatemodeai": {"on", "off"},
	"opencode":      {"low", "high"},
	"opencode-zen":  {"low", "high"},
	"opencode-go":   {"low", "high"},
	"cloudflare":    {"on", "off"},
}

// detectModelCaps computes the full capability roll-up for provider/model.
func detectModelCaps(provider, rawModel string) ModelCapabilities {
	caps := ModelCapabilities{EffortLevels: []string{}}
	logical := lastSegment(rawModel)

	// PROVIDER-AWARE RESOLUTION (v0.26): providers we KNOW document their
	// effort surface are resolved curated-first, then the provider default.
	// Generic OpenRouter/GitHub live detection never overrides a known
	// provider's own shape (the old code let an OpenRouter family match
	// hand a 7-level ladder to a NIM model that only takes on/off).
	knownProvider := providerDefaultLevels[provider] != nil

	// 1. Curated catalog (the verified per-model shapes win over everything).
	if entry, ok := resolveReasoningEntry(provider, rawModel); ok && (len(entry.EffortLevels) > 0 || entry.hasBody()) {
		if len(entry.EffortLevels) > 0 {
			caps.EffortLevels = entry.EffortLevels
			caps.Effort = true
		}
		if entry.hasBody() {
			var body map[string]any
			if json.Unmarshal(entry.Body, &body) == nil {
				if _, hasCTK := body["chat_template_kwargs"]; hasCTK {
					caps.EffortParam = "chat_template_kwargs"
				} else if _, hasRE := body["reasoning_effort"]; hasRE {
					caps.EffortParam = "reasoning_effort"
				} else if _, hasR := body["reasoning"]; hasR {
					caps.EffortParam = "reasoning"
				}
			}
		}
	}

	// 2. Provider default (nvidia on/off, opencode low/high, pm on/off…).
	if len(caps.EffortLevels) == 0 && knownProvider {
		caps.EffortLevels = append([]string{}, providerDefaultLevels[provider]...)
		caps.Effort = true
	}

	// 3. Live detection — ONLY for providers without a known effort surface
	//    (OpenRouter's public list + GitHub Models' catalog).
	if !knownProvider {
		orMeta := fetchOpenRouterMeta()
		if m, ok := orMeta[rawModel]; ok {
			applyORMeta(&caps, m)
		} else if m, ok := orMeta[logical]; ok {
			applyORMeta(&caps, m)
		} else {
			for id, m := range orMeta {
				if lastSegment(id) == logical {
					applyORMeta(&caps, m)
					break
				}
			}
		}
		ghMeta := fetchGitHubMeta()
		if e, ok := ghMeta[rawModel]; ok {
			applyGHMeta(&caps, e)
		} else if e, ok := ghMeta[logical]; ok {
			applyGHMeta(&caps, e)
		}
	}

	// 4. Name heuristics for tools/vision (old backend's derive_capabilities_from_name).
	name := strings.ToLower(rawModel)
	if !caps.Tools {
		for _, kw := range []string{"tool", "function", "agent", "instruct", "chat", "turbo", "hermes", "big-pickle", "coder", "-it"} {
			if strings.Contains(name, kw) {
				caps.Tools = true
				break
			}
		}
		// Host guarantees.
		if provider == "openrouter" {
			caps.Tools = true
		}
	}
	if !caps.Vision {
		for _, kw := range []string{"vision", "-vl", "llava", "florence", "gemma", "kimi", "llama-4", "qwen3", "glm-5", "step"} {
			if strings.Contains(name, kw) {
				caps.Vision = true
				break
			}
		}
	}

	// Web search: native only on OpenRouter (plugins body); others get the
	// injected tool loop (handled in chat path).
	ws, _ := supportsNativeWebSearch(provider, rawModel)
	caps.WebSearch = ws || provider != "" // web search available via tools on every host

	return caps
}

func applyORMeta(caps *ModelCapabilities, m openRouterModelMeta) {
	for _, p := range m.SupportedParameters {
		switch p {
		case "reasoning", "reasoning_effort", "include_reasoning":
			if len(caps.EffortLevels) == 0 {
				caps.EffortLevels = openRouterLadder
				caps.EffortParam = "reasoning"
			}
			caps.Effort = true
		case "tools", "tool_choice":
			caps.Tools = true
		}
	}
	for _, mod := range m.InputModalities {
		switch mod {
		case "image":
			caps.Vision = true
		case "audio":
			caps.Audio = true
		}
	}
}

func applyGHMeta(caps *ModelCapabilities, e githubModelsCatalogEntry) {
	for _, c := range e.Caps {
		switch c {
		case "tool-calling", "tools", "agents", "agentsV2":
			caps.Tools = true
		case "reasoning":
			// Native reasoner — no knob. Keep levels empty; the frontend
			// hides the effort button but shows a "reasoning" capability chip.
			caps.Effort = true
		}
		if strings.Contains(strings.ToLower(c), "reason") {
			caps.Effort = true
		}
	}
	for _, mod := range e.Modalities {
		switch mod {
		case "image":
			caps.Vision = true
		case "audio":
			caps.Audio = true
		}
	}
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

// BuildEffortBodyFor returns the request-body fragment enabling reasoning at
// the chosen effort level for provider/model. Port of detect_effort_body():
//   - OpenRouter:  {"reasoning": {"effort": LEVEL}} (level coerced into the ladder)
//   - Toggle models (["on","off"]): flip the first boolean inside
//     chat_template_kwargs to level != "off"
//   - Enum models: replace reasoning_effort with the level if allowed
//   - GitHub/OpenCode: {} (never send — undocumented, a 400 blacklists the slot)
func BuildEffortBodyFor(provider, rawModel, level string) map[string]any {
	if level == "" || level == "off" {
		return nil
	}
	// OpenRouter: always the reasoning.effort shape (live-verified param).
	if provider == "openrouter" {
		chosen := level
		allowed := map[string]bool{"none": true, "minimal": true, "low": true, "medium": true, "high": true, "xhigh": true, "max": true}
		if !allowed[level] {
			chosen = "high"
		}
		return map[string]any{"reasoning": map[string]any{"effort": chosen}}
	}
	// GitHub Models: conservative — no param.
	if provider == "github-models" || provider == "github" {
		return nil
	}
	// OpenCode Zen/Go (v0.26): OpenAI-compatible reasoning_effort. The
	// 400-resilience in chat.go retries without the param once and
	// blacklists it for the engine's lifetime if a model rejects it.
	if provider == "opencode" || provider == "opencode-zen" || provider == "opencode-go" {
		allowed := map[string]bool{"minimal": true, "low": true, "medium": true, "high": true, "max": true}
		chosen := level
		if !allowed[level] {
			chosen = "high"
			if level == "off" || level == "none" {
				return nil
			}
		}
		return map[string]any{"reasoning_effort": chosen}
	}

	entry, ok := resolveReasoningEntry(provider, rawModel)
	if !ok || !entry.hasBody() {
		return nil
	}
	var body map[string]any
	if err := json.Unmarshal(entry.Body, &body); err != nil {
		return nil
	}

	// Translation (a): toggle models — flip the first boolean inside
	// chat_template_kwargs based on level != "off".
	if ctk, isMap := body["chat_template_kwargs"].(map[string]any); isMap {
		for k, v := range ctk {
			if b, isBool := v.(bool); isBool {
				ctk[k] = level != "off"
				_ = b
				break
			}
		}
		return body
	}

	// Translation (b): enum models — replace reasoning_effort with the level
	// when the level is in the entry's allowed list.
	if _, hasRE := body["reasoning_effort"]; hasRE {
		if len(entry.EffortLevels) > 0 {
			for _, allowed := range entry.EffortLevels {
				if allowed == level {
					body["reasoning_effort"] = level
					return body
				}
			}
			// Level not offered by this model — keep the catalog default.
			return body
		}
		body["reasoning_effort"] = level
		return body
	}

	// reasoning:{enabled:true}-style (OpenRouter curated entries): swap to effort.
	if r, isMap := body["reasoning"].(map[string]any); isMap {
		r["effort"] = level
		return body
	}

	return body
}

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
