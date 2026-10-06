# PLAN-V111 — THE BREATHING FIELD

The user's four v1.10.0 post-ship reports, decoded on the disk tree (v1.10.0-the-weightless-wave @ ee7f854f):

1. **The projection freezes until rest** — v1.09.1 THE DRIFT COAST freezes the root vars + coasts
   every legacy window for the WHOLE motion window; the settle paint lands once, at rest. The user:
   "it updates one time after the panel is at rest. It should update like twice a second to look
   smooth but be performant."
   → **THE BREATH**: while a motion window is open, a full re-anchor paint is allowed at most every
   500ms (2Hz). The paint un-coasts, re-anchors, re-syncs the vars; the next motion() edge re-coasts.
   Drift error bounded to ≤500ms of motion instead of the whole glide.
2. **"The panel itself gets slower the more custom colors it holds… the canvas itself feels slow to
   respond"** (doom projection exonerated by the user's own testing) — mechanism UNKNOWN by the
   user's own admission. → **THE PROFILER**: a CDP/Playwright perf probe comparing a default theme
   against a many-custom-colors theme across (a) the anchor glide, (b) canvas pan/zoom input→paint
   latency, (c) CPU profiles. The fix follows the measurement (scope discipline: if it would
   spaghettify, it is documented and stopped).
3. **Sliders regress** — v1.06.3+1.08.3 gave `input.app-range` a fat custom track (10px, layered
   full-spectrum). The user: "revert… narrow, clean… follow the doom projected gradient, if we can't
   do that then the first color of that gradient is better then what we have now." Research confirms
   `accent-color` accepts `<color>` ONLY (no gradient) — native geometry cannot wear a gradient.
   → **THE NATIVE HAND**: delete both gate blocks; native sliders return; `accent-color:var(--accent)`
   = the first stop of the accent gradient (the user's own accepted fallback). Toggles keep the
   full-spectrum look the user endorsed.
4. **Amplify parallax mis-features** — decoded on the tree: with `amp > 0` the bake mints (a) live
   hero fireflies (TOP-BAND-only candidates — they exist ONLY when amp > 0, up to 40, bright/large,
   drawn on the over-icons layer, repeating at the tile period = "more stars… many of them… tiled"),
   (b) static glow (halo sprite + `shadeHex(col,0.42)` lifted cores) on top-band big dots = "large
   bright stars, brighter than any star when amp is off", (c) over-tiles on #c2 for big dots/lines
   (overDotsOn = amp≥0.5 && effFrac>0.02 — at sizeVar ≥ 80, ~20% of dots clear the bar) = "stars
   with size ≥ 80 render over icons". The BAND SPLIT itself (5 depth planes of the SAME dots/lines
   at per-band parallax factors) is the honest feature and stays.
   → **THE HONEST SKY**: heroes + static glow + the over split all removed (amp=0's exact population,
   moved in parallax fashion). → **THE TRUE DEPTH**: per-band ZOOM parallax — each band's drawn
   period scales by `S^((pf−1)·kZ)` (kZ≈0.6): near planes grow faster on zoom-in, far planes
   slower; world-true at S=1; zero new elements, zero new fills (pattern-matrix math only — the
   user's own "nothin computation wise").
5. **Comets** — "only happen when the scatter of dots or grid lines is >0.4, either or. And let's
   make it x10 more rare." Sliders are 0–100 → the gate is `scatterD > 40 || scatterL > 40`; the
   cadence 18–44s → 180–440s (first spawn 60–160s).

## Phases (staged x.x.1 pushes; ship = v1.11.0, left-shifted)

| Phase | Name | Content |
|-------|------|---------|
| probe | THE PROFILER | v111-perf-probe.py — measure BEFORE building; informs the color-count fix |
| v1.10.1 | THE BREATH | the 2Hz motion-window breath in doomprojection.js run() |
| v1.10.2 | THE HONEST SKY | heroes/glow/over-split removed; comet scatter gate + ×10 cadence |
| v1.10.3 | THE TRUE DEPTH | per-band zoom parallax in the tiled fill loop |
| v1.10.4 | THE NATIVE HAND | slider gate rules deleted; native rendering returns |
| v1.10.5 | THE MEASURED FIX | whatever THE PROFILER convicts, if it fixes cleanly |
| v1.11.0 | ship | the rig + the battery + the rebase-before-push protocol |

## Will-NOT (the spaghetti boundary)

- No rewrite of the band system into a shader/canvas-layer stack.
- No new visual elements in the parallax path (the user's explicit prohibition).
- No gradient on native sliders (browser-impossible — accent-color is <color> only).
- No painter-wide rework for the breath (one gated branch in run(), nothing more).
- The color-count conviction must be a mechanism fix, not a symptom mask.
