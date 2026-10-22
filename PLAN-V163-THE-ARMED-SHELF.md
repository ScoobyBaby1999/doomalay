# PLAN-V163 THE ARMED SHELF — opencode native tools + the living wire + the unlost tail

The user's ask (verbatim core): "We still have issues where the chat loads weird, long
chats get preserved malformed, with messages unordered, the bottom chunk of tools and
reasoning calls after the final response doesn't save and gets lost. Also opening a chat
still points us at the top not the bottom… Opening the chat for a user should load bottom
up not top down. The most recent chats are what's important, older messages can stay
dormant until scrolled to… give a very generous amount (a month or couple worth of
messages - 50ish mb maybe uncompressed). Another thing, opencode zen has a bug where it
uses its own pills, our tools are not armed natively… Moreso it seems opencode can think
for so long and nothing happens. We get the thinking pill for minutes on end with no
visual feedback… one chat has the thinking pill for so long, another gets a direct reply.
It's a bug from our end. Focus on fixing opencode, test it yourself. We are not rate
limited, if you hit rate limits it's a false positive."

## THE DIAGNOSIS (four convictions)

### D1 — THE UNMOVED ADOPTEE (tools not armed natively)
The device's own serve-side self-diagnosis (the user's paste): 30 doomalay tools run at
`http://127.0.0.1:8080/mcp/oc/<id>`, they answer — but the serve session's tool schema
carries ZERO of them; zero `mcp` connection lines in opencode.log; the per-chat config
`chats/<id>/opencode.json` exists but "the serve never reads it" because the serve process
runs with cwd = `opencode-serve/` (the root config = permissions + websearch only).
ROOT CAUSE (code-level): `ocServeSessionID`'s ADOPTION path (v1.59.2 THE SERVE MEMORY)
re-writes the per-chat config file but NEVER MOVES the adopted session — a session born
before the per-chat era (or one whose move failed: "session rides unbound") lives in the
serve's ROOT location forever, resolving the ROOT config → no MCP block → no native
tools. Fresh sessions (v1.60) get `CreateSessionInDir` (create + move) — the adoptee is
the hole.
RESEARCH-VERIFIED (opencode 2.1.x source + docs, 2026-10-22): `POST
/api/session/{id}/move {"directory"}` boots the destination's location instance and the
session is served by it — project config INCLUDING MCP re-resolves from the destination
directory (per-location instances: "one instance is one compiled, fresh copy of the graph
standing on a directory" — location-services.ts). `OPENCODE_CONFIG` env applies to serve;
no `--config` flag exists. A GLOBAL mcp entry can never serve this app (one serve child,
many chats, per-chat URLs) — the per-session move is the only correct vehicle.

### D2 — THE CODE MODE MASK (own pills, not ours)
`codemode: true` (the v1.60.4 flip, the schema's DEFAULT) does NOT expose MCP tools to
the model as tools — it bundles them INSIDE Code Mode's single `execute` tool as dotted
`tools.doomalay_<name>` calls (schema: "Expose this server's tools through Code Mode.
Defaults to true."). The user sees opencode's own execute pill with nested statuses —
"it uses its own pills, our tools are not armed natively". `codemode: false` exposes each
MCP tool DIRECTLY to the model as a first-class bare tool named `doomalay_<tool>` (the
permission config's `doomalay_*` allow-rules were written for exactly this arm). v1.60.4
convicted codemode:false mid-rig because the model (taught Code Mode naming by the then-
current {tools} block) tried `tools.doomalay_calculator` inside execute — the block
taught the wrong grammar for that arm. THE FIX: flip to codemode:false + teach the
DIRECT grammar in the {tools} block + strip the `doomalay_` prefix in the pump so the
pills render byte-identically to native ones (calculator | 17*23, not doomalay_calculator)
+ LIVE-PROVE the direct route end-to-end with the real key (the unproven arm gets
proven or the flip reverts — the v1.60.4 law cuts both ways).
BONUS: subagents inherit the session's location → the per-chat dir → subagents get the
tools natively too (the user's "subagents could have our tools").

### D3 — THE DEAD WIRE (thinking pill for minutes, arbitrary waits)
The pump's `/api/event` SSE connection has NO liveness law: `http.DefaultClient` with no
read deadline — a silently-dead connection (mobile network switch, NAT timeout, the
serve's own reloads) blocks in `ReadString` FOREVER while the turn keeps running
serve-side. The silence probe polls the durable record and honestly answers "still
running" — so the UI shows the static "X is thinking…" pill for MINUTES with zero
feedback ("nothing happens"), and whichever chat's connection survived gets the direct
reply ("the wait is arbitrary"). RESEARCH-VERIFIED: the serve sends `: heartbeat` SSE
comments every 15s and the first event is `server.connected`; the official client kills
a stream at 45s without bytes; the bus is global, multi-subscriber, and VOLATILE (a
reconnect misses the gap; the durable message log is the catch-up truth).
THE FIX: (a) StreamEvents gets a 45s byte-deadline watchdog (3× the heartbeat) that
cancels the dead connection and RECONNECTS (bounded backoff) until the turn's terminal —
the terminal always lands, live or off-wire; (b) the pump's quiet probe emits HONEST
progress pings ("still working… Ns in this turn") so the activity line moves with the
truth (the PWA's stall law eats the rest); (c) `session.step.started` rides as a progress
line; (d) the idle marker's `interrupted` outcome (research: outcome ∈
succeeded|failed|interrupted) is treated as an honest failure, not an empty success.

### D4 — THE LOST TAIL + THE TOP-DOWN OPEN (chat persistence)
(a) THE CODE MODE HALF of "the bottom chunk of tools and reasoning after the final
response doesn't save": nested Code Mode calls ride `session.tool.progress` (EPHEMERAL —
never persisted); the execute pill's persisted pair carries only the wrapper — the nested
doomalay calls VANISH on reload. D2's native arm fixes the class (every call a
first-class session.tool.* frame → a persisted pill).
(b) THE ENGINE-DEATH HALF: an Android engine kill mid-turn loses the unsent tail (the
serve — wake-locked in Termux — COMPLETES the turn; the engine log dies mid-stream; the
boot heal splices "interrupted by engine restart" wherever it lands; the next
continue/send interleaves with the splice → "long chats preserved malformed, messages
unordered"). THE FIX: THE SERVE TRUTH RECONCILE — at adoption time, when the engine's log
ends mid-turn for a chat with a living serve binding, fetch the serve's own durable
message list (GET /api/session/{id}/message, asc, the turn's messages), map the missing
tail (text → assistant rows, tool parts → tool_use/tool_result pairs, reasoning →
thinking rows) into the engine log BEFORE the healed terminal. The serve's transcript is
the durable truth the engine adopts — the same law as the session binding (v1.59.2),
extended to the transcript.
(c) THE OPEN LAW: "Opening the chat for a user should load bottom up not top down." The
v0.34 "back where the user left off" scroll-memory restore is the thing pointing at the
top — it dies. Every fresh open lands at the BOTTOM (the newest messages), always.
(d) THE GENEROUS WINDOW: "a month or couple worth of messages - 50ish mb" — a per-
session retention budget (default 48MB of event payload, idle-time trim in Maintain(),
oldest-first, never mid-turn) + the bulk-load bootstrap caps at the tail (the last
~2,500 events) with older history DORMANT until scrolled (a `?before=<seq>` page fetch
rides the existing backfill boundary) — "the most recent chats are what's important".

## THE SUB-WAVES

### v1.63.1 THE NATIVE SHELF — every serve session lives in its per-chat dir, tools bare
- ocserve: `SessionDirectory(serveSess)` (GET /api/session/{id} → data.directory; ""
  when the build doesn't speak it) + the adoption path in ocServeSessionID MOVES the
  persisted session into the per-chat dir when the directory differs (or is unreadable —
  once per engine run; a failed move degrades to bound=false honestly, the standing law).
- ocserveturn: the per-chat config entry flips `codemode: true → false` (the DIRECT arm);
  the {tools} block teaches the DIRECT grammar ("call doomalay_<name> directly by name —
  they are first-class tools, NOT inside Code Mode's execute"); the pump strips the
  `doomalay_` prefix for the pill name (display + persisted payload) so the pills render
  byte-identically to native ones; ocToolSummary gains the doomalay-family operand
  derivations (calculator → the expression, web_search → the query, … — the native
  table's own laws).
- Pins: the config bytes (codemode:false + the direct naming), the adoption move (both
  spawners), the prefix-strip law, the {tools} block grammar.

### v1.63.2 THE LIVING WIRE — the stream never dies silently, the wait speaks
- ocserve: StreamEvents restructured as streamOnce + a reconnect loop (250ms→2s backoff)
  until the terminal/ctx; a byte-deadline watchdog (45s, reset on every read — the 15s
  heartbeat law) cancels stale connections; the reconnect re-filters the same session
  (server.connected is foreign — filtered as today).
- ocserveturn: the quiet probe emits the honest elapsed ping ("OpenCode: <model> is
  still working… Ns in this turn") on every probe tick that finds the turn alive;
  session.step.started → a progress line; SessionIdleSince treats outcome=interrupted
  as failed (honest message: interrupted on the serve).
- Pins: the watchdog (a stalled body dies + reconnects + the terminal still lands), the
  progress pings on the wire, the interrupted verdict.

### v1.63.3 THE UNLOST TAIL — the serve's transcript is the truth; the open lands at the bottom
- ocserve: `ListSessionMessages(serveSess, …)` (GET /api/session/{id}/message?order=asc
  + the cursor walk) — the durable transcript reader (live-captured shape: user/
  assistant/idle + parts).
- ocserveturn/server: THE SERVE TRUTH RECONCILE — at adoption, a mid-turn engine log +
  a living binding → fetch the serve's turn tail, map it (text → assistant, tool parts
  → tool_use/tool_result with the pill grammar, reasoning → thinking) into the log
  BEFORE the healed terminal; a failed/absent serve degrades to today's heal (honest).
- chatpanel: THE OPEN LAW — the fresh open ALWAYS lands at the bottom (the scroll-map
  restore dies; restoreChatScroll's bottom branch is the only branch on open); the
  bootstrap caps at the tail window + `?before=` pages feed the backfill boundary (older
  history dormant until scrolled); retention: per-session 48MB budget trimmed in
  Maintain() (oldest-first, never the active turn's window).
- Pins: the reconcile mapping (seeded serve + killed engine → the tail lands whole), the
  bottom-open law, the dormant-older law, the retention budget.

### v1.63.4 THE LIVE PROOF — the real serve, the real key, the whole chain
- scripts/v1630-armed-shelf-rig.py: DESKTOP — spawn the real 2.1.x serve (the engine's
  own EnsureBinary), bind a chat, send a REAL turn with the user's real opencode key:
  (S1) the direct arm: the model calls doomalay tools bare-named (calculator end-to-end,
  the pill grammar on the WS exactly as the PWA sees it); (S2) the adoption move: kill
  the engine maps, re-adopt → the session's directory IS the per-chat dir → the tools
  list still answers; (S3) the living wire: stall the SSE body > 45s → the watchdog
  reconnects → the turn's terminal lands; the progress pings ride the wire; (S4) the
  reconcile: kill the engine mid-turn, restart, adopt → the serve's completed tail
  lands in the engine log (assistant + tools + the healed seam); (S5) the open laws:
  bulk bootstrap tail + bottom mount + dormant older pages + the retention trim.
- ANDROID-CHAIN (the fake bridge jail, the v1491 pattern): the per-chat config bytes on
  the termux spawner (codemode:false), the adoption move through the jailed ServeDir,
  the no-spawn reconcile gate.
- The full Go battery + vet + cross-compiles (linux + android-arm64).

### v1.63.0 THE SHIP — buildinfo 1.63.0 (ONE past v1.62.0 — the user's version law:
"push 1 version ahead not 2"), README v1.63 section, worklog record, the tag, the
rebase-before-push protocol.

## THE HONEST SCOPE LINES
- No shared single-SSE redesign: per-turn streams + reconnect + the durable probe cover
  the failure class (multi-subscriber is verified fine); the shared bus is a future wave
  if the device convicts it.
- The reconcile maps the serve's RICH part shapes to the engine's pill grammar
  conservatively — unknown part types degrade to honest text rows, never dropped
  silently (the whole-truth law).
- The retention window is per-session BY DEFAULT (48MB ≈ the user's "50ish mb"); the
  trim never touches the active turn's rows (busy-gated).
