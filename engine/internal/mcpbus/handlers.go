package mcpbus

import (
	"context"
	"encoding/json"
	"strings"

	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"
)

// handlers.go — v1.13.1 THE BUS: the MCP tool handlers (PLAN-V113 §1).
//
// One handler per Def, built once at registration. Each handler reads
// the Turn from ctx (the in-process transport passes ctx values
// straight through), validates arguments the way today's
// executeAction did (the same error strings, so models self-correct
// identically), executes through the Turn's closures and returns the
// observation text. No ACTION parsing exists anywhere on this path.

// buildMCPTool projects a Def into an mcp.Tool (real JSON Schema).
func buildMCPTool(d *Def) mcp.Tool {
	opts := []mcp.ToolOption{mcp.WithDescription(d.Desc)}
	for _, p := range d.Props {
		po := []mcp.PropertyOption{mcp.Description(p.Prop.Desc)}
		if p.Prop.Required {
			po = append(po, mcp.Required())
		}
		if len(p.Prop.Enum) > 0 {
			po = append(po, mcp.Enum(p.Prop.Enum...))
		}
		switch p.Prop.Kind {
		case PropString:
			opts = append(opts, mcp.WithString(p.Key, po...))
		case PropNumber:
			opts = append(opts, mcp.WithNumber(p.Key, po...))
		case PropBoolean:
			opts = append(opts, mcp.WithBoolean(p.Key, po...))
		case PropArray:
			opts = append(opts, mcp.WithArray(p.Key, po...))
		}
	}
	return mcp.NewTool(d.Name, opts...)
}

// localTools is the IsLocalTool set (the RunLocal dispatch names).
var localTools = map[string]bool{
	"calculator": true, "time_now": true, "uuid": true, "random": true,
	"base64": true, "hash": true, "json_tool": true, "text_stats": true,
	"url_encode": true, "regex_extract": true,
	"docx_create": true, "xlsx_create": true, "zip_create": true,
	"zip_extract": true, "archive_create": true, "archive_extract": true,
}

// personaTools is the Persona dispatch set.
var personaTools = map[string]bool{
	"persona_list": true, "persona_set": true,
	"persona_activate": true, "placeholder_set": true,
}

// handlerFor builds the MCP handler for one Def.
func handlerFor(d *Def) server.ToolHandlerFunc {
	return func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		t := TurnFromContext(ctx)
		if t == nil {
			// v1.13.4: an external /mcp consumer (no chat turn) gets the
			// session-less fallback Turn — local + web tools run exactly
			// like the PM bridge's /api/tools/* contract; session-scoped
			// tools refuse honestly.
			t = fallbackTurn()
			if t == nil {
				return mcp.NewToolResultError("error: this tool call reached the bus without a session turn"), nil
			}
		}
		argJSON := argsJSON(req)
		switch {
		case localTools[d.Name]:
			if t.RunLocal == nil {
				return mcp.NewToolResultError("error: local tools are not armed for this turn"), nil
			}
			return textResult(t.RunLocal(ctx, d.Name, argJSON, t.Sink)), nil

		case d.Name == "web_search":
			q := argString(argJSON, "query")
			if q == "" {
				return mcp.NewToolResultError("error: empty query"), nil
			}
			if t.Search == nil {
				return mcp.NewToolResultError("error: web search is not armed for this turn"), nil
			}
			text, sources, err := t.Search(ctx, q)
			if err != nil {
				return mcp.NewToolResultError("search error: " + err.Error()), nil
			}
			if len(sources) > 0 {
				t.sources = append(t.sources, sources...)
			}
			return mcp.NewToolResultText(text), nil

		case d.Name == "web_fetch":
			u := argString(argJSON, "url")
			if u == "" {
				return mcp.NewToolResultError("error: empty url"), nil
			}
			if t.Fetch == nil {
				return mcp.NewToolResultError("error: web fetch is not armed for this turn"), nil
			}
			text, err := t.Fetch(ctx, u)
			if err != nil {
				return mcp.NewToolResultError("fetch error: " + err.Error()), nil
			}
			return mcp.NewToolResultText(text), nil

		case d.Name == "template_list":
			if !t.TemplateAuto {
				return mcp.NewToolResultError("error: the template library is disabled for this chat (the template pill is off). Ask the user to enable the template pill, or answer without it."), nil
			}
			if t.TemplateList == nil {
				return mcp.NewToolResultError("error: the template library is not armed for this turn"), nil
			}
			return textResult(t.TemplateList(ctx)), nil

		case d.Name == "template_show":
			if !t.TemplateAuto {
				return mcp.NewToolResultError("error: the template library is disabled for this chat (the template pill is off). Ask the user to enable the template pill, or answer without it."), nil
			}
			id := argString(argJSON, "id")
			if id == "" {
				return mcp.NewToolResultError(`error: template_show needs {"id": "..."} — get ids from template_list`), nil
			}
			if t.TemplateShow == nil {
				return mcp.NewToolResultError("error: the template library is not armed for this turn"), nil
			}
			return textResult(t.TemplateShow(ctx, id)), nil

		case d.Name == "hublib":
			if t.Hublib == nil {
				return mcp.NewToolResultError("error: the hub library is not armed for this chat (the Bot Library switch may be off)"), nil
			}
			return textResult(t.Hublib(ctx, argJSON)), nil

		case d.Name == "skills":
			if t.Skills == nil {
				return mcp.NewToolResultError("error: the skills library is not armed for this chat"), nil
			}
			return textResult(t.Skills(ctx, argJSON)), nil

		case d.Name == "workspace":
			if t.Workspace == nil {
				return mcp.NewToolResultError("error: the workspace tool is not armed for this chat (no connected repos)"), nil
			}
			return textResult(t.Workspace(ctx, argJSON)), nil

		case personaTools[d.Name]:
			if t.Persona == nil {
				return mcp.NewToolResultError("error: persona tools need a live session on this server"), nil
			}
			return textResult(t.Persona(ctx, d.Name, argJSON)), nil

		case d.Name == "delegate":
			prompt := argString(argJSON, "prompt")
			if prompt == "" {
				return mcp.NewToolResultError(`error: delegate needs {"prompt": "...", "models": ["provider/model", "…"]}`), nil
			}
			if t.Delegate == nil {
				return mcp.NewToolResultError("error: delegate is not armed for this turn"), nil
			}
			t.Progress("consulting other models…")
			var models []string
			if raw, ok := argsMap(argJSON)["models"].([]any); ok {
				for _, m := range raw {
					if s, ok := m.(string); ok {
						models = append(models, s)
					}
				}
			}
			outs := t.Delegate(ctx, prompt, models)
			b, _ := json.Marshal(outs)
			return mcp.NewToolResultText(string(b)), nil
		}
		return mcp.NewToolResultError("error: unhandled tool \"" + d.Name + "\""), nil
	}
}

// textResult strips the OBSERVATION prefix the closure results carry
// (the today shapes) — the MCP result text IS the role:"tool" content.
func textResult(out string) *mcp.CallToolResult {
	return mcp.NewToolResultText(strings.TrimPrefix(out, "OBSERVATION:\n"))
}

// argsJSON re-marshals the call's arguments map — the closures and
// runners parse JSON semantically, so map ordering never matters.
func argsJSON(req mcp.CallToolRequest) string {
	m := req.GetArguments()
	if m == nil {
		return "{}"
	}
	b, err := json.Marshal(m)
	if err != nil {
		return "{}"
	}
	return string(b)
}

// argString pulls one string argument out of the argJSON.
func argString(argJSON, key string) string {
	var m map[string]any
	if json.Unmarshal([]byte(argJSON), &m) != nil {
		return ""
	}
	s, _ := m[key].(string)
	return s
}

// argsMap parses the argJSON (nil-safe).
func argsMap(argJSON string) map[string]any {
	var m map[string]any
	_ = json.Unmarshal([]byte(argJSON), &m)
	return m
}
