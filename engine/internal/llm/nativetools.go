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

        "github.com/ScoobyBaby1999/doomalay/engine/internal/mcpbus"
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

// stripToolsFromTurn marks a ChatRequest for a clean tool-less rerun —
// the honest degrade when a provider rejects tools (the ACTION protocol
// used to absorb this case; v1.13.2 answers without tools instead).
func stripToolsFromTurn(req ChatRequest) ChatRequest {
        req.ToolsDisabled = true
        return req
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

// nativeToolsBlacklisted reports whether this provider 400'd a
// tools-bearing request earlier in this engine's lifetime.
func nativeToolsBlacklisted(provider string) bool {
        if provider == "" {
                return false
        }
        nativeToolsMu.Lock()
        blocked := nativeToolsBlacklist[normalizeProviderName(provider)]
        nativeToolsMu.Unlock()
        return blocked
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
// execute any tool_calls, feed the results back as role:"tool" messages,
// repeat until a round produces no calls (the final answer, already
// streamed live).
//
// v1.13.2 THE HANDOFF (PLAN-V113 §2): the manifest comes from the mcpbus
// Defs (single source of truth — nativeToolSpecs is deleted) and every
// tool_call executes through the MCP bus (busExecute) with the direct
// in-process dispatch (executeAction) as the sticky fallback — the
// user's "native tool calling as fallbacks" ladder.
func runNativeToolsTurn(ctx context.Context, ch chan<- ChatChunk, errs chan<- error, req ChatRequest) {
        ch <- ChatChunk{Type: "status", State: "running"}

        // v1.13.4 THE CHAIN: the merged registry (internal Defs + every
        // attached external MCP server's namespaced tools — the 100+ tools
        // horizon) when the bus is up; the pure function serves the
        // degraded path.
        specs := mcpbus.SpecsFor(mcpGates(req))
        if bus := mcpBus(); bus != nil {
                specs = bus.Specs(mcpGates(req))
        }
        if req.ToolsDisabled {
                specs = nil
        }
        // v1.13.3: a provider that already rejected tools once (the runtime
        // blacklist) never sees the manifest again — no wasted 400 round
        // trip per turn; the turn simply runs tool-less.
        if nativeToolsBlacklisted(req.Provider) && len(specs) > 0 {
                req = stripToolsFromTurn(req)
                specs = nil
        }
        // THE BUS: one Turn per chat turn; busDegraded flips to direct
        // dispatch if the MCP protocol layer ever fails mid-turn.
        bus := mcpBus()
        var turn *mcpbus.Turn
        if bus != nil {
                turn = mcpTurnFor(req, ch)
        }
        busDegraded := bus == nil
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
        // v0.95.4 THE DROPPED BUNDLE (protocol-honesty wave): the attached
        // bundle's manifest rode the ReAct path (composeTurnSystem) and the
        // brain path (brainReq), but runNativeToolsTurn NEVER prepended it —
        // a bundle-attached chat on a native-tools provider silently lost
        // the whole "review members, load the pick" instruction. It rides
        // the system message now, same as the template brief above.
        if req.BundleManifest != "" && len(history) > 0 && history[0].Role == "system" {
                history[0].Content = req.BundleManifest + "\n" + history[0].Content
        }

        var allSources []SearchResult
        var totalUsage *Usage
        // v0.80.1: 64 rounds (was 16) — models keep going as long as they
        // like (30+ tool chains must fit; each round may also carry SEVERAL
        // parallel calls). The cap is a runaway-loop guard, not a clock.
        const maxRounds = 200 // v0.82.2: the no-cap chain (user directive: "REMOVE THE 24 MAX TURNS CAP… 100 chained tools"); was 64

        // v0.82.3 THE ANSWER-FORCE NET (the nativetools twin — this path
        // had NO net at all): a round that streams ONLY reasoning and no
        // tool calls used to end the turn silently ("len(calls) == 0 →
        // final answer — already streamed" assumed content existed). The
        // user's report: "it said it will give a summary, then didn't… I
        // think Nvidia does this too." Now: contentSeen tracks whether ANY
        // visible text streamed this TURN; a calls==0 round with none gets
        // ONE nudge round with thinking disabled (Effort "off" — the
        // documented per-family disable), and a still-silent turn ends with
        // the reasoning tail as the reply under the honest prefix.
        contentSeen := false
        think := ""
        nudged := false
        // v0.95.4: the repeat-call cache (see the twin in the ReAct loop).
        seenCalls := map[string]string{}

        for round := 0; round < maxRounds; round++ {
                roundReq := req
                roundReq.Messages = history
                if nudged {
                        // v0.82.3: the answer-force rounds run with thinking
                        // DISABLED (Effort "off" → BuildEffortBodyFor emits the
                        // documented per-family disable; mandatory reasoners
                        // send nothing — their default).
                        roundReq.Effort = "off"
                }
                extra := map[string]any{}
                if len(specs) > 0 {
                        extra["tools"] = specs
                        extra["tool_choice"] = "auto"
                }
                // v0.39 PAUSE-NOT-FAIL: the round fetch runs through the
                // network pause ladder (2 quick hiccups, then 15/30/60s
                // pauses) — a network blip no longer kills a tool chain
                // mid-flight. Rounds that streamed visible content are never
                // retried (no double-render).
                var usage *Usage
                var calls []nativeCall
                roundHadContent := false // v0.93.3: per-round prose flag (contentSeen is turn-wide)
                err := netPauseLadder(ctx, ch, roundReq.Provider, func() (bool, error) {
                        emitted := false
                        u, c, e := scanSSECollect(ctx, roundReq, extra, ch, func(reasoning, content string) {
                                emitted = true
                                if reasoning != "" {
                                        ch <- ChatChunk{Type: "thinking", Text: reasoning}
                                        think = think + reasoning
                                        if len(think) > 4800 {
                                                think = think[len(think)-2400:]
                                        }
                                }
                                if content != "" {
                                        contentSeen = true
                                        roundHadContent = true
                                        ch <- ChatChunk{Type: "assistant_delta", Text: content}
                                }
                        })
                        usage, calls = u, c
                        return emitted, e
                })
                if err == errToolsRejected {
                        // v1.13.2: the provider 400'd a tools-bearing request —
                        // it is blacklisted (scanSSECollect did it) and the turn
                        // degrades HONESTLY: one clean rerun without tools. The
                        // ACTION text protocol is gone (v1.13.3 THE GUT).
                        if len(specs) > 0 {
                                ch <- ChatChunk{Type: "progress", Text: "this provider rejected tool calling — continuing without tools…"}
                                req = stripToolsFromTurn(req)
                                runNativeToolsTurn(ctx, ch, errs, req)
                                return
                        }
                        emitTurnError(ch, fmt.Errorf("provider rejected tools"))
                        errs <- errToolsRejected
                        return
                }
                if err != nil {
                        emitTurnError(ch, err)
                        errs <- err
                        return
                }
                totalUsage = mergeUsage(totalUsage, usage)
                if len(calls) == 0 {
                        // v0.82.3 THE ANSWER-FORCE NET: a silent round (no calls,
                        // no visible content this whole turn) is NOT a final
                        // answer — it's the reasoning-without-reply shape.
                        // Nudge ONCE with thinking disabled; the next round
                        // either produces the real reply or falls through.
                        if !contentSeen && !nudged {
                                nudged = true
                                ch <- ChatChunk{Type: "progress", Text: "reasoning ended without a reply — asking again with thinking off…"}
                                history = append(history,
                                        Message{Role: "assistant", Content: "(the previous reply contained reasoning but no visible answer)"},
                                        Message{Role: "user", Content: "(system: your last reply ended after its reasoning without a visible answer. Reply NOW with your FINAL answer as plain text — no tool calls, no more reasoning.)"})
                                continue
                        }
                        // final answer — already streamed (or the nudge round
                        // produced it). Emit accumulated sources. A still-silent
                        // turn falls to the turn-end net below.
                        if contentSeen {
                                if len(allSources) > 0 {
                                        ch <- ChatChunk{Type: "sources", Sources: allSources}
                                }
                                ch <- ChatChunk{Type: "status", State: "idle", Usage: totalUsage}
                                return
                        }
                        break // the give-up shape — the turn-end net answers
                }

                // normalize + validate the calls, then execute in order
                // v0.93.3 THE ROUND SEGMENT: this round produced VISIBLE
                // prose (the model narrating: "Let me check your repos…")
                // AND structured tool calls — finalize the prose block
                // BEFORE the tool pills render, so the chat FLOWS like a
                // conversation: prose block → tool pills → next block (the
                // user's spec: "many responses that remain in the position
                // they should be and stream with the conversation"). The
                // prose STAYS; the next round's deltas open a NEW block.
                if roundHadContent {
                        ch <- ChatChunk{Type: "round_end"}
                }
                wire := make([]wireToolCall, 0, len(calls))
                for _, c := range calls {
                        args := strings.TrimSpace(c.Arguments)
                        if args == "" {
                                args = "{}"
                        }
                        if !json.Valid([]byte(args)) {
                                // v0.95.4 THE HONESTY LINE (the .MD-artifact cutoff
                                // class): arguments cut MID-STRING (the provider's
                                // token cap ate the tail) must NOT execute — the old
                                // repair silently closed the string and the tool ran
                                // with HALF the content. Tell the model to re-send.
                                if _, cut := repairJSONReport(args); cut {
                                        ch <- ChatChunk{Type: "tool_use", Name: c.Name, Summary: "(arguments cut off)"}
                                        ch <- ChatChunk{Type: "tool_result", Text: "error: your " + c.Name + " arguments arrived CUT OFF mid-JSON (the provider's output token cap likely ate the tail). The call was NOT executed. Re-send the COMPLETE call — or split the work into smaller calls.", Name: c.Name}
                                        wire = append(wire, wireToolCall{ID: c.ID, Type: "function"})
                                        wire[len(wire)-1].Function.Name = c.Name
                                        wire[len(wire)-1].Function.Arguments = "{}"
                                        continue
                                }
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
                        var observation string
                        dedupKey := c.Function.Name + "\x00" + c.Function.Arguments
                        if cached, seen := seenCalls[dedupKey]; seen {
                                // v0.95.4 THE REPEAT-CALL CACHE (the nativetools
                                // twin): an exact repeat serves the cached
                                // observation — no re-execution, no wasted round.
                                ch <- ChatChunk{Type: "tool_use", Name: c.Function.Name, Summary: "(identical repeat — cached result)"}
                                observation = "OBSERVATION:\n(identical " + c.Function.Name + " call already executed this turn — same result)\n" + cached
                        } else if bus != nil && !busDegraded {
                                var degraded bool
                                observation, degraded = busExecute(ctx, bus, turn, ch, c.Function.Name, c.Function.Arguments, &allSources)
                                if degraded {
                                        busDegraded = true
                                }
                                seenCalls[dedupKey] = strings.TrimPrefix(observation, "OBSERVATION:\n")
                        } else {
                                observation = executeAction(ctx, req, ch, c.Function.Name, c.Function.Arguments, &allSources)
                                seenCalls[dedupKey] = strings.TrimPrefix(observation, "OBSERVATION:\n")
                        }
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

        // v0.82.3 THE TURN-END NET — the give-up shape reached here (the
        // loop `break`s when the nudged round still produced no content,
        // or the budget ran out on a silent turn). The reasoning tail —
        // which usually CONTAINS the answer the model never sent — becomes
        // the reply under the honest prefix; a no-reasoning silent turn
        // gets the honest empty note. Never a silent screen.
        if !contentSeen {
                tail := strings.TrimSpace(think)
                note := "(the model returned an empty response — try again or pick a different model)"
                if tail != "" {
                        clip := tail
                        if len(clip) > 900 {
                                clip = "…" + clip[len(clip)-900:]
                        }
                        note = "(the model finished its reasoning without sending a visible reply — its last thought:)\n" + clip
                }
                ch <- ChatChunk{Type: "assistant_delta", Text: note}
                if len(allSources) > 0 {
                        ch <- ChatChunk{Type: "sources", Sources: allSources}
                }
                ch <- ChatChunk{Type: "status", State: "idle", Usage: totalUsage}
                return
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
