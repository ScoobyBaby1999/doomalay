# RESEARCH-V0982 — THE ELEMENT CATALOG & THE LIBRARY SWAP STUDY

> The user's ask (2026-10-04): "browse the repo for everything and I mean
> every element that is displayed in every screen and group them into ur
> proposal like I did in the example below, but you group each element
> individually to one from our set list of allowed elements… Choose a
> library over home grown from scratch… this final research should look at
> the things we currently are doing from scratch in the plan, and check for
> swappable libraries that can get this job done."
>
> Method: five parallel exploration agents read the full web surface
> (app/atoms/lattice/physics/pixiworld/gridicon/gridworker · panel/
> chatpanel/chatclient/formatter/msgactions/webpanel/webtab/linkviewer ·
> settings/appearance/theme/tweaks/webtweaks/usagepanel/persona/lookio/
> recovery · connectoverlay/modelbrowser/modelpicker/providers/workspace/
> ghconnect/hfconnect/sandboxpicker/chatsview/keys/localmodels ·
> artifacts/hub/hubitem/hubrepo/hubpublish/uikit/icons/gesture/uiactive/
> templatesheet + the 5,647-line index.html), every claim carries file:line.
> Web research: 16 searches (scripts/research-v0982/). NO implementation
> this turn — this doc feeds v0.99/v0.100/v0.101.

---

## PART A — THE RATIFIED SET (the closed list of swappable elements)

The user's 16, kept verbatim, plus the three they anticipated (editor box,
list renderer, library card — all CONFIRMED gaps by census) and three more
the census forced (toast, meter, node). Final set: **22 members.**

| # | Member | Definition (what makes it THIS member) |
|---|--------|----------------------------------------|
| 1 | **Canvas** | The world surface itself — all three paint backends (main-thread 2D `#c`, worker 2D, Pixi `#c3`) plus the DOM icon stratum `#chatbots` and the pre-boot backdrop. Includes the background FIELD (gradients/mesh/patterns/texture tiles). |
| 2 | **Stars** | Every dot-like object in the world: the ambient dot sea, the checker BREATH groups, hero fireflies + their glow sprites, static glow dots, over-icons dots, origin marker, atom shell stars (front/back), orbit-group stars, the nebula fog + lit-limb highlight. |
| 3 | **Grid** | Every line-like world object: full grid lines, constellation segments, shuttle drift, depth bands, over-icons lines. |
| 4 | **Orbits** | The orbital geometry: atom shell ellipses (DOM/Path2D + the Pixi Graphics twin). |
| 5 | **Node** ★NEW | The workspace object: icon disc + custom image + name label + sandbox badge + persona ring + tap-flash/dragging states + off-screen arrows + the Pixi raster twin. The most-skinnable object in the app (family glyphs, persona badges, custom art) — it deserves its own slot, not "canvas furniture." |
| 6 | **Panel** | The chatbot host sheet: `#chat-panel` + handle/anchor + scrim + header + body + the 3 dock states (half/full/duck) + the composer strip + the master-panel view stack. Gains the **mini-sheet variant** (action sheets that slide from the bottom: `#msg-action-sheet`, `.art-sheet`). |
| 7 | **Overlay** | The rounded overlay box: ConnectOverlay chrome (box + static ✕ + per-page headers), `#artifacts-overlay` sheet, CropUI dialog, recovery screen, keys dialog (⚠ rogue second implementation — see PART F). |
| 8 | **Face card** | Rounded box whose JOB is nesting other elements: settings sections, color rows, gatelock boxes, grid-effects columns, expanded tool pills, sources/hub wraps, redirect banners, publish sections, stage cards, GradientUI editor host, unsaved-changes banner. |
| 9 | **Display card** | Box whose job is DYNAMIC FORMATTED TEXT rendering: usage stat cells, context card, account/model/provider rows, `.pv-row`s, docx/xlsx/archive viewers, codecards, YT cards, link-preview cards, artifact file cards, source cards, hero cards' body text, empty states, hint/status lines, the perf HUD chip. |
| 10 | **Message box** | The big-text-optimized box: user/assistant/error/thinking bubbles (already content-visibility virtualized + two-tier streaming), the names textarea, the persona CodeMirror body. |
| 11 | **Search bar** | The rounded text input: `#chat-input`, `.wt-omni`, find bar, `#mb-search`, `.hub-search`, `.cv-input`, `.pv-input`, key/token/name/URL inputs, `#ts-search`, member filter. |
| 12 | **Select box** | Press → options: native selects (font, sort, worldLayer, license, trigger-op, branch) AND the dropdown menus (send-menu, long-press menu) AND the segmented pickers (`.hi-viewseg`, `.hp-seg`, `.vw-tab` — same exclusive-choice contract, segmented form). |
| 13 | **Main pills** | The stretchable circle→pill: `UIPills.pill()`/`.dx-pill` family, header metadata pills (`#pill-*`), seg-lib segmented control, tool pills, effort pill, starter chips, queue chips, recovery chips, settings nav tabs, `.tw-bgseg`, hub chat/locallib/publish/retry pills, FABs (circle end-state), theme picker cards. |
| 14 | **Side pills** | The box-like defined pill: `.util-btn` trio (export/usage/tweaks), theme preset cards, `.pv-btn`/`.pv-btn-primary`, `.wtw-btn`, provider pills (`.wsp-pill`), option cards, `.wsx-opt`/`.wsx-act`/`.wsx-go`, `.ts-act`, connect CTAs, save/reset buttons, `.hub-libpill` type tiles, steppers row. |
| 15 | **Small pills** | The small icon/chip pill: `.dx-pill--sm`, `.dx-chip` tags, `.gr-mini`/`.gr-dir`/`.gr-color`/`.gr-rm`, `.color-row-reset`, `.crop-btn`, `.wtw-chip`, icon cells, token swatches, `.ph-scope-pill`, `.pe-mode-pill` + action pills, mode tags, status dots (`.dd-live-dot`, `.mb-curdot`, provider dots), badges (`.wsx-badge`, sandbox badges, price/ready chips), toasts (→ see member 20), jump pill, chevrons, removers, keycaps, `.hub-sortico`, `.art-tree-ctl`, `.artt-more`, dock buttons. |
| 16 | **Slider** | Every range control: size sliders, grid sliders, parallax, scatter/variation/bias/rotation, `.gr-angle`, `.crop-zoom`, `.pv-range`, webtweaks sliders, hub steppers (discrete form), the Free⇄Paid drag slider. |
| 17 | **Toggle** | On/off: `.app-switch` (grid effects, botLib/botDL, mind compact), bare checkboxes (perf page, branch pickers), Aa/Exact find chips. |
| 18 | **Editor box** ★NEW (user-anticipated) | Code/file editing surface: CodeMirror `.art-cm-host` + `.cm-s-doomalay` theme, `.art-fallback-ta`, publish payload/file textareas, `.wsv-ta`, rename inputs. |
| 19 | **List renderer** ★NEW (user-anticipated) | Selectable row/tree engine: the `.artt-*` tree (⚠ shipped TWICE — artifacts.js AND hubrepo.js), `.vw-arch-list`, `.ts-row`s, `.hub-bunch-sec` sections, `.cv-row`/`.cv-hit` chat rows, settings rows, account rows, space rows, model rows. Rows own their dividers (folds the day-divider gap). |
| 20 | **Toast** ★NEW | Transient notice pill — currently FIVE independent implementations (`.art-toast`, `#hub-toast`, `#hubitem-toast`, `#hubpub-toast`, `#ts-toast`, `#lookio-toast` = six). |
| 21 | **Meter** ★NEW | Progress/status gauge, linear + circular forms: `.wsp-loader` sweep+counter (v0.98.1), `.cwk-bar`, `.cwd` dots + `.cwt`/`.cwe` (the no-silence row), `.ctx-ring` conic gauge, usage context meter, `.mb-barfill` benchmark bars, `.cv-spinner`, `mb-spin`, the `--dl-p` download ring, `.wt-loading` dots. |
| 22 | **Library card** ★NEW (user-anticipated) | The art-bearing card species: `.hub-card`, `.hub-card--bunch` + flag, `.hub-bunch-hero`, `.hi-head` — user-designable art (gradient spec/PNG/icon → `paintCardBg`/`flagStyle`/`idGradient`), scrim, fold, FAB dock. This is the member that makes "each bundle has its own look" a first-class object. |

**Folded decisions (ratified):** segmented controls ride **Select box**
(segmented variant) where they behave as exclusive form pickers, and
**Main pills** where they are already pills (`.tw-bgseg`); status dots ride
**Small pills**; day dividers ride **List renderer** (row chrome); action
sheets ride **Panel** (mini-sheet variant); the icon SYSTEM (Lucide, 52
glyphs, `currentColor`) and the sketch-stroke language + tone-pair pattern
stay cross-cutting SYSTEM layers (not members — every member consumes them).

---

## PART B — THE COMPLETE CATALOG (every element on every screen → member)

Format: `element (file:line) → MEMBER`. CSS classes live in index.html (IH)
unless noted. Sources: five census agents, cross-checked.

### B1. THE CANVAS WORLD (home screen)

**The surface**
- `#c` lattice canvas (IH:5407; app.js:56-87) + worker twin (gridworker.js) → **Canvas**
- `#c2` over-icons canvas (IH:5413) → **Canvas**
- `#c3` Pixi world canvas ≥60 entities (pixiworld.js:392-395) → **Canvas**
- `#chatbots` DOM icon stratum (IH:5414) → **Canvas**
- pre-boot backdrop (IH:230-236) → **Canvas**
- parallax bg tiles + 13 gradient/pattern modes + texture tint (lattice.js:426-583) → **Canvas**

**Stars**
- ambient dot sea, baked 5-band tiles (lattice.js:798-910) → **Stars**
- the BREATH checker shimmer (lattice.js:1277) → **Stars**
- hero fireflies + glow halo sprite (lattice.js:804-847, 1321-1368; sprite 135-153) → **Stars**
- static glow dots (lattice.js:873-894) → **Stars**
- over-icons oversized dots (lattice.js:1152-1155) → **Stars**
- origin marker disc (lattice.js:38-42, 1370-1377) → **Stars**
- atom shell stars front/back + Pixi glow twins (atoms.js:56-135, 263-354; pixiworld.js:636-650) → **Stars**
- orbit-group star (halo stack, atoms.js:519-592) → **Stars**
- nebula fog sphere + lit-limb highlight (atoms.js:372-505, 548-555) → **Stars**

**Grid / Orbits**
- full grid lines + segments + shuttle drift + bands + over-icons lines (lattice.js:912-1030, 1163-1268, 1582-1744) → **Grid**
- shell ellipses + Pixi Graphics twin (atoms.js:238-255; pixiworld.js:624-635) → **Orbits**

**Nodes (workspace objects)**
- `.chatbot` wrapper + transform (gridicon.js:53-94) → **Node**
- icon disc `.icon` + custom image + family tint (chatbot.js:90-169; IH:328-352) → **Node**
- name label pill `.name` (chatbot.js:96-100; IH:353-369) → **Node** (label part; typographically a Small pill)
- sandbox badge `.sandbox-badge` (chatbot.js:105-181; IH:371-388) → **Node** (badge part)
- persona ring `.persona-ring` (chatbot.js:183-208; IH:389-408) → **Node** (ring part)
- tap-flash pulse + dragging lift (gridicon.js:97-101; IH:1356-1367, 310-313) → **Node** (states)
- off-screen arrows (app.js:268-326) → **Node** (direction affordance)
- Pixi raster twin of the whole node (pixiworld.js:199-295) → **Node** (GPU path)

**On-canvas chrome**
- perf HUD chip `#perf-hud-chip` (perfhud.js:119-167; IH:414-432) → **Display card** (micro)
- perf page rows (perfhud.js:175-256) → **Display card** rows + **Select box** + **Toggle**
- long-press menu `#menu` (app.js:1251-1289; IH:435-472) → **Select box** (floating variant)
- first-run card `.ce-card` + glyph + CTA (IH:715-798) → **Face card** (+ **Side pill** CTA)
- settings gear `#settings-btn` (IH:479-520) → **Small pill**
- dock capsule `#dock-expando` (IH:545-571) → **Main pill** (the canonical stretchable — grows capsule→sub-expansion)
- dock toggle + `.dock-btn` ×6 + `#dock-sub` (IH:572-701) → **Main pill** / **Small pill**
- panel scrim `#chat-scrim` (IH:1010-1019) → **Panel** (scrim)

### B2. THE CHAT SURFACE

**Panel shell**
- `#chat-panel` + full/half/duck docks + `.handle-bar` anchor + `#panel-tab-icon` + header/avatar/name/sub + body (IH:800-1000, 5492-5523; panel.js; gesture.js) → **Panel**
- `#panel-view-back` / `#panel-view-x` (IH:3037-3046) → **Small pill** ×2
- `#panel-model-btn` (IH:935-963) → **Main pill**
- view-stack atoms: `.pv-row` → **Face card** (row); `.pv-range` → **Slider**; `.pv-input`/`.pv-select` → **Search bar**/**Select box**; `.pv-btn` → **Side pill**

**Chat header**
- `#chat-header` row + chevron + summary (chatpanel.js:1567-1585) → **Panel** (header region) + **Small pill** (chevron)
- `#header-ctx-cost` (chatpanel.js:1576) → **Small pill** (text)
- `#header-ctx-ring` conic gauge (IH:3262-3299) → **Meter** (circular)
- `#pill-row` metadata pills: sandbox/model/artifacts/persona/mind/workspace (chatpanel.js:1645-1725; `projPillStyle`) → **Main pill** ×6
- `#util-row` export/tweaks/usage (chatpanel.js:1731-1769; IH:3229-3247) → **Side pill** ×3 (the user's named example)
- gatelock boxes `#gate-box-*` (chatpanel.js:1592-1603) → **Face card**
- mind view: compact toggle → **Toggle**; threshold → **Slider**; warn box → **Face card**

**Chat log**
- `.msg-row` + `.msg-bubble` user/assistant/error (chatpanel.js:5214-5356; IH:1660-1740) → **Message box** (×4 variants; user/assistant FORMATTED via formatter, error PLAIN)
- `.msg-think` reasoning `<details>` + summary + dot + elapsed + body (IH:2366-2390) → **Message box** (collapsible variant)
- `.tool-pill` + `-use/-result/-progress` + detail rows (IH:2510-2553) → **Main pill** (chip state) / **Face card** (expanded)
- `.fmt-artifact` file card (formatter.js:784-801; IH:2393-2410) → **Display card**
- `.src-wrap`/`.hub-wrap` sources + hub-results boxes (IH:2556-2622) → **Face card**
- `.src-card`/`.hmsg-card` rows (IH:2580-2657) → **Display card** (rows)
- `.hmsg-dl` download button → **Side pill**
- `.chat-working` no-silence row: `.cwd` dots + `.cwt` phase text + `.cwe` elapsed + `.cwk-bar` sweep + stalled variant + `.cw-switch` (chatpanel.js:4998-5007; IH:2417-2507) → **Meter** (activity) + **Side pill** (switch)
- `.chat-jump` + live dot (IH:1856-1884) → **Small pill** (floating)
- `.msg-day` day divider (IH:1723-1734) → **List renderer** (row chrome)
- `#msg-action-sheet` long-press sheet (msgactions.js:17-142; IH:2687-2706) → **Panel** (mini-sheet)
- formatter internals: headings/links/inline-code (solid by design) → text styles; `.fmt-codecard` → **Display card**; `.fmt-cbtn`/`-save` → **Small pill**; `.fmt-yt` YT card + PiP → **Display card**; `.fmt-cursor` → streaming caret (state)

**Composer**
- `#chat-inputbar` strip → **Panel** (composer region)
- `#chat-input` textarea (chatpanel.js:1066) → **Search bar** (input class) — note: the big-text OPTIMIZED box stays Message box; the composer's growth-capped input rides the lighter member
- `#chat-send` mode machine + `#chat-send-more` (chatpanel.js:462-675) → **Small pill** (primary icon)
- `#send-menu` (chatpanel.js:827-920) → **Select box**
- `#send-queue` + `.sq-row` chips (chatpanel.js:706-760) → **Main pill** (dashed)
- toolbar: effort pill → **Main pill**; `#seg-lib` + bundle segment (chatpanel.js:3481-3618) → **Main pill** (segmented); clear → **Side pill**; find btn → **Small pill**
- `#tpl-chip` + `#edit-banner` (IH:1968-2016) → **Side pill** ×2
- `.chat-find` find bar + chips (chatpanel.js:3140-3304) → **Search bar** + **Small pill** ×4
- `.chat-starters` chips (IH:1829-1849) → **Main pill** ×3

**Mini browser**
- `.wt-root`/`.wt-bar`/`.wt-omni`/`.wt-go`/`.wt-ext` (webpanel.js:184-192) → **Panel** (content) + **Search bar** + **Small pill** ×2
- `.wt-loading` dots (IH:1127-1142) → **Meter**
- `.wt-guard` redirect banner (IH:1208-1256) → **Face card** + **Side pill**
- `.wt-card` link preview (IH:1148-1200) → **Display card** + **Side pill** ×2
- `.lv-card` link viewer family (linkviewer.js; IH:2243-2276) → **Display card** (+ **Small pill** ✕/open)

### B3. SETTINGS & APPEARANCE

**Shell** — master **Panel** + `.settings-nav` tab strip → **Main pill** (tabs, per-page accent) + `.settings-section` → **Face card** + `.setting-row` → row in **List renderer** + `.hint` → text.

**Colors tab**
- theme preset cards (appearance.js:307-338) → **Side pill** (the user's named example — theme cards)
- color rows (collapsed head + name + banner + reset + arrow + lazy body) (appearance.js:360-451) → **List renderer** (row) hosting the editor
- `.crc-mark` customized/this-chat markers → **Small pill** (inline marker)
- GradientUI editor: `.gr-editor` box → **Face card**; `.gr-preview-bar` → **Display card** (preview); `.gr-color` swatches + `.gr-rm` + `.gr-mini` tools + `.gr-dir`/`.gr-pat` pills → **Small pill**; `.gr-angle` → **Slider**; `.gr-tex-thumb` → **Small pill** (thumb)
- Grid Colors rows + Chat Colors scheme chips + 5 fmt rows (appearance.js:453-595) → **List renderer** rows + **Small pill** (chips)
- all reset buttons → **Side pill**
- CropUI: `.crop-ui` → **Overlay**; top bar buttons → **Small pill**; `.crop-zoom` → **Slider**; stage+frame → content inside **Overlay**

**General tab** — font select → **Select box**; names textarea → **Message box**; reset view → **Side pill**; account rows → **Display card**; account action buttons → **Small pill**; import/export theme → **Side pill** ×2.

**Sizing tab** — 3 text sliders + grid spacing + parallax → **Slider**; Dots/Lines columns → **Face card** ×2; hide/animate toggles → **Toggle** ×4; scatter/variation/bias/rotation → **Slider** ×8; reset → **Side pill**.

**Tweaks** — icon grid cells → **Small pill**; browse-image/back-to-family → **Side pill**; scheme chips + fmt rows → (as Colors tab); size sliders → **Slider** ×3; botLib/botDL → **Toggle** ×2; `.tw-bgseg` gradient/image segment → **Main pill**; gradient zone + preview strip → **Face card** + **Display card**; image zone pickers/removers → **Side pill**.

**Webtweaks** — mode chips → **Small pill** ×3; icon gradient editor → **Face card**; fs/fsSite sliders → **Slider** ×2; color chips → **Small pill**; tint editor → **Face card**; filter chips ×6 → **Small pill**; brightness slider → **Slider**; reset → **Side pill**.

**Usage** — 3 stat cells → **Display card**; context card → **Display card**; context meter → **Meter** (linear); pct/notes → text; model rows → **Display card** (rows); fleet button → **Side pill**; fleet view cells/rows → **Display card**.

**Persona** — list rows → **List renderer** (+ **Display card** rows); mode tag pill → **Small pill**; editor: mode pills ×4 → **Small pill**; action pills (save/default/dl/publish/del) → **Small pill** ×5; name input → **Search bar**; badge pill → **Small pill**; CodeMirror body → **Editor box**. Badge picker: preview → Display card (preview); kind sections → **Side pill**; token grid swatches ×13 → **Small pill**; angle presets → **Small pill**; upload/save/cancel → **Side pill**. Placeholders: key/val inputs → **Search bar**; scope segment → **Small pill**; add → **Side pill**.

**Lookio** — export/import buttons (General tab) → **Side pill**; `#lookio-toast` → **Toast**; the `.doomtheme` bundle = data (format discussion in PART D).

**Recovery** — `#doomalay-recovery` → **Overlay**; reload → **Main pill**; reset → **Small pill**.

### B4. OVERLAY SCREENS & CONNECT FLOWS

**Chrome (ConnectOverlay)** — box + scrim + `#connect-overlay-x` → **Overlay**; per-page headers (`.wsx-head`, `#mb-head`…) → page content inside **Overlay**.

**Model browser** — tabs ★/Providers/Models → **Main pill** (segmented → Select box family); sync button + label → **Small pill** + **Meter** (spin state); live-count line → **Display card**; `#mb-search` → **Search bar**; filters toggle → **Toggle**; "N on" badge + clear + ufchips + filter pill grid + sort select → **Small pill** family + **Select box**; provider boxes `.mb-provbox` → **Face card**; headers with dots/counts/grips → rows; ready/+key badges → **Small pill**; live dots → **Small pill** (status); inline key form → **Search bar** + **Side pill**; model rows `.mb-logrow` → **List renderer** (rows); star/info/scale buttons → **Small pill**; price chips → **Small pill**; current dot → **Small pill**; subtext chips + 32×3 mini-bars → **Small pill** + **Meter** (mini); host rows → **List renderer**; detail drawer with benchmark bars → **Display card** + **Meter**; compare drawer → **Face card** + **Side pill** + **Small pill**; empty states → **Display card**; pagination `.mb-more` → **Side pill**; `.mb-hint` inline toast → **Toast**.

**Model picker** — option cards → **Side pill** ×2.

**Providers screen** — reminder/syncing banners → **Display card**; dev pill → **Side pill**; Free⇄Paid slider → **Slider**; provider cards → **Face card**; brand dots → **Small pill**; Free/Paid/Active chips → **Small pill**; validation states → **Display card** (status); key inputs → **Search bar**; save buttons → **Side pill**; use-models buttons → **Side pill**; get-key links/hints → **Display card**.

**Workspaces** — picker: head/count badge/section labels → **Overlay** content + **Small pill**; `.wsp-loader` (v0.98.1 themed loader) → **Meter** (linear + counter); empty state → **Display card**; `#wsx-connect` CTA → **Side pill** (primary); workspace rows → **List renderer**; action drawer pills → **Small pill**. Connect page: provider pills → **Side pill** ×5; logged-in box → **Display card**; sign-in/create/device rows → **Side pill**; public-repo box + URL bar + go → **Face card** + **Search bar** + **Side pill**; repos box → **List renderer** (scroll list); owner headers + repo rows + type marks + access pills → **List renderer** + **Small pill**; sub-pages (gitea token, cloud form, token upgrade, HF chooser, create form, repo detail + branch checkboxes, device page, file viewers, tree) → the same members (**Search bar**, **Select box**, **Side pill**, **Toggle**, **Face card**, **List renderer**, **Editor box** for `.wsv-ta`); `#pill-workspace` header pill → **Main pill**.

**GH/HF connect** — service badges → **Small pill**; state boxes → **Display card**; primary OAuth buttons → **Side pill**; token inputs → **Search bar**; connect buttons → **Side pill**; device-flow box: big code display → **Display card** (code variant); copy → **Small pill**; open-site → **Side pill**; HF logs: tabs → **Main pill** (segmented); stream pre → **Display card**; wake → **Side pill**.

**Sandbox picker** — option cards ×4 → **Side pill**; HF mini pills → **Small pill**; desc cards → **Display card**; spaces list + rows + stage badges → **List renderer** + **Small pill**; create pill → **Side pill** (dashed); create form → **Search bar** + **Side pill**; build watcher → **Meter** (progress); age-gate card → **Display card** + **Side pill**; public-space box → **Face card** + **Search bar** + **Side pill**.

**Global search (chatsview)** — search row + input + count chip → **Search bar** + **Small pill**; Aa/Exact chips → **Toggle**; chat groups + rows + badges + tags + hits + `<mark>` → **List renderer** (+ **Small pill** badges); empty/loading + `.cv-spinner` → **Display card** + **Meter**.

**Keys dialog** ⚠ — `.kb-scrim`/`.kb-card`/`.kb-close` = a ROGUE second overlay implementation with a hardcoded `rgba(0,0,0,.48)` scrim (keys.js:33) → consolidate into **Overlay** + **Small pill**.

**Local models** — ⚠ duplicate in-page `#lm-close` ✕ under the static overlay ✕ → consolidate; status/recommended/installed cards → **Display card** + **Face card** + **Side pill**.

### B5. ARTIFACTS, LIBRARY, SHARED KIT

**Artifacts drawer** — `#artifacts-overlay` + `.art-panel` + `.art-head` (drag handle, v0.98.1) + title/count/tree-ctl/close → **Overlay** (sheet form); `.art-loading`/`.art-empty` → **Display card**; the `.artt-*` file tree (chevrons, icons w/ FileTypes colors, indent rails, rows, ⋯ more) → **List renderer** (tree) — ⚠ duplicated in hubrepo.js; action sheet + confirm chips + toast → **Panel** (mini-sheet) + **Small pill** + **Toast**; editor: CodeMirror surface → **Editor box**; action strip (save/dirty/rename/dl/del) → **Small pill** ×5; fallback textarea → **Editor box**; rename input → **Search bar**; unsaved banner → **Face card**; viewers (docx/xlsx tabs/archive/binary) → **Display card** + **Select box** (tabs) + **List renderer** (archive rows).

**The hub (public library)** — root tone pairs → system layer; `.hub-chatrow`/chat pill → **Main pill**; `#hub-locallib` mine filter → **Main pill**; topdock sticky glass → system chrome; collapsible Public Library header → **Face card** header pattern; scrunch search icon → **Small pill**; `.hub-search` → **Search bar**; sort icon pills ×4 → **Small pill**; librow type tiles `.hub-libpill` ×6 → **Side pill** (the user's named example); steppers + tone value windows → **Slider** (discrete) + **Small pill**; publish pill → **Main pill**; tag pills → **Small pill** (dx-pill--sm); `#hub-toast` → **Toast**; grid cards `.hub-card` + art layer + fade + ico + marquee name + desc/author + heart/dl/stats → **Library card**; pager + empty/retry → **Side pill**; bunch cards + notched `#tag` flag + foldable hero + view segments + member filter + collapsible sections + FABs (download ring/heart/use/delete + confirm bars) → **Library card** + **Select box** (segments) + **Search bar** (filter) + **List renderer** (sections) + **Main pill** (FAB circles) + **Meter** (`--dl-p` ring); item detail `.hi-head` hero + chips + counts + stage tree + FAB row → **Library card** + **Small pill** + **Display card**; repo browser `.hubrepo-tree` → **List renderer** (the duplicate); file preview → **Display card**.

**Publish flow** — 4 collapsible `.hp-sec` cards → **Face card** ×4; essentials (name/desc inputs, tag chips, icon grid ×52 + upload) → **Search bar** + **Small pill**; card design (segment, GradientUI, reroll, image pick, preview) → **Select box** + **Face card** + **Small pill** + **Display card** (preview); payload (stages count, textarea, focus) → **Editor box**; repo files rows → **Editor box** + **Search bar** + **Small pill**; publish CTA + dirty guard + error → **Side pill**.

**Template sheet** — search → **Search bar**; 3 action buttons → **Main pill**; group headers + counts → **List renderer** (group rows); `.ts-row` + star + chip + meta + on-state → **List renderer** + **Toggle** (star) + **Small pill** (chips); empty/notice states → **Display card**; detail: tags/stage cards/number chips (accent-gradient windows)/actions → **Face card** + **Small pill** + **Side pill**; `#ts-toast` → **Toast**; `#tpl-chip` (composer) → **Side pill**.

**Shared kit (uikit)** — `UIPills.pill()` → **Main pill**; `.dx-pill--sm`/`.dx-chip` → **Small pill**; GradientUI → **Face card** hosting **Small pill**s + **Slider** + preview **Display card**; CropUI → **Overlay** + **Slider** + **Small pill**s; icons (IconLib, 52 Lucide glyphs, currentColor) → system layer; uiactive states (`.dd-active`, dots, tab sweeps) → state layer on top of members; gesture.js → the **Panel** behavior engine (creates ZERO visual elements — verified).

### B6. CENSUS TOTALS

| Member | Instances found (approx, from the five censuses) |
|--------|--------------------------------------------------|
| Small pills | ~90 (the workhorse) |
| Display card | ~45 |
| Side pill | ~40 |
| List renderer | ~35 row families (incl. the 2 tree copies) |
| Face card | ~25 |
| Main pill | ~30 |
| Search bar | ~22 |
| Slider | ~24 |
| Select box | ~12 (+ segments) |
| Toggle | ~14 |
| Meter | ~15 (5 of them previously unmapped "GAPs") |
| Message box | ~8 |
| Panel (incl. mini-sheets) | ~10 |
| Overlay | ~8 (2 rogue implementations) |
| Editor box | ~7 |
| Toast | 6 implementations (should be 1) |
| Library card | ~6 species |
| Node | 1 object × 3 render paths |
| Canvas/Stars/Grid/Orbits | the world (3 paint backends) |

---

## PART C — THE SLOT REASSIGNMENT INPUT (border vs surface-raised, the user's complaint)

The census confirmed the user's suspicion with file:line evidence. The
v0.79.3 rebalance already moved outline pills OFF surface-2 onto
`--raised-ring = color-mix(in oklch, var(--border), var(--surface-2) 30%)`
— a BLEND of both families (index.html:4698-4715). Eight findings:

1. **The v0.72 leak, quoted in code** (index.html:4621-4634): a border
   gradient layer painted whole cards → the 3-layer PLATE fix.
2. **Hairlines are STILL split**: `--surface-2` paints dividers
   (index.html:911, 1391, 1435, 1513, 1518, 3053, 3136, 3143) while
   `--border` paints other hairlines (1541, 4386, 3165/3171…) — same
   screens, two variables, two divider colors.
3. **`--border-strong` rides the border gradient sweep** (theme.js:518-520)
   while ALSO tinting the canvas family (theme.js:687-694) and card rings —
   one var, three jobs.
4. **The chatbot disc reads both at once** (index.html:4760-4767):
   surface-2 window + surface-2 plate + border ring.
5. **DoomGates treats them as one pipeline** (theme.js:2322-2327, 2501-2513).
6. **BLOCK_READ_SET asymmetry** (theme.js:345-346): reads border-strong but
   not border.
7. **gr-editor was de-assigned** from surface-raised mid-flight
   (index.html:4648-4657) — the assignment instability is the symptom.
8. **Usage stat cells use surface-2 as the divider** (usagepanel.js:42) —
   a settings-screen var leaking into a chat view.

**The FIELD model fixes this by construction** (PLAN-V098-COLOR-SYSTEM):
the 10 customizable vars + 5 fmt + 3 grid slots shrink to
`--field-surface / --field-ink / --field-accent-1..3 / --field-canvas /
--field-fmt`. Mapping proposal:

| Today | Field model |
|-------|-------------|
| `--surface-1` (panels/cards/bubbles) | `--field-surface` (the plate) |
| `--surface-2` (raised chrome) + `--surface-3` (press/rings) | DERIVED: `color-mix(in oklch, --field-surface, --field-ink 6%/14%)` — raised stops being a user slot (it was fighting surface/border anyway) |
| `--border` + `--border-strong` + `--raised-ring`/`--raised-chrome` | DERIVED: `color-mix(in oklch, --field-surface, --field-ink 18%)` (+ the field-window ring where gradients demand it) — ONE hairline owner, the split ends |
| `--text-1/2/3/-dim` | `--field-ink` (+ color-mix tints — already the v0.98 direction: "ink never a window") |
| `--accent`, `--accent-2/3/4` | `--field-accent-1..3` (accent-4 folds into the tone-pair system per-scope) |
| `--bg-panel` (canvas bg) + grid bg | `--field-canvas` (spec: solid/gradient/image → the field atlas) |
| `--bg-app` (overlay bg) | DERIVED from `--field-surface` (or rides the canvas field window) |
| `--fmt-a1/a2/a3/bright/link` | `--field-fmt` (keeps 5 named stops, fed from accents by default) |
| grid line/dot/origin | `--field-canvas` children (sampled from the canvas field — the lattice already consumes a spec object, not CSS vars: theme.js:796-849) |
| `--ok/--warn/--err/--notice`, persona/template tints | SYSTEM colors (not user slots; stay theme-carried) |

**Lag note (the user's "border/surface-raised cost more than canvas
background"):** exactly right mechanically — the canvas field rasterizes
ONCE into tiles (lattice bake), while border/surface-raised changes
re-mint the DoomGates derived-gate stylesheets + re-snapshot every L2
window element (theme.js epoch re-mint). The FIELD model's per-epoch atlas
applies the canvas's bake-once economics to every slot — that is the
plan's central perf claim, and the census's var-consumer tables (PART B's
color-source annotations) are the input to Batch 2 (the slot assignment
table).

---

## PART D — THE LIBRARY SWAP STUDY (homegrown → MIT/Apache library)

The rule from the user: **prefer a library over homegrown.** Verdicts,
from the 16 searches (scripts/research-v0982/) + license verification:

### ADOPT (5)

| Library | License | Replaces (homegrown today) | Why |
|---------|---------|---------------------------|-----|
| **culori** | MIT | `shadeHex`/`lighten`/`darken`/`mixHex`/`hslToHex`/`rgbToHsl`/`paletteAt` (uikit.js:188-276) + lattice's `quantColor` helpers (lattice.js:155-194) + theme.js OKLab blends (565-577) | The modern consensus color engine: full OKLab/OKLCH/P3, tree-shakeable to ~5KB, functional API. One correct perceptual math layer everywhere JS must know a color (canvas dots, exports, gradient interpolation, ink derivation fallbacks). Search-confirmed the ecosystem consensus (vs chroma.js sRGB-centric). |
| **material-color-utilities** | Apache-2.0 | NOTHING today (the image→theme flow doesn't exist) | Google's Material You engine (google/material-foundation): `sourceColorFromImage` → seed → 9 dynamic schemes (TonalSpot, Vibrant, Expressive…). This IS the "user picks an image → every object projects it" pipeline, battle-tested in Android 12+. Slot into the FIELD editor as the image→`--field-accent-1..3` suggester. |
| **PixiJS extensions** (already vendored, MIT) | MIT | (a) the planned 9-slice asset scaling — `NineSliceSprite` ships in Pixi; (b) gradient TEXT — v8 `FillGradient` on `Text`/`BitmapText`; (c) the planned field atlas — `RenderTexture` | Zero new dependency — the license is already paid, the runtime already ships, the icon world already lazy-loads it. v0.101's 9-slice masks and any GPU text moment ride it. |
| **DTCG design-tokens format** (W3C CG spec) | open spec | the `.doomtheme` private JSON shape (lookio.js:44-115) | Not a library — the interchange FORMAT. Adopting DTCG keys (`$value`/`$type`/`$metadata`) for the FIELD slots inside `.doomtheme` v2 makes bundles readable by Tokens Studio/Style Dictionary/Figma plugins for free — the public-library bundles become a real ecosystem format. Keep the magic + loader; fold legacy shapes on read (the plan's Batch 5 already promises import compat). |
| **Lucide** (already vendored) | ISC | — | Confirmed healthy; the swappable-ICON story (every glyph skinnable per theme) extends it, not replaces it. |

### KEEP (no swap needed — already the right library)

- **CodeMirror 5** (MIT, vendored) — the **Editor box** member's engine. (Note for later: CM6 is the maintained line; CM5 is frozen-but-stable. Not this wave.)
- **marked + DOMPurify + Prism** (MIT/MIT/Apache, vendored) — the **Display card**/**Message box** text pipeline.
- **GSAP verdict stands** (from v0.96 research): NOT vendored — compositor transforms + the worker world don't need it.

### REJECT (considered, documented, declined)

| Candidate | License | Verdict |
|-----------|---------|---------|
| Shoelace / Lion / UI5 web-component kits | MIT / Apache-2.0 / Apache-2.0 | Fight the closed-set philosophy: shadow-DOM theming vs our var-twins/L2 field windows, ~100KB+ weight into a Go-embedded bundle, and a default look we'd have to un-design. Our 22-member set IS the component contract; UIPills is its embryo. |
| Style Dictionary (runtime use) | Apache-2.0 | Build-time token DISTRIBUTION — our editor IS the runtime. Rejected before (RESEARCH-COLOR-REWORK); stays rejected, BUT its v4 token format is DTCG — so the format adoption above inherits its tool interop anyway. |
| node-vibrant / color-thief | MIT | Redundant with material-color-utilities (extraction + scheme in one, Google-maintained). Skip. |
| chroma.js | Apache-2.0 | Culori strictly better for perceptual spaces (established v0.89.8; reconfirmed). |
| Rust/WASM color crate | — | Over-engineering (established v0.89.8; the culori math is microseconds at our scale). |
| Houdini Paint Worklets | — | Right for STATIC plates (a future option for the border ring), wrong for anything the L2 layers already do cheaper; WebView flakiness. Keep parked. |

### PRUNE (dead weight found by the census)

- **wunderbaum** (MIT, vendored) — the tree was replaced by hand-rolled `.artt-*` (v0.42); vendor JS + the `.wb-*` CSS override block (index.html:2809-2865) + LICENSE are dead weight. Remove in the list-renderer wave.
- **`.artt-*` tree CSS shipped twice** (artifacts.js:401-453 AND hubrepo.js:117-153) — the **List renderer** member dedupes it.
- **keys.js rogue overlay** (own scrim/card/✕ + the last hardcoded color `rgba(0,0,0,.48)`) — consolidate onto **Overlay**.
- **localmodels `#lm-close` duplicate ✕** — the same double-X the catalogue screen had (fixed v0.98.1); this one remains.
- **`.ts-star-on` hardcoded amber `#f5b642`** (index.html:2068) — theme-violation to fold into the Meter/Small-pill accent system.
- **Dead CSS**: `.hub-bundles` (3584-3611), `.hub-bunch-chip` (3814), `mark.chat-search-mark` (2675), `.pv-row-sub`.

---

## PART E — THE GRADIENT TEXT LAG (the user's phone)

**Root cause (mechanism, not guess):** gradient text today = CSS
`background-clip: text` over a `background-attachment: fixed` gradient
twin — and `background-attachment: fixed` is effectively **unsupported on
Android WebView/mobile Chromium** (the long-standing blink bug set), which
is exactly why the repo built the L2 fixed-attachment emulation (pseudo
layers + observer). The remaining phone lag is the OTHER half:
`background-clip: text` makes the browser paint the text as a MASK and
composite the gradient through it — every scroll/repaint re-rasterizes the
masked text run. Titles scroll → every frame pays the mask tax.

**The verdict — three tiers, no new dependency:**
1. **Body/long text: NEVER a window** (already the v0.98 plan:
   `--field-ink` derives via color-mix, solid). This kills the bulk of the
   cost — most gradient text moments become free.
2. **Short static gradient moments (titles, the few `data-text-grad`
   spans): keep CSS clip BUT drop the fixed-attachment illusion** — a
   locally-sized gradient (the element's own box) costs one paint, not
   per-scroll re-projection. If the shared-field illusion must hold, the
   L2 transform-carried layer (no re-raster in motion) is the ceiling.
3. **Animated/hero gradient text: Pixi `Text` with v8 `FillGradient`**
   (already vendored) — GPU raster, one texture, compositor-cheap. Use
   only where a title is the moment (empty states, hero cards).

There is **no mainstream open-source "gradient text" library** (searches
return technique articles, not packages — the space is CSS/SVG/canvas
technique). The library answer is Pixi for the GPU tier + culori for the
interpolation; the rest is the plan's own ink-vs-window discipline.

---

## PART F — WHAT THIS FEEDS (the waves, unchanged scopes, better ammo)

- **v0.99 THE FIELD**: the slot model + atlas + picker. The census's
  var-consumer tables (PART B/C) are Batch 2's input; the border/surface
  merge (PART C) is the slot-shrink's justification. culori lands here
  (the ink/mix fallbacks + canvas sampling).
- **v0.100 THE MASKS**: pseudo-only L2 + the plate/ring redesign. PART E's
  tier rules ride; the toast/meter/overlay consolidations are cheap wins
  to bundle.
- **v0.101 THE ASSETS**: user-uploadable field images + 9-slice shape
  assets (Pixi `NineSliceSprite` + CSS `border-image`) + the swappable
  editor. material-color-utilities lands here (image→accents); DTCG keys
  land in the `.doomtheme` v2 shape; the **Library card** member +
  wunderbaum prune + list-renderer dedupe ride here.
- **The Node member** gives bundles a skinnable canvas object (persona
  rings/disc art already are per-node skins); **every member's swappable
  skin** + DTCG bundles + the hub's existing card-design system = the
  user's "public library where each bundle has its own look" endgame.

**No implementation this turn** — this is the research the waves will be
built from.
