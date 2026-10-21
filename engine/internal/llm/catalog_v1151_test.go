package llm

// catalog_v1151_test.go — v1.15.1 THE CHOICE (PLAN-V115 §v1.15.1).
//
// The autopickers are gone: the probe ladder is LIVE-DERIVED (the
// provider's own roster, free-first, capped at 5) and the "auto"
// pseudo-model resolution scores pure catalog data (free + tools +
// reasoning + context) instead of a hardcoded family name list.

import (
        "net/http"
        "net/http/httptest"
        "os"
        "strings"
        "testing"
)

// stubRosterServer answers GET /models with an OpenAI-wire roster.
func stubRosterServer(t *testing.T, ids ...string) *httptest.Server {
        t.Helper()
        var b strings.Builder
        b.WriteString(`{"data":[`)
        for i, id := range ids {
                if i > 0 {
                        b.WriteString(",")
                }
                b.WriteString(`{"id":"` + id + `"}`)
        }
        b.WriteString(`]}`)
        body := b.String()
        return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
                if !strings.HasSuffix(r.URL.Path, "/models") {
                        http.NotFound(w, r)
                        return
                }
                w.Header().Set("Content-Type", "application/json")
                _, _ = w.Write([]byte(body))
        }))
}

// TestV1151_ProbeLadderIsLiveDerived — with a stubbed NVIDIA roster the
// ladder is exactly [the 5 live models] — NO hardcoded model ids can
// appear (nvidia has no probe_model in the catalog anymore), and the cap
// holds even when the roster is long.
func TestV1151_ProbeLadderIsLiveDerived(t *testing.T) {
        srv := stubRosterServer(t,
                "z-ai/glm-5.3-flash",
                "openai/gpt-oss-20b",
                "nvidia/nemotron-3-super-120b-a12b",
                "meta/llama-3.2-11b-vision-instruct",
                "google/gemma-4-31b-it",
                "qwen/qwen3.6-coder",
                "deepseek/deepseek-v4",
                "kimi/kimi-k3",
        )
        defer srv.Close()
        t.Setenv("DOOMALAY_BASE_URL_NVIDIA", srv.URL)

        // v1.55.4 THE LIVE-PROBE LAW: the ProbeModel FIELD is gone entirely —
        // no provider carries a probe pin. The free-first rung reads the LIVE
        // registry (seeded here: every roster model cost-0 → free → the whole
        // roster walks).
        seed := `{"nvidia":{"name":"NVIDIA","models":{"z-ai/glm-5.3-flash":{"name":"glm","cost":{"input":0,"output":0}},"openai/gpt-oss-20b":{"name":"oss","cost":{"input":0,"output":0}},"nvidia/nemotron-3-super-120b-a12b":{"name":"super","cost":{"input":0,"output":0}},"meta/llama-3.2-11b-vision-instruct":{"name":"llama","cost":{"input":0,"output":0}},"google/gemma-4-31b-it":{"name":"gemma","cost":{"input":0,"output":0}},"qwen/qwen3.6-coder":{"name":"qwen","cost":{"input":0,"output":0}},"deepseek/deepseek-v4":{"name":"ds","cost":{"input":0,"output":0}},"kimi/kimi-k3":{"name":"kimi","cost":{"input":0,"output":0}}}}}`
        if err := SetModelsDevForTest([]byte(seed)); err != nil {
                t.Fatalf("seed: %v", err)
        }
        defer ClearModelsDevForTest()

        cat, err := LoadCatalog()
        if err != nil {
                t.Fatalf("LoadCatalog: %v", err)
        }
        cfg := cat["nvidia"]

        got := probeCandidates("nvidia", cfg, "key", "")
        // v1.29.3: the cap grew 5 → 12 (the rotten-roster-head fix — the
        // user's Nvidia ladder burned all 5 rungs on retired models); an
        // 8-model roster therefore lands WHOLE (the fallback rung dedupes).
        if len(got) != 8 {
                t.Fatalf("ladder = %v (len %d), want exactly 8 live-roster candidates (cap now %d)", got, len(got), probeCandidateCap)
        }
        want := []string{
                "z-ai/glm-5.3-flash",
                "openai/gpt-oss-20b",
                "nvidia/nemotron-3-super-120b-a12b",
                "meta/llama-3.2-11b-vision-instruct",
                "google/gemma-4-31b-it",
                "qwen/qwen3.6-coder",
                "deepseek/deepseek-v4",
                "kimi/kimi-k3", // the whole roster — the cap is headroom, not a trimmer, until 12
        }
        for i := range want {
                if got[i] != want[i] {
                        t.Fatalf("ladder[%d] = %q, want %q (full ladder: %v)", i, got[i], want[i], got)
                }
        }
}

// TestV1151_ProbeLadderLeadsConfiguredProbe — the catalog-configured
// probe model (config, not code) still leads when one exists (opencode's
// big-pickle).
// v1.55.4 THE LIVE-PROBE LAW: opencode's big-pickle PIN is dead — the
// ladder is the live roster, FREE models first (the registry's cost law).
// big-pickle (registry cost-0) leads; mimo-v2.5-free carries a PAID
// registry price in this seed (the -free name lie, live-convicted).
func TestV1551_ProbeLadderLiveLeads(t *testing.T) {
        srv := stubRosterServer(t, "kimi-k2.6", "big-pickle", "mimo-v2.5-free")
        defer srv.Close()
        t.Setenv("DOOMALAY_BASE_URL_OPENCODE", srv.URL)

        seed := `{"opencode":{"name":"OpenCode","models":{"big-pickle":{"name":"Big Pickle","cost":{"input":0,"output":0}},"kimi-k2.6":{"name":"Kimi","cost":{"input":1,"output":4}},"mimo-v2.5-free":{"name":"Mimo","cost":{"input":0.3,"output":1.2}}}}}`
        if err := SetModelsDevForTest([]byte(seed)); err != nil {
                t.Fatalf("seed: %v", err)
        }
        defer ClearModelsDevForTest()

        cat, err := LoadCatalog()
        if err != nil {
                t.Fatalf("LoadCatalog: %v", err)
        }
        cfg := cat["opencode"]
        got := probeCandidates("opencode", cfg, "key", "")
        // the FREE registry model leads; the paid entries ride as roster order,
        // capped by the any-model fallback rung
        if len(got) == 0 || got[0] != "big-pickle" {
                t.Fatalf("ladder = %v, want big-pickle (the registry's free model) leading", got)
        }
}

// TestV1151_ProbeLadderDeadRoster — a roster that can't be fetched and no
// pins anywhere: the ladder is empty (the validator reports "no probe model
// available" honestly — it does NOT fall back to any hardcoded list).
func TestV1151_ProbeLadderDeadRoster(t *testing.T) {
        srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
                http.Error(w, "boom", 500)
        }))
        defer srv.Close()
        t.Setenv("DOOMALAY_BASE_URL_NVIDIA", srv.URL)

        cat, err := LoadCatalog()
        if err != nil {
                t.Fatalf("LoadCatalog: %v", err)
        }
        got := probeCandidates("nvidia", cat["nvidia"], "key", "")
        if len(got) != 0 {
                t.Fatalf("dead roster + no pins: ladder = %v, want empty (honest)", got)
        }
}

// TestV1151_AutoModelScorePureData — the auto resolution scores CATALOG
// DATA only: free beats paid, tools beat no-tools, context adds gently.
// A made-up id with a "popular" name scores ZERO against real fields.
func TestV1151_AutoModelScorePureData(t *testing.T) {
        freeTools := EnrichedModel{ID: "x/free-tools", IsFree: true, Capabilities: []string{"tools", "reasoning"}, ContextLength: 128000}
        paidTools := EnrichedModel{ID: "x/paid-tools", Capabilities: []string{"tools"}, ContextLength: 128000}
        freeNoCaps := EnrichedModel{ID: "kimi-k-popular-name", IsFree: true, ContextLength: 32000}
        bare := EnrichedModel{ID: "glm-5.3-flash-popular-name"}

        if autoModelScore(freeTools) <= autoModelScore(paidTools) {
                t.Fatalf("free+tools+reasoning (%d) must outrank paid+tools (%d)", autoModelScore(freeTools), autoModelScore(paidTools))
        }
        // The free 500-bonus is intentional (free models serve on ANY account —
        // the "auto" pick must work, not merely be capable), so a bare free
        // model still outranks a paid tools-capable one.
        if autoModelScore(freeNoCaps) <= autoModelScore(paidTools) {
                t.Fatalf("free+ctx (%d) must outrank paid+tools (%d) — free serves on any account", autoModelScore(freeNoCaps), autoModelScore(paidTools))
        }
        if autoModelScore(freeNoCaps) <= autoModelScore(bare) {
                t.Fatalf("free+ctx (%d) must outrank a name-only model (%d) — name heuristics are dead", autoModelScore(freeNoCaps), autoModelScore(bare))
        }
        // The exact receipt: free 500 + tools 50 + reasoning 30 + ctx 4 = 584.
        if s := autoModelScore(freeTools); s != 584 {
                t.Fatalf("freeTools score = %d, want 584", s)
        }
}

// TestV1151_ResolveAutoModelNonAutoPassthrough — non-auto models pass
// through untouched ("" = nothing to resolve).
func TestV1151_ResolveAutoModelNonAutoPassthrough(t *testing.T) {
        if r := ResolveAutoModel("nvidia/z-ai/glm-5.3-flash", "nvidia", nil); r != "" {
                t.Fatalf("concrete model resolved to %q, want passthrough", r)
        }
        if r := ResolveAutoModel("nvidia/auto", "", nil); r != "" {
                t.Fatalf("auto with no provider resolved to %q, want \"\"", r)
        }
}

// TestV1151_NoKnownGoodListsRemain — the hardcoded lists are gone from
// the source (the compile-level guard: the functions no longer exist is
// enforced by this file compiling; this test pins the source text so a
// future paste-back gets caught).
func TestV1151_NoKnownGoodListsRemain(t *testing.T) {
        src, err := os.ReadFile("catalog.go")
        if err != nil {
                t.Skip("source not readable (release build)")
        }
        s := string(src)
        for _, banned := range []string{
                "nemotron-3-super-120b-a12b",
                "nemotron-3.5-lightning-free",
                "deepseek-v4-flash-free",
                "big-pickle\",", // knownGoodProbes literal shape
        } {
                if strings.Contains(s, banned) {
                        t.Fatalf("catalog.go still contains hardcoded model id %q — THE CHOICE forbids hardcoded autopick lists", banned)
                }
        }
}
