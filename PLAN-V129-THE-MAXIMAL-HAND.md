# PLAN-V129 — THE MAXIMAL HAND

The user's report (the Doobie chatlog, live device v1.27.x — a full
self-audit the bot ran against its own sandbox):
> "In it's contents, you can see that we have a 60 second termux timeout.
> When we shouldn't. Also, we don't have maximal termux capabilities as we
> should."

Two asks, both evidenced inside the transcript:

## THE EVIDENCE (the Doobie audit, live device)

1. **THE 60s BUDGET BIT — twice.**
   `TIMEOUT — Termux killed the command at its 60s budget; partial stdout:
   go: downloading github.com/segmentio/asm v1.1.3 …` — a Go module fetch
   died at 60s. The model had NOT passed `timeout_ms` (none of its exec
   calls did), so the compiled default fired. The audit's own conclusion
   (#8): "60-second exec budget — long compilations/downloads need chunked
   resumes or background sessions."
2. **THE 180s CEILING** — `termuxtool.go` clamps any `timeout_ms` to
   180000; the Kotlin bridge hard-caps at `MAX_RUN_TIMEOUT_MS = 180_000`;
   the engine-side HTTP client carries `clientHardCap = 185s`. Even when
   the model ASKS for longer, every layer refuses past 3 minutes.
3. **The pkg verb** runs a FIXED 180000 (a 38 MB golang install took 37s
   on this device's network; a slow-network toolchain can exceed 3 min).
4. **THE HELP LIES** (honesty debt, independent bug): the help still
   teaches "60s default, 180s max; **12 per minute per chat**" — the
   12/min default DIED in v1.26.2 (unbound unless armed in ✦ tweaks). The
   chatlog's model read this help and believed a cap that isn't there.
5. **THE NOEXEC DISCOVERY BURN** (audit #7): shared storage is FUSE-mounted
   `noexec` AND copied files land mode-600 — the model burned 4+ tool
   calls discovering the pattern (`./mcpclient: Permission denied` →
   `grep /proc/mounts` → `cp … $HOME` → still denied → `chmod 755` →
   works). The capability EXISTS (exec can `cd $HOME && ./bin`); the
   KNOWLEDGE is what's missing — nothing teaches the model the physics.
6. **THE DEVICE-COMMANDS GAP**: the help advertises "the termux-api
   package adds the device commands (termux-battery-status,
   termux-wifi-connectioninfo, termux-notification, termux-clipboard-set…)"
   — but on this device they are absent (the `cmds` inventory proves the
   Termux:API companion app isn't installed) and NOTHING in the app says
   so or how to unlock them.

## RESEARCH RECEIPTS

· **The timeout-observation honesty** — the current text says "Termux
  killed the command at its 60s budget". Neither half survives scrutiny:
  the budget is OURS (the engine arms the Kotlin `timeoutRunnable`), and
  NOTHING is killed — `runCommand`'s timeout only stops WAITING
  (TermuxBridge.kt:286-290 fires and reports `timeout=true`; the
  Termux-side process keeps running — termuxstreamrun.go's own comment:
  "the wrapper may still run in Termux"). The stream-recovery path (cat
  the logs by token) exists precisely BECAUSE the process outlives the
  wait. The new text tells both truths.
· **Why not a literally-unbounded default**: the bridge round-trip needs
  a bound by construction (the Kotlin latch + timeoutRunnable design; the
  engine's HTTP context — a *sick* bridge must never hang a turn forever),
  and a genuinely hung command (a prompt, an infinite loop) would hold
  the turn with only the Stop button — chat.go:912's own law ("v0.80.1:
  NO turn budget — the Stop button … the only cancellation paths"). The
  repo already has the unbounded lane: **session_start** (nohup, no
  budget, tailable log, killable pid). So the ladder is: default 10 min →
  explicit `timeout_ms` up to 30 min → session_start for the unbounded
  class. 600s covers 10× the longest job the audit ran; 1800s matches the
  longest reasonable compile/download; the sessions lane takes everything
  beyond.
· **The FUSE noexec physics** (audit-verified, /proc/mounts on device):
  `/storage/emulated/0` is `rw,nosuid,nodev,noexec` FUSE; `$HOME`
  (`/data/data/com.termux/files/home`) is real data storage — exec works
  there and `chmod` sticks. The audit's proven pattern:
  `cp bin $HOME/ && chmod 755 $HOME/bin && $HOME/bin`. Teaching one line
  in the help + manifest = zero discovery burns next time. This is
  Android physics (scoped-storage FUSE) — not fixable, only teachable.
· **Termux:API**: the device commands come from TWO pieces — `pkg install
  termux-api` (the CLI scripts, visible in `cmds`) AND the Termux:API
  companion app (F-Droid, `com.termux.api`) that actually executes the
  intents. Neither is present on this device. The bridge ALREADY does a
  PackageManager lookup for `com.termux` (sub-ms) on every /status — a
  `com.termux.api` lookup is the identical shape, and the additive-field
  law (v1.20.1's checkin fields: "an older Kotlin bridge that predates …
  simply does not send them, and they decode to their zero values") is
  the established pattern for growing /status.

## §1 — v1.28.1 THE LONG BUDGET (the engine side)

`termuxtool.go`:
- exec: `timeoutMS := 60000` → **600000** (10 min default); the clamp
  `> 180000 → 180000` → **`> 1800000 → 1800000`** (30 min ceiling).
- pkg: the fixed `180000` → **600000** (installs stream live; matches the
  exec default; a slow-network toolchain completes).
- `termuxTimeoutObs` + the streaming twin's inline text: "Termux killed
  the command at its Ns budget" → the honest two-truth text:
  `TIMEOUT — the Ns exec budget ended; the command may still be running
  in Termux (pass timeout_ms up to 1800000, or session_start it for
  unbounded)` + partial output as before.

`termuxbridge/client.go`:
- `clientHardCap = 185 * time.Second` → **1805s** (the bridge max + the
  same +5s slack `termuxRunOne` uses — the belt under forgetful callers
  stays a belt, just a 30-minute one).
- The doc comments that teach "60s / 180s hard cap" follow the new law.

**Go pins** (`termuxtool_test.go`): default-60s pin → 600000; clamp pin →
1800000; the TIMEOUT-text pin follows the new observation. The fake
bridge's own internal 60000 default is its own physics (only its kill
timer) — rides along for consistency.

## §2 — v1.28.2 THE KOTLIN TWIN + THE TAUGHT LAW

`TermuxBridge.kt` (companion constants — the twin law, both sides match):
- `DEFAULT_RUN_TIMEOUT_MS = 60_000L` → **600_000L**
- `MAX_RUN_TIMEOUT_MS = 180_000L` → **1_800_000L** (MIN 1s stays)

THE TAUGHT LAW (the model-facing capability text — the "maximal
capabilities" ask made real):
- `termuxHelpText`: the exec line's stale "60s default, 180s max; 12 per
  minute per chat" DIES → "10 min default, 30 min max (timeout_ms);
  unbounded jobs → session_start" + the pacing truth ("unbound by
  default; an optional per-minute burst cap arms in ✦ tweaks → Termux").
- The capability paragraph grows the audit's two physics laws, taught as
  one line each: the noexec law ("compiled binaries cannot execute from
  the bound folders (FUSE noexec) — copy to $HOME and set the bit:
  cp bin $HOME/ && chmod 755 $HOME/bin && $HOME/bin") and the device-
  commands law ("the termux-api package + the Termux:API companion app
  (F-Droid) unlock battery/wifi/location/camera/notification/clipboard
  commands").
- `mcpbus/def.go` termux Desc: two short clauses join ("exec budget 10
  min default / 30 min max, unbounded via background sessions; compiled
  binaries execute from $HOME only — shared storage is noexec") — the
  manifest is what the model reads FIRST.

**Rig re-pins**: `v1233-live-stream-rig.mjs`'s TIMEOUT-text assertion
follows the new honest observation.

## §3 — v1.28.3 THE DEVICE COMMANDS LIGHT (the unlock, made visible)

- `TermuxBridge.kt`: `isApiInstalled(ctx)` (PackageManager lookup for
  `com.termux.api`, the same shape as `isInstalled`) + `api_installed`
  rides `statusJson()` — additive; old bridges decode it to false (the
  honest-old-flow law).
- `termuxbridge/client.go` Status struct: `APIInstalled bool
  \`json:"api_installed"\`` (additive, zero-value-tolerant).
- `termuxapi.go` aggregation: `api_installed` passthrough in
  /api/termux/status.
- `termuxsetup.js`: the READY card grows ONE honest line — installed:
  "device commands live (battery · wifi · location · camera ·
  notification · clipboard)"; not: "device commands locked — install the
  Termux:API app (F-Droid) + pkg install termux-api to unlock battery/
  wifi/location/camera/…". No new intent, no new URL plumbing — text
  guidance only (the setup ladder's own idiom).
- The help's device-commands line carries the SAME requirement wording
  (§2's text already does).

## §4 — v1.29.0 THE SHIP

- `buildinfo.go` → 1.29.0 THE MAXIMAL HAND + the record comment.
- NEW `scripts/v1290-maximal-rig.mjs` (the live-engine battery): the
  default-budget law (an exec with NO timeout_ms rides 600000 — asserted
  on the fake bridge's received body), the clamp law (timeout_ms 9999999
  → 1800000), the pkg budget (600000), the honest TIMEOUT observation
  text (both the one-shot path and the streaming path), the help honesty
  (no "12 per minute"; the budgets taught; the noexec law present), the
  status field (`api_installed` present, bool).
- The existing battery re-run: the Go server suite (termuxtool pins),
  v1233 (live-stream), v1241 (terminal pulse), v1245 (pill titles),
  v1262 (unbound burst), v1270 E2E (the walk — its stub passes
  timeout_ms 60000, a still-legal value; zero changes expected).
- `docs/TERMUX-DEVICE-TEST.md` grows the budget walk (a 70s sleep exec
  under the new default completes; a timeout_ms=2000 exec reports the
  honest budget-ended text).
- Commit sequence per the repo's wave law: §1, §2, §3, §4 — then push +
  tag `v1.29.0-the-maximal-hand`.

## THE OTA WALL (recorded honestly, the v1.27.0 lesson)

The engine AND the Kotlin bridge change → `min_engine` walls the delta →
ONE APK install carries everything. The OTA banner says so.
