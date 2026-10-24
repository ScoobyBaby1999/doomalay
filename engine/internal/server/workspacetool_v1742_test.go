package server

// workspacetool_v1742_test.go — v1.74.2 THE SURGEON'S OATH pins, the
// verb-contract edition: the patch verb's partial apply end-to-end
// (through the real forge client), the read anchors, and the schema
// honesty (edits = array, termux args = object).

import (
        "encoding/base64"
        "encoding/json"
        "net/http"
        "net/http/httptest"
        "os"
        "strings"
        "sync"
        "testing"

        "github.com/ScoobyBaby1999/doomalay/engine/internal/config"
        "github.com/ScoobyBaby1999/doomalay/engine/internal/forge"
        "github.com/ScoobyBaby1999/doomalay/engine/internal/store"
)

// fakeV1742GitHub — a two-file repo + a PUT capture (the partial commit
// must carry ONLY the applied edits).
func fakeV1742GitHub(t *testing.T, mu *sync.Mutex, puts *[]string) *httptest.Server {
        t.Helper()
        mux := http.NewServeMux()
        mux.HandleFunc("GET /repos/{owner}/{repo}/git/trees/{ref}", func(w http.ResponseWriter, r *http.Request) {
                write824(w, map[string]any{"truncated": false, "tree": []map[string]any{
                        {"path": "a.go", "type": "blob", "size": 60, "sha": "d1"},
                }})
        })
        mux.HandleFunc("GET /repos/{owner}/{repo}/contents/{path...}", func(w http.ResponseWriter, r *http.Request) {
                body := "package x\n\nfunc greet(name string) string {\n\treturn \"hello \" + name\n}\n\nfunc farewell() {}\n"
                write824(w, map[string]any{
                        "name": "a.go", "path": "a.go", "sha": "x", "size": len(body),
                        "encoding": "base64", "content": base64.StdEncoding.EncodeToString([]byte(body)),
                })
        })
        mux.HandleFunc("PUT /repos/{owner}/{repo}/contents/{path...}", func(w http.ResponseWriter, r *http.Request) {
                var payload struct {
                        Message string `json:"message"`
                        Content string `json:"content"`
                }
                _ = json.NewDecoder(r.Body).Decode(&payload)
                decoded, _ := base64.StdEncoding.DecodeString(payload.Content)
                mu.Lock()
                *puts = append(*puts, string(decoded))
                mu.Unlock()
                write824(w, map[string]any{
                        "content": map[string]any{"path": "a.go", "sha": "newsha"},
                        "commit":  map[string]any{"sha": "c1", "html_url": "https://e.test/me/repo/commit/c1"},
                })
        })
        srv := httptest.NewServer(mux)
        t.Cleanup(srv.Close)
        return srv
}

func newV1742Server(t *testing.T) (*Server, string, *sync.Mutex, *[]string) {
        t.Helper()
        var mu sync.Mutex
        var puts []string
        fake := fakeV1742GitHub(t, &mu, &puts)
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
        sess := &store.Session{ID: "v1742sess", Title: "t", Model: "nvidia/x", Provider: "nvidia"}
        if err := db.CreateSession(sess); err != nil {
                t.Fatalf("session: %v", err)
        }
        if err := s.vault.Set("GITHUB_PAT", "github", "ghp_v1742test", ""); err != nil {
                t.Fatalf("vault: %v", err)
        }
        w := &store.Workspace{ID: "v1742ws", Name: "me/oath",
                Kind: "github", Host: "github.com", Owner: "me", Repo: "oath", Branch: "main",
                DefaultBranch: "main", Access: forge.AccessFull, RepoURL: "https://e.test/me/oath"}
        if err := db.CreateWorkspace(w); err != nil {
                t.Fatalf("workspace: %v", err)
        }
        if err := db.BindWorkspace(sess.ID, w.ID); err != nil {
                t.Fatalf("bind: %v", err)
        }
        return s, sess.ID, &mu, &puts
}

// TestV1742_PatchPartialContractEndToEnd — 2 good edits + 1 miss in ONE
// patch call: the commit carries the two edits, the observation says
// 2-of-3, the miss gets the actual-lines re-ask, and the don't-re-send
// law rides.
func TestV1742_PatchPartialContractEndToEnd(t *testing.T) {
        s, sid, mu, puts := newV1742Server(t)
        out := wsRun(s, sid, `{"action":"patch","ws":"me/oath","path":"a.go","message":"oath","edits":[`+
                `{"old":"return \"hello \" + name","new":"return \"hi \" + name"},`+
                `{"old":"func greetz_the_missing_one(name string) string {","new":"func greet2(name string) string {"},`+
                `{"old":"func farewell() {}","new":"func farewell(name string) {}"}]}`)
        if !strings.Contains(out, "PATCHED — a.go @ main (2 of 3 surgical edit(s))") {
                t.Fatalf("the honest 2-of-3 head: %q", out)
        }
        if !strings.Contains(out, "edit 1: exact match") || !strings.Contains(out, "edit 3: exact match") {
                t.Fatalf("the applied edits report as one-liners: %q", out)
        }
        if !strings.Contains(out, "edit 2 did not apply") {
                t.Fatalf("the miss names its edit: %q", out)
        }
        if !strings.Contains(out, "the file's actual lines") {
                t.Fatalf("aider's actual-lines re-ask must ride: %q", out)
        }
        if !strings.Contains(out, "do NOT re-send them") {
                t.Fatalf("the don't-re-send law must ride: %q", out)
        }
        // THE COMMIT CARRIES THE APPLIED EDITS (never the whole-call abort)
        mu.Lock()
        if len(*puts) != 1 {
                mu.Unlock()
                t.Fatalf("exactly one PUT must ship the partial result, got %d", len(*puts))
        }
        content := (*puts)[0]
        mu.Unlock()
        if !strings.Contains(content, `return "hi " + name`) {
                t.Fatalf("edit 1 must be in the committed file:\n%s", content)
        }
        if !strings.Contains(content, "func farewell(name string) {}") {
                t.Fatalf("edit 3 must be in the committed file:\n%s", content)
        }
        if !strings.Contains(content, "func greet(name string) string {") {
                t.Fatalf("the untouched greet signature stays:\n%s", content)
        }
}

// TestV1742_PatchZeroOfN — nothing matches: the honest failure, and NO
// write ships (nothing double-applies on the retry).
func TestV1742_PatchZeroOfN(t *testing.T) {
        s, sid, mu, puts := newV1742Server(t)
        out := wsRun(s, sid, `{"action":"patch","ws":"me/oath","path":"a.go","edits":[`+
                `{"old":"not here at all","new":"x"},{"old":"also absent","new":"y"}]}`)
        if !strings.HasPrefix(strings.TrimPrefix(out, "OBSERVATION:\n"), "error: no edits applied") {
                t.Fatalf("0-of-N is the honest error head: %q", out[:min(80, len(out))])
        }
        mu.Lock()
        defer mu.Unlock()
        if len(*puts) != 0 {
                t.Fatalf("0-of-N must never write, got %d PUT(s)", len(*puts))
        }
}

// TestV1742_ReadAnchors — the ranged read echoes which lines shipped and
// numbers them by default (the str_replace anchor law).
func TestV1742_ReadAnchors(t *testing.T) {
        s, sid, _, _ := newV1742Server(t)
        out := wsRun(s, sid, `{"action":"read","ws":"me/oath","path":"a.go","range":"lines:3-5"}`)
        if !strings.Contains(out, "lines 3–5 of 7") {
                t.Fatalf("the head must echo the range with totals: %q", out[:min(120, len(out))])
        }
        if !strings.Contains(out, "3│ func greet(name string) string {") {
                t.Fatalf("a ranged read numbers its lines by default:\n%s", out)
        }
        // line_numbers:false turns them off
        out2 := wsRun(s, sid, `{"action":"read","ws":"me/oath","path":"a.go","range":"lines:3-5","line_numbers":false}`)
        if strings.Contains(out2, "│") {
                t.Fatalf("line_numbers:false must strip the anchors:\n%s", out2)
        }
}

// TestV1742_SchemaHonesty — the manifest tells the truth: edits is an
// ARRAY, termux args is an OBJECT (the string lies are dead).
func TestV1742_SchemaHonesty(t *testing.T) {
        src, err := readFileSource1742("../mcpbus/def.go")
        if err != nil {
                t.Fatalf("read def.go: %v", err)
        }
        if !strings.Contains(src, `prop("edits", "patch: the surgical edit list`) {
                t.Fatalf("edits must be declared with prop(…PropArray)")
        }
        if !strings.Contains(src, `prop("args", `) {
                t.Fatalf("termux args must be declared with prop(…PropObject)")
        }
        if !strings.Contains(src, "PropObject PropKind = \"object\"") {
                t.Fatalf("the PropObject kind must exist")
        }
        // the MCP-side builder carries the object case
        hsrc, err := readFileSource1742("../mcpbus/handlers.go")
        if err != nil {
                t.Fatalf("read handlers.go: %v", err)
        }
        if !strings.Contains(hsrc, "case PropObject:") {
                t.Fatalf("the MCP tool builder must carry the PropObject case")
        }
}

// TestV1742_TermuxPatchPartialWired — the termux patch verb rides the
// same partial engine (source pin; the rig covers it live).
func TestV1742_TermuxPatchPartialWired(t *testing.T) {
        src, err := readFileSource1742("termuxtool.go")
        if err != nil {
                t.Fatalf("read termuxtool.go: %v", err)
        }
        if !strings.Contains(src, "surgeon.ApplyEditsPartial(rest, specs)") {
                t.Fatalf("the termux patch verb must ride the partial engine")
        }
        if !strings.Contains(src, "no edits applied") {
                t.Fatalf("the 0-of-N honest refusal must ride")
        }
}

func readFileSource1742(rel string) (string, error) {
        b, err := os.ReadFile(rel)
        if err != nil {
                return "", err
        }
        return string(b), nil
}
