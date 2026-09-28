package llm

import (
	"strings"
	"testing"
)

// TestPMNativeLadder v0.69 — PrivateMode's DEPLOYED validator speaks the
// standard effort ladder ('none','minimal','low','medium','high'); the
// OpenRouter registry's glm-5.3 vocabulary (low/high/max, default max)
// must be filtered to it and the default snapped, so the wire NEVER sees
// a value the deployed API rejects (the user's live 400:
// "Input should be 'none', 'minima…" on reasoning_effort).
func TestPMNativeLadder(t *testing.T) {
	for _, model := range []string{"glm-5.3", "glm-5.3-flash", "glm-latest", "glm-5.2"} {
		spec := ResolveEffort("privatemodeai", model)
		if len(spec.Levels) == 0 {
			t.Fatalf("%s: no levels resolved", model)
		}
		native := providerNativeLevels["privatemodeai"]
		for _, lv := range spec.Levels {
			if !native[lv] {
				t.Errorf("%s: advertised level %q is not in PM's native ladder %v", model, lv, native)
			}
		}
		if spec.Default == "" || !hasString(spec.Levels, spec.Default) {
			t.Errorf("%s: default %q not on the advertised ladder %v", model, spec.Default, spec.Levels)
		}
		if hasString(spec.Levels, "max") || spec.Default == "max" {
			t.Errorf("%s: 'max' survived the PM native filter (levels=%v default=%q)", model, spec.Levels, spec.Default)
		}
	}
	// the wire: every sendable level lands inside the deployed enum
	for _, model := range []string{"glm-5.3", "glm-latest"} {
		for _, lv := range []string{"low", "medium", "high", "max", "on", "none", "minimal"} {
			body := BuildEffortBodyFor("privatemodeai", model, lv)
			if body == nil {
				continue // mandatory reasoner: off/none send nothing
			}
			re, ok := body["reasoning_effort"].(string)
			if !ok {
				t.Errorf("%s/%s: expected reasoning_effort fragment, got %v", model, lv, body)
				continue
			}
			if !providerNativeLevels["privatemodeai"][re] {
				t.Errorf("%s/%s: sent reasoning_effort=%q — outside PM's deployed enum", model, lv, re)
			}
		}
	}
	// gpt-oss on PM keeps its documented low/medium/high (the filter only
	// removes, never adds) and stays reasoning_effort-shaped
	spec := ResolveEffort("privatemodeai", "gpt-oss-120b")
	if spec.Param != "reasoning_effort" && spec.Param != "" {
		t.Errorf("gpt-oss param = %q, want reasoning_effort (or none)", spec.Param)
	}
	for _, lv := range spec.Levels {
		if !providerNativeLevels["privatemodeai"][lv] {
			t.Errorf("gpt-oss advertised %q — outside the PM native set", lv)
		}
	}
	// other providers untouched by the PM filter
	if _, filtered := providerNativeLevels["openrouter"]; filtered {
		t.Error("openrouter must never be native-filtered")
	}
}

// TestMentionsEffortParamPydantic v0.69 — the exact 400 body from the
// user's report must trip the effort-param rescue (retry-without + the
// engine-lifetime blacklist), and non-effort validation errors must not.
func TestMentionsEffortParamPydantic(t *testing.T) {
	live := `{"error":{"message":"1 validation error:\n {'type': 'literal_error', 'loc': ('body', 'reasoning_effort'), 'msg': \"Input should be 'none', 'minimal', 'low', 'medium', 'high'\"}"}}`
	if !mentionsEffortParam(live) {
		t.Fatal("the live PM glm-5.3 literal_error body must trip the effort-param rescue")
	}
	cases := map[string]bool{
		// effort-shaped rejections (existing + Pydantic)
		`Input should be 'none'`: true, // names effort? no — needs a reasoning keyword; see below
		`{'loc': ('body', 'reasoning_effort'), 'msg': 'Input should be ...'}`: true,
		`reasoning_effort is not supported by this model`:                     true,
		`chat_template_kwargs: unexpected field`:                              true,
		`Unrecognized request argument: thinking`:                             true,
		// non-effort bodies must NOT trip
		`invalid model id: foo/bar`:     false,
		`authentication error: bad key`: false,
		`quota exceeded`:                false,
		`{'loc': ('body', 'max_tokens'), 'msg': 'Input should be <= 4096'}`: false,
	}
	for body, want := range cases {
		// the bare "Input should be 'none'" case has no reasoning keyword —
		// the guard requires one; align the expectation with the contract.
		got := mentionsEffortParam(body)
		if !strings.Contains(strings.ToLower(body), "reason") &&
			!strings.Contains(strings.ToLower(body), "effort") &&
			!strings.Contains(strings.ToLower(body), "thinking") &&
			!strings.Contains(strings.ToLower(body), "chat_template") {
			want = false
		}
		if got != want {
			t.Errorf("mentionsEffortParam(%q) = %v, want %v", body, got, want)
		}
	}
}
