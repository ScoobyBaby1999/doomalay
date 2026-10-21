// toolfault_test.go — v1.56.0 THE HICCUP FLAG pins.
//
// The user's law: "Every single hiccup you encounter while running tool
// calls flag and tell me."
package llm

import (
	"context"
	"strings"
	"testing"
)

// TestDetectToolFault_Truncation: a truncated observation is flagged.
func TestDetectToolFault_Truncation(t *testing.T) {
	rep := DetectToolFault("OBSERVATION:\nsome output\n[truncated: first 24000 of 91234 bytes shown]")
	if !rep.Faulted {
		t.Fatalf("a truncated observation was not flagged")
	}
	if !strings.Contains(rep.Label, "truncated") {
		t.Fatalf("label = %q, want a truncation label", rep.Label)
	}
}

// TestDetectToolFault_RefusalAndError: a refusal and a failed call are
// flagged.
func TestDetectToolFault_RefusalAndError(t *testing.T) {
	for _, tc := range []struct {
		obs  string
		want string
	}{
		{"OBSERVATION:\nREFUSED — the command looks like a file destroy", "refused"},
		{"OBSERVATION:\nerror: arguments must be a JSON object", "failed"},
		{"OBSERVATION:\n[termux: output truncated at 100KB by Termux's result cap]", "100KB"},
	} {
		rep := DetectToolFault(tc.obs)
		if !rep.Faulted {
			t.Fatalf("not flagged: %q", tc.obs)
		}
		if !strings.Contains(rep.Label, tc.want) {
			t.Fatalf("label = %q, want it to mention %q", rep.Label, tc.want)
		}
	}
}

// TestDetectToolFault_CleanObservation: a normal result is NOT flagged
// (a false alarm would train the user to ignore the flag).
func TestDetectToolFault_CleanObservation(t *testing.T) {
	for _, obs := range []string{
		"OBSERVATION:\n42\n",
		"OBSERVATION:\nGREP — \"TODO\" in /x (3 lines):\n- a.go:1  TODO\n",
		"OBSERVATION:\nno matches for the pattern",
		"OBSERVATION:\n// the error: handling path\nfunc f() {}\n",
	} {
		rep := DetectToolFault(obs)
		if rep.Faulted {
			t.Fatalf("a clean observation was flagged: %q → %+v", obs, rep)
		}
	}
}

// TestFlagToolFault_SpeaksTheNotice: the flag RIDES the turn as a notice
// (the user sees it; the model sees it).
func TestFlagToolFault_SpeaksTheNotice(t *testing.T) {
	ch := make(chan ChatChunk, 8)
	rep := FlagToolFault(context.Background(), ch, "workspace",
		"OBSERVATION:\n3 hit(s)\n[truncated: first 100 of 900 bytes shown]")
	if !rep.Faulted {
		t.Fatalf("not flagged")
	}
	select {
	case c := <-ch:
		if c.Type != "notice" {
			t.Fatalf("chunk type = %q, want notice", c.Type)
		}
		if !strings.Contains(c.Text, "tool hiccup") || !strings.Contains(c.Text, "workspace") {
			t.Fatalf("the notice does not name the tool: %q", c.Text)
		}
	default:
		t.Fatalf("no notice was emitted")
	}
}

// TestFlagToolFault_QuietOnACleanResult: no notice for a clean result.
func TestFlagToolFault_QuietOnACleanResult(t *testing.T) {
	ch := make(chan ChatChunk, 8)
	FlagToolFault(context.Background(), ch, "workspace", "OBSERVATION:\nall good\n")
	select {
	case c := <-ch:
		t.Fatalf("a clean result produced a notice: %q", c.Text)
	default:
	}
}
