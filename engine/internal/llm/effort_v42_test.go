// effort_v42_test.go — the v0.42 dynamic effort registry tests.
//
// Everything here runs against a CANNED OpenRouter payload served by a local
// httptest server (or the pure parser) — NO network. The canned entries are
// trimmed copies of the LIVE /api/v1/models shape (verified 2026-06): ids
// with "~" aliases and ":batch"/":free" route variants, per-model
// "reasoning" objects with supported_efforts/default_effort/mandatory/
// default_enabled/supports_max_tokens, and supported_parameters carrying
// "reasoning_effort" exactly where the top-level enum is accepted.
package llm

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// cannedORModels mirrors the live OpenRouter models subset the resolution
// assertions depend on (trimmed but shape-identical).
const cannedORModels = `{"data":[
 {"id":"moonshotai/kimi-k2.6","context_length":262144,
  "supported_parameters":["include_reasoning","reasoning","tools"],
  "reasoning":{"mandatory":false,"default_enabled":true},
  "architecture":{"input_modalities":["text","image"]},
  "pricing":{"prompt":"0.00000095","completion":"0.000004"}},
 {"id":"moonshotai/kimi-k3","context_length":262144,
  "supported_parameters":["include_reasoning","reasoning","reasoning_effort","tools"],
  "reasoning":{"mandatory":false,"default_enabled":true,"supported_efforts":["max","high","low"],"default_effort":"max"},
  "architecture":{"input_modalities":["text","image"]}},
 {"id":"~moonshotai/kimi-latest","context_length":262144,
  "supported_parameters":["include_reasoning","reasoning","reasoning_effort","tools"],
  "reasoning":{"mandatory":false,"default_enabled":true,"supported_efforts":["max","high","low"],"default_effort":"max"}},
 {"id":"z-ai/glm-5.3","context_length":131072,
  "supported_parameters":["include_reasoning","reasoning","reasoning_effort","tools"],
  "reasoning":{"mandatory":true,"default_enabled":true,"supported_efforts":["max","high","low"],"default_effort":"max"}},
 {"id":"z-ai/glm-5.3-flash","context_length":131072,
  "supported_parameters":["include_reasoning","reasoning","reasoning_effort","tools"],
  "reasoning":{"mandatory":true,"default_enabled":true,"supported_efforts":["max","high","low"],"default_effort":"max"}},
 {"id":"openai/gpt-oss-120b","context_length":131072,
  "supported_parameters":["include_reasoning","reasoning","reasoning_effort","tools"],
  "reasoning":{"mandatory":true,"supported_efforts":["high","medium","low"],"default_effort":"medium"}},
 {"id":"openai/gpt-oss-120b:batch","context_length":131072,
  "supported_parameters":["include_reasoning","reasoning","reasoning_effort","tools"],
  "reasoning":{"mandatory":true,"supported_efforts":["high","medium","low"],"default_effort":"medium"}},
 {"id":"nvidia/nemotron-3.5-lightning","context_length":262144,
  "supported_parameters":["include_reasoning","reasoning","tools"],
  "reasoning":{"mandatory":false},
  "architecture":{"input_modalities":["text"]}},
 {"id":"nvidia/nemotron-3-super-120b-a12b","context_length":262144,
  "supported_parameters":["include_reasoning","reasoning","reasoning_effort","tools"],
  "reasoning":{"mandatory":false,"default_enabled":true,"supports_max_tokens":true,"supported_efforts":["medium","low"],"default_effort":"medium"}},
 {"id":"deepseek/deepseek-v4-pro","context_length":1000000,
  "supported_parameters":["include_reasoning","reasoning","reasoning_effort","tools"],
  "reasoning":{"mandatory":false,"supported_efforts":["xhigh","high"],"default_effort":"high"}},
 {"id":"anthropic/claude-fable-5","context_length":200000,
  "supported_parameters":["include_reasoning","reasoning","reasoning_effort","tools"],
  "reasoning":{"mandatory":true,"supported_efforts":["max","xhigh","high","medium","low"],"default_effort":"high"}},
 {"id":"google/gemma-4-31b-it","context_length":262144,
  "supported_parameters":["include_reasoning","reasoning","tools"],
  "reasoning":{"mandatory":false,"default_enabled":false}},
 {"id":"mistralai/mistral-large-2512:batch","context_length":131072,
  "supported_parameters":["tools"],
  "reasoning":null}
]}`

// useTestORRegistry points the registry at an httptest server serving the
// canned payload and resets the TTL cache; the previous state is restored on
// cleanup. nil server → an unreachable URL (the offline/fetch-failure path).
func useTestORRegistry(t *testing.T, srv *httptest.Server) {
	t.Helper()
	orRegMu.Lock()
	prevURL, prevCache, prevAt := openRouterModelsURL, orRegCache, orRegAt
	if srv != nil {
		openRouterModelsURL = srv.URL
	} else {
		openRouterModelsURL = "http://127.0.0.1:1/or-unreachable"
	}
	orRegCache, orRegAt = nil, time.Time{}
	orRegMu.Unlock()
	t.Cleanup(func() {
		orRegMu.Lock()
		openRouterModelsURL, orRegCache, orRegAt = prevURL, prevCache, prevAt
		orRegMu.Unlock()
	})
}

// startCannedOR serves the canned payload over HTTP (the real fetch path).
func startCannedOR(t *testing.T) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, cannedORModels)
	}))
	t.Cleanup(srv.Close)
	return srv
}

// cannedRegistry parses the canned payload directly (pure-parser tests).
func cannedRegistry(t *testing.T) map[string]*orModelMeta {
	t.Helper()
	reg := parseOpenRouterModels([]byte(cannedORModels))
	if len(reg) == 0 {
		t.Fatal("canned registry parsed empty")
	}
	return reg
}

// ── The pure registry parser ───────────────────────────────────────────────

func TestParseOpenRouterModelsV42(t *testing.T) {
	reg := cannedRegistry(t)
	// "~" alias ids collapse to the base id.
	if _, ok := reg["moonshotai/kimi-latest"]; !ok {
		t.Error("~moonshotai/kimi-latest should collapse to moonshotai/kimi-latest")
	}
	// ":batch"/":free" route variants collapse onto the base entry.
	if _, ok := reg["openai/gpt-oss-120b:batch"]; ok {
		t.Error(":batch variant must not be a separate registry key")
	}
	if reg["openai/gpt-oss-120b"] == nil {
		t.Error("openai/gpt-oss-120b missing after variant collapse")
	}
	if reg["mistralai/mistral-large-2512"] == nil {
		t.Error(":batch-only id should collapse to its base id")
	}
	// Reasoning objects parse with every documented field.
	glm := reg["z-ai/glm-5.3"]
	if glm == nil || glm.Reasoning == nil {
		t.Fatal("z-ai/glm-5.3 reasoning missing")
	}
	if glm.Reasoning.DefaultEnabled == nil || !*glm.Reasoning.DefaultEnabled {
		t.Errorf("glm-5.3 default_enabled should parse true, got %v", glm.Reasoning.DefaultEnabled)
	}
	if glm.Reasoning.DefaultEffort != "max" || len(glm.Reasoning.SupportedEfforts) != 3 {
		t.Errorf("glm-5.3 efforts wrong: %+v", glm.Reasoning)
	}
	sup := reg["nvidia/nemotron-3-super-120b-a12b"]
	if sup == nil || sup.Reasoning == nil || !sup.Reasoning.SupportsMaxTokens {
		t.Errorf("nemotron-3-super supports_max_tokens should parse, got %+v", sup)
	}
	if !hasString(sup.SupportedParameters, "reasoning_effort") {
		t.Error("nemotron-3-super supported_parameters should carry reasoning_effort")
	}
	// nil reasoning (no knob) parses as nil, not an empty object.
	if reg["mistralai/mistral-large-2512"].Reasoning != nil {
		t.Error("mistral-large reasoning should be nil (JSON null)")
	}
	// Garbage + empty input never panic.
	if m := parseOpenRouterModels(nil); len(m) != 0 {
		t.Error("empty body should parse to an empty map")
	}
	if m := parseOpenRouterModels([]byte("{not json")); len(m) != 0 {
		t.Error("garbage body should parse to an empty map")
	}
}

// ── The cross-provider family matcher ─────────────────────────────────────

func TestMatchOREntryV42(t *testing.T) {
	reg := cannedRegistry(t)
	cases := []struct {
		model string
		want  string // expected canonical OR id ("" = no match)
	}{
		{"moonshotai/kimi-k2.6", "moonshotai/kimi-k2.6"}, // exact id (the OR provider's own)
		{"kimi-k2.6", "moonshotai/kimi-k2.6"},            // bare id → last-segment (PrivateMode shape)
		{"kimi-latest", "moonshotai/kimi-latest"},        // PM's -latest alias → ~ collapsed entry
		{"z-ai/glm-5.3", "z-ai/glm-5.3"},                 // vendor+seg (NVIDIA shape)
		{"GLM-5.3", "z-ai/glm-5.3"},                      // case-insensitive (Together shape)
		{"glm-5.3-flash", "z-ai/glm-5.3-flash"},          // exact beats the glm-5.3 prefix
		{"gpt-oss-120b", "openai/gpt-oss-120b"},          // PM's bare + openai/ alias ids
		{"openai/gpt-oss-120b", "openai/gpt-oss-120b"},
		{"nvidia/nemotron-3.5-lightning-30b-a3b", "nvidia/nemotron-3.5-lightning"}, // NIM suffix id → prefix match
		{"nemotron-3-super-120b-a12b", "nvidia/nemotron-3-super-120b-a12b"},
		{"totally-unknown-model", ""},
		{"nvidia/nemotron-3-120b-a12b", ""}, // no prefix relation — must NOT fuzzy-match
	}
	for _, c := range cases {
		e := matchOREntry(reg, c.model)
		got := ""
		if e != nil {
			got = e.ID
		}
		if got != c.want {
			t.Errorf("matchOREntry(%q) = %q, want %q", c.model, got, c.want)
		}
	}
	if matchOREntry(reg, "") != nil || matchOREntry(nil, "kimi-k2.6") != nil {
		t.Error("empty model / empty registry must not match")
	}
}

// ── Resolution: the precedence chain + per-provider shapes ────────────────

func TestResolveEffortV42(t *testing.T) {
	useTestORRegistry(t, startCannedOR(t))
	cases := []struct {
		name      string
		provider  string
		model     string
		levels    string // comma-joined
		def       string
		mandatory bool
		param     string
		source    string
	}{
		// PrivateMode — the disappearing-toggle bug's models.
		{"pm kimi-k2.6 toggle", "privatemodeai", "kimi-k2.6", "on,off", "on", false, "chat_template_kwargs", "openrouter"},
		{"pm kimi-latest enum-but-kimi-shape", "privatemodeai", "kimi-latest", "low,high,max", "max", false, "chat_template_kwargs", "openrouter"},
		{"pm glm-5.3 mandatory enum", "privatemodeai", "glm-5.3", "low,high,max", "max", true, "reasoning_effort", "openrouter"},
		{"pm gpt-oss-120b enum", "privatemodeai", "gpt-oss-120b", "low,medium,high", "medium", true, "reasoning_effort", "openrouter"},
		// NVIDIA — the blanket-on/off complaint.
		{"nvidia lightning toggle (OR toggle-only)", "nvidia", "nvidia/nemotron-3.5-lightning-30b-a3b", "on,off", "on", false, "chat_template_kwargs", "openrouter"},
		{"nvidia super enum", "nvidia", "nvidia/nemotron-3-super-120b-a12b", "low,medium", "medium", false, "reasoning_effort", "openrouter"},
		{"nvidia kimi-k3 enum", "nvidia", "moonshotai/kimi-k3", "low,high,max", "max", false, "reasoning_effort", "openrouter"},
		{"nvidia gemma toggle default-off", "nvidia", "google/gemma-4-31b-it", "on,off", "off", false, "chat_template_kwargs", "openrouter"},
		{"nvidia unknown → blanket", "nvidia", "totally-unknown-model", "on,off", "on", false, "chat_template_kwargs", "provider-default"},
		// OpenRouter — its own list is authoritative.
		{"openrouter claude enum", "openrouter", "anthropic/claude-fable-5", "low,medium,high,xhigh,max", "high", true, "reasoning", "openrouter"},
		{"openrouter kimi toggle", "openrouter", "moonshotai/kimi-k2.6", "on,off", "on", false, "reasoning", "openrouter"},
		{"openrouter no-reasoning → NO ladder (the blanket fix)", "openrouter", "mistralai/mistral-large-2512", "", "", false, "", "openrouter"},
		{"openrouter bogus id → no knob", "openrouter", "bogus-model-id", "", "", false, "", ""},
		// Providers without a blanket AND without an OR match → [] (no button).
		{"together unknown → no levels", "together", "some-unknown-model", "", "", false, "", ""},
		// Cloudflare keeps the curated fallback path.
		{"cloudflare unknown → blanket + catalog shape", "cloudflare", "@cf/nvidia/nemotron-3-120b-a12b", "on,off", "on", false, "catalog", "provider-default"},
	}
	for _, c := range cases {
		spec := ResolveEffort(c.provider, c.model)
		got := strings.Join(spec.Levels, ",")
		if got != c.levels {
			t.Errorf("%s: levels = %q, want %q", c.name, got, c.levels)
		}
		if spec.Default != c.def {
			t.Errorf("%s: default = %q, want %q", c.name, spec.Default, c.def)
		}
		if spec.Mandatory != c.mandatory {
			t.Errorf("%s: mandatory = %v, want %v", c.name, spec.Mandatory, c.mandatory)
		}
		if spec.Param != c.param {
			t.Errorf("%s: param = %q, want %q", c.name, spec.Param, c.param)
		}
		if spec.Source != c.source {
			t.Errorf("%s: source = %q, want %q", c.name, spec.Source, c.source)
		}
	}
}

// TestResolveEffortPrecedenceV42 — SOURCE 1 (provider's own live surface)
// beats the OpenRouter family match; offline, the chain degrades to the
// blanket/curated fallbacks instead of losing the button.
func TestResolveEffortPrecedenceV42(t *testing.T) {
	useTestORRegistry(t, startCannedOR(t))

	// Live surface wins over the OR enum for the same model.
	live := &LiveEffortInfo{Levels: []string{"on", "off"}, Default: "on", Param: "chat_template_kwargs"}
	spec := ResolveEffortWithLive("privatemodeai", "glm-5.3", live)
	if strings.Join(spec.Levels, ",") != "on,off" || spec.Source != "provider-live" || spec.Param != "chat_template_kwargs" {
		t.Errorf("live surface should override OR: %+v", spec)
	}

	// Offline: the registry fetch fails and has never succeeded →
	// blankets/curated take over.
	useTestORRegistry(t, nil)
	spec = ResolveEffort("nvidia", "moonshotai/kimi-k2.6")
	if strings.Join(spec.Levels, ",") != "on,off" || spec.Source != "provider-default" {
		t.Errorf("offline nvidia should degrade to the blanket: %+v", spec)
	}
	spec = ResolveEffort("privatemodeai", "kimi-k2.6")
	if strings.Join(spec.Levels, ",") != "on,off" {
		t.Errorf("offline PM kimi should keep the toggle: %+v", spec)
	}
	spec = ResolveEffort("openrouter", "anthropic/claude-fable-5")
	if len(spec.Levels) != 7 || spec.Source != "catalog" {
		t.Errorf("offline openrouter should degrade to the curated ladder: %+v", spec)
	}
}

// ── Request building: the shape map + coercion ────────────────────────────

func TestBuildEffortBodyForV42(t *testing.T) {
	useTestORRegistry(t, startCannedOR(t))
	cases := []struct {
		name     string
		provider string
		model    string
		level    string
		want     string // JSON object or "null"
	}{
		// OpenRouter shapes.
		{"or enum effort", "openrouter", "anthropic/claude-fable-5", "high", `{"reasoning":{"effort":"high"}}`},
		{"or enum coercion", "openrouter", "anthropic/claude-fable-5", "banana", `{"reasoning":{"effort":"high"}}`},
		{"or toggle enabled", "openrouter", "moonshotai/kimi-k2.6", "on", `{"reasoning":{"enabled":true}}`},
		{"or toggle off → nothing", "openrouter", "moonshotai/kimi-k2.6", "off", "null"},
		// NVIDIA shapes.
		{"nvidia kimi on", "nvidia", "moonshotai/kimi-k2.6", "on", `{"chat_template_kwargs":{"thinking":true}}`},
		{"nvidia kimi off (documented disable)", "nvidia", "moonshotai/kimi-k2.6", "off", `{"chat_template_kwargs":{"thinking":false}}`},
		{"nvidia lightning coerce high→on", "nvidia", "nvidia/nemotron-3.5-lightning-30b-a3b", "high", `{"chat_template_kwargs":{"thinking":true}}`},
		{"nvidia super coerce high→medium", "nvidia", "nvidia/nemotron-3-super-120b-a12b", "high", `{"reasoning_effort":"medium"}`},
		{"nvidia gemma enable_thinking", "nvidia", "google/gemma-4-31b-it", "on", `{"chat_template_kwargs":{"enable_thinking":true}}`},
		{"nvidia unknown toggle", "nvidia", "totally-unknown-model-x", "high", `{"chat_template_kwargs":{"thinking":true}}`},
		// PrivateMode shapes (research 3-c: kimi thinking, glm/gpt-oss reasoning_effort).
		{"pm kimi on", "privatemodeai", "kimi-k2.6", "on", `{"chat_template_kwargs":{"thinking":true}}`},
		{"pm kimi off", "privatemodeai", "kimi-k2.6", "off", `{"chat_template_kwargs":{"thinking":false}}`},
		{"pm glm max", "privatemodeai", "glm-5.3", "max", `{"reasoning_effort":"max"}`},
		{"pm glm low", "privatemodeai", "glm-5.3", "low", `{"reasoning_effort":"low"}`},
		{"pm glm off — mandatory, never disable", "privatemodeai", "glm-5.3", "off", "null"},
		{"pm gpt-oss high", "privatemodeai", "gpt-oss-120b", "high", `{"reasoning_effort":"high"}`},
		{"pm kimi-latest enum level → kimi toggle shape", "privatemodeai", "kimi-latest", "high", `{"chat_template_kwargs":{"thinking":true}}`},
		// Provider-native vocabularies + coercion map (research 3-c).
		{"deepseek xhigh → high", "deepseek", "deepseek-v4-pro", "xhigh", `{"reasoning_effort":"high"}`},
		{"anthropic minimal → low", "anthropic", "claude-fable-5", "minimal", `{"effort":"low"}`},
		// OpenCode: v0.26 semantics — toggle families still dial via
		// reasoning_effort=high (the 400-net makes it safe).
		{"opencode enum", "opencode", "glm-5.3", "high", `{"reasoning_effort":"high"}`},
		{"opencode toggle → high", "opencode", "kimi-k2.6", "high", `{"reasoning_effort":"high"}`},
		{"opencode off → nothing", "opencode", "kimi-k2.6", "off", "null"},
		// Conservative providers + sentinels.
		{"github never sends", "github-models", "deepseek-r1", "high", "null"},
		{"no-knob model never sends", "openrouter", "mistralai/mistral-large-2512", "high", "null"},
		{"med sentinel sends nothing", "privatemodeai", "kimi-k2.6", "med", "null"},
		{"empty level sends nothing", "nvidia", "nvidia/nemotron-3-super-120b-a12b", "", "null"},
	}
	for _, c := range cases {
		body := BuildEffortBodyFor(c.provider, c.model, c.level)
		var got string
		if body == nil {
			got = "null"
		} else {
			b, err := json.Marshal(body)
			if err != nil {
				t.Fatalf("%s: marshal: %v", c.name, err)
			}
			got = string(b)
		}
		if got != c.want {
			t.Errorf("%s: body = %s, want %s", c.name, got, c.want)
		}
	}
}

// ── The PrivateMode chat-only filter ──────────────────────────────────────

// cannedPMModels mirrors the LIVE GET /v1/models payload (2026-06: tasks[]
// shape, kimi-k2.6 deprecated, whisper/embedding/voxtral non-chat entries).
const cannedPMModels = `{"object":"list","data":[
 {"id":"deepseek-ocr-2","object":"model","tasks":["generate","vision"]},
 {"id":"glm-5.3","object":"model","tasks":["generate","tool_calling"]},
 {"id":"glm-5.2","object":"model","tasks":["generate","tool_calling"]},
 {"id":"glm-latest","object":"model","tasks":["generate","tool_calling"]},
 {"id":"glm-5.3-flash","object":"model","tasks":["generate","tool_calling","vision"]},
 {"id":"glm-flash-latest","object":"model","tasks":["generate","tool_calling","vision"]},
 {"id":"openai/gpt-oss-120b","object":"model","tasks":["generate","tool_calling"]},
 {"id":"gpt-oss-120b","object":"model","tasks":["generate","tool_calling"]},
 {"id":"gpt-oss-latest","object":"model","tasks":["generate","tool_calling"]},
 {"id":"kimi-k2.6","object":"model","tasks":["generate","tool_calling","vision"]},
 {"id":"kimi-latest","object":"model","tasks":["generate","tool_calling","vision"]},
 {"id":"openai/whisper-large-v3","object":"model","tasks":["transcribe"]},
 {"id":"whisper-large-v3","object":"model","tasks":["transcribe"]},
 {"id":"qwen3-embedding-4b","object":"model","tasks":["embed"]},
 {"id":"voxtral-mini-3b","object":"model","tasks":["transcribe"]}
]}`

func TestFetchPrivateModeModelsChatOnlyV42(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") == "" {
			w.WriteHeader(401)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, cannedPMModels)
	}))
	t.Cleanup(srv.Close)
	prev := privateModeModelsURL
	privateModeModelsURL = srv.URL
	t.Cleanup(func() { privateModeModelsURL = prev })

	// No key → nil (PM requires auth).
	if fetchPrivateModeModels("") != nil {
		t.Error("empty key must return nil")
	}
	models := fetchPrivateModeModels("test-key")
	if models == nil {
		t.Fatal("keyed fetch failed")
	}
	got := map[string]bool{}
	for _, m := range models {
		got[m.RawID] = true
	}
	if len(models) != 11 {
		t.Errorf("want 11 chat models (tasks contains generate), got %d: %v", len(models), got)
	}
	for _, want := range []string{"kimi-k2.6", "kimi-latest", "glm-5.3", "glm-latest", "glm-5.3-flash", "glm-flash-latest", "gpt-oss-120b", "openai/gpt-oss-120b", "gpt-oss-latest", "glm-5.2", "deepseek-ocr-2"} {
		if !got[want] {
			t.Errorf("chat model %q missing", want)
		}
	}
	for _, banned := range []string{"whisper-large-v3", "openai/whisper-large-v3", "qwen3-embedding-4b", "voxtral-mini-3b"} {
		if got[banned] {
			t.Errorf("non-chat model %q must be filtered out (tasks[])", banned)
		}
	}

	// Older shape (no tasks[]) passes through untouched.
	oldShape := `{"data":[{"id":"legacy-kimi","max_context_length":256000}]}`
	srv2 := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, oldShape)
	}))
	t.Cleanup(srv2.Close)
	privateModeModelsURL = srv2.URL
	legacy := fetchPrivateModeModels("k")
	if len(legacy) != 1 || legacy[0].RawID != "legacy-kimi" || legacy[0].ContextLength != 256000 {
		t.Errorf("legacy no-tasks shape should pass through, got %+v", legacy)
	}
}

// ── Live key-state patching on the served catalog ─────────────────────────

func TestApplyLiveKeyStateV42(t *testing.T) {
	cat := &CatalogV2{
		Providers: map[string]ProviderConfig{
			"privatemodeai": {EnvVar: "PRIVATEMODEAI_API_KEY"},
			"nvidia":        {EnvVar: "NVIDIA_API_KEY"},
		},
		Groups: []ProviderGroup{
			{Name: "privatemodeai", EnvVar: "PRIVATEMODEAI_API_KEY", HasKey: false, ModelCount: 0, Models: []EnrichedModel{{ID: "privatemodeai/kimi-latest"}}},
			{Name: "nvidia", EnvVar: "NVIDIA_API_KEY", HasKey: true, ModelCount: 1, Models: []EnrichedModel{{ID: "nvidia/x"}}},
		},
		SyncStatus: []SyncStatus{
			{Provider: "privatemodeai", HasKey: false},
			{Provider: "nvidia", HasKey: true},
		},
		Logical: []LogicalModel{
			{Logical: "kimi-latest", Hosts: []HostRoute{
				{Provider: "privatemodeai", ModelID: "kimi-latest", HasAPIKey: false},
				{Provider: "nvidia", ModelID: "moonshotai/kimi-k2.6", HasAPIKey: true},
			}},
		},
	}
	// Key lands in the vault AFTER the entry was built (only PM's key —
	// nvidia's entry was built WITH its key, so it flips the other way).
	out := ApplyLiveKeyState(cat, map[string]string{"PRIVATEMODEAI_API_KEY": "k"})
	if !out.Groups[0].HasKey {
		t.Error("PM group hasApiKey should reflect the live vault")
	}
	if out.Groups[1].HasKey {
		t.Error("nvidia group hasApiKey should flip off when the vault lost the key")
	}
	if !out.SyncStatus[0].HasKey {
		t.Error("syncStatus has_key should reflect the live vault")
	}
	if !out.Logical[0].Hosts[0].HasAPIKey {
		t.Error("logical host route HasAPIKey should reflect the live vault")
	}
	if out.Logical[0].Hosts[0].Provider != "privatemodeai" || out.Logical[0].Hosts[1].Provider != "nvidia" || out.Logical[0].Hosts[1].HasAPIKey {
		t.Errorf("keyed host should sort first + unkeyed last, got %+v", out.Logical[0].Hosts)
	}
	if !out.Partial {
		t.Error("a changed key state must mark the response Partial (client re-polls)")
	}
	// No change → not partial, and the input catalog is never mutated.
	out2 := ApplyLiveKeyState(cat, map[string]string{"NVIDIA_API_KEY": "n"})
	if out2.Partial {
		t.Error("unchanged key state must not mark Partial")
	}
	if cat.Groups[0].HasKey || cat.Logical[0].Hosts[0].HasAPIKey || cat.Logical[0].Hosts[0].Provider != "privatemodeai" {
		t.Error("the cached entry must not be mutated in place")
	}
}
