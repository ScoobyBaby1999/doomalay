# PLAN v0.52 — connect fixes + the chat/library UX wave

User items 1–7 (2026-09-24). Research done; root causes found. Build phases:

## A. OAuth fixes (items 1+2)

ROOT CAUSES (verified in code):
- `hfExchangeCode` (hfspace.go:879) uses a bare `http.Client` — no
  `netx.Transport()`. The engine's pure-Go resolver on the device reads a
  broken `/etc/resolv.conf` (`nameserver ::1` → refused) → the token
  exchange dies with `dial tcp: lookup huggingface.co on [::1]:53`.
  Same bug: `ghTokenExchange` (workspaces.go:1536), `forgeLoginFor`
  (workspaces.go:1351), the logs proxy (hfspace.go:723). netx already has
  the DoH fallback — these four clients just don't use it.
- "GitHub sign-in isn't configured" is CORRECT behavior: the old pair was
  purged (compromised) and the vault has no secret yet.

THE SECURE SECRET ANSWER (item 1): the yellow one-time OAuth setup box IS
the confidential path — the secret POSTs to
`/api/workspaces/oauth/github/config` and lands in the engine's ENCRYPTED
VAULT on the device (never in the shipped binary, never in chat). It is a
PRODUCTION mechanism (every fresh install needs it once), not dev-only;
it only renders while `has_secret` is false and hides itself after saving.
Client id ships built-in (public value, fine to bake).

FIXES:
1. Route all four clients through `netx.Transport()`.
2. Make the token-exchange error self-explanatory when DNS fails.
3. ghconnect.js: clearer box copy (stays-on-device wording, client id
   shown, hidden after save — already), GH start error points to the box.
4. Tests: httptest-based round-trip for both exchanges (override base URL
   via package vars), + netx DoH fallback regression.

## B. Sandbox picker (item 3)
- Remove the `hf-docker` PRO card + dockerFlow/renderDocker (the quota
  renderer stays for the watchBuild path, copy updated).
- "Community workspace" → "Community Docker Sandbox" everywhere.
- Remove the `← back` button from the HF chooser header.
- Richer descriptions: colored bold spans / chips (ok-green for included
  toolchain, warn for limits) + the SHARED warning on the community card
  and its detail panel: shared with the community — never feed secrets,
  keys, or private data.

## C. Merge search + all chats (item 4)
- chatsview.js becomes the ONE surface: search row (Aa/Exact chips, live
  /api/search results grouped by chat) above the date-bucketed index;
  empty query → the index, typing → results; hits keep jump-to-message.
- GlobalSearch keeps findOpts/findMatches (the local find bar uses them)
  but open() delegates to ChatsView.open().
- Dock: the ⌕ button and its markup are REMOVED; 💬 opens the merged view.

## D. Library decoupling (item 5)
- hub.js gains `cur.chat` (null | {sessionId,title,iconHTML}). A pill row
  at the top of the view: `[icon] chat_1 · baby ▾` / `[📚] no chat ▾`.
- Pill tap → ChatsView.openPicker(onPick): the merged overlay in PICK mode
  (rows connect instead of opening the chat).
- Hub.open(type, {chat}): from a chatbot → that chat auto-connected (pill
  shows its icon + `chat_# · name`); from the canvas dock → NO chat.
- While the hub view is up, the panel header avatar goes neutral (📚 +
  "community library") so the library isn't visually bound to the host.

## E. The 3 per-chat pills (item 6)
Toolbar = [effort · x] [⧉ template | +] [🛠 skills | +] (+ clear + find):
- Label press → toggle the chat's auto-search cap (template_auto /
  skills_auto — NEW session columns, migration + PATCH + restore + ride
  the turn). Pill lights up when on.
- `+` press → Hub.open('template'|'skill', {chat}) — the public library
  with THIS chat connected.
- `+` shows the template/skill in use THIS TURN (tool_use events:
  template_show / dtemplate / skills load), reverting to `+` when idle;
  a manually-activated template name shows persistently.
- Engine gating: direct path gates the template ACTION tools on
  TemplateAuto; brain path passes template_auto/skills_auto → run_turn →
  _build_tools excludes `dtemplate`/`skills` + the system-prompt lines;
  brain/ synced to hfzero/brain/, shared space redeployed.
- The old whole-pill template browse action is REPLACED by the hotbox
  (nothing to remove in the ChatTweaks page — no such toggles exist
  there; verified).

## F. Workspace pill (item 7)
- `▣ + workspace <count>` (was icon + count only).

## G. Test as a real user
- go test ./... ; node JS suites; agent-browser: picker renders (no PRO
  card, no back, new name + warning), dock has ONE chats button, merged
  search/index view works, hub pill no-chat→pick→updates, toolbar 3
  pills + toggles persist, workspace pill text.

## H. Ship
- pull/rebase → commit → push → tag v0.52.0 → release; sync brain;
  redeploy the community sandbox; worklog + MEMORY updates.
