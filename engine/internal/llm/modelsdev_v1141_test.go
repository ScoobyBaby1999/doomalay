package llm

// modelsdev_v1141_test.go — v1.14.1 THE LEDGER: the snapshot lookup matrix.
// The pinned numbers come from the embedded snapshot itself (probed at
// generation time); if the snapshot is ever regenerated with shifted
// values, these tests are the change-detector — update them consciously.

import "testing"

func TestV1141_LookupSpec_Matrix(t *testing.T) {
	cases := []struct {
		slot  string
		known bool
		ctx   int
	}{
		{"gpt-4o", true, 128000},                                  // bare id
		{"openai/gpt-4o", true, 128000},                           // provider/model
		{"openrouter/openai/gpt-4o-mini", true, 128000},           // engine slot: provider + vendor path
		{"nvidia/nvidia/nemotron-3.5-lightning", true, 1000000},   // the double-prefix NIM shape
		{"definitely/not-a-real-model-xyz", false, 0},             // unknown
	}
	for _, c := range cases {
		s, ok := LookupSpec(c.slot)
		if ok != c.known {
			t.Errorf("LookupSpec(%q) known = %v, want %v", c.slot, ok, c.known)
			continue
		}
		if ok && s.Context != c.ctx {
			t.Errorf("LookupSpec(%q).Context = %d, want %d", c.slot, s.Context, c.ctx)
		}
	}
}

func TestV1141_SpecMaxOutput(t *testing.T) {
	// The NIM model the floor test exercises (probed: out=65536).
	if out, ok := SpecMaxOutput("nvidia/nvidia/nemotron-3.5-lightning"); !ok || out != 65536 {
		t.Fatalf("SpecMaxOutput(nemotron-3.5-lightning) = %d,%v; want 65536,true", out, ok)
	}
	if _, ok := SpecMaxOutput("definitely/not-a-real-model-xyz"); ok {
		t.Fatal("unknown model must not report an output cap")
	}
}

func TestV1141_ContextLimitFor_SpecPrimary(t *testing.T) {
	// spec-known: the snapshot wins.
	if got := ContextLimitFor("openai/gpt-4o"); got != 128000 {
		t.Errorf("ContextLimitFor(gpt-4o) = %d, want 128000 (snapshot primary)", got)
	}
	// snapshot-blind but curated-known: the ctxRules fallback.
	if got := ContextLimitFor("nvidia/total-mystery-nemotron-model"); got != 131072 {
		t.Errorf("ContextLimitFor(unknown nemotron) = %d, want 131072 (curated fallback)", got)
	}
	// fully unknown: the conservative default.
	if got := ContextLimitFor("definitely/not-a-real-model-xyz"); got != 65536 {
		t.Errorf("ContextLimitFor(unknown) = %d, want 65536", got)
	}
}

func TestV1141_LookupPrice_Sources(t *testing.T) {
	// snapshot-primary: source labeled "models.dev".
	p := LookupPrice("openai/gpt-4o-mini")
	if p.Source != "models.dev" {
		t.Fatalf("LookupPrice(gpt-4o-mini).Source = %q, want models.dev", p.Source)
	}
	if p.InputPerM != 0.15 || p.OutputPerM != 0.6 {
		t.Errorf("gpt-4o-mini rates = %v/%v, want 0.15/0.6", p.InputPerM, p.OutputPerM)
	}
	// snapshot-blind, curated-known: "my-deepseek-clone" matches no
	// snapshot key, hits the deepseek substring rule.
	p2 := LookupPrice("privatemode/my-deepseek-clone")
	if p2.Source != "DeepSeek list" {
		t.Errorf("LookupPrice(my-deepseek-clone).Source = %q, want the curated fallback", p2.Source)
	}
	// fully unknown: honest unpriced (never invent a dollar figure).
	p3 := LookupPrice("definitely/not-a-real-model-xyz")
	if p3.Source != "unpriced" {
		t.Errorf("LookupPrice(unknown).Source = %q, want unpriced", p3.Source)
	}
}

func TestV1141_SpecSupportsTools(t *testing.T) {
	if tc, ok := SpecSupportsTools("openai/gpt-4o"); !ok || !tc {
		t.Errorf("gpt-4o tool_call = %v,%v; want true,true", tc, ok)
	}
	if tc, ok := SpecSupportsTools("definitely/not-a-real-model-xyz"); ok {
		t.Errorf("unknown model must not claim tool support (%v,%v)", tc, ok)
	}
}
