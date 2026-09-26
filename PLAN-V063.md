# PLAN-V063 — One GitHub App + the in-app everything (browser-in-browser)

The user's directive (2026-09-26, this session): *"I enabled device flow, try
the GitHub app flow now. Remove the old integration of the GitHub flow and
let's only have this new better one. And implement a browser-in-browser (or
something similar) — load any page, press any link, play a YouTube video and
stay in the app, PiP if not fullscreen. Open-source libraries welcome
(MIT/CC/Apache)."*

Methodology (MEMORY.md golden rule): hypothesis → live probe + web research
→ real plan → build per phase → red-team as a real user → release per phase.

---

## 0. The live evidence gathered BEFORE this plan

- **PROBED (live)**: `POST github.com/login/device/code` with
  `client_id=Iv23liDzVTw7zphxo5Hv` now returns a **user_code**
  (`6A44-A5EB`, expires 899s, interval 5) — the owner ENABLED Device Flow on
  the one-press app. The v0.58 device app (`Iv23li3qm665pDrDO1Nh`) is
  obsolete: both flows can ride the ONE app.
- **Web research (this session)**:
  - Document Picture-in-Picture: **desktop Chrome only — NOT in Android
    WebView** (no support announcements; Chromium source gates it). On the
    APK, "PiP if not fullscreen" = WebChromeClient `onShowCustomView`
    fullscreen (the confirmed pattern; Android API docs verify
    onShowCustomView/onHideCustomView) — system PiP stays a stretch.
  - Google blocks consent screens in embedded WebViews
    (`disallowed_useragent` — confirmed) → Google-gated key pages
    (aistudio.google.com) must hand off to a **Chrome Custom Tab**
    (androidx.browser, Apache-2.0) which rides the user's Chrome session.
  - OSS "in-app browser" libraries: only unmaintained samples / heavyweight
    multiplatform frameworks. **Plain WebView + our toolbar (~200 lines
    Kotlin) + androidx.browser is the better choice** — fewer deps, full
    theme control. No new web-side library (YT IFrame needs none).
- **Repo recon**: releases build APK + desktop binaries via GitHub Actions
  on tag push (no local Android SDK needed). The JS-bridge pattern exists
  (`__doomalayKotlin` @JavascriptInterface + `window.doomalay.*`), the
  back-gesture asks the SPA first (`window.doomalay.handleBack`), MediaZoom
  (fullscreen image overlay) is exposed by formatter.js for reuse, external
  main-frame nav currently leaves the app (`handleUrl` → ACTION_VIEW), and
  chat links render via formatter.js `.fmt-link` anchors.

---

## Phase G — v0.61.3-gh-one-app: ONE GitHub App, both flows

The owner enabled Device Flow on the one-press app (probed live above), so
the v0.61.2 two-app split (one-press app + device app) is retired.

1. `workspaces.go`: DELETE `ghDeviceDefaultClientID` and the
   `ghDeviceClientID()` resolver — `handleGHDeviceStart` now uses
   `ghOAuthCreds()`'s id directly (env → vault → the ONE shipped app). The
   device flow becomes secretless-only against the same app id (no secret in
   the device POST — unchanged).
2. Comments updated: the ONE app carries loopback callback URLs, Device Flow
   ☑ (probed live 2026-09-26), Expire tokens ☐. Custom env/vault installs
   keep overriding both flows with their own app (unchanged semantics).
3. `oauth_test.go`: `TestGHDeviceRidesDeviceApp` (pinned the split) →
   replaced by a test pinning the ONE-app behavior (device start uses the
   same resolver as the web flow; no second app constant exists).
4. Docs: `GITHUB_APP_SETUP.md` armed-state section rewritten (one app, both
   flows; the v0.58 app may be deleted on GitHub's side);
   `HF_CAPABILITY_MATRIX.md` line 281 note updated; `ghbroker.go` comment
   referencing the old app id updated.
5. Red team (adapt scripts/v0612-gh-armed-test.sh → v0613): boot with NO
   env → status armed on the one app; device start mints a LIVE user_code on
   the SAME app id (the actual new-app probe, not the old one); the
   one-press authorize URL still carries PKCE S256; the done-page popup
   path still paints.
6. Release `v0.61.3-gh-one-app` (fetch/rebase first per protocol).

## Phase E1 — v0.62.1-embed-yt: link cards + YouTube + PiP (T1)

Zero new dependencies. Works on every install including Android (same web
UI inside the APK WebView).

1. **Engine** — NEW `engine/internal/server/linkpreview.go`
   (`GET /api/preview?url=…`, registered in server.go):
   - classify by extension + Content-Type: `image|video|audio|pdf|html`;
   - YouTube: watch/youtu.be/m.youtube/shorts/clip + `t=` timestamps →
     `{type:"youtube", embed:"youtube-nocookie.com/embed/ID", thumb:
     "i.ytimg.com/vi/ID/maxresdefault.jpg"}` — pure URL parse, NO fetch;
   - HTML: server-side fetch (netx transport, 10s budget, 1MB cap, HEAD
     first then GET) → extract `<title>`, favicon, `og:title/description/
     image` → the link-card metadata;
   - `frameable` verdict: response `x-frame-options` + CSP
     `frame-ancestors` parsed (CSP wins when both) — the probe logic
     productized; negative verdicts cached per-origin 1h, metadata per-URL
     1h (small map + mutex + janitor sweep, same style as oauthStates);
   - SSRF guard: only http/https, no localhost/private-IP targets
     (the engine is local-first; a preview fetch must never loop back).
2. **Web** — NEW `linkviewer.js` (loaded in index.html after formatter.js):
   - `LinkViewer.attach(root)` — delegate handler: every external
     `.fmt-link`/`[data-linkview]` anchor click → preventDefault → the
     card opens INLINE (compact: favicon+title+host + ▶), never leaves;
   - expanded: YouTube → lazy 16:9 `youtube-nocookie` iframe + **PiP button**
     (`documentPictureInPicture.requestWindow` feature-detected, desktop
     Chrome/Edge; hides when absent; classic video PiP fallback for direct
     video files); image → inline + MediaZoom on tap; audio/video → native
     tags; PDF → iframe; frameable HTML → sandboxed lazy iframe; blocked →
     og-card + "open in app ↗" button (APK bridge if present, else popup
     / new tab);
   - theme: every color via CSS vars (`--surface-2`, `--border`,
     `--accent`, `--text-*`) — nothing hardcoded; all UI lives inside chat
     messages (the panel) — no new chrome surfaces.
3. **Chat**: formatter.js already linkifies; linkviewer attaches one global
   delegate on the chat log — bare URLs stay compact until tapped (the
   transcript does not become a gallery unless asked).
4. Tests: Go table tests (classifier, XFO/CSP parser, YT rewrites incl.
   shorts/timestamps, cache TTL, private-IP refusal); linkviewer smoke via
   node; agent-browser red team: a chat message with a YouTube link → the
   card renders and the iframe loads, NO navigation away; a blocked link →
   og-card; an image link → inline + zoom.
5. Release `v0.62.1-embed-yt`.

## Phase E2 — v0.62.2-embed-browser: the browser-in-browser (T2)

The user's headline ask. "Press any link and stay in the app."

1. **Web** — `linkviewer.js` grows `InAppBrowser.open(url, meta)`:
   - APK (bridge present): `window.__doomalayKotlin.openInApp(url, theme)`
     — Kotlin opens the viewer (below);
   - desktop/popup-capable: `window.open(url, '_blank', 'width=760,
     height=900')` popup — the app window stays on screen (the paste box
     stays visible — the v0.60 OAuth pattern applied to key pages);
   - gateway/popup-blocked: new tab (the honest ceiling there).
   The blocked-link card's "open in app" button + providers.js
   `Get API key` links both call this instead of `openInSystemBrowser`.
2. **APK** — `platforms/android/.../ViewerActivity.kt` (NEW):
   - a second full-screen WebView: JS + DOM storage + cookies ON
     (CookieManager flush + the SAME profile → logins persist across
     opens); our own themed toolbar (back ‹ · reload ↻ · open-in-browser ⤢
     · close ✕) — colors passed from the web UI via the bridge call
     (accent/surface/onAccent as a JSON arg), never hardcoded;
   - toolbar ✕ finishes the activity → MainActivity + its WebView were
     NEVER navigated: SPA state, panel, back-gesture stack intact
     (the v0.60 lesson);
   - `WebChromeClient.onShowCustomView/onHideCustomView` — video
     fullscreen (YouTube embeds' □ button now works in-app; this also
     serves the main activity — same client pattern applied there);
   - back gesture: viewer WebView history first, then finish();
   - `webview_hostile` providers (Google-gated: aistudio etc.) never see
     the viewer — the toolbar ⤢ and the auto-handoff use a **Chrome Custom
     Tab** (androidx.browser, Apache-2.0 — added to gradle deps), themed
     with the same accent, riding the user's Chrome session.
3. **APK** — `MainActivity.handleUrl`: main-frame external nav now opens
   the ViewerActivity in-app (NOT the system browser) — every link the
   chat/panels produce stays in the app. (Iframe sub-frames keep loading
   in place — unchanged.)
4. **providers.json**: `webview_hostile: true` flags on the Google-gated
   rows; surfaced through the providers API so the web UI can pre-route
   those to the Custom Tab path.
5. Tests: web side red-teamed with agent-browser (popup opens, blocked-card
   button, providers link wiring, hint copy). Kotlin: careful review + CI
   build as the compile gate (no local SDK; tunnel down — note to the user
   to live-test the APK, list exactly what to try).
6. Release `v0.62.2-embed-browser`.

## Phase E3 — v0.62.3-embed-screenshots: the T3 tier (stretch)

Only if it stays clean (scope discipline): engine chromium detection
(PATH probe at boot → caps), `GET /api/preview/screenshot?url=…&w=&scale=`
(headless-new, 2880×1800 retina, 24h cache dir), card art for blocked
pages on desktop/self-host; APK hides the tier (no CLI chromium). Includes
a live per-binary flag verification pass. **Skip if it smells like
spaghetti** — the user's explicit stop rule.

---

## Verification matrix (per phase)

| Phase | Go tests | JS tests | Live red team (agent-browser) | Release |
|---|---|---|---|---|
| G | one-app pins | uikit/theme suites | device code mints on the ONE app; one-press shape; done page | v0.61.3-gh-one-app |
| E1 | classifier/XFO/YT/cache/SSRF | linkviewer smoke | YT card renders in chat, no nav; blocked → og-card; image zoom | v0.62.1-embed-yt |
| E2 | (none — Kotlin) | wiring checks | popup path, providers link, hint copy | v0.62.2-embed-browser |
| E3 | caps + service | — | screenshot on a public page | v0.62.3-embed-screenshots |
