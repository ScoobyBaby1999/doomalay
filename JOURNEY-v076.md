# THE ULTIMATE VERIFICATION JOURNEY — v0.76 "test the repo thru and thru as a real user"

*One session, the whole stack, real keys, real providers, real GitHub, real HF Spaces.*

---

## THE JOURNEY (chronological, as a real user)

### 1. Recovery + rebase
The sandbox survived this time: engine + brain were still running from the last session. The last session's commit (v0.76.5 — the quick-chat workspace hand + the PR verb) was **unpushed** while two other bots had advanced main to v0.78.4 → v0.79.2. Rebased clean (zero conflicts, both waves touch disjoint files), rebuilt, all suites green, pushed.

### 2. First contact with the HF space (the "silent death" that wasn't)
- Drove an HF-sandbox chat through the engine (the real user flow). First turn: the shell tool RAN (real `ls` in the isolated workspace, uid 30611, `/tmp/doomalay-workspaces/ScoobyBaby1999/<sid>`) — but the stream sat silent for 5+ minutes, then died with **no error, no final answer**.
- Root-caused by waiting longer: the turn COMPLETED at 9m51s. **The stream never died — the space is just extremely slow.** ~2–6 min *per model call*.
- Pulled the space's logs: the brain's setup is 2 seconds (registry + 17 tools). Egress probe: 51ms to NVIDIA. Not the app. Not the network RTT.
- **THE SMOKING GUN** (a raw curl from *inside* the space, run by the bot itself): `200 123.783904s` — a 5-token NVIDIA completion takes **2m3.85s from the space** vs 13.4s from my sandbox. **NVIDIA queues/throttles requests from HF's shared egress IPs.** The app is innocent; the provider path from HF is the tax.

### 3. The bugs the journey surfaced (all live-found, all root-caused, all fixed + tested + pushed)

| # | Bug | Live symptom | Fix |
|---|-----|--------------|-----|
| 1 | **The consent gate** (brain/agent.py) | A quick chat with no bound repo fell to the strands BUILT-IN shell → interactive consent prompt on a headless server → **every command "cancelled by user"**; the model retried 6× then gave up | `_build_tools` defaults the workspace to the documented `brain/.chat-ws/<sid>` → the consent-free custom shell/python_repl always arm |
| 2 | **The list env_var 500** (brain/server.py) | github-models' env_var is a LIST → `req_env.get(<list>)` = `TypeError: unhashable` → **bare 500 on every /chat** (reproduced with a stack trace; the space 500'd instantly) | Normalize once, first-present alternate wins, attribution carries the resolved name |
| 3 | **The none-usage crash** (strands 0.1.5) | A provider streaming a final `metadata` chunk with `usage=None` → `AttributeError: 'NoneType' has no attribute 'prompt_tokens'` → **the turn dies after the model already answered** | Import-time guard maps the usage-less chunk to zeros |
| 4 | **The 10-minute turn budget** (engine chat.go) | **Both paths died at exactly 600s mid-chain**: the local brain (32-step chain dead at 11/32, no final answer) and the space ("brain stream error: context deadline exceeded") | Brain-mediated turns (local OR remote) get a **45-min floor**; the brain's own watchdog (960s idle / 55-min cap) is the real authority; + deepseek joins reasonKws (it emits reasoning_content on every call — raw-API-observed) |
| 5 | **The idle-death stream** (brain agent.py) | Silent model calls (2–6 min on the space) carried zero SSE bytes — undici `terminated` at 300s with headers at 0.8s; proxies kill idle streams | **The pump heartbeat**: a lightweight progress event every 25s during silence (progress events are ephemeral per the v0.23 contract — never persisted, replays clean) — **live-verified on the redeployed space** |
| 6 | **The bundle-download SSE lie** (brain/tools/dt_hublib.py) | The engine's collection download STREAMS SSE; the brain read it as JSON → "unexpected engine response" → **the model was told its bundle download FAILED and apologized while the 64 items landed fine** (the model then heroically worked around our bug, downloading members one by one) | `download_collection` streams the SSE: progress rides the observation (`64/64`), the terminal complete/failed event is the result, budget 6 min |

Also healed en route: `test_dt_hublib` card shape (the other bot's v0.77.6 `upstream` field — suite was red on main); **retired github-models in the catalog** (GitHub shut the Models API down on 2026-07-30 — the endpoint answers a stub "OK"; web-search-verified).

### 4. THE E2E MATRIX (the user's checklist)

| Requirement | Result |
|---|---|
| **HF sandbox works** | ✓ deployed + verified; heartbeat live; honest errors |
| **A persona** | ✓ Noir Detective downloaded + armed (prior session), re-downloaded live this session |
| **A skill** | ✓ Superpowers TDD (15 skills in library after the bundle) |
| **A script** | ✓ "Bump Version" (.sh) downloaded live |
| **A theme** | ✓ midnight-test-look downloaded live |
| **A bundle that uses a mix** | ✓ superpowers-obra: **64 items** (45 docs + 15 skills + 4 scripts) — the model counted them, worked around bug #6, and reported the truth |
| **Simple models execute tools reliably** | ✓ deepseek-v4.1-flash (the fast/simple tier): **32/32 chained tool calls** in ONE conversation (12m39s, final report accurate, python_repl + journal + shell all real) |
| **The five types, all in one turn** | ✓ **65 tool calls** in one turn; per-type local counts verified engine-side (persona 1, script 4, skill 15, template 1, theme 1, doc 45) |
| **GitHub workspace connects, bot pushes/PRs** | ✓✓ **PR #1 (direct path, brain off) + PR #2 (local-brain path)** both live on `ScoobyBaby1999/doomalay-e2e-verify` with real commits on auto-created branches |
| **HF chat uses bash reliably** | ✓ the shell tool runs under uid-isolated workspaces every time; chains complete under the new 45-min budget; each model call pays the NVIDIA-HF-IP tax (~2–5 min) — the app is honest about it now (heartbeat + budget) |
| **Secure / safe / private** | ✓ 8/8 security audit: anonymous + bad-token rejected (401), error events never echo keys (sentinel-key probe), key attribution present, session/workspace traversal sanitized, engine /api/keys lists presence only, key-value endpoint 403s, debug egress carries no secrets, third-party env filter never leaks GITHUB_PAT |
| **Provider rotation on 429** | ✓ tested the truth: NVIDIA works everywhere (slow from HF IPs); **OpenCode's free tier is origin-blocked** (FreeTierError); PrivateMode's catalog URL is the user's own localhost gateway; Cloudflare's community key is dead; github-models retired. Rotation exists in the app (attribution + 401/403 handling) but only NVIDIA is currently usable from the space |
| **The app knows its capabilities** | ✓ v0.78.1's session-context block (live-verified in a prior session: the model stated its own context window, rates, connections); the personas teach the six types + both pills (five-types turn proves the model used them) |
| **Browser red-team** | ✓ app renders, dock (4 pills + gear + arrow column), panel opens, chat view (model/sandbox pills, starter prompts, lib+ pill, effort), all-chats (20 chats), hub (6 type chips + search + 4 sorts + connected-chat pill), message rendering with linkification — **zero console errors** |

### 5. What shipped
- **main @ f9d5a6b8** (rebased onto v0.79.2): v0.76.5 (workspace hand + PR verb) + v0.76.6 (four bug fixes + heartbeat) + v0.76.6b (SSE truth)
- **Tags**: `v0.76.6-ultimate-verification-fixes` → CI: Android APK ✓ / Desktop Binaries ✓ / HF Space Docker ✓ (all green)
- **The community space redeployed directly** (4 files) — the heartbeat + all fixes live on `scoobybaby1999-doomalaysocreate.hf.space` within minutes

### 6. The honest limits (not fixable from our side)
1. **The NVIDIA-HF-IP latency tax** (~2–5 min per model call from the shared space) — provider-side IP queuing. Own spaces and the desktop brain are fast. The app now survives + communicates it honestly.
2. **Provider scarcity from HF**: OpenCode origin-blocked, github-models retired (July 30 2026), cloudflare community key dead. Only NVIDIA currently serves the shared space.
3. **The Kotlin side** (APK BIB behavior) — compiles via CI only; needs the user's device/tunnel (was down) or the fresh APK.
