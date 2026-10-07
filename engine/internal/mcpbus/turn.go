package mcpbus

import (
	"context"
	"encoding/json"
	"strings"
)

// turn.go — v1.13.1 THE BUS: the per-turn execution context (PLAN-V113 §1).
//
// The Bus is global (one MCPServer per engine process); the Turn is the
// per-chat-turn state. CallTool injects it via ctx values and the
// in-process transport hands the SAME ctx to tool handlers, so
// session-scoped execution (artifacts, persona store, workspace tokens,
// web keys) reaches every handler without any global mutable state.
//
// Every field is a closure the llm package wires from ChatRequest —
// mcpbus stays free of llm types (the import arrow only points one
// way). Closures return observation text in TODAY's exact shapes so
// the model-visible strings are byte-identical through the migration.

// ArtifactSink mirrors llm.ArtifactSink — Go interfaces are structural,
// the llm type satisfies this without knowing about it.
type ArtifactSink interface {
	SaveArtifact(name string, data []byte, source string) (id string, size int64, err error)
	ReadArtifact(name string) ([]byte, error)
}

// Source mirrors llm.SearchResult for citation fanout.
type Source struct {
	Title   string `json:"title"`
	URL     string `json:"url"`
	Snippet string `json:"snippet"`
}

type turnKey struct{}

// Turn carries everything one chat turn's tool executions need.
// Constructed by the llm layer per turn (from ChatRequest), passed to
// Bus.CallTool. Nil-closure fields simply mean the tool honestly
// reports it is not armed for this chat.
type Turn struct {
	SessionID string

	// RunLocal executes the local + file tools (llm.RunLocalTool).
	// Returns the full "OBSERVATION:\n…" text — the today shape.
	RunLocal func(ctx context.Context, name, argJSON string, sink ArtifactSink) string
	Sink     ArtifactSink

	// Search runs one web search. Returns the formatted observation
	// text (no OBSERVATION prefix) and the citation sources. An error
	// yields the honest MCP tool error ("search error: …" — the today
	// text shape, now protocol-true).
	Search func(ctx context.Context, query string) (string, []Source, error)
	// Fetch fetches one URL. Returns the readable text; an error yields
	// the honest MCP tool error ("fetch error: …").
	Fetch func(ctx context.Context, url string) (string, error)

	// TemplateAuto gates the template library (the template pill).
	TemplateAuto bool
	// TemplateList / TemplateShow run the library tools; return the
	// full "OBSERVATION:\n…" text.
	TemplateList func(ctx context.Context) string
	TemplateShow func(ctx context.Context, id string) string

	// Persona runs persona_list/persona_set/persona_activate/
	// placeholder_set (server closure). Returns "OBSERVATION:\n…".
	Persona func(ctx context.Context, name, argJSON string) string
	// Hublib runs the public-hub library tool (server closure).
	Hublib func(ctx context.Context, argJSON string) string
	// Skills runs the installed-skills tool (server closure).
	Skills func(ctx context.Context, argJSON string) string
	// Workspace runs the connected-repos tool (server closure).
	Workspace func(ctx context.Context, argJSON string) string
	// Delegate fans a prompt out to other models (server closure).
	Delegate func(ctx context.Context, prompt string, models []string) []map[string]any

	// Summarize builds the pill text for a tool call. Optional — nil
	// falls back to DefaultSummary (the ported per-category logic).
	Summarize func(name, argJSON string) string

	// ProgressTo is the chat-channel progress emitter the llm layer
	// wires per turn — Turn.Progress fans out to it AND the bus
	// observers (both surfaces see the line).
	ProgressTo func(text string)

	// internal state — owned by the bus, not the llm layer.
	notify    func(e Progress) // set per CallTool; observers
	sources   []Source         // accumulated citations (web_search)
	toolStart int64            // monotonic start for DurationMS
}

// Progress emits an ephemeral progress line mid-execution (long tools
// only) — both the chat channel (ProgressTo) and the bus observers
// see it.
func (t *Turn) Progress(text string) {
	if t == nil {
		return
	}
	if t.ProgressTo != nil {
		t.ProgressTo(text)
	}
	if t.notify != nil {
		t.notify(Progress{SessionID: t.SessionID, Text: text})
	}
}

// fallbackTurnFn builds the session-less Turn external consumers get
// (/mcp callers with no chat turn). Registered by the llm package at
// init (it owns the runners); nil = external callers get honest
// refusals.
var fallbackTurnFn func() *Turn

// SetFallbackTurn registers the session-less external-consumer Turn.
func SetFallbackTurn(fn func() *Turn) { fallbackTurnFn = fn }

func fallbackTurn() *Turn {
	if fallbackTurnFn != nil {
		return fallbackTurnFn()
	}
	return nil
}

// sessionTurnResolver builds a session-bound Turn from a session id —
// registered by the server package (it owns the closures + artifact
// sinks). External /mcp consumers carrying X-Doomalay-Session get
// session-scoped tools (the PM bridge's contract).
var sessionTurnResolver func(sessionID string) *Turn

// SetSessionTurnResolver registers the session-bound Turn builder.
func SetSessionTurnResolver(fn func(sessionID string) *Turn) { sessionTurnResolver = fn }

// ResolveSessionTurn builds the Turn for one session (nil when unknown).
func ResolveSessionTurn(sessionID string) *Turn {
	if sessionTurnResolver == nil || sessionID == "" {
		return nil
	}
	return sessionTurnResolver(sessionID)
}

// ContextWithTurn injects a Turn into a context (the /mcp HTTP layer
// uses it for session-header-bound requests).
func ContextWithTurn(ctx context.Context, t *Turn) context.Context {
	if t == nil {
		return ctx
	}
	return context.WithValue(ctx, turnKey{}, t)
}

// TurnFromContext extracts the Turn the bus injected for this call.
func TurnFromContext(ctx context.Context) *Turn {
	if ctx == nil {
		return nil
	}
	if t, ok := ctx.Value(turnKey{}).(*Turn); ok {
		return t
	}
	return nil
}

// DefaultSummary is the ported per-category pill text — identical to
// summarizeLocalAction + executeAction's inline extraction tables.
func DefaultSummary(name, argJSON string) string {
	var args map[string]any
	_ = json.Unmarshal([]byte(argJSON), &args)
	get := func(k string) string {
		if v, ok := args[k].(string); ok {
			return clampRunes(v, 80)
		}
		return ""
	}
	first := func(keys ...string) string {
		for _, k := range keys {
			if v := get(k); v != "" {
				return v
			}
		}
		return ""
	}
	switch name {
	case "calculator":
		return get("expr")
	case "time_now":
		return get("tz")
	case "hash":
		return get("algo")
	case "base64", "json_tool", "url_encode":
		return get("mode")
	case "regex_extract":
		return get("pattern")
	case "docx_create", "xlsx_create", "zip_create", "zip_extract",
		"archive_create", "archive_extract":
		return get("name")
	case "web_search":
		return get("query")
	case "web_fetch":
		return get("url")
	case "template_list":
		return "browse the template library"
	case "template_show":
		return get("id")
	case "hublib":
		return first("q", "id", "action")
	case "skills":
		return first("skill", "q", "action")
	case "workspace":
		return first("ws", "path", "query", "what", "action")
	case "delegate":
		return clampRunes(get("prompt"), 80)
	case "persona_list":
		return ""
	case "persona_set", "persona_activate":
		return first("name", "id", "from")
	case "placeholder_set":
		return first("key", "value")
	}
	return ""
}

// clampRunes clamps s to at most n runes (the old clamp's shape).
func clampRunes(s string, n int) string {
	if n <= 0 {
		return ""
	}
	r := []rune(strings.TrimSpace(s))
	if len(r) <= n {
		return string(r)
	}
	return string(r[:n])
}
