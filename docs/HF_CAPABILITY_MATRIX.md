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
