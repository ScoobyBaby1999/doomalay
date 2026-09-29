# PLAN-V072 — THE PARITY CARD + THE EASY SLIDE + THEME COHERENCE + STAR SIZES

Four user asks, four staged waves (each: build → test → commit → tag → push,
rebase first):

## WAVE 1 (v0.72.1) THE PARITY CARD — bundles == single items
User spec: "When viewing bundles, it shouldn't look different from viewing
single files… no tags under the description, no total downloads/endorsements,
two rectangular pills instead of the circular FABs. Every item published in
the library should act as a bundle, even with 1 file. Visually + functionally
the same; only the LLM has more options."

- SERVER (collections.go): `CollectionSummary.Tags []string` — votes across
  ALL member tags (not just the first), top 16 by votes (ties alphabetical).
- CLIENT (hub.js bunchRender): the hero mirrors hi-head's body EXACTLY —
  name+icon / desc (the content bits line) / meta ("N items · updated …") /
  TAGS row (top 5 `hi-chip`s + a "+X" chip, title lists the rest) / COUNTS
  row (♥ Σ hearts · ⤓ Σ downloads, the hi-counts markup).
- The rectangular `download all N` + `use bundle` pills RETIRE. The bottom
  FAB row (hi-fabs/hi-fab, the exact single-item classes):
  · ⤓ download — runBundleDownload; running shows "N/M" + pulse; done ✓/ok;
    partial "↻N/M"; error "↻retry". Live repaint via paintDlPill port.
  · ♥ endorse — locked until the bundle is downloaded (the engine's rule);
    on = every member hearted; tap fans out endorse/unendorse over members.
  · ▶ use bundle — only when the registry says downloaded (applyBundle).
  · 🗑 delete — only when downloaded; the hi-delbar confirm bar; POST
    /api/hub/collections/{id}/delete + registry clear.
- GRID cards already match (title/desc/foot stats); the bunch card keeps
  its flag — parity is at the DETAIL level.

## WAVE 2 (v0.72.2) THE EASY SLIDE-DOWN — 30% dock → swipe away
User spec: "make it easier for them to be slid down and go out of render…
slide down at 30% dock → the panel should go away."

- gesture.js (the regular panel):
  · DUCK_BODY_SLOP 12px (vs BODY_SLOP 24) while ducked, and the ducked body
    hijack SKIPS the inner-scroller gate (downward = away, per spec).
  · fromDuck release: `dy > DUCK_TAP_SLOP || vy > 0.3` → CLOSE.
  · THE EXPIRY GUARD: the 3s hold retriggers (never fires) while a finger
    is on the sheet (track.active || track.bodyStart).
- PanelBrowserSheet.kt (the BIB):
  · The ducked WebView chain drops the atTop requirement (downward pull on
    the peeked page = dismiss intent) + the ducked slop drops to 12dp.
  · fingerOnSheet: DOWN on strip/pill/page sets it, UP/CANCEL clears; the
    unduck runnable retriggers instead of rising while held.
  · release()'s dragFromDuck path already closes on any dy>0 (kept).

## WAVE 3 (v0.72.3) THEME COHERENCE — borders / raised / background / pills
User spec: outline pills in chat + chatbot metadata don't follow the theme;
the border variable leaks into surface-raised and colors whole collapsible
pills; surface-raised leaks into background; background/raised TILE per
element instead of one screen projection; the parallax slider caps at 100.

- (a) EMPIRICAL PROBE first: pixel-compare pills at different offsets inside
  the transformed panel → confirm what fixed-attachment actually does there.
- (b) THE PLATE SYSTEM (the leak fix): theme.js writes `--X-plate` for the
  box vars (--bg-app, --surface-1, --surface-2) = the gradient twin when
  real, else `linear-gradient(var(--X),var(--X))`. The Layer-2/Layer-3/
  radius-safe rules paint the PLATE as layer 1 — the border ring layer can
  never flood the whole element when the surface twin is 'none'.
- (c) CHAT PILL WINDOWS: src-wrap/hub-wrap become real bg-app windows with
  a border ring (plates); tool-pill-progress windows surface-2; the chatbot
  name pill / icon disc / sandbox badge join the projection families; the
  src-count/src-card-dom outlines ride their accent windows.
- (d) PARALLAX SLIDER: max 100 → 300 (appearance.js gridSlider) and app.js
  clamps allow pdepth up to 3.0 (PF_LINE can cross 0 — the hyper-space
  look; bgParallax floors at 0.15 as today).
- (e) TILING: whatever the probe shows — fix per root cause.

## WAVE 4 (v0.72.4) STAR SIZES — the variation cap raised
User spec: "increase the size variation of dots and lines, make the cap
higher — some stars larger, some lines very small, almost like a shooting
star."

- app.js: sizeFrac = sizeVar/100 * 1.5 (±85% → ±150%).
  · Dots: jr ∈ [floor 0.15 … 2.5× base] — big stars, dust motes.
  · Line segments: segLen floor 0.06×grid (a 2-4px speck-streak at the
    extreme = the shooting star), segW floor 0.12 (hairlines), max 2.5px.
- The continuous-line path's lwBase keeps its 0.3 floor.

## TESTS
- scripts/v0721-parity-card-test.sh — server Tags aggregation + the bunch
  view DOM (tags/counts/FABs/states) + live click paths on the mock hub.
- scripts/v0722-easy-slide-test.sh — synthetic touch sequences for both
  panels' ducked releases (incl. the scrolled-content + held-press cases)
  + the Kotlin static audit.
- theme twin suite + a new plate/leak probe in the v065 spirit (phases:
  border-only, raised-only, both) + the parallax slider bounds.
- v065 theme suite (249 screens) as the final visual regression.
