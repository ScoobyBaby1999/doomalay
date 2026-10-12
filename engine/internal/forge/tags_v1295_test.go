package forge

// tags_v1295_test.go — v1.29.5 THE GITHUB HAND: the tags pair against a
// stub GitHub/Gitea/GitLab (list + create, lightweight + annotated, the
// ref-segment law, the honest ErrUnsupported refusals).

import (
        "context"
        "encoding/json"
        "fmt"
        "net/http"
        "net/http/httptest"
        "strings"
        "testing"
)

func tagsStubForge(t *testing.T, kind string) (*Client, *[]string) {
        t.Helper()
        var posts []string
        mux := http.NewServeMux()
        mux.HandleFunc("GET /repos/o/r/tags", func(w http.ResponseWriter, r *http.Request) {
                w.Header().Set("Content-Type", "application/json")
                fmt.Fprint(w, `[{"name":"v1.0.0","commit":{"sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}},{"name":"v1.1.0","commit":{"sha":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}}]`)
        })
        mux.HandleFunc("GET /api/v1/repos/o/r/tags", func(w http.ResponseWriter, r *http.Request) {
                w.Header().Set("Content-Type", "application/json")
                fmt.Fprint(w, `[{"name":"v1.0.0","commit":{"sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}}]`)
        })
        mux.HandleFunc("POST /repos/o/r/git/refs", func(w http.ResponseWriter, r *http.Request) {
                var b map[string]string
                _ = json.NewDecoder(r.Body).Decode(&b)
                posts = append(posts, b["ref"]+"@"+b["sha"])
                w.WriteHeader(201)
                fmt.Fprintf(w, `{"ref":%q}`, b["ref"])
        })
        mux.HandleFunc("POST /repos/o/r/git/tags", func(w http.ResponseWriter, r *http.Request) {
                var b map[string]string
                _ = json.NewDecoder(r.Body).Decode(&b)
                posts = append(posts, "tagobj:"+b["tag"]+":"+b["message"])
                w.WriteHeader(201)
                fmt.Fprint(w, `{"sha":"cccccccccccccccccccccccccccccccccccccccc"}`)
        })
        mux.HandleFunc("GET /api/v4/projects/o%2Fr/repository/tags", func(w http.ResponseWriter, r *http.Request) {
                w.Header().Set("Content-Type", "application/json")
                fmt.Fprint(w, `[{"name":"v2.0.0","message":"the release\nbody","commit":{"id":"dddddddddddddddddddddddddddddddddddddddd"}}]`)
        })
        mux.HandleFunc("POST /api/v4/projects/o%2Fr/repository/tags", func(w http.ResponseWriter, r *http.Request) {
                var b map[string]string
                _ = json.NewDecoder(r.Body).Decode(&b)
                posts = append(posts, "gltag:"+b["tag_name"]+":"+b["ref"])
                w.WriteHeader(201)
                fmt.Fprint(w, `{"name":"`+b["tag_name"]+`"}`)
        })
        srv := httptest.NewServer(mux)
        t.Cleanup(srv.Close)
        api := srv.URL
        if kind == "gitlab" {
                api = srv.URL + "/api/v4"
        } else if kind == "gitea" {
                api = srv.URL + "/api/v1"
        }
        // v1.29.5: GitHubAPIBase is the exported test seam (the v1191 pattern)
        oldGH := GitHubAPIBase
        GitHubAPIBase = srv.URL
        t.Cleanup(func() { GitHubAPIBase = oldGH })
        c := &Client{host: HostInfo{Kind: kind, APIBase: api, Host: "stub", WebBase: srv.URL, Owner: "o", Repo: "r", ProjectPath: "o/r"}, hc: http.DefaultClient}
        return c, &posts
}

func TestV1295_Tags_List(t *testing.T) {
        ctx := context.Background()
        // GitHub
        c, _ := tagsStubForge(t, "github")
        rows, err := c.Tags(ctx, "tok", 0)
        if err != nil || len(rows) != 2 || rows[0].Name != "v1.0.0" || !strings.HasPrefix(rows[1].SHA, "bbbb") {
                t.Fatalf("gh tags: %v %+v", err, rows)
        }
        // Gitea
        c, _ = tagsStubForge(t, "gitea")
        rows, err = c.Tags(ctx, "tok", 0)
        if err != nil || len(rows) != 1 || rows[0].Name != "v1.0.0" {
                t.Fatalf("gitea tags: %v %+v", err, rows)
        }
        // GitLab (carries the annotated message)
        c, _ = tagsStubForge(t, "gitlab")
        rows, err = c.Tags(ctx, "tok", 0)
        if err != nil || len(rows) != 1 || rows[0].Message != "the release" {
                t.Fatalf("gitlab tags: %v %+v", err, rows)
        }
        // HF — the honest refusal
        c, _ = tagsStubForge(t, "hf")
        if _, err := c.Tags(ctx, "tok", 0); err == nil {
                t.Fatalf("HF must refuse tags (ErrUnsupported)")
        }
}

func TestV1295_Tags_Create(t *testing.T) {
        ctx := context.Background()
        // lightweight: one refs POST, no tag object
        c, posts := tagsStubForge(t, "github")
        ref, err := c.CreateTag(ctx, "v1.2.0", "aaaa", "", "tok")
        if err != nil || ref != "refs/tags/v1.2.0" {
                t.Fatalf("gh create: %v %q", err, ref)
        }
        if len(*posts) != 1 || (*posts)[0] != "refs/tags/v1.2.0@aaaa" {
                t.Fatalf("lightweight = ONE refs POST, got %v", *posts)
        }
        // annotated: the tag OBJECT first, then the ref at the object's sha
        c, posts = tagsStubForge(t, "github")
        ref, err = c.CreateTag(ctx, "v1.3.0", "aaaa", "the annotation", "tok")
        if err != nil || ref != "refs/tags/v1.3.0" {
                t.Fatalf("gh annotated create: %v %q", err, ref)
        }
        if len(*posts) != 2 || (*posts)[0] != "tagobj:v1.3.0:the annotation" || !strings.Contains((*posts)[1], "cccc") {
                t.Fatalf("annotated = tag object + ref at the object sha, got %v", *posts)
        }
        // the honest input refusals
        if _, err := c.CreateTag(ctx, "", "aaaa", "", "tok"); err == nil {
                t.Fatalf("empty tag must refuse")
        }
        if _, err := c.CreateTag(ctx, "bad tag", "aaaa", "", "tok"); err == nil {
                t.Fatalf("a space in the tag must refuse")
        }
        if _, err := c.CreateTag(ctx, "v1.4.0", "", "", "tok"); err == nil {
                t.Fatalf("no sha must refuse")
        }
        if _, err := c.CreateTag(ctx, "v1.4.0", "aaaa", "", ""); err == nil {
                t.Fatalf("no token must refuse")
        }
        // GitLab create (the repository tags API shape)
        c, posts = tagsStubForge(t, "gitlab")
        if _, err := c.CreateTag(ctx, "v2.1.0", "dddd", "note", "tok"); err != nil {
                t.Fatalf("gitlab create: %v", err)
        }
        if len(*posts) != 1 || (*posts)[0] != "gltag:v2.1.0:dddd" {
                t.Fatalf("gitlab create shape: %v", *posts)
        }
}

func TestV1295_Tags_RefSegmentLaw(t *testing.T) {
        bad := []string{"", "a b", "a~b", "a^b", "a:b", "a?b", "a*b", "a[b", "a\\b", "-lead", "a..b", "a.lock", strings.Repeat("x", 201)}
        for _, s := range bad {
                if tagRefLegal(s) {
                        t.Errorf("tagRefLegal(%q) must be false", s)
                }
        }
        good := []string{"v1.0.0", "v1.2.3-rc.1", "release-2024.01", "a_b+c"}
        for _, s := range good {
                if !tagRefLegal(s) {
                        t.Errorf("tagRefLegal(%q) must be true", s)
                }
        }
}
