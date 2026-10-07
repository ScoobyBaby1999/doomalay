package mcpbus

import (
        "context"
        "encoding/json"
        "fmt"
        "strings"
        "sync"
        "sync/atomic"
        "testing"
)

// newTestBus builds a bus with a recording observer.
func newTestBus(t *testing.T) (*Bus, *recorder) {
        t.Helper()
        b, err := New()
        if err != nil {
                t.Fatalf("New: %v", err)
        }
        rec := &recorder{}
        b.AddObserver(rec)
        t.Cleanup(func() { _ = b.Close() })
        return b, rec
}

type recorder struct {
        mu     sync.Mutex
        starts []ToolStart
        ends   []ToolEnd
        progs  []Progress
}

func (r *recorder) OnToolStart(e ToolStart) {
        r.mu.Lock()
        r.starts = append(r.starts, e)
        r.mu.Unlock()
}

func (r *recorder) OnToolEnd(e ToolEnd) {
        r.mu.Lock()
        r.ends = append(r.ends, e)
        r.mu.Unlock()
}

func (r *recorder) OnProgress(e Progress) {
        r.mu.Lock()
        r.progs = append(r.progs, e)
        r.mu.Unlock()
}

// fakeTurn wires stub closures that record calls and return today's
// exact observation shapes.
func fakeTurn(session string) *Turn {
        return &Turn{
                SessionID: session,
                RunLocal: func(ctx context.Context, name, argJSON string, sink ArtifactSink) string {
                        switch name {
                        case "calculator":
                                var a struct {
                                        Expr string `json:"expr"`
                                }
                                _ = json.Unmarshal([]byte(argJSON), &a)
                                if a.Expr == "2+2" {
                                        return "OBSERVATION:\n4"
                                }
                                return "OBSERVATION:\n" + a.Expr + " = ?"
                        case "zip_create":
                                var a struct {
                                        Name string `json:"name"`
                                }
                                _ = json.Unmarshal([]byte(argJSON), &a)
                                return "OBSERVATION:\nbuilt bundle.zip (3 files, 12.4 KB)\nSaved as artifact \"" + a.Name + "\" (12.4 KB) — the user can open/download it from the chat's artifact drawer. Tell the user the file is ready."
                        }
                        return "OBSERVATION:\nok"
                },
                Search: func(ctx context.Context, query string) (string, []Source, error) {
                        if query == "fail" {
                                return "", nil, fmt.Errorf("boom")
                        }
                        return "1. Example — https://example.com\nsnippet text", []Source{
                                {Title: "Example", URL: "https://example.com", Snippet: "snippet text"},
                        }, nil
                },
                Fetch: func(ctx context.Context, url string) (string, error) {
                        if url == "" {
                                return "", fmt.Errorf("empty")
                        }
                        return "page text for " + url, nil
                },
                TemplateAuto: true,
                TemplateList: func(ctx context.Context) string { return "OBSERVATION:\nredteam: 6 stages" },
                TemplateShow: func(ctx context.Context, id string) string {
                        return "OBSERVATION:\nmethodology of " + id
                },
                Persona: func(ctx context.Context, name, argJSON string) string {
                        return "OBSERVATION:\npersona " + name + " ran"
                },
                Hublib:    func(ctx context.Context, argJSON string) string { return "OBSERVATION:\nhub ok" },
                Skills:    func(ctx context.Context, argJSON string) string { return "OBSERVATION:\nskills ok" },
                Workspace: func(ctx context.Context, argJSON string) string { return "OBSERVATION:\nworkspace ok" },
                Delegate: func(ctx context.Context, prompt string, models []string) []map[string]any {
                        return []map[string]any{{"model": "test", "answer": "42"}}
                },
        }
}

func args(t *testing.T, v any) json.RawMessage {
        t.Helper()
        b, err := json.Marshal(v)
        if err != nil {
                t.Fatal(err)
        }
        return b
}

// ── the protocol path ────────────────────────────────────────────────

func TestListToolsServesAll28(t *testing.T) {
        b, _ := newTestBus(t)
        tools, err := b.ListTools(context.Background())
        if err != nil {
                t.Fatalf("ListTools: %v", err)
        }
        if len(tools) != 28 {
                t.Fatalf("want 28 tools, got %d", len(tools))
        }
        for _, tool := range tools {
                if tool.Name == "" || tool.Description == "" {
                        t.Fatalf("tool %q missing name/description", tool.Name)
                }
        }
}

// ── execution: local + file tools ────────────────────────────────────

func TestCallToolCalculator(t *testing.T) {
        b, rec := newTestBus(t)
        turn := fakeTurn("sess-1")
        res := b.CallTool(context.Background(), turn, "calculator", args(t, map[string]any{"expr": "2+2"}))
        if res.IsError {
                t.Fatalf("unexpected error: %s", res.Text)
        }
        if res.Text != "4" {
                t.Fatalf("want 4, got %q", res.Text)
        }
        if len(rec.starts) != 1 || rec.starts[0].Name != "calculator" || rec.starts[0].Summary != "2+2" {
                t.Fatalf("bad ToolStart: %+v", rec.starts)
        }
        if len(rec.ends) != 1 || rec.ends[0].Text != "4" || rec.ends[0].DurationMS < 0 {
                t.Fatalf("bad ToolEnd: %+v", rec.ends)
        }
        if rec.starts[0].SessionID != "sess-1" || rec.ends[0].SessionID != "sess-1" {
                t.Fatalf("session not carried through events")
        }
}

func TestCallToolArtifactDetection(t *testing.T) {
        b, rec := newTestBus(t)
        turn := fakeTurn("sess-1")
        res := b.CallTool(context.Background(), turn, "zip_create", args(t, map[string]any{
                "name":  "bundle.zip",
                "files": []map[string]any{{"name": "a.txt", "content": "x"}},
        }))
        if res.IsError {
                t.Fatalf("unexpected error: %s", res.Text)
        }
        if res.Artifact != "bundle.zip" {
                t.Fatalf("want artifact bundle.zip, got %q", res.Artifact)
        }
        if rec.ends[0].Artifact != "bundle.zip" {
                t.Fatalf("artifact not reported on ToolEnd")
        }
}

// ── web tools + sources ──────────────────────────────────────────────

func TestCallToolWebSearchSources(t *testing.T) {
        b, rec := newTestBus(t)
        turn := fakeTurn("sess-1")
        res := b.CallTool(context.Background(), turn, "web_search", args(t, map[string]any{"query": "example"}))
        if res.IsError {
                t.Fatalf("unexpected error: %s", res.Text)
        }
        if len(res.Sources) != 1 || res.Sources[0].URL != "https://example.com" {
                t.Fatalf("want 1 source, got %+v", res.Sources)
        }
        if len(rec.ends[0].Sources) != 1 {
                t.Fatalf("sources not on ToolEnd")
        }
        // sources drain per call — a second search returns its own set
        res2 := b.CallTool(context.Background(), turn, "web_search", args(t, map[string]any{"query": "again"}))
        if len(res2.Sources) != 1 {
                t.Fatalf("second search should drain its own sources, got %+v", res2.Sources)
        }
}

func TestCallToolWebSearchErrorText(t *testing.T) {
        b, _ := newTestBus(t)
        turn := fakeTurn("sess-1")
        res := b.CallTool(context.Background(), turn, "web_search", args(t, map[string]any{"query": "fail"}))
        if !res.IsError {
                t.Fatalf("want IsError for search failure")
        }
        if res.Text != "search error: boom" {
                t.Fatalf("today-parity error text, got %q", res.Text)
        }
}

func TestCallToolEmptyQuery(t *testing.T) {
        b, _ := newTestBus(t)
        res := b.CallTool(context.Background(), fakeTurn("s"), "web_search", args(t, map[string]any{"query": ""}))
        if !res.IsError || res.Text != "error: empty query" {
                t.Fatalf("want today-parity empty-query error, got %+v", res)
        }
}

// ── gated tools ──────────────────────────────────────────────────────

func TestGatedToolsRefuseWhenUnarmed(t *testing.T) {
        b, _ := newTestBus(t)
        bare := &Turn{SessionID: "s"} // no closures
        for _, name := range []string{"hublib", "skills", "workspace", "persona_list", "delegate"} {
                res := b.CallTool(context.Background(), bare, name, args(t, map[string]any{}))
                if !res.IsError {
                        t.Fatalf("%s should refuse unarmed", name)
                }
        }
}

func TestSpecsGating(t *testing.T) {
        b, _ := newTestBus(t)
        none := b.Specs(Gates{})
        if len(none) != 20 {
                t.Fatalf("want 20 always-on specs (28 - 8 gated), got %d", len(none))
        }
        all := b.Specs(Gates{Hublib: true, Skills: true, Persona: true, Workspace: true, Delegate: true})
        if len(all) != 28 {
                t.Fatalf("want 28 specs with all gates, got %d", len(all))
        }
        // spot-check the OpenAI wire shape against the proven one
        var found bool
        for _, s := range all {
                fn, _ := s["function"].(map[string]any)
                if fn == nil || fn["name"] != "calculator" {
                        continue
                }
                found = true
                if fn["description"] != "Evaluate a math expression and return the result." {
                        t.Fatalf("calculator description drifted")
                }
                params, _ := fn["parameters"].(map[string]any)
                props, _ := params["properties"].(map[string]any)
                expr, _ := props["expr"].(map[string]any)
                if expr == nil || expr["type"] != "string" {
                        t.Fatalf("calculator.expr shape drifted: %+v", props)
                }
                req, _ := params["required"].([]string)
                if len(req) != 1 || req[0] != "expr" {
                        t.Fatalf("calculator required drifted: %+v", req)
                }
        }
        if !found {
                t.Fatalf("calculator spec missing")
        }
}

// ── delegate + progress ──────────────────────────────────────────────

func TestCallToolDelegate(t *testing.T) {
        b, rec := newTestBus(t)
        res := b.CallTool(context.Background(), fakeTurn("s"), "delegate", args(t, map[string]any{
                "prompt": "meaning of life?",
                "models": []string{"nvidia/nemotron", "mistral/large"},
        }))
        if res.IsError {
                t.Fatalf("unexpected error: %s", res.Text)
        }
        if !strings.Contains(res.Text, `"answer":"42"`) {
                t.Fatalf("delegate result text, got %q", res.Text)
        }
        if len(rec.progs) != 1 || rec.progs[0].Text != "consulting other models…" {
                t.Fatalf("progress event missing: %+v", rec.progs)
        }
}

// ── templates ────────────────────────────────────────────────────────

func TestTemplatesGatedOnPill(t *testing.T) {
        b, _ := newTestBus(t)
        off := fakeTurn("s")
        off.TemplateAuto = false
        res := b.CallTool(context.Background(), off, "template_list", args(t, map[string]any{}))
        if !res.IsError || !strings.Contains(res.Text, "the template pill is off") {
                t.Fatalf("want pill-off refusal, got %+v", res)
        }
        on := fakeTurn("s")
        res2 := b.CallTool(context.Background(), on, "template_list", args(t, map[string]any{}))
        if res2.IsError || res2.Text != "redteam: 6 stages" {
                t.Fatalf("want template list, got %+v", res2)
        }
        res3 := b.CallTool(context.Background(), on, "template_show", args(t, map[string]any{"id": "redteam"}))
        if res3.Text != "methodology of redteam" {
                t.Fatalf("want template show, got %q", res3.Text)
        }
}

// ── unknown tools + turn context ─────────────────────────────────────

func TestUnknownToolTeaches(t *testing.T) {
        b, _ := newTestBus(t)
        res := b.CallTool(context.Background(), fakeTurn("s"), "calculator_pro", args(t, map[string]any{}))
        if !res.IsError {
                t.Fatalf("unknown tool must error")
        }
        if !strings.Contains(res.Text, `unknown tool "calculator_pro"`) {
                t.Fatalf("teaching text, got %q", res.Text)
        }
        if !strings.Contains(res.Text, "calculator") {
                t.Fatalf("teaching text should list valid tools")
        }
}

func TestTurnContextFlowsThroughProtocol(t *testing.T) {
        b, rec := newTestBus(t)
        // The handler reads the Turn from ctx — this is THE in-process
        // ctx-value passthrough verification (the design's load-bearing
        // wall). If the summary + session arrive, the Turn flowed.
        turn := fakeTurn("ctx-proof")
        b.CallTool(context.Background(), turn, "time_now", args(t, map[string]any{"tz": "Asia/Beirut"}))
        if rec.starts[0].Summary != "Asia/Beirut" || rec.ends[0].SessionID != "ctx-proof" {
                t.Fatalf("ctx did not flow through the MCP protocol: %+v", rec)
        }
}

// ── concurrency (-race) ──────────────────────────────────────────────

func TestConcurrentTurns(t *testing.T) {
        b, _ := newTestBus(t)
        var wg sync.WaitGroup
        var okCount atomic.Int64
        for i := 0; i < 16; i++ {
                wg.Add(1)
                go func(i int) {
                        defer wg.Done()
                        turn := fakeTurn(fmt.Sprintf("sess-%d", i))
                        res := b.CallTool(context.Background(), turn, "calculator", args(t, map[string]any{"expr": "2+2"}))
                        if !res.IsError && res.Text == "4" {
                                okCount.Add(1)
                        }
                }(i)
        }
        wg.Wait()
        if okCount.Load() != 16 {
                t.Fatalf("concurrent calls: %d/16 ok", okCount.Load())
        }
}

// ── multiple observers stack ─────────────────────────────────────────

func TestObserverStacking(t *testing.T) {
        b, _ := newTestBus(t)
        var hits atomic.Int64
        b.AddObserver(ObserverFuncs{End: func(ToolEnd) { hits.Add(1) }})
        b.CallTool(context.Background(), fakeTurn("s"), "uuid", args(t, map[string]any{"count": 1}))
        if hits.Load() != 1 {
                t.Fatalf("second observer did not fire")
        }
}

// ── the summary table ────────────────────────────────────────────────

func TestDefaultSummary(t *testing.T) {
        cases := []struct {
                name, argJSON, want string
        }{
                {"calculator", `{"expr":"1+1"}`, "1+1"},
                {"web_search", `{"query":"go mcp"}`, "go mcp"},
                {"hublib", `{"action":"search","q":"redteam"}`, "redteam"},
                {"skills", `{"action":"load","skill":"superpowers"}`, "superpowers"},
                {"workspace", `{"action":"tree","ws":"owner/repo"}`, "owner/repo"},
                {"persona_set", `{"name":"Scooby"}`, "Scooby"},
                {"delegate", `{"prompt":"a very long prompt indeed"}`, "a very long prompt indeed"},
                {"template_list", `{}`, "browse the template library"},
        }
        for _, c := range cases {
                if got := DefaultSummary(c.name, c.argJSON); got != c.want {
                        t.Errorf("%s summary: want %q, got %q", c.name, c.want, got)
                }
        }
}
