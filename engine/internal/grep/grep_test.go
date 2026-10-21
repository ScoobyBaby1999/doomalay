// grep_test.go — v1.56.0 THE SOPHISTICATED GREP pins.
//
// The laws under test:
//   · ALL HITS: every matching line in every file is reported (the old
//     "first hit per file" fold is DEAD).
//   · REGEX: real patterns work; a RE2-refused pattern still works via
//     the .NET engine (and says so).
//   · GLOBS: include/exclude filter the corpus.
//   · CONTEXT: -A/-B/-C lines ride each hit.
//   · NO SILENT CAPS: a per-file ceiling is REPORTED.
package grep

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func writeTree(t *testing.T, files map[string]string) string {
	t.Helper()
	root := t.TempDir()
	for name, body := range files {
		p := filepath.Join(root, name)
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return root
}

// TestAllHitsInEveryFile: three files, two matches each — EVERY match is
// reported (the old fold reported one).
func TestAllHitsInEveryFile(t *testing.T) {
	root := writeTree(t, map[string]string{
		"a.go":  "needle one\nplain\nneedle two\n",
		"b.md":  "needle three\n",
		"c.txt": "nothing here\n",
	})
	m, err := New("needle", false, true, false)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	res, err := WalkDir(m, root, Options{})
	if err != nil {
		t.Fatalf("WalkDir: %v", err)
	}
	if res.Stats.Hits != 3 {
		t.Fatalf("hits = %d, want 3 (every match, every file)", res.Stats.Hits)
	}
	if res.Stats.FilesMatched != 2 {
		t.Fatalf("files matched = %d, want 2", res.Stats.FilesMatched)
	}
	// the hits are ordered by path (a stable, predictable order)
	if res.Hits[0].Path != "a.go" || res.Hits[0].Line != 1 {
		t.Fatalf("first hit = %+v, want a.go:1", res.Hits[0])
	}
	if res.Hits[1].Line != 3 {
		t.Fatalf("second hit line = %d, want 3", res.Hits[1].Line)
	}
}

// TestRegexPattern: a real regex (the old grep was a literal).
func TestRegexPattern(t *testing.T) {
	root := writeTree(t, map[string]string{
		"a.go": "func Alpha() {}\nfunc Beta() {}\nvar gamma = 1\n",
	})
	m, err := New(`func\s+\w+`, false, true, false)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	res, err := WalkDir(m, root, Options{})
	if err != nil {
		t.Fatalf("WalkDir: %v", err)
	}
	if res.Stats.Hits != 2 {
		t.Fatalf("hits = %d, want 2", res.Stats.Hits)
	}
}

// TestLookaroundFallsBackToRegexp2: a pattern RE2 refuses (a lookahead)
// still works — and the engine is REPORTED (never a silent failure).
func TestLookaroundFallsBackToRegexp2(t *testing.T) {
	root := writeTree(t, map[string]string{
		"a.go": "foo = 1\nbar = 2\n",
	})
	m, err := New(`foo(?=\s*=)`, false, false, false)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	if m.Engine() != "regexp2" {
		t.Fatalf("engine = %q, want regexp2 (the lookaround fallback)", m.Engine())
	}
	res, err := WalkDir(m, root, Options{})
	if err != nil {
		t.Fatalf("WalkDir: %v", err)
	}
	if res.Stats.Hits != 1 {
		t.Fatalf("hits = %d, want 1", res.Stats.Hits)
	}
}

// TestGlobFilters: the include/exclude globs filter the corpus.
func TestGlobFilters(t *testing.T) {
	root := writeTree(t, map[string]string{
		"a.go":      "needle\n",
		"b.md":      "needle\n",
		"docs/c.md": "needle\n",
		"vendor/v.go": "needle\n",
	})
	m, _ := New("needle", false, true, false)
	res, err := WalkDir(m, root, Options{
		IncludeGlobs: []string{"*.go", "docs/**"},
		ExcludeGlobs: []string{"vendor/**"},
	})
	if err != nil {
		t.Fatalf("WalkDir: %v", err)
	}
	got := map[string]bool{}
	for _, h := range res.Hits {
		got[h.Path] = true
	}
	if !got["a.go"] || !got["docs/c.md"] {
		t.Fatalf("hits = %v, want a.go + docs/c.md", got)
	}
	if got["b.md"] {
		t.Fatalf("b.md leaked past the include glob: %v", got)
	}
	if got["vendor/v.go"] {
		t.Fatalf("vendor leaked past the exclude glob: %v", got)
	}
}

// TestContextLines: -C lines ride each hit.
func TestContextLines(t *testing.T) {
	root := writeTree(t, map[string]string{
		"a.txt": "one\ntwo\nHIT\nfour\nfive\n",
	})
	m, _ := New("HIT", false, true, false)
	res, err := WalkDir(m, root, Options{Context: 1})
	if err != nil {
		t.Fatalf("WalkDir: %v", err)
	}
	if len(res.Hits) != 1 {
		t.Fatalf("hits = %d, want 1", len(res.Hits))
	}
	h := res.Hits[0]
	if len(h.Before) != 1 || h.Before[0] != "two" {
		t.Fatalf("before = %v, want [two]", h.Before)
	}
	if len(h.After) != 1 || h.After[0] != "four" {
		t.Fatalf("after = %v, want [four]", h.After)
	}
}

// TestPerFileCeilingIsReported: a ceiling is never silent.
func TestPerFileCeilingIsReported(t *testing.T) {
	root := writeTree(t, map[string]string{
		"a.txt": "x\nx\nx\nx\nx\n",
	})
	m, _ := New("x", false, true, false)
	res, err := WalkDir(m, root, Options{MaxPerFile: 2})
	if err != nil {
		t.Fatalf("WalkDir: %v", err)
	}
	if !res.Stats.Truncated {
		t.Fatalf("truncated flag = false — the ceiling was silent")
	}
	if res.Stats.Reason == "" {
		t.Fatalf("no reason — the ceiling was silent")
	}
	if len(res.Hits) != 2 {
		t.Fatalf("hits = %d, want 2 (the ceiling)", len(res.Hits))
	}
}

// TestFixedLiteral: the fixed mode escapes the pattern (a '.' is a dot).
func TestFixedLiteral(t *testing.T) {
	root := writeTree(t, map[string]string{
		"a.txt": "a.b\naxb\n",
	})
	m, err := New("a.b", true, true, false)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	if m.Engine() != "literal" {
		t.Fatalf("engine = %q, want literal", m.Engine())
	}
	res, _ := WalkDir(m, root, Options{})
	if res.Stats.Hits != 1 {
		t.Fatalf("hits = %d, want 1 (a literal dot does not match 'x')", res.Stats.Hits)
	}
}

// TestCaseSensitivityAndWord: the flags work.
func TestCaseSensitivityAndWord(t *testing.T) {
	root := writeTree(t, map[string]string{
		"a.txt": "Needle Needle\n",
	})
	ci, _ := New("needle", false, true, false)
	res, _ := WalkDir(ci, root, Options{})
	if res.Stats.Hits != 1 {
		t.Fatalf("case-insensitive hits = %d, want 1", res.Stats.Hits)
	}
	cs, _ := New("needle", false, false, false)
	res, _ = WalkDir(cs, root, Options{})
	if res.Stats.Hits != 0 {
		t.Fatalf("case-sensitive hits = %d, want 0", res.Stats.Hits)
	}
	w, _ := New("eedle", false, true, true)
	res, _ = WalkDir(w, root, Options{})
	if res.Stats.Hits != 0 {
		t.Fatalf("word-boundary hits = %d, want 0 ('eedle' is not a word)", res.Stats.Hits)
	}
}

// TestInvert: grep -v.
func TestInvert(t *testing.T) {
	root := writeTree(t, map[string]string{
		"a.txt": "keep\ndrop\nkeep2\n",
	})
	m, _ := New("drop", false, true, false)
	m.Invert = true
	res, _ := WalkDir(m, root, Options{})
	if res.Stats.Hits != 2 {
		t.Fatalf("invert hits = %d, want 2", res.Stats.Hits)
	}
}

// TestFilesOnlyAndCount: the -l and -c shapes.
func TestFilesOnlyAndCount(t *testing.T) {
	root := writeTree(t, map[string]string{
		"a.txt": "x\nx\n",
		"b.txt": "x\n",
	})
	m, _ := New("x", false, true, false)
	res, _ := WalkDir(m, root, Options{FilesOnly: true})
	if len(res.Hits) != 2 {
		t.Fatalf("files_only hits = %d, want 2 (one per file)", len(res.Hits))
	}
	for _, h := range res.Hits {
		if h.Line != 0 {
			t.Fatalf("files_only hit carries a line: %+v", h)
		}
	}
}

// TestEmptyPatternIsAnError: a bad pattern is an error, not a silent
// match-everything.
func TestEmptyPatternIsAnError(t *testing.T) {
	if _, err := New("", false, true, false); err == nil {
		t.Fatalf("empty pattern accepted")
	}
}

// TestBinaryFilesAreSkipped: a NUL byte means binary — skipped, not
// matched.
func TestBinaryFilesAreSkipped(t *testing.T) {
	root := writeTree(t, map[string]string{
		"bin.dat": "needle\x00needle\n",
		"a.txt":   "needle\n",
	})
	m, _ := New("needle", false, true, false)
	res, _ := WalkDir(m, root, Options{})
	if res.Stats.Hits != 1 {
		t.Fatalf("hits = %d, want 1 (the text file only)", res.Stats.Hits)
	}
}

// TestLongLinesDoNotBreakTheScanner: a 2MB line is a real line.
func TestLongLinesDoNotBreakTheScanner(t *testing.T) {
	root := writeTree(t, map[string]string{
		"a.txt": strings.Repeat("z", 2<<20) + "\nHIT\n",
	})
	m, _ := New("HIT", false, true, false)
	res, _ := WalkDir(m, root, Options{})
	if res.Stats.Hits != 1 {
		t.Fatalf("hits = %d, want 1", res.Stats.Hits)
	}
}
