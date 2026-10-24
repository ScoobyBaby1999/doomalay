// toolfault_v1741_test.go — v1.74.1 THE HONEST FAULT LINE pins.
//
// The live conviction (the user's bullet: "the model does a tool call, it
// fails, but executes successfully — and the model goes on as if it hadn't
// just failed"): the old every-line scan false-positived on SUCCESSFUL
// reads/greps/execs whose *content* echoed `error:` lines — the user saw
// "tool hiccup — the call failed" while the model's history carried only
// the success, and the repeat-cache skip re-EXECUTED every identical
// retry (double side effects). THE HEAD-LINE LAW + the structured verdict
// kill both.
package llm

import (
        "context"
        "os"
        "strings"
        "testing"
)

// mustReadSource — the source-pin helper (the discipline: pin the honest
// TEXTS in the tree, path relative to this package's dir).
func mustReadSource(t *testing.T, rel string) string {
        t.Helper()
        b, err := os.ReadFile(rel)
        if err != nil {
                t.Fatalf("read %s: %v", rel, err)
        }
        return string(b)
}

// TestV1741_PhantomFailureDies: a successful read of a log full of
// error: lines is a SUCCESS — no hiccup notice, cacheable, no failure.
func TestV1741_PhantomFailureDies(t *testing.T) {
        logRead := "OBSERVATION:\nTEXT — deploy.log (412 bytes)\n2026-10-24 error: connection refused\n2026-10-24 error: retrying\nerror: gave up after 3 tries\n"
        if rep := DetectToolFault(logRead); rep.Faulted {
                t.Fatalf("a successful read of an error-laden log was flagged: %+v", rep)
        }
        if failedObservation(logRead, false) {
                t.Fatalf("a successful read of an error-laden log classified failed — the cache would skip and every retry would re-execute")
        }
        // the structured truth agrees: IsError=false is a success, whatever
        // the content echoes
        if rep := DetectToolFaultStructured(logRead, false); rep.Faulted {
                t.Fatalf("structured success + error-laden content flagged: %+v", rep)
        }
        // no notice is spoken
        ch := make(chan ChatChunk, 8)
        FlagToolFaultStructured(context.Background(), ch, "termux", logRead, false)
        select {
        case c := <-ch:
                t.Fatalf("a successful read produced a notice: %q", c.Text)
        default:
        }
}

// TestV1741_StructuredFailureWins: the bus's IsError=true forces the
// notice even when the observation text carries no error: head (the
// structured flag is the authoritative verdict).
func TestV1741_StructuredFailureWins(t *testing.T) {
        weirdFailure := "OBSERVATION:\nthe provider answered 429 and the call was abandoned mid-flight"
        rep := DetectToolFaultStructured(weirdFailure, true)
        if !rep.Faulted || rep.Label != "the call failed" {
                t.Fatalf("structured failure not flagged: %+v", rep)
        }
        if !failedObservation(weirdFailure, true) {
                t.Fatalf("structured failure classified success — it would cache and the retry would serve the stale failure")
        }
}

// TestV1741_HeadLineLaw: the error/refusal classes judge ONLY the head.
func TestV1741_HeadLineLaw(t *testing.T) {
        cases := []struct {
                obs     string
                faulted bool
                label   string
        }{
                {"OBSERVATION:\nerror: arguments must be a JSON object", true, "the call failed"},
                {"OBSERVATION:\nsearch error: the query engine timed out", true, "the search call failed"},
                {"OBSERVATION:\nfetch error: no such host", true, "the fetch call failed"},
                {"OBSERVATION:\nREFUSED — the command looks like a file destroy", true, "refused"},
                {"OBSERVATION:\nJAIL REFUSED: /etc is outside the roots", true, "jail"},
                {"OBSERVATION:\nTIMEOUT — the 600s exec budget ended", true, "timed out"},
                // content lines NEVER count
                {"OBSERVATION:\nGREP — \"error:\" in src (3 lines)\n- a.go:12  error: nope\n- b.go:4   error: bad", false, ""},
                {"OBSERVATION:\nTREE — repo\nerror: this is just file content", false, ""},
                // the exec banner head with a nonzero exit is a failure
                {"OBSERVATION:\nEXEC DONE — workdir /x\nexit_code: 1\nstdout:\nok\nstderr:\nboom", true, "nonzero"},
                // a zero exit with grumbling stderr is a SUCCESS
                {"OBSERVATION:\nEXEC DONE — workdir /x\nexit_code: 0\nstdout:\nok\nstderr:\nerror: a warning the tool itself printed", false, ""},
        }
        for _, tc := range cases {
                rep := DetectToolFault(tc.obs)
                if rep.Faulted != tc.faulted {
                        t.Fatalf("DetectToolFault(%q) = %+v, want faulted=%v", tc.obs[:min(50, len(tc.obs))], rep, tc.faulted)
                }
                if tc.faulted && !strings.Contains(rep.Label, tc.label) {
                        t.Fatalf("label = %q, want it to mention %q", rep.Label, tc.label)
                }
        }
}

// TestV1741_TruncationStillSpeaks: the tail-appended truncation markers
// keep reporting (an honest hiccup on a successful call — never "failed").
func TestV1741_TruncationStillSpeaks(t *testing.T) {
        truncated := "OBSERVATION:\nbig listing\n[truncated: first 8192 of 99999 bytes shown]"
        rep := DetectToolFaultStructured(truncated, false)
        if !rep.Faulted || !strings.Contains(rep.Label, "truncated") {
                t.Fatalf("truncation marker not reported on a structured success: %+v", rep)
        }
        // but it is NOT a failure — the call succeeded, a re-run would
        // truncate identically
        if failedObservation(truncated, false) {
                t.Fatalf("a truncated SUCCESS classified failed")
        }
}

// TestV1741_ExitCodeLaw: the exec shape's structured exit_code line.
func TestV1741_ExitCodeLaw(t *testing.T) {
        if !nonzeroExitCode("OBSERVATION:\nEXEC DONE\nexit_code: 2\n") {
                t.Fatalf("exit_code 2 must read as failure")
        }
        if nonzeroExitCode("OBSERVATION:\nEXEC DONE\nexit_code: 0\n") {
                t.Fatalf("exit_code 0 must read as success")
        }
        if nonzeroExitCode("OBSERVATION:\nno exit code here") {
                t.Fatalf("a non-exec observation must not read as failure")
        }
}

// TestV1741_HonestPanicAndCancelTexts: the panic + cancellation texts
// teach the model to re-send the SAME call, never to "rephrase" or
// change strategy (the anti-simplification law), and a cancellation
// says what actually happened.
func TestV1741_HonestPanicAndCancelTexts(t *testing.T) {
        src := mustReadSource(t, "../mcpbus/bus.go")
        for _, want := range []string{
                "re-send the same call (it may have partially run",
                "the turn was cancelled mid-call",
        } {
                if !strings.Contains(src, want) {
                        t.Fatalf("bus.go lost the honest text %q", want)
                }
        }
        wrapSrc := mustReadSource(t, "../mcpbus/jobwrap.go")
        if strings.Contains(wrapSrc, "rephrase or try a different approach") {
                t.Fatalf("jobwrap.go still carries the rephrase text")
        }
        if !strings.Contains(wrapSrc, "re-send the same call") {
                t.Fatalf("jobwrap.go lost the re-send text")
        }
}
