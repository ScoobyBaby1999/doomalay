// catalog.go embeds the provider catalog (providers.json) in the Go binary
// and syncs /v1/models directly — no Python brain needed. This lets the
// Android APK (which can't bundle Python) still show the provider list +
// model picker.
//
// Validation strategies (per provider, "validate" field in providers.json):
//   - "" / "models"    : GET {base_url}/models. 200 = valid (+model count).
//                        401/403 = invalid. Anything else = "unverified" —
//                        the key is saved but we could not confirm it.
//   - "auth_key"       : GET {base_url}{validate_path} (an endpoint that
//                        REQUIRES auth, e.g. OpenRouter's /auth/key). This
//                        is for providers whose /models is public.
//   - "chat_probe"     : POST {base_url}/chat/completions with probe_model
//                        and max_tokens=1. Auth errors = invalid; quota or
//                        model errors mean auth PASSED (the key is fine).
//
// The golden rule: never report "invalid" unless the provider itself said
// the key is bad. A valid key must never be shown as invalid (the v0.11
// bug: wrong base URLs made every key look invalid).
package llm

import (
        "bytes"
        "embed"
        "encoding/json"
        "fmt"
        "io"
        "io/fs"
        "net/http"
        "strings"
        "sync"
        "time"
)

//go:embed catalog/providers.json
var catalogFS embed.FS

// ProviderConfig is one provider's config (matches brain/catalog/providers.json).
type ProviderConfig struct {
        EnvVar       string `json:"env_var"`
        BaseURL      string `json:"base_url"`
        LitellmPrefix string `json:"litellm_prefix"`
        Label        string `json:"label"`
        Description  string `json:"description"`
        SignupURL    string `json:"signup_url"`
        FreeTier     bool   `json:"free_tier"`
        Color        string `json:"color"`
        ExtraEnvVar  string `json:"extra_env_var,omitempty"`
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
        syncCacheMu sync.RWMutex
        syncCache   = make(map[string]syncCacheEntry)
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
        State      string `json:"state"`       // "valid" | "invalid" | "unverified"
        Valid      bool   `json:"valid"`       // true only for State == "valid"
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

        client := &http.Client{Timeout: 12 * time.Second}

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
                // POST a 1-token completion with a known model. Auth is checked
                // before quota/model errors, so: auth error = invalid key;
                // model/quota error = auth passed (key is fine).
                url := resolveBaseURL(cfg, accountID) + "/chat/completions"
                payload := map[string]any{
                        "model":      cfg.ProbeModel,
                        "messages":   []map[string]string{{"role": "user", "content": "hi"}},
                        "max_tokens": 1,
                }
                bodyBytes, _ := json.Marshal(payload)
                req, err := http.NewRequest("POST", url, bytes.NewReader(bodyBytes))
                if err != nil {
                        return ValidateResult{State: "unverified", Reason: err.Error()}
                }
                req.Header.Set("Content-Type", "application/json")
                req.Header.Set("User-Agent", browserUA)
                setAuthHeaders(req, cfg, apiKey)
                resp, err := client.Do(req)
                if err != nil {
                        return ValidateResult{State: "unverified", Reason: "network: " + err.Error()}
                }
                defer resp.Body.Close()
                body, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
                status := resp.StatusCode
                bodyStr := strings.TrimSpace(string(body))
                if status == 200 {
                        return ValidateResult{State: "valid", Valid: true}
                }
                if status == 401 || status == 403 {
                        return ValidateResult{State: "invalid", Reason: fmt.Sprintf("HTTP %d: %s", status, bodyStr)}
                }
                // Quota / model / billing errors all mean auth PASSED.
                return ValidateResult{State: "valid", Valid: true, Reason: bodyStr}

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
                        if probe, ok := chatProbe(providerName, cfg, apiKey, accountID, probeCfg); ok {
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

// chatProbe POSTs a 1-token completion. Auth checked before quota/model
// errors, so: 401/403 = invalid key; anything else = auth passed (valid).
func chatProbe(provider string, cfg ProviderConfig, apiKey, accountID, probeModel string) (ValidateResult, bool) {
        payload := map[string]any{
                "model":      probeModel,
                "messages":   []map[string]string{{"role": "user", "content": "hi"}},
                "max_tokens": 1,
        }
        status, body, err := httpPostJSON(resolveBaseURL(cfg, accountID)+"/chat/completions", apiKey, payload, nil)
        if err != nil {
                return ValidateResult{}, false // network down — can't judge
        }
        bodyStr := strings.TrimSpace(string(body))
        if status == 200 {
                return ValidateResult{State: "valid", Valid: true}, true
        }
        if status == 401 || status == 403 {
                return ValidateResult{State: "invalid", Reason: fmt.Sprintf("HTTP %d: %s", status, bodyStr)}, true
        }
        // Quota / model / billing errors all mean auth PASSED.
        return ValidateResult{State: "valid", Valid: true, Reason: "chat probe: auth passed (" + bodyStr + ")"}, true
}

// ResolveModel resolves a user-facing model id (e.g. "openrouter/auto")
// to (model, base_url, env_var, api_key, auth_style). Used by the direct LLM proxy.
func ResolveModel(userModel, userProvider string, keys map[string]string) (model, baseURL, envVar, apiKey, authStyle string, err error) {
        catalog, err := LoadCatalog()
        if err != nil {
                return "", "", "", "", "", err
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
