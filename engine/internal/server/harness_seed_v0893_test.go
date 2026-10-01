package server

// harness_seed_v0893_test.go — v0.89.3 THE BOT'S OWN MANUAL: the HF-chat
// artifact seeding contract.
//
//   (1) an HF session (sandbox="hf") created through the real API opens
//       with the 'HARNESS.md' artifact in its drawer — the SAME doc the
//       Spaces ship (brain/HARNESS.md via the hfzero embed) and the bot
//       reads in its workspace;
//   (2) a quick session seeds NOTHING (quick bots have no harness doc);
//   (3) the seeded content is the real manual: it enumerates the tool
//       families (shell, the Strands built-ins, the dt registry) and the
//       /pub serving primitive;
//   (4) deleting the seed respects the user (a re-create does NOT re-seed
//       over the deletion… the seeder runs on CREATE only, so this is
//       structurally guaranteed — the test pins the API-level behavior
//       that a fresh HF chat always seeds exactly once).

import (
        "bytes"
        "encoding/json"
        "net/http/httptest"
        "strings"
        "testing"

        "github.com/ScoobyBaby1999/doomalay/engine/internal/hfzero"
)

func reqJSON(t *testing.T, s *Server, method, path string, body any) (*httptest.ResponseRecorder, map[string]any) {
        t.Helper()
        var rdr *bytes.Reader
        if body != nil {
                b, err := json.Marshal(body)
                if err != nil {
                        t.Fatalf("marshal: %v", err)
                }
                rdr = bytes.NewReader(b)
        } else {
                rdr = bytes.NewReader(nil)
        }
        req := httptest.NewRequest(method, path, rdr)
        req.Header.Set("Content-Type", "application/json")
        w := httptest.NewRecorder()
        s.mux.ServeHTTP(w, req)
        var out map[string]any
        _ = json.Unmarshal(w.Body.Bytes(), &out)
        return w, out
}

func TestHarnessArtifactSeedsOnHFCreateOnly(t *testing.T) {
        m := newMockHubHF(t)
        s := newHubTestServer(t, m)

        // (1) the HF chat seeds HARNESS.md
        w, hfSess := reqJSON(t, s, "POST", "/api/sessions", map[string]any{
                "id": "hs-hf-1", "title": "HF chat", "sandbox": "hf",
                "model": "openai/gpt-4o", "provider": "openai",
        })
        if w.Code != 201 {
                t.Fatalf("HF session create: %d", w.Code)
        }
        hfID, _ := hfSess["ID"].(string)

        w, list := reqJSON(t, s, "GET", "/api/sessions/"+hfID+"/artifacts", nil)
        if w.Code != 200 {
                t.Fatalf("artifacts list: %d", w.Code)
        }
        arts, _ := list["artifacts"].([]any)
        if len(arts) != 1 {
                t.Fatalf("HF chat must open with exactly ONE artifact (HARNESS.md), got %d", len(arts))
        }
        meta := arts[0].(map[string]any)
        if name, _ := meta["name"].(string); !strings.EqualFold(name, "HARNESS.md") {
                t.Fatalf("seeded artifact must be HARNESS.md, got %q", name)
        }
        if src, _ := meta["source"].(string); src != "harness-seed" {
                t.Fatalf("seeded artifact source must be harness-seed, got %q", src)
        }

        // (3) the content is the REAL manual (tool families + /pub primitive)
        aid, _ := meta["id"].(string)
        w, one := reqJSON(t, s, "GET", "/api/sessions/"+hfID+"/artifacts/"+aid, nil)
        if w.Code != 200 {
                t.Fatalf("artifact get: %d", w.Code)
        }
        content, _ := one["content"].(string)
        for _, want := range []string{
                "shell", "file_read", "calculator", "current_time", // tool families
                "swarm", "artifact", "workspace",                     // dt registry picks
                "/pub/<file>",                                        // the serving primitive
                "HARNESS.md",                                         // self-named
        } {
                if !strings.Contains(content, want) {
                        t.Fatalf("seeded HARNESS.md must mention %q (the complete manual rides the seed)", want)
                }
        }

        // (2) the quick chat seeds NOTHING
        w, qSess := reqJSON(t, s, "POST", "/api/sessions", map[string]any{
                "id": "hs-q-1", "title": "Quick chat", "sandbox": "quick",
                "model": "openai/gpt-4o", "provider": "openai",
        })
        if w.Code != 201 {
                t.Fatalf("quick session create: %d", w.Code)
        }
        qID, _ := qSess["ID"].(string)
        w, list2 := reqJSON(t, s, "GET", "/api/sessions/"+qID+"/artifacts", nil)
        if w.Code != 200 {
                t.Fatalf("quick artifacts list: %d", w.Code)
        }
        arts2, _ := list2["artifacts"].([]any)
        if len(arts2) != 0 {
                t.Fatalf("quick chat must NOT seed a harness artifact, got %d", len(arts2))
        }
}

func TestHarnessDocRidesTheSpacePackage(t *testing.T) {
        // The SAME doc ships inside every new Space (hfzero.Files carries
        // brain/HARNESS.md) — the workspace pointer and the drawer copy can
        // never drift from what the Space actually contains.
        files, err := hfzero.Files()
        if err != nil {
                t.Fatalf("hfzero files: %v", err)
        }
        var harness []byte
        for _, f := range files {
                if f.Path == "brain/HARNESS.md" {
                        harness = f.Content
                }
        }
        if len(harness) == 0 {
                t.Fatal("the space package must carry brain/HARNESS.md")
        }
        if !strings.Contains(string(harness), "SINGLE SOURCE OF TRUTH") {
                t.Fatal("the riding doc must be the harness manual")
        }
}
