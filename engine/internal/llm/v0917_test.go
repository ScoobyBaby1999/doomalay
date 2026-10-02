package llm

// v0917_test.go — THE MISTRAL WAVE pins (user spec: "add minstral without
// any static model lists, we want to fetch all their models dynamically as
// we do the other provider models").
//
// What these tests PIN:
//   1. fetchOpenAICompatible parses Mistral's DOCUMENTED /v1/models shape
//      (data[].id + max_context_length + capabilities{vision,function_calling})
//      — the enrichment rides the provider's own listing, the ids are never
//      static. Also the honest failures: no key → nil, 401 → nil (the
//      provider card shows unsynced, never a fake list).
//   2. The effort surface for a mistral model discovered DYNAMICALLY via
//      the OpenRouter registry (mistralai/mistral-medium-3-5 with the
//      documented binary reasoning_effort: high|none): "high" sends the
//      top-level param, "off" sends reasoning_effort:"none" — the binary
//      toggle the user described, driven entirely by live data.
//   3. Offline (registry unreachable): mistral models carry NO effort spec
//      → nothing is sent (the 400-safe path).

import (
        "encoding/json"
        "io"
        "net/http"
        "net/http/httptest"
        "testing"
)

// cannedMistralModels — Mistral's documented /v1/models response shape
// (docs.mistral.ai, live-researched 2026-10-02): data[] with id,
// max_context_length, and capabilities{completion_chat, function_calling,
// vision, ...}. The ids mirror the current lineup the research found
// (mistral-medium-3-5, the Z.ai GLM 5.3 third-party host, magistral) —
// but the ENGINE never hardcodes them: this is the wire shape only.
const cannedMistralModels = `{"object":"list","data":[
 {"id":"mistral-medium-3-5","object":"model","owned_by":"mistralai",
  "max_context_length":262144,
  "capabilities":{"completion_chat":true,"function_calling":true,"vision":true}},
 {"id":"glm-5.3","object":"model","owned_by":"zai",
  "max_context_length":1000000,
  "capabilities":{"completion_chat":true,"function_calling":true,"vision":false}},
 {"id":"magistral-medium-latest","object":"model","owned_by":"mistralai",
  "max_context_length":128000,
  "capabilities":{"completion_chat":true,"function_calling":false,"vision":false}}
]}`

func TestFetchOpenAICompatibleMistralShape(t *testing.T) {
        srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
                if r.URL.Path != "/v1/models" {
                        t.Errorf("unexpected path: %s", r.URL.Path)
                }
                if got := r.Header.Get("Authorization"); got != "Bearer test-key" {
                        t.Errorf("auth header missing/wrong: %q", got)
                }
                w.Header().Set("Content-Type", "application/json")
                io.WriteString(w, cannedMistralModels)
        }))
        defer srv.Close()

        cfg := ProviderConfig{BaseURL: srv.URL + "/v1", FreeTier: true}
        models := fetchOpenAICompatible("mistral", cfg, "test-key")
        if len(models) != 3 {
                t.Fatalf("want 3 models, got %d: %+v", len(models), models)
        }
        byID := map[string]fetchedModel{}
        for _, m := range models {
                byID[m.RawID] = m
        }
        mm := byID["mistral-medium-3-5"]
        if mm.ContextLength != 262144 {
                t.Errorf("mistral-medium-3-5 context: want 262144, got %d", mm.ContextLength)
        }
        if !hasString(mm.Caps, "vision") || !hasString(mm.Caps, "tools") {
                t.Errorf("mistral-medium-3-5 caps: want vision+tools, got %v", mm.Caps)
        }
        if !mm.IsFree {
                t.Errorf("free-tier provider should mark models free (pre-v0.91.7 semantics)")
        }
        glm := byID["glm-5.3"]
        if glm.ContextLength != 1000000 {
                t.Errorf("glm-5.3 context: want 1000000, got %d", glm.ContextLength)
        }
        if hasString(glm.Caps, "vision") {
                t.Errorf("glm-5.3 vision cap should be absent")
        }
        if !hasString(glm.Caps, "tools") {
                t.Errorf("glm-5.3 tools cap should be present")
        }
        if !byID["magistral-medium-latest"].SyncedLive {
                t.Errorf("models must be SyncedLive")
        }

        // the honest failures
        if got := fetchOpenAICompatible("mistral", cfg, ""); got != nil {
                t.Errorf("no key → nil, got %d models", len(got))
        }
        srv401 := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
                w.WriteHeader(http.StatusUnauthorized)
                io.WriteString(w, `{"detail":"Invalid API Key"}`)
        }))
        defer srv401.Close()
        cfg401 := ProviderConfig{BaseURL: srv401.URL + "/v1"}
        if got := fetchOpenAICompatible("mistral", cfg401, "bad-key"); got != nil {
                t.Errorf("401 → nil (unsynced card, never a fake list), got %d models", len(got))
        }
}

// TestOpenAICompatModelFieldUnion — the context-length field union parses
// each provider's spelling (groq context_window / together context_length /
// mistral max_context_length) without any per-provider switch.
func TestOpenAICompatModelFieldUnion(t *testing.T) {
        for _, tc := range []struct {
                json string
                ctx  int
        }{
                {`{"id":"llama-4-scout","context_window":131072}`, 131072},
                {`{"id":"deepseek-v4","context_length":163840}`, 163840},
                {`{"id":"mistral-small-2506","max_context_length":131000}`, 131000},
                {`{"id":"bare-model"}`, 0},
        } {
                var m openAICompatModel
                if err := json.Unmarshal([]byte(tc.json), &m); err != nil {
                        t.Fatalf("unmarshal %s: %v", tc.json, err)
                }
                out := m.toFetched(false)
                if out.ContextLength != int64(tc.ctx) {
                        t.Errorf("%s: context want %d got %d", tc.json, tc.ctx, out.ContextLength)
                }
        }
}

// TestMistralEffortBinaryToggle — the effort surface when the OR registry
// (live data) knows the model: mistral-medium-3-5's DOCUMENTED binary
// reasoning_effort (high|none) surfaces as the on/off toggle.
func TestMistralEffortBinaryToggle(t *testing.T) {
        // the registry entry the live OR API would serve for the model
        reg := `{"data":[
 {"id":"mistralai/mistral-medium-3-5","context_length":262144,
  "supported_parameters":["include_reasoning","reasoning","reasoning_effort","tools"],
  "reasoning":{"mandatory":false,"default_enabled":true,
   "supported_efforts":["high","none"],"default_effort":"high"}}
]}`
        srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
                io.WriteString(w, reg)
        }))
        defer srv.Close()
        useTestORRegistry(t, srv)

        // the resolved spec: binary levels, top-level param
        spec := ResolveEffort("mistral", "mistral-medium-3-5")
        if spec == nil || len(spec.Levels) == 0 {
                t.Fatal("no effort spec resolved from the OR registry")
        }
        if spec.Param != "reasoning_effort" {
                t.Errorf("mistral shape must be top-level reasoning_effort, got %q", spec.Param)
        }
        if !hasString(spec.Levels, "high") || !hasString(spec.Levels, "none") {
                t.Errorf("binary toggle levels [high none] missing: %v", spec.Levels)
        }

        // high → the param rides
        b := BuildEffortBodyFor("mistral", "mistral-medium-3-5", "high")
        if b == nil || b["reasoning_effort"] != "high" {
                t.Errorf("high should send reasoning_effort=high, got %v", b)
        }
        // off → the documented none (the binary toggle's other side)
        b = BuildEffortBodyFor("mistral", "mistral-medium-3-5", "off")
        if b == nil || b["reasoning_effort"] != "none" {
                t.Errorf("off should send reasoning_effort=none (the documented toggle), got %v", b)
        }
        // an unsupported level coerces into the ladder, never the raw value
        b = BuildEffortBodyFor("mistral", "mistral-medium-3-5", "max")
        if b == nil || b["reasoning_effort"] == "max" {
                t.Errorf("max must coerce (mistral documents high|none), got %v", b)
        }
}

// TestMistralEffortOfflineSendsNothing — registry unreachable + mistral not
// in any static blanket: NO param is sent (the 400-safe path).
func TestMistralEffortOfflineSendsNothing(t *testing.T) {
        useTestORRegistry(t, nil)
        if b := BuildEffortBodyFor("mistral", "mistral-medium-3-5", "high"); b != nil {
                t.Errorf("offline mistral must send nothing, got %v", b)
        }
        // and the catalog entry carries no static model data to fall back on
        catalog, err := LoadCatalog()
        if err != nil {
                t.Fatalf("load catalog: %v", err)
        }
        cfg, ok := catalog["mistral"]
        if !ok {
                t.Fatal("mistral missing from providers.json")
        }
        if cfg.EnvVar != "MISTRAL_API_KEY" || cfg.BaseURL != "https://api.mistral.ai/v1" {
                t.Errorf("mistral config should be pure wiring: %+v", cfg)
        }
        if cfg.ProbeModel != "" {
                t.Errorf("mistral carries a probe model — the list must stay fully dynamic")
        }
}
