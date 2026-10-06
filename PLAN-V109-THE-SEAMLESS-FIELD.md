# PLAN-V109 — THE SEAMLESS FIELD

> The user's report (v1.08.1 post-ship), verbatim intent:
> 1. "The workspace pills even when doom projection is on sometimes switch to
>    non doom projection randomly for a bit before going back to doom
>    projection and functioning normally"
> 2. "enable/disable toggles and sliders still don't use doom projection and
>    get painted with only the first color not the full gradient"
> 3. "The panel is still laggy sometimes and can use a bit less lag"
> 4. "using non doom projection introduces a slight tiling issues with the
>    surface variable as the panels header doesn't sync with the rest of the
>    gradient sometimes, but repeats it"
> 5. RESEARCH: "how we can further reduce panel lag"
> 6. RESEARCH: "what opensource library or another method we can use to
>    handle doom projected text as currently our doom projected text causes
>    extreme lag, switching doom projection off fixes it tho"

## §0 THE RECON (done — the facts the phases ride)

- **The flicker (1) is an OSCILLATION in the painter's own registry**
  (doomprojection.js): the metadata/workspace pills match the stylesheet
  through the inline catchers `[data-aN-grad] [style*="background-color:
  rgba(var(--accent-N-rgb)"]` (index.html 5709-5726). When the painter L2-
  bakes a pill, the inline suppression REPLACES `background-color` with
  `transparent !important` — **the catcher's attribute substring is
  destroyed** — the pill stops matching SEL — the very next paint() DROPS it
  (drop loop: painted ∧ ¬in-qSA → L2.drop + restoreAuthorBg) — the restore
  REWRITES the original spelling — the catcher matches again — the NEXT
  paint re-bakes → suppress → break → drop → … The pill oscillates
  projected↔local on whatever irregular trigger cadence the page supplies
  (scrolls, settles, opacity writes from the workspace count fetch — the
  "randomly for a bit" feel). The v1.06.3 ownership law saved/restored the
  author's values but never re-anchored the SEL match.
- **The flat toggles/sliders (2)**: settings app-switch tracks bake their
  visuals INLINE at render (appearance.js 1128-1130, toggleRow 1666: checked
  = `background: var(--accent)` shorthand). Under projection the accent
  catcher paints `var(--accent-gradient)` + the DOOM SHEET mints `fixed` +
  the painter viewport-bakes the track inside the panel — a viewport WINDOW
  on a 42×24px control ≈ a flat slice of the field (reads as "the first
  color"). The UNCHECKED tracks: inline `background: var(--surface-3)`
  shorthand beats the plain §3a :where image rule → fully flat. The sliders:
  `.app-range` DOES ride the §3a surface window (v1.06.3), but when the
  surface twin is flat ('none' — the common doom theme rides the accents)
  the track falls back to the flat raised chrome and the thumb rides
  `var(--accent)` solid — "only the first color" again.
- **The header tiling (4)**: the Layer-1 rule paints the SAME local field on
  THREE stacked boxes — `#chat-panel, .panel-header, .panel-body`
  (index.html 5050). Local light = each box renders the gradient AT ITS OWN
  BOX → the header restarts the field instead of continuing it. "Sometimes"
  = only visible when the stop positions straddle the header/body boundary.
- **The text lag (3+6)**: inside the roots the fmt text rides the LEGACY
  inline bake (attachment:scroll + viewport-size + var-carried position).
  Every scroll delta re-anchors EVERY painted text element (scrollRebake →
  one style write per element per scroll event — the read/write thrashing
  the research flags); every motion frame re-resolves `var(--proj-ty)` in
  each text position → style recalc + REPAINT of viewport-sized gradients
  clipped to glyphs, per frame, for the whole transcript. Text cannot ride
  the L2 compositor path (clip:text fails L2.ok by design) — so text IS the
  remaining panel lag when projection is on ("switching doom projection off
  fixes it" — OFF, the fmt rules never bake, nothing re-anchors).
- **RESEARCH (tool-results/v109-research/, 8 searches)**: (a) NO open-source
  library handles projected text better — the entire "gradient text" OSS
  space (GradientTextify, the CodePen patterns, design-system recipes) ships
  the same `background-clip: text` + gradient mechanism and inherits the
  same cost; (b) the cost is architectural: clip:text forces the slow
  per-glyph mask raster, and style writes during scroll/motion force
  main-thread work that defeats the compositor (layout-thrashing literature;
  Chrome's own Android scroll-jank work is input-to-frame compositor
  delivery); (c) content-visibility/containment help offscreen populations
  but not on-screen motion. VERDICT: no library adopt; the fix is OURS —
  stop writing during motion/scroll ("the coast"), re-anchor at settle.
  Written up in docs/RESEARCH-V109-TEXT-AND-PANEL-PERF.md.

## §1 v1.08.2 — THE STEADY HAND (the pill oscillation)

**The edit (doomprojection.js):** a suppressed painted element is a PAINTER
asset — its SEL match was broken BY the painter, so the registry may not
drop it for that reason alone.

- paint()'s READ phase gains a second source: after the per-root qSA sweep,
  every `painted` element with `__projSuppressed && isConnected` that the
  sweep did not match re-enters the read list (stamped, deduped) and runs
  the IDENTICAL per-element body (rect, vis-form, epoch snapshot, bake
  decision) — factor the loop body into a helper, no behavior change for
  the qSA population.
- The snapshot carries `attachment` (one more computed read it already
  performs). THE OWNERSHIP TEST: a SUPPRESSED element whose computed
  attachment no longer carries `fixed` has been claimed by a local CSS rule
  (the §2 gate windows) — the painter yields: L2.drop + unpaint (the
  author's values were already restored by drop). Legacy (non-suppressed)
  bakes are untouched — their inline scroll is the bake itself.
- Net: the pill bakes once, stays in the registry across repaints (the
  catcher match is no longer load-bearing while suppressed), and only
  leaves the set when CSS truly takes it back or it leaves the DOM.

**WILL NOT:** touch the catcher spellings, the L2 geometry, the white-pill
law (restoreAuthorBg stays exactly as shipped).

**The proof (§A of the rig):** reproduce the oscillation on the PRE tree
(bake → repaint → DROP (data-proj gone, attachment scroll, position
stripped) → repaint → re-bake); on the POST tree the pill holds one stable
bake across N forced repaints (data-proj stable, suppression stable, no
drop events in DoomProjection.counters), and the label ink stays readable.

## §2 v1.08.3 — THE FULL SPECTRUM (toggles + sliders ride the field)

**The edit (index.html, static, projection-scoped):** THE GATE-WINDOW LAW —
a rule that exists only to show a field under the projection gate declares
its OWN local attachment (`background-attachment: local !important`): the
minted `fixed` (plain) can never out-rank it, and the painter's
first-encounter probe reads the computed attachment and opts the element out
(the v0.92.1 memo path — zero painter cost, zero viewport rasters).

- CHECKED switch tracks: `[data-a1-grad] .app-switch input:checked ~
  .app-switch-track` — the full accent gradient AT BOX SCALE (the
  "compressed full gradient" the user describes), `local !important`
  beating the mint + the catcher, `background-size: 100% 100% !important`
  + `background-position: 0 0 !important` pinning the box scale. The gate-
  led form merges under ROOT_GATE_RE (the v1.04.2 law) — no double-html
  mint.
- UNCHECKED switch tracks: `[data-s1-grad] .app-switch input:not(:checked)
  ~ .app-switch-track` — `background-image: var(--surface-1-gradient, none),
  var(--accent-gradient, none) !important` (THE LAYERED WINDOW: the surface
  field when it is live; the accent field shows through when the surface
  twin is flat) + `local !important` (beats the inline render shorthand).
- SLIDERS: the gate track rule gains the same layered image + `local
  !important`; the thumb keeps the solid accent (a 20px knob — the v0.92.1
  scale precedent; putting a gradient var on a ::-webkit-slider-thumb rule
  would leak onto the element through the painter's pseudo-strip — WILL
  NOT).
- The doom switch's own rule (5222) generalizes into the unchecked law.

**The proof (§B):** under the gate with live accent fields: a checked
track's computed image = the accent gradient, attachment local, NO
data-proj/data-proj-bake, painter stats.paints unchanged across toggle
flips; screenshots (checked + unchecked + slider) show the FULL gradient on
the controls; OFF state byte-identical (gate rules inert).

## §3 v1.08.4 — THE SEAMLESS FIELD (the header joins the body's gradient)

**The edit (index.html + gesture.js):** ONE field, TWO windows, ZERO
restarts.

- index.html 5050 splits: the header and the body keep the surface field
  but render it at a SHARED scale — `background-size: 100%
  var(--panel-field-h, 100%)` — with the body offset by the header's
  height: `background-position: 0 calc(-1 * var(--panel-header-h, 0px))`.
  The header positions at `0 0`. Any linear gradient now CONTINUES across
  the seam (same size, shifted origin) instead of repeating. #chat-panel
  keeps its own paint (covered by the opaque pair; translucent surfaces
  keep their root wash).
- gesture.js syncs the two vars at every REST write (the settle path it
  already owns): `--panel-header-h` = the header's offsetHeight,
  `--panel-field-h` = header + the rest window height. During motion the
  vars freeze (the field is the panel's material; the stretch REVEALS more
  of it — no per-frame rescale, no per-frame raster). The close path
  (`writeVis(H)`) leaves the vars (harmless at zero height).
- Fallback: both vars default to the current local behavior (100%/0px) —
  pre-sync renders byte-identical to v1.08.1.

**The proof (§C):** screenshots at rest (projection OFF, gradient surface):
the header strip and the body's top band sample the SAME field positions
(pixel probe: the header's bottom row hue ≈ the body's top row hue — the
v098 tiling-period check pattern); after a stretch + settle the field
re-syncs; a synthetic tall-header (font-size bump) re-syncs at rest.

## §4 v1.08.5 — THE COAST (text stops writing during motion+scroll)

**The edit (doomprojection.js):** the research verdict applied — during
motion and scroll the text windows COAST (their gradients ride the content;
zero main-thread writes, zero glyph rasters); ONE settle paint re-anchors.

- Baked text windows are marked at decision time (`__projClip` from
  snap.clip === 'text'; cleared on drop/strip paths).
- scrollRebake skips `__projClip` elements (they coast with the content;
  newcomers still get the on-the-spot bake — correct anchor at first sight).
- motion()'s window-open edge (coast flag false→true) performs ONE batched
  disconnect: every painted text element's background-position is rewritten
  to its CURRENT resolved constant (the var term dropped) — the per-frame
  `--proj-tx/--proj-ty` writes stop touching text entirely (no recalc, no
  repaint; the L2 layers keep their compositor compensation).
- paint() un-coasts at entry (it IS the settle): the read phase re-anchors
  every text window (the coasted constants differ from the var-form → the
  normal write path restores them).
- The rig measures: style writes during a scripted 1200px transcript scroll
  (pre: ~painted-text-count per event; post: 0) and long-task time during a
  scripted panel drag with a long transcript (the rig prints both).

**WILL NOT:** touch the L2 path, the motion windows' cadence, the DOOM
SHEET, or the native-fixed leg outside the roots (none of it writes during
scroll).

## §5 SHIP v1.09.0 — THE SEAMLESS FIELD

- the full battery: v109 rig (new) + v107 22/22 + v106 21/21 + v1045 11/11
  + v1040 7/7 + twins/uikit/go;
- the REBASE PROTOCOL: fetch origin (the parallel bot), diff, merge, build;
- buildinfo 1.09.0 → tag v1.09.0-the-seamless-field → release (CI APK) →
  CI green → worklog + MEMORY.md.

## §6 THE SPAGHETTI BOUNDARY (will NOT)

- no new projection modes, no per-element opt-out config surface — the
  attachment:local gate law and the suppressed-ownership test are the two
  mechanisms, both inside the existing derivation;
- no transform-only rewrite of the panel sheet (the v1.06 scope-cut stands;
  the coast + the research write-up are this wave's lag answer);
- no chatpanel/settings re-architecture (the renders keep their inline
  spells; CSS wins over them under the gate);
- no thumb gradients (the pseudo-strip leak — noted, refused);
- if the coast needs anything deeper than the clip flag + the disconnect
  batch inside doomprojection.js, it stops there.
