# PLAN-EMBED-V062 — Display anything in-app: embeds, screenshots, the key flow

The user's directive (2026-09-26): *"research what we can do to either embed
pages or take screenshots and display very high resolution screenshots of
pages and YouTube videos — the goal is to have the app display anything and
embed most things the LLM can fetch and link to, so users are never
redirected away from the app. The get-cloud-API-keys flow must work without
a redirect out of the app — all done through an embedding."*

Methodology (as always): probe live first, read the docs second, design
from evidence. Everything below marked **probed** was measured against the
real endpoints on 2026-09-26 (`scripts/v062_frame_probe.py`, kept for
re-runs).

---

## 1. The empirical base: what can actually be embedded

The browser refuses to render a cross-origin page in an `<iframe>` when the
page's own response headers say so — `x-frame-options: DENY|SAMEORIGIN`
(legacy) or `content-security-policy: frame-ancestors …` (modern, wins when
both are present). **No web-side library can bypass this.** Probing the app's
REAL targets (the `Get API key ↗` links from `engine/internal/llm/catalog/
providers.json`, the token pages, the YouTube surfaces):

| Page | iframe verdict (probed) |
|---|---|
| openrouter.ai/keys | **BLOCKED** (`frame-ancestors 'self'` + XFO SAMEORIGIN) |
| console.anthropic.com/settings/keys | **BLOCKED** (`frame-ancestors 'self'`) |
| api.together.ai/settings/api-keys | **BLOCKED** (`frame-ancestors 'none'`) |
| build.nvidia.com/settings/api-keys | **BLOCKED** (`frame-ancestors 'self' *.nvidia.com *.hcaptcha.com`) |
| portal.privatemode.ai/api-keys | **BLOCKED** (`frame-ancestors 'none'` + XFO DENY) |
| platform.deepseek.com/api_keys | **EMBEDDABLE** (no framing guard!) |
| platform.openai.com, console.groq.com, dash.cloudflare.com | bot-walled to headless probes (403); production sends frame guards — treat as **BLOCKED** |
| github.com/settings/tokens, github.com (any) | **BLOCKED** (`frame-ancestors 'none'`, XFO deny) |
| huggingface.co (+ /settings/tokens, /spaces) | **BLOCKED** (XFO SAMEORIGIN / DENY) |
| arxiv.org | **BLOCKED** (`frame-ancestors 'none'`) |
| **youtube-nocookie.com/embed/ID** | **EMBEDDABLE — by design** |
| **i.ytimg.com/vi/ID/maxresdefault.jpg** | **EMBEDDABLE** |
| example.com (control) | EMBEDDABLE |

**Conclusion 1:** an `<iframe>` embed is a dead end for every API-key
console that matters. These pages are auth-walled and frame-guarded on
purpose. Any design that promises "the keys page in an iframe" lies.

**Conclusion 2:** The frame guards govern **iframes only — NOT top-level
navigation.** The APK's WebView IS a browser: if the WebView itself
navigates to `platform.openai.com/api-keys`, the page renders fully in-app
(no iframe involved). That is the honest "embedding" for key pages on
Android. On desktop, the equivalent is a popup window (the app tab never
navigates — the v0.60 OAuth pattern).

**Conclusion 3:** YouTube is the opposite case — embedding is first-class
(native `/embed/` iframes + `i.ytimg.com` thumbnails, both verified
frame-friendly), needs **no library**, and pairs with the Document
Picture-in-Picture API for the float-over-the-app UX.

---

## 2. The three display tiers (the architecture)

Every link the LLM (or the UI) produces gets classified by the engine and
rendered in the best tier it supports. Never a blank "open in browser ↗"
dead end again:

| Tier | Mechanism | Works for |
|---|---|---|
| **T1 — embed in place** | `<iframe>`/`<img>`/`<video>` inline in the chat/panel | YouTube (embed URL), direct images, direct video/audio, PDFs (browser viewer), frame-guard-free HTML (deepseek!), og:image previews |
| **T2 — render in-app** | APK: in-app browser tab (second WebView, our toolbar) · desktop: popup window | EVERYTHING, including all key consoles (top-level navigation ignores frame guards) |
| **T3 — show, then jump** | high-res screenshot (or preview card: favicon+title+description) + one-tap open (APK: Custom Tab; desktop: popup) | pages that refuse/break in T2 (Google-login walls, bot challenges), fast glanceable previews |

The engine classifies (T1 possible? chromium available for T3?) — the UI
renders — the user never chooses.

---

## 3. The YouTube path (T1 — verified, zero dependencies)

- **Watch URLs → embed URLs**: `youtube.com/watch?v=ID`, `youtu.be/ID`,
  `m.youtube.com`, Shorts, timestamps (`&t=90s` → `?start=90`) all rewrite
  to `https://www.youtube-nocookie.com/embed/ID` (privacy-enhanced domain,
  probed frame-friendly; `youtube.com` main pages are NOT embeddable — the
  rewrite is mandatory, not cosmetic).
- **Player**: plain iframe (16:9, lazy) — the official IFrame Player API
  (developers.google.com/youtube/iframe_api_reference, read) is only needed
  if we later want JS control (queue/volume/events); start without it.
- **Thumbnail**: `i.ytimg.com/vi/ID/maxresdefault.jpg` with
  `hqdefault.jpg` fallback (probed embeddable) — instant poster frames, no
  engine work.
- **Picture-in-Picture** (docs read: developer.chrome.com/docs/
  web-platform/document-picture-in-picture): `documentPictureInPicture.
  requestWindow({width, height})` — user-gesture required — moves ANY
  element (including a YouTube iframe) into an always-on-top window.
  Chrome/Edge 116+, behind the WebView on Android 14+ (verify live in the
  APK; graceful hide when `!('documentPictureInPicture' in window)`).
  Classic `<video>.requestPictureInPicture()` stays the fallback for direct
  video files. No third-party library anywhere — the parked §E conclusion
  (PLAN-AUTH-V060) holds.

---

## 4. The screenshot service (T3 — engine, optional dependency)

**Design:** `GET /api/preview/screenshot?url=…&w=1440&scale=2` → the engine
shells out to a locally-detected Chromium binary:

```
<chromium> --headless=new --screenshot=<tmp>.png \
  --window-size=1440,900 --force-device-scale-factor=2 \
  --hide-scrollbars --virtual-time-budget=8000 --no-sandbox \
  <url>
```

- **Retina-class output**: 1440×900 × scale 2 = a 2880×1800 PNG — "very
  high resolution" as requested; `--virtual-time-budget` waits out JS
  rendering without wall-clock sleeps; `--no-sandbox` only where the
  binary needs it (containerized/self-host).
- **Detection at boot**: PATH probe for `chromium | chromium-browser |
  google-chrome | google-chrome-stable | chrome` → capability reported by
  `/api/preview/caps` (the UI hides the screenshot tier when absent).
  Desktop and self-hosted boxes have it; **Android does NOT** (no CLI
  chromium on a stock device) — the APK's T3 is the preview card + Custom
  Tab instead, and that's fine: on Android, T2 (in-app browser tab)
  covers what screenshots would.
- **Cache**: screenshots land in `<data-dir>/preview-cache/<sha>.png`
  (TTL 24h) and are served with long-lived cache headers — repeat views
  are free.
- **Auth-walled reality**: a headless screenshot of `openrouter.ai/keys`
  shows the LOGIN WALL, not the keys. Screenshots are for PUBLIC pages —
  docs, articles, landing pages, repos (public), search results — exactly
  the "LLM fetched a link, show me what it is" chat case. They do NOT
  replace T2 for the key flow.
- **Hosted screenshot APIs** (screenshotone et al.): viable fallback for
  keyless installs, but they ship the user's links to a third party and
  need an API key — against the app's local-first grain. Deprioritized;
  documented as a self-host option only.
- No Go deps added (stdlib exec.Command; chromedp/go-rod unnecessary for
  single-shot renders).

---

## 5. The get-cloud-API-keys flow in-app (the specific ask)

Current state: `providers.js` `Get API key ↗` = `target="_blank"` +
"Opened X in your browser. Copy your key there, come back, and paste it
above." The APK's `handleUrl` hands external URLs to the system browser —
the user leaves the app completely. What changes:

**Desktop / zai-web gateway:** the link opens a **popup** (window.open,
700×800) instead of a tab — the app window stays visible beside it, the
paste box stays on screen, the existing hint copy becomes accurate
("copy your key in the window beside this one"). Popup-blocked or
gateway-context: same-tab with `?back=` return handled by the SPA landing
listener. Nothing more is possible for frame-guarded pages — and that is
the honest ceiling on the web platform.

**APK (the real fix): an in-app browser tab.** `MainActivity` grows a
second-WebView viewer (bottom-sheet dialog or full-screen activity, our
own toolbar: ← back · ↻ reload · ⤢ open-in-browser · ✕):

1. The web UI calls `window.doomalay.openInApp(url)` (the existing
   JS-bridge pattern; fallback: navigate to
   `http://127.0.0.1:8080/viewer.html?url=…` which the WebView client
   intercepts).
2. Kotlin opens the viewer WebView **main-frame** — top-level navigation,
   so X-Frame-Options does not apply; the key page renders fully in-app;
   logins persist in the WebView profile (cookie manager) across uses.
3. The user copies the key in the viewer, taps ✕ — the paste box is
   exactly where they left it (the main WebView never navigated: SPA
   state, back gesture, panel — all intact; v0.60 lesson applied).
4. **Google-login-gated pages** (aistudio.google.com/apikey etc.) refuse
   WebViews by policy → the toolbar's ⤢ hands the URL to a **Chrome
   Custom Tab** (docs read: developer.chrome.com/docs/android/custom-tabs
   — themable, keeps the app alive behind, rides the user's Chrome
   session: usually ALREADY logged in, often zero extra taps). The
   engine's provider metadata marks `webview_hostile: true` for known
   offenders so the UI goes straight to the Custom Tab.
5. Keyboard-aware paste helper stays (the box + validate button already
   wired via `/api/keys/validate`).

Result: the key flow never lands the user in a naked browser tab; on the
APK it is fully in-app (or a themed Custom Tab for the hostile few).

---

## 6. The Universal Link Viewer (chat + panels, one component)

**Engine:** `GET /api/preview?url=…` — one endpoint, one JSON verdict
(this is my probe script, productized):

- fetches the URL server-side (netx, 10s budget, 1MB cap);
- classifies: `image | video | audio | pdf | html`;
- for HTML: extracts `<title>`, favicon, `og:title/description/image`
  (link-preview metadata);
- reads `x-frame-options` + CSP `frame-ancestors` → `frameable:
  true/false` (the probe logic, cached per-origin, negative-TTL 1h);
- YouTube/Shorts/youtu.be → `{type:"youtube", embed, thumb}` without a
  fetch (URL parse only);
- `screenshot: available|no` (chromium caps) so the UI knows its T3
  options.

**Web (`linkviewer.js`, one shared component):** renders the card + the
tier pick — YouTube → embed iframe + PiP button; image → inline + zoom;
video/audio → native tags; PDF → iframe; frameable HTML → sandboxed lazy
iframe; blocked HTML → og-card (+ screenshot when caps say so) + "open in
app" (APK bridge) / popup (desktop). Used by: chat message links (the
LLM's fetched pages), the model browser's provider rows, the providers
panel, sandbox picker docs.

**Chat UX:** markdown links in assistant messages auto-render as viewer
cards when the model emits bare URLs or explicit links; bare URLs stay
compact (favicon + title + ▶ expand) so transcripts don't turn into
galleries unless asked.

---

## 7. Implementation waves (each = one x.x.1/x.x.2 release, red-teamed)

- **v0.62.1 — link cards + YouTube in chat**: engine `/api/preview`
  (metadata + frameable verdict, NO screenshots yet) + `linkviewer.js` +
  chat link cards + YouTube embed/Shorts/timestamp rewrite + thumbnails +
  PiP (Document PiP + video fallback, feature-detected). The most user
  value, zero new dependencies, works on every install including Android.
- **v0.62.2 — the screenshot tier**: chromium detection + `/api/preview/
  screenshot` + cache + card art for blocked pages (desktop/self-host).
  Includes the live CLI-flag verification pass (the flags above are the
  documented new-headless set; verify per-binary in the red team).
- **v0.62.3 — the in-app key flow**: APK viewer WebView (toolbar, cookie
  persistence, ✕ returns to the intact panel) + `window.doomalay.
  openInApp` bridge + Custom Tab handoff for webview-hostile providers +
  providers.js popup (desktop) + `webview_hostile` provider metadata.
- **v0.62.4 (stretch)** — viewer in model browser/sandbox panels; oEmbed
  for richer cards (YouTube's own oEmbed gives title/author with no key).

## 8. Verification (per wave, the usual loop)

- Go: preview endpoint unit tests (classifier, XFO/CSP parser, YouTube
  rewrites incl. timestamps/shorts, cache TTL, size caps); screenshot
  service guarded behind caps (no chromium → clean 501, UI hides tier).
- JS suites: uikit/theme stay green; new linkviewer self-test.
- Red team (agent-browser, engine on :818x): a chat message with a
  YouTube link renders the embed (no navigation), a blocked link renders
  the og-card, image links inline, the providers-panel link opens a
  popup (desktop path), the APK bridge falls back cleanly in a non-APK
  browser.
- APK: manual/CI pass for the viewer tab (open keys page, login persists,
  back gesture, ✕ intact panel) + Custom Tab handoff for a Google-gated
  provider.
