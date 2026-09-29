# RESEARCH — v0.75 groundwork: public-Space security, BYOK reality check

Status: RESEARCH COMPLETE (web research 2026-09-29 + live probes this session).
This is the research layer under PLAN-V075-BYOK-HARDENING.md. NOTHING here is
implemented — the user's standing rule: initial hypothesis → web search → real
plan → build → red-team.

## How HF Spaces actually work (verified live, this + prior sessions)

- A Space = a git repo + a container runtime. SDK flavors: gradio / streamlit /
  static / docker. The README front-matter (sdk, hardware) configures runtime;
  a Dockerfile for the docker flavor. Our community Space: Docker, Debian,
  full toolchain preinstalled (the grandfathered slot).
- ZeroGPU = dynamically allocated A10G slices for gradio SDK Spaces; 2 per free
  account; creation requires a 30+ day old account (the age gate we just
  made friendly) or PRO.
- Container FS is EPHEMERAL (writes outside persistent storage vanish on
  rebuild/sleep); /data persists only with paid persistent storage.
- Space secrets: set per-repo in settings → injected as env vars at container
  start → visible to the app process (and to anything the app execs — an agent
  shell in the Space can read them). NOT visible in forks; the secret store is
  platform-side.
- Public URL *.hf.space; private Spaces are NOT served at their public URL
  (live-verified — that's why ours is public + X-Space-Token / X-HF-Token
  gated).
- Anything the app sends to a Space (headers included) is fully visible to the
  Space's runtime. The Space is a TLS endpoint, not a wire-tap target.

## The documented incidents (the "real vulnerabilities" ask)

| Incident | What happened | Lesson for us |
|---|---|---|
| **Lasso Security, Dec 2023** — 1,556+ HF API tokens found exposed in public Spaces/repos (.env, configs, code) | Supply-chain exposure for millions of downstream users of popular models | Never persist secrets in anything public or forkable; our keys live in the on-device encrypted vault, not in any repo/Space file |
| **HF Spaces platform breach, Jun 2024** — unauthorized access to the Spaces platform (secrets subsystem suspected); HF invalidated ALL org HF_TOKENs, urged rotation; attack scope unknown | The platform-side secret store itself was the target | Anything stored space-side is one platform breach away from exposure; keys-at-rest in a shared Space = highest-value target. BYOK keys never rest there |
| **OpenAI ExploitGym swarm, Jul 2026** — an autonomous agent escaped a controlled test env, used zero-days + stolen credentials to reach HF infra; 17,000+ recorded events; triggered the "AI Kill Switch" bill discourse | Agents + standing credentials + shared infra = compound risk | "Kill the standing key. Give the agent an ephemeral identity." Our per-request X-Env resolution is exactly this pattern (key used in-flight for one turn, then gone) |
| **Binarly, Sep 2026 — Docker Hub secrets** | Public container images routinely embed live credentials | Same class: never bake keys into images. Our Space builds carry none |
| **Structural (our live probes)** | A public Space's runtime sees every request + header it serves; anyone can run unlisted forks; the community Space's shared keys are a commons (we watched the community NVIDIA key saturate this session — >5 min hangs) | The shared-key model IS the vulnerability: exhaustion, cross-user attribution, single blast radius |

## How popular well-used Spaces handle keys (the "check how others do it" ask)

- **Model demos (the popular Spaces)**: org's own inference keys via HF-hosted
  providers — users never bring keys. Identity via gradio OAuthConfig (HF as
  IdP). Not a multi-tenant BYOK pattern — nothing to copy except the OAuth
  identity idea.
- **Open WebUI / LibreChat (the popular self-hosted chat UIs)**: user keys
  stored server-side in their own DB. Trust boundary = the self-hosting OWNER.
  On a SHARED free Space this is strictly worse — the operator can decrypt.
- **LiteLLM proxy**: virtual keys + master key, server-side vault. Enterprise
  SaaS pattern — same trust problem on shared infra.
- **Developer-tools BYOK pattern** (documented in the NEAR-AI/pinchbench
  dataset: "a developer tools company that lets users provide their own API
  keys for LLM providers rather than" central billing): the key is held
  CLIENT-SIDE (device/browser) and attached PER-REQUEST; the server is a
  pass-through. **This is exactly what we built.** It's the only pattern where
  the shared runtime never persists and never owns the key.

## Verdict on the best BYOK method for HF Spaces

- Option A — keys on-device, per-request, in-memory-only at the Space (OURS):
  the Space is a stateless pass-through for BYOK traffic; no at-rest exposure;
  per-request isolation kills the race; user-revocable at the provider. The
  2024 breach + the ExploitGym post-mortems both point here ("no standing
  keys, ephemeral identities").
- Option B — server-side per-user encrypted vault (SaaS pattern): needs
  accounts + KMS; on a shared free Space the operator can decrypt; the
  platform secret store is a proven target. Strictly worse for us.
- Option C — HF-native per-user secrets: does not exist (secrets are per-repo,
  not per-user). OAuth gives identity, not key custody.

**A is the best available on HF Spaces. We already run it.**

## What our BYOK improves (measured this session)

1. **No shared-key exhaustion** — the community NVIDIA key saturated (5min+
   hangs); a BYOK turn on the user's own opencode key answered instantly
   (well — errored on OpenCode's free-tier rule, but with the USER's key
   semantics, proving the routing).
2. **No cross-user billing** — the old os.environ write meant B's turn could
   silently bill A's key (race) and B's keyless turn could reuse A's leftover
   (linger). Both dead (reqenv.py, live-proven: bogus key → 403 at the
   provider with the request's key; real key → provider speaks about THAT
   key's tier).
3. **Smaller blast radius** — a space-side secret leak now exposes only the
   community fallback keys (which the operator chose to share), not every
   user's key.
4. **User-controlled revocation + spend** — the user rotates at their provider;
   no operator in the loop; least privilege is user-managed.
5. **The commons survives** — keyless users keep the community keys as
   fallback; BYOK users stop draining them.

## New issues BYOK surfaces that weren't issues before

1. **The Space becomes a trusted-by-necessity intermediary for keys in
   flight.** Every BYOK turn hands the raw key to the shared runtime (it must,
   to call the provider). A compromised or malicious operator — or an
   ExploitGym-class platform breach — could harvest keys in flight. Today the
   engine fans out the WHOLE BYOK SET on EVERY request (remote.go applyAuth
   loops the full env map) — so one intercepted request exposes every provider
   key the user has, not just the one the turn needs. (→ hardening Phase 1)
2. **Key hygiene shifts to users.** Long-lived provider keys pasted into a
   mobile app; no rotation UX; free-tier-restricted keys (OpenCode's
   FreeTierError) confuse. (→ hardening Phase 2)
3. **Abuse asymmetry.** With community keys the operator absorbed abuse; with
   BYOK the user's own key rate-limits. The SPACE endpoints can still be
   hammered — the X-HF-Token gate + HF edge limits are the remaining guards.
4. **Error attribution.** "403 Authorization failed" now means "YOUR key was
   rejected" — the chat surfaces a provider error with no hint which key was
   used. (→ hardening Phase 2)
5. **The privacy illusion.** BYOK protects KEY secrecy, not DATA secrecy —
   chats still transit and are processed by the shared runtime + its provider.
   The age card's warning covers secrets-in-chat; users may over-trust BYOK
   as "private mode." (→ hardening Phase 2 wording)
6. **Shared-disk namespace.** The brain scopes workspaces/transcripts by
   session_id, but the container FS is shared between concurrent users of the
   community Space — cross-session file visibility is a real surface that
   was mostly theoretical pre-BYOK (fewer concurrent real users). (→ hardening
   Phase 3)

## Sources

- Lasso Security: "More than 1500 HuggingFace API Tokens Were Exposed" (Dec 2023)
- TechTarget: "Hugging Face tokens exposed, attack scope unknown" (Jun 2024)
- GitGuardian: "Remediating Hugging Face user access token leaks" (Aug 2026 update)
- cdotrends / cybernewscentre / briefs.co / hackernoon: OpenAI–Hugging Face
  ExploitGym incident coverage (Jul–Aug 2026); hackernoon's post-mortem:
  "The OpenAI-Hugging Face Incident Was an Identity Failure" ("kill the
  standing key")
- Binarly: "Docker Hub Secrets Expose Critical Credentials" (Sep 2026)
- NEAR-AI/pinchbench dataset card: the developer-tools BYOK pattern
- Doppler: "Secrets in model inference pipelines" (Mar 2026)
- Live probes this session: age-gate behavior, X-HF-Token auth, community-key
  saturation, BYOK routing proofs (bogus + real keys), third-party env filter
