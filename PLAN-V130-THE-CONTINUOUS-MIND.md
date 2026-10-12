# PLAN-V130 — THE CONTINUOUS MIND

> THE LAW (saved per the user's standing order, verbatim):
> "do not implement anything without planning out all phases in detail. Whilst
> websearching all the documentation and relevant websites for insight we can
> apply before anything is actually done. This applies to everything from now
> on. Before you build. You initial plan/hypothesis -> web search -> real plan
> -> build -> revise/test/redteam the implemented phase/sub goal with real
> tests, imitate a real user and act as a human being testing the full
> capabilities and trying out use cases."
> hypothesis -> web search -> THIS PLAN -> build -> redteam (rigs + walks + a
> REAL-model replication) -> ship v1.30.0.

## 0. The evidence (the Doobie transcript = the spec)

The attached chatlog (PM chat `doomalay-doobie-6accb54f`, 10 tool events) shows
four mechanical diseases, each mapped to code:

| # | Symptom (user's words) | Root cause (code) |
|---|---|---|
| 1 | "termux not having access to GitHub" (the user had to paste a PAT into the chat) | No credential lane anywhere: engine → bridge → Kotlin has no env/token plumbing; termux git has no `~/.git-credentials`; the vault's `GITHUB_PAT` (already allowlisted, vault.go:92) never reaches Termux. Bonus hazard: the pasted PAT persists in the chat DB **unredacted** (Redact() only wires error events, chat.go:2194). |
| 2 | "no tool for tags or a more permissible method for the model to manage repos" | The workspace tool's `view` enum has no `tags` (def.go:216); the only tag-producing verb is `release_create`; forge clients have no Tags/CreateTag; the manifest Desc even LIES ("Jailed to bound folders… never executed" — true only for file verbs, false for exec). |
| 3 | "kept constantly avoiding execution… researching things it should have known… second guess itself all the time" — "fix WITHOUT adding a prompt or changing the persona" | THREE mechanical causes: (a) **TOOL AMNESIA**: `buildHistory`/`buildHistoryCompacted` (chat.go:2073, compact.go:298) fold only user/assistant events — every tool_use/tool_result is persisted for the UI but NEVER enters the model's history, so every new turn starts fact-blind and re-reads the same files (the transcript re-reads timer 769 twice, the scheduleUpdate region twice); (b) **SILENT 24KB CLAMP**: `clamp(obsText, 24000)` (nativetools.go:470) appends "…" with no marker — the model can't know its read was amputated, so it doesn't trust its reads (Cline's honest-marker pattern is the industry fix); (c) **THE ANNOUNCEMENT EXIT**: the answer-force net (nativetools.go:314-341) ends the turn the moment a round produces prose with no calls — "Let me read the code regions" ends the turn AS the final answer; the user must push ("Continue, sorry for the interrupt"). The v1.13-era auto-proceed (`looksLikeIntentOnly`, llm/chat.go:589-640) is dead code with zero call sites. |
| 4 | "Termux queries return [object Object] when expanded" (fix 7) | `openToolFullView`'s `qHtml` (chatpanel.js:5951-5959) pretty-prints only `typeof q === 'string'`; the termux payload's `pay.args` is an OBJECT (inner args double-encoded per the v1.27.0 manifest law) → `String(pretty)` → "[object Object]". The v1.27.0 fix went to pill labels (`termuxArgsOf`) but never to the overlay's query box. |
| 5 | "panel closes, re-opens, re-renders the chat history instead of having it cached = turn gets interrupted. This is very bad." (fix 8) | (a) **EVERY open is a full rebuild**: `panel.open()` → `wipeBody()` (panel.js:141) → `renderHost` → `bodyEl.innerHTML = …` (chatpanel.js:1071) — the whole convo re-parses + re-formats (the "periodic snappy re-render"); (b) **THE FALSE INTERRUPT**: the engine NEVER kills a turn on socket loss (chat.go:910-915) — but `wireClientClose` (chatpanel.js:4156) fires when the reconnect ladder exhausts (~20s) regardless of ownership: while the panel is closed (currentCtx=null, doze kills the WS pongs), it flips `isStreaming=false`, pushes a "Connection dropped — Tap Retry" error and parks the queue — while the engine is still running the turn. The reopen then surfaces the false verdict. Also the replayed-terminal direct-flush risk (status handler 5014-5076: `wasStreaming` has no `_replay` guard on the flush path). |
| 6 | "lib tool enabled but the bot didn't stop to use lib before implementation" (fix 6) | The discipline is advisory prose (MUST=search-before-answer, MAY=load, preambles.go:121-128); the loaded skill's methodology is a tool observation in ONE turn — it evaporates at turn end (the tool amnesia again). Nothing persists the loaded skill. |

## 0.1 Research receipts (web pass, before this plan)

- **Tool-result retention**: industry norm (Claude Code, Cline) keeps tool
  observations in the conversation transcript; compaction summarizes them.
  Doomalay's exclusion of tool events from history is the anomaly; the
  "context amnesia → repeated file reads" failure mode is a documented class
  ("Your AI Coding Agent Forgets Things — manage the context window").
- **Honest truncation**: Cline pins `[command truncated: N more chars…]`;
  Claude's API never silently truncates (errors instead). Our bare-"…" clamp
  is the anti-pattern → every clamp gains a byte-honest marker.
- **GIT_ASKPASS**: the proven headless token lane (helper + GIT_TERMINAL_PROMPT=0);
  already proven IN-REPO (workspaces.go:1173-1183). For the Termux side we use
  `git config credential.helper store` + `~/.git-credentials` (0600) written
  via the EXISTING `RunWithStdin` bridge lane (client.go:157, v1.20.2) — the
  token rides stdin over loopback HTTP, never in a persisted command string.
- **DOM keep-alive**: the repo already owns the machinery (panel.js
  `_stashRoot`/`_restoreRoot` DocumentFragment stash; the `data-wt-keep`
  web-tab deck) — reuse the in-repo pattern for the chat root.

## 0.2 Design constraints (the user's law)

- NO prompt additions, NO persona changes for #3: the fixes are mechanical
  (memory + markers + loop behavior + tool state). The only model-facing text
  this wave adds is TOOL SCHEMA (manifest/help lines for the new verbs — the
  same surface every existing verb uses) and ONE mechanical loop instruction
  (the revived auto-proceed nudge, v1.13's own design, bounded).
- One of the two overlay surfaces only for new UI (this wave adds NO new UI
  surface — everything lands in existing panel/pill/overlay chrome).
- Theme vars everywhere; no hardcoded colors.
- Phases v1.29.1 → v1.29.6, ship v1.30.0; each phase pushes.

## §1 v1.29.1 — THE STASHED CHAT (fix 8a: the snappy re-render dies)

`chatpanel.js` + `panel.js`:

1. **Stash on close** — inside the existing `doomalay:panel-closed` listener
   (chatpanel.js:116), BEFORE `currentCtx = null`: if `currentCtx` owns a
   rendered chat root, move `#chat-root` into `state._domStash` (a
   DocumentFragment), record `state._stashLen = state.messages.length`,
   `state._stashScroll` (the #chat-scroll scrollTop), `state._stashAt`.
   The DOM nodes keep their listeners (detachment never strips them);
   `state._miEls` (mi→el cache) stays VALID — the same nodes re-attach.
2. **Restore on reopen** — in `ChatPanel.render` (chatpanel.js:321): if
   `state._domStash` exists for THIS icon → the RESTORE PATH (skip
   renderHost entirely): `bodyEl.innerHTML=''` (cheap — the wipe already
   happened), appendChild(fragment), rebuild `currentCtx` (the same shape
   renderHost builds: bodyEl/icon/state/panel/type + ctx via buildCtx),
   re-point `state.client.onEvent` + `wireClientClose`, `reviveClient` if
   dead, re-mount `ctx` refs (scrollEl/msgContainer/input/sendBtn — reuse
   buildCtx which queries them), restore scrollTop, APPEND THE DELTA:
   `for (i = state._stashLen; i < state.messages.length; i++)
   appendMessage(...)` (background data-only growth while closed), re-arm
   the activity row if `state.isStreaming` (the watchdog repaints — it
   guards on isOwner), `syncSendButton`, `scheduleOpenFlush`, backfill NOT
   needed (the DOM already holds the tail + the previously-backfilled head).
   The stash slot then clears (`state._domStash = null`).
3. **Memory discipline** — one stash per state; dropped on: chat switch (the
   salvage path), a second close (re-stash replaces), >300 messages of
   growth while closed (fall back to renderHost), page hide (the WebView may
   reclaim — on `visibilitychange→hidden` the stash stays (fragment is JS
   memory), on `pagehide` it stays too; only an explicit render without
   restore consumes it).
4. **The streaming turn while stashed** — the pill stream (tool_stream) and
   delta handlers no-op data-only while closed (isOwner=false); the delta
   re-render (updateMessageEl) guards ownership already. On restore, the
   partial message element + `_miEls` mapping resume live updates.
5. **Salvage compatibility** — `salvageFormatted` reads DOM before the
   innerHTML wipe on SWITCH; with the stash, the outgoing chat's DOM is in
   the fragment, not bodyEl — the switch path first checks
   `prevCtx.state._domStash` (nothing to salvage from bodyEl — correct, the
   fragment already IS the salvage, one level up).

Pins: source contracts (the stash listener order, the restore branch shape,
the delta-append loop) + a jsdom-style stub DOM behavior rig (close → stash →
messages grow → reopen → restored root + delta appended, no renderHost call,
scroll preserved, listeners alive).

## §2 v1.29.2 — THE UNBROKEN TURN (fix 8b: the false interrupt dies)

`chatpanel.js`:

1. **The backgrounded-drop law** — `wireClientClose` (4156): after the
   `!state.isStreaming` guard, NEW: `if (!isOwner(state) || !currentCtx)
   { state._bgDrop = Date.now(); return; }` — a drop while the chat is
   backgrounded NEVER declares the turn dead, never parks the queue, never
   writes the error. The turn stays armed; the reopen's revive + gap replay
   resolves the truth (terminal → honest end; deltas → still live).
2. **The replayed-flush guard** — the status handler's queue flush
   (`ev.state === 'idle' && wasStreaming`, 5065): add `&& !ev._replay` — a
   REPLAYED idle during the reopen burst never flushes the queue directly
   (scheduleOpenFlush handles the post-quiet flush; the direct flush only
   fires for LIVE idles). The `error`-bubble path on a replayed terminal
   stays (honest — the turn really did fail while closed).
3. **The revive handshake** — on restore/render, if `state._bgDrop`:
   reviveClient reconnects with `&since=lastSeq`; the gap replay either
   carries the turn's tail (deltas keep flowing — isStreaming stays armed,
   streaming resumes into the restored DOM) or a terminal (the status
   handler ends it honestly). `_bgDrop` clears on `client.onOpen`/first
   event. If the revive FAILS while now visible, the honest error path
   fires (the user can see and act).
4. **PM chats** — no engine WS; the loop is in-browser and survives close
   by construction (data-only). Rig-pins: no abort path on panel-closed
   (grep law: `_pmAbort` only fires from the Stop tap, chatframework:206).

Pins: source laws + the interrupt rig (a fake WS client: drop mid-stream
while backgrounded → no isStreaming flip, no error message; reopen → replay
delivers tail → streaming continues; replayed idle → no direct flush).

## §3 v1.29.3 — THE HONEST QUERY (fix 7: [object Object] dies)

`chatpanel.js`:

1. New pure helper `toolQueryText(pay)`: termux → `termuxArgsOf(pay)` →
   render `{action: …}` + the inner args as pretty JSON (and the command
   readable); object args (any tool) → `JSON.stringify(args, null, 2)`;
   string → the string (qHtml's existing pretty path handles JSON strings).
2. `openToolFullView` (5923): `query = toolQueryText(pay) || pay.query ||
   pay.summary || ''`; the legacy borrow walk (5924-5935) gains the same
   derivation. `qHtml` (5951) gains the object branch (the
   toolDetailHTML:5825 pattern) so the fallback never stringifies an
   object bare.
3. Redaction belt: the rendered query runs through the existing redact
   helper if present (defense-in-depth; the §5 persistence redaction is
   the real fix).

Pins: the v1245-rig family grows the matrix (termux object inner-string,
flat, plain object, string, empty) for the overlay query box.

## §4 v1.29.4 — THE TOOL MEMORY (fixes 3-5: the amnesia, the silent clamp, the announcement exit)

`engine/internal/server/chat.go` + `compact.go` + `llm/nativetools.go`:

1. **THE FOLD** — `buildHistory` and `buildHistoryCompacted` gain a
   tool_event fold: walking events in order, a `tool_use` JSON payload
   `{name, summary, args, text}` + its adjacent `tool_result`
   `{name, text}` (matched by name+order; UNMATCHED pairs are skipped —
   providers validate call→result sequences) fold as:
   - ONE synthetic window slot: `Message{Role:"assistant",
     ToolCalls: json([{id:"fold-N", type:"function", function:{name,
     arguments: args||"{}"}}])}` followed by
     `Message{Role:"tool", ToolCallID:"fold-N", Name, Content: clampMarked(
     Redact(result text), 6000)}` — the PAIR counts as ONE window message
     (the window law stays 40 conversational slots).
   - Honest clamp: `clampMarked` appends
     `\n[tool output truncated: first 6000 of N bytes]` when cut.
   - Budget: the most recent `toolFoldMax = 12` pairs ride whole; OLDER
     tool pairs inside the window ride as ONE-LINE STUBS
     `[ran termux exec — output omitted]` (the model sees that it acted,
     without the bytes). Folded bytes also count toward the compaction
     trigger (compact.go's char counter grows a tool_result term).
   - Redact() runs on every folded text (belt for §5's PAT hazard).
   - `assistant_delta` segments between tool pairs keep folding as today —
     the transcript order (prose → pair → prose) is preserved.
2. **The in-turn clamp marker** — `clamp(obsText, 24000)` (nativetools.go,
   both sites: the executed result + the skip fault) becomes
   `clampMarked` with the same honest tail (totals included).
3. **THE PROCEED** (the announcement exit dies) — revive
   `looksLikeIntentOnly` (llm/chat.go:589, dead since v1.13.3) on the
   native-tools path: in the `len(calls)==0` branch (nativetools.go:314),
   BEFORE the final-answer exit, if `contentSeen && roundHadContent &&
   looksLikeIntentOnly(final text) && proceeds < 2`:
   append `Message{Role:"user", Content:"(proceed — execute the plan with
   your tools now; this instruction is the loop, not the user)"}` and
   `continue` the loop (thinking stays on — this is NOT the silent-shape
   nudge). Bounded at 2 proceeds/turn (the third announcement IS the
   answer; no infinite narration loop). The proceed round emits a progress
   chunk ("proceeding…") so the UI shows movement.
   - No persona/prompt change: this is loop mechanics (v1.13's own dead
     design revived); the instruction names the loop, not the persona.
4. **Compact honesty** — the compact summary prompt (if any mentions the
   fold) unchanged; the trigger counts folded bytes so compaction fires
   BEFORE context overflow.

Pins (Go): buildHistory with a synthetic event stream (pairs, orphans,
oversized results, the 12-pair budget, stubs, redaction); clampMarked;
the proceed law (a stub LLM that narrates intent twice then calls; assert:
no early exit, the nudge text, the 2-proceed bound); the window count law
(a pair = 1 slot).

REAL-MODEL REPLICATION (the user's "replicate this urself"): a scripted
run against the real engine with a real provider (OpenRouter key) — turn 1
runs `exec cat notes.txt`, turn 2 asks "what did the file say?" WITHOUT
re-reading — the fold works iff the model answers from memory. Also the
announcement shape: a task phrased to invite narration; assert the turn
proceeds to tool calls without a user push.

## §5 v1.29.5 — THE GITHUB HAND (steps 1-2: credentials + tags)

`termuxtool.go` + `workspacetool.go` + `forge/*.go` + `chat.go`:

1. **termux `git_setup`** (no args): engine reads the vault
   (`vault.Get("GITHUB_PAT")`); absent → the honest refusal naming the
   connect UI (`/api/workspaces/accounts`, the ghconnect paste box).
   Present → GitHub API `GET /user` (login; best-effort, non-fatal) →
   dispatch through the EXISTING stdin lane
   (`termuxfs.go:418` pattern: `s.termux.RunWithStdin(ctx, script, "",
   timeout, credentialLine)`):
   - script (bash, heredoc-free): ensure git (`command -v git || pkg
     install -y git`), `umask 077`, write stdin → `~/.git-credentials`
     (truncate), `git config --global credential.helper store`,
     `git config --global user.name/user.email` (from the API login, only
     if unset), report `git --version` + the config verdict.
   - The persisted tool_use args = `{"action":"git_setup"}` (no token);
     the tool_result = the script's stdout (no token); the credential
     line rides ONLY the loopback bridge body. Redact() runs on the
     result text as the belt.
   - Help/manifest/sessionctx gain ONE line each (tool schema):
     `git_setup — arm the vault's GitHub token in Termux (git push/clone
     work after one call)`.
2. **workspace tags** — `view:"tags"` (list: name, sha, message) +
   `tag_create {repo, tag, sha, message?}` (annotated when message,
   lightweight when not): forge clients grow `Tags(ctx, repo, page)` +
   `CreateTag(ctx, repo, tag, sha, message)` — GitHub (GET /repos/…/tags;
   POST /repos/…/git/refs `refs/tags/<tag>` + the tag-object path for
   annotated), GitLab (repository tags API), Gitea (refs API); HF/
   sourcehut → honest "no tag API" refusal. Manifest enum + sessionctx
   line grow with the two verbs.
3. **THE REDACTION WIRING** — the persist path (chat.go:2255-2355) runs
   `Redact()` on: `user` event content, `tool_use`/`tool_result` text
   (the ghp_/github_pat_/gho_ shapes already implemented, redact.go:59).
   Live frames stay raw (the open panel shows what the user sent); the
   DB + replay + export speak the redacted form. The pasted-PAT-in-chat
   hazard dies for future events.
4. **The manifest honesty fix** — def.go:241's termux Desc: the truthful
   split (file verbs jailed to bound roots; exec runs any command, workdir
   = the first bound root, $HOME is exec-land where git lives).

Pins (Go): git_setup (fake bridge HTTP + a stub vault: the credential
rides stdin only — assert the persisted args/result carry no token; the
no-token refusal; git-missing path), tags (forge stubs: list + create +
the honest refusals), redaction (a user event with a PAT persists
redacted; tool text likewise).

## §6 v1.29.6 — THE PERSISTED SKILL (fix 6: the loaded skill stops evaporating)

`skills.go` + `chat.go`/`compact.go` + the session store:

1. `skills.load` stores the skill's head on the session row:
   `SkillName` + `SkillHead` (the methodology's first ~3000 chars,
   clampMarked) — the CompactSummary pattern (a column on the session,
   updated on load; load of another skill REPLACES it).
2. `buildHistory`/`buildHistoryCompacted` inject the active-skill lead-in
   (exactly like the compact-summary note):
   `[active skill: NAME — loaded by you for this work]\n<methodology
   head>\n[end of skill head]` while `SkillHead` is set. The model CHOSE
   to load it; the persistence is state, not persona.
3. The load result text grows one honest line: "the methodology stays
   armed for this chat's turns." The sessionctx lib line speaks the
   loaded skill (mechanical state visibility).
4. Clearing: the ✦ lib toggle off (existing gate) clears the head; a new
   load replaces. No new UI surface (the toggle already exists).

Pins (Go): load → session row carries head; buildHistory injects + caps;
replace-on-load; toggle-off clears (the existing gate path).

## §7 v1.30.0 — THE SHIP

- buildinfo 1.30.0 + this plan rides the repo + the wave record.
- NEW `scripts/v1300-continuous-rig.cjs` (the source/behavior battery for
  §1-§3: the stash/restore laws, the backgrounded-drop law, the
  replayed-flush guard, toolQueryText) + Go tests for §4-§6 + the E2E walk
  `scripts/v1300-e2e-walk.mjs` (agent-browser, real engine, the executing
  fake bridge, the OpenAI stub): S1 chat streams → S2 panel CLOSES mid-turn
  (the turn continues in data) → S3 messages grow while closed → S4 REOPEN:
  the stash restores (a DOM marker element SURVIVES — no full re-render),
  the delta appends, the turn KEEPS STREAMING into the restored DOM → S5
  the tool pill expand shows the REAL query (no [object Object]) → S6
  git_setup arms via the fake bridge (the credential stdin law) → S7 the
  tags view + tag_create → S8 the real-model replication script → S9
  reload replay (the fold survives: the model history includes tool pairs
  — verified via a debug endpoint or the engine log) → S10 390px + zero
  page errors.
- Re-run the standing battery: v1290, v1270 walk, v1250 walk, v1245,
  v1262, v1232, v1234, v1244, v1241-*, interrupt rig, the full Go suite,
  linux + android(arm64 CGO=0) builds, vet.
- docs/TERMUX-DEVICE-TEST.md grows the v1.30.0 walk.
- Push main + tag v1.30.0 (CI builds the APK — engine AND web AND Kotlin
  [git_setup needs no Kotlin change — the stdin lane exists] changed →
  min_engine walls the OTA; one install carries everything).

## Honest risks

- The fold grows the prompt (6KB × 12 pairs ≈ 72KB worst case + stubs) —
  the compact trigger counts it; the window law keeps 40 slots; the stub
  tier keeps old pairs at one line. If a provider chokes on folded pairs
  (validation), the fold degrades to stubs-only for that provider
  (future switch; not this wave — the in-turn wire shape is identical, so
  providers that run the loop already accept it).
- The proceed nudge could double-fire on a model that narrates then
  answers — bounded at 2, and intentPhrases are conservative (checked
  against the waitnotices test corpus).
- The stash holds a live DOM fragment per chat (memory) — one slot, and
  the >300-growth fallback drops to the renderHost path.
