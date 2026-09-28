# PLAN-V0642 — THE PANEL POLISH + THE SECRET THIRD DOCK

> USER SPEC (three asks, one wave): "The panel browser in browser is
> actually incredible. It's amazing seriously. Just please let's polish
> the 4 pills up-top (search, back, redirect, and close) and let's add a
> very polished neat circular loading bar that uses theme colors + a
> loading (website link) text while the panel is loading instead of a
> black screen. Amazing job. If it will not require significant rework,
> Let's also have it so that while the panel is open and half docked,
> the user can press the canvas and still move it, since the panel is
> half docked some of the background still shows. So the flow would be
> the user can interact with the canvas while the panel is half docked,
> doing so puts the canvas back into focus (undarknes it/removes the
> filter) and docks the panel to a third secret position - a position
> that fills only like 30% of the screen, the panel snaps into the
> secret third low docked position automatically when the user tried to
> interact with the canvas while the panel is half docked, doing so
> should dock the panel temporary for ~3 seconds with a retriggrable
> delay every time the user retouched the screen"

## 0. The verdict on ask #3 (why YES — no significant rework)

The duck is **native-sheet-only**. The SPA's own panel screens
(gesture.js) keep their two docks untouched — zero web-panel surgery.
The only SPA-side need is the *canvas focus* half of the spec, and the
"filter" the user sees over the canvas is the SPA's own `#chat-scrim`
(the chat panel's dim, `rgba(--bg-panel-rgb, 0.4)`), **not** anything
the native sheet draws (the v0.64 scrim never had a background — it was
an invisible tap-catcher). So the interplay is one tiny channel:

```
press on the app behind the half-docked sheet
  └─ MainActivity's SPA-WebView touch listener (returns false — the
     touch ALWAYS flows on into the SPA, so the canvas pans immediately)
      └─ PanelBrowserSheet.onSpaTouch() → duckForCanvas()
          ├─ the sheet glides 62% → the SECRET 30% dock
          ├─ notifyState {open, ducked} → spaEval →
          │    window.__doomalayPanelState (browserdock.js)
          │      ├─ scrim pointer-events:none (taps reach the canvas)
          │      └─ ducked ⇒ scrim opacity 0 (the dim lifts — the
          │           0.25s CSS transition rides the sheet's glide)
          └─ a 3s retriggerable hold — every retouch (canvas OR the
             ducked panel itself) resets it; expiry glides the sheet
             back to 62% and restores the dim
```

The old scrim-tap-dismisses behavior is RETIRED with the scrim view
itself (a canvas press is now a duck, per spec — dismiss stays ✕ /
drag-fling / Android back). The full dock never ducks (no canvas is
visible to press). A manual strip drag cancels the duck — the hand
takes the sheet and `release()` decides the landing.

## 1. The pill polish (the strip, natively)

One family, four chips, all theme-snapshot-driven:

- **the four pills** — `[↻ url]` + `‹` `⧉` `✕` share the same surface
  fill + 1dp theme border + full rounding (the acts become 34dp
  CIRCLES, radius 17dp; the URL pill keeps its capsule; the stray
  0.92 alpha is dropped so all four read identically).
- **feedback** — every chip gets a `RippleDrawable` (accent @ ~26%,
  transparent when disabled — the back pill's empty-history state),
  clipped to its own shape via the mask; the ↻ glyph gains a
  transparent-content circular ripple of its own.
- **the spin** — while a page loads, the ↻ icon rotates (a linear
  infinite ObjectAnimator); it stops on `onPageCommitVisible`.
- **definition** — a 1dp hairline (border @ ~32%) under the strip
  separates the chrome from the page; the dash widens 36→40dp.

## 2. The loading overlay (instead of the black screen)

The 2dp top loadbar is RETIRED. In its place, a full-body overlay
(above the WebView, inside the sheet) while a page loads:

- **the ring** — a hand-drawn `LoadRing` (a `View.onDraw` arc): a full
  circle track (border @ ~18%) + a 96° accent arc with round caps,
  rotating on a linear infinite animator. Theme colors only.
- **the link text** — the loading URL, 13sp, text3, middle-ellipsized,
  capped at 280dp, centered under the ring.
- **the timing** — `onPageStarted` shows (110ms fade-in),
  `onPageCommitVisible` hides (160ms fade-out — the FIRST PAINT, so a
  rendered page is never covered), `onPageFinished` is the safety net.
  A sequence token kills the hide/show race on fast redirects.
- The overlay never consumes touches — the strip (the drag surface)
  lives outside the body, and taps on a half-painted page pass through.

## 3. The geometry (three docks now)

| dock | fraction | offset (px pushed down) | reached by |
|------|----------|-------------------------|-----------|
| full | 1.00 | 0 | fling/drag up, resume |
| default | 0.62 | 0.38·H | open, undock |
| **the secret** | **0.30** | **0.70·H** | a canvas press at default |

`DUCK_HOLD_MS = 3000`. The duck never crosses into `release()`'s
jurisdiction — dragging from the duck offset walks the same
gesture.js-parity decision table (a 0.32·H deliberate drag from ANY
offset closes, a fling down closes, up goes full/default).

## 4. Surfaces touched

- `PanelBrowserSheet.kt` — pills, ring, duck, scrim retirement,
  animator-race fix (`animateTo` now cancels the prior glide — also
  fixes the pre-existing close-then-reopen-in-200ms GONE race).
- `MainActivity.kt` — the SPA touch listener + `spaEval`.
- `browserdock.js` — `window.__doomalayPanelState` (the scrim
  interplay, ~25 lines; also dispatches `doomalay:panel-state`).
- Zero changes: gesture.js, panel.js, app.js, the engine, the bridge
  contract (openPanel/panelOpen/panelUrl/panelClose all verbatim).

## 5. Tests

`scripts/v0642-panel-polish-test.sh` — the live-engine red team:
the panelState channel (pointer-events suspension, the dim lift, the
restore, `elementFromPoint` proving the canvas is the hit target while
suspended), the event, the v0.64 routing spot-checks, the static
Kotlin audit (constants, wiring, retirements, theme discipline — the
Kotlin compiles in CI, blind locally), zero console errors. Plus the
full regression battery: v0640 56/56, v0621, v0623, v0624, uikit,
theme, `go test`.
