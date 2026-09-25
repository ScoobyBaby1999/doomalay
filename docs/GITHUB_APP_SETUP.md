# GitHub App Setup — the "Sign in with GitHub" flow (workspaces)

This guide fills **every box** of the GitHub App creation form
(https://github.com/settings/apps/new) for doomalay's sign-in, and explains
the production auth model (v0.61: the direct one-press, GitHub fully
separated from HuggingFace).

---

## 0. How the production sign-in works (v0.61 — read this first)

**The goal:** any friend installs the app and signs into GitHub with ONE
press — login (maybe), **Authorize**, done. No code entry, no HuggingFace
anywhere in the chain, zero setup.

**The constraint (verified live, twice):** GitHub's redirect flow always
requires the app's **client secret** at the token exchange — even with
PKCE (GitHub's Jul 2025 PKCE changelog: *"GitHub does not distinguish
between public and confidential clients"*; a live probe with a valid
client_id + code_verifier and no secret returns
`incorrect_client_credentials`). HF can skip its secret because HF has
public PKCE clients; GitHub, today, cannot.

**The unlock (v0.61, researched per the user's directive): GitHub's own
`gh` CLI ships its client secret in open source.**
`cli/cli internal/authflow/flow.go`:

```go
// This value is safe to be embedded in version control
oauthClientSecret = "34ddeff2b558a23d38fba8a6de74f086ede1cc0b"
```

GitHub's accepted threat model for native clients: the secret is not
treated as confidential. What actually protects the flow is that
**authorization codes only ever land on the app's REGISTERED callback
URLs** — ours are loopback-only (`http://localhost:8080/...` = the user's
own machine) — and, since v0.61, **PKCE S256**: an intercepted code is
worthless without the per-sign-in verifier, which never leaves the
engine's memory.

**So the flow is now:** *Sign in with GitHub* → popup straight to
`github.com/login/oauth/authorize` (with `code_challenge` S256) → login
if needed → press **Authorize** (first run: **Install & Authorize** with
**Only select repositories** = complete access over ONE repo — branches,
files, PRs — never the account) → GitHub redirects to the ENGINE's
loopback callback → exchange (shipped secret + verifier) → token into
that device's encrypted vault → done page auto-closes → panel repaints.

What each party holds:

| Piece | Who holds it | Why it's safe |
|---|---|---|
| Client ID | ships inside the app (public by design) | identifies the app, grants nothing |
| Client secret | ships inside the app (gh-CLI pattern) | useless without a code; codes only land on loopback; PKCE S256; rotatable by re-commit |
| User token | each user's own encrypted device vault | per-user, revocable at github.com/settings/applications |

**Fallbacks (both still live):** origins where a callback URL can't be
registered (the zai-web gateway, preview URLs, LAN IPs, tunnels) keep the
v0.60.2 **space broker** (when armed — the Space holds the secret
server-side) and the v0.55 **device flow** (secretless: one-time code at
github.com/login/device; the panel's open button uses the `?user_code=`
prefill URL GitHub's login wall preserves). The engine picks
automatically; the user never chooses.

### Arming the direct one-press (one-time, ~3 minutes)

1. **GitHub App settings → Identifying and authorizing users → Callback
   URLs** → add BOTH:
   - `http://localhost:8080/api/github/oauth/callback`
   - `http://127.0.0.1:8080/api/github/oauth/callback`

   (plus the same pair with port `:8123` if that port is ever used.)
   GitHub Apps accept multiple callback URLs and allow http for loopback.
2. **Client secrets → Generate a new client secret** → paste the value
   into `ghOAuthDefaultClientSecret` in
   `engine/internal/server/workspaces.go` → commit → release. That single
   line arms every install in the world.
3. Keep **Device Flow ☑** (the fallback), **Expire user authorization
   tokens ☐** (refresh also needs the secret; long-lived tokens are the
   UX we want), Administration **No access**.

Until step 2 lands, `ghOAuthDefaultClientSecret` is empty and installs
behave exactly like v0.60 (broker/device flow) — the empty string is the
off switch.

---

## 1. Create the GitHub App — every box

Open **https://github.com/settings/apps/new** (Developer Settings →
Create GitHub App) and fill in:

| Box | Value | Why |
|---|---|---|
| **GitHub App name** | `Doomalay Workspaces` | Shown to users on the authorize screen. Anything you like. |
| **Homepage URL** | `https://github.com/ScoobyBaby1999/doomalay` | The app's website — the repo is fine. |
| **Identifying and authorizing users → Callback URL** | `http://localhost:8080/api/github/oauth/callback` **and** `http://127.0.0.1:8080/api/github/oauth/callback` | v0.61 CHANGE (was: leave empty): the direct one-press lands here. Loopback only — codes can never be aimed anywhere else. |
| ☐ Allow wildcard matching | leave OFF | Loopback callbacks need no wildcards. |
| ☐ **Expire user authorization tokens** | **LEAVE UNCHECKED** | The refresh grant also needs the client secret, and long-lived tokens are the friend-UX (no re-auth every 8h). A token lives until revoked at github.com/settings/applications. |
| ☑ **Request user authorization (device flow)** | **CHECK IT** | The fallback for gateway/LAN origins. Without this checkbox the engine's device flow gets `device_flow_disabled` from GitHub. |
| ☑ **Request user authorization (OAuth) during installation** | CHECK IT | Install + authorize in one pass — fewer taps. |
| **Setup URL / Redirect on update** | leave empty | No post-install screen needed. |
| **Webhook → Active** | **leave OFF** | We poll the API; no inbound webhook = no webhook secret to protect, no public URL needed. |
| **Repository permissions → Contents** | **Read and write** | File trees, file reads, commits (the editor's "commit" button). |
| **Repository permissions → Metadata** | **Read-only** (auto-required) | Mandatory companion of every other repo permission. |
| **Repository permissions → Pull requests** | **Read and write** | Fork + PR flows (partial access tier). |
| **Repository permissions → Administration** | **No access** (v0.59 CHANGE — was Read and write) | Only needed for the in-app "create new repo" button. Left OFF so the authorize screen shows pure repo access (code + PRs) — the smallest grant that covers everything else. If you want in-app repo creation, flip it to Read and write later; the app detects the 403 and explains. |
| **Account permissions** | none needed | We don't touch emails/profile beyond the login (which needs no extra permission). |
| **Subscribe to events** | none | No webhooks. |
| **Where can this GitHub App be installed** | **Any account** | Friends must be able to authorize the app from THEIR accounts — "Only on this account" blocks them. |

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
zero account-level) and nothing more. On top of that, only a GitHub App
gives the **"Only select repositories"** install screen — the repo-level
grant that is the whole point. That's why the guide uses one.

After creation, on the app's page:
- Note the **App ID** (not needed by the engine, just for reference).
- Copy the **Client ID** (shown near the top, `Iv…`). It ships as
  `ghOAuthDefaultClientID` in `engine/internal/server/workspaces.go`.
  **Wired as of v0.58: `Iv23li3qm665pDrDO1Nh`** (the current app, Device
  Flow verified live against `github.com/login/device/code`).
- **Client secret: generate it and ship it** (v0.61 CHANGE — was: never
  generate). Paste the value into `ghOAuthDefaultClientSecret` in
  `engine/internal/server/workspaces.go` (gh-CLI pattern, see §0) — or,
  for a self-hosted/rotated setup, set `DOOMALAY_GH_CLIENT_SECRET` on
  that machine instead. Never paste it into a chat or a non-repo file.

## 2. What users see (all implemented)

1. Friend installs the app → workspace picker → **＋ connect workspace**
   → GitHub (or the GitHub connect panel directly — it's a first-class
   panel, no HuggingFace involved).
2. **Sign in with GitHub — one click**: a popup opens STRAIGHT to GitHub
   (loopback installs; the default once the secret ships). Log in if
   asked → press **Authorize** (first run: pick **Only select
   repositories** → the repo). The popup closes itself and the panel
   flips to `✓ connected as @friend`. Nothing else.
3. Gateway installs (or before the secret ships): the panel shows a
   one-time code (NOT a password) with **copy** and **open github ↗**
   buttons (the open button carries the `?user_code=` prefill — GitHub's
   login wall preserves it). About the warning on GitHub's code page:
   github.com/login/device displays a standard anti-phishing note
   ("GitHub staff will never ask you for this code") because that page
   exists to catch phishing sites that abuse device codes. It is not a
   comment on the app's access level. The code only confirms this one
   sign-in and cannot be reused.
4. The authorize screen lists the app's permissions — **repository
   access only** (Contents, Pull requests, Metadata). No account
   permissions of any kind.
5. The token rides that device's encrypted vault (AES-256-GCM) — same
   storage as every other key in the app. Revocable any time at
   `github.com/settings/applications`.

## 3. Why shipping the secret is OK now (the v0.61 security model)

The old policy ("the secret doesn't exist") came from the OLD app pair
whose secret leaked into the wrong places — that app is deleted. The
v0.61 model is GitHub's own (the gh CLI ships its secret in open source)
plus two structural guards:

- **A leaked secret alone grants nothing.** It is not an API token: no
  repo access, no user data, no installation tokens (those need the App's
  PRIVATE KEY, which never ships). It can only finish an OAuth exchange
  on a code the attacker somehow obtained.
- **Codes can't be obtained.** They land only on the registered loopback
  callbacks (the user's own machine), and PKCE S256 (v0.61) means even a
  perfectly intercepted code is useless without the per-sign-in verifier.
- **Rotation is one commit.** If the secret is ever abused, generate a
  new one in the app settings, paste, commit, release — the old value
  dies everywhere at once.

Per-user tokens, encrypted at rest (vault-only, AES-256-GCM, `0600`
master key), no pasting — all unchanged.

## 4. Self-hosted installs / rotation (optional)

The engine resolves credentials in order: env → vault → shipped default.

```bash
DOOMALAY_GH_CLIENT_ID=Iv…      # optional: your own GitHub App
DOOMALAY_GH_CLIENT_SECRET=…    # optional: override/rotate the shipped one
```

(or POST them once to `/api/workspaces/oauth/github/config` on that
install — stored encrypted in that install's vault). Non-loopback public
origins still can't register a callback — those installs keep the
broker/device flow automatically.
