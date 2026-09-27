# PLAN-V0640 — THE NATIVE PANEL BROWSER

> USER SPEC (final word on the panel browser): "The panel browser feature
> is meant for apk and phones only. For desktops, we should not hesitate
> to redirect users. If we can somehow render the native WebView into a
> scrollable snapable panel, a feature or push that is solely reserved
> for the APK versions and other versions that support it.. let's do so
> it's worth it.. even if only the APK can display the panel browser and
> all other applications render the browser in browser. While the app as
> a whole should work across multiple devices with the same
> functionality, we can make an exception to this specifically. As it is
> so much easier to be redirected in desktops then it is on phones."

## 0. THE VERDICT (why YES)

The v0.63.4–63.6 panel browser rendered pages in an **`<iframe>`** inside
the SPA. X-Frame-Options / CSP frame-ancestors — anti-clickjacking
response headers enforced by the browser engine itself on **iframes** —
made most big sites refuse. No amount of JS, probing or proxying makes a
third party drop their frame guards (v0.63.6's auto-route was the best an
iframe could ever do: hand the link to the full-screen viewer).

The browser-in-browser (ViewerActivity) loads **every** page because it
is a **native WebView — a top-level browsing context**. Those headers
only govern iframes; a top-level WebView ignores them entirely.

**So the panel browser becomes the same native WebView — docked as a
native bottom sheet INSIDE MainActivity, over the untouched SPA.** Same
engine as the full-screen browser-in-browser ⇒ it loads exactly as many
pages, by construction. No iframes. No embeddability detection. No
verdict round-trip on the open path.

This is feasible *now* because the user lifted the two constraints that
killed the v0.63.6 exploration of the same idea:

1. "no desktop story" → desktop no longer gets a panel browser at all
   (redirect, no hesitation — desktops have real windows already);
2. "per-frame cross-world sync" → the sheet is NOT synced to the DOM
   panel; it is its own native surface with its own native gestures.

## 1. THE ARCHITECTURE

```
APK (MainActivity)                        every other surface
┌───────────────────────────────┐         ┌─────────────────────────┐
│ main WebView (the SPA)        │         │ desktop browser / HF    │
│  ┌─────────────────────────┐  │         │ Space / self-host /     │
│  │ PanelBrowserSheet       │  │         │ phone browser / pre-64  │
│  │  ┌───────────────────┐  │  │         │ APK                     │
│  │  │ strip: [↻ url]——‹⧉✕│  │  │         │                         │
│  │  │ WebView (TOP-LEVEL)│  │  │         │   link tap → fallback() │
│  │  └───────────────────┘  │  │         │   (popup → tab — the    │
│  └─────────────────────────┘  │         │    v0.62.3 tiers)       │
└───────────────────────────────┘         └─────────────────────────┘
```

- The SPA never navigates and never learns about the page — it just
  calls `__doomalayKotlin.openPanel(url, {theme})` and the native sheet
  docks over it. Closing restores the app exactly as left (resumable:
  the sheet's WebView survives closes — history + cookies persist).
- **Capability routing lives in ONE place** (browserdock.js `open()`):
  `openPanel` on the bridge ⇒ native panel; otherwise ⇒ `fallback()`.
  A feature that only drops where it's supported — old APKs, desktop,
  HF Space, self-host all degrade to the browser-in-browser untouched.

## 2. PanelBrowserSheet.kt (the native sheet)

- **Views** — pure framework, zero new dependencies (no material):
  overlay `FrameLayout` (added via `addContentView`, GONE while closed)
  → scrim (tap = dismiss) + sheet `LinearLayout`
  (top-rounded 16dp, `clipToOutline`) → strip + loadbar + WebView.
- **The strip** mirrors the v0.63.4 spec natively: `[↻ url-pill] —— [‹][⧉][✕]`
  — pill = surface @0.92 alpha, 1dp border, fully rounded; tap = COPY the
  link (ClipboardManager + toast); ↻ reloads; ‹ walks the WebView's own
  history; ⧉ box+arrow leaves the app (ACTION_VIEW → Custom Tab →
  browser); ✕ dismisses; the dash stays dead-center (1fr·auto·1fr).
- **Snap geometry — gesture.js parity, ported 1:1**:
  `default = 0.62·H`, `full = 1.0·H` (H = content height below the
  status bar), and `decide(vy, dy)` VERBATIM: FLING_VY 0.55 px/ms,
  DOCK_VY 0.18, UP_DRAG_FRAC 0.22, FULL_DOCK_FRAC 0.10, FULL_CLOSE_FRAC
  0.55, CLOSE_FRAC 0.32, PROJECTION_MS 140 velocity projection. Drag the
  strip; release snaps; fling down from half dismisses; scrim dismisses.
- **The WebView** = the ViewerActivity engine: JS + DOM storage, zoom,
  the app-global cookie profile (logins shared with the main WebView),
  `shouldOverrideUrlLoading` handleNav (http/https in place ·
  `doomalay://` → dismiss + visibilitychange into the SPA · other
  schemes → ACTION_VIEW), WebChromeClient video fullscreen
  (onShowCustomView covers the activity), DownloadListener for files
  (PDFs etc. → system handlers, same as the export path).
- **Back** (native, BEFORE the SPA is ever consulted):
  video fullscreen → exit; `canGoBack()` → goBack; else dismiss.
- **Theme** — the CSS-var snapshot arrives on every `openPanel` (nothing
  hardcoded): pill/strip/scrim/WebView backgrounds, border, icon + URL
  tints, dash, loadbar accent. System theme attrs are the fallback.

## 3. browserdock.js v0.64.0 — THE ROUTER (InAppBrowser v3)

- `open(url, {purpose:'getkey'|hostile})` → `fallback()` **sync** — the
  v0.62.3 contract (key consoles ride the full-screen viewer) unchanged.
- `open(url)` + `__doomalayKotlin.openPanel` → the native panel
  (`openPanel(url, {theme: snapshot()})`), returns `'native-panel'`.
- `open(url)` everywhere else → `fallback()` immediately — the desktop
  "do not hesitate" redirect. The iframe dock, the verdict fetch, the
  auto-route and the bust-guard are RETIRED with it (no iframe exists).
- `external()` verbatim (⧉ semantics). `isOpen()/currentURL()/close()`
  consult the bridge getters (`panelOpen/panelUrl/panelClose`) — the
  native sheet owns the state.
- Dead code swept: `#pb-*` DOM + CSS, `.panel-browser` rules, panel.js
  `_setStripMode`, app.js' InAppBrowser block in `handleBack` (native
  consumes Android back before the SPA is consulted).

## 4. TESTS

- NEW `scripts/v0640-native-panel-test.sh`: the desktop redirect (no
  dock, popup tier, no lv-card), the native-panel contract (openPanel
  payload = url + live theme; no iframe ever; bridge getters wired),
  getkey/hostile sync tiers, the pre-v0.64 APK bridge (openInApp only),
  the bridge-hiccup fallback, external(), formatter↗, theme discipline,
  panel sanity for ordinary views, zero console errors.
- RETIRED: v0634 / v0635 / v0636 (their premise — the iframe dock — is
  gone; their surviving contracts live on in v0640).
- Regressions: v0621 (YT), v0623 (embed browser), v0624 (screenshots),
  uikit, theme twins, `go test ./...`.

## 5. RELEASE

One feature commit, tag `v0.64.0-native-panel-browser` — CI stamps the
APK, builds desktop + HF Space, publishes the release.
