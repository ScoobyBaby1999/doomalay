// catalog.go embeds the provider catalog (providers.json) in the Go binary
// and syncs /v1/models directly — no Python brain needed. This lets the
// Android APK (which can't bundle Python) still show the provider list +
// model picker.
//
// Validation strategies (per provider, "validate" field in providers.json):
//   - "" / "models"    : GET {base_url}/models. 200 = valid (+model count).
//     401/403 = invalid. Anything else = "unverified" —
//     the key is saved but we could not confirm it.
//   - "auth_key"       : GET {base_url}{validate_path} (an endpoint that
//     REQUIRES auth, e.g. OpenRouter's /auth/key). This
//     is for providers whose /models is public.
//   - "chat_probe"     : POST {base_url}/chat/completions with probe_model
//     and max_tokens=1. Auth errors = invalid; quota or
//     model errors mean auth PASSED (the key is fine).
//
// The golden rule: never report "invalid" unless the provider itself said
// the key is bad. A valid key must never be shown as invalid (the v0.11
// bug: wrong base URLs made every key look invalid).
package llm

import (
	"embed"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/ScoobyBaby1999/doomalay/engine/internal/netx"
)

//go:embed catalog/providers.json
var catalogFS embed.FS

// ProviderConfig is one provider's config (matches brain/catalog/providers.json).
type ProviderConfig struct {
	EnvVar        string `json:"env_var"`
	BaseURL       string `json:"base_url"`
	LitellmPrefix string `json:"litellm_prefix"`
	Label         string `json:"label"`
	Description   string `json:"description"`
	SignupURL     string `json:"signup_url"`
	FreeTier      bool   `json:"free_tier"`
	Color         string `json:"color"`
	ExtraEnvVar   string `json:"extra_env_var,omitempty"`
	// AuthStyle: "bearer" (default) or "anthropic" (x-api-key + version).
	AuthStyle string `json:"auth_style,omitempty"`
	// Validate strategy: "" / "models" / "auth_key" / "chat_probe".
	Validate string `json:"validate,omitempty"`
	// ValidatePath is appended to base_url for the "auth_key" strategy.
	ValidatePath string `json:"validate_path,omitempty"`
	// ProbeModel is the model used for the "chat_probe" strategy.
	ProbeModel string `json:"probe_model,omitempty"`
}

// ModelInfo is one model from a provider's /v1/models endpoint.
type ModelInfo struct {
	ID       string `json:"id"`
	Provider string `json:"provider"`
	Label    string `json:"label"`
}

// SyncStatus is the per-provider sync result.
type SyncStatus struct {
	Provider   string `json:"provider"`
	HasKey     bool   `json:"has_key"`
	ModelCount int    `json:"model_count"`
	Error      string `json:"error,omitempty"`
}

// ModelsResponse is the full /api/models response.
type ModelsResponse struct {
	Providers   map[string]ProviderConfig `json:"providers"`
	Models      []ModelInfo               `json:"models"`
	SyncStatus  []SyncStatus              `json:"syncStatus"`
	TotalModels int                       `json:"totalModels"`
}

// LoadCatalog reads the embedded providers.json.
func LoadCatalog() (map[string]ProviderConfig, error) {
	data, err := fs.ReadFile(catalogFS, "catalog/providers.json")
	if err != nil {
		return nil, err
	}
	var catalog map[string]ProviderConfig
	if err := json.Unmarshal(data, &catalog); err != nil {
		return nil, err
	}
	return catalog, nil
}

// syncCache caches /v1/models results per provider (5 min TTL).
var (
	syncCacheMu  sync.RWMutex
	syncCache    = make(map[string]syncCacheEntry)
	syncCacheTTL = 5 * time.Minute
)

type syncCacheEntry struct {
	fetchedAt time.Time
	models    []ModelInfo
	err       error
}

// SyncModels fetches each provider's /v1/models endpoint. Keys is a map of
// env_var → api_key (from the secrets vault). If force is true, re-syncs all.
//
// This runs directly in Go — no Python brain needed. Each provider sync
// has a 10s timeout. Slow providers don't block the whole response.
func SyncModels(keys map[string]string, force bool) *ModelsResponse {
	catalog, err := LoadCatalog()
	if err != nil {
		return &ModelsResponse{
			Providers:   map[string]ProviderConfig{},
			Models:      []ModelInfo{},
			SyncStatus:  []SyncStatus{},
			TotalModels: 0,
		}
	}

	var allModels []ModelInfo
	var syncStatus []SyncStatus
	var mu sync.Mutex

	var wg sync.WaitGroup
	for name, cfg := range catalog {
		wg.Add(1)
		go func(name string, cfg ProviderConfig) {
			defer wg.Done()

			apiKey := keys[cfg.EnvVar]
			accountID := ""
			if cfg.ExtraEnvVar != "" {
				// Cloudflare needs the account ID too — check if we have it.
				accountID = keys[cfg.ExtraEnvVar]
				if accountID == "" {
					mu.Lock()
					syncStatus = append(syncStatus, SyncStatus{Provider: name, HasKey: false, ModelCount: 0})
					mu.Unlock()
					return
				}
			}
			if apiKey == "" {
				mu.Lock()
				syncStatus = append(syncStatus, SyncStatus{Provider: name, HasKey: false, ModelCount: 0})
				mu.Unlock()
				return
			}

			// Check cache.
			if !force {
				syncCacheMu.RLock()
				if entry, ok := syncCache[name]; ok && time.Since(entry.fetchedAt) < syncCacheTTL {
					syncCacheMu.RUnlock()
					mu.Lock()
					syncStatus = append(syncStatus, SyncStatus{Provider: name, HasKey: true, ModelCount: len(entry.models)})
					allModels = append(allModels, entry.models...)
					mu.Unlock()
					return
				}
				syncCacheMu.RUnlock()
			}

			// Fetch /v1/models.
			models, err := fetchProviderModels(name, cfg, apiKey, accountID)
			syncCacheMu.Lock()
			syncCache[name] = syncCacheEntry{fetchedAt: time.Now(), models: models, err: err}
			syncCacheMu.Unlock()

			mu.Lock()
			if err != nil {
				syncStatus = append(syncStatus, SyncStatus{Provider: name, HasKey: true, ModelCount: 0, Error: err.Error()})
			} else {
				syncStatus = append(syncStatus, SyncStatus{Provider: name, HasKey: true, ModelCount: len(models)})
				allModels = append(allModels, models...)
			}
			mu.Unlock()
		}(name, cfg)
	}
	wg.Wait()

	return &ModelsResponse{
		Providers:   catalog,
		Models:      allModels,
		SyncStatus:  syncStatus,
		TotalModels: len(allModels),
	}
}

// resolveBaseURL substitutes the {account_id} placeholder (Cloudflare).
func resolveBaseURL(cfg ProviderConfig, accountID string) string {
	if strings.Contains(cfg.BaseURL, "{account_id}") {
		if accountID == "" {
			accountID = "missing-account-id"
		}
		return strings.ReplaceAll(cfg.BaseURL, "{account_id}", accountID)
	}
	return cfg.BaseURL
}

// setAuthHeaders applies the provider's auth style to a request.
func setAuthHeaders(req *http.Request, cfg ProviderConfig, apiKey string) {
	if cfg.AuthStyle == "anthropic" {
		req.Header.Set("x-api-key", apiKey)
		req.Header.Set("anthropic-version", "2023-06-01")
		return
	}
	req.Header.Set("Authorization", "Bearer "+apiKey)
}

// fetchProviderModels calls the provider's /v1/models endpoint.
func fetchProviderModels(name string, cfg ProviderConfig, apiKey, accountID string) ([]ModelInfo, error) {
	url := resolveBaseURL(cfg, accountID) + "/models"
	req, err := http.NewRequest("GET", url, nil)
	if err != nil {
		return nil, err
	}
	// v0.13: browser-ish UA — several provider CDNs (Cloudflare-fronted)
	// challenge or block the default Go UA, which made valid keys look
	// "unverified" in v0.12.
	req.Header.Set("User-Agent", browserUA)
	req.Header.Set("Accept", "application/json")
	setAuthHeaders(req, cfg, apiKey)

	resp, err := providerHTTP.Do(req)
	if err != nil {
		return nil, fmt.Errorf("fetch: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("HTTP %d", resp.StatusCode)
	}

	body, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if err != nil {
		return nil, fmt.Errorf("read: %w", err)
	}

	var models []ModelInfo
	// Shape 1+2: {"data":[...]} / {"models":[...]}
	var data struct {
		Data []struct {
			ID   string `json:"id"`
			Name string `json:"name"`
		} `json:"data"`
		Models []struct {
			ID   string `json:"id"`
			Name string `json:"name"`
		} `json:"models"`
	}
	if err := json.Unmarshal(body, &data); err == nil {
		for _, m := range data.Data {
			models = append(models, modelInfoFrom(name, m.ID, m.Name))
		}
		for _, m := range data.Models {
			models = append(models, modelInfoFrom(name, m.ID, m.Name))
		}
	}
	// Shape 3: bare top-level array [{"id":...},...] (GitHub-style).
	if len(models) == 0 {
		var bare []struct {
			ID   string `json:"id"`
			Name string `json:"name"`
		}
		if err := json.Unmarshal(body, &bare); err == nil {
			for _, m := range bare {
				models = append(models, modelInfoFrom(name, m.ID, m.Name))
			}
		}
	}
	if len(models) == 0 {
		return nil, fmt.Errorf("no models parsed from response")
	}
	// Drop empty entries (ids that parsed to "").
	filtered := models[:0]
	for _, m := range models {
		if m.ID != "" {
			filtered = append(filtered, m)
		}
	}
	if len(filtered) == 0 {
		return nil, fmt.Errorf("no models parsed from response")
	}
	return filtered, nil
}

func modelInfoFrom(provider, id, name string) ModelInfo {
	realID := id
	if realID == "" {
		realID = name
	}
	if realID == "" {
		return ModelInfo{}
	}
	return ModelInfo{
		ID:       fmt.Sprintf("%s/%s", provider, realID),
		Provider: provider,
		Label:    realID,
	}
}

// ValidateResult is the outcome of a key check.
type ValidateResult struct {
	State      string `json:"state"` // "valid" | "invalid" | "unverified"
	Valid      bool   `json:"valid"` // true only for State == "valid"
	ModelCount int    `json:"model_count"`
	Reason     string `json:"reason,omitempty"`
}

// ValidateKey checks a stored key against the provider. keys is the full
// vault env map (so extra env vars like CLOUDFLARE_ACCOUNT_ID are available).
//
// Only reports "invalid" when the provider explicitly rejects the key.
func ValidateKey(envVar string, keys map[string]string) ValidateResult {
	apiKey := keys[envVar]
	if apiKey == "" {
		return ValidateResult{State: "invalid", Reason: "no key stored for " + envVar}
	}
	catalog, err := LoadCatalog()
	if err != nil {
		return ValidateResult{State: "unverified", Reason: "load catalog: " + err.Error()}
	}
	var cfg ProviderConfig
	var providerName string
	found := false
	for name, c := range catalog {
		if c.EnvVar == envVar {
			cfg, providerName, found = c, name, true
			break
		}
	}
	if !found {
		return ValidateResult{State: "invalid", Reason: "unknown env_var: " + envVar}
	}
	accountID := keys[cfg.ExtraEnvVar]

	// v0.14: netx transport — the DoH fallback that makes validation work
	// on Android (the pure-Go resolver has no /etc/resolv.conf there).
	client := &http.Client{Timeout: 12 * time.Second, Transport: netx.Transport()}

	switch cfg.Validate {
	case "auth_key":
		// An endpoint that requires auth (e.g. OpenRouter /auth/key).
		url := strings.TrimSuffix(resolveBaseURL(cfg, accountID), "/") + cfg.ValidatePath
		req, err := http.NewRequest("GET", url, nil)
		if err != nil {
			return ValidateResult{State: "unverified", Reason: err.Error()}
		}
		req.Header.Set("User-Agent", browserUA)
		req.Header.Set("Accept", "application/json")
		setAuthHeaders(req, cfg, apiKey)
		resp, err := client.Do(req)
		if err != nil {
			return ValidateResult{State: "unverified", Reason: "network: " + err.Error()}
		}
		defer resp.Body.Close()
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		if resp.StatusCode == 200 {
			return ValidateResult{State: "valid", Valid: true}
		}
		if resp.StatusCode == 401 || resp.StatusCode == 403 {
			return ValidateResult{State: "invalid", Reason: fmt.Sprintf("HTTP %d: %s", resp.StatusCode, strings.TrimSpace(string(body)))}
		}
		return ValidateResult{State: "unverified", Reason: fmt.Sprintf("HTTP %d", resp.StatusCode)}

	case "chat_probe":
		// v0.15: probe a LADDER of models instead of one. Some keys
		// are fine but lack access to a specific model (free-tier
		// accounts can't use paid models and vice versa) — a single
		// 401 on ONE model must not damn the whole key. Order:
		//   1. the configured probe model,
		//   2. FREE models (work on any account) from the live list,
		//   3. the first model of the live list.
		// Verdicts: 200/429/402 = valid; 401/403 = the key was
		// rejected (invalid if any candidate says so); 404/410/400
		// = inconclusive for that model (keep trying, never
		// "invalid"); network error = unverified.
		candidates := probeCandidates(providerName, cfg, apiKey, accountID)
		if len(candidates) == 0 {
			return ValidateResult{State: "unverified", Reason: "no probe model available"}
		}
		var lastAuthErr, lastInconclusive string
		for _, probeModel := range candidates {
			res, tryNext := chatProbeResult(providerName, cfg, apiKey, accountID, probeModel)
			if res.State == "valid" {
				if probeModel != cfg.ProbeModel {
					extra := ""
					if res.Reason != "" {
						extra = " — " + res.Reason
					}
					res.Reason = "auth passed via " + probeModel + extra
				}
				return res
			}
			if res.State == "invalid" {
				lastAuthErr = res.Reason // a REAL key rejection — remember it
				continue
			}
			if tryNext {
				lastInconclusive = res.Reason // model-level error — keep trying
				continue
			}
			return res // network error — can't judge
		}
		if lastAuthErr != "" {
			// At least one model ran the auth check and the
			// provider rejected the key.
			return ValidateResult{State: "invalid", Reason: lastAuthErr}
		}
		if lastInconclusive != "" {
			// No candidate reached the auth layer (all model-level
			// errors) — can't confirm either way.
			return ValidateResult{State: "unverified", Reason: lastInconclusive}
		}
		return ValidateResult{State: "unverified", Reason: "probe ladder exhausted"}

	default:
		// GET {base_url}/models. Some providers return 200 without
		// checking the key (public lists) — those always pass, which
		// is the safe direction: a real key is never called invalid.
		models, err := fetchProviderModels(providerName, cfg, apiKey, accountID)
		if err == nil {
			return ValidateResult{State: "valid", Valid: true, ModelCount: len(models)}
		}
		errStr := err.Error()
		if strings.Contains(errStr, "HTTP 401") || strings.Contains(errStr, "HTTP 403") {
			return ValidateResult{State: "invalid", Reason: errStr}
		}
		// v0.13: 429 means auth PASSED — the provider knows the key
		// and is rate limiting. Never show a working key as broken.
		if strings.Contains(errStr, "HTTP 429") {
			return ValidateResult{State: "valid", Valid: true, Reason: "rate-limited (auth passed)"}
		}
		// v0.13 MULTI-STRATEGY FALLBACK: the models endpoint glitched
		// (timeout, shape change, transient 5xx) — before declaring
		// "unverified", run a chat probe. Auth errors = invalid;
		// anything else = the key is fine. This kills the v0.12
		// yellow-"unverified" dead-end that also blocked auto-pick.
		if probeCfg, ok := probeModelFor(providerName, models); ok {
			if probe, tryNext := chatProbeResult(providerName, cfg, apiKey, accountID, probeCfg); tryNext || probe.State != "unverified" {
				return probe
			}
		}
		return ValidateResult{State: "unverified", Reason: errStr}
	}
}

// probeModelFor picks a model for the chat-probe fallback: the provider's
// configured probe_model, else the first synced model, else a live fetch.
func probeModelFor(provider string, models []ModelInfo) (string, bool) {
	catalog, err := LoadCatalog()
	if err != nil {
		return "", false
	}
	if cfg, ok := catalog[provider]; ok && cfg.ProbeModel != "" {
		return cfg.ProbeModel, true
	}
	if len(models) > 0 {
		return models[0].Label, true
	}
	// No cached models — try a keyless public sync for the probe id.
	if cfg, ok := catalog[provider]; ok {
		if fetched, err := fetchProviderModels(provider, cfg, "", ""); err == nil && len(fetched) > 0 {
			return fetched[0].Label, true
		}
	}
	return "", false
}

// chatProbeResult POSTs a 1-token completion with one model.
//
// Verdict honesty (v0.15 refinement): some providers check the MODEL before
// the key (NVIDIA returns 404/410 for retired models even with a garbage
// key), so "any non-401 = auth passed" was too loose — a bad key probed
// against a dead model looked VALID. Now:
//
//	200 / 429 / 402      → auth passed (rate/billing errors prove the key)
//	401 / 403            → the provider rejected the key for THIS model
//	404 / 410 / 400 / 5xx → inconclusive (model-level or shape error) —
//	                       try the next candidate; if none resolve,
//	                       the validator reports unverified, not valid.
func chatProbeResult(provider string, cfg ProviderConfig, apiKey, accountID, probeModel string) (ValidateResult, bool) {
	payload := map[string]any{
		"model":      probeModel,
		"messages":   []map[string]string{{"role": "user", "content": "hi"}},
		"max_tokens": 1,
	}
	// v0.25: provider quirks ride along (opencode needs x-session-id for
	// its free-tier models — probing big-pickle without it always 400s).
	status, body, err := httpPostJSON(resolveBaseURL(cfg, accountID)+"/chat/completions", apiKey, payload, providerExtraHeaders(provider, apiKey))
	if err != nil {
		return ValidateResult{State: "unverified", Reason: "network: " + err.Error()}, false
	}
	bodyStr := friendlyProviderError(status, body)
	switch {
	case status == 200:
		return ValidateResult{State: "valid", Valid: true}, true
	case status == 429 || status == 402:
		// Rate limit / billing — the auth layer RAN and accepted the key.
		return ValidateResult{State: "valid", Valid: true, Reason: bodyStr}, true
	case status == 401 || status == 403:
		return ValidateResult{State: "invalid", Reason: bodyStr}, true
	default:
		// Inconclusive — this model didn't reach the auth check.
		return ValidateResult{State: "unverified", Reason: "probe " + probeModel + ": " + bodyStr}, true
	}
}

// probeCandidates builds the model ladder for the chat_probe strategy.
func probeCandidates(provider string, cfg ProviderConfig, apiKey, accountID string) []string {
	var out []string
	seen := map[string]bool{}
	add := func(id string) {
		if id == "" || seen[id] {
			return
		}
		seen[id] = true
		out = append(out, id)
	}
	add(cfg.ProbeModel)

	// v0.16: NVIDIA NIM is account-gated per model ("Function not found
	// for account") — many catalog models 404 for a given key while a
	// live-verified set always serves. Insert those right after the
	// configured probe so a valid key never lands on "unverified".
	for _, kg := range knownGoodProbes(provider) {
		add(kg)
	}

	// Live model list (best-effort; keyless for public lists). Prefer
	// FREE models — they work on zero-credit accounts.
	if fetched, err := fetchProviderModels(provider, cfg, apiKey, accountID); err == nil {
		for _, m := range fetched {
			if isFreeProbeModel(provider, m.Label) {
				add(m.Label)
			}
		}
		if len(out) == 0 {
			add(fetched[0].Label)
		} else {
			add(fetched[0].Label) // any-model fallback last
		}
	}
	return out
}

// knownGoodProbes — live-verified (2026-09-14) models that served real chat
// completions on a fresh NVIDIA key when ~70% of the catalog was account-404.
// Used by the probe ladder AND by the frontend auto-pick preference list.
func knownGoodProbes(provider string) []string {
	if provider == "nvidia" {
		return []string{
			"nvidia/nemotron-3.5-lightning-30b-a3b",
			"nvidia/nemotron-3-super-120b-a12b",
			"z-ai/glm-5.3-flash",
			"openai/gpt-oss-20b",
			"nvidia/nemotron-3-ultra-550b-a55b",
			"google/gemma-4-31b-it",
		}
	}
	// v0.25: OpenCode Zen — the FREE models only. kimi-k2.6 (the old probe
	// model) is PAID on zen: a keyless-of-payment account gets CreditsError
	// "No payment method …/billing" — the exact message users mistook for
	// "my key needs billing enabled". big-pickle + the *-free set serve on
	// any valid key (with the x-session-id header).
	if provider == "opencode" {
		return []string{
			"big-pickle",
			"nemotron-3.5-lightning-free",
			"deepseek-v4-flash-free",
			"mimo-v2.5-free",
		}
	}
	return nil
}

// isFreeProbeModel knows the per-provider free-model rules (probe ladder only).
func isFreeProbeModel(provider, modelID string) bool {
	switch provider {
	case "opencode":
		// Zen free models: big-pickle + "-free" suffix, minus the
		// known paid exceptions.
		if modelID == "big-pickle" {
			return true
		}
		if strings.HasSuffix(modelID, "-free") &&
			modelID != "minimax-m3-free" && modelID != "qwen3.6-plus-free" {
			return true
		}
		return false
	case "nvidia":
		// v0.15: NVIDIA NIM models default to FREE (user-verified:
		// build.nvidia.com exposes free endpoints for ~all listed
		// models, e.g. Kimi K3).
		return true
	}
	return false
}

// friendlyProviderError extracts the human message from an OpenAI-style
// error body ({"error":{"message":"Invalid API key."}}) so badges read
// "Invalid API key" instead of a wall of JSON.
func friendlyProviderError(status int, body []byte) string {
	raw := strings.TrimSpace(string(body))
	if raw == "" {
		return fmt.Sprintf("HTTP %d", status)
	}
	var shaped struct {
		Error struct {
			Message string `json:"message"`
		} `json:"error"`
		Detail  string `json:"detail"`
		Title   string `json:"title"`
		Message string `json:"message"`
	}
	if json.Unmarshal(body, &shaped) == nil {
		if shaped.Error.Message != "" {
			return fmt.Sprintf("HTTP %d: %s", status, shaped.Error.Message)
		}
		if shaped.Message != "" {
			return fmt.Sprintf("HTTP %d: %s", status, shaped.Message)
		}
		if shaped.Detail != "" {
			return fmt.Sprintf("HTTP %d: %s", status, shaped.Detail)
		}
	}
	if len(raw) > 160 {
		raw = raw[:160] + "…"
	}
	return fmt.Sprintf("HTTP %d: %s", status, raw)
}

// ResolveModel resolves a user-facing model id (e.g. "openrouter/auto")
// to (model, base_url, env_var, api_key, auth_style). Used by the direct LLM proxy.
func ResolveModel(userModel, userProvider string, keys map[string]string) (model, baseURL, envVar, apiKey, authStyle string, err error) {
	catalog, err := LoadCatalog()
	if err != nil {
		return "", "", "", "", "", err
	}
	// v0.14: local models (picked via LocalModelsScreen) resolve to the
	// on-device / LAN Ollama server. Ollama speaks the OpenAI-compatible
	// /v1 chat shape; no key required. Previously this path died with
	// "unknown provider: ollama" before a single token could stream.
	if userProvider == "ollama" || userProvider == "local" {
		model = strings.TrimPrefix(userModel, userProvider+"/")
		return model, "http://127.0.0.1:11434/v1", "OLLAMA", "", "", nil
	}
	cfg, ok := catalog[userProvider]
	if !ok {
		return "", "", "", "", "", fmt.Errorf("unknown provider: %s", userProvider)
	}
	envVar = cfg.EnvVar
	apiKey = keys[envVar]
	if apiKey == "" {
		return "", "", "", "", "", fmt.Errorf("no API key for %s", envVar)
	}
	accountID := keys[cfg.ExtraEnvVar]
	baseURL = resolveBaseURL(cfg, accountID)
	authStyle = cfg.AuthStyle

	// SyncModels prefixes model IDs with the provider name
	// ("openrouter/llama-3.3-70b"). The provider's own API expects the
	// bare ID — strip our prefix. (v0.11 bug: the prefix was sent as-is.)
	model = strings.TrimPrefix(userModel, userProvider+"/")
	// Cloudflare model IDs keep their native "@cf/vendor/model" shape —
	// nothing else to strip.
	return model, baseURL, envVar, apiKey, authStyle, nil
}
