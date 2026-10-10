# PLAN-V122 — THE MIRROR WAVE

The polish wave: the user sees (and edits) everything the bot is fed; the capabilities
list shrinks to what is real; the Termux setup shows its pulse. Three phases:

- **v1.21.2 THE CLEANSING** — capabilities library shrinks to the real gates.
- **v1.21.3 THE PULSE** — the Termux setup progress bar (ASCII, theme-colored).
- **v1.22.0 THE MIRROR** — the Preamble system: the prompt furniture becomes a
  portable, editable, optional persona-metadata block. Ship record.

---

## §0 THE DESIGN VERDICT (the user's direct question)

**Split — agreed.** One persona is the wrong shape for this, for four reasons:

1. The 8 prompt components are two different KINDS of text. Identity/Style/Rules are
   VOICE (prose, human-authored, stable). Repo access / artifacts / library / controls /
   session are MACHINERY (dynamic blocks the app owns, changing every turn). One blob
   forces the user to edit machinery prose to touch their persona's voice.
2. Portability: a published persona carrying our app's controls ledger is garbage in
   another app. A persona that is pure voice + a separate optional preamble travels clean.
3. The placeholder vocabulary keeps the bot live-informed NO MATTER how the user rewrites
   the preamble — {session} always expands to the live dashboard, so edits can't stale the bot.
4. Optional + disableable keeps the lean-prompt escape hatch (power users, tiny models).

Industry pattern check (research): SKILL.md / Agent Skills (frontmatter name+description
+ markdown body), Agent-Flavored Markdown (YAML front matter + markdown component),
AGENTS.md (runtime-agnostic markdown). The preamble adopts exactly this shape: a .md file
with light frontmatter + a body written in placeholders. Portable by construction.

**What stays intentionally engine-side (the "intentionally hidden extras"):** the
turn-level payloads — the attached-bundle manifest and the METHOD TEMPLATE brief (transient
turn attachments, already visible in the UI's own pills), and the tool-result teachings
(workspace help, skills bootstrap) which are tool OUTPUTS, not prompt furniture.

---

## §1 v1.21.2 THE CLEANSING (capabilities + lib unification)

UI (capabilities.js):
- REMOVE rows: web_search, deep_research, skills_auto, template_auto (+ their flipToggle
  branches; + header comment refresh).
- KEEP rows: lib_auto (the one library gate) — flips ONLY libAuto now (the server stamps
  the legacy flags; no client lockstep needed).
- ROW ORDER: Web Library (🛠 lib) first, Workspaces second, Termux third, PERSONA LAST.
- Persona row: sub reflects the ACTIVE persona name, falling back to the DEFAULT persona's
  name ("Default") when none is set — resolveActive already returns the chain; add the
  default-name fallback + chip always "set".
- Termux sub: "local Linux sandbox (commands, package installs, local storage)".
- Workspaces sub: "repositories and sandboxes connected to the chat".

Wiring (chatpanel.js / tweaks.js):
- persistCaps: stop sending web_search + deep_research (web search is always-on now;
  deep research is a library card). Keep sending lib_auto (+ template_auto/skills_auto as
  the lib OR for old-engine compat).
- Delete DEAD CODE: segPill + segPlusLabel (chatpanel.js:3661-3739, 3376-3389 — zero callers).
- THE SYNC GAP (agent-verified): tweaks setBox('botLib') PATCHes but never repaints the
  toolbar lib pill; syncLibPill never repaints an open view. FIX: setBox botLib now also
  state-updates + fires `doomalay:caps-changed` on document; chatpanel listens and
  re-renders the toolbar for the active chat. Capabilities flips already repaint via
  ctx.rerender; the tweaks switch re-reads state on every open (fresh view push).
- runWSTurn + chatclient.js: stop sending web_search/deep_research turn overrides.

Engine:
- sessions.go POST: birth default WebSearch=TRUE when omitted (web search always on).
- PATCH handler: UNCHANGED semantics (lib_auto stamps the three — the unified gate; the
  else-if re-derivation stays for old clients). DeepResearch/WebSearch fields stay stored
  (old sessions + API compat; no UI writes them anymore).
- chatMetadataPreamble (chat.go:361): the web-search line stays (true); the deep-research
  line drops the stale "(armed via the lib pill's +…)" text → honest "currently OFF" only
  when the stored flag says so.
- PM path (chatpanel.js:2541-2558): drop the deep-research 8-stage head (the library card's
  METHOD TEMPLATE brief covers it).

Deep research's new home: the library card ALREADY EXISTS — hub builtin
`doomalay/builtin/deep-research` (8-stage methodology) + brain DEFAULT_TEMPLATES "Default
Deep Research". The capability row dies; the card remains the publication. No new content.

Tests: node rig (rowsFor shapes, flipToggle surface, persistCaps payload shape, the
caps-changed event), Go test for the birth default.

## §2 v1.21.3 THE PULSE (termux setup progress bar)

termuxsetup.js — a bottom bar mounted between `.tsx-steps` and `.tsx-foot`:
- ASCII bar: `[███████▋░░░░░░░░] 47% · step 2/4 · bootstrap` — Unicode blocks with the fractional
  tip characters (▏▎▍▌▋▊▉) so 4 steps render as 20 smooth cells; braille spinner
  (⠋⠙⠹⠸⠼⠴⠦⠧) while a probe/act is in flight; theme vars ONLY (--accent-rgb fills,
  --surface-2 track, --text-3 label). monospace font (the bar is ASCII art).
- Fraction = weighted ladder: ① installed ② bootstrap_done||props_ok ③ permission
  ④ ready — matches _stepStates exactly (one source of truth; the bar derives FROM the
  same steps array, no second implementation).
- While any act/probe is in flight: spinner + "checking…"; on probe_suppressed: the bar
  idles with the paused note (the quiet gate honesty — no fake motion).
- THE SAFE-TO-LEAVE NOTE (true by design — verified): the bootstrap runs in Termux, the
  engine keeps the state, the quiet gate holds, and the capabilities row re-probes on
  onExit. Bar caption: "you can leave the app — setup keeps running; this page catches up
  when you return." Rendered once step ② is the active step (the leave-to-Termux moment).
- Ready state: the bar fills to 100% + the existing readyHTML swap.

Tests: node rig on the bar renderer (pure fn: steps → {cells, pct, label}), the spinner
frames, the caption logic; the existing tsx test surfaces stay green.

## §3 v1.22.0 THE MIRROR (the Preamble system)

### The format (portable)

```markdown
---
name: Doomalay briefing
description: The app briefing — what this chat can reach and its live state.
placeholders: model, provider, name, date, repo_access, artifacts, library, controls, session
---

You are {model}, hosted via {provider}, chatting inside the Doomalay app on the user's
own device. Today is {date}.

{repo_access}

{artifacts}

{library}

{controls}

{session}
```

- Frontmatter: name + description + placeholders (self-documenting; the skills precedent).
- Unknown {keys} expand only via the existing custom-placeholder machinery or stay literal
  — a foreign app can strip or substitute them (AGENTS.md-style runtime-agnosticism).
- Download: `<slug>.md` with the frontmatter. Publish: hub type `preamble` (.md).
- Import: tiny frontmatter parser (name/description/placeholders) + body.

### The placeholder vocabulary (new reserved keys, expanded at turn time)

| key | expands to | source |
|---|---|---|
| {date} | "Saturday, 10 October 2026" | time.Now, engine + JS twin |
| {repo_access} | workspace manifest (PUBLIC REPO ACCESS / CONNECTED CLOUD WORKSPACES) | workspaceManifestFor(sess) |
| {artifacts} | the artifact protocol block ("" when the active persona already teaches artifacts) | artifactSystemPrompt const |
| {library} | the Doomalay Library section + [Live library state] line | libraryPreamble + libStateLine |
| {controls} | "## This chat's controls" ledger | chatMetadataPreamble |
| {session} | "## Your session (live)" dashboard | sessionContextPreamble |

Plus the EXISTING vocabulary ({name}/{model}/{provider}/{skills}/customs) via
substituteAllVars — unchanged. The placeholders view + reserved-key lists gain the new
builtins (both engines + JS twin).

### Composition (the new systemPromptForMetrics)

```
[turn payloads stay llm-side prepends: METHOD TEMPLATE, bundle manifest]
preamble (expanded)  ← default / custom / OFF
persona (voice)      ← resolveActivePersonaMerged chain (unchanged)
```

- Preamble FIRST, persona SECOND — the machinery briefs above; the voice lands closest to
  the conversation. The identity LINE folds into the default preamble's first sentence
  (editable like everything else).
- preamble_sel: '' = app default · 'off' = disabled · '<id>' = a saved custom.
- OFF = pure persona turn (the lean prompt). The default personas already carry identity
  via {model}/{provider} substitutions, so OFF stays honest.
- The artifact-skip rule survives: when the active persona text contains "artifact",
  {artifacts} expands to "" (no duplication).
- The llm-side workspace prepend FOLDS into {repo_access} — the server stops setting
  ChatRequest.WorkspaceManifest on the direct path (the field + prepend stay for any
  other caller; no duplication).
- The {skills} stub stays a stub (documented; a future wave may wire it).

### Storage + API (mirror the persona machinery)

- `chat_sessions.preambles TEXT` (JSON array of {id,name,text}) + `chat_sessions.preamble_sel TEXT`
  ('' default / 'off' / id) — the v0.26 migration idiom; store struct + SELECT/UPDATE lists.
- PATCH /api/sessions/{id}: `preambles` (JSON string) + `preamble_sel` keys.
- The DEFAULT preamble is NOT stored — the engine composes it live from the same block
  builders (always in sync with the app). The UI shows it as a locked "Default" row;
  "duplicate" copies it into the chat's list for editing.

### UI (persona.js, reusing the persona machinery)

- LIST view: a "Preamble" row UNDER the placeholders row (the user's spec) —
  sub shows the active selection ("default" / name / "off").
- Preamble panel (same master-panel stack): enabled chip (on/off) + rows (Default locked,
  customs, + add) + editor twin: name input, CodeMirror body, action row
  (save · ↺ default · ⇩ .md · ⇧ publish · delete) — the persona editor's exact action set.
- Tap a row = select it for this chat (one-tap, persona idiom). Save/persist rides the
  SAME PATCH (preambles + preamble_sel join the personas/placeholders body) + the same
  doomalay:persona-saved broadcast so every open chat re-hydrates.
- Hub: Register(LibrarySpec{Type:"preamble", PayloadExt:".md", Tag:"doomalay-preamble"})
  — tabs/routes/downloads come free; hubpublish.js ext/placeholder maps + hubitem.js
  import branch + hub.js bundle twin (the registry's three hardcoded client switches).

### PM twin (the browser path)

pmSystemMessage: the same preamble expansion client-side — its existing builders
(pmMetadataBlock/pmSessionContext/workspace twin/artifact prompt) map onto the same
placeholder keys; preamble_sel '' uses the PM default (today's assembly, byte-stable),
custom text expands through Persona.substituteAll + the new block twins, 'off' = persona only.

### Bot tools

NONE this wave (persona_set/list twins deliberately out of scope — the preamble is
composition furniture, not a bot hand).

### Tests

- Go: composition tests (default = byte-compatible with today's prompt minus ordering,
  custom expansion, OFF, artifact-skip, {repo_access} no-dup, PATCH round-trip, hub type).
- Node rig: preamble panel flows (select/save/download/publish payload shapes, frontmatter
  parser, the placeholder expansion twin).
- Browser E2E (agent-browser): edit preamble → turn → the stub captures the NEW prompt;
  disable → lean prompt; the hub round-trip.
- The vverify capture rig re-runs as the regression harness (payload diffs per phase).

## §4 Sequence + pushing

1. v1.21.2 commit + push (rebase protocol first).
2. v1.21.3 commit + push.
3. v1.22.0 commits (engine → web → hub → tests) + push; tag `v1.22.0-the-mirror` → release.
4. Rig battery re-run at each phase; the parallel bot's moves rebased on before every push.

## §5 Will-NOT (the spaghetti boundary)

- No blob/fetch truncation work, no reply-structure work (the standing 5-point task —
  separate wave, untouched here).
- No {skills} wiring, no bot-side preamble tools, no preamble badges/modes.
- No new capabilities rows; no hub content authoring beyond what exists.
- The brain's template/skills fields stay as-is (the lib OR already unifies them).
