# PLAN-V152 — THE SURGEON (the chat-honesty fixes + surgical editing + the autonomous push)

## 0. THE USER'S ASK (verbatim, distilled)

- "I've attached the trippy logs, u can read the ends to see if any new insight on issues
  with our chat. We want to fix as much issues with our current chat implementation before
  we build more. Defer the library ship once more. Not until we can have percise edits for
  artifacts and external and internal repos. We need an unbelibably solid tool for this.
  I'd recommend researching and integrating one that works for go and our app, maybe the go
  MCP community tools or another repo that has something of the sort."
- "We need the bot to be able to seamless push from its local repo to the cloud repo using
  our strict push philosophy on its own. You can review and make sure it's implementation
  is solid, but please for this test have it push the botton it created as a sub wave x.x.#
  completely on its own. It should do so with no hiccups and with extreme ease, no
  overthinking needed. Due to the provided tools we offer it, same with the ability to edit
  repos and files and trees surgically."
- The permanent law (the generic prompt): initial plan/hypothesis → web search → real plan →
  build → revise/test/redteam with real tests as a real user.

## 1. INITIAL HYPOTHESIS (before research)

The (2).md trippy log (Oct 21, glm-5.3-flash @ nvidia, 128K window, 13 user / 124 tool
events, 700K tokens in) convicts FIVE new issue classes beyond v1.50's fixes:

1. **Engine restarts kill turns mid-flight** — "interrupted by engine restart" 2×; the
   final working turn died at seq 9542 mid-thinking, RIGHT AFTER deciding its plan
   ("Decided. Block 1 now.") — 5,600 events of work, zero durable output. The user's
   words: "I asked for very simple requests and nothing was done."
2. **Failed sends re-persist the user message** — the same user message appears 5× in the
   log (each DNS failure → new user row). History bloat + a broken-looking transcript.
3. **DNS failures are terminal, not transient** — `netx: no address for
   "integrate.api.nvidia.com" (system resolver and DNS-over-HTTPS both failed)` → instant
   raw-JSON error, zero retries, while the pause ladder exists for every OTHER net class.
4. **The 600s termux exec black hole** — one exec burned the full 10-minute budget with no
   output (an on-device go build on FUSE storage); the model sat blind.
5. **The workspace tree flood** — a 1459-entry repo listing = 69,775 bytes, issued 3×
   (≈210KB of context) because the listing shape is a raw recursive dump.

Plus the tooling gap that gates the library ship: **no surgical edit verb exists** — the
workspace tool writes whole files only (`put`), so a one-line change to a 145KB file means
reading and PUTting all 145KB (the exact wall the v1500 rig B model hit).

## 2. RESEARCH (the law: before any build)

### 2.1 The (2).md log tail — the bot's own self-diagnosis (read in full)

The final turn (the user's "diagnose yourself" ask) maps the JSON event ledger:
- 8,545 thinking events (457KB), 47 tool_use / 45 tool_result (TWO UNPAIRED — the restart
  kills), 5× the same user row, 6 error rows, 20 status rows.
- The gaps: +248s, +605s (the exec timeout), +230s, +65s, +120s… the device was starved
  (load average 14.35).
- The 3× 69KB tree flood; truncation markers on the termux exec pills; the two DIVERGENT
  copies of agent_core.py in the repo (165,354 vs 165,722 bytes, different blob shas —
  `engine/internal/hfzero/brain/agent_core.py` vs `brain/agent_core.py`).

### 2.2 Code survey (every site verified file:line — see worklog)

- **Restart-heal** (`server.go:230 healInterruptedTurns`): appends ONLY a terminal
  `status error healed` — nothing is resumed; a dangling `tool_use` (no result) is
  silently DROPPED by `foldSlots` (toolfold.go:69 — the `pending` list is never flushed):
  the model's history loses even the knowledge that it made the call.
- **Send path** (`chat.go:1312 handleTurn`): user event persisted at :1412 BEFORE the
  stream; the busy-reject (:1377-1392) re-persists the user row on EVERY rejected send;
  `chatclient.js:159` replays queued frames verbatim on reconnect.
- **Error UX** (`llm/chat.go:2563 isTransientNetErr`): the regex has NO DNS class —
  `no such host` / `no address` / `lookup` never match → DNS death is a terminal error,
  the ladder never runs. `chatpanel.js:2624 friendlyError` has no DNS/offline class →
  raw Go transport strings render verbatim.
- **Termux exec** (`termuxtool.go` + `termuxstreamrun.go`): the v1.23.3 live stream EXISTS
  (0.5s tail|curl chunks → `tool_stream` WS events) — but the model itself still sees
  nothing until the tool_result lands (one-shot physics); the 600s budget message already
  points at `session_start` for long jobs.
- **Workspace tree** (`workspacetool.go:143`): `tree` = ONE recursive GitHub call, the
  WHOLE repo, upstream-truncated only at 100k entries / 7MB; no summary shape, no paging.
- **Edit verbs**: NONE. `put` (whole-file) only. The forge client has branches / PR /
  merge(method) / tags / releases but NO multi-file commit, NO patch, NO sync awareness.

### 2.3 Web research — the surgical-editing state of the art (verified from sources)

- **The industry pattern is search/replace blocks applied in-memory, then whole-file
  write** — Claude Code's Edit (old_str must match exactly once, `replace_all` opt),
  the official MCP filesystem server's `edit_file` v2.0.0 (`edits: [{oldText, newText}]`,
  `dryRun` preview, whitespace normalization + fuzzy matching with confidence scoring),
  Aider's search/replace blocks. Unified-diff/apply_patch (Codex) is the minority pattern
  and is brittle to line-number drift from LLM output.
- **go-git (v5.19.3 / v6.0.0-beta.1)**: rebase ❌ unsupported, three-way merge ❌ not in
  any release, pull = fast-forward only → we build NOTHING on go-git's merge; the
  strict-push safety comes from the GitHub ref-update fast-forward guard instead.
- **GitHub git data API** (REST docs verified): `POST /git/trees` with `base_tree` +
  inline `content` per entry (blobs optional) + `sha: null` = delete → `POST /git/commits`
  (tree + parents) → `PATCH /git/refs/heads/{branch}` with `force:false` = THE
  fast-forward guard (422 when the remote moved = our rebase alarm). The contents API PUT
  409s on a stale blob sha (the single-file guard).

### 2.4 The design that falls out (the recommendation, applied)

(a) exact-match search/replace blocks, softened (exact → whitespace-flexible → honest
    failure with nearest-context diagnostics), dry-run diff preview;
(b) multi-file ONE-commit via the git data API with the ff-guard ref update;
(c) NO go-git merge/rebase — the strict push philosophy rides API-side optimistic
    concurrency + a sync verb that makes "behind / overlap" visible BEFORE the push.

## 3. THE REAL PLAN (the phases)

Version law: buildinfo stands at 1.50.0 → this wave's phases are v1.52.1-v1.52.7, the
ship is v1.52.0 (renumber past whatever stands at SHIP time — parallel waves exist).

### v1.52.1 THE DNS RUNG (the transient class + the friendly face)

- `llm/chat.go isTransientNetErr`: add the DNS class — `no such host|no address|lookup
  |dns|server misbehaving|SERVFAIL|connection lookup failed` → DNS death rides the pause
  ladder (1.5s→3s→15s→30s→60s rungs → the 2-min provider hold → the suspended mode that
  waits for the network) instead of an instant terminal error.
- `chatpanel.js friendlyError`: the DNS/offline class — "Network trouble reaching
  <provider> — DNS couldn't resolve it. The engine auto-retries; tap Continue when you're
  back online." (the continue affordance, never retry).
- Test: the EXACT trippy error string from the (2).md log feeds the matcher (unit) + the
  compressed-ladder rig (DOOMALAY_NET_LADDER_WAITS) proves retry-not-terminal.

### v1.52.2 THE NO-DUP SEND (the 5× user row dies)

- `chat.go handleTurn`: a send whose text is IDENTICAL to the last user row, where the
  turn after it FAILED (terminal status error, no assistant content) = a CONTINUE in
  disguise — dispatch the continue path, persist NOTHING. The 5-tap storm becomes 1 row +
  4 silent resumes.
- The busy-reject: when the in-flight turn's persisted user text equals the incoming
  text, DON'T re-persist the row (error + terminal only — the text is already in the log);
  a different text keeps the v0.44 honest persist.
- Test: rig drives send → forced failure → same-text send ×4 → the user event count in
  the session JSON stays EXACTLY 1; the 5th different-text send persists normally.

### v1.52.3 THE HEALED SEAM (restart-killed turns become continuable + honest)

- `server.go healInterruptedTurns`: after the healed terminal, synthesize a
  `tool_result` for every dangling `tool_use` in the interrupted turn —
  "interrupted by engine restart — this call never ran; re-issue it if still needed" —
  so (a) the model's history carries the truth (foldSlots pairs it instead of dropping
  the call), (b) provider wires stay valid (every tool_use answered).
- The healed status carries `"hint":"continue"` and the frontend renders the restart
  bubble with the continue affordance (the composer's 4th mode already arms on a trailing
  error — verified chatpanel.js:754).
- Test: rig kills the engine mid-tool-call → reboot → the session JSON shows the
  synthesized result; continue produces new content; the dangling call rides history as
  an answered pair.

### v1.52.4 THE HONEST TREE (the 69KB flood → the summary shape)

- `workspacetool.go tree`: when the recursive listing exceeds a threshold (default 200
  entries), the DEFAULT output becomes the DIR SUMMARY — top-level dirs with per-dir file
  counts + aggregate sizes, plus the immediate children of `path` — with a one-line hint
  ("tree with {\"path\":\"…\"} narrows; {\"recursive\":true} returns the full listing").
  NOT truncation (the law): a smarter default VIEW; the full recursive listing stays one
  explicit call away. `ls` (one level) is unchanged.
- Test: unit (a 1459-entry fake tree renders as a ~30-line summary, zero entries hidden
  from the count math) + rig (the model's first tree call on the real repo comes back
  compact; it narrows with path — no 3× flood).

### v1.52.5 THE BLADE (the patch verb — surgical search/replace)

- NEW `engine/internal/server/edits.go`: `ApplyEdits(content string, edits []EditSpec) (
  newContent string, report []string, err error)` — per edit: EXACT match first; then the
  whitespace-flexible match (indentation-insensitive line matching with re-indentation of
  the replacement to the match's indent); multiple occurrences → honest count error
  (offer `all:true` or `occurrence:N`); not-found → the nearest-context diagnostic (the
  closest line(s) by similarity + the edit index). `DiffPreview(old, new)` renders a
  unified-diff-style preview (minimal hand-rolled LCS on lines — no new dependency).
- Workspace verb `patch`: `{"ws", "path", "edits":[{old,new,all?,occurrence?}],
  "message"?, "branch"?, "dry_run"?}` — fetch the file (full, the law), apply, and:
  dry_run → the diff preview + the match report, NO commit; else commit the WHOLE edited
  file via the existing PutFile path (the 409-stale-sha guard already there).
- Termux verb `patch`: the SAME ApplyEdits engine on a local file
  (`{"path","edits",...}` — read → apply → write; dry_run preview). One engine, two
  surfaces (the OOP law).
- The tool help text teaches the shape (the model-facing contract).
- Test: unit table (exact / fuzzy-indent / multi-count / not-found-near-miss / all /
  occurrence / dry-run) + rig (a real model patches a repo file through the app with NO
  whole-file read of the 145KB monster — it reads a RANGE, patches, the diff lands).

### v1.52.6 THE ONE COMMIT (multi-file surgical commit — the seamless push core)

- Forge GitHub adapter: `CommitFiles(ctx, branch, message, files []FileEdit, tok)` via the
  git data API — resolve the branch head (auto-create from the default branch when
  missing, the v0.76.5 law), `POST /git/trees` (base_tree=head's tree; per file: inline
  `content` for writes, `sha:null` for deletes; renames = write-new + delete-old in one
  entry pair), `POST /git/commits` (parents=[head]), `PATCH /git/refs/heads/{branch}`
  `force:false` — a 422 is the honest "the remote moved — re-read, re-apply" answer (the
  strict-push law; NEVER force).
- Workspace verb `commit`: `{"ws", "files":[{path, edits? | content?, delete?, rename_from?}],
  "message", "branch"?}` — each file: fetch (only when `edits` present), ApplyEdits, then
  ONE atomic commit. The observation reports the diff summary per file + the commit URL +
  the next-step hint (pr / pr_merge rebase).
- Test: unit (adapter against a stubbed transport: tree/commit/ref call shapes + the 422
  guard) + rig (a real model lands a 3-file one-commit change through the app; a
  concurrent-push simulation convicts the 422 path with the honest re-apply answer).

### v1.52.7 THE SYNC EYE (the rebase awareness — the strict push philosophy, visible)

- Workspace verb `sync`: `{"ws", "branch"?, "base"?}` → (a) does the branch exist; (b) the
  commits on base the branch is BEHIND (list); (c) the files changed on base since the
  branch point; (d) the OVERLAP between those and the branch's own changed files (the
  conflict forecast); (e) the guidance: no overlap → `pr_merge` with `method:rebase` is
  safe; overlap → re-branch from base and re-apply the patches (the surgical edits
  re-apply cleanly unless the same regions changed).
- Test: unit (stubbed forge: behind/overlap/forecast shapes) + rig (the bot runs sync
  before its push, gets "0 behind / no overlap", proceeds; the overlap path returns the
  honest forecast).

### THE PROOF (scripts/v1520-surgeon-rig.py — real engine + real browser + REAL models)

- RIG A (chat honesty): the DNS string → ladder retries (compressed), terminal ONLY after
  the ladder; the 5-tap same-text storm → user rows stay EXACTLY 1; the engine killed
  mid-tool-call → reboot → synthesized tool_result + continue produces new content.
- RIG B (the blade): a real model (Nvidia glm-5.3-flash through the app's composer, the
  in-app key) performs a surgical patch: reads a RANGE, patches with edits[], dry-run
  first, lands the commit; the GitHub diff shows EXACTLY the surgical change.
- RIG C (THE GLOW PUSH — the final test, the user's own words): the bot pushes its glow
  feature (the v1500 rig B design: the connect-workspace pill's accent glow when no
  workspaces are connected — `#wsx-connect` / `.wsx-conn` / the `wsx-glow` keyframe / the
  `data-empty` attribute) as a sub-wave x.x.# COMPLETELY ON ITS OWN: it reads the repo
  state + the worklog's version law, decides the number, patches the app files + buildinfo
  in ONE surgical commit, syncs (the rebase check), pushes, and the push lands on GitHub
  with no hiccups. I review the result but do NOT touch its push.

### SHIP v1.52.0

- buildinfo bump (renumber past whatever stands at ship time), README section (the wave
  in one breath), the rig's verdicts recorded, the worklog entry, rebase-before-push per
  the multi-agent protocol, then push.

## 4. THE LAWS THAT BIND THIS WAVE

- The full-return law (v1.19.1 / v1.50.1): nothing is ever cut mid-content; the tree
  summary is a VIEW, the full listing one explicit call away.
- The continue-only law (v1.50.5): no retry surfaces anywhere; the DNS failure's answer
  is the ladder + continue.
- The strict-push law: rebase-awareness before every push (sync), optimistic-concurrency
  guards during (409/422, never force), the honest re-apply answer after.
- The OOP law: ONE edit engine (ApplyEdits) behind every surface (workspace patch, termux
  patch, commit's per-file edits).
- The theme law: zero hardcoded colors (the glow the bot pushes rides the EXISTING accent
  variable — the v1500 design already does).
- The version law: never trust a reservation; renumber at ship time past whatever
  buildinfo stands.
