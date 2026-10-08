# Termux device test — the real-Android checklist

The sandbox redteam (v1.17.5) proved every contract on OUR side of the
wire — the fake bridge speaks the Kotlin `TermuxBridgeServer` HTTP
contract byte-for-byte, the engine aggregates it honestly, the PWA walks
the whole ladder. What it cannot prove is the OTHER side: `com.termux`
receiving our RUN_COMMAND intent on a real device. This is the checklist
for that. Time budget: ~5 minutes.

## Setup

1. **Install the doomalay APK** (the release build) on your device.
2. **Install Termux** — the setup screen's "Get Termux" button opens
   https://f-droid.org/repo/com.termux_1002.apk (Termux 0.118.3,
   versionCode 1002). The GitHub mirror works too:
   https://github.com/termux/termux-app/releases (pick the
   `github-debug_universal` APK). Install it, and **open it once**
   (the bootstrap must finish — you should land on a `$` prompt).
3. **Run the bootstrap one-liner** — in the setup screen tap "Copy",
   then "Open Termux", then long-press → paste → enter:
   ```
   curl -fsSL https://raw.githubusercontent.com/ScoobyBaby1999/doomalay/main/termux/setup.sh | bash
   ```
   Watch it: it enables `allow-external-apps`, reloads settings, runs
   `termux-setup-storage` (a dialog appears — tap **Allow all files
   access**), installs coreutils, and creates the default workspace
   folder `~/storage/shared/Doomalay`.
4. **Grant the run permission** — the setup screen's third step opens
   Settings → Apps → Doomalay → Permissions → Additional permissions →
   **"Run commands in Termux environment"** → Allow.
5. Back in the doomalay app: the setup screen's fourth step should flip
   to **READY** within a few seconds (it polls). If it doesn't, see
   "Reporting failures" below.

## After READY

- Stack ⌨ Termux from the capability library on a chat — the pill
  appears in the chat's metadata row (accent-colored).
- Reload the app — the pill persists.
- The capability is intentionally **inert this wave** — no tools, no
  workspace, nothing runs yet (the MCP tool layer + workspace picker is
  the next wave). Stacking it proves the whole pipe; executing comes
  next.

## The three-tap honesty note

The setup needs exactly three taps from you (install, one pasted
command, one permission grant). That's not our limitation — it's
Termux's security model working as designed: no app can silently run
commands in your Termux.

## Reporting failures

If a step won't advance, screenshot the setup screen (each step shows
its state) and include:

- the **last_error line** (the setup screen prints it under the failing
  step — e.g. `probe timeout` / `403 token` / `refused`),
- the engine log: Android → Settings → Apps → Doomalay → the log file
  (or `adb logcat | grep -i doomalay`),

Common causes:

| Symptom | Cause | Fix |
|---|---|---|
| bridge_ok stays false, last_error mentions force-stopped | Android killed Termux | open Termux once, back to doomalay, the poll recovers |
| Permission step never completes | the settings screen wasn't reached | the step's button deep-links; otherwise grant manually (Additional permissions) |
| storage_ok false | the all-files dialog was dismissed | run `termux-setup-storage` again inside Termux |
| `403 token` | the engine restarted with a stale bridge token | restart the doomalay app fully (swipe away + reopen) |
