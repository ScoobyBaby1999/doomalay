package server

// workspacetool_test.go — v0.76.5 THE QUICK-CHAT WORKSPACE HAND tests.
//
// Locks in:
//  1. THE VERB SURFACE: list/help/tree/ls/read/readme/grep/view answer
//     with model-facing TEXT (the OBSERVATION shape the ReAct loop feeds
//     back); the unknown-action contract teaches every verb.
//  2. ACCESS TIERS: put refuses partial with the fork path; pr refuses
//     read-only with the fork path and OPENs at partial; fork needs a
//     token but never a tier.
//  3. THE MARKER HEADS: COMMITTED / PR OPENED / FORKED — deterministic
//     lines (future pill work matches them like "SKILL LOADED —").
//  4. WS RESOLUTION: id, owner/repo, bare name, suffix; the anti-thrash
//     no-match teach lists the actual workspaces.
//  5. THE MANIFEST: workspaceManifestFor composes the CONNECTED CLOUD
//     WORKSPACES block (rows + tier semantics) only when bound.
//  6. The REST twin: POST /api/workspaces/{id}/pr (the handler the brain
//     twin's pr verb calls).

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/ScoobyBaby1999/doomalay/engine/internal/config"
	"github.com/ScoobyBaby1999/doomalay/engine/internal/forge"
	"github.com/ScoobyBaby1999/doomalay/engine/internal/store"
)

// fakeGitHub serves the exact REST shapes the forge client parses.
func fakeV765GitHub(t *testing.T) *httptest.Server {
	t.Helper()
	mux := http.NewServeMux()
	write := func(w http.ResponseWriter, v any) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(v)
	}
	mux.HandleFunc("GET /repos/{owner}/{repo}", func(w http.ResponseWriter, r *http.Request) {
		write(w, map[string]any{
			"full_name":      r.PathValue("owner") + "/" + r.PathValue("repo"),
			"description":    "the fake repo",
			"default_branch": "main", "stargazers_count": 3, "language": "Go",
			"html_url": "https://e.test/" + r.PathValue("owner") + "/" + r.PathValue("repo"),
			"clone_url": "https://e.test/x.git",
		})
	})
	mux.HandleFunc("GET /repos/{owner}/{repo}/git/trees/{ref}", func(w http.ResponseWriter, r *http.Request) {
		write(w, map[string]any{"truncated": false, "tree": []map[string]any{
			{"path": "README.md", "type": "blob", "size": 42, "sha": "r1"},
			{"path": "src", "type": "tree", "sha": "t1"},
			{"path": "src/main.go", "type": "blob", "size": 100, "sha": "m1"},
		}})
	})
	mux.HandleFunc("GET /repos/{owner}/{repo}/contents/{path...}", func(w http.ResponseWriter, r *http.Request) {
		p := r.PathValue("path")
		if p == "src" {
			write(w, []map[string]any{
				{"name": "main.go", "path": "src/main.go", "type": "file", "size": 100, "sha": "m1"},
			})
			return
		}
		write(w, map[string]any{
			"name": "README.md", "path": p, "sha": "r1", "size": 42,
			"encoding": "base64",
			"content": "IyBoZWxsbwo=", // "# hello"
		})
	})
	mux.HandleFunc("PUT /repos/{owner}/{repo}/contents/{path...}", func(w http.ResponseWriter, r *http.Request) {
		write(w, map[string]any{"commit": map[string]any{
			"sha": "c9", "html_url": "https://e.test/commit/c9"}})
	})
	mux.HandleFunc("GET /repos/{owner}/{repo}/git/ref/heads/{branch}", func(w http.ResponseWriter, r *http.Request) {
		write(w, map[string]any{"ref": "refs/heads/" + r.PathValue("branch"), "object": map[string]any{"sha": "head123", "type": "commit"}})
	})
	mux.HandleFunc("POST /repos/{owner}/{repo}/git/refs", func(w http.ResponseWriter, r *http.Request) {
		var b map[string]any
		_ = json.NewDecoder(r.Body).Decode(&b)
		write(w, map[string]any{"ref": b["ref"], "object": map[string]any{"sha": "head123"}})
	})
	mux.HandleFunc("POST /repos/{owner}/{repo}/forks", func(w http.ResponseWriter, r *http.Request) {
		write(w, map[string]any{"full_name": "me/" + r.PathValue("repo") + "-fork"})
	})
	mux.HandleFunc("POST /repos/{owner}/{repo}/pulls", func(w http.ResponseWriter, r *http.Request) {
		var b map[string]any
		_ = json.NewDecoder(r.Body).Decode(&b)
		write(w, map[string]any{"number": 7, "html_url": "https://e.test/pr/7",
			"state": "open", "title": b["title"], "head": map[string]any{"ref": b["head"]}})
	})
	mux.HandleFunc("GET /repos/{owner}/{repo}/issues", func(w http.ResponseWriter, r *http.Request) {
		write(w, []map[string]any{{"number": 5, "title": "crash", "state": "open",
			"user": map[string]any{"login": "z"}, "updated_at": "2026-09-01T00:00:00Z"}})
	})
	mux.HandleFunc("GET /repos/{owner}/{repo}/pulls", func(w http.ResponseWriter, r *http.Request) {
		write(w, []map[string]any{{"number": 4, "title": "fix it", "state": "open",
			"user": map[string]any{"login": "z"}, "head": map[string]any{"ref": "fix"},
			"updated_at": "2026-09-01T00:00:00Z", "html_url": "https://e.test/pr/4"}})
	})
	mux.HandleFunc("GET /repos/{owner}/{repo}/commits", func(w http.ResponseWriter, r *http.Request) {
		write(w, []map[string]any{{"sha": "abc123def", "commit": map[string]any{
			"message": "init", "author": map[string]any{"name": "z", "date": "2026-09-01T00:00:00Z"}}}})
	})
	mux.HandleFunc("GET /repos/{owner}/{repo}/branches", func(w http.ResponseWriter, r *http.Request) {
		write(w, []map[string]any{{"name": "main"}, {"name": "dev"}})
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv
}

// newV765Server: in-memory store + a session with one bound FULL-access
// github workspace ("me/fullrepo"), one PARTIAL ("me/partrepo") and one
// READ ("me/readrepo"), all pointing at the fake github.
func newV765Server(t *testing.T) (*Server, string) {
	t.Helper()
	fake := fakeV765GitHub(t)
	old := forge.GitHubAPIBase
	forge.GitHubAPIBase = fake.URL
	t.Cleanup(func() { forge.GitHubAPIBase = old })

	dir := t.TempDir()
	db, err := store.Open(dir)
	if err != nil {
		t.Fatalf("store: %v", err)
	}
	if err := db.Migrate(); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	s := New(&config.Config{DataDir: dir}, db, nil)

	sess := &store.Session{ID: "v765sess", Title: "Workspace Tool", Model: "nvidia/x", Provider: "nvidia"}
	if err := db.CreateSession(sess); err != nil {
		t.Fatalf("session: %v", err)
	}
	// a PAT in the vault so the write verbs have a token (the fake never
	// validates it)
	if err := s.vault.Set("GITHUB_PAT", "github", "ghp_v765test", ""); err != nil {
		t.Fatalf("vault: %v", err)
	}
	mk := func(id, repo, access string) *store.Workspace {
		w := &store.Workspace{ID: id, Name: "me/" + repo,
			Kind: "github", Host: "github.com", Owner: "me", Repo: repo, Branch: "main",
			DefaultBranch: "main", Access: access, RepoURL: "https://e.test/me/" + repo}
		if err := db.CreateWorkspace(w); err != nil {
			t.Fatalf("workspace %s: %v", repo, err)
		}
		if err := db.BindWorkspace(sess.ID, w.ID); err != nil {
			t.Fatalf("bind %s: %v", repo, err)
		}
		return w
	}
	mk("aaaa00000001", "fullrepo", forge.AccessFull)
	mk("aaaa00000002", "partrepo", forge.AccessPartial)
	mk("aaaa00000003", "readrepo", forge.AccessRead)
	return s, sess.ID
}

func wsRun(s *Server, sid, args string) string {
	return s.runWorkspaceAction(context.Background(), sid, args)
}

func TestV765_ListAndHelpTeach(t *testing.T) {
	s, sid := newV765Server(t)
	out := wsRun(s, sid, `{"action":"list"}`)
	if !strings.Contains(out, "3 connected workspace(s)") || !strings.Contains(out, "me/fullrepo [id=") {
		t.Fatalf("list: %q", out)
	}
	out = wsRun(s, sid, `{"action":"help"}`)
	for _, v := range []string{"tree", "read", "put", `"pr"`, "fork", "discover", "view"} {
		if !strings.Contains(out, v) {
			t.Fatalf("help missing %q: %q", v, out)
		}
	}
	// unknown action → the verb contract
	out = wsRun(s, sid, `{"action":"zzz"}`)
	if !strings.Contains(out, "unknown workspace action") || !strings.Contains(out, workspaceVerbs) {
		t.Fatalf("unknown action: %q", out)
	}
}

func TestV765_NoWorkspaceHonestTeach(t *testing.T) {
	s, _ := newV765Server(t)
	out := wsRun(s, "unknown-session", `{"action":"list"}`)
	if !strings.Contains(out, "no cloud workspace is connected") || !strings.Contains(out, "+workspace pill") {
		t.Fatalf("no-ws teach: %q", out)
	}
	out = wsRun(s, "unknown-session", `{"action":"read","ws":"x","path":"y"}`)
	if !strings.Contains(out, "no cloud workspace is connected") {
		t.Fatalf("no-ws read: %q", out)
	}
}

func TestV765_ReadVerbs(t *testing.T) {
	s, sid := newV765Server(t)
	out := wsRun(s, sid, `{"action":"info","ws":"me/fullrepo"}`)
	if !strings.Contains(out, "me/fullrepo [github] access=full") || !strings.Contains(out, "default branch: main") {
		t.Fatalf("info: %q", out)
	}
	out = wsRun(s, sid, `{"action":"tree","ws":"fullrepo"}`)
	if !strings.Contains(out, "me/fullrepo at /") || !strings.Contains(out, "src/ (dir)") || !strings.Contains(out, "README.md") {
		t.Fatalf("tree: %q", out)
	}
	out = wsRun(s, sid, `{"action":"ls","ws":"me/fullrepo","path":"src"}`)
	if !strings.Contains(out, "main.go") {
		t.Fatalf("ls: %q", out)
	}
	out = wsRun(s, sid, `{"action":"read","ws":"me/fullrepo","path":"README.md"}`)
	if !strings.Contains(out, "# hello") || !strings.Contains(out, "blob sha r1") {
		t.Fatalf("read: %q", out)
	}
	out = wsRun(s, sid, `{"action":"readme","ws":"me/fullrepo"}`)
	if !strings.Contains(out, "README of me/fullrepo") {
		t.Fatalf("readme: %q", out)
	}
}

func TestV765_ViewVerbs(t *testing.T) {
	s, sid := newV765Server(t)
	for _, c := range []struct{ what, want string }{
		{"issues", "issue(s) in me/fullrepo"},
		{"pulls", "pull request(s) in me/fullrepo"},
		{"commits", "commit(s) in me/fullrepo"},
		{"branches", "branch(es) in me/fullrepo"},
	} {
		out := wsRun(s, sid, `{"action":"view","ws":"me/fullrepo","what":"`+c.what+`"}`)
		if !strings.Contains(out, c.want) {
			t.Fatalf("view %s: %q", c.what, out)
		}
	}
	out := wsRun(s, sid, `{"action":"view","ws":"me/fullrepo","what":"bogus"}`)
	if !strings.Contains(out, "unknown view") {
		t.Fatalf("view bogus: %q", out)
	}
}

func TestV765_PutAccessGate(t *testing.T) {
	s, sid := newV765Server(t)
	// partial → refusal with the fork path (the honest tier teach)
	out := wsRun(s, sid, `{"action":"put","ws":"me/partrepo","path":"a.txt","content":"x"}`)
	if !strings.Contains(out, "access=partial") || !strings.Contains(out, "FULL access") {
		t.Fatalf("put partial: %q", out)
	}
	// full → the real PUT (sha fetch + commit) + the marker head
	out = wsRun(s, sid, `{"action":"put","ws":"me/fullrepo","path":"README.md","content":"# new","message":"up"}`)
	if !strings.Contains(out, "COMMITTED — README.md @ main") || !strings.Contains(out, "https://e.test/commit/c9") {
		t.Fatalf("put full: %q", out)
	}
	// feature-branch flow: a missing branch is created from HEAD, then the
	// commit lands on it, and the observation teaches the pr follow-up
	out = wsRun(s, sid, `{"action":"put","ws":"me/fullrepo","path":"notes/e2e.md","content":"x","branch":"feat/e2e"}`)
	if !strings.Contains(out, "COMMITTED — notes/e2e.md @ feat/e2e (branch created)") ||
		!strings.Contains(out, `"action":"pr"`) {
		t.Fatalf("put new branch: %q", out)
	}
}

func TestV765_PartialPrFlow(t *testing.T) {
	s, sid := newV765Server(t)
	// read-only → the fork-path teach
	out := wsRun(s, sid, `{"action":"pr","ws":"me/readrepo","head":"feat/x"}`)
	if !strings.Contains(out, "read-only") || !strings.Contains(out, "fork") {
		t.Fatalf("pr read: %q", out)
	}
	// partial → the real PR + the marker head
	out = wsRun(s, sid, `{"action":"pr","ws":"me/partrepo","head":"feat/x","base":"main","title":"Add x"}`)
	if !strings.Contains(out, "PR OPENED — #7") || !strings.Contains(out, "feat/x → main") || !strings.Contains(out, "https://e.test/pr/7") {
		t.Fatalf("pr partial: %q", out)
	}
	// missing head → the anti-thrash teach
	out = wsRun(s, sid, `{"action":"pr","ws":"me/partrepo"}`)
	if !strings.Contains(out, "pr needs") || !strings.Contains(out, "head") {
		t.Fatalf("pr teach: %q", out)
	}
}

func TestV765_ForkMarker(t *testing.T) {
	s, sid := newV765Server(t)
	out := wsRun(s, sid, `{"action":"fork","ws":"me/fullrepo"}`)
	if !strings.Contains(out, "FORKED — me/fullrepo-fork") || !strings.Contains(out, "opens the PR back") {
		t.Fatalf("fork: %q", out)
	}
}

func TestV765_WsResolutionAndTeach(t *testing.T) {
	s, sid := newV765Server(t)
	// bare name
	out := wsRun(s, sid, `{"action":"info","ws":"fullrepo"}`)
	if !strings.Contains(out, "me/fullrepo") {
		t.Fatalf("bare name: %q", out)
	}
	// suffix match
	out = wsRun(s, sid, `{"action":"info","ws":"partrepo"}`)
	if !strings.Contains(out, "me/partrepo") {
		t.Fatalf("suffix: %q", out)
	}
	// id
	bound, _ := s.db.ListSessionWorkspaces(sid)
	var id string
	for _, w := range bound {
		if w.Repo == "fullrepo" {
			id = w.ID
		}
	}
	out = wsRun(s, sid, `{"action":"info","ws":"`+id+`"}`)
	if !strings.Contains(out, "me/fullrepo") {
		t.Fatalf("id: %q", out)
	}
	// no match → lists the actual workspaces (anti-thrash)
	out = wsRun(s, sid, `{"action":"info","ws":"nope/nope"}`)
	if !strings.Contains(out, "no connected workspace matches") || !strings.Contains(out, "me/fullrepo") {
		t.Fatalf("no match teach: %q", out)
	}
}

func TestV765_ManifestComposition(t *testing.T) {
	s, sid := newV765Server(t)
	m := s.workspaceManifestFor(sid)
	if !strings.Contains(m, "CONNECTED CLOUD WORKSPACES") || !strings.Contains(m, "me/fullrepo") ||
		!strings.Contains(m, "access=partial") || !strings.Contains(m, "fork+PR flows") {
		t.Fatalf("manifest: %q", m)
	}
	if s.workspaceManifestFor("nonesuch") != "" {
		t.Fatalf("manifest for unbound chat should be empty")
	}
}

func TestV765_RestPrEndpoint(t *testing.T) {
	s, sid := newV765Server(t)
	bound, _ := s.db.ListSessionWorkspaces(sid)
	var partID string
	for _, w := range bound {
		if w.Repo == "partrepo" {
			partID = w.ID
		}
	}
	// read-only workspace → 403 with the fork path
	var readID string
	for _, w := range bound {
		if w.Repo == "readrepo" {
			readID = w.ID
		}
	}
	rec := hubReq(t, s, "POST", "/api/workspaces/"+readID+"/pr", map[string]any{"head": "x"})
	if rec.Code != 403 || !strings.Contains(rec.Body.String(), "fork") {
		t.Fatalf("read pr: %d %s", rec.Code, rec.Body.String())
	}
	// partial → the PR lands
	rec = hubReq(t, s, "POST", "/api/workspaces/"+partID+"/pr", map[string]any{
		"head": "feat/it", "title": "The fix"})
	var out map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("json: %v", err)
	}
	if rec.Code != 200 || out["pr"] != true || out["number"] != float64(7) {
		t.Fatalf("partial pr: %d %v", rec.Code, out)
	}
	if out["url"] != "https://e.test/pr/7" {
		t.Fatalf("pr url: %v", out["url"])
	}
	// missing head → 400 teach
	rec = hubReq(t, s, "POST", "/api/workspaces/"+partID+"/pr", map[string]any{})
	if rec.Code != 400 || !strings.Contains(rec.Body.String(), "head branch is required") {
		t.Fatalf("no head: %d %s", rec.Code, rec.Body.String())
	}
	_ = io.Discard
}
