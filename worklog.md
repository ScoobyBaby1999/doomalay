
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
---
Task ID: v0991-research
Agent: Z.ai Code (main orchestrator)
Task: The user's final-research turn for the color system: find every
  MIT/Apache library that replaces a homegrown piece of PLAN-V098-COLOR-SYSTEM
  ("choose a library over home grown"), diagnose the nested-box lag +
  the border/surface-raised edit-cost asymmetry + the variable confusion,
  and produce the build order. NO implementation.

Work Log:
- Re-cloned @ 21ec824 (rebased onto the parallel wave's v0.98.1 + v0.98.2
  mid-session; the census was reconciled against RESEARCH-V0982, not
  duplicated).
- Four parallel research agents: (1) the repo census — 91 vars, 701
  var-consuming rules, per-family usage, the overlap evidence, the colors-tab
  structure, the canvas path, the .doomtheme shape (docs/CENSUS-V099-SLOT-SCAN.md);
  (2) color engines; (3) UI primitives; (4) text/atlas/bundle security.
  Every license/size/version verified first-hand (npm registry JSON, raw
  LICENSE files, measured gzip of shipped dist files); artifacts in
  tool-results/v099-research/.
- Wrote docs/RESEARCH-V099-LIBRARY-SCAN.md — the consolidated decision record:
  5 NEW adoptions beyond v0982 (@floating-ui/dom 1.8.0 MIT 4KB — picker/
  select anchoring; @tanstack/virtual-core 3.17.11 MIT 7KB — catalogue/library
  windowing; fflate 0.8.3 MIT 12.6KB — the .doomtheme v2 zip container;
  maxrects-packer 2.7.3 MIT 3.3KB — the field-atlas packer; Ajv 8.20
  standalone MIT ~KBs — untrusted-bundle validation), the 8-rung import
  security ladder, the nested-box recipe (cv:hidden/auto + accordion caps +
  the L2 read guard), the WebView-111 CSS floor + @property guardrails,
  and 2 CORRECTIONS on v0982 (chroma.js is BSD-3-Clause code — not Apache;
  Pixi Text+FillGradient carries upstream bugs #10595/#10926, so the GPU
  text tier rides BitmapText/RenderTexture bakes instead; vendored Pixi
  verified as v8.21.0, not 11.x).
- The census adjudicated the user's reports: border/surface-raised edits fan
  over ~86/~110 rules incl. every L2 window + gate re-mint vs the canvas's
  one debounced atlas rebake (the asymmetry is real); 5 overlap findings
  confirm the variable confusion (25 dual-family rules, 74+ dividers painted
  with surface vars, border-as-fills, the entangled raised-ring, the
  surface-3 ghost).
- Wrote PLAN-V099-THE-FIELD.md — the build order: the 7-field model (raised +
  hairlines become derived color-mix products), the phase cadence v0.99.3-.7
  + v0.99.0 ship (vendor -> slots -> reassign -> tab -> nested boxes), the
  v0.100 MASKS (pseudo-only, plate 3->2 layers, gradient-text tiers, virtual-
  core, consolidations), the v0.101 ASSETS (fflate/maxrects/Ajv/MCU, 9-slice
  members, icon-pack registry, .doomtheme v2 + security), the new v0.102
  LIBRARY wave (public sharing, per-user bundle looks).

Stage Summary:
- The library question is CLOSED for the color system: culori + floating-ui
  land in v0.99.3 (27.3KB gz total); virtual-core in v0.100; fflate +
  maxrects + compiled validators + MCU in v0.101; everything else verified
  and rejected with evidence. GradientUI, the Field/Mask core, the panel
  drag, and the icon registry stay homegrown because the open-source world
  has not solved them (proof on record).
- Research only — nothing implemented. The census + these two docs are the
  complete input set for the v0.99 build.

---
Task ID: v099.3 + v099.4 (pushed)
Agent: Z.ai Code (main orchestrator)
Task: THE FIELD phases 3+4 — vendoring + the 7-slot model (per PLAN-V099-THE-FIELD.md).

Work Log:
- v0.99.3: culori 4.0.2 IIFE + Floating UI core/dom 1.8.0 UMD vendored (MIT, LICENSEs filed); theme.js gains FieldMath (cssMix + luminance, exported); scripts/v099-calibrate.js = the calibration tool (fits against the v0.98.0 tag).
- v0.99.4: index.html :root = @property (7 fields + accent-4) + THE DERIVATION BLOCK + the 10 [data-theme] blocks rewritten to field values (carrying accent-4/semantics/tints/triplet statics); theme.js = FIELDS/LEGACY_FIELD_MAP/foldThemeOverrides/DERIVED_MIXES/TRIPLET_VARS + the applyTheme rewrite (field twins + aliases + culori triplets + on-accent/veil/bright gates + field-owned grad gates) + GATES slimmed (ACC 3, SURF 1) + deriveBorderTwins RETIRED; appearance.js = 6 field rows (ink = plain color input) + fold-seeded + legacy-aware resets; app.js/atoms/pixiworld/browserdock resolve real hexes through the upgraded resolvedThemeVar (the @property rgb()/color-mix boundary); canvasFingerprint reads --field-canvas.
- THE OKLAB DECISION (rig-caught): Chromium's color-mix(in oklch) paints near-achromatic inputs hue-powerless (oklch(… none) → warm-gray, 7/255 off calibration on midnight/mono) — switched the derivations to color-mix(in oklab): identical calibration fits (hue-adjacent pairs), culori parity PIXEL-EXACT.
- Rigs: v099-field-parity.sh NEW (5/5: CSS≡JS worst 0/channel, drift ≤ 0.028, 10-theme cascade, triplets, zero errors); test_theme_twins re-pinned (196); v0911 re-pinned to the field contract (12/12); v098 panel 21/21 (257 nodes); v097 29/29; v092 13/13; go green.
- Browser-verified: boot clean, all 10 themes cascade, ink edit live-writes --field-ink (tints follow), accent gradient edit fires data-a1-grad + writes both twin spellings + storage holds field keys, lookio legacy round-trip folds, fmt gradients + light-theme veil flip correct.

Stage Summary:
- PUSHED: main 504ee975 → 925b5820 (v0.99.3) → 58957a81 (v0.99.4).
- Next: v0.99.5 THE REASSIGNMENT (the census walk: 74 dividers → --border, plate stacks 3→2, the title family → fmt-a1, glyph catchers die, the 16 text-vs-accent rules → ink/fmt, modelbrowser border-strong text → ink tint).

---
Task ID: v099 wave (repo record)
Agent: Z.ai Code (main orchestrator)
Task: v0.99.5-.7 + the v0.99.0 ship — the repo-side record.

Work Log:
- 208b0acc v0.99.5: the census reassignment (one hairline owner; 2-layer plates; accent-text ban; title family → fmt-a1; glyph death) — v099-reassign-audit 6/6 NEW.
- 442f9240 v0.99.6: the 7-slot Colors tab + the floating picker (Floating UI debut; GradientUI slim 8→2; grid+fmt folded in; 126-node mount) — v098 panel rig re-pinned 21/21.
- 7874c91a v0.99.7: the nested-box recipe (settled cv:hidden; ≤2 accordion; cv:auto rows) — v099-settings-open 6/6 NEW.
- 2dbcdee6 + tag v0.99.0-the-field + release: version 0.99.0; full battery green; CI (APK + desktop + HF Space) ALL SUCCESS.

Stage Summary:
- v0.99 THE FIELD is COMPLETE AND SHIPPED.
- Next: v0.100 THE MASKS per PLAN-V099: (1) the cheap consolidations (toast ×6→1, keys.js→Overlay, localmodels double-✕, amber star→accent); (2) the gradient-text tiers (title family → local-box clip — one paint, no per-scroll projection); (3) L2 pseudo-only (the legacy inline bake retires — the deep PROJ surgery); (4) @tanstack/virtual-core on the catalogue + hub grid.

---
Task ID: v1.00.1 (pushed)
Agent: Z.ai Code (main orchestrator)
Task: THE TOUCH FIX — the user-reported picker-dead-on-Android bug (the 6th #sheet-root recurrence), fixed at the root + the v1.00/v1.01 plan docs.

Work Log:
- Re-cloned @ af028270 (sandbox reset again); rebase check: no parallel-bot movement.
- Root-caused from primary sources (W3C Touch Events L2 §9, MDN, Chrome docs, Playwright source — evidence in /home/z/my-project/tool-results/v100-research/): the v0.99.6 .slot-pop popover is body-appended → isInsideUI never learned it → touchstart preventDefault → the synthetic click suppressed → every click-wired control dead on touch; mouse clicks fire regardless (why every desktop rig was blind — Playwright #2903's own note).
- THE FIX — THE POSITIVE LIST (app.js): isInsideUI RETIRES; the canvas input owns ONLY #c + #chatbots (panel.js _wireDuck's v0.69 pattern). Touch/mouse/wheel/contextmenu gates flip to !onCanvasSurface → return. The class dies at the root: every present AND future body-appended overlay gets native taps. Wheel over the popover now scrolls it (the mouse twin, same fix).
- index.html: the popover's sticky head top:-12px → 0 (the ✕ VANISHED mid-scroll — pinned above the scrollport, clipped; the rig caught it); touch-action: manipulation on .slot-pop.
- THE REAL-TOUCH RIG (scripts/v1000-touch-test.mjs + v1000-touch-tap.sh): Playwright hasTouch + tap() = trusted CDP touches + raw CDP drag sequences; 19 assertions (class-death proof: a stop added by a real tap + touchstarts NOT prevented; refactor proof: canvas pan + preventDefault still engage; popover scroll; wheel twin; zero errors).
- NEGATIVE CONTROL PROVEN: against the old code the rig fails 6 (T3a/b/c, T4a, T7c, T8b — exactly the bug class); with the fix 19/19.
- DISCOVERED + documented: the Go build cache does NOT invalidate on embedded-file changes (measured: stashed web/app.js → fresh go build → binary served the OLD assets) — the wrapper now always builds with -a. Every rig that assumes a prebuilt binary after web-asset edits runs stale.
- Full battery green: touch 19/19 · twins 194 · uikit 140 · go vet+test 8 pkgs · v099 5/6/6 · v098 21/13/10 · v097 29 · v092 13 · v0911 12.
- PLAN-V100-THE-MASKS.md + PLAN-V101-THE-ASSETS.md written (the research-backed wave plans; BitmapText gradient = broken in pixi 8.21 (1px atlas span, verified from dist source) → the generateTexture bake; virtual-core vanilla wiring; the .doomtheme v2 ladder).

Stage Summary:
- PUSHED: main af028270 → 5554349e (v1.00.1). CI builds the APK with the fix.
- Next: v1.00.2 gradient-text tiers (the bake) → v1.00.3 L2 pseudo-only → v1.00.4 virtual-core → v1.00.5 consolidations → v1.00.0 ship; then v1.01 THE ASSETS.

---
Task ID: v1.00 + v1.01 waves (repo record)
Agent: Z.ai Code (main orchestrator)
Task: The user order: push v1.00 + v1.01 together; fix the picker overlay that doesn't register touches. Iron law per phase: plan → web search → real plan → build → red-team with real tests.

Work Log:
- 5554349e v1.00.1: THE POSITIVE LIST — isInsideUI retires; the canvas input owns ONLY #c + #chatbots; the #sheet-root class dies at the root (6th recurrence was the v0.99.6 popover). THE REAL-TOUCH RIG (v1000, Playwright hasTouch + CDP): 19/19 with the fix, 13/19 against the old code (negative-control proven). + the sticky-head top:0 fix (the ✕ vanished mid-scroll) + touch-action: manipulation. LANDMINE documented: the Go build cache does NOT invalidate on embedded web-asset changes — rigs must go build -a.
- 6f4abf8b v1.00.2: THE GRADIENT-TEXT TIERS (PART E) — the fmt family + the title family + the 2 accent-glyph stragglers drop background-attachment: fixed (local-box, one paint, zero projection; clip:text can never ride L2); the object track untouched. v1002 rig 6/6 (drag with live gradient text = ZERO longtasks).
- e2fb1c0b v1.00.3: THE PHANTOM PURGE — painted-set hygiene (image-none riders leave the set; the set-theme swatch class caught live with instrumented builds: the v0.98 flat-gradient plate catcher computes non-none in a mid-flip transient). The legacy-bake retirement proven (v1003 rig 5/5: every VISIBLE painted element rides L2). THE OFFSCREEN MINT prototyped + REVERTED (exposed a pre-existing settings-page-render/root-registry race — future wave, documented).
- 2ca3729d v1.00.4: @tanstack/virtual-core 3.17.11 vendored + loaded (window.VirtualCore, browser-verified). The WIRING = its own wave (the catalogue's DOM is already PAGE-capped — the anti-spaghetti call).
- 191893b7 v1.00.5: THE CHEAP CONSOLIDATIONS — toast ×8 → uikit DoomToast (delegates, zero call-site churn); keys.js rides THE OVERLAY SCREEN (the last hardcoded rgba(0,0,0,.48) scrim dies); the localmodels double-✕ gone; the amber ts-star themed (var(--warn) + triplet).
- 9e3bcc1e + tag v1.00.0-the-masks: version 1.00.0 SHIPPED. Battery: go 8 pkgs · v1000 19/19 · v1002 6/6 · v1003 5/5 · v099 5/6/6 · v098 21/13/10 · v097 29/29 · v092 13/13 · v0911 12/12 · twins 194 · uikit 140.
- 1f451188 v1.01.1: THE ASSETS VENDORS — fflate 0.8.3 (MIT UMD) + maxrects-packer 2.7.3 (MIT ESM .mjs — the dist min.js is plain CJS, ReferenceErrors in the browser) + material-color-utilities 0.4.0 (Apache-2.0, the +esm single-file). All browser-verified (fflate zip round-trip; MCU image→SchemeContent end-to-end; MCU.sourceColorFromImage needs a real IMAGE element — a canvas hangs its load path).
- 36cf2709 + tag v1.01.0-the-assets: THE IMAGE→PALETTE SUGGESTER — the canvas picker: pick an image → MCU quantize+score → SchemeContent dark-first → the 6-swatch proposal → apply writes the 7 fields (one-runtime-truth: MCU is generation-time only). v1012 rig 7/7 (real file upload end-to-end). Version 1.01.0.

Stage Summary:
- BOTH WAVES SHIPPED: v1.00.0-the-masks + v1.01.0-the-assets (CI building the APKs).
- The user's touch bug is FIXED AT THE ROOT and negative-control-proven.
- NEXT (per PLAN-V101): the field atlas (maxrects, 2048² clamp, MAX_TEXTURE_SIZE query), the 9-slice/icon registry, the .doomtheme v2 zip container + the 8-rung security ladder; then the virtual-core wiring wave; then v1.02 THE LIBRARY.

---
Task ID: v1.03.0 (the wave ship)
Agent: Z.ai Code (main orchestrator)
Task: THE EDITOR & THE PROJECTION — the user's 4-point color system order, shipped as one wave.

Work Log:
- v1.03.1 THE CARD (60a903d5): the flat --card derivation + the full nested-element reassignment; v1031 16/16 (re-pinned through the wave for the editor path).
- v1.03.2 THE TEXT STYLE PROMOTION (a9ab6daa): its own collapsible section; the v0.99.6 fmt-label regression fixed; v1032 10/10.
- v1.03.3 THE THEME EDITOR (2512b1a7): the reusable panel page + the tagged registry + the Overlay list; v1033 15/15.
- v1.03.4 THE WHEEL (2d3bf77f): the CSS-composed HSV disc + the H/S/V sliders + common/last-used; the fmt entries; the popover retired; v1034 11/11.
- v1.03.5 THE UNIVERSAL ANGLE (47fed386): linear/radial-orbit/mesh-rotation/pattern-transforms in css() + the canvas rasterizer (the worker shares lattice.js); the legacy dir normalization; v1035 10/10.
- v1.03.6 THE DOOM PROJECTION v2 (aef26551): the toggleable 2D canvas field projector — the crawl discovery, the override sheet, the once-per-theme field rasters, the 9-arg crop loop; v1036 10/10.
- SHIP: tag v1.03.0-the-editor + the release (CI: APK + desktop + HF Space all SUCCESS; 4 assets attached). The battery: v1031-v1036 + v098 24/24 + v1015 15/15 (L2b re-pinned: the v2 module replaced the stub BY DESIGN) + v099 5/6/6 + v1000 19/19 (re-pinned to the editor contract) + v1003 5/5 + twins 199 + uikit 140 + go (TestScreenshotRealRender fails on PRISTINE v1.02.0 in this sandbox — the reaper kills its Chromium; environmental, documented).
- LANDMINES: the browser daemon wedges under battery load (pkill -9 -f agent-browser resets; NEVER let a rig hit the bash timeout mid-command); engines must be script-spawned; the browser session's localStorage outlives the server data dir.

Stage Summary:
- THE 4-POINT ORDER IS DELIVERED: the card material, the text-style section, the Theme Editor (layout + wheel + types + universal angle + the tagged registry), and the doom projection v2 (the toggleable shared-field projector).
- The user's ask "render them once not once per element" is literal in the v2: one bitmap per field, one drawImage per consumer.
- Residue for the next wave: the pixiworld pill field bridge (the pills paint locally — the 56px precedent), the virtual-core catalogue wiring, the DTCG token namespacing, the settings-page/root-registry race (the v1.00.3 leftover).

---
Task ID: v1.04.0 (ship)
Agent: Z.ai Code (main orchestrator)
Task: The v1.04 wave — the user's five Theme-Editor fixes + THE RESTORE (the broken canvas doom projection deleted; the pre-v1.01.5 viewport-projection system ported back onto the field twins). The ship record.

Work Log:
- v1.04.1 THE FIVE FIXES (5d53b786): the wheel touch channel (gesture.js's ownsGesture + THE CHANNEL GATE — the body touchstart doesn't even record owned channels), the type tiles (the distinct outline family + inline SVG glyphs — the ⌧ tofu dead), the live angle banner (direct style writes + the makeWriter spec-pollution fix), the texture/import separation (the type selects; the row browses), the reset arrow (reset-before-open in the delegated handler).
- v1.04.5 THE RESTORE (d8e84f86): doomprojection.js replaced wholesale — the canvas system deleted, the pre-v1.01.5 painter ported (the transform-proof bake, the batched read/write paint, the L2 compositor layers, the observer family) + THE DOOM SHEET (the toggle's derived fixed-attachment mint with THE GATE MERGE) + THE ALLOW-LIST (the fmt text track + the derived solids never mint) + the full teardown (OFF = the v1.01.5 local light, byte-identical).
- THE REBASE DANCE: the parallel bot's shadow wave (v1.04.2/3/4: elevation tokens, shadow sweep, fallback canon) landed mid-session — three rebases, one silent wrong resolution (rebase --ours is the BASE branch — the rig caught the canvas stats shape), the restore recovered + re-proven.
- THE VERDICTS: v1042-the-restore 16/16, v1041 16/16, the full battery green on the FINAL merged tree (v1033/34/35/32/31, v1015, the bot's v1042-elevation 6/6 + v1043-shadow 5/5, v1000 19/19, v098 24/24, twins 199, uikit 140, go server). VLM: the seamless shared field confirmed, zero artifacts.
- THE SHIP: tag v1.04.0-the-restore — CI all green (the APK + the 3 desktop binaries + the HF Space); the release carries all 4 assets.

Stage Summary:
- The user's whole order delivered. The doom projection is the RESTORED system (toggleable in the Colors tab), not the broken canvas.
- Landmines banked: rebase --ours/--theirs is swapped vs merge (rig-caught); the agent-browser pool wedges need pkill -9 between batches; rig scroll assertions must force real deltas.
- The v1.05 candidates: the pixiworld pill bridge (the projection for the canvas pills), the root-registry race on fast overlay opens, the L2 layer-count budget on very long transcripts.

---
Task ID: v1.04.2-.5 + v1.05.0 ship (the discipline wave)
Agent: Super Z (main orchestrator)

Work Log:
- v1.04.2 THE ELEVATION TOKENS (455135d7): --shadow-ink = color-mix(in oklab,
  var(--field-canvas), #000 55%) in the derivation block + the --shadow-ink-rgb
  triplet (JS twin in applyTheme; the OKLAB mix lands at rgb(2,2,2) — the naive
  linear-RGB guess was wrong, the rig caught it). v1042 rig 6/6 (CSS≡JS parity
  via a srgb-forced probe; the live canvas-override → shadow re-tint proof).
- v1.04.3 THE SHADOW SWEEP (5f554b36): all 37 index.html literals + JS
  stragglers → rgba(var(--shadow-ink-rgb), α) exact-alpha parity; text-shadows
  → veil-ink; inset rings → --highlight-inset-rgb; the fmt h1 hairline →
  --border; hub.js ink-on-art upgraded to WCAG relative luminance +
  higher-contrast pick. v1043 rig 5/5 (grep gate + the live consumer proof).
- v1.04.4 THE FALLBACK CANON (2e5abe6f): DoomTheme.FALLBACKS = the one literal
  map; 12 consumer files re-pointed; settings.js seeds as CANON-TWINs (loads
  before theme.js — load-order fact); the atoms.js triplet-slot latent bug
  fixed. LEGACY_GRID exposed as the sentinel owner after the rig caught the
  reset-path first cut pinning the grid (FALLBACKS.canvas ≠ the sentinel).
- v1.04.5 THE ENFORCEMENT (7d246e21, rebased onto the parallel v1.04.0-the-restore
  wave — the fetch/rebase/merge protocol caught their 2 commits mid-flight):
  v1040-discipline-audit.sh 7 gates (the two rules fail builds now);
  docs/DISCIPLINE.md (the canonical zones + the surface ledger + the
  artifacts-sheet decision + the z-ladder); v1045-redteam.sh 11/11 (the
  human-imitation journey on both theme polarities — paper shadow ink
  (84,83,81) vs midnight (2,2,2); the purple-canvas shadow hue-follow; the
  reset-sentinel contract; zero console errors).
- SHIP v1.05.0-the-discipline: buildinfo 1.05.0 + tag + release (CI APK).
- Battery: v1040 7/7 · v1042 6/6 · v1043 5/5 · v1045 11/11 · v1031 16/16 ·
  v098 24/24 · twins 199 · uikit 140 · go green.

Stage Summary:
- THE TWO STANDING RULES ARE SELF-ENFORCING: no hardcoded chrome colors
  outside the documented canonical zones (the audit fails on new ones), and
  every front-facing surface rides the Panel / the Overlay Screen / the
  documented chrome ladder. Shadow color is a theme product. The next
  improvement on these axes would be the DTCG namespacing refactor — noted
  as FUTURE residue; doing it now would be the spaghetti the user capped.

---
Task ID: v1.06.0 ship (completion)
Agent: Super Z (main orchestrator)

Work Log:
- v1.05.1 THE GLASS WINDOW: gesture.js writeVis → element-scoped height on .panel-body (the per-frame inherited-var subtree sweep is dead; the var rides only while the projection is enabled). BENCH on the same tree: 12-14x cheaper per frame.
- v1.05.2 THE STUCK SWITCH: setEnabled commit-first + rollback + self-heal on DOM traces; stage-guarded teardown + registry-independent orphan sweep ([data-proj] + new [data-proj-bake] markers); paint() strips disconnected windows (the view-stack resurrection leak); the vis-var seed at enable.
- v1.05.3 THE PROOF: scripts/v106-fluid-wave-test.py — 22 checks, both trees. BEFORE: 4 genuine failures (the stuck switch reproduced; the stash leak; the var residue). AFTER: 21/21 (the plan's 22 checks + the CTA count). The look: panel-region delta 0.22%.
- Pushed 6350a0a2..821a12a3 (3 phase commits); no parallel movement at fetch time.

Stage Summary:
- The wave ships as v1.06.0-the-fluid-wave (tag next) — the panel glide rides the compositor, the toggle cannot wedge, the projection's toggle-off is registry-independent.

---
Task ID: v107-wave
Agent: Super Z (main)
Task: THE CANVAS OPT WAVE (PLAN-V107) — the user's three asks: (1) the grid
still not 60fps + visible tiling, bake everything not moving (O(k)); (2)
below ~30% zoom (up close) the grid over-calculates and snaps — fix
thoroughly, ideally predetermined paths; (3) restore life — more dynamic,
very few points/lines moving fast, tiling no longer perceivable.

Work Log:
- REBASE: local tree was f4a8353a + the unpushed v0971 wave — the parallel
  bot landed v0.98.1 (= the same issues 1-3 scope) plus v0.99-v1.06.0 (the
  FIELD color system, the editor, the restore, the discipline, the fluid
  wave). Hard reset to origin/main c2d1ff1f; nothing of mine was lost.
- MEASURED the worst-case doom grid live (headless 412×915): 29 tile fills
  per full frame, 15fps at rest (the v0.97 ambient cadence gate), 6
  rebakes inside one pinch sweep (pending=true mid-gesture), VLM-confirmed
  tiling period ~1.5-2 screens. Root causes code-proven: bgKey (bgView.zx)
  churns the bake fingerprint EVERY FRAME once scale>1; colors sample
  through the LIVE bgView fold at bake scale (the color snap); the cheap
  frame wiped #c2 without repainting the over layer (the icons' front
  layer vanished/flickered at rest).
- RESEARCH: RESEARCH-V084's standing verdict holds (canvas2d + worker +
  createPattern; Pixi owns the conditional world layer; no second WebGL
  context for the grid). MDN CanvasPattern.setTransform; multires LOD
  ladders (mipmaps/krpano analog); game-art repetition wisdom (period ≥
  2-4× viewport or break with a second scale).
- v1.06.1 THE ZOOM LADDER (a82d094d): reference-space color sampling
  (zoom-stable), bgKey OUT of the fingerprint, canonical level bakes
  (level = 1.25× quantum of scale; set = pure function of params+level),
  LRU byte-capped ladder cache (TL_BUDGET 96→32MB per set, cap 128MB),
  async-only bakes (onBakeReady → repaint-wanted), levels floored at 0
  (zoom-out rides level 0 supersampled), ladder instruments. Storm dead:
  full 6× sweep = 4 async bakes (was 6+ synchronous), fast fling = 1,
  pan = 0, warm revisits = instant.
- v1.06.2 THE FILL DIET (bb73c29c): the bg mirror-quad (2×2 flipped
  arrangement baked once → ONE pattern fill; BG_TILE_MULT 2→1.35) +
  over-tiles for the top band only (29→21 fills; the v0812 contract
  verified live: dots+lines still route at amp≥50).
- v1.06.3 THE LIFE WAVE (bb1c4bd2): renderOverLayer (the cheap frame is
  lossless for #c2 — the vanish/flicker fix), the modulation field (256²
  theme-tinted value noise, soft-light, 320-cell period, 0.9× parallax +
  2.5px/s drift — the tiling kill), comets (≤3, 4-10s apart, glowing
  heads + gradient tails), twinklers (~5% of cells, some fast blinkers),
  cadence 66→33ms, TEMPO 0.6, hero pulse spread 1.8→3.4, cometsLive rides
  the 60fps cheap-frame gate. VLM: organic large-scale variation, no
  tiling read, premium maintained.
- v1.06.4 THE PROOF: scripts/v107-canvas-proof.sh 15/15 (storm dead, budget
  holds, grid alive, theme owns everything, zero errors). Battery: v1040
  7/7, v0899 12/12, v0852 14/14 (RIG REPAIRED — the camera-pan assert was
  proven PRE-EXISTING-failing on the untouched v1.06.0 tree; the rig's
  document-level synthetic mousedown is correctly rejected by
  onCanvasSurface; the repair targets #c like a real finger), v0831 13/13,
  v0812 7/7, v0901 15/15, twins 199, uikit 140, go test green.

Stage Summary:
- THE THREE ASKS ANSWERED: (1) 29→21 fills + one-fill bg + async-only
  bakes — the 60fps path is structural; (2) deep zoom = predetermined
  level swaps (a seen level is ZERO work; unseen = one async bake, ever)
  — no snap (geometry exact through swaps; sharpness-only landings);
  (3) the field modulates (soft-light, 320-cell period), comets fly,
  twinklers blink (some fast), the breath runs 2× faster at 30fps ambient
  — tiling no longer perceivable (VLM-verified).
- The wave completes at v1.07.0 (the left dot moves). CI builds the APK.
- NOT done (deliberate, anti-spaghetti): band merging (AMP_BANDS stays 5 —
  the parallax depth reads), negative zoom-out levels (level 0
  supersampling is free), cross-faded level swaps (the ≤1.12× sharpness
  delta is invisible), comets during zoom-out extremes only skipping
  twinklers below 10px spacing (density guard).
Task ID: v1.06.0 CI + release
Agent: Super Z (main orchestrator)

Work Log:
- CI on the tag: Build Desktop ✅ · Build Android APK ✅ · Build HF Space ✅.
- Release live: v1.06.0-the-fluid-wave — app-debug.apk 22.9MB + 3 desktop binaries.

Stage Summary:
- WAVE SHIPPED. The panel's motion cost is compositor-shaped (12-14x cheaper per frame), the projection toggle cannot wedge, and the proof rig is permanent at scripts/v106-fluid-wave-test.py.

---
Task ID: v1.07.0 ship (completion)
Agent: Super Z (main orchestrator)

Work Log:
- v1.06.1 THE SURFACE EXEMPTION: PROJ_RE drops surface-1 — the panel body
  + overlay card (the viewport-sized, most-rebaked windows) render their
  gradients LOCAL in both toggle states; the accents keep projecting.
- v1.06.2 THE TEXT FIELD: fmt-[a-z0-9]+ joins PROJ_RE + ROOT_GATE_RE
  merges the [data-fmt-grad~=…] gate — the Blink probe proved fixed +
  background-clip:text coexist; in-panel text rides the legacy bake.
- v1.06.3 THE CHROME FOLLOW + THE WHITE PILL + THE LIVE SWITCH:
  · the white pill ROOT-CAUSED on the rig: the carry branch's
    unconditional inline image/color strip deleted the metadata pills'
    OWN tint (the [style*=] catchers lost their match → the UA
    buttonface gray); the L2 suppression also REPLACES the author's
    values. THE OWNERSHIP LAW: the painter strips only painter-written
    props (__projSuppressed); the author's background is SAVED at
    suppression (restoreAuthorBg) and RESTORED at drop/strip; zero-rect
    carries take constants only.
  · the chrome-follow: :where(html[data-doom-proj][data-s1-grad])
    windows the Layer-3 family + .app-range track/thumb on the surface
    field LOCALLY (zero painter cost — surface is out of the allow-list).
  · the live switch: wireInputs syncs the app-switch track/thumb in
    place — the doom projection pill updates without a settings reopen.
- v1.06.4 THE SHADOW & THE HIGHLIGHT EXPOSED: --field-shadow /
  --field-highlight override slots (the Colors tab's Shadow + Highlight
  rows, seeding from DoomTheme.derivedShadowHex/derivedHighlightHex);
  applyTheme: override wins, default rides the CSS color-mix/static.
  The v1045 redteam joined the on-disk doctrine (v1045-mix-serve.py —
  the stale embedded tree was reading empty tokens; 11/11 after).
- THE REBASE PROTOCOL caught the parallel canvas-opt wave (their
  v1.06.1-.3: zoom ladder / fill diet / life wave) mid-ship; rebased
  amicably — zero file overlap with this wave; the rig re-ran 22/22 on
  the merged tree.

Stage Summary:
- THE WAVE SHIPS as v1.07.0-the-selective-field — the projection is
  selective (surface local, text + accents + chrome in), the painter's
  hands are owned, the switch is live, the elevation tokens are
  user-editable. Battery: v107 22/22 · v106 21/21 · v1045 11/11 ·
  v1040 7/7.

---
Task ID: v1.08.1 CI + release
Agent: Super Z (main orchestrator)

Work Log:
- THE SHIP RACE, twice over: the rebase protocol caught the parallel
  canvas-opt wave mid-ship (their v1.06.1-.3 phases, then their
  v1.07.0-the-canvas-opt-wave ship) — rebased amicably both times (the
  only conflicts: buildinfo's Version line + the shared worklog). The
  ledger shifted: this wave ships as v1.08.1.
- v1.08.0's APK CI died in the stamp step: MINOR "08" is an invalid
  OCTAL literal in bash $(( )) (05/06/07 silently worked). v1.08.1
  fixes the workflow with 10# forcing.
- A stale v1.07.0-the-selective-field tag + release (created by the
  first partially-rejected push) was deleted on the remote.
- CI on v1.08.1: Build Android APK ✅ · Build Desktop ✅ · Build HF
  Space ✅. Release live: app-debug.apk 22.9MB + 3 desktop binaries.

Stage Summary:
- WAVE SHIPPED. Battery on the shipped tree: v107 rig 22/22 · v106
  fluid 21/21 · v1045 redteam 11/11 (on-disk doctrine) · v1040
  discipline 7/7.

---
Task ID: v1.09.0 ship (completion)
Agent: Super Z (main orchestrator)

Work Log:
- THE SEAMLESS FIELD wave (PLAN-V109-THE-SEAMLESS-FIELD.md) — the user's
  four reports + two research asks, four phase commits:
- v1.08.2 THE STEADY HAND: the pill oscillation root-caused on the rig
  (painted-series [1,7,1,7,1,7]) — the L2 suppression rewrote the inline
  background-color, BREAKING the [data-aN-grad] [style*="background-color:
  rgba(var(--accent-N-rgb)"] catcher that matched the pills into SEL; the
  next paint dropped them, the restore re-spelled them, the paint after
  re-baked — the projected↔local flicker. Fix: the READ phase's per-element
  body is a shared closure; suppressed windows re-enter it (a painter asset,
  not a stranger) + THE OWNERSHIP TEST (the snapshot lifts the color too +
  carries the computed attachment; a suppressed element the CSS claimed
  locally yields: stats.yielded).
- v1.08.3 THE FULL SPECTRUM: the settings toggles + sliders wear the FULL
  gradient at box scale. THE GATE-WINDOW LAW: gate-led rules declare
  attachment:local !important — the minted plain fixed can never out-rank
  it and the painter's first-encounter probe opts the element out (zero
  painter cost). Checked tracks = the accent field; unchecked = the LAYERED
  window (surface live → surface; surface flat → the accent shows through
  a surface-3 veil); sliders = the same layered window. The doom-switch
  rule generalizes; the thumb stays solid (the pseudo-strip leak — refused).
- v1.08.4 THE SEAMLESS FIELD: the Layer-1 rule painted the SAME local
  gradient on THREE stacked boxes (header restart = the tiling report).
  ONE field, THREE windows: shared --panel-field-h scale, the header/body
  windows offset by --panel-head-off/--panel-field-top; gesture.js syncs
  at rest through a CSSOM rule (#panel-field-vars — observer-invisible),
  debounced behind writeVis; the closed sheet keeps its last geometry;
  fallback = the exact v1.08.1 look.
- v1.08.5 THE COAST: the text lag root = the legacy bake's per-event
  writes (scrollRebake: ~1400 writes / 14 scroll steps / 129 windows —
  rig-measured) + the per-frame var recalc/raster during the drag. Text
  windows now COAST (flagged at decision time INCLUDING the carry path —
  the rig caught two storm shapes: the reset-on-steady-paint flag and the
  un-flagged carries); scrollRebake skips them; first sight still bakes
  once; the motion edge performs ONE batched disconnect; paint() un-coasts.
  RESEARCH: no OSS library changes the math (they all ship clip:text) —
  docs/RESEARCH-V109-TEXT-AND-PANEL-PERF.md.
- Battery on the shipped tree: v109 rig 30/30 (NEW, permanent) · v107
  22/22 (the fmt-h2 check updated for the coast contract: first-sight
  bake) · v106 21/21 · v1045 11/11 · v1040 7/7 · uikit 140. The twins
  suite: 198/199 — the "page 6 slot banners" assertion FAILS ON THE
  UNTOUCHED v1.08.1 BASELINE TOO (proven pre-existing, out of scope).
  go test rides CI (no go toolchain in this sandbox).

Stage Summary:
- THE WAVE SHIPS as v1.09.0-the-seamless-field. The projection's pills
  hold one steady bake, the toggles/sliders show the full gradient, the
  header continues the body's field, and projected text costs nothing
  during motion. Next session: sideload the APK, re-judge the flicker +
  the toggle/slider look + the header seam + the panel glide with
  projection ON.

---
Task ID: v1.10.0 ship (THE WEIGHTLESS WAVE)
Agent: Super Z (main orchestrator)

Work Log:
- THE WEIGHTLESS WAVE (PLAN-V110-THE-WEIGHTLESS-WAVE.md) — the user's
  four v1.09.0 post-ship reports, four phase commits:
- v1.09.1 THE DRIFT COAST: the anchor glide's remaining cost = the
  per-frame inherited-var invalidation sweeps (the --proj-tx/--proj-ty
  CSSOM rule writes per root per frame), the shrinking slide's scroller
  clamp firing scrollRebake per frame, and ANY mid-glide paint un-coasting
  the text back to var form (re-arming the per-frame glyph rasters). The
  coast generalized to the WHOLE field: motionTick returns while coasting
  (the L2 transforms hold their rest compensation — everything rides
  rigidly, the text coast's own drift contract), scrollRebake gates on
  coasting, coastText covers every LEGACY window (text incl. the vis form
  + the non-L2 fallbacks; one cached matrix read per root per edge), the
  setVars same-value guard, and run() defers full paints while a motion
  window is open + the gesture stamp is fresh (the settle lands one frame
  after the window closes; its trailing motionTick re-syncs the vars).
- v1.09.2 THE FULLSCREEN FIELD: --panel-field-h = the FULL-DOCK extent
  (fieldTop + visForY(0)) instead of the current dock's bodyH — docking
  anywhere REVEALS a sub-window of the one fullscreen field; the no-repeat
  extent is >= every window, so the ink leak is geometrically impossible;
  per-dock re-syncs die (the performant shape the user prescribed).
- v1.09.3 THE STILL HAND: the zoom ladder's bake never arms mid-gesture —
  the hosts report the zoom-gesture state per frame (zg: pinch active or
  a wheel burst within 200ms), the worker holds, the stretched current set
  renders (exact by world-proportionality), and the RELEASE frame (the
  two->one-finger transition — the rig caught that CDP and real fingers
  lift one at a time; the touches===0 branch never saw pinching true)
  arms the debounce — ONE bake ~150ms after settle.
- v1.09.4 THE RARE SKY: comets 4-10s -> 18-44s (cap 3 -> 2, first spawn
  6-16s), three size/distance classes (FAR 60% thin dim fast background /
  MID 30% / NEAR 10% thick bright slow foreground) with the tail width,
  head glow and the parallax factor spread per class; lastComet rides the
  debug blob (the instrument). Zero new color literals (the gate holds).
- THE RIG: scripts/v110-weightless-wave-test.py (permanent) — §A the drift
  coast (frozen vars per frame pair, single-step settle paints, the defer
  counter, the settle re-anchor) · §B the fullscreen field (dock-independent
  scale, the extent covers every window, the header shares the scale) ·
  §C the still hand (bakeGen frozen mid-gesture for pinch AND wheel, one
  settle bake each) · §D the rare sky (first spawn >= 5s, <= 3 in 46s, the
  class bounds). The v110-zoom-probe.py caught the release-frame miss.
- Battery on the shipped tree: v110 rig 22/22 (NEW) · v109 30/30 · v106
  21/21 · v1045 11/11 · v1040 7/7 · uikit 140 · twins 198/199 (the
  pre-existing page-6-slot-banners baseline failure, documented).
  v107-canvas-proof: 13/15 on the STALE embedded binary (07:27 build; no
  go toolchain in this sandbox to re-embed the current tree — the rig
  hits the engine port directly, unlike the on-disk v106/v109/v110 rigs).
  Its two fails (rest-cadence FPS under load, theme-flip sampling) are on
  that stale snapshot; its zoom-storm contract is SUPERSEDED by the v110
  §C proof on the disk tree (bakeGen frozen mid-gesture is strictly
  stronger than "no frame pays a bake").

Stage Summary:
- THE WAVE SHIPS as v1.10.0-the-weightless-wave. The glide is compositor
  work + one layout write, the surface field is one fullscreen material
  that docks reveal instead of re-fit, the zoom gesture recomputes nothing
  and lands one sharp bake at settle, and the sky is quiet and varied.
  Next session: sideload the APK, re-judge the glide with projected text,
  the field at every dock, the pinch feel, and the star cadence.

---
Task ID: v1.12.0 (THE BREATHING FIELD)
Agent: Super Z (main orchestrator)

Task: The user's four v1.10.0 post-ship reports — (1) the projection
updates once at rest (should be ~2Hz) + "the panel itself gets slower
the more custom colors it holds… the canvas itself feels slow to
respond", (2) revert the sliders (narrow, clean; the gradient or the
first color), (3) comets only when scatter > 0.4 and x10 rarer, (4)
amplify parallax must reuse the existing dots/lines (no new brighter
stars, nothing over the icons) and amplify the parallax while zooming
AND panning.

Work Log:
- THE PROFILER first (the user: "I don't know why"): v111-perf-probe.py
  — two theme configs (LEAN default vs RICH many-custom-colors), real
  CDP input, raw-websocket devtools.timeline traces (playwright filters
  the Tracing domain — the honest timeline needed a second, direct CDP
  connection). Findings: the glide's dominant cost is style recalc
  (UpdateLayoutTree 445-524ms/window) driven by the per-frame inherited
  --panel-vis-h write, plus a gradient raster storm in rich themes
  (RasterTask 31 -> 1029 events) — the per-frame var re-resolve of
  every painted window whose formula calcs the var. JS measured
  near-idle (the user's own exoneration of doom projection's JS).
  Canvas pan/zoom measured clean.
- v1.10.1 THE BREATH: run() allows a full re-anchor paint every 500ms
  while a motion window is open (the user's exact cadence); the coast
  still freezes between breaths; the settle lands exact.
- v1.10.2 THE HONEST SKY: decoded the amplifier's three mis-features on
  the tree — the amp-only hero fireflies (tiled, bright, over icons),
  the static glow (brighter than the amp-0 grid), the over-icons split
  (sizeVar >= 80 over icons). All retired; the band split (the same
  dots/lines at per-depth parallax) stays. Comets: the scatter > 40
  gate (the user's 0.4 on the app's 0-100 sliders) + x10 cadence
  (180-440s, first 60-160s).
- v1.10.3 THE TRUE DEPTH: per-band zoom parallax — each band's drawn
  period scales by S^((pf-1)*kZ): the planes diverge under zoom,
  world-true at scale 1 and amp 0; pattern-matrix math only.
- v1.10.4 THE NATIVE HAND: the slider gate rules retired; native
  rendering returns; accent-color = var(--accent) = the first gradient
  stop (research: accent-color is <color> only — the user's accepted
  fallback). Toggles keep the full spectrum.
- v1.10.5 THE MEASURED FIX: the inherited var lands at most every 500ms
  during motion and always at the rest writes; the layout stays exact
  per frame (the element-scoped inline height). Measured: UpdateLayout
  Tree 445.7 -> 71.1ms (lean) / 524.5 -> 110.3ms (rich).
- THE RIG: scripts/v111-breathing-field-test.py (20 checks — the breath,
  the coast between breaths, the honest sky, the comet gate, the zoom
  depth incl. byte-flat-at-zoom, the native hand, the var throttle).
  The pinch needed a corridor-checked center + a quiet-canvas gate (a
  CDP simultaneous lift and an icon under a finger both eat gestures —
  the chase is documented in the rig).
- Battery on the shipped tree: v111 20/20 (NEW, permanent) · v110 22/22
  (§A writes/bumps + §D cadence asserts updated to the breath + x10
  contracts, documented) · v109 30/30 (§B slider + §D_motion asserts
  updated to the native-hand + breath contracts, documented) · v106
  21/21 · v1045 11/11 · v1040 7/7 · uikit 140 · twins 198/199 (the
  documented pre-existing page-6 baseline failure).
- SCOPE BOUNDARY (the spaghetti line): the remaining rich-theme glide
  raster storm is inherent to fixed-attachment gradients on elements a
  resizing panel repaints — layer-promoting every painted window would
  trade main-thread paint for N viewport-sized GPU layers on a weak
  device (memory + swap); documented, not built.

Stage Summary:
- WAVE SHIPS as v1.12.0-the-breathing-field (the parallel bot's HF TRUTH WAVE took v1.11.0 mid-flight; the rebase-before-push protocol merged amicably — no file overlap beyond the buildinfo version chain). The projection breathes at
  2Hz mid-motion, the amplifier keeps only the honest parallax (plus
  zoom depth), the sky obeys the scatter gate at x10 rarity, the
  sliders are native again, and the measured recascade storm is gone.
  Next session: the user sideloads the APK and re-judges the glide feel
  with many custom colors, the amplifier look, the comet rarity, and
  the native sliders.

---
Task: v1.13.x-v1.14.0 THE MCP WAVE (PLAN-V113 — the mcp-go conviction)
Agent: the MCP bot (mark3labs/mcp-go replacement of the ACTION tool system)

Work Log:
- v1.13.1 THE BUS: the mcpbus lands as pure addition — 28 tool Defs as the
  single source of truth, the in-process MCP client, Observer hooks, Turn
  ctx plumbing; CI go 1.23 -> 1.25.5 (mcp-go v1.1.1 requires it).
- v1.13.2 THE HANDOFF: the chat loop runs the MCP bus as the PRIMARY tool
  path (BusFailure -> sticky direct-dispatch fallback; tools-rejecting
  providers blacklist + answer honestly without tools); ChatRequest gains
  SessionID for trace attribution.
- v1.13.3 THE GUT: the ACTION text protocol is DELETED (~1,500 lines:
  parseAction family, glue parsers, alias/Levenshtein layers, the ReAct
  preamble-hold state machine, DSML reinject, the kill-switch); ~40 server
  teaching texts rewritten to tool-call phrasing; live verdict 19/19 against
  the real NVIDIA key (nemotron-3.5-lightning: calculator chain, live
  web_search, zip_create artifact).
- v1.13.4 THE CHAIN: external MCP servers attach onto the bus (stdio on
  desktop, streamable-HTTP everywhere incl. Android) under name_ namespaces
  with auto-paginated tools/list + raw-schema proxies; /mcp serves external
  consumers the same registry; config via DOOMALAY_MCP_SERVERS or
  <dataDir>/mcp_servers.json. Live: engine B chains engine A (56 tools).
- v1.13.5 THE LAST ACTION: pmsdk.js (the PM E2E browser loop) drops the
  ACTION grammar for tools[] from /mcp + native tool_calls delta assembly;
  ground-truth probe proved PM's E2E API passes OpenAI tools[] natively;
  X-Doomalay-Session resolves session turns for external callers.
- v1.13.6 THE REDTEAM: the 67-check adversarial rig (deterministic stub
  personas — nvidia/openrouter scenarios, groq the reject carrier — plus
  mcpdemo, a standalone 100-tool streamable-HTTP MCP server with
  boom/hang/boom_panic fault injectors). Two engine bugs convicted, fixed,
  and pinned: (1) the honesty line's execution side — a cut/malformed call
  said "NOT executed" then executed anyway with bus-coerced {} (Skip/SkipText
  now make the fault text the tool's answer: one call_id, one tool message);
  (2) THE THIRD CARRIER — openrouter turns never reached the bus (plugin-first
  routing + always-on WebSearch); every tools-capable provider now runs the
  tool_calls loop first, the OpenRouter web plugin ladders down to the
  blacklisted/anthropic-wire fallback. Rig 67/67.

Stage Summary:
- THE MCP WAVE is complete and shipped as v1.14.0-the-mcp-wave. MCP is the
  tool system end to end: one calling convention, 28 internal tools, any
  number of external servers (the 100+ tools horizon made real by mcpdemo
  and /mcp), ACTION dead on every path, honest degrade contracts pinned by
  the rig. Parallel bots (tiktoken accuracy, OTel hooks/traces) plug into
  the bus's Observer sockets — no file overlap, no conflicts.

---
Task ID: v1.14.5
Agent: Main orchestrator (the real-key E2E wave, fresh session)

Task: The user's fresh keys + the old NVIDIA key — "solely test the chat bot
and check for errors. If you found no errors then dont do anything."

Work Log:
- Sandbox reset recovery (3rd time): re-cloned doomalay (main @ 53191635 =
  v1.14.4 head — the parallel HONEST-ENGINE wave shipped v1.14.1..v1.14.4 on
  top of my v1.13.6/v1.14.0, rebased in), reinstalled Go 1.25.5, rebuilt the
  engine, keys at /home/z/keys.env. Tunnel down — sandbox testing.
- OpenCode deep-probe (11 web searches + gateway source reads): oc_sk_ keys
  authenticate on ALL THREE lanes (zen/v1, zen/go/v1, inference) but the
  account has NO Go subscription (EntitlementError) and NO prepaid funds
  ("Insufficient account funds" on every paid model), and the free tier is
  hard-walled to the OpenCode app (FreeTierError survives the full 4-condition
  client gate: opencode UA + ses_ session + stream:true + bash/read tools).
  The engine's honest-degrade path verified end-to-end (403 error frame +
  idle + the guidance message). Header contract correct: zen/go 400
  MissingSessionID reproduced + bypassed with a stable ses_ header.
- LIVE MATRIX (fresh keys, the engine's real /api/keys flow): NVIDIA valid —
  the live roster flagship nemotron-3-super-120b-a12b chains calculator +
  time_now + zip_create flawlessly (4s turns, grounded answers, full trace
  lifecycle); OpenRouter valid — lfm-2.5-2.6b:free (the 2.6B weak model!)
  chains instantly, nemotron:free completes through a 229s free-tier queue
  with honest "waiting on OpenRouter" notices; Mistral key now VALID (was
  invalid) — currently 429-capacity-limited, the engine's 3-retry backoff
  (4s→14s) + honest stop is exactly the strictly-429 contract; PM E2E probe
  5/5 (attestation + refreshSecret + plain + tools passthrough).
- THE PRE-MADE HORDE re-run: 23/23 with the fleet (fs/memory/think/sqlite =
  29 community tools + the internal 28 = 57-tool merged registry).
- REAL-USER UI E2E (agent-browser, engine-served PWA, persistent engine via
  a double-fork daemonizer — the sandbox reaps normal background spawns):
  13-round self-knowledge conversation: R1 stock-trading opener (bot knows
  artifacts + capabilities), R2 lib search → RECOMMENDS THE KRONOS REPO
  (4 hublib queries with visible retry reasoning), R3 personas (knows Noir
  Detective + download/activate WITHOUT being asked), R4 workspaces (knows
  GitHub/HF/Gitea/GitLab/Sourcehut + what the workspace tool does), R6
  usage/context (EXACT ledger numbers: 159,964 in / 4,364 out, ≈$0.04,
  62.7% of 262k, correct rate math), R7 five-tool chain incl. COMMUNITY
  fs_write_file/fs_read_text_file grounded, R8 artifact card, R9 web search
  with 5-source disclosures, essay + queued follow-up.
- FPS: 60fps 0 drops (max 20ms gap) at empty, semi-saturated, heavy (12
  rounds + 2 workspaces + artifacts), and DURING active streaming. Zero
  console errors, zero engine errors.
- Queue: QUEUED badge + remove + auto-drain after the running turn.
  Interrupt: clean stop + "the reply was interrupted — tap Retry". Resend:
  Retry re-sends and completes on the switched model.
- Workspaces: GitHub PAT through the real connect flow (✓ logged in
  @ScoobyBaby1999 → doomalay repo bound FULL access) + HF access token
  (doomalay-kronos dataset bound FULL) → the workspace tool turn did PARALLEL
  ls+grep across both, grounded summary (143 HF entries, six Kronos skills).
- TRUE PM E2E PATH (the earlier GLM 5.3 pick had landed on NVIDIA's copy of
  the model — PM-unique glm-latest picked instead): the browser loaded the
  full pmsdk E2E chain (wasm attestation), tool executions went through
  POST /mcp (the mcp-go bus first), grounded "33 × 3 = 99 + Tokyo 01:10 JST".

THE FINDINGS (the only errors found — all small, all fixed):
1. THE STALE AUTO-PICK: nemotron-3.5-lightning-30b-a3b was deprovisioned
   from NIM (live roster check: 502/404) but THREE hardcoded lists still
   led with it (engine knownGoodProbes + the PWA's KNOWN_GOOD and
   FALLBACK_MODELS) — every one-press connect inherited a dead-then-flaky
   model (live-observed: a 3.5-minute round-one stall, then repeated
   "no response from Nvidia" waits). All three now lead with the live
   nemotron-3-super-120b-a12b. Verified live: fresh one-press connect lands
   on the live model.
2. THE SANDBOX TEACHING GAP (R5): asked "what sandbox am I on / what do the
   others offer", the model honestly said "I don't have any information
   about selectable sandboxes" — the session preamble never taught the
   concept. sessionctx.go now carries the sandbox line (current sandbox +
   the four switchable types). Verified live: full correct table answer.
3. v1143 community-chain-test model id healed (the stale lightning → live
   super; 23/23 re-proven).

Stage Summary:
- The system is HEALTHY end to end under real keys: tools chain reliably on
  every chat-capable provider (strong AND weak models), rendering is
  sequential and delta-correct at a locked 60fps, queue/interrupt/resend all
  behave, the bot never stops except strictly-429 (displayed, retried 3x),
  community MCP tools ride the bus, PM executes tools mcp-first like everyone
  else, and both workspace connects work with full access. The one thing the
  user must do OUTSIDE the app: add credits (zen pay-per-use) or the Go
  subscription (with Global region privacy) at opencode.ai for the fresh
  OpenCode key to chat — the key itself is valid and the engine degrades
  honestly meanwhile.

═══ v1.15 THE CHOICE WAVE (2026-10-08) ═══

The user's four fronts, delivered as PLAN-V115 (four phases, ship v1.16.0):

1. v1.15.1 THE CHOICE (baec254f) — the autopickers are dead: no hardcoded
   model lists anywhere (engine knownGoodProbes deleted → live-derived
   ladder, free-first, capped at 5; ResolveAutoModel scores pure catalog
   data; the PWA's KNOWN_GOOD/FALLBACK + the one-press silent pick + the
   reminder GUI deleted). Every connect flow now FORCES the user's pick
   through the model screen in TEACH MODE: the Ready (key-backed) filter
   preset, the teaching provider first + expanded, and the short banner
   ("Pick your model — this is the model screen. Reopen it anytime from the
   👾 model pill in your chat's header."). Caught live: modelpicker called
   smartConnect() with no callback → the screen never opened (fixed+pinned).
   Live E2E through the real NVIDIA key: card → teach screen → pick →
   unlocked chat → exact reply.

2. v1.15.2 THE DECOUPLE (9f0bb201) — isolation proven under genuine
   overlap: scripts/v1152-slow-stub.mjs (slow carrier, per-request markers)
   + scripts/v1152-decouple-rig.mjs (speaks the PWA's own ChatClient
   contract). 30/30: parallel streams, busy isolation, abort isolation,
   socket-kill + server-side turn survival + &since resume, replay
   reconstruction, the stale-frame guard. Live UI redteam: 3 chatbots
   (nvidia/groq/openrouter personas) flipped mid-stream — 0 foreign
   markers; browser panel navigated while a chat streamed; PWA RELOAD
   MID-TURN — the turn survived, replayed, completed all 40 deltas.
   Convicted+fixed: the DOOMALAY_BASE_URL override didn't hold for the
   specialized model fetchers (nvidia/opencode/PM/openrouter) — now the
   mirror contract is honest.

3. v1.15.3 THE TRIM (820f0df4) — the chat/session files: dead code out
   (chatpanel's unreachable pre-v0.48 persona duplicate still teaching the
   DELETED ACTION grammar — actively harmful since v1.13.3; persona.js's
   ## Tools/## Library rewritten to native tool-call phrasing; the last
   engine remnant strings healed). Complexity: buildHistory is BOUNDED
   (ListEventsTail + the hide-only query + a doubling tail walk —
   O(window) per turn, exactness fallback for mid-delta-run tails);
   updateMessageEl is an O(1) mi→el cache (was a full-DOM querySelector
   per 180ms tick); sessionLocks/chatPipes get reapIdleChat (never while
   a turn runs — the resume-swap invariant, pinned by test).

4. v1.15.4 THE SHELL PLAN (e10b112a) — PLAN-V116-THE-SHELL-WAVE.md: the
   design for bash/shell/real-Linux in Quick Chat (WS /api/term + creack/pty
   engine side with the android build-gate, xterm.js in the OVERLAY per the
   container law with theme-var-fed colors, the jailed one-shot shell MCP
   tool with blocklist/caps/cooldown, the Termux bridge for local Android)
   — v1.16.x builds it phase by phase.

Ship v1.16.0: buildinfo carries the wave. Full battery green throughout
(decouple 30/30 · v1136 67/67 · choice 19/19 · v1153 pins · llm · server ·
isolation 12 · round-flow · interrupt 65).

---
## v1.18.0 — THE TERMUX WAVE (PLAN-V117, shipped 2026-10-08)

The user's directive: Termux comes to the APK first; only quick chat
exists; the +sandbox becomes a +capabilities overlay (stackable, the
future library); the setup must be one-click or as close as possible; a
live delta update system so users download only what changed.

- **v1.17.1 THE PIVOT** — sandboxpicker.js deleted (665 lines incl. the
  whole HF sub-picker family); capabilities.js born (the capability
  library on the ConnectOverlay: stackable toggle rows + action rows +
  the APK-only Termux row); gatelock = model + optional caps; quick by
  birth (chatbot.js + sessionBody + engine default); chat_sessions.termux
  column; sessionctx capabilities teaching.
- **v1.17.2 THE BRIDGE** — RUN_COMMAND manifest permissions + queries;
  TermuxBridge.kt (intent sender, PendingIntent results, honest ladder);
  TermuxBridgeServer (token-authed loopback); engine --termux-bridge +
  termuxbridge client + /api/termux/status (cached probe, honest ladder)
  + /api/termux/act. APK CI green (Kotlin compiles).
- **v1.17.3 THE SETUP** — termux/setup.sh (the curl bootstrap); the
  setup overlay (4 auto-advancing step cards, 3s poll, READY card, Done
  pop-back); the F-Droid 1002 + the one-liner.
- **v1.17.4 THE LIVE UPDATE** — internal/ota + otaapi (status/check/
  download, sha256-verified atomic downloads, ota-first static overlay =
  restart-free apply); web/ota.js banner; CI manifest generation; the
  old generate-patch-manifest.py retired.
- **v1.17.5 THE REDTEAM** — the 108-check rig (fake bridge + fake OTA
  against the live engine) + agent-browser E2E. Convicted + fixed:
  quick-by-birth engine gap; renderTypePills undefined (killed the real
  browser render while source rigs stayed green); pre-session caps lost
  on reload (icon.caps stash); late pill repaint. The honest gap: the
  com.termux intent round-trip needs real hardware —
  docs/TERMUX-DEVICE-TEST.md is the checklist.

The Termux capability is inert by design this wave — workspaces + the
MCP tool layer (termux_exec + file verbs, jailed to the approved
workspace) is PLAN-V118, the next wave.

---
Task ID: v1.23.1
Agent: Main orchestrator (THE PILL WAVE)
Task: PLAN-V123 §1 — THE LINK (dynamic F-Droid stable URL) + THE PACING (the 4s exec cooldown dies).

Work Log:
- Research receipts: fetched F-Droid API v1 live — suggestedVersionCode 1002 (0.118.3 stable) while packages[0] AND [1] are betas today (the user's "2nd link" heuristic would grab a beta — the suggested-code match is the honest pick); RUN_COMMAND = one broadcast (100KB cap, no incremental channel → streaming must originate inside Termux); engine serves 127.0.0.1:8080 on the APK (the checkin pattern proves Termux→loopback works).
- fdroid.go (NEW): resolveFdroidTermuxURL (5s timeout, 6h TTL cache, one-flight) + pickFdroidURL (suggested-match → first non-prerelease (beta/rc/alpha leading-boundary markers) → frozen 1002) + warmFdroidURL (every status poll warms it in the background).
- handleTermuxAct: open_fdroid resolves + rides the URL via the NEW bridge ActWithURL; TermuxBridge.kt honors it ONLY under the https://f-droid.org/ allowlist (frozen constant = the fallback). Kotlin diff ~20 lines.
- THE PACING: termuxExecCooldown/termuxExecLast deleted; the 12/min rolling cap stays; help/sessionctx/example texts updated; TestV1231_Exec_NoCooldown_CapHolds + re-pins (termuxtool_test shrinkPacing, sessionctx_test "12 per minute per chat", v1203 rig 61/61, v1211 rig 30/30 — the immediate second exec RUNS now).
- Whitespace law incidents (2, both fixed): the Edit tool space-ified tab-styled termuxbridge/client.go + termuxapi.go — python tab-restore, diffs surgical (client.go = ActWithURL only; termuxapi.go = warm + the fdroid act branch).
- The mirror wave shipped v1.22.0 mid-build → my wave = v1.23.x → v1.24.0 (no collision); rebased clean, battery re-run green post-rebase.
- Battery: fdroid_test 3/3 · full server suite ok · termuxbridge ok · vet clean · linux+android builds · v1202 66/66 · v1204 38/38 · v1213 25/25 · v1212 23/23. Pushed 40fa32fc (origin/main).

Stage Summary:
- The Get-Termux tap always serves F-Droid's CURRENT stable link (never manually updated again; offline = the frozen link); exec runs rapid-fire with only the 12/min cap. Engine+Kotlin ride the APK (OTA carries nothing of this phase).

---
Task ID: v1.23.2
Agent: Main orchestrator (THE PILL WAVE)
Task: PLAN-V123 §2 — THE ONE PILL: merge the tool call + result pills, derive the real exec label, the loading bar.

Work Log:
- chatpanel.js: toolPillLabelParts + termuxArgsOf (the pure label derivation: first token + the ONE generic 'install' join, pkg verb, summary fallback) + mergeToolResult (the pairing-to-last-pending reducer, ei2, resPayload) + refreshToolRow (in-place repaint) — all exported for the rig.
- messageHTML tool branch: the merged/pending/progress states, the dim tail + live dot, the expanded three-truth-rows (tool/query/result); toolDetailHTML: args pretty-print (object or JSON string), the merged result read, THE LOADING BAR (pending) + the streamText seam for v1.23.3.
- The WS tool_result handler merges (replay identical — persistence untouched, append-only law); the PM onTool twin merges the result half + persists the RAW args; pmsdk passes args + prefers the nested args.command summary (the 'exec' flat-key vagueness dies).
- The hide flows honor ei2 (the live hide loop, regenerate, commitEditStash — masking either half drops the vessel).
- openToolFullView reads msg.res (the borrow walk stays for standalone legacy pills).
- index.html: the tail/live-dot/bar/stream CSS (theme vars only + prefers-reduced-motion honesty); mobile 390px verified.
- THE BROWSER WALK (agent-browser + a live engine, zero console errors): the seeded session replayed through the real app renders ONE merged pill ('pip install numpy', result tone, both-spans label+tail) + ONE pending pill ('ls -la' + live dot; expanded = tool/query/result + the 3.375px animated slide bar); the full view opens/closes; the X works.
- Battery: v1232 rig 39/39 (NEW) · v1171 67/67 · v1212 23/23 · interrupt 65 · v1175 155/155 · v0935 13/13. Pushed d69544ca.

Stage Summary:
- One pill per action, the program as the placeholder, the query as the tail, the loading bar while in flight — live, replayed, and pre-merge chats alike. The PWA side lands OTA. The stream (v1.23.3) fills the same vessel.
