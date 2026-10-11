# PLAN-V126 — THE LEXICON WAVE (approved — build in flight)

> DECISIONS (user, post-plan): **A** {skills} stays an honest stub · **B** the engine
> preview endpoint GET /api/sessions/{id}/blocks (the recommendation) · **C** the HARD
> REFUSE — reserved names refused at every door, no backward-compat ride for existing
> shadowers ("I don't care about backward compatibility") · **D** numbering — a parallel
> wave shipped v1.27.0 (THE HONEST PROGRAM) mid-plan, so per this plan's own clause the
> phases renumber: **v1.27.1 · v1.27.2 · v1.27.3 → ship v1.28.0**.

The user's ask: tie the new PREAMBLE system (v1.22.0 THE MIRROR) to the pre-existing
PLACEHOLDER and PERSONA systems. In the chat-data section of the persona panel, the
Placeholders row (which sits above the Preamble row) must list ALL placeholders the app
uses — we use a lot. Update the previously-implemented placeholders screen to suit the
new preamble + placeholders, and tie it all with the placeholder create/delete system
(global/local customs). This wave is the completion of a promise PLAN-V122 §3 already
made and only partially kept: "The placeholders view + reserved-key lists gain the new
builtins (both engines + JS twin)."

Phases: v1.27.1 THE FULL LEXICON · v1.27.2 THE TIE · v1.27.3 THE TRIGGER + DELETE TIES
· THE REDTEAM → ship v1.28.0. All UI on the panel (persona panel's view stack),
all colors through theme tokens. Rebase against parallel bots before every push.

---

## §0 THE VERIFIED CURRENT STATE (code census, HEAD 79f8136a v1.26.0)

The full placeholder vocabulary — 13 named keys + user customs:

| # | key | class | expands to | where handled |
|---|-----|-------|-----------|---------------|
| 1 | {name} | live fact | the chat's title | substituteAllVars (personas.go:744) + persona.js substituteAll:1557 |
| 2 | {model} | live fact | pretty model name | same |
| 3 | {provider} | live fact | provider label (catalog) | same |
| 4 | {date} | live fact | "Saturday, 10 October 2026" | substituteAllVars:759 + JS twin:1562 (added v1.22.0) |
| 5 | {skills} | live fact — STUB | literal "(no skills attached yet)" | personas.go:756 + persona.js:1560 |
| 6 | {repo_access} | live block | workspace manifest (PUBLIC REPO ACCESS / CONNECTED CLOUD WORKSPACES) | expandPromptBlocks (preambles.go:156) / pmRepoAccessBlock (chatpanel.js:2628) |
| 7 | {artifacts} | live block | the artifact protocol ("" when the persona already teaches it) | preambles.go:164 / chatpanel.js:2617 |
| 8 | {library} | live block | library section + [Live library state] line | preambles.go:171 / pmLibraryPreamble (chatpanel.js:2386) |
| 9 | {controls} | live block | "## This chat's controls" ledger | preambles.go:174 / pmMetadataBlock (chatpanel.js:2315) |
| 10 | {session} | live block | "## Your session (live)" dashboard | preambles.go:177 / pmSessionContext (chatpanel.js:2416) |
| 11 | {messages} | trigger-only metric | folded model-visible message count | triggerSatisfied (personas.go:680) + persona.js valueFor:1519 — NEVER text-substituted |
| 12 | {turns} | trigger-only metric | user turn count | personas.go:682 + valueFor:1520 (aliases {message_count}/{turn_count} accepted) |
| 13 | {repo} | template-internal slot | " (your Space: …)" / " (the shared sandbox)" | engine defaultPersonaFor (chat.go:554) + PM (chatpanel.js:2587) — HF default persona ONLY |
| + | customs | user-defined | their stored value | mergedPlaceholders (personas.go:325) — global 🌐 (/api/placeholders → app_settings) + local 📍 (session.Placeholders), local wins; expand in personas AND preambles (substituteAllVars runs on both, chat.go:659/667); feed triggers |

Composition order (the law): customs FIRST (substituteAllVars on preamble + persona),
THEN the five live blocks (expandPromptBlocks) — so live block text is never chewed by
user keys; side effect: a custom key named like a block SHADOWS the block.

## §1 THE FINDINGS (the drift the wave heals)

1. **The placeholders screen is stale.** placeholdersView (persona.js:1382) lists only
   {name} {model} {provider} {date} {skills} as built-ins. The five MIRROR blocks and
   the two metrics are INVISIBLE — the user cannot discover the vocabulary the preamble
   editor keeps telling them to use.
2. **The chat-data row is stale.** The Placeholders row sub (persona.js:494) still says
   "{name} {model} {provider} {skills} + custom keys" — no blocks, no date.
3. **Reserved-key mismatch (a real footgun).** Engine PUT rejects
   name/model/provider/skills/date/messages/turns (personas.go:813); the front-end
   add-box (persona.js:1456) rejects name/model/provider/skills/messages/turns — it
   MISSES date. NEITHER rejects the five block names: a user can create a global custom
   {session} or {library} today, and because customs substitute FIRST it would silently
   shadow the live block in every persona and the preamble.
4. **The API's builtin list is dead payload.** GET /api/placeholders advertises
   builtin:[…7 keys…] (personas.go:794) but no client reads it (persona.js loadGlobals:175
   takes only d.placeholders) — and it lacks the five blocks. Four hand-maintained lists
   drift instead of one source of truth: engine GET builtin, engine reserved switch,
   JS add-box check, JS triggerKeys.
5. **buildPreambleFile is blind to customs** (persona.js:788): the frontmatter
   `placeholders:` field only detects the 5 blocks + 4 built-ins — a preamble using a
   custom {brand} exports without declaring it.
6. **{date} is advertised but not triggerable.** The API builtin says date exists; the
   engine triggerSatisfied and the JS valueFor have NO date case — trigger on date
   silently never fires. The trigger picker doesn't offer it either (consistent UI,
   inconsistent API).
7. **Custom rows lie a little.** customRow sub says "usable in personas + triggers"
   (persona.js:1397) — since v1.22.0 they're also usable in preambles.
8. **{skills} is an admitted stub** — "(no skills attached yet)" on both paths, while
   the app actually has the MCP bus roster it could point at. (Scope decision — §5.)

## §2 RESEARCH TAKEAWAYS (applied)

- **AGENTS.md** (agents.md): a simple, open, runtime-agnostic markdown format — and it
  defines NO variable system at all. Confirms our portability law (unknown {keys} stay
  literal) and the self-describing frontmatter (a foreign runtime can't know our keys,
  so the file must list them — and we should list customs too, not just built-ins).
- **Obsidian core Templates** (help.obsidian.md/plugins/templates): a SMALL fixed
  inventory presented as a table — each variable with a one-line description and its
  current format. The model for our inventory screen: every key, one honest line,
  live value where one exists.
- **VS Code snippets**: built-in variables are a documented fixed set grouped by
  category with per-variable descriptions; unknown variables render as written. Grouped
  presentation + literal-unknown behavior — our grouped sections mirror this.
- **LangChain PromptTemplate**: separates template variables from `partial_variables`
  (values fixed before runtime). Maps cleanly onto our two classes: LIVE keys
  (engine-computed every turn) vs STATIC customs (user-fixed values). The plan adopts
  this live/static vocabulary in the UI copy — it explains the system better than
  "built-in vs custom" (a {name} is also built-in, but customs are the only static ones).

## §3 THE DESIGN — v1.27.1 THE FULL LEXICON

placeholdersView (persona.js) rebuilt, all on the panel stack, theme tokens only:

- Hint rewritten: two classes of keys — LIVE (the app computes them every turn) and
  STATIC (your stored values). "These substitute into every persona AND the active
  preamble on every turn; customs also power trigger conditions."
- Section "live blocks — the preamble machinery": {repo_access} {artifacts} {library}
  {controls} {session} rows. Each: description + where it lands (the default preamble's
  slot map) + ({artifacts}: "collapses to nothing when your persona already teaches
  artifacts"). LIVE PREVIEW (decision §5-B): either description-only, or a tiny engine
  preview endpoint GET /api/sessions/{id}/blocks (server renders the same turn-time
  builders, capped) and each row expands to its current first lines — one source of truth.
- Section "live facts": {name} {model} {provider} {date} with their live values (the
  existing builtin() rows, kept + date already there) — {skills} per §5-A.
- Section "trigger metrics": {messages} {turns} with a "trigger-only — counts; never
  written into the prompt" sub (aliases {message_count}/{turn_count} footnoted).
- Sections "global 🌐" + "this chat 📍": the existing CRUD unchanged in flow
  (key + value + scope pill + add; ✕ deletes), corrected in law:
  - reserved-key list = the 7 built-ins + the 5 block names, engine PUT AND front-end
    add-box (fixes finding 3 + the missing date);
  - customRow sub → "static · usable in personas · preamble · triggers";
  - a legacy custom that shadows a block name gets a warn badge ("shadows the live
    {library} block — rename it") instead of a silent surprise.
- The chat-data Placeholders row sub (persona.js:494) becomes the live enumeration:
  "12 built-ins — 5 blocks · 5 facts · 2 metrics — + your customs" (exact copy tuned
  in-build; the full spelling lives one tap away in the screen).

## §4 THE DESIGN — v1.27.2 THE TIE (one vocabulary, one source of truth)

- Engine: GET /api/placeholders returns { placeholders, builtin: [7], blocks: [5] };
  the PUT reserved switch rejects builtin + blocks (one shared Go slice, not two lists).
- persona.js loadGlobals caches builtin + blocks into ONE PH_VOCAB constant that feeds
  every consumer — placeholdersView sections, the add-box reserved check, triggerKeys
  groups, buildPreambleFile detection (12 + this chat's globals/locals — customs now
  declared in exported frontmatter), the preamble editor's hint. The four drifting
  hand-maintained lists die.
- THE IMPORT BRIDGE (the strongest tie): hub preamble import (hub.js
  importPreambleInto) diffs the parsed frontmatter `placeholders:` + body {keys}
  against the live vocabulary; any unknown custom key surfaces a one-tap suggestion row
  ("this preamble uses {brand} — create it?") that opens the add flow prefilled (scope
  pill defaults 🌐). Import → the placeholders screen knows what the preamble needs.
- Preamble editor: the static hint line (persona.js:680) becomes a tappable
  "{ } vocabulary" pill → placeholdersView. The persona editor already has the { }
  pill — now both editors share the same inventory view (one source of truth in the UI too).

## §5 THE DESIGN — v1.27.3 THE TRIGGER + DELETE TIES

- {date} becomes a real trigger key: engine triggerSatisfied gains `case "date"`
  (weekday string, case-insensitive = / != — the "activate on Monday" pattern);
  persona.js valueFor + triggerKeys gain date under built-in globals. The five blocks
  stay OUT of triggers BY DESIGN (documented: prose blocks aren't comparable facts).
- Trigger view: "Create more keys under { } placeholders" becomes a tappable pill →
  placeholdersView (the view stack already supports it).
- THE DELETE GUARD: deleting a custom key scans this chat's personas + preambles for
  {key}; when referenced → confirm ("{brand} is used by 'Persona 2' — delete anyway?").
  Honest scope: client-side scan covers THIS chat only (globals are engine-wide; the
  guard says so). Ties the create/delete system to the persona + preamble systems.
- PM twin parity: valueFor gains date; nothing else moves (substituteAll already
  handles the vocabulary; the block expansion order is already mirrored).

## §6 THE REDTEAM → SHIP v1.28.0

- scripts/v1271-lexicon-rig.mjs (node, against the live engine): GET returns builtin 7
  + blocks 5; PUT rejects each block name + date with the honest 400; a date trigger
  fires; session PATCH round-trip of customs; the hard-refuse PATCH sanitize.
- Regression: v1220 mirror rig + v1151 choice rig + personas/placeholder Go tests green.
- agent-browser real-user walk: chat data → placeholders (all sections, live values,
  390px no-overflow) → add 🌐 + 📍 customs → try {session} → rejected with the reason →
  import a preamble carrying {brand} → suggestion → create → row appears → delete guard
  fires on a referenced key → trigger builder lists date.
- Ship: buildinfo 1.28.0 + the wave record; rebase protocol (fetch origin, clear
  tool-results/ if it blocks, ff-only/merge, build APK, then push); phased commits
  v1.27.1 → v1.27.3 then the v1.28.0 ship.

## §7 DECISIONS (answered by the user — see the header block)

- **A. {skills}**: the honest stub this wave (chosen).
- **B. Block live preview**: the tiny engine preview endpoint GET /api/sessions/{id}/blocks
  (chosen — the recommendation; it also powers future prompt debugging).
- **C. Legacy shadowing customs**: THE HARD REFUSE (chosen — the user explicitly dropped
  backward compatibility): reserved names refused at the API PUT, the bot's
  placeholder_set, the session PATCH and the front-end add box; a stored shadower is
  flagged in the UI and dies on its next write.
- **D. Wave naming**: confirmed with the renumber (v1.27.1-.3 → v1.28.0; the parallel
  v1.27.0 THE HONEST PROGRAM took the minors).

## §8 QUEUED (unchanged, this wave does not touch them)

- Sideload the APK + real-user test of the Preamble panel (tweak a block, flip Off,
  import from the hub) — can ride the same sideload session as this wave's E2E APK.
- The parked 5-point task (blob truncation, reply structure) — still its own wave.
