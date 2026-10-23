# PLAN-V171 — THE HONEST RECONCILE

The pocket-bridge replay conviction, from the user's own device export.

## THE CONVICTION (the evidence)

The user's message (2026-10-23, with the export `doomalay-sky-6adbbb21`): "we have
major tooling issues, a lot of tools never finish the output… You can use opencode
thru the tunnel I believe like I have. It's pretty bad."

The export's own ledger (the JSON event stream, dissected):

- **14 logical tool calls → 93 tool events.** Every prior turn's `tool_use` /
  `tool_result` pair re-emitted into each new turn, all timestamped within the
  same second (the silence-probe cadence): 2 pairs, then 6, then 7, then 9, then
  12 — the event table grows quadratically with the session's tool history.
- The replayed results carry the serve's own "Tool execution interrupted" text —
  the UI drowns in interrupted pills that already closed; the user reads it as
  "tools never finish the output."
- **The oc_stalled death loop**: the 5-minute stall ceiling convicted the turn
  (`timeout 20 git grep | head` never returned — 333s), the interrupt fired, and
  the auto-retry's continuation on the SAME serve session answered `git log -1`
  in 0s and then hung FOREVER on `ls -d */` — the interrupt freed the turn but
  not the session's wedged tool state (its persistent bash).
- The genuinely slow calls (the `read` of a 200K-file home dir: 270s; the wide
  `grep -ril`: 92s; the native `grep`: 178s) are the device's own physics — the
  engine's answer to them is the stall ceiling + the honest pings, both of which
  worked; the REPLAY and the SESSION REUSE are our bugs.

## THE ROOT CAUSES

1. **The un-anchored reconcile window** (v1.67.2's mid-turn reconcile): the
   probe trims its window to "everything after the newest idle marker." The
   pocket serve (opencode 2.1.2, live-verified) writes NO idle rows for
   interrupted turns — after every stall/interrupt cascade the trim found no
   idle and the window became the WHOLE session. A fresh pump's dedupe maps
   (per-turn) start empty, so every completed/error tool part re-emitted.
2. **The interrupt-only stall conviction** (v1.67.1): the ceiling interrupts
   the zombie turn but keeps the serve session — the wedged bash state survives
   into every later turn on the same session.

## THE FIXES

- **v1.71.1 THE TURN ANCHOR** — `ocAnchorTurnWindow(msgs, turnStartedAt)`:
  the window is time-anchored FIRST (zero grace — the engine and the serve
  share the host clock, and `turnStartedAt` is stamped BEFORE the prompt POST,
  so every part of THIS turn is created ≥ it; the ended-check already relies on
  the same same-host law). A part stamped before the turn's start is never this
  turn's — it drops unconditionally. The newest-idle trim stays as the belt
  WITHIN the anchored window; a message with no stamps drops too (the safe
  answer: a missed recovery beats the quadratic replay).
- **v1.71.2 THE STALL RECYCLE** — the oc_stalled conviction now: interrupt →
  DELETE the wedged serve session (best-effort) → forget the chat's binding →
  the honest message ("the stuck session was discarded — your next message
  starts a fresh one") → the terminal. The next turn births a FRESH serve
  session (a clean bash, the opening text re-armed). The wall-walk path keeps
  its same-session law (context survives a wall); only the never-returned-tool
  conviction recycles.

## THE PROOF

- `scripts/v1710-replay-rig.mjs` — the fake 2.1.2 serve speaking the
  live-captured shapes, four legs:
  - LEG A the replay conviction (stalled tool, NO idle marker, healthy
    follow-ups — zero prior-turn re-emissions; convicted the pre-fix build);
  - LEG B the idle belt (the interrupt-writing-idle shape — clean on both
    builds; the belt law holds);
  - LEG C the stall recycle (the wedged session DELETED, the follow-up on a
    fresh serve session id, the honest notice);
  - LEG D the turn anchor (completed turns, NO idle rows anywhere — no
    prior-turn re-emission).
  - **Pre-fix: 17/22 (the replay + the death loop reproduced exactly). Fixed: 22/22.**
- TestV1710 ×4 (the anchor's table laws: prior-turn drops with no idles, the
  belt cuts within the window, zero grace + the safe no-stamp answer, the
  recycle's source law).
- The v1670 rig re-proven 34/34 (the stall/gap/wall legs all hold with the
  recycle in place); go build + vet clean; the ocserve + llm suites green; the
  server suite chunked green (the full-process run OOMs in this sandbox — the
  dev stack's memory, environmental, same as the v1.70 ship); the
  linux/amd64 + android/arm64 cross-compiles.
