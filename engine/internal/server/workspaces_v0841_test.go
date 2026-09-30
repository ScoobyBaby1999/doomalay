package server

// workspaces_v0841_test.go — THE ATOM CAP (user spec: "Cap the workspaces
// per chat at like 50 I guess.... Or 24? Idk... Ur call." — 32: the
// electron-shell layout [4, 6, 8, 8, 8] fills four shells + a partial
// fifth; the canvas twin is web/atoms.js).
//
// Pinned here:
//   1. the 32nd bind SUCCEEDS (the cap is on the 33rd, not the 32nd);
//   2. the 33rd bind on BOTH routes answers 409 with the exact message
//      ("this chat already orbits 32 workspaces — unbind one first");
//   3. the capped session-workspace bind never connects the inline
//      workspace (no orphan row is created before the refusal);
//   4. another session is untouched (the cap is per-chat, not global).

import (
        "encoding/json"
        "fmt"
        "net/http/httptest"
        "strings"
        "testing"

        "github.com/ScoobyBaby1999/doomalay/engine/internal/config"
        "github.com/ScoobyBaby1999/doomalay/engine/internal/store"
)

func newV841Server(t *testing.T) (*Server, *store.DB) {
        t.Helper()
        dir := t.TempDir()
        db, err := store.Open(dir)
        if err != nil {
                t.Fatalf("store: %v", err)
        }
        if err := db.Migrate(); err != nil {
                t.Fatalf("migrate: %v", err)
        }
        s := New(&config.Config{DataDir: dir}, db, nil)
        return s, db
}

func v841Bind(t *testing.T, s *Server, method, path, body string) *httptest.ResponseRecorder {
        t.Helper()
        req := httptest.NewRequest(method, path, strings.NewReader(body))
        req.Header.Set("Content-Type", "application/json")
        rec := httptest.NewRecorder()
        s.mux.ServeHTTP(rec, req)
        return rec
}

func TestV841_AtomCap(t *testing.T) {
        s, db := newV841Server(t)
        sid := "v841sess"
        if err := db.CreateSession(&store.Session{ID: sid, Title: "t", Model: "nvidia/x", Provider: "nvidia"}); err != nil {
                t.Fatalf("session: %v", err)
        }
        // 32 workspaces exist globally; bind them ALL through the session route.
        for i := 0; i < 32; i++ {
                w := &store.Workspace{
                        ID: fmt.Sprintf("%012x", i), Name: fmt.Sprintf("me/r%02d", i),
                        Kind: "github", Host: "github.com", Owner: "me", Repo: fmt.Sprintf("r%02d", i),
                        Branch: "main", DefaultBranch: "main", Access: "read",
                        RepoURL: fmt.Sprintf("https://e.test/me/r%02d", i),
                }
                if err := db.CreateWorkspace(w); err != nil {
                        t.Fatalf("ws %d: %v", i, err)
                }
                rec := v841Bind(t, s, "POST", "/api/sessions/"+sid+"/workspaces",
                        fmt.Sprintf(`{"workspace_id":"%012x"}`, i))
                if rec.Code != 200 {
                        t.Fatalf("bind %d: expected 200, got %d (%s)", i+1, rec.Code, rec.Body.String())
                }
        }

        // the 33rd via the session route → 409 with the exact message
        w33 := &store.Workspace{ID: "000000000021", Name: "me/r33", Kind: "github", Host: "github.com",
                Owner: "me", Repo: "r33", Branch: "main", DefaultBranch: "main", Access: "read",
                RepoURL: "https://e.test/me/r33"}
        if err := db.CreateWorkspace(w33); err != nil {
                t.Fatalf("ws33: %v", err)
        }
        rec := v841Bind(t, s, "POST", "/api/sessions/"+sid+"/workspaces", `{"workspace_id":"000000000021"}`)
        if rec.Code != 409 {
                t.Fatalf("33rd session bind: expected 409, got %d (%s)", rec.Code, rec.Body.String())
        }
        var errObj map[string]any
        if err := json.Unmarshal(rec.Body.Bytes(), &errObj); err != nil {
                t.Fatalf("decode 409: %v", err)
        }
        want := "this chat already orbits 32 workspaces — unbind one first"
        got, _ := errObj["error"].(string)
        if got != want {
                t.Fatalf("409 message: want %q, got %q", want, got)
        }

        // the 33rd via the per-workspace route → the same 409
        rec = v841Bind(t, s, "POST", "/api/workspaces/000000000021/bind", `{"session_id":"`+sid+`"}`)
        if rec.Code != 409 {
                t.Fatalf("33rd ws bind: expected 409, got %d (%s)", rec.Code, rec.Body.String())
        }

        // unbinding one frees a slot — the 33rd lands
        rec = v841Bind(t, s, "DELETE", "/api/sessions/"+sid+"/workspaces/000000000000", "")
        if rec.Code != 200 {
                t.Fatalf("unbind: expected 200, got %d (%s)", rec.Code, rec.Body.String())
        }
        rec = v841Bind(t, s, "POST", "/api/workspaces/000000000021/bind", `{"session_id":"`+sid+`"}`)
        if rec.Code != 200 {
                t.Fatalf("bind after unbind: expected 200, got %d (%s)", rec.Code, rec.Body.String())
        }

        // the capped session route with an INLINE connect (url path): refused
        // BEFORE the connect — no orphan workspace row may appear.
        before := func() int {
                list, err := db.ListWorkspaces()
                if err != nil {
                        t.Fatalf("list: %v", err)
                }
                return len(list)
        }()
        rec = v841Bind(t, s, "POST", "/api/sessions/"+sid+"/workspaces", `{"url":"https://github.com/me/orphan"}`)
        if rec.Code != 409 {
                t.Fatalf("capped inline connect: expected 409, got %d (%s)", rec.Code, rec.Body.String())
        }
        if after := func() int {
                list, err := db.ListWorkspaces()
                if err != nil {
                        t.Fatalf("list: %v", err)
                }
                return len(list)
        }(); after != before {
                t.Fatalf("capped inline connect created an orphan workspace row (%d → %d)", before, after)
        }

        // a DIFFERENT session is untouched by the cap
        sid2 := "v841sess2"
        if err := db.CreateSession(&store.Session{ID: sid2, Title: "t2", Model: "nvidia/x", Provider: "nvidia"}); err != nil {
                t.Fatalf("session2: %v", err)
        }
        rec = v841Bind(t, s, "POST", "/api/sessions/"+sid2+"/workspaces", `{"workspace_id":"000000000021"}`)
        if rec.Code != 200 {
                t.Fatalf("other session bind: expected 200, got %d (%s)", rec.Code, rec.Body.String())
        }
}
