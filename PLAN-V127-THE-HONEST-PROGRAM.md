# PLAN-V127 — THE HONEST PROGRAM

The user's report (the Faqous transcript, live device v1.26.0):
> "all exec actions don't get programatically titled or don't get a derived
> title, it's blank, with no header or indicator at all which tool ran unless
> expanded… in the query, we have action and a 'command' for every single
> exec… the first word can be programatically derived and used as the header
> or tools title — cal or python3 or du or sed or curl."
> "Also, remove the parralell burst thing, or better yet, set the default to
> unbound and add a frontend tweak-able variable in the per chat tweaks
> screen to set an optional limit… default unbound if that's not an issue, or
> high number."

Two convictions, both evidenced against the LIVE device events
(`/api/sessions/6acba4c659780dd2843b7d83/events` — the exact chat from the
transcript):

## THE ROOT CAUSE (why v1.24.5's title derivation shows blank)

The persisted device tool_use events carry:

```json
{"name":"termux","summary":"exec","text":"",
 "args":{"action":"exec","args":"{\"command\": \"cal 10 2026\"}"}}
```

The inner `args` is a **JSON-encoded string**, not an object. WHY: the MCP
manifest (mcpbus/def.go:241) declares the termux `args` property as
`type:"string"` — "JSON object of the action's arguments, e.g. {…}" — so
every schema-following PM model (glm-5.3-flash here) double-encodes it. The
ENGINE has tolerated the string form since v1.20.3 (runTermuxAction's
`case string:` merge), but the FRONTEND derivation never did:

```js
// chatpanel.js termuxArgsOf
var inner = a.args && typeof a.args === 'object' && !Array.isArray(a.args) ? a.args : null;
```

`a.args` is a string → `inner = null` → the exec branch's command is `''` →
label, title, body ALL empty → the collapsed pill renders as a naked ⌕ icon
with no text (the user's exact complaint), live AND replayed (the shape
persists). The v1245 rig + the v1250 E2E stub only ever emitted the OBJECT
inner form — the device's real shape was never pinned. The summary field
falls back to "exec" for the same reason (pmsdk's nested-object check fails
on the string), which is why the pill didn't even show the command.

**The manifest is NOT changed** — the string form is the manifest's own
taught shape (mcpbus_test.go:302 pins `argsProp["type"] == "string"`), the
engine tolerates all three forms (string/object/flat), so the FRONTEND
derivation must tolerate them too. A one-sided frontend fix, no wire change.

## RESEARCH RECEIPTS

· **The program-token law (the user's "first word" idea — kept, with one
  grammatical refinement).** POSIX Shell Command Language: a `NAME=value`
  word before a utility is a *variable assignment prefixing that utility*
  — it is grammar, not the program. So the program = the first
  NON-assignment word: `FOO=1 python3 -V` → `python3`. No program lists, no
  dictionaries — one regex. (POSIX §2.9.1 Simple Commands; validated
  against `env(1)`/`bash(1)` behavior: `FOO=bar cmd` runs `cmd`.)
  Everything else stays first-word (the user's law): `cal`, `python3`,
  `du`, `sed`, `curl`, `cd '/x' && bash hello.sh` → `cd` (honest — that IS
  the first program; the body carries the rest).
· **MD3 sliders + switches** (m3.material.io/components/sliders,
  /components/switch/guidelines): "Switches are best used to adjust
  settings and standalone options"; sliders "let users make selections
  from a range of values" — the optional-cap row = switch (arm the limit)
  + slider (the value), the same idiom the mind view's auto-compaction
  toggle + threshold slider already use in this app.
· **Sliding-window rate limiters** (industry survey: dev.to "Building a
  Production Rate Limiter from Scratch in Go", leapcell.io sliding-window
  Go/Redis): per-key configurable limits over a rolling window is the
  standard shape; our gate is exactly that (per-session rolling 60s log)
  — the change is only WHERE the limit comes from (a per-chat setting,
  not a compiled const) and its DEFAULT (unbound).

## §1 — v1.26.1 THE STRING ARGS (the blank-title fix)

`chatpanel.js`:

· `termuxArgsOf`: parse the inner `args` when it's a string
  (`JSON.parse` with the honest null on garbage), keep the object form,
  and fold FLAT top-level keys into `inner` when the nested args never
  carried them (the engine's own merge law — runTermuxAction merges
  nested→flat, nested-wins-missing). Pure, render-time — every family
  derives fresh: PM live, PM replay, WS live, WS replay.
· The exec branch: the PROGRAM TOKEN = the first non-assignment word —
  `/(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*(\S+)/` (assignment-skip + capture
  in one match; the match's end offset yields the BODY = the raw command
  remainder after the program). Title clamp at 28 chars (a garbage token
  must not blow the chip). The ` install` label join keeps its
  label-only nicety, now tested against the token AFTER the program.
· The pkg branch: the name reads `packages` (the array — the manifest's
  own example `"packages":["python"]`, the real device shape
  `{"op":"install","packages":["cowsay"]}`) joined with spaces, falling
  back to `name`.
· `title`/`body`/`label`/`tail` contracts otherwise UNCHANGED — the chip,
  the pill text span, the overlay tv-name/tv-sub, and the activity line
  all already read toolPillLabelParts.

Rig: `scripts/v1245-pill-title-rig.cjs` grows the DEVICE-SHAPE cases —
the transcript's exact payloads (outer-object+inner-string, outer-string+
inner-string, flat command, env-prefix, `packages` array, the 28-clamp).
E2E: the v1250 walk's stub arguments switch to the device's string form.

## §2 — v1.26.2 THE UNBOUND BURST (the anti-burst law becomes a tweak)

The engine (`termuxtool.go`): `termuxExecCap` const (12) DIES. The gate
reads the chat's tweaks blob:

```go
cap := termuxExecCapOf(sessionID) // chat.tweaks.<sid> {execCap:N}; absent/0 → unbound
```

· absent / 0 / negative / garbage → **UNBOUND** (the user's default — the
  execs are jailed, blocklisted, streamed, and the model's own loop waits
  on each result; the turn budget backstops the runaway case).
· N>0 (clamped ≤1000) → the rolling window with N; the refusal text
  speaks N and the ✦ tweaks → Termux path ("this chat's burst cap is N
  one-shot execs per minute — set in ✦ tweaks → Termux; ask the user, or
  wait for the window to roll").
· The window var + the per-session log map stay (the tests shrink the
  window). ONE gate site — `runTermuxAction` feeds both the direct ACTION
  path and the MCP/PM path, keyed by the chat's sessionID, and the
  tweaks blob lives at `chat.tweaks.<sessionID>` — both paths read the
  same row.

The ✦ tweaks screen (`tweaks.js`): a new **Termux** section after Bot
Library — the burst-cap switch (OFF = unbound, the default; ON = limited)
+ the execs/minute slider (5..120, arms at 12 — the old law's number as
the familiar ground), the mind-view's slider idiom. Writes `execCap` into
the chat's tweaks blob (delete when OFF — absent is the unbound default),
rides the existing `persist()` PUT → `/api/sessions/{id}/tweaks`. The
blob is the single source — no session-row twin, no dual-write.

Tests: `TestV1203_Exec_RateCap` sets the blob (the cap arms from the
chat's tweaks); NEW `TestV1262_UnboundDefault` (20 rapid execs all run);
the refusal-text pin re-points at the N phrasing. The v1203 arm-test.js
and v1211 rig source pins re-point at the new law (their behavioral
assertions — rapid-fire runs — hold identically).

## §3 — v1.27.0 THE SHIP

buildinfo 1.27.0 + the wave record. NEW `scripts/v1270-e2e-walk.mjs`
(the v1250 pattern: real engine + executing fake bridge + OpenAI stub +
?apk=1): the string-args pill chip (the device's exact shape — the
regression), the overlay's tv-name, the UNBOUND burst (15 rapid /mcp
execs all run), the armed cap (blob execCap:3 → the 4th refuses with the
new text), the ✦ Termux section round-trip (switch + slider → blob →
reload), mobile 390px, zero console errors. Full battery: the Go suite,
every re-runnable rig, the walk ×2. Push main + tag v1.27.0 (CI: APK +
desktop + patch-manifest).

**The honest device steps**: the pill-title fix rides the OTA
(chatpanel.js is a PWA file — the user's device picks it up on the next
open, no reinstall); the unbound default + the gate read ride the APK
(the engine changed — min_engine is the full-APK wall); the tweaks row
itself rides the OTA but stays inert until the APK lands (the blob
writes, the old binary ignores it — honest).
