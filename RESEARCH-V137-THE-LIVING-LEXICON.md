# RESEARCH-V137 — THE LIVING LEXICON
## What it takes to make the placeholder system compartmentalized, moddable, bot-creatable, and bundle-portable — even for computed placeholders like a `{win}` function

> The user's ask, verbatim: "Let's also double check and make sure our placeholder system is
> compartmentalized and moddable, what I mean is that any user should be able to have the BOT
> itself create any placeholder exactly like we do, have that custom placeholder work for
> their chat. Even if it's something completely random like {model} or {date} or a random
> {win} function they setup that has code and logic to determine its value that may be
> completely arbitrary. They should be able to define placeholders, use them in a preamble
> or persona, and if said preamble or persona is published to the library, and another user
> downloads that persona or preamble, the custom placeholders should work for the end user
> who downloaded the persona. Research what it would take for us to implement this. We
> already have a bundle system - so if placeholders come with extra code, what would it
> take for us to be able to patch in whatever the placeholder code may be, so the code
> comes bundled with the persona or preamble, and then is patched into the end users own
> app at runtime, or with a restart or something."

---

## 0. What exists today (the honest baseline)

| Capability | Status | Where |
|---|---|---|
| User creates static customs (local per-chat / global) | ✅ | persona.js `{ } placeholders` screen; `PUT/DELETE /api/placeholders`; session PATCH `placeholders` |
| The BOT creates customs ("exactly like we do") | ✅ (static values only) | the `placeholder_set` tool (local \| global scope), personas.go — the hard-refuse law guards reserved keys |
| Bot-created customs WORK in the chat that made them | ✅ | `substituteAllVars` + `mergedPlaceholders` run every turn |
| 5 live blocks + 7 built-in facts | ✅ | `expandPromptBlocks`, `substituteAllVars` |
| Triggers on customs | ✅ | `triggerSatisfied` (numeric + string compares) |
| Customs carried by a PUBLISHED persona/preamble | ❌ (this wave's §5 closes it) | the frontmatter listed keys as DOCUMENTATION; the import bridge merely SUGGESTED them |
| A custom whose VALUE references other placeholders (template customs) | ❌ → ✅ this wave | `substituteAllVars`'s new bounded second pass |
| Computed customs — `{date}`-like fact-backed keys, arbitrary `{win}` code | ❌ | the ladder below |

**The verdict up front**: everything through "declarative + fact-backed + template"
customs that travel inside the bundle and work for downloaders ships **now** (rung
L1, 100% string data — zero new attack surface). The genuinely COMPUTED customs
(`{win}` with code and logic) are **achievable** — but they are a security surface
that must be earned, not a feature to bolt on. The ladder below is the path, with
the industry receipts.

## 1. The four-rung ladder (safety-ordered)

### L1 — DECLARATIVE + TEMPLATE customs (SHIPS IN THIS WAVE, v1.36.5)

- A custom's value is a **string**; a value that itself contains `{tokens}`
  re-expands in ONE bounded second pass (`substituteAllVars`): `{tip} = "running
  {model} today"` renders the live model. Depth is exactly TWO — a cycle
  (`{a}="{b}"` + `{b}="{a}"`) terminates as a literal leftover, never a loop.
- Portability: the `.md` frontmatter's `placeholders:` line may now carry
  **definitions** (`{key: {value, scope}}`). Publish (persona + preamble) writes
  the definitions for the customs the text uses; install materializes them into
  the downloader's chat — existing keys win, reserved keys refused (the
  hard-refuse law stands engine-side in `sanitizeLocalPlaceholders`).
- **What it costs**: nothing. Pure data through the existing PATCH/PUT doors.
- **What it gives**: the user's "{model} or {date}" examples already exist as
  built-ins; template customs give most "{date}-like" power without code.

### L2 — FACT-BACKED customs (cheap, next wave candidate)

- A definition may declare `kind: "date" | "model" | "provider" | "name" |
  "messages" | "turns"`: the engine maps the custom onto the SAME builders the
  built-ins use, evaluated live at turn time (a rename of an existing fact with
  the user's own key — `{when}` = the {date} fact).
- Cost: a small resolver in `substituteVarsOnePass` + one field in the definition
  schema. Still zero code execution — the kind whitelist is the sandbox.

### L3 — EXPRESSIONS (the CEL/expr answer — recommended before any code)

- A definition may declare `expr: "..."` in a **non-Turing-complete expression
  language** — the industry's standard answer for untrusted user logic:
  - **CEL** (Google's Common Expression Language): single-line expressions,
    syntax-checked, no loops/recursion, bounded evaluation — used across
    Google's APIs exactly because arbitrary scripting is unsafe;
  - **expr-lang** (Go-native, CEL-spirited): expressions over a declared
    variable environment with a type-checked AST and an eval budget;
  - Starlark (the Bazel dialect) is the heavier sibling — its own maintainers
    note crash-safety ≠ wall-clock safety: the EMBEDDER still owns resource
    limits (issue #249, bazelbuild/starlark).
- The expression's variable environment = the facts + the other customs + a
  small function whitelist (`len`, `lower`, `upper`, `contains`, `now`,
  `rand`…); a turn-time budget (AST depth cap + node-count cap + wall-clock
  μs cap) and a determinism gate (expressions used in TRIGGERS must be pure —
  `rand` is banned there).
- Portability: `expr` is TEXT in the frontmatter definition — a downloader's
  engine evaluates it under the SAME budget. No "patching" of code at all; the
  engine ships the interpreter, the bundle ships only the expression.
- **What it costs**: one dependency (expr-lang) or a hand-rolled mini-parser
  (~300 lines for arithmetic + comparison + string ops + `if`), plus the
  budget/determinism gates and redteam tests. This is weeks, not months.

### L4 — ARBITRARY CODE (`{win}` backed by real code) — achievable, but earned

The user's literal ask: a placeholder whose value is determined by arbitrary
code, bundled with the persona, "patched into the end user's app at runtime."

- **The modern answer is QuickJS compiled to WASM, run under Wazero (CGo-free)** —
  e.g. the "QJS" pattern: QuickJS-NG embedded as a WASM module, so the JS runs
  inside a WASM boundary with no filesystem, no network, no host imports by
  default. The receipts that make this the ONLY acceptable shape:
  - QuickJS-NG CVE-2026-37630: an RCE against QuickJS-NG 0.12.1 reachable over
    the network — the lesson is not "avoid QuickJS" but "never expose the
    interpreter to an untrusted boundary without the WASM wall + no bridges";
  - the sandbox consensus: "audit all the code you write to expose APIs to the
    sandbox" — every function we hand the script is an attack surface; the
    default surface is EMPTY.
- **The "patch" story the user asked about** — how code actually travels:
  1. the bundle's frontmatter definition for `{win}` carries `kind: "code"` +
     the script TEXT (or a reference to a script artifact in the bundle's
     extra-files) + a `caps` list (e.g. `["rand"]` — the whitelist of host
     functions it may call);
  2. at INSTALL time (not silently at runtime) the app registers the script in
     the chat's placeholder table with its caps — the honest "patch": it is
     an install-time registration of an artifact the engine already knows how
     to run, NOT live code injection into the app;
  3. at TURN time the engine evaluates it inside the WASM interpreter with:
     instruction budget (kill at N ops), wall-clock budget (kill at T ms),
     memory cap, empty import surface except the whitelisted caps, no I/O,
     no prompt access (the script cannot read the conversation), output
     size-capped;
  4. a RESTART is never needed — registration is data + the interpreter is
     always present; but the UI must show the truth: a persona that carries
     executable code says so BEFORE install ("this persona includes 1 code
     placeholder — review it") with the script viewable, and a global kill
     switch (settings: "code placeholders") defaults OFF until the user opts
     in. That consent gate is the difference between a feature and a malware
     channel.
- **What it costs**: a WASM build of QuickJS (~600KB–1MB added to the engine),
  the capability registry, the budgets, the install-time consent UI, and a
  serious redteam (fuzz the interpreter with hostile scripts; prove the kill
  switch fires under infinite loops + allocations; prove caps can't be
  escalated). Months of careful work — worth it only if users actually publish
  computed personas. **Recommendation: build L2+L3 first; the L3 expression
  language covers ~90% of "{win}" ideas (a dice roll, a date comparison, a
  score threshold) with zero of the risk.**

## 2. The compartmentalization audit ("double check and make sure")

- **Per-chat isolation**: local customs live on the session row
  (`chat_sessions.placeholders`); globals live in `app_settings` — merged with
  local winning. The v1.33.5 ownerState wave already proved the CHAT-parallel
  isolation discipline; placeholders are read per-turn from the session being
  sent, so parallel chats never cross-contaminate.
- **Bot-parity**: the bot's `placeholder_set` writes through the same
  `setPlaceholder` as the UI, same validation, same hard-refuse. What the BOT
  cannot do yet that the USER can: edit block overrides / the blocks toggle —
  a deliberate gate (blocks are app machinery), documented here.
- **The reserved-key law**: built-ins + block names are refused as custom keys
  at every door (UI add box, engine PUT, bot tool, session PATCH sanitize, and
  now the definitions materializer). One law, five doors.
- **The trigger safety**: customs feed trigger conditions; template customs
  expand BEFORE trigger evaluation (the second pass runs in
  `substituteAllVars`, which `triggerValue` reads after) — a template custom
  used in a trigger compares its EXPANDED value. Computed customs (L3/L4) must
  be banned from triggers unless pure — noted in the L3 design.

## 3. What SHIPPED in v1.36.5 (this wave's slice)

1. Template customs — the bounded second pass (engine, `substituteAllVars`).
2. The portable definitions form — frontmatter `placeholders:` as JSON
   definitions; publish writes them (persona + preamble), the three import
   paths (hubitem card, hub bundle, the suggestion bridge) materialize them.
3. The suggestion bridge now only surfaces keys the file does NOT carry.
4. Persona exports/downloads ride the portable file shape (raw-text hub
   personas import unchanged — the parser degrades to "no frontmatter").
5. This document — the L2/L3/L4 path with receipts, for the next waves.

**The honest bottom line**: a downloaded persona's custom placeholders now
"just work" for every STATIC and TEMPLATE value — which is what a persona's
voice actually needs. Computed placeholders are designed, costed, and
security-reviewed above; they should ride the L3 expression rung next, and
only earn the L4 code rung with the install-time consent gate.
