# PLAN — v0.62 HF SPACES PICKER + WORKSPACES PROVIDER REDESIGN

User request (6 items) → 3 phases, one push per phase (protocol: every phase = a push).

## Phase 1 — the +sandbox picker & the HF Space redesign (items 1+2)
**sandboxpicker.js** (web):
- Quick Chat card: description REMOVED (title-only card).
- HF Space card: new small-text formatted description (subtle/accent colors):
  "Linux sandbox, ephemeral. Access to bash, python, java, package installs. Your own
  personal ZeroGPU space running on dynamically allocated resources." + detail rows
  (2 per free tier · 1 GB storage · sleeps by usage · wakes ~1 min · installs ephemeral).
- HF card carries a LIVE mini pill: "HF login required" / "✓ HF connected" (fetch /api/hf/account).
- Press HF card: NOT logged in → HFConnect.openConnectPanel (onDone → re-open picker state).
  Logged in → THE REPURPOSED OVERLAY:
    - scrollable list of the user's spaces (stage badges, managed mark)
    - bottom row: ＋ create new space pill → inline name input + Create → in-app progress
      (watchBuild inline; quota/PRO errors shown IN the app, never leaving it)
    - footer: a small search-bar-looking pill (input + connect button) — paste a public
      space URL → recognize → connect → use (sandbox hf, mode public)
- REMOVED: openHFChooser 3-card screen, community Docker card/flow, renderZero page,
  renderShared, renderQuotaPaused, renderPick (its list becomes the overlay body).
**engine**:
- /api/hf/spaces?all=1 — list ALL the user's spaces (skip IsDoomalaySpaceName filter).
- sandbox_mode "public": remoteBrainFor builds NewSharedRemoteBrain(repo, SpaceURL(repo), hfToken, env)
  (public spaces accept HF-token auth like the shared one — mode public = shared auth + own repo).

## Phase 2 — workspaces picker polish + back-nav (items 3+4)
- Reproduce the back bug live (agent-browser) → fix (connect page must POP to the picker).
- Picker: empty state → simple "nothing here yet…" (no large description text).
- The pinned ＋ connect workspace row: proper theme gradient pill.

## Phase 3 — the connect overlay + provider redesign (items 5+6)
**Connect overlay (2nd screen)**: "connect any repo" pill at the TOP, contents formatted/
polished, everything (incl. gradients) theme colors; my repos REMOVED (stays: connect any
repo → cloud form, create new repo, device storage, local folder coming soon).
**Picker (1st screen = THE REDESIGN, library-like)**:
- Top: provider pills grid — GitHub (default), Gitea, GitLab, Sourcehut, Self-Host — big,
  polished, each a different color; the overlay's colors SYNC to the selected provider
  (scoped --wsp-* RGB vars per provider).
- Under the pills (GitHub selected):
  - sign in button → reusable GHConnect panel; signed in → "✓ logged in — @user" text
  - ＋ create new GitHub repo pill (create form, kind-aware)
  - connect / use a public GitHub repo — URL paste + connect/fork
  - SCROLLABLE box: the user's repos (discover, kind-aware); under each repo the
    read-only / partial·fork·PR / full access pills GLOW (active) / unglow (dim) per the
    repo's permissions; tap a row → repo detail (entire repo | pick branches — the old
    HF-space-style flow, existing openRepoDetail)
- Gitea pill: same section, gitea naming + colors + kind=gitea API calls.
- Self-host pill: instead of login → device storage location / local folder.
- The global connected workspaces list (bind/unbind rows) stays below the provider section.

## Verification per phase
- go build + go vet + go test ./... (EXIT=0 explicit, never piped)
- node --check on changed JS; engine REBUILD after web edits (go:embed!)
- agent-browser live: 412×915, engine :8080, HF token connected; exercise every flow
- git commit + push + tag v0.62.N + release (check used numbers first)
