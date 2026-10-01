# PLAN-V0913 — Phase 3: the Python Library, the topical tags, THE SPACE'S FACE

The tail of the user's 4-issue prompt (Issues 1–2 already landed: v0.90.4 the
stretch fix, v0.91.2 the color rework Phase 1). This wave finishes:

- **Issue 2** — Kronos bundle tags (`#readme` → finance/stocks/prediction) +
  python scripts as a library category (weak models must run them 100%)
- **Issue 3** — superpowers `#docs`/`#scripts` vague tags → real ones
- **Issue 4** — the Space's page must show THE GAME, not the JSON blob; the
  work must be done by the HF chat (enhanced capabilities); chatlog attached

## Research findings (this session)

- **HF official docs (spaces-overview)**: "Each time a new commit is pushed,
  the Space will automatically rebuild and restart." → committing the updated
  template + `public/index.html` to the Space repo is THE persistence + deploy
  mechanism, one atomic flow.
- **Why the game vanished**: it was written to the ephemeral public root
  (`/tmp/doomalay-public` on free Spaces — `/data` is never mounted there);
  the Space restarted (sleep/rebuild) and wiped it. Root cause of "I only see
  JSON metadata": (a) the root route served the info blob unconditionally,
  (b) nothing persisted the agent's work.
- **The space gate**: `OPEN_PATHS = {"/", "/health"}` — the root is already
  open; serving the game there needs no auth change.
- **The agent's hand**: brain `hf publish [path, repo, repo_type, …]` can
  commit files into any repo the per-turn `DOOMALAY_HF_TOKEN` (fanned out by
  the engine from the vault) may write — including its own Space.
- **Deep-research tags**: already meaningful (`research/web/citations/
  multi-stage`) — no vague tags there; no action needed (verified live).

## Phase A — v0.91.3: the Python Library + topical tags (WIP → verified → landed)

State: code done (engine `hub.go` python LibrarySpec, `skills.go` dispatch
line, `hub_test.go` 5→6, brain `dt_hublib.py` type+label, `kronos-corpus.py`
TOPICAL+PY_SCRIPTS); live datasets already committed (kronos 16 items with 6
python + topical tags; superpowers retagged: docs→agent-skills/methodology,
scripts→automation/tooling).

1. Rebuild engine from the WIP tree (binary==source parity; strings-check
   "Python Library" + "doomalay-python").
2. Run `scripts/v0913-python-library-test.sh` — 5 checks: registry 6
   libraries, the 6 live Kronos python items with teaching descriptions
   (RUN: lines), the kronos bundle tag row (finance/prediction/markets,
   #readme gone), the superpowers tag row (#docs/#scripts gone), a real .py
   payload serving.
3. `go test ./...` + the brain test tree (dt_hublib + pub route).
4. Real-user UI pass (agent-browser): the hub page renders the Python
   Library tab; the kronos bundle card shows the topical tags.
5. Commit `feat(v0.91.3)` — python library + tags + the corpus/tag-surgery
   tools + the rig.

## Phase B — v0.91.4: THE SPACE'S FACE (template code)

State: code done (brain `server.py` persistent public root — env → /data →
**repo public/** → /tmp ladder; template `app.py`/`docker-app.py` root route
serves the published index.html, JSON blob only when empty; HARNESS.md
teaches the persistence pattern).

1. Pin the root-serving contract with tests (template root serves
   published index; falls back to JSON when absent; the pub-route tests
   stay green — extend `test_pub_route.py` + the Go template tests if they
   exist for /).
2. Commit `feat(v0.91.4)` with the brain re-sync (embed parity).

## Phase C — the final-test Space: new template + THE GAME via the HF chat

1. **Update the Space** (ScoobyBaby1999/doomalay-final-test): HF-API commit
   of exactly the 4 changed files (app.py, brain/server.py, brain/HARNESS.md,
   brain/tools/dt_hublib.py) → automatic rebuild (research-confirmed).
2. Verify: /health 200, root = JSON (empty public root), the new code live.
3. **THE HF CHAT TURN** (the user's explicit requirement — the chat does the
   work): boot engine + app, open the HF chat bound to the Space, send THE
   ASK: rebuild the evolution game (3 dot species — GREEN immortal, BLUE
   must eat GREEN ≤20s, RED must eat BLUE ≤20s; chase/flee; spawn buttons;
   live counters; starvation countdown rings; beautiful + smooth) and
   **publish it PERSISTENTLY**: write `index.html` in the workspace, then
   `hf publish` it to `public/index.html` of the Space repo (repo_type
   space) — the HARNESS.md persistence path; then verify the Space root.
4. Watch the transcript (the v0894 watch pattern; the ask is focused —
   expect well under the 2.2h/35-call marathon of last time).
5. **Real-user verification**: open the Space URL in the browser → the game
   renders at the ROOT; play it (spawn all three species; greens immortal,
   blues starve out, reds sustain; countdown rings animate); screenshot.
6. **PERSISTENCE PROOF**: restart the Space → rebuild → the game STILL
   serves at the root (the entire point of v0.91.4).
7. **Chatlog**: export the chat session transcript →
   `/home/z/my-project/download/` + link the Space URL in the reply.

## Phase D — closeout

1. Engine version → 0.92.0 (wave completion chore), binaries rebuilt.
2. Final sweep on the merged tree (v0913 + go test + a canvas/color spot
   check — the stretch + color fixes stay intact).
3. Rebase check vs origin (parallel bots), push, tag
   `v0.92.0-phase3-complete`.
4. Worklog + user summary with the Space link + chatlog path.

## Red-team notes / risks

- **Zombie ports**: every rig takes a fresh port + proves child ownership
  (ss pid match) — the v0892 lesson.
- **SSE relay ~2h death**: the focused ask keeps the turn short; the
  never-lose-content nets from v0.77.5 + v0.81.7 hold the final answer.
- **The agent writing to the ephemeral root**: HARNESS.md + THE ASK both
  insist on the `hf publish` repo path; the persistence proof (restart)
  catches any cheat — if the game dies on restart, the turn failed.
- **Model choice**: kimi (privatemode) drove the v0.89.4 marathon fine;
  fallback to glm (nvidia) if a turn dies early.
- **Weak-model reliability (Issue 2's goal)**: the python items' descriptions
  each teach the run (deps + weights + command); the hublib dispatch line
  teaches save-and-run. A follow-up probe may drive a WEAK model through
  one kronos python item if budget allows.
