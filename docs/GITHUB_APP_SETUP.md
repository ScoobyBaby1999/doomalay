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

### v0.60.2 — THE SPACE BROKER: the one-click, repo-scoped sign-in

The device flow asks the user to read and retype a code. The **broker**
(the legacy doomalaysocreate pattern, ported) removes even that: the
community Space holds the GitHub App's **client secret** in its env, so it
can run the full redirect exchange server-side. The panel opens a popup,
the user presses **Install & Authorize** once, picks
**Only select repositories** → the chosen repo gets complete access
(branches, files, PRs — nothing account-wide), the popup ends on the
engine's done page, closes itself, and the panel updates. The token
crosses the browser only as a **one-time unguessable grant code** claimed
server-to-server by the user's own engine.

What each party holds now:

| Piece | Who holds it | Secret? |
|---|---|---|
| Client ID | ships inside the app + the Space env | no |
| Client secret | **the Space's env ONLY** (never in any app build) | yes |
| User token | each user's own encrypted device vault | yes, per-user |

**To arm it (one-time, ~2 minutes):**
1. GitHub App settings → *Client secrets* → **Generate a new client secret**.
2. GitHub App settings → *Callback URL* → add
   `https://scoobybaby1999-doomalaysocreate.hf.space/gh/oauth/callback`
   (keep Device Flow checked — it stays as the fallback).
3. HF Space → *Settings → Secrets* → add
   `GITHUB_CLIENT_ID=Iv23li3qm665pDrDO1Nh` and
   `GITHUB_CLIENT_SECRET=<the secret from step 1>`.
4. Redeploy the Space with the v0.60.2 `app.py`
   (`scripts/shared_app.py` in the repo → `deploy_shared.py`).

Until the Space is configured, every install automatically keeps the
device-code flow (the panel probes `/gh/oauth/config` first). Security
notes: the relay target is locked to loopback/LAN/gateway origins, states
and grants are one-shot with 10/5-minute TTLs, and the secret never
appears in any browser-facing URL.

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
| **Repository permissions → Administration** | **No access** (v0.59 CHANGE — was Read and write) | Only needed for the in-app "create new repo" button. Left OFF so the authorize screen shows pure repo access (code + PRs) — the smallest grant that covers everything else. If you want in-app repo creation, flip it to Read and write later; the app detects the 403 and explains. |
| **Account permissions** | none needed | We don't touch emails/profile beyond the login (which needs no extra permission). |
| **Subscribe to events** | none | No webhooks. |
| **Where can this GitHub App be installed** | **Any account** | v0.55 CHANGE (was: only this account). Friends must be able to authorize the app from THEIR accounts — "Only on this account" blocks them. |

Press **Create GitHub App**.

> **Already created the app with the old (larger) permission set?** Open
> its settings → *Permissions & events* → Repository permissions → set
> **Administration** to *No access* → Save. That's the whole change —
> reducing a permission does not require re-authorization.

### Why a GitHub App (not an OAuth App)

You may wonder whether "I made an App, not an OAuth" caused the scary
permissions screen — it's the opposite. An **OAuth App** only has the
classic coarse scopes (`repo` = *full control of ALL your repositories,
including private ones*). A **GitHub App** is the fine-grained kind: it
lists exactly Contents / Pull requests / Metadata (all repository-level,
zero account-level) and nothing more. That's why the guide uses one.

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
2. **Sign in with GitHub** → the app shows a one-time code (NOT a password)
   with **copy** and **open github ↗** buttons (opens
   `github.com/login/device`).
3. About the warning on GitHub's code page: github.com/login/device
   displays a standard anti-phishing note ("GitHub staff will never ask
   you for this code") because that page exists to catch phishing sites
   that abuse device codes. It is not a comment on the app's access level.
   The code only confirms this one sign-in and cannot be reused.
4. The authorize screen lists the app's permissions — **repository
   access only** (Contents, Pull requests, Metadata). No account
   permissions of any kind.
5. Friend enters the code on GitHub, presses **Authorize** → the panel
   flips to `✓ connected as @friend` within a couple of seconds.
6. The token rides that device's encrypted vault (AES-256-GCM) — same
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
