package llm

import (
	"strings"
	"testing"
)

// v0.40: the model-gone one-tap recovery ranking — deterministic core
// checks against the static catalog (family ranking, dead-route
// exclusion, same-provider + key-backed filter, cap at 3).
func TestSuggestReplacements(t *testing.T) {
	keys := map[string]string{"NVIDIA_API_KEY": "nvapi-test"}
	cat := BuildCatalogV2(keys, false)
	if cat == nil || len(cat.Logical) == 0 {
		t.Skip("no catalog available")
	}

	// find a real nvidia-hosted logical model to "kill"
	var deadLogical, deadModelID string
	for _, lm := range cat.Logical {
		for _, h := range lm.Hosts {
			if h.Provider == "nvidia" && h.HasAPIKey {
				deadLogical, deadModelID = lm.Logical, h.ModelID
				break
			}
		}
		if deadLogical != "" {
			break
		}
	}
	if deadLogical == "" {
		t.Skip("no nvidia models in catalog")
	}

	sug := SuggestReplacements("nvidia/"+deadModelID, "nvidia", keys, 3)
	if len(sug) == 0 {
		t.Skip("no key-backed nvidia alternatives")
	}
	if len(sug) > 3 {
		t.Fatalf("want ≤3 suggestions, got %d", len(sug))
	}
	for _, s := range sug {
		if s.Provider != "nvidia" {
			t.Fatalf("suggestion provider = %q, want nvidia (same provider)", s.Provider)
		}
		if s.Model == "nvidia/"+deadModelID {
			t.Fatalf("suggested the dead model itself")
		}
		if !strings.HasPrefix(s.Model, "nvidia/") {
			t.Fatalf("suggestion %q is not the full user-facing form", s.Model)
		}
		if s.Label == "" {
			t.Fatalf("empty label for %q", s.Model)
		}
	}
}

func TestModelGoneMessage(t *testing.T) {
	yes := []string{
		"404: this model is no longer available for your nvidia account — pick another model",
		"this model has been retired by the provider (end of life) — pick another model",
		"Function 'x': Not found for account",
		"410 Gone: end of life reached",
	}
	no := []string{
		"the model is at capacity (429)",
		"connection reset by peer",
		"",
	}
	for _, m := range yes {
		if !ModelGoneMessage(m) {
			t.Fatalf("ModelGoneMessage(%q) = false, want true", m)
		}
	}
	for _, m := range no {
		if ModelGoneMessage(m) {
			t.Fatalf("ModelGoneMessage(%q) = true, want false", m)
		}
	}
}

func TestSuggestReplacementsGuards(t *testing.T) {
	if SuggestReplacements("", "nvidia", map[string]string{"NVIDIA_API_KEY": "k"}, 3) != nil {
		t.Fatal("empty model should return nil")
	}
	if SuggestReplacements("nvidia/x", "nvidia", nil, 3) != nil {
		t.Fatal("nil keys should return nil")
	}
	if SuggestReplacements("nvidia/x", "nvidia", map[string]string{"NVIDIA_API_KEY": "k"}, 0) != nil {
		t.Fatal("want=0 should return nil")
	}
	// unknown provider → no candidates, nil (never a panic)
	if SuggestReplacements("ghost/model-x", "ghost", map[string]string{"GHOST_API_KEY": "k"}, 3) != nil {
		t.Fatal("unknown provider should return nil")
	}
}
