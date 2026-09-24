# PLAN — v0.51 "Finish the HF integration" — community Docker + verified OAuth + honest quotas

Status: RESEARCH COMPLETE (live experiments 2026-09-23, this session) → real plan below.
Author: Super Z (this session) · Repo: ScoobyBaby1999/doomalay @ main (a3beee0, v0.50)

## MISSION (user spec, this session)
Finish the HF integration so we can move on to other sandbox forms (Modal etc.).
Try the dockerfile space (HF root-access stress); if the dockerfile method is
pointless vs ZeroGPU → ADD BACK the community workspace instead. Configure the
new GitHub App client secret. Fresh HF account (firstdoobievault) for real-user
testing where possible.

## LIVE EXPERIMENT RESULTS (all this session, main account = free tier)

| # | Finding | Evidence |
|---|---------|----------|
| X1 | Docker runtime wall is AIRTIGHT for free accounts: `Quota exceeded for flavor cpu-basic (requested=1): current=1, limit=0` persists even with EVERY docker space paused. The grandfathered slot is BOUND — pausing another space does NOT free it (the "pause it & wake mine" remedy FAILS: restart → 403 "You've reached your cpu-basic quota limit"). | hf_swap_experiment.py: paused doomalaysocreate + Loom, restart of e2e-docker still 402/403, quota msg unchanged |
| X2 | ZeroGPU capability matrix (fresh probe space, live): **uid 0 root**, Debian 12, gcc/g++/make/cmake PREINSTALLED, node 20 + npm, git, python 3.10 + pip. **apt-get update + install WORK** (openjdk-17 installed + runs at runtime!). **pip install works. go toolchain downloads in 3.8s + compiles + runs. rustup installs full toolchain.** Fast egress (aliyun mirror 15MB/s). | zg_probe.py + ScoobyBaby1999/doomalay-zg-probe (live battery, this session) |
| X3 | The user's compile/use-case is FULLY served by ZeroGPU: bash ✓ root ✓ C/C++ ✓ Node ✓ Python ✓ Java (apt) ✓ Go (download) ✓ Rust (rustup) ✓ own libraries ✓ (pip/npm/apt). Only Docker-in-Docker + PREINSTALLED toolchains + install-persistence differ — and Docker runtime is unreachable free anyway. | X1 + X2 |
| X4 | The community shared Space (doomalaysocreate, grandfathered Docker, full toolchain PREINSTALLED gcc/go/rust/java/node) is RUNNING and serves every HF-connected user via X-HF-Token. It is the ONLY runnable Docker experience for free users. | api/spaces/ScoobyBaby1999/doomalaysocreate → RUNNING cpu-basic |
| X5 | Fresh-account browser signup/login is blocked by AWS WAF anti-bot (image CAPTCHA ~20 attempts, VLM solve 1/20; audio unavailable). firstdoobievault does NOT exist yet on HF. → end-of-session request: user creates account + token manually (3 min human task). | agent-browser + API user lookup (404) |
| X6 | GitHub App client secret provided THIS session: vault-configurable via POST /api/workspaces/oauth/github/config (engine + ghconnect UI already built by connect-wave). | user message + workspaces.go endpoints |

## PHASES

### PHASE 1 — the picker restructure (user's fallback decision, based on X1-X4)
`sandboxpicker.js` HF chooser — 4 cards, ordered by free-tier value:
1. **⚡ ZeroGPU Sandbox (your own)** — first (the free path; 2 per account).
   Description updated with VERIFIED capabilities (X2): root Linux, bash,
   gcc/g++/make/cmake + Node + Python preinstalled, apt/pip/npm installs,
   Go/Rust/Java on demand. Dynamic: "HF login required" ↔ "HuggingFace connected".
2. **🌍 Community workspace (shared Docker)** — RE-ADDED as a first-class card
   (renderShared already exists — re-wire it): full toolchain PREINSTALLED
   (gcc, Go, Rust, Java, Node), instant, no setup. Dynamic: same HF chips.
3. **📋 Pick an existing space** — unchanged (scrollable).
4. **🐳 Docker sandbox (own — PRO)** — demoted to last, badge "PRO", honest
   copy: creation + full provisioning works on every account, but cpu-basic
   RUNTIME is PRO-gated since Jul-2026 (free: the Space is built and ready;
   it wakes on upgrade). Per X1: REMOVE the misleading "pause it & wake mine"
   offer on free accounts — replace with the honest bound-slot note.
Engine: keep docker-create + pause endpoints (PRO users + API compat).

### PHASE 2 — honest quota messaging (X1)
- `renderQuotaPaused`: replace the pause-swap remedy block with: PRO upgrade
  note + ZeroGPU + community pointers (the swap does NOT work free — X1).
- `hfspace.go` docker-create note: same correction (no pause-swap promise).

### PHASE 3 — persona + descriptions truth update (X2)
- `defaultPersonaHF`: mention apt/pip/npm + runtime toolchain installs +
  ephemerality of installs (reinstall after wake) — keep it tight.
- ZeroGPU card copy (Phase 1) carries the verified capability list.

### PHASE 4 — GitHub OAuth end-to-end (X6)
- Configure the client secret into the local engine vault via the built
  endpoint; live-run the full flow: start → GitHub authorize (browser session)
  → callback → vault token → /api/gh/account connected.
- If the browser has no GitHub login: verify flow mechanics with a dry-run
  (302 + state) and mark full-user-flow verification for the tunnel/device test.

### PHASE 5 — HF OAuth CIMD end-to-end
- Restore the saved ScoobyBaby1999 browser session; run /api/hf/oauth/start →
  authorize (as that user) → callback → vault → /api/hf/account. Live-verify
  the token actually works (whoami + space create with it if needed).

### PHASE 6 — red-team as a REAL USER (local engine + real HF)
- Engine up (engine_e2e.sh harness); via agent-browser as a user:
  * Sandbox picker: 4 cards render, dynamic chips correct, theme vars only
  * HF connect panel: OAuth button + manual paste + get-token link
  * ZeroGPU create flow → real space → real chat (shell tool: uname/apt)
  * Community workspace chat: shared space, X-HF-Token, shell verbatim
  * Negatives: no token → 401s + honest messages; bogus repos; cancel mid-flow
- go test ./... + scripts/test_*.js suites green.

### PHASE 7 — rebase + push + release (multi-agent protocol)
- fetch → rebase → build → tag v0.51.0-hf-finished → release notes.
- Cleanup: delete doomalay-zg-probe space; worklog + MEMORY updates.
- End-of-session ask (X5): manual steps for the user to create + verify the
  firstdoobievault account and send a token (then the fresh-account matrix
  can be probed next session).

## RISKS
| Risk | Mitigation |
|------|------------|
| Shared space load | It's token-gated + per-chat workspaces (v0.46); unchanged |
| ZeroGPU 2-space quota on fresh accounts (30-day rule) | Honest messaging already in picker (keep) |
| CIMD/OAuth flows depend on remote doc + HF login state | Both verified live before; re-verify in Phase 4/5 |
| Multi-agent push conflicts | Rebase protocol |
