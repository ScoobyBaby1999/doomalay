# PLAN V0.78 — THE AWARENESS + FEEL WAVE

User's 4 items (session 2026-09-30, after v0.77 shipped):
1. The bot doesn't know its own usage/pricing/context/tokens, nor whether it's
   connected to a workspace/repo, on which platforms, at what access level.
2. The browser-in-browser panel feels ~80fps; the regular chat panel feels
   ~8fps (scrolling text, clicking inside it).
3. Add a 4th pill (web) that opens the browser-in-browser panel + completely
   rework the dock cluster UI: rounder, ~1.2–1.5× smaller, pills expand under
   the settings icon.
4. Hugging Face repos can't use bash/grep/shell/ls (another LLM is also on it;
   the "old hf repo" = the brain Space's own toolset, which works).

State at planning: main = 9e331247 (parallel bot's persona-hand; my v0.77.3
bf44e82c is in). Tunnel DOWN → all testing in-sandbox. Go 1.23.4 reinstalled.

## Research done (before this plan)
- 4 Explore agents mapped: panel-perf (ranked jank chain), dock cluster (exact
  CSS + wiring), bot-context injection points (3 chat paths, usage data that
  already exists), HF repo tools gap (proof: forge layer has no huggingface.co).
- 6 web searches: streaming-markdown full-reparse is THE known cost; CSS
  content-visibility:auto is the pragmatic transcript virtualization; layout
  thrash fixes = batch reads + rAF; HF git-over-HTTPS + LFS confirmed.
- LIVE HF API probes (token verified): /api/{models|datasets|spaces}/{repo}
  info/tree/commits/refs/discussions ALL answer; git smart-HTTP 200 on
  `.git/info/refs`; our Space carries branches main + legacy-2026-09.
- Key insight (panel perf): the BIB panel is NATIVE (Kotlin PanelBrowserSheet,
  own WebView, Choreographer translationY, SPA untouched) — the chat panel
  instead pays: full projection paints per scroll event (theme.js:908), per
  tap/transition (914-928, transform transitions = FIVE paints), per streaming
  DOM mutation (863-896), per drag frame via the un-stripped `--panel-vis-h`
  (gesture.js writeVis vs the strip regex at 889-892), per ambient canvas tick
  (app.js:1240-1262 pokes under the open panel), O(n²) markdown re-parse per
  180ms tick (formatter.js:289-298), zero transcript virtualization.

## Collision map
Parallel bot is active in brain/* + agent_core.py (branches bot-e2e-live2 seen).
This wave touches: engine Go (chat.go, NEW sessionctx.go, forge/*, workspaces.go,
usage-area helpers) + web (theme.js, chatpanel.js, gesture.js, app.js,
index.html) + tests. NO brain/ files → no hfzero twin sync, no Space deploy.
Merge discipline: fetch → diff → amicably resolve → push (as v0.75/v0.77 did).

---

## PHASE 1 — v0.78.1 "the bot's own dashboard" (item 1)
The model gets a LIVE per-turn session-context block. Data already exists
server-side (usage.go aggregation, llm.LookupPrice, ContextLimitFor,
lastUsageInput, hub.Username(), accounts, ListSessionWorkspaces) — it just
never reached the prompt.

Files:
- NEW engine/internal/server/sessionctx.go — `sessionContextPreamble(sess)`:
  one `## Your session (live)` block, ~≤16 lines, values only when meaningful:
  * identity: model + provider label (fresh, like the identity line).
  * context window: limit, used (max(estimate, lastUsageInput)), remaining,
    fill %, compacted state.
  * usage so far this chat: tokens in/out, turns, est. cost (or "free tier /
    unpriced — tokens only").
  * pricing: current model's rates ($/M in + out, or free-tier note).
  * connections: Hugging Face connected as <user> / not connected; GitHub
    signed in as <login> / not; Gitea likewise; (count of keyed cloud providers
    optional — skip if noisy).
  * workspaces: this chat's bound repos (kind owner/repo, access level) +
    total connected count; when zero: the capability line — "You CAN be
    connected to workspaces (GitHub, Gitea, GitLab, Sourcehut, and Hugging
    Face repos — models/datasets/spaces); the user connects them via the
    library/hub connect flow; when bound, the workspace tool can ls, grep,
    read and edit them (your access level is shown per repo)."
  * db-nil guarded (Server without store must still compose — tests).
- engine/internal/server/chat.go:588 — `meta := s.chatMetadataPreamble(sess)
  + s.sessionContextPreamble(sess)` (all 3 return paths inherit; covers the
  direct path AND the brain path since the engine always sends system_prompt,
  chat.go:875).
- web/chatpanel.js — PM twin: `pmSessionContextBlock(state)` (async, fetches
  /api/sessions/{id}/usage + /api/hub/auth/status + /api/workspaces/accounts
  + /api/sessions/{id}/workspaces, cached per turn), appended inside
  pmSystemMessage after pmMetadataBlock (the v0.68 twin-sync pattern).
- NEW engine/internal/server/sessionctx_test.go — fabricated session+events:
  expected substrings, zero-turns compactness, db-less guard, size budget.
- Rig: Go test + a Playwright rig running a PM turn with PMBridge stubbed to
  echo the system message → assert the block + numbers present.

Gates: go build/vet/test; node --check chatpanel.js; theme twins + uikit;
rig green; block renders in a REAL local-brain turn (assert via a turn against
the local brain with an echo model, or the /api/chat request capture).

## PHASE 2 — v0.78.2 "the hf forge" (item 4)
huggingface.co becomes a first-class forge kind → HF repos (models/datasets/
spaces) connect as workspaces; every existing repo tool (ls/tree, grep, read,
branches, commits, discussions, write, discover, clone) works with ZERO brain
changes (the stack is kind-agnostic downstream).

Files:
- NEW engine/internal/forge/hf.go — the adapter (all URLs verified live):
  * hfRepoInfo: GET /api/{type}/{repo} → RepoMeta (stars=likes, clone URL
    https://huggingface.co/[prefix/]{repo}.git, default branch main; access:
    token+own-repo (whoami, cached per Client) → full; token+readable →
    partial; public → read).
  * hfTree: GET /api/{type}/{repo}/tree/{rev}[/path] → TreeEntry[].
  * hfFile: GET {web}/{prefix}/{repo}/resolve/{rev}/{path} (follow redirects —
    the hub/hf.go FetchFile pattern; the /api/raw form 404'd in probes).
  * hfBranches: GET /api/{type}/{repo}/refs → branches[].name.
  * hfCommits: GET /api/{type}/{repo}/commits/{rev} → Commit[].
  * hfIssues/hfPulls/hfDiscussions: GET /api/{type}/{repo}/discussions
    (HF unifies them; filter by type issue / pull-request / discussion).
  * hfPutFile: the NDJSON commit API (reuse hub/hf.go CommitFiles shape,
    generalized to models/datasets/spaces).
  * hfCreateRepo + hfListUserRepos (author= listings across the three types).
  * Fork/Releases/Workflows/Licenses/Gitignores → ErrUnsupported (clean 502s).
- engine/internal/forge/forge.go — knownHosts += huggingface.co /
  www.huggingface.co / hf.co → "hf"; Recognize: parse the repo TYPE from the
  path (datasets|spaces prefix; bare = model), strip trailing junk
  (/tree/…, /commit/…, /resolve/…, /blob/…); HostInfo.HFType field.
- engine/internal/forge/client.go — dispatch: "hf" cases (RepoInfo, Tree,
  File, Branches, Commits, Issues, Pulls, Discussions, PutFile, CreateRepo,
  ListUserRepos; Search already falls back to engine Grep); NewClient: hf =
  plainClient (fixed host, like github).
- engine/internal/server/workspaces.go — globalToken("hf") → s.hfToken();
  wsClient: for kind hf, re-Recognize(w.RepoURL) for the type (meta.hf_type
  fallback); apiBaseFor; connectRepo + discover flows get the hf listing;
  clone handler: HF token injection (user:token@huggingface.co) if the
  github-style injection is kind-specific.
- UI: workspace kind badge for hf (🤗-style, theme-safe — same treatment the
  sandbox pill already uses) in the picker/lists (workspace.js / hub UI).
- NEW engine/internal/forge/hf_test.go — httptest fake hub: recognize cases
  (all 3 URL shapes + junk suffixes + bare host), tree/file/branches/commits
  mapping, NDJSON commit shape, ErrUnsupported set, access mapping.
- LIVE proof: connect ScoobyBaby1999/doomalaysocreate as a workspace (tree,
  read a file, grep, branches incl. legacy-2026-09, commits, discussions);
  explore a public model repo (no connect); write test on a throwaway scratch
  repo (create → put → read → delete via API).

Gates: go build/vet/test; the live proof; workspace e2e via the rig.

## PHASE 3 — v0.78.3 "the panel feel II" (item 2)
Kill every remaining full projection paint on interaction paths + the O(n²)
streaming render + virtualize the transcript. Target: scroll, taps, streaming
and drags are all motion-grade (CSSOM vars only); exactly one full paint at
gesture settle; long transcripts skip offscreen layout/paint.

Files (web/):
- theme.js —
  1. scroll: the capture scroll listener calls a scroll-motion handler that
     writes `--proj-sy` (scrollTop px) on the scrolling element — no mark().
  2. paint(): bake B relative to the scroll origin (rect + scrollTop at paint
     time) for elements inside scrollers; the anchor CSS subtracts
     var(--proj-sy, 0px) (same decomposition trick as --proj-tx).
  3. transition listeners: split property classes — transform/translate →
     motion(); true layout movers (width/height/top/left/margin/padding/
     font-size) → movingLayout; COSMETIC (background, color, opacity,
     border-*, box-shadow…) → return, paint nothing.
  4. observer classifier: strip `--panel-vis-h` alongside transform/translate
     (drag/spring/duck frames become motion-grade); add DoomProjection.settle()
     → one mark() after the spring completes.
  5. negative memoization: `__projNone` when backgroundImage === 'none'
     (invalidated by the same reset that clears __projPainted on theme swaps).
- gesture.js — call DoomProjection.settle() on spring/drag completion (the
  spot stopAll/dismiss already know the settle moments).
- app.js — tick(): skip renderGrid + DoomProjection.poke() while the chat
  panel covers the viewport (panel full/open state; the duck peek still
  paints). Keep icon/entity motion logic unchanged.
- chatpanel.js —
  6. two-tier streaming render: stableEl + tailEl; split at a safe markdown
     block boundary (last "\n\n" with balanced fences, ≥~80 chars back);
     boundary advances move newly-stable HTML into stableEl (postProcess
     that chunk once); each 180ms tick re-renders ONLY the tail; on
     assistant_complete the existing full render runs once (correctness).
  7. scrollBottom: rAF-aligned, only when near bottom.
  8. updateJump layout reads → rAF-throttled (one read batch per frame).
- index.html — `.msg` completed rows: content-visibility: auto +
  contain-intrinsic-size fallback; no hardcoded colors.
- NEW scripts/v078-panel-perf-test.py (Playwright+CDP, counters exposed on
  DoomProjection): scripted scroll → fullPaints==0; tool-pill tap →
  fullPaints==0; synthetic stream → stable container childList mutations
  stop after stabilization, tail-only swaps; drag → 0 mid-glide + 1 settle;
  visual VLM check: pills/bubble windows still aligned after scroll.
- Keep green: scripts/v074-panel-feel-test.sh, theme twins, uikit.

## PHASE 4 — v0.78.4 "the dock rework" (item 3)
- index.html —
  * NEW #dock-web (4th pill): filled globe glyph (Material "language" path —
    matches the cluster's filled style), fill var(--text-3), hover accent
    like siblings.
  * sizes: buttons 44 → 32px (≈1.37× smaller), icons 22 → 16px, radius 12 →
    16 (capsule ends at 32h), gaps 8 → 6, cluster margins 16 → 14.
  * hit-slop: ::after inset −6/−6/−6/−6 → ≥40px touch zones (the v0.77.1
    .app-switch pattern; keeps the Android floor).
  * strip moves UNDER the settings icon: top = gear-bottom + gap, right =
    gear's right edge, vertical column; the arrow stays beside the gear.
  * expand/collapse animation: transform + opacity only (translateY(-4px→0)
    + scale(0.98→1), ~150ms, visibility-gated) — motion-grade by Phase 3's
    classifier; arrow glyph rotates 90° when expanded (transform transition).
  * fix the stale #settings-btn aria-label ("Reset view" → "Settings").
- app.js — #dock-web → InAppBrowser.open(InAppBrowser.currentURL() ||
  'https://duckduckgo.com', {purpose:'web'}) (the omnibox's own engine; no
  Kotlin changes needed — open(url) + resume both work); keep #dock-* IDs +
  doomalay.dock.v1 persistence.
- tests: update scripts/v31-browser-test.py (4 icons, ≤36px visuals, ≥40px
  hit zones via elementFromPoint probes, animation states, persistence, the
  web pill opens the browser via a stub).
- VLM polish pass on the cluster (light/dark + an accent theme).

## SHIP
- Push per phase: v0.78.1-session-context, v0.78.2-hf-forge,
  v0.78.3-panel-feel-2, v0.78.4-dock-rework; wave tag v0.78.0 + release
  (rebase ritual first: fetch, diff latest APK/remote, merge amicably).
- Engine version bump to 0.78.0 at wave end. Watch CI attach the APK.
- Red-team as a real user each phase BEFORE its push (the rigs + live probes
  above; PM turn, brain turn, HF repo ops, scroll/tap/stream/drag counters,
  dock interactions, theme twins).
- Investigate the stray "v0.61.2-gh-armed" release (created recently, windows
  exe only) before creating ours — don't touch if it's another agent's.

## Explicitly NOT doing (anti-spaghetti)
- No brain/ changes (parallel bot's turf; the engine prompt covers the bot).
- No usage-event per-model attribution fix (usage.go:69-77 near-miss — noted,
  not this wave's ask).
- No Kotlin/PanelBrowserSheet changes.
- No new usage UI (the ask is the BOT knowing, not a new screen).
- No generic multi-scroller projection generalization beyond the chat
  scroller (ship the hot path; keep the code small).
