# RESEARCH — Ephemeral credentials: the future path to per-turn tokens (Phase 5)

Status: RESEARCH NOTE ONLY, NO BUILD (Phase 5 of PLAN-V075-BYOK-HARDENING.md —
"NO build unless a provider ships it"). Research layer under the v0.75 wave;
companion to RESEARCH-V075-BYOK-SECURITY.md (the BYOK threat model).

Provenance, per the standing rule: **[live]** = verified by web search /
direct doc fetches this session (2026-09-29; 12 search attempts, 6
productive — failures listed in §Sources); **[train]** = training knowledge
(cutoff early 2025), stable facts only (GitHub's 1-hour installation tokens,
Gemini static keys, RFC texts).

## Why this exists: the structural limit of BYOK on HF Spaces

- The chat brain runs on a shared HF Space, and to call a provider on the
  user's behalf the Space's runtime MUST hold something that authorizes the
  call. Today that something is the raw long-lived provider key riding
  `X-Env-*` per request (per-request since v0.72; scoped to the turn's
  provider only once Phase 1 lands).
- The Space is therefore a **trusted-by-necessity intermediary**. A
  compromised or malicious Space — or an ExploitGym-class platform breach of
  the secrets/in-flight surface (Jun-2024 HF Spaces breach; the Jul-2026
  post-mortem's "kill the standing key, give agents ephemeral identities") —
  can harvest keys in flight. Phase 1 (send only the turn's key) shrinks the
  blast radius from "every provider key" to "one provider key"; it cannot
  shrink it to zero: **a captured key stays valid until the user rotates**
  (days-to-months of billing + model access exposure).
- The end-state this note maps: a credential whose capture is *worthless
  within minutes* — short-lived, scoped, per-session/per-turn tokens issued
  by the provider on the user's delegation, refreshed transparently. Every
  adjacent industry already does this (cloud STS, GitHub Apps, k8s
  service-account tokens); the LLM providers are the laggards — but 2025-26
  moved fast.

## The state of the art, 2025-2026 [live unless marked]

### Token exchange (RFC 8693) went from RFC to production — for workloads

- **Anthropic**: the Claude platform now ships THREE auth methods
  (platform.claude.com/docs/en/manage-claude/authentication):
  1. **API keys** — static, but now support **creation-time expiration**
     (presets/custom durations, org-level maximum-expiration policy,
     `expires_at` surfaced in the Admin API, warning emails 7d/1d out).
     "Expiration limits the lifetime of a leaked credential" — their words.
  2. **Workload Identity Federation** — a workload exchanges an IdP-issued
     JWT (AWS, GCP, Azure, GitHub Actions, Kubernetes, SPIFFE, Entra, Okta)
     at `POST /v1/oauth/token` for a short-lived Claude API access token;
     SDKs auto-refresh. Their pitch verbatim: "There is no sk-ant-api…
     string to mint, distribute, or rotate."
  3. **App Attest** — an iOS/macOS installation proves it is a genuine,
     unmodified build (Apple App Attest) → Anthropic issues the device a
     **short-lived access token (1-hour TTL, workspace-scoped,
     Messages-API-only)**. "Let genuine installations of your app call the
     Claude API without shipping an API key." Closest shipped thing to
     per-device ephemeral LLM credentials — but iOS-only, and it bills the
     developer's workspace, not the user's (so: not BYOK).
- **OpenAI**: official SDKs now support **workload identity authentication
  with short-lived tokens from cloud identity providers instead of long-lived
  API keys** (npm `openai` README Sep-2026; developers.openai.com API
  reference lists "workload identity federation for short-lived access
  tokens"). Their "Agent security in the enterprise" paper: authenticate
  agents via SSO + WIF, "issue short-lived, task-scoped" credentials. BUT:
  still **no short-lived/scoped keys for end users** — community thread
  "Short Lived Restrictive API Keys" (Mar-2026): no built-in feature;
  model-only or spend-capped keys don't exist.
- **OpenRouter** (the aggregator to watch, per the plan):
  - **Workload Identity Federation** (Business/Enterprise): literal **RFC
    8693 token exchange** — `POST /api/v1/oauth/token`,
    `grant_type=urn:ietf:params:oauth:grant-type:token-exchange`, subject JWT
    from your IdP → **15-minute access tokens** (never outliving the input
    JWT), `scope: inference`, ES256 `at+jwt` with public JWKS, federation
    policies (issuer + aud/sub + CEL conditions). Revocation semantics:
    killing the policy stops new exchanges; outstanding tokens die within
    15 min; the target API key is checked on every request.
  - **OAuth PKCE** ("connect your users to OpenRouter"): one-click consent →
    exchange a 10-minute single-use code for a **user-controlled API key** —
    labeled, revocable, deep-linkable by SHA-256 hash (`/keys/{hash}`).
    Long-lived, but minted per-app on explicit user consent (no pasting).
  - **BYOK**: provider keys stored **server-side, encrypted, in the
    OpenRouter workspace** — key-at-rest with an intermediary (the escrow
    pattern RESEARCH-V075 rejected for the Space); 5% platform fee past a
    free allowance ($25k list-price/month PAYG; Oct-2025 blog: 1M free BYOK
    requests/month).
- **Google** [train]: Gemini API keys remain static strings (web-style
  restrictions, not API-native TTL); the short-lived story lives server-side
  in Vertex AI (OAuth2 access tokens ~1h via ADC/WIF). No end-user
  ephemeral option on the Gemini API key path.
- **Hugging Face** [live, doc read]: fine-grained tokens scoped to selected
  repos/orgs (roles: fine-grained / read / write; expiration presets at
  creation [train]); **Trusted Publishers** exchanges a CI provider's OIDC
  identity token for a **short-lived Hub token** per run (repo- or
  user-scoped) — HF's own token-exchange deployment, for CI/CD only.
- **The consumer-OAuth dead end**: Anthropic's Feb-2026 policy update bans
  using Claude Code OAuth tokens "in any other product, tool, or service,
  including Agent SDK" (Consumer ToS) — i.e., you may NOT ride a user's
  Claude subscription via OAuth the way we ride GitHub. Do not plan on it.

### Standards consolidating underneath

- **MCP authorization spec**: remote MCP servers = OAuth 2.1 + PKCE +
  dynamic client registration + resource indicators (modelcontextprotocol.io;
  analyses: prefect.io Apr-2026, descope Jul-2026, permit.io May-2026) — the
  first *de facto standard* saying agent-to-tool auth is OAuth, not API keys.
- **IETF**: `draft-chen-oauth-roadmap` (2026) names RFC 8693 token exchange
  as the delegation building block; a Mar-2026 draft "AI Agent Authentication
  and Authorization" proposes WIF + short-lived workload credentials as the
  agent model. Industry write-ups converge (Stacklok "Beyond API keys",
  DevRev Sep-2026, Airbyte's five agent-access patterns).
- **RFC 8628 (device flow)** — the secretless UX we already ship for GitHub
  (docs/GITHUB_APP_SETUP.md) — is the natural consent UX for any future
  provider OAuth on a phone; Claude Code's own login uses it.

### Honest table: who issues short-lived/scoped credentials today

| Provider | End-user short-lived creds? | What exists today | Fit for Doomalay BYOK |
|---|---|---|---|
| Anthropic | **Partial** — workloads + attested iOS apps | WIF (RFC 8693, auto-refresh), App Attest (1h, iOS), key expiry at creation | No: WIF targets org workloads; App Attest bills the developer |
| OpenAI | **No** (yes for enterprise workloads) | SDK workload-identity w/ short-lived tokens; static user keys only | No: nothing a user's phone can mint |
| OpenRouter | **Partial** — org workloads (WIF 15-min); OAuth mints long-lived key | RFC 8693 exchange (Business/Ent.), OAuth PKCE, server-side BYOK vault | Partial: OAuth PKCE usable as an aggregator option; still a long-lived key at rest |
| Google (Gemini API) | **No** [train] | Static API keys; Vertex ADC/WIF is server-side | No |
| Hugging Face | **Partial** — CI/CD only | Fine-grained tokens (+ expiry), Trusted Publishers OIDC→short-lived Hub token | No for inference; yes as our own IdP |
| GitHub (the archetype) | **Yes** [train] | Installation tokens: 1h TTL, fine-grained perms, mint-on-demand | Not an LLM provider — it's the *model* |

## The GitHub-App model: what 1-hour tokens would mean for an LLM provider

The archetype [train]: a GitHub App holds a private key that NEVER leaves the
operator. To act, it signs a short-lived JWT and calls
`POST /app/installations/{id}/access_tokens` → an **installation token valid
for 1 hour**, scoped to the installation's selected repositories and the
app's fine-grained permissions. Refresh = mint again. Users revoke by
uninstalling; tokens die within the hour. Compromise of any single token in
flight costs at most one hour of scoped access — never the account.

Mapped onto an LLM provider, this is the **delegation broker pattern**:

| GitHub-land | LLM-provider-land | Doomalay-land |
|---|---|---|
| GitHub App (registered, permission set) | Provider "app" registration with `inference:{model}` scopes | The Doomalay app identity (already how our GitHub App works) |
| Install (user consents, selects repos) | User connects Doomalay at the provider; delegates per-model spend | One-tap in ProvidersScreen (OAuth/PKCE UX we already ship) |
| App private key (never shared) | App signing credential held by… | …the user's ENGINE (on-device vault) — NOT the Space |
| Installation token (1h, scoped) | Per-session/per-turn token: model-scoped, budget-capped, 15-60 min TTL | The ONLY thing the Space ever sees — sent as `X-Env-*`, dies with the turn |
| Uninstall / token revoke | Revoke at provider; tokens expire anyway | User kills delegation; nothing to rotate on our side |

What would need to exist **provider-side** for this to be real (none of the
majors ships all of it for end users today):

1. **App registration** with inference scopes (per-model, per-endpoint —
   Anthropic's App Attest is Messages-only: the scope concept exists).
2. **Per-user consent/install** (OpenRouter's OAuth PKCE consent screen is
   the exact UX; GitHub's "Only select repositories" is the exact scoping
   metaphor — "only this model", "only $5/day").
3. **A mint endpoint** an end-user device can call — token exchange
   (RFC 8693) or attested-install (App Attest analog). Today's WIF endpoints
   authenticate *org workloads* via an org's IdP, not a user's phone.
4. **Per-token limits**: spend caps, rate ceilings, TTL ≤ 1h (OpenRouter's
   15-min tokens + budget features are prototype pieces).
5. **Audit surface**: OpenRouter already shows the shape — per-key hash
   deep-links, per-token `federation_policy_id` claims, public JWKS.
6. **Android attestation**: the Play Integrity equivalent of Apple App
   Attest [train] — no LLM provider accepts it today; the day one does, a
   mobile-first BYOK app like ours is first in line.

## What Doomalay can do NOW vs later

### Now (small, honest, no new trust assumptions)

1. **Per-key TTL hints + rotation nudges** (feeds Phase 2's UX): where the
   provider supports creation-time expiry (Anthropic console keys, HF
   fine-grained tokens), ProvidersScreen should say so at key-entry time
   ("Anthropic: create a 30-day key — paste the expiry, we'll nudge you");
   track key age in vault metadata; surface "this key is 90 days old". The
   *only* user-visible lifetime control that exists today — use it.
2. **Watch catalog**: keep this note's table as a living checklist
   (quarterly, or on the triggers below). The engine needs NO changes.
3. **OpenRouter as an optional aggregator provider**: our existing PKCE +
   loopback + vault plumbing (the GitHub flow) could add OpenRouter OAuth
   PKCE as a one-tap "connect OpenRouter" — user-controlled, labeled,
   revocable key minted by explicit consent. Honest tradeoff to document:
   the user now trusts OpenRouter instead of the Space (the exact complaint
   in OpenAI's community "Is this the solution to BYOK?", Feb-2026); the
   key is still long-lived at rest in our vault. Value = aggregation +
   one-tap onboarding, not ephemerality.
4. **Keep the per-request credential plumb clean** (already true):
   reqenv.py's per-request ContextVar resolution is exactly the shape a
   future token would ride. No work needed — just don't regress it.

### Later (gated on providers — the actual Phase 5 payoff)

5. **Token-exchange proxying** (RFC 8693): IF a provider ships a
   *user-facing* exchange endpoint, the engine mints per-session tokens
   on-device and sends those in `X-Env-*` instead of the key; 401 →
   re-mint. The brain needs zero changes (a token is just another value).
6. **Delegation-broker mode** (full GitHub-App model): per-turn scoped
   tokens with budget caps; the Space sees only tokens. Wire when ANY major
   provider ships items 1-4 above for end users.

### Explicitly CANNOT be done until providers ship it

- Per-turn ephemeral tokens for OpenAI / Gemini / the local-provider set:
  there is nothing to exchange, nothing to consent to, nothing to cap.
- Ending the Space's trusted-intermediary status: the Space must receive
  SOME authorizer; without provider-side delegation that authorizer is the
  raw key. (Engine-calls-provider-directly breaks the brain-side agent/tool
  architecture; a Doomalay-run key-escrow broker re-introduces Option B,
  which RESEARCH-V075 already rejected.)
- Riding consumer subscription OAuth (Claude Code tokens): explicitly
  banned by Anthropic's Feb-2026 ToS update. Never build on it.
- Android attestation flows: no provider accepts Play Integrity [train].

## Watch triggers (revisit this note when any fires)

- OpenRouter extends WIF/OAuth beyond Business plans to personal users, or
  mints short-lived tokens on the OAuth (not BYOK) path.
- Anthropic opens App Attest to Android/Play Integrity, or a user-billed
  attested-app flow (today: developer-billed, iOS-only).
- OpenAI ships short-lived scoped API keys (community ask since 2023);
  Google ships ephemeral/user-scoped Gemini credentials.
- MCP-OAuth-style authorization becomes the norm for inference endpoints
  (a provider shipping `/.well-known/oauth-protected-resource` for chat
  completions would be the signal).

## Verdict — no build today (consistent with the plan)

Phase 5 is this note and nothing else. The infrastructure is converging on
our side of the table (RFC 8693 in production at Anthropic/OpenRouter/
OpenAI; MCP OAuth 2.1; IETF agent-auth drafts; Anthropic's 1-hour attested
tokens prove the TTL model works at LLM scale), but **no major provider
lets an end user's device mint short-lived inference tokens billed to that
user**. Until one does, per-turn ephemerality for Doomalay is a
documentation-and-watch state: Phase 1-4 of the hardening plan remain the
best available defenses, and §"Now" above lists the honest residue.

## Sources

Search failures this session (junk/empty results, 6 of 12 attempts):
"Gemini short-lived credentials" (×2); "HF token expiration" (×2 — recovered
by directly reading the HF docs page below); "GitHub App installation token
TTL" (×2 — covered by [train] + our live-probed docs/GITHUB_APP_SETUP.md);
"OpenRouter OAuth docs" (recovered via openrouter.ai/docs/llms.txt + .md
fetches). All below verified live 2026-09-29:

- OpenRouter (fetched): https://openrouter.ai/docs/guides/overview/auth/
  {byok,oauth,workload-identity-federation,management-api-keys} ; blog:
  "Bring Your Own API Keys" (Dec-2024), "1M free BYOK requests per month"
  (Oct-2025) — openrouter.ai/blog/announcements/…
- Anthropic (fetched): https://platform.claude.com/docs/en/manage-claude/
  authentication (key expiration, WIF, App Attest)
- Claude Code OAuth ban: news.ycombinator.com/item?id=47069621 ;
  r/ClaudeAI "Anthropic just updated Claude Code Docs to ban OAuth"
  (Feb-2026); github.com/AndyMik90/Aperant/issues/1871
- OpenAI: developers.openai.com/api/reference/overview ; npm `openai`
  README (workload identity, Sep-2026); cdn.openai.com "Agent security in
  the enterprise"; community.openai.com "Short Lived Restrictive API Keys"
  (Mar-2026) + "Is this the solution to BYOK?" (Feb-2026)
- Hugging Face (fetched): huggingface.co/docs/hub/security-tokens
  (fine-grained roles, Trusted Publishers)
- MCP authorization: modelcontextprotocol.io; analyses prefect.io
  (Apr-2026), descope.com (Jul-2026), permit.io (May-2026), aembit.io
- IETF: draft-chen-oauth-roadmap-01 (2026); "AI Agent Authentication and
  Authorization" draft (Mar-2026); industry direction: stacklok.com
  "Beyond API keys", devrev.ai (Sep-2026), airbyte.com, descope.com (Feb-2026)
- [train] (cutoff early 2025, stable facts): GitHub Apps installation-token
  mechanics (docs.github.com/en/rest/apps — 1-hour TTL, mint via App-signed
  JWT); fine-grained PATs; RFC 8693/8628 texts; Gemini static keys; Vertex
  ADC; Android Play Integrity; HF token expiry presets.
- Incident background (from RESEARCH-V075-BYOK-SECURITY.md): HF Spaces
  platform breach (Jun-2024); ExploitGym post-mortems (Jul-2026) — "kill
  the standing key, give the agent an ephemeral identity."
