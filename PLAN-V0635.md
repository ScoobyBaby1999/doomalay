# PLAN-V0635 — THE LINK OPENS THE PANEL (the browser IS a panel screen)

## The user's clarification (this session, verbatim intent)

> "the browser in browser does not seem embedded or displayed in the panel yet…
> currently we have 2 screens. The panel and the overlay screen. The panel is
> the one that slides between two fixed positions… the overlay screen in the
> GUI that we use with a hardcoded right aligned X… can we change the
> appearance of the Fullscreen browser in browser so that it appears to render
> as the panel or embedded into the panel. So the user doesn't have to deal
> with a new screen. Opening a link would display it on the panel, so the user
> may have a link open with the panel sitting at half position, see the app
> canvas in the background, whilst browsing the browser in browser on the half
> docked panel… I just want the browser in browser to be a panel screen aswell.
> 2. Moreover, I asked for the refresh button (in the browser in browser
> header) to be left of the link, and for the link text to be in an opaque pill
> that follows themes.
> One more thing, the self host category when pressing connect workspace
> overlay screen doesn't glow in the theme color when selected"

## Hypothesis → Research (what actually happened)

v0.63.4 shipped the docked panel browser (browserdock.js + the strip) and CI
is GREEN (APK + Desktop x3 + HF Space; the user downloaded app-debug.apk).
The user still saw "its own new screen" because the dock was UNREACHABLE on
the primary path:

1. A link tap opens the INLINE lv-card preview (linkviewer.js openCard) — a
   transcript card, NOT the panel screen the user described.
2. On that card, "open" for a frame-BLOCKED page (most big sites) calls
   fallback() DIRECTLY → the full-screen ViewerActivity (APK: a separate
   Activity, ✕ far right — "the overlay screen… hardcoded right aligned X")
   or a desktop popup. The dock only appears for frameable pages, one extra
   tap away (⤢).
3. On the APK, ANY navigation the web layer misses is intercepted NATIVELY
   (MainActivity.handleUrl → openInViewer) → always the full-screen viewer.

The strip the user asked for (↻ INSIDE the pill, left of the link; pill
slightly-opaque + rounded + theme vars; ‹ ⧉ ✕ right of the dash) already
exists in v0.63.4 — the user never reached it.

## The plan (build)

**A. linkviewer.js — THE TAP IS THE OPEN.** The document-level delegate now
calls InAppBrowser.open(href) directly: every external link tap docks the
PANEL BROWSER as a panel screen (the chat root stashes + restores via the
view stack). openCard/_paint stay exported (tests + the degenerate
no-InAppBrowser path).

**B. browserdock.js — frame hardening + loop guard.**
- mountFrame: `sandbox="allow-scripts allow-forms allow-popups
  allow-popups-to-escape-sandbox allow-same-origin allow-presentation"` on
  html/youtube frames — identical behavior to a plain iframe EXCEPT the page
  can never navigate the TOP window (frame-buster JS dies on every platform;
  the desktop SPA can no longer be navigated away). PDFs keep the plain
  frame (Chrome's built-in PDF viewer).
- open(): the same-URL rapid-reopen guard — a frame-buster that somehow
  reaches the native layer (window.open in single-window mode) routes back
  through open(); two re-opens of the same URL inside 1.5s = treat as
  blocked (og-card), never a reload loop.
- renderMedia: the docked image taps into MediaZoom (the pinch-zoom
  overlay) — the v0.62.1 zoom survives inside the panel browser.

**C. formatter.js — the explicit leave-the-app affordances ride external().**
The YT card's ↗ and MediaZoom's open button are "leave the app" actions →
InAppBrowser.external() (the box+arrow semantics: site's native app →
Custom Tab → browser), not window.open.

**D. MainActivity.kt — the native layer defers to the panel.** handleUrl
now evaluates `InAppBrowser.open(url)` in the main WebView first (the dock
docks on the panel); only a dead JS layer (null/undefined result) opens the
full-screen ViewerActivity directly. window.open/target=_blank/missed
clicks now land on the panel too.

**E. workspace.js — the self-host pill GLOWS in the theme color.** Self-host
gets the primary accent (--accent-rgb/--accent) for its selected glow + the
data-prov="selfhost" scope re-points the section surfaces to the theme
color. The no-glow neutral CSS is retired.

**F. NOT changing (scope discipline):** the getkey/hostile synchronous
tiers (the E2 contract — key consoles are frame-blocked BY DESIGN and must
render in the real WebView); the ViewerActivity itself (the fallback tier
for blocked pages' "open"); YT in-place cards (formatter intercepts before
the delegate).

## Test (red team)

New scripts/v0635-panel-screen-test.sh (fork of v0634, rewritten for the
direct-dock contract) + the regressions updated where they tapped links
expecting cards (they now drive LinkViewer.openCard explicitly for card
coverage, and the dock for the flow):
- tap a link → THE DOCK on the panel (no lv-card in the transcript), strip
  chrome on, header yields, pill = the link, iframe loading
- strip geometry (pill LEFT / dash center / acts RIGHT) + remeasure
- pill copy + toast; ↻ rebuilds; ‹ stack; ✕ / Escape restore the chat
- blocked page → the og-card IN THE PANEL + ⤢ → fallback tiers
- sandbox attr present (html/yt), absent (pdf); bust-guard fires
- getkey/hostile still synchronous (the v0.62.3 contract)
- YT fmt-card regression (in-place play, ↗ = external)
- self-host pill: computed glow uses the accent rgb
- theme discipline (.pb-* / .lv-* / .wsp-pill hardcode nothing)
- drag full ⇄ half with the dock alive

Suites: v0635 + v0621/v0623/v0624 (updated) + uikit + theme + go test ./...

## Ship

Rebase → push → tag v0.63.5-link-opens-panel → GitHub release (CI: APK +
Desktop x3 + HF Space) → worklog + MEMORY.md.
