# PLAN-V165 — THE LOUD SYSTEM

The user's four asks (verbatim core):
1. The opencode **shell** pill's collapsed header shows a static "shell" title +
   the dynamic command. Change the header to the command's first word —
   "dynamically derived similarly to how our termux exec tool is".
2. **Every system-injected prompt** (the anti-degrade warnings after hiccups,
   the proceed nudge…) must be DYNAMIC ("add the tool it did verbatim back to
   it"; the proceed carries "the tail of the message for context") and must be
   RENDERED — "reuse the message box that appears when a model hiccups but add
   another state to it for when the system injects a prompt, displaying the
   prompt that we injected. Every Injected prompt should adhere to this. The
   system should never inject a prompt without making it clear for both the
   frontend and the chat transcript."
3. The collapsed headers get **compound-command awareness**: scan for `||` and
   `&&` "and other relevant syntax depending on the language" → "CD & grep" /
   "mkdir & ls" as the header, capped at 2-3 commands.
4. **Hublib and web_search don't work for opencode** — "hublib isn't exposed to
   opencode, and web_search doesn't work without a travily key, websearch
   ideally should work with simple google, duckduckgo, another opensource
   browser as it does with the other providers. Please also verify that
   opencode can use GitHub tools (view releases, all that)".

Standing laws: theme tokens only (no hardcoded colors), panel/overlay only for
new UI, rebase before push, phases x.x.1… then the ship x.x.0.

## THE RESEARCH CONVICTIONS (already done, live-audited)

- **The pill grammar**: termux exec's derivation lives PWA-side
  (chatpanel.js:5934 — the program-token regex, body = remainder after it).
  The opencode shell pill rides the else-branch (title=p.name="shell",
  body=p.summary=the command's first line — engine-derived via
  ocToolSummary("shell")). No native tool is named "shell" → name==='shell' +
  toolArgsOf(p).command is an unambiguous hook.
- **The injection corpus** (every synthetic user-role prompt into a live
  turn's history):
  * nativetools.go:347 + chat.go:403 — SeamNudgeText (the mid-reply cut)
  * nativetools.go:412 — "(proceed — execute the announced plan with your
    tools now)" + progress line
  * nativetools.go:426 — the answer-force nudge pair
  * nativetools.go:630 — "Tool budget reached. Write your FINAL answer now."
  * server chat.go:2361 — cont.nudge (continueCore's seam nudge)
  * The anti-degrade warnings ride TOOL RESULTS: RetrySameCallDirective
    (const) appended at ~27 sites (nativetools 2, termuxtool 3,
    workspacetool ~22) — already visible as pill results; the ask makes them
    DYNAMIC (the verbatim call rides the directive).
- **The rendering vehicle**: the hiccup box = the persisted `notice` event +
  `.msg-bubble.msg-notice` with data-code states (tool-hiccup = the warn
  tone). A new `injected` event type mirrors the notice machinery end-to-end:
  ChatChunk{Type:"injected"} → the chunk loop stamps {message, code:"injected"}
  → forwardEvents persists {message, code} JSON → the PWA lifts it live AND on
  replay → the same box with data-code="injected" (the --accent tone) → the
  exports carry the rows. The fold NEVER carries injected rows into the
  model's history (compact.go's type filter already excludes them — an
  injection speaks its turn only).
- **The websearch truth (v2 docs)**: opencode's native websearch providers are
  Exa/Firecrawl/Parallel/Tavily/TinyFish — ALL key-required; there is no
  keyless native option. OUR doomalay_web_search IS the keyless engine
  (Tavily-if-key → DuckDuckGo HTML → DDG Lite → Bing) and it IS exposed via
  the /mcp/oc binding. THE TEACHING BUG: toolsBlockFor's pick line says
  "your native ones for files/shell/web" — it actively teaches the model to
  use its keyless-broken native websearch. The fix is the teaching: web
  search → doomalay_web_search FIRST. hublib + workspace (GitHub: view
  releases, issues, PRs) are in Defs() and armed on sessionMcpTurn — the
  same pick line must name them for their jobs (the current line never
  mentions repos/GitHub at all).

## PHASE v1.65.1 — THE SPEAKING HEADER (asks 1+3, one mechanism)

chatpanel.js:

1. `commandTitleParts(cmd)` — ONE shared derivation (the termux-exec law
   widened, purely derived, no dictionaries):
   - Operate on the command's first non-empty line.
   - QUOTE-AWARE compound scan: walk the line tracking inDouble/inSingle/
     inBacktick/escape/parenDepth; split on `&&`, `||`, `;`, `|`, `&`,
     newline boundaries OUTSIDE quotes/parens.
   - Each segment's program token: the existing assignment-skip regex
     (leading NAME=value words are grammar, not the program).
   - ≤1 segment → title = the program token (clamped 28), body = the
     remainder after it (the existing termux law, unchanged).
   - 2-3 segments → title = the program tokens joined " & " ("cd & grep",
     "mkdir & ls"), capped at 3 tokens + a trailing "…" when more segments
     follow; body = the FULL first line (no single remainder can carry a
     compound honestly).
2. The termux exec branch routes through the shared helper (it gains the
   compound law; the 'install' label nicety stays for singles).
3. A new opencode-shell branch in the else-else (where ga parses):
   fam === 'shell' && ga.command → commandTitleParts(ga.command);
   label = title + (body ? ' ' + body : ''); fallback stays title=p.name,
   body=p.summary (never a blank pill).
4. Theme/UI: zero new CSS (the existing .tool-pill-name chip + text span
   render the derived parts) — the header just speaks now.

Pins: a Go-free PWA pin set in the rig (the derivation function exercised
through the real chatpanel.js in the harness: singles, compounds, quoted
pipes, `$(ls | head)` paren-skip, 4+ segments cap, assignment prefixes).

## PHASE v1.65.2 — THE LOUD INJECTION (ask 2)

Engine (llm):
1. `EmitInjected(ch, text)` — the one law: ChatChunk{Type: "injected",
   Text: text}, non-blocking send (FlagToolFault's discipline). Every
   injection site calls it with the EXACT text appended to history.
2. `RetryDirectiveFor(name, rawArgs)` in argrepair.go — the dynamic face:
   "Retry the SAME call — verbatim, as you sent it: <name> <args clamped
   ~480 with the honest cut marker> — with this fix. Do not simplify,
   downgrade, or switch strategy." The const stays as the tail (the pins
   keep their anchor). Sweep all ~27 sites (each has the call's name/action
   + raw args in scope).
3. The proceed injection becomes dynamic: the announcement's tail (~200
   chars) rides for context — "…Your announcement's tail, for context:
   \"<tail>\". Execute that plan with your tools now."
4. The seam + answer-force + budget texts stay generic-simple (the ask's
   "either very generic and simple" arm) — but ALL of them now emit the
   injected row.

Server (chat.go):
5. The chunk loop: `case "injected"` stamps ev["code"]="injected",
   ev["message"]=chunk.Text (the notice branch's twin).
6. forwardEvents: `case "injected":` persists {message, code} JSON exactly
   like notice.
7. The continueCore nudge site (chat.go:2361): emit the injected row
   (s.emit type "injected") at the append — the pre-llm injection is loud
   too. The emit switch grows the "injected" case (mirror "notice").
8. Exports: foldEvents grows "injected" → a foldedRow Type "injected"; all
   four renderers (md/txt/csv/html) carry "⌁ system injected:" rows (new
   rows only — old exports change shape never).

PWA (chatpanel.js + index.html):
9. handleEvent: the `injected` branch (live + replay lift, the notice
   branch's twin) → state row {role:'injected', text, ts}.
10. The renderer: role 'injected' → the SAME notice bubble classes with
    data-code="injected" + a "system injected:" lead — THE HICCUP BOX'S NEW
    STATE.
11. CSS: .msg-notice[data-code="injected"] — the --accent tone (color:
    var(--accent), rgba(var(--accent-rgb)…)), glyph '⌁'. Theme tokens only.

Pins: llm pins (the dynamic directive, the proceed tail, the sites emit),
server pins (the chunk stamp, the persist shape, the replay lift, the export
row), the rig's live UI leg.

## PHASE v1.65.3 — THE OPEN SHELF (ask 4)

ocservetools.go toolsBlockFor — the pick line rewrites:
- Web search → doomalay_web_search FIRST (keyless: the DuckDuckGo/Bing
  ladder — "as it does with the other providers"); the model's own
  websearch needs a paid provider key this device does not have.
- GitHub/repos (code, issues, PRs, **releases**, tags, workflows) →
  doomalay_workspace.
- The hub library → doomalay_hublib (browse/download).
The catalog itself needs no change — hublib/web_search/workspace are already
registered + armed on sessionMcpTurn.

## PHASE v1.65.4 — THE REDTEAM + THE SHIP

- scripts/v1650-loud-system-rig.mjs — the live proof:
  §A the header law (the real chatpanel.js derivation: singles, compounds,
  quotes, parens, the cap),
  §B the injection law LIVE (a real engine turn whose proceed/nudge/seam
  fire → the injected rows render in the panel + persist + replay + export),
  §C the dynamic directive (a malformed-args turn → the fault text carries
  the verbatim call),
  §D THE OPEN SHELF live (the real /mcp/oc dance: tools/list carries hublib
  + web_search + workspace; tools/call hublib search + web_search + workspace
  view releases against the real vault token; if the opencode free window is
  open: a REAL serve turn asked to "search the hub" / "view the releases of
  <the user's repo>" / "search the web for X" → the model picks
  doomalay_hublib / doomalay_workspace / doomalay_web_search),
  §E the battery re-run (the full rig suite + go ALL + vet + cross-compiles).
- Honest skips: the opencode-quota-dependent legs ride the free-window
  rotation (the machinery legs prove without the serve).

## THE SHIP

buildinfo 1.64.0 + the README v1.64 section + the worklog record + the tag
v1.64.0-the-loud-system. Rebase check first (the parallel bot).
