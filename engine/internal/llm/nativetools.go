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
        Type        string           `json:"type"`
        Description string           `json:"description,omitempty"`
        Items       *json.RawMessage `json:"items,omitempty"`
        Enum        []string         `json:"enum,omitempty"`
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
                        "name":  strProp("Archive file name, e.g. 'exercise.zip'."),
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
        // web tools — v0.44: ALWAYS in the manifest (the self-enable spec:
        // the model may call web_search/web_fetch whenever it needs live
        // facts; req.WebSearch now only gates the OpenRouter provider-side
        // search path in runWebSearchTurn). Providers that 400 on tools
        // already fall back to the ACTION protocol (errToolsRejected).
        specs = append(specs,
                nativeToolSpec("web_search", "Search the live web and return ranked results (titles, URLs, snippets).", map[string]jsonSchemaProp{
                        "query": strProp("The search query."),
                }, "query"),
                nativeToolSpec("web_fetch", "Fetch a web page and return its readable text content.", map[string]jsonSchemaProp{
                        "url": strProp("The absolute https:// URL."),
                }, "url"),
        )
        // v0.44 TEMPLATE SELF-SERVE: browse the app's method-template
        // library (same ACTION tools; executeAction runs them).
        specs = append(specs,
                nativeToolSpec("template_list", "List the app's method-template library (ids, names, stage counts).", map[string]jsonSchemaProp{}),
                nativeToolSpec("template_show", "Show one method template's full methodology (stages with instructions, or the markdown discipline).", map[string]jsonSchemaProp{
                        "id": strProp("The template id from template_list."),
                }, "id"),
        )
        // v0.67.2 + v0.72 + v0.73: THE LIBRARY — the public hub (ALL SIX item
        // types: templates, skills, scripts, docs, personas, themes) AND its
        // BUNDLES (curated collections), browsable + downloadable on the fly.
        // Same runner as the ACTION protocol path (executeAction routes it to
        // the server's hublibDispatch; the two chat switches — Bot Library
        // and Can download bundles — gate use/downloads).
        if req.HublibToolFn != nil {
                specs = append(specs,
                        nativeToolSpec("hublib", "Search/browse/download the PUBLIC HUB — the community library of templates, skills, scripts, docs, personas, themes (every single item is a bundle of one) AND BUNDLES (curated collections). Bundle detail lists every member's when-to-use description; browse before using, pick the member that fits, never the whole bundle at once.", map[string]jsonSchemaProp{
                                "action": {Type: "string", Description: "'bundles' (list collections, narrow with q/tag), 'bundle' (one bundle's members + when-to-use descriptions), 'download_bundle' (download every member), 'search' (browse items), 'get' (one item's detail + payload head) or 'download'.", Enum: []string{"bundles", "bundle", "download_bundle", "search", "get", "download"}},
                                "q":      strProp("Search query (search/bundles; empty = newest)."),
                                "tag":    strProp("Badge tag filter (bundles only)."),
                                "type":   {Type: "string", Description: "Library type.", Enum: []string{"template", "skill", "script", "doc", "persona", "theme"}},
                                "repo":   strProp("The item's repo (get/download, from a search result)."),
                                "id":     strProp("The item's or bundle's id (get/download/download_bundle/bundle, from a result)."),
                        }, "action"),
                )
        }
        // v0.72: THE SKILLS HAND — the downloaded skill methodologies
        // (bootstrap the superpowers discipline, list/search, load +
        // follow, read companion files).
        if req.SkillsToolFn != nil {
                specs = append(specs,
                        nativeToolSpec("skills", "The installed SKILLS LIBRARY — downloadable methodologies (e.g. superpowers). bootstrap loads the selection discipline; load arms one skill's full methodology to FOLLOW for the work it covers; descriptions state when each fires.", map[string]jsonSchemaProp{
                                "action": {Type: "string", Description: "'bootstrap' (the skill discipline), 'list', 'search', 'load' (arm + follow a skill), 'files' or 'read'.", Enum: []string{"bootstrap", "list", "search", "load", "files", "read"}},
                                "skill":  strProp("The skill name (load/files/read; from list/search)."),
                                "q":      strProp("Search query (search only)."),
                                "path":   strProp("Companion file path (files/read only)."),
                        }, "action"),
                )
        }
        // v0.73: THE PERSONA HAND on the native path — the self-management
        // tools were ACTION-protocol-only (v0.28), so native-function-calling
        // providers (NVIDIA & friends) could only WRITE "ACTION: persona_set"
        // as prose (observed live in the red team). The manifest entry makes
        // them real tool_calls; executeAction routes them to PersonaToolFn.
        if req.PersonaToolFn != nil {
                specs = append(specs,
                        nativeToolSpec("persona_list", "List YOUR personas and placeholders in this chat (id, name, mode, preview) — includes the hub personas you could import.", map[string]jsonSchemaProp{}),
                        nativeToolSpec("persona_set", "Create, edit or import a persona. Omit id to create; {\"from\": \"<hub persona name>\", \"activate\": true} imports a DOWNLOADED library persona and makes it the active one (you become it); activate:true makes any target the one always-active persona.", map[string]jsonSchemaProp{
                                "id":       strProp("An existing persona id (edit)."),
                                "name":     strProp("The persona's name."),
                                "text":     strProp("The persona's system-prompt text."),
                                "from":     strProp("Import a hub persona you downloaded (its name or id) instead of inline text."),
                                "activate": {Type: "boolean", Description: "Make it the always-active persona."},
                        }),
                        nativeToolSpec("persona_activate", "Become a listed persona (deactivates the previous one); {\"id\": \"\"} deactivates all (back to the app default).", map[string]jsonSchemaProp{
                                "id": strProp("The persona id from persona_list (empty deactivates all)."),
                        }),
                        nativeToolSpec("placeholder_set", "Set a {placeholder} usable in personas and triggers.", map[string]jsonSchemaProp{
                                "key":   strProp("The placeholder name."),
                                "value": strProp("The placeholder value."),
                        }, "key", "value"),
                )
        }
        // v0.76.5: THE WORKSPACE HAND — the chat's connected cloud repos.
        // Gated on the armed runner like hublib/skills; executeAction routes
        // the calls to the server's runWorkspaceAction (same dispatch the
        // ACTION protocol path uses). One consolidated tool + an action param
        // (the ergonomics convention; access-tier scoped server-side).
        if req.WorkspaceToolFn != nil {
                specs = append(specs,
                        nativeToolSpec("workspace", "Act on this chat's CONNECTED cloud repos (the CONNECTED CLOUD WORKSPACES block lists them): browse (tree/ls/read/grep/readme), inspect history/issues/PRs/discussions/releases/Actions (view), WRITE (put = an API commit, full access; pr opens a pull request; fork), create a repo, or discover the account's repos. Use it whenever the user asks about their connected repo — its code, history, issues, PRs, or wants a change pushed.", map[string]jsonSchemaProp{
                                "action": {Type: "string", Description: "'list' (the connected repos), 'info', 'tree', 'ls', 'read', 'readme', 'grep', 'view', 'put', 'pr', 'fork', 'create' or 'discover'.", Enum: []string{"list", "info", "tree", "ls", "read", "readme", "grep", "view", "put", "pr", "fork", "create", "discover"}},
                                "ws":     strProp("The repo: id, owner/repo or the bare repo name (from the CONNECTED block or list)."),
                                "path":   strProp("File/subdirectory path (tree/ls/read/put)."),
                                "ref":    strProp("Branch/tag/sha override (defaults to the repo branch)."),
                                "range":  strProp("Read slice: head:80 | tail:40 | lines:10-60."),
                                "query":  strProp("Grep search text."),
                                "what":   {Type: "string", Description: "View subject (view only).", Enum: []string{"issues", "pulls", "commits", "branches", "releases", "workflows", "runs", "discussions"}},
                                "state":  {Type: "string", Description: "Filter state for issues/pulls (view only).", Enum: []string{"open", "closed", "all"}},
                                "content": strProp("Full new file text (put only)."),
                                "message": strProp("Commit message (put only; default auto)."),
                                "branch":  strProp("Target branch (put; a NEW branch is created from HEAD — then pr it)."),
                                "head":    strProp("PR source branch (pr only; owner:branch for forks)."),
                                "base":    strProp("PR target branch (pr only; default the repo branch)."),
                                "title":   strProp("PR title (pr only)."),
                                "body":    strProp("PR description (pr only)."),
                                "name":    strProp("New repo name (create only)."),
                                "kind":    {Type: "string", Description: "Forge (create/discover only).", Enum: []string{"github", "gitea", "gitlab"}},
                                "private": {Type: "boolean", Description: "Create private (create only)."},
                        }, "action"),
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
        // v0.44 TEMPLATE PILL: the active method template rides the system
        // message (the direct path's first message IS the persona system
        // prompt) — the same METHOD TEMPLATE block the ReAct path prepends
        // to its composed system prompt.
        if req.TemplateBrief != "" && len(history) > 0 && history[0].Role == "system" {
                history[0].Content = templateBriefBlock(req.TemplateID, req.TemplateBrief) + "\n" + history[0].Content
        }
        // v0.76.5 THE WORKSPACE HAND: the CONNECTED CLOUD WORKSPACES block
        // rides the system message the same way (the brain twin's
        // _build_system_prompt shape — the model must know which repos exist
        // and their access tiers, or it will guess).
        if req.WorkspaceManifest != "" && len(history) > 0 && history[0].Role == "system" {
                history[0].Content = req.WorkspaceManifest + "\n" + history[0].Content
        }

        var allSources []SearchResult
        var totalUsage *Usage
        // v0.80.1: 64 rounds (was 16) — models keep going as long as they
        // like (30+ tool chains must fit; each round may also carry SEVERAL
        // parallel calls). The cap is a runaway-loop guard, not a clock.
        const maxRounds = 200 // v0.82.2: the no-cap chain (user directive: "REMOVE THE 24 MAX TURNS CAP… 100 chained tools"); was 64

        for round := 0; round < maxRounds; round++ {
                roundReq := req
                roundReq.Messages = history
                extra := map[string]any{
                        "tools":       specs,
                        "tool_choice": "auto",
                }
                // v0.39 PAUSE-NOT-FAIL: the round fetch runs through the
                // network pause ladder (2 quick hiccups, then 15/30/60s
                // pauses) — a network blip no longer kills a tool chain
                // mid-flight. Rounds that streamed visible content are never
                // retried (no double-render).
                var usage *Usage
                var calls []nativeCall
                err := netPauseLadder(ctx, ch, roundReq.Provider, func() (bool, error) {
                        emitted := false
                        u, c, e := scanSSECollect(ctx, roundReq, extra, ch, func(reasoning, content string) {
                                emitted = true
                                if reasoning != "" {
                                        ch <- ChatChunk{Type: "thinking", Text: reasoning}
                                }
                                if content != "" {
                                        ch <- ChatChunk{Type: "assistant_delta", Text: content}
                                }
                        })
                        usage, calls = u, c
                        return emitted, e
                })
                if err == errToolsRejected {
                        // provider can't do tools — rerun the turn on the ACTION protocol
                        runWebSearchTurn(ctx, ch, errs, req)
                        return
                }
                if err != nil {
                        emitTurnError(ch, err)
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
                emitTurnError(ch, err)
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
                                // v0.39 COOLDOWN TABLE: skip alternate hosts that
                                // are blacklisted (401/403) or mid-cooldown (429/
                                // 5xx/net) — rotating onto a provider we JUST
                                // recorded as failing would repeat the failure.
                                if !ProviderAvailable(alt.Provider) {
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
