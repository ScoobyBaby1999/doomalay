package server

// ocservetools_v1581_test.go — v1.58.1 THE INFORMATIVE PILL pins
// (PLAN-V158 §1). The user's law: opencode tool pills must speak the SAME
// grammar as native ones — the bare tool name (never "opencode:grep") + a
// DERIVED operand (never a static "running") — with the whole-result law
// (the 6000-char silent clamp is dead) + the live progress ping + the
// serve's own truncated verdict surfaced honestly.

import (
        "context"
        "encoding/json"
        "fmt"
        "net/http"
        "net/http/httptest"
        "strings"
        "sync"
        "testing"
        "time"

        "github.com/ScoobyBaby1999/doomalay/engine/internal/llm"
        "github.com/ScoobyBaby1999/doomalay/engine/internal/ocserve"
)

// seedOCContext arms the live registry with a context window for the pump's
// budget law (the models.dev api.json shape).
func seedOCContext(t *testing.T, ctx int64) {
        t.Helper()
        seed := fmt.Sprintf(`{"opencode":{"name":"OpenCode","models":{"big-pickle":{"name":"Big Pickle","limit":{"context":%d,"output":32000},"cost":{"input":0,"output":0}}}}}`, ctx)
        if err := llm.SetModelsDevForTest([]byte(seed)); err != nil {
                t.Fatalf("seed: %v", err)
        }
}

// TestOcToolSummaryTable pins the verb+operand derivation table: every
// known tool answers its OWN operand (the PWA renders title=name,
// body=summary — byte-identical native pills), an unknown tool answers
// its first string arg (the derived fallback — never static), and a tool
// with no readable operand answers "" (the PWA's own fallback law).
func TestOcToolSummaryTable(t *testing.T) {
        cases := []struct{ name, args, want string }{
                // the file verbs speak the PATH TAIL (the PWA's own v1.33.2 law)
                {"read", `{"path":"/home/u/proj/src/main.go"}`, "main.go"},
                {"write", `{"path":"/home/u/proj/notes.txt","content":"x"}`, "notes.txt"},
                {"edit", `{"path":"/a/b/c/config.json"}`, "config.json"},
                // the search verbs keep their PATTERN
                {"grep", `{"pattern":"func Test","path":"/x"}`, "func Test"},
                {"glob", `{"pattern":"*.go"}`, "*.go"},
                // the exec law: the command's own first line
                {"shell", "{" + "\"command\"" + ":\"python3 -m pytest -q\\nls\", \"workdir\":\"/x\"}", "python3 -m pytest -q"},
                // the web verbs
                {"websearch", `{"query":"latest bun release"}`, "latest bun release"},
                {"webfetch", `{"url":"https://example.com/doc"}`, "https://example.com/doc"},
                // the delegating verbs
                {"subagent", `{"agent":"code","description":"find the flaky test","prompt":"..."}`, "find the flaky test"},
                {"skill", `{"id":"superpowers:debug"}`, "superpowers:debug"},
                // Code Mode: the code's first non-empty line
                {"execute", "{" + "\"code\"" + ":\"\\nimport sys\\nprint(1)\"}", "import sys"},
                // the patch law: the first file the patch touches — the args ride the
                // REAL wire shape (input.ended's text is the call's JSON:
                // {"patchText": "…"}; the \n below are JSON escapes inside the string,
                // decoding to real newlines exactly as the serve sends them)
                {"patch", `{"patchText":"*** Begin Patch\n*** Update File: src/app.go\n@@\n-x\n+y\n*** End Patch"}`, "app.go"},
                // the session verbs
                {"session_move", `{"directory":"/new/dir"}`, "/new/dir"},
                {"opencode.session_rename", `{"title":"the new plan"}`, "the new plan"},
                // THE DERIVED FALLBACK: an unknown tool still speaks its first
                // string arg (an MCP/plugin tool — never a static string)
                {"mcp_github_tool", `{"repo":"doomalay/app","number":7}`, "doomalay/app"},
                // no readable operand → "" (the PWA falls back to the name)
                {"mystery", `{"count":4}`, ""},
                {"", `{"query":"x"}`, ""},
        }
        for _, c := range cases {
                if got := ocToolSummary(c.name, c.args); got != c.want {
                        t.Fatalf("ocToolSummary(%q, %.60q) = %q, want %q", c.name, c.args, got, c.want)
                }
        }
        // NEVER STATIC: the same tool with different args answers different
        // operands (the pill lives with the call's truth)
        if ocToolSummary("grep", `{"pattern":"aaa"}`) == ocToolSummary("grep", `{"pattern":"bbb"}`) {
                t.Fatalf("the summary must derive from the args — two greps with different patterns answer different pills")
        }
}

// TestOcProgressLine pins the live-tail derivation: the serve's OWN
// statuses speak (toolCalls → "tool: status" pairs, a live shell its id);
// empty metadata answers "" (nothing fabricated).
func TestOcProgressLine(t *testing.T) {
        tc := true
        cases := []struct {
                meta ocserve.EventToolMetadata
                want string
        }{
                {ocserve.EventToolMetadata{ToolCalls: []ocserve.EventToolCallStatus{{Tool: "opencode.models", Status: "running"}}}, "[opencode.models: running]"},
                {ocserve.EventToolMetadata{ToolCalls: []ocserve.EventToolCallStatus{{Tool: "read", Status: "completed"}, {Tool: "write", Status: "running"}}}, "[read: completed · write: running]"},
                {ocserve.EventToolMetadata{ShellID: "sh_abc123"}, "[shell session sh_abc123 running]"},
                {ocserve.EventToolMetadata{Truncated: &tc}, ""}, // a truncation verdict is NOT progress
                {ocserve.EventToolMetadata{}, ""},               // nothing invented
        }
        for _, c := range cases {
                if got := ocProgressLine(c.meta); got != c.want {
                        t.Fatalf("ocProgressLine(%+v) = %q, want %q", c.meta, got, c.want)
                }
        }
}

// TestOcObsBudgetLaws pins the window-physics budget (the v1.56.1
// whole-return law inherited by the opencode path): 90% of the window's
// byte size, floored at 1MB capped to a quarter of the window — a
// 65536-floor unknown model keeps a real budget, a 200K model rides
// ~684KB, a big-window model far above the old 6000-char amputation.
func TestOcObsBudgetLaws(t *testing.T) {
        seed := `{"opencode":{"name":"OpenCode","models":{
                "big-pickle":{"name":"Big Pickle","limit":{"context":200000,"output":32000},"cost":{"input":0,"output":0}},
                "tiny-one":{"name":"Tiny One","limit":{"context":32000,"output":8192},"cost":{"input":0,"output":0}}
        }}}`
        if err := llm.SetModelsDevForTest([]byte(seed)); err != nil {
                t.Fatalf("seed: %v", err)
        }
        defer llm.ClearModelsDevForTest()
        // 200K window: 200000*3.8 = 760000 bytes * 0.9 = 684000
        if got := ocObsBudget("opencode/big-pickle"); got != 684000 {
                t.Fatalf("a 200K model rides 684000 bytes whole, got %d", got)
        }
        // 32K window: 32000*3.8 = 121600; quarter = 30400 (< 1MB floor → floor 30400);
        // budget 90% = 109440 > floor → 109440
        if got := ocObsBudget("opencode/tiny-one"); got != 109440 {
                t.Fatalf("a 32K model rides 109440 bytes whole, got %d", got)
        }
        // unknown model: the conservative 65536 floor * 3.8 * 0.9 ≈ 224KB
        if got := ocObsBudget("opencode/never-heard-of"); got <= 6000 {
                t.Fatalf("even an unknown model's budget must dwarf the dead 6000-char clamp, got %d", got)
        }
}

// runPumpFrames drives the pump against a fake serve answering the given
// SSE frames, returning the engine events it emitted.
func runPumpFrames(t *testing.T, frames []string) []map[string]any {
        t.Helper()
        t.Setenv("DOOMALAY_OPENCODE_SERVE_PASSWORD", "rig-pw")
        fake := &fakeServe{}
        var mu sync.Mutex
        mu.Lock()
        fake.sse = frames
        mu.Unlock()
        srv := httptest.NewServer(http.HandlerFunc(fake.handler))
        defer srv.Close()
        m := ocserve.New("", "key", nil)
        m.SetBaseURL(srv.URL)
        s := &Server{ocServeSessions: map[string]string{"chat1": "ses_fake_pre"}}
        events := make(chan map[string]any, 64)
        done := make(chan struct{})
        var got []map[string]any
        go func() {
                for ev := range events {
                        got = append(got, ev)
                }
                close(done)
        }()
        recycled, err := s.ocServePump(context.Background(), m, "ses_fake_pre", "chat1", "opencode/big-pickle", events, time.Now().UnixMilli())
        close(events)
        <-done
        if err != nil {
                t.Fatalf("pump: %v", err)
        }
        if recycled {
                t.Fatalf("a clean tool turn must not recycle")
        }
        return got
}

// TestOcServePumpInformativePill drives the LIVE-CAPTURED frame sequence
// (input.started → input.ended → called → progress → success) through the
// pump and pins: the bare name + derived summary, the use-before-result
// law with called as a no-duplicate belt, the progress → tool_stream
// ping carrying the call's id, and the terminal.
func TestOcServePumpInformativePill(t *testing.T) {
        seedOCContext(t, 200000)
        defer llm.ClearModelsDevForTest()
        frames := []string{
                `data: {"id":"e1","type":"session.tool.input.started","data":{"sessionID":"ses_fake_pre","id":"call_g1","name":"grep"}}`,
                `data: {"id":"e2","type":"session.tool.input.ended","data":{"sessionID":"ses_fake_pre","id":"call_g1","text":"{\"pattern\":\"func Test\",\"path\":\"/x\"}"}}`,
                `data: {"id":"e3","type":"session.tool.called","data":{"sessionID":"ses_fake_pre","id":"call_g1","input":{"pattern":"func Test","path":"/x"},"executed":false}}`,
                `data: {"id":"e4","type":"session.tool.progress","data":{"sessionID":"ses_fake_pre","id":"call_g1","metadata":{"toolCalls":[{"tool":"read","status":"completed"},{"tool":"grep","status":"running"}]}}}`,
                `data: {"id":"e5","type":"session.tool.success","data":{"sessionID":"ses_fake_pre","id":"call_g1","content":[{"type":"text","text":"src/a_test.go: no hits"}],"metadata":{"truncated":false}}}`,
                `data: {"id":"e6","type":"session.step.ended","data":{"sessionID":"ses_fake_pre","finish":"stop"}}`,
                `data: {"id":"e7","type":"session.execution.succeeded","data":{"sessionID":"ses_fake_pre"}}`,
        }
        got := runPumpFrames(t, frames)
        var uses, streams, results int
        for _, ev := range got {
                switch ev["type"] {
                case "tool_use":
                        uses++
                        if ev["name"] != "grep" {
                                t.Fatalf("THE NO-PREFIX LAW: the pill name is bare, got %v", ev["name"])
                        }
                        if ev["summary"] != "func Test" {
                                t.Fatalf("THE DERIVED SUMMARY: grep's pattern, got %v", ev["summary"])
                        }
                        if ev["tool_use_id"] != "call_g1" {
                                t.Fatalf("the use must carry the call id, got %v", ev["tool_use_id"])
                        }
                case "tool_stream":
                        streams++
                        if ev["delta"] != "[read: completed · grep: running]\n" {
                                t.Fatalf("THE LIVE PING: the serve's own statuses, got %q", ev["delta"])
                        }
                        if ev["name"] != "grep" || ev["tool_use_id"] != "call_g1" {
                                t.Fatalf("the ping must name its call: name=%v id=%v", ev["name"], ev["tool_use_id"])
                        }
                case "tool_result":
                        results++
                        if ev["name"] != "grep" {
                                t.Fatalf("the result name is bare too, got %v", ev["name"])
                        }
                        if ev["text"] != "src/a_test.go: no hits" {
                                t.Fatalf("the whole result text, got %v", ev["text"])
                        }
                }
        }
        if uses != 1 {
                t.Fatalf("THE NO-DUPLICATE BELT: called after input.ended must not re-emit the use, got %d uses", uses)
        }
        if streams != 1 {
                t.Fatalf("one progress frame → one live ping, got %d", streams)
        }
        if results != 1 {
                t.Fatalf("one success → one result, got %d", results)
        }
}

// TestOcServePumpUnboundedResult pins THE WHOLE-RETURN LAW: a result far
// past the old 6000-char clamp lands WHOLE on the transcript (no silent
// amputation) — the user's chatlog conviction.
func TestOcServePumpUnboundedResult(t *testing.T) {
        seedOCContext(t, 200000)
        defer llm.ClearModelsDevForTest()
        // a REAL grep-shaped result: many lines, ~19.5KB — far past the dead
        // 6000-char clamp. The expected text is edge-trimmed to match
        // ClampMarked's OWN contract (TrimSpace — the native path rides the
        // identical law; the pin then compares the surviving bytes EXACTLY).
        // The success frame is MARSHALED (json.Marshal) so the payload's
        // newlines ride escaped — an SSE frame is ONE line; a raw newline would
        // split the event and kill the pump's read (the first draft's bug,
        // caught by this very test).
        big := strings.TrimSpace(strings.Repeat("hit this-file.go: a real grep hit line\n", 500))
        successData, err := json.Marshal(map[string]any{
                "sessionID": "ses_fake_pre", "id": "call_r1",
                "content":  []map[string]string{{"type": "text", "text": big}},
                "metadata": map[string]any{"truncated": false},
        })
        if err != nil {
                t.Fatalf("marshal: %v", err)
        }
        frames := []string{
                `data: {"id":"e1","type":"session.tool.input.started","data":{"sessionID":"ses_fake_pre","id":"call_r1","name":"grep"}}`,
                `data: {"id":"e2","type":"session.tool.input.ended","data":{"sessionID":"ses_fake_pre","id":"call_r1","text":"{\"pattern\":\"hit\"}"}}`,
                `data: {"id":"e3","type":"session.tool.success","data":` + string(successData) + `}`,
                `data: {"id":"e4","type":"session.execution.succeeded","data":{"sessionID":"ses_fake_pre"}}`,
        }
        got := runPumpFrames(t, frames)
        for _, ev := range got {
                if ev["type"] != "tool_result" {
                        continue
                }
                text, _ := ev["text"].(string)
                if len(text) != len(big) {
                        t.Fatalf("THE WHOLE-RETURN LAW: a %d-byte grep result must land WHOLE (the 6000-char silent clamp is DEAD), got %d bytes (tail: %.80q)", len(big), len(text), text[max(0, len(text)-80):])
                }
                if strings.Contains(text, "[truncated:") {
                        t.Fatalf("no honest marker on an UNclamped result")
                }
                return
        }
        t.Fatalf("no tool_result event landed")
}

// TestOcServePumpServeTruncated pins the honest truncation verdict: when
// the SERVE itself declares metadata.truncated=true, the result carries
// the honest tail line (we surface the truth — we never invent it and
// never hide it).
func TestOcServePumpServeTruncated(t *testing.T) {
        seedOCContext(t, 200000)
        defer llm.ClearModelsDevForTest()
        frames := []string{
                `data: {"id":"e1","type":"session.tool.input.started","data":{"sessionID":"ses_fake_pre","id":"call_t1","name":"read"}}`,
                `data: {"id":"e2","type":"session.tool.input.ended","data":{"sessionID":"ses_fake_pre","id":"call_t1","text":"{\"path\":\"/big.log\"}"}}`,
                `data: {"id":"e3","type":"session.tool.success","data":{"sessionID":"ses_fake_pre","id":"call_t1","content":[{"type":"text","text":"the first part"}],"metadata":{"truncated":true}}}`,
                `data: {"id":"e4","type":"session.execution.succeeded","data":{"sessionID":"ses_fake_pre"}}`,
        }
        got := runPumpFrames(t, frames)
        for _, ev := range got {
                if ev["type"] != "tool_result" {
                        continue
                }
                text, _ := ev["text"].(string)
                if !strings.Contains(text, "the first part") {
                        t.Fatalf("the result text must ride whole: %q", text)
                }
                if !strings.Contains(text, "opencode shortened this output itself") {
                        t.Fatalf("the serve's truncated=true must surface honestly, got %q", text)
                }
                return
        }
        t.Fatalf("no tool_result event landed")
}

// TestOcServePumpCalledBelt pins the belt: a call whose input.ended NEVER
// rode (an upstream shape change) still gets its use row from
// tool.called's structured input — the derived summary reads the same
// operand either way.
func TestOcServePumpCalledBelt(t *testing.T) {
        seedOCContext(t, 200000)
        defer llm.ClearModelsDevForTest()
        frames := []string{
                `data: {"id":"e1","type":"session.tool.input.started","data":{"sessionID":"ses_fake_pre","id":"call_b1","name":"websearch"}}`,
                `data: {"id":"e2","type":"session.tool.called","data":{"sessionID":"ses_fake_pre","id":"call_b1","name":"websearch","input":{"query":"the lost input.ended frame"},"executed":false}}`,
                `data: {"id":"e3","type":"session.tool.success","data":{"sessionID":"ses_fake_pre","id":"call_b1","content":[{"type":"text","text":"results"}],"metadata":{"truncated":false}}}`,
                `data: {"id":"e4","type":"session.execution.succeeded","data":{"sessionID":"ses_fake_pre"}}`,
        }
        got := runPumpFrames(t, frames)
        var use, result bool
        for _, ev := range got {
                switch ev["type"] {
                case "tool_use":
                        use = true
                        if ev["name"] != "websearch" || ev["summary"] != "the lost input.ended frame" {
                                t.Fatalf("the called belt must derive the same operand: name=%v summary=%v", ev["name"], ev["summary"])
                        }
                case "tool_result":
                        result = true
                }
        }
        if !use || !result {
                t.Fatalf("a missing input.ended must never lose the pill: use=%v result=%v", use, result)
        }
}

// TestOcServePumpParallelSameName pins THE ID-FIRST PAIRING feed shape:
// two same-name calls in flight each carry their own id on BOTH the use
// and the result (the engine-side half of the PWA's id-first merge law).
func TestOcServePumpParallelSameName(t *testing.T) {
        seedOCContext(t, 200000)
        defer llm.ClearModelsDevForTest()
        frames := []string{
                `data: {"id":"e1","type":"session.tool.input.started","data":{"sessionID":"ses_fake_pre","id":"call_p1","name":"read"}}`,
                `data: {"id":"e2","type":"session.tool.input.ended","data":{"sessionID":"ses_fake_pre","id":"call_p1","text":"{\"path\":\"/a.go\"}"}}`,
                `data: {"id":"e3","type":"session.tool.input.started","data":{"sessionID":"ses_fake_pre","id":"call_p2","name":"read"}}`,
                `data: {"id":"e4","type":"session.tool.input.ended","data":{"sessionID":"ses_fake_pre","id":"call_p2","text":"{\"path\":\"/b.go\"}"}}`,
                `data: {"id":"e5","type":"session.tool.success","data":{"sessionID":"ses_fake_pre","id":"call_p2","content":[{"type":"text","text":"B"}],"metadata":{"truncated":false}}}`,
                `data: {"id":"e6","type":"session.tool.success","data":{"sessionID":"ses_fake_pre","id":"call_p1","content":[{"type":"text","text":"A"}],"metadata":{"truncated":false}}}`,
                `data: {"id":"e7","type":"session.execution.succeeded","data":{"sessionID":"ses_fake_pre"}}`,
        }
        got := runPumpFrames(t, frames)
        pairs := map[string][2]string{} // callID → [useSummary, resultText]
        for _, ev := range got {
                switch ev["type"] {
                case "tool_use":
                        id, _ := ev["tool_use_id"].(string)
                        pairs[id] = [2]string{fmt.Sprint(ev["summary"]), ""}
                case "tool_result":
                        id, _ := ev["tool_use_id"].(string)
                        p, ok := pairs[id]
                        if !ok {
                                t.Fatalf("a result for an unknown call id: %v", id)
                        }
                        p[1] = fmt.Sprint(ev["text"])
                        pairs[id] = p
                }
        }
        if len(pairs) != 2 {
                t.Fatalf("two same-name calls must stay two distinct id pairs, got %d", len(pairs))
        }
        if pairs["call_p1"] != [2]string{"a.go", "A"} || pairs["call_p2"] != [2]string{"b.go", "B"} {
                t.Fatalf("the id pairing must hold through completion (out-of-order results): %+v", pairs)
        }
}

// TestOcServeEventMetadataShape pins the typed metadata block against the
// LIVE-CAPTURED frames (execute → toolCalls, shell → shellID, success →
// truncated) — the serve's own vocabulary, decoded where the pump reads it.
func TestOcServeEventMetadataShape(t *testing.T) {
        raw := `{"toolCalls":[{"tool":"read","status":"completed","input":{"path":"/x"}},{"tool":"grep","status":"running"}]}`
        // fresh zero values per decode: json.Unmarshal APPENDS into existing
        // slices and leaves unset pointers — a reused `m` carries the previous
        // frame's truth across decodes (the first draft's bug, caught here).
        var m ocserve.EventToolMetadata
        if err := json.Unmarshal([]byte(`{"toolCalls":[{"tool":"read","status":"completed","input":{"path":"/x"}},{"tool":"grep","status":"running"}]}`), &m); err != nil {
                t.Fatalf("toolCalls metadata must decode: %v", err)
        }
        if len(m.ToolCalls) != 2 || m.ToolCalls[0].Tool != "read" || m.ToolCalls[0].Status != "completed" || m.ToolCalls[1].Status != "running" {
                t.Fatalf("toolCalls shape wrong: %+v (raw %s)", m, raw)
        }
        m = ocserve.EventToolMetadata{}
        if err := json.Unmarshal([]byte(`{"shellID":"sh_k1"}`), &m); err != nil || m.ShellID != "sh_k1" {
                t.Fatalf("shellID metadata must decode: %+v (%v)", m, err)
        }
        m = ocserve.EventToolMetadata{}
        if err := json.Unmarshal([]byte(`{"truncated":true}`), &m); err != nil || m.Truncated == nil || !*m.Truncated {
                t.Fatalf("truncated=true must decode: %+v (%v)", m, err)
        }
        m = ocserve.EventToolMetadata{}
        if err := json.Unmarshal([]byte(`{"truncated":false}`), &m); err != nil || m.Truncated == nil || *m.Truncated {
                t.Fatalf("truncated=false must decode as a false pointer: %+v (%v)", m, err)
        }
        // an absent block decodes zero (nothing invented)
        m = ocserve.EventToolMetadata{}
        if err := json.Unmarshal([]byte(`{}`), &m); err != nil || m.Truncated != nil || m.ShellID != "" || len(m.ToolCalls) != 0 {
                t.Fatalf("an empty metadata block must decode zero: %+v (%v)", m, err)
        }
}

// max mirrors the builtin for the older toolchain used by some rigs.
func max(a, b int) int {
        if a > b {
                return a
        }
        return b
}
