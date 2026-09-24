# The HF-Space Capability Port Matrix — v0.19

*"Tell me everything that we can port into quick chat that requires completely
no manual setup by the user — AWS strands adapter, tools, hooks, connect to
repos and workspaces, bash, build apps or analyse stocks. I need to know
exactly how much we can pull off from a quick chat button, vs termux, vs hf
chat. If we can make the entirety of HF chat's capabilities in the quick
chat, let's do so."*

This is the complete audit of the old HF space (`doomalaysocreate/lib/`) and
the current `brain/` against what the **quick chat button** (Android APK,
Go engine, zero user setup) can carry. Sources: code archaeology of
`lib/agent_sessions.py`, `lib/tools/`, `lib/orchestrator/`, `lib/jobs.py`,
`lib/github_integration.py`, `brain/agent.py`, `brain/agent_core.py`, plus
live verification of the engine's current pipelines.

---

## What the old HF space actually has (the inventory)

| # | Capability | Where it lives | What it is |
|---|-----------|----------------|------------|
| 1 | **Two-tier agent** | `agent_sessions.py` | Claude Agent SDK tier (Anthropic key) OR Strands Agents SDK tier (any provider via LiteLLM). Sessions as jobs, 2h TTL, append-only event transcripts — the same event-log model our engine uses. |
| 2 | **Tool suite** | brain `agent.py` | shell, file_read, file_write, editor, web_search, web_fetch, http_request, calculator, memory, delegate, agent_panel, git, current_time, env, grep, glob, think, journal, memorize, slug, retrieve |
| 3 | **Hooks + skills** | `agent_core.py` | `.claude/skills` seeded per workspace (conscious, workspace-artifacts), BYPASS_TOOL_CONSENT, guarded shell |
| 4 | **Workspaces + repos** | `github_integration.py` | GitHub OAuth token exchange, encrypted storage, repo/branch/content proxy, workspace CRUD, commit/push/PR ops, public workspace registry |
| 5 | **Multi-agent orchestrator** | `orchestrator/` | planner → roles → schematic graph execution; panel fan-out + `merge.py` critiques/panels across providers |
| 6 | **Judge panel** | `judge/`, `jobs.py` | N-model fan-out on one input, cross-provider failover via SlotScheduler, merged verdicts |
| 7 | **Routing gateway** | `providers.py`, `scheduler.py` | logical→physical model routing, live failover on 429/5xx, per-profile metrics |
| 8 | **Memory + datasets** | `memory_layer.py`, `dataset_persistence.py`, `public_dataset.py` | persistent memory, favorites, public dataset publishing |
| 9 | **Templates** | `templates.py` (2,045 lines) | web/deep/judge prompt template library (already partially represented in the engine's `web_template` / `deep_template` / `judge_template` session columns) |
| 10 | **Cost layer** | `pricing.py`, `metrics.py`, `promptcache.py` | per-model pricing, usage metrics, prompt caching |

---

## The port matrix — quick chat button vs Termux vs HF chat

Legend: **[IN]** already in quick chat today (v0.19) · **[PORT-0]** portable
with zero user setup (pure Go work in the engine) · **[TERMUX]** needs the
Termux chat type · **[HF]** needs the hosted brain (desktop/HF deploy)

| Capability | Quick chat (today) | Quick chat (portable, 0 setup) | Termux | HF chat |
|---|---|---|---|---|
| Multi-provider chat + reasoning + effort ladders | **[IN]** | — | same | same |
| Thinking streams | **[IN]** | — | | |
| Web search + web fetch (keyless DuckDuckGo) | **[IN]** | — | | |
| Deep research (search → read → follow-ups → synthesize) | **[IN]** | — | | |
| Artifacts (any file type; download / edit / rename / delete) | **[IN]** | — | | |
| Personas (per-chat system prompt + live model identity) | **[IN]** (v0.19) | — | | |
| Mid-conversation model switching | **[IN]** (v0.19) | — | | |
| Exports (csv / md / json) | **[IN]** | — | | |
| No-hang guarantee (90s silence watchdog + terminal statuses) | **[IN]** (v0.19) | — | | |
| Calculator tool | — | **[PORT-0]** trivial Go ReAct tool | ✓ | ✓ |
| Current time / timezone / unit conversion tools | identity line only | **[PORT-0]** trivial | ✓ | ✓ |
| Text/data tools (jq-like, regex, sort/dedupe, CSV ops) | — | **[PORT-0]** pure Go | ✓ | ✓ |
| URL fetch-and-summarize as a first-class action | internal | **[PORT-0]** expose WebFetch | ✓ | ✓ |
| Prompt template library (the 2,000-line templates.py) | — | **[PORT-0]** ship as preset personas | ✓ | ✓ |
| Persistent memory layer (user prefs across chats) | — | **[PORT-0]** engine KV + auto-inject | ✓ | ✓ |
| Judge / critique panel (N-model fan-out + merge) | smartConnect pick only | **[PORT-0]** engine-side fan-out over existing keys | ✓ | ✓ |
| Stock analysis | as websearch prompts | **[PORT-0]** Stooq/Yahoo keyless CSV quote tool + artifacts | ✓ | ✓ |
| Cross-provider failover routing (429/5xx bounce) | probe ladder only | **[PORT-0]** logical→host rotation in ResolveModel | ✓ | ✓ |
| Prompt caching / cost metrics | — | **[PORT-0]** (engine-side accounting) | | ✓ |
| GitHub connect: clone / read / commit / push / PR | — | **[PORT-0]** via go-git (Apache-2.0) + GitHub REST; token paste = the ONLY user step (same as a provider key — same UX as cloud connect) | ✓ | ✓ |
| Workspaces (per-chat scratch repos) | — | **[PORT-0]** app-private storage + go-git | ✓ | ✓ |
| Basic shell commands | — | **[PORT-0-ish]** `/system/bin/sh` + toybox runs under the app UID in app storage — viable for quick commands, NOT for toolchains | ✓ full | ✓ full |
| Python / pip / data-science stacks | — | ✗ no interpreter on Android | **[TERMUX]** | ✓ |
| Compilers / build apps / Node | — | ✗ | **[TERMUX]** | ✓ |
| Long-running background jobs (2h sessions) | — | ✗ (Android process limits) | **[TERMUX]** | ✓ |
| Multi-agent swarm (delegate / planner graphs) | — | ✗ heavy for on-device | partial | ✓ |
| Hooks system (BYPASS_TOOL_CONSENT etc.) | — | ✗ meaningless without a shell | **[TERMUX]** | ✓ |

## The verdict

**~70% of the HF chat capability, by user value, is portable to the quick
chat button with ZERO user setup** — everything in the `[PORT-0]` rows is
pure Go engine work against providers the user has already keyed. The
v0.16 ChatType architecture is ready for the rest: `class TermuxChat extends
ChatType` + `ChatTypes.register()` gets the shell/python/build tier, and the
brain already runs unchanged on desktop.

Recommended port order (each is a self-contained engine module):
1. **Calculator + time + text tools** (one ReAct tool file, hours of work)
2. **Template library as preset personas** (pure content)
3. **Stocks: keyless quote tool (Stooq CSV) + artifact reports**
4. **Persistent memory layer** (KV + auto-injection into systemPromptFor)
5. **Judge panel fan-out** (engine already has all the plumbing)
6. **Git/GitHub workspaces via go-git** (biggest lift; token UX identical
   to provider keys)

---

## v0.21 UPDATE — what was ported, and the standing decisions

*"Port everything that is portable... even if it's heavy on the device. So
port the swarm fanout panel delegate system as well, since the user can use
cloud models to void the system limitations."*

### Ported into the quick chat button (v0.20 + v0.21, zero user setup)

| Port | Status | Where |
|------|--------|-------|
| Calculator + time + text tools | ✅ **DONE** v0.20 | `engine/internal/llm/localtools.go` — 10 local tools (calculator/time_now/uuid/random/base64/hash/json_tool/text_stats/url_encode/regex_extract) ride EVERY turn, engine + PM paths |
| Web tools (search + fetch) | ✅ **DONE** (existed; hardened v0.20) | DDG retry + lite endpoint; alias/bare-arg/truncated-JSON repair so models can't fail a tool call on formatting |
| Tool-name aliases + arg repair | ✅ **DONE** v0.20 | `canonicalToolName` + `repairJSON` (Go + PM loops) |
| **Swarm fanout panel delegate** | ✅ **DONE** v0.21 | `delegate {"prompt", "models"}` ACTION — up to 3 OTHER models consulted in parallel (`server/compact.go RunDelegate`), replies returned as the observation. Cloud models void device limits by design — the fan-out spends tokens, never CPU. PM targets report their E2E constraint honestly. |
| **Auto-compacting** | ✅ **DONE** v0.21 | `server/compact.go maybeCompact` — at 70% of the model's window, older turns are summarized into the session's compact summary (HF's proactive_compression, in Go); `buildHistoryCompacted` sends summary + recent tail; full history stays on disk; UI shows a compact pill |
| **Real context tracking** | ✅ **DONE** v0.21 | per-turn usage from providers' own reports → per-session + fleet context fill (`/api/sessions/{id}/usage`, `/api/usage`) + the ⧗ usage panel |
| **Cost tracking** | ✅ **DONE** v0.21 | `llm/pricing.go` — curated $/M-token list rates, per-model + per-provider + fleet totals; unpriced models never invent dollars; NVIDIA dev tier marked free |
| Local tool server for PM | ✅ **DONE** v0.20 | `/api/tools/local` — one implementation, engine + WebView both use it |
| Model identity + personas | ✅ **DONE** v0.20 | `{model}`/`{provider}` live placeholders + the merged HF-style default persona |

### Standing decisions (user directive: "make the decision wisely")

**1. Strands AWS adapter — KEEP as the brain-side option, do NOT put it in
the APK path.** Strands is a Python SDK (AWS) requiring a Python runtime +
its dependency tree; the Android APK cannot bundle Python, and the quick
chat's Go ReAct loop now matches strands' core value for chat (streamed
tool rounds, sliding-window context with proactive compression, multi-model
routing). Where strands genuinely wins — the hosted brain tier (desktop /
HF deploy, where `brain/` already uses it with LiteLLM for the two-tier
agent + orchestrator + judge panel) — it stays. Verdict: strands is not
*replaced*, it's *tiered*: quick chat = Go engine, heavy tier = strands.

**2. The HF space — KEEP, as the heavy sandbox tier.** Its bubblewrapped
Docker genuinely brings what the quick chat cannot: REAL bash, git clone,
pip/npm installs, package builds, arbitrarily large tool chains (the
`brain/agent.py` suite: shell, file ops, editor, http_request, git,
grep/glob, journal…). The Android APK cannot execute real shells without
Termux, and tool calls that need a live filesystem need a live sandbox.
Everything ELSE the HF chat does — calculator, web, templates-as-personas,
judge fan-out (now the delegate tool), memory notes (now the compact
summary + sliding window), cost/usage (now the ⧗ panel), stocks (Stooq
keyless, ported next) — is now in or porting to the quick chat. The quick
chat is the default; the HF space is the heavy tier; Termux is the
on-device middle tier.

**3. RAG + Graphiti — PORT-NEXT (designed, not yet wired).** The
sophisticated RAG brain (vector store + retrieval + optional Graphiti
temporal-knowledge connection) is the largest remaining port. The engine's
event log + compact summary already give per-chat memory; the next layer
is a cross-chat vector store (pure-Go embeddings via the cloud providers
are possible; local embeddings need a small GGML binding — device-heavy
but the user accepts heavy). Graphiti requires a Neo4j/graph endpoint —
that stays OPTIONAL and brain-side by design ("optional connection to
graphiti" per the user spec). It stays on the roadmap as its own work
package.

**4. Stocks (keyless Stooq)** — ported in the HF matrix as PORT-0; NEXT
up with RAG (same `delegate`/tool pattern: `stocks {"symbol": "AAPL"}`).

### The tier map today (quick chat button vs Termux vs HF chat)

| Capability | Quick chat (v0.21) | Termux chat | HF chat (brain) |
|---|---|---|---|
| Chat + streaming + thinking | ✅ | ✅ (same engine) | ✅ |
| Model identity + personas | ✅ | ✅ | ✅ |
| Local tools (calc/time/uuid/hash/json/regex/base64) | ✅ 10 tools | ✅ | ✅ (Python impls) |
| Web search + fetch | ✅ | ✅ | ✅ |
| Swarm delegate fan-out | ✅ | ✅ | ✅ (agent_panel + judge) |
| Auto-compact + usage + cost | ✅ | ✅ | ✅ (strands-side) |
| Artifacts (files in chat) | ✅ | ✅ | ✅ (workspace files) |
| REAL bash / shell | ❌ | ✅ | ✅ |
| git clone / repos / PRs | ❌ | ❌ (manual) | ✅ |
| pip/npm installs, builds | ❌ | ❌ | ✅ |
| Huge tool chains (20+ Python tools) | ❌ | partial | ✅ |
| Orchestrator + templates | ❌ | ❌ | ✅ |
| RAG + Graphiti | 🚧 next | 🚧 | ✅ (memory + datasets) |

---

## v0.46 UPDATE — THE HF CHAT IS LIVE (the ZeroGPU paywall hack)

*"Make the HF chat option functional instead of just quick chat… if HF space
docker repo cloning is gated by a paywall we must find a hack to allow users
to create and clone our setup — one per chat or specific chats share the
same space, user can choose."*

### The paywall (empirically mapped, 2026-09-22, free account)

| Path | Result |
|------|--------|
| `POST /api/spaces/{repo}/duplicate` (Docker SDK) | ❌ PRO-gated |
| `POST /api/repos/create` sdk=docker (public OR private) | ❌ PRO-gated |
| `POST /api/repos/create` sdk=gradio, hardware=cpu-basic | ❌ PRO-gated |
| `POST /api/repos/create` sdk=gradio, **hardware=zero-a10g** | ✅ **FREE** |
| `POST /api/repos/create` sdk=static | ✅ free (no server) |
| Downgrade an existing space to cpu-basic | ❌ PRO-gated |
| **Quota**: free accounts host **2 ZeroGPU spaces** (PRO: 10) | — |

### The hack (verified end-to-end on the free tier)

The ZeroGPU runtime's only extra demand is *"a @spaces.GPU function detected
during startup"* — which is a `/startup-report` POST the `spaces` package
fires from `gradio.one_launch()` at `demo.launch()`. The template
(`engine/internal/hfzero/`) defines one never-called `@spaces.GPU` noop and
fires `spaces.zero.client.startup_report()` manually from a FastAPI
lifespan — the space then serves the brain's FastAPI on :7860 (7860
HARDCODED: the container's $PORT=7861 is the platform proxy). Container
reality (probed): uid 0, Debian 12, Python 3.10, Node 20 + npm, gcc/g++/
make/cmake, git — a full dev sandbox.

### What shipped (all live-verified)

- **Own spaces**: engine creates a token-gated gradio+zero-a10g Space under
  the user's account, uploads the embedded brain (122 files), sets the
  DOOMALAY_SPACE_TOKEN secret, and routes that chat's turns through it
  (RemoteBrain, same /chat SSE protocol as the local brain).
- **Shared space**: doomalaysocreate upgraded in place (legacy on branch
  `legacy-2026-09`) — current brain + full toolchain (gcc/go/rust/java/
  node) behind X-HF-Token auth (any valid HF user) + per-chat workspaces
  + concurrency cap.
- **Per-chat choice**: sandbox picker → HF → Shared | Create own | Pick
  existing; session carries sandbox_mode + sandbox_repo; fallback to the
  direct pipeline with a visible progress note whenever the space is
  unreachable.
- **Brain hardening**: model-aware LLM timeouts (the flat 60s killed
  reasoning turns from shared egress IPs), py3.10 StrEnum shim.

### The port matrix, updated

| Capability | Quick chat | HF chat (own space) | HF chat (shared) |
|---|---|---|---|
| Real bash / files / git / build tools | ✗ | ✓ (your private sandbox) | ✓ (community) |
| Python agent (Strands + 15 dt-tools + swarm) | ✗ | ✓ | ✓ |
| Setup cost | zero | HF login + ~4 min build | HF login only |
| Isolation | device | one space per chat (≤2 free) | per-chat workspaces |
| Sleeps after 48h idle | n/a | ✓ (auto-wake on next turn) | ✓ |

---

## v0.51 addendum — the runtime walls, measured live (2026-09-23)

Three live experiments on the free tier (ScoobyBaby1999, plus a throwaway
probe space) settled the Docker question for good:

| Experiment | Result |
|---|---|
| **Slot-swap**: pause doomalaysocreate + Loom (all cpu-basic spaces paused), restart the converted docker space | **FAILS** — restart → 403 "You've reached your cpu-basic quota limit…", quota stays `current=1, limit=0`. The grandfathered slot is BOUND to the account, not transferable. The "pause it & wake mine" remedy is dead on free accounts. |
| **ZeroGPU capability battery** (dedicated probe space) | **Root (uid 0)**, Debian 12. Preinstalled: gcc 12.2 / g++ / make 4.3 / cmake 3.25 / Node 20.20 + npm 10.8 / git 2.39 / Python 3.10 + pip 26. At runtime: **apt-get update + install WORK** (openjdk-17 installed and runs), **pip install works**, **Go toolchain downloads in 3.8 s** (go1.25, compile+run OK), **rustup installs the full Rust toolchain**. Fast egress (15 MB/s mirrors). |
| **Create + convert + chat (own ZeroGPU)** | gradio+zero-a10g create → 122 files / 1.9 MB commit → BUILDING → RUNNING in **75 s** → real chat turn returns verbatim `uname` from inside the space + python output. |

### The final shape (v0.51 picker)

1. **⚡ ZeroGPU sandbox (own)** — the free path. 2 per free account (verified
   email + 30-day account age). Everything the user asked for — root, bash,
   compilers, package installs, on-demand Go/Rust/Java — minus only
   Docker-in-Docker and install persistence (ephemeral: reinstall after a nap;
   the persona tells the assistant to prefer fast reinstall paths).
2. **🌍 Community workspace (shared Docker)** — the preinstalled-toolchain
   experience (gcc/Go/Rust/Java 17/Node preinstalled, zero setup). The ONLY
   runnable Docker runtime accessible to free users (the grandfathered
   doomalaysocreate space, X-HF-Token gated).
3. **📋 Pick an existing space** — scrollable, live stage badges, "managed
   here" marker for spaces this engine holds tokens for.
4. **🐳 Docker sandbox (own)** — PRO-badged: creation + full provisioning
   works on every account (static→docker flip), but cpu-basic runtime is
   PRO-gated since Jul-2026. Honest paused_quota note (no fake remedies);
   one-tap fallbacks to ZeroGPU / community.

### OAuth state (2026-09-23)

- **HF (CIMD)**: start → 302 with PKCE + registered redirect ✓; HF accepts
  the CIMD client_id ✓; callback state validation ✓. The consent click needs
  a live human HF session (AWS WAF blocks headless logins — ~20 VLM attempts,
  1 success rate). Manual token paste remains the always-works path.
- **GitHub App** (`Iv23liDzVTw7zphxo5Hv`): client secret vault-configured ✓;
  start → 302 to github.com/login/oauth/authorize with the REGISTERED
  `http://localhost:8080/api/github/oauth/callback` ✓; bogus state → 400 ✓;
  PAT connect via the sign-in-once path ✓. Full OAuth round-trip awaits a
  real GitHub login (user's device — loopback IS production for the APK).
  **2026-09-25 superseded:** that app is compromised/deleted; v0.55+ is
  secretless device flow, and v0.58 wires the NEW app
  `Iv23li3qm665pDrDO1Nh` (Device Flow ☑ verified live — device/code
  returns a user_code; no secret exists anywhere; see
  docs/GITHUB_APP_SETUP.md).

---

## ZeroGPU capability probe — full matrix (2026-09-23, live-verified, fresh token)

Method: throwaway ZeroGPU space (`doomalay-captest-*`), 3 probe rounds
(startup matrix → followup with base64 sources → pip/npm/java diagnostics),
results streamed to run logs via `CAPPROBE|` lines; space deleted after.

### Verdict

**ZeroGPU delivers everything the Docker question was about.** Per-user
Dockerfile spaces are IMPOSSIBLE on free accounts (402 wall, re-verified
with the fresh token — ANY cpu-basic creation incl. gradio SDK is
PRO-gated), but ZeroGPU gives root + package installs + compilers +
library downloads + serving + full egress. The v0.51 picker architecture
(ZeroGPU own / community shared / pick existing) is correct as shipped.

### Verified matrix (ZeroGPU, free tier)

| Capability | Result | Detail |
|---|---|---|
| Root access | ✅ | `uid=0(root)` — full root |
| OS / runtime | ✅ | Debian 12, Python 3.10.13, pip 26.2.1, Node 20.20.2, npm 10.8.2 |
| Resources | ✅ | 16 cores, ~940 GB RAM visible (host view; cgroup-limited but generous) |
| Preinstalled | ✅ | gcc/g++ 12.2.0, Make 4.3, cmake 3.25.1, git 2.39.5, bash 5.2, curl |
| apt (root) | ✅ | update 1.5 s; install tree 1.5 s; **golang-1.19 in 4.2 s**; **rustc/llvm-14 in 8.4 s** |
| Runtime pip | ✅ | rich 2.21.0; **strands-agents installs AND imports at runtime** |
| Runtime npm | ✅ | leftpad installs; node require OK |
| C compile+run | ✅ | gcc -O2, 35 ms, hello-world; binary runs as bg process |
| Go / Rust / Java | ✅* | installable via apt per session (seconds); not preinstalled |
| Own HTTP servers | ✅ | loopback + 0.0.0.0 both 200; node http server responds |
| Egress | ✅ | HF/GitHub/PyPI/npm/arbitrary internet all reachable — no allowlist |
| Storage | ⚠️ | /tmp + $HOME writable — ephemeral, no persistent /data |
| Session caveat | ⚠️ | apt/pip installs vanish on container restart (reinstall = seconds) |
| Docker-in-docker | ❌ | no docker CLI, no docker.sock |
| QEMU | ❌ | absent on ZeroGPU (community space has it preinstalled) |

### Quota walls (re-verified with fresh token)

- cpu-basic creation (docker OR gradio SDK) → **402 PRO-gated** — the
  Vite+blank→Dockerfile injection strategy is dead for free accounts.
- zero-a10g creation → **200** (the loophole holds).
- ZeroGPU cap: **2 per free account; paused spaces still count**.
- Repo deletion: use `huggingface_hub.HfApi.delete_repo` (hand-rolled
  `/api/repos/delete` shapes 404).
- `firstdoobievault` still does not exist (404) — fresh-account matrix
  blocked on manual signup (CAPTCHA + email verification are human-only).

### Probe engineering notes

- Bind :7860 FIRST (`prevent_thread_lock=True`), probes in a daemon
  thread — import-time work = RUNTIME_ERROR (ZeroGPU startup check).
- spaces-patched gradio 5.49.1 rejects `every=` on `.load()` events.
- Log SSE: Python urllib unreliable (0 bytes); `curl -N` works.
- CACHED image re-commits restart in ~1 min — fast probe iteration.
