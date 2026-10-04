
---
Task ID: v0700
Agent: Super Z (main, continued session)
Task: Land the in-flight v0.70 THEME ACCURACY WAVE (the previous session
died mid-surgery: DoomGates derived-gates + accurate ink + nebula text +
the v070 suite, all uncommitted with 19 failing checks).

Work Log:
- Diagnosed the 19 fails: systematic arg-order bugs in the suite's
  check/has/nohas calls (the JSON passed as the NAME), the active theme
  was midnight while paint() targeted nebula, agent-browser eval returns
  JSON-QUOTED strings (adopted the v0651 ev() unwrap), .fmt needed a
  seeded assistant message, .sm-row needed the send-menu open, the pills
  needed the metadata dropdown OPEN (display:none = zero rect = the PROJ
  painter correctly skips), ERRS printed nothing when empty, and trim1's
  walk matched the BASE .hi-counts b rule (narrowed to [data-text-grad]).
- REAL implementation bugs found + fixed: (1) the derived-gates selector
  list only carried the gate prefix on the FIRST selector — 2..N were
  UNGATED (on-accent ink would fire on solid themes, the v0.66 regression
  reborn); (2) .wsp-pub-go leaked into the derivation (the var(--wsp-c,
  var(--accent-2)) fallback spelling) — the skip now covers .wsp/.wsx/
  .hub-libpill selectors AND values referencing var(--wsp (the explicit
  families are tone/prov-scoped in index.html); .wsp-pub-go got explicit
  per-provider gate rules (github/selfhost→a1, gitea→a2, gitlab→a3,
  sourcehut→a4).
- v070-accuracy-redteam.sh REWRITTEN: 27/27 (nebula seeded + theme
  switched, the dropdown opens, an assistant turn seeds .fmt, in-browser
  color canonicalization for the ink checks, the v42 ERRS pattern).
- Regressions on the rebuilt binary: theme twins 165, uikit 140, go test
  ok, v0642 47/47, v0643 30/30, v0651 53/53, v0680 81/81.
- Released: commit 473e967 (v0.70.0 THE ACCURACY WAVE).

Stage Summary:
- The theme accuracy wave LANDED: pills follow their assigned variables
  through the derived gates, chat text rides text-1's field, nebula
  ships its own text family, and the model/sandbox/mind/workspace pills
  render their accents' viewport projections under gradients.

---
Task ID: v0710
Agent: Super Z (main, continued session)
Task: The user's four asks: (1) the #xyz bundle badge follows the card's
color, (2) PM usage/tokens-in/out tracking, (3) use a WHOLE bundle via
the library (+ the bot reads docs and decides which skill/ext fits),
(4) quick chat must know how to search/use the library — verify the
superpowers bundle e2e, deep research template awareness, and 20+-tool
chains that never get interrupted.

Work Log:
- (1) hub.js flagStyle: the badge painted only the design's FIRST STOP
  (a flat amber chip on superpowers' amber→red→violet mesh). It now
  paints the card's OWN art (the same GradientUI css incl. mesh/texture/
  blend, else the bunch's hash gradient); ink flips by the AVERAGE stop
  luminance.
- (2) ROOT CAUSE: PM turns persisted the RAW OpenAI chunk usage
  (prompt_tokens/completion_tokens) while server/usage.go parses
  input_tokens/output_tokens — every PM turn unmarshalled to TURNS WITH
  ZERO TOKENS. pmsdk normUsage maps either spelling, mergeUsage SUMS
  across ReAct rounds (llm.mergeUsage parity — a 12-round turn reported
  one round's cost), and chatpanel's persist boundary normalizes AGAIN
  (bridge-agnostic belt+suspenders).
- (3) THE WHOLE-BUNDLE SEAM: hub.js's bunch view grows a ▣ use-bundle
  pill (the download pill's chrome); applyBundle (chatpanel.js) arms the
  chat — libAuto on, the ▣ chip (the tpl-chip mechanics), a localStorage
  manifest keyed by session (no engine migration), segPlusLabel shows
  the bundle — and runPMTurn passes state.bundle; pmsdk prepends THE
  ATTACHED BUNDLE block (the member manifest with type/name/desc/repo/id
  + the 4-step decision protocol: review → pick → LOAD via skills/hublib
  actions → follow + say which).
- (4a) THE ALWAYS-ON VOCABULARY: the v0.60 lib gate only armed the
  ACTION protocol when the pill was ON — with it off the model never
  learned the actions and GUESSED skills (the user's report verbatim).
  PM_LIB_ACTIONS now rides EVERY PM system message (the server gates
  load/download; the text names the 🛠 pill so refusals become
  recommendations, not retry storms); the bootstrap + 1%-discipline ride
  only under the gate. skills.go's refusal messages name the pill first.
- (4b) DEEP RESEARCH KNOWS ITSELF (PM): the flag only suppressed web
  tools — the engine's stage pipeline never runs on PM, so the bot was
  blind AND methodology-less ("doesn't know it is using a template").
  The 8-stage methodology now rides the system message ('you are running
  it NOW') and the web tools stay ON. MAX_ROUNDS 24→40.
- TESTS: v071-pm-loop-test.mjs NEW 18/18 — the REAL loop extracted and
  driven (the v28 pattern): a 25-tool chain with reasoning between
  rounds runs UNINTERRUPTED and finishes; >40 rounds exhaust gracefully
  with a forced final answer; usage normalizes + sums (2500/1250 over 25
  rounds); the vocabulary rides lib-off; the bundle manifest rides. 
  v071-bundle-usage-test.sh + v071-mock-hub.py NEW 19/19 — a mock HF hub
  (the hub_test.go pattern, standalone python) feeds the REAL engine:
  the bunch card + badge render, THE BADGE PAINTS THE CARD'S ART
  (computed backgroundImage byte-equal), use-bundle arms chip+gate+
  manifest+localStorage, the PM turn (stubbed bridge) carries the bundle
  opts, and /api/sessions/{id}/usage counts prompt/completion as in/out.
  SUITE BUGS fixed in-run: the bunch cards ride a TYPE's grid (click
  .hub-libpill[data-lib=skill] first), the library+bunch stack TWO views
  (pop to root before the chip/input checks).
- Regressions (fresh binary): v070 27/27, v0642 47/47, v0643 30/30,
  v0651 53/53 (one known duck-glide timing flake, clean twice after),
  v0680 81/81, v0621 19, v0623 16, v0624 13, v0640 56, uikit 140, theme
  twins 165, interrupt 65, pm-parser 32, go test ok. The v065 theme
  suite (249 screens) restarted EXCLUSIVELY after the first run was
  collateral-killed by a parallel battery (the known agent-browser
  session collision — never run browser suites concurrently with it).
- Released: commit 6ae9698 (v0.71.0 THE BUNDLE WAVE).

Stage Summary:
- The badge wears the card's art; PM tokens are tracked (normalized,
  round-summed, aggregated); a bundle attaches WHOLE and the bot picks
  the member per task; the library vocabulary always rides so quick chat
  searches instead of guessing; deep research announces itself and uses
  the live web; 25-tool chains run uninterrupted.

---
Task ID: v0710-addendum
Agent: Super Z (main)
Task: The rebase onto upstream's parallel waves + the push.

Work Log:
- Upstream had advanced 12 commits mid-flight (v0.67.2 LIBRARY ACTS,
  v0.67.4-5 HONEST GRID + PERSISTENT BUNDLE DOWNLOAD, v0.68.3, and
  v0.69.0 THE ACTIVE-BUNDLE PILL + DOWNLOAD GATE + METADATA PERSONAS —
  a parallel session's complementary take on the same library asks).
- THE REBASE (4 conflicted files, all resolved by MERGING semantics):
  · chatpanel.js — the chip's ✕ keeps my bundle-detach AND calls their
    armTurnBundle; armTurnBundle now derives state.bundle FIRST (an
    attached bundle outranks the single template — tool events still
    override live, the next user message re-derives); applyBundle calls
    armTurnBundle (the instant-show their applyTemplate gives); my
    segPlusLabel bundle line REVERTED (their v0.68 spec: the + stays a
    plain '+', the dedicated #seg-lib-bundle segment owns the name).
  · hub.js — upstream's registry-driven download pill (dlState/bdlEntry/
    dlPillTitle/dlPillInner/is-running/is-done) + paintDlPill kept
    verbatim; my ▣ use-bundle pill rides beside it.
  · index.html — their .hub-bundle-dl-fill progress CSS + my
    .hub-bundle-use twin kept.
  · pmsdk.js — the PM_LIB_ACTIONS merge: their "library is an ASSET, not
    a detour" anti-guessing line + their search-on-ask line JOIN my
    NEVER-guess + 🛠-pill-gate line, all riding the always-on vocabulary;
    the 1%-discipline stays gate-scoped (PM_LIB_DISCIPLINE).
- VERIFICATION on the rebased tree (fresh binary): v071 19/19 (the
  critical merge validation — chip + segment coexist), v070 27/27,
  v0642 47/47, v0643 30/30, v0651 53/53, v0680 81/81, v0621 19,
  v0623 16, v0624 13, v0640 56, pm-loop 18, pm-parser 32, interrupt 65,
  theme twins 165, uikit 140, go test ./... ok. The v065 theme suite's
  key phases re-run chunked post-rebase (p00/p07/p08/p09/p10/p13/p15/
  p16): 108 screens, ZERO console errors.
- PUSHED: main 809346f..ca3b246; tags v0.70.0-accuracy-wave (cde660f)
  + v0.71.0-bundle-wave (ca3b246). No Kotlin was touched this session
  (web + Go only) — the APK CI compiles the unchanged Kotlin from the
  v0.69-green tree.

Stage Summary:
- main @ ca3b246 (v0.71.0-bundle-wave), both waves shipped and rebased
  clean onto the parallel sessions' library work; the two bundle models
  (their per-turn ACTIVE segment + my persistent whole-bundle attach)
  compose into one UX: attach ▣ → segment shows the bundle → the bot
  loads the member it picks → the segment refines to that member.

---
Task ID: v0981-wave
Agent: Super Z (main, continued session)
Task: Land the in-flight v0.97.1 CATALOGUE & SHEETS POLISH WAVE (previous
  session died mid phase-E: code was done, rig/rebuild/push were not), then
  begin the v0.98.2 research turn (element catalog + library swap study).

Work Log:
- REBASE: stashed the uncommitted wave, fast-forwarded main to origin/main
  (upstream parallel bot had pushed v0.97.0 THE CANVAS WAVE + v0.98.0 THE
  FINISH WAVE — 4 commits, zero overlap with this wave's files; only the
  engine binary conflicted, resolved by rebuild). Re-versioned the wave
  v0.97.1 -> v0.98.1 (upstream took the 0.97.x line).
- Fresh sandbox had NO Go: installed go1.25.0 to /home/z/sdk (go.mod wants
  1.25.0). Rebuilt the binary with the merged tree + ldflags 0.98.1.
- RIG DEBUG (9/19 -> 19/19): the code was RIGHT, the rig had bugs —
  (a) FOUR uncalled-IIFE evals (agent-browser serializes a function object
  as '{}' — the nvidia save click, the wsx-connect click etc silently
  no-oped); (b) True/yes translation missing on one ck; (c) the picker
  loader is real but unobservable post-hoc (fresh engine resolves the
  empty globals list in ~20ms — rig-proven loader seen 19ms gone 24ms) ->
  added the fetch delay harness (1.6s on /api/workspaces + discover only);
  (d) the github account must be POSTed BEFORE the first picker open
  (v0.98 C5's 60s hydrateAccounts cache reads an out-of-band later add as
  stale).
- ONE REAL CODE FIX: wireSheetDrag's fling detector used raw instantaneous
  velocity — a sub-frame move pair read as an enormous px/ms fling and
  dismissed on a gentle pull. Now rides gesture.js's own discipline (its
  v0.42 fix): the 4ms dt floor + 0.7/0.3 EMA.
- KEY REFRESH: .secrets rewritten with the user's new batch (github,
  opencode, privatemode, nvidia, openrouter, hf, mistral mstrl_, new
  tunnel) — nvidia + github live-validated against the real APIs.
- VERIFIED: rig v0981 19/19 ALL GREEN (incl. the real nvidia key save ->
  cache bust -> reopen auto-sync, and the real github account -> 12 repos
  in the connect box), go test ./... ok, uikit 140, theme twins 165,
  v098-panel-colors 21/21 (upstream's suite on the merged tree; needed
  cp engine/bin/doomalay-engine /tmp/doomalay-engine for its fixed path).
- PUSHED: main 0881d47a..94a064ff + tag v0.98.1-catalogue-sheets-wave.

Stage Summary:
- The 8-issue batch is now FULLY closed (1-3 here, 4-8 by the parallel
  waves). Engine 0.98.1. Next: the v0.98.2 research turn (every element on
  every screen -> the swappable-element set list + MIT/Apache library swap
  study for the color system + gradient text perf) — NO implementation.

---
Task ID: v0982-research
Agent: Super Z (main)
Task: The user's research turn: push the previous wave (done: v0.98.1 above),
  then browse the repo for EVERY element displayed in EVERY screen and group
  each into the allowed swappable-element set + the final library-swap study
  for the v0.98 color system plan. NO implementation.

Work Log:
- Five parallel census agents read the full web surface (canvas world, chat
  surface, settings/appearance, overlays/connect flows, artifacts/library/
  shared kit) — every element carries file:line.
- 16 web searches (scripts/research-v0982/) for MIT/Apache library
  candidates + license verification.
- Synthesized docs/RESEARCH-V0982-ELEMENT-CATALOG.md:
  * PART A: the ratified 22-member set (user's 16 + editor box, list
    renderer, library card [user-anticipated, census-confirmed] + toast,
    meter, node [census-forced]) with fold decisions.
  * PART B: the complete catalog — every element on every screen mapped
    to one member (~400 elements, per-surface tables).
  * PART C: the border vs surface-raised evidence (8 file:line findings —
    the user's complaint confirmed) + the 10-vars -> FIELD model mapping
    table.
  * PART D: the library swap study — ADOPT culori (MIT, replaces
    shadeHex/mixHex/quantColor/OKLab blends), material-color-utilities
    (Apache-2.0, the image->palette pipeline), PixiJS extensions
    (NineSliceSprite/FillGradient/RenderTexture — already vendored),
    DTCG token format (the .doomtheme v2 keys). REJECT Shoelace/Lion/UI5,
    Style Dictionary runtime, node-vibrant, chroma. PRUNE wunderbaum
    (dead since v0.42), the .artt-* tree CSS shipped twice, keys.js rogue
    overlay + its hardcoded rgba(0,0,0,.48), localmodels duplicate X,
    .ts-star-on hardcoded #f5b642.
  * PART E: gradient text lag root cause (background-clip:text mask tax +
    fixed-attachment unsupported on Android WebView -> the L2 emulation
    cost) + the 3-tier verdict (ink never a window / static titles use
    local gradients / animated heroes use Pixi FillGradient).
  * PART F: how it feeds v0.99/v0.100/v0.101.

Stage Summary:
- The element catalog is the Batch-2 input the color plan was waiting for;
  the library study picks 4 adoptions (2 of them free — already vendored)
  and kills 6 homegrown/duplicated systems. Research only — nothing
  implemented.
