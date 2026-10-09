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

---

## v1.20.x / v1.21.0 — THE TERMUX LIFE WAVE additions

The v1.20.4 rig + browser E2E proved the whole wave against a fake bridge
that EXECUTES commands for real (the jailed listing, mkdir, the stdin
write, the checkin, the tool turn). What still needs YOUR device (the
v1.21.0 APK — the v1.19.x engine you may still run does not serve the new
endpoints):

1. **Update the APK to v1.21.0**, then open the app and check
   `/api/termux/status` through the tunnel — it now carries
   `checkin_url`, `bootstrap_done`, `probe_suppressed`.
2. **The quiet gate** — if you ever re-run the setup (new Termux install):
   step ③'s "Open settings" stays DISABLED until the paste (step ②) lands.
   The command you copy now carries a `--checkin <url>` tail; the moment
   the script finishes, step ② flips ✓ BY ITSELF (the script pings the
   app over loopback — no command bridge needed, no Termux notifications).
3. **A local device folder as a workspace** — +workspace → connect
   workspace → Self-Host → device storage: the browser lists your real
   folders (device storage root, downloads, documents, termux home).
   Navigate, create a folder, "use this folder" — reads AND writes ride
   Termux (your All-Files-Access grant, not an app permission).
4. **The bot's termux tool** — stack ⌨ Termux on a chat with a bound
   folder and ask it to `ls` / run something / start a python session:
   the tool is jailed to the bound folder, output is full, execs pace at
   one per 4 seconds, and `session_start {"name","command"}` +
   `session_list` + `session_log` + `session_kill` manage background
   processes (e.g. a `python -m http.server`) with tailable logs.
5. **The chat metadata** — with Termux stacked and live there is NO ⌨
   pill in the pill row anymore (the capability lives in the 🧩 library
   row); the pill row reads 🧩 capabilities · 👾 model · ▣ + workspace.
