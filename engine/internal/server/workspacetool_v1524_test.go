package server

// workspacetool_v1524_test.go — v1.52.4 THE HONEST TREE pins.
//
// The trippy (2).md log convicted the flood: a 1,459-entry repo listing
// (69,775 bytes) ridden THREE times (~210KB of context) because `tree`'s
// default view is a raw recursive dump that answers no question. The cure
// is a VIEW change, never a cut: past 200 entries the default becomes the
// dir summary (counts describe everything; {"recursive":true} returns the
// full listing verbatim), and `ls` at the root stops being a no-op filter
// that leaked the whole dump.

import (
	"fmt"
	"strings"
	"testing"

	"github.com/ScoobyBaby1999/doomalay/engine/internal/forge"
	"github.com/ScoobyBaby1999/doomalay/engine/internal/store"
)

// The 1,459-entry doomalay-scale repo: the summary renders ~30 honest
// lines (every top-level dir with counts), the recursive flag returns
// every entry verbatim.
func TestV1524_TreeSummaryShape(t *testing.T) {
	ws := &store.Workspace{Name: "doomalay", Kind: "github"}
	var entries []forge.TreeEntry
	// 30 top-level dirs × 46 files each = 1,380 files + 30 tree rows + 49 root files = 1,459
	for d := 0; d < 30; d++ {
		dir := fmt.Sprintf("dir%02d", d)
		entries = append(entries, forge.TreeEntry{Path: dir, Type: "tree"})
		for f := 0; f < 46; f++ {
			entries = append(entries, forge.TreeEntry{Path: fmt.Sprintf("%s/file%02d.go", dir, f), Type: "blob", Size: 1000})
		}
	}
	for f := 0; f < 49; f++ {
		entries = append(entries, forge.TreeEntry{Path: fmt.Sprintf("root%02d.md", f), Type: "blob", Size: 500})
	}
	if len(entries) != 1459 {
		t.Fatalf("fixture geometry: want 1459 entries (the log's real count), got %d", len(entries))
	}

	out := wsTreeSummaryText(ws, "", "main", entries, false)
	lines := strings.Split(strings.TrimRight(out, "\n"), "\n")
	if len(lines) > 100 {
		t.Fatalf("the 1,459-entry summary must stay compact (~80 lines), got %d", len(lines))
	}
	// THE METRIC THAT CONVICTED THE FLOOD: the raw dump was 69,775
	// bytes — the summary must land under 5KB while describing every
	// entry by count and size.
	if len(out) > 5000 {
		t.Fatalf("the summary must stay under 5KB for a 1,459-entry repo, got %d bytes", len(out))
	}
	// every top-level dir appears exactly once with its honest count
	for d := 0; d < 30; d++ {
		want := fmt.Sprintf("- dir%02d/ (dir — 46 files, ~", d)
		if !strings.Contains(out, want) {
			t.Fatalf("summary must carry %q", want)
		}
	}
	// the root files ride with sizes (humanBytes shape: "500B")
	if !strings.Contains(out, "- root00.md (500B)") {
		t.Fatalf("direct files must ride with sizes, got:\n%s", out[:400])
	}
	// the honest totals + the two narrowing verbs (1,459 rows = 1,429
	// files + 30 tree rows — the count describes EVERY entry)
	if !strings.Contains(out, "1459 entries (1429 files,") {
		t.Fatalf("honest totals must ride: %s", v1524FirstLine(out))
	}
	if !strings.Contains(out, `"recursive":true`) || !strings.Contains(out, `"path":"dir"`) {
		t.Fatal("the narrowing hint must teach both verbs")
	}
	// the classic listing stays VERBATIM under the threshold / with the flag
	small := entries[:150]
	classic := wsTreeText(ws, "", "main", small, false)
	if !strings.Contains(classic, "- dir00/file00.go (1000B)") {
		t.Fatal("the classic verbatim listing must keep every entry line")
	}
}

// `ls` at the ROOT: the old no-op filter leaked the full recursive dump;
// the honest ls semantics = direct children only.
func TestV1524_LsAtRootIsDirectChildrenOnly(t *testing.T) {
	entries := []forge.TreeEntry{
		{Path: "engine", Type: "tree"},
		{Path: "engine/cmd/doomalay/main.go", Type: "blob", Size: 10},
		{Path: "engine/internal/x.go", Type: "blob", Size: 20},
		{Path: "app", Type: "tree"},
		{Path: "README.md", Type: "blob", Size: 30},
		{Path: "go.mod", Type: "blob", Size: 5},
	}
	out := onlyDirsAndTopLevel(entries, "")
	if len(out) != 4 {
		var got []string
		for _, e := range out {
			got = append(got, e.Path)
		}
		t.Fatalf("ls at / must keep only the 4 direct children, got %d: %v", len(out), got)
	}
	// a scoped ls keeps its exact semantics (files in path + direct dirs)
	scoped := onlyDirsAndTopLevel(entries, "engine")
	for _, e := range scoped {
		if e.Path == "README.md" || e.Path == "app" {
			t.Fatalf("scoped ls leaked an outsider: %s", e.Path)
		}
	}
}

func v1524FirstLine(s string) string {
	if i := strings.Index(s, "\n"); i >= 0 {
		return s[:i]
	}
	return s
}
