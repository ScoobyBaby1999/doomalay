package server

// hublib_v072_test.go — v0.72 THE AUTONOMOUS BUNDLE HAND. Locks in:
//
//  1. THE BUNDLE ACTIONS: hublibDispatch answers bundles / bundle /
//     download_bundle; browsing is NEVER gated (lib-off still lists +
//     details), download_bundle carries the same three gates as a
//     single download (lib pill, tweaks Bot Library, Can download
//     bundles) and lands every member.
//  2. THE SUPERPOWERS COMPETENCE: the superpowers bundle's detail +
//     download observations carry the WORKFLOW order (brainstorm →
//     plans → execution → TDD → review → finish) + the script truth
//     (maintainer scripts vs the skills' companion scripts).
//  3. THE SKILLS HAND: skillsDispatch load emits the "SKILL LOADED —
//     <name>" head (the active-bundle pill's match, live + replay) and
//     honors the lib gate; runSkillsAction wraps the same dispatch.
//  4. THE WS BUNDLE MANIFEST: bundleManifestText composes the
//     pick-load-follow protocol (the pmsdk twin) with skills-first
//     member ordering.
//  5. The unknown-action contract lists every new action.

import (
        "strings"
        "testing"

        "github.com/ScoobyBaby1999/doomalay/engine/internal/hub"
        "github.com/ScoobyBaby1999/doomalay/engine/internal/store"
)

// newV072Server builds a server on the mock HF with a superpowers-shaped
// bundle: 2 skills + 1 script + 2 docs, all Collection "superpowers-obra".
func newV072Server(t *testing.T) *Server {
        t.Helper()
        m := newMockHubHF(t)
        s := newHubTestServer(t, m)

        sk1 := hub.Item{ID: "superpowers-brainstorming-69b7f5", Type: "skill", Name: "Superpowers Brainstorming",
                Description: "You MUST use this before any creative work", Author: "obra", Repo: "mockuser/doomalay-superpowers",
                Tags: []string{"superpowers"}, Collection: "superpowers-obra", File: "items/superpowers-brainstorming-69b7f5.md",
                UpdatedAt: "2026-09-01T00:00:00Z"}
        sk2 := hub.Item{ID: "superpowers-writing-plans-abc123", Type: "skill", Name: "Superpowers Writing Plans",
                Description: "Use when you have a spec or requirements for a multi-step task, before touching code",
                Author: "obra", Repo: "mockuser/doomalay-superpowers", Tags: []string{"superpowers"},
                Collection: "superpowers-obra", File: "items/superpowers-writing-plans-abc123.md", UpdatedAt: "2026-09-01T00:00:00Z"}
        m.seed("mockuser/doomalay-superpowers", []string{"doomalay-skill"}, map[string]string{
                "items/index.json":                        hubMustJSON(t, []hub.Item{sk1, sk2}),
                "items/superpowers-brainstorming-69b7f5.md": "# Superpowers Brainstorming\n\nYou MUST use this before any creative work.",
                "items/superpowers-writing-plans-abc123.md": "# Superpowers Writing Plans\n\nWrite the plan before the code.",
        })

        sc1 := hub.Item{ID: "bump-version-sh-111111", Type: "script", Name: "bump-version.sh",
                Description: "repo version bump helper", Author: "obra", Repo: "mockuser/doomalay-superpowers-scripts",
                Tags: []string{"superpowers"}, Collection: "superpowers-obra", File: "items/bump-version-sh-111111.sh",
                UpdatedAt: "2026-09-01T00:00:00Z"}
        m.seed("mockuser/doomalay-superpowers-scripts", []string{"doomalay-script"}, map[string]string{
                "items/index.json": hubMustJSON(t, []hub.Item{sc1}),
                "items/bump-version-sh-111111.sh": "#!/bin/sh\necho bump",
        })

        d1 := hub.Item{ID: "readme-doc-222222", Type: "doc", Name: "README", Description: "the bundle's readme",
                Author: "obra", Repo: "mockuser/doomalay-superpowers-docs", Tags: []string{"superpowers"},
                Collection: "superpowers-obra", File: "items/readme-doc-222222.md", UpdatedAt: "2026-09-01T00:00:00Z"}
        d2 := hub.Item{ID: "spec-doc-333333", Type: "doc", Name: "The Spec", Description: "the design spec",
                Author: "obra", Repo: "mockuser/doomalay-superpowers-docs", Tags: []string{"superpowers"},
                Collection: "superpowers-obra", File: "items/spec-doc-333333.md", UpdatedAt: "2026-09-01T00:00:00Z"}
        m.seed("mockuser/doomalay-superpowers-docs", []string{"doomalay-doc"}, map[string]string{
                "items/index.json":      hubMustJSON(t, []hub.Item{d1, d2}),
                "items/readme-doc-222222.md": "# README\n\nthe bundle",
                "items/spec-doc-333333.md":   "# The Spec\n\nthe design",
        })
        return s
}

func v072Get(args map[string]string) func(string) string {
        return func(k string) string { return args[k] }
}

func TestV072BundlesListNeverGated(t *testing.T) {
        s := newV072Server(t)
        // "" session = lib OFF (sessionLibOn("") is false) — the LIST still answers.
        res, errStr := s.hublibDispatch("bundles", v072Get(map[string]string{}), "")
        if errStr != "" {
                t.Fatalf("bundles must never be gated (lib off): %s", errStr)
        }
        for _, want := range []string{
                "HUB BUNDLES",
                "superpowers-obra",
                "5 members (2 skills, 1 script, 2 docs)",
                `{"action":"bundle","id":"…"}`,
        } {
                if !strings.Contains(res, want) {
                        t.Fatalf("bundles output missing %q:\n%.600s", want, res)
                }
        }
}

func TestV072BundleDetailCarriesCompetence(t *testing.T) {
        s := newV072Server(t)
        // lib OFF ("" session) — browsing the bundle still answers.
        res, errStr := s.hublibDispatch("bundle", v072Get(map[string]string{"id": "superpowers-obra"}), "")
        if errStr != "" {
                t.Fatalf("bundle detail must never be gated: %s", errStr)
        }
        for _, want := range []string{
                "BUNDLE — superpowers-obra — 5 members",
                "WORKFLOW (superpowers)",
                "brainstorming",
                "writing-plans",
                "test-driven-development",
                "SELECTION:",
                "never force a member onto a task it was not written for",
                "Superpowers Brainstorming",
                "You MUST use this before any creative work",
                "superpowers-brainstorming-69b7f5",
                "bump-version.sh",
                "maintainer",
                `{"action":"download_bundle"`,
        } {
                if !strings.Contains(res, want) {
                        t.Fatalf("bundle detail missing %q:\n%.900s", want, res)
                }
        }
        // the id is normalized: raw "Superpowers Obra!" reaches the same bundle
        res2, errStr2 := s.hublibDispatch("bundle", v072Get(map[string]string{"id": "Superpowers Obra!"}), "")
        if errStr2 != "" || !strings.Contains(res2, "BUNDLE — superpowers-obra") {
                t.Fatalf("bundle id normalization failed: %s / %.200s", errStr2, res2)
        }
}

func TestV072BundleDetailUnknownID(t *testing.T) {
        s := newV072Server(t)
        _, errStr := s.hublibDispatch("bundle", v072Get(map[string]string{"id": "nope"}), "")
        if errStr == "" || !strings.Contains(errStr, "no bundle") {
                t.Fatalf("unknown bundle must refuse with guidance, got: %q", errStr)
        }
}

func TestV072DownloadBundleGatesAndLands(t *testing.T) {
        s := newV072Server(t)

        // gate 1: lib OFF ("" session)
        _, errStr := s.hublibDispatch("download_bundle", v072Get(map[string]string{"id": "superpowers-obra"}), "")
        if errStr == "" || !strings.Contains(errStr, "Bot Library is OFF") {
                t.Fatalf("lib-off must refuse, got: %q", errStr)
        }

        // a real session with the lib ON
        if err := s.db.CreateSession(&store.Session{ID: "v072-chat", Title: "Bundle Bot", Provider: "nvidia", Sandbox: "quick", LibAuto: true}); err != nil {
                t.Fatalf("session: %v", err)
        }

        // gate 2: tweaks Bot Library OFF
        if err := s.db.SetSetting(chatTweaksKey("v072-chat"), `{"botLib":false}`); err != nil {
                t.Fatalf("tweaks: %v", err)
        }
        _, errStr = s.hublibDispatch("download_bundle", v072Get(map[string]string{"id": "superpowers-obra"}), "v072-chat")
        if errStr == "" || !strings.Contains(errStr, "Bot Library switch is OFF") {
                t.Fatalf("tweaks botLib-off must refuse, got: %q", errStr)
        }

        // gate 3: Can download bundles OFF
        if err := s.db.SetSetting(chatTweaksKey("v072-chat"), `{"botDL":false}`); err != nil {
                t.Fatalf("tweaks: %v", err)
        }
        _, errStr = s.hublibDispatch("download_bundle", v072Get(map[string]string{"id": "superpowers-obra"}), "v072-chat")
        if errStr == "" || !strings.Contains(errStr, "Can download bundles switch is OFF") {
                t.Fatalf("tweaks botDL-off must refuse, got: %q", errStr)
        }

        // all gates on → the whole bundle lands
        if err := s.db.SetSetting(chatTweaksKey("v072-chat"), `{}`); err != nil {
                t.Fatalf("tweaks: %v", err)
        }
        res, errStr := s.hublibDispatch("download_bundle", v072Get(map[string]string{"id": "superpowers-obra"}), "v072-chat")
        if errStr != "" {
                t.Fatalf("download_bundle with gates on: %s", errStr)
        }
        for _, want := range []string{
                "DOWNLOADED BUNDLE — superpowers-obra · 5 items (2 skills, 1 script, 2 docs)",
                "WORKFLOW (superpowers)",
                "Superpowers Brainstorming",
                "pick the member that fits the actual sub-problem",
        } {
                if !strings.Contains(res, want) {
                        t.Fatalf("download_bundle output missing %q:\n%.700s", want, res)
                }
        }
        // the members really landed in the engine's local library
        for _, typ := range []string{"skill", "script", "doc"} {
                rows, err := s.hub.Downloads(typ)
                if err != nil {
                        t.Fatalf("downloads(%s): %v", typ, err)
                }
                n := 0
                for _, r := range rows {
                        if r.Item.Collection == "superpowers-obra" {
                                n++
                        }
                }
                want := map[string]int{"skill": 2, "script": 1, "doc": 2}[typ]
                if n != want {
                        t.Fatalf("bundle download landed %d %ss, want %d", n, typ, want)
                }
        }
}

func TestV072UnknownActionListsBundleActions(t *testing.T) {
        s := newV072Server(t)
        _, errStr := s.hublibDispatch("warp", v072Get(map[string]string{}), "")
        if errStr == "" || !strings.Contains(errStr, "Valid: search, get, download, bundles, bundle, download_bundle.") {
                t.Fatalf("unknown action must list the bundle actions, got: %q", errStr)
        }
}

func TestV072SkillsLoadEmitsPillShape(t *testing.T) {
        s := newEmbeddedSkillsTestServer(t) // the embedded superpowers skills
        if err := s.db.CreateSession(&store.Session{ID: "v072-sk", Title: "Sk", Provider: "nvidia", Sandbox: "quick", LibAuto: true}); err != nil {
                t.Fatalf("session: %v", err)
        }
        res, errStr := s.skillsDispatch("load", v072Get(map[string]string{"skill": "superpowers-using-superpowers"}), "v072-sk")
        if errStr != "" {
                t.Fatalf("skills load: %s", errStr)
        }
        if !strings.HasPrefix(res, "SKILL LOADED — superpowers-using-superpowers.") {
                t.Fatalf("the load head must feed the active-bundle pill, got: %.120s", res)
        }

        // lib OFF → load refuses with the switch path
        _, errStr = s.skillsDispatch("load", v072Get(map[string]string{"skill": "superpowers-using-superpowers"}), "")
        if errStr == "" || !strings.Contains(errStr, "Bot Library is OFF") {
                t.Fatalf("skills load must honor the lib gate, got: %q", errStr)
        }

        // runSkillsAction (the direct-path ACTION runner) wraps the same core
        out := s.runSkillsAction("v072-sk", `{"action":"load","skill":"superpowers-using-superpowers"}`)
        if !strings.HasPrefix(out, "OBSERVATION:\nSKILL LOADED — superpowers-using-superpowers.") {
                t.Fatalf("runSkillsAction must return the OBSERVATION-wrapped pill head, got: %.140s", out)
        }
}

func TestV072BundleManifestText(t *testing.T) {
        b := map[string]any{
                "name": "superpowers", "id": "superpowers-obra", "tag": "superpowers",
                "members": []any{
                        map[string]any{"type": "doc", "name": "README", "desc": "the readme", "repo": "r", "id": "d1"},
                        map[string]any{"type": "skill", "name": "Brainstorming", "desc": "before any creative work", "repo": "r", "id": "s1"},
                        map[string]any{"type": "script", "name": "bump.sh", "desc": "version helper", "repo": "r", "id": "c1"},
                },
        }
        m := bundleManifestText(b)
        for _, want := range []string{
                "THE ATTACHED BUNDLE — superpowers (#superpowers) — 3 members",
                "For EVERY request:",
                "· skill — Brainstorming — before any creative work [r / s1]",
                "WORKFLOW (superpowers)",
        } {
                if !strings.Contains(m, want) {
                        t.Fatalf("manifest missing %q:\n%.600s", want, m)
                }
        }
        // skills-first ordering: the skill line precedes the doc line
        si := strings.Index(m, "· skill —")
        di := strings.Index(m, "· doc —")
        if si < 0 || di < 0 || si > di {
                t.Fatalf("manifest must order skills before docs")
        }
        // no members → no manifest
        if out := bundleManifestText(map[string]any{"name": "x", "members": []any{}}); out != "" {
                t.Fatalf("empty members must compose no manifest, got: %q", out)
        }
        if out := bundleManifestText(nil); out != "" {
                t.Fatalf("nil bundle must compose no manifest")
        }
}

func TestV072SuperpowersWorkflowOnlyForSuperpowers(t *testing.T) {
        if superpowersWorkflowBlock("superpowers-obra", false) == "" {
                t.Fatal("the superpowers bundle must carry the workflow block")
        }
        if superpowersWorkflowBlock("some-other-bundle", false) != "" {
                t.Fatal("other bundles must not carry the superpowers workflow")
        }
}
