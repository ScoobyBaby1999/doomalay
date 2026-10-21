# Doomalay

A sovereign self-hosted AI workspace with maximal capability.

## Architecture

```
Go Engine (universal runtime) + Python Brain (Strands agent, full tools)
+ PWA (spatial canvas, physics-driven chat icons)
```

**PrivateMode is engine-native** (v1.44 PLAN-V144, v1.45 PLAN-V145, v1.46
PLAN-V146): PM chat turns ride the engine's own E2E-encrypted wire —
`engine/internal/pm` vendors the MIT-licensed half of Edgeless's pure-Go
client (PROVENANCE.md records every delta), the engine pins the deployment's
mesh CA (TOFU; PM chats work on the pin with ZERO wasm), and the engine's
PM client dials through `netx` like every engine outbound (v1.45.1 — the
Android DNS fix; the vendored Go-default dialer was the one that died on
real devices). The ONLY thing licensed to run Edgeless's BSL-1.1 attestation
verifier is their own MIT-distributed wasm artifact (`web/vendor/pm/`), and
it runs STRICTLY on demand (v1.45.4 — the provider card's explicit "verify
attestation" button; nothing loads wasm automatically, at connect or
anywhere else). Net honesty (v1.45.2): a single provider being unreachable
while others work is reported as THAT provider being down ("your
connection is fine") with a bounded hold, never a fake "network
unreachable" — the infinite patient-engine wait stays reserved for true
device-offline shapes. The co-located brain rides
`POST /api/pm/local/v1/chat/completions` (api-key-fallback=never).
Reasoning honesty (v1.46): PM's gateway (vLLM 0.31) emits every reasoning
delta in BOTH wire spellings (`reasoning` + `reasoning_content`,
byte-equal — the rename compat shim); the engine's alias law
(`mergeWireReasoning`) merges the pair into ONE copy so PM-native thinking
streams clean (the "every word appears twice" bug), and the provider's own
`reasoning_tokens` share of the completion rides the usage ledger end-to-end
(the 🧠 stat on the usage panel).

**The seen signal** (v1.48 PLAN-V148 — every phase live-convicted with a
pre-fix flip): **the single echo** — every user message reached the model
TWICE on every provider since the brain-history build (the turn persisted
the user event before history assembled, then appended it again; the brain
appended it a third time on its path) — `trimInFlightUser` now drops the
log's own trailing copy (byte-equal match only; no history byte is ever
dropped) at both construction sites, and a stub-provider probe counts the
real wire payload (`:2` pre-fix, `:1` post). **The live stars** —
connecting a workspace never refreshed the orbiting stars until the icon
was physically moved: the worker clone cache only re-sent entities when
the position-based checksum changed, so a session bound at rest left a
`sessionId:''` clone and the painter skipped the icon; the sig now folds a
memoized per-entity session hash and the count-change signal forces one
clone-bearing frame. **The direct plus** — the ＋ badge on a workspace row
adds it to the chat in ONE press (its own click, `stopPropagation`, the
same bind chain the expanded pill runs). **The informative pill** — the
workspace tool's collapsed pill speaks its verb + operand
(`grep | readme`, `view | issues`, `pr_diff | #12`) instead of the static
`workspace | repo` fallback: the full verb table off the tool's own param
grammar. **The serve bridge** — OpenCode's FREE models at last, the honest
way: the hosted API's free tier is walled below-HTTP to OpenCode's own
clients (byte-faithful CLI-identity replays still 403), so the engine
manages the GENUINE client itself (`engine/internal/ocserve`: the pinned
1.19.3 CLI, the gate-law permission config — execution + writes denied —
one serve session per chat, THE RECYCLE LAW on the free-tier wall,
persona/context riding the message text, reasoning deltas → thinking
events, serve's own tokens + reasoning share on the usage ledger). On the
desktop engine `big-pickle` and friends stream live through the engine's
own WS protocol; where the bridge cannot run (Android — the CLI is
glibc-linked), the honest copy names the wall, the desktop truth, and the
alternatives.

**Two new native hands + a retired bridge** (v1.47 PLAN-V147): the
engine's tool registry grew to 31. `djournal` — the personal journal
(the authentic Go port of `brain/tools/dt_journal.py`: moods, tags,
highlights, gratitude, energy, day streaks, rotating prompts, weekly
reviews, md/json exports) — one append-only diary per install at
`<data-dir>/journal/entries.jsonl`; exports also land in the chat's
artifact drawer. The port is pinned byte-for-byte against the Python
spec itself (`engine/internal/djournal/djournal_parity_test.go` runs
both implementations over one scenario — banker's rounding, the
own-zone date law, and the JSON entry shape all agree exactly).
`fleet` — the other-chatbots roster + detail (the A2A agent-card
grammar over the engine's own truth: title/model/canvas/live state/
turns, the q filter, and one chat's full card with its CURRENT action
from the live events tail + the running/idle turn-gauge truth).
And the old PM bridge's orphaned `/api/tools/*` tool-server routes are
GONE (the WebView-bridge chat that consumed them died with the native
PM; a full-tree sweep found zero consumers) — the mcpbus, `/mcp`, and
the brain's `/api/pm/local` bridge all stay.

## Structure

```
doomalay/
├── engine/          # Go — HTTP/WS, SQLite, secrets, sandbox
├── brain/           # Python — Strands agent, templates, panel, tools
├── app/             # PWA — Vite + React 19 + PixiJS + Matter.js
├── platforms/       # Platform-specific files
│   ├── android/     # Kotlin + Chaquopy APK
│   ├── windows/     # NSIS installer (future)
│   ├── linux/       # AppImage (future)
│   ├── macos/       # .dmg (future)
│   ├── ios/         # PWA-only (future)
│   └── hf-space/    # Docker (app-building machine)
├── docs/
└── scripts/
```

## Quick Start

```bash
# Setup brain (one-time)
cd brain && python3 -m venv .venv && source .venv/bin/activate && pip install -r requirements.txt

# Build + run
make build-engine
./engine/doomalay-engine
# Opens http://localhost:8080
```

## Dev

```bash
make dev  # 3 terminals: engine, brain, PWA hot-reload
```

## Platforms

| Platform | Build | Download |
|---|---|---|
| Android | `make build-apk` or CI | GitHub Releases (.apk) |
| Windows | CI | GitHub Releases (.exe) |
| Linux | CI | GitHub Releases (AppImage) |
| macOS | CI | GitHub Releases (.dmg) |
| HF Space | `make build-hf-space` | Docker image |

See `docs/` for platform-specific setup guides.
