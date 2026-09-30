package llm

import (
	"reflect"
	"testing"
)

// v0.83.2 THE PRIVATEMODE OWN-SURFACE LADDER — the docs-verified effort
// surface (docs.privatemode.ai/models/overview v1.57, fetched live
// 2026-10-01). User spec: "For privatemodeai, let's make sure we enable
// effort modes for their models. We want users to be able to toggle
// effort modes like they can with Nvidia reliably anytime."
func TestPMFamilyEffortLadders(t *testing.T) {
	cases := []struct {
		model   string
		levels  []string
		def     string
		param   string
		mand    bool
	}{
		// kimi family — the verified PM boolean toggle (kimi-latest
		// previously inherited a FAKE enum from the OR registry).
		{"kimi-k2.6", []string{"on", "off"}, "on", "chat_template_kwargs", true},
		{"kimi-latest", []string{"on", "off"}, "on", "chat_template_kwargs", true},
		// glm family — low/high/max, DEFAULT max, mandatory (reasoning
		// can't be switched off; none maps to max). 'max' previously
		// got stripped by the v0.69 native filter.
		{"glm-5.3", []string{"low", "high", "max"}, "max", "reasoning_effort", false},
		{"glm-5.3-flash", []string{"low", "high", "max"}, "max", "reasoning_effort", false},
		{"glm-latest", []string{"low", "high", "max"}, "max", "reasoning_effort", false},
		{"glm-flash-latest", []string{"low", "high", "max"}, "max", "reasoning_effort", false},
		{"glm-5.2", []string{"low", "high", "max"}, "max", "reasoning_effort", false},
		// gpt-oss family — low/medium/high, default medium.
		{"gpt-oss-120b", []string{"low", "medium", "high"}, "medium", "reasoning_effort", true},
		{"gpt-oss-latest", []string{"low", "medium", "high"}, "medium", "reasoning_effort", true},
		{"openai/gpt-oss-120b", []string{"low", "medium", "high"}, "medium", "reasoning_effort", true},
		// deepseek-ocr — OCR, no reasoning dial.
		{"deepseek-ocr-2", []string{}, "", "", false},
	}
	for _, tc := range cases {
		got := pmFamilyEffort(tc.model)
		if got == nil {
			t.Fatalf("pmFamilyEffort(%q) = nil, want a docs ladder", tc.model)
		}
		if !reflect.DeepEqual(got.Levels, tc.levels) {
			t.Errorf("pmFamilyEffort(%q).Levels = %v, want %v", tc.model, got.Levels, tc.levels)
		}
		if got.Default != tc.def {
			t.Errorf("pmFamilyEffort(%q).Default = %q, want %q", tc.model, got.Default, tc.def)
		}
		if got.Param != tc.param {
			t.Errorf("pmFamilyEffort(%q).Param = %q, want %q", tc.model, got.Param, tc.param)
		}
		if got.CanDisable != tc.mand {
			t.Errorf("pmFamilyEffort(%q).CanDisable = %v, want %v", tc.model, got.CanDisable, tc.mand)
		}
	}
	// Unknown family → nil (falls through to the OR registry chain).
	if pmFamilyEffort("some-future-model") != nil {
		t.Error("pmFamilyEffort(unknown) should be nil (dynamic chain)")
	}
}

// The resolution chain consults the PM docs table BEFORE the OR registry —
// glm keeps its 'max' even though the OR family view + the pre-v0.83
// filter would strip it, and kimi-latest stays a toggle.
func TestResolveEffortPMChainPrecedence(t *testing.T) {
	spec := ResolveEffort("privatemodeai", "glm-5.3")
	if !hasString(spec.Levels, "max") {
		t.Errorf("glm-5.3 levels = %v, want max present (the docs default)", spec.Levels)
	}
	if spec.Default != "max" {
		t.Errorf("glm-5.3 default = %q, want max", spec.Default)
	}
	if spec.Source != "pm-docs" {
		t.Errorf("glm-5.3 source = %q, want pm-docs", spec.Source)
	}
	spec = ResolveEffort("privatemodeai", "kimi-latest")
	if !hasEnumLevels(spec.Levels) {
		// kimi must be the on/off toggle, never an enum
		if !reflect.DeepEqual(spec.Levels, []string{"on", "off"}) {
			t.Errorf("kimi-latest levels = %v, want [on off]", spec.Levels)
		}
	}
	if spec.Source != "pm-docs" {
		t.Errorf("kimi-latest source = %q, want pm-docs", spec.Source)
	}
	// A provider other than PM never hits the PM table.
	nv := ResolveEffort("nvidia", "kimi-k2.6")
	if nv.Source == "pm-docs" {
		t.Error("nvidia/kimi-k2.6 must not resolve through the PM docs table")
	}
}
