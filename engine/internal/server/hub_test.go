package server

// hub_test.go — v0.31 HUB routes, exercised end-to-end against the real
// mux with an in-process mock Hugging Face (httptest.Server — the v301
// Forwarder pattern, handlers instead of forwarding): libraries list,
// item listing (merge + metrics + search + all four sorts), item detail +
// PNG proxy, download, endorse (requires download), publish, the persona
// picker hearts, the auth connect flow, and unknown-type 404s.

import (
        "encoding/base64"
        "encoding/json"
        "fmt"
        "io"
        "net/http"
        "net/http/httptest"
        "net/url"
        "strings"
        "sync"
        "testing"

        "github.com/ScoobyBaby1999/doomalay/engine/internal/config"
        "github.com/ScoobyBaby1999/doomalay/engine/internal/hub"
        "github.com/ScoobyBaby1999/doomalay/engine/internal/store"
)

// ── mock Hugging Face ─────────────────────────────────────────────────────

// mockHubHF is a tiny HF Hub: repos are file maps + tags (derived from the
// README frontmatter, like the real hub), commits are recorded raw for
// NDJSON assertions. "goodtoken" is the only valid token.
type mockHubHF struct {
        mu      sync.Mutex
        repos   map[string]map[string][]byte
        tags    map[string][]string
        likes   map[string]bool
        commits []string
        srv     *httptest.Server

        // v0.48: space bookkeeping — creation sdk (assert the Vite-blank
        // trick: STATIC, not docker), secrets set, pause/restart calls, and
        // the runtime snapshot GET /api/spaces/{repo} serves.
        spaceSDK     map[string]string
        spaceSecrets map[string]map[string]string
        spaceCalls   map[string]int // repo -> pause+restart call count
        spaceRuntime map[string]any // runtime object served for every space
}

func newMockHubHF(t *testing.T) *mockHubHF {
        t.Helper()
        m := &mockHubHF{
                repos:        map[string]map[string][]byte{},
                tags:         map[string][]string{},
                likes:        map[string]bool{},
                spaceSDK:     map[string]string{},
                spaceSecrets: map[string]map[string]string{},
                spaceCalls:   map[string]int{},
        }
        mux := http.NewServeMux()

        mux.HandleFunc("GET /api/whoami-v2", func(w http.ResponseWriter, r *http.Request) {
                if r.Header.Get("Authorization") != "Bearer goodtoken" {
                        w.WriteHeader(http.StatusUnauthorized)
                        return
                }
                writeHubMockJSON(w, map[string]any{"type": "user", "name": "mockuser"})
        })

        mux.HandleFunc("GET /api/datasets", func(w http.ResponseWriter, r *http.Request) {
                filter := r.URL.Query().Get("filter")
                m.mu.Lock()
                defer m.mu.Unlock()
                var out []map[string]any
                for id, tags := range m.tags {
                        if !hubSliceContains(tags, filter) {
                                continue
                        }
                        out = append(out, map[string]any{
                                "id": id, "author": strings.SplitN(id, "/", 2)[0],
                                "likes": 0, "downloads": 0, "private": false,
                                "lastModified": "2026-09-01T00:00:00.000Z",
                        })
                }
                writeHubMockJSON(w, out)
        })

        // v0.47: repo ids now travel with a RAW slash ("user/name" — HF
        // rejects %2F upstream), so single-segment wildcards no longer
        // match. Prefix handlers parse the repo out of the path manually.
        mux.HandleFunc("GET /api/datasets/", func(w http.ResponseWriter, r *http.Request) {
                rest := strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/datasets/"), "/")
                if unesc, err := url.PathUnescape(rest); err == nil {
                        rest = unesc
                }
                m.mu.Lock()
                defer m.mu.Unlock()
                if i := strings.Index(rest, "/tree/main/"); i >= 0 {
                        // tree listing (the index fallback)
                        files, ok := m.repos[rest[:i]]
                        if !ok {
                                w.WriteHeader(http.StatusNotFound)
                                return
                        }
                        prefix := strings.Trim(rest[i+len("/tree/main/"):], "/") + "/"
                        var out []map[string]any
                        for path := range files {
                                if strings.HasPrefix(path, prefix) && !strings.Contains(strings.TrimPrefix(path, prefix), "/") {
                                        out = append(out, map[string]any{"type": "file", "path": path, "size": len(files[path])})
                                }
                        }
                        writeHubMockJSON(w, out)
                        return
                }
                if _, ok := m.repos[rest]; !ok {
                        w.WriteHeader(http.StatusNotFound)
                        return
                }
                writeHubMockJSON(w, map[string]any{"id": rest, "private": false})
        })

        mux.HandleFunc("GET /datasets/", func(w http.ResponseWriter, r *http.Request) {
                rest := strings.Trim(strings.TrimPrefix(r.URL.Path, "/datasets/"), "/")
                i := strings.Index(rest, "/resolve/main/")
                if i < 0 {
                        w.WriteHeader(http.StatusNotFound)
                        return
                }
                repo := rest[:i]
                if unesc, err := url.PathUnescape(repo); err == nil {
                        repo = unesc
                }
                m.mu.Lock()
                defer m.mu.Unlock()
                files, ok := m.repos[repo]
                if !ok {
                        w.WriteHeader(http.StatusNotFound)
                        return
                }
                body, ok := files[rest[i+len("/resolve/main/"):]]
                if !ok {
                        w.WriteHeader(http.StatusNotFound)
                        return
                }
                w.Write(body)
        })

        mux.HandleFunc("POST /api/repos/create", func(w http.ResponseWriter, r *http.Request) {
                var req struct {
                        Type         string `json:"type"`
                        Name         string `json:"name"`
                        Organization string `json:"organization"`
                        Private      bool   `json:"private"`
                        SDK          string `json:"sdk"`
                }
                _ = json.NewDecoder(r.Body).Decode(&req)
                if (req.Type != "dataset" && req.Type != "space") || req.Name == "" {
                        w.WriteHeader(http.StatusBadRequest)
                        return
                }
                id := req.Name
                if req.Type == "space" {
                        // spaces live under the author's namespace (whoami
                        // user = mockuser for "goodtoken")
                        id = "mockuser/" + req.Name
                }
                if req.Organization != "" {
                        id = req.Organization + "/" + req.Name
                }
                m.mu.Lock()
                defer m.mu.Unlock()
                if _, exists := m.repos[id]; exists {
                        w.WriteHeader(http.StatusConflict)
                        w.Write([]byte(`{"error": "You already created this repo name"}`))
                        return
                }
                m.repos[id] = map[string][]byte{}
                if req.Type == "space" {
                        m.spaceSDK[id] = req.SDK
                }
                writeHubMockJSON(w, map[string]any{"url": "/api/" + req.Type + "s/" + id})
        })

        // v0.48: space management surface — commit (NDJSON), secrets,
        // restart, pause, runtime snapshot, author listing.
        mux.HandleFunc("POST /api/spaces/", func(w http.ResponseWriter, r *http.Request) {
                rest := strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/spaces/"), "/")
                // NOTE: no outer lock — mockHubCommit locks internally
                // (Go mutexes are not reentrant; an outer lock deadlocks).
                switch {
                case strings.HasSuffix(rest, "/commit/main"):
                        mockHubCommit(w, m, strings.TrimSuffix(rest, "/commit/main"), r)
                case strings.HasSuffix(rest, "/preupload/main"):
                        var req struct {
                                Files []struct {
                                        Path string `json:"path"`
                                } `json:"files"`
                        }
                        _ = json.NewDecoder(r.Body).Decode(&req)
                        var files []map[string]any
                        for _, f := range req.Files {
                                files = append(files, map[string]any{"path": f.Path, "uploadMode": "regular"})
                        }
                        writeHubMockJSON(w, map[string]any{"files": files})
                case strings.HasSuffix(rest, "/secrets"):
                        repo := strings.TrimSuffix(rest, "/secrets")
                        var req struct {
                                Key   string `json:"key"`
                                Value string `json:"value"`
                        }
                        _ = json.NewDecoder(r.Body).Decode(&req)
                        m.mu.Lock()
                        if m.spaceSecrets[repo] == nil {
                                m.spaceSecrets[repo] = map[string]string{}
                        }
                        m.spaceSecrets[repo][req.Key] = req.Value
                        m.mu.Unlock()
                        writeHubMockJSON(w, map[string]any{})
                case strings.HasSuffix(rest, "/restart"):
                        repo := strings.TrimSuffix(rest, "/restart")
                        m.mu.Lock()
                        m.spaceCalls[repo+"#restart"]++
                        m.mu.Unlock()
                        writeHubMockJSON(w, map[string]any{"ok": true})
                case strings.HasSuffix(rest, "/pause"):
                        repo := strings.TrimSuffix(rest, "/pause")
                        m.mu.Lock()
                        m.spaceCalls[repo+"#pause"]++
                        m.mu.Unlock()
                        writeHubMockJSON(w, map[string]any{"ok": true})
                default:
                        w.WriteHeader(http.StatusNotFound)
                }
        })
        mux.HandleFunc("GET /api/spaces/", func(w http.ResponseWriter, r *http.Request) {
                rest := strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/spaces/"), "/")
                m.mu.Lock()
                defer m.mu.Unlock()
                rt := map[string]any{"stage": "NO_APP_FILE"}
                if m.spaceRuntime != nil {
                        rt = m.spaceRuntime
                }
                writeHubMockJSON(w, map[string]any{"id": rest, "sdk": m.spaceSDK[rest],
                        "runtime": rt})
        })

        // ALL POST /api/datasets/* (preupload / commit / like) in ONE
        // dispatcher (v0.47 raw-slash repos).
        mux.HandleFunc("POST /api/datasets/", func(w http.ResponseWriter, r *http.Request) {
                rest := strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/datasets/"), "/")
                switch {
                case strings.HasSuffix(rest, "/preupload/main"):
                        // preupload: everything is a regular git file (the LFS
                        // path is covered by the hub package's own suite).
                        var req struct {
                                Files []struct {
                                        Path string `json:"path"`
                                } `json:"files"`
                        }
                        _ = json.NewDecoder(r.Body).Decode(&req)
                        var files []map[string]any
                        for _, f := range req.Files {
                                files = append(files, map[string]any{"path": f.Path, "uploadMode": "regular"})
                        }
                        writeHubMockJSON(w, map[string]any{"files": files})

                case strings.HasSuffix(rest, "/commit/main"):
                        mockHubCommit(w, m, strings.TrimSuffix(rest, "/commit/main"), r)

                case strings.HasSuffix(rest, "/like"):
                        repo := strings.TrimSuffix(rest, "/like")
                        m.mu.Lock()
                        defer m.mu.Unlock()
                        m.likes[repo] = true
                        writeHubMockJSON(w, map[string]any{"liked": true})

                default:
                        w.WriteHeader(http.StatusNotFound)
                }
        })

        mux.HandleFunc("DELETE /api/datasets/", func(w http.ResponseWriter, r *http.Request) {
                rest := strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/datasets/"), "/")
                if !strings.HasSuffix(rest, "/like") {
                        w.WriteHeader(http.StatusNotFound)
                        return
                }
                m.mu.Lock()
                defer m.mu.Unlock()
                m.likes[strings.TrimSuffix(rest, "/like")] = false
                w.WriteHeader(http.StatusOK)
        })

        m.srv = httptest.NewServer(mux)
        t.Cleanup(m.srv.Close)
        return m
}

// mockHubCommit applies one NDJSON commit to a mock repo (the verified HF
// shape: header + file lines). v0.47: split out of the shared POST
// dispatcher so the routing stays readable.
func mockHubCommit(w http.ResponseWriter, m *mockHubHF, repo string, r *http.Request) {
        body, _ := io.ReadAll(r.Body)
        m.mu.Lock()
        files, ok := m.repos[repo]
        m.mu.Unlock()
        if !ok {
                w.WriteHeader(http.StatusNotFound)
                return
        }
        for _, line := range strings.Split(strings.TrimSpace(string(body)), "\n") {
                if line == "" {
                        continue
                }
                var op struct {
                        Key   string `json:"key"`
                        Value struct {
                                Path     string `json:"path"`
                                Content  string `json:"content"`
                                Encoding string `json:"encoding"`
                        } `json:"value"`
                }
                if err := json.Unmarshal([]byte(line), &op); err != nil {
                        w.WriteHeader(http.StatusBadRequest)
                        return
                }
                if op.Key != "file" {
                        continue
                }
                content := []byte(op.Value.Content)
                if op.Value.Encoding == "base64" {
                        content, _ = base64.StdEncoding.DecodeString(op.Value.Content)
                }
                m.mu.Lock()
                files[op.Value.Path] = content
                m.mu.Unlock()
        }
        m.mu.Lock()
        defer m.mu.Unlock()
        m.commits = append(m.commits, string(body))
        mockHubDeriveTags(m, repo)
        writeHubMockJSON(w, map[string]any{"commitUrl": "/" + repo + "/commit/mocksha"})
}

// mockHubDeriveTags parses "- <tag>" lines out of the README frontmatter.
func mockHubDeriveTags(m *mockHubHF, id string) {
        readme, ok := m.repos[id]["README.md"]
        if !ok {
                return
        }
        var tags []string
        inFront := false
        for _, line := range strings.Split(string(readme), "\n") {
                if strings.TrimSpace(line) == "---" {
                        if inFront {
                                break
                        }
                        inFront = true
                        continue
                }
                if inFront && strings.HasPrefix(line, "- ") {
                        tags = append(tags, strings.TrimSpace(line[2:]))
                }
        }
        m.tags[id] = tags
}

func hubSliceContains(list []string, want string) bool {
        for _, v := range list {
                if v == want {
                        return true
                }
        }
        return false
}

func writeHubMockJSON(w http.ResponseWriter, v any) {
        w.Header().Set("Content-Type", "application/json")
        _ = json.NewEncoder(w).Encode(v)
}

func (m *mockHubHF) seed(id string, tags []string, files map[string]string) {
        m.mu.Lock()
        defer m.mu.Unlock()
        m.tags[id] = tags
        m.repos[id] = map[string][]byte{}
        for p, c := range files {
                m.repos[id][p] = []byte(c)
        }
}

func (m *mockHubHF) file(id, path string) ([]byte, bool) {
        m.mu.Lock()
        defer m.mu.Unlock()
        b, ok := m.repos[id][path]
        return b, ok
}

// ── helpers ───────────────────────────────────────────────────────────────

// newHubTestServer boots the real Server against the mock HF + a fresh DB.
func newHubTestServer(t *testing.T, m *mockHubHF) *Server {
        t.Helper()
        dir := t.TempDir()
        db, err := store.Open(dir)
        if err != nil {
                t.Fatalf("store: %v", err)
        }
        if err := db.Migrate(); err != nil {
                t.Fatalf("migrate: %v", err)
        }
        cfg := &config.Config{DataDir: dir}
        cfg.Hub.HFBase = m.srv.URL
        return New(cfg, db, nil)
}

// hubReq fires one request at the real mux (no middleware — the v30
// httptest-recorder pattern) and returns the recorder.
func hubReq(t *testing.T, s *Server, method, path string, body any) *httptest.ResponseRecorder {
        t.Helper()
        var rdr io.Reader
        if body != nil {
                b, err := json.Marshal(body)
                if err != nil {
                        t.Fatalf("marshal body: %v", err)
                }
                rdr = strings.NewReader(string(b))
        }
        rec := httptest.NewRecorder()
        s.mux.ServeHTTP(rec, httptest.NewRequest(method, path, rdr))
        return rec
}

// escRepo URL-escapes a repo id into ONE path segment (the engine's
// hf.go escapeRepo does the same on the wire).
func escRepo(repo string) string { return strings.ReplaceAll(repo, "/", "%2F") }

func hubMustJSON(t *testing.T, v any) string {
        t.Helper()
        b, err := json.Marshal(v)
        if err != nil {
                t.Fatalf("marshal: %v", err)
        }
        return string(b)
}

// seedHubRouteFixtures seeds two publisher repos + one metrics sidecar.
func seedHubRouteFixtures(t *testing.T, m *mockHubHF) {
        t.Helper()
        alpha := hub.Item{ID: "star-captain-aaaaaa", Type: "persona", Name: "Star Captain",
                Description: "boldly goes where no chat has gone", Author: "alice", Repo: "alice/doomalay-personas",
                Tags: []string{"scifi", "hero"}, UpdatedAt: "2026-08-01T00:00:00Z",
                Design: hub.Design{Kind: "gradient", Colors: []string{"#ff0055", "#0055ff"}}, File: "items/star-captain-aaaaaa.md"}
        beta := hub.Item{ID: "meadow-witch-bbbbbb", Type: "persona", Name: "Meadow Witch",
                Description: "herbal magic and calm rambles about hero soup", Author: "alice", Repo: "alice/doomalay-personas",
                Tags: []string{"fantasy"}, UpdatedAt: "2026-09-01T00:00:00Z", File: "items/meadow-witch-bbbbbb.md"}
        gamma := hub.Item{ID: "noir-detective-cccccc", Type: "persona", Name: "Noir Detective",
                Description: "rain-soaked hero of the neon streets", Author: "bob", Repo: "bob/doomalay-personas",
                Tags: []string{"noir"}, UpdatedAt: "2026-07-01T00:00:00Z", File: "items/noir-detective-cccccc.md"}

        png := "\x89PNG\r\n\x1a\n" + strings.Repeat("fakepngbytes", 8)
        m.seed("alice/doomalay-personas", []string{"doomalay-persona"}, map[string]string{
                "items/index.json":               hubMustJSON(t, []hub.Item{alpha, beta}),
                "items/star-captain-aaaaaa.json": hubMustJSON(t, alpha),
                "items/star-captain-aaaaaa.md":   "# Star Captain\nyou command a starship",
                "items/star-captain-aaaaaa.png":  png,
                "items/meadow-witch-bbbbbb.json": hubMustJSON(t, beta),
                "items/meadow-witch-bbbbbb.md":   "# Meadow Witch\nyou brew potions",
        })
        m.seed("bob/doomalay-personas", []string{"doomalay-persona"}, map[string]string{
                "items/index.json":                 hubMustJSON(t, []hub.Item{gamma}),
                "items/noir-detective-cccccc.json": hubMustJSON(t, gamma),
                "items/noir-detective-cccccc.md":   "# Noir Detective\nyou smoke too much",
        })
        m.seed("bob/doomalay-metrics", []string{"doomalay-metrics"}, map[string]string{
                "metrics.jsonl": `{"op":"heart","target":"alice/doomalay-personas|star-captain-aaaaaa","ts":"2026-09-02T00:00:00Z"}
{"op":"download","target":"alice/doomalay-personas|star-captain-aaaaaa","ts":"2026-09-02T00:00:01Z"}
`,
        })
}

// itemsResp mirrors GET /api/hub/{type}/items.
type itemsResp struct {
        Type  string     `json:"type"`
        Items []hub.Item `json:"items"`
        Total int        `json:"total"`
}

func itemIDs(items []hub.Item) []string {
        out := make([]string, len(items))
        for i, it := range items {
                out[i] = it.ID
        }
        return out
}

// ── tests ──────────────────────────────────────────────────────────────────

// TestHubLibraries — the registry listing the panel builds its tabs from.
func TestHubLibraries(t *testing.T) {
        m := newMockHubHF(t)
        s := newHubTestServer(t, m)

        rec := hubReq(t, s, "GET", "/api/hub/libraries", nil)
        if rec.Code != 200 {
                t.Fatalf("status %d body %s", rec.Code, rec.Body.String())
        }
        var got struct {
                Libraries []struct {
                        hub.LibrarySpec
                        LocalCount int `json:"localCount"`
                } `json:"libraries"`
        }
        if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
                t.Fatalf("decode: %v", err)
        }
        // v0.52: 4 built-in libraries — persona + template + skill + theme.
        if len(got.Libraries) != 4 {
                t.Fatalf("libraries = %+v", got.Libraries)
        }
        byType := map[string]hub.LibrarySpec{}
        for _, l := range got.Libraries {
                byType[l.Type] = l.LibrarySpec
                if l.LocalCount != 0 {
                        t.Fatalf("fresh library %s localCount = %d", l.Type, l.LocalCount)
                }
        }
        if byType["persona"].Tag != "doomalay-persona" || byType["persona"].PayloadExt != ".md" ||
                byType["template"].Tag != "doomalay-template" || byType["template"].PayloadExt != ".json" ||
                byType["skill"].Tag != "doomalay-skill" || byType["skill"].PayloadExt != ".md" ||
                byType["theme"].Tag != "doomalay-theme" || byType["theme"].PayloadExt != ".doomtheme" {
                t.Fatalf("specs = %+v", byType)
        }
}

// TestHubUnknownType — every {type} route 404s on an unregistered library.
func TestHubUnknownType(t *testing.T) {
        m := newMockHubHF(t)
        s := newHubTestServer(t, m)

        for _, tc := range []struct{ method, path string }{
                {"GET", "/api/hub/icons/items"},
                {"GET", "/api/hub/icons/item/a%2Fb/c"},
                {"GET", "/api/hub/icons/png/a%2Fb/c"},
                {"POST", "/api/hub/icons/download"},
                {"POST", "/api/hub/icons/endorse"},
                {"POST", "/api/hub/icons/publish"},
        } {
                rec := hubReq(t, s, tc.method, tc.path, map[string]string{"repo": "a/b", "id": "c"})
                if rec.Code != 404 {
                        t.Fatalf("%s %s = %d, want 404", tc.method, tc.path, rec.Code)
                }
        }
}

// TestHubItemsRoute — the listing: merge + metrics aggregation + search +
// all four sorts + the tag filter, straight through the routes.
func TestHubItemsRoute(t *testing.T) {
        m := newMockHubHF(t)
        seedHubRouteFixtures(t, m)
        s := newHubTestServer(t, m)

        // merge (refresh=1 bypasses the 10-min remote cache) + metrics:
        // star-captain carries 1 heart + 1 download from bob's sidecar.
        rec := hubReq(t, s, "GET", "/api/hub/persona/items?refresh=1", nil)
        if rec.Code != 200 {
                t.Fatalf("status %d body %s", rec.Code, rec.Body.String())
        }
        var all itemsResp
        if err := json.Unmarshal(rec.Body.Bytes(), &all); err != nil {
                t.Fatalf("decode: %v", err)
        }
        if all.Type != "persona" || all.Total != 3 || len(all.Items) != 3 {
                t.Fatalf("items = %+v", all)
        }
        for _, it := range all.Items {
                if it.ID == "star-captain-aaaaaa" && (it.Hearts != 1 || it.Downloads != 1) {
                        t.Fatalf("star-captain counts = %d/%d", it.Hearts, it.Downloads)
                }
        }

        // recent (default, no query): beta (Sep) → alpha (Aug) → gamma (Jul)
        if got := itemIDs(all.Items); fmt.Sprint(got) != fmt.Sprint([]string{"meadow-witch-bbbbbb", "star-captain-aaaaaa", "noir-detective-cccccc"}) {
                t.Fatalf("recent order = %v", got)
        }

        // search by name / tag / description
        for q, want := range map[string]string{
                "captain":     "star-captain-aaaaaa",   // name
                "scifi":       "star-captain-aaaaaa",   // tag
                "rain-soaked": "noir-detective-cccccc", // description
        } {
                rec := hubReq(t, s, "GET", "/api/hub/persona/items?q="+q+"&refresh=1", nil)
                var got itemsResp
                _ = json.Unmarshal(rec.Body.Bytes(), &got)
                if got.Total != 1 || got.Items[0].ID != want {
                        t.Fatalf("search %q = %v, want [%s]", q, itemIDs(got.Items), want)
                }
        }

        // sorts: hearts (alpha=1), downloads (alpha=1), relevant with query
        rec = hubReq(t, s, "GET", "/api/hub/persona/items?sort=hearts&refresh=1", nil)
        var sorted itemsResp
        _ = json.Unmarshal(rec.Body.Bytes(), &sorted)
        if sorted.Items[0].ID != "star-captain-aaaaaa" {
                t.Fatalf("hearts order = %v", itemIDs(sorted.Items))
        }
        rec = hubReq(t, s, "GET", "/api/hub/persona/items?sort=downloads&refresh=1", nil)
        _ = json.Unmarshal(rec.Body.Bytes(), &sorted)
        if sorted.Items[0].ID != "star-captain-aaaaaa" {
                t.Fatalf("downloads order = %v", itemIDs(sorted.Items))
        }
        // "hero": alpha's TAG (+2) beats the witch's and the detective's
        // description matches (+1 each) — relevance must rank alpha first.
        rec = hubReq(t, s, "GET", "/api/hub/persona/items?q=hero&sort=relevant&refresh=1", nil)
        _ = json.Unmarshal(rec.Body.Bytes(), &sorted)
        if sorted.Total != 3 || sorted.Items[0].ID != "star-captain-aaaaaa" {
                t.Fatalf("relevant order = %v", itemIDs(sorted.Items))
        }
        // default sort WITH a query = relevant
        rec = hubReq(t, s, "GET", "/api/hub/persona/items?q=hero&refresh=1", nil)
        _ = json.Unmarshal(rec.Body.Bytes(), &sorted)
        if sorted.Items[0].ID != "star-captain-aaaaaa" {
                t.Fatalf("default-with-query order = %v", itemIDs(sorted.Items))
        }

        // tag filter
        rec = hubReq(t, s, "GET", "/api/hub/persona/items?tag=fantasy&refresh=1", nil)
        var tagged itemsResp
        _ = json.Unmarshal(rec.Body.Bytes(), &tagged)
        if tagged.Total != 1 || tagged.Items[0].ID != "meadow-witch-bbbbbb" {
                t.Fatalf("tag filter = %v", itemIDs(tagged.Items))
        }
}

// TestHubItemDetailAndPNG — the remote proxy (item meta + payload), the PNG
// proxy with cache headers, and the local fast path after a download.
func TestHubItemDetailAndPNG(t *testing.T) {
        m := newMockHubHF(t)
        seedHubRouteFixtures(t, m)
        s := newHubTestServer(t, m)

        // remote item detail
        rec := hubReq(t, s, "GET", "/api/hub/persona/item/"+escRepo("alice/doomalay-personas")+"/meadow-witch-bbbbbb", nil)
        if rec.Code != 200 {
                t.Fatalf("detail status %d body %s", rec.Code, rec.Body.String())
        }
        var detail struct {
                Item    hub.Item `json:"item"`
                Payload string   `json:"payload"`
        }
        if err := json.Unmarshal(rec.Body.Bytes(), &detail); err != nil {
                t.Fatalf("decode: %v", err)
        }
        if detail.Item.ID != "meadow-witch-bbbbbb" || detail.Payload != "# Meadow Witch\nyou brew potions" {
                t.Fatalf("detail = %+v payload %q", detail.Item, detail.Payload)
        }

        // missing item meta → 404
        rec = hubReq(t, s, "GET", "/api/hub/persona/item/"+escRepo("alice/doomalay-personas")+"/ghost", nil)
        if rec.Code != 404 {
                t.Fatalf("missing item = %d, want 404", rec.Code)
        }

        // PNG proxy: bytes + long cache
        rec = hubReq(t, s, "GET", "/api/hub/persona/png/"+escRepo("alice/doomalay-personas")+"/star-captain-aaaaaa", nil)
        if rec.Code != 200 {
                t.Fatalf("png status %d body %s", rec.Code, rec.Body.String())
        }
        if ct := rec.Header().Get("Content-Type"); ct != "image/png" {
                t.Fatalf("png content-type = %q", ct)
        }
        if cc := rec.Header().Get("Cache-Control"); !strings.Contains(cc, "max-age=") {
                t.Fatalf("png cache-control = %q", cc)
        }
        wantPNG, _ := m.file("alice/doomalay-personas", "items/star-captain-aaaaaa.png")
        if string(rec.Body.Bytes()) != string(wantPNG) {
                t.Fatal("png bytes did not round-trip")
        }
        // an item with no PNG → 404
        rec = hubReq(t, s, "GET", "/api/hub/persona/png/"+escRepo("alice/doomalay-personas")+"/meadow-witch-bbbbbb", nil)
        if rec.Code != 404 {
                t.Fatalf("no-png = %d, want 404", rec.Code)
        }
}

// TestHubDownloadRoute — POST download persists locally; the payload
// round-trips; a re-download still answers from the (same) source.
func TestHubDownloadRoute(t *testing.T) {
        m := newMockHubHF(t)
        seedHubRouteFixtures(t, m)
        s := newHubTestServer(t, m)

        body := map[string]string{"repo": "alice/doomalay-personas", "id": "star-captain-aaaaaa"}
        rec := hubReq(t, s, "POST", "/api/hub/persona/download", body)
        if rec.Code != 200 {
                t.Fatalf("download status %d body %s", rec.Code, rec.Body.String())
        }
        var dl struct {
                Item    hub.Item `json:"item"`
                Payload string   `json:"payload"`
        }
        if err := json.Unmarshal(rec.Body.Bytes(), &dl); err != nil {
                t.Fatalf("decode: %v", err)
        }
        if dl.Item.ID != "star-captain-aaaaaa" || dl.Payload != "# Star Captain\nyou command a starship" {
                t.Fatalf("download = %+v payload %q", dl.Item, dl.Payload)
        }
        // persisted: the local fast path answers the item detail
        rec = hubReq(t, s, "GET", "/api/hub/persona/item/"+escRepo("alice/doomalay-personas")+"/star-captain-aaaaaa", nil)
        var detail struct {
                Item    hub.Item `json:"item"`
                Payload string   `json:"payload"`
        }
        _ = json.Unmarshal(rec.Body.Bytes(), &detail)
        if detail.Payload != "# Star Captain\nyou command a starship" {
                t.Fatalf("local fast path payload = %q", detail.Payload)
        }
        // and the library listing keeps showing it (remote + local merge)
        rec = hubReq(t, s, "GET", "/api/hub/persona/items?refresh=1", nil)
        var items itemsResp
        _ = json.Unmarshal(rec.Body.Bytes(), &items)
        if items.Total != 3 {
                t.Fatalf("after download, items = %d", items.Total)
        }
        // missing body keys → 400
        rec = hubReq(t, s, "POST", "/api/hub/persona/download", map[string]string{"id": "x"})
        if rec.Code != 400 {
                t.Fatalf("missing repo = %d, want 400", rec.Code)
        }
        // unknown item → 404
        rec = hubReq(t, s, "POST", "/api/hub/persona/download", map[string]string{"repo": "alice/doomalay-personas", "id": "ghost"})
        if rec.Code != 404 {
                t.Fatalf("ghost download = %d, want 404", rec.Code)
        }
}

// TestHubEndorseRoute — endorsing without a download is a 400; after the
// download it hearts locally, likes the publisher repo, and writes the
// metrics heart event. Unendorse mirrors.
func TestHubEndorseRoute(t *testing.T) {
        m := newMockHubHF(t)
        seedHubRouteFixtures(t, m)
        s := newHubTestServer(t, m)

        // connect first so the HF side effects fire
        rec := hubReq(t, s, "POST", "/api/hub/auth/connect", map[string]string{"token": "goodtoken"})
        if rec.Code != 200 {
                t.Fatalf("connect status %d body %s", rec.Code, rec.Body.String())
        }

        body := map[string]string{"repo": "alice/doomalay-personas", "id": "star-captain-aaaaaa"}

        // NOT downloaded → 400 (the enforceable endorsement rule)
        rec = hubReq(t, s, "POST", "/api/hub/persona/endorse", body)
        if rec.Code != 400 || !strings.Contains(rec.Body.String(), "download") {
                t.Fatalf("endorse before download = %d %s", rec.Code, rec.Body.String())
        }

        // download → endorse
        if rec := hubReq(t, s, "POST", "/api/hub/persona/download", body); rec.Code != 200 {
                t.Fatalf("download status %d", rec.Code)
        }
        rec = hubReq(t, s, "POST", "/api/hub/persona/endorse", body)
        if rec.Code != 200 {
                t.Fatalf("endorse status %d body %s", rec.Code, rec.Body.String())
        }
        var resp struct {
                OK   bool     `json:"ok"`
                Item hub.Item `json:"item"`
        }
        if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
                t.Fatalf("decode: %v", err)
        }
        if !resp.OK {
                t.Fatal("endorse resp ok = false")
        }

        // the publisher repo was liked + the metrics heart event was written
        m.mu.Lock()
        liked := m.likes["alice/doomalay-personas"]
        m.mu.Unlock()
        metrics, hasMetrics := m.file("mockuser/doomalay-metrics", "metrics.jsonl")
        if !liked {
                t.Fatal("publisher repo was not liked")
        }
        if !hasMetrics || !strings.Contains(string(metrics), `"op":"heart"`) ||
                !strings.Contains(string(metrics), `"target":"alice/doomalay-personas|star-captain-aaaaaa"`) {
                t.Fatalf("metrics = %q", metrics)
        }

        // the hearted personas listing carries the heart (hub row, id + name)
        rec = hubReq(t, s, "GET", "/api/hub/personas/hearted", nil)
        var hearted struct {
                Personas []struct {
                        ID   string `json:"id"`
                        Name string `json:"name"`
                } `json:"personas"`
        }
        if err := json.Unmarshal(rec.Body.Bytes(), &hearted); err != nil {
                t.Fatalf("decode hearted: %v", err)
        }
        if len(hearted.Personas) != 1 || hearted.Personas[0].ID != "star-captain-aaaaaa" ||
                hearted.Personas[0].Name != "Star Captain" {
                t.Fatalf("hearted = %+v", hearted.Personas)
        }

        // unendorse mirrors: heart cleared + repo unliked
        rec = hubReq(t, s, "POST", "/api/hub/persona/unendorse", body)
        if rec.Code != 200 {
                t.Fatalf("unendorse status %d body %s", rec.Code, rec.Body.String())
        }
        m.mu.Lock()
        liked = m.likes["alice/doomalay-personas"]
        m.mu.Unlock()
        if liked {
                t.Fatal("publisher repo still liked after unendorse")
        }
        rec = hubReq(t, s, "GET", "/api/hub/personas/hearted", nil)
        _ = json.Unmarshal(rec.Body.Bytes(), &hearted)
        if len(hearted.Personas) != 0 {
                t.Fatalf("hearted after unendorse = %+v", hearted.Personas)
        }
}

// TestHubPublishRoute — publish happy path (repo created + tagged, files
// present, index regenerated, author stamped, tag cap) + the 401/400s.
func TestHubPublishRoute(t *testing.T) {
        m := newMockHubHF(t)
        seedHubRouteFixtures(t, m)
        s := newHubTestServer(t, m)

        // not connected → 401
        rec := hubReq(t, s, "POST", "/api/hub/persona/publish", map[string]any{
                "name": "Mock Persona", "payload": "# hello",
        })
        if rec.Code != 401 {
                t.Fatalf("publish without token = %d, want 401", rec.Code)
        }

        // connect, then publish
        if rec := hubReq(t, s, "POST", "/api/hub/auth/connect", map[string]string{"token": "goodtoken"}); rec.Code != 200 {
                t.Fatalf("connect status %d", rec.Code)
        }

        png := []byte{0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 1, 2, 3, 4, 5}
        tags := []string{}
        for i := 0; i < 20; i++ {
                tags = append(tags, fmt.Sprintf("tag-%02d", i))
        }
        rec = hubReq(t, s, "POST", "/api/hub/persona/publish", map[string]any{
                "name":        "Mock Persona!!",
                "description": "published from a test",
                "tags":        tags,
                "design":      map[string]any{"kind": "gradient", "colors": []string{"#111111", "#222222"}},
                "payload":     "# Mock Persona\nhello",
                "pngBase64":   base64.StdEncoding.EncodeToString(png),
        })
        if rec.Code != 200 {
                t.Fatalf("publish status %d body %s", rec.Code, rec.Body.String())
        }
        var pub struct {
                Item hub.Item `json:"item"`
                Repo string   `json:"repo"`
        }
        if err := json.Unmarshal(rec.Body.Bytes(), &pub); err != nil {
                t.Fatalf("decode: %v", err)
        }
        wantID := hub.ItemID("Mock Persona!!", "mockuser")
        if pub.Item.ID != wantID || pub.Item.Author != "mockuser" || pub.Repo != "mockuser/doomalay-personas" {
                t.Fatalf("published item = %+v repo %q", pub.Item, pub.Repo)
        }

        // the repo was created (with the library tag via the README) and every
        // file landed, the author is stamped into the stored meta, and the tag
        // cap held at 15.
        m.mu.Lock()
        _, repoExists := m.repos["mockuser/doomalay-personas"]
        tagged := hubSliceContains(m.tags["mockuser/doomalay-personas"], "doomalay-persona")
        m.mu.Unlock()
        if !repoExists || !tagged {
                t.Fatalf("repo exists=%v tagged=%v", repoExists, tagged)
        }
        meta, _ := m.file("mockuser/doomalay-personas", "items/"+wantID+".json")
        var stored hub.Item
        if err := json.Unmarshal(meta, &stored); err != nil {
                t.Fatalf("stored meta: %v", err)
        }
        if stored.Author != "mockuser" || stored.Type != "persona" || stored.Design.Kind != "png" {
                t.Fatalf("stored meta = %+v", stored)
        }
        if len(stored.Tags) != hub.MaxTags {
                t.Fatalf("stored tags = %d, want cap %d", len(stored.Tags), hub.MaxTags)
        }
        if b, ok := m.file("mockuser/doomalay-personas", "items/"+wantID+".md"); !ok || string(b) != "# Mock Persona\nhello" {
                t.Fatalf("payload file = %q ok=%v", b, ok)
        }
        if b, ok := m.file("mockuser/doomalay-personas", "items/"+wantID+".png"); !ok || string(b) != string(png) {
                t.Fatalf("png file = %q ok=%v", b, ok)
        }
        if b, ok := m.file("mockuser/doomalay-personas", "items/index.json"); !ok || !strings.Contains(string(b), wantID) {
                t.Fatalf("index = %q ok=%v", b, ok)
        }

        // the published item shows up in the (refreshed) listing
        rec = hubReq(t, s, "GET", "/api/hub/persona/items?refresh=1", nil)
        var items itemsResp
        _ = json.Unmarshal(rec.Body.Bytes(), &items)
        if !hubSliceContains(itemIDs(items.Items), wantID) {
                t.Fatalf("published item missing from listing: %v", itemIDs(items.Items))
        }

        // name required → 400; payload cap → 400
        rec = hubReq(t, s, "POST", "/api/hub/persona/publish", map[string]any{"payload": "x"})
        if rec.Code != 400 || !strings.Contains(rec.Body.String(), "name") {
                t.Fatalf("nameless publish = %d %s", rec.Code, rec.Body.String())
        }
        rec = hubReq(t, s, "POST", "/api/hub/persona/publish", map[string]any{
                "name": "Big", "payload": strings.Repeat("x", 65<<10)})
        if rec.Code != 400 || !strings.Contains(rec.Body.String(), "payload too large") {
                t.Fatalf("oversize payload = %d %s", rec.Code, rec.Body.String())
        }
}

// TestHubAuthFlow — status → connect (bad token 401, good token 200) →
// status shows the username → disconnect clears.
func TestHubAuthFlow(t *testing.T) {
        m := newMockHubHF(t)
        s := newHubTestServer(t, m)

        status := func() (bool, string) {
                rec := hubReq(t, s, "GET", "/api/hub/auth/status", nil)
                if rec.Code != 200 {
                        t.Fatalf("status code %d", rec.Code)
                }
                var st struct {
                        Connected bool   `json:"connected"`
                        Username  string `json:"username"`
                }
                _ = json.Unmarshal(rec.Body.Bytes(), &st)
                return st.Connected, st.Username
        }

        if c, u := status(); c || u != "" {
                t.Fatalf("fresh status = %v %q", c, u)
        }
        rec := hubReq(t, s, "POST", "/api/hub/auth/connect", map[string]string{"token": "badtoken"})
        if rec.Code != 401 {
                t.Fatalf("bad token = %d, want 401", rec.Code)
        }
        if c, u := status(); c || u != "" {
                t.Fatalf("status after bad connect = %v %q", c, u)
        }
        rec = hubReq(t, s, "POST", "/api/hub/auth/connect", map[string]string{"token": "goodtoken"})
        if rec.Code != 200 {
                t.Fatalf("connect = %d body %s", rec.Code, rec.Body.String())
        }
        var conn struct {
                OK       bool   `json:"ok"`
                Username string `json:"username"`
        }
        _ = json.Unmarshal(rec.Body.Bytes(), &conn)
        if !conn.OK || conn.Username != "mockuser" {
                t.Fatalf("connect resp = %+v", conn)
        }
        if c, u := status(); !c || u != "mockuser" {
                t.Fatalf("status after connect = %v %q", c, u)
        }
        rec = hubReq(t, s, "POST", "/api/hub/auth/disconnect", nil)
        if rec.Code != 200 {
                t.Fatalf("disconnect = %d", rec.Code)
        }
        if c, u := status(); c || u != "" {
                t.Fatalf("status after disconnect = %v %q", c, u)
        }
}

// TestHubPersonaHearts — the persona picker's local-only hearts.
func TestHubPersonaHearts(t *testing.T) {
        m := newMockHubHF(t)
        s := newHubTestServer(t, m)

        rec := hubReq(t, s, "POST", "/api/hub/persona/heart", map[string]string{"id": "p_42", "name": "Meadow Witch"})
        if rec.Code != 200 {
                t.Fatalf("heart status %d body %s", rec.Code, rec.Body.String())
        }
        rec = hubReq(t, s, "GET", "/api/hub/personas/hearted", nil)
        var hearted struct {
                Personas []struct {
                        ID   string `json:"id"`
                        Name string `json:"name"`
                } `json:"personas"`
        }
        if err := json.Unmarshal(rec.Body.Bytes(), &hearted); err != nil {
                t.Fatalf("decode: %v", err)
        }
        if len(hearted.Personas) != 1 || hearted.Personas[0].ID != "p_42" || hearted.Personas[0].Name != "Meadow Witch" {
                t.Fatalf("hearted = %+v", hearted.Personas)
        }

        // unheart removes it
        rec = hubReq(t, s, "POST", "/api/hub/persona/unheart", map[string]string{"id": "p_42", "name": "Meadow Witch"})
        if rec.Code != 200 {
                t.Fatalf("unheart status %d", rec.Code)
        }
        rec = hubReq(t, s, "GET", "/api/hub/personas/hearted", nil)
        _ = json.Unmarshal(rec.Body.Bytes(), &hearted)
        if len(hearted.Personas) != 0 {
                t.Fatalf("hearted after unheart = %+v", hearted.Personas)
        }

        // missing id → 400
        rec = hubReq(t, s, "POST", "/api/hub/persona/heart", map[string]string{"name": "No Id"})
        if rec.Code != 400 {
                t.Fatalf("idless heart = %d, want 400", rec.Code)
        }
}
