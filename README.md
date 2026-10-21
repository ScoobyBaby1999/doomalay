## v1.52 THE SURGEON (PLAN-V152) — the chat-honesty fixes + surgical editing + the autonomous push

- The user's ask verbatim: "I've attached the trippy logs, u can read the ends to see if any new insight on issues with our chat. We want to fix as much issues with our current chat implementation before we build more. Defer the library ship once more. Not until we can have percise edits for artifacts and external and internal repos. We need an unbelibably solid tool for this." + "We need the bot to be able to seamless push from its local repo to the cloud repo using our strict push philosophy on its own."
- THE DIAGNOSIS (the (2).md log, read in full — the bot's own final-turn self-diagnosis included): SIX issue classes convicted — (1) engine restarts kill turns mid-flight ("interrupted by engine restart" ×2, 5,600 events of work, zero durable output — "I asked for very simple requests and nothing was done"); (2) the same user message persisted 5× (every failed send re-persisted); (3) DNS death was TERMINAL (isTransientNetErr had no DNS class — the pause ladder never ran); (4) the 600s termux exec black hole; (5) the 69,775-byte workspace tree flood ×3 (~210KB of context); (6) THE MASKED FAILURE (convicted LIVE by the v1520 rig: a 403 emitted its error chunk then returned nil/nil/nil — the callers read SILENCE, the failed turn fell through to the "(the model returned an empty response…)" note + terminal IDLE: a provider failure masked as success, the no-dup law disarmed, continue never arming).
- v1.52.1 THE DNS RUNG — the DNS class (no such host | no address | lookup | dns | SERVFAIL) joins isTransientNetErr: a DNS outage rides the pause ladder (fresh-dial retries, the bounded hold, the suspended mode) instead of an instant terminal; friendlyError gains the DNS/offline class ("Network trouble… tap Continue when you're back online") — and the net-hold's exit lost its last "Tap Retry" string (the continue-only law).
- v1.52.2 THE NO-DUP SEND — a re-send of the FAILED last turn's own text is a CONTINUE in disguise: sendIsFailedRepeat (the last user row == the text AND the last terminal is error — an 8,000-row tail window so a 5,600-event flood still finds its row) dispatches the resume and persists NOTHING; the busy-reject's same-text shape persists no second row either. The 5-tap storm = ONE user row.
- v1.52.3 THE HEALED SEAM — the boot heal ANSWERS a restart-killed turn's dangling tool_use with the honest never-ran truth ("interrupted by engine restart — this call never ran; re-issue it if still needed") BEFORE the healed terminal (now carrying "hint":"continue") — the history fold DROPPED unanswered uses entirely (the model lost the knowledge it made the call; provider wires that validate the tool_use→tool_result chain got invalid shapes). The composer arms CONTINUE on the healed seam (the _interrupted stamp — live AND replayed; tool pills never own the tail verdict).
- v1.52.4 THE HONEST TREE — past 200 entries the tree verb's DEFAULT view is the DIR SUMMARY (every top-level dir with file counts + sizes, direct files, honest totals, the two narrowing verbs); {"recursive":true} returns the full listing VERBATIM — a smarter VIEW, never a truncation (the v1.19.1 whole-truth law holds). The ls-at-root no-op filter is FIXED (ls at / = direct children — the old code leaked the full recursive dump).
- v1.52.5 THE BLADE — engine/internal/surgeon: the ONE edit engine (EXACT match → INDENT-FLEX recovery with re-indentation of the replacement to the file's own indentation → the NEAREST-CONTEXT miss diagnostic naming the closest line; all/occurrence resolution that never guesses; DiffPreview unified-style, hand-rolled LCS, zero dependencies). Surfaces: the workspace `patch` verb (read a range → edits[] → dry_run preview or the sha-guarded API commit) + the termux `patch` verb (the SAME engine on local jailed files) — the OOP law: one truth, no twin drift. The research verdict honored: search/replace blocks applied in-memory + whole-file write IS the industry pattern (Claude Code Edit / the MCP filesystem server's edit_file v2 / Aider); unified-diff application is the brittle minority.
- v1.52.6 THE ONE COMMIT — forge CommitFiles (the GitHub git data API: branch head → base_tree → POST /git/trees with inline content + sha:null deletes → POST /git/commits → PATCH /git/refs/heads/{branch} force:false — THE STRICT-PUSH GUARD; a 422 answers "the branch moved under you — re-read and re-apply", NEVER forced) + the workspace `commit` verb (multi-file: edits | content | delete | rename_from, ONE atomic commit, the per-file report).
- v1.52.7 THE SYNC EYE — forge CompareRefs (base...head with each side's changed files since the merge-base) + the workspace `sync` verb: ahead/behind, the files base moved (with the ⚠ ALSO-CHANGED-ON-YOUR-BRANCH overlap marks), and the verdict — disjoint changes → pr_merge method:rebase lands cleanly; overlap → re-branch from base and re-apply the surgical edits. The rebase awareness the strict-push protocol demands BEFORE every push.
- THE HONEST TERMINAL (the rig's live conviction, fixed in-phase) — a provider HTTP failure (403/401/…) now ends the turn TERMINAL ERROR: the errHTTPAlreadyEmitted sentinel marks failures whose friendly chunk already rode (emitTurnError owes only the terminal — no double bubble; the plain-path drain is sentinel-aware through llm.IsAlreadyEmitted). The masked empty-response-idle shape is dead.
- THE LLM ARG COERCION (the rig's second live conviction) — dry_run:"true" (a STRING — the classic LLM shape) skipped the preview and committed directly; wsArgBool/editArgBool/termuxArgsBool now coerce the honest string forms ("true"/"1"/"yes"), and occurrence accepts strings too.
- THE PROOF (scripts/v1520-surgeon-rig.py — real engines + the real browser page + REAL model turns through the app's own composer): RIG A 15/15 (A1 the no-dup law LIVE: 5 same-text sends → EXACTLY ONE user row, 5 honest errors, the composer arms CONTINUE; A2 the healed seam: the REST-seeded dangling tool_use → engine REBOOT → the synthesized never-ran answer + the continue hint + the composer arms continue; A3 the DNS face: the log's verbatim netx error renders friendly, the raw string gone, the affordance is Continue) · RIG B 10/10 (the blade LIVE on Nvidia glm-5.3-flash through the app: the scratch repo bound, 8 tool calls, dry-run FIRST, the PATCHED commit, the GitHub truth = the glow flag flipped surgically, renderPill/enableGlow untouched, the old line replaced not appended) · RIG C THE GLOW PUSH (the finale, run post-ship: the bot pushes its glow feature as a sub-wave x.x.# COMPLETELY ON ITS OWN through the new tools). Go battery 17/17 packages green (the new surgeon package aboard).

## v1.50 THE UNLOST MIND (PLAN-V150) — the trippy chatlog fixes: the whole return, the one truth, the honest mask, the single voice, the continue button

- The user's report verbatim: "despite the push to stop truncated returns on tool pills we still have some tools pills that slipped under the cracks and return truncated returns. All tool pills must return the entirety of the output. This is a weird bug as the UI that renders the tool pills output for the user seems to be fine and return the full output even if it's a extremely large file. If they don't use the same methods then how is that working with our OOP standards for loose coupling and best coding practices" + "the chat repeating itself. It should always be caught up, matter of fact, rework the (retry) botton that we have (the one alogslide send, queue, and stop) and turn it to a continue botton. No more retry whatsoever existing in the app. Only continue, continue exactly where it left off. Or as close to exactly as possible."
- THE OOP ANSWER — the pill UI and the model never shared a path: the pill rendered the persisted tool_result event (full since v1.19.1) while the model path re-clamped through THREE independent sites (the v0.38 24,000-byte in-turn clamp, the v1.30.4 6,000-byte cross-turn clamp + the 12-pair stub law, and the tool-level caps the push never swept). ONE source of truth restored: the persisted event feeds both; the fold renders SHAPE (no policy); budget policy lives in exactly ONE place (the auto-compactor + the context-aware in-turn guard).
- v1.50.1 THE WHOLE RETURN — every tool-level cap dies: skills read 8000 / load 40000 / search top-8 / the hublib 6000-12-3000-40000 family + 14 clip sites · delegate 2000 · fleet roster 30 + detail 90-char snips (the known JSON shapes render field-by-field, full text) · archive_extract 60-file cap + 4000-byte inline gate (the DESIGNED 400KB ceiling remains) · archive_create + xlsx_create silent drops become NAMED drops · web_search snippet/title collection clamps.
- v1.50.2 THE ONE TRUTH — the fixed 24,000-byte in-turn clamp becomes CONTEXT-AWARE (turnObsBudget: 90% of the model's documented window minus the in-turn history, floor 24,000, honest ClampMarked totals when physics says no); the 6,000-byte cross-turn clamp + the 12-pair stub law are DEAD (every tool pair rides history WHOLE — Redact stays: the pasted-PAT law is security, not truncation). Budget = the auto-compactor (70% trigger, counts tool_result bytes) + the count window + the 92% guard.
- v1.50.3 THE HONEST MASK — buildHistoryCompacted builds the hidden set from the log's hide rows (the old foldSlots(liveEvents, nil) sent a nil map: every retry/edit/regenerate hide was ignored by the PRODUCTION history builder — the model kept seeing the dead turn + the re-sent user message = the chat repeating itself).
- v1.50.4 THE SINGLE VOICE — deltas ACCUMULATE into one slot, the full assistant event SEALS (replaces the accumulated prefix); the old first-delta-sealed-itself made every later delta its OWN model-history message plus the full event as another copy — a streamed reply rode context N+1 times (in-context self-repetition + window flooding).
- v1.50.5 THE CONTINUE — the retry era is over: the WS 'continue' frame + handleContinueTurn (NO user event ever re-persisted; trailing error rows masked engine-side; the SeamNudgeText nudge for the cut shape; the plain answer for the died-before-content shape) + the frontend 4th-mode swap (arms on a trailing error OR a cut tail — finish_reason length / output_cut consumed from the terminal usage; every "tap Retry" string dies; the model-switch chip rides the same frame).
- THE PROOF (scripts/v1500-unlost-mind-rig.py — real engines + the real browser page + REAL model turns through the app's own composer): RIG A the loop conviction 9/9 (turn 1 reads the 55,336-byte skills.go in ONE call; turn 2 recalls 10 function names + BOTH deep-tail doc comments VERBATIM with ZERO tool calls; the pre-fix flip: 14-tool-call storm + the tail comments GONE — the trippy loop convicted live) · RIG B the original prompt 5/5 (Nvidia GLM works the real repo task: the 145,832-byte workspace.js read WHOLE, 52 tool rounds, no loop, exactly-once prompt) · RIG C the continue button 10/10 (stop mid-stream → menu continue → NO new user event, new content, zero errors). Go battery 16 packages green on the merged tree (the pocket-bridge + seen-signal waves aboard).

# Doomalay

A sovereign self-hosted AI workspace with maximal capability.

## Architecture

```
Go Engine (universal runtime) + Python Brain (Strands agent, full tools)
+ PWA (spatial canvas, physics-driven chat icons)
```

**PrivateMode is engine-native** (v1.44 PLAN-V144, v1.45 PLAN-V145, v1.46
PLAN-V146): PM chat turns ride the engine's own E2E-encrypted wire —
`engine/internal/pm` vendors the MIT-licensed half of Edgeless's pure-Go
client (PROVENANCE.md records every delta), the engine pins the deployment's
mesh CA (TOFU; PM chats work on the pin with ZERO wasm), and the engine's
PM client dials through `netx` like every engine outbound (v1.45.1 — the
Android DNS fix; the vendored Go-default dialer was the one that died on
real devices). The ONLY thing licensed to run Edgeless's BSL-1.1 attestation
verifier is their own MIT-distributed wasm artifact (`web/vendor/pm/`), and
it runs STRICTLY on demand (v1.45.4 — the provider card's explicit "verify
attestation" button; nothing loads wasm automatically, at connect or
anywhere else). Net honesty (v1.45.2): a single provider being unreachable
while others work is reported as THAT provider being down ("your
connection is fine") with a bounded hold, never a fake "network
unreachable" — the infinite patient-engine wait stays reserved for true
device-offline shapes. The co-located brain rides
`POST /api/pm/local/v1/chat/completions` (api-key-fallback=never).
Reasoning honesty (v1.46): PM's gateway (vLLM 0.31) emits every reasoning
delta in BOTH wire spellings (`reasoning` + `reasoning_content`,
byte-equal — the rename compat shim); the engine's alias law
(`mergeWireReasoning`) merges the pair into ONE copy so PM-native thinking
streams clean (the "every word appears twice" bug), and the provider's own
`reasoning_tokens` share of the completion rides the usage ledger end-to-end
(the 🧠 stat on the usage panel).

**The seen signal** (v1.48 PLAN-V148 — every phase live-convicted with a
pre-fix flip): **the single echo** — every user message reached the model
TWICE on every provider since the brain-history build (the turn persisted
the user event before history assembled, then appended it again; the brain
appended it a third time on its path) — `trimInFlightUser` now drops the
log's own trailing copy (byte-equal match only; no history byte is ever
dropped) at both construction sites, and a stub-provider probe counts the
real wire payload (`:2` pre-fix, `:1` post). **The live stars** —
connecting a workspace never refreshed the orbiting stars until the icon
was physically moved: the worker clone cache only re-sent entities when
the position-based checksum changed, so a session bound at rest left a
`sessionId:''` clone and the painter skipped the icon; the sig now folds a
memoized per-entity session hash and the count-change signal forces one
clone-bearing frame. **The direct plus** — the ＋ badge on a workspace row
adds it to the chat in ONE press (its own click, `stopPropagation`, the
same bind chain the expanded pill runs). **The informative pill** — the
workspace tool's collapsed pill speaks its verb + operand
(`grep | readme`, `view | issues`, `pr_diff | #12`) instead of the static
`workspace | repo` fallback: the full verb table off the tool's own param
grammar. **The serve bridge** — OpenCode's FREE models at last, the honest
way: the hosted API's free tier is walled below-HTTP to OpenCode's own
clients (byte-faithful CLI-identity replays still 403), so the engine
manages the GENUINE client itself (`engine/internal/ocserve`: the pinned
1.19.3 CLI, the gate-law permission config — execution + writes denied —
one serve session per chat, THE RECYCLE LAW on the free-tier wall,
persona/context riding the message text, reasoning deltas → thinking
events, serve's own tokens + reasoning share on the usage ledger). On the
desktop engine `big-pickle` and friends stream live through the engine's
own WS protocol; where the bridge cannot run (Android — the CLI is
glibc-linked), the honest copy names the wall, the desktop truth, and the
alternatives.

**The pocket bridge** (v1.49 PLAN-V149; v1.51 PLAN-V151 THE SECOND
TONGUE) — OpenCode's free models on ANDROID, the honest way with the
fewest gates Android allows. The official CLI has no Android build (glibc
+ non-PIE; upstream closed it as not-planned), but guysoft's
opencode-termux line cross-compiles OpenCode NATIVELY for Android/Termux
aarch64 — the engine provisions that client itself: with Termux installed
and the one-line bootstrap run (both existing doomalay flows), ONE TAP on
the OpenCode card's "Install OpenCode" drives the whole thing through the
app's jailed-exec path — download (the pinned 72.5MB opencode2 v1.0.3-rc3
= OpenCode 2.0.0-android, SHA256-verified) → unzip (+ the retired 1.x
files leave best-effort) → the 2.x gate-law permission config → a
wake-locked `opencode2 serve` on the shared loopback. The WHOLE bridge now
speaks the OpenCode 2.x serve API (PLAN-V151): the desktop pin is the npm
@opencode/cli 2.1.2 tarball (sha512-verified against the registry's own
integrity — OpenCode 2 ships as npm; GitHub releases stay 1.x), the serve
is HTTP-basic-auth (the password derives stably from the key so a pocket
serve that outlives the engine stays adoptable), the turn flow is session
create → model select → text-only prompt → the v2 SSE vocabulary, and the
usage ledger carries serve's own tokens + cache + cost (0) end-to-end. Free-model turns
run through the engine's own WS protocol with serve's own usage on the
ledger; an engine restart adopts the live serve instead of stacking one,
a died serve re-provisions itself, and every missing gate answers its own
honest state on the card (Termux missing → the setup hand-off; no key →
the key prompt; a dead bridge → the wall + alternatives). Desktop
behavior is byte-unchanged.

**Two new native hands + a retired bridge** (v1.47 PLAN-V147): the
engine's tool registry grew to 31. `djournal` — the personal journal
(the authentic Go port of `brain/tools/dt_journal.py`: moods, tags,
highlights, gratitude, energy, day streaks, rotating prompts, weekly
reviews, md/json exports) — one append-only diary per install at
`<data-dir>/journal/entries.jsonl`; exports also land in the chat's
artifact drawer. The port is pinned byte-for-byte against the Python
spec itself (`engine/internal/djournal/djournal_parity_test.go` runs
both implementations over one scenario — banker's rounding, the
own-zone date law, and the JSON entry shape all agree exactly).
`fleet` — the other-chatbots roster + detail (the A2A agent-card
grammar over the engine's own truth: title/model/canvas/live state/
turns, the q filter, and one chat's full card with its CURRENT action
from the live events tail + the running/idle turn-gauge truth).
And the old PM bridge's orphaned `/api/tools/*` tool-server routes are
GONE (the WebView-bridge chat that consumed them died with the native
PM; a full-tree sweep found zero consumers) — the mcpbus, `/mcp`, and
the brain's `/api/pm/local` bridge all stay.

## Structure

```
doomalay/
├── engine/          # Go — HTTP/WS, SQLite, secrets, sandbox
├── brain/           # Python — Strands agent, templates, panel, tools
├── app/             # PWA — Vite + React 19 + PixiJS + Matter.js
├── platforms/       # Platform-specific files
│   ├── android/     # Kotlin + Chaquopy APK
│   ├── windows/     # NSIS installer (future)
│   ├── linux/       # AppImage (future)
│   ├── macos/       # .dmg (future)
│   ├── ios/         # PWA-only (future)
│   └── hf-space/    # Docker (app-building machine)
├── docs/
└── scripts/
```

## Quick Start

```bash
# Setup brain (one-time)
cd brain && python3 -m venv .venv && source .venv/bin/activate && pip install -r requirements.txt

# Build + run
make build-engine
./engine/doomalay-engine
# Opens http://localhost:8080
```

## Dev

```bash
make dev  # 3 terminals: engine, brain, PWA hot-reload
```

## Platforms

| Platform | Build | Download |
|---|---|---|
| Android | `make build-apk` or CI | GitHub Releases (.apk) |
| Windows | CI | GitHub Releases (.exe) |
| Linux | CI | GitHub Releases (AppImage) |
| macOS | CI | GitHub Releases (.dmg) |
| HF Space | `make build-hf-space` | Docker image |

See `docs/` for platform-specific setup guides.
