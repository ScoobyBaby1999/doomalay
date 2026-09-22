package server

import (
        "encoding/json"
        "net/http/httptest"
        "strconv"
        "strings"
        "testing"

        "github.com/ScoobyBaby1999/doomalay/engine/internal/config"
        "github.com/ScoobyBaby1999/doomalay/engine/internal/store"
)

// v0.41: GLOBAL CHAT SEARCH — the transcript-across-sessions endpoint.
// Covers: hits + grouping + caps, case-insensitivity, LIKE wildcard
// escaping, hidden-event exclusion, snippet centering + match offset,
// query validation, and store-level substring semantics.
func newSearchTestServer(t *testing.T) *Server {
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
        return New(cfg, db, nil)
}

func seedSearchSession(t *testing.T, s *Server, id, title string, updatedOrder int, msgs [][2]string) {
        t.Helper()
        if err := s.db.CreateSession(&store.Session{ID: id, Title: title, Model: "nvidia/openai/gpt-oss-20b", Provider: "nvidia", Sandbox: "quick"}); err != nil {
                t.Fatalf("create session: %v", err)
        }
        for _, m := range msgs {
                if _, err := s.db.AppendEvent(id, m[0], m[1], ""); err != nil {
                        t.Fatalf("append: %v", err)
                }
        }
        // nudge updated_at so ordering is deterministic (most recent first)
        if _, err := s.db.Exec(`UPDATE chat_sessions SET updated_at = ? WHERE id = ?`, float64(1700000000+updatedOrder), id); err != nil {
                t.Fatalf("touch: %v", err)
        }
}

func searchReq(t *testing.T, s *Server, q string) (*httptest.ResponseRecorder, map[string]any) {
        t.Helper()
        req := httptest.NewRequest("GET", "/api/search?q="+urlQueryEscape(q), nil)
        rec := httptest.NewRecorder()
        s.mux.ServeHTTP(rec, req)
        var out map[string]any
        if rec.Code == 200 {
                if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
                        t.Fatalf("decode: %v", err)
                }
        } else {
                t.Logf("search %q -> %d %s", q, rec.Code, rec.Body.String())
        }
        return rec, out
}

func urlQueryEscape(s string) string {
        var b strings.Builder
        for i := 0; i < len(s); i++ {
                c := s[i]
                if c == '%' || c == '&' || c == '+' || c == '#' || c == ' ' {
                        b.WriteByte('%')
                        b.WriteByte("0123456789ABCDEF"[c>>4])
                        b.WriteByte("0123456789ABCDEF"[c&0xF])
                } else {
                        b.WriteByte(c)
                }
        }
        return b.String()
}

func TestSearchRoute(t *testing.T) {
        s := newSearchTestServer(t)
        seedSearchSession(t, s, "s-alpha", "Pineapple Research", 10, [][2]string{
                {"user", "tell me about pineapples and quantum entanglement"},
                {"assistant", "Pineapples grow quantum crowns in tropical superposition."},
                {"assistant", "Unrelated filler about the weather."},
        })
        seedSearchSession(t, s, "s-beta", "Weather Talk", 5, [][2]string{
                {"user", "no fruit here"},
                {"assistant", "just clouds today"},
        })

        // 1. hit: grouped under the owning chat, ordered most-recent first
        rec, out := searchReq(t, s, "pineapple")
        if rec.Code != 200 {
                t.Fatalf("status %d body %s", rec.Code, rec.Body.String())
        }
        results := out["results"].([]any)
        if len(results) != 1 {
                t.Fatalf("results = %d, want 1 (grouped)", len(results))
        }
        g := results[0].(map[string]any)
        if g["session_id"] != "s-alpha" || g["title"] != "Pineapple Research" {
                t.Fatalf("group = %v", g)
        }
        matches := g["matches"].([]any)
        if len(matches) != 2 {
                t.Fatalf("matches = %d, want 2 (user + assistant only)", len(matches))
        }

        // 2. case-insensitive
        _, out = searchReq(t, s, "PINEAPPLE")
        if len(out["results"].([]any)) != 1 {
                t.Fatalf("case-insensitive failed")
        }

        // 3. non-transcript types are NOT searched (status/thinking)
        if _, err := s.db.AppendEvent("s-beta", "status", `{"state":"pineapple-stealth"}`, ""); err != nil {
                t.Fatal(err)
        }
        _, out = searchReq(t, s, "pineapple-stealth")
        if len(out["results"].([]any)) != 0 {
                t.Fatalf("status leaked into search results")
        }

        // 4. LIKE wildcards match literally (a query with % is not a wildcard)
        _, out = searchReq(t, s, "pine%apple")
        if len(out["results"].([]any)) != 0 {
                t.Fatalf("wildcard query leaked: %v", out["results"])
        }

        // 5. hidden events are excluded (delete-style masking)
        evs, err := s.db.ListEvents("s-alpha", 0)
        if err != nil {
                t.Fatal(err)
        }
        var hideID int64
        for _, ev := range evs {
                if ev.EventType == "user" {
                        hideID = ev.ID
                        break
                }
        }
        if _, err := s.db.AppendEvent("s-alpha", "hide", `[`+strconv.FormatInt(hideID, 10)+`]`, ""); err != nil {
                t.Fatal(err)
        }
        _, out = searchReq(t, s, "pineapple")
        g = out["results"].([]any)[0].(map[string]any)
        if n := len(g["matches"].([]any)); n != 1 {
                t.Fatalf("after hide, matches = %d, want 1 (the user row masked)", n)
        }

        // 6. query validation
        rec, _ = searchReq(t, s, "p")
        if rec.Code != 400 {
                t.Fatalf("1-char query status = %d, want 400", rec.Code)
        }

        // 7. snippet carries the match offset for client-side highlight
        _, out = searchReq(t, s, "superposition")
        g = out["results"].([]any)[0].(map[string]any)
        m0 := g["matches"].([]any)[0].(map[string]any)
        snip := m0["snippet"].(string)
        ms := int(m0["match_start"].(float64))
        if !strings.EqualFold(snip[ms:ms+len("superposition")], "superposition") {
                t.Fatalf("match_start misaligned: snip=%q ms=%d", snip, ms)
        }
}

// Store-level: substring semantics + scan cap sanity.
func TestSearchTranscriptStore(t *testing.T) {
        dir := t.TempDir()
        db, err := store.Open(dir)
        if err != nil {
                t.Fatal(err)
        }
        if err := db.Migrate(); err != nil {
                t.Fatal(err)
        }
        if err := db.CreateSession(&store.Session{ID: "s1", Title: "T", Model: "m", Provider: "p"}); err != nil {
                t.Fatal(err)
        }
        // substring inside a word (FTS token match would MISS this)
        if _, err := db.AppendEvent("s1", "assistant", "disentanglement of bromelain", ""); err != nil {
                t.Fatal(err)
        }
        hits, err := db.SearchTranscript("entangle", 100)
        if err != nil {
                t.Fatal(err)
        }
        if len(hits) != 1 {
                t.Fatalf("substring hits = %d, want 1", len(hits))
        }
        if hits[0].Title != "T" || hits[0].Role != "assistant" {
                t.Fatalf("hit = %+v", hits[0])
        }
        // no match → empty (not nil)
        hits, err = db.SearchTranscript("zzz-not-there", 100)
        if err != nil || len(hits) != 0 {
                t.Fatalf("empty search = %v, %v", hits, err)
        }
}
