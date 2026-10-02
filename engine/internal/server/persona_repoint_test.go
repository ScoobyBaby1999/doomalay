package server

import (
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/ScoobyBaby1999/doomalay/engine/internal/store"
)

// TestPersonaRePointOnSandboxSwitch — v0.93.6: switching the sandbox method
// mid-chat re-points UNEDITED personas (empty or verbatim-default text) to
// the new mode's default; edited personas never move (the user's spec:
// "未编辑过的 persona 应自动切换为新默认").
func TestPersonaRePointOnSandboxSwitch(t *testing.T) {
	edited := "## Identity\nYou are MY OWN custom persona with unique text."
	// three personas: an empty follower, a frozen verbatim quick default
	// (the bug: saved from the prefilled editor untouched), and edited.
	list := []map[string]any{
		{"id": "p1", "name": "Empty", "text": "", "mode": "always"},
		{"id": "p2", "name": "FrozenDefault", "text": defaultPersonaQuick, "mode": "inactive"},
		{"id": "p3", "name": "Edited", "text": edited, "mode": "shuffle"},
	}
	raw, _ := json.Marshal(list)

	sess := &store.Session{ID: "s1", Sandbox: "quick", Personas: string(raw)}

	// quick → hf: the frozen default re-points (text clears to ""), the
	// empty one stays empty, the edited one NEVER moves.
	rePointUneditedPersonas(sess, "quick", "hf")

	var out []map[string]any
	if err := json.Unmarshal([]byte(sess.Personas), &out); err != nil {
		t.Fatalf("re-point left invalid JSON: %v", err)
	}
	byID := map[string]string{}
	for _, p := range out {
		byID[p["id"].(string)], _ = p["text"].(string)
	}
	if byID["p1"] != "" {
		t.Errorf("empty follower must stay empty, got %q", byID["p1"])
	}
	if byID["p2"] != "" {
		t.Errorf("the frozen verbatim default must clear to '' (follow the new mode), got %d chars", len(byID["p2"]))
	}
	if byID["p3"] != edited {
		t.Errorf("edited persona must NEVER move, got %q", byID["p3"])
	}

	// the HF default is caught too (switching hf → quick with a frozen HF
	// template stored)
	list2 := []map[string]any{
		{"id": "q1", "name": "FrozenHF", "text": defaultPersonaHF, "mode": "always"},
	}
	raw2, _ := json.Marshal(list2)
	sess2 := &store.Session{ID: "s2", Sandbox: "hf", Personas: string(raw2)}
	rePointUneditedPersonas(sess2, "hf", "quick")
	var out2 []map[string]any
	_ = json.Unmarshal([]byte(sess2.Personas), &out2)
	if txt, _ := out2[0]["text"].(string); strings.TrimSpace(txt) != "" {
		t.Errorf("frozen HF default must clear on switch to quick, got %d chars", len(txt))
	}

	// no sandbox CHANGE → nothing happens (the re-point only fires on a
	// real mode switch)
	list3 := []map[string]any{
		{"id": "r1", "name": "Frozen", "text": defaultPersonaQuick, "mode": "always"},
	}
	raw3, _ := json.Marshal(list3)
	sess3 := &store.Session{ID: "s3", Sandbox: "quick", Personas: string(raw3)}
	rePointUneditedPersonas(sess3, "quick", "quick") // same mode — a no-op call
	var out3 []map[string]any
	_ = json.Unmarshal([]byte(sess3.Personas), &out3)
	if txt, _ := out3[0]["text"].(string); txt != defaultPersonaQuick {
		t.Errorf("same-mode call must not touch the text (the PATCH handler gates on real change anyway)")
	}

	// empty/legacy personas column → safe no-op
	sess4 := &store.Session{ID: "s4", Sandbox: "quick", Personas: ""}
	rePointUneditedPersonas(sess4, "quick", "hf") // must not panic
	sess5 := &store.Session{ID: "s5", Sandbox: "quick", Personas: "not json"}
	rePointUneditedPersonas(sess5, "quick", "hf") // must not panic
}

// TestWebPersonaTemplateExtraction — the engine must recognize the WEB
// templates too (what the ↺ pill loads and the user actually saves — they
// diverge from the engine consts today: the web quick template carries the
// Library section inline). The extractor parses the embedded persona.js.
func TestWebPersonaTemplateExtraction(t *testing.T) {
        wq, wh := webPersonaTemplates()
        if wq == "" || wh == "" {
                t.Fatalf("extraction failed: quick=%d chars hf=%d chars", len(wq), len(wh))
        }
        // the known content markers
       	if !strings.Contains(wq, "## Library") || !strings.Contains(wq, "## Artifacts") {
                t.Errorf("web quick template must carry the Library + Artifacts sections")
        }
        if !strings.Contains(wh, "HARNESS.md") || !strings.Contains(wh, "{repo}") {
                t.Errorf("web HF template must carry the HARNESS pointer + {repo} placeholder")
        }
        // escape decoding worked (no literal \n two-char sequences left)
        if strings.Contains(wq, `\n`) || strings.Contains(wh, `\n`) {
                t.Errorf("escapes must decode to real newlines")
        }

        // THE FROZEN WEB DEFAULT — a persona saved verbatim from the
        // prefilled editor (web template) re-points on a sandbox switch.
        list := []map[string]any{
                {"id": "w1", "name": "FrozenWebQuick", "text": wq, "mode": "always"},
        }
        raw, _ := json.Marshal(list)
        sess := &store.Session{ID: "w", Sandbox: "quick", Personas: string(raw)}
        rePointUneditedPersonas(sess, "quick", "hf")
        var out []map[string]any
        if err := json.Unmarshal([]byte(sess.Personas), &out); err != nil {
                t.Fatalf("re-point left invalid JSON: %v", err)
        }
        if txt, _ := out[0]["text"].(string); strings.TrimSpace(txt) != "" {
                t.Errorf("the frozen WEB default must clear on switch (it is as unedited as the engine one)")
        }
}

// TestSessionPatchRePointsPersona — the END-TO-END wiring: a real PATCH
// /api/sessions/{id} with {"sandbox":"hf"} flips a quick chat's frozen
// verbatim default to the follow-the-mode state (empty text), while an
// edited persona rides through untouched.
func TestSessionPatchRePointsPersona(t *testing.T) {
	dir := t.TempDir()
	db, err := store.Open(dir)
	if err != nil {
		t.Fatalf("store: %v", err)
	}
	if err := db.Migrate(); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	edited := "## Identity\nA fully custom persona — edited, mine."
	wq, _ := webPersonaTemplates()
	if wq == "" {
		t.Skip("web template extraction unavailable")
	}
	raw, _ := json.Marshal([]map[string]any{
		{"id": "a", "name": "FrozenDefault", "text": wq, "mode": "always"},
		{"id": "b", "name": "Edited", "text": edited, "mode": "shuffle"},
	})
	sess := &store.Session{ID: "sp1", Title: "t", Sandbox: "quick", Personas: string(raw)}
	if err := db.CreateSession(sess); err != nil {
		t.Fatalf("create: %v", err)
	}

	s := &Server{db: db}
	// PATCH sandbox quick → hf through the real handler
	body := strings.NewReader(`{"sandbox":"hf"}`)
	r := httptest.NewRequest("PATCH", "/api/sessions/sp1", body)
	r.SetPathValue("id", "sp1")
	w := httptest.NewRecorder()
	s.handleSessionsUpdate(w, r)
	if w.Code != 200 {
		t.Fatalf("PATCH failed: %d %s", w.Code, w.Body.String())
	}

	got, err := db.GetSession("sp1")
	if err != nil {
		t.Fatalf("reload: %v", err)
	}
	if got.Sandbox != "hf" {
		t.Fatalf("sandbox must persist, got %q", got.Sandbox)
	}
	var out []map[string]any
	if err := json.Unmarshal([]byte(got.Personas), &out); err != nil {
		t.Fatalf("personas JSON broke: %v", err)
	}
	byID := map[string]string{}
	for _, p := range out {
		byID[p["id"].(string)], _ = p["text"].(string)
	}
	if strings.TrimSpace(byID["a"]) != "" {
		t.Errorf("the frozen default must re-point (empty) on the switch — got %d chars", len(byID["a"]))
	}
	if byID["b"] != edited {
		t.Errorf("the edited persona must ride through untouched — got %q", byID["b"])
	}
}
