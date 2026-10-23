# PLAN-V167 — THE PATIENT CANVAS (the user's 2026-10-23 four-list)

The user's report, distilled:

1. **THE ETERNAL PILL + THE HALTED CHAT** — "this complex CD and ls and strings
   and a grep with multiple | command loaded indefinitely, after that the model
   stopped and changing models didn't fix it. The chat throttled and halted with
   no more responses and just waiting. A new chat with opencode works. And
   switching to another provider same chat seems to fix it. Actually in every
   chat I've had I had pills load indefinitely or take a very long time where
   the bot continued on past it completely."
2. **THE SILENT 429** — "When I get 429 errors, which I got a lot of, I didn't
   get any indication visually that the chat chained any timer for errors, no
   popups, nothing to tell me that the chat joined a listener for an exception
   handler timer. Instead for opencode it's a very long wait time with an
   uninsightful pill. For Openrouter it's an interrupt/stop with 'the model is
   at capacity (429) — wait ~15s and try again, or switch models (each model
   has its own limit)'."
3. **THE ORBITING STARS' COST** — "The orbiting stars around Dom icons
   representing chat workspaces causes huge drop in performance when zoomed
   out… make them orbit much slower so they render less… once the user passes a
   certain zoom out threshold they slow down exponentially then freeze… find an
   opensource library… these stars must be negligible. Even if it means making
   them static — but that's a last resort."
4. **THE BOUNDED CANVAS** — "Let's limit the canvas sizes from 8-64 or 128k. No
   infinite grid."

## RESEARCH CONVICTIONS (the pre-build web work, per the standing law)

- **opencode 2.x API** (v2 docs + sst/opencode@v2.1.4 source, live-verified
  endpoints): `POST /api/session/{id}/interrupt` (empty body →
  `{interrupted:bool}`) kills an in-flight turn — the v2 abort; the event bus
  `/api/event` is **VOLATILE BY CONTRACT** (dropping queue 4096, "events during
  disconnection are missed… build state reconciliation on top of REST reads").
  THE ENGINE NEVER CALLS INTERRUPT and never reconciles MID-TURN — exactly the
  user's two diseases.
- **Stars**: Pixi **v8.21.0** is already vendored and exports
  `ParticleContainer`+`Particle` (flat particle array, position-only dynamic
  props, one draw call per blend mode — the "million particles" pass ≥8.5).
  The canonical LOD ladder (Unity/Unreal/Mapbox): full → thin → **freeze**
  (cacheAsTexture / visible=false) → cull. No other library beats what we
  already ship (three.js = second GL context +600KB; pixi-particles is dead
  for v8; canvas-confetti is the wrong model).
- **The 429 corpus audit** (all error-emission sites swept): the sentinel
  machinery (v1.61.3) is COMPLETE and 17/17-green on the fake — but THREE real
  429 shapes never arm it: (a) **`oc_free_walled`** (the opencode wall-walk's
  exhaustion terminal) carries no `retry_class`; (b) **the SSE mid-stream
  error frame** (`data: {"error":{...}}` after HTTP 200 — OpenRouter's
  documented free-model kill shape) is parsed as a choice-less chunk and
  SILENTLY DROPPED — the stream then ends "clean" and the turn dies as an
  empty/interrupted shell; (c) the opencode free-limit wait itself is invisible
  (the serve retries internally for minutes; the user sees only "still
  working… Ns").
- **The eternal-pill corpus**: the pump's reconnect loop (v1.64.2 THE LIVING
  WIRE) reconnects the SSE but the frames lost in the gap are gone forever —
  its own comment says "frames missed during the gap are covered by the pump's
  durable record probe" but SessionIdleSince only owns the TERMINAL; the
  missed `session.tool.success` frames never re-emit → the pill spins forever
  (live AND on replay — the result was never persisted engine-side either).
- **The halted chat**: a turn whose tool never returns (the complex multi-pipe
  command hanging in termux) parks the pump in the "still working… Ns" loop
  FOREVER — there is no stall ceiling, no interrupt, no session recycle. The
  chat's turn lock holds → every send throttles; switching provider "fixes" it
  only because applyModel calls stopTurnIfStreaming (the PWA-side ctx cancel).

## THE WAVES

### v1.67.1 THE INTERRUPT HAND (ocserveturn.go + ocserve.go)
- `Manager.InterruptSession(serveSess)` — POST /api/session/{id}/interrupt
  (the researched v2 abort; best-effort, 8s timeout).
- **THE STALL CEILING**: ocServePump tracks `lastEvAt`; a turn silent (no live
  frames) AND unchanged in the durable record for
  `ocServeStallCeiling` (default 5 min, env-rigged) is convicted stuck:
  → InterruptSession (kill the zombie turn serve-side)
  → close every pending pill with an honest synthetic tool_result
    ("the command never returned — cancelled after Nm")
  → error + terminal (the chat's lock releases, the send queue lives)
  → mark the binding poisoned (kv) so the NEXT prompt births a fresh serve
    session (the recycle law extended to stuck turns).
- **THE ZOMBIE GUARD at prompt time**: before Prompt(), if the serve session's
  newest record is a still-running turn from a PREVIOUS prompt (stale past the
  ceiling), recycle the session first (interrupt + delete + fresh) — "a new
  chat works" without the new chat.
- THE HONEST PILL DURING THE WAIT: the "still working" ping learns to name a
  stalled tool ("shell still running… Ns — will cancel at Nm").

### v1.67.2 THE UNLOST MID-TURN (ocserveturn.go + ocserve.go)
- **THE MID-TURN RECONCILE**: when streamOnce returns reconnectable (the gap)
  — and on the silence probe when the durable record shows movement the live
  feed never delivered — re-read the serve transcript
  (ListSessionMessages, the turn's window) and RE-EMIT the missed events
  idempotently (per-call-ID: any tool part whose result never rode gets its
  tool_use (if missing) + tool_result NOW; the pills close honestly). The
  turn's terminal stays SessionIdleSince's business; this pass owns the MIDDLE.
- This kills "pills load indefinitely or take a very long time where the bot
  continued on past it completely" at the root: the missed result lands from
  the durable record within one reconnect cycle.

### v1.67.3 THE LOUD 429 (llm/chat.go + ocserveturn.go + chatpanel.js)
- **THE SSE ERROR FRAME**: scanSSECollect parses `{"error":{...}}` frames —
  a 429/rate-limit error frame surfaces as the honest error chunk WITH
  RetryClass="429" (+ provider) → the sentinel arms → the pill shows; other
  error frames surface as the honest stream error (never the silent
  empty-shell death).
- **oc_free_walled arms the sentinel**: the wall-walk exhaustion terminal
  carries retry_class="429"/retry_provider="opencode" (the windows reset on
  opencode's clock; the probe is the bridge-health + the auto-continue IS the
  window test — a still-closed window re-parks with attempts preserved).
- **THE OPENCODE 429 VISIBILITY**: ocServeFailEvents' 429 path gains a
  progress line BEFORE the terminal ("OpenCode: the model's free window is
  rate-limited — arming the auto-retry timer") so the wait is never
  "uninsightful"; the PWA error bubble for retryable classes appends the
  honest "auto-retry armed — the timer probes every Nm" line (the pill's own
  countdown rides below).
- The PWA's friendlyError 429 rewrite mentions the auto-retry when the event
  carries retry_class (the pill is the visual; the error text names it).

### v1.67.4 THE NEGLIGIBLE STARS (atoms.js + app.js + pixiworld.js)
- **THE ZOOM TEMPO LAW** (atoms.js, ONE truth in AtomCore — both hosts + pixi
  ride it): `starTempo(scale)` = MOTION_TEMPO × exp-decay between 0.75 and
  0.45 (exponential slowdown as the user zooms out), **0 (frozen) below
  0.45**. Frozen = the atom-only frame STOPS posting (ambientActive's atoms
  branch goes quiet; the last static raster persists; a camera move repaints
  once at the new frozen pose).
- **THE CADENCE CAP**: the atoms-only cheap frame runs at ≤30fps
  (time-based skip with drift correction — never frame-modulo), and rides the
  tempo (slower stars → fewer frames; frozen → zero frames).
- **THE PIXI PARTICLE SHELF** (pixiworld.js): the world layer's star buckets
  migrate from per-star Sprites to ONE ParticleContainer (position-only
  dynamic props, one shared glow texture, blendMode 'add', boundsArea set) —
  ~1 draw call for every star on screen; shells stay the normal-blend atlas
  batch. The zoom-tempo law rides the same world clock (the parity pin).
- THE FREEZE LADDER at the DOM twin: frozen scale → paint ONE static frame
  (t clamped) and stop the loop; unfreeze on zoom-in (the tempo returns).

### v1.67.5 THE FINITE PLATE (app.js + appearance.js + settings.js + physics.js)
- The World Size dial loses the "Off — infinite" rung: 8k/16k/32k/64k/128k
  only. applyWorldSize's sanctioned ladder drops 0; a saved 0 migrates once to
  16,384 (the worldSizeV167 flag — a deliberate re-pick of a real size
  survives); physics.js's unbounded half (0) becomes unreachable dead law
  (kept, never armed). The edge affordance + the fit-all floor unchanged.

### v1.67.6 THE LIVE PROOF (scripts/v1670-patient-canvas-rig.mjs)
- LEG A — THE STUCK TURN: a fake serve whose tool never returns → the stall
  ceiling fires → the interrupt POSTs → the pills close honestly → the
  terminal lands → THE SAME CHAT accepts a new prompt (the lock released).
- LEG B — THE LOST RESULT: a serve that emits the tool_use live, kills the
  event stream in the gap, then completes the tool + answers (the result
  frame only in the durable transcript) → the reconcile re-emits the result →
  the pill closes → the answer lands.
- LEG C — THE LOUD 429: a fake provider that answers 200 then an SSE error
  frame {"error":{"code":429}} → the error surfaces WITH retry_class → the
  sentinel arms → the pill ladder (armed → probe → recovered) on the WS; the
  oc_free_walled shape arms too.
- LEG D — THE FROZEN STARS: a headless run of atoms.js's tempo law + the
  cadence gate (frozen at ≤0.45 → zero frames posted; the pixi shelf's
  Particle path pins the API shape against the vendored 8.21 bundle).
- LEG E — THE FINITE PLATE: the dial's rungs (no 0), the saved-0 migration,
  clampCamera at every rung.
- Plus the full battery (v1610 17/17, v1620, v1630, v1650…) + go vet + the
  cross-compiles.

## THE LAWS HELD
- Theme colors only (no literals) — the new pill/error lines ride
  var(--warn)/var(--ok)/the existing classes.
- Only the two overlay surfaces (panel/Overlay) for UI — all new faces are
  message rows inside the existing chat transcript.
- Phased pushes (x.x.1…x.x.5 → the x.7.0 ship after the rebase check).
- The rebase discipline: fetch + rebase before every push; the merged tree
  re-proves the battery.
