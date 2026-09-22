# PLAN — v0.46.0: HF CHAT FUNCTIONAL (the ZeroGPU sandbox wave)

Status: RESEARCH COMPLETE → this is the real plan (after hypothesis + web research + live empirical verification)
Author: Super Z (this session) · Repo: ScoobyBaby1999/doomalay @ main (77e2574)

---

## MISSION (user spec)
Make the HF chat option FUNCTIONAL — not just quick chat. Users choose per chat:
**Quick Chat** (on-device direct) OR **HF Space sandbox** (real bash/python/git/npm
on Hugging Face). Space cloning must work around the PRO paywall. User's own
space per chat OR shared space — user chooses.

## VERIFIED RESEARCH (empirical, today, live)

| # | Fact | Evidence |
|---|------|----------|
| R1 | PRO wall blocks Docker AND Gradio space creation on free accounts (duplicate AND create-from-scratch) | Live API test: `POST /api/repos/create` sdk=docker → "requires a PRO subscription"; duplicate → same |
| R2 | **THE HACK**: Gradio SDK + `hardware:"zero-a10g"` creation SUCCEEDS on free accounts | Live test: doom-test-gradio1 created |
| R3 | ZeroGPU runtime demands ≥1 `@spaces.GPU` fn "detected during startup" — actually a startup-report POST fired by `gradio.one_launch()` at `demo.launch()`. We fire `spaces.zero.client.startup_report()` manually from a FastAPI lifespan + define one @spaces.GPU noop → **space RUNS with pure FastAPI on :7860** | Live test: https://scoobybaby1999-doom-test-gradio1.hf.space → RUNNING, root/, /echo OK |
| R4 | ZeroGPU container = FULL dev env: uid 0 (root), Debian 12, Python 3.10, pip, Node 20+npm, gcc/g++/make/cmake, git 2.39, bash, ssh, curl/wget | Live /probe on test space |
| R5 | Engine's brain client is URL-agnostic (POST /chat, SSE, X-Env-* key headers) → a RemoteBrain = same client + space URL | bridge.go Chat() |
| R6 | Session.Sandbox column ('quick'\|'hf'\|...) + sandbox picker UI exist; chat flow NEVER branches on it → HF option is decoration | chat.go: only brain-vs-direct fork |
| R7 | Previous bot's create flow broken: no `sdk` param (PRO wall), Dockerfile git-clones PRIVATE repo, no chat wiring, OAuth needs unregistered client_id | hfspace.go:372-393 |
| R8 | Old doomalaysocreate space = legacy monolith (agent_sessions.py 145K, critique_service.py 283K…), RUNNING, Docker SDK, grandfathered | HF API tree |
| R9 | brain/ = 2.6MB, 65 py files → embeddable/uploadable via commit API (NDJSON, encoding:"utf-8" — NOT "text") | du + live commit tests |
| R10 | Space sleep: gcTimeout 48h; wake = restart API (already implemented) | HF API |

## PHASES (all planned before building; each ends with real tests)

### PHASE 1 — ZeroGPU sandbox template (engine-embedded) → `engine/internal/hfzero/`
- `template/app.py`: the hack wrapper — import spaces FIRST; `@spaces.GPU` noop; FastAPI
  lifespan fires `spaces.zero.client.startup_report()`; imports brain's FastAPI app;
  space-token middleware (X-Space-Token == env DOOMALAY_SPACE_TOKEN else 401);
  gradio status UI mounted at /ui (proves gradio coexistence; satisfies shape checks)
- `template/requirements.txt`: brain deps for the space (litellm, strands, fastapi…)
- `template/README.md`: sdk: gradio, sdk_version pinned, hardware zero-a10g note
- `brainfiles.go`: go:embed of the brain/ tree (committed copy synced from ../../brain
  by `make sync-hfzero`; CI runs it before build; test asserts no drift)
- Unit test: template renders contain the 4 hack elements (spaces import, GPU noop,
  startup_report, token middleware)

### PHASE 2 — Engine: space manager + RemoteBrain + chat routing
- `hfspace.go` REWRITE of create path:
  - `POST /api/hf/space/create` {name?} → (1) `POST /api/repos/create`
    {type:space, sdk:gradio, hardware:zero-a10g, private:true}; (2) commit template
    + brain files batched; (3) set secret DOOMALAY_SPACE_TOKEN (random 32 hex) via
    `/api/spaces/{repo}/secrets`; (4) vault store token+repo; → {repo, url, stage}
  - `POST /api/hf/space/ensure` → list user spaces (GET /api/spaces?author=), reuse
    first doomalay-* else create
  - `GET /api/hf/spaces` → user's doomalay-* spaces + live stage each
  - `GET /api/hf/shared` → shared space URL (doomalaysocreate) + docs
  - keep: status/logs(SSE)/restart + OAuth (still honored when client_id configured)
  - token-paste remains the primary connect (Hub panel, vault) — OAuth needs a
    registered HF app which only the account owner can create in HF settings UI
- `engine/internal/brain/remote.go`: RemoteBrain — Healthy()/Chat()/Models() +
  headers X-Space-Token (own) or X-HF-Token (shared) + X-Env-* keys; 15s health
  cache; MarkUnhealthy + quiet revive; per-request timeout; workspace param
  `chat-<sessionID>` (sanitized [a-z0-9-])
- `chat.go` handleTurn routing:
  `sess.Sandbox=="hf" && remote configured` → streamFromRemoteBrain (failover →
  direct proxy w/ progress event, same UX as local brain failover); else existing
  local-brain/direct fork UNTOUCHED
- sessions: new columns `sandbox_mode` (shared|own), `sandbox_repo`; PATCH support;
  migrations additive
- server.go: register new routes; vault keys `HF_SPACE_<repo>` tokens

### PHASE 3 — Upgrade the SHARED space (doomalaysocreate) — "upgraded to function better"
- Branch `legacy-2026-09` on the space repo (rollback), then commit NEW content:
  - Dockerfile: brain-only host (build-essential, golang, rustc, openjdk-17, node 20,
    ripgrep, python 3.11 + brain pip deps) — the full toolchain the quick chat can't
    have; NO engine (engines connect TO it)
  - app.py: brain FastAPI + HF-token auth middleware (validates X-HF-Token via
    whoami-v2, 5-min cache) + per-workspace dirs /data/workspaces/{id} + basic
    quotas (concurrent sessions cap, disk cap) + same /chat SSE protocol
- The engine's shared mode points here — zero protocol changes (R5)

### PHASE 4 — Frontend wiring (the user-facing choice)
- sandboxpicker.js: HF card opens 3-way chooser (ConnectOverlay): **Shared space**
  (instant), **Your own space** (create via hack, live build progress), **Pick
  existing** (list of user's doomalay-* spaces)
- hfconnect.js: extend with create-progress view (poll → BUILDING → RUNNING),
  space list, per-chat assign; keep pill + logs + wake
- chatframework.js: applySandbox('hf', {mode, repo}) → PATCH session; sandbox pill
  shows mode+repo+stage; composer badge "sandbox: HF"
- No new build step (vanilla JS, embedded) — matches web/ architecture

### PHASE 5 — Redteam as a REAL USER (before push)
1. Engine local run (Go build OK already) + agent-browser:
   - Shared: pick → send "run uname -a and show me the output" → tool events render,
     output correct, artifacts work
   - Own: create (REAL API call, real build 3-6 min) → same chat test → curl without
     token → 401
   - Model switch mid-chat, stop button, sleeping space → wake, error space → logs
   - No HF token → clear guidance + quick-chat fallback banner
   - Workspace escape: workspace id `../../etc` → sanitized; tool shell `rm -rf /`
     outside workspace → blocked by scoping
2. API curl pass over every /api/hf/* route incl. 400/401/502 paths
3. Existing suites: go test ./... + scripts/test_*.js — all green
4. Android: CI tag build; engine paths are pure HTTP (no new platform deps)

### PHASE 6 — Rebase + push + release (multi-agent protocol)
- `git fetch origin && git rebase origin/main` → resolve → verify build → push
- Tag `v0.46.0-hf-chat` → CI: APK + desktop + hf-space image → release notes
- worklog.md (both repo + /home/z/my-project) updated with Task IDs
- Cleanup: delete doom-test-static1; doom-test-gradio1 stays as live probe reference

## RISKS & MITIGATIONS
| Risk | Mitigation |
|------|-----------|
| HF patches the zero-a10g creation loophole | Detect the PRO-wall error → surface "shared space" fallback + honest message (no dead UI) |
| ZeroGPU quota consumed by noop | @spaces.GPU fn is never called (report only needs it DEFINED); UI button omitted |
| Space build slow first time (pip deps) | Batch commit; requirements pinned; build ~3-6 min; progress UI + docs |
| No persistent storage on free spaces | Document ephemeral 48h workspaces; artifacts downloadable via chat; (paid persistent storage = user's choice later) |
| Shared space abuse | HF-token auth + per-workspace quotas + platform rate limits (strictly better than the old fully-public space) |
| Multi-agent push conflicts | Rebase protocol (fetch → diff → merge → push); no force-push |

## OUT OF SCOPE (spaghetti guard)
- No rewrite of the legacy monolith's features beyond what the current brain has
- No OAuth app registration (needs HF settings UI access — user action if desired)
- No Termux/mesh changes; no UI redesign beyond the sandbox flow
