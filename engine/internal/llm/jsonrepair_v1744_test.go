package llm

// jsonrepair_v1744_test.go — v1.74.4 THE DEEP PARSE pins: the jsonrepair
// subset (the ISC algorithm's high-value rungs) as the argrepair
// ladder's deepest repair, plus the web tools' loud teach texts.

import (
	"encoding/json"
	"os"
	"strings"
	"testing"
)

// TestV1744_JsonRepairDeepTable — every repair shape in, valid JSON out.
func TestV1744_JsonRepairDeepTable(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want string // the canonical re-marshal of the repaired doc
	}{
		{"unquoted key", `{command: "python -V"}`, `{"command":"python -V"}`},
		{"unquoted key + bare value", `{op: install, count: 3}`, `{"count":3,"op":"install"}`},
		{"python literals", `{mode: None, flag: True, other: False}`, `{"flag":true,"mode":null,"other":false}`},
		{"trailing comma", `{"a": 1, "b": [1, 2, 3,],}`, `{"a":1,"b":[1,2,3]}`},
		{"line comment", "{\n  // the command to run\n  \"command\": \"ls\"\n}", `{"command":"ls"}`},
		{"block comment", `{ /* cache */ "a": 1 }`, `{"a":1}`},
		{"json fence", "```json\n{\"a\": 1}\n```", `{"a":1}`},
		{"single quotes", `{'command': 'python -V'}`, `{"command":"python -V"}`},
		{"string concat", `{"path": "src/" + "main.go"}`, `{"path":"src/main.go"}`},
		{"missing colon", `{command "python -V"}`, `{"command":"python -V"}`},
		{"missing closers", `{"a": {"b": [1, 2`, `{"a":{"b":[1,2]}}`},
		{"NaN", `{"x": NaN}`, `{"x":null}`},
	}
	for _, tc := range cases {
		got, cut := jsonRepairDeep(tc.in)
		if cut {
			t.Fatalf("%s: repaired as cut?? %q", tc.name, got)
		}
		var m map[string]any
		if err := json.Unmarshal([]byte(got), &m); err != nil {
			t.Fatalf("%s: still invalid after the deep repair: %v\nin:  %s\ngot: %s", tc.name, err, tc.in, got)
		}
		b, _ := json.Marshal(m)
		if string(b) != tc.want {
			t.Fatalf("%s:\n got %s\nwant %s", tc.name, b, tc.want)
		}
	}
}

// TestV1744_CutVerdictSurvives — a document ending mid-string is the
// CUT verdict: the LADDER refuses it before the deep rung ever runs
// (RepairJSONQuotes' stillIn gate). The deep rung never invents tail
// content — the honesty line: never execute half a command.
func TestV1744_CutVerdictSurvives(t *testing.T) {
	// the whole ladder's law: a genuinely cut call is refused
	if _, _, ok := ParseToolArgs(`{"command": "python3 -c "pri`); ok {
		t.Fatal("the ladder must refuse the cut call")
	}
	// a document that ends UNAMBIGUOUSLY mid-string (no trailing content
	// the repairer could misread as structure) is the deep rung's own cut
	if _, cut := jsonRepairDeep(`{"command": "python3 -c pri`); !cut {
		t.Fatal("an unterminated string must stay the cut verdict")
	}
}

// TestV1744_DeepRungLands — the shapes the earlier rungs could not fix
// now parse through ParseToolArgs with the jsonrepair note.
func TestV1744_DeepRungLands(t *testing.T) {
	m, notes, ok := ParseToolArgs(`{command: "python -V" // the version check
}`)
	if !ok {
		t.Fatal("the unquoted-key + comment shape must land through the ladder")
	}
	if m["command"] != "python -V" {
		t.Fatalf("command = %v", m["command"])
	}
	found := false
	for _, n := range notes {
		if n.Kind == "jsonrepair" {
			found = true
		}
	}
	if !found {
		t.Fatalf("the jsonrepair note must ride: %+v", notes)
	}
	// the Python-literal shape (a model thinking in python — the user's
	// own observation: 'go doesn't help us here as it is weird and
	// unfamiliar to python')
	m2, _, ok2 := ParseToolArgs(`{action: "exec", args: {command: "ls", force: True, retries: None}}`)
	if !ok2 {
		t.Fatal("the python-literals shape must land")
	}
	args, _ := m2["args"].(map[string]any)
	if args == nil || args["force"] != true || args["retries"] != nil {
		t.Fatalf("the python literals must map: %+v", m2)
	}
}

// TestV1744_WebTeachTexts — the loud-requirement law reaches the web
// family: the empty-arg errors teach the call shape (source pin).
func TestV1744_WebTeachTexts(t *testing.T) {
	src, err := readSource1744("../mcpbus/handlers.go")
	if err != nil {
		t.Fatalf("read handlers.go: %v", err)
	}
	for _, want := range []string{
		`web_search needs {"query":"the search text"}`,
		`web_fetch needs {"url":"https://the.page/path"}`,
	} {
		if !strings.Contains(src, want) {
			t.Fatalf("the web teach text lost %q", want)
		}
	}
	if strings.Contains(src, `"error: empty query"`) || strings.Contains(src, `"error: empty url"`) {
		t.Fatalf("the bare empty-query/url errors must be dead")
	}
}

func readSource1744(rel string) (string, error) {
	b, err := os.ReadFile(rel)
	if err != nil {
		return "", err
	}
	return string(b), nil
}
