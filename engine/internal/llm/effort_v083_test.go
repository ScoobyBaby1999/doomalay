package llm

import (
        "reflect"
        "testing"
)

// effort_v083_test.go — the PrivateMode effort surfaces, LIVE now
// (v1.55.4 THE LIVE EFFORT): the docs-carved static table (pmFamilyEffort,
// SOURCE 1.5) is DEAD — the exact same ladders ride models.dev's OWN
// reasoning_options for privatemode-ai (verified against the live doc:
// kimi → toggle, glm → low/high/max with no disable rung = mandatory,
// gpt-oss → low/medium/high, deepseek-ocr → no dial). The registry decides;
// nothing is carved into the tree.

const pmSeedV1554 = `{"privatemode-ai":{"name":"PrivateMode","models":{
        "kimi-k2.6":{"name":"Kimi K2.6","reasoning":true,"reasoning_options":[{"type":"toggle"}]},
        "kimi-latest":{"name":"Kimi Latest","reasoning":true,"reasoning_options":[{"type":"toggle"}]},
        "glm-5.3":{"name":"GLM 5.3","reasoning":true,"reasoning_options":[{"type":"effort","values":["low","high","max"]}]},
        "glm-5.3-flash":{"name":"GLM 5.3 Flash","reasoning":true,"reasoning_options":[{"type":"effort","values":["low","high","max"]}]},
        "glm-latest":{"name":"GLM Latest","reasoning":true,"reasoning_options":[{"type":"effort","values":["low","high","max"]}]},
        "glm-flash-latest":{"name":"GLM Flash Latest","reasoning":true,"reasoning_options":[{"type":"effort","values":["low","high","max"]}]},
        "glm-5.2":{"name":"GLM 5.2","reasoning":true,"reasoning_options":[{"type":"effort","values":["low","high","max"]}]},
        "gpt-oss-120b":{"name":"GPT-OSS 120B","reasoning":true,"reasoning_options":[{"type":"effort","values":["low","medium","high"]}]},
        "gpt-oss-latest":{"name":"GPT-OSS Latest","reasoning":true,"reasoning_options":[{"type":"effort","values":["low","medium","high"]}]},
        "deepseek-ocr-2":{"name":"DeepSeek OCR 2","reasoning":false}
}}}`

// TestPMFamilyEffortLives — the PM ladders, resolved LIVE from the
// registry's reasoning_options through the resolution chain.
func TestPMFamilyEffortLives(t *testing.T) {
        if err := SetModelsDevForTest([]byte(pmSeedV1554)); err != nil {
                t.Fatalf("seed: %v", err)
        }
        defer ClearModelsDevForTest()

        cases := []struct {
                model    string
                levels   []string
                mandatory bool
                param    string
        }{
                // kimi family — the toggle (on/off), default on.
                {"kimi-k2.6", []string{"on", "off"}, false, "chat_template_kwargs"},
                {"kimi-latest", []string{"on", "off"}, false, "chat_template_kwargs"},
                // glm family — low/high/max, NO disable rung → mandatory (the
                // docs-verified PM law, now derived from the data itself).
                {"glm-5.3", []string{"low", "high", "max"}, true, "reasoning_effort"},
                {"glm-latest", []string{"low", "high", "max"}, true, "reasoning_effort"},
                {"glm-flash-latest", []string{"low", "high", "max"}, true, "reasoning_effort"},
                {"glm-5.2", []string{"low", "high", "max"}, true, "reasoning_effort"},
                // gpt-oss family — low/medium/high.
                {"gpt-oss-120b", []string{"low", "medium", "high"}, true, "reasoning_effort"},
                {"gpt-oss-latest", []string{"low", "medium", "high"}, true, "reasoning_effort"},
                // deepseek-ocr — OCR, no reasoning dial.
                {"deepseek-ocr-2", []string{}, false, ""},
        }
        for _, tc := range cases {
                got := ResolveEffort("privatemodeai", tc.model)
                if !reflect.DeepEqual(got.Levels, tc.levels) {
                        t.Errorf("ResolveEffort(%q).Levels = %v, want %v (source %q)", tc.model, got.Levels, tc.levels, got.Source)
                }
                if got.Mandatory != tc.mandatory {
                        t.Errorf("ResolveEffort(%q).Mandatory = %v, want %v", tc.model, got.Mandatory, tc.mandatory)
                }
                if got.Param != tc.param {
                        t.Errorf("ResolveEffort(%q).Param = %q, want %q", tc.model, got.Param, tc.param)
                }
                // (a model with NO ladder answers no source — the honest nothing)
                if len(tc.levels) > 0 && got.Source != "provider-live" {
                        t.Errorf("ResolveEffort(%q).Source = %q, want provider-live (the registry)", tc.model, got.Source)
                }
        }
        // kimi's default is on (the registry's toggle law).
        if spec := ResolveEffort("privatemodeai", "kimi-latest"); spec.Default != "on" {
                t.Errorf("kimi default = %q, want on", spec.Default)
        }
}

// TestResolveEffortPMChainPrecedence — the chain consults the LIVE registry
// BEFORE the OR registry: glm keeps its max (the OR family view + the
// native filter would strip it) and kimi-latest stays a toggle. A provider
// the registry doesn't carry that model for never inherits PM's data.
func TestResolveEffortPMChainPrecedence(t *testing.T) {
        if err := SetModelsDevForTest([]byte(pmSeedV1554)); err != nil {
                t.Fatalf("seed: %v", err)
        }
        defer ClearModelsDevForTest()

        spec := ResolveEffort("privatemodeai", "glm-5.3")
        if !hasString(spec.Levels, "max") {
                t.Errorf("glm-5.3 levels = %v, want max present (the registry's own ladder)", spec.Levels)
        }
        if spec.Source != "provider-live" {
                t.Errorf("glm-5.3 source = %q, want provider-live (the registry)", spec.Source)
        }
        spec = ResolveEffort("privatemodeai", "kimi-latest")
        if hasEnumLevels(spec.Levels) {
                // kimi must be the on/off toggle, never an enum
                if !reflect.DeepEqual(spec.Levels, []string{"on", "off"}) {
                        t.Errorf("kimi-latest levels = %v, want [on off]", spec.Levels)
                }
        }
        // A provider the registry doesn't carry kimi for never resolves PM's
        // data (the PM seed carries only privatemode-ai).
        nv := ResolveEffort("nvidia", "totally-unknown-kimi-x")
        if nv.Source == "provider-live" {
                t.Error("nvidia must not inherit privatemode-ai's registry entry")
        }
}
