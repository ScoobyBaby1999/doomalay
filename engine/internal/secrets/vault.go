// Package secrets is the AES-256-GCM encrypted provider key vault.
//
// Keys live at ~/.local/share/doomalay/secrets.db (a separate SQLite file
// from the chat store, so it can have different backup/permissions). Each
// key is encrypted with a master key derived from:
//   1. The OS keychain if available (future — for now we use a passphrase)
//   2. A master passphrase stored in ~/.config/doomalay/master.key (random
//      32 bytes generated on first run, mode 0600)
//   3. The DOOMALAY_MASTER_KEY env var (for headless/cloud)
//
// On the HF Demo Engine, the same code runs but additionally mirrors each
// key to HF Space secrets via huggingface_hub (handled by the brain, which
// has the HF token — see brain/providers.py).
package secrets

import (
        "crypto/aes"
        "crypto/cipher"
        "crypto/rand"
        "crypto/sha256"
        "encoding/base64"
        "encoding/json"
        "errors"
        "fmt"
        "io"
        "os"
        "path/filepath"
        "sync"
        "time"
)

// Vault stores encrypted provider keys.
type Vault struct {
        mu       sync.RWMutex
        master   [32]byte // derived from keyfile/env
        keyStore map[string]*Entry // env_var -> entry (in-memory cache; persisted via Save)
        path     string // path to the JSON keystore file
}

// Entry is one stored secret.
type Entry struct {
        Provider    string `json:"provider"`
        EnvVar      string `json:"env_var"`
        KeyCipher   string `json:"key_cipher"`   // base64
        KeyNonce    string `json:"key_nonce"`     // base64
        Extra       string `json:"extra,omitempty"`
        ExtraCipher string `json:"extra_cipher,omitempty"` // base64
        ExtraNonce  string `json:"extra_nonce,omitempty"`  // base64
        CreatedAt   float64 `json:"created_at"`
        UpdatedAt   float64 `json:"updated_at"`
}

// HasKey reports whether a key is set (for the GET /api/keys response).
// NEVER returns the key value itself.
type HasKey struct {
        EnvVar  string `json:"env_var"`
        Provider string `json:"provider"`
        HasKey  bool   `json:"has_key"`
        HasExtra bool  `json:"has_extra"`
}

// PROVIDER_KEY_ALLOWLIST is the security allowlist: users can only set
// these env vars, not arbitrary ones. Ported from the old db.PROVIDER_KEY_ALLOWLIST.
var PROVIDER_KEY_ALLOWLIST = map[string]string{
        "OPENROUTER_API_KEY":    "openrouter",
        "NVIDIA_API_KEY":        "nvidia",
        "OPENAI_API_KEY":        "openai",
        "ANTHROPIC_API_KEY":     "anthropic",
        "GROQ_API_KEY":          "groq",
        "CLOUDFLARE_API_KEY":    "cloudflare",
        "CLOUDFLARE_ACCOUNT_ID": "cloudflare", // extra field
        "GITHUB_MODELS_TOKEN":   "github-models",
        "TAVILY_API_KEY":        "tavily",
        "BRAVE_API_KEY":         "brave",
        "DEEPSEEK_API_KEY":      "deepseek",
        "TOGETHER_API_KEY":      "together",
        "MISTRAL_API_KEY":       "mistral",
        "COHERE_API_KEY":        "cohere",
        "PERPLEXITY_API_KEY":    "perplexity",
        "HUGGING_FACE_TOKEN":    "huggingface",
        "GITHUB_PAT":            "github", // for workspace cloning
        "GITEA_TOKEN":           "gitea",
}

// IsAllowed checks if an env var is in the allowlist.
func IsAllowed(envVar string) bool {
        _, ok := PROVIDER_KEY_ALLOWLIST[envVar]
        return ok
}

// ProviderFor returns the provider name for an env var, or "".
func ProviderFor(envVar string) string {
        return PROVIDER_KEY_ALLOWLIST[envVar]
}

// New creates or opens the vault at dataDir/secrets.json.
func New(dataDir string) (*Vault, error) {
        keystorePath := filepath.Join(dataDir, "secrets.json")
        masterKeyPath := filepath.Join(dataDir, "master.key")

        // Resolve the master key.
        var master [32]byte
        if env := os.Getenv("DOOMALAY_MASTER_KEY"); env != "" {
                h := sha256.Sum256([]byte(env))
                copy(master[:], h[:])
        } else if data, err := os.ReadFile(masterKeyPath); err == nil && len(data) == 32 {
                copy(master[:], data)
        } else {
                // Generate a new random master key.
                if _, err := rand.Read(master[:]); err != nil {
                        return nil, fmt.Errorf("generate master key: %w", err)
                }
                if err := os.WriteFile(masterKeyPath, master[:], 0o600); err != nil {
                        return nil, fmt.Errorf("write master key: %w", err)
                }
        }

        v := &Vault{
                master:   master,
                keyStore: make(map[string]*Entry),
                path:     keystorePath,
        }
        if err := v.load(); err != nil {
                return nil, err
        }
        return v, nil
}

func (v *Vault) load() error {
        data, err := os.ReadFile(v.path)
        if errors.Is(err, os.ErrNotExist) {
                return nil // fresh start
        }
        if err != nil {
                return err
        }
        return json.Unmarshal(data, &v.keyStore)
}

func (v *Vault) save() error {
        data, err := json.MarshalIndent(v.keyStore, "", "  ")
        if err != nil {
                return err
        }
        return os.WriteFile(v.path, data, 0o600)
}

// encrypt encrypts plaintext with AES-256-GCM. Returns (ciphertext, nonce), base64.
func (v *Vault) encrypt(plaintext string) (cipherB64, nonceB64 string, err error) {
        block, err := aes.NewCipher(v.master[:])
        if err != nil {
                return "", "", err
        }
        gcm, err := cipher.NewGCM(block)
        if err != nil {
                return "", "", err
        }
        nonce := make([]byte, gcm.NonceSize())
        if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
                return "", "", err
        }
        ct := gcm.Seal(nil, nonce, []byte(plaintext), nil)
        return base64.StdEncoding.EncodeToString(ct),
                base64.StdEncoding.EncodeToString(nonce), nil
}

// decrypt decrypts base64 ciphertext+nonce.
func (v *Vault) decrypt(cipherB64, nonceB64 string) (string, error) {
        ct, err := base64.StdEncoding.DecodeString(cipherB64)
        if err != nil {
                return "", err
        }
        nonce, err := base64.StdEncoding.DecodeString(nonceB64)
        if err != nil {
                return "", err
        }
        block, err := aes.NewCipher(v.master[:])
        if err != nil {
                return "", err
        }
        gcm, err := cipher.NewGCM(block)
        if err != nil {
                return "", err
        }
        pt, err := gcm.Open(nil, nonce, ct, nil)
        if err != nil {
                return "", err
        }
        return string(pt), nil
}

// Set stores a provider key. envVar must be in the allowlist.
func (v *Vault) Set(envVar, provider, key, extra string) error {
        if !IsAllowed(envVar) {
                return fmt.Errorf("env var %q not in allowlist", envVar)
        }
        if provider == "" {
                provider = ProviderFor(envVar)
        }
        v.mu.Lock()
        defer v.mu.Unlock()

        keyC, keyN, err := v.encrypt(key)
        if err != nil {
                return err
        }
        e := &Entry{
                Provider:  provider,
                EnvVar:    envVar,
                KeyCipher: keyC,
                KeyNonce:  keyN,
                Extra:     extra,
        }
        if extra != "" {
                ec, en, err := v.encrypt(extra)
                if err != nil {
                        return err
                }
                e.ExtraCipher = ec
                e.ExtraNonce = en
        }
        if existing, ok := v.keyStore[envVar]; ok {
                e.CreatedAt = existing.CreatedAt
        } else {
                e.CreatedAt = float64(time.Now().UnixMilli()) / 1000.0
        }
        e.UpdatedAt = float64(time.Now().UnixMilli()) / 1000.0
        v.keyStore[envVar] = e
        return v.save()
}

// Get returns the decrypted key (for the brain to use as an env var).
// Not exposed via the HTTP API — only the brain calls this internally.
func (v *Vault) Get(envVar string) (key, extra string, err error) {
        v.mu.RLock()
        e, ok := v.keyStore[envVar]
        v.mu.RUnlock()
        if !ok {
                return "", "", fmt.Errorf("no key for %s", envVar)
        }
        key, err = v.decrypt(e.KeyCipher, e.KeyNonce)
        if err != nil {
                return "", "", err
        }
        if e.ExtraCipher != "" {
                extra, err = v.decrypt(e.ExtraCipher, e.ExtraNonce)
        }
        return key, extra, err
}

// List returns which providers have keys (never the values).
func (v *Vault) List() []HasKey {
        v.mu.RLock()
        defer v.mu.RUnlock()
        out := make([]HasKey, 0, len(v.keyStore))
        for _, e := range v.keyStore {
                out = append(out, HasKey{
                        EnvVar:   e.EnvVar,
                        Provider: e.Provider,
                        HasKey:   e.KeyCipher != "",
                        HasExtra: e.ExtraCipher != "",
                })
        }
        return out
}

// Delete removes a key.
func (v *Vault) Delete(envVar string) error {
        v.mu.Lock()
        defer v.mu.Unlock()
        if _, ok := v.keyStore[envVar]; !ok {
                return fmt.Errorf("no key for %s", envVar)
        }
        delete(v.keyStore, envVar)
        return v.save()
}

// AsEnv returns all stored keys as a map suitable for setting as env vars
// when the brain spawns a subprocess. This is how provider keys reach the
// Python brain without ever touching the filesystem unencrypted.
func (v *Vault) AsEnv() map[string]string {
        v.mu.RLock()
        defer v.mu.RUnlock()
        env := make(map[string]string, len(v.keyStore))
        for envVar, e := range v.keyStore {
                if key, err := v.decrypt(e.KeyCipher, e.KeyNonce); err == nil {
                        env[envVar] = key
                }
                if e.ExtraCipher != "" {
                        if extra, err := v.decrypt(e.ExtraCipher, e.ExtraNonce); err == nil {
                                env[e.EnvVar+"_EXTRA"] = extra
                        }
                }
        }
        return env
}
