package llm

import (
	"encoding/json"
	"testing"
)

// ── v0.28 stupid-proof ACTION parser ─────────────────────────────────────────
//
// The user's spec: "any dumb model can 100% reliably chain all the tools,
// any time." These tests pin every tolerance added in v0.28 — case, spacing,
// missing colons, markdown chrome, Python-flavored JSON, near-miss tool
// names, function-call argument shapes — plus the false-positive guards
// that keep prose from turning into a tool call.

func mustParse(t *testing.T, reply string) parsedAction {
	t.Helper()
	acts := parseActions(reply)
	if len(acts) == 0 {
		t.Fatalf("parseActions(%q) = no actions", reply)
	}
	return acts[len(acts)-1]
}

func assertJSONEq(t *testing.T, got, want string) {
	t.Helper()
	var g, w any
	if err := json.Unmarshal([]byte(got), &g); err != nil {
		t.Fatalf("args %q are not valid JSON: %v", got, err)
	}
	if err := json.Unmarshal([]byte(want), &w); err != nil {
		t.Fatalf("want %q is not valid JSON: %v", want, err)
	}
	gj, _ := json.Marshal(g)
	wj, _ := json.Marshal(w)
	if string(gj) != string(wj) {
		t.Fatalf("args mismatch:\n got %s\nwant %s", gj, wj)
	}
}

func TestParseActionsCaseInsensitive(t *testing.T) {
	a := mustParse(t, "Action: calculator {\"expr\": \"1+1\"}")
	if a.Name != "calculator" {
		t.Fatalf("name = %q, want calculator", a.Name)
	}
	a = mustParse(t, "action: time_now {\"tz\": \"UTC\"}")
	if a.Name != "time_now" {
		t.Fatalf("name = %q, want time_now", a.Name)
	}
}

func TestParseActionsSpaceBeforeColon(t *testing.T) {
	a := mustParse(t, "ACTION : time_now {\"tz\": \"Asia/Tokyo\"}")
	if a.Name != "time_now" {
		t.Fatalf("name = %q, want time_now", a.Name)
	}
	assertJSONEq(t, a.Args, `{"tz": "Asia/Tokyo"}`)
}

func TestParseActionsMissingColon(t *testing.T) {
	a := mustParse(t, "ACTION time_now {\"tz\": \"UTC\"}")
	if a.Name != "time_now" {
		t.Fatalf("name = %q, want time_now", a.Name)
	}
}

func TestParseActionsMarkdownBold(t *testing.T) {
	// colon inside the bold
	a := mustParse(t, "**ACTION:** calculator {\"expr\": \"2+2\"}")
	if a.Name != "calculator" {
		t.Fatalf("bold-colon: name = %q, want calculator", a.Name)
	}
	assertJSONEq(t, a.Args, `{"expr": "2+2"}`)
	// bold around the whole call
	a = mustParse(t, "**ACTION: calculator** {\"expr\": \"3+3\"}")
	if a.Name != "calculator" {
		t.Fatalf("bold-name: name = %q, want calculator", a.Name)
	}
	assertJSONEq(t, a.Args, `{"expr": "3+3"}`)
}

func TestParseActionsBackticks(t *testing.T) {
	a := mustParse(t, "Here's how: `ACTION: time_now {\"tz\": \"UTC\"}`")
	if a.Name != "time_now" {
		t.Fatalf("name = %q, want time_now", a.Name)
	}
}

func TestParseActionsQuoteAndBulletPrefixes(t *testing.T) {
	a := mustParse(t, "> ACTION: time_now {\"tz\": \"UTC\"}")
	if a.Name != "time_now" {
		t.Fatalf("quote-prefix: name = %q", a.Name)
	}
	a = mustParse(t, "- ACTION: time_now {\"tz\": \"UTC\"}")
	if a.Name != "time_now" {
		t.Fatalf("bullet-prefix: name = %q", a.Name)
	}
}

func TestParseActionsActionsProseGuard(t *testing.T) {
	// "ACTIONS: 1) search 2) fetch" (a plan header) must NOT parse as a call.
	if acts := parseActions("ACTIONS: 1) search the web 2) fetch the repo"); len(acts) != 0 {
		t.Fatalf("ACTIONS prose parsed as a call: %+v", acts)
	}
	// "actionable", "action:" mid-prose at line start of a sentence fragment
	if acts := parseActions("Actions speak louder than words."); len(acts) != 0 {
		t.Fatalf("prose parsed as a call: %+v", acts)
	}
}

func TestParseActionsSingleQuotedJSON(t *testing.T) {
	a := mustParse(t, "ACTION: calculator {'expr': '2+2'}")
	if a.Name != "calculator" {
		t.Fatalf("name = %q", a.Name)
	}
	assertJSONEq(t, a.Args, `{"expr": "2+2"}`)
}

func TestParseActionsTrailingComma(t *testing.T) {
	a := mustParse(t, "ACTION: calculator {\"expr\": \"2+2\",}")
	assertJSONEq(t, a.Args, `{"expr": "2+2"}`)
	a = mustParse(t, "ACTION: zip_create {\"name\": \"b.zip\", \"files\": [{\"name\": \"a.txt\", \"content\": \"x\"},],}")
	assertJSONEq(t, a.Args, `{"name": "b.zip", "files": [{"name": "a.txt", "content": "x"}]}`)
}

func TestParseActionsSmartQuotes(t *testing.T) {
	a := mustParse(t, "ACTION: web_search {“query”: “best cat food”}")
	if a.Name != "web_search" {
		t.Fatalf("name = %q", a.Name)
	}
	assertJSONEq(t, a.Args, `{"query": "best cat food"}`)
}

func TestParseActionsBareKeys(t *testing.T) {
	a := mustParse(t, "ACTION: docx_create {name: \"report.docx\", blocks: []}")
	if a.Name != "docx_create" {
		t.Fatalf("name = %q", a.Name)
	}
	assertJSONEq(t, a.Args, `{"name": "report.docx", "blocks": []}`)
}

func TestParseActionsParenWrappedArgs(t *testing.T) {
	// function-call shape: calculator("2+2")
	a := mustParse(t, "ACTION: calculator (\"2*21\")")
	if a.Name != "calculator" {
		t.Fatalf("name = %q", a.Name)
	}
	assertJSONEq(t, a.Args, `{"expr": "2*21"}`)
}

func TestParseActionsSingleQuoteBareArg(t *testing.T) {
	a := mustParse(t, "ACTION: time_now 'Asia/Tokyo'")
	if a.Name != "time_now" {
		t.Fatalf("name = %q", a.Name)
	}
	assertJSONEq(t, a.Args, `{"tz": "Asia/Tokyo"}`)
}

// ── fuzzy tool names ────────────────────────────────────────────────────────

func TestCanonicalToolNameFuzzy(t *testing.T) {
	cases := map[string]string{
		"web_serch":   "web_search",
		"web_searchh": "web_search",
		"times_now":   "time_now",
		"docx_creat":  "docx_create",
		"xlsxcreate":  "xlsx_create",
		"random_uuid": "uuid", // generate_uuid alias
		"word":        "docx_create",
		"excel":       "xlsx_create",
		"my_personas": "persona_list",
		"who_am_i":    "persona_list",
		"become":      "persona_activate",
	}
	for in, want := range cases {
		if got := canonicalToolName(in); got != want {
			t.Errorf("canonicalToolName(%q) = %q, want %q", in, got, want)
		}
	}
	// something that is NOT a near-miss stays itself (no false snap)
	if got := canonicalToolName("sing_a_song"); got != "sing_a_song" {
		t.Errorf("distant name snapped to %q", got)
	}
}

// ── nudge detectors ─────────────────────────────────────────────────────────

func TestLooksLikeCapabilityDenial(t *testing.T) {
	yes := []string{
		"I'm sorry, but I don't have access to the internet.",
		"Unfortunately I can't browse the web, so I can't verify that.",
		"As an AI language model, I cannot access external URLs.",
		"My knowledge cutoff means I can't check the current time.",
	}
	for _, s := range yes {
		if !looksLikeCapabilityDenial(s) {
			t.Errorf("expected denial for %q", s)
		}
	}
	no := []string{
		"The repository is private — web_fetch returned 404 metadata confirming it exists but is not public. You would need to authenticate.",
		strings_Repeat("long answer ", 200),
	}
	for _, s := range no {
		if looksLikeCapabilityDenial(s) {
			t.Errorf("false denial for %.40q…", s)
		}
	}
}

func TestLooksLikeIntentOnlySearchFlavors(t *testing.T) {
	if !looksLikeIntentOnly("Let me search for that repo.") {
		t.Error("expected intent for 'Let me search'")
	}
	if !looksLikeIntentOnly("I'll fetch the README now.") {
		t.Error("expected intent for \"I'll fetch\"")
	}
}

// strings_Repeat avoids importing strings just for one test helper.
func strings_Repeat(s string, n int) string {
	out := ""
	for i := 0; i < n; i++ {
		out += s
	}
	return out
}

// ── lenientJSON unit behavior ──────────────────────────────────────────────

func TestLenientJSON(t *testing.T) {
	cases := []struct{ in, want string }{
		{"{'a': 'x'}", `{"a": "x"}`},
		{`{"a": 1,}`, `{"a": 1}`},
		{`{a: "x"}`, `{"a": "x"}`},
		{`{"name": "it's fine"}`, `{"name": "it's fine"` + `}`},
	}
	for _, c := range cases {
		if got := lenientJSON(c.in); !json.Valid([]byte(got)) {
			t.Errorf("lenientJSON(%q) = %q — not valid JSON", c.in, got)
		}
	}
}

// v0.38 phantom-action filter: the required-arg guard.
func TestActionHasRequiredArg(t *testing.T) {
	cases := []struct {
		name, args string
		want       bool
	}{
		{"web_search", `{"query":"latest news"}`, true},
		{"web_search", `{}`, false},                     // the phantom recap
		{"web_search", `{"query":"  "}`, false},         // whitespace-only
		{"search", ``, false},                           // alias + empty args (rest defaulted "{}")
		{"web_fetch", `{"url":"https://x.dev"}`, true},  //
		{"web_fetch", `{"url":""}`, false},              //
		{"calculator", `{"expr":"2+2"}`, true},          //
		{"calculator", `{}`, false},                    //
		{"time_now", `{}`, true},                        // no required arg
		{"uuid", ``, true},                              //
		{"unknown_tool", `{"x":1}`, true},               // unknown → let the tool speak
	}
	for _, c := range cases {
		args := c.args
		if args == "" {
			args = "{}"
		}
		if got := actionHasRequiredArg(c.name, args); got != c.want {
			t.Errorf("actionHasRequiredArg(%q, %q) = %v, want %v", c.name, args, got, c.want)
		}
	}
}
