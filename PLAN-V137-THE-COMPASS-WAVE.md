# PLAN-V137 — THE COMPASS WAVE (v1.37.0)

> The user's ask, five items: (1) cap max zoom-in ~30% lower + expand zoom-out by
> 300%, (2) long-press an existing icon → the same overlay used for New Bot /
> New Tab, but with a Pin option and a Delete option (last row) — Delete opens
> the reusable Overlay screen with "delete this chat forever? (a very long
> time)"; pinned chats show first in the all-chats panel; only pinned chats and
> tabs carry the off-screen indicator, (3) the off-screen indicator refactored:
> dynamic scale (further = smaller, capped), dynamic color (the pinned icon's
> gradient or badge color; nothing set → a color sampled from the gradient of
> all colors, never a static solid list), and press-the-indicator → the canvas
> viewport smoothly + quickly drags itself to the target until centered or the
> user interacts with the canvas (UI icons on the canvas don't cancel it),
> (4) the placeholder system: a toggle that disables/enables the live block
> placeholders (included/excluded from preambles AND personas) + a method to
> view the FULL placeholder text (today it cuts off) via an arrow that opens
> the reusable panel/overlay as a text editor (edit, scroll, reset to default,
> etc. — reuse a screen we have), (5) research what it takes to make the
> placeholder system compartmentalized and moddable: the BOT can create
> placeholders exactly like the user, customs work per-chat, and a persona or
> preamble published to the library carries its custom placeholders (even
> computed ones like {win} backed by code) so they work for the downloader.

## The state on record (recon receipts)

- Origin/main = `ce7d7379` (v1.36.0 THE FINISHER WAVE). The prior session's
  v1.37.0 swift-canvas optimization was NEVER pushed (no credentials that
  session) and the sandbox reset destroyed the local commits — that wave is
  LOST and is NOT re-delivered here (honesty on the record; it can return as
  its own wave). This wave = the five items above, shipped as v1.37.0.
- Zoom: `app.js` L91-93 `MIN_SCALE=0.5 / MAX_SCALE=3.0`; the clamps re-read at
  4 sites (zoomAt, pinch, setView, boot-restore) — one constant change covers
  all. The lattice tile ladder is zoom-stable by design (level 0 rides
  downscaled for all s<0.89; real levels only for s>1.118).
- Off-screen indicators: `computeArrows()` app.js L298 — EVERY off-screen
  entity gets a fixed-size ~22px chevron clamped to a 50px margin, colored by
  family hex (default family → `--border-strong` via a 1s-TTL cache), painted
  main-side (`paintArrows`) AND worker-side (gridworker.js L158 rides the
  per-frame message: {x,y,angle,color}). No hit-testing, no scale, no color
  dynamics, no pin concept today.
- Long-press: `LONG_PRESS_MS=500` (the Android norm). The timer fires while
  inputState==='PENDING' → MENU_OPEN + `showMenu(x,y)` → the `#menu` DOM
  element (themed CSS, z-1000) with the New Bot / New Tab buttons. Today a
  hold ON an icon opens the SAME canvas menu (icons are only distinguished at
  drag-start and tap — the hold path never checks `findIconAt`).
- Deletion of chats: NO path exists today (recon: no delete-chat flow in
  app.js/chatbot.js). The engine endpoint exists: `DELETE /api/sessions/{id}`
  (sessions.go L409 — session + events). Web icons have no engine session.
- Pinning: no pin concept anywhere. `ChatIcon.serialize/deserialize`
  (chatbot.js) and `WebIcon.serialize/deserialize` (webtab.js) ride
  localStorage via `saveNow()` (app.js L2092). The restore loop
  (`GridIcon.create`) passes the saved object through — a `pinned` flag rides
  base `serialize()` and is re-applied in the restore loop.
- All-chats panel: `chatsview.js` — fetches `/api/chats`, buckets by date
  (Today/Yesterday/Previous 7 days/Older), renders sections. No pin ordering.
- Placeholders (persona.js L1496 `placeholdersView`): the five MIRROR blocks
  expand via `GET /api/sessions/{id}/blocks` (previews capped: 6 lines +
  2000-char `blockPreviewCap`); live facts + trigger metrics; global 🌐 +
  local 📍 customs (value column truncates with ellipsis — no full-text view).
  The engine: `expandPromptBlocks` (preambles.go L157) expands the 5 blocks
  over the composed preamble+persona; `substituteAllVars` (personas.go L823)
  substitutes facts + customs FIRST. The bot tool `placeholder_set` exists
  (local|global scope, hard-refuse on reserved keys). Session PATCH accepts
  `personas` / `placeholders` / `preambles` / `preamble_sel` etc.
- The editor: CodeMirror is vendored (`/vendor/editor/codemirror.min.js` +
  mode-markdown) and the persona/preamble editors are PV()-view screens with
  CodeMirror + save/default/dl/publish/trash pills — the exact reusable
  pattern the user's item 4 asks for.
- The Overlay screen: `window.ConnectOverlay` (connectoverlay.js) — content-
  agnostic full-screen rounded card, themed, with pushPage/popPage. This is
  the sanctioned surface for the delete warning.
- The bundle system: personas/preambles publish as portable `.md` with
  frontmatter that already carries a `placeholders:` LINE (a plain key list,
  documentation only). The import bridge (v1.27.2) SUGGESTS missing keys —
  no values ever ride the bundle today.

## Web research receipts (the searches, before the build)

- Off-screen indicator pattern (game-UI canon): edge-clamped arrows pointing
  at off-screen targets, with distance-based scale/color as a standard
  affordance (Evo's "Off Screen Indicator… Supports UI and 3D world targets,
  distance"). Our edge-clamp already matches; we add the distance dynamics.
- Long-press: ~500ms is the Android context-menu norm (Android Chrome's own
  text-selection engages at ~500ms). Our `LONG_PRESS_MS=500` is right.
- Camera glide: rAF-driven, ease-out, interruptible-on-user-input is the
  standard law (MDN rAF; every canvas camera tutorial). Ours rides the
  existing tick loop (full frames while gliding — `moving` semantics).
- Untrusted user-defined logic (the item-5 research core):
  - **CEL** (Google's Common Expression Language) — non-Turing-complete
    expressions, syntax-checked, evaluated with bounded time; the industry's
    "single-line scripting for untrusted users" answer.
  - **Starlark** (Bazel) — deterministic Python dialect, no I/O, but its own
    maintainers note resource limits are still on the embedder (crash safety
    ≠ wall-clock safety).
  - **QuickJS-in-WASM** (the "QJS" CGo-free Wazero pattern) — arbitrary JS
    inside a WASM boundary; the modern answer for L4 arbitrary code, WITH the
    cautionary receipts: QuickJS-NG CVE-2026-37630 (RCE when exposed to the
    network) and the "audit every API you expose to the sandbox" law.
  - The consensus ladder: declarative < expressions < full code, and each
    step up must earn a trust gate (install-time consent + no I/O bridge by
    default + budgets).

## THE PLAN — five phases + the ship (v1.36.x phases, ship v1.37.0)

### §1 v1.36.1 — THE CLOSER VIEW (zoom caps)

- `MAX_SCALE 3.0 → 2.1` (the user's "~30% less" zoom-in cap).
- `MIN_SCALE 0.5 → 0.125` — the zoom-OUT depth expands ×4 = "+300%"
  (0.5/4: the world shrinks to 1/8 the size vs 1/2 — you see 4× more world).
- All 4 clamp sites read the same constants — one edit; a saved scale outside
  the new range heals via the existing clamp on restore.
- Side-effects audited: the lattice ladder rides level-0 downscaled across the
  whole s<0.89 range (by design, zoom-stable fingerprint); the dot radius
  floor (0.6) and the icon hit-radius floor (28px) keep deep zoom-out
  readable + finger-friendly; findIconAt's min-28px hit circle keeps far
  icons tappable at 0.125.
- Rig pins: the clamp math at all four sites (zoomAt wheel, pinch, setView,
  restore-heal) + the deep-zoom-out ladder stays level 0.

### §2 v1.36.2 — THE HELD THING (icon hold menu · pin · delete)

- **The icon hold menu**: the long-press timer callback checks
  `findIconAt(startScreenX, startScreenY)`. An icon → `#menu` re-populated
  with the icon rows: `📌 pin` / `📌 unpin` (first) and `🗑 delete …` (LAST
  row, per the user's spec). No icon → the existing New Bot / New Tab menu,
  byte-identical. Same `#menu` element, same theming, same open/close law
  (tap outside dismisses; the menu never flash-opens the panel — inputEnd
  with MENU_OPEN is inert, as today).
- **Pin**: `icon.pinned` (bool). Base `GridIcon.serialize()` carries it; the
  boot-restore loop re-applies it after `GridIcon.create`. A themed pin badge
  (`.pin-badge`, `--accent` ring, pin glyph SVG — zero hard-coded colors)
  rides the icon element while pinned (the sandbox-badge pattern). Toggling
  pins saves + updates the arrows (pinned-only law lands in §3's filter but
  the flag + persistence + UI land here).
- **Delete**: the Delete row opens `window.ConnectOverlay` — the reusable
  Overlay screen — with the warning the user worded: "Delete this chat
  forever? (a very long time)" + the chat's name + [delete] (err tone) /
  [keep it] buttons, all theme-var painted. Confirm:
  - chat icon: `DELETE /api/sessions/{id}` (engine drops session + events),
    then `world.remove(id)` + `icon.el.remove()` + `scheduleSave()`; if the
    master panel currently hosts THIS chat → close it first (the delete must
    never leave a panel whose session is gone).
  - web icon: local-only removal (no engine session) — same world/DOM/save
    path. If the tab is grouped, the group re-syncs (tabgroups' own removal
    path is honored).
  - A toast carries the truth ("chat deleted — its history is gone").
- **Pinned first in all-chats**: `chatsview.js` renders a `📌 Pinned` section
  ABOVE Today (same section chrome), populated from `/api/chats` rows whose
  session_id ∈ `window.doomalay.pinnedSessions()` (new app.js export).
  Pinned rows also wear the pin glyph in their topline; unpinned rows keep
  the date buckets exactly as today.
- Rig pins: hold-on-icon opens the icon menu (not the canvas menu), hold on
  empty canvas still opens New Bot/New Tab; pin toggles + persists across a
  save/load cycle; the delete overlay flow end-to-end (open → confirm →
  session 404 after; panel closed if it hosted it); the all-chats pinned
  section renders pinned-first; unpinned all-chats unchanged.

### §3 v1.36.3 — THE TRUE COMPASS (indicator scale · color · the glide)

- **Pinned-only**: `computeArrows()` filters `bot.pinned` — off-screen
  non-pinned entities get NO indicator (the user's default-off law).
- **Dynamic scale**: the arrow's size interpolates by the off-screen distance
  `d` (screen px from the clamped edge point to the true screen position):
  near (d→0) = **2.2×** the current default chevron, far (d≥D_REF, the
  reference = 1.5× the viewport diagonal) = **2.0×** — the user's two caps
  ordered by their own "further = smaller" law (both ~2× today's default; a
  10% dynamic band; `ARROW_SCALE_MAX/MIN` are one-line tunables). The chevron
  path draws through `ctx.scale(s, s)` so the shape stays the twin of today's.
- **Dynamic color**, priority order:
  1. a pinned CHAT: its family hex (the icon's badge/disc color — already
     theme-resolved for default families via the existing hex cache);
  2. a pinned TAB with a customized gradient spec: the gradient's first stop
     hex (its own color);
  3. nothing set (default-family chats, default-gradient tabs): a color
     SAMPLED FROM THE GRADIENT OF ALL COLORS — the hue wheel — hue =
     `hash(entity.id) % 360`, deterministic per entity (stable, never
     flickers), saturation/lightness adapted from the live theme accent
     (DoomTheme's resolved `--accent`, S/L reused; fallback S62/L55) so the
     rainbow still belongs to the theme's tone. Never a static solid list.
- **Press → the glide**: `computeArrows()`'s result is cached main-side
  (`lastArrows`, each entry {x, y, r, targetId}); a TAP (inputEnd, PENDING,
  no icon under the finger) hit-tests the cache first — a hit starts
  `cameraGlide(target)`:
  - the tick loop lerps `offsetX/offsetY` toward centering the target icon
    (target: icon screen pos = viewport center), ease-out cubic over ~600ms
    (longer distances clamp the duration — "smoothly and quickly"), full
    frames while gliding (`moving` semantics — the lattice + icons re-render
    per frame exactly like a pan);
  - the glide ENDS when the icon is within ~24px of center (a flash marks
    the arrival) or the target leaves the world;
  - the glide CANCELS on ANY canvas-surface interaction (inputStart on #c /
    #chatbots, pinch start, wheel on canvas) — but taps on UI chrome (the
    settings gear, the dock — separate DOM elements that never reach the
    canvas handlers) do NOT cancel it, exactly the user's law.
- **Worker mode**: the per-frame arrow message gains `s` (the scale) —
  gridworker paints `ctx.scale(s,s)` before the same path; main-mode
  `paintArrows` does the same. Both twins byte-share the geometry constants.
- Rig pins: pinned-only filter; scale monotonicity (near > far, caps 2.2×/
  2.0× of the default extents); the color ladder (family hex → gradient
  stop → deterministic rainbow, stable across frames); the glide (tap arrow
  → camera converges to center ±24px; a mid-glide canvas touch cancels; a
  UI-icon tap during the glide does not); worker-mode paint carries the scale.

### §4 v1.36.4 — THE HONEST BLOCKS (toggle + the full-text editor)

- **Engine**: two new session columns (the standard ALTER pattern):
  `ph_blocks_off INTEGER DEFAULT 0` + `block_overrides TEXT` (JSON map
  blockKey → text). PATCH keys `ph_blocks_off` (bool) + `block_overrides`
  (string, sanitized: valid JSON map, keys ⊆ the five block names, size cap
  32KB/entry). `expandPromptBlocks`:
  - `ph_blocks_off` → the five block TOKENS are removed (excluded) from the
    composed preamble+persona and the blank gaps collapse (the existing
    `\n\n\n` collapse law) — facts ({model} {date} …) still substitute.
  - an override for a block → its text replaces the live builder's expansion
    for that block (the edited truth wins; `collapsed:{artifacts}` yield rule
    still applies first).
  - `GET /api/sessions/{id}/blocks` gains `?full=1` (untruncated per-block
    text, 64KB block cap) + reports `ph_blocks_off` + `block_overrides`.
- **Client (persona.js `placeholdersView`)**:
  - THE TOGGLE: a master row at the top of the "live blocks" section — a
    themed switch pill (the `ph-scope-pill` pattern) reading
    `live blocks: ON | excluded`; tapping PATCHes `ph_blocks_off` + re-renders
    the view; a hint line states the law ("excluded from preambles AND
    personas — the live facts still expand").
  - THE EDITOR: every block row + every custom row gains an arrow (✎) that
    pushes `placeholderEditorView` — the persona-editor screen reused
    (CodeMirror markdown, line numbers, scrolling, dirty-state save pill):
    - live block: the editor opens with the override if set, else the FULL
      live expansion (`?full=1`); pills = [save override] [↺ reset to
      default] (clears the override) — an "override active" chip rides the
      header when one is set; saving PATCHes `block_overrides`.
    - custom (global/local): the editor opens with the value; save writes it
      back (PUT /api/placeholders for global; session PATCH for local);
      the row's truncation ellipsis problem dies (full text, scrollable).
- Rig pins: the toggle excludes all five blocks from the composed prompt
  (facts still in); overrides win over live text; reset clears; the editor
  loads the FULL text (>2000 chars — the old cap); PATCH round-trip.

### §5 v1.36.5 — THE LIVING LEXICON (research + the portable slice)

- **RESEARCH-V137-THE-LIVING-LEXICON.md** (the deliverable the user asked
  for — "research what it would take"): the four-rung ladder
  (L1 declarative templates → L2 fact-backed customs → L3 CEL-style
  expressions → L4 QuickJS-in-WASM arbitrary code), each rung's safety
  envelope, the bundle format evolution, the install-time trust gate, the
  CVE receipts, and the honest verdict for {win}-with-code.
- **THE SLICE THAT SHIPS** (rung L1, 100% safe, real for downloaders TODAY):
  - Engine: `substituteAllVars` gains ONE bounded second pass — a custom
    value that itself contains `{tokens}` re-expands once (depth 2, the same
    longest-first map; cycles terminate as literal leftovers — the law is
    documented in the code). A custom `{tip} = "running {model} today"`
    really renders the live model.
  - Bundle portability: the portable .md frontmatter's `placeholders:` line
    may now carry a JSON object of DEFINITIONS
    (`placeholders: {"mood":{"value":"playful","scope":"local"}}`). Publish
    (persona + preamble editors): the chat's customs that the text uses ride
    the frontmatter as definitions. Install (the hub import path): the
    definitions materialize into the installing chat's LOCAL map — reserved
    keys skipped (the hard-refuse law stands), the user's existing keys win
    (never overwritten), and the import bridge's suggestion rows disappear
    for keys that auto-installed. A downloader's persona/preamble "just
    works" — the placeholders arrive WITH it.
- Rig pins: the second-pass expansion (incl. the cycle-leftover law); publish
  writes definitions; install materializes them (reserved refused, existing
  keys preserved); the downloaded preamble expands with its carried customs.

### The ship — v1.37.0 THE COMPASS WAVE

- buildinfo → 1.37.0 + the wave record; the full battery: the new v1370 rig
  + the v1370 E2E walk (real engine, real browser, real taps/holds) + the
  Go suite (13 packages) + vet + linux/android(arm64, CGO=0) builds + the
  prior waves' rigs that still apply on this tree.
- The push protocol: fetch → diff → merge → rebase → publish (phases as
  v1.36.1…v1.36.5 commits, the ship as v1.37.0 + the tag), then CI watch.

## The will-NOT boundary (honest scope)

- NO arbitrary-code placeholder execution ships in this wave — that is L3/L4
  territory and rides the research doc's verdict + trust gates instead.
- The lost swift-canvas optimization is NOT silently re-attempted inside this
  wave; it gets its own honest re-delivery later if the user wants it.
- No new overlay surfaces beyond the two sanctioned ones (#menu IS the
  existing long-press overlay; ConnectOverlay IS the Overlay screen; the PV()
  panel views ARE the panel). No hard-coded colors anywhere — every new
  pixel rides theme vars (the pin badge, the menu rows, the delete warning,
  the rainbow sampler's tone, the editor chrome).
