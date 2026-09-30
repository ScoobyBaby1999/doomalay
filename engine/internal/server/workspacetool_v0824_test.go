package server

// workspacetool_v0824_test.go — THE GREP LINES + THE DOT PATH (user spec:
// "grep appears to have an issue, and c returned empty on the doomalaysocreate
// branch" — the live log showed every grep hit as "lib/docs/captest-2026-06.md:0"
// and the tree call as "at . @c — 0 entries" on a repo full of files).
//
// Two root causes, both fixed in v0.82.4:
//   1. ghSearch built SearchHit{Path, Snippet} with NO Line — GitHub's
//      /search/code returns no line numbers even with text-match (web-search-
//      verified), so the zero value rendered as ":0". Now each hit's file is
//      fetched and the REAL first-match line + a true line snippet ride home;
//      unresolved hits render as the bare path (never "path:0").
//   2. strings.Trim(path, "/") left "." as a literal prefix — GitHub's
//      recursive-tree filter matched nothing ("0 entries"). NormalizeTreePath
//      canonicalizes ".", "./", "/./", trailing "/." at Client.Tree/File and
//      the tool verbs.

import (
        "encoding/base64"
        "encoding/json"
        "net/http"
        "net/http/httptest"
        "strings"
        "testing"

        "github.com/ScoobyBaby1999/doomalay/engine/internal/config"
        "github.com/ScoobyBaby1999/doomalay/engine/internal/forge"
        "github.com/ScoobyBaby1999/doomalay/engine/internal/store"
)

func write824(w http.ResponseWriter, v any) {
        w.Header().Set("Content-Type", "application/json")
        _ = json.NewEncoder(w).Encode(v)
}

// fakeV824GitHub — the minimal endpoint set: tree, contents (files with
// known line layouts), and /search/code in GitHub's REAL shape (paths +
// text_matches fragments, NO line numbers).
func fakeV824GitHub(t *testing.T) *httptest.Server {
        t.Helper()
        mux := http.NewServeMux()

        mux.HandleFunc("GET /repos/{owner}/{repo}/git/trees/{ref}", func(w http.ResponseWriter, r *http.Request) {
                write824(w, map[string]any{"truncated": false, "tree": []map[string]any{
                        {"path": "lib/debug_log.py", "type": "blob", "size": 60, "sha": "d1"},
                        {"path": "lib/docs/captest-2026-06.md", "type": "blob", "size": 50, "sha": "c1"},
                }})
        })

        // the file bodies: "function" appears on KNOWN lines
        mux.HandleFunc("GET /repos/{owner}/{repo}/contents/{path...}", func(w http.ResponseWriter, r *http.Request) {
                p := r.PathValue("path")
                var body string
                switch p {
                case "lib/debug_log.py":
                        body = "\"\"\"doc\"\"\"\n\ndef function one():\n    pass\n"
                case "lib/docs/captest-2026-06.md":
                        body = "# captest\n\na function of the cap system\n"
                default:
                        w.WriteHeader(404)
                        write824(w, map[string]any{"message": "Not Found"})
                        return
                }
                write824(w, map[string]any{
                        "name": p, "path": p, "sha": "x", "size": len(body),
                        "encoding": "base64", "content": base64.StdEncoding.EncodeToString([]byte(body)),
                })
        })

        // GitHub's real search shape: items with paths + fragments, NO lines
        mux.HandleFunc("GET /search/code", func(w http.ResponseWriter, r *http.Request) {
                write824(w, map[string]any{"items": []map[string]any{
                        {"name": "debug_log.py", "path": "lib/debug_log.py",
                                "text_matches": []map[string]any{{"fragment": "def function one"}}},
                        {"name": "captest-2026-06.md", "path": "lib/docs/captest-2026-06.md",
                                "text_matches": []map[string]any{{"fragment": "a function of the cap"}}},
                }})
        })

        srv := httptest.NewServer(mux)
        t.Cleanup(srv.Close)
        return srv
}

func newV824Server(t *testing.T) (*Server, string) {
        t.Helper()
        fake := fakeV824GitHub(t)
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
        sess := &store.Session{ID: "v824sess", Title: "t", Model: "nvidia/x", Provider: "nvidia"}
        if err := db.CreateSession(sess); err != nil {
                t.Fatalf("session: %v", err)
        }
        if err := s.vault.Set("GITHUB_PAT", "github", "ghp_v824test", ""); err != nil {
                t.Fatalf("vault: %v", err)
        }
        w := &store.Workspace{ID: "v824ws", Name: "me/greplines",
                Kind: "github", Host: "github.com", Owner: "me", Repo: "greplines", Branch: "c",
                DefaultBranch: "main", Access: forge.AccessFull, RepoURL: "https://e.test/me/greplines"}
        if err := db.CreateWorkspace(w); err != nil {
                t.Fatalf("workspace: %v", err)
        }
        if err := db.BindWorkspace(sess.ID, w.ID); err != nil {
                t.Fatalf("bind: %v", err)
        }
        return s, sess.ID
}

// TestV824_GrepLineNumbers — the hits carry REAL path:line + a true line
// snippet (was ":0" + a whitespace-collapsed fragment).
func TestV824_GrepLineNumbers(t *testing.T) {
        s, sid := newV824Server(t)
        out := wsRun(s, sid, `{"action":"grep","ws":"me/greplines","query":"function","limit":10}`)
        if !strings.Contains(out, "2 hit(s)") {
                t.Fatalf("hit count: %q", out)
        }
        // THE REAL LINES: "function" is on line 3 of debug_log.py and line 3 of
        // captest-2026-06.md — NOT ":0"
        if !strings.Contains(out, "- lib/debug_log.py:3") {
                t.Fatalf("missing the resolved line lib/debug_log.py:3:\n%s", out)
        }
        if !strings.Contains(out, "- lib/docs/captest-2026-06.md:3") {
                t.Fatalf("missing the resolved line lib/docs/captest-2026-06.md:3:\n%s", out)
        }
        if strings.Contains(out, ":0") {
                t.Fatalf("an unresolved :0 leaked:\n%s", out)
        }
        // the true LINE snippet (from the fetched file, not the fragment)
        if !strings.Contains(out, "def function one():") {
                t.Fatalf("missing the true line snippet:\n%s", out)
        }
}

// TestV824_TreeDotPath — tree with path "." behaves exactly like "" (the
// repo's entries; display reads "at /"), and "./lib" lists the subtree.
func TestV824_TreeDotPath(t *testing.T) {
        s, sid := newV824Server(t)
        out := wsRun(s, sid, `{"action":"tree","ws":"me/greplines","path":"."}`)
        if !strings.Contains(out, "at / @c — 2 entries") {
                t.Fatalf("the dot-path tree should list the repo root: %q", out)
        }
        if strings.Contains(out, "0 entries") {
                t.Fatalf("the dead-prefix bug reproduced: %q", out)
        }
        out = wsRun(s, sid, `{"action":"tree","ws":"me/greplines","path":"./"}`)
        if !strings.Contains(out, "at / @c — 2 entries") {
                t.Fatalf("the './' tree should equal '': %q", out)
        }
        out = wsRun(s, sid, `{"action":"ls","ws":"me/greplines","path":"/./"}`)
        if !strings.Contains(out, "2 entries") {
                t.Fatalf("the '/./' ls should equal '': %q", out)
        }
}

// TestV824_ReadDotPath — a read of "./lib/debug_log.py" resolves like
// "lib/debug_log.py".
func TestV824_ReadDotPath(t *testing.T) {
        s, sid := newV824Server(t)
        out := wsRun(s, sid, `{"action":"read","ws":"me/greplines","path":"./lib/debug_log.py"}`)
        if !strings.Contains(out, "def function one") {
                t.Fatalf("the dot-path read failed: %q", out)
        }
}

// TestV824_NormalizeTreePath — the canonicalizer's table.
func TestV824_NormalizeTreePath(t *testing.T) {
        cases := []struct{ in, want string }{
                {"", ""},
                {".", ""},
                {"./", ""},
                {"/./", ""},
                {"./.", ""},
                {".//", ""},
                {"src", "src"},
                {"./src", "src"},
                {"src/.", "src"},
                {"/src/", "src"},
                {"/./src/./", "src"},
                {"src/main.go", "src/main.go"},
        }
        for _, c := range cases {
                if got := forge.NormalizeTreePath(c.in); got != c.want {
                        t.Fatalf("NormalizeTreePath(%q) = %q, want %q", c.in, got, c.want)
                }
        }
}

// TestV824_GrepUnresolvedRendersBarePath — a hit whose file 404s (branch
// mismatch: code search indexes the default branch, the ref may differ)
// renders as the bare path — never "path:0".
func TestV824_GrepUnresolvedRendersBarePath(t *testing.T) {
        t.Helper()
        mux := http.NewServeMux()
        mux.HandleFunc("GET /search/code", func(w http.ResponseWriter, r *http.Request) {
                write824(w, map[string]any{"items": []map[string]any{
                        {"name": "ghost.md", "path": "ghost/missing.md",
                                "text_matches": []map[string]any{{"fragment": "the function ghost"}}},
                }})
        })
        mux.HandleFunc("GET /repos/{owner}/{repo}/contents/{path...}", func(w http.ResponseWriter, r *http.Request) {
                w.WriteHeader(404)
                write824(w, map[string]any{"message": "Not Found"})
        })
        fake := httptest.NewServer(mux)
        t.Cleanup(fake.Close)
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
        sess := &store.Session{ID: "v824c", Title: "t", Model: "x", Provider: "nvidia"}
        if err := db.CreateSession(sess); err != nil {
                t.Fatalf("session: %v", err)
        }
        if err := s.vault.Set("GITHUB_PAT", "github", "ghp_x", ""); err != nil {
                t.Fatalf("vault: %v", err)
        }
        w := &store.Workspace{ID: "w1", Name: "me/ghostrepo", Kind: "github", Host: "github.com",
                Owner: "me", Repo: "ghostrepo", Branch: "c", DefaultBranch: "main", Access: forge.AccessFull}
        if err := db.CreateWorkspace(w); err != nil {
                t.Fatalf("workspace: %v", err)
        }
        if err := db.BindWorkspace(sess.ID, w.ID); err != nil {
                t.Fatalf("bind: %v", err)
        }

        out := wsRun(s, sess.ID, `{"action":"grep","ws":"me/ghostrepo","query":"function","limit":10}`)
        if !strings.Contains(out, "- ghost/missing.md") {
                t.Fatalf("the unresolved hit should render its path: %q", out)
        }
        if strings.Contains(out, "ghost/missing.md:0") || strings.Contains(out, ":0") {
                t.Fatalf("the bogus :0 leaked: %q", out)
        }
}
