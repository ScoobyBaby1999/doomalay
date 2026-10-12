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

---

## v1.21.1 — THE ARMED HAND additions (the PM-chat fix)

**The bug you hit:** a PrivateMode chat (privatemodeai/…) with ⌨ stacked
and device folders bound answered *"the termux tool is not armed for
this chat"* on every call. Three stacked causes, all fixed in v1.21.1:

1. **The PM arm** — PrivateMode chats run their turns in the WebView
   (the engine can't speak PM's E2E protocol), and their tool calls go
   through the engine's `/mcp` endpoint. That session Turn was missing
   the Termux closure entirely — PM bots could NEVER use the termux tool
   no matter what you stacked. Fixed: the closure now wires (the
   v1211 rig proves every verb through the exact PM call path).
2. **The bind is the consent** — your session row said
   `Termux:false` even though you stacked the row (the PATCH died
   silently once). Now binding a device folder AUTO-STACKS the
   capability — the ⌨ row and the bot can never disagree again.
3. **The silent PATCH death** — a failed capability-flip save (4xx) used
   to die invisibly while the UI kept showing "stacked". It now toasts
   the failure honestly.

**Device checklist (needs the v1.21.1 APK — the OTA only updates the
web side, the engine rides the APK):**

1. Install the v1.21.1 APK (from the release the CI just built).
2. Open your existing PM chat (the one with the two device folders) —
   the ⌨ row should now read stacked (your session was also healed
   remotely through the tunnel: `termux:true` PATCHed).
3. Ask the bot: *"run `ls` on my device"* or *"what commands do you
   have?"* — it should call the termux tool and show real output. The
   new `cmds` action inventories EVERY available command; `pkg install`
   (e.g. python, node, ffmpeg) makes that package's commands live
   instantly; `session_start` runs background processes (python servers)
   you can list/log/kill.
4. In a NON-PM chat (any other provider), the same works through the
   engine's direct path.

## v1.24.0 — THE PILL WAVE additions (the full UX polish)

The wave's five fronts are all PWA-side except where noted: the F-Droid
link goes dynamic (the setup page's Get Termux always opens the current
STABLE — engine-side resolution against the F-Droid API, rides the APK),
the exec cooldown is gone (12/min cap stays), the tool pills merge (one
pill per action with the real program name), long output streams live
into the pill (~2/s), and the full-view overlay is ONE polished box.

**Device checklist:**

1. Install the v1.24.0 APK (the engine-side pieces — the F-Droid
   resolver, the pacing, the stream route + wrapper — ride the APK; the
   overlay/PWA pieces also land OTA for older APKs).
2. **The setup link**: Settings → the ⌨ Termux setup page → tap
   *Get Termux* — F-Droid should open at the CURRENT stable Termux
   page (not a pinned old version). If F-Droid is unreachable, the
   static 0.118.3 link answers (honest fallback).
3. **The ONE pill + the live stream**: ask the bot to install something
   slow (e.g. *“install python then show me the version”* or any
   `pkg install …`). While it runs:
   - ONE pill per action (not call + result separately), labeled with
     the actual program (`pkg install python`, `bash`, `python`) —
     never the vague `exec`.
   - The pill's collapsed tail shows the LIVE last line of output
     (~twice a second).
   - Tap the pill's **↗** — the full-view overlay opens: the head
     (tool + the derived label), ONE rounded box (query · divider ·
     output), and the output area FILLS LIVE while the command runs
     (the byte counter under it counts up). Watch the install land in
     real time.
4. **The overlay polish**: the ⧉ copy affordance is a footer button
     (bottom-right, icon + small "copy" label — no longer under the ✕);
     the query and output ride ONE box with a divider; 20px of edge
     room all around. Copy works mid-stream (copies what's shown).
5. **The landing**: when the command finishes, the OPEN overlay
     re-renders in place with the complete result (paged if huge, with
     the page buttons + byte count). Long results scroll.
6. **Replay**: close the overlay, leave the chat, come back (or reload)
   — the transcript is still ONE pill with the same label; the ↗ opens
   the overlay with the full result.
7. **Rapid execs**: two commands back to back — no 4s wait anymore
   (both run immediately; the 13th in a minute still gets the honest
   pace refusal).

## v1.25.0 — THE PARITY WAVE additions (every surface that already
worked right becomes the pattern)

1. **The Termux capability row speaks the on/off pill**: Settings → the
   capability library (the 🧩 box on a new chat, or the caps pill) —
   once Termux is READY, the Termux row's chip reads **on** (stacked)
   or **off** — the exact pill every toggle row speaks — while the
   description line stays STATIC ("local Linux sandbox (commands,
   package installs, local storage)" in both states). Tap the row: the
   chip flips on → off → on; the description never moves.
2. **The drawer from the workspace picker**: Workspaces → tap a local
   (termux) workspace row → **📂 open in drawer** — the artifacts
   drawer opens with the DEVICE STORAGE tree (NO "session not found").
   Expand the folder, tap a file: the editor opens. Edit + **save to
   device** — then check the file in your file manager: the content
   actually changed (save writes the real file, it is not a download).
3. **The honest folder names**: add a self-host workspace from a picked
   folder WITHOUT typing a name — the workspace lists under the
   folder's REAL name (the basename), never "my folder".
4. **The bundle face**: open the library (🛠 lib + the +), pick a
   bundle, press **▶ use** — back in the chat:
   - The chat icon on the canvas grows a small corner badge showing the
     BUNDLE's own icon (the same one the library card shows). Nothing
     in use → no badge at all (the old always-on ⚡ is gone).
   - The pill right of the lib shows the bundle name + an **✕**; the
     old full-width "▣ bundle" row above the toolbar is gone.
   - Press the **✕** — the bundle detaches (badge disappears, the
     manifest is dropped). Re-attach and reload the page: the badge
     re-appears on its own at chat open.
5. **The one-word pill titles**: run a few different tool actions —
   `ls`, a file write, a `grep`, `pkg install …`, a background session.
   Every pill now leads with a one-word VERB chip (`ls`, `file_write`,
   `grep`, `pkg`, `session`…) followed by the dim query — never the
   generic `exec`. The ↗ full-view overlay's title says the same verb.

## v1.27.0 — THE HONEST PROGRAM additions (the exec titles + the unbound
burst)

> The engine changed this wave, so `min_engine` walls the delta — the
> OTA banner says "engine update required" and **one v1.27.0 APK install
> carries everything** (the title fix, the unbound default, and the ✦
> Termux section together).

1. **The exec pills speak the program** (the blank-title fix — PM/quick
   chats): ask the bot to run a few one-shot execs — `cal 10 2026`,
   `python3 -c …`, `du -sh .`, `sed …`, `curl …`. Every exec pill now
   leads with the PROGRAM chip (`cal`, `python3`, `du`, `sed`, `curl`)
   + the dim command remainder — the pills were blank before this
   release (the args ride as a JSON string on the PM path and the
   derivation only accepted objects). The ↗ overlay's title says the
   same program. Reload the chat: the pills keep their chips (the
   derivation is render-time, replay included).
2. **The burst runs unbound by default**: ask for "a mixed batch of 15
   random exec commands, all independent" — ALL of them run (the old
   12-per-minute law is gone; nothing refuses at #13).
3. **The optional cap is a per-chat tweak**: open the chat's ✦ tweaks
   panel → the **Termux** section → "Exec burst cap":
   - OFF (the default) = unbound — the state value reads "unbound".
   - Flip the switch ON → the slider picks the cap (5..120, arming at
     12); the value label reads "N / minute". Fire more than N execs
     in a minute: the (N+1)th refuses with the honest ask ("this
     chat's burst cap is N one-shot execs per minute (armed in ✦
     tweaks → Termux)") — the model tells you, never a silent drop.
   - Flip the switch OFF → the cap lifts immediately (the very next
     exec runs). "↺ reset everything" also clears it.
   - Note: the cap counts from the moment you arm it (unbound execs
     never fill the window).

## v1.29.0 — THE MAXIMAL HAND additions (the long budget + the taught
physics + the device-commands light)

> The engine AND the Kotlin bridge changed this wave, so `min_engine`
> walls the delta — **one v1.29.0 APK install carries everything**.

1. **The 60-second timeout is dead** (the Doobie audit's report): ask
   the bot to run something that takes 70–90 seconds without passing a
   timeout — e.g. `exec 'sleep 75; echo done'` or a slow download
   (`curl -o big …`). It now COMPLETES (the old build killed it at
   60s with "TIMEOUT — Termux killed the command"). The default exec
   budget is 10 minutes; the model can pass `timeout_ms` up to
   30 minutes; anything longer should run as a background session
   (session_start — no budget).
2. **The honest timeout text**: force one with a tiny budget — ask for
   `exec 'sleep 10'` with `timeout_ms: 2000`. The observation now says
   "TIMEOUT — the 2s exec budget ended; the command may still be
   running in Termux (pass timeout_ms up to 1800000, or session_start
   it for unbounded)" + the partial output — the old text claimed
   "Termux killed the command" (neither half was true).
3. **The noexec law is taught (the discovery burn dies)**: ask the bot
   to compile something (gcc or go) in the bound folder and run the
   binary. The old build burned 4+ calls discovering the
   Permission-denied physics; now the help/manifest/preamble teach it
   up front — the bot goes straight to
   `cp mybin $HOME/ && chmod 755 $HOME/mybin && $HOME/mybin` (shared
   storage is FUSE noexec; $HOME is exec-capable).
4. **The honest budgets in the help**: ask the bot to call the termux
   `help` action — the exec line now reads "10 min default, 30 min max
   via timeout_ms; longer jobs → session_start" and the pacing line
   reads "UNBOUND by default; the user can arm an optional per-minute
   burst cap in ✦ tweaks" (the old help claimed a 12/min cap that
   hasn't been armed by default since v1.26.2).
5. **The device-commands light**: open the Termux setup screen (or
   re-run it from the capabilities row when unready) — once READY, the
   card carries one more line:
   - Termux:API companion app installed → "device commands live —
     battery · wifi · location · camera · notification · clipboard
     (termux-api)".
   - Not installed (most devices) → "device commands locked — install
     the Termux:API app (F-Droid) + pkg install termux-api to unlock
     …" — the exact two-step unlock, taught where you land.

---

## v1.30.0 THE CONTINUOUS MIND — the 6-walk device checklist

The wave's law: the chat never re-renders, the turn never interrupts,
the bot remembers what its hands read, and the GitHub hand is real.

1. **The stashed chat (the snappy re-render dies)**: open a chat, send a
   message that runs a termux exec, and CLOSE the panel mid-turn (drag
   down past the close threshold). Re-open the same chat — the
   conversation appears INSTANTLY (no re-render flash, the scroll returns
   where you left it), the in-flight turn keeps streaming into the same
   tree, and NO "Connection dropped — Tap Retry" bubble ever appears.
2. **The turn finishes while closed**: start a long exec turn, close the
   panel, wait, re-open — the turn's answer is there and complete (the
   engine kept running it; the reopen resolved the truth, never a false
   interrupt).
3. **The honest query**: tap any termux pill's ↗ — the query box shows
   the REAL command (pretty JSON with the action + the parsed args),
   never `[object Object]`. Same after a reload (the replayed pill).
4. **The tool memory**: ask the bot to `cat` a file via termux, then in
   a NEW message ask "what did the file say — without running anything?"
   — the bot answers from memory (no new exec pill). The old build
   re-read the file (the amnesia).
5. **The proceed**: give the bot a task that tempts an announcement
   ("I will now check the timers…") — the turn CONTINUES to execution
   (you'll see "the plan is announced — proceeding to execution…") up to
   twice, instead of ending the turn and waiting for you to push.
6. **The GitHub hand**: connect a GitHub token once (the workspace
   connect flow), then ask the bot to `git_setup` — one call arms
   ~/.git-credentials (0600 + credential.helper=store + the identity) in
   Termux; every later `git clone/push` just works with NO token in any
   command. Ask for tags: the workspace tool's `view tags` lists them
   and `tag_create {tag, sha, message}` cuts one.
7. **The persisted skill**: with the lib pill on, ask the bot to load a
   skill — from then on every turn in that chat follows it (the
   methodology rides the history; it no longer evaporates at the turn
   boundary).
