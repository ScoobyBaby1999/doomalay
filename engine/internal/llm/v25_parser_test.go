package llm

import (
	"encoding/json"
	"testing"
)

// ── v0.25 glued-action split ─────────────────────────────────────────────

// TestParseActionsGluedLine: the dock-CSV bug — a model gluing a second
// ACTION into the first action's line. Both must parse as separate,
// CLEAN calls (the first tool must NOT receive the second action's text
// inside its arguments).
func TestParseActionsGluedLine(t *testing.T) {
	in := `ACTION: base64 {"mode": "encode", "text": "Testing base64 encoding!"} ACTION: hash {"algo": "sha256", "text": "Doomalay"}`
	acts := parseActions(in)
	if len(acts) != 2 {
		t.Fatalf("parseActions(glued) = %d acts, want 2: %+v", len(acts), acts)
	}
	if acts[0].Name != "base64" {
		t.Errorf("act[0].Name = %q, want base64", acts[0].Name)
	}
	var a0 map[string]any
	if err := json.Unmarshal([]byte(acts[0].Args), &a0); err != nil {
		t.Fatalf("act[0] args not valid JSON: %v (%q)", err, acts[0].Args)
	}
	if a0["text"] != "Testing base64 encoding!" {
		t.Errorf("act[0] text = %v, want clean 'Testing base64 encoding!'", a0["text"])
	}
	if acts[1].Name != "hash" {
		t.Errorf("act[1].Name = %q, want hash", acts[1].Name)
	}
	var a1 map[string]any
	if err := json.Unmarshal([]byte(acts[1].Args), &a1); err != nil {
		t.Fatalf("act[1] args not valid JSON: %v (%q)", err, acts[1].Args)
	}
	if a1["algo"] != "sha256" || a1["text"] != "Doomalay" {
		t.Errorf("act[1] = %v, want algo=sha256 text=Doomalay", a1)
	}
}

// TestParseActionsMarkerInsideStringNotSplit: an "ACTION:" INSIDE a JSON
// string value must never split.
func TestParseActionsMarkerInsideStringNotSplit(t *testing.T) {
	in := `ACTION: docx_create {"name": "guide.docx", "blocks": [{"type": "paragraph", "text": "Use ACTION: calculator to do math"}]}`
	acts := parseActions(in)
	if len(acts) != 1 {
		t.Fatalf("parseActions = %d acts, want 1 (marker inside string)", len(acts))
	}
	var a0 map[string]any
	if err := json.Unmarshal([]byte(acts[0].Args), &a0); err != nil {
		t.Fatalf("args not valid JSON: %v", err)
	}
	if a0["name"] != "guide.docx" {
		t.Errorf("name = %v, want guide.docx", a0["name"])
	}
}

// TestRepairJSONRawNewlines: zip_create args with literal newlines inside
// string values (dock CSV event 36-37 — "files is required" after repair).
func TestRepairJSONRawNewlines(t *testing.T) {
	in := `{"name": "b.zip", "files": [{"name": "a.txt", "content": "line1
line2
line3"}]}`
	fixed := repairJSON(in)
	var parsed struct {
		Name  string `json:"name"`
		Files []struct {
			Name    string `json:"name"`
			Content string `json:"content"`
		} `json:"files"`
	}
	if err := json.Unmarshal([]byte(fixed), &parsed); err != nil {
		t.Fatalf("repaired JSON still invalid: %v\n%s", err, fixed)
	}
	if len(parsed.Files) != 1 || parsed.Files[0].Content != "line1\nline2\nline3" {
		t.Errorf("files survived wrong: %+v", parsed)
	}
}

// TestParseActionsTruncatedMultilineZip: the exact dock-CSV shape — a huge
// one-line zip_create whose JSON contains a raw newline (model cut it),
// so the line-extension collects and repair must yield VALID args with
// the files list intact.
func TestParseActionsTruncatedMultilineZip(t *testing.T) {
	in := "ACTION: zip_create {\"name\": \"Complex_Bundle_10_Files.zip\", \"files\": [{\"name\": \"data_pipeline.py\", \"content\": \"#!/usr/bin/env python\nimport os\nimport sys\"}"
	acts := parseActions(in)
	if len(acts) != 1 {
		t.Fatalf("parseActions = %d acts, want 1", len(acts))
	}
	if acts[0].Name != "zip_create" {
		t.Fatalf("name = %q, want zip_create", acts[0].Name)
	}
	var parsed struct {
		Name  string `json:"name"`
		Files []struct {
			Name string `json:"name"`
		} `json:"files"`
	}
	if err := json.Unmarshal([]byte(acts[0].Args), &parsed); err != nil {
		t.Fatalf("zip_create args still invalid after repair: %v\nargs: %s", err, acts[0].Args)
	}
	if len(parsed.Files) == 0 {
		t.Fatalf("files LOST — the exact dock-CSV regression. args: %s", acts[0].Args)
	}
	if parsed.Files[0].Name != "data_pipeline.py" {
		t.Errorf("files[0].name = %q, want data_pipeline.py", parsed.Files[0].Name)
	}
}

// TestParseActionsSingleStillWorks: one plain action must not regress.
func TestParseActionsSingleStillWorks(t *testing.T) {
	acts := parseActions("ACTION: calculator {\"expr\": \"2+2*10\"}")
	if len(acts) != 1 || acts[0].Name != "calculator" {
		t.Fatalf("single action broken: %+v", acts)
	}
	var a map[string]any
	if err := json.Unmarshal([]byte(acts[0].Args), &a); err != nil || a["expr"] != "2+2*10" {
		t.Fatalf("single action args broken: %v %v", acts[0].Args, err)
	}
	// parseAction (compat wrapper) returns the LAST call.
	name, _, ok := parseAction("ACTION: uuid {\"count\":1} ACTION: random {\"min\":1,\"max\":9}")
	if !ok || name != "random" {
		t.Errorf("parseAction wrapper = %q %v, want random true", name, ok)
	}
}
