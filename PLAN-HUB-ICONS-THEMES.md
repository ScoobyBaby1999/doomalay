# REAL PLAN — v0.52 "the hub, icons & themes wave" (the interrupted bot's 10 items, rebuilt)

CONTEXT: the other bot's code was lost (never pushed), but its HF DATASET work SURVIVED
(ScoobyBaby1999/doomalay-superpowers @ 4a0c09547a "v0.51 corpus v2: 1:1 obra/superpowers
v6.4.1 sync, uncapped stages, icons + superpowers-obra bunch, full 75-file skill tree,
user-template array dropped"). Verified live: rows carry `icon` (Lucide names: lightbulb,
bug, map, layers, flask, shield, zap) + `collection: superpowers-obra`; skills match
obra/superpowers main 15/15 (content identical modulo the intentional `superpowers-`
name prefix); templates are uncapped (no max_tokens keys); the dupe-causing user-template
array is gone. This wave rebuilds ALL app-side code to honor that corpus + the 10 asks.

RULES (standing): new UI only on the Panel or the Overlay screen (canvas-native excepted);
ZERO hardcoded colors — everything rides the theme token system; stop before spaghetti.

## PHASES

### A — engine: icon + collection on the Item (asks 1, 3)
- hub/model.go: `Icon string` + `Collection string` json fields.
- hub/scan.go: surface icon/collection from jsonl rows (sanitize icon name: [a-z0-9-]);
  dir-tree items get "" (optional by design).
- hub/service.go Items(): also derive `collections` — per collection id: count, aggregated
  hearts/downloads, icon (most common), sample names, per-type counts.
- hub/service.go publish(): accept + persist icon + collection in the published row
  (jsonl row keys), so ANYONE can bunch their listings.
- scan_test.go/service tests: surfacing, aggregation, publish round-trip.

### B — web: the icon library (ask 3)
- NEW web/icons.js — window.IconLib: 36 Lucide-named inline SVGs (24×24, stroke=
  currentColor → theme-follows for free): the 7 corpus names + 29 more (brain, sparkles,
  search, code, database, cloud, git-branch, rocket, palette, settings, users, message,
  send, download, heart, star, book, pen, terminal, cpu, globe, lock, key, play, check,
  x, plus, trash, copy, share, wand, target, compass, layers-2…).
- IconLib.svg(name, size) / IconLib.has(name) / IconLib.NAMES.
- Lucide is ISC-licensed — extend docs/CREDITS.md.

### C — hub cards restyle (asks 3, 4, 6)
- hub.js cardHTML: icon COLUMN left of name (IconLib, falls back to none), bigger ♥/⤓
  glyphs + counts, real border (var(--border)) + shadow (rgba(0,0,0,.35) — shade, not a
  color), text scrim under the body (linear-gradient surface veil) so text POPS on any
  bg, name --text-1 bold, desc --text-2.
- Card hearts become LIVE: tap ♥ on a card → endorse/unendorse directly when downloaded
  (filled ♥ vs outline ♡ reflects state; not-downloaded → opens the detail as before —
  engine still 400-guards). Every heart instance shares Hub.setHearted-driven repaint.
- hubitem.js: icon in the collapsible header; fabs bigger.

### D — collections UI (ask 1)
- hub.js: when items carry collections, render GROUP CARDS (collection style: icon +
  name + N members + Σ hearts/downloads) atop the grid; tap → collection view = member
  list ACROSS libraries (sectioned: templates / skills / personas), X chip to exit
  (rides the tag-filter pattern; keyboard rule intact).
- hubpublish.js: "collection" input + icon picker grid (publish form) → contributors
  clamp many items into one bunch.

### E — superpowers uncapped + 1:1 sync (ask 2)
- brain/orchestrator/templates/superpowers_*.json ← corpus v2 payloads (fetch from HF
  jsonl `content`, byte-faithful) — removes every per-stage max_tokens cap.
- orchestrator.py _ROLE_DEFAULT_MAX_TOKENS → PLANNER/GENERATOR/REVIEWER/TRANSFORMER/
  EXTRACTOR 131072, VERIFIER 8192. SAFE: scheduler.call_slot clamps to each provider's
  published limits.max_out (verified in code).
- judge/llm_judge.py _VERIFIER_MAX_TOKENS 200 → 4096.
- Verify agent_skills/ 15 SKILL.md == corpus v2 (script diff), brain→hfzero sync.

### F — grid dots gradient + canvas parallax + bigger size variation (ask 7)
- app.js: dotColorAt(t) — interpolate the dot spec stops; per-dot t = positional
  projection mixed with per-dot hash → some dots are DIFFERENTLY colored (visible
  variety, not a smooth sweep). Lines: per-line/per-segment sampled color likewise.
- paintCanvasBackground: camera-parallax translate (bg moves at 35% of pan; scale
  pull 35% of zoom) + margin fill so no edge ever shows. All aesthetics keep v0.49
  fidelity, now world-anchored.
- gridSizeVariation: ±50% → ±85% (floors: dot r ≥ .2, line w ≥ .12).

### G — export/import the whole look (ask 8)
- appearance.js General page: "export my look" / "import a look".
- Bundle: {format:"doomalay-look", version:1, exportedAt, state: Settings.getState()}
  — images (bumpmaps/photos) are dataURLs INSIDE the state → ride along 1:1.
- File name doomalay-<theme>-<date>.doomtheme (JSON inside; .json accepted on import;
  magic-field validated; 24MB cap; import = setState + full re-apply + toast).

### H — themes panel in the public library (ask 9)
- hub.go: FOURTH library `theme` (tag doomalay-theme; payload ext .doomtheme).
- scanner: jsonl rows keyed "theme" + *.doomtheme files in trees (multi-layout reuse).
- Payload = the Phase-G bundle; `scope: "global" | "chat"` inside. Downloading a global
  theme imports the look live; a chat theme applies to the chat that opened the hub
  (PUT tweaks). hubitem detail renders the JSON summary.
- hub.js libraries row gains 🎨 themes; the pill row scrolls horizontally (4 columns
  don't fit Android), icons smaller, header compact (user spec verbatim).
- Publish: "publish my look" prefills the bundle from the CURRENT state.

### I — chat icon tweak (ask 10)
- engine tweaks.go: chatIconKey + PUT/GET/DELETE /api/sessions/{id}/icon (bgRecord
  pattern, 4MB cap) — dataURL too big for the 64KB tweaks blob.
- tweaks blob: iconIndex | iconCustom flag.
- tweaks.js: "chat icon" section — family icon grid (families.json defaults) + "browse
  image…" → existing CropUI (square crop; avatar clips circular) → PUT icon →
  getAvatarHTML prefers custom → canvas node + panel header + reload persistence.

### J — sheet dedupe (ask 5, finish)
- templatesheet.js mergeHubDownloads: dupeKey = kebab(task_type || id || name) —
  brain ∪ hub ∪ localStorage deduped on it. One Superpowers Brainstorm, once and
  forever. (Dataset-side dupes already fixed by the corpus v2.)

### K — redteam as a real user
- Go suites + brain suites + node --check + self-tests.
- Live engine :8123: API probes (collections/icons/theme library), agent-browser
  walkthrough of every ask, visual pixel checks (multi-color dots, parallax shift,
  card contrast), export→wipe→import 1:1 look test, chat icon crop flow, publish with
  icon+collection.

### L — rebase, push, release
- fetch origin (other bots!), rebase, full suites, push, tag v0.52.0-hub-icons-themes,
  verify CI assets, worklog + MEMORY update.
