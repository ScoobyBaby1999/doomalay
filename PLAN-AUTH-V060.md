# PLAN — v0.60: THE AUTH HOME-COMING

The user's verdict: both current auth methods are rejected.
- HF: "redirects the user out the app and doesn't sync or update" — the
  callback lands on a FULL APP instance (localhost:8080 in the external
  browser = "a separate instance of the app"), the panel never updates on
  return, and the back gesture lands on a "hardcoded screen" (the reloaded
  SPA root).
- GitHub: "asks for too much access… we want complete access over one
  repo, not the entire account" + the device-code entry is unwanted.
  Direct order: rip the auth from the old doomalaysocreate space.

## Research findings (live, 2026-09-25/26)

1. **The legacy space's GitHub auth** (legacy-2026-09 branch,
   `github_integration.py` + `critique_service.py`): a classic OAuth App
   whose secret lives in the SPACE's env; `/api/auth/github/login?
   redirect_to=<caller>` → GitHub → space callback → server-side code
   exchange → one-time in-memory GRANT → redirect to the caller with the
   grant → caller claims it. One click, no code entry, works from ANY
   origin because the callback is the space's fixed URL. THE pattern to
   port — with one upgrade: use the GitHub App (Iv23li3qm665pDrDO1Nh)
   instead of a classic OAuth App, so the user selects "Only select
   repositories" at install = complete access over ONE repo, not the
   account.
2. **Embedding (YouTube-style) is a dead end for auth, by design**:
   github.com sends `x-frame-options: deny` + `frame-ancestors 'none'`;
   huggingface.co sends `SAMEORIGIN` (probed live, both). No library can
   remove those headers. The correct pattern — what Google/Microsoft
   native SDKs do — is a POPUP (desktop/PWA) or external browser (the APK
   already routes external URLs there) + an auto-closing DONE PAGE on our
   own origin. YouTube embeds need no library either (native /embed
   iframes are frame-friendly; Document PiP API covers the future
   picture-in-picture).
3. **Why HF needs no code today** (user's question): on-device origins
   are loopback → HF's redirect flow is secretless (public CIMD client +
   PKCE). GitHub's redirect flow always demands a client secret (probed
   v0.56) → that's why GitHub got the device flow. The space-broker
   brings GitHub to 1-click too: the secret lives ONLY in the space.
4. **Android**: external URLs already open in the external browser
   (handleUrl); back = window.doomalay.handleBack() (overlay stack —
   sound). The "separate instance" is the engine callback redirecting to
   `/` (the full app) in the external browser; the "hardcoded screen" is
   the same-tab SPA reload in a browser PWA. Both die with the done page
   + popup.

## Implementation

### A. The done page (engine) — THE return-to-app screen
`oauthDonePage(w, provider, user, errMsg)` — tiny dark HTML served BY the
callback endpoints (no redirect, no app reload):
- `✓ connected to <provider> as <user>` (or the error variant)
- postMessage `{type:'doomalay-auth', provider, user}` to the opener
  (same engine origin — popups keep the opener across the whole redirect
  chain)
- auto `window.close()` after 400ms (popup case)
- a `← return to the app` button → `doomalay://return` deep link (APK
  external-browser case) with a fallback hint ("switch to the Doomalay
  app")
Wired into: `handleHFOAuthCallback`, the self-hosted
`handleGHOAuthCallback`, and the new broker relay below.

### B. HF — stay in the app (web)
- Loopback origin: the connect button opens a POPUP
  (`window.open('/api/hf/oauth/start…')`), never navigating the app tab
  (state preserved — kills the "hardcoded screen"). Popup blocked →
  same-tab fallback (current behavior).
- Non-loopback (gateway/preview): the v0.59 device flow stays.
- BOTH panels get: a `message` listener (popup says connected → repaint +
  toast) and `visibilitychange`/`focus` listeners → re-fetch
  `/api/hf/account` (the APK-return + manual-close sync the user asked
  for — "listeners or something of the sort").

### C. GitHub — the space as OAuth broker (port of the legacy flow)
Space (`scripts/shared_app.py` → doomalaysocreate, public endpoints):
- `GET /gh/oauth/config` → `{configured}` (CORS `*`) — the UI probes this
- `GET /gh/oauth/start?redirect=<engine origin>` → 302 to
  github.com/login/oauth/authorize (client_id + the space callback URL);
  in-memory state {nonce → redirect}, 10-min TTL; 503 with setup
  instructions when GITHUB_CLIENT_SECRET is unset
- `GET /gh/oauth/callback?code&state` → server-side exchange (secret
  never leaves the space) → one-time grant {code → (token, login)},
  5-min TTL → 302 to `<engine>/api/gh/oauth/relay?grant=…`
- `GET /gh/oauth/grants/<code>` → one-time claim `{token, login}`

Engine:
- `GET /api/gh/oauth/broker/start` → 302 to
  `<sharedSpaceBaseURL>/gh/oauth/start?redirect=<schemeHost(r)>`
  (env DOOMALAY_GH_BROKER override)
- `GET /api/gh/oauth/relay?grant=…` → engine claims the grant
  server-to-server (netx) → vault (GITHUB_PAT + login) → done page
- `/api/gh/account` gains `broker_url`

Web (ghconnect.js): the primary button probes the broker config → if
configured: popup to `/api/gh/oauth/broker/start` (1 click on GitHub —
"Install & Authorize" with **Only select repositories** = the repo-level
grant) + message/visibility listeners. Fallback link stays: "use a
one-time code instead" (the v0.55 device flow, verbatim). Copy explains
the repository selection screen.

Security model: the secret lives ONLY in the space env (like the legacy
space); the token crosses the browser ONLY as a one-time unguessable
grant code claimed server-to-server; state nonces are one-shot.

### D. Android
- Manifest: `launchMode="singleTop"` + a `doomalay://` VIEW/BROWSABLE
  intent filter (the done page's return button foregrounds the running
  app; the WebView's visibilitychange then refreshes the panel).
- No WebView routing changes needed (external URLs already leave).

### E. YouTube-in-chat (research only — future feature, no library needed)
youtube.com/embed iframes are frame-friendly by design; Document PiP
(Chrome 116+) pops any element. Documented for the upcoming chatbot
embed feature; not in this wave.

## Verification (the code-check loop)
- Go: done-page contract tests; broker relay round-trip against a mock
  space (grant claim, vault shape, no secret in any browser-facing URL);
  all existing suites green.
- Live red-team (agent-browser): HF popup round trip → done page
  postMessage + auto-close wiring; GH broker → the space's live 503
  (not configured until the user adds the secret) + the fallback device
  flow; listeners repaint the panels on focus.
- CI: APK (deep-link manifest), desktop, HF-space.

## The user's end (after this ships)
1. GitHub App → settings: generate the client secret; add Callback URL
   `https://scoobybaby1999-doomalaysocreate.hf.space/gh/oauth/callback`;
   keep Device Flow checked (fallback) + Administration off.
2. HF Space → Settings → Secrets: `GITHUB_CLIENT_ID=Iv23li3qm665pDrDO1Nh`,
   `GITHUB_CLIENT_SECRET=<the secret>`.
3. Deploy the updated space (needs the HF token — re-add it here OR run
   `HF_TOKEN=… python3 /home/z/my-project/scripts/deploy_shared.py`).
4. On the GitHub screen: choose "Only select repositories" → pick the
   repo. That's the whole repo-scoping.
