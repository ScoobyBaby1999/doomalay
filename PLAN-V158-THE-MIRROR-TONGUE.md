# PLAN-V158 — THE MIRROR TONGUE (OpenCode 1:1 native parity)

The user's ask verbatim: "OPENCODE WORKS! … our goal is to have opencode run
natively like all other providers … we must make it mimic the native providers
as 1:1 as we can get it to, especially when it comes to it's continuity and
ability to hold turns without interruptions and setbacks (like our native chat
does) and tool use capabilities (every tool and capability our native chat has,
tools should also not return truncated or incomplete or broken or data with
silent drops). … opencode tools show opencode:grep or opencode:tool name and
then a running description. This is Terrible, can't we have it show the same
descriptions every other provider does, where it shows grep or whatever plus
insightful data next to it not just a static running. … try reusing the one we
have or inherit or something, keep Object Oriented practices. And make sure to
test your results, grep should return regular hits, not be broken."

## THE RESEARCH (live-probed 2026-10-22, before any build — the standing law)

R1 THE GATE PASSES WITH OPEN HANDS (probe: v157-parity-probe.py): a REAL 2.1.2
   serve with shell/edit/webfetch/subagent/websearch ALLOWED + question denied
   ran write→grep→read→execute→shell turns on big-pickle, cost 0, gate green.
   The v148 deny-law extends: the gate reads the genuine client, not the
   permission config.

R2 THE TOOL EVENT VOCABULARY (captured frames, v151-sse-events2 + v157 probe):
   · session.tool.called {id, input: STRUCTURED DICT, executed} — every tool
   · session.tool.progress {metadata: {toolCalls:[{tool,status,input}] |
     shellID}} — LIVE progress mid-tool (execute sub-calls, shell sessions)
   · session.tool.success {content[], metadata: {truncated: BOOL}} — the
     serve itself declares truncation honestly
   · session.tool.failed {error:{type,message}} — type "permission.rejected"
     for denied actions; "tool.execution" for failures.
   Our pump today consumes ONLY input.started/input.ended/success/failed —
   the live progress + the honest truncated flag + structured input are on
   the wire UNUSED.

R3 THE 6000-CHAR SILENT CLAMP (convicted): ocserveturn.go tool_result rides
   clampServer(text, 6000) — the v1.56.0/1.56.1 disease (silent amputation)
   on the opencode path: a big grep result silently loses everything past
   6000 chars. Native rides turnObsBudget (window-physics: 90% of the
   model's documented window, 1MB floor capped at a quarter of the window).
   llm.ContextLimitFor is exported — the SAME law is reusable verbatim.

R4 THE STATIC "running" PILL (convicted): emitToolUse sends
   name="opencode:"+name, summary="running" — the PWA renders title
   "opencode:grep" body "running". Native pills: title=verb (grep), body=
   operand (the pattern) — derived at executeAction time from the args. The
   PWA's toolPillLabelParts else-branch renders title=p.name, body=p.summary
   — so an engine-side derived summary = byte-identical native rendering
   with ZERO new PWA pill code (the OOP reuse the user asked for).

R5 WEBSEARCH WORKS KEYLESS (probe 1 + 2): the device's "Web search
   cancelled" = NO PROVIDER SELECTED → the interactive ask-flow fires
   headlessly → cancelled. Setting "websearch": {"provider": "tavily"} in
   the serve config makes websearch WORK through the serve with the
   existing OPENCODE_API_KEY (real IEEE results, cost 0 — the search rides
   the authenticated account). NO extra key needed.

R6 SUBAGENT + WEBFETCH PASS (probe 2): subagent spawned a real child session
   on the free tier (gate green); webfetch fetched example.com. Both safe to
   allow.

R7 THE RULES-ARRAY GRAMMAR (docs + probe 2): V2 permissions = ordered rules
   {action, resource, effect}, LAST-MATCH-WINS, unmatched action → ask (the
   headless hang) → every action needs an explicit rule. Probe 2 convicted
   MY OWN rule order: the broad deny AFTER the $HOME allow wins (deny) — the
   narrow allow must come AFTER the broad deny. $HOME expands in
   external_directory/read/edit resources. Shell carries host authority
   (the docs' own warning) — the user's explicit "full access as a real
   user" stance makes shell:allow the choice; the honest persona says so.

R8 THE PER-CHAT TERMUX CAPABILITY is a pure UI flag for opencode chats (the
   serve rides the DEVICE bridge, never the per-chat tool) — the user's
   "auto-turn it on + reflect in UI" = flip sess.Termux at turn time (engine
   self-heal) + the PWA chip reflect. Idempotent both sides.

R9 THE PROVIDER-SCREEN PILLS ARE FETCH-GATED (convicted): providerPills
   returns [] when the one-shot bridge fetch hasn't landed (4s cap, no
   retry; the 2s poll only runs DURING installing) — that's the "pills only
   show after I click get API key / disappear with setup progress" disease.
   The fix: pills render ALWAYS (3 states: not-setup action / setting-up
   live / setup dim), a light always-on poll while the panel is open, and
   the fetch-hiccup keeps the last truth.

R10 THE HONEST TOOLS ADDENDUM (the chatlog's Tier-0 finding): the opening
   text advertises workspace/hublib tools the serve never had — the model
   burns turns hallucinating them. The opening text for opencode chats must
   list the session's REAL tools (the config's own truth).

## THE PHASES

### v1.58.1 THE INFORMATIVE PILL — tool pills 1:1 (the main ask)
· ocserve.go: eventData gains Metadata (typed: toolCalls, shellID, truncated).
· ocservetools.go (new): ocToolSummary(name, args) — the verb+operand table
  (read→path-tail, glob/grep→pattern, edit/write→path-tail, patch→first
  section's file, shell→command head, websearch→query, webfetch→url,
  skill→id, execute→code first line, subagent→description, session_move→
  directory, unknown→first string arg; NEVER a static string). Pure
  function + its own pins.
· ocserveturn.go: emitToolUse → name WITHOUT the "opencode:" prefix +
  summary=ocToolSummary (the PWA renders title=verb body=operand natively);
  tool.called belt (structured input marshaled when input.ended never rode).
· THE UNBOUNDED RESULT: clampServer(6000) dies; the result rides
  ClampMarked(text, obsBudget) with obsBudget = the window-physics law
  (llm.ContextLimitFor(sess model) + the 90%/quarter/floor formula — the
  same numbers turnObsBudget uses); the serve's metadata.truncated=true →
  an honest "⚠ opencode shortened this output" tail line.
· THE LIVE PILL: session.tool.progress → tool_stream pings (delta = the
  derived compact line: "opencode.models: running" / "shell sh_…: in flight")
  — the PWA's live tail + the stall-law bump both ride the existing
  tool_stream machinery.
· chatpanel.js: mergeToolResult + the tool_stream matcher prefer
  tool_use_id (fallback name — the legacy events unchanged); parallel
  same-name calls can never mis-merge.
· Pins: the summary table, the no-prefix law, the budget law (a >6000-char
  result lands WHOLE), the progress ping, the truncated marker, id-merge.

### v1.58.2 THE OPEN HANDS + THE WIDE SHELF — capabilities, continuity, BOTH toolsets
· The NEW permission config (rules array — one constant, both spawners):
  question deny (headless ask = hang); subagent allow (R6); external
  * deny THEN $HOME/* allow (R7's order law); read/grep/glob/shell/webfetch/
  websearch/skill/execute allow; edit $HOME/* allow; + "websearch":
  {"provider": "tavily"} (R5 — the device's cancelled disease dies).
· THE WIDE SHELF (the user's new ask, live-proven v158 research):
  the app's own tools are ALREADY an MCP server (v1.13 /mcp,
  X-Doomalay-Session binding, server name "doomalay-tools"); the 2.1.2
  serve attaches remote MCP servers from config (initialize → tools/list
  dance captured through the MITM; protocol 2025-11-25; custom headers
  RIDE). THE PER-CHAT BINDING (concurrency-safe): each serve session is
  MOVED into its own directory (POST /api/session/{id}/move {"directory"},
  extracted from the binary's routes, live-proven) whose opencode.json
  carries the MCP entry url http://127.0.0.1:<engine-port>/mcp/oc/<app-chat-id>
  + codemode:false (DIRECT tools — the model calls calculator/fleet/…
  bare-named; the pill grammar rides ocToolSummary's derived fallback) +
  oauth:false + headers belt. THE ENGINE mounts /mcp/oc/{chatID} — a
  request-clone wrapper injecting X-Doomalay-Session (the SAME resolution
  path as the header; zero new resolution code). sessionMcpTurn gains the
  missing Fleet + Djournal arms (the /mcp path never had them — convicted
  live: "the fleet tool needs a live session" with the header RIDING).
  tools/call also carries _meta.ai.opencode/sessionID (the serve session)
  — the belt: the engine's ocServeSessions map inverts serve→app chat.
· ocServeOpeningText: the honest tools addendum (R10) — the session's
  REAL merged catalog: the opencode native toolset (read/write/edit/
  shell/glob/grep/webfetch/websearch/subagent/execute/skill + the Code
  Mode namespaces) + the app's 31 tools via the doomalay MCP server
  (calculator, time_now, uuid, random, base64, url_encode, hash, json_tool,
  text_stats, regex_extract, docx_create, xlsx_create, zip_create,
  zip_extract, archive_create, archive_extract, web_search, web_fetch,
  template_list, template_show, hublib, workspace, persona, journal
  (djournal), fleet, delegate, termux, skills…) + the honest NO-ACTION
  grammar note (never write "ACTION: …" prose — call the tools directly).
· THE DYNAMIC PROGRESS LINES: the static "OpenCode free bridge: turn in
  flight" dies; the pump emits phase-true progress events (connecting →
  turn started → "<model> is thinking…" → tool lines) — the activity
  indicator moves with the turn's truth.
· THE TERMUX AUTO-ENABLE (R8): runOcServeTurn on the pocket path flips
  sess.Termux in the store (self-heal) + a progress line says so; the PWA
  send-path flips the chip live through the existing persistCaps chain when
  the bridge is the pocket bridge.
· Pins: the config byte-shape (desktop + termux), the per-chat dir law,
  the /mcp/oc route, the sessionMcpTurn arms, the addendum, the phases.

### v1.58.3 THE STEADY PILLS — the provider screen (secondary ask 2)
· providers.js: THE ALWAYS LAW — pills render on the row from the first
  paint (checking → not-setup default), never []; the 3 states (not-setup
  action / setting-up live / setup dim) with the failed→retry + checking
  rungs; the light poll runs WHILE THE PANEL IS OPEN (2s single-flight
  aborting — the route is non-blocking since v1.55.1); a fetch hiccup keeps
  the last truth (no vanishing); walled/unconfigured keep their honest pill
  (the click toasts the gate's own detail).
· The termux pill gains its setting-up rung (the TermuxSetup overlay's
  ladder feeds it).

### v1.58.4 THE LIVE PROOF — scripts/v1580-mirror-tongue-rig.py
· DESKTOP (the real serve + the real key): the derived pill summaries live
  (grep→pattern, read→tail…), the >6KB result WHOLE, websearch WORKS
  (R5), webfetch, subagent, shell, the honest addendum, the dynamic
  phases, the ledger cost 0.
· ANDROID-CHAIN (the fake bridge jail): the rules-array config bytes, the
  key.env, the auto-enable self-heal, the steady pills, the resumed turns.
· --device: the tunnel gate (down at plan time — the standing honest skip).

### v1.58.0 THE SHIP — buildinfo 1.58.0, README, worklog, the battery,
  cross-compiles, the rebase law, the tag.
