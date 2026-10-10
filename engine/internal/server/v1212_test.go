package server

// v1212_test.go — PLAN-V122 §1 THE CLEANSING: web search is ALWAYS ON.
// The birth default (omitted web_search births TRUE; explicit false wins)
// and the lib-only PATCH semantics (lib_auto stamps the legacy flags —
// the standalone stacks are gone, one gate, one truth).

import (
        "net/http/httptest"
        "strings"
        "testing"

        "github.com/ScoobyBaby1999/doomalay/engine/internal/config"
        "github.com/ScoobyBaby1999/doomalay/engine/internal/store"
)

func newV1212Server(t *testing.T) *Server {
        t.Helper()
        dir := t.TempDir()
        db, err := store.Open(dir)
        if err != nil {
                t.Fatalf("store: %v", err)
        }
        if err := db.Migrate(); err != nil {
                t.Fatalf("migrate: %v", err)
        }
        return New(&config.Config{DataDir: dir}, db, nil)
}

func createSessionRaw(t *testing.T, s *Server, body string) (int, string) {
        t.Helper()
        req := httptest.NewRequest("POST", "/api/sessions", strings.NewReader(body))
        rec := httptest.NewRecorder()
        s.mux.ServeHTTP(rec, req)
        return rec.Code, rec.Body.String()
}

func patchSessionRaw(t *testing.T, s *Server, id, body string) (int, string) {
        t.Helper()
        req := httptest.NewRequest("PATCH", "/api/sessions/"+id, strings.NewReader(body))
        rec := httptest.NewRecorder()
        s.mux.ServeHTTP(rec, req)
        return rec.Code, rec.Body.String()
}

// THE ALWAYS-ON BIRTH DEFAULT: an API client that omits web_search gets a
// web-search-ON chat (the old default was false — the trap the cleansing
// removes; the UI always sent it, every other client silently lost).
func TestV1212WebSearchBirthDefault(t *testing.T) {
        s := newV1212Server(t)
        code, body := createSessionRaw(t, s, `{"id":"ws-birth","title":"Birth","provider":"nvidia","model":"m"}`)
        if code != 201 {
                t.Fatalf("create HTTP %d: %s", code, body)
        }
        sess, err := s.db.GetSession("ws-birth")
        if err != nil {
                t.Fatalf("get: %v", err)
        }
        if !sess.WebSearch {
                t.Fatalf("omitted web_search must birth TRUE, got false")
        }
}

// An explicit false still wins (API compat — no silent overrides).
func TestV1212WebSearchExplicitFalseWins(t *testing.T) {
        s := newV1212Server(t)
        code, body := createSessionRaw(t, s, `{"id":"ws-explicit","title":"Explicit","provider":"nvidia","model":"m","web_search":false}`)
        if code != 201 {
                t.Fatalf("create HTTP %d: %s", code, body)
        }
        sess, _ := s.db.GetSession("ws-explicit")
        if sess.WebSearch {
                t.Fatalf("explicit web_search:false must win")
        }
}

// THE ONE GATE: a lib_auto PATCH stamps the legacy template/skills flags
// (the standalone stacks are gone; the server is the lockstep writer).
func TestV1212LibPatchStampsLegacyFlags(t *testing.T) {
        s := newV1212Server(t)
        createSessionRaw(t, s, `{"id":"lib-stamp","title":"Stamp","provider":"nvidia","model":"m"}`)
        code, body := patchSessionRaw(t, s, "lib-stamp", `{"lib_auto":true}`)
        if code != 200 {
                t.Fatalf("patch HTTP %d: %s", code, body)
        }
        sess, _ := s.db.GetSession("lib-stamp")
        if !sess.LibAuto || !sess.TemplateAuto || !sess.SkillsAuto {
                t.Fatalf("lib_auto:true must stamp all three, got lib=%v tpl=%v skills=%v",
                        sess.LibAuto, sess.TemplateAuto, sess.SkillsAuto)
        }
        code, _ = patchSessionRaw(t, s, "lib-stamp", `{"lib_auto":false}`)
        if code != 200 {
                t.Fatalf("patch2 HTTP %d", code)
        }
        sess, _ = s.db.GetSession("lib-stamp")
        if sess.LibAuto || sess.TemplateAuto || sess.SkillsAuto {
                t.Fatalf("lib_auto:false must clear all three")
        }
}
