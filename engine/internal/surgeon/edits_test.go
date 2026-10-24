package surgeon

// edits_test.go — v1.52.5 THE BLADE pins. The matrix the research set:
// exact / indent-flex / multi-count / occurrence / all / nearest-miss /
// sequential / dry-run preview shapes.

import (
        "strings"
        "testing"
)

const v1525File = `package main

// greet says hello.
func greet(name string) string {
        return "hello " + name
}

// farewell says bye.
func farewell(name string) string {
        return "bye " + name
}
`

func TestV1525_ExactMatch(t *testing.T) {
        out, reports, err := ApplyEdits(v1525File, []EditSpec{
                {Old: `return "hello " + name`, New: `return "hi " + name`},
        })
        if err != nil {
                t.Fatalf("exact match failed: %v", err)
        }
        if !strings.Contains(out, `return "hi " + name`) || strings.Contains(out, `"hello " + name`) {
                t.Fatalf("the surgical swap must land exactly once:\n%s", out)
        }
        if reports[0].Mode != "exact" || reports[0].Count != 1 {
                t.Fatalf("report: mode=%s count=%d", reports[0].Mode, reports[0].Count)
        }
}

func TestV1525_SequentialEdits(t *testing.T) {
        out, _, err := ApplyEdits(v1525File, []EditSpec{
                {Old: `// greet says hello.`, New: `// greet says hi (renamed).`},
                {Old: "func greet(name string) string {", New: "func greet(who string) string {", All: true},
                {Old: `return "hello " + name`, New: `return "hello " + who`},
        })
        if err != nil {
                t.Fatalf("sequential edits failed: %v", err)
        }
        if !strings.Contains(out, "func greet(who string) string {") || !strings.Contains(out, `"hello " + who`) {
                t.Fatalf("edit N must see edit N-1's output:\n%s", out)
        }
}

func TestV1525_MultipleOccurrencesNeverGuess(t *testing.T) {
        _, _, err := ApplyEdits(v1525File, []EditSpec{
                {Old: "name string) string {", New: "who string) string {"}, // appears 2×
        })
        if err == nil || !strings.Contains(err.Error(), "appears 2 times") {
                t.Fatalf("a multi-match without all/occurrence must fail honestly, got: %v", err)
        }
        // occurrence picks the 2nd (1-based)
        out, reports, err := ApplyEdits(v1525File, []EditSpec{
                {Old: "name string) string {", New: "who string) string {", Occurrence: 2},
        })
        if err != nil {
                t.Fatalf("occurrence=2 failed: %v", err)
        }
        if strings.Contains(out, "func greet(who") || !strings.Contains(out, "func farewell(who") {
                t.Fatalf("occurrence 2 must patch farewell, not greet:\n%s", out)
        }
        if reports[0].Count != 1 {
                t.Fatalf("occurrence patches exactly one, got %d", reports[0].Count)
        }
        // all replaces every match
        out, _, err = ApplyEdits(v1525File, []EditSpec{
                {Old: "name string) string {", New: "who string) string {", All: true},
        })
        if err != nil {
                t.Fatalf("all failed: %v", err)
        }
        if strings.Count(out, "who string) string {") != 2 || strings.Contains(out, "name string)") {
                t.Fatalf("all must patch both sites:\n%s", out)
        }
}

func TestV1525_IndentFlexRecovery(t *testing.T) {
        // the model copied the line with the WRONG indentation (one tab vs
        // the file's one tab + different depth) — the flex match recovers.
        file := "func outer() {\n\tif true {\n\t\treturn 1\n\t}\n\treturn 0\n}\n"
        // old written with plain spaces where the file has tabs
        edits := []EditSpec{{Old: "    return 1", New: "    return 42"}}
        out, reports, err := ApplyEdits(file, edits)
        if err != nil {
                t.Fatalf("indent-flex must recover the whitespace-shifted match: %v", err)
        }
        if !strings.Contains(out, "\t\treturn 42") {
                t.Fatalf("the replacement must land with the file's own indentation:\n%q", out)
        }
        if reports[0].Mode != "indent-flex" {
                t.Fatalf("report mode must be indent-flex, got %s", reports[0].Mode)
        }
}

func TestV1525_NotFoundNearestContext(t *testing.T) {
        _, _, err := ApplyEdits(v1525File, []EditSpec{
                {Old: "return \"greetings \" + name", New: "x"},
        })
        if err == nil {
                t.Fatal("a miss must fail")
        }
        msg := err.Error()
        // v1.74.2: the miss rides the similarity-window re-ask (aider's
        // "did you mean these actual lines") — the actual file lines, the
        // line numbers, and the re-read cure
        if !strings.Contains(msg, "did not apply") || !strings.Contains(msg, "hello") || !strings.Contains(msg, "lines ") {
                t.Fatalf("the miss must carry the actual-lines re-ask for one-round recovery: %v", err)
        }
        if !strings.Contains(msg, "re-read the file") {
                t.Fatalf("the miss must teach the cure: %v", err)
        }
}

func TestV1525_EmptyOldRefused(t *testing.T) {
        _, _, err := ApplyEdits(v1525File, []EditSpec{{Old: "", New: "x"}})
        if err == nil || !strings.Contains(err.Error(), "empty") {
                t.Fatalf("an empty old must be refused honestly, got %v", err)
        }
        if _, _, err := ApplyEdits(v1525File, nil); err == nil {
                t.Fatal("no edits must be refused")
        }
}

func TestV1525_DiffPreview(t *testing.T) {
        old := "line1\nline2\nline3\nline4\nline5\n"
        new := "line1\nline2 changed\nline3\nline4\nline5\n"
        d := DiffPreview(old, new)
        if !strings.Contains(d, "@@ -1,5 +1,5 @@") && !strings.HasPrefix(d, "@@") {
                t.Fatalf("the preview must carry hunk headers, got:\n%s", d)
        }
        if !strings.Contains(d, "- line2") || !strings.Contains(d, "+ line2 changed") {
                t.Fatalf("the preview must show the -/+ pair, got:\n%s", d)
        }
        if DiffPreview("same\n", "same\n") != "(no changes)" {
                t.Fatal("identical content must answer (no changes)")
        }
        // a multi-hunk diff splits with context gaps
        old2 := "a\nb\nc\nd\ne\nf\ng\nh\ni\nj\nk\nl\n"
        new2 := "a\nb\nX\nd\ne\nf\ng\nh\nY\nj\nk\nl\n"
        d2 := DiffPreview(old2, new2)
        if strings.Count(d2, "@@") != 2 {
                t.Fatalf("two far-apart changes must render two hunks, got:\n%s", d2)
        }
}

// The end-to-end shape the workspace patch verb rides: a big file (the
// 145KB wall the v1500 rig B model hit), patched surgically with NO
// whole-file rewrite by the model.
func TestV1525_BigFileSurgical(t *testing.T) {
        var sb strings.Builder
        sb.WriteString("package workspace\n\n")
        for i := 0; i < 3000; i++ {
                sb.WriteString("// method ")
                sb.WriteString(strings.Repeat("x", 20))
                sb.WriteString(" does thing ")
                if i == 1500 {
                        sb.WriteString("\nfunc theGlowTarget() {\n\t// glow: the connect pill accent\n\treturn nil\n}\n\n")
                }
                sb.WriteString("\n")
        }
        big := sb.String()
        edits := []EditSpec{{
                Old:  "\t// glow: the connect pill accent\n\treturn nil",
                New:  "\t// glow: the connect pill accent when nothing is connected\n\treturn theGlow()",
        }}
        out, reports, err := ApplyEdits(big, edits)
        if err != nil {
                t.Fatalf("the surgical edit on a %d-byte file failed: %v", len(big), err)
        }
        if !strings.Contains(out, "return theGlow()") {
                t.Fatal("the edit must land")
        }
        if len(out)-len(big) < 20 || len(out)-len(big) > 100 {
                t.Fatalf("the file must grow by the edit's delta only, got %d", len(out)-len(big))
        }
        if reports[0].OldLen == 0 || reports[0].NewLen == 0 {
                t.Fatal("the report must carry the spans")
        }
        // the preview stays proportional to the EDIT, not the file
        preview := DiffPreview(big, out)
        if len(preview) > 400 {
                t.Fatalf("the preview must stay small (proportional to the edit), got %d bytes", len(preview))
        }
}
