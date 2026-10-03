package llm

// dsml_v0954_test.go — v0.95.4 THE DSML FILTER pins (the Go side; the JS
// twin is scripts/test_dsml_v0954.js). The live bug (the user's scooby
// export): deepseek-family native tool markup streamed into the VISIBLE
// transcript while the calls inside never executed.

import (
        "encoding/json"
        "strings"
        "testing"
)

func v0954Feed(t *testing.T, f *dsmlFilter, parts ...string) (visible string, calls []nativeCall) {
        t.Helper()
        var sb strings.Builder
        for _, p := range parts {
                sb.WriteString(f.feed(p))
        }
        c, _, vis := f.flush()
        return sb.String() + vis, append(c, f.take()...)
}

// The canonical deepseek shape, split across MANY deltas (the streaming
// reality): markup stripped, call rescued, prose kept.
func TestV0954DSMLSplitAcrossDeltas(t *testing.T) {
        var f dsmlFilter
        visible, calls := v0954Feed(t, &f,
                "Let me compute.",
                "<｜DSML｜calls>\n<｜DSML｜invoke",
                ` name="calculator">`,
                "\n<｜DSML｜parameter name=\"expression\">2+2*10<｜DSML｜/parameter>\n<｜DSML｜/invoke>",
                "\n<｜DSML｜/calls>",
                "\nDone.",
        )
        if visible != "Let me compute.\nDone." {
                t.Fatalf("visible: %q", visible)
        }
        if len(calls) != 1 || calls[0].Name != "calculator" {
                t.Fatalf("calls: %+v", calls)
        }
        var args map[string]string
        if err := json.Unmarshal([]byte(calls[0].Arguments), &args); err != nil {
                t.Fatalf("args not JSON: %v (%s)", err, calls[0].Arguments)
        }
        if args["expression"] != "2+2*10" {
                t.Fatalf("expression arg: %q", args["expression"])
        }
}

// The reinject mode (no tools array — the ReAct consumer): the rescued
// calls ride the visible stream as ACTION lines.
func TestV0954DSMLReinjectAsActionLines(t *testing.T) {
        f := dsmlFilter{reinject: true}
        visible, _ := v0954Feed(t, &f,
                "Working.<｜DSML｜calls><｜DSML｜invoke name=\"hash\"><｜DSML｜parameter name=\"text\">abc<｜DSML｜/parameter><｜DSML｜/invoke><｜DSML｜/calls>ok",
        )
        // (take() may stock the calls too — scanSSECollect only reads it in
        // non-reinject mode; the load-bearing contract is the visible stream.)
        if !strings.Contains(visible, "ACTION: hash ") {
                t.Fatalf("the ACTION line must ride the visible stream: %q", visible)
        }
        if strings.Contains(visible, "DSML") {
                t.Fatalf("markup leaked: %q", visible)
        }
}

// An UNTERMINATED block (the stream cut mid-call): flush salvages what's
// there — the model's intent is visible, not silently lost.
func TestV0954DSMLUnterminatedSalvage(t *testing.T) {
        var f dsmlFilter
        visible, calls := v0954Feed(t, &f,
                "start <｜DSML｜calls><｜DSML｜invoke name=\"file_write\"><｜DSML｜parameter name=\"content\">half a file",
        )
        if len(calls) != 1 || calls[0].Name != "file_write" {
                t.Fatalf("salvaged calls: %+v", calls)
        }
        if strings.Contains(visible, "DSML") {
                t.Fatalf("markup leaked into the salvage: %q", visible)
        }
}

// A PARTIAL opener split across deltas ("<", "<｜", "＜DSML…" tails) never
// renders garbage.
func TestV0954DSMLPartialOpenerHeld(t *testing.T) {
        var f dsmlFilter
        var sb strings.Builder
        sb.WriteString(f.feed("hello <"))
        sb.WriteString(f.feed("｜DSM"))
        sb.WriteString(f.feed("L｜calls>")) // completes the opener → block starts
        if strings.Contains(sb.String(), "DSML") {
                t.Fatalf("partial opener leaked: %q", sb.String())
        }
        // still in-block: everything buffers
        if got := f.feed("invisible"); got != "" {
                t.Fatalf("in-block content must not stream: %q", got)
        }
}

// Clean text passes through unchanged (the hot path — no '<' fast exit).
func TestV0954DSMLCleanPassthrough(t *testing.T) {
        var f dsmlFilter
        if got := f.feed("plain text, no markup at all"); got != "plain text, no markup at all" {
                t.Fatalf("clean passthrough: %q", got)
        }
        if got := f.feed("has <br> html but no dsml"); got != "has <br> html but no dsml" {
                t.Fatalf("non-DSML angle brackets: %q", got)
        }
}

// repairJSONReport — THE HONESTY LINE: in-string truncation (the .MD
// artifact cutoff class) is detectable; brace-only truncation is not.
func TestV0954RepairJSONReport(t *testing.T) {
        if _, cut := repairJSONReport(`{"content": "half a file`); !cut {
                t.Fatalf("in-string truncation must report cut=true")
        }
        if _, cut := repairJSONReport(`{"a": 1, "b": 2`); cut {
                t.Fatalf("brace-only truncation (complete values) must report cut=false")
        }
        if _, cut := repairJSONReport(`{"a": 1}`); cut {
                t.Fatalf("valid JSON must report cut=false")
        }
        // the repaired outputs are still valid JSON in both cases
        fixed, _ := repairJSONReport(`{"content": "half a file`)
        if !json.Valid([]byte(fixed)) {
                t.Fatalf("repaired in-string JSON must be valid: %q", fixed)
        }
        fixed2, _ := repairJSONReport(`{"a": 1, "b": 2`)
        if !json.Valid([]byte(fixed2)) {
                t.Fatalf("repaired brace-only JSON must be valid: %q", fixed2)
        }
}

// The output floor table + the 400 detector.
func TestV0954OutputFloor(t *testing.T) {
        if v, ok := providerMaxTokensFloor("nvidia"); !ok || v < 8192 {
                t.Fatalf("nvidia floor: %d %v", v, ok)
        }
        if v, ok := providerMaxTokensFloor("together"); !ok || v < 8192 {
                t.Fatalf("together floor: %d %v", v, ok)
        }
        if _, ok := providerMaxTokensFloor("openrouter"); ok {
                t.Fatalf("openrouter keeps its server default (no floor)")
        }
        if !mentionsMaxTokens(`{"error": "max_tokens must be <= 4096"}`) {
                t.Fatalf("the 400 detector must catch max_tokens mentions")
        }
        if mentionsMaxTokens(`{"error": "invalid model"}`) {
                t.Fatalf("the 400 detector must not fire on unrelated 400s")
        }
}
