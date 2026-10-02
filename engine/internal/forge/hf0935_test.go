// hf0935_test.go — the v0.93.5 REPO-CREATION WAVE pins, offline.
//
// The user's live findings this file guards against regressing:
//   - "API: error: this forge does not support that operation" deleting a
//     file on an HF repo → DeleteFile must dispatch to the hub's NDJSON
//     `deletedFile` op (client-proven; the OpenAPI `deletedEntry` is a
//     spec bug — huggingface_hub + hub.js both send deletedFile).
//   - "kind must be GitHub|gitea|gitlab" creating an HF repo → the typed
//     create (model|dataset|space, sdk for spaces, license enum, 402
//     honesty) + the Storage Bucket API (its own endpoint, NOT
//     /api/repos/create).
//   - "license stays none, no names" → LicensesRich carries key+name.
package forge

import (
        "context"
        "encoding/json"
        "net/http"
        "net/http/httptest"
        "strings"
        "testing"
)

// fakeHub935 — the v0.93.5 surface: typed create, buckets, delete commits.
func fakeHub935(t *testing.T) *httptest.Server {
        t.Helper()
        mux := http.NewServeMux()
        j := func(w http.ResponseWriter, v any) {
                w.Header().Set("Content-Type", "application/json")
                _ = json.NewEncoder(w).Encode(v)
        }
        mux.HandleFunc("/api/whoami-v2", func(w http.ResponseWriter, r *http.Request) {
                j(w, map[string]any{"name": "testuser"})
        })
        // typed create — asserts the full v0.93.5 contract per type
        mux.HandleFunc("/api/repos/create", func(w http.ResponseWriter, r *http.Request) {
                var req map[string]any
                _ = json.NewDecoder(r.Body).Decode(&req)
                typ, _ := req["type"].(string)
                if typ == "space" {
                        sdk, _ := req["sdk"].(string)
                        if sdk == "" {
                                w.WriteHeader(422)
                                _, _ = w.Write([]byte(`{"error":"sdk required for spaces"}`))
                                return
                        }
                }
                // the 402 branch: gradio on a free account (the paid-sdk case)
                if typ == "space" && req["sdk"] == "gradio" && req["name"] == "paid" {
                        w.WriteHeader(402)
                        _, _ = w.Write([]byte(`{"error":"payment required"}`))
                        return
                }
                name, _ := req["name"].(string)
                j(w, map[string]any{"url": "https://huggingface.co/x/" + name, "name": name, "id": "0123456789abcdef01234567"})
        })
        // the delete-commit endpoint — pins the deletedFile NDJSON op
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
                if len(lines) != 2 || lines[0]["key"] != "header" || lines[1]["key"] != "deletedFile" {
                        w.WriteHeader(422)
                        _, _ = w.Write([]byte(`{"error":"expected header+deletedFile"}`))
                        return
                }
                val, _ := lines[1]["value"].(map[string]any)
                if val["path"] != "bash-demo.txt" {
                        w.WriteHeader(422)
                        return
                }
                j(w, map[string]any{"commitOid": "delsha999", "commitUrl": "https://huggingface.co/spaces/testuser/proj/commit/delsha999"})
        })
        // the Storage Bucket API (its own endpoint — NOT repos/create)
        mux.HandleFunc("/api/buckets/testuser", func(w http.ResponseWriter, r *http.Request) {
                if r.Method != http.MethodGet {
                        w.WriteHeader(405)
                        return
                }
                j(w, []map[string]any{{"id": "testuser/demo-bucket", "private": false, "description": "a bucket"}})
        })
        mux.HandleFunc("/api/buckets/testuser/newbucket", func(w http.ResponseWriter, r *http.Request) {
                var req map[string]any
                _ = json.NewDecoder(r.Body).Decode(&req)
                if priv, _ := req["private"].(bool); !priv {
                        w.WriteHeader(422)
                        return
                }
                j(w, map[string]any{"url": "https://huggingface.co/buckets/testuser/newbucket", "name": "newbucket", "id": "0123456789abcdef01234567"})
        })
        srv := httptest.NewServer(mux)
        t.Cleanup(srv.Close)
        return srv
}

func hub935Client(t *testing.T) *Client {
        srv := fakeHub935(t)
        old := hfBase
        hfBase = srv.URL
        t.Cleanup(func() { hfBase = old })
        return NewClient(HostInfo{Kind: "hf", Host: "huggingface.co",
                Owner: "testuser", Repo: "proj", HFType: "spaces"})
}

// THE DELETE FIX — the user's live error: "this forge does not support
// that operation". DeleteFile must route to the hub (deletedFile op), not
// ErrUnsupported.
func Test0935DeleteFileDispatchesHF(t *testing.T) {
        c := hub935Client(t)
        out, err := c.DeleteFile(context.Background(), "bash-demo.txt", "main", "", "", "tok")
        if err != nil {
                t.Fatalf("DeleteFile on HF: %v", err)
        }
        if !strings.Contains(out, "delsha999") && !strings.Contains(out, "commit/delsha999") {
                t.Errorf("delete must return the commit id/url, got %q", out)
        }
        // the github-only era answers ErrUnsupported — HF must never again
        c2 := NewClient(HostInfo{Kind: "gitlab", Host: "gitlab.com", Owner: "o", Repo: "r"})
        if _, err := c2.DeleteFile(context.Background(), "x", "main", "", "", ""); err != ErrUnsupported {
                t.Errorf("gitlab delete should stay unsupported, got %v", err)
        }
}

// THE TYPE-FIRST CREATE — sdk validation, streamlit deprecation, the 402
// honesty, the license enum ride, short_description cap.
func Test0935CreateRepoTyped(t *testing.T) {
        c := hub935Client(t)
        ctx := context.Background()

        // space: static sdk rides the body
        meta, err := c.CreateRepoTyped(ctx, "fresh", "a space", "space", "", "mit", false, "tok")
        if err != nil {
                t.Fatalf("space create: %v", err)
        }
        if !strings.HasSuffix(meta.WebURL, "/spaces/testuser/fresh") {
                t.Errorf("space web URL must carry the spaces prefix: %s", meta.WebURL)
        }
        // dataset + model prefixes
        meta, err = c.CreateRepoTyped(ctx, "d1", "", "dataset", "", "", true, "tok")
        if err != nil || !strings.HasSuffix(meta.WebURL, "/datasets/testuser/d1") {
                t.Errorf("dataset create: %v %s", err, meta.WebURL)
        }
        meta, err = c.CreateRepoTyped(ctx, "m1", "", "model", "", "", false, "tok")
        if err != nil || !strings.HasSuffix(meta.WebURL, "/testuser/m1") {
                t.Errorf("model create: %v %s", err, meta.WebURL)
        }
        // invalid sdk refused client-side
        if _, err := c.CreateRepoTyped(ctx, "x", "", "space", "web4", "", false, "tok"); err == nil {
                t.Error("invalid sdk must be refused")
        }
        // streamlit (deprecated) maps to docker
        if _, err := c.CreateRepoTyped(ctx, "st", "", "space", "streamlit", "", false, "tok"); err != nil {
                t.Errorf("streamlit must map to docker, got: %v", err)
        }
        // unknown type refused
        if _, err := c.CreateRepoTyped(ctx, "x", "", "kernel", "", "", false, "tok"); err == nil {
                t.Error("unknown type must be refused (buckets have their own API)")
        }
        // 402 → the plain-language paid-sdk error
        _, err = c.CreateRepoTyped(ctx, "paid", "", "space", "gradio", "", false, "tok")
        if err == nil || !strings.Contains(err.Error(), "static") {
                t.Errorf("402 must name the free sdk, got: %v", err)
        }
        // other forges answer ErrUnsupported from the typed entry
        gh := NewClient(HostInfo{Kind: "github", Host: "github.com", Owner: "o", Repo: "r"})
        if _, err := gh.CreateRepoTyped(ctx, "x", "", "space", "", "", false, "tok"); err != ErrUnsupported {
                t.Errorf("github typed create should be unsupported, got %v", err)
        }
}

// THE STORAGE BUCKETS — the Xet-backed S3-like storage, its OWN endpoint.
func Test0935Buckets(t *testing.T) {
        c := hub935Client(t)
        ctx := context.Background()

        meta, err := c.BucketCreate(ctx, "newbucket", true, "tok")
        if err != nil {
                t.Fatalf("bucket create: %v", err)
        }
        if meta.FullName != "testuser/newbucket" || !strings.HasSuffix(meta.WebURL, "/buckets/testuser/newbucket") {
                t.Errorf("bucket meta wrong: %+v", meta)
        }
        list, err := c.BucketList(ctx, "tok", 10)
        if err != nil || len(list) != 1 || list[0].FullName != "testuser/demo-bucket" {
                t.Errorf("bucket list: %+v %v", list, err)
        }
        // no token → the honest error, not a hub call
        if _, err := c.BucketCreate(ctx, "x", false, ""); err == nil {
                t.Error("bucket create without token must fail honestly")
        }
}

// THE LICENSE NAMES — key AND display name ("mit — MIT License"), the
// hub's real 83-key enum for HF.
func Test0935LicensesRich(t *testing.T) {
        c := hub935Client(t)
        hf, err := c.LicensesRich(context.Background(), "tok")
        if err != nil {
                t.Fatalf("hf licenses: %v", err)
        }
        if len(hf) != 83 {
                t.Errorf("the hub's create enum has 83 keys, got %d", len(hf))
        }
        if hf[0].Key != "apache-2.0" || hf[1].Key != "mit" || hf[1].Name != "MIT" {
                t.Errorf("enum order/labels wrong: %+v %+v", hf[0], hf[1])
        }
        // "other" is the escape hatch and must be present
        found := false
        for _, l := range hf {
                if l.Key == "other" {
                        found = true
                }
        }
        if !found {
                t.Error("'other' must be in the list")
        }
        // gitlab stays honestly unsupported
        gl := NewClient(HostInfo{Kind: "gitlab", Host: "gitlab.com", Owner: "o", Repo: "r"})
        if _, err := gl.LicensesRich(context.Background(), ""); err != ErrUnsupported {
                t.Errorf("gitlab rich licenses should be unsupported, got %v", err)
        }
}
