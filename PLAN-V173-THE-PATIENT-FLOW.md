# PLAN-V173 — THE PATIENT FLOW

> The user's ask (this session, verbatim): "I thought each tool call was it's own
> process with its own pid, so the chatbot can call as many tools and each tool
> act as a subagent, not interfering with the chat. Our top priority is
> continuity, we already have an issue where our timer handler doesn't pick up
> network interrupts and add the chat to the continuation timer witha visual
> queue or hint. And now we have issues where tool calls that take a lot of
> time interrupt the chat flow completely? Wouldn't it make more sense if that
> long tool call gets its own pid with its own allocated resources, goes on for
> however long and then returns when its done? The model can execute and
> continue without a hinderance? That way a model can try one tool call, do
> other methods, decide weather to kill the old pid tool call or not. The UI be
> dealt with after the fact, tool calls that take a long time can re-render
> once complete, possibly in a different theme color indicating they took
> time, we can even display the time it took for each tool call if we don't
> already. The idea is simple. The chatbot has a lot of capabilities, but none
> should interrupt it's flow. It should all feel like an extension not a rigid
> workflow."

## THE AUDIT (the conviction record — file:line receipts)

1. **Tools are NOT own-PID processes today.** Both execution paths converge
   at `mcpbus.Bus.CallTool` (bus.go:237): the native loop
   (`runNativeToolsTurn` nativetools.go:160, the sequential `for _, c := range
   wire` at :553) and the serve path (serve → HTTP `/mcp/oc/<chat>` →
   `ResolveSessionTurn` → the same bus) execute each call SYNCHRONOUSLY inside
   the turn goroutine. One slow tool blocks the whole round loop — the chat
   freezes. The only existing own-PID pattern: the termux device shell's
   `session_start/session_log/session_kill` (termuxtool.go:296-302, "actually
   kills the child" :1405) — the model must know to reach for it.
2. **THE NET ARM GAP (the timer handler that never picks up network
   interrupts).** The retry sentinel arms ONLY on turn deaths carrying
   `retry_class` (server/chat.go:3141). The direct-provider paths classify net
   correctly (`netProviderHoldLoop` → `wrapRetryable(..., "net", ...)`
   llm/chat.go:2573). But the oc-bridge's ONE classifier,
   `ocServeFailEvents` (ocserveturn.go:1201), knows ONLY 429/free-limit
   (:1229-1233). A network interrupt through the serve path lands as
   `oc_bridge_error` with NO class → the chat never joins a timer, no visual
   queue, no auto-continue. The user's report is exact.
3. **The honest clock does not exist for tools.** The bus computes
   `ToolEnd.DurationMS` (bus.go:296) but it never reaches the pills — the PWA
   shows only turn elapsed + thinking-chain elapsed. No per-tool duration, no
   slow-tone, no after-the-fact re-render.
4. **The post-turn event machinery exists** and is the delivery rail for job
   completions: `s.emit(pipeFor(sid), sid, type, content, toolUseID)`
   (server/chat.go:3231) persists + pushes live — the retry sentinel's pill
   path (retrysentinel.go:310) proves it end-to-end.

## THE RESEARCH (the standing law's pass — sourced in the worklog)

- **The design is spec-shaped**: the job layer maps 1:1 to MCP Tasks
  (`io.modelcontextprotocol/tasks`: `CreateTaskResult`/`tasks/get`/
  `tasks/cancel`, statuses `working → completed|failed|cancelled`, terminal
  states never transition; the spec's own `model-immediate-response` blesses
  "return control to the model with a ticket").
- **Claude Code auto-backgrounds long tool calls** (default 2min grace) —
  "Claude receives the task ID immediately and keeps working… Stopping
  doesn't guarantee the server stops" (the cooperative-kill honesty law).
- **opencode's own shell tool** is the ticket pattern: "Command moved to the
  background (shell ID: …)", `BACKGROUND_INSTRUCTION` = keep working, do not
  poll, "you will be resumed automatically when the command finishes". Its MCP
  client: execution timeout 12h (remote HTTP servers — our `/mcp/oc` surface),
  with an `onprogress` keepalive trick; so a 10s grace window is comfortably
  inside every client timeout found (TS SDK 60s per request; Claude Code 60s
  to first byte + 5min idle).
- **The Go process-group kill law** is already proven in this repo
  (screenshot_unix.go: `Setpgid: true` + `cmd.Cancel = syscall.Kill(-pid,
  SIGKILL)`); `exec.CommandContext`'s default kills ONLY the direct child —
  the group kill is the fix (documented: pkg.go.dev/os/exec, man7 kill.2).

## THE PHASES

### v1.73.1 THE NET ARM
- `ocServeFailEvents` (ocserveturn.go:1201): classify the net class —
  `netx.IsTransient` over the message (the one truth, netx/retry.go:42 —
  timeout/reset/EOF/refused/DNS/5xx already live-convicted on this device)
  plus status 502/503/504 → `retry_class="net"`, `retry_provider="opencode"`.
- The arm line (the v1.67.3 law, the net wording): a progress line FIRST —
  "network interrupted — the auto-retry timer is armed (it probes and
  CONTINUES this conversation the moment the network answers; no tap
  needed)" — then the error + the sentinel's pill below it.
- AUDIT every remaining turn-death path for a missing class: the seam
  exhaustion (nativetools.go `maxSeams`), `netPauseLadder`'s exhaustion tail,
  the pump's stream-death mapping, the oc-bridge auth/stall exclusions stay
  non-retryable by law (auth never arms; oc_stalled rides the v1.71.2
  recycle instead).
- PINS: a serve error frame carrying a net-class message ("fetch failed:
  ECONNRESET", "i/o timeout") → the failure events carry retry_class=net →
  `sentinelFor().Arm` fired → the retry pill rows in the DB → the probe
  succeeds → the auto-continue (no tap). The v1672 pins re-run (429 still
  arms; auth still never).

### v1.73.2 THE JOB LAYER
- New package `engine/internal/jobmgr` (no import cycle: it imports nothing
  from mcpbus; mcpbus imports it): the engine-global JobManager —
  `Job{ID j_<12hex>, SessionID, Tool, ArgsJSON, StartedAt, State
  working→completed|failed|cancelled (terminal never transitions), Text,
  DurationMS}`, `Execute(ctx, sessionID, tool, args, run func(ctx))` with the
  grace window (`DOOMALAY_JOB_GRACE_MS`, default 10_000), `Status/Kill/List`,
  and `SetEventSink(func(sessionID, content string))` — the server wires it
  at boot to `s.emit(pipeFor(sid), sid, "job", content, "")`.
- THE WRAP lives inside `Bus.CallTool` (bus.go:237) so BOTH paths get it
  uniformly (native loop + `/mcp/oc` serve route + external /mcp): the tool
  runs in its own goroutine with its own cancellation context; finishes
  within grace → the exact today result (byte-identical, zero behavior
  change for fast tools); exceeds grace → the ticket is the tool result.
- THE TICKET TEXT (the researched three-part law, opencode's own shape):
  (1) what happened + the handle, (2) keep working on anything that doesn't
  depend on this, (3) do NOT poll — the completion lands in this chat and
  you'll see it; `job_status {"id"}` checks, `job_kill {"id"}` stops.
- `job_status` / `job_kill` / `job_list`: first-class ALWAYS-ON tools (the
  calculator set) — `job_status` answers running (Ns elapsed) or the terminal
  result; `job_kill` is COOPERATIVE (MCP's law: the state moves to cancelled
  even if the work keeps running — the honest text says so, Claude Code's
  "stopping doesn't guarantee" wording); goroutine jobs die on context cancel
  (web/webfetch/forge honor ctx); subprocess-backed tools keep the
  screenshot_unix group-kill law where the engine owns the process.
- THE COMPLETION EVENT: when a job settles, the manager fires the sink → a
  persisted "job" event rides the chat (`{id, tool, state, duration_ms,
  text}`) — live push + replay + export. Mid-turn on the native path: the
  next round boundary injects the completed jobs as THE LOUD INJECTION rows
  (the model sees them without polling). On the serve path: the model's own
  `job_status` + the next turn's opening text carry them (pull-only by
  protocol — the ticket teaches it).
- Jobs are capped per session (8 concurrent — the runaway guard) and the
  whole map is mutex-guarded; job ids are unique per engine.

### v1.73.3 THE HONEST CLOCK + THE AFTER-THE-FACT UI
- `duration_ms` rides EVERY `tool_result` event (the bus's ToolEnd → the llm
  observer → the chunk → the persist → the PWA) — the number the user asked
  for ("display the time it took for each tool call if we don't already" —
  we don't).
- PWA (chatpanel.js + index.html, theme-law only — zero hardcoded colors):
  (1) the per-pill duration chip (every completed pill: "12.4s"); (2) THE
  SLOW TONE — tools that took ≥ the slow threshold (`data-slow`, default 30s,
  `DOOMALAY_SLOW_TOOL_MS`) render on the --warn accent tone ("indicating
  they took time"); (3) THE AFTER-THE-FACT RE-RENDER — the "job" event row
  (✓/✗/⊘ + the tool + the duration + the collapsible result), replayed and
  exported like every first-class row.
- The export (export.go): the job rows render as readable lines.

### v1.73.4 THE LIVE PROOF
- `scripts/v1730-patient-flow-rig.mjs` (port 8730, THE DEPLOYMENT LAW): the
  fake 2.1.2 serve (the v1710 rig's shape) + a fake OpenAI-compatible
  provider + the REAL binary:
  - LEG A THE NET ARM: a serve error frame with a net-class message →
    retry_class=net rides the failure events → the sentinel arms (the pill
    rows) → the probe succeeds → the AUTO-CONTINUE fires (no tap).
  - LEG B THE JOB LAYER (native path): a real turn whose `web_fetch` hits
    the rig's own /slow route (sleeps 15s) → the ticket at ~10s → the model
    continues (a second tool fires while the job runs) → `job_status`
    mid-running answers honestly → the completion event persists + pushes.
  - LEG C THE JOB LAYER (serve path): the fake serve's model calls
    `doomalay_web_fetch` on the slow URL through the engine's `/mcp/oc`
    route → the MCP response arrives well under the serve's timeout with the
    ticket → the serve model continues → the completion lands.
  - LEG D THE KILL: a slow job → `job_kill` → cancelled + the cooperative
    honesty text.
  - LEG E THE HONEST CLOCK: `duration_ms` on every tool_result; the PWA
    source pins (the duration chip, the slow tone, the job row) — §A-style.
- THE TUNNEL (the user's live engine, confirmed v1.71.0-the-honest-reconcile
  at the new URL): the live verification that the RELEASED engine's tool
  flow holds (real turns, pills closing, no hangs) — the v1.71 fixes on the
  real phone; then the rig proves v1.73 on top. A test chat, verified, then
  deleted (leave no trace).
- THE BATTERY: go build + vet · the new v1731/v1732/v1733 pins · the v1672 +
  v1710 + v1720 regression rigs · the census + source-pin re-anchor ·
  discipline 7+B1 · the linux + android-arm64 cross-compiles.

## THE SHIP
- buildinfo **1.73.0** (ONE past the parallel wave's live 1.72.0 — the +1
  law; rebase before push, the parallel wave is active).
- README v1.73 section + the repo worklog record + the sandbox worklog
  append + the tag + the release (the CI builds the APK).
