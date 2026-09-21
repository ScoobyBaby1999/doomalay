package llm

// nativetools.go — v0.38 NATIVE FUNCTION CALLING for the direct proxy path.
//
// WHY: the ACTION text protocol (chat.go's ReAct loop) asks the MODEL to
// hand-write `ACTION: zip_create {"name": …, "files": […]}` as prose — and
// models routinely emit JSON with missing commas, smart quotes, or glued
// fragments (the live nemotron/zip_create failure: "arguments must be a
// JSON object — invalid character '"' after object key:value pair"). With
// native OpenAI-style function calling the provider TOKENIZES the arguments
// into a structured tool_calls field — malformed JSON is impossible by
// construction, the arguments stream in validated fragments, and the model
// can never "forget" the protocol shape.
//
// Design:
//   - Chat() routes plain + web-search turns here when the provider is on
//     the native allowlist (OpenAI-compatible hosts with function calling).
//   - The turn runs the SAME tool set (localtools + web + delegate) with
//     the SAME executeAction() — identical pills, observations, artifacts.
//   - A provider that rejects tools with a 400 is blacklisted for this
//     engine's lifetime and the turn falls back to the ACTION protocol —
//     zero user-visible difference.
//   - Deep research keeps its scripted pipeline (P9 makes it pill-emitting).

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"sync"
)

// nativeCall is one complete assembled tool call (arguments accumulated
// from streamed deltas by scanSSECollect).
type nativeCall struct {
	ID        string
	Name      string
	Arguments string
}

// errToolsRejected is the sentinel for "provider 400'd a tools-bearing
// request" — suppressed from the UI, triggers the ACTION-protocol fallback.
var errToolsRejected = fmt.Errorf("provider rejected native tools")

var (
	nativeToolsMu        sync.Mutex
	nativeToolsBlacklist = map[string]bool{}
)

// blacklistNativeTools remembers a provider that 400'd tools.
func blacklistNativeTools(provider string) {
	nativeToolsMu.Lock()
	nativeToolsBlacklist[normalizeProviderName(provider)] = true
	nativeToolsMu.Unlock()
}

// toolsRejectedBody sniffs a 400 body for tools/function-calling mentions.
func toolsRejectedBody(body string) bool {
	b := strings.ToLower(body)
	return strings.Contains(b, "tool") || strings.Contains(b, "function")
}

// nativeToolProviders: hosts speaking OpenAI-compatible function calling
// (mirrors brain/provider_quirks.json's tools:true set). privatemodeai is
// excluded (E2E browser path), cloudflare is per-model, anthropic speaks a
// different wire protocol.
var nativeToolProviders = map[string]bool{
	"nvidia":        true,
	"opencode":      true,
	"opencode-zen":  true,
	"opencode-go":   true,
	"openrouter":    true,
	"github-models": true,
	"groq":          true,
	"together":      true,
	"mistral":       true,
	"deepseek":      true,
	"openai":        true,
	"together_ai":   true,
}

func normalizeProviderName(p string) string {
	p = strings.ToLower(strings.TrimSpace(p))
	// the catalog uses both spellings across builds
	switch p {
	case "opencode-zen":
		return "opencode"
	case "together_ai", "togetherai":
		return "together"
	}
	return p
}

// SupportsNativeTools reports whether this provider's direct-proxy turns
// should run the native function-calling loop.
func SupportsNativeTools(provider string) bool {
	if provider == "" {
		return false
	}
	nativeToolsMu.Lock()
	blocked := nativeToolsBlacklist[normalizeProviderName(provider)]
	nativeToolsMu.Unlock()
	if blocked {
		return false
	}
	return nativeToolProviders[normalizeProviderName(provider)]
}

// ── the tool manifest (the ACTION protocol's tool set, structured) ──────

type jsonSchemaProp struct {
	Type        string   `json:"type"`
	Description string   `json:"description,omitempty"`
	Items       *json.RawMessage `json:"items,omitempty"`
	Enum        []string `json:"enum,omitempty"`
}

func strProp(desc string) jsonSchemaProp {
	return jsonSchemaProp{Type: "string", Description: desc}
}

func nativeToolSpec(name, desc string, props map[string]jsonSchemaProp, required ...string) map[string]any {
	return map[string]any{
		"type": "function",
		"function": map[string]any{
			"name":        name,
			"description": desc,
			"parameters": map[string]any{
				"type":       "object",
				"properties": props,
				"required":   required,
			},
		},
	}
}

// nativeToolSpecs builds the manifest for a turn (web tools when enabled).
func nativeToolSpecs(req ChatRequest) []map[string]any {
	specs := []map[string]any{
		nativeToolSpec("calculator", "Evaluate a math expression and return the result.", map[string]jsonSchemaProp{
			"expr": strProp("The expression to evaluate, e.g. '2+2*10'."),
		}, "expr"),
		nativeToolSpec("time_now", "Current date/time (optionally in a named IANA timezone).", map[string]jsonSchemaProp{
			"tz": strProp("IANA timezone like 'UTC' or 'Asia/Beirut'. Empty = local."),
		}),
		nativeToolSpec("uuid", "Generate UUIDs.", map[string]jsonSchemaProp{
			"count": {Type: "number", Description: "How many UUIDs (default 1)."},
		}),
		nativeToolSpec("random", "Random integers.", map[string]jsonSchemaProp{
			"min":    {Type: "number", Description: "Inclusive minimum."},
			"max":    {Type: "number", Description: "Inclusive maximum."},
			"count":  {Type: "number", Description: "How many (default 1)."},
			"unique": {Type: "boolean", Description: "Distinct values only."},
		}),
		nativeToolSpec("base64", "Base64 encode/decode text.", map[string]jsonSchemaProp{
			"mode": {Type: "string", Description: "'encode' or 'decode'.", Enum: []string{"encode", "decode"}},
			"text": strProp("The input text."),
		}, "text"),
		nativeToolSpec("url_encode", "URL percent-encode/decode text.", map[string]jsonSchemaProp{
			"mode": {Type: "string", Description: "'encode' or 'decode'.", Enum: []string{"encode", "decode"}},
			"text": strProp("The input text."),
		}, "text"),
		nativeToolSpec("hash", "Hash text (md5, sha1, sha256, sha512).", map[string]jsonSchemaProp{
			"algo": {Type: "string", Description: "Algorithm.", Enum: []string{"md5", "sha1", "sha256", "sha512"}},
			"text": strProp("The input text."),
		}, "algo", "text"),
		nativeToolSpec("json_tool", "Validate/pretty/minify JSON text.", map[string]jsonSchemaProp{
			"mode": {Type: "string", Description: "'pretty', 'minify' or 'validate'.", Enum: []string{"pretty", "minify", "validate"}},
			"text": strProp("The JSON text."),
		}, "text"),
		nativeToolSpec("text_stats", "Statistics about text (words, chars, lines…).", map[string]jsonSchemaProp{
			"text": strProp("The input text."),
		}, "text"),
		nativeToolSpec("regex_extract", "Extract regex matches from text.", map[string]jsonSchemaProp{
			"pattern": strProp("The regular expression."),
			"text":    strProp("The input text."),
			"group":   {Type: "number", Description: "Capture group to return (0 = whole match)."},
		}, "pattern", "text"),
	}
	// file tools — the artifact producers
	specs = append(specs,
		nativeToolSpec("docx_create", "Create a .docx document from structured blocks and save it as a downloadable artifact.", map[string]jsonSchemaProp{
			"name":   strProp("File name, e.g. 'report.docx'."),
			"blocks": {Type: "array", Description: "Ordered blocks: {\"type\":\"heading|paragraph|bullet\",\"text\":\"…\"}."},
		}, "name", "blocks"),
		nativeToolSpec("xlsx_create", "Create a .xlsx spreadsheet and save it as a downloadable artifact.", map[string]jsonSchemaProp{
			"name":   strProp("File name, e.g. 'data.xlsx'."),
			"sheets": {Type: "array", Description: "Sheets: {\"name\":\"…\",\"rows\":[[cell,…],…]}."},
		}, "name", "sheets"),
		nativeToolSpec("zip_create", "Create a .zip archive from files (each {name, content}) and save it as a downloadable artifact.", map[string]jsonSchemaProp{
			"name": strProp("Archive file name, e.g. 'exercise.zip'."),
			"files": {Type: "array", Description: "Files: [{\"name\":\"path/file.txt\",\"content\":\"text content\"}]. Content is plain text (UTF-8)."},
		}, "name", "files"),
		nativeToolSpec("zip_extract", "List or extract a .zip artifact (pass the artifact name).", map[string]jsonSchemaProp{
			"artifact": strProp("Name of a saved .zip artifact to open."),
			"b64":      strProp("OR base64 zip bytes directly."),
		}),
		nativeToolSpec("archive_create", "Create an archive (.zip/.tar.gz/.7z…) from files and save it as a downloadable artifact.", map[string]jsonSchemaProp{
			"name":  strProp("Archive file name with extension."),
			"files": {Type: "array", Description: "Files: [{\"name\":\"path\",\"content\":\"text\"}] or {\"name\":\"…\",\"b64\":\"…\"}."},
		}, "name"),
		nativeToolSpec("archive_extract", "Extract any archive artifact (zip/7z/rar/tar/gz…).", map[string]jsonSchemaProp{
			"artifact": strProp("Name of a saved archive artifact."),
			"b64":      strProp("OR base64 archive bytes."),
		}),
	)
	// web tools when enabled
	if req.WebSearch {
		specs = append(specs,
			nativeToolSpec("web_search", "Search the live web and return ranked results (titles, URLs, snippets).", map[string]jsonSchemaProp{
				"query": strProp("The search query."),
			}, "query"),
			nativeToolSpec("web_fetch", "Fetch a web page and return its readable text content.", map[string]jsonSchemaProp{
				"url": strProp("The absolute https:// URL."),
			}, "url"),
		)
	}
	// delegate when armed
	if req.DelegateFn != nil {
		specs = append(specs, nativeToolSpec("delegate", "Consult up to 3 other models in parallel and get their answers.", map[string]jsonSchemaProp{
			"prompt": strProp("The question to ask the other models."),
			"models": {Type: "array", Description: "Optional provider/model ids to consult."},
		}, "prompt"))
	}
	return specs
}

// wireToolCall is the OpenAI wire shape for an assistant tool_calls entry.
type wireToolCall struct {
	ID       string `json:"id"`
	Type     string `json:"type"`
	Function struct {
		Name      string `json:"name"`
		Arguments string `json:"arguments"`
	} `json:"function"`
}

// ── the turn ────────────────────────────────────────────────────────────

// runNativeToolsTurn runs the native function-calling loop: stream a round,
// execute any tool_calls via the SAME executeAction (same pills, artifacts,
// observations), feed the results back as role:"tool" messages, repeat until
// a round produces no calls (the final answer, already streamed live).
func runNativeToolsTurn(ctx context.Context, ch chan<- ChatChunk, errs chan<- error, req ChatRequest) {
	ch <- ChatChunk{Type: "status", State: "running"}

	specs := nativeToolSpecs(req)
	history := make([]Message, len(req.Messages))
	copy(history, req.Messages)

	var allSources []SearchResult
	var totalUsage *Usage
	const maxRounds = 16

	for round := 0; round < maxRounds; round++ {
		roundReq := req
		roundReq.Messages = history
		extra := map[string]any{
			"tools":       specs,
			"tool_choice": "auto",
		}
		usage, calls, err := scanSSECollect(ctx, roundReq, extra, ch, func(reasoning, content string) {
			if reasoning != "" {
				ch <- ChatChunk{Type: "thinking", Text: reasoning}
			}
			if content != "" {
				ch <- ChatChunk{Type: "assistant_delta", Text: content}
			}
		})
		if err == errToolsRejected {
			// provider can't do tools — rerun the turn on the ACTION protocol
			runWebSearchTurn(ctx, ch, errs, req)
			return
		}
		if err != nil {
			errs <- err
			return
		}
		totalUsage = mergeUsage(totalUsage, usage)
		if len(calls) == 0 {
			// final answer — already streamed. Emit accumulated sources.
			if len(allSources) > 0 {
				ch <- ChatChunk{Type: "sources", Sources: allSources}
			}
			ch <- ChatChunk{Type: "status", State: "idle", Usage: totalUsage}
			return
		}

		// normalize + validate the calls, then execute in order
		wire := make([]wireToolCall, 0, len(calls))
		for _, c := range calls {
			args := strings.TrimSpace(c.Arguments)
			if args == "" {
				args = "{}"
			}
			if !json.Valid([]byte(args)) {
				// belt-and-suspenders: repair truncated streamed JSON
				if fixed := repairJSON(args); json.Valid([]byte(fixed)) {
					args = fixed
				} else if fixed := lenientJSON(repairJSON(args)); json.Valid([]byte(fixed)) {
					args = fixed
				} else {
					// unrecoverable — tell the model via the tool result
					ch <- ChatChunk{Type: "tool_use", Name: c.Name, Summary: "(malformed arguments)"}
					ch <- ChatChunk{Type: "tool_result", Text: "error: arguments arrived malformed — re-emit the call", Name: c.Name}
					wire = append(wire, wireToolCall{ID: c.ID, Type: "function"})
					wire[len(wire)-1].Function.Name = c.Name
					wire[len(wire)-1].Function.Arguments = args
					continue
				}
			}
			wire = append(wire, wireToolCall{ID: c.ID, Type: "function"})
			wire[len(wire)-1].Function.Name = c.Name
			wire[len(wire)-1].Function.Arguments = args
		}

		// assistant message carrying the structured calls (for the next round)
		callsJSON, _ := json.Marshal(wire)
		history = append(history, Message{Role: "assistant", ToolCalls: callsJSON})

		// execute + append role:"tool" results
		for _, c := range wire {
			observation := executeAction(ctx, req, ch, c.Function.Name, c.Function.Arguments, &allSources)
			// strip the protocol prefix — the wire tool message is plain content
			obs := strings.TrimPrefix(observation, "OBSERVATION:\n")
			history = append(history, Message{
				Role:       "tool",
				ToolCallID: c.ID,
				Name:       c.Function.Name,
				Content:    clamp(obs, 24000),
			})
		}
	}

	// Budget exhausted — force a final answer without tools.
	history = append(history, Message{Role: "user", Content: "Tool budget reached. Write your FINAL answer now."})
	finalReq := req
	finalReq.Messages = history
	final, err := streamCompletion(ctx, finalReq, ch, nil)
	if err != nil {
		errs <- err
		return
	}
	totalUsage = mergeUsage(totalUsage, final)
	if len(allSources) > 0 {
		ch <- ChatChunk{Type: "sources", Sources: allSources}
	}
	ch <- ChatChunk{Type: "status", State: "idle", Usage: totalUsage}
}

// ── v0.38 MODEL-GONE FALLBACK ROUTING ───────────────────────────────────
//
// Live-observed (NVIDIA NIM): models get DEPROVISIONED mid-session — the
// provider answers 404 "Function …: Not found for account …" (during this
// release's own testing: lightning, kimi-k2.6, nemotron-51b and nemotron-340b
// all vanished between runs). The turn used to die with "this model is no
// longer available — pick another model". Now: the SAME logical model is
// looked up in the catalog, and the next key-backed host takes the turn
// (one rotation per turn, announced as a progress pill).

// ResolveModelAlternate finds another provider hosting the same logical
// model as (userModel, userProvider) and resolves ITS credentials.
func ResolveModelAlternate(userModel, userProvider string, keys map[string]string) (model, baseURL, envVar, apiKey, authStyle, altProvider string, ok bool) {
	if keys == nil || userModel == "" || userProvider == "" {
		return "", "", "", "", "", "", false
	}
	// The user-facing id is "provider/modelId" — find the logical entry
	// whose hosts include THIS route.
	cat := BuildCatalogV2(keys, false)
	stripped := strings.TrimPrefix(userModel, userProvider+"/")
	for _, lm := range cat.Logical {
		for _, h := range lm.Hosts {
			if h.Provider != userProvider || h.ModelID != stripped {
				continue
			}
			// found OUR route — pick the next key-backed alternate host
			for _, alt := range lm.Hosts {
				if alt.Provider == userProvider {
					continue
				}
				m, bu, ev, ak, as, err := ResolveModel(alt.Provider+"/"+alt.ModelID, alt.Provider, keys)
				if err == nil && ak != "" {
					return m, bu, ev, ak, as, alt.Provider, true
				}
			}
			return "", "", "", "", "", "", false
		}
	}
	return "", "", "", "", "", "", false
}

// modelGoneBody sniffs a 404/410 body for deprovisioning language.
func modelGoneBody(body string) bool {
	b := strings.ToLower(body)
	return strings.Contains(b, "not found for account") ||
		strings.Contains(b, "no longer available") ||
		strings.Contains(b, "does not exist") ||
		strings.Contains(b, "decommission") ||
		strings.Contains(b, "model not found") ||
		strings.Contains(b, "not available")
}
