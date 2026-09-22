# PLAN — v0.47 "The Connect Wave" — OAuth, the reworked sandbox picker, mode personas, tool upgrades

User spec (11 items, 2026-09-22). Scope discipline: ONLY these items.

## Research findings (all live-verified 2026-09-22)

| # | Finding | Proof |
|---|---------|-------|
| R1 | HF OAuth CIMD (Client ID Metadata Documents) — automated OAuth app creation. client_id = the CIMD doc URL, PKCE, no secret. **VERIFIED LIVE**: HF fetched our Pages CIMD doc and served the login page on /oauth/authorize (not "Invalid client_id") | curl test, this session |
| R2 | HF loopback redirect rule: port-less `http://localhost/api/hf/oauth/callback` registration matches ANY port (RFC 8252 §7.3) — same rule on GitHub | HF docs (live fetch) |
| R3 | HF OAuth scopes (live docs): `write-repos` (read+write personal repos), `manage-repos` (+create/delete), `contribute-repos` (only app-created repos — current engine scope, WRONG for us). OAuth tokens: 8h, NO refresh tokens | HF docs |
| R4 | **Task-4 bug reproduced without a token**: `GET /api/datasets/User%2Fdoomalay-personas` → 400 `"Invalid repo name: … - repo name includes an url-encoded slash"`. HF now rejects %2F on ALL datasets endpoints (resolve/tree/preupload/lfs/commit). Raw slash works everywhere. | curl matrix, this session |
| R5 | HF space creation policy (live docs, Oct-2025 change): Gradio+Docker space creation needs PRO/Team; free personal accounts host up to 2 **Gradio ZeroGPU** spaces only. Static = free. ZeroGPU = NVIDIA RTX Pro 6000 Blackwell, dynamic allocation | docs/spaces-overview + docs/spaces-zerogpu |
| R6 | The user's HF OAuth client secret (3894128e-…) pairs with an UNKNOWN client_id (3 candidates tested → all "Invalid client_id") — CIMD replaces the need for it | curl tests |
| R7 | GitHub OAuth (engine, d19ef42): full flow exists (`/api/workspaces/oauth/github/*`) but callback path is `/api/workspaces/oauth/github/callback` while the user's GitHub App registers `/api/github/oauth/callback` → path mismatch must be aliased. GitHub loopback rule = same any-port rule | workspaces.go + GitHub docs |
| R8 | Local HF token + 3 provider keys (opencode/privatemode/nvidia) were lost with `.secrets` (checked FS, git history, prev-chat share link — unrecoverable). GitHub PAT survives in the git remote. | this session |

## PHASE 1 — engine hub fix (task 4)
- `internal/hub/hf.go`: `escapeRepo` returns the repo id RAW (all 6 datasets call sites). %2F is dead on HF.
- Update `hub_test.go` escRepo helper → raw; keep mocks path-shape-compatible.

## PHASE 2 — HF OAuth via CIMD (task 3 engine)
- `hfspace.go`: default `hfOAuthClientID` = `https://scoobybaby1999.github.io/doomalaysocreate/.well-known/oauth-cimd` (env-overridable `DOOMALAY_HF_OAUTH_CLIENT_ID`).
- Scope → `openid profile write-repos manage-repos`.
- Callback keeps storing token+user in the vault; redirect `/?hf_connected=1&hf_user=…`.
- `/api/hf/account`: ALWAYS resolve the username (vault extra from the hub connect, or whoami fallback) — fixes "connected as" (task 8).
- Manual paste stays: `POST /api/hub/auth/connect` (already verifies + stores username).

## PHASE 3 — GitHub OAuth wiring (tasks 10+11 engine)
- Default client id `Iv23liDzVTw7zphxo5Hv` (env `DOOMALAY_GH_OAUTH_CLIENT_ID`, vault override).
- Alias `GET /api/github/oauth/callback` → existing workspaces callback handler; `oauthRedirectURI` emits that path (matches the user's registered URLs).
- Client secret: vault via existing `POST /api/workspaces/oauth/github/config` (user must generate once — reported at the end).
- Manual GitHub token connect: existing workspaces forge endpoints.

## PHASE 4 — frontend cleanup + connect UIs (tasks 1, 2, 3, 8, 11)
- **Task 1**: delete `#hf-btn` + status-pill wiring (index.html, app.js); hfconnect.js loses openConnect/ensureSpace/createSpace/pill — keeps the logs viewer (`openLogsFor` used by the picker).
- **Task 3 UI — `hfconnect.js` reborn**: `openConnectPanel({onDone})` —
  1. "Sign in with Hugging Face ↗" button → `/api/hf/oauth/start?redirect=/`
  2. "Optional manual method" notice + token paste + connect
  3. "get token ↗" link → https://huggingface.co/settings/tokens
  - Hosted BOTH as a ConnectOverlay page (from the sandbox chooser) and as the hub-publish panel view (same builder).
- **Task 11 UI**: same shape for GitHub (`ghconnect.js`): "Sign in with GitHub" + optional paste; unconfigured-secret → honest notice + manual path.
- **Task 2+8**: sandbox chooser (sandboxpicker) — description leads with "A real Linux sandbox…", yellow "not connected" + "Connect Hugging Face" button (opens the connect page), green "✓ connected as <name>", all theme vars, reusable Overlay (X + back stack from d19ef42).

## PHASE 5 — the reworked picker (task 9)
Options:
1. **HF Docker sandbox** — dual dynamic texts ("GitHub and HuggingFace connected" / "GitHub or HuggingFace required"); pressing checks connections, redirects to the right panel ONE at a time (HF first, then GitHub); engine `POST /api/hf/space/docker-create`:
   - fork doomalay (template) → user's GitHub (one API call)
   - `POST /api/repos/create` {space, sdk: docker} (+cpu-basic default)
   - brick-by-brick commit: README (sdk: docker), full-toolchain Dockerfile, space app (token-gated brain host), embedded brain tree
   - set space secret; watch build
   - 402 → honest PRO-wall notice + point at option 2 (ZeroGPU); the fork still offered.
   Description: "2 vCPU · 16 GB RAM · 1 GB internal storage · sleeps after 48h of inactivity · ~5 min wake" + capabilities.
2. **HF ZeroGPU Sandbox** — replaces "Your own space". Dynamic text "HF login required" ↔ "HuggingFace connected". Requires HF token (redirect to connect). Creates via the v0.46 ZeroGPU path. Description: "Dynamic resources (NVIDIA RTX Pro 6000 Blackwell GPU) · 1 GB internal storage · sleeps depending on usage · limit 2 on the free tier · ~5 min wake" + capabilities.
3. **Pick an existing space** — unchanged + SCROLLABLE list (max-height + overflow-y).
- "Shared sandbox" option: REMOVED from the UI (engine endpoint stays for compat).

## PHASE 6 — mode personas (task 6)
- `chat.go`: `defaultPersonaQuick` (current) + `defaultPersonaHF` (knows: on Hugging Face, own-space repo name or shared, full toolchain, HF tools, ephemeral workspace, sleep/wake behavior). `systemPromptForMetrics` picks by `sess.Sandbox`; HF identity line includes `sess.SandboxRepo` when own.
- `persona.js`: DEFAULT_PERSONA split; editor + status show the mode-appropriate default.

## PHASE 7 — brain tools + no-stall chaining (task 7)
- agent_core.py:
  - +`python_repl`, `web_fetch` (if present), full strands_tools sweep
  - NEW `hf_api` tool — token from the request's X-HF-Token (passed into the session): whoami/list spaces/runtime/restart/pause/secrets/variables/logs/create/commit (modify Dockerfile/README/app = "modify the docker, gradio")
  - NEW `install` tool — pip/npm/apt package installs with progress
  - NEW `parallel` tool — runs a list of shell commands concurrently (ThreadPoolExecutor) → true parallel tool execution
  - NO-STALL: replace the flat 240s kill with an inactivity watchdog — live hook events + streaming deltas + message-count growth reset a 300s idle timer; hard cap 55 min. litellm cache flush stays.

## PHASE 8 — dev public keys (task 5)
- `buildinfo.Dev` (Version contains "-dev" or DOOMALAY_DEV=1) → `/api/capabilities.dev: true`.
- `POST /api/dev/use-public-keys` (dev only) — installs embedded public keys into the vault. Embedded: GitHub PAT (have), opencode/privatemode/nvidia (LOST — placeholder until re-shared; reported).
- providers.js: dev-only "use public key" pill → endpoint → refresh + revalidate.

## PHASE 9 — test + red-team + release
- `go test ./...`; brain python tests; browser suite (overlays/pickers/panels as a real user); engine_e2e.
- Live HF: CIMD flow verified live already; token-gated flows need the re-shared HF token (ask once, at the end).
- Rebase → push → tag v0.47.0-connect-wave → release.

## Task 10 answer (for the final report)
KEEP the localhost/127.0.0.1 redirect URLs — the APK serves the PWA from an on-device engine, so loopback IS production; GitHub (like HF) ignores the PORT on loopback callbacks, so :8123/:8080 both match. Only ADD an `https://<host>/api/github/oauth/callback` entry if the PWA is ever served from a public domain (tunnel/hosting) — never remove localhost. The engine now answers at the exact registered path.

---

## ADDENDUM — 2026-09-23 research (this session, live-verified on the real account)

| # | Finding | Proof |
|---|---------|-------|
| R9 | The user's Vite-blank trick WORKS mechanically: create `sdk:static` (200, free, no 402) → ONE NDJSON commit of README(sdk:docker, app_port 7860) + Dockerfile + app.py → the space's sdk FLIPS to docker, secrets API 200. The CREATION wall is fully bypassed. | scripts/hf_docker_probe.py |
| R10 | BUT the RUNTIME wall holds on free accounts: the converted space lands PAUSED with `Quota exceeded for flavor cpu-basic (requested=1): current=1, limit=0`; restart → 403 "…upgrade your account, or pause your previous Spaces to restart this one". doomalaysocreate keeps RUNNING because it is grandfathered (holds the account's slot). | scripts/hf_quota_probe.py |
| R11 | HF staff (2026-09-21, forum): "Creating a Space that runs on compute (Gradio or Docker) requires a paid plan. **This includes converting an existing Static Space to Gradio or Docker.**" — free tier since Jul-2026 = static + ZeroGPU only. | discuss.huggingface.co/t/180646 |
| R12 | ZeroGPU docs: free personal accounts in good standing (verified email, 30+ days old) host up to 2 ZeroGPU spaces; PRO 10. `sdk:docker` + zero-a10g hardware → 400 "ZeroGPU Spaces only work with Gradio SDK" (live). GPU = NVIDIA RTX Pro 6000 Blackwell, dynamically allocated. | docs/hub/spaces-zerogpu |
| R13 | GitHub: `ScoobyBaby1999/doomalay` is public + `is_template:true` (the fork target for the viral copy). `ScoobyBaby1999/doomalaysocreate` also public (not template). | api.github.com |
| R14 | `POST /api/spaces/{repo}/pause` works — a user holding a cpu-basic slot can pause one space to wake another (HF's own suggested remedy). | live probe |

### REVISED Phase 5, Option 1 ("HF Docker sandbox" engine flow)
1. (best-effort) fork `ScoobyBaby1999/doomalay` (template repo) → user's GitHub.
2. Create the space `sdk: static` (free — beats the 402 PRO wall).
3. Brick-by-brick: ONE commit = README(sdk:docker) + full-toolchain Dockerfile + token-gated app + brain tree → sdk flips to docker.
4. DOOMALAY_SPACE_TOKEN secret on the Space + vault copy.
5. Wake attempt → runtime probe → respond with an explicit state:
   - `running` (PRO or grandfathered accounts) — done;
   - `paused_quota` (free accounts): space is BUILT and READY but HF gates cpu-basic runtime behind PRO since Jul-2026 — honest note + ZeroGPU pointer + offer to pause another of the user's doomalay spaces holding the slot (R14 swap).
   The ZeroGPU flavor stays the guaranteed free path.
