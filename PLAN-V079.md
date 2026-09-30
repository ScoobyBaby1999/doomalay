# PLAN-V079 — THE PANEL FRAME-RATE WAVE (the theme-change surgery)

User spec (verbatim intent): "The browser in browser panel runs on a much
higher frame rate than our regular panel… it's at its worse and lowest
frame rate — barely usable — in the settings panel when changing the
theme colors and variables. It's at its best on a panel with not much
going on. While chatting with the bot the panel behaves average. Your
sole goal right now is to improve the feel and frame rate of this very
important panel until it feels as good and smooth as the browser in
browser panel."

The BIB panel is NATIVE Kotlin (its own WebView + zero SPA work) — the
regular panel pays the SPA's full cost. v0.78.3 already killed the
per-frame projection paints on scroll/drag/stream. What's LEFT is the
worst case the user names: **the theme editor in the settings panel**.

## The mechanistic map (root-caused by reading every hop of the path)

Per color-wheel drag event (up to ~120/s on Android), the WHOLE of this
stack runs:

1. `uikit.js GradientUI.wire` `.gr-color input` → `paintPreview +
   paintBanner + h.live()` — per EVENT, no coalescing.
2. `h.live()` = `writeThemeVar` (appearance.js:602) → `Settings.setState`:
   - `save()` — `JSON.stringify(entire state)` + `localStorage.setItem`,
     synchronous, PER EVENT (settings.js:108).
   - Listener 1 `applyTheme` (theme.js:242):
     * `removeProperty` × every previous override key, then
       `setProperty` × ~2–3 per var + `-rgb` triplets ≈ 30–60 CSSOM
       writes on `<html>` (theme.js:256/287/295/312/358/371/386/420/441/468).
     * **9–10 INTERLEAVED `getComputedStyle(documentElement)` reads**
       (`--bg-panel` :356, `--accent` :368, `--accent-2/3/4` :384,
       `--surface-1` :402, `--surface-1/2/--bg-app` :463, and
       `cssVar('--border-strong')` :518) — each one a FORCED
       full-document style recalc after the writes above it
       (web.dev "layout thrashing", style edition — confirmed by
       the forced-layout gist + webperf literature).
     * ~15 attribute flips on `<html>` (data-theme, data-text-grad,
       data-a1..4-grad, data-s1/s2/bg-grad, data-border-grad,
       data-bright-*) — most to the SAME value they already have.
     * `Formatter.applyScheme` (formatter.js:130) — ~15 more BLIND root
       property writes + attribute flips, even when the scheme +
       overrides are byte-identical to the last apply.
     * `meta-theme-color` setAttribute.
     * `DoomProjection.poke()` → rAF-scheduled FULL projection paint
       (querySelectorAll mega-selector + per-element gCS/gBCR batch +
       style writes) — but anchors depend on GEOMETRY, not colors: a
       value-only theme change moves nothing.
     * `DoomGates.refresh()` = `derive()` (theme.js:1409) — walks EVERY
       stylesheet rule TWICE (protected pass + main pass; index.html's
       giant `<style>` + runtime-injected sheets) building selector
       arrays. `lastCSS` caches the OUTPUT, but the WALK itself runs
       per event (10–50ms on a phone, per drag frame).
   - Listener 2 (app.js:1960) → `update()` (app.js:1253) — FULL canvas
     repaint: `paintCanvasBackground` (2× colorspace tile repaint when
     the spec changed) + every dot/line (scatter/variation/rotation
     hashes) + every icon + offscreen arrows + another PROJ poke —
     even when the changed var (e.g. --accent) has ZERO canvas effect.
   - Plus the browser's own full-document style recalc + repaint the
     vars demand.

Estimated per-event cost on the phone WebView: 150–400ms → the measured
"barely usable 8 fps". ✓ matches the report.

## The fixes — v0.79.1 (theme-change surgery; each one mechanistic)

**A. rAF coalescing at the source (uikit.js)** — the `.gr-color` inputs
and the angle slider throttle `h.live()` to ONE call per animation
frame (latest-wins; the trailing `change`/pointerup value always lands).
Native color-wheel drags fire dozens of events per frame; only the last
per frame matters.

**B. Debounced persistence (settings.js)** — `setState`'s `save()`
becomes trailing-debounced (300ms) with a flush on `pagehide` +
`visibilitychange(hidden)`. The in-memory state + listeners stay
immediate; ONLY the localStorage write moves. (JSON of the whole state
per drag frame was never needed.)

**C. applyTheme surgery (theme.js)** —
   1. **Zero forced recalcs**: a per-theme-id CACHE of the [data-theme]
      block values (one batched getComputedStyle read, only when the
      theme id actually changes) + override twins known in JS ⇒ every
      one of the 9–10 `getComputedStyle` read sites resolves in pure
      JS. No read ever interleaves a write.
   2. **Delta application**: an `applied` map of the live inline
      values; `setVar(k,v)` writes only when the value differs and
      `removeProperty` only keys that truly vanish. A one-var drag
      writes exactly that var's 2–3 properties — no more
      remove-all-then-set-all invalidation storms.
   3. **Attribute guards**: each data-* flip only on real change.
   4. **Formatter.applyScheme gate**: skip entirely when
      (scheme, fmtOverrides) is identical to the last applied pair;
      delta-write the fmt twins when it isn't.
   5. **Poke discipline**: `DoomProjection.poke()` and
      `DoomGates.refresh()` fire ONLY when the GATE TOPOLOGY changed —
      a fingerprint of (theme id, the override KEY SET, per-var
      solid↔gradient state, fmt-grad slots). Value-only changes (hue,
      angle, stops within same gradient-ness) don't move boxes or
      selectors. A solid→gradient transition flips the fingerprint →
      one derive + one repaint (correct, and once, not per frame).

**D. Canvas update gating (app.js)** — the `Settings.onChange` listener
computes a canvas fingerprint (theme id, grid specs, all grid effect
keys, --bg-panel override, parallax, hide flags, families) and calls
`update()` only when it changed, rAF-coalesced (one repaint per frame
max — currently 5–10 full canvas repaints stack per frame during a
drag). An --accent/--text-1 drag repaints nothing.

## v0.79.2 — residual chat-path wins (the "average" case)

- Re-run the v0783 panel-perf suite (12/12 must hold: 0 scroll paints,
  ≤1 drag paint, two-tier streams).
- Verify the settle-timer behavior during a real streamed turn (bounded
  paints), and that nothing new paints per tick at rest.
- Any cheap cut found on the rig lands here; nothing speculative.

## NOT doing (anti-spaghetti)

- No changes to the BIB native panel (it's already the gold standard).
- No Kotlin, no brain/, no new UI, no theming-model redesign. The twin/
  gate/projection architecture is untouched — only its cost profile.

## Verification (scripts/v0791-theme-perf-test.py + red-team)

Rig (engine + Playwright, same pattern as v0783):
1. Open Settings → Appearance → expand the Customize section; expand a
   color row (the GradientUI editor). Instrument: CSSOM write counters
   (style-setter traps on documentElement.style.setProperty/
   removeProperty), applyTheme call counter, PROJ.stats.paints, a
   derive-walk counter (wrap DoomGates.refresh), update() counter, and
   a localStorage.setItem spy.
2. Dispatch 60 input events on a `.gr-color` over 1s (the native wheel
   cadence) on `--accent` (non-canvas var):
   - assert: applyTheme runs ≤ frames, setProperty calls collapse to
     ~2–3 PER FRAME (not per event), getComputedStyle forced reads = 0,
     derive walks = 0, PROJ paints = 0, update() = 0, localStorage
     writes ≤ 4 in the window, and the FINAL applied var value is the
     last dispatched one (latest-wins correctness).
3. Same drag on the CANVAS var (--bg-panel): update() ≤ 1 per frame,
   final tile is the last color (visual + fingerprint check).
4. Solid→gradient transition (2nd stop added): exactly ONE derive +
   ONE PROJ paint for the whole drag (topology change), gates on.
5. Theme switch (set-theme action): full re-apply, cache rebuild once,
   byte-identical visuals vs pre-change screenshots (the theme suite
   already pins 165 of these).
6. Size sliders (chatTextSize): per-event cost = 2 setProperty writes
   (the --chat-fs pair), nothing else.
7. Live-feel proof: the theme still updates LIVE during the drag (the
   var writes land per frame — accent color follows the wheel), the
   persistence lands after the drag settles (reload keeps the value).

Regression gates: theme twins 165/165, uikit 140/140, v0783 12/12,
v31 browser-test (dock + panels), go build/vet/test.

## Ship discipline

- v0.79.1 = A+B+C+D (one commit, one tag).
- v0.79.2 = the residual audit + any cheap chat-path cut (separate tag).
- Push only after: rebase on latest main, APK diff check, suites green.
