# GitHub App Setup — the "Sign in with GitHub" flow (workspaces)

This guide fills **every box** of the GitHub App creation form
(https://github.com/settings/apps/new) for doomalay's one-tap workspace
sign-in, and explains how to replace the compromised token securely.

---

## 0. First: kill the compromised token (do this NOW)

The PAT currently used for testing is compromised (it also sits in a git
remote URL, which is visible to any process on the machine):

1. GitHub → your avatar → **Settings → Developer settings →
   Personal access tokens** → find the token → **Delete**.
2. Remove it from any remote: `git remote set-url origin
   https://github.com/ScoobyBaby1999/doomalay.git` (no token in the URL —
   use a credential helper or SSH instead).
3. In the app: settings → keys → delete `GITHUB_PAT` if you pasted it there,
   or run the engine with a fresh vault.

OAuth (below) replaces pasted PATs entirely for the sign-in flow.

---

## 1. Create the GitHub App — every box

Open **https://github.com/settings/apps/new** (Developer Settings →
Create GitHub App) and fill in:

| Box | Value | Why |
|---|---|---|
| **GitHub App name** | `Doomalay Workspaces` | Shown to users on the authorize screen. Anything you like. |
| **Homepage URL** | `https://github.com/ScoobyBaby1999/doomalay` | The app's website — the repo is fine. |
| **Identifying and authorizing users → Redirect URI** | **add one per origin you use** (see §2) | GitHub bounces the user back here after they press Authorize. Up to 10 allowed. |
| ☐ Allow wildcard matching | **leave OFF** | We control the exact origins; wildcards are a token-leak footgun. |
| ☑ **Expire user authorization tokens** | **CHECK IT** | Gives a `refresh_token`; tokens die in 8h and the engine refreshes them automatically (already implemented). This is the single most important security box. |
| ☑ **Request user authorization (OAuth) during installation** | **CHECK IT** | Install + authorize in one pass — fewer taps. |
| ☐ Enable Device Flow | leave OFF | We use the web flow, not TV-style codes. |
| **Setup URL / Redirect on update** | leave empty | No post-install screen needed. |
| **Webhook → Active** | **leave OFF** | We poll the API; no inbound webhook = no webhook secret to protect, no public URL needed. |
| **Repository permissions → Contents** | **Read and write** | File trees, file reads, commits (the editor's "commit" button). |
| **Repository permissions → Metadata** | **Read-only** (auto-required) | Mandatory companion of every other repo permission. |
| **Repository permissions → Pull requests** | **Read and write** | Fork + PR flows (partial access tier). |
| **Repository permissions → Administration** | **Read and write** | "create new repo" as the signed-in user. |
| **Account permissions** | none needed | We don't touch emails/profile beyond the login (which needs no extra permission). |
| **Subscribe to events** | none | No webhooks. |
| **Where can this GitHub App be installed** | **Only on this account** | Private app for you. Switch to "Any account" only if you ever ship publicly. |

Press **Create GitHub App**.

After creation, on the app's page:
- Note the **App ID** (not needed by the engine, just for reference).
- Copy the **Client ID** (shown near the top, `Iv1.…` or `Iw1.…`).
- **Generate a new client secret** (bottom of the page) → copy it — it is
  shown **once**.

## 2. Redirect URIs — one per origin

The engine derives the callback from the origin the app is served on, and
tells you the exact URI: open the app and visit
`/api/workspaces/oauth/github/status` — the `redirect_uri` field is what
GitHub needs. Typical set (add the ones you use):

| Origin | Redirect URI to register |
|---|---|
| This device (PWA on the engine host) | `http://127.0.0.1:8123/api/workspaces/oauth/github/callback` and `http://localhost:8123/api/workspaces/oauth/github/callback` |
| Android device hosting the engine | `http://<phone-LAN-IP>:8123/api/workspaces/oauth/github/callback` — **GitHub only accepts http for localhost/127.0.0.1**, so use a tunnel (below) for the phone |
| Cloudflare tunnel | `https://<your-tunnel>.trycloudflare.com/api/workspaces/oauth/github/callback` |
| Any HTTPS domain you host on | `https://<domain>/api/workspaces/oauth/github/callback` |

The state nonce expires in 10 minutes and is single-use; the callback
refuses stale/unknown states.

## 3. Give the engine the client pair (secure, no redeploys)

Two ways, pick one:

**A. From the app (vault-stored, encrypted at rest):**

```bash
curl -X POST http://127.0.0.1:8123/api/workspaces/oauth/github/config \
  -H 'Content-Type: application/json' \
  -d '{"client_id":"Iv1.xxxx","client_secret":"xxxx"}'
```

The pair is AES-256-GCM encrypted in the engine vault
(`~/.local/share/doomalay/secrets.json`) — never plaintext, never in the DB.

**B. Environment (headless / CI):** start the engine with
`DOOMALAY_GH_CLIENT_ID` and `DOOMALAY_GH_CLIENT_SECRET` set. Env wins over
the vault.

Then the workspace picker's "Sign in with GitHub" becomes one tap:
redirect → GitHub → **Authorize** → back in the app, signed in. The token
(expires in 8h) + refresh token are stored encrypted; the engine refreshes
automatically — no repeated prompts.

## 4. Why this is more secure than the old PAT

- **No pasting** — the token never transits your clipboard or the chat.
- **Expiring** — 8h lifetime with auto-refresh (vs a PAT that lives for
  months/forever).
- **Scoped** — only Contents/Metadata/PRs/Administration on repos you
  install it on; revocable per-installation from GitHub in one click.
- **Encrypted at rest** — vault-only (AES-256-GCM, `0600` master key).
- **Rotate anytime** — regenerate the client secret on GitHub, re-POST the
  config. User tokens minted by the old secret die on their next refresh.

The manual token path still exists ("or paste a token instead") for
self-hosted forges and as a fallback — same vault treatment.

## 5. What the user sees (all implemented)

1. Workspace pill → picker → **＋ connect workspace** → any option.
2. "Sign in with GitHub" (big row) — one tap, GitHub page, press
   **Authorize**, back in the app: `✓ signed in as @you`.
3. Connect flows reuse it everywhere — `my repos`, `create new repo`,
   cloud URL connects. Token prompt never appears again.
4. Device storage workspaces, branch picking, and the drawer's branch
   switcher work alongside with no token prompts at all.
