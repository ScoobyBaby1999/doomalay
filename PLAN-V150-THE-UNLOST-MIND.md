# PLAN-V150 — THE UNLOST MIND

**Version:** v1.50.0 (renumbered from the drafted v1.49.x — the parallel
pocket-bridge wave claimed the v1.49.x sub-phase line on origin mid-build;
the version law: never share, never trust a reservation) · **Trigger:** the user's report (verbatim):
1. *"despite the push to stop truncated returns on tool pills we still have some tools pills that slipped under the cracks and return truncated returns. All tool pills must return the entirety of the output. This is a weird bug as the UI that renders the tool pills output for the user seems to be fine and return the full output even if it's a extremely large file. If they don't use the same methods then how is that working with our OOP standards for loose coupling and best coding practices."*
2. *"Another huge issue is the chat repeating itself. It should always be caught up, matter of fact, rework the (retry) botton that we have (the one alogslide send, queue, and stop) and turn it to a continue botton. No more retry whatsoever existing in the app. Only continue, continue exactly where it left off. Or as close to exactly as possible."*
3. *"Test it with real Nvidia and Openrouter models. 2 test, both should be done by the API keys though the app… One test should have trippy push or port or do the things it said it found and continuously lost and looped over… The second test is the original prompt I asked trippy: for them to make the connect workspace pill in the workspaces overlay glow an accent color when no workspaces are connected."*

**The pre-build research (the user's law — searched before building):** fixed-position
output truncation is a convicted industry anti-pattern (Claude Code issue #913 — the
same fixed char-position class, same symptom: agents forgetting findings, looping);
the standard continue pattern = partial assistant message + a continue-nudge (already
in this codebase as v1.39.6 THE SEAMLESS CUT's `seamNudgeText`); event-sourced history
rebuilds dedupe by event id (the UI half already does — the model-facing half didn't).

## §0 THE DIAGNOSIS — five convicted issues (all code-verified this session)

**THE OOP ANSWER** (the user's question, answered first): the pill UI and the model
never shared a path. The pill renders the **persisted `tool_result` event** — full
text, no cap, since v1.19.1 THE WHOLE TRUTH. The model-facing path re-clamps the same
bytes through **three independent sites** born after (or never touched by) the push:
the v0.38 in-turn 24,000-byte clamp (`nativetools.go:514,558`), the v1.30.4 cross-turn
6,000-byte clamp + 12-pair stub law (`toolfold.go:40-43,137,158-167`), and the
tool-level caps that predate the push and were never swept (skills/hublib v0.60,
delegate v0.21.0, fleet v1.47.2, archive/xlsx, web_search snippets). Two consumers,
two truths — THAT is the loose-coupling violation. The fix restores one source of
truth: the persisted event feeds both; the fold renders SHAPE (no policy); budget
policy lives in exactly ONE place (the auto-compactor + a context-aware in-turn guard).

1. **THE SLIPPED CAPS** — skills `read` 8,000 / `load` 40,000 / search top-8 /
   hublib 6,000-12-3,000-40,000 family (`skills.go:65-70` + 14 clip sites) ·
   delegate 2,000 (`compact.go:428`) · fleet roster 30 + detail 6×90-char
   (`fleettool.go:36-37,188-201,324,402-435`) · archive_extract 60 files +
   inline ≤4,000 (`filetools.go:70,205-233`) · archive_create silent drop >200
   (`filetools.go:119`) · xlsx_create silent drop 2,000 rows/256 cells
   (`filetools.go:552-558`) · web_search snippet 300 (`websearch.go:704`). These
   amputate the return BEFORE anyone — pill or model — sees it.
2. **THE DUAL-PATH CLAMPS** — the 24K in-turn + 6K cross-turn + 12-pair stubs: the
   pill shows a 300KB read; the model gets 24KB this turn, 6KB next turn, and
   `[ran X — output omitted]` after 12 newer pairs. THE TRIPPY LOOP DRIVER: the
   model's findings live in tool outputs; the fold silently deletes them; the model
   re-reads, re-finds, loops — "completely bonkers".
3. **THE UNSEEN MASK** — `buildHistoryCompacted` calls `foldSlots(liveEvents, nil)`
   (`compact.go:329`): hide events are ignored by the PRODUCTION history builder
   (only the test-only `buildHistory` applies them). After retry/edit/regenerate,
   the model still sees the dead turn + the re-sent user message = **the chat
   repeating itself** (user M twice + the model's own prior answer).
4. **THE FRAGMENTED VOICE** — `foldSlots` assistant_delta handling
   (`toolfold.go:70-79`): the first delta seals itself `FoldedDone:true`, so every
   later delta becomes its OWN model-history message, plus the full `assistant`
   event as another copy. A streamed reply rides context as N fragments + a
   duplicate — in-context self-repetition + 40-slot window flooding. (Same bug in
   maybeCompact's summarizer input, `compact.go:140-145`.)
5. **THE REGENERATING RETRY** — `doRetrySend` (`chatpanel.js:1056-1084`) = pop the
   tail + hide + re-send the user text as a BRAND-NEW turn — a second user event,
   a from-scratch regeneration. Combined with #3 it is the repeat machine. No
   continue mechanism exists anywhere (WS speaks only send/stop/hide — `chat.go:1071-1098`).

## §1 THE WHOLE RETURN (v1.50.1) — the tool-level caps die

Every tool returns its ENTIRE output; the honest-marker `clip()` sites become
honest-overflow notes only where a list is genuinely unbounded. Physics guards stay.

- `skills.go`: `skillsReadMax`/`skillsLoadMax`/`hublibOutMax`/`hublibPayloadHead`
  DELETED — `read`/`load`/`list`/`search`/`files`/hublib `search`/`bundles`/`get`/
  `download`/`bundle`/`download_bundle` return full bodies + full payloads + full
  lists (the device's real skill count bounds them). `skillsSearchTop` (top-8)
  dies — all ranked matches return. The persisted `SkillHead` lead-in keeps its
  3,000-byte head (it is a lead-in note, not a tool return — the model re-reads
  the FULL skill now that read is whole).
- `compact.go:428` delegate: the 2,000-char `clampServer` dies — full delegate
  replies (the 3-model cost guard stays).
- `fleettool.go`: roster cap 30 dies (full roster, ranked as today); detail's
  90-char event snips become full text (the 6-event TAIL stays — the tool's own
  semantics are a recent-activity tail, and the full log is one roster call away).
- `filetools.go` archive_extract: the 60-file listing cap dies (full listing);
  the inline ≤4,000-byte gate becomes ≤ `maxExtractSize` with the honest inline
  box (the artifact sink still saves every file — the model AND the user get the
  whole extraction).
- `filetools.go:119` archive_create + `:552-558` xlsx_create: the SILENT drops
  become honest — the output names every dropped file/row/cell count
  ("N files beyond 200 not added", "rows beyond 2000 not written") so the model
  can split its work. (Silence was the sin; the ceilings are physics.)
- `websearch.go:704`: full SERP snippets (the 300 clamp dies).

## §2 THE ONE TRUTH (v1.50.2) — the model-facing clamps die; budget lives in ONE place

- **In-turn** (`nativetools.go:514,558`): the fixed 24,000-byte clamp becomes
  CONTEXT-AWARE: `budget = (ContextLimitFor(model)·90% − est. tokens of the
  in-turn history) · 3.8 chars/token`, clamped to `[24,000 floor, no ceiling]` —
  a 200K-context model reading a 300KB file gets ALL 300KB; a small-context model
  gets the honest `ClampMarked` marker with totals (physics, announced — never
  silent). Unknown limit → generous 100K honest mark.
- **Cross-turn** (`toolfold.go`): `toolFoldBytes` 6,000 and the 12-pair stub law
  are DELETED — tool pairs ride history WHOLE (Redact stays: the pasted-PAT
  hazard law is security, not truncation). ONE pair = ONE window slot (unchanged).
- **The budget** = the existing auto-compactor (70% trigger, counts tool_result
  bytes since v1.29.4, keeps 35%) + the count window + the informational 92%
  guard. That is the single policy owner — the exact separation of concerns the
  user's OOP law demands.

## §3 THE HONEST MASK (v1.50.3) — hides reach the model history

`buildHistoryCompacted` builds the hidden-id set from the log's `hide` rows (the
`buildHistory` port — `chat.go:2375-2438`) and passes it to `foldSlots`. The event
scan whitelist gains `hide`. After retry/edit/regenerate the model's history and
the transcript AGREE — the dead turn truly leaves the context.

## §4 THE SINGLE VOICE (v1.50.4) — deltas fold; the seal dedupes

`foldSlots` (and maybeCompact's summarizer fold): an `assistant_delta` APPENDS to
the previous accumulating assistant slot (the `FoldedDone` mis-seal dies); the
full `assistant` event SEALS — it replaces the accumulated slot's content (the
seal is authoritative) or opens a sealed slot when none is accumulating. A
streamed reply rides context EXACTLY ONCE. `chat_v1153_test.go` re-pins from
"each delta is its own message" to exactly-once.

## §5 THE CONTINUE (v1.50.5) — the composer's fourth mode; the engine's continue frame

**Engine** (`chat.go`): a new WS frame `continue` → `handleContinueTurn`:
the shared lock/stale-takeover/busy prologue (busy = honest error + terminal,
no user event to orphan) · NO user event emitted · the trailing `error` rows are
masked engine-side (one persisted `hide` — the live frontend's existing hide
handler drops the bubbles) · history = buildHistoryCompacted · tail read:
last message assistant (partial/cut) → append the `seamNudgeText` user nudge;
last message user (the failed-before-content shape) → no nudge, the model simply
answers · dispatch through the same three paths (remote brain / brain / direct —
the direct proxy gains a continuation spec: no in-flight trim, nudge-if-any).
No template/bundle re-injection (a continuation continues; it does not restart
the method).

**Frontend** (`chatpanel.js` + `chatclient.js`): the retry mode dies everywhere —
`SEND_MODES`/`SEND_ICONS` gain `continue` (play-with-bar glyph); the auto ladder
arms it on a trailing error bubble OR a cut tail (`finish_reason:"length"` /
`output_cut` — now consumed at the terminal status and stamped on the last
assistant message); `doContinueSend` pops NOTHING and hides NOTHING client-side —
one `client.continue()` frame (`{type:'continue'}`), the engine owns the rest ·
every "tap Retry" string becomes "tap Continue" (`4714`, `6710`) · the
model-switch chip flow (the "— retrying" toast + `doSend` re-send) becomes the
continue frame — one mechanism for every recovery · `onRegenerate` (the
deliberate long-press re-roll) stays — it is not a failure retry, and §3 makes
its masks real so it can never duplicate again.

## §6 THE PROOF (v1.50.6) — rigs + the user's two live tests

- **Go battery:** fold-hidden pins (the PRODUCTION builder) · exactly-once delta
  pins (v1153 re-pinned) · full-output fold pins (a 100KB result rides whole) ·
  continue-handler pins (no user event; error tail hidden; nudge shape; busy) ·
  the cap tests re-pinned (skills/hublib/fleet/delegate/archive/xlsx/websearch
  full) · regressions: v1350, v1400, the full go suite, census + discipline pins.
- **RIG A — THE LOOP CONVICTION** (the user's test 1): a real engine + a real
  browser page + a REAL model turn through the app's own WS chat; a bound
  workspace; turn 1 reads a large real file and reports its findings; turn 2
  (fresh) asks for the findings WITHOUT re-reading — assert ZERO re-reads (the
  findings rode history) + matching answers. The pre-fix flip: turn 2 re-reads
  (the 6K fold ate the file) — the trippy loop, convicted live.
- **RIG B — THE ORIGINAL PROMPT** (the user's test 2): the workspace-pill-glow
  prompt, verbatim, through the app on a real model (a different provider than
  RIG A — Nvidia AND OpenRouter both exercised across the two tests, per the
  user's ask) — assert the turn completes, no repeated user echo, no repetition
  in the reply, tool pills render full.
- **RIG C — THE CONTINUE BUTTON**: send → stop mid-stream → the button reads
  continue → tap → the reply continues (new content, no repeated prefix, no new
  user bubble); busy-continue answered honestly; the model-switch chip rides the
  same frame.
- **RIG D — regressions**: v1350 62/62, v1400, node --check, the discipline pins.

## §7 THE SHIP (v1.50.0) + THE WILL-NOT BOUNDARY

Buildinfo bumps to **1.49.0** at ship time — renumbered past whatever stands
(the V148 wave owns the 1.48.x line by its sub-phase history; never trust the
1.47.0 reservation). README + OTA notes. REBASE before push (origin may have
moved — the parallel wave ships mid-flight): fetch → diff → merge-check → push.
**THE FINALE (the library ship) stays DEFERRED** until this wave lands — the
user's explicit order — and renumbers past whatever stands when IT ships.

**WILL-NOT:** the brain twins (dt_skills.py/dt_hublib.py/agent_core.py caps —
the HF-space surface, out of the engine's reach; the v1.47.0 precedent) ·
display-only glances (inline 2,000, overlay paging, live tail 4,096 — rendering
the same bytes, never data loss) · OOM physics guards (forge 64/100MB,
web_fetch 256MB, archive 32MB, termux's upstream 100KB — honest transport) ·
no AUTO-continue (V135's law: only the user's tap resumes; the engine never
silently restarts anything) · onRegenerate stays (deliberate re-roll, clean
post-§3) · no new surfaces, no hardcoded colors (the two-surface + theme laws).
