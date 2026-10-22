package llm

// argrepair_v1611_test.go — v1.61.1 THE REPAIR HAND pins (PLAN-V161 §9):
// the EXACT shapes the two live chatlogs convicted, replayed
// byte-for-byte through the repair chain. Every case below is a real
// logged event from doomalay-kenny-6ada2fc9 or doomalay-trippy —
// the tags spelled with \u003c escapes because they are the literal
// ASCII bytes the kenny export hexdump convicted.

import (
	"strings"
	"testing"
)

// The evidenced tag pair, byte-exact (kenny export: 4 occurrences).
const v1611TagCloseKey = "\u003c/arg_key\u003e"
const v1611TagOpenValue = "\u003carg_value\u003e"

// kennyShapeA — the nested args string with the tags INSIDE (kenny
// row: {"args": "{\"action\":\"exec\",\"args" + TAGS + "{\"command\"…).
func kennyShapeA() string {
	inner := `{"action":"exec","args` + v1611TagCloseKey + v1611TagOpenValue + `{"command":"curl -s -o /tmp/or_default.json -w '%{http_code} %{size_download}\n' 'https://openrouter.ai/api/v1/models' && echo 'DEFAULT done'"}`
	return inner
}

// kennyShapeB — the ACTION FIELD carrying the tags (kenny row: the
// call whose result was "unknown termux action \"exec<TAGS>{…\"").
func kennyShapeB() string {
	return "exec" + v1611TagCloseKey + v1611TagOpenValue + `{"command": "python3 -c \"import json; d=json.load(open('/storage/emulated/0/Documents/Doomaway/or_default.json')); print('top-level keys:', list(d.keys()))\""}`
}

// kennyShapeC — the raw-newline + early-close-quote shape (kenny row
// whose result was "invalid character '\n' in string literal" and
// "invalid character 'i' after object key:value pair").
func kennyShapeC() string {
	return "{\"command\": \"python3 -c \"\nimport json\nfor f in ['or_default.json','or_text.json','or_lim400.json']:\n    d = json.load(open('/storage/emulated/0/Documents/Doomaway/'+f))\n    print(f, 'keys=', list(d.keys()))\"}"
}

// kennyShapeD — the double args envelope (the model wrapped the whole
// action object inside the args key).
func kennyShapeD() string {
	return `{"args":"{\"command\": \"python3 -c \\\"import json; d=json.load(open('/storage/emulated/0/Documents/Doomaway/or_default.json')); data=d.get('data',[]); print('Total:', len(data))\\\"\"}"}`
}

func TestV1611_ParseToolArgsTagGrammar(t *testing.T) {
	// kenny's evidenced nested-args shape: "args" + closeKey +
	// openValue + "{command"… → the tags spell ":{" and the parse
	// lands with action exec + command curl ….
	m, notes, ok := ParseToolArgs(kennyShapeA())
	if !ok {
		t.Fatalf("kenny shape A not repaired")
	}
	if got, _ := m["action"].(string); got != "exec" {
		t.Fatalf("action = %q, want exec", got)
	}
	argsRaw, _ := m["args"].(map[string]any)
	if argsRaw == nil {
		t.Fatalf("args object missing after tag repair: %#v", m)
	}
	if got, _ := argsRaw["command"].(string); !strings.Contains(got, "curl -s -o /tmp/or_default.json") {
		t.Fatalf("command = %q, want the curl head", got)
	}
	if len(notes) == 0 || notes[0].Kind != "tags" {
		t.Fatalf("notes = %#v, want the tags rung", notes)
	}
}

func TestV1611_TagsToJSONPair(t *testing.T) {
	in := `{"a":"exec","args` + v1611TagCloseKey + v1611TagOpenValue + `{"command":"x"}`
	want := `{"a":"exec","args":{"command":"x"}`
	if got := TagsToJSON(in); got != want {
		t.Fatalf("TagsToJSON = %q, want %q", got, want)
	}
	// bare-key form: the lenient pass supplies the missing open quote
	in2 := `{action:exec,args` + v1611TagCloseKey + v1611TagOpenValue + `{"command":"x"}`
	got2 := TagsToJSON(in2)
	if !strings.Contains(got2, `args":{`) {
		t.Fatalf("bare-key TagsToJSON = %q, want args\":{ in it", got2)
	}
	// no tags → untouched
	if got3 := TagsToJSON(`{"action":"exec"}`); got3 != `{"action":"exec"}` {
		t.Fatalf("untouched pass-through broken: %q", got3)
	}
}

func TestV1611_SplitTaggedAction(t *testing.T) {
	real, payload, found := SplitTaggedAction(kennyShapeB())
	if !found {
		t.Fatalf("kenny shape B not recognized")
	}
	if real != "exec" {
		t.Fatalf("real action = %q, want exec", real)
	}
	if payload == nil {
		t.Fatalf("payload missing")
	}
	if got, _ := payload["command"].(string); !strings.Contains(got, "python3 -c") {
		t.Fatalf("payload command = %q", got)
	}
	// a clean action passes through untouched
	r2, p2, f2 := SplitTaggedAction("exec")
	if f2 || r2 != "exec" || p2 != nil {
		t.Fatalf("clean action disturbed: %q %#v %v", r2, p2, f2)
	}
}

func TestV1611_RawNewlineEarlyClose(t *testing.T) {
	// kenny's shape C: the command string "closes" at the quote after
	// -c, the script falls outside any string, raw newlines litter the
	// gaps. The quote-reopen rung must make it ONE command value.
	m, notes, ok := ParseToolArgs(kennyShapeC())
	if !ok {
		t.Fatalf("kenny shape C not repaired")
	}
	got, _ := m["command"].(string)
	if !strings.Contains(got, "python3 -c ") || !strings.Contains(got, "import json") {
		t.Fatalf("command = %q, want the whole script", got)
	}
	if strings.Count(got, "\n") < 3 {
		t.Fatalf("the script's newlines must survive as real \\n: %q", got)
	}
	foundQuotes := false
	for _, n := range notes {
		if n.Kind == "quotes" || n.Kind == "closers" {
			foundQuotes = true
		}
	}
	if !foundQuotes {
		t.Fatalf("notes must name the rung: %#v", notes)
	}
}

func TestV1611_DoubleEnvelope(t *testing.T) {
	// kenny's shape D: the whole action object wrapped inside "args".
	m, _, ok := ParseToolArgs(kennyShapeD())
	if !ok {
		t.Fatalf("shape D not parsed")
	}
	peeled, did := UnwrapArgsEnvelope(m, 4)
	if !did {
		t.Fatalf("envelope not peeled: %#v", m)
	}
	got, _ := peeled["command"].(string)
	if !strings.Contains(got, "python3 -c") {
		t.Fatalf("command = %q after peel", got)
	}
}

func TestV1611_TruncationRefused(t *testing.T) {
	// The honesty line: a string cut MID-VALUE never executes.
	cut := `{"command":"python3 -c "import json; d=json.lo`
	if _, _, ok := ParseToolArgs(cut); ok {
		t.Fatalf("mid-string cut must refuse")
	}
	// missing closers (complete values) DO repair
	if m, _, ok := ParseToolArgs(`{"command":"ls -la"`); !ok {
		t.Fatalf("missing closer must repair")
	} else if got, _ := m["command"].(string); got != "ls -la" {
		t.Fatalf("command = %q", got)
	}
}

func TestV1611_RepairNotesLine(t *testing.T) {
	if RepairNotesLine(nil) != "" {
		t.Fatalf("nil notes must render empty")
	}
	line := RepairNotesLine([]RepairNote{{Kind: "tags", Desc: "legacy tag grammar converted to JSON"}})
	if !strings.Contains(line, "auto-repaired") || !strings.Contains(line, "same call shape") {
		t.Fatalf("teach line = %q", line)
	}
}

func TestV1611_BareStringTagValue(t *testing.T) {
	// openValue + bare text + closeVal — the sibling tags a leaky
	// model may emit for a STRING value.
	in := `{"action":"pkg","args` + v1611TagCloseKey + v1611TagOpenValue + `install python` + "\u003c/arg_value\u003e" + `"}`
	got := TagsToJSON(in)
	if !strings.Contains(got, `"args":"install python"`) {
		t.Fatalf("bare string tag value = %q", got)
	}
}
