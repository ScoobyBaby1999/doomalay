package forge

// v1526_one_commit_test.go — v1.52.6 THE ONE COMMIT + v1.52.7 THE SYNC EYE
// pins, against a fake GitHub (the GitHubAPIBase seam): the full git-data
// sequence for a multi-file atomic commit (ref → commit → tree → commit →
// PATCH ref force:false), the 422 strict-push guard, and the compare
// shapes (behind/ahead + each side's files).

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

// fakeGitData mounts the git data API surface for ONE branch shape:
// main @ head "head1" (tree "tree1"), plus the compare endpoint with
// configurable ahead/behind and per-side files.
func fakeGitData(t *testing.T) (*httptest.Server, *gitDataState) {
	t.Helper()
	st := &gitDataState{
		head:  "head1",
		trees: map[string]string{"head1": "tree1"},
	}
	mux := http.NewServeMux()
	// 1. the branch head
	mux.HandleFunc("/repos/o/r/git/ref/heads/main", func(w http.ResponseWriter, r *http.Request) {
		st.mu.Lock()
		defer st.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"ref":    "refs/heads/main",
			"object": map[string]any{"sha": st.head, "type": "commit"},
		})
	})
	// 2. the head commit → its tree
	mux.HandleFunc("/repos/o/r/git/commits/", func(w http.ResponseWriter, r *http.Request) {
		sha := strings.TrimPrefix(r.URL.Path, "/repos/o/r/git/commits/")
		st.mu.Lock()
		tree, ok := st.trees[sha]
		st.mu.Unlock()
		if !ok {
			w.WriteHeader(404)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"sha": sha, "tree": map[string]any{"sha": tree},
		})
	})
	// 3. POST /git/trees — record the entries, answer a fresh tree sha
	mux.HandleFunc("/repos/o/r/git/trees", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "POST" {
			w.WriteHeader(405)
			return
		}
		var body struct {
			BaseTree string `json:"base_tree"`
			Tree     []struct {
				Path    string  `json:"path"`
				Mode    string  `json:"mode"`
				Type    string  `json:"type"`
				Content *string `json:"content"`
				SHA     *string `json:"sha"`
			} `json:"tree"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		st.mu.Lock()
		st.lastBaseTree = body.BaseTree
		st.lastTreeEntries = body.Tree
		st.treeSeq++
		newTree := fmt.Sprintf("tree%d", st.treeSeq)
		st.trees[newTree] = newTree
		st.mu.Unlock()
		_ = json.NewEncoder(w).Encode(map[string]any{"sha": newTree})
	})
	// 4. POST /git/commits — record message/parents, answer a commit sha
	mux.HandleFunc("/repos/o/r/git/commits", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "POST" {
			w.WriteHeader(405)
			return
		}
		var body struct {
			Message string   `json:"message"`
			Tree    string   `json:"tree"`
			Parents []string `json:"parents"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		st.mu.Lock()
		st.lastCommitMsg = body.Message
		st.lastParents = body.Parents
		st.commitSeq++
		newCommit := fmt.Sprintf("commit%d", st.commitSeq)
		st.trees[newCommit] = body.Tree
		st.mu.Unlock()
		_ = json.NewEncoder(w).Encode(map[string]any{
			"sha": newCommit, "html_url": "https://github.com/o/r/commit/" + newCommit,
		})
	})
	// 5. PATCH /git/refs/heads/main — the strict-push guard
	mux.HandleFunc("/repos/o/r/git/refs/heads/main", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "PATCH" {
			w.WriteHeader(405)
			return
		}
		var body struct {
			SHA   string `json:"sha"`
			Force bool   `json:"force"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		st.mu.Lock()
		st.lastRefUpdate = body
		if st.refFails {
			st.mu.Unlock()
			w.WriteHeader(422)
			_ = json.NewEncoder(w).Encode(map[string]any{
				"message": "Update is not a fast forward",
			})
			return
		}
		st.head = body.SHA
		st.mu.Unlock()
		_ = json.NewEncoder(w).Encode(map[string]any{"ref": "refs/heads/main"})
	})
	// 6. compare — configurable per basehead pair
	mux.HandleFunc("/repos/o/r/compare/", func(w http.ResponseWriter, r *http.Request) {
		pair := strings.TrimPrefix(r.URL.Path, "/repos/o/r/compare/")
		st.mu.Lock()
		cmp, ok := st.compares[pair]
		st.mu.Unlock()
		if !ok {
			w.WriteHeader(404)
			return
		}
		files := make([]map[string]any, 0, len(cmp.files))
		for _, f := range cmp.files {
			files = append(files, map[string]any{"filename": f})
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"ahead_by": cmp.ahead, "behind_by": cmp.behind,
			"merge_base_commit": map[string]any{"sha": cmp.mergeBase},
			"files":             files,
		})
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv, st
}

type gitDataState struct {
	mu              sync.Mutex
	head            string
	trees           map[string]string
	treeSeq         int
	commitSeq       int
	lastBaseTree    string
	lastTreeEntries []struct {
		Path    string  `json:"path"`
		Mode    string  `json:"mode"`
		Type    string  `json:"type"`
		Content *string `json:"content"`
		SHA     *string `json:"sha"`
	}
	lastCommitMsg string
	lastParents   []string
	lastRefUpdate struct {
		SHA   string `json:"sha"`
		Force bool   `json:"force"`
	}
	refFails bool
	compares map[string]fakeCompare
}

type fakeCompare struct {
	ahead, behind int
	mergeBase     string
	files         []string
}

func v1526Client(t *testing.T, srv *httptest.Server) *Client {
	t.Helper()
	oldGH := GitHubAPIBase
	GitHubAPIBase = srv.URL
	t.Cleanup(func() { GitHubAPIBase = oldGH })
	return NewClient(HostInfo{Kind: "github", Owner: "o", Repo: "r"})
}

// THE ONE COMMIT: writes + deletes in one atomic commit, the exact API
// shapes, and the force:false guard on the ref update.
func TestV1526_CommitFilesAtomic(t *testing.T) {
	srv, st := fakeGitData(t)
	c := v1526Client(t, srv)
	st.mu.Lock()
	st.compares = map[string]fakeCompare{}
	st.mu.Unlock()

	url, err := c.CommitFiles(context.Background(), "main", "the wave: 3 files, one commit", []TreeWrite{
		{Path: "app/glow.css", Content: ".wsx-conn[data-empty] { animation: wsx-glow 2s infinite; }"},
		{Path: "engine/internal/buildinfo/buildinfo.go", Content: "var Version = \"1.51.9\""},
		{Path: "old/dead.go", Delete: true},
	}, "tok")
	if err != nil {
		t.Fatalf("CommitFiles: %v", err)
	}
	if !strings.Contains(url, "/commit/commit1") {
		t.Fatalf("the commit URL must ride, got %s", url)
	}
	st.mu.Lock()
	defer st.mu.Unlock()
	// the tree rode the base_tree + inline content + the sha:null delete
	if st.lastBaseTree != "tree1" {
		t.Fatalf("base_tree must be the head's tree, got %q", st.lastBaseTree)
	}
	if len(st.lastTreeEntries) != 3 {
		t.Fatalf("3 entries must ride one tree, got %d", len(st.lastTreeEntries))
	}
	var sawDelete bool
	for _, e := range st.lastTreeEntries {
		if e.SHA == nil && e.Path == "old/dead.go" {
			sawDelete = true
		}
	}
	if !sawDelete {
		t.Fatal("the delete must ride as sha:null")
	}
	var sawContent bool
	for _, e := range st.lastTreeEntries {
		if e.Content != nil && strings.Contains(*e.Content, "wsx-glow") {
			sawContent = true
		}
	}
	if !sawContent {
		t.Fatal("the write must ride as inline content")
	}
	// the commit rode the message + the head as its only parent
	if st.lastCommitMsg != "the wave: 3 files, one commit" {
		t.Fatalf("the message must ride verbatim, got %q", st.lastCommitMsg)
	}
	if len(st.lastParents) != 1 || st.lastParents[0] != "head1" {
		t.Fatalf("the parent must be the old head, got %v", st.lastParents)
	}
	// the ref update is the strict-push guard
	if st.lastRefUpdate.Force {
		t.Fatal("the ref update must NEVER force")
	}
	if st.lastRefUpdate.SHA != "commit1" {
		t.Fatalf("the ref must move to the new commit, got %q", st.lastRefUpdate.SHA)
	}
}

// The 422: the remote moved under us → the honest re-apply answer, never
// a silent overwrite.
func TestV1526_StrictPushGuard(t *testing.T) {
	srv, st := fakeGitData(t)
	c := v1526Client(t, srv)
	st.mu.Lock()
	st.refFails = true
	st.mu.Unlock()
	_, err := c.CommitFiles(context.Background(), "main", "racing commit", []TreeWrite{
		{Path: "f.txt", Content: "x"},
	}, "tok")
	if err == nil {
		t.Fatal("a 422 must fail the commit")
	}
	if !strings.Contains(err.Error(), "moved under you") || !strings.Contains(err.Error(), "re-apply") {
		t.Fatalf("the 422 must teach the re-read-and-re-apply cure, got: %v", err)
	}
}

// THE SYNC EYE: the compare verdict + each side's files since the
// merge-base (the overlap forecast's raw material).
func TestV1527_CompareRefs(t *testing.T) {
	srv, st := fakeGitData(t)
	c := v1526Client(t, srv)
	st.mu.Lock()
	st.compares = map[string]fakeCompare{
		"main...feat": {ahead: 2, behind: 3, mergeBase: "mb1"},
		"mb1...main":  {files: []string{"engine/chat.go", "docs/README.md"}},
		"mb1...feat":  {files: []string{"app/panel.js", "engine/chat.go"}},
	}
	st.mu.Unlock()
	cmp, err := c.CompareRefs(context.Background(), "main", "feat", "tok")
	if err != nil {
		t.Fatalf("CompareRefs: %v", err)
	}
	if cmp.AheadBy != 2 || cmp.BehindBy != 3 || cmp.MergeBase != "mb1" {
		t.Fatalf("the verdict must ride: %+v", cmp)
	}
	if len(cmp.BaseFiles) != 2 || len(cmp.HeadFiles) != 2 {
		t.Fatalf("each side's files must ride: %+v", cmp)
	}
	// the overlap is computable from the two lists (chat.go is on both)
	both := map[string]bool{}
	for _, f := range cmp.HeadFiles {
		both[f] = true
	}
	overlap := false
	for _, f := range cmp.BaseFiles {
		if both[f] {
			overlap = true
		}
	}
	if !overlap {
		t.Fatal("engine/chat.go changed on BOTH sides — the forecast must see it")
	}
}

// A read-tier sanity: CommitFiles on an unsupported forge answers
// ErrUnsupported (the clean teach, never a 500).
func TestV1526_UnsupportedKind(t *testing.T) {
	c := NewClient(HostInfo{Kind: "generic", Owner: "o", Repo: "r", APIBase: "https://x"})
	if _, err := c.CommitFiles(context.Background(), "main", "m", []TreeWrite{{Path: "f", Content: "x"}}, "t"); err == nil {
		t.Fatal("generic must answer ErrUnsupported")
	}
	if _, err := c.CompareRefs(context.Background(), "a", "b", "t"); err == nil {
		t.Fatal("generic compare must answer ErrUnsupported")
	}
}

// the base64 import stays referenced (the fake's future file shapes)
var _ = base64.StdEncoding
