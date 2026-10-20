package server

// fleet_v1472_test.go + djournal_v1471_test.go shapes — v1.47 THE TWO
// HANDS (PLAN-V147 §1/§2): the integration battery over the REAL server
// runners against a REAL store (the harness law: temp dirs, no network).
// The mcpbus dispatch itself is pinned by the def-count test.

import (
        "context"
        "encoding/json"
        "os"
        "strings"
        "testing"

        "github.com/ScoobyBaby1999/doomalay/engine/internal/config"
        "github.com/ScoobyBaby1999/doomalay/engine/internal/mcpbus"
        "github.com/ScoobyBaby1999/doomalay/engine/internal/store"
)

func newTestServerV147(t *testing.T) *Server {
        t.Helper()
        dir := t.TempDir()
        db, err := store.Open(dir)
        if err != nil {
                t.Fatalf("store: %v", err)
        }
        if err := db.Migrate(); err != nil {
                t.Fatalf("migrate: %v", err)
        }
        return &Server{db: db, cfg: &config.Config{DataDir: dir}}
}

func seedSessionV147(t *testing.T, s *Server, id, title, provider, model string) *store.Session {
        t.Helper()
        sess := &store.Session{ID: id, Title: title, Provider: provider, Model: model,
                Effort: "max", Mode: "auto", WebSearch: true, Sandbox: "quick"}
        if err := s.db.CreateSession(sess); err != nil {
                t.Fatalf("create session: %v", err)
        }
        return sess
}

func seedEventV147(t *testing.T, s *Server, sid, typ, content string) {
        t.Helper()
        if _, err := s.db.AppendEvent(sid, typ, content, ""); err != nil {
                t.Fatalf("seed event: %v", err)
        }
}

func seedCanvasV147(t *testing.T, s *Server, id, name string, sessionIDs []string) {
        t.Helper()
        icons := make([]map[string]any, 0, len(sessionIDs))
        for i, sid := range sessionIDs {
                icons = append(icons, map[string]any{"id": "icon-" + id + "-" + string(rune('a'+i)), "sessionId": sid})
        }
        stateBytes, _ := json.Marshal(map[string]any{"icons": icons, "savedAt": "2026-10-20"})
        state := string(stateBytes)
        if _, err := s.db.UpsertCanvas(id, &name, nil, &state); err != nil {
                t.Fatalf("seed canvas: %v", err)
        }
}

// ── v1.47.1 THE JOURNAL HAND: the runner against a real DataDir ─────

func TestV1471_DjournalRunnerWriteReadExport(t *testing.T) {
        s := newTestServerV147(t)
        sid := "sess-j"
        seedSessionV147(t, s, sid, "Journal Chat", "privatemodeai", "glm-5.3")

        ctx := context.Background()
        // 1. write (the bare-string tolerance: models sometimes send just words)
        out := s.runDjournalAction(ctx, sid, `{"action":"write","text":"the rig is green","mood":"good","tags":"work,ship"}`)
        if !strings.Contains(out, "Saved journal entry") || !strings.Contains(out, "🙂") {
                t.Fatalf("write observation: %s", out)
        }
        // 2. read today
        out = s.runDjournalAction(ctx, sid, `{"action":"read","target":"today"}`)
        if !strings.Contains(out, "the rig is green") {
                t.Fatalf("read today: %s", out)
        }
        // 3. the state file lives under <DataDir>/journal/
        if _, err := os.Stat(s.djournalStatePath()); err != nil {
                t.Fatalf("the diary must live under DataDir/journal: %v", err)
        }
        // 4. export json — the artifact drawer card + the state-dir file
        out = s.runDjournalAction(ctx, sid, `{"action":"export","format":"json"}`)
        if !strings.Contains(out, "Saved as artifact \"export.json\"") {
                t.Fatalf("export must sink the artifact: %s", out)
        }
        // the artifact row exists in the session's drawer
        if _, err := s.findArtifactByName(sid, "export.json"); err != nil {
                t.Fatalf("the export artifact must land in the drawer: %v", err)
        }
        // 5. the bare-string tolerance (a diary line without JSON)
        out = s.runDjournalAction(ctx, sid, "just the words I want to journal")
        if !strings.Contains(out, "Saved journal entry") {
                t.Fatalf("bare string must become a write: %s", out)
        }
        // 6. the review
        out = s.runDjournalAction(ctx, sid, `{"action":"review","period":"week"}`)
        if !strings.Contains(out, "Journal review — week") || !strings.Contains(out, "avg mood") {
                t.Fatalf("review: %s", out)
        }
}

func TestV1471_DjournalDefAndSummaryRegistered(t *testing.T) {
        // the Def is in the manifest (GateNone — always armed)
        specs := mcpbus.SpecsFor(mcpbus.Gates{})
        found := false
        for _, sp := range specs {
                fn, _ := sp["function"].(map[string]any)
                if fn != nil && fn["name"] == "djournal" {
                        found = true
                        props, _ := fn["parameters"].(map[string]any)
                        if props == nil {
                                t.Fatal("djournal spec missing parameters")
                        }
                }
        }
        if !found {
                t.Fatal("djournal missing from the always-armed manifest")
        }
        // the pill body law: the action + operand head
        if got := mcpbus.DefaultSummary("djournal", `{"action":"read","target":"today"}`); got != "read today" {
                t.Errorf("djournal summary = %q, want 'read today'", got)
        }
}
