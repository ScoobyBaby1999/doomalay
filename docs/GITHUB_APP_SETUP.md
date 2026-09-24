# GitHub App Setup — the "Sign in with GitHub" flow (workspaces)

This guide fills **every box** of the GitHub App creation form
(https://github.com/settings/apps/new) for doomalay's sign-in, and explains
the production auth model (v0.55: secretless device flow).

---

## 0. How the production sign-in works (v0.55 — read this first)

**The goal:** any friend installs the app and signs in with ONE login, no
setup, no keys. **The constraint (verified live 2026-09-24):** GitHub's
redirect flow always requires the app's client secret at the token
exchange — even with PKCE (GitHub's Jul 2025 PKCE changelog: *"GitHub does
not distinguish between public and confidential clients"*; a live probe
with a valid client_id + code_verifier and no secret returns
`incorrect_client_credentials`). A distributed app can never ship that
secret without leaking it to every install.

**The answer:** the **device flow** — GitHub's only secretless grant (the
same flow the `gh` CLI uses). The user taps *Sign in with GitHub*, gets a
one-time code (`WDJB-MJHT`-style), enters it at
`https://github.com/login/device`, presses **Authorize**, and the engine
(polling in the background) stores the token in that device's encrypted
vault. No secret exists anywhere, no callback URL registration is needed,
and it works on every origin/port/tunnel a friend's install might use.

What each party holds:

| Piece | Who holds it | Secret? |
|---|---|---|
| Client ID | ships inside the app (public by design) | no |
| Client secret | **nobody — you never paste it anywhere** | (unused) |
| User token | each user's own encrypted device vault | yes, per-user |

The one-tap **redirect** flow still exists as an optional extra for
self-hosted installs that set `DOOMALAY_GH_CLIENT_SECRET` (see §4).

---

## 1. Create the GitHub App — every box

Open **https://github.com/settings/apps/new** (Developer Settings →
Create GitHub App) and fill in:

| Box | Value | Why |
|---|---|---|
| **GitHub App name** | `Doomalay Workspaces` | Shown to users on the authorize screen. Anything you like. |
| **Homepage URL** | `https://github.com/ScoobyBaby1999/doomalay` | The app's website — the repo is fine. |
| **Identifying and authorizing users → Callback URL** | optional (leave empty is fine) | Only used by the OPTIONAL one-tap redirect flow (§4). The device flow needs NO callback URL. |
| ☐ Allow wildcard matching | leave OFF | Only relevant if you add callback URLs. |
| ☐ **Expire user authorization tokens** | **LEAVE UNCHECKED** | v0.55 CHANGE (was: check it). The refresh grant requires the client secret — which secretless installs don't have. With expiry ON, friends' tokens would die after 8h with no way to refresh. With it OFF, a token lives until the user revokes it (github.com/settings/applications). |
| ☑ **Request user authorization (device flow)** | **CHECK IT** | THE production path. Without this checkbox the engine's device flow gets `device_flow_disabled` from GitHub. |
| ☑ **Request user authorization (OAuth) during installation** | CHECK IT | Install + authorize in one pass — fewer taps. |
| **Setup URL / Redirect on update** | leave empty | No post-install screen needed. |
| **Webhook → Active** | **leave OFF** | We poll the API; no inbound webhook = no webhook secret to protect, no public URL needed. |
| **Repository permissions → Contents** | **Read and write** | File trees, file reads, commits (the editor's "commit" button). |
| **Repository permissions → Metadata** | **Read-only** (auto-required) | Mandatory companion of every other repo permission. |
| **Repository permissions → Pull requests** | **Read and write** | Fork + PR flows (partial access tier). |
| **Repository permissions → Administration** | **Read and write** | "create new repo" as the signed-in user. |
| **Account permissions** | none needed | We don't touch emails/profile beyond the login (which needs no extra permission). |
| **Subscribe to events** | none | No webhooks. |
| **Where can this GitHub App be installed** | **Any account** | v0.55 CHANGE (was: only this account). Friends must be able to authorize the app from THEIR accounts — "Only on this account" blocks them. |

Press **Create GitHub App**.

After creation, on the app's page:
- Note the **App ID** (not needed by the engine, just for reference).
- Copy the **Client ID** (shown near the top, `Iv…`) — this is the ONLY
  value the app needs. Send it to the engine builder; it ships as
  `ghOAuthDefaultClientID` in `engine/internal/server/workspaces.go`.
  **Wired as of v0.58: `Iv23li3qm665pDrDO1Nh`** (the current app, Device
  Flow verified live against `github.com/login/device/code`).
- **Client secret: do NOT generate one.** Nothing needs it. (If you ever
  generate one for a self-hosted redirect setup, keep it on that server
  only — never in the app, the repo, or a chat.)

## 2. What users see (all implemented)

1. Friend installs the app → workspace picker → **＋ connect workspace** →
   GitHub (or the connect panel directly).
2. **Sign in with GitHub** → the app shows a one-time code with **copy**
   and **open github ↗** buttons (opens `github.com/login/device`).
3. Friend enters the code on GitHub, presses **Authorize** → the panel
   flips to `✓ connected as @friend` within a couple of seconds.
4. The token rides that device's encrypted vault (AES-256-GCM) — same
   storage as every other key in the app. Revocable any time at
   `github.com/settings/applications`.

No setup, no secret, no callback registration — identical experience for
you and every friend.

## 3. Why this is more secure than shipping a secret

- **No secret to leak** — the thing that compromised the old pair (a
  secret visible in the repo/agent environment) structurally cannot
  recur: the secret doesn't exist.
- **Per-user tokens** — each friend's token is their own, scoped by the
  app's permissions and revocable by them alone.
- **Encrypted at rest** — vault-only (AES-256-GCM, `0600` master key).
- **No pasting** — the token never transits a clipboard or a chat.

## 4. OPTIONAL: the one-tap redirect flow (self-hosted installs only)

If you run the engine on a fixed origin (a domain, a tunnel) and want the
smoothest UX — tap, GitHub page, back — set BOTH:

```bash
DOOMALAY_GH_CLIENT_ID=Iv…      # the app's client id
DOOMALAY_GH_CLIENT_SECRET=…    # the client secret (server-only!)
```

(or POST them once to `/api/workspaces/oauth/github/config` on that
install — stored encrypted in that install's vault).

Then register the callback URL for that origin (the exact value is shown
at `GET /api/workspaces/oauth/github/status` → `redirect_uri`), e.g.
`https://<your-domain>/api/github/oauth/callback`. On such installs the
connect panel automatically uses the one-tap redirect; everywhere else it
uses the device flow. The v0.52 yellow "one-time OAuth setup" box was
removed — the device flow made it unnecessary, and a per-device secret
paste could never work for distributed installs anyway.

The manual token path also still exists ("or paste a token instead") for
self-hosted forges and as a fallback — same vault treatment.

## 5. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `device_flow_disabled: Device Flow must be explicitly enabled for this App` | The GitHub App settings page → check **Request user authorization (device flow)** → save. |
| Start works but the code "expires" immediately | You likely have a stale flow; press Sign in again for a fresh code (codes live 15 min). |
| `incorrect_client_credentials` on a redirect sign-in | A secret was configured on that install but is wrong — regenerate it, or unset `DOOMALAY_GH_CLIENT_SECRET` to fall back to the device flow. |
| Friend can't see the app / authorize fails | The GitHub App is set to "Only on this account" — switch to **Any account** (§1). |
