# PLAN-V159 — THE HONEST RETURN

The user's report (verbatim core): *"everytime I leave the convo for a bit then
reopen the panel, the convo seems to load from scratch at a rapid pace. It's
like I'm watching history go by so fast (even the send/reply/continue) behave
as if I was mid flight... With long convos this can take minutes of
regenerating the convo until it reaches the bottom. For opencode, the same
thing happens but the state of the convo is not stored. It's like the convo
actually does start from fresh and the model doesn't have time to think... like
the turns actually processed again. We want convos to load from the bottom not
from the top, and we want to preserve the honest convo without using up so
much memory or being unoptimized and cluttered."* + *"I deleted an opencode
chat, created a new one, and the old chat popped up with a new name but the
same wonky malformed chat history, even tho it's supposed to be a new chat. I
can't even export the chat for you as it crashed the app and returned pretty
print: session not found and a black screen."*

## THE DIAGNOSIS (convicted by code-read; every link named)

### Issue 1a — every provider: "watching history go by"
On Android, leaving the app backgrounds the WebView → Android destroys it →
on return the page RELOADS → `chatStates` is empty → the panel open creates a
FRESH state (`messages: []`) → `renderHost` renders the empty transcript →
`connectWS` builds a ChatClient with `lastSeq = 0` → the connect sends NO
`&since` → the engine replays the ENTIRE event log over the WS → EVERY event
runs the full live pipeline (`handleEvent` → `appendMessage`/
`updateMessageEl` → DOM append + scroll math + formatter per event) → for a
long convo that is minutes of visual replay with the streaming machinery
running (the buttons "as if mid flight"). The v0.97 C3 TAIL-WINDOW refactor
optimized the RENDER path only (a pre-populated `state.messages`); the
fresh-state LOAD path never got it — the refactor the user remembers predates
the Android WebView-reload reality.

### Issue 1b — opencode: "the convo actually does start from fresh"
`ocServeSessions` (app session → serve session id) is an IN-MEMORY map on the
Server (ocserveturn.go:129-144, comment: "In-memory only: an engine restart
births a fresh serve session"). The Android engine restarts (watchdog /
START_STICKY / memory pressure) → the map is lost → the next turn (send OR
continue — both route through runOcServeTurn) births a FRESH serve session
with `ocServeOpeningText` = persona + "[[Conversation so far: …]]" clamped to
1500 chars/message + sliding window 40 → the model re-answers the whole convo
from the compressed recap → "the model doesn't have time to think", "the
history is so wonky and inaccurate, like the turns actually processed again".
RESEARCH (live-verified against the real 2.x serve): **opencode 2.x sessions
are DURABLE** — one global SQLite DB (`~/.local/share/opencode`), sessions
survive serve restarts AND can be prompted from a NEW serve process; only OUR
binding is lost. The fix is to persist the binding — the model's real context
never died.

### Issue 2 — the ghost + the crash
1. `deleteIconNow` (app.js) deletes the engine session + removes the icon but
   NEVER clears `chatStates[icon.id]` — the dead chat's panel state survives:
   its full `messages` array, its dead `sessionId`, its `_domStash` (the
   panel-close handler stashes the DOM INTO the dying state moments earlier),
   its ChatClient.
2. `createIconAt` (app.js:846-853) picks the FIRST FREE id (`chat_1`,
   `chat_2`, …) — a deleted chat's id is IMMEDIATELY reissued to the next
   new chat.
3. → the newborn icon (new name) renders through `getOrCreateState` → finds
   the OLD state → `restoreStashedChat` re-attaches the OLD stashed DOM →
   "the old chat popped up with a new name but the same wonky malformed chat
   history".
4. The adopted state's `sessionId` is the DELETED engine session → the WS
   upgrade 404s ("session not found") and the export view's
   `window.open('/api/sessions/{dead}/export.md')` renders the raw 404 JSON in
   a black WebView window — "pretty print: session not found and a black
   screen".
5. Bonus leaks on id reuse: drafts + scroll memory (localStorage, keyed by
   icon id) inherit from the dead chat into the newborn.

## THE FIXES (3 sub-waves, no rework of what works — the load pipeline keeps
its OOP: ONE fold truth (the client's handleEvent), ONE renderer (renderHost's
tail-window shape), ONE transport (the WS client, now cursor-armed))

### v1.59.1 THE BOTTOM — the fresh-state load lands at the bottom (chatpanel.js)
- `bootstrapHistory(bodyEl, state, cb)`: when the state is FRESH for an
  EXISTING session (`sessionId && !state.client && !messages.length &&
  !lastEventI`): fetch `GET /api/sessions/{id}/events` (one JSON — the exact
  wire shape the WS replays), then fold EVERY event data-only through the SAME
  `handleEvent` pipeline (`state._bulkLoad` forces the battle-tested
  background/data-only mode; every event tagged `_replay` so nothing re-arms),
  tracking `maxSeq`.
- `mountTranscriptTail(bodyEl, state)`: mount renderHost's OWN shape — the
  last OPEN_TAIL rows + `mountAllFormatting` + `scheduleBackfill` (the older
  history prepends in idle chunks, scroll-compensated) + `restoreChatScroll`
  (the reading law: land at the bottom, or where the reader parked).
- `connectWS` gains the `sinceSeq` pre-arm: the newborn client's `lastSeq` is
  set BEFORE `connect()` → the WS asks `&since=maxSeq` → the engine replays
  only the gap (usually nothing) + the live tail. Fallback: fetch failure →
  today's full WS replay (honest degradation, never a blank).
- Result: ONE fetch + ONE tail mount + idle chunks. No per-event DOM appends,
  no minutes of replay, no mid-flight theater. Memory: identical to today
  (state.messages) with a BOUNDED DOM (the windowing law).

### v1.59.2 THE SERVE MEMORY — the binding outlives the engine (engine)
- Persist the app→serve binding as an engine setting `chat.ocserve.<sid>`
  (the tweaks kv pattern — GetSetting/SetSetting/DeleteSetting; no schema
  change).
- `ocServeSessionID`: memory-miss → read the persisted binding → cheap
  `Manager.SessionExists` (GET /api/session/{id}, JSON-shape-guarded against
  the SPA-HTML trap) → 200: ADOPT (fresh=false — the serve's own full history
  IS the context; NO recap, the model keeps thinking) · 404/shape-miss:
  fresh + opening text (today's behavior, self-healing).
- Persist on create; drop on recycle (ocServeForgettext); on app-session
  DELETE: drop the binding + best-effort serve-side session delete (legacy
  `DELETE /session/{id}`, JSON-guarded) ONLY when a serve is already healthy
  (the delete never blocks on the bridge — the no-long-hold law).

### v1.59.3 THE GHOST — the death clears every residue (app.js + chatpanel.js)
- `ChatPanel.forgetState(iconId)`: closes the client, drops `chatStates[id]`,
  the domStashLRU entry, the draft + scroll localStorage rows.
- `deleteIconNow`: calls forgetState (AFTER the panel-close stash lands —
  the state dies whole) + `saveNow()` directly (a destructive action never
  waits on the 200ms debounce).
- `createIconAt`: NEVER reissues a retired id within the session —
  `n = max(existing chat_N) + 1` (the v0.17 fix's law extended: not just
  "unused in the live world" but monotonic).
- The export view's honest guard: `openExportView` pings
  `GET /api/sessions/{sid}` BEFORE pushing the view — 404 → the honest
  "this chat's engine session is gone" state instead of dead URLs (the
  black-screen crash class dies; offline → the rows open, the download fails
  honestly).

### v1.59.4 THE PROOF (scripts/v1590-honest-return-rig.mjs — real engine + real browser)
- §A THE BOTTOM: seed a long session (200+ events incl. thinking/tool pairs)
  → RELOAD the page (the Android reality) → open the panel → assert: the
  transcript mounts within ~2s; a MutationObserver census shows the load burst
  is ONE tail-shaped mount (≤OPEN_TAIL rows), not N per-event appends; the WS
  connect URL carries `&since=<maxSeq>`; the folded convo is WHOLE (count +
  first/last text); the scroll lands at the bottom; the send button settles
  (no mid-flight theater).
- §B THE SERVE MEMORY: with the external-serve stub (OPENCODE_SERVE_URL —
  the existing rig pattern): turn 1 → the binding persists (DB row); RESTART
  the engine → turn 2 → the serve session is RE-ADOPTED (zero new
  POST /api/session; the prompt body carries ONLY the user text — no
  "[[Conversation so far" recap); a dead binding (serve session 404) →
  self-heals fresh + recap ONCE; DELETE the chat → the binding row is gone +
  the serve-side DELETE issued (bridge-healthy case) and SKIPPED (bridge
  down — no spawn, no block).
- §C THE GHOST: create chat (chat_1) + session + messages → DELETE → assert
  chatStates empty, LS rows gone, save ran; create a new chat → id is chat_2
  (NEVER chat_1) → the panel is virgin (no messages, no sessionId, greeting
  visible); a state pointing at a dead session + the export view → the honest
  message, zero dead-URL window.open.
- The battery: the full regression rigs (v1400 ×2, v1350, v1421-1428…), go
  test ./... + vet, the cross-compile, the theme-census discipline + B1.

## THE WAVE ORDER
v1.59.1 → v1.59.2 → v1.59.3 → v1.59.4 (the proof) → ship v1.59 (README +
buildinfo 1.59.0 + worklog). Sub-wave pushes per the version law; rebase
before every push.
