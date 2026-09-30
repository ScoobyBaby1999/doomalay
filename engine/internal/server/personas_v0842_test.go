package server

// personas_v0842_test.go — THE PERSONA BADGE (user spec: "Let's have each
// persona be a badge around the chat. By default a persona has no badge,
// but a user can select a badge and associate it with a persona, it may be
// a basic solid color outline around the edge of the circle for the
// chatbot icon, or a gradient, or an image, basically our coloring
// system").
//
// Pinned here:
//   1. the badge rides the personas JSON round-trip (PATCH → GET);
//   2. parsePersonas SANITIZES (a bad token degrades to no badge; a valid
//      one survives the engine's own re-serialization — persona_set /
//      persona_activate must never DROP a badge);
//   3. the image rows: PUT rev 1 → PUT rev 2 → GET bytes (immutable cache)
//      → DELETE → GET 404; a missing session 404s;
//   4. persona_activate re-serialization KEEPS the badge.

import (
        "bytes"
        "encoding/json"
        "net/http/httptest"
        "testing"

        "github.com/ScoobyBaby1999/doomalay/engine/internal/config"
        "github.com/ScoobyBaby1999/doomalay/engine/internal/store"
)

func newV842Server(t *testing.T) (*Server, *store.DB, string) {
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
        sid := "v842sess"
        if err := db.CreateSession(&store.Session{ID: sid, Title: "t", Model: "nvidia/x", Provider: "nvidia"}); err != nil {
                t.Fatalf("session: %v", err)
        }
        return s, db, sid
}

func v842Req(t *testing.T, s *Server, method, path string, body []byte, ct string) *httptest.ResponseRecorder {
        t.Helper()
        var rdr *bytes.Reader
        if body == nil {
                rdr = bytes.NewReader(nil)
        } else {
                rdr = bytes.NewReader(body)
        }
        req := httptest.NewRequest(method, path, rdr)
        if ct != "" {
                req.Header.Set("Content-Type", ct)
        }
        rec := httptest.NewRecorder()
        s.mux.ServeHTTP(rec, req)
        return rec
}

func TestV842_BadgeSpecRoundTrip(t *testing.T) {
        s, db, sid := newV842Server(t)

        // (1) a gradient badge PATCHes in and GETs back verbatim
        list := []map[string]any{{
                "id": "p_ring", "name": "Ring", "text": "be circular", "mode": "always",
                "badge": map[string]any{"kind": "gradient", "from": "accent", "to": "accent-2", "angle": 90},
        }}
        raw, _ := json.Marshal(list)
        // the PATCH carries the personas as a JSON STRING (the column's own
        // encoding — an array body would fail the req["personas"].(string) assert)
        strJSON, _ := json.Marshal(string(raw))
        rec := v842Req(t, s, "PATCH", "/api/sessions/"+sid, []byte(`{"personas":`+string(strJSON)+`}`), "application/json")
        if rec.Code != 200 {
                t.Fatalf("patch: %d %s", rec.Code, rec.Body.String())
        }
        sess, err := db.GetSession(sid)
        if err != nil || sess == nil {
                t.Fatalf("get: %v", err)
        }
        var back []PersonaSpec
        if err := json.Unmarshal([]byte(sess.Personas), &back); err != nil || len(back) != 1 {
                t.Fatalf("personas decode: %v (%s)", err, sess.Personas)
        }
        if back[0].Badge == nil || back[0].Badge.Kind != "gradient" || back[0].Badge.Angle != 90 {
                t.Fatalf("badge = %+v", back[0].Badge)
        }

        // (2) parsePersonas sanitizes: a poisoned token degrades to no badge
        poison := `[{"id":"p_bad","name":"Bad","text":"x","mode":"always","badge":{"kind":"solid","token":"javascript:alert(1)"}}]`
        sessBad := &store.Session{ID: "v842b", Personas: poison}
        specs := parsePersonas(sessBad)
        if len(specs) != 1 || specs[0].Badge != nil {
                t.Fatalf("poison badge = %+v", specs[0].Badge)
        }

        // (4) persona_activate re-serialization KEEPS the badge (the struct
        // carries it; a dropped field would strip it on every bot-side edit)
        out := s.runPersonaTool(sid, "persona_activate", `{"id":"p_ring"}`)
        if !bytes.Contains([]byte(out), []byte("PERSONA ACTIVE")) {
                t.Fatalf("activate out: %q", out)
        }
        sess2, _ := db.GetSession(sid)
        var kept []PersonaSpec
        if err := json.Unmarshal([]byte(sess2.Personas), &kept); err != nil || len(kept) != 1 {
                t.Fatalf("personas2 decode: %v", err)
        }
        if kept[0].Badge == nil || kept[0].Badge.Kind != "gradient" {
                t.Fatalf("badge lost on re-serialization: %+v", kept[0].Badge)
        }
}

func TestV842_BadgeImageRoutes(t *testing.T) {
        s, _, sid := newV842Server(t)
        pid := "p_ring"
        png := []byte{0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 1, 2, 3, 4, 5, 6}

        // PUT → rev 1
        rec := v842Req(t, s, "PUT", "/api/sessions/"+sid+"/personabadge/"+pid, png, "image/png")
        if rec.Code != 200 {
                t.Fatalf("put1: %d %s", rec.Code, rec.Body.String())
        }
        var put1 map[string]any
        if err := json.Unmarshal(rec.Body.Bytes(), &put1); err != nil || put1["rev"].(float64) != 1 {
                t.Fatalf("put1 body: %v %v", put1, err)
        }
        // PUT again → rev 2
        rec = v842Req(t, s, "PUT", "/api/sessions/"+sid+"/personabadge/"+pid, png, "image/png")
        var put2 map[string]any
        if err := json.Unmarshal(rec.Body.Bytes(), &put2); err != nil || put2["rev"].(float64) != 2 {
                t.Fatalf("put2 body: %v %v", put2, err)
        }
        // GET → the bytes + the immutable cache
        rec = v842Req(t, s, "GET", "/api/sessions/"+sid+"/personabadge/"+pid+"?v=2", nil, "")
        if rec.Code != 200 {
                t.Fatalf("get: %d %s", rec.Code, rec.Body.String())
        }
        if !bytes.HasPrefix(rec.Body.Bytes(), []byte{0x89, 'P', 'N', 'G'}) {
                t.Fatalf("get bytes: %q", rec.Body.Bytes()[:8])
        }
        if rec.Header().Get("Cache-Control") != "public, max-age=31536000, immutable" {
                t.Fatalf("cache-control: %q", rec.Header().Get("Cache-Control"))
        }
        // DELETE → ok, then GET 404s
        rec = v842Req(t, s, "DELETE", "/api/sessions/"+sid+"/personabadge/"+pid, nil, "")
        if rec.Code != 200 {
                t.Fatalf("delete: %d %s", rec.Code, rec.Body.String())
        }
        rec = v842Req(t, s, "GET", "/api/sessions/"+sid+"/personabadge/"+pid, nil, "")
        if rec.Code != 404 {
                t.Fatalf("get after delete: %d", rec.Code)
        }
        // a missing session 404s
        rec = v842Req(t, s, "PUT", "/api/sessions/nope/personabadge/"+pid, png, "image/png")
        if rec.Code != 404 {
                t.Fatalf("missing session: %d", rec.Code)
        }
        // not an image → 415
        rec = v842Req(t, s, "PUT", "/api/sessions/"+sid+"/personabadge/"+pid, []byte("plain text"), "text/plain")
        if rec.Code != 415 {
                t.Fatalf("not an image: %d", rec.Code)
        }
}
