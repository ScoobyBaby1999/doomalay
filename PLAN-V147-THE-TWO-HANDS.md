# PLAN-V147 — THE TWO HANDS

Two parallel bots died mid-work; this wave finishes BOTH, plus one standing
directive that rode with them. The user's asks, verbatim:

- **Kenny** (died on the PM key's monthly token limit mid-plan): *"I want to
  port the journal into the app so all the users can use it. It should come
  as a native tool with the other 20+ tools."* + the last directive, which
  this wave also owns: *"The journal doesn't have to work on the old pm
  bridge, we can get rid of the fallback old pm bridge since we have native."*
- **Dock** (died mid-research, one turn, nothing pushed): *"My first ask is
  to implement a method to or tool you can use to check other chatbots that
  are active, and info about them — the canvas, the name, relevant metadata
  (sort of like a simple one with name/model - canvas - and essential info
  with a filter, then another method that expands and lists the full details
  of one chatbot, including its current actions and progress)."*

Neither bot pushed a single commit (verified against origin/main @622f754:
no `journal-native`, no `fix1457`, no fleet branch — only the many-worlds
wave's v1.42.7 on top of our v1.46.0 ship). This wave is built from their
plans, in phases, per the phase discipline.

## Research verdicts (this session)

- **R1 — the journal's spec already lives in-repo.** `brain/tools/dt_journal.py`
  (1,208 lines) is the authentic source: actions write/read/search/review/
  moods/prompt/export/help; state = append-only JSONL (`entries.jsonl`);
  dedup key `(date, created)` (an exact replay is an idempotent no-op); a
  FRESH same-date write appends with a `#2` id suffix; moods normalize to ONE
  int 1..5 (numbers beat words beat emoji; bools rejected; out-of-range =
  None, never clamped); reviews are per-ENTRY averages with a ±0.2 trend dead
  zone vs the previous equal-length window; streaks count DAYS (yesterday-
  grace: an unwritten today mid-evening never zeros a live streak); 45
  prompts rotate by day-of-year; exports round-trip JSON and atomically
  write `export.md`/`export.json`; corrupt JSONL lines are skipped, never
  fatal; replies cap at 6,000 chars with an honest pointer at the file.
- **R2 — Python `round()` is banker's rounding (half-to-even); Go's
  `math.Round` is half-away-from-zero** (docs.python.org, stackoverflow
  /10825926). The moods timeline's per-day average and `mood_scale`'s float
  coercion use `round()` — an authentic port needs a `pyRound` helper
  (half-to-even), pinned by a unit test at the exact tie (2.5 → 2, 3.5 → 4),
  or the glyph column silently diverges from the brain's journal on ties.
- **R3 — the fleet roster's shape is grounded in the A2A Agent Card model**
  (agent2agent.info/docs/concepts/agentcard, a2aproject/A2A spec): identity
  (name/description), capabilities (streaming, state transition history),
  skills, endpoint — plus the OpenAI Assistants run-status grammar
  (queued / in_progress / requires_action / completed / failed —
  community.openai.com/1090639). Our engine's equivalents: identity =
  session row (title, provider/model, persona, effort, mode); canvas =
  the `canvases` table's digest (WorldState icons hold session ids);
  capabilities = the armed pills (web_search, deep research, template,
  skills, lib, termux) + connected workspaces; state = the per-session
  turn lock (running/idle) + the events tail (the current action:
  last user head → tool_use name+summary → assistant head → status
  terminal+usage). Everything the user asked for ("the canvas, the name,
  relevant metadata… current actions and progress") is ALREADY in the
  engine's tables — the tool is an honest read surface, no new state.
- **R4 — the "old pm bridge" remnant is the `/api/tools/*` surface.**
  server.go registers five GET routes (`/api/tools/websearch`, `/webfetch`,
  `/local`, `/skills`, `/hublib`) — the dead WebView-bridge chat's tool
  contract (tools.go's own header: "the local tool server for PM"). ZERO
  consumers remain: not the web layer (grep: no `api/tools` in
  engine/internal/server/web/*.js), not the app (grep: no `api/tools` in
  platforms/android), not the brain, not the docs (one stale
  HF_CAPABILITY_MATRIX row from v0.20). The CURRENT surfaces — the mcpbus
  (the chats), `/mcp` (external consumers, the session-less fallback Turn),
  and `/api/pm/local/v1/chat/completions` (the brain's local PM bridge,
  v1.44.5 — REQUIRED, litellm cannot speak PM's E2E protocol) — all stay.
  The purge removes routes + thin HTTP wrappers only; the shared cores
  (RunLocalTool, skillsDispatch, hublibDispatch) are the mcpbus's
  implementation and live on untouched.

## The phases

- **v1.47.1 THE JOURNAL HAND.** `engine/internal/djournal` — the authentic
  Go port of the dt_journal.py core, function by function (moodScale,
  addEntry, streaks, daysSinceLast, parseRange, parsePeriod, readEntries,
  searchEntries, reviewSummary, moodTimeline, pickPrompt, exportEntries,
  loadEntries, appendEntry, runAction, help) with `pyRound` for the Python
  rounding parity. State: `<DataDir>/journal/entries.jsonl` — ONE journal
  per install (a diary is not per-chat; entries carry no session stamp —
  same as the brain's per-workspace journal). The mcpbus gains the 30th
  Def (`djournal`, always armed — GateNone), the Turn/ChatRequest closure
  (`DjournalToolFn`), the handler case, the mcpGates-free wiring in the
  server (always: `s.runDjournalAction`), and a DefaultSummary row (the
  action + target/query head). The fallback Turn refuses honestly (a
  session-less /mcp consumer has no journal). Exports ALSO sink into the
  session's artifact drawer when a Sink is armed (the docx/xlsx pattern —
  the download card), in addition to the state-dir `export.md`/`export.json`
  (the Python law). Unit battery: the 15 Kenny scenarios (confirm+streak,
  same-date #2, replay dedup, read today/range/unparseable, search
  hit/no-match/field/mood-warning, review stats/streaks/trend/bar, moods
  timeline, prompt determinism, export round-trip, help, unknown action,
  empty text, mood_scale table, corrupt-line skip, load/append) + pyRound
  ties + the 6,000-char cap.
- **v1.47.2 THE FLEET HAND.** `fleet` — the 31st native tool, the roster +
  detail read surface over the engine's own truth: roster rows
  `title — provider/model — canvas — state — last activity — turns`
  (running first, then last-activity desc; filter `q` substring over
  title/model/provider/canvas; cap 30 rows + the honest "N more" line);
  detail (`target` = id or title prefix) = the FULL card: identity (title,
  id, provider, model, effort, mode, persona name, template, preamble),
  canvas membership, the armed capabilities (pills + workspace bindings +
  sandbox), the LIVE state (running now? what it's doing — the events tail:
  the last 6 events as a timeline with heads: user, tool_use name+summary,
  assistant, thinking, status terminal+usage), and the honest telemetry
  (turns, tokens in/out/reasoning, cost when priced, last activity age).
  The same wiring as the journal (Def, closure, handler, summary row).
  Honest limits on the face: brain-side swarm sub-agents are not sessions
  (invisible); the roster reads a snapshot (a running turn's phase can age
  between the read and the render — that's a snapshot, not a stream).
- **v1.47.3 THE BRIDGE PURGE.** The five `/api/tools/*` routes + the thin
  HTTP handlers (tools.go: handleToolsLocal/handleToolsWebSearch/
  handleToolsWebFetch; skills.go: handleToolsSkills/handleToolsHublib) die;
  the workspace test that pinned the legacy route re-pins the mcpbus path;
  the stale HF_CAPABILITY_MATRIX row dies; the mcpbridge fallback-Turn
  comment ("exactly like the PM bridge's /api/tools/* contract") updates
  to speak the /mcp truth alone. The dispatch cores stay (RunLocalTool is
  the mcpbus local-tool implementation; skillsDispatch/hublibDispatch are
  the Skills/Hublib closures' bodies).
- **v1.47.4 THE PROOF.** `scripts/v1470-two-hands-rig.py` — the live
  red-team battery driven the way the real user drives the app (a real
  browser page on a real engine, the real keys): RA the journal hand live
  (write → read → review → moods → prompt → export through the engine's
  own WS chat protocol with a real provider turn; the artifact card rides
  the export; the file on disk round-trips; the 6,000-char cap; the replay
  dedup); RB the fleet hand live (seed N chats across canvases, start a
  real turn in one, assert the roster shows it RUNNING with the canvas
  name, the filter narrows, the detail card carries the current action +
  progress); RC the bridge purge (the five routes answer 404; the mcpbus
  still serves the local/web/skills/hublib tools through the REAL turn
  path); RD the source pins. Regressions: v1350, v1400, v1440, v1450,
  v1460, the go battery, all pmlive gates.
- **v1.47.0 THE SHIP.** buildinfo 1.47.0 (the wave record in the house
  style, the v1.46.0 prior preserved in the chain), README's tool census
  + the journal/fleet notes, the repo worklog chain, the tag
  `v1.47.0-the-two-hands`, cross-compile linux + android-arm64, /api/health
  answering 1.47.0 live.

## Coordination (the parallel-bot law)

Fetch immediately before every push (the other waves push every ~20
minutes); the v1470 rig's RD pins verify this wave's shapes on any tree.
The phase commits are independent enough to survive a mid-wave rebase:
djournal is a NEW package + additive Def rows; the fleet tool is additive;
the purge is a small mechanical diff over three files.
