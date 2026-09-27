# PLAN — v0.63.4 THE PANEL BROWSER (the docked browser-in-browser)

USER SPEC (v0.63.4, verbatim intent):

  "Can we have the browser in browser be displayed in the panel container.
   Meaning instead of the full screen thing, we have the BROWSER IN BROWSER
   itself be in the PANEL! so that the user can DOCK the browser itself and
   move it between the full and half screen position. Since our panel is
   like an iphone screen with a dash in the middle. Let's have the link be
   left of the dash, it's text embedded into a pill box that is slightly
   opaque, rounded, and uses theme colors. Clicking that pill box should
   copy the link. Inside the pill box left of the link add the refresh icon
   to refresh the page. Right of the dash we can have three small icons,
   one for the back tab, one to go to the redirect the user to the website
   app (please also change it's icon to be a clear box and arrow like
   YouTube) and then finally the X."

## The design

The E2 full-screen tiers (ViewerActivity APK / desktop popup) become the
FALLBACK. The primary browsing surface is THE DOCK: a view on the master
panel (panel.js pushView) so every battle-tested gesture still applies —
drag the strip to dock full/half, fling down closes, scrim closes, the
chat root is stashed + restored untouched underneath.

THE STRIP (the handle bar, grid 1fr auto 1fr — the dash stays dead
center in every mode):

      [ (↻) https://example.com/path… ]      ——      [ ‹ ] [ ⧉ ] [ ✕ ]
       left zone: the URL pill                dash    right zone: 3 acts

  · the pill — a <button>, slightly opaque (rgba surface), fully
    rounded, border + text from theme vars. Tapping it COPIES the full
    URL (clipboard API → execCommand fallback → toast "link copied").
  · ↻ INSIDE the pill, left of the text — its own button (stopProp):
    re-points the iframe at the pill's URL (see the cross-origin note).
  · ‹ — back through OUR navigation stack (the URLs opened through the
    app). WEB-VERIFIED: cross-origin contentWindow.history.back() throws
    SecurityError — the parent can never drive a foreign iframe's
    history, and internal link-clicks inside the iframe are invisible to
    us. The honest ceiling for an iframe browser — the native viewer
    (real WebView history) covers the rest.
  · ⧉ — THE BOX+ARROW (Lucide external-link, the YouTube "open in app"
    shape): leaves the app entirely — bridge openExternal() → ACTION_VIEW
    (the site's native app claims its domain) → Chrome Custom Tab →
    system browser; desktop: a plain new tab.
  · ✕ — pops the dock view (the chat root restores beneath).

While docked: .panel-browser on #chat-panel hides the panel header (the
strip IS the chrome — no duplicated title bar), .panel-body.pb-mode goes
edge-to-edge (padding 0, overflow hidden) and hosts .pb-root: a thin
accent loadbar until iframe onload, then the page. gesture.js grows a
remeasure() so the visible-window math re-runs when the strip grows.

## The routing (InAppBrowser v2 — window.InAppBrowser)

  open(url, opts)
    ├─ purpose:'getkey' | hostile → fallback() SYNC (the E2 tiers,
    │   unchanged — key consoles are frame-blocked by design; the
    │   v0623 contract stays green)
    └─ else → THE DOCK (progressive):
        1. dock view + strip chrome + loadbar IMMEDIATELY
        2. parallel GET /api/preview (1h-cached; the lv-card usually
           primed it) — optimistic iframe for html/pdf meanwhile
        3. verdict: youtube → iframe = embed URL (pill/copy keep the
           ORIGINAL link) · frameable html → as loaded · blocked /
           login_redirect → the dock swaps to the og/screenshot card
           with a ⤢ open button (→ fallback tiers); fetch failed → keep
           the optimistic load
  fallback(url, opts) — bridge hostile?CustomTab:ViewerActivity →
    popup 760×900 → tab (v0.62.3 verbatim)
  external(url) — box+arrow semantics (above)
  back()/canBack()/close()/isOpen()/currentURL() — dock controls for
    Android back (app.js pops dock-internal back FIRST) + the tests

LV-CARDS: blocked cards' open button still rides fallback() directly
(one tap to the full viewer — no two-tap regression); frameable-html and
pdf cards GAIN a ⤢ open button (the 16:10 inline crop was the only view
before). The dock's open icon language: ⤢ maximize = "bigger, still in
the app" · ⧉ box+arrow = "leave to the real browser / the site's app"
(ViewerActivity's Custom-Tab button swaps ⤢→⧉ to match — the user's
icon complaint: ⤢ read as fullscreen but actually left the app).

## Files

  web/index.html       strip skeleton + .pb-* CSS (theme vars ONLY) +
                       .panel-browser / .panel-body.pb-mode / toast
  web/browserdock.js   NEW — InAppBrowser v2 + the dock lifecycle
  web/linkviewer.js    InAppBrowser moved out; ⤢ buttons; dock opens
  web/gesture.js       anchorAPI.remeasure()
  web/app.js           Android back: dock-internal back first
  MainActivity.kt      bridge openExternal(url)
  ViewerActivity.kt    ⧉ vector drawable (ic_external_link.xml)
  scripts/v0634-panel-browser-test.sh   the red team

No engine/Go changes — /api/preview already returns the full verdict
(frameable, login_redirect, embed, screenshot_url, …).
