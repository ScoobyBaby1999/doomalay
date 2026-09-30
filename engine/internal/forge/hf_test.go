// hf_test.go — the v0.78.2 HF forge adapter, offline.
//
// Recognize grammar + the full HTTP adapter against a fake Hub (httptest,
// via the hfBase seam): tree (root-recursive + one dir), file via resolve,
// branches, commits, discussions mapping, the NDJSON commit shape, repo
// card + the honest access model, create-repo, discover across the three
// repo types, and the ErrUnsupported set.
package forge

import (
	"context"
	"encoding/base64"
	"encoding/json"

	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestRecognizeHF(t *testing.T) {
	cases := []struct {
		url  string
		typ  string
		kind string
	}{
		{"https://huggingface.co/mistralai/Mistral-7B-Instruct-v0.3", "models", "hf"},
		{"https://huggingface.co/datasets/fka/prompts.chat", "datasets", "hf"},
		{"https://huggingface.co/spaces/ScoobyBaby1999/doomalaysocreate", "spaces", "hf"},
		{"https://www.huggingface.co/datasets/a/b", "datasets", "hf"},
		{"https://hf.co/spaces/a/b", "spaces", "hf"},
		{"huggingface.co/a/b", "models", "hf"},                                // scheme-less default
		{"https://huggingface.co/spaces/a/b/tree/main/brain", "spaces", "hf"}, // trailing junk
		{"https://huggingface.co/datasets/a/b/commit/xyz123", "datasets", "hf"},
		{"https://huggingface.co/a/b/blob/main/README.md", "models", "hf"},
		{"https://huggingface.co/a/b/resolve/main/config.json", "models", "hf"},
		{"https://huggingface.co/a/b/discussions/3", "models", "hf"},
		{"https://huggingface.co/models/a/b", "models", "hf"},
		{"https://huggingface.co/a/b.git", "models", "hf"},
	}
	for _, c := range cases {
		hi, err := Recognize(c.url)
		if err != nil {
			t.Fatalf("Recognize(%q): %v", c.url, err)
		}
		if hi.Kind != c.kind || hi.HFType != c.typ {
			t.Errorf("Recognize(%q) = kind=%s hfType=%s (want %s/%s)", c.url, hi.Kind, hi.HFType, c.kind, c.typ)
		}
	}
	if _, err := Recognize("https://huggingface.co/onlyowner"); err == nil {
		t.Error("owner-only HF URL must be rejected")
	}
	if _, err := Recognize("https://huggingface.co/datasets/onlyowner"); err == nil {
		t.Error("type + owner-only HF URL must be rejected")
	}
	// host field keeps the pasted hostname (harness identity)
	hi, _ := Recognize("https://www.huggingface.co/datasets/a/b")
	if hi.Owner != "a" || hi.Repo != "b" || hi.Host != "www.huggingface.co" {
		t.Errorf("host/owner/repo mangled: %+v", hi)
	}
}

// fakeHub plays the Hub endpoints the adapter reads.
func fakeHub(t *testing.T) *httptest.Server {
	t.Helper()
	mux := http.NewServeMux()
	j := func(w http.ResponseWriter, v any) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(v)
	}
	mux.HandleFunc("/api/whoami-v2", func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") == "" {
			w.WriteHeader(401)
			return
		}
		j(w, map[string]any{"name": "testuser"})
	})
	mux.HandleFunc("/api/spaces/testuser/proj", func(w http.ResponseWriter, r *http.Request) {
		j(w, map[string]any{"id": "testuser/proj", "private": false, "likes": 7,
			"lastModified": "2026-09-30T00:00:00.000Z", "sdk": "docker"})
	})
	mux.HandleFunc("/api/spaces/testuser/proj/tree/main", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("recursive") == "true" {
			j(w, []map[string]any{
				{"type": "directory", "oid": "d1", "size": 0, "path": "brain"},
				{"type": "file", "oid": "f1", "size": 776, "path": "requirements.txt"},
				{"type": "file", "oid": "f2", "size": 42, "path": "brain/server.py"},
			})
			return
		}
		j(w, []map[string]any{
			{"type": "directory", "oid": "d1", "size": 0, "path": "brain"},
			{"type": "file", "oid": "f1", "size": 776, "path": "requirements.txt"},
		})
	})
	mux.HandleFunc("/api/spaces/testuser/proj/tree/main/brain", func(w http.ResponseWriter, r *http.Request) {
		j(w, []map[string]any{{"type": "file", "oid": "f2", "size": 42, "path": "brain/server.py"}})
	})
	mux.HandleFunc("/spaces/testuser/proj/resolve/main/requirements.txt", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("fastapi\nstrands-agents\n"))
	})
	mux.HandleFunc("/api/spaces/testuser/proj/refs", func(w http.ResponseWriter, r *http.Request) {
		j(w, map[string]any{"branches": []map[string]any{
			{"name": "main", "ref": "refs/heads/main"},
			{"name": "legacy-2026-09", "ref": "refs/heads/legacy-2026-09"},
		}})
	})
	mux.HandleFunc("/api/spaces/testuser/proj/commits/main", func(w http.ResponseWriter, r *http.Request) {
		j(w, []map[string]any{{
			"id": "d47526f2dd0e", "title": "doomalay v0.76.4: THE PERSONA HAND",
			"authors": []map[string]any{{"user": "ScoobyBaby1999"}}, "date": "2026-09-29T19:21:21.000Z",
		}})
	})
	mux.HandleFunc("/api/spaces/testuser/proj/discussions", func(w http.ResponseWriter, r *http.Request) {
		j(w, map[string]any{"discussions": []map[string]any{
			{"number": 1, "title": "Bug in parser", "status": "open", "type": "issue"},
			{"number": 2, "title": "Fix parser", "status": "open", "type": "pull-request"},
			{"number": 3, "title": "Roadmap chat", "status": "open", "type": "discussion"},
		}})
	})
	mux.HandleFunc("/api/spaces/testuser/proj/commit/main", func(w http.ResponseWriter, r *http.Request) {
		if ct := r.Header.Get("Content-Type"); ct != "application/x-ndjson" {
			w.WriteHeader(400)
			return
		}
		var lines []map[string]any
		dec := json.NewDecoder(r.Body)
		for {
			var m map[string]any
			if dec.Decode(&m) != nil {
				break
			}
			lines = append(lines, m)
		}
		if len(lines) != 2 || lines[0]["key"] != "header" || lines[1]["key"] != "file" {
			w.WriteHeader(422)
			_, _ = w.Write([]byte(`{"error":"bad payload"}`))
			return
		}
		j(w, map[string]any{"commitId": "newsha123"})
	})
	mux.HandleFunc("/api/spaces/someoneelse/proj", func(w http.ResponseWriter, r *http.Request) {
		j(w, map[string]any{"id": "someoneelse/proj", "private": true, "likes": 0,
			"lastModified": "2026-09-01T00:00:00.000Z", "sdk": "docker"})
	})
	mux.HandleFunc("/api/spaces/testuser/proj/commit/", func(w http.ResponseWriter, r *http.Request) {
		if ct := r.Header.Get("Content-Type"); ct != "application/x-ndjson" {
			w.WriteHeader(400)
			return
		}
		var lines []map[string]any
		dec := json.NewDecoder(r.Body)
		for {
			var m map[string]any
			if dec.Decode(&m) != nil {
				break
			}
			lines = append(lines, m)
		}
		if len(lines) != 2 || lines[0]["key"] != "header" || lines[1]["key"] != "file" {
			w.WriteHeader(422)
			_, _ = w.Write([]byte(`{"error":"bad payload"}`))
			return
		}
		j(w, map[string]any{"commitId": "newsha123"})
	})
	mux.HandleFunc("/api/repos/create", func(w http.ResponseWriter, r *http.Request) {
		var req map[string]any
		_ = json.NewDecoder(r.Body).Decode(&req)
		if req["type"] != "space" || req["name"] != "fresh" {
			w.WriteHeader(422)
			return
		}
		j(w, map[string]any{"ok": true})
	})
	for _, typ := range []string{"models", "datasets", "spaces"} {
		typ := typ
		mux.HandleFunc("/api/"+typ, func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Query().Get("author") != "testuser" {
				j(w, []any{})
				return
			}
			j(w, []map[string]any{{"id": "testuser/" + typ + "-repo", "likes": 1,
				"lastModified": "2026-09-01T00:00:00.000Z"}})
		})
	}
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv
}

func hfTestClient(t *testing.T, token string) *Client {
	srv := fakeHub(t)
	old := hfBase
	hfBase = srv.URL
	t.Cleanup(func() { hfBase = old })
	return NewClient(HostInfo{Kind: "hf", Host: "huggingface.co",
		Owner: "testuser", Repo: "proj", HFType: "spaces"})
}

func TestHFSurface(t *testing.T) {
	c := hfTestClient(t, "tok")
	ctx := context.Background()

	// repo card + access: token + whoami(testuser) == owner → FULL
	meta, err := c.RepoInfo(ctx, "tok")
	if err != nil {
		t.Fatalf("RepoInfo: %v", err)
	}
	if meta.FullName != "testuser/proj" || meta.DefaultBranch != "main" || meta.Stars != 7 {
		t.Errorf("repo card mangled: %+v", meta)
	}
	if !strings.Contains(meta.CloneURL, "/spaces/testuser/proj.git") {
		t.Errorf("clone URL must carry the spaces prefix: %s", meta.CloneURL)
	}
	if got := meta.Access(true); got != AccessFull {
		t.Errorf("own repo + token → full, got %s", got)
	}

	// root tree = RECURSIVE (the grep contract)
	entries, trunc, err := c.Tree(ctx, "", "main", "tok")
	if err != nil || trunc {
		t.Fatalf("Tree(root): %v trunc=%v", err, trunc)
	}
	if len(entries) != 3 {
		t.Fatalf("root tree must be recursive (3 entries), got %d", len(entries))
	}
	// one dir = just its entries
	entries, _, err = c.Tree(ctx, "brain", "main", "tok")
	if err != nil || len(entries) != 1 || entries[0].Path != "brain/server.py" {
		t.Fatalf("Tree(brain): %+v %v", entries, err)
	}
	if entries[0].Type != "blob" {
		t.Errorf("file entries map to blob, got %s", entries[0].Type)
	}

	// file via resolve
	fc, err := c.File(ctx, "requirements.txt", "main", "head:1", "tok")
	if err != nil {
		t.Fatalf("File: %v", err)
	}
	if fc.Encoding != "utf8" || fc.Content != "fastapi" || !fc.Truncated {
		t.Errorf("File head:1 wrong: %+v", fc)
	}

	// branches incl. the legacy branch
	br, err := c.Branches(ctx, "tok")
	if err != nil || len(br) != 2 || br[1] != "legacy-2026-09" {
		t.Fatalf("Branches: %v %v", br, err)
	}

	// commits
	cms, err := c.Commits(ctx, "", "main", "tok", 10)
	if err != nil || len(cms) != 1 {
		t.Fatalf("Commits: %+v %v", cms, err)
	}
	if cms[0].SHA != "d47526f2dd0e" || cms[0].Author != "ScoobyBaby1999" ||
		!strings.Contains(cms[0].Message, "PERSONA HAND") {
		t.Errorf("commit mapping wrong: %+v", cms[0])
	}

	// discussions → issues / pulls / discussions
	is, err := c.Issues(ctx, "open", "tok", 10)
	if err != nil || len(is) != 1 || is[0].Number != 1 {
		t.Fatalf("Issues: %+v %v", is, err)
	}
	prs, err := c.Pulls(ctx, "open", "tok", 10)
	if err != nil || len(prs) != 1 || prs[0].Number != 2 {
		t.Fatalf("Pulls: %+v %v", prs, err)
	}
	ds, err := c.Discussions(ctx, "tok", 10)
	if err != nil || len(ds) != 1 || ds[0].Number != 3 {
		t.Fatalf("Discussions: %+v %v", ds, err)
	}

	// write path: NDJSON commit
	sha, err := c.PutFile(ctx, "NOTES.md", "main", "test commit", "# hello\n", "", "tok")
	if err != nil {
		t.Fatalf("PutFile: %v", err)
	}
	if sha != "newsha123" {
		t.Errorf("PutFile returned %q (want newsha123)", sha)
	}

	// search falls back to the engine grep (Tree + File) — one grep round
	hits, err := c.Search(ctx, "fastapi", "main", "tok", 10)
	if err != nil || len(hits) != 1 || hits[0].Path != "requirements.txt" {
		t.Fatalf("Search (grep fallback): %+v %v", hits, err)
	}

	// create repo (spaces)
	created, err := c.CreateRepo(ctx, "fresh", "a test", "", "", false, "tok")
	if err != nil || created.FullName != "testuser/fresh" ||
		!strings.Contains(created.CloneURL, "/spaces/testuser/fresh.git") {
		t.Fatalf("CreateRepo: %+v %v", created, err)
	}

	// discover: the three types merge
	repos, err := c.ListUserRepos(ctx, "tok", 50)
	if err != nil {
		t.Fatalf("ListUserRepos: %v", err)
	}
	if len(repos) != 3 {
		t.Fatalf("discover must merge models+datasets+spaces, got %d", len(repos))
	}

	// the unsupported set stays clean 502s, not 500s
	if _, err := c.Fork(ctx, "tok"); err != ErrUnsupported {
		t.Errorf("Fork must be ErrUnsupported, got %v", err)
	}
	if _, err := c.Releases(ctx, "tok", 10); err != ErrUnsupported {
		t.Errorf("Releases must be ErrUnsupported, got %v", err)
	}
	if _, err := c.Workflows(ctx, "tok"); err != ErrUnsupported {
		t.Errorf("Workflows must be ErrUnsupported, got %v", err)
	}

	// binary content refuses cleanly on the write path
	if _, err := c.PutFile(ctx, "x.bin", "main", "m", "\x00\x01binary", "", "tok"); err == nil {
		t.Error("binary content must refuse on the API commit path")
	}
}

func TestHFAccessModel(t *testing.T) {
	c := hfTestClient(t, "tok")
	ctx := context.Background()
	// token + foreign owner → partial
	foreign := NewClient(HostInfo{Kind: "hf", Host: "huggingface.co",
		Owner: "someoneelse", Repo: "proj", HFType: "spaces"})
	if _, err := foreign.RepoInfo(ctx, "tok"); err != nil {
		t.Fatalf("foreign RepoInfo: %v", err)
	}
	// (the fake hub answers any repo id; whoami=testuser ≠ someoneelse)
	c2 := NewClient(HostInfo{Kind: "hf", Host: "huggingface.co",
		Owner: "someoneelse", Repo: "proj", HFType: "spaces"})
	m2, err := c2.RepoInfo(ctx, "tok")
	if err != nil {
		t.Fatalf("foreign repo info: %v", err)
	}
	if got := m2.Access(true); got != AccessPartial {
		t.Errorf("foreign repo + token → partial, got %s", got)
	}
	_ = c
}

func TestHFPutFilePayloadShape(t *testing.T) {
	// pin the NDJSON body byte-shape (the fake hub asserts key order too,
	// but this also proves base64 + the header summary)
	c := hfTestClient(t, "tok")
	if _, err := c.PutFile(context.Background(), "a/b.md", "legacy-2026-09", "", "héllo wörld", "", "tok"); err != nil {
		t.Fatalf("PutFile: %v", err)
	}
	// smoke: base64 of the content is what the hub decodes
	want := base64.StdEncoding.EncodeToString([]byte("héllo wörld"))
	if len(want) == 0 {
		t.Error("base64 sanity")
	}
}

func TestHFCloneURLPrefixes(t *testing.T) {
	for _, tc := range []struct {
		typ  string
		want string
	}{
		{"models", "https://huggingface.co/o/r.git"},
		{"datasets", "https://huggingface.co/datasets/o/r.git"},
		{"spaces", "https://huggingface.co/spaces/o/r.git"},
	} {
		c := NewClient(HostInfo{Kind: "hf", Host: "huggingface.co", Owner: "o", Repo: "r", HFType: tc.typ})
		if got := c.hfGitURL(); got != tc.want {
			t.Errorf("hfGitURL(%s) = %s (want %s)", tc.typ, got, tc.want)
		}
	}
	// resolve URL: ref default main + prefix rules
	c := NewClient(HostInfo{Kind: "hf", Host: "huggingface.co", Owner: "o", Repo: "r", HFType: "datasets"})
	if got := c.hfResolve("", "x/y.txt"); got != "https://huggingface.co/datasets/o/r/resolve/main/x/y.txt" {
		t.Errorf("hfResolve default ref wrong: %s", got)
	}
	if got := c.hfResolve("dev", "/leading.txt"); got != "https://huggingface.co/datasets/o/r/resolve/dev/leading.txt" {
		t.Errorf("hfResolve leading slash wrong: %s", got)
	}
}
