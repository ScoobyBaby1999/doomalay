package server

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/ScoobyBaby1999/doomalay/engine/internal/store"
)

func personaSession(personas string, placeholders string) *store.Session {
	return &store.Session{
		ID:           "s-p1",
		Title:        "Lippy",
		Model:        "nvidia/moonshotai/kimi-k2.6",
		Provider:     "nvidia",
		Persona:      "",
		Personas:     personas,
		Placeholders: placeholders,
	}
}

// v0.26: the multi-persona system — resolution order + placeholder
// substitution (the engine side of the user's spec).
func TestResolveActivePersonaModes(t *testing.T) {
	var specs []PersonaSpec
	if err := json.Unmarshal([]byte(`[
                {"id":"p1","name":"Base","text":"BASE","mode":"always"},
                {"id":"p2","name":"Trig","text":"TRIGGERED","mode":"trigger","trigger":{"key":"turns",">":true,"op":">","value":3}},
                {"id":"p3","name":"Shuf","text":"SHUFFLED","mode":"shuffle"}
        ]`), &specs); err != nil {
		t.Fatalf("parse: %v", err)
	}
	raw, _ := json.Marshal(specs)

	// below the trigger threshold → the always persona
	s := personaSession(string(raw), "")
	if p := resolveActivePersona(s, personaMetrics{Messages: 2, Turns: 2}); p == nil || p.ID != "p1" {
		t.Fatalf("below threshold should pick always, got %+v", p)
	}
	// trigger satisfied → the trigger persona wins
	if p := resolveActivePersona(s, personaMetrics{Messages: 8, Turns: 4}); p == nil || p.ID != "p2" {
		t.Fatalf("satisfied trigger should win, got %+v", p)
	}
	// custom placeholder as the trigger key (numeric value)
	p2t := &PersonaSpec{}
	_ = json.Unmarshal([]byte(`{"id":"p4","name":"Custom","text":"CUSTOM","mode":"trigger","trigger":{"key":"level","op":">","value":5}}`), p2t)
	var list []PersonaSpec
	_ = json.Unmarshal([]byte(raw), &list)
	list = append(list, *p2t)
	raw2, _ := json.Marshal(list)
	s3 := personaSession(string(raw2), `{"level":"9"}`)
	got := resolveActivePersona(s3, personaMetrics{})
	if got == nil || got.ID != "p4" {
		t.Fatalf("custom-key trigger should fire, got %+v", got)
	}
	// non-numeric custom value → trigger can't fire
	s4 := personaSession(string(raw2), `{"level":"high"}`)
	if p := resolveActivePersona(s4, personaMetrics{}); p == nil || p.ID != "p1" {
		t.Fatalf("non-numeric custom key should fall back to always, got %+v", p)
	}
}

func TestLegacySinglePersonaMigration(t *testing.T) {
	s := personaSession("", "")
	s.Persona = "my old persona text"
	specs := parsePersonas(s)
	if len(specs) != 1 || specs[0].Name != "Default" || specs[0].Mode != "always" || specs[0].Text != "my old persona text" {
		t.Fatalf("legacy migration wrong: %+v", specs)
	}
	if p := resolveActivePersona(s, personaMetrics{}); p == nil || p.Text != "my old persona text" {
		t.Fatalf("legacy persona should resolve, got %+v", p)
	}
}

func TestSubstituteAllVars(t *testing.T) {
	s := personaSession("", `{"mood":"playful"}`)
	ph := parsePlaceholders(s)
	out := substituteAllVars("hi {name} / {model} / {provider} / {skills} / {mood} / {unknown}", s.Title, s.Model, s.Provider, ph)
	for _, want := range []string{"hi Lippy", "kimi-k2.6", "NVIDIA", "(no skills attached yet)", "playful", "{unknown}"} {
		if !strings.Contains(out, want) {
			t.Errorf("substitution missing %q in %q", want, out)
		}
	}
}

func TestSystemPromptForUsesActivePersona(t *testing.T) {
	specs := `[{"id":"p1","name":"Pirate","text":"You are {name}, a pirate.","mode":"always"}]`
	srv := &Server{}
	sys := srv.systemPromptForMetrics(personaSession(specs, ""), personaMetrics{Turns: 1})
	if !strings.Contains(sys, "You are Lippy, a pirate.") {
		t.Fatalf("persona with {name} not composed: %q", sys[:120])
	}
	if !strings.Contains(sys, "You are kimi-k2.6") {
		t.Fatalf("identity line missing model: %q", sys[:120])
	}
}

func TestSanitizeArtifactNameDoubleExt(t *testing.T) {
	cases := map[string]string{
		"Hello_Word.docx.doc":            "Hello_Word.docx",
		"report.doc.docx":                "report.doc",
		"data.csv.txt":                   "data.csv",
		"b.tar.gz":                       "b.tar.gz",
		"plain.md":                       "plain.md",
		"a/b\\c.docx.doc":                "a/b/c.docx", // v0.29: paths are KEPT (the file tree nests them)
		"../escape/../../etc/passwd.txt": "escape/etc/passwd.txt",
		"/leading/slash.txt":             "leading/slash.txt",
		"weird.docx.doc.docx":            "weird.docx",
	}
	for in, want := range cases {
		if got := sanitizeArtifactName(in); got != want {
			t.Errorf("sanitizeArtifactName(%q) = %q, want %q", in, got, want)
		}
	}
}
