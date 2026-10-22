package server

// repairhand_v1611_test.go — v1.61.1 THE REPAIR HAND pins (PLAN-V161
// §9): the server-side proof that the kenny + trippy logged failure
// shapes now EXECUTE (the Unfumble Law — the model never learns it
// failed) and that the residuals speak the fix plus the
// anti-simplification order.
//
// Every shape below is the byte-exact class convicted from the two
// live chat exports; the OUTER wire layer is built with json.Marshal
// (the engine's own marshaling law) so the nested-value bytes are
// exactly what the model's fumble produced.

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/ScoobyBaby1999/doomalay/engine/internal/llm"
)

// v1611Tags — the evidenced pair, byte-exact (kenny export: 4×).
const v1611TagA = "\u003c/arg_key\u003e"  // close-arg-key (byte-exact from the kenny export)
const v1611TagB = "\u003carg_value\u003e" // open-arg-value

// wire builds the outer tool-call JSON from a map (the engine's own
// marshaling — the nested string's bytes are the model's fumble).
func wire(t *testing.T, m map[string]any) string {
	t.Helper()
	b, err := json.Marshal(m)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	return string(b)
}

// ── kenny's termux shapes, replayed byte-exact through the runner ─────────

// TestV1611_KennyTagShapeExecutes — kenny's worst logged fumble: the
// tag grammar glued INSIDE the nested args string (the logged "unknown
// termux action" + parse deaths). The call must EXECUTE and the
// observation must carry the honest teach head.
func TestV1611_KennyTagShapeExecutes(t *testing.T) {
	fb := newFakeArmBridge(t)
	s := newArmServer(t, fb)
	root := t.TempDir()
	armTermuxChat(t, s, "kenny1", root)

	nested := `{"action":"exec","args` + v1611TagA + v1611TagB + `{"command":"echo repaired-tag-shape"}`
	argJSON := wire(t, map[string]any{"args": nested})
	out := s.runTermuxAction(context.Background(), "kenny1", argJSON)
	if !strings.Contains(out, "repaired-tag-shape") {
		t.Fatalf("the tagged call did NOT execute:\n%s", out)
	}
	if !strings.Contains(out, "arguments auto-repaired") {
		t.Fatalf("the teach head is missing:\n%s", out)
	}
}

// TestV1611_KennyRawNewlineShapeExecutes — kenny's early-close quote +
// raw-newline shape (the logged "invalid character '\n' in string
// literal" + "invalid character 'i' after object key:value pair"
// deaths): the whole python script rides as ONE command value.
func TestV1611_KennyRawNewlineShapeExecutes(t *testing.T) {
	fb := newFakeArmBridge(t)
	s := newArmServer(t, fb)
	root := t.TempDir()
	armTermuxChat(t, s, "kenny2", root)

	// the model's bytes: the command string "closed" at the quote after
	// -c and the script fell out with raw newlines around it
	nested := "{\"command\": \"python3 -c \"\nimport json\nprint('repaired-newline-shape')\n\"}"
	argJSON := wire(t, map[string]any{"action": "exec", "args": nested})
	out := s.runTermuxAction(context.Background(), "kenny2", argJSON)
	if !strings.Contains(out, "repaired-newline-shape") {
		t.Fatalf("the raw-newline call did NOT execute:\n%s", out)
	}
	if !strings.Contains(out, "arguments auto-repaired") {
		t.Fatalf("the teach head is missing:\n%s", out)
	}
}

// TestV1611_KennyEnvelopeShapeExecutes — the double args envelope
// ({"args":"{\"command\": …}"} with NO action key — kenny's row-48
// class): peeled + the command infers exec + executed.
func TestV1611_KennyEnvelopeShapeExecutes(t *testing.T) {
	fb := newFakeArmBridge(t)
	s := newArmServer(t, fb)
	root := t.TempDir()
	armTermuxChat(t, s, "kenny3", root)

	argJSON := wire(t, map[string]any{"args": `{"command": "echo repaired-envelope-shape"}`})
	out := s.runTermuxAction(context.Background(), "kenny3", argJSON)
	if !strings.Contains(out, "repaired-envelope-shape") {
		t.Fatalf("the envelope call did NOT execute:\n%s", out)
	}
	if !strings.Contains(out, "arguments auto-repaired") {
		t.Fatalf("the teach head is missing:\n%s", out)
	}
	if !strings.Contains(out, "action inferred as exec") {
		t.Fatalf("the exec inference note is missing:\n%s", out)
	}
}

// TestV1611_KennyActionTagSplitExecutes — the action field carrying the
// tags (the logged "unknown termux action \"exec<TAGS>{…\"" death):
// the split rescues the real action and the payload merges.
func TestV1611_KennyActionTagSplitExecutes(t *testing.T) {
	fb := newFakeArmBridge(t)
	s := newArmServer(t, fb)
	root := t.TempDir()
	armTermuxChat(t, s, "kenny4", root)

	actionVal := "exec" + v1611TagA + v1611TagB + `{"command":"echo repaired-action-split"}`
	argJSON := wire(t, map[string]any{"action": actionVal})
	out := s.runTermuxAction(context.Background(), "kenny4", argJSON)
	if !strings.Contains(out, "repaired-action-split") {
		t.Fatalf("the tagged-action call did NOT execute:\n%s", out)
	}
	if !strings.Contains(out, "arguments auto-repaired") {
		t.Fatalf("the teach head is missing:\n%s", out)
	}
}

// TestV1611_TruncatedCallRefusedWithDirective — the honesty line: a
// genuinely truncated call never executes half a command, and the
// verdict carries the anti-simplification order.
func TestV1611_TruncatedCallRefusedWithDirective(t *testing.T) {
	fb := newFakeArmBridge(t)
	s := newArmServer(t, fb)
	root := t.TempDir()
	armTermuxChat(t, s, "kenny5", root)

	out := s.runTermuxAction(context.Background(), "kenny5", `{"action":"exec","args":"{\"command\":\"python3 -c \"import json; d=json.lo`)
	if !strings.Contains(out, "malformed beyond mechanical repair") {
		t.Fatalf("the truncation verdict must speak:\n%s", out)
	}
	if !strings.Contains(out, llm.RetrySameCallDirective) {
		t.Fatalf("the anti-simplification order is missing:\n%s", out)
	}
	if fb.runCount() != 0 {
		t.Fatalf("a truncated call must NEVER touch the bridge (runs=%d)", fb.runCount())
	}
}

// TestV1611_UnknownActionDirective — the unknown-action verdict teaches
// the fix AND forbids the downgrade (kenny's "simpler approach" spiral).
func TestV1611_UnknownActionDirective(t *testing.T) {
	fb := newFakeArmBridge(t)
	s := newArmServer(t, fb)
	root := t.TempDir()
	armTermuxChat(t, s, "kenny6", root)

	out := tool(s, "kenny6", "explode", `{}`)
	if !strings.Contains(out, `unknown termux action "explode"`) {
		t.Fatalf("unknown action teach:\n%s", out)
	}
	if !strings.Contains(out, llm.RetrySameCallDirective) {
		t.Fatalf("the anti-simplification order is missing:\n%s", out)
	}
}

// TestV1611_RepairedReadRidesTheTeachHead — the repair wrapper's teach
// head lands at the top of the OBSERVATION on the file verbs too.
func TestV1611_RepairedReadRidesTheTeachHead(t *testing.T) {
	fb := newFakeArmBridge(t)
	s := newArmServer(t, fb)
	root := t.TempDir()
	armTermuxChat(t, s, "kenny7", root)
	if err := os.WriteFile(filepath.Join(root, "f.txt"), []byte("hello\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	// the truncated-nested read: {"action":"read","args":"{\"path\":\"f.txt\"}
	// (closer missing — kenny's "unexpected end of JSON input" class) → the
	// closers rung repairs, the read runs — with the teach head
	nested := `{"path": "f.txt"`
	argJSON := wire(t, map[string]any{"action": "read", "args": nested})
	out := s.runTermuxAction(context.Background(), "kenny7", argJSON)
	if !strings.Contains(out, "hello") {
		t.Fatalf("the envelope read did not execute:\n%s", out)
	}
	if !strings.Contains(out, "arguments auto-repaired") {
		t.Fatalf("the teach head is missing:\n%s", out)
	}
}

// ── the workspace drift shapes (kenny class 5, trippy classes 6/7) ───────

func TestV1611_WsFromPathInference(t *testing.T) {
	s, sid := newV1560Server(t)
	// kenny's byte-exact class: the workspace NAME rode the path key.
	out := wsRun(s, sid, `{"action":"grep","path":"me/greplines","query":"TODO"}`)
	if !strings.Contains(out, "a.go:2") {
		t.Fatalf("the path-as-ws grep did not execute:\n%s", out)
	}
	if !strings.Contains(out, "workspace \"me/greplines\" taken from the path") {
		t.Fatalf("the inference teach is missing:\n%s", out)
	}
	// the legacy death text is GONE for this shape
	if strings.Contains(out, "no connected workspace matches") {
		t.Fatalf("the old failure still fires for the inferable shape:\n%s", out)
	}
}

func TestV1611_ReadContinueReplay(t *testing.T) {
	s, sid := newV1560Server(t)
	// read a file first (the recorder)
	out := wsRun(s, sid, `{"action":"read","ws":"me/greplines","path":"a.go"}`)
	if !strings.Contains(out, "TODO: one") {
		t.Fatalf("the first read failed:\n%s", out)
	}
	// trippy's byte-exact class: range with NO path — the replay continues
	out = wsRun(s, sid, `{"action":"read","ws":"me/greplines","range":"lines:1-2"}`)
	if !strings.Contains(out, "path replayed from your last read") {
		t.Fatalf("the read-continue teach is missing:\n%s", out)
	}
	if strings.Contains(out, "read needs") {
		t.Fatalf("the old failure still fires for the replayable shape:\n%s", out)
	}
}

func TestV1611_GrepAliasQuery(t *testing.T) {
	s, sid := newV1560Server(t)
	// trippy's class: no query, but the termux spelling rode along
	out := wsRun(s, sid, `{"action":"grep","ws":"me/greplines","pattern":"TODO"}`)
	if !strings.Contains(out, "a.go:2") {
		t.Fatalf("the aliased grep did not execute:\n%s", out)
	}
	if !strings.Contains(out, `"pattern" read as the grep query`) {
		t.Fatalf("the alias teach is missing:\n%s", out)
	}
}

// TestV1611_PatchUnresolvableWsNoPanic — the audit §1.8 landmine: patch
// with an unresolvable ws was a NIL DEREF (a panic on the worst model's
// arg fumble). Now: the honest teach, never a panic.
func TestV1611_PatchUnresolvableWsNoPanic(t *testing.T) {
	s, sid := newV1560Server(t)
	for _, verb := range []string{"patch", "commit", "sync", "tag_create"} {
		out := wsRun(s, sid, `{"action":"`+verb+`","ws":"does-not-exist","path":"a.go"}`)
		if !strings.Contains(out, "no connected workspace matches") {
			t.Fatalf("%s with an unresolvable ws must teach, got:\n%s", verb, out)
		}
	}
}

// TestV1611_WsArgIntCeiling — a model's limit:1000 must LIMIT (the old
// <500 guard inverted it to UNLIMITED).
func TestV1611_WsArgIntCeiling(t *testing.T) {
	args := map[string]any{"limit": float64(1000)}
	if got := wsArgInt(args, "limit", 0); got != 1000 {
		t.Fatalf("limit:1000 must ride through, got %d", got)
	}
	args2 := map[string]any{"limit": float64(200000)}
	if got := wsArgInt(args2, "limit", 0); got != 0 {
		t.Fatalf("an absurd limit must fall to the default, got %d", got)
	}
}
