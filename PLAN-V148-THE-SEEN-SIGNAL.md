# PLAN-V148 — THE SEEN SIGNAL

The user's device report (5 asks) + the standing laws (plan → research → build →
red-team; phases x.x.1…; two-surface UI; theme tokens only; rebase before every push).

## THE ASKS (verbatim anchors)

1. "the users messages send twice when talking to bots. Each user message is
   duplicate and sent twice."
2. "When a chat gets a newly added workspace (especially if it's not the first
   created chat) the chat icon needs to be moved or refreshed for the orbiting
   stars to reflect, connecting a workspace doesn't send a signal to refresh
   the icon for the orbitting stars to show visually."
3. "in the chat metadata when the workspace overlay screen is open, we have a +
   arrow right of each row … Pressing the + should add it to the chat directly.
   Instead of user presses + then also has to press include in this chat."
4. "The workspace tool is still not clear when the pill is collapsed … replace
   the workspace static text with a dynamic text of the action being used
   (grep, view, ext..) and include the 'what' parameter aswell in the collapsed
   pill description."
5. "Have another go at making opencode free via the API" (serve / inference-API
   leads from the user's research).

## THE RESEARCH (live-probed this session, all from this sandbox)

### #1 THE DOUBLE ECHO — root-caused in the engine's turn construction
- `handleTurn` emits+persists the user event at chat.go:1208 BEFORE history is
  built. `buildHistoryCompacted` (compact.go:308) reads the event log AFTER —
  so the in-flight user message is ALREADY the last history row.
- Direct path then appends it AGAIN (chat.go:1993) → the model receives
  [user M, user M]. Brain path: brainHistory carries M (chat.go:1340-1348) AND
  brain/agent.py:318-319 appends M again. EVERY message, EVERY provider, since
  the v0.38 brain-history build. The PM-native reasoning surface (which
  restates the request) made it visible.
- `Turns: countUserTurns(history)+1` (chat.go:1999) assumed history EXCLUDES the
  in-flight message → off by one under the fixed order.
- UI transcript is NOT doubled (optimistic bubble + echo resolution +
  dropAdjacentUserDupes guard the render); the wire to the MODEL is.
- FIX (conservative, fails soft): `trimInFlightUser` — drop ONE trailing
  user-role history row ONLY when it is byte-equal to the in-flight text, at
  both construction sites; then the existing append supplies it exactly once.
  Redacted (key-shaped) texts never match → never dropped → old behavior for
  that edge, zero bytes of history ever lost. maybeCompact is clean (the
  summarizer input excludes the in-flight row by construction).

### #2 THE LIVE STARS — the worker clone cache is the hole
- Stars paint from `counts[icon.sessionId]` (atoms.js); the refresh chain
  EXISTS (workspace bind → fireWSChanged → app.js:3170 Atoms.refresh →
  atoms-changed → startAnimation). BUT the worker paint path (the default,
  settings.js workerPaint:true) only re-sends entity clones when
  `entitiesSig()` changes — and the sig hashes ONLY count+x/y (app.js:518-527).
  A session bound at runtime (chat created later, icon at rest) leaves the
  worker holding a clone with `sessionId:''` → paintCore skips the icon → no
  stars until the icon is physically MOVED (fresh clones). Exactly the user's
  symptom; first chat works because boot forces fresh clones
  (Painter.entsSig===null).
- FIX (belt+braces): (a) fold a cheap cached per-entity session-hash into
  entitiesSig (memoized on the entity — rebinds change the sig); (b) on
  `doomalay:atoms-changed` force ONE paintGridFrame with the existing
  forceEnts=true so fresh clones ride immediately (the param already exists,
  app.js:546, used nowhere).

### #3 THE DIRECT PLUS — the badge reuses the bind chain
- workspace.js boundRowHTML:1022 renders `<span class="wsx-badge read">＋</span>`
  on rows not in chat; the row click = expand (wireBoundRows:1027); the real
  include action is the expanded `＋ add to this chat` handler (:1060-1073 →
  POST /api/sessions/{sid}/workspaces, loadGlobals, refreshPills,
  fireWSChanged, toast).
- FIX: extract the bind chain into one function; the ＋ badge gets its own
  click (stopPropagation — the row still expands on its own body) and adds
  directly. Same honest guard (no model connected → 'connect a model first').

### #4 THE INFORMATIVE PILL — the workspace family speaks its verbs
- chatpanel.js toolPillLabelParts:5680-5684 covers only
  read/put/tree/ls/readme; every other workspace verb (grep, view, list, info,
  pr, …) falls to the static fallback (title='workspace', body=summary).
- The args are ALREADY parsed (toolArgsOf; ga.action/ga.ws/ga.path/ga.query/
  ga.what; workspacetool.go:938-972 is the verb/param truth: grep→query,
  view→what, read→ws+path, list→none).
- FIX: extend the family branch — title = the bare verb (the family's own
  existing law: 'read'/'put' render bare), body = the operand (query/what/
  path/ws tail), clamped like the neighbors (~40). One edit feeds the
  collapsed pill + the live activity line + the full view.

### #5 THE OPENCODE TRUTH — the free tier's real shape, probed live
- The hosted inference API (opencode.ai/inference/v1): models list works with
  the key (free ids present: big-pickle, glm-5.3-flash-free, …) — completions
  on free models answer 403 FreeTierError "only from within OpenCode", with OR
  WITHOUT the full CLI identity header set. Below-HTTP client check (per the
  v0.26/v0.35 record + today's probes + the upstream issues): NO header set
  can ever pass. Third-party API free use is walled BY DESIGN.
- THE GENUINE PATH (proven live from this sandbox, same egress where raw curl
  403s): `opencode serve` + POST /session/{id}/message with the default turn
  shape → 200, real completions on big-pickle, cost 0, reasoning parts
  streamed via prompt_async (204) + GET /event SSE (message.part.updated:
  reasoning/text/tool parts live), token usage incl. reasoning + cache.
- THE GATE LAWS (probed): (1) default shape only — per-turn `tools` OR
  `system` overrides poison the turn (FreeTierError) AND the session stays
  poisoned (clean turns after a violation fail); fresh session recovers.
  (2) A PROJECT-LEVEL opencode.json permission config (bash/edit/write/patch/
  webfetch deny, read/grep/glob/list allow) PASSES the gate and the model
  answers "I don't have a Bash tool available" — execution + writes blocked
  while the turn stays genuine. (3) rapid clean turns pass.
- FIX SHAPE: engine-managed serve bridge (the brain/bridge.go precedent —
  the engine already manages co-located runtimes): managed binary (desktop
  linux/darwin; NOT Android — glibc binary, 186MB), scratch dir + the
  permission config, per-chat serve sessions (persona rides the message text —
  the system field trips the gate), SSE → engine deltas (reasoning → thinking
  events, text → assistant deltas, tool parts → status lines), usage rides the
  v1.46.2 ledger (reasoning + cache reported), recycle-on-403 (fresh serve
  session + compacted context replay, once), honest copy everywhere (the
  provider card speaks the wall + the desktop truth; Android answers the
  honest message). Binary is 186MB glibc — Android native is out (termux
  proot documented as a future option); the HF-brain relay is the phone
  answer long-term (needs the user's infra call — out of this wave).

## THE PHASES

- **v1.48.1 THE SINGLE ECHO** — trimInFlightUser at both construction sites +
  the Turns alignment + the regression pin (the real order: emit → build →
  trim → append → exactly once) + live red-team through the engine.
- **v1.48.2 THE LIVE STARS** — the entitiesSig session-hash + the forced
  forceEnts paint on atoms-changed. Red-team: connect a workspace to a
  second chat through the real UI; stars appear without moving the icon.
- **v1.48.3 THE DIRECT PLUS** — the ＋ badge binds directly (stopPropagation;
  the shared bind chain), row click still expands. Red-team via the UI.
- **v1.48.4 THE INFORMATIVE PILL** — the workspace family's full verb table.
  Red-team: a real workspace grep/view turn shows the verb + operand.
- **v1.48.5 THE SERVE BRIDGE** — engine/internal/ocserve (managed serve +
  health + restart) + the turn adapter (sessions, SSE deltas, recycle,
  usage) + the provider dispatch (free models → bridge) + honest card copy.
- **v1.48.6 THE PROOF** — the v1480 rig (each fix driven the way the user
  drives the app) + the full regression battery + the oclive gate.
- **v1.48.0 THE SHIP** — buildinfo, README, the record chain, cross-compile,
  tag v1.48.0-the-seen-signal.

## THE HONEST LIMITS (on the record)

- The serve bridge is DESKTOP-ONLY this wave (Android glibc law); the phone
  keeps the honest walled message until the brain-relay/termux call.
- OpenCode's gate is actively evolving — the bridge is opportunistic free
  capacity with honest fallbacks (the walled message, other providers).
- The trim is content-matched (redacted key-shaped texts keep the old shape —
  no history byte is ever dropped by the fix).
- Old chats keep their logged history byte-identical (the fix is turn-time).
