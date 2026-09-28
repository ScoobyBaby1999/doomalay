# PLAN-V0643 + V0644 — THE TIDY PILL + THE PARITY WAVE

> USER SPEC (six asks, two waves): "that was a job well done. Good job.
> Let's make the search pill for the browser In browser (BIB) panel 10%
> less wide and high. Let's also make the hitbox for the refresh icon
> bigger so it's easier to press. Let's move the smooth loading icon u
> made that uses theme colors upward approx 35% from its current
> position. Let's also add a loading pill, similar to the one we have
> when the chatbot is thinking or establishing a connection ext.. to
> the web link pill in the bib panel only when the website is actively
> loading. More generally, let's expand this bib panel functionality to
> the regular panel. Reuse the function if easier. But let's have the
> bib panel and regular panel function the same, in that they have 3
> fixed positions, 2 mains ones, and one that stays for ~3 retriggrable
> seconds unless the user is interacting. Finally, let's add the
> functionality so that if the user presses the panel while it is docked
> at 30%, (they are don't interacting) if they press it or slide up,
> the panel goes back to it's original position, if they slide it down,
> it goes slides down and stops rendering."

## Wave 1 — v0.64.3 THE TIDY PILL (native-only, asks 1–4)

All four asks live in `PanelBrowserSheet.kt` — zero web changes, zero
gesture changes. The Kotlin compiles in CI (blind locally); the suite
carries a static audit.

  1. THE SEARCH PILL, 10% LESS WIDE AND HIGH. "Search pill" is the
     user's name for the URL capsule `[↻ link]` (their vocabulary since
     the polish round: "the 4 pills — search, back, redirect, close").
     Height today: 24dp icon + 2×5dp padding = 34dp. New: 30dp tall
     (−12%): the refresh slot grows to 30×30 (ask 2) with 0dp vertical
     pill padding. Width: the text cap 170dp → 153dp (−10%), pill
     padding 6/10 → 5/9, text padding 4/6 → 3/5.
  2. THE REFRESH HITBOX. The ImageButton slot 24×24 → 30×30 (+25% a
     side, +56% area) while the glyph stays 18dp (padding 3→6dp) — the
     button fills the pill's full height at its left edge. The ripple
     circle radius follows 12 → 15dp.
  3. THE RING LIFTED. The loading stack (ring + link text) sits at the
     body's center today; it moves up by 35% of the OVERLAY's height
     (center 50% → 15%), clamped so the stack's top never leaves the
     body (the 30% duck peek has a short body — clamp keeps ≥ ~13dp).
     Implemented as an OnLayoutChangeListener writing translationY —
     rotation-safe, no per-show math.
  4. THE LOADING PILL ON THE LINK PILL. The chatbot's thinking pill
     (`chatpanel.js` v0.23 "the no-silence guarantee") is five pulsing
     accent dots (`cwd-pulse`: 0.9s cycle, 0.12s stagger, opacity
     .18→1, scale .82→1.12). The same five dots become a `LoadDots`
     view appended to the URL capsule (right of the text), GONE unless
     `setLoading(true)`, fading in/out with the overlay's own 110/160ms
     timing, tinted by the theme snapshot's accent per open, spun by a
     phase animator in startSpins/stopSpins. `setLoading` drives both
     the body overlay AND the pill dots — one loading truth.

## Wave 2 — v0.64.4 THE PARITY WAVE (asks 5–6, both panels)

The regular panel (gesture.js's always-tall sheet) grows the BIB
panel's exact third-dock behavior. Same fractions (0.62 default /
0.30 duck), same ~3s retriggerable hold, same triggers, same docked
rules. "Reuse the function if easier" — the Kotlin and the JS can't
share code, but they share the DESIGN, constant for constant.

### The state machine (both panels, identical semantics)

  · TRIGGER — a touch on the app behind the half-docked panel (the
    canvas strip it leaves visible): the panel glides to the 30% peek,
    the canvas dim lifts (the SPA's #chat-scrim), and the touch is
    never eaten — the canvas pans immediately under the gliding sheet.
    The full dock never ducks (nothing to press behind it).
  · THE HOLD — ~3s, retriggered by EVERY touch on the app behind the
    panel AND by continuous interaction (touchmove on the canvas, page
    scrolls in the peek — "unless the user is interacting"). Expiry
    glides back to the 62% dock and the dim is restored.
  · THE DOCKED RULES (ask 6) — while the panel sits at the 30% peek:
      press it (a tap: strip, pill, page, chat body — anywhere that
      isn't already a button with its own job) → back to the ORIGINAL
      dock (62%).
      slide up → back to the ORIGINAL dock (62% — NOT full: "goes back
      to it's original position").
      slide down → the panel slides down and STOPS RENDERING (native:
      dismiss + webView.onPause(); web: the dismiss spring + close).
    The four chrome buttons keep their own semantics (↻ reloads, ‹
    walks history, ⧉ leaves, ✕ dismisses) — a press on a button is
    the button's, not the panel's; the native ‹/⧉/↻ also restore the
    dock (attention is back), ✕ dismisses anyway.

### The web half (gesture.js + panel.js + browserdock.js)

  · gesture.js — THE DUCK ENGINE: DUCK_FRAC 0.30, DUCK_HOLD_MS 3000;
    `duckForCanvas()` (guards: on-screen, not full, not already
    ducked → spring to the peek), `retriggerDuck()`, `cancelDuck()`,
    `isDucked()`; `track.fromDuck` captured at begin() so end()
    decides the ducked release with the docked rules; body-tap restore
    (a body touch that never moved, while ducked → restore); the
    engine never touches currentState — position memory (full/default)
    is unaffected, decide() is untouched for non-ducked gestures.
    Fires `doomalay:panel-duck` + keeps `window.__doomalayPanelDuck`
    current for the native channel's guard.
  · panel.js — THE TRIGGER WIRING: a document-level capture
    touchstart/touchmove (passive, never eaten): a touch outside
    #chat-panel while the panel sits at default → duck; while ducked →
    retrigger. The #chat-scrim's inline channel (the same pattern
    browserdock.js established): pointer-events none while the panel
    is open (canvas presses must reach the canvas), opacity 0 while
    ducked (canvas focus), cleared exactly on close. The scrim's old
    tap-to-close is retired for touch (a canvas press DUCKS now — BIB
    parity); the DESKTOP convention survives as a document-level click
    close (mouse-only: pointerType guard + a drag-versus-click check +
    capture-phase stopPropagation, so the old scrim semantics — a
    clean outside click closes, a drag pans — hold on desktops).
  · browserdock.js — THE CHANNEL GUARD: the native sheet's
    __doomalayPanelState close-branch no longer wipes the scrim
    overrides blindly; if the SPA's own panel is open underneath, the
    suspension stays (and the dim follows the SPA panel's own duck).

### The native half (PanelBrowserSheet.kt + MainActivity.kt)

  · `dragFromDuck` at ACTION_DOWN; release() from the duck: dy > slop
    down → dismiss (+ webView.onPause() — "stops rendering"), else →
    restore to 62%. A no-drag UP on the strip/pill → restore (the pill
    still copies). The sheet's WebView: MOVE retriggers (long scrolls
    keep the peek), a no-move UP restores (the press rule). ↻ ‹ ⧉
    clicks restore after their action; ✕ stays dismiss.
  · MainActivity's SPA listener also fires on ACTION_MOVE — a
    continuous canvas drag is "interacting" and must not let the hold
    expire mid-gesture.

## Tests

  · scripts/v0643-panel-tidy-test.sh — the static Kotlin audit (30×30
    slot, 153dp cap, LoadDots, the lift + clamp, ripple 15, the
    onPause/onResume pairing) + the router regression spot checks.
  · scripts/v0644-parity-test.sh — LIVE against the engine: the duck
    glide + exact landing, the scrim channel (suspension, dim lift,
    restore), the retrigger hold (real 3s waits), the docked-grab
    rules (synthetic touch sequences: down → close, up → restore, tap
    → restore, body tap → restore), the mouse click-to-close with the
    drag guard, the full-dock no-duck guard, the native channel's
    close-branch guard, the position-memory invariance + the
    doomalay:panel-duck events. Plus the static native audit.
  · Regressions: v0642 (46), v0640 (56), v0621, v0623, v0624, uikit
    (140), theme (165), go test ./... (server + llm).

## Ship

Two staged pushes (the house rule): v0.64.3 commit + tag + push, then
v0.64.4 commit + tag + push — rebase before each.
