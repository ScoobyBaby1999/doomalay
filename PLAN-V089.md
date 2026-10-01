# PLAN-V089 — THE ALIEN, THE GUARD'S LIST, THE PILL'S WIRE, AND THE BOT'S OWN MANUAL

Wave v0.89 — the user's 4-item feedback round (2026-10-01), on top of
origin/main @ 8e0252e8 (v0.88.2, 52 commits ahead of my v0.77.10b — rebased
clean, ff-only).

## The 4 items (verbatim intent)

1. **The alien icon** — "+model when creating a chat" should carry a weird
   👾 purple alien face (or ant face) instead of the robot 🤖.
2. **The redirect exemptions** — exclude Hugging Face, GitHub, and the other
   sites WE USE from the redirect-guard flow (the popup asking whether we
   want to be redirected).
3. **The PM effort pill** — "Using privatemodeai, I still can't see the
   effort mode pill. It's gone. Doesn't render. We can't use kimi or GLM or
   any of the offered models on actual effort modes."
4. **The sandbox test + the bot's own manual** — default personas must
   differ (quick vs HF); the HF persona should EXCLUDE the important tools
   and only mention basics (calculator, time); if the persona would get too
   long, include an ARTIFACT in each HF chat telling the bot where to read
   about its harness; the bot must KNOW all its capabilities by itself.
   Then the FINAL capability test: each sandbox tests everything it can;
   the HF bot uses a test space (ZeroGPU preferred), uses up storage, writes
   files, saves+runs a viewable simulation script, and turns the space into
   an evolution-simulator game (3 colored dot types: A never dies, B must
   eat A within X seconds or dies, C must eat B within X seconds or dies;
   all they do is flee or chase) — the BOT builds it, not me.

## Research findings (this session, live)

- **PM docs (docs.privatemode.ai/models/overview, fetched 2026-10-01):**
  - GLM-5.3 / GLM-5.3-Flash: `reasoning_effort` default **max**, accepted
    **low, high, max**; reasoning CANNOT be switched off; any other value
    (incl. none) maps to max.
  - gpt-oss-120b: `reasoning_effort` default medium, accepted low/medium/high.
  - Kimi K2.6 (deprecated but served): default thinking ON; **sending
    `chat_template_kwargs:{"thinking":false}` switches reasoning OFF**.
  - The reasoning text returns in the `reasoning` field (reasoning_content
    deprecated).
  - Live /v1/models: glm-5.2/5.3/5.3-flash + -latest aliases, gpt-oss-120b
    (+openai/ alias) + latest, kimi-k2.6 + kimi-latest, deepseek-ocr-2.
- **The catalog truth (engine probe, live):** with the PM key stored, the
  engine's /api/models serves the privatemodeai group with correct pm-docs
  ladders (verified end-to-end: group count 11, glm=low/high/max def max,
  kimi=on/off def on, gpt-oss=low/med/high def medium). Brain-up AND
  brain-down both serve it (the brain's /models lacks groups → the engine
  fills them from its Go catalog).
- **THE PILL BUG (root-caused, two layers):**
  - **Layer A (render):** the cold-boot catalog (`buildStaticCatalog`)
    serves ALL groups with `models: null`. chatframework's ensureCatalog
    retries only while TOTAL models == 0, max 8 × 1.5s. If a device's
    first live sync is slower than that window (or PM times out of the
    10s collect budget on a slow network), the partial catalog locks in:
    other providers present (NVIDIA → "reliable"), PM missing → **no
    ladder → no pill, for the whole session**. Reproduced logically; my
    sandbox renders the pill on every path (both flows), so the device
    divergence is the cold/partial window — the fix must make the pill
    self-sufficient.
  - **Layer B (the wire):** pmsdk.js maps effort per family — but for
    kimi, `'off'` falls into the outer `!== 'off'` guard and sends
    NOTHING (PM's default = thinking ON → dialing off does nothing);
    `'on'` correctly sends thinking:true. glm/gpt-oss enums go out as
    top-level `reasoning_effort` (correct per docs). The 400-resilience
    net silently drops the param on rejection.
- **The redirect guard (v0.87.1):** native `handleNav` in
  PanelBrowserSheet.kt (shouldOverrideUrlLoading, registrable-domain
  compare, banner ask, 12s expiry, search-engine exemptions) + the
  webpanel.js twin. The fix: add the OUR-SITES exemption set to both.
- **The SDK split (verified from code):** quick chat = the engine's own
  protocol (ACTION + native tools: calculator, web_search/fetch, library,
  artifacts, workspaces — NO shell). HF chat = the brain running IN the
  Space: **AWS Strands SDK** (strands-agents 0.1.5 + strands-agents-tools
  0.1.9: shell, file_read/write, editor, calculator, current_time, memory,
  env, grep, glob, think, journal, memorize, slug, retrieve, http_request,
  web_search/fetch, delegate) + the dt registry (workspace, explore, hf,
  hublib, persona, skills, swarm, rtsearch, template, timemgr, journal,
  stocks, socreate, artifact, spec, git, worktree, web). The user's belief
  "HF uses AWS Strands SDK, quick chat can't bash, HF can bash" — all
  confirmed.
- **HF account (live):** ScoobyBaby1999; 4 spaces (Loom, doomalaysocreate,
  doomalay-e2e-docker, doomalay-e2e-v051); ZeroGPU quota free (2/account,
  0 used). The engine's own-space flow creates ZeroGPU spaces (sdk:gradio
  README + the FastAPI gate app — the v0.46 hack).
- **Current personas:** DEFAULT_PERSONA_HF enumerates the whole toolchain
  in a long "## Environment" section — exactly what the user wants GONE
  (replaced by basics + a pointer to a harness doc the bot reads on
  demand).

## Phases (build order; each gets its own rig + real-user pass)

### v0.89.1 — THE ALIEN + THE GUARD'S LIST (items 1 + 2)
- chatframework.js: the +model row icon 🤖 → 👾 (line ~124) and the
  pill-model label '🤖 ' → '👾 ' (line ~150). The empty state '◈ + Model'
  stays. Any other 🤖 in the create-a-chat flow follows.
- PanelBrowserSheet.kt handleNav + webpanel.js (the twin): the TRUSTED
  SITES set — huggingface.co, hf.co, github.com, gist.github.com,
  gitea.com, gitlab.com, sourcehut.org, portal.privatemode.ai,
  privatemode.ai, opencode.ai, nvidia.com — skip the guard banner
  (auto-follow), exactly like the search-engine exemptions. Everything
  else still asks. The list lives as one shared-shape constant in both
  twins (kept in sync per the v0.87.1 pattern) — theme law: no colors
  involved (behavior only).
- Rig v0891: the icon (header row + pill label, both states), the guard
  (BIB mock: huggingface.co cross-domain auto-follows, github.com too,
  unknown.com still asks + ignores on tap-elsewhere, same-domain still
  silent, search engines still exempt; the web twin parity on the same
  cases).

### v0.89.2 — THE PILL'S WIRE (item 3, both layers)
- chatpanel.js:
  - buildToolbar: when effortLevelsFor returns null AND the chat's
    provider group is missing/empty in the catalog → fire ONE
    `/api/models?refresh=1`, re-derive, re-render (bounded once per build;
    no loops).
  - THE CLIENT FALLBACK LADDER (pm-docs, verified today): used ONLY when
    the catalog returns nothing for a PM model — kimi* → on/off def on;
    glm (not 5.1) → low/high/max def max (mandatory); gpt-oss →
    low/medium/high def medium; deepseek-ocr → none. Source label
    'pm-docs (client)'. The engine's ladder wins whenever present.
- pmsdk.js (the wire, per docs):
  - kimi: 'on' → chat_template_kwargs.thinking=true; **'off' →
    chat_template_kwargs.thinking=false** (was: send nothing).
  - glm-5.x / gpt-oss: reasoning_effort = the level (unchanged, verified).
  - the 400-resilience net stays as the last resort.
- Rig v0892: (a) cold-catalog panel open (engine restarted, panel opened
  within the static window) → the PM pill STILL renders via the client
  fallback; (b) the pill cycles kimi on→off→on; (c) the wire proof — wrap
  the PM bridge, assert request bodies: kimi off → `chat_template_kwargs.
  thinking===false`; glm max → `reasoning_effort==='max'`; (d) a REAL PM
  turn at effort low vs max — behavioral delta (latency/length), reply
  streams, no 400s.

### v0.89.3 — THE BOT'S OWN MANUAL (item 4a: personas + harness)
- brain/HARNESS.md (NEW — the complete HF-sandbox manual): what the Space
  is (ZeroGPU/Docker, the gate app, why it sleeps), the Strands SDK +
  EVERY built-in tool with a one-line usage example, the full dt registry
  with examples, the Linux toolchain (bash/python/git/node/gcc/make/cmake),
  pip/npm installs, the HF API self-management (edit own files, secrets,
  logs, restart), storage (ephemeral ~50GB — commit/download what
  matters), how to SERVE things at the Space root (turning the space into
  a viewable app/game), the ZeroGPU quota, the per-chat workspace, and
  the honest remote-degradation notes (the space cannot see the user's
  device). Synced into the hfzero template (go:embed) so every Space
  ships it at a known path.
- persona.js DEFAULT_PERSONA_HF → SHORT: identity (2 lines) + style +
  basic tools only ("you have a calculator and the current time") + the
  ONE pointer: "Your complete harness — every capability, tool and
  command of this sandbox — is HARNESS.md in your workspace (read it with
  file_read or shell whenever you need to know what you can do)."
  The long "## Environment" section is GONE. personas.go/chat.go twin
  (defaultPersonaHF) mirrors it.
- Engine-side seeding: on HF chat creation, auto-create the 'My harness'
  artifact (the same doc) in the chat's drawer — the user can read it
  too; the bot's reply-artifact flow stays untouched.
- Rig v0893: the personas differ (HF has no environment enumeration, has
  calculator/time + the pointer; quick keeps the classic blocks); HF
  persona is SHORTER than quick's; the harness artifact auto-seeds on HF
  chat create (and only HF); HARNESS.md rides the space package (sync
  test); the doc enumerates every registered tool name (cross-checked
  against dt_registry + agent.py).

### v0.89.4 — THE FINAL TEST (item 4b: real, as a user — I ask, the bots do)
- Quick chat: create a fresh chat (NVIDIA + PM models), ask it to
  enumerate and demonstrate ALL its capabilities (calculator, web search,
  library, artifacts, workspaces) — verify it KNOWS them (no bash claims
  — it must say it has no shell in quick chat) and can actually DO them.
- HF chat: connect/create a ZeroGPU test space through the app's own-space
  flow; then ONE user ask covering: know your harness (read HARNESS.md),
  test every capability (bash, file writes, package installs, HF
  self-management), USE UP a large chunk of the storage with generated
  data files (du/df proof, then clean up enough to stay healthy), save +
  run a simple simulation script I can view (artifact), and turn the
  space into the evolution game — 3 spawnable colored dot types: A never
  dies; B must eat A within X seconds or dies; C must eat B within X
  seconds or dies; all they do is flee or chase. The BOT designs/builds/
  serves it (it may port open work — its choice); I only ask + verify.
- Verify: the Space URL serves the game (agent-browser visit: spawn the
  three types, observe chase/flee + starvation deaths + the never-dying
  type); the artifacts drawer shows the sim script; the storage proofs in
  the transcript.

### v0.89.5 — the red-team + suites + rebase + push
- Re-run the adjacent suites (v0871 BIB focus, v0853 webtab, v0831, the
  persona suites) + the new rigs; theme twins + uikit; go vet/test;
  Kotlin compile-risk review (CI builds the APK).
- REBASE ritual: fetch, diff, merge, verify — then push v0.89.x + the
  wave tag; worklog + MEMORY.md updates.

## Laws honored throughout
- Only the two overlay surfaces (panel / Overlay screen) — no new chrome.
- Zero hardcoded colors — the alien is a glyph (emoji, like ⚡/🔌 already
  in the pills); the guard's banner already themes.
- The bot does the bot's work (the game); I do the plumbing + the asking.
- Phase versioning x.x.1…; push only after the rebase ritual.
