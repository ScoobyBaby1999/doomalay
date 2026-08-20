// catalog.go embeds the provider catalog (providers.json) in the Go binary
// and syncs /v1/models directly — no Python brain needed. This lets the
// Android APK (which can't bundle Python) still show the provider list +
// model picker.
package llm

import (
        "embed"
        "encoding/json"
        "fmt"
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
                        if cfg.ExtraEnvVar != "" {
                                // Cloudflare needs the account ID too — check if we have it.
                                if keys[cfg.ExtraEnvVar] == "" {
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
                        models, err := fetchProviderModels(name, cfg, apiKey)
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

// fetchProviderModels calls the provider's /v1/models endpoint.
func fetchProviderModels(name string, cfg ProviderConfig, apiKey string) ([]ModelInfo, error) {
        baseURL := cfg.BaseURL
        if cfg.ExtraEnvVar != "" {
                // Cloudflare: substitute account ID.
                // (Not implemented for direct proxy — Cloudflare needs the account ID
                // which we don't have in this context. Skip for now.)
        }

        url := baseURL + "/models"
        client := &http.Client{Timeout: 10 * time.Second}
        req, err := http.NewRequest("GET", url, nil)
        if err != nil {
                return nil, err
        }
        req.Header.Set("Authorization", "Bearer "+apiKey)

        resp, err := client.Do(req)
        if err != nil {
                return nil, fmt.Errorf("fetch: %w", err)
        }
        defer resp.Body.Close()

        if resp.StatusCode != 200 {
                return nil, fmt.Errorf("HTTP %d", resp.StatusCode)
        }

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
        if err := json.NewDecoder(resp.Body).Decode(&data); err != nil {
                return nil, fmt.Errorf("decode: %w", err)
        }

        var models []ModelInfo
        for _, m := range data.Data {
                id := m.ID
                if id == "" {
                        id = m.Name
                }
                if id == "" {
                        continue
                }
                models = append(models, ModelInfo{
                        ID:       fmt.Sprintf("%s/%s", name, id),
                        Provider: name,
                        Label:    id,
                })
        }
        for _, m := range data.Models {
                id := m.ID
                if id == "" {
                        id = m.Name
                }
                if id == "" {
                        continue
                }
                models = append(models, ModelInfo{
                        ID:       fmt.Sprintf("%s/%s", name, id),
                        Provider: name,
                        Label:    id,
                })
        }
        return models, nil
}

// ResolveModel resolves a user-facing model id (e.g. "openrouter/auto")
// to (litellm_model, base_url, env_var). Used by the direct LLM proxy.
func ResolveModel(userModel, userProvider string, keys map[string]string) (model, baseURL, envVar, apiKey string, err error) {
        catalog, err := LoadCatalog()
        if err != nil {
                return "", "", "", "", err
        }
        cfg, ok := catalog[userProvider]
        if !ok {
                return "", "", "", "", fmt.Errorf("unknown provider: %s", userProvider)
        }
        envVar = cfg.EnvVar
        baseURL = cfg.BaseURL
        apiKey = keys[envVar]
        if apiKey == "" {
                return "", "", "", "", fmt.Errorf("no API key for %s", envVar)
        }
        // If the model already has a provider prefix, use as-is.
        if strings.Contains(userModel, "/") {
                model = userModel
        } else {
                model = fmt.Sprintf("%s/%s", cfg.LitellmPrefix, userModel)
        }
        return model, baseURL, envVar, apiKey, nil
}

// ValidateKey pings the provider's /v1/models endpoint with the given API key
// to verify the key is valid. Returns (valid, modelCount, error).
// Used by the /api/keys/validate endpoint so the PWA can show ✓/✕ feedback
// when a user enters a key.
func ValidateKey(envVar, apiKey string) (bool, int, error) {
        if apiKey == "" {
                return false, 0, fmt.Errorf("no API key provided")
        }
        catalog, err := LoadCatalog()
        if err != nil {
                return false, 0, fmt.Errorf("load catalog: %w", err)
        }
        // Find the provider config for this env var.
        var cfg ProviderConfig
        var providerName string
        found := false
        for name, c := range catalog {
                if c.EnvVar == envVar {
                        cfg = c
                        providerName = name
                        found = true
                        break
                }
        }
        if !found {
                return false, 0, fmt.Errorf("unknown env_var: %s", envVar)
        }
        _ = providerName
        models, err := fetchProviderModels(providerName, cfg, apiKey)
        if err != nil {
                return false, 0, err
        }
        return true, len(models), nil
}
