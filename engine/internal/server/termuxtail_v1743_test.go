package server

// termuxtail_v1743_test.go — v1.74.3 THE TERMUX TAIL pins: the silent
// data-loss conviction (a >100KB patch read through Termux's bundle cap
// amputated the tail and the write-back DESTROYED it), the live
// truncation detector (the Kotlin bridge's original-length fields, dead
// reflection until now), and the honest grep rendering (the literal
// backslash-n NOTE + the always-1 candidate count).

import (
	"encoding/json"
	"os"
	"strings"
	"testing"

	"github.com/ScoobyBaby1999/doomalay/engine/internal/forge"
	"github.com/ScoobyBaby1999/doomalay/engine/internal/store"
	"github.com/ScoobyBaby1999/doomalay/engine/internal/termuxbridge"
)

// TestV1743_LiveDetector — the bridge client decodes the true sizes and
// the detector fires EXACTLY (the old reflection scanned a field that
// never existed in the struct — dead code since v1.20.1).
func TestV1743_LiveDetector(t *testing.T) {
	payload := `{"ok":true,"stdout":"abc","stderr":"","exit_code":0,"stdout_original_length":150000,"stderr_original_length":0}`
	var res termuxbridge.RunResult
	if err := json.Unmarshal([]byte(payload), &res); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if res.StdoutOriginalLength != 150000 {
		t.Fatalf("the client must decode stdout_original_length: %d", res.StdoutOriginalLength)
	}
	if !termuxTruncated(&res) {
		t.Fatal("an original length above the delivered size IS truncation")
	}
	// the exact detector beats the heuristic: a 2KB stdout with a 150KB
	// original (the old heuristic would call it clean)
	res2 := termuxbridge.RunResult{Stdout: strings.Repeat("x", 2048), StdoutOriginalLength: 150000}
	if !termuxTruncated(&res2) {
		t.Fatal("the live detector must catch what the size heuristic cannot")
	}
	// unknown (-1): the heuristic stays the fallback
	res3 := termuxbridge.RunResult{Stdout: strings.Repeat("x", termuxCapBytes+10), StdoutOriginalLength: -1}
	if !termuxTruncated(&res3) {
		t.Fatal("the heuristic fallback must keep firing")
	}
	// a clean small result with an honest original length
	res4 := termuxbridge.RunResult{Stdout: "ok", StdoutOriginalLength: 2}
	if termuxTruncated(&res4) {
		t.Fatal("a whole result is not truncated")
	}
}

// TestV1743_TailLawSourcePins — the patch verb rides the STREAM path
// and REFUSES on any truncation (the announced size check + the 8MB
// marker); the write-back can never see an amputated buffer.
func TestV1743_TailLawSourcePins(t *testing.T) {
	src, err := os.ReadFile("termuxtool.go")
	if err != nil {
		t.Fatalf("read termuxtool.go: %v", err)
	}
	for _, want := range []string{
		"THE 100KB TAIL LAW",
		"s.termuxRunScriptStream(ctx, sessionID, script", // the stream read
		"a patch NEVER writes a truncated buffer back",
		"want != len(rest)", // the announced-size check
		"output truncated at the engine's 8MB buffer",
	} {
		if !strings.Contains(string(src), want) {
			t.Fatalf("termuxtool.go lost the tail-law piece %q", want)
		}
	}
	// the bundle path is GONE from the patch verb (the read at least)
	if strings.Contains(string(src), "oc, obs := s.termuxRunScript(ctx, script") {
		// the plain bundle wrapper may still serve OTHER verbs; the patch
		// verb itself must not — verified by the stream pin above + the
		// ordering: the stream call appears INSIDE termuxVerbPatch
		vp := string(src)
		start := strings.Index(vp, "func (s *Server) termuxVerbPatch")
		end := strings.Index(vp[start:], "\nfunc ")
		body := vp[start : start+end]
		if strings.Contains(body, "termuxRunScript(ctx, script") {
			t.Fatal("the patch READ must not ride the 100KB bundle path (the write-back's base64 may)")
		}
		if !strings.Contains(body, "termuxRunScriptStream") {
			t.Fatal("the patch verb must read through the stream path")
		}
	}
}

// TestV1743_GrepHonestRendering — the NOTE rides a REAL newline (the
// old literal backslash-n glued onto the last hit), and the candidate
// count is the TRUE count (the old split on the 2-char sequence always
// said 1).
func TestV1743_GrepHonestRendering(t *testing.T) {
	ws := &store.Workspace{Name: "me/oath", Kind: "github"}
	res := &forge.GrepResult{
		Hits: []forge.SearchHit{{Path: "a.go", Line: 1, Snippet: "match"}},
		Remaining: "b.go\nc.go\nd.go",
		Complete:  false,
		Reason:    "hit limit (1) reached — 1 hit(s) found so far; narrow the query (a glob, a path, a tighter pattern) to see the rest",
	}
	out := wsGrepText(ws, forge.SearchOptions{Query: "TODO"}, res)
	if strings.Contains(out, `\nNOTE`) {
		t.Fatalf("the literal backslash-n must be dead:\n%q", out)
	}
	if !strings.Contains(out, "\nNOTE: ") {
		t.Fatalf("the NOTE must start on its own line:\n%q", out)
	}
	if !strings.Contains(out, "3 candidate file(s) remain") {
		t.Fatalf("the TRUE candidate count must ride (the old always-1 count is dead):\n%s", out)
	}
	if !strings.Contains(out, `"resume"`) {
		t.Fatalf("the small-list resume teach must ride:\n%s", out)
	}
	// the large-list arm: the narrowing cure + the next-candidates preview
	var many []string
	for i := 0; i < 40; i++ {
		many = append(many, "pkg/file"+string(rune('a'+i%26))+string(rune('0'+i/26))+".go")
	}
	res2 := &forge.GrepResult{Hits: res.Hits, Remaining: strings.Join(many, "\n"), Complete: false, Reason: res.Reason}
	out2 := wsGrepText(ws, forge.SearchOptions{Query: "TODO"}, res2)
	if !strings.Contains(out2, "40 candidate file(s) remain") {
		t.Fatalf("the true large count:\n%s", out2)
	}
	if !strings.Contains(out2, "narrow the query") {
		t.Fatalf("the narrowing cure must ride:\n%s", out2)
	}
}
