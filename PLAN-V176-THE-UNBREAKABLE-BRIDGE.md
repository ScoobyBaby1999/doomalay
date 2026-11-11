# PLAN-V176 — THE UNBREAKABLE BRIDGE

The user's ask verbatim (the network-reliability prompt, 2026-11-11):
> "The current code does not fully account for bad or poor networks, and there
> are several targeted optimizations you can make to improve reliability
> without changing how the architecture works." — bridge.go talks to a local
> Python process (never drops), but that Python brain calls external AI APIs
> over the internet, so slow/dropping Wi-Fi directly stalls or breaks the
> HTTP requests inside bridge.go. No client timeouts, no streaming stall
> watchdog, no retry on transient glitches, MarkUnhealthy never wired to the
> failures it was built for, dead query-param code, hand-rolled SSE slicing
> that swallows malformed JSON, and a double Python boot at startup.

## THE CONVICTIONS (from the user's audit, verified against the live code)

1. **THE INFINITE HANG**: `Chat` and `Models` ride `http.DefaultClient`
   (bridge.go:206, :282) — no timeout anywhere. A Wi-Fi black-hole (silent
   drop, no clean FIN) hangs both forever unless the caller happens to
   cancel the context. `waitHealthy` (:112) and the `MarkUnhealthy`
   re-probe (:317) use bare `http.Get` — same disease.
2. **THE ZOMBIE STREAM**: mid-turn, if the brain's provider connection
   freezes, `resp.Body.Read` sits forever — the user's endless loading
   spinner, live-observed class. The Python side deliberately has no kill
   (v0.80.1 no-kill law, litellm timeout=86400) — the engine is the only
   place a watchdog can live. The REMOTE brain got one in v1.10.2
   (`guardFirstByte` + `stallKillSeconds`); the local bridge never did.
3. **THE ONE-SHOT MODELS**: a 1-second Wi-Fi hiccup kills `Models` outright —
   no retry, while the engine's own egress paths have run bounded backoff
   since v1.61.2 THE PATIENT WIRE (`netx.RetryDo`).
4. **THE UNWIRED HEALTH FLIP**: `MarkUnhealthy` (v0.44.1) exists precisely to
   flip the brain dead after a live connection failure, but `Chat`/`Models`
   never call it — the whole mechanism depends on outside callers
   remembering.
5. **THE DEAD PARAM + THE PILING PROBES**: Models' `refresh` query block
   (:279-281) can never fire (the URL is built with no query; zero callers
   since v1.55.3), and `MarkUnhealthy` has no re-probe single-flight guard.
6. **THE SILENT CORRUPTION**: hand-rolled byte slicing + `json.Unmarshal`
   with the error discarded (:245) — network truncation and serialization
   bugs vanish without a trace. No line cap either: a hostile/hung stream
   grows `buf` without bound.
7. **THE DOUBLE BOOT**: `Start` boots an entire Python interpreter just to
   `import fastapi, uvicorn, litellm` (:58-61), then boots Python again for
   server.py — 1-3s of pure latency on every cold start (Termux included).

## THE RESEARCH (what this rides)

- **Cloudflare's net/http timeout guide** (blog.cloudflare.com, the complete
  guide): phase-specific timeouts — `Transport.ResponseHeaderTimeout` limits
  the wait for headers; `Client.Timeout` must NEVER ride a streaming client
  (long AI answers are legitimate); probes want `DisableKeepAlives` so a
  stale socket can't answer a health check. The engine's own bytesizego-era
  law: `http.DefaultClient` waits forever — a zero-value client is a bug.
- **The ONE retry truth**: `netx.IsTransient` + `netx.RetryDo` (v1.61.2,
  engine/internal/netx/retry.go) — bounded, backoff-paced, ctx-interruptible,
  request-builder pattern (no consumed-body trap), retries only the
  transient class + 5xx, never validation-class 4xx. The bridge adopts it
  instead of growing a parallel classifier (the v1.73.1 law: one truth).
- **The remote twin already models the shape** (remote.go): per-call probe
  client with 15s timeout, no-key probes, `Timeout: 0` on the streaming chat
  client, MarkUnhealthy-on-Do-error. The local bridge mirrors its sibling.
- **The stall precedent**: `guardFirstByte` + `stallKillSeconds`
  (DOOMALAY_HF_STALL_KILL, default 600, 0=disabled) — the synthetic notice
  rides the events stream so forwardEvents persists it like any other; the
  guard cancels the space call the instant it fires (the errs-channel
  blocking-drain law at chat.go:3236).
- **The brain keeps time**: a lightweight progress heartbeat rides every
  model hop every 25s (agent.py v0.76.6, live-found on the HF rig) — a 45s
  no-BYTES watchdog has a 20s margin above the heartbeat period, so slow
  multi-minute tool turns never trip it; only a truly frozen stream does.
- **LiteLLM's wire**: `data: {json}\n\n` lines, terminal `data: [DONE]`
  (docs.litellm.ai/completion/stream) — the scanner preserves the exact
  `data: ` prefix, TrimSpace, and [DONE] semantics, byte for byte.

## THE WAVE (5 phases, riding live buildinfo 1.75.0 → ship v1.76.0)

### v1.76.1 THE PATIENT BRIDGE WIRE — dedicated clients + retry + wired health
New `engine/internal/brain/wire.go` (the reusable component layer):
- **brainClientOptions + newBrainClient**: one factory, three shapes —
  probe (total timeout, DisableKeepAlives), models (total timeout),
  chat (NO total timeout, ResponseHeaderTimeout) — all cloned off
  DefaultTransport, all env-knobbed in seconds mirroring stallKillSeconds:
  `DOOMALAY_BRAIN_PROBE_TIMEOUT` (10), `DOOMALAY_BRAIN_HEADER_TIMEOUT` (30).
  Per-call construction = the remote-twin convention, knobs read live.
- **`probeHealth()`**: one probe component, three users (waitHealthy,
  the re-probe loop, the future keepalive) — never sends provider keys
  (the v0.75 smallest-surface law).
- **`Models` rides `netx.RetryDo`** (3 attempts, 1s base — the forge's
  pacing): a 1s Wi-Fi hiccup survives; 5xx from the brain drains + retries;
  transport-exhausted errors MarkUnhealthy + carry the honest `(retried Nx)`
  suffix. Body capped at 1<<22 (remote-twin parity).
- **`Chat` Do-failure → MarkUnhealthy** (the remote-twin's own law), and a
  200 answer heals `healthy=true` without waiting for a re-probe.
- **THE NON-IDEMPOTENCE LAW**: the /chat POST is NEVER retried — a retry
  could double-run a live agent turn. Only GET-class calls ride RetryDo.

### v1.76.2 THE STALL SENTINEL — the no-bytes watchdog
- `streamWatchdog` (wire.go): a feed/reset timer goroutine, byte-level fed
  by a `feedReader` wrapping resp.Body (a partial line counts — bytes are
  bytes). Fires after `DOOMALAY_BRAIN_STALL_KILL` (default 45s, 0 = the pure
  v0.80.1 no-kill mode) → cancels the stream context → the reader exits →
  `ErrStreamStalled` (typed, errors.Is-able) rides the errs channel →
  MarkUnhealthy (the quiet 15s re-probe revives it).
- **The honest spinner death** (server/chat.go `streamFromBrain`): the
  guardBrainStall wrapper (guardFirstByte's architecture) sees the stall
  error, emits a persisted `{"type":"error","error":"brain_stall",...}`
  event so the turn ends with a red bubble + terminal state — never a dead
  spinner, never a silent log line.

### v1.76.3 THE DEAD-CODE FUNERAL + THE SINGLE RE-PROBE LAW
- The never-firing `refresh` block (Models builds its own queryless URL;
  zero callers since v1.55.3) dies.
- `reprobing` single-flight guard under `b.mu`: only ONE background re-probe
  loop can exist per Brain, no matter how many MarkUnhealthy calls arrive
  while a slow probe is still in flight.

### v1.76.4 THE HONEST SCANNER — SSE parsing that tells the truth
- `bufio.Scanner` (64KB initial / 2MB max) replaces the hand-rolled
  IndexByte loop: handles \r\n natively, one buffer, no repeated slicing.
- Malformed `data:` JSON gets LOUD: one log line with the truncated payload
  + a stream-end count — network truncation and serialization bugs surface
  immediately instead of vanishing.
- A line over the 2MB cap fails CLEANLY (`bufio.ErrTooLong` rides errs)
  instead of growing memory without bound.

### v1.76.5 THE SINGLE PASS — startup in one Python boot
- The deps-check interpreter boot DIES. server.py starts directly; a bounded
  8KB stderr ring (tee'd — live logs keep flowing to the engine console)
  captures an ImportError tail if the process dies young, and the error
  carries the same `pip install -r brain/requirements.txt` remedy + the
  actual module line.
- **Early-exit detection**: the boot watches the process — a dead Python
  fails the start in milliseconds (the captured tail attached), never after
  the full health-window wait. `DOOMALAY_BRAIN_BOOT_TIMEOUT` (10s default)
  knobs the window for slow devices.
- The persistent cmd.Wait goroutine: a clean waitErr/done seam, Stop() rides
  it, and a brain that exits is reaped (no zombie children).

### v1.76.0 THE SHIP — the proof + the record
- The redteam battery: fault-injection chaos suite (stall, black-hole,
  reset, 5xx ladder, malformed lines, oversized lines, dead-process boot,
  slow-deps boot) + a REAL end-to-end: the real Python brain (venv, real
  litellm stack) + a real provider key, driven through Brain.Chat.
- buildinfo **1.76.0** (live 1.75.0 + 1 — the +1 law), the README v1.76
  section, the worklog record, the tag `v1.76.0-the-unbreakable-bridge`,
  push (rebase first — parallel bots may have shipped mid-wave; renumber
  if the wave number was taken).

## THE LAWS (this wave's own)
- **Same signatures, same happy path** — public method signatures are
  byte-identical; a healthy fast network sees identical behavior (the
  user's "preserving full code integrity").
- **One retry truth** — netx.IsTransient/RetryDo, never a parallel
  classifier; one probe truth — probeHealth; one client truth —
  newBrainClient.
- **Honesty all the way down** — every new failure mode produces a clean,
  typed, surfacable error (stall sentinel, retried-Nx suffix, captured
  stderr tails), never a silent swallow, never a dead spinner.
- **Zero UI, zero theme tokens, zero new surfaces** — this wave is
  wire-level only; the two sanctioned surfaces (the panel, the overlay)
  are untouched.
