package server

// longhaul_v1421_test.go — v1.42.1 THE LONG HAUL (PLAN-V142 §3.0): the
// server-side surfaces.
//
//   (1) the boot heal closes EXACTLY the pending sessions (the tail walk
//       through the real server path) and is idempotent;
//   (2) GET /api/storage/usage answers the honest dashboard shape;
//   (3) POST /api/storage/maintain runs a pass and reports it;
//   (4) the OTA overlay sweep removes deleted files, keeps manifest
//       files and in-flight .tmp downloads.

import (
        "net/http/httptest"
        "os"
        "path/filepath"
        "strings"
        "testing"
        "time"

        "github.com/ScoobyBaby1999/doomalay/engine/internal/config"
	"github.com/ScoobyBaby1999/doomalay/engine/internal/ota"
        "github.com/ScoobyBaby1999/doomalay/engine/internal/store"
)

func newLongHaulServer(t *testing.T) *Server {
        t.Helper()
        dir := t.TempDir()
        db, err := store.Open(dir)
        if err != nil {
                t.Fatalf("store: %v", err)
        }
        if err := db.Migrate(); err != nil {
                t.Fatalf("migrate: %v", err)
        }
        // The REAL constructor (routes registered; OTAURL empty → ota nil; the
        // maintenance goroutine sleeps 30s — tests finish long before).
        cfg := &config.Config{DataDir: dir}
        return New(cfg, db, nil)
}

func seedSession(t *testing.T, s *Server, sid string, shape []struct{ typ, content string }) {
        t.Helper()
        if err := s.db.CreateSession(&store.Session{ID: sid, Title: sid, CreatedAt: float64(time.Now().UnixMilli()) / 1000.0, UpdatedAt: float64(time.Now().UnixMilli()) / 1000.0}); err != nil {
                t.Fatalf("create session: %v", err)
        }
        for _, ev := range shape {
                if _, err := s.db.AppendEvent(sid, ev.typ, ev.content, ""); err != nil {
                        t.Fatalf("seed event: %v", err)
                }
        }
}

// TestV1421_HealClosesExactlyPending — the tail-walk heal through the
// real server path: pending sessions get their terminal, closed ones are
// untouched, a second heal run is a no-op.
func TestV1421_HealClosesExactlyPending(t *testing.T) {
        s := newLongHaulServer(t)
        seedSession(t, s, "pending-1", []struct{ typ, content string }{
                {"user", "hi"}, {"status", `{"state":"running"}`}, {"assistant_delta", "x"},
        })
        seedSession(t, s, "closed-1", []struct{ typ, content string }{
                {"user", "hi"}, {"status", `{"state":"idle"}`},
        })
        seedSession(t, s, "pending-2", []struct{ typ, content string }{
                {"user", "hi"},
        })

        s.healInterruptedTurns()

        // Both pending sessions now end with a healed terminal.
        for _, sid := range []string{"pending-1", "pending-2"} {
                pending, decided := s.db.TailPendingTurn(sid, 20001)
                if pending || !decided {
                        t.Fatalf("%s still pending after heal (pending=%v decided=%v)", sid, pending, decided)
                }
                events, _ := s.db.ListEvents(sid, 0)
                last := events[len(events)-1]
                if last.EventType != "status" || last.Content == "" {
                        t.Fatalf("%s heal appended a non-status tail: %+v", sid, last)
                }
        }

        // The closed session gained nothing.
        events, _ := s.db.ListEvents("closed-1", 0)
        if len(events) != 2 {
                t.Fatalf("closed-1 gained events: %d", len(events))
        }

        // Idempotent: a second run heals nothing.
        s.healInterruptedTurns()
        events, _ = s.db.ListEvents("pending-1", 0)
        if len(events) != 4 { // user + running + delta + healed status
                t.Fatalf("second heal was not a no-op: %d events", len(events))
        }
}

// TestV1421_StorageUsageEndpoint — the dashboard shape.
func TestV1421_StorageUsageEndpoint(t *testing.T) {
        s := newLongHaulServer(t)
        seedSession(t, s, "u1", []struct{ typ, content string }{{"user", "hi"}})

        w := httptest.NewRecorder()
        req := httptest.NewRequest("GET", "/api/storage/usage", nil)
        s.mux.ServeHTTP(w, req)
        if w.Code != 200 {
                t.Fatalf("usage: %d", w.Code)
        }
        body := w.Body.String()
        for _, want := range []string{`"ok":true`, `"db_bytes"`, `"wal_bytes"`, `"chat_events"`, `"hub_items"`, `"sessions"`, `"last_vacuum_at"`, `"overlay"`} {
                if !strings.Contains(body, want) {
                        t.Fatalf("usage body missing %s: %s", want, body)
                }
        }
}

// TestV1421_StorageMaintainEndpoint — the on-demand pass.
func TestV1421_StorageMaintainEndpoint(t *testing.T) {
        s := newLongHaulServer(t)
        if _, err := s.db.AppendEvent("m1", "user", "hi", ""); err != nil {
                t.Fatalf("seed: %v", err)
        }

        w := httptest.NewRecorder()
        req := httptest.NewRequest("POST", "/api/storage/maintain", strings.NewReader(`{"force":true}`))
        s.mux.ServeHTTP(w, req)
        if w.Code != 200 {
                t.Fatalf("maintain: %d %s", w.Code, w.Body.String())
        }
        body := w.Body.String()
        for _, want := range []string{`"ok":true`, `"Checkpointed"`, `"VacuumRan"`} {
                if !strings.Contains(body, want) {
                        t.Fatalf("maintain body missing %s: %s", want, body)
                }
        }
        if s.db.LastVacuumAt() == 0 {
                t.Fatalf("forced maintain did not stamp last_vacuum_at")
        }
}

// TestV1421_OtaOverlaySweep — deleted files die, manifest files and
// in-flight .tmp downloads survive.
func TestV1421_OtaOverlaySweep(t *testing.T) {
        s := newLongHaulServer(t)
        root := t.TempDir()
        s.ota = &otaManager{url: "http://example/manifest.json", root: root}

        kept := filepath.Join(root, "app.js")
        stray := filepath.Join(root, "sandboxpicker.js") // the v1.17.1 deletion, resurrected
        inflight := filepath.Join(root, "hub.js.tmp")
        nested := filepath.Join(root, "sub", "gone.js")
        for _, p := range []string{kept, stray, inflight} {
                if err := os.WriteFile(p, []byte("x"), 0o644); err != nil {
                        t.Fatalf("write: %v", err)
                }
        }
        if err := os.MkdirAll(filepath.Dir(nested), 0o755); err != nil {
                t.Fatalf("mkdir: %v", err)
        }
        if err := os.WriteFile(nested, []byte("x"), 0o644); err != nil {
                t.Fatalf("write: %v", err)
        }

        man := &ota.Manifest{Version: "v9.9.9", Files: []ota.FileEntry{
                {Path: "engine/internal/server/web/app.js"},
                {Path: "engine/internal/server/web/hub.js"},
        }}
        if removed := s.otaOverlaySweep(man); removed != 2 {
                t.Fatalf("sweep removed %d files, want 2 (stray + nested gone)", removed)
        }
        if _, err := os.Stat(kept); err != nil {
                t.Fatalf("manifest file was removed: %v", err)
        }
        if _, err := os.Stat(inflight); err != nil {
                t.Fatalf("in-flight .tmp was removed: %v", err)
        }
        if _, err := os.Stat(stray); !os.IsNotExist(err) {
                t.Fatalf("stray file survived the sweep")
        }
        if _, err := os.Stat(nested); !os.IsNotExist(err) {
                t.Fatalf("nested stray survived the sweep")
        }

        // Once-per-version: a second call with the same version is a no-op
        // even if a new stray appeared.
        s.ota.mu.Lock()
        s.ota.man = man
        s.ota.lastSwept = ""
        s.ota.mu.Unlock()
        if err := os.WriteFile(stray, []byte("x"), 0o644); err != nil {
                t.Fatalf("write: %v", err)
        }
        s.otaSweepOnManifest()
        if _, err := os.Stat(stray); !os.IsNotExist(err) {
                t.Fatalf("sweep-on-manifest did not clean the fresh stray")
        }
        // Now the version IS stamped: a new stray survives until the next version.
        if err := os.WriteFile(stray, []byte("x"), 0o644); err != nil {
                t.Fatalf("write: %v", err)
        }
        s.otaSweepOnManifest()
        if _, err := os.Stat(stray); err != nil {
                t.Fatalf("same-version sweep re-ran (the once-per-version gate failed)")
        }
}
