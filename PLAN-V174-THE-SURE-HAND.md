# PLAN-V174 — THE SURE HAND (the tool-reliability wave)

The user's seven bullets, verbatim intent:

1. "Still so many tool hiccups… the rate at which models fail to land tool calls is too high."
2. "Auto retry got armed which was correct but displayed that it will try to continue in 0:00?? Armed for 429 rate limit. Me manually pressing continue without waiting worked."
3. "The chat seemed to break out of its shell or intend to download something external when it wanted to rebase?!?! It started talking about how it wants to use termux instead cause our tools were causing issues?"
4. "One time I caught it saying we gave truncated returns??"
5. "Many times the model had to solve problems that it really shouldn't have… problems that threw it off for a thought or two."
6. "Sometimes the model does a tool call, it fails, but executes successfully. But the model goes on like regular as if it hadn't just failed. And why do they fail to begin with, can't we do stuff to prevent this."
7. (MOST IMPORTANT) "Our surgical editing tools + JSON or text tools are very limited and bad… we rely too much on JSON and text parsing when models don't seem like they want to do that… the model always has to find workarounds to surgically edit files, it has to create patches and fix mistakes that shouldn't happen because the toolset we have for editing is bad and we rely too much on a rigid structure. Isn't there some open source project/s that can help us with this."

## 0. The audits + the research (done first, per the standing loop)

Four parallel agents (records in the sandbox worklog, Task IDs audit-a/b/c + research-d):

- **audit-a**: the ACTION grammar is DEAD since v1.13.3 — the landing path is native tool_calls → argrepair ladder (5 outer + ~11 nested rungs) → mcpbus. The PHANTOM FAILURE (bullet 6) is convicted: `DetectToolFault`/`failedObservation` (llm/toolfault.go) line-scan EVERY line of every observation — a SUCCESSFUL read/grep/exec whose *output* contains an `error:` line makes the user see "tool hiccup — the call failed" while the model's history carries only the success (the notice never enters model context) — display says failed, execution succeeded, model goes on: the exact symptom. The same false positive skips the repeat-cache → an identical retry RE-EXECUTES → double side effects. The 0:00 pill is convicted: the sentinel Arm fires at server/chat.go:3157 BEFORE the error row persists (:3167 — the comment above it lies), so the armed pill lands ABOVE the error bubble; the PWA merge walk-back (chatpanel.js:5215-5223) breaks on the error row → every later phase row opens a NEW pill → the original armed pill orphans at its stale next_at → 0:00 forever (live and on replay). Manual continue → `Disarm` emits NO closing row → the live pill orphans the same way.
- **audit-b**: the surgeon (engine/internal/surgeon/edits.go) is exact → indent-flex, all-or-nothing (first bad edit aborts the whole call, nothing lands), nearest-line diagnostic by common-prefix only. Truncation is honest almost everywhere EXCEPT: (CONVICTION 1, HIGH) termux `patch` reads the file through the 100KB-bundle path and NEVER checks truncation before edit+write-back — patching any local file >100KB SILENTLY DESTROYS ITS TAIL; (CONVICTION 2) wsGrepText writes a LITERAL `\n` (verified backslash-n in source) and splits Remaining on the 2-char sequence → "1 candidate file(s) remain" always; (CONVICTION 3) mcpbus def.go declares `edits` as PropString while the parser demands an array — every schema-literal MCP patch call eats a teach-retry.
- **audit-c**: the rebase trap — the workspace tool is 100% forge-REST (no clone, no rebase/merge/cherry-pick) and NOTHING tells the model that; `{repo_access}` is silent, the persona says "Prefer DOING" even on chats with zero execution tools, the unknown-tool teach lines at chat.go:2302/2312 list 20-of-30 and 15-of-18 verbs (stale pre-V161 shapes re-taught exactly on the fumble path), termux `read` has no `range` (a drifted range arg is silently ignored → whole-file dump), and termux device rows leak into the cloud-workspaces block where they guarantee "lookup device: no such host" failures.
- **research-d** (the open-source answer the user asked for): **aider** (Apache-2.0) — the S/R-block engine: partial apply + the re-ask contract (failed block echoed, "did you mean these actual lines", "the REPLACE lines are already in the file", "the other N blocks applied — don't re-send them"), the `...` elision rung, marker leniency; polyglot data: whole-file 99.6% median well-formed vs S/R 94.2% — but S/R + the re-ask loop is what rescues mid models (chatgpt-4o: 64.4% well-formed → 45.3% pass). **Roo/Cline** (Apache-2.0): middle-out Levenshtein fuzzy + line-number-prefix stripping + teaching errors. **Anthropic's str_replace tool** (MIT reference): numbered `view` output as anchors + unique-match law + "review the changes" nudge. **jsonrepair** (ISC, Go ports exist): the deep JSON repair rung. Aider's measured verdict, quoted: "GPT is quantitatively worse at editing code if you use JSON/function-call formats… stuffing source code into JSON is complicated and error prone" — so the fixes lean on text-side leniency, never more JSON rigidity.

## 1. The phases

### v1.74.1 — THE HONEST FAULT LINE (bullets 1 + 6: the phantom failure)

Files: `engine/internal/llm/toolfault.go`, `engine/internal/llm/nativetools.go`, `engine/internal/mcpbus/bus.go` (IsError threading), `engine/internal/mcpbus/handlers.go` (web error prefixes), `engine/internal/mcpbus/jobwrap.go` (select race), `engine/internal/llm/chat.go` (busFailure text).

- **THE HEAD-LINE LAW**: `DetectToolFault` and `failedObservation` judge ONLY the observation's head (the first non-empty line after the `OBSERVATION:` prefix) — never content lines. A successful grep whose matches contain `error:` lines is a SUCCESS. The structured truth wins where it exists: the bus result's `IsError` flag is threaded through `busExecute` into the fault verdict (the string heuristic is the fallback, head-line bound).
- **The cache realignment**: a false-positive no longer skips the repeat-cache (a clean success caches); a REAL failure (`search error:`/`fetch error:` normalized to `error:` head prefixes) never caches. Termux TIMEOUT keeps its honest "may still be running" text AND its re-execute classification (never cached).
- **The hiccup notice honesty**: the notice text distinguishes `the call failed` (real) from `the observation reports a hiccup` (truncation/refusal mid-success); a truncation notice on a successful call no longer says "failed".
- **jobwrap's duplicate delivery**: the done+timer select race (ticket AND later settle both delivered) gets the once-delivery guard.
- **BusFailure "context canceled"**: when the lane survived (the job ticket exists), the text says the lane continues and the result lands after the fact — never "rephrase".
- Pins: TestV1741 — the log-file read with `error:` lines (no notice, cached, idempotent re-fire), the real failed call (notice + re-execute), the web error prefixes, the head-line boundary, the jobwrap once-law, the bus-failure text.

### v1.74.2 — THE SURGEON'S OATH (bullet 7 — the heart of the wave)

Files: `engine/internal/surgeon/edits.go` (+ new `partial.go`, `lenient.go`), `engine/internal/llm/workspacetool.go` (patch/commit verbs, read anchors), `engine/internal/llm/termuxtool.go` (patch verb, read range), `engine/internal/mcpbus/def.go` (schema honesty), `engine/internal/llm/wsParseEdits` paths.

- **THE PARTIAL-APPLY CONTRACT** (aider's law): `ApplyEditsPartial` applies every edit that lands, skips the ones that don't, returns per-edit outcomes. The workspace `patch`/`commit` + termux `patch` verbs commit the SUCCESSFUL edits and answer ONE honest observation:
  - `PATCHED — path (N of M edits applied)` + per-edit `exact|indent-flex|elision|fuzzy` lines;
  - per FAILED edit: the block echoed (old, clamped), **"the file's actual lines around the best match are:"** (a real similarity scan — Levenshtein ratio over lines, best window ± context — replacing the common-prefix-only diagnostic), **"the new text is already in the file — this edit looks already applied; verify, don't re-send it"** (the classic aider already-applied case), and **"the other N edits applied — don't re-send them; send only the fixed edit(s)"**;
  - 0-of-N applied = an honest `error:` head (a real failure: re-executes on retry, nothing double-applied).
- **THE LENIENCY LADDER** (research order, each rung honest and reported):
  1. input normalization: `\r\n`→`\n` on the model's old/new; **numbered-line stripping** — when every `old` line carries a `cat -n` prefix (`123│ ` / `123: ` / `123  `), strip and match bare (Claude Code's own known failure — and we are about to hand models numbered reads);
  2. exact (byte) — unchanged;
  3. indent-flex — unchanged;
  4. **elision** — `...` lines in `old` pair with `...` in `new`; each real piece must occur exactly once in order; the middle is spliced (aider's try_dotdotdots);
  5. **fuzzy** — bounded Levenshtein line-window match, avg ratio ≥ 0.90 AND every line ≥ 0.75, best-window only, reported as `fuzzy (NN% — verify the result)`. Wrong-place edits stay scarier than re-asks: the bounds are tight.
- **READ ANCHORS** (Anthropic's pattern): workspace `read` echoes `path · lines A–B of T · N bytes` in the head ALWAYS; `line_numbers:true` param numbers the lines `cat -n` style (default ON for ranged reads ≤200 lines). termux `read` GAINS `range` (parity: head/tail/lines, silently-ignored drift dies) + the same head echo.
- **SCHEMA HONESTY**: def.go `edits` PropString → the array shape it truly is; `termux.args` declares object-or-string honestly; the patch need-text teaches "for whole rewrites send content; for surgical edits send edits blocks" (the weak-model path stays first-class).
- Pins: TestV1742 ×N — the partial arc, the re-ask texts, already-applied, elision, fuzzy bounds (a 1-char typo lands; a wrong-window 0.7 miss refuses), numbered-old, CRLF, the multi-match contract intact, def.go spec shape, the read anchors.

### v1.74.3 — THE TERMUX TAIL (bullet 4: the silent data loss + the grep rendering)

Files: `engine/internal/llm/termuxtool.go`, `engine/internal/termuxbridge/client.go`, `engine/internal/llm/workspacetool.go` (wsGrepText), `engine/internal/grep/grep.go`.

- **THE 100KB TAIL LAW**: termux `patch`'s read rides the STREAM path (8MB); when even that truncates, patch REFUSES with the honest text — it NEVER writes back a truncated buffer. A regression pin proves a >100KB file's tail survives a patch.
- **The live detector**: the Go bridge client decodes `stdout_original_length`/`stderr_original_length` (the Kotlin bridge already sends them — termuxbridge/client.go drops them today); `termuxMaybeTrunc` stops guessing.
- **The grep NOTE fix**: the literal `\n` dies; `Remaining` splits on real newlines; the candidate cursor tracks the SCAN position (not the hit count); the workspace grep verb exposes `resume` (the cursor rides the REST shape that already exists).
- Pins: TestV1743 — the tail survival, the detector, the NOTE rendering (multi-candidate count > 1), the resume path.

### v1.74.4 — THE DEEP PARSE (bullet 1: the JSON landing)

Files: `engine/internal/llm/argrepair.go` (+ new `jsonrepair.go`), `engine/internal/mcpbus/handlers.go` (web teach texts).

- **THE JSONREPAIR RUNG** (the ISC algorithm, ported in-house — no new dependency): after the existing rungs, repair what they don't: single-quoted keys/strings, unquoted keys, trailing commas, `//`/`/* */` comments, ```json fences, Python `None/True/False`, smart quotes, bare NaN/Infinity, missing closers. The CUT verdict (mid-string truncation) keeps refusing honestly — jsonrepair never invents tail content.
- **The loud web texts**: web_search/web_fetch need-texts carry the call shape (the v1.70 loud-requirement law finally applied to the one family it missed).
- Pins: TestV1744 — the repair table (each shape in, valid JSON out), the cut-refusal survives, the web teach texts.

### v1.74.5 — THE 0:00 CLOCK (bullet 2)

Files: `engine/internal/server/chat.go` (arm ordering), `engine/internal/server/retrysentinel.go` (Disarm closing row), `engine/internal/server/web/chatpanel.js` (countdown honesty + stale guard).

- **THE ORDER LAW**: the sentinel Arm moves BELOW the error row's persist — the armed pill lands BELOW the error bubble and every later phase row merges into it (the walk-back no longer crosses the error).
- **THE CLOSING ROW**: `Disarm` (manual continue / new prompt / chat delete) emits a `recovered`-phase pill row with the honest note ("continued manually" / "new prompt") — the live pill closes, live and on replay.
- **THE COUNTDOWN HONESTY**: `retryCountdown` at/below zero renders `probing…` (a probe is in flight or imminent — never a frozen `0:00`); a live-phase pill whose next_at is > 15min stale (orphaned rows in already-persisted device DBs) renders dim `timer ended` instead of ticking.
- Pins: TestV1745 — the emit ordering (pill id > error id), the disarm row, the PWA source pins (probing/ended strings), replay orphan resolution.

### v1.74.6 — THE HONEST DOOR (bullets 3 + 5: the rebase trap + the friction)

Files: `engine/internal/llm/chat.go` (repo_access + persona conditioning + stale teaches), `engine/internal/server/ocservetools.go` (serve pick line), `engine/internal/llm/workspacetool.go` (device rows), `engine/internal/mcpbus/bus.go` (panic text).

- **THE API-ONLY TRUTH**: `{repo_access}` says it plainly: the workspace tool drives repos through the GitHub REST API — no local clone, no rebase/merge/cherry-pick; `sync` is the rebase eye; real git runs on the termux device. The rebase trap dies at the source: the model never again discovers the limits by failing.
- **The stale teaches die**: the unknown-tool teach lines derive their verb lists from the REAL verb sets (single source of truth — the same slice the dispatch switch rides).
- **The scratch-dir truth**: the serve pick line names the shell cwd as the per-chat scratch dir (the real files live behind doomalay_workspace/doomalay_termux).
- **The persona conditioning**: "Prefer DOING" only when an execution tool is actually armed; otherwise "describe exactly what should run".
- **The device-row split**: termux rows leave the cloud-workspaces block (their own line, the right client) — the manufactured "lookup device: no such host" dead-end dies.
- **The panic text**: "the engine recovered; retry the SAME call" (the anti-simplification law).
- Pins: TestV1746 — the teach derivations, the repo_access line, the persona conditioning, the row split, source pins.

### v1.74.7 — THE LIVE PROOF

`scripts/v1740-sure-hand-rig.mjs` (port 8740, THE DEPLOYMENT LAW) — the fake provider + the fake termux bridge + the real binary:

- LEG A THE PHANTOM LAW: a successful read of a log full of `error:` lines → no hiccup notice, cached, idempotent re-fire; a real failure → notice + re-execute.
- LEG B THE OATH: the partial arc end-to-end (2 good + 1 bad edit in ONE call → 2 land + the re-ask with actual lines + already-applied + don't-re-send); the elision patch; the fuzzy patch (typo lands, wrong-window refuses); numbered-old; the read anchors; the 0-of-N honest failure.
- LEG C THE CLOCK: the 429 arm → pill below the error row → probes merge into ONE pill → manual continue → the closing row → replay: one closed pill, zero orphans, zero 0:00.
- LEG D THE TAIL: a >100KB termux patch (the fake bridge) — the tail survives or the call refuses honestly; the grep NOTE renders with real newlines + the true candidate count.
- LEG E THE DOOR: the {tools} block carries the API-only line; the unknown-tool teach lists the real verbs; the web teach texts.
- THE BATTERY: v1740 ×3 stable + the regressions (v1730 34/34, v1670 34/34, v1720, v1710) + the new unit pins ×5 + go build + vet + the package batteries + the cross-compiles (linux + android-arm64).

## 2. The discipline

- COMMIT AFTER EVERY GREEN PHASE (the rebuild-sandbox conviction).
- No new tools (the census stays 34) — only params + texts + engines.
- Theme tokens only in every PWA touch; no hardcoded colors.
- Push each phase; the wave ships as buildinfo 1.74.0 + the tag v1.74.0-the-sure-hand. The +1 law: if a parallel bot ships mid-wave, renumber (plan file, tests, rigs, labels) before the ship.
- Before ANY push: fetch, diff, check merge errors, merge amicably.
- The tunnel is DOWN — sandbox rig proof now; the device redteam at the next tunnel-up (and delete the leftover "v173 rig check (deleted after)" chat).
