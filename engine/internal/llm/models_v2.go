// models_v2.go — the dynamic model catalog with the LOGICAL view.
//
// Port of the old doomalaysocreate backend (lib/provider_sync/*.py +
// critique_service catalog builder), adapted to Go:
//   - every provider's model list is fetched LIVE at runtime from the
//     provider's own API (no static model lists, ever)
//   - a cross-provider FAMILY REGISTRY is built from OpenRouter's public
//     models list + GitHub Models' public catalog (context, capabilities,
//     benchmarks, pricing belong to the model family, not the route)
//   - models are grouped by family into LOGICAL models with HOST routes
//     (provider priority, hasApiKey, syncedLive) — the "model view"
//   - each provider also gets a GROUP (the "provider view")
//   - effort levels per (provider, model) come from effort.go
//
// Backward compatibility: the response keeps `providers` (catalog configs)
// and `models` (flat "provider/id" list) so v0.12 screens keep working; the
// new `groups` + `logical` arrays power the v0.13 model browser.

package llm

import (
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"
)

// ModelAttributes is the presentation metadata for a logical model.
type ModelAttributes struct {
	Capabilities []string          `json:"capabilities,omitempty"`
	Benchmarks   map[string]float64 `json:"benchmarks,omitempty"`
	Pricing      string            `json:"pricing,omitempty"`
	Ranks        []RankEntry       `json:"ranks,omitempty"`
	EffortLevels []string          `json:"effortLevels,omitempty"`
	Note         string            `json:"note,omitempty"`
}

// RankEntry is a leaderboard rank (old: design_arena top-3).
type RankEntry struct {
	Label string `json:"label"`
	Rank  int    `json:"rank"`
}

// EnrichedModel is one model on one provider, with metadata.
type EnrichedModel struct {
	ID            string   `json:"id"`      // "provider/raw_id" (the slot key)
	RawID         string   `json:"rawId"`   // the id the provider expects
	Provider      string   `json:"provider"`
	DisplayName   string   `json:"displayName"`
	Family        string   `json:"family"`
	ContextLength int64    `json:"contextLength"`
	IsFree        bool     `json:"isFree"`
	Capabilities  []string `json:"capabilities,omitempty"`
	Pricing       string   `json:"pricing,omitempty"`
	EffortLevels  []string `json:"effortLevels,omitempty"`
}

// HostRoute is one provider-hosted route of a logical model.
type HostRoute struct {
	Provider            string `json:"provider"`
	ProviderDisplayName string `json:"providerDisplayName"`
	Color               string `json:"color"`
	ModelID             string `json:"modelId"` // raw id on that provider
	ContextLength       int64  `json:"contextLength"`
	HasAPIKey           bool   `json:"hasApiKey"`
	SyncedLive          bool   `json:"syncedLive"`
	DefaultPriority     int    `json:"defaultPriority"`
	IsFree              bool   `json:"isFree"`
}

// LogicalModel groups provider models by family (the "model view" row).
type LogicalModel struct {
	Logical       string           `json:"logical"`
	DisplayName   string           `json:"displayName"`
	Family        string           `json:"family"`
	ContextLength int64            `json:"contextLength"`
	Hosts         []HostRoute      `json:"hosts"`
	Attributes    *ModelAttributes `json:"attributes,omitempty"`
	IsFree        bool             `json:"isFree"`
}

// ProviderGroup is the "provider view" entry: one provider + its models.
type ProviderGroup struct {
	Name        string          `json:"name"`
	DisplayName string          `json:"displayName"`
	Color       string          `json:"color"`
	Description string          `json:"description"`
	Models      []EnrichedModel `json:"models"`
	HasKey      bool            `json:"hasApiKey"`
	SyncedLive  bool            `json:"syncedLive"`
	ModelCount  int             `json:"modelCount"`
	SettingsURL string          `json:"settingsUrl"`
	FreeTier    bool            `json:"freeTier"`
	EnvVar      string          `json:"envVar,omitempty"`
}

// CatalogV2 is the /api/models response with the logical view.
type CatalogV2 struct {
	Providers   map[string]ProviderConfig `json:"providers"`
	Models      []ModelInfo               `json:"models"`
	Groups      []ProviderGroup           `json:"groups"`
	Logical     []LogicalModel            `json:"logical"`
	SyncStatus  []SyncStatus              `json:"syncStatus"`
	TotalModels int                       `json:"totalModels"`
	SyncedAt    string                    `json:"syncedAt"`
}

// hostPriority is the default provider order when building host routes
// (mirrors the old backend's providers_catalog.json iteration order —
// free/fast hosts first, paid last).
var hostPriority = []string{
	"nvidia", "opencode", "privatemodeai", "cloudflare", "groq",
	"github", "openrouter", "together", "mistral", "opencode", "deepseek",
	"openai", "anthropic",
}

// providerPriorityIndex ranks providers for defaultPriority.
func providerPriorityIndex(name string) int {
	for i, p := range hostPriority {
		if p == name {
			return i
		}
	}
	return len(hostPriority) + 1
}

// ── Per-provider live fetchers (the crown jewels) ──────────────────────────

// fetchedModel is the normalized output of a provider fetcher.
type fetchedModel struct {
	RawID         string
	ContextLength int64
	IsFree        bool
	Pricing       string
	Caps          []string
	SyncedLive    bool
}

// fetchProviderModelsV2 dispatches to the per-provider live fetcher.
// Every fetcher uses the provider's OWN API — no static fallbacks.
func fetchProviderModelsV2(name string, cfg ProviderConfig, apiKey, accountID string) []fetchedModel {
	switch name {
	case "openrouter":
		return fetchOpenRouterModels(apiKey)
	case "nvidia":
		return fetchNvidiaModels(apiKey)
	case "opencode":
		return fetchOpenCodeModels(apiKey)
	case "privatemodeai":
		return fetchPrivateModeModels(apiKey)
	case "cloudflare":
		return fetchCloudflareModels(apiKey, accountID)
	case "github":
		return fetchGitHubModels(apiKey)
	default:
		// OpenAI-compatible /v1/models (groq, together, mistral, openai,
		// anthropic, deepseek) — fetchProviderModels already handles the
		// data[]/models[] shapes; re-parse raw for enrichment.
		return fetchOpenAICompatible(name, cfg, apiKey)
	}
}

// fetchOpenRouterModels — GET https://openrouter.ai/api/v1/models?output_modalities=text
// (public; optional auth). Free detection: zero prices or ":free" suffix.
// Free-only by default matches the old backend's safe default; the full
// (paid) list is still fetched to enrich the family registry.
func fetchOpenRouterModels(apiKey string) []fetchedModel {
	body, err := httpGetJSON("https://openrouter.ai/api/v1/models?output_modalities=text", apiKey)
	if err != nil {
		return nil
	}
	var resp struct {
		Data []struct {
			ID            string `json:"id"`
			ContextLength int64  `json:"context_length"`
			Pricing       struct {
				Prompt     string `json:"prompt"`
				Completion string `json:"completion"`
			} `json:"pricing"`
			Architecture struct {
				InputModalities []string `json:"input_modalities"`
			} `json:"architecture"`
		} `json:"data"`
	}
	if json.Unmarshal(body, &resp) != nil {
		return nil
	}
	var out []fetchedModel
	for _, m := range resp.Data {
		free := strings.HasSuffix(m.ID, ":free") ||
			(parsePrice(m.Pricing.Prompt) == 0 && parsePrice(m.Pricing.Completion) == 0)
		var caps []string
		for _, mod := range m.Architecture.InputModalities {
			if mod == "image" {
				caps = append(caps, "vision")
			} else if mod == "audio" {
				caps = append(caps, "audio")
			}
		}
		out = append(out, fetchedModel{
			RawID:         m.ID,
			ContextLength: m.ContextLength,
			IsFree:        free,
			Pricing:       pricingString(m.Pricing.Prompt, m.Pricing.Completion, free),
			Caps:          caps,
			SyncedLive:    true,
		})
	}
	return out
}

// fetchNvidiaModels — GET https://integrate.api.nvidia.com/v1/models
// (works with a Bearer key; the listing is public too).
func fetchNvidiaModels(apiKey string) []fetchedModel {
	body, err := httpGetJSON("https://integrate.api.nvidia.com/v1/models", apiKey)
	if err != nil {
		return nil
	}
	var resp struct {
		Data []struct {
			ID      string `json:"id"`
			OwnedBy string `json:"owned_by"`
		} `json:"data"`
	}
	if json.Unmarshal(body, &resp) != nil {
		return nil
	}
	var out []fetchedModel
	for _, m := range resp.Data {
		// owned_by "nvidia" → NVIDIA-hosted (free endpoint); third-party
		// hosted models on NIM bill per token.
		free := strings.Contains(strings.ToLower(m.OwnedBy), "nvidia")
		out = append(out, fetchedModel{
			RawID:      m.ID,
			IsFree:     free,
			SyncedLive: true,
		})
	}
	return out
}

// fetchOpenCodeModels — GET https://opencode.ai/zen/v1/models (public).
// Free: "big-pickle" (verified) or "-free" suffix, EXCEPT the known paid
// exceptions (minimax-m3-free, qwen3.6-plus-free — paid on Zen despite the name).
func fetchOpenCodeModels(apiKey string) []fetchedModel {
	body, err := httpGetJSON("https://opencode.ai/zen/v1/models", apiKey)
	if err != nil {
		return nil
	}
	var resp struct {
		Data []struct {
			ID string `json:"id"`
		} `json:"data"`
	}
	if json.Unmarshal(body, &resp) != nil {
		return nil
	}
	paidExceptions := map[string]bool{
		"minimax-m3-free": true, "qwen3.6-plus-free": true,
	}
	var out []fetchedModel
	for _, m := range resp.Data {
		free := m.ID == "big-pickle" ||
			(strings.HasSuffix(m.ID, "-free") && !paidExceptions[m.ID])
		out = append(out, fetchedModel{
			RawID:      m.ID,
			IsFree:     free,
			SyncedLive: true,
		})
	}
	return out
}

// fetchPrivateModeModels — GET https://api.privatemode.ai/v1/models (Bearer).
// Shape: {"data":[{"id":"kimi-k2.6","max_context_length":256000}]}.
func fetchPrivateModeModels(apiKey string) []fetchedModel {
	if apiKey == "" {
		return nil
	}
	body, err := httpGetJSON("https://api.privatemode.ai/v1/models", apiKey)
	if err != nil {
		return nil
	}
	var resp struct {
		Data []struct {
			ID                string `json:"id"`
			MaxContextLength  int64  `json:"max_context_length"`
			ContextLength     int64  `json:"context_length"`
		} `json:"data"`
	}
	if json.Unmarshal(body, &resp) != nil {
		return nil
	}
	var out []fetchedModel
	for _, m := range resp.Data {
		ctx := m.MaxContextLength
		if ctx == 0 {
			ctx = m.ContextLength
		}
		out = append(out, fetchedModel{
			RawID:         m.ID,
			ContextLength: ctx,
			IsFree:        true, // free confidential tier
			SyncedLive:    true,
		})
	}
	// Drop "-latest" variants when a specific model exists (old dedup rule).
	out = dedupeLatest(out)
	return out
}

// fetchCloudflareModels — GET
// https://api.cloudflare.com/client/v4/accounts/{id}/ai/models/search?per_page=500&page=N
// (Bearer token + account id, paginated). Model id = item.name.
func fetchCloudflareModels(apiKey, accountID string) []fetchedModel {
	if apiKey == "" || accountID == "" {
		return nil
	}
	var out []fetchedModel
	for page := 1; page <= 5; page++ {
		u := fmt.Sprintf("https://api.cloudflare.com/client/v4/accounts/%s/ai/models/search?hide_experimental=false&include_deprecated=true&per_page=500&page=%d", accountID, page)
		body, err := httpGetJSON(u, apiKey)
		if err != nil {
			break
		}
		var resp struct {
			Success bool `json:"success"`
			Result  []struct {
				ID   string `json:"id"`
				Name string `json:"name"`
			} `json:"result"`
			ResultInfo struct {
				TotalCount int `json:"total_count"`
				PerPage    int `json:"per_page"`
			} `json:"result_info"`
		}
		if json.Unmarshal(body, &resp) != nil || !resp.Success {
			break
		}
		for _, m := range resp.Result {
			id := m.Name
			if id == "" {
				id = m.ID
			}
			if id == "" {
				continue
			}
			out = append(out, fetchedModel{RawID: id, IsFree: true, SyncedLive: true})
		}
		if len(resp.Result) == 0 || len(out) >= resp.ResultInfo.TotalCount {
			break
		}
	}
	return out
}

// fetchGitHubModels — GET https://models.github.ai/catalog/models
// (public, no auth). Bare JSON array shape.
func fetchGitHubModels(apiKey string) []fetchedModel {
	headers := map[string]string{
		"Accept":                "application/vnd.github+json",
		"X-GitHub-Api-Version":  "2026-03-10",
	}
	_ = headers
	body, err := httpGetJSON("https://models.github.ai/catalog/models", apiKey)
	if err != nil {
		return nil
	}
	var entries []struct {
		ID           string   `json:"id"`
		Capabilities []string `json:"capabilities"`
		Modalities   []string `json:"supported_input_modalities"`
		Limits       struct {
			MaxInputTokens int64 `json:"max_input_tokens"`
		} `json:"limits"`
	}
	if json.Unmarshal(body, &entries) != nil {
		return nil
	}
	var out []fetchedModel
	for _, m := range entries {
		var caps []string
		for _, c := range m.Capabilities {
			switch c {
			case "tool-calling", "tools", "agents", "agentsV2":
				caps = append(caps, "tools")
			case "reasoning":
				caps = append(caps, "reasoning")
			}
		}
		for _, mod := range m.Modalities {
			if mod == "image" {
				caps = append(caps, "vision")
			}
		}
		out = append(out, fetchedModel{
			RawID:         m.ID,
			ContextLength: m.Limits.MaxInputTokens,
			IsFree:        true, // free tier: 15 rpm / 150 rpd
			Caps:          caps,
			SyncedLive:    true,
		})
	}
	return out
}

// fetchOpenAICompatible — GET {base}/models for the standard providers.
func fetchOpenAICompatible(name string, cfg ProviderConfig, apiKey string) []fetchedModel {
	if apiKey == "" {
		return nil
	}
	base := strings.TrimSuffix(cfg.BaseURL, "/")
	body, err := httpGetJSON(base+"/models", apiKey)
	if err != nil {
		return nil
	}
	var resp struct {
		Data []struct {
			ID   string `json:"id"`
			Name string `json:"name"`
		} `json:"data"`
		Models []struct {
			ID   string `json:"id"`
			Name string `json:"name"`
		} `json:"models"`
	}
	_ = json.Unmarshal(body, &resp)
	var out []fetchedModel
	for _, m := range resp.Data {
		id := m.ID
		if id == "" {
			id = m.Name
		}
		if id == "" {
			continue
		}
		out = append(out, fetchedModel{
			RawID:      id,
			IsFree:     !cfg.FreeTier == false, // paid catalog providers are paid
			SyncedLive: true,
		})
	}
	for _, m := range resp.Models {
		id := m.ID
		if id == "" {
			id = m.Name
		}
		if id == "" {
			continue
		}
		out = append(out, fetchedModel{RawID: id, SyncedLive: true})
	}
	return out
}

// ── Catalog assembly ───────────────────────────────────────────────────────

// catalogV2Cache caches the assembled catalog (10 min TTL — same as the old
// backend's in-process cache).
var (
	catalogV2Mu   sync.Mutex
	catalogV2Ent  *CatalogV2
	catalogV2At   time.Time
)

const catalogV2TTL = 10 * time.Minute

// BuildCatalogV2 assembles the full catalog: live provider syncs + family
// registry + logical grouping. force bypasses the cache.
func BuildCatalogV2(keys map[string]string, force bool) *CatalogV2 {
	catalogV2Mu.Lock()
	defer catalogV2Mu.Unlock()
	if !force && catalogV2Ent != nil && time.Since(catalogV2At) < catalogV2TTL {
		return catalogV2Ent
	}

	catalog, err := LoadCatalog()
	if err != nil {
		catalog = map[string]ProviderConfig{}
	}

	// Sync every provider in parallel (public listings sync even without
	// keys so the model browser can show unavailable routes dimmed).
	type syncOut struct {
		name   string
		models []fetchedModel
		err    error
	}
	outCh := make(chan syncOut, len(catalog))
	var wg sync.WaitGroup
	for name, cfg := range catalog {
		wg.Add(1)
		go func(name string, cfg ProviderConfig) {
			defer wg.Done()
			apiKey := keys[cfg.EnvVar]
			accountID := ""
			if cfg.ExtraEnvVar != "" {
				accountID = keys[cfg.ExtraEnvVar]
			}
			models := fetchProviderModelsV2(name, cfg, apiKey, accountID)
			var syncErr error
			if models == nil {
				syncErr = fmt.Errorf("no models returned")
			}
			outCh <- syncOut{name: name, models: models, err: syncErr}
		}(name, cfg)
	}
	go func() {
		wg.Wait()
		close(outCh)
	}()

	synced := map[string][]fetchedModel{}
	syncErrs := map[string]error{}
	for out := range outCh {
		if out.err != nil {
			syncErrs[out.name] = out.err
		}
		if out.models != nil {
			synced[out.name] = out.models
		}
	}

	// Family registry from OpenRouter (public) + GitHub (public).
	registry := buildFamilyRegistry()

	// Provider groups (provider view).
	var groups []ProviderGroup
	var flat []ModelInfo
	for _, name := range sortedProviderNames(catalog) {
		cfg := catalog[name]
		models := synced[name]
		hasKey := keys[cfg.EnvVar] != ""
		group := ProviderGroup{
			Name:        name,
			DisplayName: cfg.Label,
			Color:       cfg.Color,
			Description: cfg.Description,
			HasKey:      hasKey,
			SyncedLive:  len(models) > 0,
			ModelCount:  len(models),
			SettingsURL: cfg.SignupURL,
			FreeTier:    cfg.FreeTier,
			EnvVar:      cfg.EnvVar,
		}
		for _, m := range models {
			fam := MakeFamily(m.RawID)
			em := EnrichedModel{
				ID:            name + "/" + m.RawID,
				RawID:         m.RawID,
				Provider:      name,
				DisplayName:   DeriveDisplayName(m.RawID),
				Family:        fam,
				ContextLength: m.ContextLength,
				IsFree:        m.IsFree,
				Capabilities:  m.Caps,
				Pricing:       m.Pricing,
				EffortLevels:  DetectEffortLevels(name, m.RawID),
			}
			// Enrich from the registry when the fetcher was sparse.
			if em.ContextLength == 0 {
				if meta, ok := registry[fam]; ok {
					em.ContextLength = meta.Context
				}
			}
			if len(em.Capabilities) == 0 {
				if meta, ok := registry[fam]; ok {
					em.Capabilities = meta.Capabilities
				}
			}
			if em.Pricing == "" {
				if meta, ok := registry[fam]; ok {
					em.Pricing = meta.Pricing
				}
			}
			if !em.IsFree {
				if meta, ok := registry[fam]; ok && meta.IsFree {
					em.IsFree = true
				}
			}
			group.Models = append(group.Models, em)
			flat = append(flat, ModelInfo{ID: name + "/" + m.RawID, Provider: name, Label: m.RawID})
		}
		// Sort provider view models: intelligence → context → name.
		sortEnriched(group.Models)
		group.ModelCount = len(group.Models)
		groups = append(groups, group)
	}

	// Logical models (model view) — group every synced model by family.
	logicalMap := map[string]*LogicalModel{}
	var logicalOrder []string
	for _, name := range sortedProviderNames(catalog) {
		for _, m := range synced[name] {
			fam := MakeFamily(m.RawID)
			lm, ok := logicalMap[fam]
			if !ok {
				lm = &LogicalModel{
					Logical:     fam,
					DisplayName: DeriveDisplayName(m.RawID),
					Family:      fam,
				}
				logicalMap[fam] = lm
				logicalOrder = append(logicalOrder, fam)
			}
			// Host route.
			cfg := catalog[name]
			lm.Hosts = append(lm.Hosts, HostRoute{
				Provider:            name,
				ProviderDisplayName: cfg.Label,
				Color:               cfg.Color,
				ModelID:             m.RawID,
				ContextLength:       m.ContextLength,
				HasAPIKey:           keys[cfg.EnvVar] != "",
				SyncedLive:          true,
				DefaultPriority:     providerPriorityIndex(name),
				IsFree:              m.IsFree,
			})
			if m.ContextLength > lm.ContextLength {
				lm.ContextLength = m.ContextLength
			}
			if m.IsFree {
				lm.IsFree = true
			}
		}
	}
	// Attributes from the registry.
	var logical []LogicalModel
	for _, fam := range logicalOrder {
		lm := logicalMap[fam]
		if len(lm.Hosts) == 0 {
			continue
		}
		attrs := &ModelAttributes{EffortLevels: []string{}}
		if meta, ok := registry[fam]; ok {
			attrs.Capabilities = meta.Capabilities
			attrs.Benchmarks = meta.Benchmarks
			attrs.Pricing = meta.Pricing
			attrs.Ranks = meta.Ranks
		}
		if len(attrs.Capabilities) == 0 {
			attrs.Capabilities = InferCapabilitiesFromName(fam)
		}
		// Effort levels: union of host-specific ladders (OpenRouter 7-level
		// wins when present; curated shapes otherwise).
		levelSet := map[string]bool{}
		var levels []string
		for _, h := range lm.Hosts {
			for _, lv := range DetectEffortLevels(h.Provider, h.ModelID) {
				if !levelSet[lv] {
					levelSet[lv] = true
					levels = append(levels, lv)
				}
			}
		}
		if len(levels) > 0 {
			attrs.EffortLevels = normalizeLevels(levels)
		}
		if len(attrs.Capabilities) > 0 && hasCapability(attrs.Capabilities, "reasoning") && len(attrs.EffortLevels) == 0 {
			// Native reasoner — keep empty levels (frontend hides the knob).
		}
		lm.Attributes = attrs
		// Sort hosts by default priority, then availability.
		sortHosts(lm.Hosts)
		logical = append(logical, *lm)
	}
	// Sort logical models: intelligence desc → context desc → name.
	sortLogical(logical, registry)

	// Sync status.
	var status []SyncStatus
	for _, name := range sortedProviderNames(catalog) {
		cfg := catalog[name]
		st := SyncStatus{
			Provider:   name,
			HasKey:     keys[cfg.EnvVar] != "",
			ModelCount: len(synced[name]),
		}
		if e, ok := syncErrs[name]; ok && len(synced[name]) == 0 {
			st.Error = e.Error()
		}
		status = append(status, st)
	}

	resp := &CatalogV2{
		Providers:   catalog,
		Models:      flat,
		Groups:      groups,
		Logical:     logical,
		SyncStatus:  status,
		TotalModels: len(flat),
		SyncedAt:    time.Now().UTC().Format(time.RFC3339),
	}
	catalogV2Ent = resp
	catalogV2At = time.Now()
	return resp
}

// familyMeta is the registry entry for a model family.
type familyMeta struct {
	Context     int64
	IsFree      bool
	Pricing     string
	Capabilities []string
	Benchmarks  map[string]float64
	Ranks       []RankEntry
}

// buildFamilyRegistry merges OpenRouter's public list + GitHub's public
// catalog into per-family metadata (first-wins merge, exactly like the old
// _fetch_openrouter_family + _fetch_github_models_family).
func buildFamilyRegistry() map[string]familyMeta {
	registry := map[string]familyMeta{}

	// OpenRouter: full list (free + paid) — metadata for the family.
	body, err := httpGetJSON("https://openrouter.ai/api/v1/models?output_modalities=text", "")
	if err == nil {
		var resp struct {
			Data []struct {
				ID            string   `json:"id"`
				ContextLength int64    `json:"context_length"`
				SupportedParameters []string `json:"supported_parameters"`
				Pricing       struct {
					Prompt     string `json:"prompt"`
					Completion string `json:"completion"`
				} `json:"pricing"`
				Architecture struct {
					InputModalities []string `json:"input_modalities"`
				} `json:"architecture"`
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
			} `json:"data"`
		}
		if json.Unmarshal(body, &resp) == nil {
			for _, m := range resp.Data {
				fam := MakeFamily(m.ID)
				existing, ok := registry[fam]
				if !ok {
					existing = familyMeta{}
				}
				if existing.Context == 0 {
					existing.Context = m.ContextLength
				}
				if existing.Pricing == "" {
					free := strings.HasSuffix(m.ID, ":free") ||
						(parsePrice(m.Pricing.Prompt) == 0 && parsePrice(m.Pricing.Completion) == 0)
					existing.Pricing = pricingString(m.Pricing.Prompt, m.Pricing.Completion, free)
					if free {
						existing.IsFree = true
					}
				}
				for _, mod := range m.Architecture.InputModalities {
					if mod == "image" {
						existing.Capabilities = appendUnique(existing.Capabilities, "vision")
					} else if mod == "audio" {
						existing.Capabilities = appendUnique(existing.Capabilities, "audio")
					}
				}
				for _, p := range m.SupportedParameters {
					if p == "tools" || p == "tool_choice" {
						existing.Capabilities = appendUnique(existing.Capabilities, "tools")
					}
					if p == "reasoning" || p == "include_reasoning" {
						existing.Capabilities = appendUnique(existing.Capabilities, "reasoning")
					}
				}
				if existing.Benchmarks == nil {
					aa := m.Benchmarks.ArtificialAnalysis
					if aa.IntelligenceIndex > 0 || aa.CodingIndex > 0 || aa.AgenticIndex > 0 {
						existing.Benchmarks = map[string]float64{
							"intelligence": aa.IntelligenceIndex,
							"coding":       aa.CodingIndex,
							"agentic":      aa.AgenticIndex,
						}
					}
				}
				if len(existing.Ranks) == 0 {
					for _, r := range m.Benchmarks.DesignArena {
						existing.Ranks = append(existing.Ranks, RankEntry{Label: r.Category, Rank: r.Rank})
					}
					if len(existing.Ranks) > 3 {
						existing.Ranks = existing.Ranks[:3]
					}
				}
				registry[fam] = existing
			}
		}
	}

	// GitHub: only ADDS missing fields (context, capabilities).
	if gh := fetchGitHubModels(""); gh != nil {
		for _, m := range gh {
			fam := MakeFamily(m.RawID)
			existing, ok := registry[fam]
			if !ok {
				existing = familyMeta{}
			}
			if existing.Context == 0 {
				existing.Context = m.ContextLength
			}
			for _, c := range m.Caps {
				existing.Capabilities = appendUnique(existing.Capabilities, c)
			}
			registry[fam] = existing
		}
	}

	return registry
}

// ── helpers ────────────────────────────────────────────────────────────────

func sortedProviderNames(catalog map[string]ProviderConfig) []string {
	names := make([]string, 0, len(catalog))
	for name := range catalog {
		names = append(names, name)
	}
	sort.Slice(names, func(i, j int) bool {
		pi, pj := providerPriorityIndex(names[i]), providerPriorityIndex(names[j])
		if pi != pj {
			return pi < pj
		}
		return names[i] < names[j]
	})
	return names
}

func sortEnriched(models []EnrichedModel) {
	sort.SliceStable(models, func(i, j int) bool {
		ei, ej := models[i], models[j]
		// free first, then name (provider view is a flat ranked list).
		if ei.IsFree != ej.IsFree {
			return ei.IsFree
		}
		if ei.ContextLength != ej.ContextLength {
			return ei.ContextLength > ej.ContextLength
		}
		return ei.DisplayName < ej.DisplayName
	})
}

func sortHosts(hosts []HostRoute) {
	sort.SliceStable(hosts, func(i, j int) bool {
		// Available (hasApiKey) hosts first, then default priority.
		if hosts[i].HasAPIKey != hosts[j].HasAPIKey {
			return hosts[i].HasAPIKey
		}
		if hosts[i].DefaultPriority != hosts[j].DefaultPriority {
			return hosts[i].DefaultPriority < hosts[j].DefaultPriority
		}
		return hosts[i].Provider < hosts[j].Provider
	})
}

func sortLogical(models []LogicalModel, registry map[string]familyMeta) {
	score := func(m LogicalModel) (float64, int64, float64) {
		if m.Attributes != nil && m.Attributes.Benchmarks != nil {
			return m.Attributes.Benchmarks["intelligence"], m.ContextLength, m.Attributes.Benchmarks["coding"]
		}
		if meta, ok := registry[m.Family]; ok {
			return meta.Benchmarks["intelligence"], m.ContextLength, meta.Benchmarks["coding"]
		}
		return 0, m.ContextLength, 0
	}
	sort.SliceStable(models, func(i, j int) bool {
		iq, ict, icd := score(models[i])
		jq, jct, jcd := score(models[j])
		if iq != jq {
			return iq > jq
		}
		if ict != jct {
			return ict > jct
		}
		if icd != jcd {
			return icd > jcd
		}
		return models[i].DisplayName < models[j].DisplayName
	})
}

func normalizeLevels(levels []string) []string {
	// Prefer the canonical 7-level ladder order when present.
	order := map[string]int{"none": 0, "minimal": 1, "low": 2, "medium": 3, "high": 4, "xhigh": 5, "max": 6, "on": 7, "off": 8}
	sort.SliceStable(levels, func(i, j int) bool {
		return order[levels[i]] < order[levels[j]]
	})
	return levels
}

func hasCapability(caps []string, want string) bool {
	for _, c := range caps {
		if strings.EqualFold(c, want) || strings.Contains(strings.ToLower(c), want) {
			return true
		}
	}
	return false
}

func appendUnique(list []string, v string) []string {
	for _, x := range list {
		if x == v {
			return list
		}
	}
	return append(list, v)
}

func parsePrice(s string) float64 {
	var f float64
	_, _ = fmt.Sscanf(strings.TrimSpace(s), "%g", &f)
	return f
}

// pricingString formats USD/token prices × 1M (old backend's format).
func pricingString(prompt, completion string, free bool) string {
	if free || (parsePrice(prompt) == 0 && parsePrice(completion) == 0) {
		return "$0 / $0 (free)"
	}
	return fmt.Sprintf("$%.2f / $%.2f per M", parsePrice(prompt)*1e6, parsePrice(completion)*1e6)
}

// dedupeLatest drops "-latest" ids when a specific sibling exists.
func dedupeLatest(models []fetchedModel) []fetchedModel {
	base := map[string]bool{}
	for _, m := range models {
		if !strings.HasSuffix(m.RawID, "-latest") {
			base[strings.TrimSuffix(m.RawID, "-latest")] = true
		}
	}
	var out []fetchedModel
	for _, m := range models {
		if strings.HasSuffix(m.RawID, "-latest") {
			if base[strings.TrimSuffix(m.RawID, "-latest")] {
				continue // specific variant exists — drop the latest alias
			}
		}
		out = append(out, m)
	}
	return out
}
