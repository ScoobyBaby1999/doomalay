package hub

// collections_test.go — v0.52: the BUNCH. Corpus rows carrying icon +
// collection surface on the items, and Collections() derives one grouped
// summary per collection id ACROSS libraries (the superpowers templates +
// skills all clamping into one listing), with the members' hearts +
// downloads aggregated and the most common member icon on the bunch.

import (
	"strings"
	"testing"
)

func seedCorpusRepoV52(t *testing.T, m *mockHF) {
	t.Helper()
	tpl := jsonlLine(t, map[string]any{
		"template": "superpowers_brainstorm", "file": "templates/superpowers_brainstorm.json",
		"description": "ideas-into-designs flow", "content": stageJSONForTest,
		"icon": "lightbulb", "collection": "Superpowers Obra!!",
	})
	tpl2 := jsonlLine(t, map[string]any{
		"template": "superpowers_tdd", "file": "templates/superpowers_tdd.json",
		"description": "the TDD iron law", "content": stageJSONForTest,
		"icon": "flask", "collection": "superpowers-obra",
	})
	skills := []string{
		jsonlLine(t, map[string]any{
			"skill": "superpowers-brainstorming", "file": "skills/brainstorming/SKILL.md",
			"description": "before any creative work", "content": "# brainstorming",
			"icon": "zap", "collection": "superpowers-obra",
		}),
		jsonlLine(t, map[string]any{
			"skill": "superpowers-writing-plans", "file": "skills/writing-plans/SKILL.md",
			"description": "plans first", "content": "# writing plans",
			"icon": "zap", "collection": "superpowers-obra",
		}),
		jsonlLine(t, map[string]any{
			"skill": "lonely-skill", "file": "skills/lonely/SKILL.md",
			"description": "no bunch", "content": "# lonely",
		}),
	}
	m.seedRepo("scooby/doomalay-superpowers", []string{"superpowers"}, map[string]string{
		"superpowers_templates.jsonl": tpl + "\n" + tpl2,
		"superpowers_skills.jsonl":    strings.Join(skills, "\n"),
	})
}

func TestScanSurfacesIconAndCollection(t *testing.T) {
	m := newMockHF(t)
	seedCorpusRepoV52(t, m)
	svc := newTestService(t, m)

	items, err := svc.Items("template", "", "recent", "", false)
	if err != nil {
		t.Fatalf("items: %v", err)
	}
	br := findByName(items, "Superpowers Brainstorm")
	if br == nil {
		t.Fatalf("brainstorm template missing: %+v", items)
	}
	if br.Icon != "lightbulb" {
		t.Fatalf("icon not surfaced: %q", br.Icon)
	}
	// "Superpowers Obra!!" sanitizes to the SAME id as "superpowers-obra"
	if br.Collection != "superpowers-obra" {
		t.Fatalf("collection not sanitized/surfaced: %q", br.Collection)
	}
	tdd := findByName(items, "Superpowers TDD")
	if tdd == nil || tdd.Icon != "flask" || tdd.Collection != "superpowers-obra" {
		t.Fatalf("tdd icon/collection wrong: %+v", tdd)
	}

	skills, err := svc.Items("skill", "", "recent", "", false)
	if err != nil {
		t.Fatalf("skills: %v", err)
	}
	z := findByName(skills, "Superpowers Brainstorming")
	if z == nil || z.Icon != "zap" {
		t.Fatalf("skill icon wrong: %+v", z)
	}
	lonely := findByName(skills, "Lonely Skill")
	if lonely == nil || lonely.Collection != "" || lonely.Icon != "" {
		t.Fatalf("unbunched skill should carry no icon/collection: %+v", lonely)
	}
}

func TestCollectionsDerivesBunchesAcrossLibraries(t *testing.T) {
	m := newMockHF(t)
	seedCorpusRepoV52(t, m)
	svc := newTestService(t, m)

	bunches, err := svc.Collections("", false)
	if err != nil {
		t.Fatalf("collections: %v", err)
	}
	if len(bunches) != 1 {
		t.Fatalf("want exactly 1 bunch (superpowers-obra), got %d: %+v", len(bunches), bunches)
	}
	b := bunches[0]
	if b.ID != "superpowers-obra" {
		t.Fatalf("bunch id: %q", b.ID)
	}
	// 2 templates + 2 skills (the lonely skill is unbunched)
	if b.Members != 4 {
		t.Fatalf("members: %d (want 4)", b.Members)
	}
	if b.ByType["template"] != 2 || b.ByType["skill"] != 2 {
		t.Fatalf("byType: %+v", b.ByType)
	}
	// zap is the most common icon (2 skills) over flask/lightbulb (1 each)
	if b.Icon != "zap" {
		t.Fatalf("bunch icon should be the most common member icon: %q", b.Icon)
	}

	// the text filter matches the bunch id…
	hits, _ := svc.Collections("obra", false)
	if len(hits) != 1 {
		t.Fatalf("filter by id: %d", len(hits))
	}
	// …and a member name…
	hits, _ = svc.Collections("writing plans", false)
	if len(hits) != 1 {
		t.Fatalf("filter by member name: %d", len(hits))
	}
	// …but not what isn't there.
	hits, _ = svc.Collections("nonexistent", false)
	if len(hits) != 0 {
		t.Fatalf("filter should miss: %d", len(hits))
	}
}
