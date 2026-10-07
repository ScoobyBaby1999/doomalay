package llm

import (
	"context"
	"encoding/json"
	"log"

	"github.com/ScoobyBaby1999/doomalay/engine/internal/mcpbus"
)

// mcpbridge.go — v1.13.2 THE HANDOFF (PLAN-V113 §2).
//
// The chat loop's wiring to the mcpbus: the Turn (per-request closures),
// the Gates (the closure-armed tool set), and busExecute — the
// executeAction twin that runs every tool call through the REAL MCP
// protocol and emits the exact ChatChunk sequence the old path emitted
// (tool_use pill → sources → tool_result card).
//
// The fallback ladder (the user's spec: "native tool calling as
// fallbacks"): if the MCP protocol layer itself fails, the turn
// stickily degrades to the direct in-process dispatch (executeAction —
// the native fallback) for the rest of the turn.

var mcpBusWarned bool

// mcpGates derives the armed-tool gates from the request's closures —
// exactly the nativeToolSpecs gating, now in one place.
func mcpGates(req ChatRequest) mcpbus.Gates {
	return mcpbus.Gates{
		Hublib:    req.HublibToolFn != nil,
		Skills:    req.SkillsToolFn != nil,
		Persona:   req.PersonaToolFn != nil,
		Workspace: req.WorkspaceToolFn != nil,
		Delegate:  req.DelegateFn != nil,
	}
}

// mcpTurnFor builds the per-turn execution context: every ChatRequest
// closure bridges onto the mcpbus Turn, the chat channel becomes the
// progress emitter. Observation text shapes are TODAY's exact shapes
// (the handlers and the fallback path agree byte-for-byte).
func mcpTurnFor(req ChatRequest, ch chan<- ChatChunk) *mcpbus.Turn {
	return &mcpbus.Turn{
		SessionID: req.SessionID,
		RunLocal: func(ctx context.Context, name, argJSON string, sink mcpbus.ArtifactSink) string {
			return RunLocalTool(name, argJSON, sink)
		},
		Sink: req.ArtifactSink,
		Search: func(ctx context.Context, query string) (string, []mcpbus.Source, error) {
			results, err := WebSearch(ctx, query, 5, req.TavilyKey)
			if err != nil {
				return "", nil, err
			}
			obs := FormatSearchResults(results)
			if obs == "" {
				// v0.27.1: "no results" for a specific named project usually
				// means private/nonexistent; say that so the model stops
				// instead of re-searching.
				obs = "(no results — try different terms; a specific named project or account may be private or nonexistent, in which case say so instead of retrying)"
			}
			return obs, toBusSources(results), nil
		},
		Fetch: func(ctx context.Context, url string) (string, error) {
			return WebFetch(ctx, url, 12000)
		},
		TemplateAuto:  req.TemplateAuto,
		TemplateList:  func(ctx context.Context) string { return runTemplateList(ctx, req) },
		TemplateShow:  func(ctx context.Context, id string) string { return runTemplateShow(ctx, req, id) },
		Persona:       req.PersonaToolFn,
		Hublib:        req.HublibToolFn,
		Skills:        req.SkillsToolFn,
		Workspace:     req.WorkspaceToolFn,
		Delegate:      req.DelegateFn,
		ProgressTo: func(text string) {
			ch <- ChatChunk{Type: "progress", Text: text}
		},
	}
}

// busExecute runs ONE tool call through the MCP bus and emits the
// ChatChunk sequence (the executeAction emission contract):
// tool_use → sources (web tools) → tool_result (+artifact card).
// Returns the observation (OBSERVATION-prefixed, the today shape) and
// whether the turn should degrade to direct dispatch (bus failure).
func busExecute(ctx context.Context, bus *mcpbus.Bus, turn *mcpbus.Turn, ch chan<- ChatChunk, action, argJSON string, allSources *[]SearchResult) (observation string, degraded bool) {
	summary := mcpbus.DefaultSummary(action, argJSON)
	ch <- ChatChunk{Type: "tool_use", Name: action, Summary: summary}
	res := bus.CallTool(ctx, turn, action, json.RawMessage(argJSON))
	if res.BusFailure {
		// The MCP protocol layer itself failed: serve the honest error
		// (the model self-corrects next round) and degrade the turn —
		// the remaining calls run the direct in-process dispatch.
		return "OBSERVATION:\n" + res.Text, true
	}
	if len(res.Sources) > 0 {
		srcs := fromBusSources(res.Sources)
		*allSources = append(*allSources, srcs...)
		ch <- ChatChunk{Type: "sources", Sources: srcs}
	}
	resChunk := ChatChunk{Type: "tool_result", Text: clamp(res.Text, 600), Name: action}
	if res.Artifact != "" {
		resChunk.Artifact = map[string]any{"name": res.Artifact}
	}
	ch <- resChunk
	return "OBSERVATION:\n" + res.Text, false
}

// mcpBus returns the process-wide bus (nil when unavailable — callers
// run the direct dispatch; the warning fires once).
func mcpBus() *mcpbus.Bus {
	bus, err := mcpbus.Default()
	if err != nil {
		if !mcpBusWarned {
			mcpBusWarned = true
			log.Printf("mcpbus unavailable — tool calls run the direct dispatch: %v", err)
		}
		return nil
	}
	return bus
}

func toBusSources(results []SearchResult) []mcpbus.Source {
	if len(results) == 0 {
		return nil
	}
	out := make([]mcpbus.Source, len(results))
	for i, r := range results {
		out[i] = mcpbus.Source{Title: r.Title, URL: r.URL, Snippet: r.Snippet}
	}
	return out
}

func fromBusSources(sources []mcpbus.Source) []SearchResult {
	if len(sources) == 0 {
		return nil
	}
	out := make([]SearchResult, len(sources))
	for i, s := range sources {
		out[i] = SearchResult{Title: s.Title, URL: s.URL, Snippet: s.Snippet}
	}
	return out
}

// init registers the session-less fallback Turn external /mcp consumers
// get (v1.13.4 THE CHAIN): local + web tools run exactly like the PM
// bridge's /api/tools/* contract (no session, no keys beyond the live
// ladder); session-scoped tools (persona/hublib/skills/workspace/
// delegate, templates) refuse honestly.
func init() {
	mcpbus.SetFallbackTurn(func() *mcpbus.Turn {
		return &mcpbus.Turn{
			SessionID: "external",
			RunLocal: func(ctx context.Context, name, argJSON string, sink mcpbus.ArtifactSink) string {
				return RunLocalTool(name, argJSON, sink)
			},
			Search: func(ctx context.Context, query string) (string, []mcpbus.Source, error) {
				results, err := WebSearch(ctx, query, 5, "")
				if err != nil {
					return "", nil, err
				}
				obs := FormatSearchResults(results)
				if obs == "" {
					obs = "(no results — try different terms; a specific named project or account may be private or nonexistent, in which case say so instead of retrying)"
				}
				return obs, toBusSources(results), nil
			},
			Fetch: func(ctx context.Context, url string) (string, error) {
				return WebFetch(ctx, url, 12000)
			},
		}
	})
}
