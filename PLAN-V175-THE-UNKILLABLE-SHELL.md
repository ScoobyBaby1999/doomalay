# PLAN-V175 — THE UNKILLABLE SHELL

The user's ask verbatim (the boonboon transcript, 2026-10-24):
> "notice how after hours the bridge seems to have died. Possibly a restart
> I'm not sure, but the app survived - continued, lost connection to termux,
> and I had to setup the termux command manually. This is unacceptable. If
> we can't have the command be a one time setup (truly one time) then we
> need a script to auto setup termux everytime it gets switched off. No
> user input needed at all. So 2 things: termux needs to be persistent, and
> the bot needs better git access and knowledge."

The same transcript's first half (the push struggle): the model never knew
`git_setup` existed until the user said "just use git setup. It's already
available u have all the tolls" — then tried `termux git_setup` as a SHELL
command, then `{"op":"install"}`, before landing `{"action":"git_setup"}`;
the push itself then died on auth, non-fast-forward, and a rebase-conflict
maze resolved by hand with sed/python heredocs. Embarrassing — the user's
word.

## THE CONVICTIONS (from the transcript, diagnosed)

1. **THE SILENT DEATH**: hours in, EVERY termux exec times out — even
   `echo test` at 5s. The APK survived (chats continued); Termux did not.
   Cause (researched): Android killed Termux — the phantom process killer
   (Android 12+, the termux-app README's own NOTICE), an OEM battery pass,
   or a reboot leaving Termux in the stopped state. In ALL of those shapes
   the PendingIntent result never fires → every RUN_COMMAND times out. The
   engine had NO detection, NO revival, NO honesty — the model just burned
   its calls against a dead shell (13+ timeouts in the transcript).
2. **THE UNKNOWN HAND**: `git_setup` lived in the tool Desc + help since
   v1.29.5, but the model never read it — and the FAILURE POINT (git auth
   errors) taught nothing. The v1.74.6 wave taught the fallback lists; the
   failure point still teaches nothing. The model must meet the answer
   WHERE IT FAILS.
3. **THE PUSH DANCE**: push → auth fail → (unknown fix) → non-fast-forward
   → pull --rebase → conflict maze → manual sed surgery. Each step cost the
   model multiple flailing calls. The dance is KNOWN — fetch, rebase, push,
   tags — and the engine can do it in ONE verb with honest reporting.

## THE RESEARCH (the platform truths this rides)

- **Killed ≠ stopped**: a foreground-service caller CAN `startService()` a
  killed app's service back to life (Android docs: background service
  limits exempt foreground-service callers; the kill left the package
  runnable). The FIRST probe after death often revives Termux by itself —
  if the engine retries with patience (cold start is slow).
- **Stopped state is the wall**: force-stop / fresh boot leaves a package
  stopped; service starts are dropped like FLAG_EXCLUDE_STOPPED_PACKAGES
  broadcasts. The documented ladder out: launch the app's activity — and
  background activity launch is EXEMPT for apps holding
  SYSTEM_ALERT_WINDOW (developer.android.com/guide/components/activities/
  secure-bal: "The app has the SYSTEM_ALERT_WINDOW permission granted by
  the user").
- **Termux's own persistence law** (termux-app README + Termux:Boot docs):
  `termux-wake-lock` keeps the CPU + makes Termux hold itself alive;
  `~/.termux/boot/` scripts (Termux:Boot) re-arm at every device boot —
  the canonical "Termux survives reboots" answer, needs the add-on app
  opened once.
- **The heartbeat file**: `date +%s > $HOME/.doomalay/alive` — a cheap
  marker the engine can read through the bridge to separate "process dead"
  from "alive but busy".

## THE WAVE (5 phases, riding live buildinfo 1.73.0 → ship v1.74.0)

### v1.74.7 THE PHOENIX HEART — the engine-side auto-revive
New `engine/internal/server/termuxphoenix.go` (the termuxresume.go pattern):
- **THE HEALTH GAUGE**: every bridge outcome feeds it — probe results,
  streaming-run outcomes, resume runs. `termux phoenix` state:
  consecutiveFailures, lastFailureAt, lastOKAt, reviveAttempts,
  reviveRunning, reviveLastAt/OK/Error. A delivered result (any exec that
  answers, any probe with markers) resets the gauge. A transport error or
  run-timeout bumps it. (The bridge itself being unreachable — the APK
  dead — is NOT Termux death; the gauge only counts run-timeouts and
  dead-command signatures, the observed transcript's exact shape.)
- **THE DEATH CONVICTION**: ≥2 consecutive run-failures = dead. Then THE
  REVIVE LADDER, single-flight, throttled (≥90s between ladders, never
  two at once):
  1. a patient probe (45s deadline — cold start is slow; the probe's own
     startService often revives a killed-not-stopped Termux),
  2. still dead → the NEW `revive_termux` act through the bridge (v1.74.8
     Kotlin): re-send probe + launch the Termux activity (SAW-exempt when
     granted), wait 2s, re-probe,
  3. the honest status fields (`phoenix_*` in /api/termux/status) + the
     log lines — never silent.
- **THE KEEPALIVE**: a process-lifetime loop (netWakeListener's shape):
  every 15 min (±jitter), when Termux was READY within the last hour, one
  cheap probe — catches death within minutes instead of at the user's next
  command, and the periodic RUN_COMMAND keeps the Termux service warm
  against OEM "unused app" passes.
- **THE OBSERVATION TEACH**: the streaming TIMEOUT observation and the
  bridge-error observation grow the honest line when a revive is in flight:
  "Termux appears dead — the engine is auto-reviving it (attempt N); give
  it ~30s, or check /api/termux/status" — the model learns the state
  instead of burning calls. Zero new UI required (additive status fields
  the PWA can render later).

### v1.74.8 THE PHOENIX HAND — the Kotlin revive act
`TermuxBridge.kt` + the `/act` route, additive:
- `revive_termux`: (1) one benign RUN_COMMAND probe (20s), (2) if it never
  delivered: `startActivity(Termux)` with NEW_TASK — canDrawOverlays makes
  it legal from background; without the grant we try + catch honestly
  (some OEMs allow it), (3) answer {ok, probe_delivered, launched} — the
  engine's ladder reads it. The overlay-permission ask joins the Termux
  setup screen's honest rungs (a PWA-side pill, later wave — the act works
  without it whenever Termux was killed-not-stopped).

### v1.74.9 THE EVERALIVE SCRIPT — setup.sh (evolves OTA, no APK needed)
- **THE PERSISTENT WAKELOCK**: setup's final step acquires
  `termux-wake-lock` and KEEPS it (today: released at exit). The bar's
  note says so honestly. `termux-wake-unlock` is the user's off-switch.
- **THE BOOT SCRIPT**: writes `~/.termux/boot/doomalay-keepalive`
  (executable): `termux-wake-lock` + the heartbeat stamp + a log line.
  Works the moment Termux:Boot is installed+opened (the honest echo names
  the F-Droid install + one-open ritual — one time, by Termux's own
  security model).
- **THE HEARTBEAT**: `~/.doomalay/alive` (epoch) written at setup end +
  by the boot script — the engine's status read joins the resume state
  read (one marker'd cat, quiet-gated) so "Termux process dead" vs
  "alive" is a field, never a guess.
- The checkin stays untouched; the ledger stays untouched; every addition
  is non-fatal by the file's own law.

### v1.74.10 THE GIT HAND — first-class git verbs + self-healing auth
`termuxtool.go` + `mcpbus/def.go`:
- **THE VERBS** (jailed like every verb, workdir = first root or path):
  - `git_status` {path?}: branch, ahead/behind, `status --short`, last 5
    log lines — ONE observation.
  - `git_pull` {path?}: fetch + rebase; conflicts → the honest file list
    + marker counts + the resolve-then-commit teach; NEVER auto-resolves.
  - `git_push` {path?, tags?}: THE DANCE — fetch → behind? rebase → push
    (branch + --follow-tags; `tags:true` escalates to --tags).
    **THE SELF-HEALING AUTH**: auth-failure signature AND the vault holds
    a GitHub token → arm credentials INLINE (the git_setup script, factored
    into a helper) → retry the push ONCE → report honestly. The model
    never sees "Authentication failed" as a dead end again.
  - `git_commit` {message, paths?, path?}: add (all or paths) + commit,
    the summary line back.
- **THE FAILURE-POINT TEACH** (the transcript's root conviction): when an
  exec's output carries git's auth-failure signatures (Authentication
  failed / could not read Username / terminal prompts disabled / 403 on
  github.com) AND the vault holds a token, the observation GROWS the line:
  "GIT AUTH FAILED — the vault's GitHub token arms Termux in ONE call:
  {\"action\":\"git_setup\"} (or git_push, which arms it automatically).
  Never paste tokens into commands." The answer meets the failure.
- **THE TEACHES**: termuxVerbs + the manifest Desc + the help text carry
  the git verbs first-class; the unknown-action fallback already lists
  them (v1.74.6's complete-teach law — extend its list, keep its shape).
- Census: the mcpbus enum pin re-anchors (the verbs ride the termux
  tool's action enum — 34 tools unchanged).

### v1.74.11 THE LIVE PROOF — the rig + the ship
- Go pins: phoenix (conviction ladder, throttle, single-flight, status
  fields, the timeout teach, the heartbeat parse), git (self-heal flow
  against a fake bridge — auth fail → arm → retry succeeds; conflict
  honesty; the exec auth-teach firing + NOT firing without a token;
  git_status shape). TestV1747/TestV17410.
- The battery: go test ./... (chunked), vet, the linux + android-arm64
  cross-compiles, the census re-anchor, discipline 7+B1.
- buildinfo **1.74.0** (live buildinfo 1.73.0 + 1 — the +1 law, no skips),
  the README v1.74 section, the worklog record, the tag
  `v1.74.0-the-unkillable-shell`, push (rebase first).

## THE LAWS (this wave's own)
- **A setup that RAN is a setup that STAYS ALIVE** — the persistence
  rides the one-time bootstrap; no new user ritual beyond Termux's own
  security model (the Boot add-on's one open).
- **The failure point is the teacher** — every known remedy meets the
  model exactly where it fails, never in a manual it won't read.
- **Honesty all the way down** — revive attempts, wake locks, heartbeats:
  status fields + observation lines, never silent magic.
- Additive everywhere: the bridge act, the status fields, the verbs — an
  old PWA + old Kotlin + old setup.sh keep working byte-identical.
