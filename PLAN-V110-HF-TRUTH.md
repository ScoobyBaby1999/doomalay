# PLAN-V110 — THE HF TRUTH WAVE (the 5th attempt, implementation session)

> The mandate: make the HF chat do what its card claims (Linux sandbox, bash,
> installs), guide unaware users, make the space know itself, verify the
> login-screen token acquisition honestly, and PROVE it with real chats.
> Root causes were live-diagnosed last session (D1–D7,
> download/hf-chat-v110-evidence/01-live-diagnosis.md). This wave implements
> the six fixes. Versions ride as v1.10.1…v1.10.6 on top of v1.10.0; the
> completed wave ships as **v1.11.0-the-hf-truth-wave** (left dot moves).

## The root-cause chain being killed
- **D1 NVIDIA black-hole** — calls from the space stall forever (no first
  LLM event, per-call timeout 86400s). Other providers answer in seconds.
- **D2 OAuth expiry** — expires_in=28800 is DISCARDED; no reconnect UI; the
  token silently 401s 8h after sign-in.
- **D3 the silent fallback** — sandbox failure = ONE transient progress note
  that vanishes; the turn completes on the direct pipeline and the user
  never learns bash never ran.
- **D4 the space doesn't know itself** — SPACE_ID never read; dt_hf's
  space_* actions demand a repo id the user must type themselves.
- **D5 PM never touches the space** — privatemodeai models route to the
  local bridge, unmarked.

---

## Phase 1 — v1.10.1 THE HONEST TURN (persistent `notice` events)
**Problem D3.** Fallback/degradation is announced via an EPHEMERAL progress
event (never persisted, gone at turn end, invisible on replay).
**Fix:**
- engine chat.go: new `notice` event class — PERSISTED to chat_events
  (JSON payload `{message, code}` like errors carry), forwarded with i/ts/seq
  so replays rebuild it. Helper `persistNotice(pipe, sessionID, message, code)`.
- Emitters upgraded from transient → persistent:
  - `remoteBrainFor()==nil` on an HF session (unconfigured)
  - `rb.Chat` failure (unreachable / 401 / 429) before the direct fallback
  - (Phase 2) watchdog cancel; (Phase 5) PM-on-HF at session create.
- chatpanel.js: live + replay handler → `role:'notice'` bubble, amber-ink
  system styling via theme tokens (NO hardcoded colors), non-terminal (does
  NOT park the queue like errors).
**Tests:** Go test — fallback path persists a notice row; rig — notice bubble
renders + survives replay.

## Phase 2 — v1.10.2 THE BLACK-HOLE GUARD
**Problem D1.** Constraints: the v0.80.1 user directive REMOVED kill timers
("models should be able to keep going as long as they like") because SLOW ≠
stuck (shared space pays 2–6 min silent per legitimate model call). The
guard must distinguish *black hole* (never a first byte) from *slow*.
**Fix (brain — pre-flight, never mid-turn):**
- providers path: on an HF space (env `SPACE_ID` present), before the FIRST
  model call of a turn, if the provider's health is unknown/stale, run a
  15s **reachability probe** (1-token litellm call). Stall → record a 30-min
  cooldown, emit an honest error event naming the provider + advice ("NVIDIA
  is not answering from this sandbox right now — switch provider or retry
  later"); the turn fails FAST (~15s) instead of hanging a day. Pass → cache
  ok 10 min, call proceeds untouched. NO running call is ever cancelled.
**Fix (engine — remote.go, for spaces running OLD brains):**
- `Chat` wraps the SSE stream: consecutive progress-only heartbeats with
  ZERO LLM-ish events (thinking/assistant/tool/round) for **10 min**
  (tunable `DOOMALAY_HF_STALL_KILL`, 0=off) → cancel the SPACE call only
  (child ctx, not turnCtx), inject the honest notice + run the direct
  fallback. 10 min > the shared-space 6-min worst case with margin; the
  user's Stop button remains the manual override.
**Tests:** unit (watchdog fires on synthetic heartbeat-only stream; does NOT
fire when a tool event lands at minute 9); live e2e — NVIDIA turn ≤ ~12 min
worst case, notice + fallback visible; a working provider turn unaffected.

## Phase 3 — v1.10.3 THE SPACE KNOWS ITSELF
**Problem D4.** HF sets `SPACE_ID` in every space; the brain never reads it.
**Fix (brain):**
- dt_hf.py: `_default_repo()` — empty repo on space_* actions → SPACE_ID;
  HELP text says "omit repo to act on the Space you're running in".
- New `self` action: SPACE_ID, hardware, CPU count, memory (/proc/meminfo),
  disk (shutil.disk_usage on /data + /), python/node versions, uptime,
  workspace path — the "knows everything about itself + its free memory and
  disk" mandate.
- HARNESS.md: "Your own Space" section (identity, self default, what to tell
  users about free RAM/disk, ephemeral rules).
**Deploy:** commit brain files to the test space via the NDJSON API +
factory restart. **Tests:** live e2e — "show me your build logs" with no
repo → own build log tail; "how much disk/memory do you have" → real numbers.

## Phase 4 — v1.10.4 TOKEN HONESTY
**Problem D2.** `expires_in` is parsed by NEITHER exchange path.
**Fix (engine):**
- hfExchangeCode + hfDeviceExchange return (token, expiresIn); callers store
  vault extra as JSON `{"user":…, "expires_at": unix}` (bare-name = legacy,
  both parse).
- hub.Service: `Username()` parses both shapes; new `TokenMeta()`.
- `/api/hf/account` → `expires_at`, `expires_in_hours`, `expired` (an oauth
  token whose whoami 401s reports expired live).
**Fix (UI hfconnect.js):** "sign-in expires in ~Xh" under the connected card;
expired → amber + Reconnect (re-runs the same flow) + "use a long-lived
fine-grained token instead" guidance linking the token-paste path with the
exact scope list.
**Tests:** unit — both extra shapes round-trip; account fields; UI render.

## Phase 5 — v1.10.5 THE GUIDED FIRST-RUN + PM BADGE
**Problems D5 + the "help unaware users" mandate.**
- sessions create: `sandbox=hf` + provider `privatemodeai` → persist the
  notice "PrivateMode runs locally — this model never reaches the sandbox".
- sandboxpicker.js: the steps strip when no own space is configured —
  [1 Connect HF] → [2 Create your free sandbox / Use the shared sandbox] →
  [3 Chat] — each row live state (✓/◌), taps deep-link to the flow.
- PM models in the picker marked "(local)" on HF chats.
**Tests:** rig — fresh state shows the strip with correct states; PM session
carries the notice; battery transcripts.

## Phase 6 — v1.10.6 THE PROOF + SHIP
Live red-team battery against the REAL space (engine → space → provider),
transcripts saved to `download/hf-chat-v110-evidence/phase6/`:
1. HAPPY — a working provider turn: bash runs (`uname -a`, `free -m`), the
   model shows real output, artifacts attach.
2. HANG — NVIDIA turn: pre-flight probe or watchdog fires ≤ the honest
   bound; notice + direct fallback visible; transcript saved.
3. SELF — "show me your build logs" (no repo) + "disk + memory?" → the
   space answers about ITSELF.
4. UNCONFIGURED — fresh session sandbox=hf, no token: persistent notice,
   turn still answers on the direct pipeline.
5. TOKEN — expiry fields render; simulated-expiry reconnect card.
6. PM — PM-on-HF session: badge + notice present.
Then: go test ./…, standing rigs (v0899 v0852 v0831 v0812 v0854 v0901,
theme twins, uikit), engine rebuild, rebase onto origin/main (parallel-bot
protocol), push, tags v1.10.1…v1.10.6 + v1.11.0-the-hf-truth-wave.

## THE PROOF (what the user can verify)
- The evidence folder: every battery transcript (full SSE event dumps).
- The APK: fresh CI build after push — HF chat → the notices appear in the
  UI, NVIDIA turns fail honestly, the space answers self questions.
- The space itself: `hf space self` / "what can you do" → reads HARNESS.md.
