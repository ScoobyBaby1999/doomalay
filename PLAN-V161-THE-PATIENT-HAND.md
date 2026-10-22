# PLAN-V161 — THE PATIENT HAND

The user's report (verbatim core): *"Whenever a turn gets dropped due to
network or another thing that requires the user to press continue … start a
timer that probes the user for the connection or whatever started the
hindrance. The timer can be customisable, default to like 5-10 mins per
signal. The timer then is armed to probe the issue, for instance a default
timer when a network issue is detected that probes the user for a connection
after we exhaust our retry methods, same with 429 errors across different
providers. Every chat that gets interrupted for the same reason can join and
listen to the appropriate dynamic timer. When the signal triggers (429 works,
network is back) auto-continuation occurs (user doesn't have to tap continue)
and the dynamic timer is killed, all listeners have their convo continue. Each
probe we log in the chat, so when this occurs a pill or something is created
or used to display retried x time. And the seconds or minutes left until next
retry, if it works, the pill completes … and shows continued after X retries.
Z:Y hours/minutes elapsed."* + *"The fromtier-ish model had a few hiccups, but
the bad one had a lot. Why is that? How can we reduce this down to a near 0 …
Everytime they hiccup, instead of retrying, they try and make it simpler. We
cannot have that … the model should never, ever, feel like it's restricted by
our chatbot sandbox, it should feel the opposite … We cannot have tool
hiccups, we should permit just about any tool call … for everything the model
tried now and failed, we should patch, nothing like this should ever happen.
Models should not try and simplify the call cause we failed the execution. It's
an issue on our end, even the worst models should execute the best tools
seamlessly, and should never downgrade the execution or simplify it."*

Evidence: two real chat exports — `doomalay-kenny-6ada2fc9` (openrouter/free,
the "bad" model, ~9 tool hiccups + 2 turn drops) and `doomalay-trippy-6ada1e32`
(nvidia step-5-preview, the frontier-ish model, ~8 hiccups + 2 mid-stream
aborts). Every hiccup below is a real logged event, not a hypothesis.

## THE DIAGNOSIS (convicted from the two chatlogs; every link named)

### Why the bad model hiccups more
Both models emit the SAME mistake classes; the frontier model recovers in one
retry, the free model spirals ("Let me try a simpler approach" — kenny's own
thinking, 4×) and finally derails into SPARQL and probe-artifacts instead of
retrying (trippy, after 2 arg errors, abandoned reading the engine code
entirely: "So let me take the trustworthy path instead"). The mistakes are
cheap to repair mechanically — the DERAILMENT is the cost. So the law of this
wave: **the engine repairs what it can, retries what it can, and only speaks
when it truly cannot — and when it must speak, the message forbids
simplification.** A hiccup the model never sees is a hiccup that never
derails it.

### Class A — termux nested-args malformation (kenny ×5, all repairable)
The engine's outer gate (nativetools.go:465-503) repairs raw newlines/quotes
in the OUTER tool_call JSON, then the bus re-marshals. But the termux tool's
`args` prop is a JSON-object-as-STRING, and the models nest their command
JSON inside that string:
1. **raw newline inside the nested string** — kenny: `{"action":"exec","args":"{\"command\": \"python3 -c \"import json;\nfor f in …\"}"}` → outer JSON valid (the `\n` is an escape) → nested value contains a REAL newline byte → `json.Unmarshal` at termuxtool.go:177 dies: *"invalid character '\n' in string literal"*. No repair exists at this level (audit §5.2: "the nested-string unmarshal at :177 is bare").
2. **double-nested args** — kenny: `{"args": "{\"args\": "{\"action\":\"exec\",…}"}"}` — the model wraps the whole action object inside the args key, recursively. One merge level exists (:173-192); the recursive shape needs unwrapping.
3. **legacy tag-grammar leakage** — kenny's worst: the model emitted the DEAD v1.13 ACTION grammar tags inside the native call: `action="exec啸{"command": "python3 -c …"}"` → termuxtool.go:249 answers *"unknown termux action \"exec啸{…}\""* (audit: "nothing strips legacy tag-grammar chars anywhere"). The tags also appear INSIDE JSON values (`"args啸{`) — the old grammar's `啸` = "next key" separator, so `"args啸{…}` decodes to `"args":{…}` mechanically.
4. **unescaped inner quotes / truncation** — kenny: *"invalid character 'c' after object key"*, *"unexpected end of JSON input"* — the lenientJSON/repairJSON chain exists in llm but is NOT applied to the nested string.

### Class B — workspace arg-schema drift (kenny ×2, trippy ×6)
5. **`path` used as the workspace key** — kenny: `{"action":"grep","path":"ScoobyBaby1999/doomalay","query":"openrouter"}` → `get("ws")`="" → resolveWSToolRef nil (2 bound) → *"no connected workspace matches \"\""* (workspacetool.go:96→:1225). The model put the workspace NAME in `path` — inferable mechanically: the path's first segment(s) match a bound workspace Name/owner-repo.
6. **read-continue** — trippy ×4: `{"action":"read","range":"lines:1330-1420","ws":"…"}` — the model forgot `path` but its intent is unambiguous: continue reading the file it just read. No last-read state exists anywhere (audit §1.6). A per-session last-read-path (the termuxExecLog map pattern) makes this repairable; without one the model abandons the whole investigation.
7. **grep missing query / cross-tool drift** — trippy: `{"action":"grep","ws":"…"}` with no query; the workspace grep reads `query`, the termux grep reads `pattern` — the Defs teach both spellings and the models mix them (audit §7c: "cross-tool drift feeds the confusion").
8. **the latent nil-deref** — audit §1.8: `patch`/`commit`/`sync`/`tag_create` deref a nil toolWS when ws is unresolvable → panic → bus middleware error. A worst-model arg fumble on patch becomes "the workspace tool failed internally".
9. **`wsArgInt` silently drops values ≥500** (workspacetool.go:1484-1489) — `limit:1000` becomes 0 = UNLIMITED — the honest-ceiling inversion.

### Class C — transient network errors surfaced raw (kenny ×1, trippy ×3)
10. GitHub forge calls are single-shot 20s (forge/client.go:109-153 — audit: "zero retry logic"); the chatlogs show *"context deadline exceeded"*, *"unexpected EOF"*, *"dial tcp … i/o timeout"* and web_fetch *"resolve raw.githubusercontent.com: no address"* reaching the MODEL verbatim. Each of these is a 1-3s-backoff-retry class (GitHub's own best-practice doc: honor Retry-After / x-ratelimit-reset; backoff between retries). `ghLoginFor` (termuxtool.go:1309) uses raw `http.DefaultClient` — no netx transport (the Android DNS-fix transport!), no retry. The llm package's proven transient classifier `isTransientNetErr` (chat.go:2587-2615) already names every observed class — it just never runs on tool-side requests.

### Class D — turn drops that park the chat (kenny ×2, trippy ×2)
11. kenny: *"OpenRouter is unreachable right now … Tap Continue"* ×2 — the bounded provider hold (netProviderHoldLoop, 2 min, chat.go:2350-2424) expires → the turn parks. trippy: *"read tcp …: read: software caused connection abort"* ×2 — mid-stream aborts that exhausted the seam budget → the turn parks. The 429 ladder gives up after 3 attempts/8s. In every case the chat sits with a red error pill and the user must tap Continue — even when the failure clears itself 30 seconds later. The device's own netSuspendedLoop is patient (infinite, WakeNet-wired) but ONLY while the turn is alive; the PARKED turn has nothing waiting on the signal.

### Class E — the schema itself teaches wrong (the root amplifier)
12. The workspace Def's action enum lists 16 of 30 verbs (audit §3.2: patch/commit/sync/branch/issue*/pr_comment/pr_review/pr_merge/discussion_post/workflow_dispatch/file_delete/release_create MISSING) and omits ~20 props the verbs read (edits, files, dry_run, labels, number/issue/pr, event, method, category, workflow, inputs, target …). The termux Def's enum omits `patch` (:256). The termux `args` prop declares STRING-only (def.go:257) — actively inviting the nesting confusion. The models that read the manifest literally never learn `patch` exists and always nest `args` as a string.

## THE RESEARCH (web, pre-build — the standing law)

- **OpenRouter** (docs, live-fetched): 429/503 (and in-flight-budget 402) carry a standard **`Retry-After` response header in seconds** — "The OpenAI SDK, Anthropic SDK, Vercel AI SDK, and OpenRouter SDK already respect this header for backoff". 429 = "You are being rate limited"; 503 = "no available model provider that meets your routing requirements"; 529 = provider overloaded; the documented cure is "exponential backoff and retry logic". → The sentinel's per-signal probe interval must READ Retry-After at park time and clamp the first probe to it; the configured interval (default 5 min) covers the headerless case (upstream shared-pool 429s usually carry none).
- **GitHub REST best practices** (docs, live-fetched): honor `retry-after` and `x-ratelimit-remaining:0`/`x-ratelimit-reset`; "wait for an exponentially increasing amount of time between retries, and throw an error after a specific number of retries"; do not re-hammer validation-class 4xx. → forge retry = transient classes only (timeout/EOF/reset/DNS/5xx), 3 attempts, 1s/3s backoff, never on 403/404/422.
- **json_repair** (the canonical LLM-JSON repair library, README): LLM JSON mistakes are "simple enough to be fixed without destroying the content" — missing quotes/commas/brackets, truncated values, stray prose. The engine already carries repairJSON/lenientJSON (outer layer); this wave extends the SAME philosophy to the nested layer + the two doomalay-specific classes the library never saw (tag-grammar leakage, recursive args-wrapping).
- **The v1.50.5 law check**: PLAN-V150 §7 documents "no AUTO-continue — V135's law: only the user's tap resumes". THE USER'S NEW ORDER supersedes it for RETRYABLE classes only — the plan states it, the code comments it, and non-retryable classes (auth/quota/modelgone/payload) still park exactly as before. User-tap Continue always remains.

## THE SUB-WAVES (phases v1.61.1 → v1.61.5, ship v1.61.0)

### v1.61.1 — THE REPAIR HAND ( Classes A + B + E: worst models execute seamlessly)
One shared repair module `engine/internal/llm/argrepair.go` (exported — server
imports it), extending the existing chain — order matters, each rung only if
the previous failed:
1. `RepairActionArgs(raw string) (map[string]any, notes []string)`:
   parse → repairJSON (raw control chars escaped, closers appended) →
   lenientJSON (smart quotes, single-quote strings, bare keys, trailing
   commas) → **stripTagChars** (the v1.13 grammar: `啸` outside strings
   becomes `":"`, `ɚ`/`啸` inside VALUES deleted; `啸` at a key position
   closes the key) → parse; collect human notes per applied rung.
2. **Recursive unwrap** (bounded, 4 levels): while the map has an `args`
   key whose value (string|object) parses to a map that itself contains
   `action`/`args`, unwrap one level (top-level explicit keys win).
3. **tag-split action**: `action` containing `啸` → real action = prefix
   before the first tag; the remainder parses as args → merge (kenny's
   `exec啸{…}` class).
4. Server-side wiring: termuxtool.go:173-192 nested-args merge calls the
   repair chain instead of bare Unmarshal (kenny classes 1/2/4 all land
   here); workspacetool.go:65 gets the same treatment for its outer parse.
   On success with notes, the observation carries a one-line teach head:
   `note: arguments auto-repaired (raw newlines escaped) — call executed as
   intended` (honesty law kept; the model learns the shape; ZERO failures).
5. **Workspace inference**: (a) `ws` missing/empty + `path`/`repo`/`workspace`
   present → longest-prefix match against bound Names/owner-repo/Repo →
   split ws + remaining path (kenny class 5); (b) `read` with empty `path` +
   `range` present → the per-session LAST-READ map (`Server.wsLastRead`,
   the termuxExecLog mutex-map pattern) — record on every successful read;
   replay it for range-only reads (trippy class 6 ×4); (c) grep `query`
   aliases: `pattern`, `q`, `search` (trippy class 7 / cross-tool drift).
6. **The anti-simplification law, engine-spoken**: every arg-validation error
   and every malformed-args skip text gains the suffix: `Retry the SAME call
   with this fix — do not simplify, downgrade, or switch strategy.`
   (nativetools.go:471-497 skip texts + workspacetool verb errors + termux
   need-texts). The message the model reads is the last defense against the
   "simpler approach" spiral.
7. **Fix the landmines**: `verbNeedsWS` += patch/commit/sync/tag_create (the
   nil-deref); `wsArgInt` accepts ≤100000 (kills the ≥500→unlimited
   inversion).
8. **The schema teaches the truth** (Class E): workspace Def action enum =
   all 30 verbs + the missing props (edits/files/dry_run/labels/number/
   issue/pr/event/method/category/workflow/inputs/target/description/
   license/gitignore/from); termux enum += `patch`; the termux `args` prop
   desc: `JSON object of the action's arguments — e.g. {"command":"python -V"} — pass it as a JSON object OR as that object's text; both are accepted`
   (the string requirement stays in the schema for wire-compat but the tool
   takes both — and now repairs).
9. Go pins: the EXACT kenny + trippy logged shapes replayed byte-for-byte
   (I have them in the exports) as table tests: repaired → executed (fake
   bridge), inference hits, nil-deref regression, the notes teaching.

### v1.61.2 — THE PATIENT WIRE (Class C: transient tool-side retries)
1. `netx.IsTransient(err)` — lift the proven `isTransientNetErr` class set
   (timeout/context deadline/reset/broken pipe/unexpected EOF/refused/5xx/
   tls/dns/no such host/no address/SERVFAIL) into netx; llm's classifier
   delegates (one truth).
2. `netx.RetryDo(client, req, n, baseDelay)` — bounded retry with 1s/3s
   backoff, ctx-aware, Retry-After-ignoring (tools, not turn loops); used by
   forge `Client.doAccept` (3 attempts — GitHub's "specific number of
   retries" advice) and WebFetch (2 attempts).
3. `ghLoginFor` → netx transport + retry (kills the raw DefaultClient bug).
4. Honesty: a retry-exhausted error reports `… (retried 3x)` — never silent.
5. Go pins: fake-server fail-twice-then-200 for forge + fetch; the
   classifier table (every observed chatlog error string → transient).

### v1.61.3 — THE RETRY SENTINEL (Class D engine-side: the dynamic timers)
New `engine/internal/server/retrysentinel.go` — the cross-chat registry:
1. **Arm**: terminal turn errors classified RETRYABLE (net-hold expiry,
   429, 5xx, mid-stream abort) gain a machine-readable
   `ChatChunk.RetryClass` (e.g. `net`, `429`, `5xx`; + provider) set at the
   park sites (llm: netProviderHoldLoop verdict, the 429/503 ladder's final
   failure, the seam-exhausted abort) — server-side forwardEvents sees
   terminal error + RetryClass → `sentinel.Arm(sid, provider, class, retryAfter)`.
   Non-retryable classes (auth/quota/modelgone/payload/cancelled) never arm.
   **Retry-After (OpenRouter-documented) is captured at the 429/503 emit site
   and clamps the first probe** (header present → first probe at
   min(header, configured interval); else the interval).
2. **Shared dynamic timers**: registry keyed `class:provider` (net is
   provider-scoped too — "OpenRouter unreachable" ≠ device-offline, the
   engine already distinguishes via anyOtherProviderHealthy). One timer per
   key; `interval = tweaks config` (default 5 min; env
   `DOOMALAY_RETRY_SENTINEL_*` for rigs). Chats parking on the same signal
   JOIN the live timer (listener list) — the user's "every chat that gets
   interrupted for the same reason can join and listen".
3. **The probes** (cheap, keyless where possible): provider signals → GET
   `{base}/models` (9s, netx) — 200 = healthy; net-class device signals →
   netx.Diag + the WakeNet broadcast short-circuits every net timer
   (the Kotlin NetworkCallback already wakes the engine — the sentinel
   listens too). A passing probe fires **auto-continue for every listener**
   through the extracted continue-core (see 5) — staggered 1.5s apart,
   riding PaceProvider (the burst-429 protection the audit flagged).
4. **The lifecycle pills** (persisted event type `retry`, the PWA merges
   consecutive rows into ONE pill): `armed` (attempt 0 — "auto-retry armed —
   <signal> — first probe in M:SS") → per-probe `probe` rows (attempt N
   failed — still unreachable / next probe in M:SS) → `recovered`
   ("continued after N retries — H:MM elapsed", pill completes) → timer
   killed + listeners drained. A busy listener (user turn in flight) skips
   and re-listens; manual Continue/send disarms that listener (last
   listener out kills the timer).
5. **The continue-core extraction**: handleContinueTurn's body
   (server/chat.go:1247-1351) becomes `continueCore(sid, nudge)` + the WS
   wrapper — the sentinel calls the SAME core (lock, pulse, error-row
   masking, seam-nudge tail-read, all the v1.50.5 laws intact).
6. **Durability**: kv row `retry.sentinel.<sid>` {class, provider,
   attempts, startedAt, retryAfterMs}; boot scan re-arms parked chats whose
   tail is a retryable terminal (survives the Android engine restart);
   recover/disarm deletes the row. The attempt count survives re-arms —
   "continued after X retries" counts honestly across engine restarts.
7. **The ocserve arm**: opencode free-limit 429s park turns the same way —
   ocServeFailEvents gains the RetryClass (429:opencode), probe = the
   bridge's own health (the /api/health of the serve) — the same registry,
   the same pills.
8. Config: kv row `retry.sentinel` `{enabled:true, intervals:{net:300,429:300,5xx:300}}`
   (seconds), read live (the termuxExecCapOf pattern), env overrides for
   rigs. Default ON — the user's ask is the default behavior.

### v1.61.4 — THE RETRY PILL (the PWA face, Classes D UI)
1. `handleEvent` `retry` branch → ONE live pill per turn (merge machinery
   keyed like tool pills; `refreshToolRow` repaint): live = working-tone pill
   with icon ↻ + `auto-retry: OpenRouter unreachable — probe 3 failed — next
   probe in 4:32` (client-side countdown ticker from `next_at`, the
   ActivityPill clock pattern) + expandable detail (per-probe lines,
   timestamps); `recovered` = complete-tone (--ok) `continued after 5
   retries — 23:14 elapsed`.
2. Theme law: the pill composes ONLY `var(--warn)` live / `var(--ok)`
   complete / `rgba(var(--*-rgb),α)` surfaces — zero literals (audited law).
3. ✦ tweaks panel section "Auto-retry" (the Panel — the UI law): enabled
   toggle + per-class interval steppers (network / rate-limit / server,
   minutes 1-15, default 5) → the `retry.sentinel` kv row (global, labeled
   "all chats").
4. Export: `foldEvents` retry case + md `> ↻ …`, txt `[retry] …`, html —
   the kenny/trippy export format shows the probes forever (the user reads
   exports as ground truth).
5. The busy-path honesty: a listener whose auto-continue found the lock
   busy re-arms silently (pill says "waiting for your turn to finish").

### v1.61.5 — THE REDTEAM (the proof, then ship v1.61.0)
1. Go battery: the repair table (every logged kenny/trippy shape byte-exact
   → repaired/deferred), inference pins, forge retry pins, sentinel
   lifecycle pins (arm/join/probe/recover/kill, Retry-After clamp, busy
   re-listen, boot re-arm, attempt-count persistence), pill-shape pins.
2. `scripts/v1610-patient-hand-rig.py` — REAL end-to-end on the local
   engine: a fake provider (base-URL override) that 429s → the turn parks →
   the sentinel arms → probes fail (pill 2 on the WS) → the provider
   recovers → AUTO-CONTINUE lands the reply (no tap) → the recovered pill
   completes with honest elapsed — captured LIVE on the WS exactly as the
   PWA sees it, plus the export shows the probe lines. A second rig leg
   replays kenny's exact malformed termux call through the real bus +
   fake bridge → the call EXECUTES (curl to the recovering fake provider)
   — the "worst model executes seamlessly" proof. A third leg: two chats
   park on the same signal → ONE timer → both continue.
3. Real-user pass (the standing law): act as the user — send, park, watch
   pills tick, no tap, conversation resumes; malformed calls in a real
   chat; read the export.
4. README v1.61 + the worklog record; push phases per the user's law
   (rebase-check before each push — parallel bots shipping).

## THE LAWS THIS WAVE WRITES
- **The Unfumble Law**: a tool call that can be mechanically repaired IS
  repaired — the model never learns it failed. Only the truly impossible
  speaks, and it speaks the fix + the anti-simplification order.
- **The Sentinel Law** (supersedes v135/v150.5's no-auto-continue for
  retryable classes, per the user's explicit order): a turn that dies on a
  retryable signal auto-resumes when the signal clears — the user's tap is
  always still faster, never required.
- **The Shared Timer Law**: one hindrance, one timer, every interrupted
  chat its listener — probes are paid once, recoveries fan out.
