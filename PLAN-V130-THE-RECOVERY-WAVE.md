# PLAN-V130 — THE RECOVERY WAVE

The user's five reports, all in the "honest recovery" family: the Termux
setup's last friction, the stuck-busy wedge after an interrupted turn, a
key-probe that distrusts good keys, a reasoning stream that stalls after a
network resume, and a cursor that outlives its chain.

Recon + research: every root cause below was READ IN THE TREE and, where a
provider is involved, LIVE-PROBED with the user's own keys (the Nvidia
ladder verdict is empirical, not hypothetical). Termux behavior verified
against the RUN_COMMAND intent docs + the Termux security model.

---

## 0. THE CENSUS (what the code actually says)

### T1 — the Termux setup ladder (termuxsetup.js, the ConnectOverlay page)
- 4 rows: ① Install · ② Bootstrap (cmd + Copy + check-now + **Open Termux**)
  · ③ Allow commands (gated on ②) · ④ Verify. `_stepStates` computes all
  four; `shouldForce` already force-polls while ①–③ are done and !ready
  (the verify stage runs itself — ④ has NO button).
- **Open Termux today**: `act('open_termux')` → the Kotlin bridge's
  `getLaunchIntentForPackage(com.termux)`. Nothing else. The user does
  Copy → switch → long-press → Paste → Enter by hand.
- **Why true pre-typing is impossible** (research-verified): Termux's
  security model — RUN_COMMAND intents require `allow-external-apps=true`
  (the very thing step ② sets) AND the app's RUN_COMMAND permission
  (step ③). Pre-bootstrap, both are absent by definition; no public API
  can inject keystrokes into another app's terminal (no accessibility
  path; termux-clipboard-set works inside Termux only). Post-bootstrap,
  every reachable state of step ② still lacks one of the two grants
  (props_ok=false ⇒ RUN_COMMAND is refused by Termux itself).
  → THE HONEST MAXIMUM: one tap = the CURRENT command lands on the
  clipboard + Termux opens + the row teaches "long-press → Paste → Enter"
  (3 interactions, down from 5, and the right command is guaranteed).
- **④ is invisible work today**: it renders a row with no button whose
  only content is a status chip; its failure notes (storage not granted)
  are the only unique signal it carries.
- **The pills**: `.tsx-ico` is a 26×26 rounded square holding a unicode
  ①②③ glyph — the "prototype" look the user named.

### T2 — the stuck-busy wedge ("agent already processing")
- The turn lock is PER-SESSION (`sessionLocks` map, chat.go:83) — a busy
  reject can never literally cross sessions. The leak the user FEELS is
  the stuck state itself: a turn interrupted client-side (network drop →
  ladder exhausted → wireClientClose) keeps running ENGINE-side (by
  design, v0.39) and can hang on a deprovisioned NIM stream — the lock is
  held indefinitely, and EVERY later send in that chat eats the busy
  reject. Retry loops on it forever. The only outs are Stop (the client's
  stop() sends abort — but the dead client can't) or an engine restart.
- The busy reject path (chat.go:945-959) rejects blindly: it never asks
  WHO is sending. A send frame just arrived on a LIVE socket — if the
  held turn's pipe has no socket, or a DIFFERENT socket, the sender is
  by definition not the turn's own client. That asymmetry is the fix.
- The busy message itself ("agent already processing") is a dead end —
  no Stop hint, no honesty about the interrupted turn.

### T2b — the Nvidia "saved unverified" yellow box
- `ValidateKey` → chat_probe ladder (catalog.go). Nvidia has NO configured
  probe_model ⇒ the ladder is the live roster's head: first 4 "free"
  models (all NIM models count free) + fetched[0], capped
  `probeCandidateCap = 5`.
- LIVE-PROBED (the user's key, today): Nvidia's /v1/models wire order
  leads with ancient publishers — 01-ai/yi-large, adept/fuyu-8b,
  ai21labs/jamba-1.5, bigcode/starcoder2-15b… The first 12 contain exactly
  one still-live model. Probes:
  - `bigcode/starcoder2:15b` → **404 "404 page not found"** (the user's
    exact reason string — the label form carries the colon)
  - `01-ai/yi-large` → 404 function-not-found; `meta/llama-3.3-70b` → 410
    EOL; `qwen/qwen3-coder-480b` → 410 EOL
  - `deepseek-ai/deepseek-v4.1-flash` → **200** (the key is FINE)
- Verdict: the ladder burns all 5 rungs on retired models → all
  inconclusive → "unverified" with the last 404 as the reason. The yellow
  box distrusts a proven-good key.

### T3 — the PrivateMode skill-library pill
- `pmsdk.js` `fetchLibBootstrap()` reads `_pmBootstrapCache` (line 177)
  **without ever declaring it** — compare `_pmManifestCache` (line 202,
  declared). First read of an undeclared identifier = ReferenceError, so
  the function throws BEFORE the fetch fires, on EVERY call, forever.
  The catch at line 401 turns it into the onProgress pill:
  "skill library unavailable — _pmBootstrapCache is not defined" — the
  user's exact pill, briefly shown before the PM reply starts. The lib
  bootstrap never loads on PM turns with the 🛠 pill ON.

### T4 — the reasoning box stalls after a network resume
- Resume mechanics (engine) are sound: `pipeFor` + `swap(conn)` re-binds
  the running turn to the new socket; reapIdleChat never reaps mid-turn.
- Client resume cursors are sound: `since=lastSeq` (wire seq) vs
  `lastEventI` (persisted id) overlap-drop is the designed idempotency.
- **Provable defect #1 — the `_replay` tag smears onto LIVE events**
  (chatclient.js `_tagReplay`): the tag ends only on a >1200ms arrival
  gap. A fast reasoning stream (Deepseek v4.1 flash deltas < 1200ms
  apart) that resumes straight into live deltas NEVER clears the tag —
  every live delta stays `_replay:true` until the model's next natural
  pause. Tagged live deltas are second-class exactly where it hurts:
  they don't re-arm `isStreaming` (4658), `tool_stream` drops them
  (4835). The thinking BODY still renders (no _replay guard on the
  append) — but any turn whose client belief reset (wireClientClose)
  stays visually dead: the box frozen, while `tickThinkingMeta`'s 500ms
  ticker keeps raising the elapsed/chars line from raw data — "the
  dynamic text keeps increasing". The tag clears at the next
  reasoning process / turn — "streaming picks up with the next chain".
- **Provable defect #2 — no deterministic end-of-replay**: the engine
  knows exactly when its backlog burst ends but stays silent; the client
  guesses by timing. 1200ms of silence is the heuristic that fails here.
- Fix shape: the engine emits an ephemeral `ws_state:'replay_done'` after
  the replay loop; the client ends the tag on it (heuristic stays as the
  fallback for older engines); a resume landing mid-turn forces one
  re-render of the last streaming bubbles (belt and braces).

### T5 — the cursor that outlives the chain
- The thinking bubble's `streaming` flag flips false ONLY at turn end
  (`completeAllStreaming`). `stampThinkEnd` (v0.27.1) stamps `endedAt`
  the moment the stream moves past thinking — but leaves
  `streaming=true`. Result: the `.fmt-cursor` keeps blinking at the end
  of a FINISHED reasoning chain while the tool runs / the reply streams,
  exactly until the whole turn ends. The user wants the cursor gone when
  the CHAIN ends (tool / next chain / reply).

---

## 1. v1.29.1 — THE TERMUX LADDER (termuxsetup.js only)
1. **Hide ④**: pageHTML renders three rows. `_stepStates` keeps computing
   all four (the ladder law, the node rig's contract); the verify stage's
   signal moves to the status line: "finishing — verifying storage + the
   bridge…" while ①–③ are done && !ready; the storage/props failure notes
   that used to land under ④/② surface in the status line too.
   `paintStep('verify')` no-ops on the missing row (guards already hold).
2. **The pills**: `.tsx-ico` becomes a designed number pill — a 24px
   circle, the step NUMBER as text (1/2/3, not ①), states:
   pending = dim outline, active = accent border + the row's `.now`
   emphasis, done = accent fill + ✓. Theme vars only. The right-side
   status chip keeps its ✓/now/— semantics.
3. **Open Termux, taught**: the button now (a) writes the CURRENT
   bootstrap command (`bootstrapCmd` — checkin tail included) to the
   clipboard (the copyText path, toast "command copied"), (b) fires
   open_termux, (c) the bootstrap row gains a one-line hint under the
   command: "in Termux: long-press → Paste, then Enter". Copy stays as a
   utility; the hint replaces the guesswork. Button label: "Open Termux ⌘".
   Zero Go/Kotlin changes (the intent already exists).

## 2. v1.29.2 — THE QUIET END (client JS only)
1. **pmsdk.js**: `var _pmBootstrapCache = null;` declared. The pill text
   becomes reachable only when the bootstrap endpoint genuinely fails.
2. **stampThinkEnd ends the chain's UI**: when it stamps `endedAt` on a
   thinking bubble it also flips `streaming=false` and re-renders that
   bubble (cursor gone, the live dot freezes, the elapsed chip hides —
   the stats line keeps its final "reasoning · Ns · chars"). All call
   sites carry bodyEl. The next thinking event opens a FRESH bubble
   (role check) with its own cursor — chains are visually distinct.
3. Rig: extend the node walk with the chain-end assertion (cursor span
   absent after the tool event lands; stats frozen).

## 3. v1.29.3 — THE OPEN DOOR (engine Go)
1. **The stale-turn takeover**: handleTurn receives the sender's conn.
   On a busy reject: when NO registered turn belongs to the sender's
   conn → `abortTurn(sessionID)` (the stale turn's own terminal status
   lands on its listeners) and re-try the lock with a short bounded wait
   (≤3s). Acquired → the new turn runs. Not acquired → the honest
   reject. A same-conn double-send (the client's own queue racing) keeps
   today's instant reject. LIVE-RIG AMENDMENT (the live proof convicted
   the first shape): the gate reads the turn's OWNER conn (recorded at
   registerTurnCancel), NOT the pipe's current socket — a resumed client
   swaps into the SAME pipe, so the pipe's ws IS the new sender by the
   time the second send arrives; the owner is the invariant that
   actually identifies whose turn it is.
2. **The honest busy message**: "the previous turn is still running —
   tap Stop to end it, or wait for it to finish" (Stop, Retry, wait —
   all three now actually resolve).
3. **The probe ladder**: `probeCandidateCap` 5 → 12 (SIMPLIFIED FROM THE
   DRAFT: the models.dev freshness reorder was dropped — the live probe
   showed the first live nvidia model sits at roster position 8, so
   depth alone reaches past the rotten head; the reorder would have made
   the v1151 pins brittle against future snapshot regenerations for zero
   measured need); the all-inconclusive reason ends with "— model-level
   errors only; the key itself was never rejected". The Nvidia connect
   flow lands green on the user's key (live-verified: deepseek-v4.1-flash
   200s at roster position 8).

## 4. v1.29.4 — THE STEADY RESUME (engine + client + rig)
1. **Engine**: after the replay loop in handleChatWS, send the ephemeral
   `{"type":"ws_state","state":"replay_done","resumed":bool}` (no seq —
   the ws_state family is never persisted).
2. **Client**: chatclient ends the replay tag on `replay_done`
   (deterministic; the 1200ms heuristic stays for older engines). The
   panel, on `ws_state open` mid-turn, force-re-renders the last
   streaming bubbles once the burst drains (the resume-wedge eraser).
3. **The rig** (node): drives the REAL chatclient tag logic + the panel's
   thinking path through: stream → drop → resume-with-gap → live deltas
   — asserts the live deltas arrive untagged, the box re-renders, and
   isStreaming holds. Wired into the wave battery.

## 5. v1.30.0 — THE SHIP
- Battery: the new rigs + v1290 32/32 + v1280 40/40 + v1233 21/21 +
  v1270/v1250 walks + the Go suite + uikit.
- Rebase protocol (download / diff / merge), then tag v1.30.0-the-recovery-wave.

## SPAGHETTI BOUNDARY (documented, not built)
- No accessibility/keystroke injection into Termux (no public API; the
  clipboard+teach IS the honest maximum).
- No per-provider global locks (the per-session lock is correct; the
  takeover makes it self-healing).
- No client queue-machine redesign (the takeover fixes the wedge at the
  engine's door where the truth lives).
- No background-compat shims for any of the above (per standing law).
