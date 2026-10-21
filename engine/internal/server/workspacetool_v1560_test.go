// workspacetool_v1560_test.go — v1.56.0 THE SOPHISTICATED GREP pins
// (the model-facing surface, through the real tool runner).
//
// The laws under test:
//   · EVERY hit in EVERY file is reported (the old fold: one hit per
//     file).
//   · the pattern is a REGEX (the old grep was a literal).
//   · the globs and the context lines work.
//   · the honest header (the engine, the count, the reason).
package server

import (
	"encoding/base64"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/ScoobyBaby1999/doomalay/engine/internal/config"
	"github.com/ScoobyBaby1999/doomalay/engine/internal/forge"
	"github.com/ScoobyBaby1999/doomalay/engine/internal/store"
)

// fakeV1560GitHub — a repo whose files hold MULTIPLE matches each, so
// the "every hit" law is provable.
func fakeV1560GitHub(t *testing.T) *httptest.Server {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("GET /repos/{owner}/{repo}/git/trees/{ref}", func(w http.ResponseWriter, r *http.Request) {
		write824(w, map[string]any{"truncated": false, "tree": []map[string]any{
			{"path": "a.go", "type": "blob", "size": 40, "sha": "d1"},
			{"path": "b.md", "type": "blob", "size": 40, "sha": "c1"},
			{"path": "vendor/c.go", "type": "blob", "size": 40, "sha": "e1"},
		}})
	})
	mux.HandleFunc("GET /repos/{owner}/{repo}/contents/{path...}", func(w http.ResponseWriter, r *http.Request) {
		p := r.PathValue("path")
		var body string
		switch p {
		case "a.go":
			body = "package x\n// TODO: one\nfunc f() {}\n// TODO: two\n"
		case "b.md":
			body = "# doc\nTODO three\n"
		case "vendor/c.go":
			body = "// TODO: vendored\n"
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
	// GitHub's code search (the candidate path) — it returns a fragment
	// but no line numbers.
	mux.HandleFunc("GET /search/code", func(w http.ResponseWriter, r *http.Request) {
		write824(w, map[string]any{"items": []map[string]any{
			{"name": "a.go", "path": "a.go",
				"text_matches": []map[string]any{{"fragment": "// TODO: one"}}},
			{"name": "b.md", "path": "b.md",
				"text_matches": []map[string]any{{"fragment": "TODO three"}}},
			{"name": "c.go", "path": "vendor/c.go",
				"text_matches": []map[string]any{{"fragment": "// TODO: vendored"}}},
		}})
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv
}

func newV1560Server(t *testing.T) (*Server, string) {
	t.Helper()
	fake := fakeV1560GitHub(t)
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
	sess := &store.Session{ID: "v1560sess", Title: "t", Model: "nvidia/x", Provider: "nvidia"}
	if err := db.CreateSession(sess); err != nil {
		t.Fatalf("session: %v", err)
	}
	if err := s.vault.Set("GITHUB_PAT", "github", "ghp_v1560test", ""); err != nil {
		t.Fatalf("vault: %v", err)
	}
	w := &store.Workspace{ID: "v1560ws", Name: "me/greplines",
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

// TestV1560_GrepReportsEveryHit: a.go holds TWO matches — both are
// reported (the old fold showed one per file).
func TestV1560_GrepReportsEveryHit(t *testing.T) {
	s, sid := newV1560Server(t)
	out := wsRun(s, sid, `{"action":"grep","ws":"me/greplines","query":"TODO"}`)
	if !strings.Contains(out, "a.go:2") {
		t.Fatalf("the first match is missing: %q", out)
	}
	if !strings.Contains(out, "a.go:4") {
		t.Fatalf("the SECOND match in the same file is missing (the one-per-file fold lives): %q", out)
	}
	if !strings.Contains(out, "b.md:2") {
		t.Fatalf("the other file's match is missing: %q", out)
	}
	if strings.Contains(out, ":0") {
		t.Fatalf("a bogus :0 leaked: %q", out)
	}
}

// TestV1560_GrepIsARegex: the pattern is a REGEX (the old grep was a
// literal — "TODO: one" would never have matched).
func TestV1560_GrepIsARegex(t *testing.T) {
	s, sid := newV1560Server(t)
	out := wsRun(s, sid, `{"action":"grep","ws":"me/greplines","query":"TODO:\\s+(one|two)"}`)
	if !strings.Contains(out, "a.go:2") || !strings.Contains(out, "a.go:4") {
		t.Fatalf("the regex did not match both TODO lines: %q", out)
	}
}

// TestV1560_GrepGlobFilter: the include glob filters the corpus.
func TestV1560_GrepGlobFilter(t *testing.T) {
	s, sid := newV1560Server(t)
	out := wsRun(s, sid, `{"action":"grep","ws":"me/greplines","query":"TODO","include":"*.md"}`)
	if !strings.Contains(out, "b.md:2") {
		t.Fatalf("the included file is missing: %q", out)
	}
	if strings.Contains(out, "a.go") {
		t.Fatalf("a.go leaked past the include glob: %q", out)
	}
}

// TestV1560_GrepExcludeGlob: the exclude glob filters the corpus.
func TestV1560_GrepExcludeGlob(t *testing.T) {
	s, sid := newV1560Server(t)
	out := wsRun(s, sid, `{"action":"grep","ws":"me/greplines","query":"TODO","exclude":"vendor/**"}`)
	if strings.Contains(out, "vendor/c.go") {
		t.Fatalf("the excluded file leaked: %q", out)
	}
	if !strings.Contains(out, "a.go:2") {
		t.Fatalf("the kept file is missing: %q", out)
	}
}

// TestV1560_GrepContextLines: the context lines ride the hit.
func TestV1560_GrepContextLines(t *testing.T) {
	s, sid := newV1560Server(t)
	out := wsRun(s, sid, `{"action":"grep","ws":"me/greplines","query":"TODO","include":"b.md","context":1}`)
	if !strings.Contains(out, "package x") && !strings.Contains(out, "# doc") {
		t.Fatalf("the context line is missing: %q", out)
	}
}

// TestV1560_GrepHonestHeader: the header carries the truth (the engine,
// the counts) — the model can tell a regex search from a literal one.
func TestV1560_GrepHonestHeader(t *testing.T) {
	s, sid := newV1560Server(t)
	out := wsRun(s, sid, `{"action":"grep","ws":"me/greplines","query":"TODO"}`)
	if !strings.Contains(out, "engine=") {
		t.Fatalf("the header does not name the engine: %q", out)
	}
	if !strings.Contains(out, "4 hit(s)") {
		t.Fatalf("the hit count is wrong (want 4 — two in a.go, one in b.md, one in vendor/c.go): %q", out)
	}
}

// TestV1560_GrepCountMode: the -c shape (the count per file).
func TestV1560_GrepCountMode(t *testing.T) {
	s, sid := newV1560Server(t)
	out := wsRun(s, sid, `{"action":"grep","ws":"me/greplines","query":"TODO","count":true}`)
	if !strings.Contains(out, "a.go: 2 hit(s)") {
		t.Fatalf("the per-file count is wrong: %q", out)
	}
}

// TestV1560_GrepLiteralMode: the fixed mode escapes the pattern.
func TestV1560_GrepLiteralMode(t *testing.T) {
	s, sid := newV1560Server(t)
	out := wsRun(s, sid, `{"action":"grep","ws":"me/greplines","query":"TODO","fixed":true}`)
	if !strings.Contains(out, "4 hit(s)") {
		t.Fatalf("the literal search found nothing: %q", out)
	}
}
