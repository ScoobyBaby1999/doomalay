# PLAN-V113 — THE MCP WAVE

The directive (the user's words): "completely gut and replace the ACTION component
of our tool system. We want to plan then implement this community go mcp tool
library as our primary method of chaining 100+ tools and tool use, native tool
calling as fallbacks. No action based Json unreliable tool calling with no hooks
and traces."

## The conviction (research-verified against mark3labs/mcp-go v1.1.1 source)

The ACTION protocol asks the MODEL to hand-write `ACTION: tool {"json": …}` as
prose — and chat.go answers with ~1,400 lines of parser triage: repairJSON,
lenientJSON, splitGluedActions, stripActionDecorations, canonicalToolName's
15-alias switch, a Levenshtein ≤2 fuzzy matcher, glued-action splitting,
truncation-refusal reporting. Every one of those lines is evidence of the same
fact: **the model is the serializer, and it is unreliable.** Meanwhile the
same tool set is described TWICE (protocol prose in composeTurnSystem +
jsonSchemaProp maps in nativeToolSpecs) and executed through a
string-in/string-out `executeAction` with no hooks and no trace points.

mark3labs/mcp-go v1.1.1 (2026-09-23, spec 2026-07-28, pure Go — CGO_ENABLED=0,
android/arm64 clean) gives us the replacement spine:

- `server.NewMCPServer` + `mcp.NewTool` builder → **one registry, real JSON
  Schemas**, hooks ON the protocol (`AddBeforeCallTool`/`AddAfterCallTool`/
  `AddOnError`), panic recovery (`WithRecovery`), input-schema validation.
- `client.NewInProcessClient(server)` → the loop executes tools through the
  REAL MCP protocol with zero network, zero subprocess (Android-safe), and the
  caller's ctx values flow straight into tool handlers (verified:
  `InProcessTransport.SendRequest` → `HandleMessage(ctx,…)` →
  `context.WithValue` preserves parent values).
- `server.NewStreamableHTTPServer` implements `http.Handler` → mounts on the
  engine mux at `/mcp` for EXTERNAL consumers (the browser, remote hosts, the
  100+ tool horizon). Custom headers reach tool handlers (`request.Header`).
- The `otel` submodule + our observer hooks are the instrumentation points the
  parallel tiktoken/OTel bot stacks on — this wave builds the sockets, not the
  telescope.

## The architecture — THE BUS

```
engine/internal/mcpbus:
  Def (name, description, props, required, gate)  ← single source of truth
    ├→ mcp.NewTool registration (MCP JSON Schema, tools/list, tools/call)
    └→ OpenAI tools[] manifest (the proven nativeToolSpecs wire shape)
  Bus  = MCPServer + in-process client + observer chain
  Turn = per-turn context {sessionID, runner fns, artifact sink, sources,
        progress} carried via ctx values through the in-process transport
  Observer = the hooks: ToolStart/ToolEnd/ToolProgress/ToolArtifact —
        llm implements it as ChatChunk emission (tool_use/tool_result/
        progress/artifact events — the UI contract is untouched)
```

Routing after the wave:
- **PRIMARY**: every tools-capable turn runs the native function-calling loop
  (nativetools.go machinery kept: pause ladder, dedup cache, answer-force net,
  truncation refusal) with MCP-sourced manifests; every tool_calls executes
  through `bus.CallTool` → in-process MCP → hooks fire → observation.
- **FALLBACK**: bus-level failure degrades to direct in-process dispatch (the
  old executeAction core, ACTION parsing deleted); providers that 400 tools
  are blacklisted (existing ladder) and continue tool-less — honestly.
- **DEAD**: the ACTION grammar, its parser family, its protocol prompt blocks,
  its alias/fuzzy resolution, its tests. pmsdk.js's client-side ACTION loop
  (the last copy) is replaced with MCP-over-HTTP or deferred with a receipt.

## Phases (staged x.x.1 pushes; ship = v1.14.0)

| Phase | Name | Content |
|-------|------|---------|
| v1.13.1 | THE BUS | mcp-go dep + go 1.25.5 bump (engine go.mod + 3 CI workflows); mcpbus package: Defs for all 28 tools, Bus, Turn ctx plumbing, Observer hooks, in-process client; unit tests incl. ctx-flow, concurrency (-race), gating. PURE ADDITION — zero chat-path change. |
| v1.13.2 | THE HANDOFF | runNativeToolsTurn consumes MCP-sourced specs + executes via the bus (events identical); bus-failure → direct dispatch fallback; ACTION loop dormant behind DOOMALAY_ACTION_FALLBACK=1 kill-switch for one wave. |
| v1.13.3 | THE GUT | delete the ACTION family: parseAction(s), repairJSON*, lenientJSON, splitGluedActions, stripActionDecorations, canonicalToolName, nearestToolName, all *ToolsProtocol prompt blocks, composeTurnSystem's protocol stacking, DSML reinject mode, ACTION tests; scanSSECollect keeps the DSML strip. |
| v1.13.4 | THE CHAIN | external MCP servers: stdio + streamable-HTTP clients attach with `name_tool` namespacing (100+ tools); config via env/JSON; /mcp endpoint mounted on the engine mux for external consumers; scale test. |
| v1.13.5 | THE LAST ACTION | pmsdk.js PM loop → MCP-over-HTTP browser client (initialize → tools/list → tools/call POSTs) — or a documented deferral with the honest reason. |
| v1.13.6 | THE REDTEAM | real-key E2E (OpenRouter/Nvidia/Mistral): multi-tool chains (calculator → time_now → zip_create), web_search sources, artifacts, error ladders, 100+ tool manifest scale, replay determinism, concurrent sessions; act as a real user through the panel. |
| v1.14.0 | ship | the wave record + the rebase-before-push protocol (pull --rebase, conflict check, push). |

## Will-NOT (the spaghetti boundary)

- No change to the UI event contract: tool_use, tool_result, round_end,
  progress, sources, artifact chunks keep their shapes and ordering.
- No OTel/tiktoken implementation — the parallel bots own those; this wave
  ships the Observer sockets they plug into.
- No brain/ (Python Strands) changes — it already speaks native tool calling.
- No ACTION revival for function-less providers — they degrade honestly to
  tool-less chat (the user's explicit trade: reliability over grammar rescue).
- No new UI surfaces — pills already render tool events; engine-side wave.
- No hard-coded colors anywhere (engine-side; theme system untouched).
