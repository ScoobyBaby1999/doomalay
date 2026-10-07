package mcpbus

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"strings"
	"sync"
	"time"

	"github.com/mark3labs/mcp-go/client"
	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"
)

// bus.go — v1.13.1 THE BUS (PLAN-V113 §1).
//
// One MCPServer hosts the whole tool registry; an in-process MCP client
// (no network, no subprocess) executes every call through the REAL MCP
// protocol — tools/list, tools/call, JSON-RPC, the lot. The chat loop
// talks to this bus; native function calling presents the manifest the
// bus builds; the observers (the hooks) see every call with timing.

// busVersion rides the MCP server/client handshake (serverInfo).
const busVersion = "1.13.1"

// Bus is the engine-wide tool bus. Construct once (New or Default),
// share freely — CallTool is safe for concurrent turns.
type Bus struct {
	srv       *server.MCPServer
	cli       *client.Client
	hooks     *server.Hooks
	mu        sync.RWMutex
	observers []Observer
	// v1.13.4 THE CHAIN: attached external servers' proxied tools.
	external      map[string]*extTool
	externalSpecs []map[string]any
}

// New builds the bus: the MCP server with every Def registered, plus
// the initialized in-process client.
func New() (*Bus, error) {
	b := &Bus{hooks: &server.Hooks{}, external: map[string]*extTool{}}
	b.srv = server.NewMCPServer("doomalay-tools", busVersion,
		server.WithToolCapabilities(false),
		// v1.13.2 THE CONTAINED PANIC: a panicking tool handler becomes a
		// tool-level ERROR RESULT (the model self-corrects next round; the
		// turn survives; the engine never dies) — strictly better than the
		// old turn-level guard, which is retained in llm.Chat as the
		// defense-in-depth for panics OUTSIDE the bus. (mcp-go's own
		// WithRecovery returns a JSON-RPC error instead — that would read
		// as a BusFailure and degrade the turn to direct dispatch, where
		// the same panic would kill it. Not that.)
		server.WithToolHandlerMiddleware(func(next server.ToolHandlerFunc) server.ToolHandlerFunc {
			return func(ctx context.Context, req mcp.CallToolRequest) (result *mcp.CallToolResult, err error) {
				defer func() {
					if r := recover(); r != nil {
						log.Printf("PANIC recovered in mcpbus tool %s: %v", req.Params.Name, r)
						result = mcp.NewToolResultError("error: the " + req.Params.Name + " tool failed internally — the engine recovered; rephrase or try a different approach")
						err = nil
					}
				}()
				return next(ctx, req)
			}
		}),
		server.WithHooks(b.hooks),
	)
	for i := range defs {
		b.srv.AddTool(buildMCPTool(&defs[i]), handlerFor(&defs[i]))
	}
	cli, err := client.NewInProcessClient(b.srv)
	if err != nil {
		return nil, fmt.Errorf("mcpbus: in-process client: %w", err)
	}
	if err := cli.Start(context.Background()); err != nil {
		return nil, fmt.Errorf("mcpbus: client start: %w", err)
	}
	initReq := mcp.InitializeRequest{Params: mcp.InitializeParams{
		ProtocolVersion: mcp.LATEST_PROTOCOL_VERSION,
		Capabilities:    mcp.ClientCapabilities{},
		ClientInfo:      mcp.Implementation{Name: "doomalay-engine", Version: busVersion},
	}}
	if _, err := cli.Initialize(context.Background(), initReq); err != nil {
		return nil, fmt.Errorf("mcpbus: initialize: %w", err)
	}
	b.cli = cli
	return b, nil
}

var (
	defaultOnce sync.Once
	defaultBus  *Bus
	defaultErr  error
)

// Default lazily builds the process-wide bus (one per engine).
func Default() (*Bus, error) {
	defaultOnce.Do(func() {
		defaultBus, defaultErr = New()
	})
	return defaultBus, defaultErr
}

// ── the manifest (what the model sees) ──────────────────────────────

// Gates mirrors the ChatRequest closures that arm gated tools — the
// exact gating nativeToolSpecs applied, now in one place.
type Gates struct {
	Hublib    bool
	Skills    bool
	Persona   bool
	Workspace bool
	Delegate  bool
}

// Specs returns the OpenAI-style tools[] manifest for the armed gates —
// the same wire shape nativeToolSpecs emitted (a dozen providers have
// spoken this shape in production), built from the same Defs that
// register the MCP tools. One source of truth, two projections.
func (b *Bus) Specs(g Gates) []map[string]any {
	out := SpecsFor(g)
	b.mu.RLock()
	ext := b.externalSpecs
	b.mu.RUnlock()
	if len(ext) > 0 {
		out = append(out[:len(out):len(out)], ext...)
	}
	return out
}

// SpecsFor builds the OpenAI-style tools[] manifest from the Defs — a
// PURE function (no bus instance), so the degraded bus-down path still
// presents the exact same manifest.
func SpecsFor(g Gates) []map[string]any {
	out := make([]map[string]any, 0, len(defs))
	for i := range defs {
		d := &defs[i]
		switch d.Gate {
		case GateHublib:
			if !g.Hublib {
				continue
			}
		case GateSkills:
			if !g.Skills {
				continue
			}
		case GatePersona:
			if !g.Persona {
				continue
			}
		case GateWorkspace:
			if !g.Workspace {
				continue
			}
		case GateDelegate:
			if !g.Delegate {
				continue
			}
		}
		out = append(out, openAISpec(d))
	}
	return out
}

// openAISpec projects one Def into the OpenAI function-calling shape.
func openAISpec(d *Def) map[string]any {
	props := map[string]any{}
	required := []string{}
	for _, p := range d.Props {
		pm := map[string]any{"type": string(p.Prop.Kind), "description": p.Prop.Desc}
		if len(p.Prop.Enum) > 0 {
			pm["enum"] = p.Prop.Enum
		}
		props[p.Key] = pm
		if p.Prop.Required {
			required = append(required, p.Key)
		}
	}
	return map[string]any{
		"type": "function",
		"function": map[string]any{
			"name":        d.Name,
			"description": d.Desc,
			"parameters": map[string]any{
				"type":       "object",
				"properties": props,
				"required":   required,
			},
		},
	}
}

// ListTools dogfoods the protocol: the tool list as the MCP client
// sees it (JSON Schemas included). External-server aggregation (Phase
// 4) extends this.
func (b *Bus) ListTools(ctx context.Context) ([]mcp.Tool, error) {
	res, err := b.cli.ListTools(ctx, mcp.ListToolsRequest{})
	if err != nil {
		return nil, err
	}
	return res.Tools, nil
}

// ── execution ───────────────────────────────────────────────────────

// Result is one tool execution's outcome, shaped for the role:"tool"
// message the chat loop builds — Text is the observation minus the
// OBSERVATION prefix, byte-identical to the direct path's content.
type Result struct {
	Name       string
	Text       string
	IsError    bool
	BusFailure bool     // the MCP protocol layer itself failed (not the tool) — the caller's native-dispatch fallback signal
	Artifact   string   // the saved artifact's name (file tools)
	Sources    []Source // citations accumulated by this call (web_search)
}

// CallTool executes ONE tool through the real MCP protocol: the Turn
// rides the ctx into the handler (in-process transport passes ctx
// values through), observers see start/end with timing, sources and
// artifacts drain back here.
func (b *Bus) CallTool(ctx context.Context, t *Turn, name string, args json.RawMessage) Result {
	if t == nil {
		t = fallbackTurn()
		if t == nil {
			t = &Turn{}
		}
	}
	if len(args) == 0 || !json.Valid(args) {
		args = json.RawMessage("{}")
	}
	argJSON := string(args)

	summary := DefaultSummary(name, argJSON)
	if t.Summarize != nil {
		summary = t.Summarize(name, argJSON)
	}
	t.notify = func(e Progress) { b.fire(e) }
	ctx = context.WithValue(ctx, turnKey{}, t)

	b.fire(ToolStart{SessionID: t.SessionID, Name: name, Summary: summary})
	start := time.Now()

	var argsMap map[string]any
	if err := json.Unmarshal(args, &argsMap); err != nil || argsMap == nil {
		argsMap = map[string]any{}
	}
	res, err := b.cli.CallTool(ctx, mcp.CallToolRequest{
		Params: mcp.CallToolParams{Name: name, Arguments: argsMap},
	})

	result := Result{Name: name}
	switch {
	case err != nil:
		// Protocol-level failure. An unknown tool teaches the model the
		// armed list; a KNOWN tool failing at the protocol level is the
		// bus-failure signal — the chat loop degrades to direct
		// in-process dispatch (the native fallback) for that call.
		result.IsError = true
		result.BusFailure = defByName(name) != nil
		if !result.BusFailure {
			result.Text = "error: unknown tool \"" + name + "\". Valid tools: " + b.armedToolList(t) + "."
		} else {
			result.Text = "error: the tool bus failed to execute " + name + " — " + err.Error()
		}
	default:
		text, isErr := extractToolText(res)
		result.Text = text
		result.IsError = isErr
		result.Sources = drainSources(t)
		result.Artifact = detectArtifact(argJSON, text)
	}

	b.fire(ToolEnd{
		SessionID:  t.SessionID,
		Name:       name,
		Text:       result.Text,
		IsError:    result.IsError,
		Artifact:   result.Artifact,
		Sources:    result.Sources,
		DurationMS: time.Since(start).Milliseconds(),
	})
	return result
}

// armedToolList lists the tools valid for this turn (the armed gates +
// the always-on set) — the teaching text for hallucinated calls.
func (b *Bus) armedToolList(t *Turn) string {
	var names []string
	b.mu.RLock()
	for name := range b.external {
		names = append(names, name)
	}
	b.mu.RUnlock()
	for i := range defs {
		d := &defs[i]
		switch d.Gate {
		case GateHublib:
			if t.Hublib == nil {
				continue
			}
		case GateSkills:
			if t.Skills == nil {
				continue
			}
		case GatePersona:
			if t.Persona == nil {
				continue
			}
		case GateWorkspace:
			if t.Workspace == nil {
				continue
			}
		case GateDelegate:
			if t.Delegate == nil {
				continue
			}
		}
		names = append(names, d.Name)
	}
	return strings.Join(names, ", ")
}

// drainSources takes the citations the handler accumulated.
func drainSources(t *Turn) []Source {
	if t == nil || len(t.sources) == 0 {
		return nil
	}
	s := t.sources
	t.sources = nil
	return s
}

// detectArtifact ports the v0.22 contract: a file tool whose
// observation says "Saved as artifact " reports the artifact name (the
// arg's name) so the UI renders a real download card on the pill.
func detectArtifact(argJSON, text string) string {
	if !strings.Contains(text, "Saved as artifact ") {
		return ""
	}
	var fargs struct {
		Name string `json:"name"`
	}
	_ = json.Unmarshal([]byte(argJSON), &fargs)
	return fargs.Name
}

// extractToolText joins a CallToolResult's text contents.
func extractToolText(res *mcp.CallToolResult) (string, bool) {
	if res == nil {
		return "error: empty tool result", true
	}
	var b strings.Builder
	for _, c := range res.Content {
		if tc, ok := mcp.AsTextContent(c); ok {
			if b.Len() > 0 {
				b.WriteString("\n")
			}
			b.WriteString(tc.Text)
		}
	}
	return b.String(), res.IsError
}

// ── observers + hooks ───────────────────────────────────────────────

// AddObserver registers a tool-call lifecycle observer (the hooks the
// ACTION path never had). The llm layer's observer emits the ChatChunk
// events; the OTel bot's observer can stack after it.
func (b *Bus) AddObserver(o Observer) {
	if o == nil {
		return
	}
	b.mu.Lock()
	b.observers = append(b.observers, o)
	b.mu.Unlock()
}

// fire dispatches one lifecycle event to every observer. Observers run
// synchronously in registration order — the llm observer emits the
// ChatChunk events in exactly the order the old executeAction did.
func (b *Bus) fire(e interface{ event() }) {
	b.mu.RLock()
	observers := b.observers
	b.mu.RUnlock()
	for _, o := range observers {
		switch ev := e.(type) {
		case ToolStart:
			o.OnToolStart(ev)
		case ToolEnd:
			o.OnToolEnd(ev)
		case Progress:
			o.OnProgress(ev)
		}
	}
}

// ── accessors + lifecycle ───────────────────────────────────────────

// Hooks exposes the mcp-go server hooks (AddBeforeCallTool,
// AddAfterCallTool, AddOnError, …) — the PROTOCOL-level instrumentation
// surface. The OTel bot (or the otel submodule) stacks spans here;
// these fire for every tools/call the server serves, including future
// external /mcp consumers, independent of the app-level Observers.
func (b *Bus) Hooks() *server.Hooks { return b.hooks }

// Server exposes the MCPServer (Phase 4 mounts it on the engine mux at
// /mcp for external consumers).
func (b *Bus) Server() *server.MCPServer { return b.srv }

// Close shuts the in-process client down.
func (b *Bus) Close() error {
	if b.cli != nil {
		return b.cli.Close()
	}
	return nil
}
