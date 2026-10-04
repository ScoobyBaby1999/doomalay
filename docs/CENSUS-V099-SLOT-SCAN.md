# CENSUS-V099 — THE SLOT SCAN (batch 2/3 of the color-rework repo scan)

> Feeds PLAN-V098-COLOR-SYSTEM.md ("The Field & the Masks"). Everything
> below is measured from the v0.98.0 tree (`0881d47`): a brace-matching CSS
> rule parser over index.html's single `<style>` block + ripgrep over the
> JS. **index.html = 5,643 lines / 1,117 CSS rules / 701 rules consume ≥1
> var() / 91 distinct vars consumed.** JS files add ~1,600 more `var(--…)`
> spellings inside injected `<style>` strings and inline styles.
> File:line refs are exact. Method notes at the bottom.

---

## A. VARIABLE INVENTORY

### A1. Static definitions in index.html

| Family | Vars (static sites) | Definition sites (index.html) |
|---|---|---|
| **canvas/overlay bg** | `--bg-app`, `--bg-panel` (+`-rgb`) | :root L17–18; per-theme blocks L79–224; `--bg-app-rgb` statics L5387–5396; `--bg-panel-rgb` derived at runtime |
| **surface** | `--surface-1`, `--surface-2`, `--surface-3` (+`-rgb`) | :root L19–21; per-theme L80–82 etc. |
| **border** | `--border`, `--border-strong` | :root L22–23; per-theme L83, L104… |
| **text** | `--text-1`, `--text-2`, `--text-3`, `--text-3-dim` (+`--text-3-rgb`) | :root L24–27; per-theme L90, L105… |
| **accent** | `--accent`, `--accent-2..4` (+`-rgb`) | :root L28–32; per-theme L91–94… |
| **semantic** | `--ok`, `--warn`, `--err`, `--notice` (+`-rgb`) | :root L33–39; per-theme L96… |
| **pill tones** | `--persona-tint`/`-rgb`, `--template-tint`/`-rgb` | :root L43–44; paper/frost overrides L204–205, L223–224 |
| **derived ink** | `--on-accent`, `--on-brand`, `--on-ok`, `--veil-ink`(+`-rgb`), `--text-shadow` | :root L30, L56–66 (runtime re-derived) |
| **fmt** | `--fmt-a1`, `--fmt-a2`, `--fmt-a3`, `--fmt-bright`, `--fmt-link` (+`-gradient`, `+-ink` runtime twins) | :root defaults L1652–1657 (all alias accent-2/text-1) |
| **sizing (not color)** | `--chat-fs`, `--chat-scale`, `--ui-fs`, `--ui-small-fs`, `--ui-micro-fs` | :root L68–75 |
| **raised chrome** | `--raised-chrome`, `--raised-ring` | L4707–4711 (flat fallback + color-mix(in oklch) derivation) |
| **wunderbaum** | `--wb-node-text-color`, `--wb-border-color`, `--wb-hover-color`, `--wb-active-color`, `--wb-error-color` + 8 wb vars | .art-tree L2807–2822 |
| **perfhud** | `--p`, `--thr`, `--ring`, `--zone`, `--tick-op` (+ @property --p) | .ctx-ring L3266–3268 |
| **hub tones** | `--hub-tone`, `--hub-tone-rgb` (+`--hub-cols`) | .hi-root L4021; per-tone L4024–4028 |
| **runtime misc (non-color)** | `--panel-vis-h` (gesture.js), `--wt-fs`, `--wt-c1`, `--wt-c2` (webtweaks.js), `--artt-ind`, `--artt-rail` (artifacts.js), `--d` (workspace/hubrepo tree depth), `--dd-accent` (uiactive.js), `--slide-t/--slide-d`, `--dl-p`, `--wsp-c/--wsp-rgb/--kp/--kpc` (workspace.js injects), `--x-rgb` (appearance.js row banners) | see respective files |

The 10 **[data-theme]** blocks are midnight(:root), nebula L78, ember L99,
forest L114, ocean L129, rose L144, mono L159, solar L174, paper L189,
frost L208 — each re-declares bg/surface/border/text/accent/semantic sets.

### A2. Runtime-generated vars (theme.js `applyTheme`, L463–728)

Twins per CUSTOMIZED var (only when a `themeOverrides[themeId]` entry exists):
- `--X` (solid twin = first color) + `--X-gradient` (background-image or literal `'none'`) — derived by `deriveTwins()` L105 / `deriveBorderTwins()` L266 (border gets the SINGLE-LAYER 135° sweep; patterns dropped)
- `--border` override also derives `--border-strong-gradient` (L519)
- `-rgb` triplets auto-derived from the SOLID twin via `RGB_PAIRS` (L302–308): accent 1–4, ok, warn, err, bg-app, surface-1, surface-2, bg-panel

Always derived every apply (base themes too):
- `--bg-panel-rgb` (L542), `--on-accent` (L546–549), `--on-accent-2/3/4` (L553–558)
- `--veil-ink`, `--veil-ink-rgb` (surface-1 luminance, L578–589)
- `--on-surface-1`, `--on-surface-2`, `--on-bg-app`, `--on-border` (bright-ink gates, L594–618)
- `--text-2/-3/-3-dim` + `--text-2-rgb` re-derived when `--text-1` is overridden (L565–577)
- text sizes `--chat-fs`, `--chat-scale`, `--ui-fs`, `--ui-small-fs` (L637–643)
- fmt slots via `Formatter.applyScheme` → `--fmt-<slot>`, `--fmt-<slot>-gradient`, `--fmt-<slot>-ink` on :root + `data-fmt-grad` attr (formatter.js L130–149)
- `#meta-theme-color` content (Android status bar) + `DoomalayConfig.families.default.color` = resolved `--border-strong` (L689)

Root GATE attributes (state, not colors): `data-text-grad`, `data-a1..a4-grad`,
`data-s1-grad`, `data-s2-grad`, `data-bg-grad`, `data-border-grad`,
`data-bright-s1/s2/bg/border` (L651–667).

Projection painter vars: `--proj-tx`, `--proj-ty` written per motion tick
into ONE root CSSOM rule (theme.js L964, L1041–1042) — consumed by every
fixed-attachment window's `background-position: calc(var(--proj-tx) + Bpx)`.

### A3. User-customizable vs internal

**CUSTOMIZABLE (theme.js `CUSTOMIZABLE` L309–328) — the 10 the Colors tab edits:**

| Var | Label | Hint (as shipped) |
|---|---|---|
| `--bg-panel` | Canvas background | the infinite grid canvas · gradients, patterns + textures |
| `--bg-app` | Overlay background | overlay screens · collapsible headers · scrims |
| `--surface-1` | Surface | panels · cards · bubbles |
| `--surface-2` | Surface raised | inputs · hover · raised cards |
| `--border` | Borders | hairlines + outlines |
| `--text-1` | Primary text | body text · gradients paint the titles |
| `--accent` | Accent 1 | the primary accent · user bubbles |
| `--accent-2` | Accent 2 | the adjacent accent |
| `--accent-3` | Accent 3 | the third accent |
| `--accent-4` | Accent 4 | scripts + providers |

**NOT customizable (internal/derived):** `--surface-3` (55+ consumers, no
editor row, no gradient twin — the plate-catcher at L4904 paints it solid),
`--border-strong` (rides the border sweep only), `--text-2/-3/-3-dim`,
`--veil-ink`, `--on-*`, `--raised-chrome`/`--raised-ring` (color-mix of
surface-2+bg-app / border+surface-2), `--ok/-warn/-err/-notice`,
`--persona-tint`/`--template-tint`, the 5 `--fmt-*` slots (separate editor
family), grid slots bg/lineColor/dotColor/originColor (canvas-side specs,
not CSS vars), `--hub-tone`, `--wsp-*`.

---

## B. USAGE CENSUS (index.html consumers per family)

Counts = number of CSS **rules** consuming the var (a rule with the var in
3 declarations counts once). Gradient twins and `-rgb` twins counted
separately.

| Var | Rules | Var | Rules | Var | Rules |
|---|---|---|---|---|---|
| --ui-small-fs | 105 | --err | 22 | --bg-app | 9 |
| --text-3 | 104 | --border-strong | 17 | --bg-panel | 8 |
| --text-1 | 92 | --accent-gradient | 14 | --wt-fs | 8 |
| --accent | 66 | --err-rgb | 13 | --fmt-link | 8 |
| --text-2 | 65 | --fmt-a2 | 13 | --warn | 8 |
| --surface-2 | 59 | --hub-tone | 13 | --accent-3-gradient | 8 |
| --border | 57 | --hub-tone-rgb | 11 | --accent-4-gradient | 7 |
| --surface-3 | 53 | --text-3-dim | 10 | --border-gradient | 7 |
| --accent-rgb | 49 | --surface-3-rgb | 10 | --accent-3 | 6 |
| --raised-chrome | 46 | --fmt-a3 | 10 | --fmt-bright | 6 |
| --ui-fs | 45 | --bg-panel-rgb | 12 | --text-shadow | 6 |
| --accent-2 | 40 | --fmt-a1 | 12 | --on-accent-3 | 6 |
| --accent-2-rgb | 40 | --bg-app-rgb | 5 | *(full ranked list: 91 vars — see /tmp census JSON preserved in scripts)* |
| --chat-scale | 40 | --accent-2-gradient | 9 | | |
| --surface-1 | 34 | --surface-1-gradient | 5 | | |
| --ui-micro-fs | 33 | --surface-2-gradient | 4 | | |
| --chat-fs | 26 | --ok | 12 | | |

Combined **raised family** (`--surface-2` 59 + `--raised-chrome` 46 +
`--raised-ring` 4 + `--surface-2-gradient` 4 + `--surface-2-rgb` 4) =
**~110 rule-slots across 77 distinct selectors**. Combined **border family**
(`--border` 57 + `--border-strong` 17 + `--border-gradient` 7 +
`--border-strong-gradient` 1 + `--raised-ring` 4) = **~86 rule-slots across
74 distinct selectors**. `--surface-3` alone: 53 rules (NOT customizable,
NOT documented in the tab — the silent 11th color).

### B1. The border-family consumers (74 selectors, --border/--border-strong)

Fill/outline mixes (from the declaration-level scan):
- **--border as FILL (background/stroke)** — "looks like fill, colored by border": `#menu button:hover/active` L662, `#chat-panel .handle-bar` L684/L967, scrollbar thumbs L1627 (`--border-strong`), `.fmt-cbtn:active` L1999, `.msg-action-btn:active` L2282, `.art-row-btn:active` L2624/2696, `.ctx-ring::after` conic L2873, `[style*="background: var(--border-strong)"]` inline catcher L4313
- **--border as BORDER (the sane majority)**: #perf-hud-chip L323, #menu L344, .wtw-btn L1099/1115, .color-row-banner L1284, .color-row-reset L1291, .setting-row input[type=color] L1364, .chat-find* L1465–1509, .starter-chip L1545, scrollbars L1620, #edit-banner .eb-cancel L1683, #tpl-chip .tpl-chip-x L1707, .ts-act/.ts-star/.ts-notice L1717–1770, .fmt-yt-pip L1902, .fmt-cbtn L1992–2000, .tool-pill-progress/detail L2186–2187, .src-wrap L2211, .hub-wrap L2253, .art-row-btn L2408–2413, .art-confirm L2422, .art-ed-btn L2428, .art-toast L2580, .art-unsaved L2624, #panel-view-back/x L2663, .pv-input/.pv-select L2775, .pv-btn L2781, #chat-search-input L2804, .chat-search-nav L2812, .hub-searchico L2967, .hub-search L2978, .hub-ctl L3092, .hub-bundles-track L3125, .hub-card L3160 (+strong), .hub-card-ico L3183, .hub-bunch-sec-n L3270, .hub-memq-x L3281, .hub-memq-empty L3295, .hp-icogrid L3466, .hi-ico L3530, .hi-chip--info L3560 (strong), .hi-stage-mt L3566, .hi-viewseg L3594, .hi-fab L3629 (strong), .hi-delbar-btn L3668, .hp-textarea L3680, .hp-color L3732, .hp-pick L3743, .gr-color L3830, .gr-rm L3841, .gr-mini L3862, .gr-preview L3869, .tw-iconcell L3963, .gr-editor/.gr-swatches/.gr-tools L4054
- The native **outline-pill family** (v0.79.3 "assign to border"): `.hub-search, .chat-find, .chat-find-input, .chat-find-btn, .color-row-reset, .settings-nav .tab, .util-btn, .kbd` L4940–4944 → raised-chrome fill + raised-ring border (color-mix incl. --border)

### B2. The raised-family consumers (59 selectors on --surface-2 + 46 on --raised-chrome)

- **--surface-2 as FILL** (the plate/stack members): .chatbot .icon L253, #settings-btn:active L410, #dock-toggle:active L481, .dock-btn:hover L548, #chat-panel L655 (fill — see overlap), .panel-header L732, .settings-nav L1156 (fill), .settings-section L1200, .setting-row L1253, .color-row-collapsed L1264, .starter-chip:hover L1553, .ts-row L1732, .ts-chip L1751, .ts-detail-body/.ts-stage L1778–1779, .lv-* L1921–1939, .fmt-code-inline L1970, .hmsg-card L2276, .msg-action-ts L2344, .art-panel/.art-head/.art-row L2374–2397, .art-ed-actions L2427, .art-tree L2441 (wunderbaum --wb-border-color), .art-sheet L2497, .art-sheet-btn L2510, .vw-h1 L2532, .vw-arch-head/member L2553–2562, .pe-identity L2602, .cm gutters L2634, .pv-row L2676, .pe-body-fill L2745, .ph-scope-pill L2753, .hub-chatpill L2895, .hub-topdock L2928, .hub-card:active L3168, .hub-bunch-hero L3326, .hubrepo-* L3421–3435, .hi-head L3511, .hp-seg L3716, .hp-preview L3752, .gr-rm L3841, .hp-sec L3920, .gr-editor L4054 (v0.79.3: color-mix over surface-1), the chatbot disc stack L4096/4756
- **--raised-chrome (color-mix surface-2+bg-app)**: the ~46-control native Layer-3 mega-rule L4725–4739 (`.app-range, input[type=text/password/email/number], textarea, select, .app-switch-track, .ts-row:hover/active, .pv-btn:hover, .err-switch, .chat-jump, .ts-chip, .art-rename-input, .art-sheet-input, .art-toast, .hub-searchico, .hub-libpill, .hub-bunch-sec-n, .hub-bunch-chip, .hub-nav, .hp-icocell, .hi-fab, .hp-color, .hp-mini, .hp-pick, .dx-pill, .gr-color, .gr-mini, .crop-btn, .hp-focus-btn, .tw-iconcell, .chat-find-chip, .sm-ghost, #chat-send-more, .gr-dir, .cv-input, .cv-chip, .cv-badge, .cv-count-chip, .wsx-input, .wsx-act, .wsc-brsel, .pv-btn, #pe-name, #ph-key, #ph-val, #menu, .tool-pill-progress`) + L4215 outline pills + #menu L344, .wtw-btn L1099, .wt-omni L859, .wt-go/.wt-ext L873, .color-row-reset L1291, .chat-find* L1465–1502, .err-switch L1517, .chat-jump L1564, .art-* L2415–2580, .pv-input L2775, #chat-search-input L2804, .chat-search-nav L2812, #util-row .util-btn L2827, .hub-* L2967–3458, .hi-viewseg L3594, .hi-fab L3629, .hi-delbar L3655, .hp-* L3680–3963, .dx-pill L3773, .gr-color L3830, .gr-mini+crop-btn L3853/3887, .hp-focus-btn L3941, .tw-iconcell L3963

### B3. OVERLAP FINDINGS — the "variables don't make sense" evidence

**(1) 25 rules consume BOTH border-family AND raised-family vars** (the
families fight over the same objects — every one is a pill/input with a
raised fill AND a border ring):
`#menu` L344, `.wtw-btn` L1099, `.color-row-reset` L1291, `.chat-find` L1465,
`.chat-find-input` L1486, `.chat-find-btn` L1502, `.err-switch` L1517
(border-strong), `.chat-jump` L1564 (border-strong), `.art-toast` L2580,
`.pv-input,.pv-select` L2775, `.pv-btn` L2781 (strong), `#chat-search-input`
L2804, `.chat-search-nav` L2812, `.hub-searchico` L2967, `.hub-search` L2978,
`.hub-ctl` L3092, `.hub-bunch-sec-n` L3270, `.hub-memq-x` L3281, `.hi-viewseg`
L3594, `.hi-fab` L3629 (strong), `.hp-textarea` L3680, `.hp-color` L3732,
`.hp-pick` L3743, `.gr-color` L3830, `.tw-iconcell` L3963. These are the
"raised chrome" contract objects — yet their visible ring is the BORDER
variable's, and `--raised-ring` itself is literally `color-mix(border,
surface-2 30%)` (L4710). Changing EITHER var repaints all of them.

**(2) 74+ rules paint BORDERS with SURFACE vars** — elements that look like
hairlines/dividers/rings but belong to the surface family (so a surface-2
edit moves every hairline in the app):
`border: 1px solid var(--surface-3)`: #settings-btn L667, #dock-expando.open
L726/L754, #canvas-empty .ce-card L863, #chat-panel .handle #panel-tab-icon
L983, .wt-bar L1134, .wt-omni L1142, .wt-go/.wt-ext L1156, .wt-card L1230,
.wt-card-img L1259, .wtw-chip L1363, .fmt-media-img L2148, .fmt-yt L2154,
.lv-card L2197, .lv-open L2222, .fmt-code-inline L2253, .fmt-codecard L2261,
.fmt-codehead L2265, .fmt th/td L2302, .fmt-artifact L2341 (mix), .vw-tab
L2825, .vw-table td L2833, .hub-libpill L3320, .hub-empty L3722, .hub-nav
L3741, .hp-icocell[data-on] L3478, .hi-fab:active L3638, .hi-delbar-btn
L3668, .hp-mini L4019, .dx-pill L4056, #util-row .util-btn L3110
`border…var(--surface-2)`: #chat-panel L938 (border-top), .panel-header L1015
(border-bottom), .settings-nav L1439, .settings-section L1483, .setting-row
L1536, .color-row-collapsed L1547, .ts-row L2015, .ts-chip L2034, .ts-detail-body
L2061, .ts-stage L2062, .msg-action-ts L2627, .art-panel L2657, .art-head
L2666, .art-row L2680, .art-ed-actions L2710, .art-sheet L2780/2793, .vw-h1
L2815, .vw-arch-head/member L2836/2845, .pe-identity L2885, .CodeMirror-gutters
L2917, .pv-row L2959, .pe-body-fill L3028, .ph-scope-pill L3036, .hub-chatpill
L3178, .hub-topdock L3211, .hubrepo-* L3704–3722, .hi-head L3794, .hp-seg
L3999, .hp-preview L4035
Plus box-shadow rings: `.pe-mode-pill` L3008, `#util-row .util-btn` L3110,
`.hub-chatpill` L3178, `.dx-pill` L4056, `.dx-chip` L4097, `.gr-rm` L4124,
`.hp-sec` L4203 (all `rgba(var(--surface-3-rgb), …)` hard-shadow offsets).

**(3) BORDER vars used as FILLS** (section B1 list): menu-button press states,
the panel handle-bar drag pill, scrollbar thumbs, copy-button press states,
ctx-ring conic track, and the border-strong inline catchers. The scrollbar
thumb is the clearest "looks like a control fill, painted by the border var."

**(4) Text-vs-accent overlaps (16 rules consume BOTH text-family and
accent-family)**: `#panel-tab-icon .wt-circle-grad` L897 (hard-coded
linear-gradient(accent→accent-2) + text-1), `.wt-guard` L1002, `.wt-root.custom-tint
.wt-go/.wt-ext` L1264, `.color-row-reset:hover` L1306, `:root` fmt defaults
L1390, `.starter-chip:hover` L1553, `.fmt blockquote` L1815, `.fmt table thead
th` L2011, `.chat-working` L2078, `.art-tree` L2441, `.vw-quote` L2534,
`.vw-table td.vw-th` L2551, `.pe-identity-hint` L2617, `.hub-step-val` L3110,
`.hub-bunch-chip` L3319, `.gr-rm:hover` L3851 — accent text on text-family
backgrounds everywhere; the derived gates then clip the accent labels into
glyph windows, making the text/accent split doubly dynamic.

**(5) The plate stacks make border/surface inseparable BY DESIGN**: the
Layer-2 rule L4631–4643 paints `background-image: var(--surface-1-gradient),
linear-gradient(var(--surface-1)…), var(--border-gradient)` with three fixed
attachments — one object, three fields, two variables. Same for src-wrap/hub-wrap
L4667 (bg-app × 2 + border), chatbot disc L4756 (surface-2 × 2 + border),
and the four inline-catcher stacks L4882–4928. **Changing --border
re-rasters every Layer-2 card's ring; changing --surface-1/2 re-rasters
every plate — the two biggest fan-outs in the app overlap on the SAME
objects.** That is the structural reason a border/surface-raised edit costs
more than a canvas edit (see C).

**(6) `--surface-3` is the ghost family**: 53 rules consume it, it has NO
Colors-tab row, NO gradient twin, and it appears in borders (B3-2), fills
(press states, .hub-nav, .dx-pill, code blocks) and shadows simultaneously.

---

## C. COST RANKING (why border/surface-raised edits lag)

Top-20 most-consumed vars by CSS rules in index.html (the repaint fan-out
when the var changes — every consumer re-rasters if it carries a fixed
gradient, and a var write invalidates the whole doc):

| # | Var | Rules | Gradient twin? | Notes |
|---|---|---|---|---|
| 1 | --ui-small-fs | 105 | no | layout var — cheap, but invalidates everything |
| 2 | --text-3 | 104 | no | the metadata ink — text-only paints |
| 3 | --text-1 | 92 | **--text-1-gradient (2 rules but HUGE)** | feeds background-clip:text on whole .fmt bodies (E) |
| 4 | --accent | 66 | --accent-gradient (14 rules) | user bubbles + windows + glyphs |
| 5 | --text-2 | 65 | no | |
| 6 | --surface-2 | 59 | --surface-2-gradient (4 rules + plate stacks) | raised family anchor |
| 7 | --border | 57 | --border-gradient (7 rules + 5 plate stacks + ring mixes) | border family anchor |
| 8 | --surface-3 | 53 | none (solid only) | the ghost family |
| 9 | --accent-rgb | 49 | — | rgba tint composition |
| 10 | --raised-chrome | 46 | derived (color-mix) | native, re-resolves in style recalc |
| 11 | --ui-fs | 45 | no | |
| 12 | --accent-2 | 40 | --accent-2-gradient (9) | |
| 13 | --accent-2-rgb | 40 | — | |
| 14 | --chat-scale | 40 | no | |
| 15 | --surface-1 | 34 | --surface-1-gradient (5 rules + Layer-1/2 stacks) | the panel field |
| 16 | --ui-micro-fs | 33 | no | |
| 17 | --chat-fs | 26 | no | |
| 18 | --err | 22 | no | |
| 19 | --border-strong | 17 | --border-strong-gradient (1 + catchers) | scrollbar thumbs, hub-card, hi-fab |
| 20 | --accent-gradient | 14 rules direct | IS the gradient | the heaviest raster type |

**Gradient consumers (heavier repaint — fixed-attachment viewport rasters):**
59 rules consume some `--X-gradient` twin. Solid consumers repaint their own
box; gradient consumers repaint a **viewport-sized raster** each (unless
native/scroll-attachment): the inline catchers (8), Layer-1 #chat-panel
(3-field), Layer-2 cards (24 selectors × 3 layers), src/hub-wrap, chatbot
disc/name/badge (scroll-local since v0.92.1), headers h3/#chat-header/.pub-head-bar
(bg-app window), text-grad clip families (2 rules, ~40 selectors), the
fmt-slot clip rules (4), the a1–a4 window/glyph gates (~50 selectors incl.
runtime-derived), and the border plate rings.

**Why canvas is cheap in comparison:** the canvas edits flow through
`canvasFingerprint()` (app.js L1984–2008) which whitelists ONLY
`--bg-panel`, `--border-strong` + grid specs; an accent/surface edit never
touches the canvas, and a bg-panel edit re-bakes tiles in the WORKER with a
150ms debounce (lattice.js L622–624). A border/surface-raised DOM edit
re-rasters 57–110 DOM rules including the composited fixed-attachment
plates + their L2 pseudo layers + the GATES-emitted derived windows.

**Runtime-injected consumers amplify the DOM fan-out** (JS `var(--…)` counts
in injected `<style>` strings + inline styles): --ui-small-fs 210,
--text-3 208, --surface-2 115, --text-1 100, --accent-rgb 99, --accent 97,
--border 69, --accent-2-rgb 66, --text-2 60, --ok 50, --ui-fs 49, --accent-2
45… (modelbrowser.js 363, workspace.js 329, chatpanel.js 162, sandboxpicker.js
130, providers.js 92, appearance.js 90 are the heaviest injectors).

**Derived GATES emission** (theme.js L2279–2626): a runtime CSS compiler walks
every stylesheet and emits `[data-aN-grad] <sel>{background-image:…;background-attachment:fixed!important;color:var(--on-accent-N)!important}`
per accent consumer (window or glyph), plus surface windows + plate rings.
Static simulation over index.html alone: ~26 accent-1 windows + 7 glyphs,
~24 accent-2 windows + 3 glyphs, 6 surface-1 windows, 8 surface-2 windows,
4 bg-app windows + plate rings — **~83 gated selectors from the static sheet;
injected sheets (modelbrowser/workspace/chatsview/sandboxpicker/persona/artifacts)
roughly double it.** The gate CSS re-emits on every stylesheet mutation
(MutationObserver L2604–2617) and trips `DoomProjection.repaint()`.

---

## D. THE COLORS TAB STRUCTURE

**Where it's built:** appearance.js registers the pages with settings.js
(`Settings.registerPage('appearance', …)` L754–777). settings.js
`renderSettings()` (L220–277) builds the nav tab strip (`.settings-nav .tab`)
+ `panelRef.open({bodyHTML})` — the panel is panel.js's master sheet.
The tweaks view (tweaks.js) re-renders the SAME builders per-chat.

**Nesting depth (collapsibles within collapsibles) — 3 levels:**
1. **Level 1:** `.settings-section` collapsibles (`.settings-section h3[data-section-toggle]`, appearance.js `section()` L1094–1096; folded by default, wired by settings.js wireInputs L353–359). Colors page = **4 sections**: "Theme" (swatches), "Customize <Theme>" (10 rows), "Grid Colors" (3 rows + reset), "Chat Colors" (scheme swatches + 5 fmt rows + reset).
2. **Level 2:** `.color-row-collapsed` collapsibles (appearance.js `colorRowCollapsed()` L392–400: head = name + `.color-row-banner` preview + `.color-row-reset` ↺ + arrow; body = `[data-color-body]`). The Customize section has 10, Grid 3, Chat Colors 5 → **18 collapsible rows inside 4 collapsible sections**.
3. **Level 3:** the GradientUI editor's own internal rows inside each expanded color-row (swatches row, tools row, style pills row, pattern pills row, angle row, texture row).

**What mounts on tab open (post-v0.98 C3 lazy editors):** the page renders
section shells + collapsed-row shells ONLY — **289 nodes, 0 long tasks**
(rig v098-panel-colors). `rowEditorBuilders[pfx]` (L440) holds a builder per
row; `buildLazyEditor()` (L442–451) fills `[data-color-body]` on FIRST expand
(head click handler L411–420). One GradientUI editor ≈ **34 DOM nodes** at
default (2 colors, noTex): `.gr-editor` + `.gr-preview-bar` + `.gr-swatches`
(+3 nodes per color: swatch/input/remove) + `.gr-tools` (3 buttons + count)
+ style row (8 dir pills) + pattern row (label + 5 pills) + angle row
(4 nodes when diag). With texture row / more colors → ~50 nodes (the
pre-v0.98 eager mount was 18 editors ≈ 979 nodes).

**Colors-tab tab-switch cost today:** re-render is a full `bodyEl.innerHTML`
rebuild (renderSettings L242); on close, the body wipes 450ms after the
animation if >25 nodes remain (settings.js L250–260, v0.98 C6).

**General tab for comparison (L811–877):** 5 flat sections — "Text" (font
select), "Default Chat Names" (textarea), "View" (reset button),
"Connected Accounts" (hydrateAccounts rows — 60s cache since v0.98 C5),
"Import / Export Theme" (lookio buttons). **No Level-2 collapsibles, no
editors, no gradient UI.** Sizing = 3 sections of sliders + effect columns.

**GradientUI editor anatomy (uikit.js L615–704):** preview bar (live
`css(spec)`), swatch row (1–15 `.gr-color` inputs + per-swatch ✕),
tools (＋ color / ⤨ shuffle / ↻ random / n⁄15 count), style row (auto/h/v/
diag/diag2/radial/swirl/mesh), pattern row (navy/pinstripe/gingham/
sunburst/checker), angle slider (diag only), texture row (canvas-bg only —
`noTex` everywhere else). `wire()` (L721+) mutates the spec in place, calls
`live()` per value change and `rebuild()` per shape change; the editor's own
repaints are flagged `__projCosmetic` (L743) so the projection painter
ignores them.

---

## E. GRADIENT TEXT (background-clip:text) — every site

| Site | Selectors | Feeding vars | Trigger |
|---|---|---|---|
| index.html L2165–2191 | `[data-fmt-grad~="a1"] .fmt h2`, `~="a3" .fmt em/.fmt h4`, `~="bright" .fmt strong/.fmt h1`, `~="link" .fmt a.fmt-link` (+fmt-user) | `--fmt-a1/a3/bright/link-gradient` + `-ink` twins | any fmt slot holds a gradient (Colors tab / per-chat tweaks) |
| index.html L4985–5024 | `[data-text-grad]` — **~40 selectors**: .settings-section h3 span, .pub-title, .chatbot .name, .gatelock-title, .panel-header .meta .name, .wsx-title, **`.fmt` (the WHOLE message body)**, .placeholder, .setting-row label, .pv-row-title, .pv-sub-label, .ts-row-name, .ts-detail-name, .ts-stage-name, .color-row-name, .art-row-name, .art-title, .art-sheet-name, .art-binary-name, .crop-title, .lv-title, .hub-bunch-hero-name, .hi-title, .hi-delbar-text, .hubrepo-file-path, .vw-h1/h2/b/doc/title/arch-name, #menu button, h1, h2, h3 | `--text-1-gradient` | Primary text holds a gradient |
| index.html L5037–5044 | `[data-text-grad] .hub-card-name-in` (the marquee span — own window, composited-child fix) | `--text-1-gradient` | ditto |
| index.html L5058–5071 | `.crc-mark` + `[data-text-grad] .crc-mark` override — the "· customized" marker opts OUT of the parent clip (z-fight fix) | `--accent` / `--accent-2` | marker present |
| index.html L5131–5138, L5158–5164 | `[data-a1-grad] .ts-on-ico, [data-a1-grad] .hub-step-val`, `[data-a2-grad] .ts-stage-fo` — accent GLYPHS | `--accent-gradient`, `--accent-2-gradient` | accent holds a gradient |
| index.html L5350–5381 | the 8 INLINE GLYPH CATCHERS `[data-aN-grad] [style*="color:var(--accent-N)"]:not([style*="background"])` | `--accent-N-gradient` | JS-built accent labels |
| theme.js L2539–2545 | GATES runtime emission — every static rule that is a lone `color: var(--accent-N)` label becomes a clipped glyph window | `--accent-N-gradient` | accent gradient live |
| sandboxpicker.js L575–577 | injected `.hf-age-head` (the HF age-card headline) | `--accent-gradient` | always injected when age card mounts |
| tweaks.js | per-chat fmt twin paint on #chat-root (`data-fmt-grad` on the chat root — any ancestor works) | `--fmt-*-gradient` | per-chat fmt spec |

**No `-webkit-text-fill-color` anywhere** (the v0.74 fix removed it — it
inherited and killed child colors); clipping is `color: transparent` +
`background-clip: text`. **The lag relevance:** `[data-text-grad] .fmt`
makes EVERY message body a fixed-attachment clip window — on a low-end
phone each message rasterizes the text-1 field at viewport size, and the
L2 mint/bake machinery (theme.js `ok()`/`snapshot()`/`bake()`) carries
those pseudos on scroll. The `.hub-card-name-in` rule exists precisely
because clipped text + compositing is flaky on WebView.

---

## F. THE CANVAS COLOR PATH

**Read points (who reads which var, when):**
- **app.js `buildLatticeParams()` L180–223** — reads DoomTheme
  `effectiveGrid/effectiveGridSpecs/canvasBgSpec` (pure JS, no computed
  styles): grid specs (bg/lineColor/dotColor/originColor as GradientUI
  SPECS), `canvasSpec` (the --bg-panel override raw spec incl. texture),
  `bgFallback` hex. Posted to the worker only when `latticeFingerprint()`
  (L234–243) changes (cheapJSON digests).
- **app.js `borderStrongHex()` L274–285** — `getComputedStyle --border-strong`
  for off-screen arrows, **1s TTL cache**, reset on `doomalay:theme-changed/applied`.
  Also `DoomalayConfig.families.default.color` is set to resolved
  `--border-strong` by applyTheme (theme.js L687–694) — the default-family
  chatbot icons/arrows follow the BORDER variable.
- **lattice.js** — consumes only the P blob: `P.specs.dotColor/lineColor`
  (gradient specs sampled per tile at bake), `P.canvasSpec` →
  `paintCanvasBackground(gctx, spec, …)` (L1116/L1427), `P.t.*` hex
  fallbacks. Tile lattice `tlFingerprint` L654–663 includes the spec
  digests + raster quantum; **rebake = 150ms debounce after settle**
  (params churn/zoom), baked in the worker (or main-thread fallback).
- **atoms.js L137–178** — orbit star colors: `--accent-rgb`/`--accent`,
  `--accent-2-rgb`/`--accent-2`, `--border-strong` (orbit ring rgba .35),
  originColor via `DoomTheme.effectiveGrid` — **1s TTL cache** (`colors()`).
- **pixiworld.js L158–179 `themeColors()`** — reads `--surface-2, --text-1,
  --text-2, --text-3-dim, --bg-app, --ok, --surface-1, --accent,
  --accent-2, --border-strong` via getComputedStyle — **1s TTL cache** —
  feeds the GPU icon raster (disc/name-pill/ok-badge repaint when the
  fingerprint changes).
- **gridworker.js** — imports lattice.js inside the worker; never touches
  the DOM/getComputedStyle (all colors ride the posted P blob).

**Rebake triggers:** `Settings.onChange` → `canvasFingerprint()` gate
(app.js L2021–2037) → `update()` → Lattice frame with fresh P → tile bake
debounce. `doomalay:theme-changed/applied` reset the arrow/family caches.
Theme flips re-derive meta theme-color + family tint inside applyTheme.

**Theme→canvas contract:** the canvas is driven by `--bg-panel` (Canvas
background row) + the 4 grid slots, NOT by --bg-app/--surface-*; accent/
surface/text edits are invisible to the canvas. This is why editing canvas
bg is cheap (worker + debounce + tile cache) while border/surface-raised
edits are expensive (DOM fan-out, section C).

---

## G. THE .DOOMTHEME FORMAT (lookio.js)

```
{ "format": "doomalay-look", "version": 1,
  "app": "doomalay", "exportedAt": ISO, "scope": "global" | "chat",
  "state": { …the ENTIRE Settings state… },        // settings.js defaultState + saved
  "chat":  { …the per-chat tweaks blob… },          // scope=chat only
  "chatAssets": { background|texture|icon: dataURL } // scope=chat only
}
```
- `state` bundles: theme id, **themeOverrides {themeId:{'--accent': spec,…}}**
  (gradient specs with texture dataURLs inline), chatScheme + fmtOverrides
  (specs), chatTextSize/uiTextSize/smallTextSize, gridSize + the 4 grid
  color slots (specs/hexes), all ~20 grid-effect knobs, perfHud/workerPaint/
  worldLayer, fontFamily, names[].
- Import validates magic (`doomalay-look` or legacy `doomalay.settings`,
  state under `state` or `settings`) + 24MB cap; global scope REPLACES the
  settings state via `Settings.setState` (L186–191); chat scope PUTs the
  bytes back to `/api/sessions/:id/{background,texture,icon}` then the
  tweaks blob, then `ChatTweaks.attach`.
- File name: `doomalay-{scope}-{theme}-{YYYYMMDD}.doomtheme`.
- **Migration note for v0.99:** the loader must fold `themeOverrides` +
  grid slots + fmtOverrides into the new field model on read (the plan's
  batch 5).

---

## H. SWAPPABLE-ELEMENT CANDIDATES (the mask taxonomy, with var families)

Every distinct UI element class that exists (file:selector → family that
feeds it):

| Element kind | Class/id (site) | Color family |
|---|---|---|
| **Master panel (chat)** | #chat-panel (L655, L938) | surface-1 fill + surface-1-gradient window (L4611) + surface-2 hairline |
| **Panel header** | .panel-header (L732, L1015), #chat-header (L4961) | surface-2 base + bg-app gradient window + text-shadow |
| **Panel handle** | .handle-bar (L684/967), #panel-tab-icon (L700) | border fill (handle-bar!), raised-chrome+surface-3 (icon) |
| **Overlay screens** | #connect-overlay (connectoverlay.js inline bg-app), .src-wrap/.hub-wrap (L4667) | bg-app ×2 + border ring plate |
| **Settings sections / cards** | .settings-section, .hub-card, .pv-row, .msg-assistant, .ts-row, .hmsg-card, .starter-chip, .fmt-codecard, .fmt-yt, .fmt-code, .fmt-pre, .code-card, .artifact-card, .art-panel, .art-row, .art-ed-body, .art-sheet, .cm-s-doomalay.CodeMirror, .hp-sec, #send-menu, .kb-card, .cv-section, .mb-more, .wsx-opt (the Layer-2 plate list L4631–4635) | surface-1-gradient + surface-1 plate + border-gradient ring (3-layer) |
| **Section headers (collapsibles)** | .settings-section h3 (L4961), .pub-head-bar | bg-app gradient window + text-1 |
| **Message bubbles** | .msg-user (L1673: accent + accent-gradient fixed + on-accent), .msg-assistant (L1688: surface-1), .msg-error (err tints), .hmsg-card (hub msgs, Layer-2) | accent / surface-1 / err |
| **User bubble text** | — | --on-accent (derived) |
| **Chat transcript** | .fmt (formatter slots a1/a2/a3/bright/link; inline code .fmt-code-inline = surface-2 chip; tables th surface-3; hr surface-3; blockquote borders surface-3) | fmt + surface |
| **Day dividers** | .msg-day::before/::after (L1727) | surface-3 |
| **Composer** | #chat-input (raised-chrome via input[]), #chat-send (accent window when .sm-on L5118), #chat-send-more (raised), #send-cluster, .sm-row/.sm-ghost (raised), .chat-jump (L1564 raised + border-strong) | raised + accent |
| **Input / search bars** | input[type=text/password/email/number], textarea, select, .cv-input, .wsx-input, .art-rename-input, .art-sheet-input, .hub-search, #chat-search-input, .chat-find-input, .wt-omni, .hp-textarea, .pv-input | raised-chrome fill + raised-ring ring |
| **Select boxes** | select, .pv-select, .wsc-brsel | raised |
| **Tab strips** | .settings-nav .tab (L1399: rgba text-3 outline → raised-chrome/ring via L4940; active tabs tinted accent/accent-2/accent-3 L1426–1446 + gradient windows L4314+), .hi-viewseg, .vw-tab, .ts-stage, .mb-pill | raised + accent windows |
| **Pills — filter/category** | .hub-libpill (raised + per-tone accent windows L5211–5232), .mb-pill/.mb-ufchip (accent-3 windows), .hub-bunch-chip, .hub-chatpill, .cv-chip, .cv-badge, .cv-count-chip, .wsx-chip, .dx-pill (raised+accent-2-gradient when on), .pe-mode-pill, .ph-scope-pill, .hub-nav | raised + accent-N |
| **Pills — tool/status** | .tool-pill-progress/.tool-pill-detail (border outline + accent), .chat-working (accent-1 window), .starter-chip (surface-1) | mixed |
| **Chips — gradient editor** | .gr-color, .gr-mini, .gr-dir, .crop-btn, .gr-rm, .gr-swatches, .gr-tools (L4054: color-mix surface-1+surface-2 box) | raised + surface mix |
| **Sliders** | .app-range (raised track + accent fill), .gr-angle | raised + accent |
| **Toggles/switches** | .app-switch-track (raised; checked = accent + accent-gradient L1585), .err-switch | raised + accent |
| **Checkboxes** | input[type=checkbox] + .app-switch hit-slop (L1597) | accent |
| **Scrollbars** | #chat-scroll/#mb-list/.mb-body ::-webkit-scrollbar-thumb (L1620–1627) | **border-strong fill**, border track |
| **Canvas chatbot icons** | .chatbot .icon (L253/L4096/L4756: surface-2 ×2 + border ring, scroll-local), .chatbot .name (bg-app window), .sandbox-badge (surface-1), family tints via DoomalayConfig (border-strong) | surface-2 + border |
| **Canvas grid/dots/lines** | lattice.js tiles from grid specs (bg/lineColor/dotColor/originColor — Canvas color rows) | grid slots |
| **Canvas stars/orbits** | atoms.js (accent-rgb, accent-2-rgb, border-strong ring, originColor) | accent + border-strong |
| **Pixi world layer** | pixiworld.js rasters (surface-2 disc, text-1/2 name, ok badge, accent) | surface + text + accent |
| **Dock** | #settings-btn (surface-1 fill + surface-3 border), .dock-btn (surface-2 hover), #dock-expando (surface-1 + surface-3) | surface |
| **Context meter** | .ctx-ring (conic accent + border-strong after L2873), .ctx-ring-btn | accent + border-strong |
| **Badges/counts** | .hub-count, .ts-stage-n (accent-2 window), .hub-step-val (accent glyph), .hi-stagen, .hi-chip (hub-tone rgba), .hi-chip--info (surface-3 + border-strong), .chatbot .sandbox-badge | accent / hub-tone |
| **Dividers/hairlines** | .setting-row, .settings-nav, .ts-detail-body, .art-head, .vw-arch-*, .pe-identity, .CodeMirror-gutters, .msg-action-ts, .fmt hr (all border:surface-2/3) | surface (!) |
| **Toasts** | .art-toast (raised), #lookio-toast (JS: surface-2+border inline) | raised |
| **Tooltips** | browser-native title attrs only (no custom tooltip class in index.html); .hint (text-3) | text |
| **Spinners/progress** | @keyframes mb-spin (streaming cursor), .tool-pill-progress, .ctx-ring | accent/border |
| **Chat rows (all-chats index)** | .cv-* rows (chatsview.js injects: surface-2 rows + accent chips), .mb-* modelbrowser, .ts-row/.ts-chip/.ts-stage (templatesheet) | raised + accent |
| **Hub cards/art** | .hub-card (+ .hub-card--bunch, .hub-card-ico), .hi-head hero + scrim (bg-panel-rgb gradient scrim L4037), .hi-fab (raised + border-strong), .hp-* publish flow (raised family throughout) | surface + bg-panel + raised |
| **Empty states** | #canvas-empty .ce-card (surface-1 mix + surface-3 border + accent glyph), .hub-empty (dashed surface-3) | surface + accent |
| **Menu** | #menu long-press menu (raised-chrome + border ring; buttons border fill on press) | raised + border |
| **Wunderbaum tree** | .art-tree (--wb-* overrides → text-1/surface-2/err) | text/surface |
| **Editor (CodeMirror)** | .cm-s-doomalay (surface-1 + Layer-2 stack) | surface |
| **Persona picker hearts** | .pp-heart (surface-3-rgb .75) | surface |
| **Provider pills (connect)** | .wsp-pill/.wsp-signin/.wsx-ico (workspace.js injected --wsp-c/-rgb per provider = accent-N mapping) | accent (indirection) |
| **Browser panel** | .wt-* family (surface-3 borders, raised-chrome, custom-tint color-mix --wt-c1/c2) | surface + accent |

**Taxonomy takeaway for the Field model:** ~9 mask classes would cover the
app: ① panel/sheet, ② card (Layer-2 plate), ③ pill/chip (accent window),
④ input/control (raised chrome), ⑤ bubble (accent window), ⑥ divider/hairline
(today: SURFACE-colored borders — the rework's #1 reassignment), ⑦ badge/count,
⑧ icon disc, ⑨ scrim/overlay veil. The tab strips + toggles are pills; the
scrollbar is a pill; the toasts are cards.

---

## METHOD NOTES

- Rule census: brace-matching parser over the single `<style>` in index.html
  (5,643 lines), comments stripped, @media/@supports recursed with real line
  numbers; `var(--X)` extracted per rule (dedup per rule); 1,117 rules, 701
  consumers, 91 vars. Declaration-level scans parse `prop: value` pairs to
  classify border-as-fill vs surface-as-border.
- JS counts: `rg -o 'var\(--'` per file; the injected `<style>` strings in
  modelbrowser/workspace/chatpanel/sandboxpicker/providers/persona/chatsview/
  usagepanel/hfconnect/localmodels/ghconnect/artifacts/hubrepo/hubpublish etc.
  are counted in the JS totals (they're runtime stylesheet rules, so the
  derived GATES also see them).
- Derived-gate selector counts are a STATIC simulation of the L2279–2626
  walker over index.html only (runtime sheets roughly double it); MAX_SEL
  cap in code = 400.
- All file:line references verified against the v0.98.0 tree.
