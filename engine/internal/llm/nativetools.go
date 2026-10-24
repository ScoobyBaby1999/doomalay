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

	"github.com/ScoobyBaby1999/doomalay/engine/internal/jobmgr"
	"github.com/ScoobyBaby1999/doomalay/engine/internal/mcpbus"
	"github.com/ScoobyBaby1999/doomalay/engine/internal/obs"
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
// v1.13.6: Skip/SkipText carry the honesty-line verdict for a call whose
// arguments arrived CUT OFF or malformed — the fault text IS the tool's
// answer (one role:"tool" message per call_id, never a second contradictory
// execution of a call we already told the model was NOT executed).
type wireToolCall struct {
	ID       string `json:"id"`
	Type     string `json:"type"`
	Skip     bool   `json:"-"` // do not execute — the fault text answers instead
	SkipText string `json:"-"`
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

	// v1.50.2 THE ONE TRUTH: the in-turn observation clamp is
	// CONTEXT-AWARE, not a fixed 24,000. The old ceiling amputated a
	// 300KB file read even on a 200K-context model — silent data loss
	// with zero budget pressure (a trippy-loop driver: the model
	// "found" things the clamp then ate). The budget: 90% of the
	// model's documented window minus what the in-turn history already
	// holds. A result rides WHOLE whenever it fits (the common case on
	// big-context models); when physics says no, ClampMarked carries
	// the honest totals so the model KNOWS and can re-read slices.
	// Recomputed per round (history grows); floor 24,000 so a tiny-
	// window model is never worse off than the old ceiling.
	obsBudget := turnObsBudget(req.Model, messagesTokens(req.Messages))

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
	proceeds := 0 // v1.29.4 THE PROCEED: bounded at 2 — the third announcement IS the answer
	// v1.39.6 THE SEAMLESS CUT: bounded at 3 seams per turn — a long
	// outage may legitimately cut several rounds; the fourth cut ends
	// honestly (the runaway guard).
	seams := 0
	const maxSeams = 3
	// v0.95.4: the repeat-call cache (see the twin in the ReAct loop).
	seenCalls := map[string]string{}

	for round := 0; round < maxRounds; round++ {
		// v1.73.2 THE JOB LAYER (restored by the v1.74.10 wave): the
		// round-boundary drain — a background lane that settled since
		// the last round rides the history as the loud system row (the
		// after-the-fact UI; settled jobs are already persisted + live
		// by the sink, so no duplicate row fires here — the job row IS
		// the loud half).
		if settled := jobmgr.Default().DrainSettled(req.SessionID); len(settled) > 0 {
			block := jobmgr.SettledBlock(settled, 4000)
			history = append(history, Message{Role: "user", Content: "(system: " + block + ")"})
		}
		roundReq := req
		roundReq.Messages = history
		// v1.14.4 THE TRACE: the round boundary — inputs on the
		// start event, outcomes on the end event below.
		obs.EmitS(ctx, obs.RoundStart, "round", round, "model", roundReq.Model,
			"provider", roundReq.Provider, "messages", len(history), "tools", len(specs))
		fsmFrom(ctx).roundStart(round) // v1.14.6: the FSM counts the round
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
		roundText := ""          // v1.29.4 THE PROCEED: the round's visible prose (tail-kept for intent matching)
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
					// v1.70.2 THE WHITESPACE BLINDNESS (the
					// campaign's conviction: a degraded
					// free-router round streamed ONLY newlines —
					// contentSeen flipped true and the
					// empty-response net never fired; the user
					// saw a blank reply with no honest note).
					// Whitespace-only text is NOT content.
					if strings.TrimSpace(content) != "" {
						contentSeen = true
						roundHadContent = true
					}
					roundText += content // v1.29.4: the proceed reads the announcement
					if len(roundText) > 1600 {
						roundText = roundText[len(roundText)-900:]
					}
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
			sealTurn(ctx, ch, errToolsRejected, nil)
			emitTurnError(ch, fmt.Errorf("provider rejected tools"))
			errs <- errToolsRejected
			return
		}
		// v1.39.6 THE SEAMLESS CUT (PLAN-V140 §4): a transient network
		// failure of a round that ALREADY streamed visible prose was
		// the last honest terminal for net-class errors — the double-
		// render guard rightly refused to blindly re-run the round
		// (the partial would re-print). The seam is the sanctioned
		// continuation: seal the partial as its own segment (round_end
		// — the prose block finalizes, the tool pills would render
		// below it), persist the seam notice, hold in the suspension
		// until the network returns (the same heartbeats/wake/Stop),
		// then continue with the PARTIAL AS CONTEXT — the continuation
		// round streams a NEW segment (double-render impossible by
		// construction: the old one is sealed complete) and may even
		// carry tool calls (the full round machinery handles it —
		// calls, segments, the proceed, the final answer all flow
		// from here). Bounded at 3 seams per turn.
		if err != nil && isTransientNetErr(err) && roundHadContent && seams < maxSeams {
			seams++
			ch <- ChatChunk{Type: "round_end"}
			ch <- ChatChunk{Type: "notice", Text: "the connection cut mid-reply — holding, and continuing when the network returns (Stop always works)"}
			history = append(history,
				Message{Role: "assistant", Content: roundText},
				Message{Role: "user", Content: SeamNudgeText})
			// v1.65.2 THE LOUD INJECTION: the seam nudge is a system-injected
			// prompt — speak it (the hiccup box's injected state renders it;
			// the transcript keeps it).
			EmitInjected(ch, SeamNudgeText)
			roundReq.Messages = history
			err = netSuspendedLoop(ctx, ch, roundReq.Provider, "", func() (bool, error) {
				emitted2 := false
				u2, c2, e2 := scanSSECollect(ctx, roundReq, extra, ch, func(reasoning, content string) {
					emitted2 = true
					if reasoning != "" {
						ch <- ChatChunk{Type: "thinking", Text: reasoning}
						think += reasoning
						if len(think) > 4800 {
							think = think[len(think)-2400:]
						}
					}
					if content != "" {
						contentSeen = true
						roundHadContent = true
						roundText += content
						if len(roundText) > 1600 {
							roundText = roundText[len(roundText)-900:]
						}
						ch <- ChatChunk{Type: "assistant_delta", Text: content}
					}
				})
				usage, calls = u2, c2
				return emitted2, e2
			})
			// fall through: err == nil → the round's normal flow
			// (call validation, execution, segments) continues
			// with the continuation round's outcome; err != nil →
			// the honest terminal below (a second cut of the
			// continuation, a class change, or the user's Stop).
		}
		if err != nil {
			sealTurn(ctx, ch, err, nil)
			emitTurnError(ch, err)
			errs <- err
			return
		}
		totalUsage = mergeUsage(totalUsage, usage)
		// v1.14.4 THE TRACE: the round's outcome (calls + tokens).
		if usage != nil {
			obs.EmitS(ctx, obs.RoundEnd, "round", round, "calls", len(calls),
				"input_tokens", usage.InputTokens, "output_tokens", usage.OutputTokens)
		}
		if len(calls) == 0 {
			// v1.29.4 THE PROCEED (revived v0.24 design — dead
			// since v1.13.3 THE GUT): a round that ANNOUNCES a plan
			// ("Let me read the code regions…", "I will now check the
			// timers") with no tool calls used to END THE TURN — the
			// announcement became the final answer and the user had
			// to push ("Continue, sorry for the interrupt" — the
			// Doobie transcript's exact shape). The loop now appends
			// the announcement + ONE mechanical proceed instruction
			// and continues — the model executes instead of waiting.
			// Bounded at 2 proceeds per turn (the third announcement
			// IS the answer); thinking stays ON (this is not the
			// silent shape); tools must be armed (nothing to execute
			// otherwise — the nudge would be noise).
			if contentSeen && roundHadContent && proceeds < maxProceeds && len(specs) > 0 && shouldProceed(roundText) {
				proceeds++
				obs.EmitS(ctx, obs.Notice, "round", round, "text", "intent-only reply — proceed round armed")
				ch <- ChatChunk{Type: "progress", Text: "the plan is announced — proceeding to execution…"}
				if strings.TrimSpace(roundText) != "" {
					history = append(history, Message{Role: "assistant", Content: roundText})
				}
				// v1.65.2 THE LOUD INJECTION + THE DYNAMIC TEXT: the proceed
				// nudge carries the announcement's tail for context (the user's
				// ask: "proceed and print the tail of the message for context")
				// and the injected row renders it (never a silent injection).
				proceedText := ProceedInjectionText(roundText)
				history = append(history, Message{Role: "user", Content: proceedText})
				EmitInjected(ch, proceedText)
				continue
			}
			// v0.82.3 THE ANSWER-FORCE NET: a silent round (no calls,
			// no visible content this whole turn) is NOT a final
			// answer — it's the reasoning-without-reply shape.
			// Nudge ONCE with thinking disabled; the next round
			// either produces the real reply or falls through.
			if !contentSeen && !nudged {
				nudged = true
				obs.EmitS(ctx, obs.Notice, "round", round, "text", "reasoning ended without a reply — nudge round armed (thinking off)")
				ch <- ChatChunk{Type: "progress", Text: "reasoning ended without a reply — asking again with thinking off…"}
				// v1.65.2 THE LOUD INJECTION: the answer-force nudge is
				// generic-simple by design (the ask's first arm) — and now it
				// renders (the injected row) instead of riding silently.
				answerForceText := "(system: your last reply ended after its reasoning without a visible answer. Reply NOW with your FINAL answer as plain text — no tool calls, no more reasoning.)"
				history = append(history,
					Message{Role: "assistant", Content: "(the previous reply contained reasoning but no visible answer)"},
					Message{Role: "user", Content: answerForceText})
				EmitInjected(ch, answerForceText)
				continue
			}
			// final answer — already streamed (or the nudge round
			// produced it). Emit accumulated sources. A still-silent
			// turn falls to the turn-end net below.
			if contentSeen {
				if len(allSources) > 0 {
					ch <- ChatChunk{Type: "sources", Sources: allSources}
				}
				sealTurn(ctx, ch, nil, totalUsage)
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
				// v1.13.6: the wire entry carries Skip+SkipText so
				// the execution loop NEVER runs this call (the old
				// code executed it anyway with bus-coerced "{}",
				// emitting a SECOND contradictory tool_result for
				// the same call_id — caught by the v1.13.6 rig).
				// v1.61.1 THE REPAIR HAND, rung 0: legacy tag-grammar
				// leakage (the kenny conviction) converts to JSON BEFORE
				// any verdict — the tags are mechanical punctuation, the
				// call underneath is usually whole.
				if hasLegacyTags(args) {
					args = TagsToJSON(args)
				}
				// v1.61.1: the cut verdict is judged on the REOPENED text
				// (RepairJSONQuotes subsumes the naive walk — an early-close
				// quote misjudges as cut), and the fault text FORBIDS the
				// simplification path (the old "or split the work" taught
				// the exact downgrade the user's law kills).
				if _, stillIn, _ := RepairJSONQuotes(args); stillIn {
					// v1.65.2 THE VERBATIM LAW: the anti-simplification order
					// carries the call VERBATIM — the model retries THAT.
					fault := "error: your " + c.Name + " arguments arrived CUT OFF mid-JSON (the provider's output token cap likely ate the tail). The call was NOT executed. Re-send the COMPLETE call with the same intent. " + RetryDirectiveFor(c.Name, args)
					obs.EmitS(ctx, obs.ToolFault, "round", round, "name", c.Name, "call_id", c.ID, "fault", "arguments cut mid-JSON")
					ch <- ChatChunk{Type: "tool_use", Name: c.Name, Summary: "(arguments cut off)"}
					ch <- ChatChunk{Type: "tool_result", Text: fault, Name: c.Name}
					wire = append(wire, wireToolCall{ID: c.ID, Type: "function", Skip: true, SkipText: fault})
					wire[len(wire)-1].Function.Name = c.Name
					wire[len(wire)-1].Function.Arguments = "{}"
					continue
				}
				// belt-and-suspenders: repair truncated streamed JSON
				if fixed := repairJSON(args); json.Valid([]byte(fixed)) {
					args = fixed
				} else if fixed := lenientJSON(repairJSON(args)); json.Valid([]byte(fixed)) {
					args = fixed
				} else if t, stillIn, _ := RepairJSONQuotes(args); !stillIn && json.Valid([]byte(t)) {
					// v1.61.1 rung 3: the quote-reopen (an unescaped quote
					// that closes a value early — the kenny class). stillIn
					// on the reopened text is the true cut verdict.
					args = t
				} else {
					// unrecoverable — tell the model via the tool result
					// (v1.13.6: Skip carries the verdict — no execution)
					// v1.65.2 THE VERBATIM LAW: the call rides the order verbatim.
					fault := "error: arguments arrived malformed — re-emit the call with the same intent and the same arguments, corrected. " + RetryDirectiveFor(c.Name, args)
					ch <- ChatChunk{Type: "tool_use", Name: c.Name, Summary: "(malformed arguments)"}
					ch <- ChatChunk{Type: "tool_result", Text: fault, Name: c.Name}
					wire = append(wire, wireToolCall{ID: c.ID, Type: "function", Skip: true, SkipText: fault})
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
			// v1.13.6 THE HONESTY LINE, execution side: a Skipped
			// call's fault text IS the tool's answer — the call was
			// never executed, so no bus dispatch, no cache write, no
			// second contradictory result for this call_id.
			if c.Skip {
				// v1.14.4 THE TRACE: the skipped call is on the
				// timeline (start+end, fault text head) — the
				// honesty line is observable end to end.
				obs.EmitS(ctx, obs.ToolStart, "round", round, "name", c.Function.Name, "summary", "(call skipped — arguments unusable)")
				obs.EmitS(ctx, obs.ToolEnd, "round", round, "name", c.Function.Name,
					"skipped", true, "obs_bytes", len(c.SkipText))
				history = append(history, Message{
					Role:       "tool",
					ToolCallID: c.ID,
					Name:       c.Function.Name,
					Content:    ClampMarked(strings.TrimPrefix(c.SkipText, "OBSERVATION:\n"), obsBudget), // v1.50.2: context-aware (was a fixed 24,000)
				})
				continue
			}
			dedupKey := c.Function.Name + "\x00" + c.Function.Arguments
			if cached, seen := seenCalls[dedupKey]; seen {
				// v0.95.4 THE REPEAT-CALL CACHE (the nativetools
				// twin): an exact repeat serves the cached
				// observation — no re-execution, no wasted round.
				obs.EmitS(ctx, obs.ToolStart, "round", round, "name", c.Function.Name, "summary", "(identical repeat — cached result)")
				obs.EmitS(ctx, obs.ToolEnd, "round", round, "name", c.Function.Name, "cached", true, "obs_bytes", len(cached))
				ch <- ChatChunk{Type: "tool_use", Name: c.Function.Name, Summary: "(identical repeat — cached result)"}
				observation = "OBSERVATION:\n(identical " + c.Function.Name + " call already executed this turn — same result)\n" + cached
			} else if bus != nil && !busDegraded {
				var degraded bool
				observation, degraded = busExecute(ctx, bus, turn, ch, c.Function.Name, c.Function.Arguments, &allSources)
				// v1.13.2 THE HANDOFF: emit tool_result for the UI (the busExecute
				// call emits tool_use + progress, but not the final tool_result).
				ch <- ChatChunk{Type: "tool_result", Text: strings.TrimPrefix(observation, "OBSERVATION:\n"), Name: c.Function.Name}

				// v1.56.0 THE HICCUP FLAG: every hiccup a tool
				// reports (a truncated result, a skipped file,
				// a refusal) is SPOKEN — the user sees it and
				// the model knows its observation was partial.
				FlagToolFault(ctx, ch, c.Function.Name, observation)
				// v1.14.4 THE TRACE: bus calls trace through the
				// bus Observer (spans + events, obs.AttachBus);
				// only the DEGRADE verdict is unique to this site.
				if degraded {
					busDegraded = true
					obs.EmitS(ctx, obs.ErrorEv, "round", round, "where", "mcpbus", "degraded", true, "name", c.Function.Name)
				}
				// v1.70.1 THE UNDEUPED RETRY: a FAILED observation never
				// enters the repeat-cache — the campaign's live conviction
				// (a mkdir failed on a missing parent; the model created
				// the parent and re-fired the IDENTICAL call; the cache
				// served the old failure verbatim and the directory was
				// never created). Only a SUCCESS is idempotently
				// cacheable — a retry of a failure must re-execute.
				if !failedObservation(observation, false) {
					seenCalls[dedupKey] = strings.TrimPrefix(observation, "OBSERVATION:\n")
					// v1.70.4 THE STALE CENSUS: a successful call may
					// have MUTATED state — every cached MUTABLE READ
					// (the no-arg census verbs) is now stale. The
					// campaign's live chain: persona_set created a
					// persona; the model re-listed; the cache served
					// the PRE-CREATE persona_list verbatim; the model
					// went blind to the new id, misused persona_set
					// with a name-as-id, and a duplicate "Persona"
					// appeared. Census verbs re-execute — they are
					// cheap in-process reads.
					evictMutableReads(seenCalls)
				}
			} else {
				// v1.14.4 THE TRACE: the direct dispatch — no bus
				// Observer fires here, so the span + events are
				// manual (same session-keyed registry as the bus).
				tsp, hasSpan := obs.StartSessionToolSpan(req.SessionID, c.Function.Name, c.ID)
				obs.EmitS(ctx, obs.ToolStart, "round", round, "name", c.Function.Name, "summary", "(direct dispatch — bus unavailable)")
				observation = executeAction(ctx, req, ch, c.Function.Name, c.Function.Arguments, &allSources)
				obs.EmitS(ctx, obs.ToolEnd, "round", round, "name", c.Function.Name, "direct", true, "obs_bytes", len(observation))
				// v1.56.0 THE HICCUP FLAG (the direct dispatch
				// twin — the same law, the same notice).
				FlagToolFault(ctx, ch, c.Function.Name, observation)
				if hasSpan {
					tsp.End(strings.HasPrefix(observation, "OBSERVATION:\n(error"), len(observation))
				}
				if !failedObservation(observation, false) {
					seenCalls[dedupKey] = strings.TrimPrefix(observation, "OBSERVATION:\n")
					evictMutableReads(seenCalls) // v1.70.4 THE STALE CENSUS
				}
			}
			// strip the protocol prefix — the wire tool message is plain content
			// (v1.14.4: renamed obs→obsText — the obs PACKAGE lives here now)
			obsText := strings.TrimPrefix(observation, "OBSERVATION:\n")
			// v1.50.2: recompute per round — every appended result
			// eats into the room the next one has.
			obsBudget = turnObsBudget(req.Model, messagesTokens(history))
			history = append(history, Message{
				Role:       "tool",
				ToolCallID: c.ID,
				Name:       c.Function.Name,
				Content:    ClampMarked(obsText, obsBudget), // v1.50.2: context-aware (was a fixed 24,000)
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
		// v1.70.2 THE PROSE-CALL DETECTION (the campaign's free-router
		// conviction): a degraded round describes its tool calls in
		// PROSE (the <dots_function_call>/<invoke> grammar) instead of
		// emitting structured calls — they never execute. Name it so
		// the user knows the tools were never run and the fix is a
		// retry or a concrete model, not a bug in the tools.
		proseCalls := strings.Contains(tail, "<invoke name=") || strings.Contains(tail, "dots_function_call")
		if tail != "" {
			clip := tail
			if len(clip) > 900 {
				clip = "…" + clip[len(clip)-900:]
			}
			note = "(the model finished its reasoning without sending a visible reply — its last thought:)\n" + clip
			if proseCalls {
				note += "\n(note: that last reasoning DESCRIBES tool calls in prose instead of emitting them — they were never executed; a degraded round. Ask again or pick a concrete model)"
			}
		} else if proseCalls {
			note = "(the model described tool calls in prose instead of emitting them — they were never executed; a degraded round. Ask again or pick a concrete model)"
		}
		ch <- ChatChunk{Type: "assistant_delta", Text: note}
		if len(allSources) > 0 {
			ch <- ChatChunk{Type: "sources", Sources: allSources}
		}
		sealTurn(ctx, ch, nil, totalUsage)
		ch <- ChatChunk{Type: "status", State: "idle", Usage: totalUsage}
		return
	}

	// Budget exhausted — force a final answer without tools.
	history = append(history, Message{Role: "user", Content: "Tool budget reached. Write your FINAL answer now."})
	// v1.65.2 THE LOUD INJECTION: the budget verdict renders too (never a silent injection).
	EmitInjected(ch, "Tool budget reached. Write your FINAL answer now.")
	finalReq := req
	finalReq.Messages = history
	// v1.39.3 THE PATIENT ENGINE: the budget-exhausted final answer runs
	// through the net ladder too — the ReAct rounds were laddered since
	// v0.39 but THIS final stream (the turn's actual answer) died
	// instantly on a transport blip.
	final, _, err := netLadderStream(ctx, finalReq, ch, nil)
	if err != nil {
		sealTurn(ctx, ch, err, nil)
		emitTurnError(ch, err)
		errs <- err
		return
	}
	totalUsage = mergeUsage(totalUsage, final)
	if len(allSources) > 0 {
		ch <- ChatChunk{Type: "sources", Sources: allSources}
	}
	sealTurn(ctx, ch, nil, totalUsage)
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
