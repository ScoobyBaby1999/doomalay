package server

// lexicon_v1370_test.go — v1.36.4/§5 THE HONEST BLOCKS + THE LIVING LEXICON
// pins (PLAN-V137 §4+§5, the engine side).
//
// 1. THE TOGGLE: ph_blocks_off strips the five MIRROR block tokens from the
//    composed text (gaps collapsed) — facts still expand.
// 2. THE OVERRIDES: block_overrides replaces a block's live expansion; the
//    {artifacts} yield rule survives; the sanitizer drops foreign keys and
//    refuses non-maps; a reset (empty map) restores the live truth.
// 3. THE FULL ENDPOINT: ?full=1 raises the per-block cap and the override
//    rides the emitted text with its live default alongside.
// 4. THE TEMPLATE CUSTOMS (v1.36.5): a custom value containing {tokens}
//    re-expands in the bounded second pass; a cycle terminates as a literal
//    leftover — never a loop.
// 5. The PATCH round-trip: ph_blocks_off + block_overrides persist and
//    re-read through the session GET.

import (
        "encoding/json"
        "net/http/httptest"
        "strings"
        "testing"

        "github.com/ScoobyBaby1999/doomalay/engine/internal/config"
        "github.com/ScoobyBaby1999/doomalay/engine/internal/store"
)

func newV1370Server(t *testing.T) *Server {
        t.Helper()
        dir := t.TempDir()
        db, err := store.Open(dir)
        if err != nil {
                t.Fatalf("store: %v", err)
        }
        if err := db.Migrate(); err != nil {
                t.Fatalf("migrate: %v", err)
        }
        // New() wires the mux (the {id} path values need the router — the
        // v28 test server law)
        return New(&config.Config{DataDir: dir}, db, nil)
}

func newV1370Session(t *testing.T, s *Server, id string) *store.Session {
        t.Helper()
        sess := &store.Session{ID: id, Title: "Scooby", Model: "stub/model-x", Provider: "stub"}
        if err := s.db.CreateSession(sess); err != nil {
                t.Fatalf("create: %v", err)
        }
        return sess
}

// TestV1370_BlocksOffExcludes — the toggle strips the five tokens, collapses
// the gaps, and leaves the facts (which substitute in the EARLIER pass).
func TestV1370_BlocksOffExcludes(t *testing.T) {
        s := newV1370Server(t)
        sess := newV1370Session(t, s, "v1370a")

        text := "line one\n\n{repo_access}\n\n{artifacts}\n\n{library}\n\n{controls}\n\n{session}\n\nafter {date}"
        on := s.expandPromptBlocks(text, sess, "", false)
        for _, k := range placeholderBlocks {
                if strings.Contains(on, "{"+k+"}") {
                        t.Fatalf("blocks ON: {%s} must expand, got literal", k)
                }
        }

        sess.PhBlocksOff = true
        off := s.expandPromptBlocks(text, sess, "", false)
        for _, k := range placeholderBlocks {
                if strings.Contains(off, "{"+k+"}") {
                        t.Fatalf("blocks OFF: {%s} must be gone, got literal", k)
                }
        }
        if strings.Contains(off, "\n\n\n") {
                t.Fatalf("blocks OFF: gaps must collapse, got %q", off)
        }
        if !strings.Contains(off, "line one") || !strings.Contains(off, "after ") {
                t.Fatalf("blocks OFF: the plain text must stand: %q", off)
        }
        if strings.Contains(off, "{date}") {
                t.Fatalf("blocks OFF: the {date} FACT must still expand: %q", off)
        }
        // {date} is a FACT — it still expands even with the blocks off (the
        // earlier substituteAllVars pass owns it; expandPromptBlocks's own twin
        // stands for the direct-call shape).
        off2 := s.expandPromptBlocks("today is {date}", sess, "", false)
        if strings.Contains(off2, "{date}") {
                t.Fatalf("the {date} fact must still expand with blocks off: %q", off2)
        }
}

// TestV1370_OverridesWin — an override replaces the live expansion; the live
// default returns when the override clears; foreign keys never ride.
func TestV1370_OverridesWin(t *testing.T) {
        s := newV1370Server(t)
        sess := newV1370Session(t, s, "v1370b")

        base := s.expandPromptBlocks("head\n\n{session}\n\ntail", sess, "", false)

        ov := map[string]string{"session": "MY SESSION TRUTH"}
        raw, _ := json.Marshal(ov)
        sess.BlockOverrides = string(raw)
        got := s.expandPromptBlocks("head\n\n{session}\n\ntail", sess, "", false)
        if !strings.Contains(got, "MY SESSION TRUTH") {
                t.Fatalf("the override must win, got: %q", got)
        }
        if strings.Contains(got, "MY SESSION TRUTH") && got == base {
                t.Fatalf("override output must differ from the live base")
        }

        // reset: an empty map restores the live truth
        sess.BlockOverrides = "{}"
        reset := s.expandPromptBlocks("head\n\n{session}\n\ntail", sess, "", false)
        if reset != base {
                t.Fatalf("reset must restore the live base\ngot:  %q\nwant: %q", reset, base)
        }

        // the sanitizer: foreign keys die, non-maps refuse to "{}"
        if got := sanitizeBlockOverrides(`{"session":"x","not_a_block":"y"}`); strings.Contains(got, "not_a_block") {
                t.Fatalf("foreign keys must die, got %q", got)
        }
        if got := sanitizeBlockOverrides(`{"session":"x"}`); !strings.Contains(got, "session") {
                t.Fatalf("real keys survive, got %q", got)
        }
        if got := sanitizeBlockOverrides(`not json`); got != "" {
                t.Fatalf("non-map must sanitize to empty, got %q", got)
        }
        if got := parseBlockOverrides("not json"); got != nil {
                t.Fatalf("parse of a non-map must be nil, got %v", got)
        }
}

// TestV1370_BlocksEndpointFull — ?full=1 raises the cap; the override rides
// the emitted text with the live default alongside; the toggle reports.
func TestV1370_BlocksEndpointFull(t *testing.T) {
        s := newV1370Server(t)
        newV1370Session(t, s, "v1370c")

        // persist the override through the PATCH door (the endpoint re-reads
        // the session row — in-memory mutation is not the truth)
        long := strings.Repeat("x", 3000)
        ovJSON, _ := json.Marshal(map[string]string{"session": long})
        pbJSON, _ := json.Marshal(map[string]string{"block_overrides": string(ovJSON)})
        pbr := httptest.NewRequest("PATCH", "/api/sessions/v1370c", strings.NewReader(string(pbJSON)))
        pbrec := httptest.NewRecorder()
        s.mux.ServeHTTP(pbrec, pbr)
        if pbrec.Code != 200 {
                t.Fatalf("PATCH override: want 200, got %d (%s)", pbrec.Code, pbrec.Body.String())
        }

        // the glance (default cap): truncated at 2000 — through the MUX
        // (the {id} path value needs the router, the v30 law)
        req := httptest.NewRequest("GET", "/api/sessions/v1370c/blocks", nil)
        rec := httptest.NewRecorder()
        s.mux.ServeHTTP(rec, req)
        var d1 struct {
                Blocks       map[string]map[string]any `json:"blocks"`
                PhBlocksOff  bool                       `json:"ph_blocks_off"`
        }
        if err := json.Unmarshal(rec.Body.Bytes(), &d1); err != nil {
                t.Fatalf("glance decode: %v (%s)", err, rec.Body.String())
        }
        b := d1.Blocks["session"]
        if b == nil {
                t.Fatalf("the session block must ride")
        }
        if b["override"] != true {
                t.Fatalf("the override flag must ride, got %v", b)
        }
        if txt, _ := b["text"].(string); len(txt) != 3000 {
                t.Fatalf("the glance text must be the full override (it is the truth the turn sends), got %d", len(txt))
        }

        // ?full=1: the LIVE default also rides untruncated where it fits
        req2 := httptest.NewRequest("GET", "/api/sessions/v1370c/blocks?full=1", nil)
        rec2 := httptest.NewRecorder()
        s.mux.ServeHTTP(rec2, req2)
        var d2 struct {
                Blocks      map[string]map[string]any `json:"blocks"`
                PhBlocksOff bool                       `json:"ph_blocks_off"`
        }
        if err := json.Unmarshal(rec2.Body.Bytes(), &d2); err != nil {
                t.Fatalf("full decode: %v", err)
        }
        b2 := d2.Blocks["session"]
        if b2 == nil || b2["live"] == nil {
                t.Fatalf("the live default must ride alongside the override")
        }
        if d2.PhBlocksOff {
                t.Fatalf("the toggle must report false by default")
        }

        // the toggle rides the payload truth (PATCHed, not in-memory)
        tgJSON, _ := json.Marshal(map[string]bool{"ph_blocks_off": true})
        s.mux.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("PATCH", "/api/sessions/v1370c", strings.NewReader(string(tgJSON))))
        rec3 := httptest.NewRecorder()
        s.mux.ServeHTTP(rec3, httptest.NewRequest("GET", "/api/sessions/v1370c/blocks", nil))
        if !strings.Contains(rec3.Body.String(), `"ph_blocks_off":true`) {
                t.Fatalf("the toggle must report true: %s", rec3.Body.String())
        }
}

// TestV1370_TemplateCustoms — the bounded second pass (v1.36.5 rung L1).
func TestV1370_PatchRoundTrip(t *testing.T) {
        s := newV1370Server(t)
        newV1370Session(t, s, "v1370d")

        body := `{"ph_blocks_off":true,"block_overrides":"{\"session\":\"OV\"}"}`
        req := httptest.NewRequest("PATCH", "/api/sessions/v1370d", strings.NewReader(body))
        rec := httptest.NewRecorder()
        s.mux.ServeHTTP(rec, req)
        if rec.Code != 200 {
                t.Fatalf("PATCH: want 200, got %d (%s)", rec.Code, rec.Body.String())
        }

        got, err := s.db.GetSession("v1370d")
        if err != nil || got == nil {
                t.Fatalf("get: %v", err)
        }
        if !got.PhBlocksOff {
                t.Fatalf("ph_blocks_off must persist, got %v", got.PhBlocksOff)
        }
        ov := parseBlockOverrides(got.BlockOverrides)
        if ov == nil || ov["session"] != "OV" {
                t.Fatalf("block_overrides must persist, got %q", got.BlockOverrides)
        }

        // back off again — both keys flip
        body2 := `{"ph_blocks_off":false,"block_overrides":"{}"}`
        req2 := httptest.NewRequest("PATCH", "/api/sessions/v1370d", strings.NewReader(body2))
        rec2 := httptest.NewRecorder()
        s.mux.ServeHTTP(rec2, req2)
        if rec2.Code != 200 {
                t.Fatalf("PATCH 2: want 200, got %d", rec2.Code)
        }
        got2, _ := s.db.GetSession("v1370d")
        if got2 == nil || got2.PhBlocksOff {
                t.Fatalf("ph_blocks_off must clear")
        }
        if parseBlockOverrides(got2.BlockOverrides)["session"] != "" {
                t.Fatalf("the override must clear, got %q", got2.BlockOverrides)
        }
}
