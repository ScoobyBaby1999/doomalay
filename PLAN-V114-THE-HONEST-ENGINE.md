# PLAN-V114 — THE HONEST ENGINE (the ledger / the trace / the solid stream)

The directive (the user's words): "the chat works on the surface, but under
the hood everything is broken — tools starve, streams stop and REPLACE,
reasoning leaks, and none of the numbers (usage, max usage, context length,
auto-compaction) are verified. Delegate to specialized opensource libraries."

This wave runs IN PARALLEL with PLAN-V113-THE-MCP-WAVE.md (the mcp-go bus —
the other bot's lane, v1.13.1..v1.14.0). That plan's own words: "the otel
submodule + our observer hooks are the instrumentation points the parallel
tiktoken/OTel bot stacks on." This plan IS that bot. Version lane: phases
v1.14.1..v1.14.4, ship v1.15.0.

## Research verdict (search-verified this wave)

| Need | Verdict |
|------|---------|
| Real token counts | **pkoukk/tiktoken-go v0.1.8** (955★, pure Go, dlclark/regexp2). Default loader fetches BPE from OpenAI's blob at RUNTIME — forbidden on Android. Fix: `go:embed` cl100k_base.tiktoken.gz + a custom BpeLoader that ignores the URL. EncodeOrdinary never panics on special tokens. |
| Model ground truth | **models.dev api.json** — 226 providers, per-model `limit.context`, `limit.output`, `cost.input/output` ($/M), `tool_call`, `reasoning`. Snapshot rebuilt into `catalog/modelsdev_snapshot.json.gz` (11,911 keys, 103KB gz): full `provider/model` keys + unambiguous bare ids, empty records dropped. Refresh script in scripts/ — refresh NEVER blocks a turn. |
| Pricing | models.dev costs become PRIMARY; the curated priceRules survive as the fallback for models the snapshot doesn't know (opencode/privatemodeai are not in models.dev); source is labeled end to end. |
| Observability | **otel-go + GenAI semantic conventions** as the spine, OTLP/HTTP exporter (default OFF, settings-gated); **Langfuse v3 self-host** ingests OTLP natively (no official Go SDK exists — verified). Lands in Phase 2 ON the MCP wave's Observer hooks. |
| Frameworks | eino / langchaingo / genkit / bonnie / agent-framework-go: all REJECTED (the engine IS the framework; runs die with the app process). |
| Tools | the MCP bot's lane (bus shipped). NO fallbacks per directive: native tool_calls only, providers that 400 tools run tool-less honestly. |

## Phases

### v1.14.1 — THE LEDGER
1. **tokens.go** — `go:embed catalog/cl100k_base.tiktoken.gz`; offline BpeLoader
   (gzip + `base64 rank` parse); lazy `sync.Once` install; `CountTokens`
   (EncodeOrdinary, heuristic fallback). `EstimateTokens(s)` upgrades to real
   BPE counting; `EstimateTokensN` (byte-count form, used where only sizes
   exist) stays heuristic and is documented as such.
2. **modelsdev.go** — embedded snapshot; `LookupSpec` (exact → drop-prefix →
   suffix scan, negatives cached); `SpecContext` / `SpecMaxOutput` /
   `SpecPrice` / `SpecSupportsTools`.
3. **pricing.go** — `LookupPrice`: snapshot primary → curated fallback →
   unpriced (source labeled). `ContextLimitFor`: snapshot primary → ctxRules →
   65536. Auto-compaction + the context ring get REAL windows for free.
4. **The spec-driven floor** — the v0.95.4 output-floor hook keeps its
   provider gate (nvidia/together), but the VALUE becomes the model's
   documented `limit.output` from the snapshot (fallback 16384). The
   400-strip retry survives untouched as the safety net.
5. **Usage honesty** — `Usage` carries `finish_reason` + `output_cut`;
   scanSSECollect captures the last terminal reason; mergeUsage keeps the
   LAST round's terminal state; server passthrough persists both; the usage
   endpoints expose per-model length-cut counts, finish-reason histograms,
   and the price/limit SOURCE.
6. **The 92% context guard** — before dispatch in llm.Chat: real BPE count of
   the assembled request vs the snapshot window; >92% emits ONE progress
   notice with the actual numbers (informational — compaction still owns the
   trigger; the guard makes the invisible visible).
7. Tests: token counts (exact cl100k expectations), spec lookup matrix,
   floor body assertion via httptest, finish_reason capture, guard firing.
   `go test ./...`.

### v1.14.2 — THE TRACE
otel-go (no-op default), GenAI semconv spans (turn → llm call → tool call),
OTLP/HTTP exporter behind settings, Langfuse v3 self-host documented as the
first sink. Hooks = span events, riding the MCP wave's Observer chain.

### THE SOLID STREAM (planned v1.14.3; lands v1.14.6 — the MCP wave's script
### commits took v1.14.2/3, THE TRACE took v1.14.4, the E2E heals v1.14.5)
RE-SCOPED by the user (the three corrections): one bot per convo → per-bot
isolation is the law; per-chat WebSockets are already the transport (keep
them); turns may run 24h+ — the continuation ban was on UNKNOWABLE loops,
not long turns.

1. **Per-bot isolation (the user's infrequent leak)** — the user hit tools
   generating for all bots of one provider across fresh chats. Root cause
   found in the audit: `opencodeSessionCache` derived x-session-id PER API
   KEY — every chat on the same key shared one upstream Zen session
   identity. Fix: scope per chat session id (stable across restarts, unique
   per bot), per-key fallback only for sessionless paths (probes). Full
   package-state audit lands with it: config tables stay read-only; any
   state touched per request must be sharded by session id or mutex-guarded.
2. **Per-bot terminal-state machine** — one FSM INSTANCE per turn/bot
   (owned by the turn goroutine, keyed by req.SessionID — no global mutable
   state): dispatch → open → streaming → tool rounds → terminal verdict.
   Generalized over every stream path (the silent-stop net leaves the
   native-only ghetto): a stream that stops without a terminal verdict
   (stop/length/tool_calls/error) is detected, recorded via the LEDGER's
   finish_reason plumbing, and healed — never silently done.
3. **Reasoning normalization table** — reasoning_content (DeepSeek-style) /
   reasoning (OpenRouter-style) / `<think>`-in-content stripper → one
   canonical reasoning channel for every provider.
4. **PWA append-only + the WS-replay rig** — per-chat WS confirmed as the
   architecture (one socket per session, generation-guarded swap, the turn
   survives reconnects server-side; workspace grouping stays a UI-stub,
   NOT transport multiplexing). Gaps to close: reconnects upgrade to
   `since=<lastSeq>` incremental replay (full replay only on cold open);
   the derived-messages pipeline becomes incremental (per-event reducers,
   not eventsToMessages(all) per event — O(n²) melts on 24h turns); the
   rig proves open → stream → drop → reconnect(since) yields byte-identical
   state vs the never-disconnected control.
5. **The honest continuation engine (the user's 24h-turn directive)** —
   finish_reason=length is PER-COMPLETION physics (the provider's
   limit.output), not a turn limit; a turn is a chain. When a completion
   ends on the cap mid-sentence, the engine continues from where it stopped,
   governed by a PER-CHAT TURN BUDGET (the user's slider: Off / N rounds /
   Unbounded — default Unbounded; taught to the bot in the session preamble
   so it knows its own policy). Every continuation is announced in-band
   (round no. + tokens carried), persisted, traced (the v1.14.4 rings),
   usage-accumulated live, interruptible by the stop button. A no-token
   stall is NOT a continuation (the stall-guards keep their job);
   compaction owns the context window across rounds.

### v1.14.7 — THE STEADY HANDS (post-MCP leftovers; planned v1.14.4, the label went to THE TRACE)
Tool-result enrichment (the Anthropic effective-tools guidance); the two dead
tools get real returns or honest removal; native tool_calls stay the ONLY
path (no fallbacks — done by the MCP wave, verified here).

### v1.15.0 — ship
The wave record + buildinfo bump + rebase-before-push.

## Will-NOT (the spaghetti boundary)
- No framework adoption; no vendor SDK lock-in beyond tiktoken-go + otel-go.
- The snapshot refresh NEVER blocks a turn (embedded copy serves; refresh is
  a build-time action).
- The guard NEVER blocks or cancels a turn — it only speaks.
- Silent continuation is banned; long turns are not. Unbounded continuation
  (Phase 3, the user's 24h directive) is legal ONLY because it is announced,
  traced, budgeted per chat, and interruptible — a loop nobody can see is
  the failure mode; a loop on the timeline is a feature.
- The per-completion output cap (limit.output) is provider physics — the
  engine never fakes it away; it chains completions honestly instead.
- No transport multiplexing: one WebSocket per chat stays (decoupled bots,
  independent lifecycles); grouping is a UI concern.
- No usage-endpoint breaking changes: new fields are additive.
