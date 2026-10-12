# PLAN-V135 — THE UNBROKEN TURN

**Version:** v1.35.0 · **Trigger:** the user's report (two faces, one law):
1. *"closing and opening a panel mid-turn stops the turn"* (long convo)
2. *"leaving the app while a bot is running and returning takes us back to the canvas, opening the panel the bot got interrupted"*
3. **THE LAW:** *"Once a turn in a session starts, nothing should automatically end it unless the user manually does so."*

## §1 THE CONVICTIONS (scripts/v1350-unbroken-turn-rig.mjs — the real engine + the real PWA + agent-browser)

The rig reproduced the whole family BEFORE the fix (38/47 with the failures exactly on the reported paths):

- **S5 conviction (engine):** the v1.29.3 OPEN DOOR aborted a **LIVE** turn. A fresh socket (page reload mid-turn — the Android WebView-kill shape) + any send: the sender's conn owned no registered turn → `abortTurn` killed a streaming turn, whose deferred terminal then emitted a **fabricated clean `status: idle`** — a truncated reply masquerading as completion. Log line: `open door: … aborting the stale turn for the new sender`.
- **S4 conviction (client):** after a mid-turn reload, the reopen's replay ended WITHOUT a terminal; the UI stayed disarmed through the whole quiet phase (a long tool run produces no live deltas to re-arm on) — button read Send while the engine held the turn → the S5 abort was one tap away.
- **S2/S3 conviction (client):** `wireClientClose`'s owner path **fabricated a terminal** on reconnect-ladder exhaustion (~20s): `isStreaming=false` + a persisted-looking "Connection to the engine dropped mid-reply — Tap Retry" bubble + a parked queue — while the engine was STILL streaming the turn (chat.go never kills a turn on socket loss). A >20s network wobble on a long convo painted "interrupted" over a running bot.

## §2 THE FIXES

### Engine (chat.go) — v1.35.0 THE TURN PULSE
- `turnActivity` map + `markTurnEvent(sessionID)`: **every** event a turn produces (persisted or ephemeral: deltas, thinking, progress, tool_stream) is a heartbeat; the send itself marks at turn start; the entry clears at turn end.
- `turnStale(sessionID)`: no pulse for `turnStaleAfter` (120s — the client's own stall-chip twin) or no pulse ever.
- The open door's abort now NESTS the pulse gate inside the untouched v1.29.3 owner gate: `if takeoverStaleTurn(…) { if turnStale(…) { abort + bounded wait } else { the door stays shut (log) } }`. A **LIVE** turn keeps the lock; the new sender gets the honest persisted busy answer ("the previous turn is still running — tap Stop to end it, or wait for it to finish"). The Nvidia-wedge contract (a silent-hung turn opens the door after 120s) is preserved bit-for-bit.

### Client (chatpanel.js) — v1.35.0 THE UNBROKEN TURN
1. **No fabricated terminals, ever.** `wireClientClose`'s owner path holds the turn armed on ladder exhaustion: the honest indicator ("connection lost — the turn continues engine-side, reconnecting…"), the revive poll (20s, forever) keeps reconnecting, the Stop button stays available. The gap replay resolves the truth when the wire returns (engine terminal → honest end; deltas → the stream resumes). The fabricated bubble is DELETED from the tree (a source pin guards it).
2. **THE TRUTH ARM.** A terminal ledger (`state._terminalSeen`: set by every live-or-replayed terminal status, reset by every user echo). When `replay_done` lands and the backlog ends mid-turn (user echo, no terminal after it), the UI arms streaming from the TRANSCRIPT'S TRUTH — button reads Stop, the activity row runs — instead of waiting for a live delta. The quiet-phase send window is dead at the UI level too.
3. **THE FRESH RESTORE.** `restoreStashedChat` force-repaints the tail's streaming bubbles on reopen (the closed window's beats updated data-only; the stashed DOM showed close-time text).

### The dead-turn escape (verified, unchanged)
An engine restart mid-turn leaves a log with no terminal → the boot-heal appends `{"state":"error","healed":true,"message":"interrupted by engine restart"}` → the resumed client replays the ENGINE's truth and the turn ends honestly. The truth-arm can never stream forever (rig S6 proves it live: engine `kill -9` mid-turn → restart → healed terminal → clean end).

## §3 THE BATTERY (all on this tree)
- **v1350 rig 62/62** — S2 panel close/reopen mid-turn (streams through, no interrupt, complete) · S3 socket-death mid-turn (ladder + gap replay, no fabricated bubble) · S4 reload mid-turn (truth-arm re-arms, completes) · S5 quiet-phase send trap (button Stop; turn 1 completes; no open door) · S6 engine-restart truth (boot-heal ends it, no eternal stream) · S7 raw stranger-socket send (honest busy answer; the live turn completes; the door's shut confirmed in the log)
- **New Go tests:** chat_v1350_test.go (pulse semantics ×4 + owner-gate nesting + source pins) · chat_v1293 pins intact
- **Regression:** Go suite 13 packages ok · v1321 144/144 · v1310 rig 58/58 + walk 27/27 · v1300 29/29 (the replay_done pin widened for the truth-arm — intent unchanged) · v1290 32/32 · v1323 10/10 · interrupt-fixes 65 · round-flow 11 · isolation 12

## §4 THE WILL-NOT BOUNDARY
- No auto-retry of an interrupted turn (the engine's truth + the user's Stop/Retry remain the only moves).
- No engine-side turn resume-after-restart (the boot-heal terminal is the honest record; a resume feature is its own wave).
- No busy-reject redesign: the persisted honest busy answer + terminal stays (it IS the record a reload needs).
- No UI redesign of the panel/overlay carriers; zero color hardcodes; every new string rides the existing theme vars.
