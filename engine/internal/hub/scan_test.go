package hub

// scan_test.go — v0.48 scanner behaviors: multi-layout repo probing
// (hub-native index | items/ fallback | corpus JSONL | conventional
// dirs), the broadened discovery channels (a doomalay-* dataset with NO
// doomalay tags is found via search), corpus payload refs ("<jsonl>#<key>"
// and "<jsonl>#<key>:<child>"), and the downloads listing.

import (
        "encoding/json"
        "strings"
        "testing"
)

// stageJSONForTest is one superpowers-shaped orchestrator payload: the
// "//" header comment doubles as its description.
const stageJSONForTest = `{"//": "SUPERPOWERS BRAINSTORM - ideas-into-designs flow (ported from obra/superpowers)", "task_type": "superpowers_brainstorm", "task": "brainstorm flow", "stages": [{"name": "classify", "role": "extractor", "instructions": "Classify the request.", "inputs": ["prompt"]}], "output_rules": {"format": "markdown"}}`

func jsonlLine(t *testing.T, v any) string {
        t.Helper()
        b, err := json.Marshal(v)
        if err != nil {
                t.Fatalf("marshal jsonl line: %v", err)
        }
        return string(b)
}

// seedCorpusRepo plants the user's real doomalay-superpowers shape:
// topical tags ONLY (no doomalay-template tag — the exact reason the old
// tag-only discovery never saw it), payloads as root-level JSONL corpora.
func seedCorpusRepo(t *testing.T, m *mockHF) {
        t.Helper()
        userTemplates := `[{"name": "Superpowers Plan", "description": "The writing-plans discipline.", "markdown": "# Plan the work in bite-sized tasks"}, {"name": "Superpowers Deep Verification", "description": "Verification as a hard gate.", "markdown": "# Verify everything"}]`
        lines := []string{
                jsonlLine(t, map[string]any{"template": "superpowers_brainstorm", "file": "superpowers_brainstorm.json", "content": stageJSONForTest}),
                jsonlLine(t, map[string]any{"template": "superpowers_user_templates", "file": "superpowers_user_templates.json", "content": userTemplates}),
        }
        skillLines := []string{
                jsonlLine(t, map[string]any{"skill": "superpowers-brainstorming", "file": "SKILL.md", "description": "Use when about to start any creative work.", "content": "---\nname: superpowers-brainstorming\n---\n# Brainstorming\nIdeas into designs."}),
                jsonlLine(t, map[string]any{"skill": "superpowers-tdd", "file": "SKILL.md", "description": "Test-driven development.", "content": "---\nname: superpowers-tdd\n---\n# TDD\nRed green refactor."}),
        }
        m.seedRepo("scooby/doomalay-superpowers", []string{"agent-skills", "prompt-engineering", "superpowers"}, map[string]string{
                "README.md":                   "---\nlicense: mit\n---\n# superpowers\n",
                "superpowers_templates.jsonl": strings.Join(lines, "\n"),
                "superpowers_skills.jsonl":    strings.Join(skillLines, "\n"),
        })
}

func findByName(items []Item, name string) *Item {
        for i := range items {
                if items[i].Name == name {
                        return &items[i]
                }
        }
        return nil
}

// TestScanCorpusLayout — the superpowers corpus (no doomalay tags, JSONL
// payloads) yields templates AND skills, with names, descriptions, tags
// and payload refs derived correctly.
func TestScanCorpusLayout(t *testing.T) {
        m := newMockHF(t)
        seedCorpusRepo(t, m)
        svc := newTestService(t, m)

        tpls, err := svc.Items("template", "", "recent", "", true)
        if err != nil {
                t.Fatalf("templates: %v", err)
        }
        if len(tpls) != 4 { // brainstorm + 2 expanded user templates + the v0.58 deep-research builtin
                for _, it := range tpls {
                        t.Logf("  %s | %s", it.Name, it.File)
                }
                t.Fatalf("want 4 templates from the corpus (3 + builtin), got %d", len(tpls))
        }

        bs := findByName(tpls, "Superpowers Brainstorm")
        if bs == nil {
                t.Fatalf("Superpowers Brainstorm missing: %+v", tpls)
        }
        if bs.Repo != "scooby/doomalay-superpowers" || bs.Author != "scooby" {
                t.Fatalf("brainstorm repo/author = %s/%s", bs.Repo, bs.Author)
        }
        if !strings.HasPrefix(bs.Description, "SUPERPOWERS BRAINSTORM") {
                t.Fatalf("description (from the // comment) = %q", bs.Description)
        }
        if bs.File != "superpowers_templates.jsonl#superpowers_brainstorm" {
                t.Fatalf("payload ref = %q", bs.File)
        }
        if !hasStr(bs.Tags, "superpowers") {
                t.Fatalf("tags = %v (want the corpus-key prefix)", bs.Tags)
        }

        plan := findByName(tpls, "Superpowers Plan")
        if plan == nil {
                t.Fatalf("expanded user template missing: %+v", tpls)
        }
        if plan.File != "superpowers_templates.jsonl#superpowers_user_templates:Superpowers Plan" {
                t.Fatalf("expanded payload ref = %q", plan.File)
        }
        if !strings.HasPrefix(plan.Description, "The writing-plans discipline") {
                t.Fatalf("expanded description = %q", plan.Description)
        }

        skills, err := svc.Items("skill", "", "recent", "", true)
        if err != nil {
                t.Fatalf("skills: %v", err)
        }
        if len(skills) != 2 {
                t.Fatalf("want 2 skills, got %d: %+v", len(skills), skills)
        }
        tdd := findByName(skills, "Superpowers TDD") // acronym prettify
        if tdd == nil {
                t.Fatalf("Superpowers TDD missing (prettify bug?): %+v", skills)
        }
        if !strings.HasPrefix(tdd.Description, "Test-driven development") {
                t.Fatalf("skill description = %q", tdd.Description)
        }

        // personas: the corpus contributes none — and that must NOT error.
        personas, err := svc.Items("persona", "", "recent", "", true)
        if err != nil {
                t.Fatalf("personas: %v", err)
        }
        if len(personas) != 0 {
                t.Fatalf("want 0 personas, got %d", len(personas))
        }

        // search finds it by tag-derived item tags and by name
        hits, _ := svc.Items("skill", "tdd", "relevant", "", true)
        if len(hits) != 1 {
                t.Fatalf("search 'tdd' → %d hits, want 1", len(hits))
        }
}

// TestScanCorpusIsFoundWithoutTags — discovery channels: a repo carrying
// only topical tags (no doomalay-template) is still discovered via the
// name-convention search; a non-doomalay repo is not.
func TestScanCorpusIsFoundWithoutTags(t *testing.T) {
        m := newMockHF(t)
        seedCorpusRepo(t, m)
        // a same-shape repo that does NOT follow the doomalay- convention
        other := []string{
                jsonlLine(t, map[string]any{"template": "some_template", "file": "x.json", "content": `{"stages": []}`}),
        }
        m.seedRepo("scooby/random-corpus", []string{"agent-skills"}, map[string]string{
                "corpus_templates.jsonl": strings.Join(other, "\n"),
        })
        svc := newTestService(t, m)

        tpls, err := svc.Items("template", "", "recent", "", true)
        if err != nil {
                t.Fatalf("templates: %v", err)
        }
        for _, it := range tpls {
                if it.Repo == "scooby/random-corpus" {
                        t.Fatalf("non-doomalay repo leaked into the library: %+v", it)
                }
        }
        if len(tpls) != 4 { // 3 corpus templates + the deep-research builtin
                t.Fatalf("want 4 templates (convention repo only + builtin), got %d", len(tpls))
        }
}

// TestDownloadCorpusRef — downloads resolve corpus refs: a #key row and
// an expanded #key:child entry; Downloads() lists them; a bogus ref
// errors cleanly.
func TestDownloadCorpusRef(t *testing.T) {
        m := newMockHF(t)
        seedCorpusRepo(t, m)
        svc := newTestService(t, m)

        items, err := svc.Items("template", "", "recent", "", true)
        if err != nil {
                t.Fatalf("templates: %v", err)
        }
        bs := findByName(items, "Superpowers Brainstorm")
        plan := findByName(items, "Superpowers Plan")
        if bs == nil || plan == nil {
                t.Fatalf("fixtures missing: %+v", items)
        }

        item, payload, err := svc.Download("template", bs.Repo, bs.ID)
        if err != nil {
                t.Fatalf("download row: %v", err)
        }
        if item.Name != "Superpowers Brainstorm" || payload != stageJSONForTest {
                t.Fatalf("row download = %s / %q", item.Name, truncate(payload, 80))
        }

        rows, err := svc.Downloads("template")
        if err != nil {
                t.Fatalf("downloads: %v", err)
        }
        if len(rows) != 1 || rows[0].Item.ID != bs.ID || rows[0].Payload != stageJSONForTest {
                t.Fatalf("downloads listing = %+v", rows)
        }

        item2, payload2, err := svc.Download("template", plan.Repo, plan.ID)
        if err != nil {
                t.Fatalf("download child: %v", err)
        }
        if item2.Name != "Superpowers Plan" {
                t.Fatalf("child download name = %s", item2.Name)
        }
        var child map[string]any
        if json.Unmarshal([]byte(payload2), &child) != nil || child["name"] != "Superpowers Plan" {
                t.Fatalf("child payload = %q", truncate(payload2, 120))
        }

        rows, _ = svc.Downloads("template")
        if len(rows) != 2 {
                t.Fatalf("downloads after child = %d, want 2", len(rows))
        }

        // a skill downloads too (SKILL.md payload via its #ref)
        skills, _ := svc.Items("skill", "", "recent", "", true)
        tdd := findByName(skills, "Superpowers TDD")
        if tdd == nil {
                t.Fatalf("skill fixture missing")
        }
        _, skPayload, err := svc.Download("skill", tdd.Repo, tdd.ID)
        if err != nil {
                t.Fatalf("skill download: %v", err)
        }
        if !strings.Contains(skPayload, "# TDD") {
                t.Fatalf("skill payload = %q", truncate(skPayload, 80))
        }

        // bogus id → clean not-found
        if _, _, err := svc.Download("template", bs.Repo, "no-such-item-000000"); err != ErrNotFoundLocal {
                t.Fatalf("bogus download err = %v, want ErrNotFoundLocal", err)
        }
}

// TestScanDirLayout — casually posted datasets (conventional dirs, no
// corpus index, no items/ tree): personas/*.md and skills/<name>/SKILL.md.
func TestScanDirLayout(t *testing.T) {
        m := newMockHF(t)
        m.seedRepo("dana/doomalay-stuff", []string{}, map[string]string{
                "personas/moon-bard.md":                 "# Moon Bard\nyou sing to the tide",
                "skills/superpowers-writing-plans/SKILL.md": "---\nname: superpowers-writing-plans\n---\n# Writing Plans\nBreak work down.",
        })
        svc := newTestService(t, m)

        personas, err := svc.Items("persona", "", "recent", "", true)
        if err != nil {
                t.Fatalf("personas: %v", err)
        }
        if len(personas) != 1 || personas[0].Name != "Moon Bard" || personas[0].File != "personas/moon-bard.md" {
                t.Fatalf("dir-probed personas = %+v", personas)
        }

        skills, err := svc.Items("skill", "", "recent", "", true)
        if err != nil {
                t.Fatalf("skills: %v", err)
        }
        if len(skills) != 1 || skills[0].Name != "Superpowers Writing Plans" {
                t.Fatalf("dir-probed skills = %+v", skills)
        }
        if !strings.HasPrefix(skills[0].File, "skills/superpowers-writing-plans/SKILL.md") {
                t.Fatalf("skill file = %q", skills[0].File)
        }

        // download through the plain-path ref
        _, payload, err := svc.Download("persona", "dana/doomalay-stuff", personas[0].ID)
        if err != nil {
                t.Fatalf("dir-layout download: %v", err)
        }
        if !strings.Contains(payload, "you sing to the tide") {
                t.Fatalf("dir-layout payload = %q", truncate(payload, 80))
        }
}

// TestResolvePayloadRefFallback — a #key:child ref whose child name does
// not exist falls back to the whole row content (honest data, not an
// error), and a bogus #key errors.
func TestResolvePayloadRefFallback(t *testing.T) {
        m := newMockHF(t)
        seedCorpusRepo(t, m)
        svc := newTestService(t, m)

        payload, err := svc.resolvePayload("scooby/doomalay-superpowers", "superpowers_templates.jsonl#superpowers_user_templates:No Such Child")
        if err != nil {
                t.Fatalf("fallback ref: %v", err)
        }
        if !strings.HasPrefix(payload, "[{") {
                t.Fatalf("fallback payload = %q", truncate(payload, 80))
        }

        if _, err := svc.resolvePayload("scooby/doomalay-superpowers", "superpowers_templates.jsonl#bogus-key"); err != ErrNotFoundLocal {
                t.Fatalf("bogus key err = %v, want ErrNotFoundLocal", err)
        }
}

func hasStr(list []string, want string) bool {
        for _, s := range list {
                if s == want {
                        return true
                }
        }
        return false
}

// TestScanThemeLibrary — v0.52: .doomtheme look bundles surface from BOTH
// casual layouts: a corpus row keyed "theme" and a themes/ directory of
// .doomtheme files (layout precedence is per-repo — corpus beats dirs —
// so the two probes ride two repos, like real posters would). Downloads
// resolve the bundle JSON through the same ref machinery the other
// libraries use.
func TestScanThemeLibrary(t *testing.T) {
        m := newMockHF(t)
        bundle := `{"format":"doomalay-look","version":1,"scope":"global","state":{"theme":"midnight","names":{"user":"visitors"}}}`
        m.seedRepo("kim/doomalay-themes", []string{"doomalay-theme"}, map[string]string{
                "looks.jsonl": jsonlLine(t, map[string]any{
                        "theme":       "Midnight Look",
                        "file":        "midnight.doomtheme",
                        "description": "deep blues, tiny dots",
                        "content":     bundle,
                }),
        })
        m.seedRepo("rex/doomalay-looks", nil, map[string]string{
                "themes/sunrise-look.doomtheme": `{"format":"doomalay-look","version":1,"scope":"global","state":{"theme":"sunrise"}}`,
        })
        svc := newTestService(t, m)

        themes, err := svc.Items("theme", "", "recent", "", true)
        if err != nil {
                t.Fatalf("themes: %v", err)
        }
        if len(themes) != 2 {
                t.Fatalf("themes = %+v", themes)
        }
        corpus := findByName(themes, "Midnight Look")
        if corpus == nil {
                t.Fatalf("no corpus theme in %+v", themes)
        }
        if corpus.Description != "deep blues, tiny dots" || corpus.Repo != "kim/doomalay-themes" {
                t.Fatalf("corpus theme = %+v", corpus)
        }
        if !strings.HasPrefix(corpus.File, "looks.jsonl#") {
                t.Fatalf("corpus ref = %q", corpus.File)
        }
        dirTheme := findByName(themes, "Sunrise Look")
        if dirTheme == nil || dirTheme.File != "themes/sunrise-look.doomtheme" {
                t.Fatalf("dir theme = %+v", dirTheme)
        }

        // the corpus ref download returns the bundle JSON byte-faithful
        _, payload, err := svc.Download("theme", "kim/doomalay-themes", corpus.ID)
        if err != nil {
                t.Fatalf("theme download: %v", err)
        }
        if !strings.Contains(payload, `"doomalay-look"`) || !strings.Contains(payload, `"midnight"`) {
                t.Fatalf("theme payload = %q", truncate(payload, 120))
        }

        // the dir-layout download (a plain path) hits the file directly
        _, payload2, err := svc.Download("theme", "rex/doomalay-looks", dirTheme.ID)
        if err != nil {
                t.Fatalf("dir theme download: %v", err)
        }
        if !strings.Contains(payload2, `"sunrise"`) {
                t.Fatalf("dir theme payload = %q", truncate(payload2, 120))
        }
}

func truncate(s string, n int) string {
        if len(s) <= n {
                return s
        }
        return s[:n] + "…"
}
