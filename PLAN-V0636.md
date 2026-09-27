# PLAN-V0636 — THE FULL PANEL + THE AUTO-ROUTE

The user's report (two defects, one architecture ask):

> "the panel currently only renders like 20% of the space and the rest is a
> black space. If u can please fix that so the embedding fits the entire panel
> not the top 20% only. Moreover, idk why our browser in browser (the old full
> screen one) can open and display any link while the panel browser can't
> embed most links… let's detect if the page can be displayed or not in our
> panel browser and automatically display pages that cannot be displayed in
> the panel browser in the browser in browser, so that way, panel browser only
> even opens when the website it displays can be displayed. Otherwise the
> browser in browser is displayed."

## Defect 1 — the 20% panel (a one-character class typo)

`#chat-panel .panel-body.pb-mode` never matched ANYTHING: panel.js adds
`pv-mode` (v0.27, every view) — `pb-mode` is a class no code ever adds. The
browser-mode rules (padding:0, overflow:hidden, the flex column) never lit,
so `.pb-root` sat in a plain block body, its `flex:1 1 auto` was inert, and
the iframe rode its ~150px intrinsic height: the page filled the top ~20% of
the panel and dead space took the rest.

**Fix (index.html):** scope the rule to `#chat-panel.panel-browser .panel-body`
— the class panel.js toggles exactly while the dock view is top. The chain
body(flex col, definite --panel-vis-h) → .pb-root(flex:1) → .pb-frame(flex:1)
now stretches the page across the whole visible window at BOTH dock
positions. Red-team asserts pad 0 / overflow hidden / display flex / ≥95%
fill at half AND full.

## Defect 2 — why the panel browser can't embed most links (the honest answer)

The panel browser renders pages in an `<iframe>` — the only way to embed a
foreign document in DOM. The big sites (Google, X, Instagram, GitHub, most
banks…) ship anti-clickjacking headers — `X-Frame-Options: DENY/SAMEORIGIN`,
`CSP frame-ancestors` — that instruct the ENGINE itself to refuse iframe
rendering. No client-side JS can bypass that; it is enforced below the page.

The old full-screen browser-in-browser is a NATIVE WebView
(ViewerActivity / desktop popup) — a TOP-LEVEL browsing context. Those
headers only restrict EMBEDDING, so every page loads. That is the whole
difference — not a bug in the dock, a different security context.

Could the panel browser "act like" the native one? Only by overlaying a
second native WebView on the panel's animated DOM rect — per-frame rect
sync across two rendering worlds, z-order fights with the strip/scrim, and
it can never work on desktop/web at all. Rejected: the user's own
alternative is strictly better.

## THE AUTO-ROUTE (the user's spec, verbatim behavior)

`open(url)` keeps the optimistic dock (zero added latency for displayable
pages) and the parallel `/api/preview` verdict:

- **frameable** → the dock shows it (now filling the whole panel).
- **youtube** → the nocookie embed rewrite (unchanged).
- **media / pdf** → native tags / plain frame (unchanged).
- **frame-blocked or login-walled** → v0.63.6: the dock hands the URL
  STRAIGHT to the full-screen browser-in-browser (`fallbackTier`) and
  closes itself — no blocked card, no dead iframe. THE PANEL BROWSER ONLY
  EVER OPENS FOR PAGES IT CAN DISPLAY.
  - APK: the bridge always fires — the seamless path.
  - Desktop: an async `window.open` can be popup-blocked (returns null);
    that rare case keeps the og/screenshot card + ⤢ open (graceful, still
    one tap from a working page).
- **bust-loop guard** (v0.63.5) keeps its CARD, now via `e.busted`: a page
  that ESCAPED the sandbox re-opened us — auto-opening the viewer then
  would be the page's doing, not a user tap. The card's note tells the
  honest story ("this page refuses to stay embedded").

Implementation notes (browserdock.js):

- `fallbackTier()` returns `{tier, ok}` — the auto-route must KNOW a tier
  fired (popup-blocked desktops return ok:false). The public `fallback()`
  keeps its string contract ('apk-viewer'|'popup'|'tab') — the v0.62.3
  E2 contract is untouched.
- `autoRoute(e)` splices the entry, re-renders the page beneath, and pops
  the view when the stack empties; `onMount` self-closes a resurfaced
  empty dock (the verdict may land while the view is covered).

## Red team

`scripts/v0636-autoroute-test.sh` (80 assertions): the tap-is-the-open
contract, THE FRAME FILLS THE PANEL at both dock positions, THE AUTO-ROUTE
(bridge openInApp + the dock closes itself + the panel restores beneath),
the popup-blocked desktop degradation, the bust guard stays a card and
NEVER calls the tiers on its own, strip/pill/copy/refresh/back/✕/Escape,
sandbox + pdf, getkey/hostile sync, YT in place, self-host glow, theme
discipline, drag full ⇄ half.

Headless lesson (both suites): once the frame FILLS the panel, a CDP mouse
drag-down lands every pointermove over the cross-origin iframe — headless
routes them to the iframe's process and gesture.js never sees them (the
up-drag survives only because its pointer stays inside the strip). Real
devices are unaffected — touch events never retarget, real mice capture in
the browser process. The suites drive the down-drag with synthetic
PointerEvents on `#panel-handle`: the same begin()/move()/end() path, no
input-routing artifact.

Suites: v0636 80/0 · v0634 53/0 (sections 1/8/10/K3 + drag updated to the
current contract) · v0623 15/0 · v0621 19/0 · v0624 13/0 · go test ./internal/server ok.
