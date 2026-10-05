# PLAN-V104 — THE FIVE FIXES + THE RESTORE

The user order (2 layers): five small fixes on the Theme Editor, then
the big one — the from-scratch canvas "doom projection v2" is
"entirely broken"; restore the system it replaced (the pre-v1.01.5
viewport-projection painter), ported to the current field variables.

## THE DIAGNOSES (recon-verified, file:line)

**F1 — the wheel's touches reach the panel.** gesture.js ownsGesture
(line 204-207) is a positive list: `input[range], input[checkbox],
.app-switch, textarea, .no-sheet-drag`. The wheel (.te-wheel) is NOT
on it → a touch drag on the wheel that moves >24px down runs the body
touchmove hijack (gesture.js line 792-804): preventDefault fires →
the wheel's pointer stream is CANCELLED + the panel sheet starts
gliding. The user's preferred shape: the panel should not even
LISTEN to that channel — only touches of certain channels.

**F2 — the type pills are the standard pill family** (raised-chrome,
border-radius 10 — the same look as every other pill), and the locked
state renders the '⌧' (U+2327) TEXT GLYPH — tofu on Android fonts.
Only pinstripe/checker/texture lock (the canvas-only types) on every
non-canvas field — exactly the three the user named.

**F3 — the angle slider never updates the banner.** The input handler
(themeeditor.js line 585-590) updates the ° label + writeLive only;
the banner refreshes only via refreshStatic() on shape changes. ALSO:
makeWriter sets q._teQueued on the SPEC OBJECT — the flag persists
into the saved themeOverrides (data pollution in the .doomtheme).

**F4 — texture IS browse-an-image.** The 'texture' type pill's click
handler goes straight to the file picker (themeeditor.js 542-558) —
selecting the type and importing the asset are one fused action. The
user wants them separated (a future import may do something else).

**F5 — the reset arrow is dead.** wireSlotRows' delegated handler
(appearance.js 827-846) checks `[data-slot-open]` FIRST — the reset
button lives INSIDE .slot-row-head (which carries data-slot-open) →
closest() finds the parent → the OPEN branch returns before the reset
branch ever runs. (The v0.45 colorRowCollapsed wiring had this exact
guard — "don't toggle when the reset pill was tapped" — the slot rows
never got it.)

**THE MAIN ISSUE — the canvas projector is broken.** The v1.03.6
doomprojection.js: (a) the #doom-proj canvas sits at z 300 BELOW the
panel/overlays — the override only makes #chat-panel + 2 inline
spellings transparent, every OTHER opaque intermediate layer hides
the canvas (the projection is invisible); (b) collectSels' dedup keys
byKey by the ELEMENT OBJECT but reads byKey[1] (el.__doomProjId is
always 1) — the dedup never works; (c) pseudo-element rules are
stripped to their host selector — the override kills the host's
image but the ::before keeps painting its LOCAL gradient ON TOP of
the canvas crop (two gradients fighting); (d) the raster reads
--field-* twins via a folded-override map that misses the
resolvedThemeVar path. Not worth patching — the user ordered the
RESTORE.

## THE RESTORE (the old system, ported)

The replaced system (last alive at 1fb19f7e, retired by v1.01.5
6f4d57fc): the CSS `background-attachment: fixed` viewport projection
+ the ~1300-line transform-proof painter in theme.js:
- GATES minted the windows (stylesheet-derived, [data-aN-grad] gates)
  WITH `background-attachment: fixed !important` — v1.01.5 dropped the
  attachment clause (the image survived — the mint at theme.js:1346
  is unchanged otherwise).
- PROJ: the root registry (#chat-panel + #connect-overlay + the
  .hub-sheet/.tpl-sheet family — the latter two are GONE post-v1.02,
  the registry list updates), SEL/POS_SEL collected from the sheets
  (fixed attachment OR var(--*-gradient)), the batched read/write
  paint (bake = `background-size: vw×vh; background-position:
  calc(var(--proj-tx)+Bpx)`; attachment scroll — mathematically
  identical to fixed, immune to the transformed-ancestor
  containing-block rule), L2 Track-2 ::before compositor layers,
  motionTick (one CSSOM var write per root per frame), scrollRebake
  (incremental, zero layout reads), bakeNewcomers, the observer
  family (the v0.79.1 value-var filter, the v0.92.1 orbit-noise
  skip, the writeEpoch self-write guard, cosmetic filters), the
  transition/scroll/resize triggers.

**Why it's portable to the current variables:** the SEL walk matches
`var(--[a-z0-9-]*gradient` — the current twin names
(--surface-1-gradient, --accent-gradient, --accent-2-gradient,
--accent-3-gradient) match verbatim. The GATES (still in theme.js)
mint the same images. The icon chrome is derived SOLIDS in the
v0.99.4 model (surface-2/rgba — never gradient windows) → the
v0.92.1 orbit-noise concern is structurally moot, but the filter
stays (defense in depth). The hub-sheet/tpl-sheet roots are gone —
the registry list becomes `#chat-panel, #connect-overlay` + the
connect overlay's pushed pages ride the same root.

**The toggle (the v1.03.6 switch stays):**
- ON: mint THE DOOM SHEET — walk every stylesheet rule whose
  background-image carries a `var(--*-gradient)`; mint
  `html[data-doom-proj] <sel> { background-attachment: fixed !important; }`
  (the html[attr] prefix out-specifies every base rule; !important
  beats the inline background shorthand resets; the walk covers the
  index.html static rules + the GATES sheet + the [style*=] catchers
  + module-injected styles). Then boot the painter (collect + paint
  + observers).
- OFF: teardown — strip every baked inline style + L2 rules + the
  flags (__projPainted/__projPos/…) + drop the DOOM SHEET +
  disconnect the observers. The v1.01.5 local model (today's
  behavior) — byte-identical for toggle-off users.
- The re-mints: DoomProjection.repaint() (the GATES call it after
  every derive — theme.js:1381) re-mints the sheet + nulls SEL; the
  observer's new-<style> detection nulls SEL + schedules the sheet
  re-mint; the 120ms 'doomalay:theme-applied' event re-mints after
  theme flips.

**The file layout:** doomprojection.js is REPLACED (the canvas
system dies — the whole file). The ported painter lives there, same
script tag, same API surface (setEnabled/enabled/repaint/poke/
motion/paint/stats + the legacy stats fields paints/motions/rebakes/
baked for the rigs).

## THE PHASES

### v1.04.1 — THE FIVE FIXES (one commit + one rig)
- F1 gesture.js: ownsGesture += `.te-wheel, .te-banner, .te-stop,
  .te-sw` (the editor's drag/tap surfaces); restructure the body
  touchstart to NOT RECORD bodyStart at all when the target owns its
  gesture (the "not even listen" shape — the move handler's noSheet
  check stays as belt-and-braces).
- F2 themeeditor.js + index.html: typesHtml renders SVG glyphs
  (inline, stroke=currentColor, 14×14 viewBox 24) — linear (two
  diagonal strokes), radial (circle + center dot), mesh (three
  offset dots), pinstripe (4 thin vertical strokes), checker (a
  2×2 checkerboard), texture (a framed image glyph) + a real
  padlock SVG badge for the locked state. The pill style becomes a
  DISTINCT family: outline tiles, no fill (transparent background,
  border-only), selected = the accent ring + the tinted glyph, 3×2
  grid.
- F3 themeeditor.js: the angle input handler updates the banner
  directly (style.backgroundImage write — same shape applyHsv uses)
  + the anchor row's banner. makeWriter: the queue flag moves to a
  closure variable (no spec pollution).
- F4 themeeditor.js: the texture pill SELECTS the type (sets dir
  'tex' if a tex exists; with no tex it opens the import). The
  import becomes its own affordance: an "image · import/replace"
  row rendered under the type pills when the field allows tex
  (canvas fields) — clicking it browses. A "clear" mini-button drops
  the tex back to linear.
- F5 appearance.js: wireSlotRows checks [data-slot-reset] BEFORE
  [data-slot-open].
- Rig: scripts/v1041-editor-fixes.sh — F1 (a wheel drag leaves the
  panel transform untouched — read the panel's computed translateY
  before/after a synthetic drag), F2 (the pills carry SVG children;
  no '⌧' text anywhere; the distinct class family), F3 (the banner's
  computed background-image changes angle after a slider set), F4
  (the texture pill does NOT open a file picker; the import row
  does; selecting texture with a tex flips the spec), F5 (the reset
  click clears the override + does not open the editor).
- Re-pin: v1033/v1034/v1035 (the editor family — the stops/types
  HTML changed), v1032 (the fmt entry), v098 (the settings colors
  tab structure — unchanged but battery), twins + uikit + go.

### v1.04.2 — THE RESTORE (one commit + one rig)
- The port (doomprojection.js, ~700 lines ported + the toggle
  shell): SEL/POS_SEL collect, syncRoots (the updated root list),
  readMatrix/setVars/motionTick, fmtCalc/fmtCalcY/fmtCalcYVis, the
  L2 module (ok/snapshot/bake/rebake/drop/resizeAll), findScroller +
  the scroller rules, paint (the batched read/write phases, the
  carry logic, the phantom purge), scrollRebake + bakeNewcomers +
  scrollSettle, the observer (value-var filter, orbit noise,
  writeEpoch, cosmetic), the transition/resize triggers, the API.
- THE DOOM SHEET + the enable/teardown shell + the boot sync.
- Rig: scripts/v1042-the-restore.sh (re-pins v1036's intent):
  ON → html[data-doom-proj] set + the DOOM SHEET present + the
  panel's computed attachment flips to fixed + the baked windows
  carry vw/vh background-size + calc(var(--proj-tx) positions; a
  scroll moves the bake (the incremental path); OFF → everything
  stripped (attachment back to scroll, no inline bakes, no sheet,
  no flags); the theme flip re-mints (a gradient edit changes the
  twins → the baked image follows — the L2 epoch re-mint); zero
  longtasks during a drag with the toggle on; the toggle persists
  across reload.
- Full battery re-run.

### v1.04.0 — THE SHIP
- The APK (build-apk), the release notes, the worklog entry, the
  push (fetch-first rebase discipline), the tag v1.04.0-the-restore.

## RISKS + MITIGATIONS
- The fixed-attachment Chromium slow path (kMaxComposited = 8) —
  the untransformed native-fixed population is tiny post-v0.99.4
  (the icon chrome is derived solids); the panel/overlay content is
  baked to scroll attachment by the painter. The toggle is the
  escape hatch.
- The bake's inline writes vs the DOOM SHEET's !important — the
  painter's position/size writes are INLINE WITHOUT !important and
  the sheet only carries ATTACHMENT — different properties, no
  fight. The L2 inline suppression (background-image none
  !important) + the sheet's attachment — orthogonal, both apply.
- The v1.01.5 split-gradient (untracked transformed ancestors) —
  the registry list covers the two live roots; any future container
  is a one-line list add (documented in the port header).
- The GATES' repaint() call now does real work again — the observer
  discipline (the writeEpoch guard) is ported verbatim so the
  painter never self-triggers.
