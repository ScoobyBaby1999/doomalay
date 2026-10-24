package surgeon

// partial_v1742_test.go — v1.74.2 THE SURGEON'S OATH pins: the
// partial-apply contract (aider's re-ask law) + every leniency rung.
//
// The user's ask: "the model always has to find workarounds to
// surgically edit files, it has to create patches and fix mistakes that
// shouldn't happen because the toolset we have for editing is bad and
// we rely too much on a rigid structure."

import (
	"strings"
	"testing"
)

const v1742File = `package main

// greet says hello.
func greet(name string) string {
	return "hello " + name
}

// farewell says bye.
func farewell(name string) string {
	return "bye " + name
}
`

// TestV1742_PartialApplyContract — 2 good edits + 1 bad in ONE call:
// the good ones LAND, the bad one gets the re-ask, and the report says
// don't re-send the applied ones.
func TestV1742_PartialApplyContract(t *testing.T) {
	res := ApplyEditsPartial(v1742File, []EditSpec{
		{Old: `return "hello " + name`, New: `return "hi " + name`},        // lands
		{Old: "return \"greetz \" + name", New: "return \"yo \" + name"},   // misses (typo)
		{Old: "// farewell says bye.", New: "// farewell says goodbye."},   // lands
	})
	if res.Applied != 2 || res.Failed != 1 {
		t.Fatalf("2 of 3 must apply: applied=%d failed=%d", res.Applied, res.Failed)
	}
	if !strings.Contains(res.Content, `return "hi " + name`) {
		t.Fatal("edit 1 must land")
	}
	if !strings.Contains(res.Content, "// farewell says goodbye.") {
		t.Fatal("edit 3 must land")
	}
	if strings.Contains(res.Content, `"hello " + name`) {
		t.Fatal("edit 1's old text must be gone")
	}
	// the failed edit's re-ask
	fail := res.Outcomes[1]
	if fail.OK || fail.Err == "" {
		t.Fatalf("edit 2 must fail with the re-ask: %+v", fail)
	}
	for _, want := range []string{
		"edit 2 did not apply",
		"your \"old\" text",
		"greetz",
	} {
		if !strings.Contains(fail.Err, want) {
			t.Fatalf("the re-ask must carry %q:\n%s", want, fail.Err)
		}
	}
	// the nearest-window re-ask names the actual lines (aider's "did you
	// mean these actual lines") — numbered, verbatim, from the file AS IT
	// IS after edit 1 (the sequential contract)
	if !strings.Contains(fail.Err, "the file's actual lines") || !strings.Contains(fail.Err, "return \"") || !strings.Contains(fail.Err, "\u2502") {
		t.Fatalf("the re-ask must show the file's actual numbered lines:\n%s", fail.Err)
	}
}

// TestV1742_AlreadyAppliedHint — a retry after a phantom failure (the
// edit actually landed last time): the miss says the new text is
// ALREADY in the file (verify, don't re-send).
func TestV1742_AlreadyAppliedHint(t *testing.T) {
	res := ApplyEditsPartial(v1742File, []EditSpec{
		{Old: "return \"hello \" + name // v1", New: `return "hi " + name // v1`},
	})
	if res.Applied != 0 || res.Failed != 1 {
		t.Fatalf("the miss must miss: %+v", res)
	}
	errText := res.Outcomes[0].Err
	// old misses, new is not in the file either — no hint yet
	if strings.Contains(errText, "ALREADY in the file") {
		t.Fatalf("the hint must not fire when the new text is absent:\n%s", errText)
	}
	// now the retry-of-a-success: old was already replaced
	edited := strings.ReplaceAll(v1742File, `return "hello " + name`, `return "hi " + name`)
	res2 := ApplyEditsPartial(edited, []EditSpec{
		{Old: `return "hello " + name`, New: `return "hi " + name`},
	})
	if res2.Applied != 0 {
		t.Fatal("the already-applied edit must not re-land")
	}
	if !strings.Contains(res2.Outcomes[0].Err, "ALREADY in the file") {
		t.Fatalf("the classic double-apply case must carry the hint:\n%s", res2.Outcomes[0].Err)
	}
}

// TestV1742_ElisionRung — aider's `...` shape: the unchanged middle is
// skipped, the pieces match, the in-between content is preserved.
func TestV1742_ElisionRung(t *testing.T) {
	old := "// greet says hello.\n...\n\treturn \"hello \" + name"
	neo := "// greet says hi (renamed).\n...\n\treturn \"hi \" + name"
	res := ApplyEditsPartial(v1742File, []EditSpec{{Old: old, New: neo}})
	if res.Applied != 1 {
		t.Fatalf("the elision edit must land:\n%s", res.Outcomes[0].Err)
	}
	if res.Outcomes[0].Mode != "elision" {
		t.Fatalf("mode must be elision, got %s", res.Outcomes[0].Mode)
	}
	if !strings.Contains(res.Content, "// greet says hi (renamed).") {
		t.Fatal("the first piece must land")
	}
	// the in-between lines survive (the ... middle is untouched)
	for _, keep := range []string{"func greet(name string) string {"} {
		if !strings.Contains(res.Content, keep) {
			t.Fatalf("the ... middle must be preserved: %q missing\n%s", keep, res.Content)
		}
	}
	// a mismatched piece-count refuses (a deletion-style dots mismatch)
	res2 := ApplyEditsPartial(v1742File, []EditSpec{{Old: old, New: "x"}})
	if res2.Applied != 0 {
		t.Fatal("a dots-count mismatch must refuse")
	}
}

// TestV1742_FuzzyRung — a 1-char typo lands at high confidence and is
// REPORTED; a wrong-window (low-similarity) miss refuses.
func TestV1742_FuzzyRung(t *testing.T) {
	// "greet" vs "grect" — one char, ratio ≈ 24/25 = 0.96
	res := ApplyEditsPartial(v1742File, []EditSpec{
		{Old: "func grect(name string) string {", New: "func greet2(name string) string {"},
	})
	if res.Applied != 1 {
		t.Fatalf("the 1-char typo must land through fuzzy:\n%s", res.Outcomes[0].Err)
	}
	if res.Outcomes[0].Mode != "fuzzy" || res.Outcomes[0].Confidence < 0.9 {
		t.Fatalf("the fuzzy landing must be reported with confidence: %+v", res.Outcomes[0])
	}
	if !strings.Contains(res.Content, "func greet2(name string) string {") {
		t.Fatal("the fuzzy replacement must land")
	}
	// a WRONG window (a different function entirely) refuses
	res2 := ApplyEditsPartial(v1742File, []EditSpec{
		{Old: "def completely_unrelated_function(x):\n\treturn x * 2", New: "nope"},
	})
	if res2.Applied != 0 {
		t.Fatalf("a low-similarity block must never fuzzy-land: %+v", res2.Outcomes[0])
	}
}

// TestV1742_NumberedOldStripping — the model copied the numbered read
// output verbatim into old (Claude Code's classic): the prefixes strip
// and the edit lands.
func TestV1742_NumberedOldStripping(t *testing.T) {
	numbered := "     4│ func greet(name string) string {\n     5│ \treturn \"hello \" + name\n     6│ }"
	res := ApplyEditsPartial(v1742File, []EditSpec{
		{Old: numbered, New: "func greet(name string) string {\n\treturn \"hi \" + name\n}"},
	})
	if res.Applied != 1 {
		t.Fatalf("the numbered old must strip and land:\n%s", res.Outcomes[0].Err)
	}
	if !strings.Contains(res.Content, `return "hi " + name`) {
		t.Fatal("the replacement must land bare (no line numbers)")
	}
	if strings.Contains(res.Content, "│") {
		t.Fatal("no numbered prefix may leak into the file")
	}
}

// TestV1742_CRLFNormalization — a CRLF file patched with LF old (the
// normalization rung).
func TestV1742_CRLFNormalization(t *testing.T) {
	crlf := strings.ReplaceAll(v1742File, "\n", "\r\n")
	res := ApplyEditsPartial(crlf, []EditSpec{
		{Old: `return "hello " + name`, New: `return "hi " + name`},
	})
	if res.Applied != 1 {
		t.Fatalf("CRLF/LF drift must not block the edit:\n%s", res.Outcomes[0].Err)
	}
	if !strings.Contains(res.Content, `return "hi " + name`) {
		t.Fatal("the edit must land")
	}
}

// TestV1742_ZeroOfNIsHonestFailure — 0-of-N never writes: the verbs
// treat it as a real failure (nothing double-applies on retry).
func TestV1742_ZeroOfNIsHonestFailure(t *testing.T) {
	res := ApplyEditsPartial(v1742File, []EditSpec{
		{Old: "not here at all", New: "x"},
		{Old: "also not here", New: "y"},
	})
	if res.Applied != 0 || res.Failed != 2 {
		t.Fatalf("0-of-N must be honest: %+v", res)
	}
	if res.Content != v1742File {
		t.Fatal("0-of-N must not modify the content")
	}
}

// TestV1742_MultiMatchInPartial — the multi-match contract survives
// partial apply: the ambiguous edit FAILS with the all/occurrence
// teach, the unambiguous one lands.
func TestV1742_MultiMatchInPartial(t *testing.T) {
	res := ApplyEditsPartial(v1742File, []EditSpec{
		{Old: "// greet says hello.", New: "// greet says hi."},       // lands
		{Old: "name string) string {", New: "who string) string {"},  // 2 matches, ambiguous
	})
	if res.Applied != 1 || res.Failed != 1 {
		t.Fatalf("applied=%d failed=%d, want 1/1", res.Applied, res.Failed)
	}
	if !strings.Contains(res.Outcomes[1].Err, "appears 2 times") {
		t.Fatalf("the ambiguous edit must teach all/occurrence:\n%s", res.Outcomes[1].Err)
	}
}

// TestV1742_NumberLines — the cat -n anchor shape the read verb rides.
func TestV1742_NumberLines(t *testing.T) {
	out := NumberLines([]string{"a", "b"}, 41)
	if !strings.Contains(out, "    41│ a") || !strings.Contains(out, "    42│ b") {
		t.Fatalf("the anchor shape: %q", out)
	}
}
