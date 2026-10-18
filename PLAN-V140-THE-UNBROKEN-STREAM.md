# PLAN-V140 — THE UNBROKEN STREAM

**Wave:** v1.40.0 · ships as `v1.40.0-the-unbroken-stream`
**The lineage:** v1.35 THE UNBROKEN TURN made a turn survive the *client's* death (socket gone → turn lives, `&since=` replay owns the truth, no fabricated terminals). This wave makes the turn survive the *engine's* world dying around it: the screen going dark, the process being frozen, the renderer being killed, and the internet going away — the two user reports, verbatim:

> "the app running on the background should not pause the bots working whatsoever… when the user comes back to the app and opens the bots panel it should update the log to reflect all the work that was done in his absence"
> "It should continue with all its effort to work despite me not having internet, when it reconnects, it should update the chat logs to show everything I've missed"

Research: `RESEARCH-V139-STREAM-RESILIENCE.md` (every law URL-cited). Recon: the worklog's Task ID 2 record (code-cited).

---

## THE DIAGNOSIS (both symptoms, both confirmed in code)

**Symptom 1 — backgrounding pauses everything.** The engine is a child OS process of the app (`EngineService` → `ProcessBuilder libdoomalayengine.so`). The foreground service keeps the process out of the cached/freezer class — but a foreground service does **not** keep the CPU awake: seconds after screen-off the kernel suspends and the engine simply stops being scheduled (research §1.2 — the Termux law: FGS **+** wakelock, together; `EngineService.kt` holds **no** `PARTIAL_WAKE_LOCK`, the manifest has **no** `WAKE_LOCK`). Compounding it: (a) deep Doze ignores wake locks and suspends network unless the app is battery-exempt (no exemption ask exists — research §1.2/§4.3); (b) a WebView renderer kill (`onRenderProcessGone` — NOT overridden) kills the whole app process by default, engine included, mid-turn (research §1.1; the boot-heal "interrupted by engine restart" receipts are this shape); (c) on return, the PWA's `visibilitychange` handler only repaints the indicator — a zombie WS or a dead client waits out the 20s throttled revive poll (research §2.4).

**Symptom 2 — network loss pauses the bots.** The engine's `netPauseLadder` (llm/chat.go:1951) retries a network-class failure through 5 fixed rungs (1.5s/3s/15s/30s/60s ≈ **110s total**) and then **gives up** → `emitTurnError` → terminal `status:error` → "tap Retry" (the exact "manually have it continue" complaint). Worse: the plain / web-search / deep-research turn paths have **zero** network retry (one transport error = instant terminal). And a mid-*stream* cut (partial content already emitted) is never retried at all — the double-render guard turns it into a terminal. No `online` listener exists anywhere in the PWA; the engine has no connectivity signal, so even a 1s blip burns a full fixed-timer rung.

**What is already right (and must stay right):** turns run on `context.Background()`-derived ctx (never the request's — the detached-work law, research §3.1); the seq event log + `&since=` replay IS the industry resumable-stream pattern (research §2.2); ping/pong measures connection liveness only, a silent client never kills a run (v1.35); the turn pulse (`markTurnEvent`/`turnStale` 120s) keeps the open door from aborting live turns.

**The one documented non-goal of this wave:** PrivateModeAI turns run *in the WebView* (`pmsdk.js` — the vendored SDK executes the agent loop in JS). A hidden WebView's timers throttle to ~1/min, so PM turns *crawl* in background even with the engine wide awake (research §1.3 — and silent-audio exemption hacks are dead). Moving PM execution engine-side is its own future wave; this wave documents the limit honestly in the device checklist. Every engine-owned provider (OpenRouter, Nvidia, Mistral, OpenCode, HF, Groq…) gets the full fix.

---

## §1 — v1.39.2 THE AWAKE ENGINE (symptom 1's core: the CPU)

**The law:** an FGS keeps the process alive; only a `PARTIAL_WAKE_LOCK` keeps the CPU scheduled. Wakelock while turns run, release when idle — battery-honest (research §1.2, the "user should be aware" notification pairing).

1. **Manifest** (`platforms/android/app/src/main/AndroidManifest.xml`): add `WAKE_LOCK`, `ACCESS_NETWORK_STATE`, `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` (the last rides §3's callback + the exemption ask).
2. **The engine tells the truth about busyness** — new endpoint `GET /api/engine/busy` → `{"turns": N, "sessions": [...]}` (a live count of in-flight turns; the same gauge that drives §1's wakelock). Server-side: a turn gauge in `server/chat.go` (atomic counter, inc on `handleTurn` entry after the lock, dec on exit).
3. **EngineService** polls `http://127.0.0.1:8080/api/engine/busy` every 5s on a dedicated thread (loopback, ~100 bytes; the poll is the self-healing truth sync — a missed announce can never wedge the wakelock). On `0→N`: acquire `PowerManager.PARTIAL_WAKE_LOCK` (stable tag `"doomalay:engine-turns"`), update the FGS notification to **"N bots working"**; on `N→0`: release the wakelock, revert the notification to "Engine running". Release in `onDestroy` too (the stuck-wakelock law). Degraded mode: if the engine is down, release + revert (an idle/dead engine never holds the CPU). Notification updates debounced by text-change only.
4. **THE RENDERER-DEATH DEFENSE** (`MainActivity`): override `WebViewClient.onRenderProcessGone` (API 26+, minSdk 24 → guard) → log it, **recreate the WebView** (destroy the old view, rebuild via an extracted `buildWebView()` — the current inline setup in `proceed()` becomes a callable), reload `http://127.0.0.1:8080`, return `true` (the app process and the engine child survive; the PWA reload replays `&since=` and the truth re-arms). Return `false` only when the activity is finishing.
5. **THE EXEMPTION LADDER** (`MainActivity`): on `onPause` while turns are busy (EngineService exposes the gauge via a companion `@Volatile`), set a pending flag; on the next `onResume`, if not `isIgnoringBatteryOptimizations` and never asked (SharedPreferences), fire `ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` once — the deep-Doze escape (research §4.3). Honest copy lives in the system dialog itself; the checklist explains the OEM battery-manager caveat (Samsung/Xiaomi "sleep" lists are outside any API).

**Tests:** Kotlin/manifest source pins in the v1400 rig (permissions present, PARTIAL_WAKE_LOCK acquire+release paths, onRenderProcessGone override, notification text update, the busy poll); engine-side: `chat_v1400_test.go` — the busy gauge counts concurrent turns, the endpoint answers live truth; rig S-checks: `GET /api/engine/busy` reads 1 mid-turn, 0 after. CI builds the APK (engine changed → `min_engine` walls the OTA → one install carries the wave).

---

## §2 — v1.39.3 THE PATIENT ENGINE (symptom 2's core: the retry policy)

**The law:** THE USER'S LAW extended to the network — a network outage is not a turn verdict. After the fixed rungs, the turn enters THE SUSPENDED MODE and waits for the internet to come back, for as long as it takes, bounded only by the user's Stop. "Continue with all its effort" (their words) is the spec.

1. **`netPauseLadder` (llm/chat.go)** — after the 5 fixed rungs, do NOT return the error. Enter the suspended loop:
   - **Enter notice (persisted):** one `notice` chunk — "connection to {provider} lost — the turn holds and keeps retrying (Stop always works)". Persisted so a returning/reconnecting user SEES why it was quiet (the ephemeral-only law of v0.39 made the whole outage invisible after reconnect — the exact "update the logs to show what I missed" ask).
   - **The wait cadence:** full-jitter exponential from a 60s base to a 5-minute cap (research §3.5 — AWS's jitter law), waited in **≤45s slices**; every slice emits an ephemeral progress heartbeat ("network paused — next attempt in Xs") — the heartbeat both keeps the live UI honest AND refreshes the turn pulse via `forwardEvents`' per-event `markTurnEvent`, so a suspended turn can never go `turnStale` (a >120s silent wait between attempts would otherwise arm the open door to abort a still-working turn — the S5 class reborn).
   - **The wake:** every wait slice `select`s on the engine-wide net-wake channel (§3) — regained connectivity retries in ~1s, not at the next rung.
   - **Exit:** success / non-transient error / `ctx.Done()` (the Stop button). **There is no give-up.**
   - **Exit notices (persisted):** on resume after suspension — "network regained after {duration} — continuing"; the transcript then shows exactly what the user missed (their ask, verbatim).
2. **Path coverage:** the plain turn (`runPlainTurn`), web-search turn, and deep-research paths get the same ladder — a tee-tap channel tracks `emitted` (first thinking/content chunk) so the **double-render guard survives intact**: rounds that streamed visible content are still never blindly retried (§4 owns that case instead).
3. **Rig-only time compression (documented, test-only):** env knobs `DOOMALAY_NET_LADDER_WAITS` (comma ms — replaces the fixed rungs), `DOOMALAY_NET_SUSPEND_BASE_MS`, `DOOMALAY_NET_SUSPEND_CAP_MS`, `DOOMALAY_NET_HEARTBEAT_MS`, `DOOMALAY_TURN_STALE_MS`. Default = the production numbers above.
4. 429/503 rungs: add jitter to the flat 4s/8s waits (same law, one-line).

**Tests:** `chat_v1400_test.go` — suspension semantics (unbounded, ctx-bounded, wake-bounded), notice emission + persistence classification, the heartbeat pulse (turnStale stays false through a long suspension), the emission tap (plain path: nothing-emitted → retried; content-emitted → never retried), env compression. Rig: the dead-provider stub (connection refused = `isTransientNetErr`'s "refused" class) → suspension → the door stays shut (busy answer to a second send past the stale window) → stub flips live → resume → full text + both notices in `ListEvents`.

---

## §3 — v1.39.4 THE NET WAKE (symptom 2's speed: event-driven, not timer-driven)

**The law:** fixed timers are the backstop, never the trigger (research §4.2). `ConnectivityManager.NetworkCallback.onAvailable` is the documented ~instant signal — and the Kotlin layer owns it.

1. **Manifest:** `ACCESS_NETWORK_STATE` (added in §1).
2. **Kotlin** (`EngineService`): register a `NetworkCallback` (default `NetworkRequest` + `NET_CAPABILITY_VALIDATED`, API 24+ = minSdk) → `onAvailable` → `TermuxBridgeServer.netWake()`.
3. **The bridge grows one push channel** (`TermuxBridge.kt`): a monotonically-increasing `netSeq` (AtomicLong) — `netWake()` increments it and releases the monitor. New route **`GET /<token>/netwait?since=N&timeout_ms=30000`**: long-poll — answers `{"seq": S}` the moment `S > N`, or `{"seq": S, "timeout": true}` at the timeout. Same token-auth loopback contract as `/run`, `/probe`, `/act`.
4. **The engine listens** (`server` startup, only when `--termux-bridge` is configured): a goroutine loops `NetWait(30s)` → on a seq change → `llm.WakeNet()`. The loop runs on a `Background`-derived ctx (the detachment law — never a request's). The termuxbridge `Client` grows `NetWait(ctx, since, timeoutMS)`.
5. **`llm.WakeNet()`** — package-level broadcast: a mutex-guarded channel swap; every suspended waiter (§2) selects on the current channel. Desktop/Termux/HF deployments (no bridge): no signal source, the jittered rungs carry it — identical semantics, slower wake.
6. **The PWA's `online` listener** (chatpanel.js module scope): `window.addEventListener('online', …)` → the §5 sweep (the browser regains connectivity before the engine's outbound leg does; both halves get the event).

**Tests:** rig S-checks with a **fake bridge server** (the rig passes `--termux-bridge http://127.0.0.1:PORT/TOKEN` to the real engine and implements `/netwait`): suspension with a multi-minute cap → flip the fake bridge's seq → the turn retries within ~1s (proves the whole chain: bridge long-poll → goroutine → `WakeNet` → waiter select). Kotlin: source pins (NetworkCallback registration, the netwait route, seq wake).

---

## §4 — v1.39.6 THE SEAMLESS CUT (mid-stream failures: the "continue where it left off" ask)

**The law:** the provider leg is not offset-resumable; the honest continuation is seal-the-partial + continue-with-it-as-context (research §3.6). No fabricated clean terminals; the seam is *marked*.

**Scope: the nativetools ReAct round + the plain path** (where bots live). When a round fails transiently AND it already streamed visible content (the double-render cliff):

1. **Seal the partial** — the streamed text is already rendered + persisted segment-wise; the round closes as a real segment (no re-emission).
2. **Persist the seam notice** — "the connection cut mid-reply — holding, and continuing when the network returns".
3. **Enter the same suspended mode** (§2's loop — shared helper).
4. **On resume: the continuation round** — a fresh provider call whose context carries the sealed partial as the trailing assistant message + the nudge: *"Your previous reply was cut off mid-stream after the text above. Continue that reply exactly from where it stopped — do not repeat any of it."* The continuation streams as a **new segment** (double-render impossible by construction — the old segment is sealed complete).
5. The turn's own verdict paths are untouched — only the transient-net mid-round class changes terminal→suspended+continue.

**Tests:** rig S-checks: a stub that streams 3 chunks then hard-cuts (RST) → the turn does NOT terminalize → suspension notice → stub live → the continuation completes the answer (both segments in `ListEvents`, seam notice between them) → the client's transcript renders partial + notice + continuation with zero duplicated text. The double-render guard stays guarded: non-transient mid-stream errors still end honestly.

---

## §5 — v1.39.5 THE HONEST RETURN (symptom 1's UX: the panel proves the work)

**The law:** never trust in-memory streaming state past a hidden period — on regain, resync from the log (research §2.4). The catch-up path exists (`&since=` replay + the TAIL LAW); this phase makes it *fire on the actual events*.

1. **`ChatClient.resync()`** (chatclient.js): a silent forced reconnect — teardown the WS *without* the ladder/onClose side-effects (a `_resyncing` flag `wireClientClose` respects), then `connect()` with `&since=lastSeq` → gap replay + live tail. This kills the **zombie socket** (doze/network-change left the WS dead-but-"open"; the engine's 75s read deadline would eventually clear it — the returning user shouldn't wait that).
2. **The visible sweep** (chatpanel.js's module-level `visibilitychange` listener — extend the existing one): on `visible` → (a) the existing indicator repaint; (b) **every** chat state gets `reviveClient` (dead clients connect now, not at the next 20s tick); (c) every owner-streaming chat with an *open* socket gets `client.resync()` (one cheap reconnect per return-with-live-work; the replay is the truth, a false positive costs nothing); (d) the all-chats index refreshes its engine-side previews (the "opens the bots panel → sees all the work" half).
3. **The `online` sweep:** the same listener body on `window 'online'`.
4. The §2/§4 persisted notices render through the existing `notice` bubble path — the transcript shows *what the engine did while the user was gone* (paused, regained, the seam) with zero new UI surfaces (the user's overlay/panel law respected; no new chrome).
5. `MainActivity.onResume` needs nothing new — the Android WebView dispatches native `visibilitychange` on window visibility changes, which is what fires the sweep.

**Tests:** walk W-checks (agent-browser + real engine + PWA): a long streamed turn → navigate away (the "user left the app" shape) → work continues engine-side → navigate back → the transcript shows the full work + the button still Stop; a mid-turn socket kill → `resync()` → replay + live resume with no "connection lost" flash; the synthetic `online` event → dead clients revive immediately; zero page errors.

---

## §6 — SHIP v1.40.0

- `buildinfo` 1.40.0 with the wave record; `docs/TERMUX-DEVICE-TEST.md` grows **the 5-minute unbroken-stream checklist**: (1) start a bot turn, background the app 2 minutes, screen off → return → the panel shows the work done in absence (the notification said "1 bot working" while away); (2) kill wifi mid-turn for 3+ minutes → the transcript shows the pause + regained notices, the turn completes on reconnect with no manual continue; (3) the one-time battery-exemption dialog after backgrounding a live turn — allow it; (4) the OEM battery-manager caveat (Samsung/Xiaomi sleep lists need a manual unrestrict); (5) the PM-provider honesty note (PM turns run in-page and slow down in background — engine-side PM is a future wave).
- **THE BATTERY:** `scripts/v1400-unbroken-stream-rig.mjs` (engine-level: suspension, wake, door, seam, busy gauge, bridge chain, source pins) + `scripts/v1400-unbroken-stream-walk.mjs` (agent-browser E2E) + `engine` `chat_v1400_test.go` + the full Go suite + vet + linux/android(arm64, CGO=0) builds + regressions: v1350 rig 62 (THE UNBROKEN TURN — this wave's invariants), v1370 walk 48, v1380 rig 32 + walk 18, v1390 30, v1391 verify, v1340 61+31, v1310 58+27, v1262, v1290, v1321, v1323, v1245.
- **Push protocol:** fetch origin (the parallel theme bot is live), diff, merge cleanly, re-run the battery on the merged tree, push `main` + the tag, watch the three CI jobs go green.

---

## THE INVARIANTS (carried from v1.35, enforced by the rig)

1. **No fabricated terminals** — pauses, seams and waits are *marked* (persisted notices); endings come from the engine's truth or the user's Stop. The `wireClientClose` fabricated-bubble deletion stays deleted (source pin).
2. **Connection liveness ≠ run liveness** — the pipe clears on the read deadline; the turn ctx stays `Background`-rooted; every new long loop (the wake listener, the suspended waits) inherits the detachment.
3. **The seq log owns the truth** — every new engine state (paused/regained/seam) rides the same persisted event log or the same ephemerality rules; the client is a tailer, never the carrier.
4. **The double-render guard** — a round that streamed visible content is never blindly retried; the seam is the only sanctioned continuation and it streams a *new* segment.
5. **Battery honesty** — the wakelock exists only while turns live, is released on idle/destroy, and its notification says the truth.
