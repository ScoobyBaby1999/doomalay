# PLAN-V125 — THE PARITY WAVE

Five user fronts, one law: every surface that already works right becomes the
pattern every other surface follows. The Termux capability row learns the
on/off pill the other rows speak, the workspace drawer button stops passing a
workspace id where a session id belongs (local folders render in the drawer
with the same tree + editor + SAVE the manual path has), self-host workspace
names stop being the static "my folder" and become the real folder's name,
the quick-chat ⚡ sandbox badge becomes the FACE of whatever bundle the bot is
actually using from the library (hidden when nothing is), and the ONE pill
grows a one-word verb title (bash / ls / file_write) instead of a text run
that blends the program into the query. Five build phases → v1.25.0.

---

## §0 RESEARCH RECEIPTS (web search, this sandbox)

1. **MD3 switches + badges** — Material Design 3: a settings row's
   description carries WHAT the setting is; the trailing control (switch /
   chip) carries the BINARY STATE, and it is the only element that changes.
   A row whose description text mutates per state is an anti-pattern (the
   affordance moves under the user's finger). → R1 exactly: keep the Termux
   sub static, make the chip the on/off state carrier like every other row.
2. **Avatar status badges** (MD3 badge + avatar UX patterns) — small circular
   overlays on avatars/icons carry DYNAMIC status; the convention is to show
   the badge only when there is something to say (unread count / online
   state), never a permanent meaningless glyph. → R4 exactly: the ⚡ badge
   (which today says nothing — every chat is 'quick') becomes the bundle-in-
   use indicator and hides when idle.
3. **AI tool-call UI patterns** (Claude/ChatGPT/agent UI surveys) — collapsed
   tool chips work best when the chip NAME is the verb ("Searching", "Running
   code") and the parameter text is secondary. A chip whose leading word is
   the program/verb + a dim query tail is the industry shape. → R5: a
   distinct one-word title chip + the query as the dim body.
4. **Tree view UX** (Fluent 2 / WinUI tree guidance) — indentation per depth
   + chevron expand/collapse + lazy load is the standard file-tree shape.
   Already implemented in the drawer (loadTermuxLevel / loadDeviceLevel);
   R2 is pure plumbing (the id bug), zero tree redesign needed.

---

## §1 v1.24.1 THE TERMUX PILL PARITY (R1)

**capabilities.js:**
- `rowsFor` — the Termux row: sub goes STATIC
  (`'local Linux sandbox (commands, package installs, local storage)'`
  — same text every state), the dynamic state moves to the chip.
- `chipFor` — grows the `kind === 'termux'` branch: not ready →
  `{cls:'setup', text:'set up…'}` (unchanged); ready → `row.on ? on : off`
  — the exact pill every toggle row speaks.
- `onTermuxTap` / `repaintTermuxRow` / `probeTermux` — unchanged (they
  already re-derive through rowsFor → chipFor).
- CSS: `.cap-chip.on/.off/.setup` untouched.

**Re-pins:** v1171 lines ~150–163 (the termux row sub/chip pins → the new
static-sub + on/off chip), v1212 lines ~27–40 (sub texts), v1173 lines
~207–220 (the unready setup chip + the setup-overlay wiring — stays valid;
re-verified). New rig `scripts/v1241-cap-parity-rig.cjs` pins the matrix:
ready+on → 'on', ready+off → 'off', unready → 'set up…', sub never changes
with stack state.

## §2 v1.24.2 THE DRAWER PARITY (R2)

**ROOT CAUSE (verified):** `workspace.js` `wireRowActions` drawer click
passes `ws.id` (a WORKSPACE id) where `Artifacts.openDrawer` expects a
SESSION id → `GET /api/sessions/<ws.id>/artifacts` → 404 "session not
found" → the catch replaces the body → renderCloudSection /
renderDeviceSection never run → no tree, no editor, no save. The bug is as
old as v0.46 (device rows); termux rows inherited it in v1.20.2. The manual
path passes `state.sessionId` and works — the tree, expand/collapse,
indentation, file payload panel, edit + SAVE-to-disk are ALL already
implemented (loadTermuxLevel → openTermuxFile → PUT /api/workspaces/{id}/
file → the stdin-law write).

**Fix (workspace.js + artifacts.js):**
- The drawer click: no session → honest toast `connect a model first` (both
  cloud + device branches — the cloud branch's dead `openDrawer(null)` dies
  too). With a session → `openDrawer(sidNow(), {name:…}, adhoc)` where
  adhoc = the clicked ws row (device/termux kinds; cloud rows keep today's
  sidNow() behavior).
- `Artifacts.openDrawer(sessionId, chat, adhoc)` — forwards adhoc to
  `renderDeviceSection(listEl, sessionId, adhoc)`.
- `renderDeviceSection(listEl, sessionId, adhoc)` — after the session-list
  fetch, if adhoc is a device/termux row whose id is NOT already in the
  bound rows, unshift it: the clicked workspace ALWAYS renders (bound or
  not). Rendering is the SAME code path (the termux tree row + lazy
  loadTermuxLevel).
- The "session not found" body only appears for a genuinely unknown session
  now.

**Rig `scripts/v1242-drawer-parity-rig.cjs`:** source contracts (the click
handler passes `sidNow()`, never `ws.id`; the no-session toast; the adhoc
forwarding chain openDrawer → renderDeviceSection) + behavior: the drawer
renders the adhoc termux row (fake /api fetch → the termux tree row with
its jailed root, expand → loadTermuxLevel called, dedupe when already
bound).

## §3 v1.24.3 THE HONEST NAMES (R3)

**ROOT CAUSE (verified):** the literal "My Folder" does not exist — the
self-host/device picker's name fallback is the static string `'my folder'`
(and desktop `'my files'`), and `currentPicker.chat` is always null today
so the fallback ALWAYS fires on an empty name box.

**Fix:**
- `workspace.js` termux browser — `termuxFolderName(path)`: the last
  non-empty path segment (trailing slashes trimmed; empty → ''). The name
  input's PLACEHOLDER updates on every listing navigation (the current
  folder's basename — the suggested name, still user-editable); the submit
  fallback (use-this-folder + mkdir) becomes `|| termuxFolderName(resolved)
  || 'my folder'` (the static string survives only as the last resort for a
  root path).
- Desktop twin — the File-Access-API picker: name fallback
  `|| dirHandle.name || 'my files'`; placeholder hints the handle's name.
- Engine belt-and-braces (`workspaces.go` `handleWorkspaceDevice`): an
  empty name with a termux_path derives the basename server-side (the
  desktop form keeps requiring a name — the client always sends
  dirHandle.name). Go test pins it.

**Rig `scripts/v1243-name-rig.cjs`:** `termuxFolderName` matrix (plain
path, trailing slash, root '/', deep path, empty) + source contracts (both
submit sites + the placeholder update + the engine fallback).

## §4 v1.24.4 THE BUNDLE FACE (R4)

**The badge becomes the face of what the bot uses:**
- `chatbot.js` — `ChatIcon.prototype.setBundleBadge(bundle)`:
  `bundle = {icon, repo, name, kind} | null`. Render law: bundleBadge set →
  the badge shows the bundle's icon (`IconLib.card(icon, repo, 13)` — the
  SAME resolver the library card uses; kind glyph fallback when no icon);
  else a legacy non-quick sandbox keeps its glyph (🤗/🔗/⌨️); else (quick,
  nothing in use) the badge is REMOVED — the ⚡ dies. `SANDBOX_BADGES`
  stays for the legacy branch. `icon.bundleBadge` lands on the instance
  (the canvas reads it).
- `pixiworld.js` — the canvas badge: `icon.bundleBadge` set → file: icon →
  a module-level Image cache keyed by URL (async load; the rAF loop paints
  it the frame after it lands); lucide/unknown → the kind glyph text.
  No badge when null and sandbox is quick.
- **Data:** hub.js's bunch-use handler adds `icon: bcur.icon, repo:
  bcur.repo` to the bundle it hands `applyBundle`; `state.bundle` (+
  `saveBundle`) carries them; `armTurnBundle`'s bundle derivation keeps the
  icon fields on `_turnBundle`.
- **Update seams:** `paintSegBundle` (THE one live seam — arm/hint/apply/X
  all flow through it) grows the badge twin: `state._icon &&
  state._icon.setBundleBadge(...)` with the icon resolution (a turn bundle
  of kind 'bundle' matching state.bundle → its icon/repo; a member kind →
  glyph only). Chat open: after `loadBundle` + the replay's last
  bundleHint, the badge reflects the stored state (an explicit init call
  in the open path, not just live events).
- **The redundant chip dies:** `syncTemplateChip` renders ONLY for
  templates now — the bundle case removes any existing chip (the seg pill
  + the badge carry it; the full-width duplicate row above the lib pill is
  gone).
- **The seg X:** `#seg-lib-bundle` becomes label span + ✕ span (the pill
  stays a button → openLib; the ✕ swallows the click): pressing it drops
  the turn's active bundle — an attached whole bundle DETACHES
  (`state.bundle = null; saveBundle; persistCaps` — the tpl-chip X law),
  then `_turnBundle = null`, seg hides, badge hides. A member-in-use (no
  attached bundle) just clears the turn display.

**Rig `scripts/v1244-bundle-face-rig.cjs`:** the badge render matrix (DOM:
icon img / svg / glyph fallback / hidden for quick+idle / legacy sandbox
kept), the canvas source contract (reads bundleBadge, the image cache),
the chip law (bundle → no #tpl-chip, template → chip), the seg X contract
(label+X spans, the X detach path mirrors the old chip-X), the hub use
handoff carries icon+repo.

## §5 v1.24.5 THE PILL TITLE (R5)

- `chatpanel.js` `toolPillLabelParts` grows `title` + `body`:
  · termux `exec` → title = the program token (bash / ls / python…), body
    = the command's remainder (the old tail);
  · `pkg` → title 'pkg', body 'install <name>';
  · `write`/`append` → title 'file_write', body = the path (summary);
  · `read` → 'file_read', `ls`→'ls', `rm`→'rm', `mkdir`→'mkdir',
    `grep`→'grep', `find`→'find', `cmds`→'cmds', `help`→'help',
    `session_*`→'session';
  · other tools → title = the tool name (web_search, hublib…), body =
    the summary;
  · legacy standalone result → title = name, body = text.
  `label`/`tail` keep their shapes (the activity line + the rigs ride
  them).
- The head: `<span class="tool-pill-name">title</span>` between the ico and
  the text span — a small chip (0.62× fs, 600 weight, surface-2 bg, hair
  border, radius, flex-shrink 0, theme vars only). The text span renders
  `body` (dim) + the live tail (pending). Expanded/overlay unchanged
  except the overlay's `.tv-name` shows the title (the raw 'termux' name
  moves to aria/title where it already lives via tvSubFor).
- **Rig `scripts/v1245-pill-title-rig.cjs`:** the title/body matrix (every
  verb, exec program, garbage honesty) + the head source contract (the
  name span + CSS) + re-pins of the v1232 label matrix (label/tail shapes
  unchanged).

## §6 v1.25.0 THE SHIP

buildinfo 1.25.0 + the wave record; the E2E walk (the v1234 pattern, one
long-lived script: real engine + the executing fake bridge + the stub
model): the cap row tap cycle, the workspace→drawer walk (termux tree →
expand → file → edit → SAVE → the file changed on disk), the folder-name
derivation, the bundle attach → badge face → X detach, the pill titles;
the full battery re-run; push main + tag → CI → the device checklist in
docs/TERMUX-DEVICE-TEST.md.

**Phase split:** §1–§5 are PWA-only except §3's engine fallback (4 lines +
test) — the OTA carries them; the APK ride is only that belt-and-braces
name fallback.
