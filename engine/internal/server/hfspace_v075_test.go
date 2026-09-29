package server

import (
        "context"
        "net/http"
        "net/http/httptest"
        "strings"
        "sync"
        "testing"

        "github.com/ScoobyBaby1999/doomalay/engine/internal/brain"
        "github.com/ScoobyBaby1999/doomalay/engine/internal/config"
        "github.com/ScoobyBaby1999/doomalay/engine/internal/store"
)

// ── v0.75 Phase 1: key-in-flight minimization ─────────────────────────────

// newV075TurnEnvServer — a Server with a vault holding MANY provider keys
// (the v0.74 shape: one leaked request used to carry them ALL).
func newV075TurnEnvServer(t *testing.T) *Server {
        t.Helper()
        dir := t.TempDir()
        db, err := store.Open(dir)
        if err != nil {
                t.Fatalf("store: %v", err)
        }
        if err := db.Migrate(); err != nil {
                t.Fatalf("migrate: %v", err)
        }
        cfg := &config.Config{DataDir: dir}
        s := New(cfg, db, nil)
        for k, v := range map[string]string{
                "NVIDIA_API_KEY":     "nvapi-key-for-nvidia-sentinel",
                "OPENAI_API_KEY":     "sk-key-for-openai-sentinel123",
                "OPENROUTER_API_KEY": "sk-or-key-sentinel-abcdefg",
                "PRIVATEMODEAI_API_KEY": "pm-key-sentinel-0123456789abcdef",
                "DEEPSEEK_API_KEY":   "ds-key-sentinel-0123456789",
                "CLOUDFLARE_API_KEY": "cf-key-sentinel-01234567",
                "CLOUDFLARE_ACCOUNT_ID": "cf-account-sentinel",
                "GITHUB_PAT":         "ghp_github-sentinel-pat-token123456",
                "DOOMALAY_HF_TOKEN":  "hf_hub-sentinel-token-1234567890",
                // a shapeless sentinel for the exact-value redaction pass:
                "TAVILY_API_KEY":      "ZzyGgTtRr1212zzzQQQwwee",
        } {
                if err := s.vault.Set(k, "", v, ""); err != nil {
                        t.Fatalf("vault set %s: %v", k, err)
                }
        }
        s.refreshRedactVals()
        return s
}

// TestTurnRemoteEnvScopesToTheTurnsProvider — THE structural fix: a
// third-party turn carries ONLY the resolved provider's key (+extra) and
// the HF tokens. The other six keys never leave the device.
func TestTurnRemoteEnvScopesToTheTurnsProvider(t *testing.T) {
        s := newV075TurnEnvServer(t)
        sess := &store.Session{Provider: "nvidia", Model: "nvidia/z-ai/glm-5.3-flash"}
        env := s.turnRemoteEnv(sess)

        if env["NVIDIA_API_KEY"] != "nvapi-key-for-nvidia-sentinel" {
                t.Errorf("the turn's provider key must ride: %v", env)
        }
        for _, banned := range []string{
                "OPENAI_API_KEY", "OPENROUTER_API_KEY", "PRIVATEMODEAI_API_KEY",
                "DEEPSEEK_API_KEY", "CLOUDFLARE_API_KEY", "GITHUB_PAT",
        } {
                if _, ok := env[banned]; ok {
                        t.Errorf("key %s leaked to the third-party turn env (v0.74 structural finding alive)", banned)
                }
        }
        if env["DOOMALAY_HF_TOKEN"] != "hf_hub-sentinel-token-1234567890" {
                t.Errorf("the HF token must ride (hf-token-auth + dt_hf): %v", env)
        }
}

// TestTurnRemoteEnvExtraField — the provider's EXTRA (cloudflare account)
// rides alongside its key, and no one else's.
func TestTurnRemoteEnvExtraField(t *testing.T) {
        s := newV075TurnEnvServer(t)
        env := s.turnRemoteEnv(&store.Session{Provider: "cloudflare", Model: "cf/x"})
        if env["CLOUDFLARE_API_KEY"] == "" || env["CLOUDFLARE_ACCOUNT_ID"] == "" {
                t.Errorf("cloudflare needs key + account extra: %v", env)
        }
        if _, ok := env["NVIDIA_API_KEY"]; ok {
                t.Errorf("nvidia key leaked on a cloudflare turn")
        }
}

// TestTurnRemoteEnvProviderPrefixFallback — a session with no provider
// field resolves from the model id's prefix ("nvidia/…" style).
func TestTurnRemoteEnvProviderPrefixFallback(t *testing.T) {
        s := newV075TurnEnvServer(t)
        env := s.turnRemoteEnv(&store.Session{Model: "nvidia/z-ai/glm-5.3-flash"})
        if env["NVIDIA_API_KEY"] == "" {
                t.Errorf("prefix fallback failed: %v", env)
        }
}

// TestTurnRemoteEnvUnknownProviderNeverWorse — an unresolvable provider
// keeps the filtered third-party set (the v0.74 shape), never the vault.
func TestTurnRemoteEnvUnknownProviderNeverWorse(t *testing.T) {
        s := newV075TurnEnvServer(t)
        env := s.turnRemoteEnv(&store.Session{Provider: "mystery", Model: ""})
        if _, ok := env["GITHUB_PAT"]; ok {
                t.Errorf("unknown provider leaked GITHUB_PAT")
        }
        if env["NVIDIA_API_KEY"] == "" {
                t.Errorf("unknown provider should keep the BYOK set (never worse), got %v", env)
        }
}

// TestKeyedProviderNames — the /models presence list carries provider
// env-var NAMES only, no values, no HF tokens.
func TestKeyedProviderNames(t *testing.T) {
        s := newV075TurnEnvServer(t)
        names := keyedProviderNames(s.thirdPartyRemoteEnv())
        joined := strings.Join(names, ",")
        for _, want := range []string{"CLOUDFLARE_API_KEY", "DEEPSEEK_API_KEY", "NVIDIA_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY", "PRIVATEMODEAI_API_KEY"} {
                if !strings.Contains(joined, want) {
                        t.Errorf("presence list missing %s: %v", want, names)
                }
        }
        for _, banned := range []string{"GITHUB_PAT", "HF_TOKEN", "DOOMALAY_HF_TOKEN", "_EXTRA"} {
                if strings.Contains(joined, banned) {
                        t.Errorf("presence list carries %s (values/tokens/forges must not): %v", banned, names)
                }
        }
}

// TestRemoteBrainChatSendsExactlyTheTurnEnv — the wire proof: a mock space
// echoes the X-Env-* headers it received; the shared-mode Chat call must
// carry EXACTLY the scoped set.
func TestRemoteBrainChatSendsExactlyTheTurnEnv(t *testing.T) {
        var mu sync.Mutex
        var got []string
        space := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
                if r.URL.Path != "/chat" {
                        w.WriteHeader(200)
                        return
                }
                mu.Lock()
                got = nil
                for k := range r.Header {
                        if strings.HasPrefix(k, "X-Env-") {
                                got = append(got, strings.ToUpper(strings.TrimPrefix(k, "X-Env-")))
                        }
                }
                mu.Unlock()
                w.Header().Set("Content-Type", "text/event-stream")
                w.Write([]byte("data: [DONE]\n\n"))
        }))
        defer space.Close()

        s := newV075TurnEnvServer(t)
        rb := s.newSharedForTest(t, space.URL)
        turnEnv := s.turnRemoteEnv(&store.Session{Provider: "nvidia", Model: "nvidia/x"})
        if _, _, err := rb.Chat(context.Background(), map[string]any{"session_id": "t", "message": "m", "model": "nvidia/x"}, turnEnv); err != nil {
                t.Fatalf("chat: %v", err)
        }
        mu.Lock()
        defer mu.Unlock()
        joined := strings.Join(got, ",")
        if !strings.Contains(joined, "NVIDIA_API_KEY") {
                t.Errorf("the turn's provider key missing on the wire: %v", got)
        }
        for _, banned := range []string{"OPENAI_API_KEY", "GITHUB_PAT", "DEEPSEEK_API_KEY", "CLOUDFLARE_ACCOUNT_ID"} {
                if strings.Contains(joined, banned) {
                        t.Errorf("key %s crossed to the space (must be scoped to the turn)", banned)
                }
        }
}

// TestRemoteBrainModelsPresenceOnly — /models sends the keyed NAMES, never
// the values.
func TestRemoteBrainModelsPresenceOnly(t *testing.T) {
        var mu sync.Mutex
        var envVals, keyed string
        space := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
                mu.Lock()
                defer mu.Unlock()
                for k := range r.Header {
                        if strings.HasPrefix(k, "X-Env-") {
                                        envVals += k + "=" + r.Header.Get(k) + ";"
                        }
                }
                keyed = r.Header.Get("X-Keyed-Providers")
                w.WriteHeader(200)
                w.Write([]byte(`{"providers": {}}`))
        }))
        defer space.Close()

        s := newV075TurnEnvServer(t)
        rb := s.newSharedForTest(t, space.URL)
        rb.SetKeyedProviders(keyedProviderNames(s.thirdPartyRemoteEnv()))
        if _, err := rb.Models(context.Background()); err != nil {
                t.Fatalf("models: %v", err)
        }
        mu.Lock()
        defer mu.Unlock()
        if envVals != "" {
                t.Errorf("/models carried X-Env VALUES (must be presence-only): %s", envVals)
        }
        if !strings.Contains(keyed, "NVIDIA_API_KEY") {
                t.Errorf("X-Keyed-Providers missing the names: %q", keyed)
        }
}

// TestRemoteBrainProbeCarriesNoKeys — /health sends auth only.
func TestRemoteBrainProbeCarriesNoKeys(t *testing.T) {
        var mu sync.Mutex
        var envVals string
        space := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
                mu.Lock()
                defer mu.Unlock()
                for k := range r.Header {
                        if strings.HasPrefix(k, "X-Env-") {
                                envVals += k + ";"
                        }
                }
                w.WriteHeader(200)
                w.Write([]byte(`{"status": "ok"}`))
        }))
        defer space.Close()

        s := newV075TurnEnvServer(t)
        rb := s.newSharedForTest(t, space.URL)
        rb.SetEnv(s.thirdPartyRemoteEnv()) // the full BYOK set is loaded…
        if !rb.Probe() {
                t.Fatalf("probe should succeed")
        }
        mu.Lock()
        defer mu.Unlock()
        if envVals != "" {
                t.Errorf("the probe carried provider keys (health never reads them): %s", envVals)
        }
}

// ── v0.75 Phase 4: in-flight redaction ────────────────────────────────────

// TestRedactShapes — every key family dies, innocent text survives.
func TestRedactShapes(t *testing.T) {
        cases := map[string]string{
                "401 Unauthorized: Bearer sk-proj-abcdefghij1234567890abcdefghij": "401 Unauthorized: Bearer " + redactedKey,
                "nvidia says nvapi-ABCDEFGHIJKLMNOPQRSTUV invalid":                "nvidia says " + redactedKey + " invalid",
                "token hf_ABCDEFGHIJKLMNOPQRSTUVWXyz rejected":                    "token " + redactedKey + " rejected",
                "pat ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ12 revoked":                    "pat " + redactedKey + " revoked",
                "fine github_pat_11_ABCDEFGHIJKLMNOPQRSTUVWXYZ":                   "fine " + redactedKey,
                "url https://user:supersecret123@api.example.com/x":                "url https://user:" + redactedKey + "@api.example.com/x",
        }
        for in, want := range cases {
                if got := Redact(in); got != want {
                        t.Errorf("Redact(%q)\n  got  %s\n  want %s", in, got, want)
                }
        }
        if got := Redact("a normal error with no secrets"); got != "a normal error with no secrets" {
                t.Errorf("innocent text mangled: %q", got)
        }
}

// TestRedactVaultValues — the exact-value pass: a sentinel secret that
// matches NO shape still dies.
func TestRedactVaultValues(t *testing.T) {
        s := newV075TurnEnvServer(t)
        _ = s // refreshRedactVals already ran in the builder
        msg := "the space echoed back ZzyGgTtRr1212zzzQQQwwee and that should not survive"
        if got := Redact(msg); strings.Contains(got, "ZzyGgTtRr1212zzzQQQwwee") {
                t.Errorf("exact vault value survived redaction: %q", got)
        }
}

// newSharedForTest — a shared-mode RemoteBrain pointed at a test space.
func (s *Server) newSharedForTest(t *testing.T, url string) *brain.RemoteBrain {
        t.Helper()
        return brain.NewSharedRemoteBrain("test/shared", url, s.hfToken, s.thirdPartyRemoteEnv())
}
