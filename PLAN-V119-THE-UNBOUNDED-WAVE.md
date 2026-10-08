# PLAN-V119 — THE UNBOUNDED WAVE

The user's five findings, one wave: the fetcher truncates (critically), public-repo
tools are gated behind bindings that serve nothing, the bot's replies replace or
append into the previous reply instead of flowing as sequential messages, and the
tool pills hide what actually happened (green pills show a naked arrow; results
truncate to fit the UI; no way to see what the bot saw).

**Name:** THE UNBOUNDED WAVE — nothing the system fetches is truncated, no tool is
gated unless the gate is the system itself, no reply lands in the wrong bubble, and
no result is hidden from the user.

**Version lane:** phases v1.19.1 → v1.19.5, ship record v1.20.0.
NOTE: PLAN-V118 is the TERMUX wave's sequel (termux workspaces + the jailed
MCP tools — the bot's declaration in the v1.18.0 ship record); its lane owns
v1.18.1+ and the v1.19.0 ship record. This wave takes v1.19.x and ships v1.20.0.
(The TERMUX ship v1.18.0 landed while this plan was being written — the lanes
stay out of each other's way by design.)

---

## Phase v1.19.1 — THE WHOLE TRUTH (engine fetch honesty)

The truncation map (measured, every site):

| Site | Cap today | Becomes |
|---|---|---|
| `llm.WebFetch(ctx, url, maxChars)` — web_fetch + bus web_fetch (mcpbridge ×2) | 12,000 chars out | FULL content; the maxChars parameter dies |
| `htmlToText(html, maxChars)` | 12,000 | FULL |
| `structuredFetch` (github/HF metadata) | `clampMaybe` | FULL |
| `fetchJSONAPI` / SERP LimitReaders (2–4 MB) | body ceiling | raised to the new network ceiling |
| workspace `read`/`readme` | `wsToolBodyCap` 6,000 | FULL |
| workspace `grep` | default limit 30, 60-row fold, 160-char line clip | unlimited default (param stays as a narrowing hint), full rows, full lines |
| workspace `tree`/`ls` | 60-row fold | FULL list (upstream `truncated` flag stays — honest signal) |
| workspace `pr_diff` | `wsToolDiffCap` 12,000 | FULL |
| `regex_extract` + local tools | `clampRunes` sites | FULL |
| deep-research per-page text | 4,000/page | FULL reads (the synthesis prompt is bounded by the SPEC-driven 92% guard — announced, not silent) |
| **every `tool_result` ChatChunk** | `clamp(text, 600)` — the pill data ceiling | FULL text (the pill's collapsed LABEL stays short; the data is whole) |
| forge network ceilings | file 4 MB / tree 16 MB / list 2 MB / diff 128 KB | 100 MB / 64 MB / 32 MB / 16 MB (upstream honesty: GitHub raw serves ≤100 MB; trees are 100k-entry/7 MB upstream — the `truncated` flag handles the rest) |
| forge grep skip | blobs > 512 KB skipped silently | threshold 8 MB + the skip is COUNTED and REPORTED |
| brain `agent_core.py` `_clip` | 4,000 chars on events | verified model-facing vs transport; uncapped where model-facing |
| template `show`/`list` | 5,000 / 2,500 | FULL |

LAW: **tool/transport data is never truncated.** The only honest size boundary in
the system is the SPEC-driven context guard (v1.14.1 LEDGER) — announced
pre-dispatch, never a silent cut. Prompt assembly may select; tools may not
truncate.

`ChatChunk` grows `Args` on `tool_use` (the raw argument JSON, unclamped) so the
viewer can show the query under the tool name. Events persist `{name, summary,
args, text}`.

Tests: the cap-free battery (httptest 2 MB body → full content; 100 KB workspace
read → full; 200-hit grep → all rows; the old constants' death pins) + all
existing suites green.

## Phase v1.19.2 — THE UNBOUND HAND (public repos need no binding)

Today every workspace verb dies with "no cloud workspace is connected to this
chat yet" — even `read` on a PUBLIC repo (the user's live repro: three refusals
on mark3labs/mcp-go). The gate moves from "a workspace is BOUND" to "the
operation needs a token":

- `ws` accepts `owner/repo` or any forge URL when nothing bound matches → an
  ephemeral tokenless client; the READ verbs (help/list/info/tree/ls/read/
  readme/grep/view) run against public repos anonymously.
- 404 → "private, renamed, or deleted" (anonymous cannot see private).
  403 rate-limit → named as GitHub's 60/hr anonymous ceiling + "bind a workspace
  token to lift it" (the one gate that is the system's).
- The WRITE verbs (put/pr/fork/issue_*/pr_*/discussion_*/workflow_dispatch/
  file_delete/release_create/create) still require a bound workspace — a token
  is genuinely required by the forge, so the gate is real, not vestigial.
- The system-prompt workspace manifest teaches the public-ref capability on
  unbound chats (the model must know `{"action":"read","ws":"owner/repo"}`
  exists before it falls back to raw fetching).

Tests: the ref-resolution matrix, the gate matrix (read unbound ✓ / write
unbound → exact teach text), and a LIVE probe of the user's exact repro
(mark3labs/mcp-go readme/ls/read through a running engine, no binding).

## Phase v1.19.3 — THE SEQUENTIAL FLOW (a reply is never rewritten)

The v0.93.3 round-segment machinery exists but not every runner obeys it:

- `runWebSearchTurn` + `runDeepResearch` emit NO `round_end` — their narration
  gloms into one bubble. They join the round contract.
- The PM bridge builds ONE `streamMsg` per turn — the browser loop's narration
  appends forever. Tool boundaries reset the segment.
- The HF sandbox → direct fallback seam streams two sources into one open
  segment. The seam closes the open segment before the fallback begins.
- Reproduce FIRST with the stub rig (the v1152 slow-stub speaks the PWA
  contract): a 3-round prose+tools turn must produce 3 ordered assistant
  events, replay-identical. Any rig conviction on the native loop gets fixed in
  the same phase.

## Phase v1.19.4 — THE FULL VIEW (the tool-result viewer)

- Green pills (`tool_result`) stop being a naked arrow: collapsed label = tool
  name + an honest short head (bytes or first words).
- Clicking a collapsed pill expands it (existing behavior, now with real
  detail since the data is whole).
- A redirect control next to the chevron opens the ConnectOverlay (the overlay
  screen law): tool name on top, the query/args under it, the FULL result
  rendered through the Formatter (markdown → Prism code cards), PAGED for
  large results with scroll — the user reads exactly what the bot read.
- Every color on `var(--…)` tokens (the pill audit says the pills already
  are; this phase pins it for the new surfaces too).

## Phase v1.19.5 (optional) — THE ONE PILL

Merge the blue (tool_use) + green (tool_result) pair into one pill per call if
the earlier phases land clean and effort remains. Skipped without regret
otherwise (the user's words).

## Ship v1.20.0 — THE UNBOUNDED WAVE ships

Full battery + live redteam (real keys, agent-browser through the real PWA),
buildinfo 1.19.0, the wave record, tag + release (the v1.14-era pipeline).

## Will-NOT

- No silent truncation anywhere — a size boundary that exists must be
  upstream's own honest signal (`truncated`, 413, rate limit) or the SPEC
  guard's announced verdict.
- No gate that the system does not require: tokenless operations run tokenless.
- No reply replaces or appends into a previous reply's bubble.
- No hardcoded colors in any new surface — the theme law holds.
- No new overlay surface outside the two ratified containers (the panel, the
  ConnectOverlay screen).
- The context window stays the model's physics: the guard announces, compaction
  compacts; the fetch layer never pre-fears on the model's behalf.
