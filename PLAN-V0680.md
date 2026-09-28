# PLAN-V0680 — THE BROWSER BAR WAVE (all four asks, one native file)

USER SPEC (verbatim anchors):
  1. "Let's make the BIB (browser in browser) and panel have the same dash
     length, let's change the BIB to use the panels dash and length. (Dash
     does not use theme colors I believe)"
  2. "Let's also make the BIB's scrolling (how it detects weather to open
     close, ext, resemble the panels functionality and mimic it if not use
     it outright)"
  3. "Let's also make the BIB search bar (the one with the address of the
     site) 15% less wide and high or 15% smaller in size."
  4. "And if possible and does not require a lot of rework, let's add search
     functionality (browser either Google or something free like brave or
     duckduckgo). So it works like any browser lol."

THE PANEL'S TRUTH (index.html, the reference — UNTOUCHED):
  · .handle-bar: 36×4px, var(--border), radius 2 — the neutral grab hint.
  · gesture.js: the scroll chain (body pull-down at top → sheet grabs after
    24px BODY_SLOP, rebase −6), EMA velocity (0.7/0.3 + the 4ms sub-frame
    floor), jitter smoothing (0.8/frame chase), rubber-band above full
    (×0.25), the settle spring (stiffness 170, critically damped ×1.02,
    quarter-velocity seed, |x|<1.5 && |v|<40 → exact rest), the gesture
    dismiss spring (440, v=max(vy·1000·0.5, 900)), and the 170ms
    cubic-bezier(0.32,0.72,0,1) open/close curve.

## ASK 1 — THE DASH (BIB → the panel's exact dash)
  dash 40→36dp; the color text1@30% → the theme BORDER straight
  (var(--border) parity — a neutral surface token, not the accent).

## ASK 2 — THE SCROLLING (gesture.js, mimicked outright)
  A. THE DRAG MACHINE — one shared state machine for the anchors AND the
     new chain: dragActivate (slop-cross rebase: dragStartY = the CURRENT
     finger, dragStartOffset = the FROZEN offset — kills the mid-glide
     drift jump, gesture.js begin() semantics), dragFollow (EMA velocity,
     rubber-band, the 0.8-smoothed Choreographer chase, snap <0.4px),
     dragEnd (release with the FINGER's dy).
  B. THE BODY CHAIN — DragBodyLayout (the body FrameLayout, inner class):
     onInterceptTouchEvent hijacks a downward page drag (24dp slop) while
     the page sits at its very top (canScrollVertically(-1) == false);
     the WebView's listener releases the parent lock on qualifying MOVEs
     (the classic handoff — the WebView gets a clean ACTION_CANCEL, the
     finger keeps control); single-driver guards; −6dp rebase at hijack;
     overScrollMode NEVER (the glow never fights the chain). The duck
     rules ride along (dragFromDuck captured at the page's DOWN).
  C. THE SPRINGS — springTo (the settle spring, replaces SNAP_MS glides:
     dock-to-dock, duck, unduck, cancelDuck-restore, the release settle —
     quarter-velocity seeded) + dismissSpring (the release-close: 440,
     max(vy·1000·0.5, 900)); the ✕/back dismiss keeps the fixed curve.
  D. THE CURVE — RISE_MS 250→170, CLOSE_MS 200→170, Decelerate(1.2) →
     PathInterpolator(0.32, 0.72, 0, 1) — gesture.js's exact rise.
  E. decide() was already verbatim (v0.64.0) — untouched.

## ASK 3 — THE CAPSULE (15% smaller)
  30→25.5dp tall (dipF), the refresh slot 30×30→25.5×25.5 (the glyph STAYS
  18dp — the hitbox survives above the pre-v0.64.3 24dp), ripple circle
  15→12.75dp, text cap 153→130dp, paddings (5,0,9,0)→(4,0,8,0) and the
  text's (3,0,5,0)→(3,0,4,0). chipShape takes Float radii now.

## ASK 4 — THE SEARCH (works like any browser)
  The capsule grows an EditText (textUri, IME_ACTION_GO + NO_FULLSCREEN,
  single line, 12sp, text3 tint, background null — the chip IS the field):
    · TAP the capsule → enterEdit: duck restores, the sheet glides FULL
      (the bar rides to the top — the keyboard never covers it), the URL
      selected (Chrome omnibox), the IME up.
    · GO → commitEdit: resolveEntry — explicit scheme passes, a dotted/
      coloned spaceless entry → https://, anything else → DuckDuckGo
      (free, keyless, no tracking — the user's "Google or something free
      like Brave or DuckDuckGo"). Stays at full (reading the results).
    · back / focus loss → exitEdit: IME down, the TextView back, the
      cancel glides the sheet to the dock the user came from.
    · LONG-PRESS the capsule → copyLink (the old tap affordance, reborn
      Android-style — manual long-press in makeDraggable: the listener
      consumes, so the system one never fires; slop/UP cancel it).
    · ↻ ‹ ⧉ exit the edit before their act; ✕/open() exit silently;
      handleBack eats the back while editing (keyboard first, browser
      behavior).

## TESTS
  · UPDATE: v0643 (the capsule constants), v0651 (the dismiss line, the
    MOVE branch shape). v0642's anchors survive (verified by grep).
  · NEW: v0680-browser-bar-test.sh — the static audit of the wave (dash
    36+border, the chain constants, the springs, the editor, resolveEntry,
    DDG, zero hex, no scrim) + the web regressions (the SPA never moved).
  · RE-RUN: v0640 v0642 v0643 v0651 v0621 v0623 v0624 uikit theme go-test.

## RELEASE
  One coherent native wave → commit + tag v0.68.0-browser-bar (rebase
  before push; CI's APK build is the compiler of record).
