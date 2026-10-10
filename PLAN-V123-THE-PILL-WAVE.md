# PLAN-V123 — THE PILL WAVE

The live-tool wave: six user fronts, one vessel. The Termux download link goes
dynamic, the exec pacing loses its 4s cooldown, the two tool pills (call +
result) become ONE pill with a live loading bar, long-running Termux output
STREAMS in twice a second instead of popping, the vague "exec" label becomes
the actual program (python / mkdir / pkg install…), and the full-result
overlay becomes one polished box. Four build phases → v1.24.0.

---

## §0 RESEARCH RECEIPTS (verified live, this sandbox)

1. **F-Droid API v1** — `GET https://f-droid.org/api/v1/packages/com.termux`
   returns (fetched today):
   `{"packageName":"com.termux","suggestedVersionCode":1002,"packages":[
   {"versionName":"0.119.0-beta.3","versionCode":1022},
   {"versionName":"0.119.0-beta.2","versionCode":1021},
   {"versionName":"0.118.3","versionCode":1002}]}`
   → The user's "2nd link = stable" heuristic is WRONG TODAY (packages[1] is
   0.119.0-beta.2 — ANOTHER beta). The correct dynamic pick: the entry whose
   `versionCode === suggestedVersionCode` (1002 → 0.118.3, the stable).
   APK URL pattern: `https://f-droid.org/repo/com.termux_<code>.apk` (no
   apkName in the response — the code-based URL is the F-Droid repo layout).
   Fallback chain: suggested-match → first non-prerelease-tagged entry
   (beta/rc/alpha — universal markers, not a program list) → the static 1002.
2. **Termux RUN_COMMAND physics** — the result is ONE PendingIntent broadcast,
   stdout+stderr capped at 100KB combined, no incremental channel. Confirmed
   by the termux-app wiki + the v1.20.1 research. → Streaming must originate
   INSIDE Termux: the wrapper script writes logs and curls increments to the
   engine's loopback (the v1.20.1 checkin pattern proves Termux→APK loopback
   HTTP works; the engine listens on 127.0.0.1:8080 on the APK).
3. **The APK port** — EngineService launches the engine on 127.0.0.1:8080;
   Termux (same device, loopback shared) can reach it. The checkin route
   (Termux→Kotlin bridge) is the precedent; the stream route goes DIRECT to
   the engine (no Kotlin changes for streaming — only the F-Droid URL param
   touches Kotlin, allowlisted to https://f-droid.org/).
4. **The "exec" label source** — pmsdk.js's summary scan hits the flat
   `action` key first → "exec". The engine WS path already summarizes the
   command. The PM onTool event carries NO args → the pill can't derive
   anything better. Fix: pass args + derive the label at render time.
5. **The stall law** — chatpanel.js:5005: 120s of no activity = "may be
   stuck" + a ⇄ switch chip. A python install > 120s with zero events trips
   it (the user's report). Streaming chunks bumpActivity → the false stall
   dies naturally once streams exist.

---

## §1 v1.23.1 THE LINK + THE PACING

**fdroid.go (NEW, engine/internal/server):**
- `resolveFdroidTermuxURL(ctx, client, apiBase)` — GET <apiBase>/v1/packages
  /com.termux (5s timeout), parse {suggestedVersionCode, packages[]}, pick
  entry.versionCode == suggestedVersionCode; else first entry whose
  versionName lacks beta/rc/alpha; else the static fallback. URL =
  `https://f-droid.org/repo/com.termux_<code>.apk`.
- Server cache: 6h TTL, warm on the first /api/termux/status probe (the
  setup page polls it — the link is resolved before the tap lands). A failed
  fetch never errors the caller — the static fallback answers.
- The act route (termuxapi.go handleAct, open_fdroid): resolve (cache ok) →
  forward `{"what":"open_fdroid","url":"<resolved>"}` to the bridge.

**TermuxBridge.kt (one edit):** handleRun parses the optional body "url";
openFdroid(ctx, url) opens it ONLY if it starts with `https://f-droid.org/`
(the allowlist — the static constant answers everything else). The engine
fix rides the APK; the Kotlin diff stays ~10 lines.

**THE PACING:** termuxExecCooldown 4s → REMOVED (the gate loses the
last-exec stamp entirely; the rolling 12/min cap stays the anti-burst law).
Every teaching surface updates honestly: termuxtool.go's help + example line,
sessionctx.go's armed block ("exec paces at ≥4s…" → "…12 per minute"),
mcpbus/def.go's Desc if it mentions pacing (it doesn't — only the 100KB cap:
verify), the PM twin in chatpanel.js (pmSessionContext) if it mentions
pacing (verify). Tests re-pinned: termuxtool_test.go's cooldown pins (the
immediate-second-exec now RUNS), v1211 rig's pacing pin (line 244-246: the
second exec gets the cap verdict at the 13th call instead — re-pin the
refusal shape), v1203/v1204 pins if they name the cooldown (grep first).

**Battery:** go build/vet/test (server + mcpbus + llm), new fdroid_test.go
(httptest mock: suggested-match, no-match-non-prerelease, offline-fallback),
the v1211/v1203/v1204 rigs re-run, the v1213/v1173 setup rigs untouched.

## §2 v1.23.2 THE ONE PILL

**The merge (chatpanel.js, render-time only — persistence stays append-only):**
- tool_use event (WS + PM + replay): the pill msg gains `pending:true` (no
  text change at store time). The collapsed label = `toolPillLabel(payload)`:
  termux exec → `<program>[ install]` derived from the command (the ONE
  generic sub-verb; no static lists) + the dim query tail; termux pkg →
  `pkg install <name>`; every other tool → summary || name (today's law).
- tool_result event: find the LAST pending same-name tool msg above → merge
  (msg.pending=false, msg.result=text, ei2=ev.i) → repaint THAT row in place
  (refreshToolPill: querySelector [data-mi] → messageHTML swap). No pending
  match → the standalone result pill (legacy chats from older engines that
  fire result-only events — verified: they don't).
- The hide pass (delete/edit) checks ei AND ei2.
- messageHTML tool branch: ONE pill. Collapsed: [⌕|↳ icon] label · dim
  query-tail (live stream tail while streaming, v1.23.3) + chevron + ↗.
  Expanded: the loading bar (pending) or the result preview (2KB cap, the
  today-law) + "open full view" affordance. `msg.progress` pills keep their
  own class (the v0.23 ephemeral progress rows are a different role —
  untouched).
- The loading bar: a 2px indeterminate slide, --accent fill on
  --surface-2 track (theme vars only), shown while pending; hidden once the
  result lands.
- PM path (pmsdk.js): onTool events carry `args: argsObj` (the payload rides
  so the label derives at render) + the summary scan prefers the nested
  `args.command` before the flat keys; the persist JSON gains the args
  string (old replays without it degrade to the summary label — honest).
- openToolFullView: unchanged this phase (v1.23.4 restyles it); it already
  borrows args from the use-half — the merge makes that lookup trivial.

**Rig (scripts/v1232-one-pill-rig.cjs):** the pure label derivation matrix
(python/pip install/pkg/mkdir/bash -c/cd-pipes/garbage), the merge reducer
(use→result merges; result-only degrades; second call of same name pairs to
the SECOND pending pill), the hide two-ei law, the pmsdk payload shape
(args + nested-command summary), the CSS class contract (theme vars, the
loading bar), replay determinism (same events → same one-pill transcript).

## §3 v1.23.3 THE LIVE STREAM

**The engine stream registry (termuxstream.go NEW):**
- `map[token]→{sessionID, name, out bytes, err bytes, done, exitCode, at}` +
  listeners; token = crypto/rand UUID (the checkin unguessability law).
- Route `POST /api/termux/stream/{token}` — body = raw chunk bytes, query
  `ch=o|e`, `done=1&ec=N` completes. Token-gated (wrong token = 404). GC:
  entries die 5min after done.
- Route `GET /api/termux/stream?session=<sid>&after=<len>` — the PM poll:
  {active, name, text (delta from after), len} — deltas with an offset (the
  UI appends exactly like the WS path).

**The wrapper (termuxtool.go exec + pkg verbs):**
- Long-running shape (exec + pkg only; the file verbs stay one-shot — they're
  sub-second): the command (base64 — zero interpolation, the session idiom)
  runs with stdout→out.log, stderr→err.log; a poll loop every 0.5s flushes
  each log's increment via `tail -c +N | curl --data-binary @-` to the
  stream URL; on exit: final flush + the done curl (ec) + `cat` both logs
  (THE FALLBACK: if the curls never landed, the result broadcast carries the
  full output — the engine uses the chunks when present, the broadcast
  otherwise; ONE wrapper serves both worlds).
- The engine: register the stream (token + session + name) BEFORE the Run;
  the registry accumulates as curls land; the Run's result closes it. The
  observation composes from the registry (stdout/stderr split preserved —
  two logs, two chunk channels) + the broadcast's exit code; 100KB
  truncation honesty from the accumulated lengths.
- WS path: the TermuxFn closure wraps with a listener → every registry
  append emits `ChatChunk{Type:"tool_stream", Name:"termux", Delta}` →
  chat.go's converter forwards `tool_stream` events (type passthrough —
  forwardEvents needs the case + persistence is EPHEMERAL: stream events
  never persist; the replay law stays the use+result pair).
- PM path: pmsdk.js — while a termux tools/call is in flight, poll
  GET /api/termux/stream?session&after every 600ms; each delta fires
  opts.onToolStream({name, delta}) → chatpanel merges into the pending pill.
- The UI: the pending pill's expanded result area shows the streaming text
  (append + throttled repaint, the scheduleUpdate cadence) + the thin
  receiving bar; the collapsed pill's dim tail becomes the live last line.
  Every chunk: bumpActivity (the stall fix — a 3-minute pip install can
  never trip the 120s law again) + setActivity("running <label>… <size>").
- Timeout: the registry entry closes on the Run's timeout verdict (honest
  partial output — the wrapper's logs still hold the tail; the observation
  reports the timeout exactly like today).

**Rig (scripts/v1233-live-stream-rig.mjs):** a real engine + the v1204-style
fake bridge that EXECUTES bash for real, loopback remapped — a slow `for i
in 1..6; do echo line; sleep 0.6; done` stream: chunk cadence ≈0.5s, the
delta composition, the stdout/stderr split, the done+ec law, the fallback
(cat when curls blocked — simulate by pointing the stream URL at a dead
port), the PM poll endpoint (after-offset deltas), the WS event order
(use → streams → result), zero persistence of stream events (replay = two
events, one pill), the stall-clock reset (state._lastActAt moves with
chunks), the 100KB truncation marker on a >100KB stream.

## §4 v1.23.4 THE POLISH + REDTEAM

**The full-view overlay (chatpanel.js + index.html CSS):**
- ONE box: the head (icon + tool name + derived label) → ONE rounded
  container holding query (labeled, mono, subtle) + divider + output
  (Formatter) + the pager. The two prototype boxes (tv-q + tv-result) become
  one `.tv-body` surface.
- Copy: a footer row bottom-right — the ⧉ copy icon + small "copy" label,
  full-width clear of the overlay's top-right ✕ (the overlap dies).
- Edge room: .tool-fullview padding 18-20px + the head keeps 28px right pad
  (the ✕ zone stays clear by construction). All colors theme vars.
- Displays tool + query + output (the merged shape — mi points at the one
  pill; the result + query both live on it).

**Redteam (as a real user, agent-browser + the rigs):** the full walk:
setup page → Get Termux (the resolved URL rides the act) → a chat with a
termux tool call → the ONE pill → expand → the live stream → the overlay →
copy → close → replay the chat (one pill, same transcript) → delete a tool
message (the two-ei hide) → mobile 390px → zero console errors. The
cooldown-free rapid execs (two in a second — both run, both pills). The
13th-in-a-minute refusal (the cap's honest teach). Tunnel: down at plan
time — re-check at ship; the device checklist gains the wave's steps
(docs/TERMUX-DEVICE-TEST.md).

## §5 v1.24.0 — buildinfo + the wave record + the APK CI.

**The OTA law (honest):** the PWA phases (pill merge, stream UI, overlay)
land OTA immediately; the engine phases (fdroid, pacing, the stream route +
wrapper) + the Kotlin URL param ride the APK. The wave record names both.

---

## THE WORKFLOW LAW (saved per the user's standing directive)

> Do not implement anything without planning out all phases in detail whilst
> websearching all the documentation and relevant websites for insight we can
> apply before anything is actually done. This applies to everything from now
> on. Before you build: initial plan/hypothesis → web search → real plan →
> build → revise/test/redteam the implemented phase/sub-goal with real tests,
> imitate a real user and act as a human being testing the full capabilities
> and trying out use cases.

**The push law:** phases push as v1.23.1 → v1.23.2 → v1.23.3 → v1.23.4; the
whole prompt ships as v1.24.0. Before EVERY push: fetch origin, rebase on
the latest main (the parallel agents' waves land in between), resolve
conflicts (the whitespace law: engine Go = the file's own tab/space style;
web JS = 8-space), re-run the battery, then push. The mirror wave
(v1.22.0, PLAN-V122) owns the preamble surfaces — this wave touches
chat.go's termux/event regions only; a rebase handles any overlap.
