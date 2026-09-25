# PLAN — v0.61: GITHUB STANDS ALONE

The user's directive (2026-09-25): "I'd rather separate GitHub from
HuggingFace so that a user can log into GitHub without logging into
hugging face first… read the docs for creating GitHub apps and follow it
to learn how we can create an app or OAuth that works very similarly to
hf, literally a one press thing: you login, maybe press an authorize
button, and that's all — without making the user have to login to
huggingface beforehand."

## Research findings (docs.github.com + live probes, 2026-09-25)

1. **PKCE exists but does not remove the secret.** Both the OAuth App and
   GitHub App web-flow docs now list `code_challenge` /
   `code_challenge_method=S256` / `code_verifier` as "Strongly
   recommended" — but the token exchange table still lists
   `client_secret` as **Required** for both app types. GitHub's Jul 2025
   PKCE changelog says it outright: *"GitHub is not requiring PKCE for any
   authentication flow at this time, as GitHub does not distinguish
   between public and confidential clients."* (Our v0.56 live probe —
   valid client_id + code_verifier, no secret → `incorrect_client_
   credentials` — agrees. There is an open feature request, issue #3106
   "Allow PKCE public clients without client_secret".)
2. **THE UNLOCK — the gh CLI precedent.** GitHub's own open-source CLI
   ships its OAuth client secret *in source*
   (cli/cli `internal/authflow/flow.go`):
   `// This value is safe to be embedded in version control`
   `oauthClientSecret = "34ddeff2b558a23d38fba8a6de74f086ede1cc0b"`.
   GitHub's accepted threat model for native clients: the secret is not
   treated as confidential — authorization codes only ever land on the
   app's REGISTERED callback URLs (our loopback = the user's own
   machine), and PKCE makes intercepted codes worthless. This is exactly
   the "public client" posture HF gives us — achievable on GitHub by
   SHIPPING the secret, gh-CLI style.
3. **GitHub Apps support multiple callback URLs**, http loopback included
   (`http://localhost:8080/...`, `http://127.0.0.1:8080/...`). The engine
   already derives the callback from the request origin and answers both
   `/api/github/oauth/callback` and `/api/workspaces/oauth/github/
   callback`.
4. **Device flow stays the secretless fallback.** Live probe
   (client_id Iv23li3qm665pDrDO1Nh): GitHub returns NO
   `verification_uri_complete` — no documented code prefill. But the
   login wall PRESERVES `?user_code=` through its `return_to`, so
   appending it to the verification URL is a free upgrade attempt
   (harmless if GitHub ignores it).

## v0.61.1 — THE DIRECT ONE-PRESS (loopback, HF-free)

User presses *Sign in with GitHub* → POPUP to
`github.com/login/oauth/authorize?client_id&redirect_uri=
http://localhost:8080/api/github/oauth/callback&state&code_challenge&
code_challenge_method=S256` → user logs in if needed, presses
**Authorize** (first run: **Install & Authorize** with
*Only select repositories* = the repo-scoped grant) → GitHub redirects to
the ENGINE's loopback callback → exchange (shipped secret + PKCE
verifier) → vault → DONE PAGE → popup auto-closes → panel syncs via
postMessage/focus. **No HF, no Space, no broker, no code entry, zero
setup for every friend install.**

### Engine (`engine/internal/server/workspaces.go`)
- `ghOAuthDefaultClientSecret` — a `var` (tests can inject), EMPTY until
  the app owner pastes the generated secret (the arming step below);
  env `DOOMALAY_GH_CLIENT_SECRET` / vault still override.
- `ghOAuthCreds`: env → vault → built-in id + shipped secret.
- **PKCE S256 end-to-end**: start mints a 43-char base64url verifier,
  sends `code_challenge` (base64url-SHA256, 43 chars, no padding) +
  `S256`; `oauthPending` gains `CodeVerifier`; the callback exchange
  includes `code_verifier`.
- Status endpoint gains `one_tap` (secret present) so the UI labels the
  button honestly.
- Device start response gains `verification_uri_complete` =
  `verification_uri + "?user_code=" + user_code` (prefill attempt).

### Web (`engine/internal/server/web/ghconnect.js` + `workspace.js`)
- `has_secret` → primary button = **one-click popup** web flow with
  waitPopup + live sync (already wired v0.60); copy: one Authorize press,
  Only select repositories, nothing HF anywhere.
- The device flow stays as the "use a one-time code instead" link (its
  open button uses the prefill URL).
- `workspace.js` picker GitHub row: stop the same-tab navigation when
  `oauth_configured` — open the GHConnect panel instead (the v0.60
  anti-pattern must not resurface).

### Docs (`docs/GITHUB_APP_SETUP.md`)
New §0 (v0.61): the direct one-press is the production path; the
shipped-secret rationale (gh CLI precedent + PKCE + loopback-only
callbacks); the broker demoted to gateway-origin optional; device flow =
universal fallback.

### Arming (USER ACTIONS, one-time, ~3 minutes)
1. GitHub App settings → **Callback URLs** → add
   `http://localhost:8080/api/github/oauth/callback` and
   `http://127.0.0.1:8080/api/github/oauth/callback` (plus the `:8123`
   twins if that port is ever used).
2. **Client secrets → Generate a new client secret** → paste the value
   into `ghOAuthDefaultClientSecret` (workspaces.go) → commit → release.
3. Keep **Device Flow ☑** (fallback), **Expire user authorization
   tokens ☐**, Administration off.

## Verification (the code-check loop)
- Go: PKCE round trip (challenge shape in the authorize URL, verifier in
  the exchange form), shipped-secret precedence (var → has_secret true),
  device `verification_uri_complete`, existing oauth/device/broker suites
  green.
- JS suites + red team (agent-browser): the one-click button opens the
  popup to the authorize URL (challenge+state present), waitPopup /
  done-page repaint, the device fallback still works, the picker row
  opens the panel (never navigates the app tab).
- Live: authorize URL shape against real GitHub with the real client id.
