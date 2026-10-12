# PLAN-V134 — THE OWNERSHIP WAVE

The user's five round-9 reports, one thread: **every surface and event must belong to
its owner.** The model pill belongs to the chat whose header it sits in; the termux
row belongs to the live capability state, not a stale snapshot; the OAuth return
belongs to the app that started the flow, not a redirect question; the pill's tail
belongs to the file/skill it actually acts on; and a PM chat's reasoning and tool
events belong to THAT chat — never to whatever chat happens to be on screen.

Phases ship as v1.33.1 → v1.33.5 (the wave rides v1.33.0), then v1.34.0 carries the
ship. All five fixes are PWA/HTML/Kotlin-side except oauthdone.go (the done page's
auto-return) — no engine protocol changes, so the PWA phases ride the OTA where
possible; the Kotlin sheet + done page changes wall at min_engine (one APK install
carries the wave).

---

## §1 v1.33.1 THE RETURNING MODEL (issue 4 — the model pill goes after reopen)

**The report:** "the model select pill goes away on a mature chat, if the panel is
closed and re-opened... We can't change models mid chat. Both ways it shouldn't
outright disappear. We need it rendered and displayed so the user may know what
model they are using, and to change it that works without causing harm."

**Root cause (evidence):** app.js resets the panel header on every open
(v0.14: "the far-left model button is hidden until ChatPanel shows it"), and
`ChatPanel.render` has two paths: `renderHost` calls `updateHeaderBtn`
(chatpanel.js:1425) — but **`restoreStashedChat` (v1.29.1 THE STASHED CHAT) mirrors
"the renderHost tail wiring (minus the rebuild)" and SKIPS `updateHeaderBtn`**
(chatpanel.js:~470-475 wires meters/button/queue/flush only). A mature chat
closed+reopened takes the stash path → the pill stays hidden forever → no model
label, no model browser. A regression born with the stash feature itself.

**The fix:** add `updateHeaderBtn(state, icon, bodyEl, panel)` to the restore tail
(the exact renderHost line, same arguments — the mirror completes). The mid-chat
model change was already safe (v0.37 stops the turn first; PATCH persists; the
event log is model-agnostic — memory and continuity untouched), so the pill's
return restores the whole capability.

**Pin:** a source + behavior rig (v1340): the restore tail's wiring list contains
updateHeaderBtn; a vm-driven restore with app.js's hide-first law shows the button
visible again after reopen.

---

## §2 v1.33.2 THE HONEST TAILS (issue 3 — "read X", "skills load X")

**The report:** "Instead of just displaying read as a generic tool title for pill
boxes when collapsed, let's use the query to get the path and display the tail up
to the last `\` — so for a full path we only get the last bit of text after the
last slash... show read X, where X represents the file being read. Same with
skills: instead of skills load, say, skills load X for whatever the skill is,
templates, personas, ext — X derived dynamically."

**Root cause:** `toolPillLabelParts` (chatpanel.js:6050) gives non-exec verbs a
static one-word title (`TERMUX_ACTION_TITLES`: read → 'file_read') and non-termux
tools get `title = p.name` ('skills', 'template_show', 'persona_set') with the
body carrying whatever summary/args happened to ride. No tail derivation anywhere.

**The fix — the tail law (pure derivation, no lists):**
1. `argsOf(p)` — the generic args parser for EVERY tool family (the termuxArgsOf
   law generalized: `p.args` may be an object, a JSON string, or flat keys on p —
   the runner's merge law, already proven on termux since v1.26.1).
2. `pathTail(s)` — the last non-empty segment after `/` (or `\`), clamped at 30
   chars, '' for empty. `nameTail(x)` — same clamp for name-like ids (a skill id
   may contain slashes — the tail law applies equally).
3. The matrix (title → the verb the user speaks; body → the dynamic X):
   - termux `read` {path} → title 'read', body = pathTail(path)
   - termux `write`/`append` {path} → 'write'/'append', body = pathTail
   - termux `ls` {path} → 'ls', pathTail ('' → the workdir stays via summary)
   - `skills` {action:'load', skill} → 'skills load', body = nameTail(skill)
   - `skills` {action:'read', skill, path} → 'skills read', pathTail(path)
   - `skills` {action:'search', q} → 'skills search', body = q (clamped)
   - `template_show` {id} → 'template', body = nameTail(id)
   - `persona_set` {name|from} / `persona_activate` {id} → 'persona', nameTail
   - `hublib` {action:'download', id, type} → 'hublib download', nameTail(id)
   - `workspace` {action:'read'|'put', path} → 'read'/'put', pathTail(path)
   - exec/pkg/ls/rm/mkdir/grep/find/cmds/help/session_* → UNCHANGED (v1.26.1's
     program-token law + v1.24.5's verb law stay exactly as shipped)
   - legacy/unknown → the existing fallbacks, byte-identical.
   The collapsed pill (name chip + dim body span) then reads "read notes.txt",
   "skills load superpowers", "template react-methods" — the user's exact ask.
4. The overlay's tvSubFor prefers the title-stripped body (v1.24.5 law) — rides
   automatically; the expanded three-truth rows keep the FULL path (the truth
   rows are for inspection — the collapsed tail is for recognition).

**Pin:** the v1245/v1232 rig family grows the matrix (the double-encoded string
args shape included — the device's real form), + the tail law units (slashes,
backslashes, trailing slashes, 30-clamp, empty).

---

## §3 v1.33.3 THE SETTLED SETUP (issue 1 — the error-looking complete screen)

**The report:** "after I set up termux I got the termux complete screen with an
error that said I must download termux from f-droid and package install termux or
something to get access to stuff like wifi, battery... Also the termux option
disappeared from capabilities — I had to exit and re-open the capabilities screen
for it to show up again, and it was switched off."

**What the line actually means (the user asked):** Termux:API is a SEPARATE
companion app (F-Droid) plus a `pkg install termux-api` package — it unlocks
device commands (battery · wifi · location · camera · notification · clipboard).
It is OPTIONAL: Termux itself is fully ready without it. v1.28.3 added the honest
line, but on the READY card it reads as a warning + "install the Termux:API app
(F-Droid)" one line under "Install Termux from F-Droid" (step ①) reads as the
same demand twice.

**Root causes (three):**
(a) The locked line's framing: "device commands locked — install..." under
"⌨ Termux is ready" — a contradiction that reads as an error (termuxsetup.js:322).
(b) **The stale snapshot:** the caps page rides the ConnectOverlay navStack as an
html STRING captured at open — BEFORE the async termux-row append. Setup pushes
over it; Done pops back to the SNAPSHOT (no termux row) — and the row's re-probe
waits for the setup instance's POLL_MS liveness kill + a forced `?refresh=1`
bridge re-probe (seconds on a real device). "Exit and re-open" gets the cached
row instantly — exactly the user's experience.
(c) **No auto-stack:** setup completion never flips the chat's capability ON —
the user found it OFF and read that as a reset.

**The fix:**
1. The READY card copy: the line becomes the optional-unlock truth — "optional:
   device commands (battery · wifi · location · camera · notification ·
   clipboard) need the Termux:API companion app — a separate app from F-Droid —
   plus `pkg install termux-api` in Termux. Termux itself is fully ready." The
   live variant keeps its line. No warning tone (the tsx-ready-api style is
   already muted; the wording carried the error weight).
2. The Done path: `kill(inst)` fires SYNCHRONOUSLY before popPage (the comment
   at termuxsetup.js:561-567 says popPage's teardown rides the interval's
   liveness watch — Done now kills first so onExit is immediate). The back-gesture
   path keeps the liveness watch.
3. The caps re-show: capabilities' onExit re-renders the library page fresh
   (`ConnectOverlay.replaceContent(pageHTML(...))` + wire) — never the stale
   snapshot — then probes the row with the CACHED status first (instant row) and
   a background `?refresh=1` (honest readiness).
4. THE AUTO-STACK: when setup completed READY and the chat's session exists and
   st.termux is false, the onExit flips it ON through the row's own persist path
   (st.termux = true + PATCH) — the setup's purpose IS stacking the capability
   for this chat. The READY card's sub-line changes to match: "⌨ Termux is
   stacked on this chat" (honest — it now is).
   Cold-open setups (no caps beneath, no session) keep the old behavior (the
   overlay closes; the row stacks from the caps screen on demand).

**Pin:** rig — the readyHTML copy law (the word 'locked' never rides the ready
card), the Done-kill-before-pop order, the onExit fresh re-render + cached-first
probe, the auto-stack matrix (ready+session+off → ON; unready → untouched;
already-on → untouched; cold-open → no flip).

---

## §4 v1.33.4 THE UNASKED RETURN (issue 2 — the OAuth redirect ask)

**The report:** "We still get blocked during auth flows — we get asked to be
redirected to 192.xx.xx or whatever the port the app is running on. We can
instead just close the panel automatically as the OAuth is over at that point
anyways, or not get prompted to redirect to the app port ip as it slows down
the flow."

**Root cause (the exact ask):** PanelBrowserSheet.kt's REDIRECT GUARD
(v0.87.3, line 1410-1433): a main-frame navigation to a different registrable
domain than the current page returns true + shows the "redirect to <host>?" ask
pill. During an OAuth flow in the sheet, the provider's page redirects to the
ENGINE's callback — `http://192.168.x.x:8080/api/github/oauth/callback` (the
remote-engine case; the origin the flow STARTED from) or any engine origin —
a different domain than github.com → **the guard asks** → the flow stalls until
the user taps the accept pill. Then the done page sits in the sheet until
manually closed.

**The fix (two halves, the user's own two options):**
1. **Not asked (the exemption):** the sheet records the ORIGIN of the URL it was
   OPENED with (`rootOrigin` — computed in openPanel from the URL arg).
   `guardShouldAsk` returns false when the navigation's origin === rootOrigin:
   a return to the flow's own origin is a homecoming, not a third-party hop.
   Covers loopback, LAN (192.x), tunnels, and gateways — whatever origin the
   flow started at. Third-party redirects elsewhere still ask (the guard's
   job is untouched).
2. **The panel closes itself (the auto-return):** oauthdone.go's done page gains
   the success-path auto-return: when `window.opener` is null (the APK sheet /
   external-browser case — the popup path keeps its postMessage + close()) and
   the page is a SUCCESS, after ~900ms it fires `location.href='doomalay://return'`.
   The SHEET already catches the scheme (dismiss() + wakeSpa(), line 1435-1444)
   — the flow ends with the panel closing itself and the SPA refetching, zero
   taps. MainActivity.handleUrl gains a `doomalay://` consume branch (return
   true — the main webview never tries to load the scheme; the app is already
   foreground). ERROR pages never auto-return (the user must read the failure —
   the honest asymmetry).

**Pin:** rig — the sheet's source pins (rootOrigin recorded; guard consults it;
MainActivity's consume branch) + oauthdone's page law (auto-return only on
success + only when opener is null + the 900ms beat) + a live walk against a
stub provider whose authorize page redirects to a second origin (the 192.x
shape): zero asks, the sheet self-closes, the account lands.

---

## §5 v1.33.5 THE ISOLATED MINDS (issue 5 — PM cross-chat leakage)

**The report:** "Privatemodeai tools and reasoning leak into other chats. One
privatemodeai doing autonomous stuff — its reasoning and tool calls leak into
all other freshly created privatemodeai chats with no messages sent. Sometimes
just its reasoning box leaks but the actual reasoning doesn't stream (just a
blank reasoning box). Chats should be 100% isolated — many PM chats doing
separate things in separate workspaces in parallel, no interference."

**Root cause (the full audit):** the PM turn's callbacks call `appendMessage`
WITHOUT the `ownerState` argument at seven sites (chatpanel.js:2917, 2996,
3044, 3115, 3132, 3143, 3151). The shared-append helper then takes
`st = currentCtx.state` — **whichever chat is on screen** — and its stale-closure
hardening RETARGETS the append into the foreground chat's live #chat-messages
(chatpanel.js:6419-6428): a background PM chat's reasoning shells, tool pills,
sources and artifact cards render into the fresh chat (and delete its greeting,
and auto-scroll it). The per-delta repaints ARE owner-gated (they pass `state`)
→ the leaked reasoning box never fills — the exact blank-box variant. WS chats
are triple-isolated (per-session transport + the engine's session guard +
handleEvent's own-state routing); the PM path bypassed all three.
Secondary: `refreshToolRow` (6147) has no owner gate (resolves #chat-messages off
the SHARED bodyEl); pmsdk's `_pmBootstrapCache` (183) is not session-keyed — one
chat's skills bootstrap serves every other PM chat.

**The fix:**
1. Pass `state` as the 6th argument at the seven PM appendMessage sites (the
   one-argument-class fix the WS twin already pays). A backgrounded PM turn
   falls into the same data-only path as WS: appends land in the stale/detached
   container (invisible; state.messages is the truth; the stash/next render
   restores from it), repaints skip (isOwner false), no greeting deletion, no
   foreign scroll.
2. `refreshToolRow` gains the owner gate: `if (!state || !isOwner(state))
   return;` — a background merge never repaints into the foreground DOM (the
   row isn't there; the data merges into state.messages and re-renders on the
   owner's next open — the WS law).
3. `_pmBootstrapCache` keys by sessionId (pmsdk.js:183) — each PM chat's
   bootstrap is its own (the engine's bootstrap is session-gated; the cache
   now matches).
4. Parallel PM turns share one attested core (the singleton) — LEFT AS IS this
   wave (the contention point is real but no live failure rides it; the
   per-session bootstrap + DOM ownership kill every reported symptom). Recorded
   in the plan as the known seam.

**Pin (the rig the gap deserves):** scripts/v1340-pm-isolation-rig.cjs — the
real chatpanel.js logic in a vm (the v0951 test_isolation shape): two PM chat
states, currentCtx pointed at the fresh one, a fake PMBridge.streamChat firing
onThinking/onTool/onDelta for the BACKGROUND state → assert the foreground
#chat-messages gains ZERO children, its #chat-greeting survives, the background
state.messages still accumulates, the reasoning never paints anywhere (the
blank-box case), and a mergeToolResult during backgrounding repaints nothing
in the foreground. Plus the pmsdk cache-key unit. Plus a LIVE walk: two real PM
chats, one autonomous turn streaming while the second opens — zero foreign rows
(against the real engine + the real PM bridge shape with a stubbed core).

---

## §6 v1.34.0 THE SHIP

buildinfo 1.34.0 + the wave record + docs/TERMUX-DEVICE-TEST.md grows the
5-walk device checklist (the model pill after close/reopen; the read/skills
tails; the setup Done → stacked ON + no error-reading line; the OAuth flow with
zero asks + the self-closing panel; two PM chats in parallel). The E2E walk
(scripts/v1340-e2e-walk.mjs) walks all five as a real user against a real engine.
Battery: v1340 rigs + the v1310/v1300/v1290/v1270/v1250 regression family + the
full Go suite + linux/android builds. Push per the protocol (rebase, check, tag).

## Will-NOT boundary (this wave)

- No engine protocol changes (all five fixes are PWA/Kotlin/done-page side).
- No PM per-session attestation core (recorded seam, not a live failure).
- No guard redesign (the rootOrigin exemption is additive; the third-party ask
  law stays exactly as the user specced it in v0.87.3).
- No changes to exec/pkg pill law (v1.26.1/v1.24.5 stay byte-identical).
