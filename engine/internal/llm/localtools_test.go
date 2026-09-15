package llm

import (
	"strings"
	"testing"
)

// TestCalcEval exercises the calculator parser (v0.20) — the model trusts
// these results, so the arithmetic must be exactly right.
func TestCalcEval(t *testing.T) {
	cases := []struct {
		expr string
		want string
	}{
		{"2+2*10", "22"},
		{"(2+2)*10", "40"},
		{"2^10", "1024"},
		{"2+3*4-6/2", "11"},
		{"sqrt(144)", "12"},
		{"sqrt(2)^2", "2.0000000000000004"}, // float reality — the model sees this
		{"abs(-5)", "5"},
		{"round(2.5)", "3"},
		{"floor(2.9)", "2"},
		{"ceil(2.1)", "3"},
		{"ln(e)", "1"},
		{"log(1000)", "3"},
		{"pi", "3.141592653589793"},
		{"min(3,1,2)", "1"},
		{"max(3,1,2)", "3"},
		{"10 % 3", "1"},
		{"-4+10", "6"},
		{"--4", "4"},
		{"2^-1", "0.5"},
		{"((1+2)*(3+4))", "21"},
		{"", "error: expr is required"},
		{"2+", "error: unexpected"},
		{"1/0", "error: division by zero"},
		{"bogus(1)", "error: unknown function"},
		{"hello", "error: unknown identifier"},
	}
	for _, c := range cases {
		got := calcEval(c.expr)
		if !strings.HasPrefix(got, c.want) && got != c.want {
			t.Errorf("calcEval(%q) = %q, want prefix %q", c.expr, got, c.want)
		}
	}
}

// TestRunLocalTool checks each local tool's happy path + arg safety.
func TestRunLocalTool(t *testing.T) {
	// calculator via the dispatcher
	if got := RunLocalTool("calculator", `{"expr":"6*7"}`); !strings.Contains(got, "42") {
		t.Errorf("calculator 6*7 = %q", got)
	}
	// uuid
	u := RunLocalTool("uuid", `{"count":2}`)
	if !strings.Contains(u, "\n") {
		t.Errorf("uuid count=2 should return 2 lines: %q", u)
	}
	// base64 round-trip
	enc := RunLocalTool("base64", `{"mode":"encode","text":"doomalay"}`)
	dec := RunLocalTool("base64", `{"mode":"decode","text":"`+strings.TrimSpace(strings.TrimPrefix(enc, "OBSERVATION:\n"))+`"}`)
	if !strings.Contains(dec, "doomalay") {
		t.Errorf("base64 round-trip failed: %q → %q", enc, dec)
	}
	// hash — deterministic, verified value
	if got := RunLocalTool("hash", `{"algo":"sha256","text":"abc"}`); !strings.Contains(got, "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad") {
		t.Errorf("sha256(abc) wrong: %q", got)
	}
	// json
	if got := RunLocalTool("json_tool", `{"mode":"validate","text":"{\"a\":1}"}`); !strings.Contains(got, "valid JSON") {
		t.Errorf("json validate = %q", got)
	}
	// text_stats
	if got := RunLocalTool("text_stats", `{"text":"one two three"}`); !strings.Contains(got, "words: 3") {
		t.Errorf("text_stats = %q", got)
	}
	// url round-trip
	if got := RunLocalTool("url_encode", `{"mode":"encode","text":"a b&c"}`); !strings.Contains(got, "a+b%26c") {
		t.Errorf("url_encode = %q", got)
	}
	// regex
	if got := RunLocalTool("regex_extract", `{"pattern":"\\d+","text":"a1 b22 c333"}`); !strings.Contains(got, "3 matches") {
		t.Errorf("regex_extract = %q", got)
	}
	// random bounds
	r := RunLocalTool("random", `{"min":1,"max":5,"count":10,"unique":true}`)
	if strings.Contains(r, "error") {
		t.Errorf("random = %q", r)
	}
	// time
	if got := RunLocalTool("time_now", `{"tz":"UTC"}`); !strings.Contains(got, "[UTC]") && !strings.Contains(got, "UTC") {
		t.Errorf("time_now = %q", got)
	}
	// bad args → a usable OBSERVATION error, not a panic
	if got := RunLocalTool("calculator", "not json"); !strings.Contains(got, "error") {
		t.Errorf("bad args should error: %q", got)
	}
	if got := RunLocalTool("nope", "{}"); !strings.Contains(got, "unknown local tool") {
		t.Errorf("unknown tool: %q", got)
	}
}

// TestParseActionAnyTool verifies the generalized ACTION regex.
func TestParseActionAnyTool(t *testing.T) {
	for _, c := range []struct {
		in   string
		tool string
		ok   bool
	}{
		{"ACTION: calculator {\"expr\": \"1+1\"}", "calculator", true},
		{"ACTION: web_search {\"query\": \"cats\"}", "web_search", true},
		{"ACTION: time_now {}", "time_now", true},
		{"ACTION: uuid", "uuid", true},
		{"Let me compute.\nACTION: calculator {\"expr\":\"2\"}", "calculator", true},
		{"Just a normal answer.", "", false},
	} {
		action, _, ok := parseAction(c.in)
		if ok != c.ok || (ok && action != c.tool) {
			t.Errorf("parseAction(%q) = (%q,%v), want (%q,%v)", c.in, action, ok, c.tool, c.ok)
		}
	}
}
