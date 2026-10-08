// v1191_whole_truth_test.go — v1.19.1 THE WHOLE TRUTH pins (PLAN-V119 §v1.19.1).
//
// The old world: the fetcher clamped output at 12,000 chars, workspace
// reads died at 6,000, grep stopped at 50 hits, and every tool_result event
// was clipped to 600 for the UI. The user's verdict: "It shouldn't truncate
// a thing." These pins prove the fetch layer returns WHOLE content — against
// a fake GitHub (httptest) so the numbers are exact.
package forge

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// fakeGitHub mounts a minimal REST surface: a contents API serving one file
// of arbitrary size, and a recursive tree listing N files.
func fakeGitHub(t *testing.T, fileSize int, treeFiles int) *httptest.Server {
	t.Helper()
	big := strings.Repeat("a", fileSize)
	mux := http.NewServeMux()
	mux.HandleFunc("/repos/o/r/contents/README.md", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"name": "README.md", "path": "README.md", "size": fileSize,
			"sha": "deadbeef", "encoding": "base64",
			"content": base64.StdEncoding.EncodeToString([]byte(big)),
		})
	})
	mux.HandleFunc("/repos/o/r/git/trees/HEAD", func(w http.ResponseWriter, r *http.Request) {
		tree := make([]map[string]any, 0, treeFiles)
		for i := 0; i < treeFiles; i++ {
			tree = append(tree, map[string]any{
				"path": fmt.Sprintf("docs/file%03d.txt", i),
				"type": "blob", "mode": "100644", "size": 128, "sha": fmt.Sprintf("sha%03d", i),
			})
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"truncated": false, "tree": tree})
	})
	for i := 0; i < treeFiles; i++ {
		p := fmt.Sprintf("/repos/o/r/contents/docs/file%03d.txt", i)
		body := fmt.Sprintf("needle content %03d\n", i)
		mux.HandleFunc(p, func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"name": p, "path": strings.TrimPrefix(r.URL.Path, "/repos/o/r/contents/"),
				"size": len(body), "sha": "x", "encoding": "base64",
				"content": base64.StdEncoding.EncodeToString([]byte(body)),
			})
		})
	}
	return httptest.NewServer(mux)
}

// TestGhFileFullContentBeyondOldCaps: a 50 KB file rides the contents API
// whole — the old 6,000-char workspace body cap and 12,000-char fetch cap
// have no successor anywhere under File().
func TestGhFileFullContentBeyondOldCaps(t *testing.T) {
	srv := fakeGitHub(t, 50_000, 0)
	defer srv.Close()
	old := GitHubAPIBase
	GitHubAPIBase = srv.URL
	defer func() { GitHubAPIBase = old }()

	c := NewClient(HostInfo{Kind: "github", Owner: "o", Repo: "r", APIBase: srv.URL})
	fc, err := c.File(context.Background(), "README.md", "", "", "")
	if err != nil {
		t.Fatalf("File: %v", err)
	}
	if len(fc.Content) != 50_000 {
		t.Fatalf("File content length = %d, want 50000 (the whole-truth law: no cap between the wire and the caller)", len(fc.Content))
	}
	if strings.Count(fc.Content, "a") != 50_000 {
		t.Fatalf("content mangled")
	}
}

// TestGrepUnlimitedDefault: 120 candidate files all match; limit<=0 (the new
// workspace-grep default) must return ALL of them — the old clampLimit(0,50)
// silently stopped at 50.
func TestGrepUnlimitedDefault(t *testing.T) {
	srv := fakeGitHub(t, 0, 120)
	defer srv.Close()
	old := GitHubAPIBase
	GitHubAPIBase = srv.URL
	defer func() { GitHubAPIBase = old }()

	c := NewClient(HostInfo{Kind: "github", Owner: "o", Repo: "r", APIBase: srv.URL})
	hits, err := Grep(context.Background(), c, "needle", "", "", 0)
	if err != nil {
		t.Fatalf("Grep: %v", err)
	}
	if len(hits) != 120 {
		t.Fatalf("Grep(limit=0) hits = %d, want 120 — an unlimited grep may not stop early", len(hits))
	}
}
