# PLAN-V107 — THE SELECTIVE FIELD

> The user's report (v1.06.0 post-ship), verbatim intent:
> 1. "let's try and have the surface color not doom project, even with the doom
>    projection toggle, let's have everything doom project but the surface as
>    that variable specifically causes a lot of lag"
> 2. "when doom projection is on the pills in the chat metadata don't project
>    gradients they get painted white"
> 3. "sliders, on/off toggle pills, and the very tiny round opaque pills (the
>    libraries circular filter pills or bundle icons) don't follow doom projection"
> 4. "the doom projection pill toggle still doesn't update to off when it is
>    toggled off and doom projection was on — we have to close and open the
>    settings again to update"
> 5. "text doesn't seem to doom project at all either"
> 6. "the previous push added a shadow color and another color to compliment
>    the surface color — they are not exposed to the settings screen" (they
>    exist: v1.04.2's --shadow-ink + --highlight-inset-rgb — derived, uneditable)

## §0 THE RECON (done — the facts the phases ride)

- **The projection is ONE viewport field per gradient var** (doomprojection.js):
  outside transformed roots = native `background-attachment: fixed` minted by
  the DOOM SHEET; inside `#chat-panel`/`#connect-overlay` = the painter bakes
  per-element windows (L2 ::before layers or inline bakes).
- **PROJ_RE** = `/var\(--(?:surface-1|accent|accent-2|accent-3)-gradient/` —
  the allow-list. The surface-1 field is THE LAG: the panel body + the overlay
  card are the two BIGGEST windows (viewport-sized layers/rasters) and the most
  re-anchored. Web research re-confirmed: fixed attachment is the expensive
  leg on mobile ("some mobiles have a problem with the fixed attachment").
- **Text is local by design** — the fmt track (`--fmt-<slot>-gradient`, slots
  a1/a2/a3/bright/link, formatter.js) was excluded at v1.00.2 ("text
  clip-windows never project"). The user now wants text IN.
- **Layer-3 chrome went native solids at v0.91.2** (`.app-range`,
  `.app-switch-track`, `.hub-libpill`, `.hub-searchico`, `.hi-fab`, `.dx-pill`…)
  — deliberately ZERO projection after the 534-raster colors-tab lag. The
  v0.92.1 precedent stands: at ≤56px, viewport projection is invisible — the
  disc renders the field at its own box scale (LOCAL window).
- **The s1-grad chrome rules** (`[data-s1-grad] #settings-btn`, `#dock-toggle`,
  `#dock-expando.open`) already paint `var(--surface-1-gradient)` LOCALLY —
  the exact model the chrome-follow phase generalizes.
- **The settings doom switch** (appearance.js ~1119) bakes its visuals inline
  at render (track background + thumb left from `s.doomProjection`);
  wireInputs' change path only calls setState — nothing restyles → the pill
  goes stale until the page re-renders (close/reopen). The module's own
  state machine is fixed (v1.05.2); this is purely the settings control.
- **The shadow/highlight tokens exist** (v1.04.2): `--shadow-ink` =
  color-mix(canvas, #000 55%) derived on every applyTheme (+ the JS triplet
  twin); `--highlight-inset-rgb: 255,255,255` = a static constant (the inset
  1px ring on raised chrome, uikit.js + index.html ×2). Neither is
  user-editable; the Colors tab exposes only the 6 fields + 5 fmt stops.
- **The white-pill report** — leading hypotheses (the rig must reproduce and
  pick): (a) the DOOM SHEET's plain `fixed` on the pill catchers resolving
  against the transformed root between the dropdown-open and the painter's
  first bake (the split-gradient window = a flat slice, possibly a light
  stop); (b) the L2 base suppression (`background-color: transparent
  !important` + inline none) surviving while its ::before layer lost its
  image (the phantom-purge path unpaints WITHOUT stripping, v1.00.3);
  (c) a mis-anchored bake pinning a white region of the field into the pill.

## §1 v1.06.1 — THE SURFACE EXEMPTION

**The edit (doomprojection.js):** PROJ_RE drops `surface-1`:
`/var\(--(?:accent|accent-2|accent-3)-gradient/`. That one regex is the
whole mechanic — the DOOM SHEET walk, the painter's SEL collection and the
mint all derive from it:

- the DOOM SHEET stops minting `fixed` for every surface rule → the panel
  body, the overlay card, the world plates render their gradients LOCAL
  (the v1.01.5 local-light look) in BOTH toggle states;
- the painter stops collecting/baking surface windows inside the roots —
  the two viewport-sized, most-rebaked layers die (the lag the user feels);
- the accents (and, after §2, the fmt field) keep the full projection.

Riding facts already in the tree: the `[data-s1-grad]` chrome windows stay
local automatically (their rules carry `var(--surface-1-gradient)` which no
longer matches); `--shadow-ink`/veil derivations are untouched; the GATES
keep setting data-s1-grad (the chrome rules still key on it).

**WILL NOT:** touch the L2 layer machinery, the toggle state machine, the
gate merge — the exemption rides the existing derivation.

**The proof (scripts/v107-selective-field-test.py, §A):**
1. gradient fields set through the app's own state machinery; projection ON;
2. `.panel-body` + `#connect-overlay` card: computed background-image keeps
   the gradient, computed attachment ≠ fixed, NO data-proj / data-proj-bake;
3. an accent window (e.g. `.sm-row.on` or the model button) still windows:
   data-proj-bake or attachment fixed OUTSIDE roots;
4. the per-paint cost: stats() painted count drops vs the pre-exemption tree
   (the surface windows were the bulk); bench note in the commit message.

## §2 v1.06.2 — THE TEXT FIELD

**The edit (doomprojection.js):**
- PROJ_RE += fmt: `/var\(--(?:accent|accent-2|accent-3|fmt-[a-z0-9]+)-gradient/`;
- ROOT_GATE_RE += the fmt gate so root-led selectors MERGE:
  `/^\[(data-fmt-grad[^\]]*|data-s1-grad|data-a1-grad|data-a2-grad|data-a3-grad)\]/`
  (the `[data-fmt-grad~="a1"] .fmt h2` family lives at the document root —
  the v1.04.2 gate-merge lesson: a prefixed descendant form NEVER matches).

Effects: the fmt text rules (h1/h2/strong/em/links + the named glyph rows)
mint `fixed` OUTSIDE the roots (native viewport projection through the
glyphs — a real Blink probe first: fixed + background-clip:text), and INSIDE
the roots the painter bakes them — clip:text elements fail L2.ok
(snap.clip === 'text') and ride the LEGACY inline bake (position/size/
attachment:scroll — the clip itself untouched). Solid slots resolve
`--fmt-X-gradient: none` → the first-encounter probe memoizes them out.

**The proof (§B):** the Blink probe (fixed+clip:text computed + screenshot)
both polarities; inside the panel a fmt h2 carries the inline bake and its
projected window survives a panel drag (no split-gradient flash); a long
transcript's painted-count delta stays sane (the rig prints it).

## §3 v1.06.3 — THE CHROME FOLLOW (+ the white pill + the live switch)

**3a — the chrome windows (index.html, static, projection-scoped):**
under `html[data-doom-proj][data-s1-grad]` the Layer-3 family +
`.app-range` + `.app-switch-track` (checked AND unchecked) + the tiny round
pills (`.hub-searchico`, `.hi-fab`, `.hp-mini`, `.dx-pill`…) get
`background-image: var(--surface-1-gradient, none)` — LOCAL windows (the
v0.92.1 scale precedent: the field at the element's own box). Because
surface-1 is out of PROJ_RE (§1), these rules NEVER enter the painter, NEVER
mint fixed, NEVER raster viewport-sized — zero painter cost, the exact
v0.91.2 objection does not apply. Sliders: `::-webkit-slider-runnable-track`
/ `-thumb` gradient styling under the same gate (accent-color stays as the
fallback). The accent-STATE chrome (checked tracks, active pills, on-rows)
already windows the accent fields via the existing catchers — untouched.

**3b — the white pill (rig first):** §C reproduces the report state-ledger
style: projection ON → gradient accents → open the chat header dropdown →
read each pill's computed background-image/color/attachment + data-proj
state + screenshot. Fix per finding (leading: purge-without-strip on a
flattened image → strip on the phantom path; plus the dropdown-open bake
ordering if the split-gradient window is what paints).

**3c — the live switch (settings.js wireInputs):** the checkbox path
updates the sibling `.app-switch-track` background + `.app-switch-thumb`
left from `el.checked` right after apply — generic for every app-switch
(the doom projection pill included) — no re-render needed.

**The proof (§C):** the doom pill flips visually in-place both ways (no
reopen); a paper-theme screenshot of the chat header pills under projection
shows gradient windows (no white flats); slider/switch screenshots under
the projection gate vs without.

## §4 v1.06.4 — THE SHADOW & THE HIGHLIGHT EXPOSED

- theme.js: two new override slots — `--field-shadow` (default: the
  canvas-55% mix, re-derived live while unset) and `--field-highlight`
  (default #ffffff). applyTheme writes `--shadow-ink` + `--shadow-ink-rgb`
  from the override when present, else the current derivation;
  `--highlight-inset` + `--highlight-inset-rgb` likewise (today the triplet
  is a boot static only). FALLBACKS += shadow/highlight hexes;
  settings.js CANON-TWIN seeds updated (v1.04.4 contract).
- appearance.js: two rows in The Fields section (Shadow, Highlight) with
  the standard color-row editor + "follow theme again" resets (the canvas
  grid-row pattern).
- index.html: the two :root statics stay as the no-JS boot fallbacks.
- docs/DISCIPLINE.md + the audit: the new tokens join the canonical zones.

**The proof (§D):** edit Shadow → every box-shadow re-tints (computed
triplet parity CSS≡JS); edit Highlight → the inset rings re-tint; reset →
byte-identical to the derived values; the discipline audit stays green.

## §5 SHIP v1.07.0 — THE SELECTIVE FIELD

- the full battery: v107 rig (new) + v106 fluid 21/21 + v1045 redteam 11/11
  + v1040 audit 7/7 + twins/uikit/go;
- the REBASE PROTOCOL: fetch origin (the parallel bot), diff, merge, build;
- buildinfo 1.07.0 → tag v1.07.0-the-selective-field → release (CI APK) →
  CI green → worklog + MEMORY.md.

## §6 THE SPAGHETTI BOUNDARY (will NOT)

- no new projection modes beyond the regex/gates (no per-element opt-out
  lists, no config surface for the field set);
- no restyle of the L2 layer geometry;
- no theme-editor re-architecture — Shadow/Highlight ride the existing
  color-row machinery;
- if the white pill needs anything deeper than the purge-strip/ordering
  fix inside doomprojection.js, it stops there — no chatpanel rewrite.
