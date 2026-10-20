# PLAN-V146 — THE CLEAN MIND

The user's post-v1.45.0 device report, verbatim: *"It works! Great job! But still we
can do with some fixes. First the pm native reasoning shows duplicate texts. Every
word appears twice in it's reasoning for some reason… I'm not sure what else uve
missed in that regard. But it seems native can still use some work."* (A parallel
bot is working the same report — this wave coordinates through the record chain:
fetch before push, verify any landed fix against the live-captured fixtures below.)

Research verdicts (this session, LIVE-PROVEN against the real deployment with the
real key — probe: `engine/cmd/pm-reason-probe`, throwaway, never committed):

- **V1 — THE ALIAS PAIR (root cause of "every word twice").** The PM gateway
  (`system_fingerprint: vllm-0.31.0-tp4-ep-2e04e944`) emits EVERY reasoning delta
  in BOTH wire spellings simultaneously, byte-equal:

  ```json
  {"delta": {"reasoning": "The", "reasoning_content": "The"}}
  {"delta": {"reasoning": " user", "reasoning_content": " user"}}
  ```

  vLLM renamed the channel (`docs.vllm.ai`: *"reasoning used to be called
  reasoning_content. To migrate, directly replace…"*); the deployed gateway serves
  BOTH names for client compatibility. Convicted on **glm-5.3** AND
  **gpt-oss-120b**, plain turns AND tool rounds, streaming AND non-streaming (the
  `message` object carries the same alias pair). The engine's normalization
  (chat.go:1384) merges `Reasoning + ReasoningOR` — built on the comment's
  assumption *"only one shape is ever non-empty per chunk in practice"*
  (v1.14.6) — so PM's every word concatenates with itself: "The The  user user …".
  Content is a single field (live-verified: clean `"Four"`), which is why ONLY the
  reasoning doubles — the user's exact symptom.
- **V2 — THE DROPPED REASONING LEDGER.** The same gateway reports
  `usage.completion_tokens_details.reasoning_tokens` in EVERY chunk (live: 53 of
  56 completion tokens were reasoning — the answer was one word). The engine's
  `openAIChunk.Usage` never parses it; the LEDGER (v1.14.1: token usage is
  honest) shows in/out/total but the reasoning share is invisible — a PM-native
  daily driver thinks heavily, and the numbers never say so.
- **V3 — THE CLEAN AUDIT (what else was checked and is NOT broken).** Live-proven
  this session: tool-call deltas are the standard OpenAI shape (id+name first,
  argument fragments after) — native tools fine; the non-streaming path uses
  `content` (present) with the alias pair unused — fine today; the PM model
  catalog filters non-chat tasks (whisper/embed) — fine; the effort arm maps
  glm → `reasoning_effort`, kimi → `chat_template_kwargs` — fine; the UI thinking
  render appends deltas efficiently (`text +=` + scheduled paint) — the doubling
  was 100% engine-side; PM needs no `max_tokens` floor (vLLM defaults to the
  model's headroom).

## The phases

- **v1.46.1 THE ALIAS LAW.** `reasoning.go`: the two wire spellings are
  DOCUMENTED ALIASES of ONE channel — `mergeWireReasoning(reasoningContent,
  reasoning)`: both non-empty + byte-equal → ONE copy (the PM shape); both
  non-empty + different → concatenated (unknown shapes keep every byte — the old
  behavior, zero regression risk for OpenRouter's `reason`-only and NIM's
  `reasoning_content`-only); one non-empty → that one. The normalization table
  gains the alias row; chat.go's two merge sites (the trace gate at :1358 and the
  canonical onDelta at :1384) consume the merge; the stale "only one shape"
  comment dies. Unit tests pin the LIVE-CAPTURED PM chunks byte-for-byte.
- **v1.46.2 THE REASONING LEDGER.** `openAIChunk.Usage` parses
  `completion_tokens_details.reasoning_tokens` → `llm.Usage.ReasoningTokens` →
  the live usage event + the persisted status usage → `usage.go` accumulates the
  per-chat + global sums → the usage panel gains a "thinking tokens" stat
  (theme-token styles only — the no-hardcoded-color law). Old sessions parse 0
  (additive JSON, no migration).
- **v1.46.3 THE PROOF.** The pmlive gate asserts the streamed thinking text
  contains NO doubled words (word-level dedup assertion, real key); the fixture
  rig pins the live-captured shapes (glm + gpt-oss + tools round + usage
  details); agent-browser drives a real engine turn end-to-end (thinking text
  renders once, the usage panel shows the reasoning share); regression batteries:
  v1350, v1400, v1440, v1450, the go suite, all pmlive gates.
- **v1.46.4 THE SHIP.** buildinfo 1.46.0; README + OTA notes that EXPLAIN the
  why (the gateway's dual-spelling compat shim × the engine's merge); the record
  chain; cross-compile linux + android-arm64; CI green; tag
  `v1.46.0-the-clean-mind`. Rebase over any parallel fix — if the sibling bot
  landed the alias fix first, their variant is verified against the same live
  fixtures and exactly one fix ships.
