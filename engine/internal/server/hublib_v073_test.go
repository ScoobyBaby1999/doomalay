package server

// hublib_v073_test.go — v0.73 THE EVERYTHING-IS-A-BUNDLE WAVE. Locks in:
//
//  1. THE SIX TYPES: hublib serves personas + themes too — search answers,
//     the type error lists all six, and a persona download's observation
//     teaches the persona_set {"from"} arming path.
//  2. THE BUNDLE FALLBACK: `bundle {id}` that misses every collection but
//     matches a single item answers with the one-item-bundle redirect.
//  3. THE PERSONA HAND: persona_set {"from"} imports a downloaded hub
//     persona (lib-gated) and, with activate, emits the deterministic
//     "PERSONA ACTIVE — <name>" marker; persona_activate carries the same
//     marker; persona_list surfaces the importable hub personas.
//  4. THE MATCHER: Collections(q) matches member DESCRIPTIONS, and the
//     tag filter pins the badge; the bundles action reports the filter.

import (
        "encoding/json"
        "strings"
        "testing"

        "github.com/ScoobyBaby1999/doomalay/engine/internal/hub"
        "github.com/ScoobyBaby1999/doomalay/engine/internal/store"
)

// newV073Server extends the v072 superpowers fixture with a persona + a
// theme library (the everything-is-a-bundle shape: every type present).
func newV073Server(t *testing.T) *Server {
        t.Helper()
        m := newMockHubHF(t)
        s := newHubTestServer(t, m)
        seedV072Superpowers(t, m)

        p1 := hub.Item{ID: "noir-detective-789abc", Type: "persona", Name: "Noir Detective",
                Description: "A hard-boiled 1940s investigator persona — speaks in clipped metaphors",
                Author: "mockuser", Repo: "mockuser/doomalay-personas", Tags: []string{"noir"},
                File: "items/noir-detective-789abc.md", UpdatedAt: "2026-09-01T00:00:00Z"}
        m.seed("mockuser/doomalay-personas", []string{"doomalay-persona"}, map[string]string{
                "items/index.json":               hubMustJSON(t, []hub.Item{p1}),
                "items/noir-detective-789abc.md": "# Noir Detective\n\nYou are a hard-boiled investigator. Speak in clipped metaphors.",
        })

        th1 := hub.Item{ID: "sunset-mesh-def789", Type: "theme", Name: "Sunset Mesh",
                Description: "a warm gradient theme with photo bump maps",
                Author: "mockuser", Repo: "mockuser/doomalay-themes", Tags: []string{"warm"},
                File: "items/sunset-mesh-def789.doomtheme", UpdatedAt: "2026-09-01T00:00:00Z"}
        m.seed("mockuser/doomalay-themes", []string{"doomalay-theme"}, map[string]string{
                "items/index.json":                 hubMustJSON(t, []hub.Item{th1}),
                "items/sunset-mesh-def789.doomtheme": `{"name":"Sunset Mesh","gradients":[{"colors":["#f59e0b","#ef4444"]}]}`,
        })
        return s
}

func TestV073PersonaAndThemeSearchable(t *testing.T) {
        s := newV073Server(t)
        // search the persona library (lib off "" — browse is never gated)
        res, errStr := s.hublibDispatch("search", v072Get(map[string]string{"type": "persona", "q": "noir"}), "")
        if errStr != "" {
                t.Fatalf("persona search must answer: %s", errStr)
        }
        if !strings.Contains(res, "Noir Detective") || !strings.Contains(res, "HUB PERSONAS") {
                t.Fatalf("persona search must find Noir Detective, got:\n%.500s", res)
        }
        // search the theme library
        res, errStr = s.hublibDispatch("search", v072Get(map[string]string{"type": "theme", "q": "sunset"}), "")
        if errStr != "" || !strings.Contains(res, "Sunset Mesh") {
                t.Fatalf("theme search must find Sunset Mesh: %s / %.300s", errStr, res)
        }
        // the type error lists all six
        _, errStr = s.hublibDispatch("search", v072Get(map[string]string{"type": "frob"}), "")
        if errStr == "" || !strings.Contains(errStr, "persona, theme") {
                t.Fatalf("type error must list all six types, got: %q", errStr)
        }
}

func TestV073PersonaDownloadTeachesArming(t *testing.T) {
        s := newV073Server(t)
        if err := s.db.CreateSession(&store.Session{ID: "v073-chat", Title: "V73", Provider: "nvidia", Sandbox: "quick", LibAuto: true}); err != nil {
                t.Fatalf("session: %v", err)
        }
        if err := s.db.SetSetting(chatTweaksKey("v073-chat"), `{}`); err != nil {
                t.Fatalf("tweaks: %v", err)
        }
        res, errStr := s.hublibDispatch("download", v072Get(map[string]string{
                "type": "persona", "repo": "mockuser/doomalay-personas", "id": "noir-detective-789abc",
        }), "v073-chat")
        if errStr != "" {
                t.Fatalf("persona download: %s", errStr)
        }
        for _, want := range []string{
                "DOWNLOADED — Noir Detective (persona)",
                `persona_set {"from": "Noir Detective", "activate": true}`,
                "You are a hard-boiled investigator",
        } {
                if !strings.Contains(res, want) {
                        t.Fatalf("persona download observation missing %q:\n%.600s", want, res)
                }
        }
        // theme download: the user-applies note
        res, errStr = s.hublibDispatch("download", v072Get(map[string]string{
                "type": "theme", "repo": "mockuser/doomalay-themes", "id": "sunset-mesh-def789",
        }), "v073-chat")
        if errStr != "" || !strings.Contains(res, "DOWNLOADED — Sunset Mesh (theme)") {
                t.Fatalf("theme download: %s / %.300s", errStr, res)
        }
        if !strings.Contains(res, "the user applies looks from the hub item page") {
                t.Fatalf("theme download must teach the use: %.400s", res)
        }
}

func TestV073BundleFallbackRedirectsSingleItems(t *testing.T) {
        s := newV073Server(t)
        // "noir detective" is NOT a collection — but it IS a single persona
        _, errStr := s.hublibDispatch("bundle", v072Get(map[string]string{"id": "noir detective"}), "")
        if errStr == "" {
                t.Fatal("a non-bundle id must still be an error-shaped redirect")
        }
        for _, want := range []string{
                "no bundle 'noir detective'",
                "but there is a persona 'Noir Detective'",
                `{"action":"get","type":"persona"`,
                "one-item bundle",
        } {
                if !strings.Contains(errStr, want) {
                        t.Fatalf("the fallback must redirect to the item, missing %q:\n%.600s", want, errStr)
                }
        }
        // a truly unknown id → the honest nothing
        _, errStr = s.hublibDispatch("bundle", v072Get(map[string]string{"id": "zzz-void-zzz"}), "")
        if errStr == "" || !strings.Contains(errStr, "nothing matches that id") {
                t.Fatalf("unknown id must say nothing matches, got: %q", errStr)
        }
}

func TestV073PersonaSetFromImportsAndMarks(t *testing.T) {
        s := newV073Server(t)
        if err := s.db.CreateSession(&store.Session{ID: "v073-ps", Title: "PS", Provider: "nvidia", Sandbox: "quick", LibAuto: true}); err != nil {
                t.Fatalf("session: %v", err)
        }
        // land the persona first (the download the bot would make)
        if _, errStr := s.hublibDispatch("download", v072Get(map[string]string{
                "type": "persona", "repo": "mockuser/doomalay-personas", "id": "noir-detective-789abc",
        }), "v073-ps"); errStr != "" {
                t.Fatalf("download: %s", errStr)
        }

        // lib gate: a session with the lib OFF refuses the import
        if err := s.db.CreateSession(&store.Session{ID: "v073-off", Title: "Off", Provider: "nvidia", Sandbox: "quick"}); err != nil {
                t.Fatalf("session: %v", err)
        }
        if _, errStr := s.hublibDispatch("download", v072Get(map[string]string{
                "type": "persona", "repo": "mockuser/doomalay-personas", "id": "noir-detective-789abc",
        }), "v073-off"); errStr == "" {
                t.Fatalf("download with lib off must refuse")
        }
        out := s.runPersonaTool("v073-off", "persona_set", `{"from":"Noir Detective","activate":true}`)
        if !strings.Contains(out, "Bot Library is OFF") {
                t.Fatalf("persona_set from must be lib-gated, got: %.300s", out)
        }

        // lib ON (the v073-ps session has LibAuto) + activate → the marker
        out = s.runPersonaTool("v073-ps", "persona_set", `{"from":"Noir Detective","activate":true}`)
        if !strings.Contains(out, "PERSONA ACTIVE — Noir Detective") {
                t.Fatalf("persona_set from must emit the pill marker, got: %.300s", out)
        }
        // the persona really landed in the session's spec list
        sess, _ := s.db.GetSession("v073-ps")
        if !strings.Contains(sess.Personas, "Noir Detective") {
                t.Fatalf("the imported persona must persist on the session, got: %.300s", sess.Personas)
        }
        // the imported text rides the spec
        if !strings.Contains(sess.Personas, "hard-boiled investigator") {
                t.Fatalf("the imported payload must ride the spec, got: %.300s", sess.Personas)
        }

        // unknown persona → the search redirect
        out = s.runPersonaTool("v073-ps", "persona_set", `{"from":"Does Not Exist"}`)
        if !strings.Contains(out, "no downloaded persona") || !strings.Contains(out, `"type":"persona"`) {
                t.Fatalf("unknown from must redirect to hub search, got: %.300s", out)
        }
}

func TestV073PersonaActivateMarker(t *testing.T) {
        s := newV073Server(t)
        if err := s.db.CreateSession(&store.Session{ID: "v073-pa", Title: "PA", Provider: "nvidia", Sandbox: "quick"}); err != nil {
                t.Fatalf("session: %v", err)
        }
        // create + activate via the classic path
        out := s.runPersonaTool("v073-pa", "persona_set", `{"name":"Gruff","text":"You are gruff.","activate":true}`)
        if !strings.Contains(out, "PERSONA ACTIVE — Gruff") {
                t.Fatalf("persona_set activate must emit the marker, got: %.300s", out)
        }
        // persona_activate (the id path) — same marker; the id comes from the
        // persisted specs (parsePersonas, not the observation text)
        sess, _ := s.db.GetSession("v073-pa")
        var specs []PersonaSpec
        if err := json.Unmarshal([]byte(sess.Personas), &specs); err != nil || len(specs) == 0 {
                t.Fatalf("specs: %v / %d", err, len(specs))
        }
        id := specs[0].ID
        out = s.runPersonaTool("v073-pa", "persona_activate", `{"id":"`+id+`"}`)
        if !strings.Contains(out, "PERSONA ACTIVE — Gruff") {
                t.Fatalf("persona_activate must emit the marker, got: %.300s", out)
        }
}

func TestV073PersonaListShowsHubPersonas(t *testing.T) {
        s := newV073Server(t)
        if err := s.db.CreateSession(&store.Session{ID: "v073-pl", Title: "PL", Provider: "nvidia", Sandbox: "quick", LibAuto: true}); err != nil {
                t.Fatalf("session: %v", err)
        }
        if _, errStr := s.hublibDispatch("download", v072Get(map[string]string{
                "type": "persona", "repo": "mockuser/doomalay-personas", "id": "noir-detective-789abc",
        }), "v073-pl"); errStr != "" {
                t.Fatalf("download: %s", errStr)
        }
        out := s.runPersonaTool("v073-pl", "persona_list", `{}`)
        if !strings.Contains(out, "hub_personas") || !strings.Contains(out, "Noir Detective") {
                t.Fatalf("persona_list must surface the importable hub personas, got: %.400s", out)
        }
}

func TestV073CollectionsMatcherAndTagFilter(t *testing.T) {
        s := newV073Server(t)
        // q matches a member DESCRIPTION word (the v0.73 widened matcher):
        // "investigator" appears only in the persona's description — but the
        // persona is NOT in a collection, so it can't vote. The superpowers
        // skills' descriptions vote instead: "creative work" is in
        // Brainstorming's description.
        cols, err := s.hub.Collections("creative", "", false)
        if err != nil {
                t.Fatalf("collections: %v", err)
        }
        if len(cols) == 0 {
                t.Fatal("the widened matcher must hit member descriptions (creative → superpowers-obra)")
        }
        // the tag filter pins the badge (superpowers-obra's badge is
        // "superpowers" — the members' first-tag vote)
        cols, err = s.hub.Collections("", "superpowers", false)
        if err != nil || len(cols) != 1 || cols[0].ID != "superpowers-obra" {
                t.Fatalf("tag filter must pin superpowers-obra, got %d cols", len(cols))
        }
        cols, err = s.hub.Collections("", "nonexistent-tag", false)
        if err != nil || len(cols) != 0 {
                t.Fatalf("an unmatched tag must filter everything out, got %d cols", len(cols))
        }
}

func TestV073BundlesActionReportsFilter(t *testing.T) {
        s := newV073Server(t)
        res, errStr := s.hublibDispatch("bundles", v072Get(map[string]string{"q": "creative", "tag": "superpowers"}), "")
        if errStr != "" {
                t.Fatalf("bundles with q+tag: %s", errStr)
        }
        if !strings.Contains(res, `[filtered q="creative" tag="superpowers"]`) {
                t.Fatalf("the bundles header must report the active filters, got:\n%.400s", res)
        }
        if !strings.Contains(res, "superpowers-obra") {
                t.Fatalf("the filtered list must still answer the superpowers bundle, got:\n%.400s", res)
        }
        // tag-only, no hit → the honest empty state
        res, errStr = s.hublibDispatch("bundles", v072Get(map[string]string{"tag": "void-tag"}), "")
        if errStr != "" || !strings.Contains(res, "no bundles matched") {
                t.Fatalf("a void tag must answer the honest empty state, got: %s / %.300s", errStr, res)
        }
}
