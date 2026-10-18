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

## v1.34.0 — THE OWNERSHIP WAVE (the 5-walk device checklist)

1. **The returning model**: open a mature chat (one with replies), close
   the panel (swipe down), reopen it — the header's model pill is STILL
   THERE (model name · provider). Tap it: the model browser opens —
   pick a different model: the chat switches (the running turn stops
   first, nothing is lost). The old build lost the pill forever on
   every reopen.
2. **The honest tails**: ask the bot to read a file (`read
   /storage/emulated/0/notes.txt` style) — the collapsed pill reads
   "read notes.txt" (the verb + the FILE's name, not the generic
   file_read or a blank). Ask it to load a skill: "skills load
   superpowers". Template/persona asks speak "template X"/"persona X".
   The full path still shows when the pill is expanded.
3. **The settled setup**: the caps screen → Termux row → setup → when
   it completes, the card reads "optional — device commands … need the
   Termux:API companion app — a separate app from F-Droid — plus `pkg
   install termux-api`. Termux itself is fully ready without it" (NOT
   an error). Tap Done: you land back on the caps page and the Termux
   row is right there, switched ON (the setup stacks it for the chat —
   no more hunting for a vanished row).
4. **The unasked return**: during an auth flow (GitHub workspace
   connect / HF), the provider's redirect back to the engine NEVER
   asks "redirect to 192.x?" anymore (the app's own origins are
   exempt). When the connect lands, the panel browser closes itself
   (~1s after the ✓) and the panel updates — no manual close.
5. **The isolated minds**: start a privatemodeai chat doing autonomous
   work, then create/open a SECOND privatemodeai chat while the first
   runs — the fresh chat stays clean (its greeting, zero foreign
   reasoning boxes or tool pills). Reopen the first: everything it did
   while backgrounded is there. Many PM chats in parallel, each on its
   own workspace, no interference.

## v1.37.0 — THE COMPASS WAVE (the 5-minute checklist)

The user's five asks, one walk each. Everything below is on the LIVE app
(real taps/holds, no test harness — the 48-check automated twin is
`scripts/v1370-compass-walk.mjs`).

1. **The closer view (zoom)**: pinch/zoom IN — the world stops growing at
   the new cap (noticeably less max zoom-in than before, ~30% less). Zoom
   OUT far — you can pull back until the whole canvas fits a thimble
   (4× deeper than the old floor). Pinch out as far as you can, then tap
   an icon that looks tiny: it still responds (the 28px finger-friendly
   hit floor). Restart the app: your zoom position survives.
2. **The held thing (icon menu)**: PRESS AND HOLD an existing chat icon
   (~half a second) — the same round menu that New Bot uses appears, but
   with two rows: **📌 pin** (first) and **🗑 delete** (last). Hold empty
   canvas instead: New Bot / New Tab, unchanged. Release: nothing
   auto-opens (the outside-tap dismisses law). Pin the chat: a small pin
   badge rides the icon's top-left; restart the app — the pin survives.
3. **The forever question (delete)**: hold an icon → 🗑 delete → the
   rounded Overlay screen asks "Delete <name> forever?" with "(a very
   long time)" under it. **[keep it]** closes safely. **[delete
   forever]** — the icon leaves the canvas, the chat's history is GONE
   from the device (the engine session + every event), a panel that was
   hosting it closes first. This cannot be undone.
4. **Pinned first**: open the all-chats panel — a 📌 Pinned section sits
   ABOVE Today holding your pinned chats (each row wears the pin tag);
   unpinned chats keep their date buckets exactly.
5. **The true compass (indicators)**: pin a chat, then pan far away —
   an indicator rides the screen edge pointing at it. Unpinned chats get
   NO indicator (pinning earns it). The indicator's color is the chat's
   own (family color / gradient; unset ones wear a deterministic
   rainbow color). Tap the indicator: the canvas GLIDES itself to the
   chat until it's centered (~half a second, smooth) — touch the canvas
   mid-glide and it stops instantly (your finger is the boss); tapping
   the settings gear or other UI during the glide does NOT stop it.
6. **The honest blocks (toggle + editor)**: a chat → Persona (face) →
   Placeholders: a **live blocks: ON | excluded** toggle rides the top —
   flip it and the five live blocks leave every preamble AND persona
   (the facts like {model} still expand). Every block/custom row has a
   **✎** — it opens the full-text editor (CodeMirror): the whole text,
   scrollable, editable. Save = your text rides every turn (override
   chip lights). **↺ reset to default** = the live truth returns.
7. **The living lexicon (portable placeholders)**: set a custom like
   `{tip} = "running {model} today"` — the inner {model} now expands
   live. Publish a persona/preamble that uses your customs — the
   downloaded file carries the definitions; a friend (or your other
   chat) importing it gets the customs installed automatically.

## v1.38.0 — THE SWIFT CANVAS (the 5-minute canvas checklist)

The engine + the web assets changed (atoms.js + pixiworld.js — min_engine
walls the delta, so this needs ONE fresh APK install; pure web-asset rides
would have been OTA but the engine build rides with it).

1. **The atoms still live**: open a chat with a few connected workspaces —
   the electron-shell stars orbit exactly as before (same speed, same
   back-and-above occlusion: stars dim and slide BEHIND the icon disc,
   front stars pass OVER it). Pinch-zoom deep out (0.125×) and in (2.1×) —
   the stars scale + cull exactly as before. **This is the parity
   guarantee: the geometry is byte-identical to the old paint.**
2. **The canvas feels lighter**: pan around with 5-10 atom-bearing chats on
   screen — the stutter the Lippy diagnosis named ("the canvas, even after
   all our efforts, needs work") should read calmer: the atom pass is now
   allocation-free (no per-star GC churn), the fill strings build 6× per
   frame instead of 960, and on your GPU the stars blit as baked sprites.
   Open Settings → Performance → the painter row still reads its mode; the
   world row reads `pixi (webgl) · aa · res` when ≥ 60 icons.
3. **The world layer's shells FINALLY DRAW (the latent bug)**: with ≥ 60
   icons (or world layer forced on), the atom shells around each chat now
   draw as true tilted ellipses — since v0.85.4 they were an invisible
   ~1px blob on this layer (a missing ×R in the Graphics path). Compare a
   chat with atoms on the DOM path (few icons) vs the pixi path (many
   icons): the shells match now.
4. **The tempo parity**: watch a chat's stars on the DOM path, then add
   icons past 60 so the world layer takes over — the stars orbit at the
   SAME speed now (the pixi side used to run 2× fast — the v0.97 slow-down
   never rode its clock).
5. **The DUAL STAR verdict**: Settings → Appearance → About (or the
   browser devtools console on the PWA): `localStorage
   ['doomalay.stardraw.v1']` reads `sprite` on hardware-canvas devices
   (your phone) — the app measured its own GPU once and picked the faster
   primitive. Nothing to do; it's the honesty receipt.

## THE UNBROKEN STREAM checklist (v1.40.0) — 5 minutes

The engine changed (the wake lock poll, the net wake bridge route, the
turn-gated gauge) — `min_engine` walls the OTA, so **install the v1.40.0
APK once** (the CI build), then:

1. **The background proof (the big one)**: start any bot on a real task
   (something that takes a few minutes), then LEAVE the app — home screen,
   screen OFF, phone in your pocket. Come back 2–3 minutes later and open
   the panel: the log should show all the work done in your absence (the
   replay is the truth). While you were away, the system notification
   should have read "1 bot working" — that's the wake lock's honesty
   receipt. If your OEM's battery manager is aggressive (Samsung/Xiaomi
   "put app to sleep"), unrestrict the app manually once: the one-time
   system dialog covers stock Android's deep-Doze, but OEM sleep lists are
   outside any API.
2. **The battery-exemption ask**: after backgrounding with a live turn
   once, the app asks (one time, on your next return) to ignore battery
   optimizations — allow it. That's what keeps the network (and the wake
   lock) alive in deep Doze.
3. **The outage proof (level 2)**: start a bot turn, then kill your
   internet (wifi + data off) mid-turn. The bot does NOT die: the panel
   keeps Stop armed, and a notice lands in the log ("connection to X
   lost — the turn holds and keeps retrying"). Turn the internet back on
   — the turn continues BY ITSELF, and the log now shows the whole story:
   the pause notice, "network regained after Ns — continuing", and the
   answer. No manual continue, ever, for a network outage.
4. **The mid-reply cut (the seam)**: if the connection dies while the bot
   is mid-sentence, the reply doesn't restart from scratch — you'll see
   the partial, a one-line "the connection cut mid-reply — holding" notice,
   and the answer continuing from where it stopped when the network
   returns.
5. **The honest return**: with a turn running, background the app for
   ~30s and come back — the panel catches up within ~a second of opening
   (the resync: no "connection lost" flash, the work just appears).
6. **The PM caveat (honest limit)**: PrivateModeAI bots run their agent
   loop in the app's web layer, not the engine — they slow down (not die)
   while backgrounded. Every engine-owned provider (OpenRouter, Nvidia,
   Mistral, OpenCode, HF, Groq) keeps full speed in the background.

**What changed under the hood, one line each**: the engine now holds a
partial wake lock while turns run (and only then — an idle engine never
burns battery); a WebView crash no longer kills the engine; a network
outage suspends a turn instead of ending it (jittered retries, woken in
~1s by Android's own connectivity signal); a mid-reply cut continues from
where it stopped; and the panel resyncs the moment you return.
