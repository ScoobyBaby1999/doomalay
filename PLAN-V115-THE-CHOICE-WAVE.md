# PLAN-V115 — THE CHOICE WAVE

The user's directive (2026-10-08), four fronts:

1. **THE AUTOPICKERS** — no more hardcoded model lists. Pick from the
   provider's *available* models (as the model-browser's Ready filter
   shows them) — or better: **force the user to select a model**, with a
   very short formatted text that shows them where the model screen is.
2. **THE DECOUPLE REDTEAM** — chatbots and browser panels/tabs must not
   interfere with one another; per-chatbot WebSocket isolation verified
   end to end; each chatbot gets its own respective space.
3. **THE TRIM** — no dead code, no unneeded backwards compatibility, a
   coherent workflow, no O(n²)+ anywhere a workaround exists. Focus: the
   chat files + everything that makes up the session.
4. **THE SHELL PLAN** (design only, this wave) — how to deliver bash /
   shell / real Linux to Quick Chat (modal or other), then the local
   Termux path.

Research receipts (web, 2026-10-08): xterm.js + PTY backend is the
canonical browser-terminal pattern (ttyd / gotty / Medium "Go backend for
Xterm.js"); full-Linux-in-WASM exists (v86, CheerpX, LinuxOnTab) but
boots 30MB+ images and emulates — wrong tool for a native-engine app
whose host already HAS a kernel. assistant-ui / aiuxplayground model-
selection patterns: recent-first, capability-gated lists, no silent
defaults — matching the forced-choice directive.

Baseline: v1.14.6 (THE SOLID STREAM — per-chat turnFSM + the OpenCode
per-chat session-id leak fix). The wave builds on top; the parallel
HONEST-ENGINE wave owns v1.14.x, so this wave runs v1.15.x phases.

---

## Phase v1.15.1 — THE CHOICE (autopickers → forced selection)

**Frontend (engine/internal/server/web/):**

- `providers.js`: DELETE `pickAutoModel`'s `KNOWN_GOOD` table, DELETE
  `FALLBACK_MODELS`, DELETE the popularity/known-good scoring. The one-
  press connect NEVER silently picks a model again. `smartConnect`
  becomes a provider *detector*: keys-first (unchanged), PRIORITY order
  (unchanged — it picks which provider's MODELS surface first, not a
  model), and instead of `onPick(provider, model)` it hands the caller
  `{connected, provider}` — the model is the user's move.
- `modelbrowser.js`: `open(onPick, opts)` gains `opts.teach` — when set:
  the availability filter starts at `available` (the Ready pair), the
  provider row for `opts.teach.provider` sorts first + auto-expands, and
  a SHORT formatted banner rides above the list:
  "Pick your model — this is the model screen. Reopen it anytime from
  the 👾 pill in your chat's header." Theme vars only, no hard colors.
- `modelpicker.js`: the cloud card flow — 0 connected providers → full
  ProvidersScreen setup (unchanged); ≥1 → ModelBrowser in teach mode
  (replaces the one-press auto-pick + the <3-providers reminder popup —
  that GUI dance is dead). Local card unchanged.
- `chatframework.js` gatelock: the model box sub-line when a provider is
  connected but no model: "tap to pick · the model screen" — the short
  pointer the user asked for. `isFulfilled` unchanged (model required).

**Engine (engine/internal/llm/catalog.go):**

- DELETE `knownGoodProbes()` — the hardcoded NVIDIA/OpenCode lists. The
  probe ladder (`probeCandidates`) becomes purely live: configured
  `probe_model` first (still config, not code), then the provider's
  synced/fetched roster, FREE models first, capped at 5 candidates (the
  user's "3-5 available models" — the probe ladder needs a handful, not
  a hail-mary sweep). `isFreeProbeModel` keeps its per-provider rules
  (those are cost rules, not model lists).
- providers.json: nvidia's `probe_model` (the deprovisioned lightning)
  is REMOVED — the ladder leads with the live roster; opencode's
  `big-pickle` (config, live-verified free tier) stays.
- `ResolveAutoModel`: `knownGoodFamilies` (name heuristics) is replaced
  by catalog-data scoring: free + tools-capable + benchmark intelligence
  — the same inputs the model browser ranks by. No name lists in code.

**Tests:** probe ladder derives from the live roster (stub provider,
5-cap, free-first); teach-mode opens Ready + banner (jsdom-level
assertions on the rig); smartConnect never returns a picked model;
ResolveAutoModel ranks a synthetic catalog without family names.

---

## Phase v1.15.2 — THE DECOUPLE REDTEAM

The isolation architecture already exists (v0.95.1 isolation contract,
cross-bind heals, per-session pipes/locks/cancels, per-chat ChatClient
WS, the browser tab deck/park). This phase PROVES it with a real-user
rig and fixes whatever it convicts.

**The rig (scripts/v1152-decouple-rig.mjs + agent-browser):**

- 3 chatbots, 3 providers (NVIDIA live + 2 stub carriers on separate
  ports via DOOMALAY_BASE_URL_ overrides), each in its own chat panel:
  1. Simultaneous turns: all three stream at once → assert zero
     cross-paint (each panel's #chat-messages contains only its own
     session's text), zero cross-delivery (server: each event's
     session_id matches its pipe), TPS per panel.
  2. Panel switching mid-stream: bot A streaming → open bot B → A keeps
     persisting (data-only mode), B renders its own stream; return to A
     → the tail window shows what streamed in the background.
  3. Browser interference: open the browser panel + 2 tabs while bot C
     streams; switch tabs, navigate, group them → bot C's stream never
     hiccups, tabs never reload, the deck/park keeps both states.
  4. Kill-the-socket: drop bot A's WS mid-turn (engine restart) → B and
     C unaffected; A's turn survives server-side (the event log keeps
     filling); a reopen resumes.
  5. PWA reload mid-turn: all three turn states reconstruct identically
     from the replay (deltas, thinking, tool pills, artifacts).
- Server-side assertions: per-session lock (busy reject lands on the
  RIGHT session), abortTurn cancels only its own turn, pipe generations
  never cross.

**Fixes land in the same commit; re-run to green.**

---

## Phase v1.15.3 — THE TRIM (chat + session files)

**Dead code / backwards compat, convicted by audit:**

- `chatpanel.js` `DEFAULT_PERSONA` + `ARTIFACT_PROMPT` (~30 lines): a
  pre-v0.48 duplicate of the quick persona, reachable ONLY when
  `window.Persona` is missing — persona.js loads first in index.html
  (line 6043 < 6109), always. DELETE the block + its two substitution
  branches; keep the `window.Persona` path only.
- `persona.js` `DEFAULT_PERSONA_QUICK` "## Tools" + "## Library": still
  teaches the DELETED ACTION grammar ("invoke tools ONLY through the
  protocol's ACTION line format", "ACTION: skills…", "ACTION:
  persona_set…") — actively harmful (models emit ACTION lines nothing
  parses). Rewrite to the engine's current phrasing (native tool_calls
  through the MCP bus; skills/persona load via their tools).
- ACTION-remnant sweep: grep the web/ tree for `ACTION`/`actionProgress`
  leftovers; same for engine strings the v1.13.3 sweep missed in
  session-facing paths.
- `pmsdk.js`: verify the v1.13.5 surgery left no dead parser branches
  (dsmlClean STAYS — DeepSeek fallback markup is real, engine twin
  kept it too).

**O(n²) / complexity audit (chat + session, frontend + engine):**

- `updateMessageEl` → `container.querySelector('[data-mi=…]')` per
  throttled render: O(DOM) per 180ms tick. Add a per-state mi→element
  cache (invalidated on renderHost/salvage) → O(1). The DOM is already
  bounded (tail window + backfill + salvage cap 240) — the cache kills
  the residual scan.
- `state.messages.indexOf(msg)` in finalizeArtifacts/updateMessageEl:
  msgs already carry nothing — stamp `msg._mi` at push sites, maintain
  on rebuild → O(1) lookup.
- Engine maps: `sessionLocks`/`chatPipes` grow per session and never
  shrink (tiny structs, but unbounded across a long life) — reap pipe
  + lock entries when a WS clears AND no session turn is in flight
  (generation-checked, belt-and-braces with the isolation guards).
- Engine `buildHistory`: O(events) per turn with a window slice at the
  end — walk events BACKWARD with the window cap and stop early
  (bounded by window + hidden-scan which still needs one forward pass;
  keep the hidden pass, bound the message pass).
- Verdict each remaining hotspot honestly; leave anything that is
  already bounded (thinking coalescing, replay, salvage).

**Workflow coherence:** verify the send → queue → stop → retry →
interrupt → resume chain still reads one way after the trim (the rig
from v1.15.2 covers it end-to-end).

---

## Phase v1.15.4 — THE SHELL PLAN (design doc, no code)

Write `PLAN-V116-THE-SHELL-WAVE.md`:

- **The terminal surface**: xterm.js vendored into web/vendor (the
  app already vendors everything; no CDN). Rendered in ONE of the two
  legal containers: the OVERLAY (rounded box over everything) for the
  quick-terminal, theme-driven via xterm's theme API fed from the
  live CSS vars (re- themed on themechange).
- **The engine side**: `engine/internal/term` — per-session PTY
  sessions (creack/pty, pure Go, android-safe cross-build), a WS
  endpoint /api/term?session_id= mirroring the chat endpoint's
  isolation law (per-session pipe, generation-checked swap, one
  writer), scrollback caps, idle reaper, cwd rooted at a per-chat
  sandbox dir. The engine ALREADY runs on the host (desktop) and in
  the APK (android) — the shell is the host's own.
- **The bot bridge**: a `shell` MCP tool on the bus (one-shot exec
  with timeout + output caps, NOT the interactive PTY) so Quick Chat
  models can run real commands; the interactive overlay is the human's.
- **Security gates**: command blocklist (rm -rf /, dd, mkfs, :(){ fork
  bombs), output byte caps, no TTY for the tool path, env scrub (keys
  never visible), per-session cwd jail (no path escapes above the
  sandbox dir where creatable), disabled entirely via a tweak.
- **The Termux path (local)**: phase B — the 'terminal' sandbox chat
  type binds to Termux via the engine's existing android surface
  (intent bridge or the termux-exec socket), the same /api/term
  contract over a different executor. Research notes included.
- Phases: v1.16.1 THE PTY → v1.16.2 THE OVERLAY → v1.16.3 THE TOOL →
  v1.16.4 THE TERMUX BRIDGE → v1.16.5 THE REDTEAM.

---

## Ship v1.16.0

buildinfo bump with the wave narrative + the repo worklog appended.
Rebase check against remote main before every push (the parallel wave
is live). Phase pushes: v1.15.1 → v1.15.2 → v1.15.3 → v1.15.4 →
v1.16.0.
