//go:build pmlive

// v1.46.1+v1.46.2 THE CLEAN MIND — the LIVE phase gate (real key, real
// deployment; CI never runs this):
//
//	PM_KEY=<key> go test -tags pmlive ./internal/server/ -run TestLivePMReasoningClean -v
//
// The user's device report: "pm native reasoning shows duplicate texts.
// Every word appears twice in its reasoning." Root cause (live-probed
// 2026-10-20): PM's vllm-0.31.0 gateway emits EVERY reasoning delta in BOTH
// wire spellings byte-equal ({"reasoning":"The","reasoning_content":"The"})
// and the engine's merge concatenated the pair. THE ALIAS LAW fixed it
// (mergeWireReasoning: byte-equal pair = ONE copy). This gate drives a REAL
// glm turn through the engine's own pipeline and asserts:
//
//   - the streamed thinking text contains NO systematic word doubling
//     (the alias bug doubled EVERY word — a >20% adjacent-duplicate rate;
//     genuine reasoning runs ~0%),
//   - the answer content is unharmed (single spelling, single copy),
//   - the terminal usage carries the provider's reasoning share
//     (completion_tokens_details.reasoning_tokens — 0 only when the
//     deployment stops reporting it; the probe measured 53/56).
package server

import (
	"context"
	"os"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/ScoobyBaby1999/doomalay/engine/internal/llm"
	"github.com/ScoobyBaby1999/doomalay/engine/internal/pmstate"
	"github.com/ScoobyBaby1999/doomalay/engine/internal/secrets"
)

// adjDupRate returns the fraction of adjacent word pairs that are exact
// duplicates (lowercased, punctuation-stripped). The alias bug doubles EVERY
// word → rate ~1.0. Genuine model reasoning: ~0.0.
func adjDupRate(t *testing.T, text string) float64 {
	t.Helper()
	words := regexp.MustCompile(`[\p{L}\p{N}']+`).FindAllString(text, -1)
	if len(words) < 6 {
		return 0 // too short to judge
	}
	dups := 0
	for i := 1; i < len(words); i++ {
		if strings.EqualFold(words[i], words[i-1]) {
			dups++
		}
	}
	return float64(dups) / float64(len(words)-1)
}

func TestLivePMReasoningClean(t *testing.T) {
	key := os.Getenv("PM_KEY")
	if key == "" {
		t.Skip("PM_KEY not set — the live rig needs a real PrivateMode key")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()

	vault, err := secrets.New(t.TempDir())
	if err != nil {
		t.Fatalf("vault: %v", err)
	}
	if err := vault.Set(pmstate.KeyEnvVar, "privatemodeai", key, ""); err != nil {
		t.Fatalf("set key: %v", err)
	}
	s := &Server{vault: vault, pm: pmstate.NewManager(vault)}
	llm.SetPMTransport(pmTransportAdapter{s.pm})
	defer llm.SetPMTransport(nil)

	req := llm.ChatRequest{
		Provider:  "privatemodeai",
		Model:     "glm-5.3", // the heavy reasoner (the probe: 53 reasoning tokens for "2+2")
		APIKey:    key,
		BaseURL:   "https://api.privatemode.ai",
		SessionID: "pm-v1461-live",
		Messages: []llm.Message{
			// The RELIABLE reasoning trigger — the explicit
			// think-instruction forced the reasoning channel
			// 3/3 in the live probe (bare "2+2" reasoned only
			// 2/3: glm's dynamic reasoning skips recall facts
			// intermittently; a flaky gate is a lying gate).
			{Role: "user", Content: "Think step by step: what is 17 times 23? Answer with just the number."},
		},
	}
	ch, _ := llm.Chat(ctx, req)

	var thinking, answer string
	var usage *llm.Usage
	var sawErr bool
	typeCounts := map[string]int{}
	for c := range ch {
		typeCounts[c.Type]++
		switch c.Type {
		case "thinking":
			thinking += c.Text
		case "assistant_delta":
			answer += c.Text
		case "status":
			if c.State == "idle" && c.Usage != nil {
				usage = c.Usage
			}
			if c.State == "error" {
				sawErr = true
				t.Logf("terminal error state: %s", c.Message)
			}
		case "error":
			sawErr = true
			t.Logf("error chunk: %s", c.Message)
		}
	}
	t.Logf("chunk types: %v — answer %q", typeCounts, answer)
	if sawErr {
		t.Fatalf("the native PM turn errored")
	}
	up := strings.ToUpper(answer)
	if !strings.Contains(up, "391") {
		t.Fatalf("the answer missed the marker: %q", answer)
	}
	if thinking == "" {
		t.Fatalf("glm-5.3 is a reasoner — the turn must stream thinking text (got none; the deployment may have changed shape)")
	}
	// THE ALIAS LAW, LIVE: no systematic doubling. The pre-fix rate was
	// ~1.0 (every word twice); genuine reasoning runs <0.2 by a wide
	// margin (observed 0.0).
	if rate := adjDupRate(t, thinking); rate >= 0.2 {
		t.Fatalf("reasoning doubled (adjacent-duplicate rate %.2f ≥ 0.20) — head of thinking: %.200q", rate, thinking)
	}
	// THE REASONING LEDGER, LIVE: the provider's own reasoning share
	// rides the terminal usage (the probe measured 53/56 on this model).
	if usage == nil || usage.TotalTokens <= 0 {
		t.Fatalf("the turn must terminate with honest usage, got %+v", usage)
	}
	if usage.ReasoningTokens <= 0 {
		t.Fatalf("glm-5.3's usage must carry the reasoning share (completion_tokens_details.reasoning_tokens), got %+v", usage)
	}
	t.Logf("CLEAN MIND live: answer %q, thinking %d chars, adjacent-dup rate %.3f, usage in=%d out=%d (reasoning %d) total=%d",
		answer, len(thinking), adjDupRate(t, thinking), usage.InputTokens, usage.OutputTokens, usage.ReasoningTokens, usage.TotalTokens)
}
