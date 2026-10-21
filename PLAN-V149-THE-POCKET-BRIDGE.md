# PLAN-V149 — THE POCKET BRIDGE

The user's ask (verbatim anchor): "We can run opencode directly on termux, let's
port and move the opencode to android aswell. Chatting with it should work …
we want the opencode provider to work with as few gates as possible. If we
require termux or another gate then so be it, better then nothing, we can work
around that. Atleast opencode is available for Android."

Standing laws honored: plan → research → build → red-team; phases v1.49.x then
the v1.49.0 ship; two-surface UI; theme tokens only; rebase before every push
(THE MERGED-TREE LAW: re-run the rig on the merged tree before the ship).

## THE RESEARCH (live from this sandbox, 2026-10-21+)

### The official truth: there is NO Android opencode
- anomalyco/opencode #10504: the official linux-aarch64 release binary fails
  natively on Termux — wrong interpreter (`/lib/ld-linux-aarch64.so.1`) and
  non-PIE; bionic can't load it. #12515: the npm package's postinstall
  downloads that same binary and dies. #21043: upstream CLOSED "CLI
  misdetects Android/Termux as Linux" as **not planned**. The desktop
  bridge's own law (v1.48.5: glibc 186MB binary, bionic can't run it) is the
  same truth from our side.
- proot IS a documented workaround (issue #709: "Switching to a proot
  distribution" works) — but it means ~250MB of downloads, ptrace overhead on
  every syscall, and a glibc distro to babysit. NOT the best gate.

### THE FIND: guysoft/opencode-termux (291★, 30 releases, active Oct 2026)
Cross-compiles OpenCode NATIVELY for Android/Termux aarch64: Bun patched for
Android (33 files: seccomp syscall fallbacks, bionic TLS alignment, PIE,
NDK toolchain), WebKit/JSC ported to bionic, Zig sigaction fix, OpenTUI
linked against the NDK libc stub. README: **"All backend services (server,
provider, LSP) [working]"** — the server is what we need. Tested on real
devices (Galaxy S10e, full TUI).

Two artifact lines:

| line | build | latest | size | API family | status |
|---|---|---|---|---|---|
| v1 | OpenCode 1.17.9 (patched-Bun transplant) | **v0.2.1 (Jun 25 2026)** | zip 52.0MB | **1.x serve** (ours) | **STABLE** |
| v2 | opencode2 = OpenCode 2.0.0-android-termux (official Bun android target) | v1.0.3-rc3 (Oct 18 2026) | zip 72.5MB | 2.x serve (new) | prerelease |

- **v0.2.1 / opencode-1.17.9-android-aarch64.zip**
  SHA256 `0c77d4b8f286e01ba08c9e9aeca8c73a0e0c655342044ab3a59cf1953093a9b0`
  (downloaded + verified in-sandbox). Layout: `opencode` (3430B POSIX-sh
  wrapper), `opencode.bin` (141.8MB), `libtagfix.so`, `libc++_shared.so`,
  `libopentui.so`. The wrapper handles EVERY Android trap itself:
  LD_PRELOAD libtagfix (bionic heap-tagging fix), LD_LIBRARY_PATH for
  libc++_shared, OPENTUI_LIB_PATH, disables @parcel/watcher, TMPDIR. Flat
  zip layout runs standalone: unzip → `./opencode serve …`. No package
  manager, no PREFIX assumptions, F-Droid-vs-Play irrelevant.
- opencode.ai/docs/server: 2.x uses a NEW API (/global/health, /project,
  /instance/dispose, …) — opencode2 would need a new adapter. The v1 line
  speaks OUR captured shapes: POST /session → {id}, prompt_async → 204,
  GET /event SSE (message.part.delta / part.updated / message.updated /
  session.idle), GET /session/status health — the ocserve client is
  **byte-compatible** with a 1.17.9 serve. DECISION: v0.2.1 (1.17.9) is the
  pin; opencode2 + a 2.x adapter is plan-B if the free-tier gate rejects
  1.17.9 (the gate "actively evolves"; desktop 1.19.3 passes — proven
  v1.48.5; 1.17.9 is the same era, ~4 months older).
- The genuine-client law holds: the guysoft binary IS opencode's own module
  graph on a patched runtime — the gate's below-HTTP client check sees the
  same client crypto; only the VERSION can differ (the decision gate).

### The app already owns every gate mechanism (v1.17–v1.35 waves)
- `termux/setup.sh` one-liner (v1.24.1, v1.35.1 pending-ledger):
  `curl -fsSL https://raw.githubusercontent.com/ScoobyBaby1999/doomalay/main/termux/setup.sh | bash`
  → allow-external-apps (the RUN_COMMAND permission) + storage + coreutils
  + checkin back to the app. The user most likely ALREADY ran it.
- `termuxbridge.Client` (engine): the Kotlin loopback server's jailed exec —
  POST /run (command, workdir, timeout_ms, 30-min hard cap) + RunWithStdin
  (zero-escaping file writes), GET /status (installed/permission/api),
  POST /act (open_termux / open_fdroid), /netwait. Auth = same-UID loopback
  + unguessable token in the URL path (DOOMALAY_TERMUX_BRIDGE /
  cfg.TermuxBridge, already wired into the Server at server.go:173).
- Loopback sharing: Termux→APK is proven in-production (the checkin);
  APK→Termux rides the SAME shared loopback interface (Orbot-class
  precedent — all apps in a user profile share 127.0.0.1). The engine
  probes a free port via its own net.Listen (same interface), Termux binds
  it, the engine connects. Verified live by the rig (phase 3).

### THE GATES (honest, minimal, three taps total)
1. Termux installed (the app shepherds: open_fdroid act + F-Droid page).
2. The one-line bootstrap (setup.sh — the EXISTING doomalay law; gives
   allow-external-apps; the checkin tells the app it ran).
3. Tap "Install OpenCode" in the provider card — the ENGINE drives the rest
   through the jailed exec: download the pinned 52MB zip (SHA-verified),
   unzip to ~/.doomalay/opencode/, `pkg install unzip ripgrep` (best-effort),
   write the gate-law opencode.json, take the wake-lock, nohup-spawn
   `opencode serve --port N --hostname 127.0.0.1`, health-poll, connect.
   The user types NOTHING after gate 2. Termux needs to stay alive (the
   wake-lock + honest status in the card; a phantom-killed Termux = the
   honest unavailable copy + "open Termux once to revive").

## THE ARCHITECTURE

```
chat turn (opencode free model, Android)
  → ocServeManager (server/ocserveturn.go — unchanged dispatch)
    → ocserve.Manager.Start — PLATFORM SPAWNER (new):
        desktop : exec-child (v1.48.5 law, unchanged, pinned 1.19.3)
        android : termuxProvisioner (new ocserve/termux.go):
                    bridge /status → ready?
                    /run download (pinned zip + SHA)
                    /run unzip + chmod + pkg (best-effort)
                    /run config (gate-law opencode.json via stdin)
                    /run spawn (wake-lock + nohup + OPENCODE_API_KEY env)
                    health-poll 127.0.0.1:N (shared loopback)
                    SetBaseURL → the EXISTING client does everything
        watchdog: serve died → re-provision (bounded); Termux dead →
                  honest ErrUnavailableWithHint
  → the turn adapter (ocserveturn.go) — UNCHANGED (sessions, opening text,
    SSE→deltas, recycle law, ledger)
```

- The spawner choice: `runtime.GOOS == "android"` → termux provisioner;
  `DOOMALAY_OPENCODE_SPAWNER=termux` forces it anywhere (the rigs);
  `DOOMALAY_OPENCODE_SPAWNER=exec` forces the classic child (belt).
- The provisioner needs the termux bridge client: the Server passes
  `s.termux` into ocserve.New (an optional field — nil = the honest
  not-bootstrapped error).
- Pinned artifact: v0.2.1 zip + SHA256 constant; env override
  `DOOMALAY_OPENCODE_ANDROID_ZIP` + `…_SHA256` (rigs + future bumps).
- Serve dir: `~/.doomalay/opencode-serve/` (Termux home) — the gate-law
  opencode.json lives there (the serve CWD); binary at
  `~/.doomalay/opencode/`. Idempotent install (re-run overwrites);
  no ledger needed.
- Port: the engine picks (net.Listen :0 probe on the shared loopback),
  passes --port; state stays in the Manager (no persistence needed —
  a fresh engine run re-provisions lazily on the first free turn).

## THE PHASES

- **v1.49.1 THE GUEST ROOM** — `ocserve/termux.go`: the provisioner (status
  ladder → install → spawn → health → honest errors at every rung) + the
  spawner interface in ocserve.go + the Server wiring (termux client +
  OPENCODE_ZEN_API_KEY pass-through; the key rides the spawn env).
  Unit pins: the command shapes (pinned URL, the wrapper invocation, nohup +
  wake-lock, the env key, the gate-law config bytes), the SHA-verify law,
  the honest-error ladder (no bridge / not bootstrapped / download fail /
  sha fail / unzip fail / health timeout), the idempotent re-install, the
  bounded watchdog. All fakeable — no device needed.
- **v1.49.2 THE OPEN HANDSHAKE** — the app surface:
  GET /api/opencode/bridge (state ladder: checking → termux_missing →
  not_bootstrapped → ready_to_install → installing → starting → up |
  install_failed | walled, with honest detail + versions + size + port);
  POST /api/opencode/bridge/install (idempotent engine-driven install);
  the turn-error copy names the phone bridge; providers.js card: the
  Android states replace the dead-end copy (the checklist + the COPY
  one-liner (the existing bootstrap command) + the Install button + live
  status + the wake-lock truth). Two-surface law: it's the existing
  providers panel card — no new surfaces; theme tokens only.
- **v1.49.3 THE LIVE PROOF** — `scripts/v1490-pocket-bridge-rig.py`:
  (a) SANDBOX MODE (runs here, no device): a fake termuxbridge (a loopback
  HTTP server speaking the 4-route contract) whose /run REALLY executes the
  provisioner's commands in a jail dir + `DOOMALAY_OPENCODE_SPAWNER=termux` +
  the artifact override pointing at the REAL linux 1.19.3 binary → the FULL
  chain runs for real: install → spawn → health → a REAL free-tier turn
  through the engine's own WS protocol with the user's key → the answer +
  usage on the ledger → session reuse on turn two → the recycle law →
  honest-wall copy when the bridge is absent.
  (b) DEVICE MODE (the red-team, the real user's phone via the tunnel):
  /api/termux/status → /api/opencode/bridge/install → a real turn on the
  REAL aarch64 binary → tokens → kill serve via /run → watchdog
  re-provision → second turn → the 1.17.9-vs-gate DECISION GATE result.
  Tunnel down → honest SKIP (the live-gate law).
- **v1.49.0 THE SHIP** — rebase (fetch; parallel-bot branches; merge-tree;
  no conflicts) → the full rig on the MERGED tree → buildinfo 1.49.0 →
  README paragraph → the record chain → cross-compile linux + android →
  tag v1.49.0-the-pocket-bridge → push.

## THE DECISION GATE (after v1.49.3's device probe)

- 1.17.9 serve passes the free tier (big-pickle answers, cost 0) → SHIP as-is.
- 1.17.9 walled (FreeTierError on the genuine binary) → plan-B phase
  (v1.49.4 THE YOUNGER GUEST): opencode2 1.0.3-rc3 + a 2.x API adapter in
  ocserve (the serve-docs API table is already captured; bounded: session
  create + prompt + SSE mapping + health). The card copy + the provisioner
  artifact table move together (the same code paths, new constants).
- The user's device is unreachable (tunnel down) → ship the sandbox-proven
  bridge + the device rig, and say so honestly (the rig runs at the user's
  next tunnel-up; the gate risk is named on the card: "bridge version
  pinned 1.17.9 — if OpenCode's gate refuses it, the card says so").

## THE HONEST LIMITS (on the record)

- The pocket bridge needs Termux installed + bootstrapped (two gates —
  the minimum Android allows; the user's own law: "if we require termux
  … so be it").
- Termux must stay alive while chatting (wake-lock held; phantom-killed
  Termux = honest unavailable + revive-on-open). The bridge is
  opportunistic capacity — every failure answers honestly, never a hang.
- The 52MB download is one-time; the install copy says the size.
- Serve turns run OpenCode's own agent loop under the gate-law config
  (execution + writes denied, read/grep/glob/list in the serve scratch
  dir) — the same honest product shape as the desktop bridge (v1.48.5).
- The free-tier gate "actively evolves"; the pinned native build is 1.17.9
  (the latest stable Android line) — the decision gate + plan-B above.
- Desktop behavior is UNCHANGED (the exec-child spawner keeps the v1.48.5
  law byte-for-byte; Android was ErrUnavailable before, now it's real).
