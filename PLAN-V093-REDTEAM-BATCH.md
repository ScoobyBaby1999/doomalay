# PLAN-V093 — THE RED-TEAM BATCH (14 live-device findings → root causes → phased fixes)

Every finding below was reproduced or root-caused against the LIVE system (the
user's API keys, the shared space, the real OpenRouter/PM/HF endpoints) before
a single line was planned. Research phase: OpenRouter reasoning/free-tier docs
+ live registry probes; Go tls:bad-record-MAC issue class; HF Hub create-repo
API (model|dataset|space) + Spaces storage limits (1GB repo git/LFS, ephemeral
disk); live fresh-session red-team on doomalaysocreate (bash works, HARNESS.md
missing from the workspace, PM sidecar mesh-CA flakiness).

════════════════════════════════════════════════════════════════════
THE ROOT-CAUSE TABLE (finding → cause → fix phase)
════════════════════════════════════════════════════════════════════

| # | user finding | root cause (verified) | phase |
|---|--------------|----------------------|-------|
| 1 | lyria-3-clip: `bufio.Scanner: token too long` | chat.go:867 SSE scan buffer caps at 256KB; lyria returns base64 media lines ≫256KB | P1 |
| 2 | OpenRouter: no reasoning shown | delta struct parses ONLY `reasoning_content`; OpenRouter streams `delta.reasoning` (live-probed) | P1 |
| 3 | OpenRouter: "no longer available for my account" | stale cached `:free` slugs 404 ("use this slug instead" — OpenRouter retired the popular :free tier Sept 2026; live registry now only 17 :free + `openrouter/free` router) | P1 |
| 4 | OpenRouter: free model "quota reached" | (a) 429 upstream shared-pool reads as generic capacity; (b) 402 "never purchased credits" reads as "free quota used up" — both mislabeled | P1 |
| 5 | provider/model screen has 2 X's | ConnectOverlay renders the static ✕ AND modelbrowser renders its own mb-close ✕ | P4 |
| 6 | create-repo: license stays none, .gitignore never loads | wireCreateForm only calls loadLists() when accounts[kind].signed_in is already populated at wire time (async race → never loads); license list carries bare keys, no names/descriptions | P5 |
| 7 | HF repo creation: "kind must be GitHub|gitea|gitlab" | handleCreateRepo's host map rejects kind=hf even though forge has hfCreateRepo; HF has no license/gitignore concept at all | P5 |
| 8 | HF repos should be bucket/dataset/space choices | HF create-repo = type model|dataset|space (research-verified); no license/gitignore; ~1GB git/LFS repo storage per space + ephemeral disk | P5 |
| 9 | loading-spaces pill: position + static text | renderProvSection puts repos box LAST + static "loading your repos…" text | P4 |
| 10 | artifacts screen can't slide down | artifacts overlay closes via scrim/✕/back only — no drag gesture | P4 |
| 11 | Mistral: `tls: bad record MAC` when chaining tools | isTransientNetErr lacks tls/bad-record-MAC patterns → the pause ladder never retries (fresh-conn retry is the documented cure for this network-corruption class) | P2 |
| 12 | Mistral turns "killed by engine restart" | the llm.Chat producer goroutine has NO recover() — a panic in the tool-chain loop kills the whole engine → the Android watchdog restarts it | P2 |
| 13 | tool chains: text vanishes + final reply streams in the wrong place | runReActRoundStream suppresses preambles; >700B preambles flush as "final" then `assistant_reset` WIPES them when the ACTION parses — so visible text disappears per round and the final answer reuses a stale bubble position | P3 |
| 14 | HF: "forge does not support that operation" on file delete | Client.DeleteFile dispatches ONLY github; HF delete needs the NDJSON `deletedFile` commit op (unused by the engine forge layer) | P5 |
| 15 | HF quick chat: no bash/ssh, just git+file-write | QUICK chat = the engine's direct pipeline (no shell by design); the HF SANDBOX path has real bash (live-proven: 7 tool calls incl. 5×shell) — the gap is awareness (16) + honest messaging | P3/P6 |
| 16 | fresh HF session doesn't know HARNESS.md / can't bash | _seed_harness only runs in StrandsAgentCore.__init__; the CHAT path (_run_strands_agent → _build_tools) never seeds HARNESS.md into the workspace (live-repro: bot found it only at /app/brain/HARNESS.md) | P3 |
| 17 | PM mesh-CA errors on the space (chaining) | pmproxy caches a wasm core per key FOREVER; when the attestation manifest rotates mid-session the core is poisoned and every later call fails ("updating mesh CA: active manifest does not match") — live-repro 2/3 | P3 |
| 18 | Nvidia: green connected border, no "use N models" pill, dimmed in catalogue | dd-active ring rides cfg.color (#76B900 brand green — violates the theme mandate); Use pill requires catalogModels.length>0 which is 0 while Nvidia's throttled sync lags; browser dims unsynced providers | P4 |
| 19 | persona default pill / sandbox-method switch | default pill is mode-aware but a SAVED default text freezes (never follows mode changes); switching sandbox method mid-chat never re-points an unedited persona | P6 |
| 20 | "waking the HF sandbox" when already running | RemoteBrain.healthy=false at every engine boot → first turn always claims "waking… up to a minute" + 75s patient probe even when the space answers in ~1s | P3 |

════════════════════════════════════════════════════════════════════
PHASES (pushed one by one, x.x.N)
════════════════════════════════════════════════════════════════════

── P1 · v0.93.1 — THE OPENROUTER HONESTY WAVE (engine/llm) ──────────
1. scanSSECollect/scanSSE buffer: 256KB → 16MB max (64KB initial). Media
   models (lyria) stream multi-MB base64 SSE lines; also guard: token-too-long
   now surfaces a plain-language error ("this model's response lines exceeded
   16MB — likely a media payload the chat can't render").
2. openAIChunk.Delta gains `reasoning` (+ `reasoning_content` kept). Both
   merge into the thinking stream. Live-verified field on
   liquid/lfm-2.5-2.6b:free.
3. friendlyHTTPError OpenRouter branches:
   - 404 "use this slug instead: X" → "OpenRouter retired this free variant —
     X is the paid slug. Try openrouter/free (routes to whatever is free
     right now) or another provider." Attach the suggested slug to the error
     event so the model-gone one-tap chips can offer it.
   - 402 "never purchased credits" → "your OpenRouter key has no credits —
     free models still work (openrouter/free, the 17 live :free models)".
   - 429 "upstream shared pool" (metadata.limit_source=upstream_provider_shared_pool)
     → "the FREE pool for this model is rate-limited upstream (shared by all
     OpenRouter free users — not your quota; yours: 50/day). Retry shortly or
     switch models."
4. Catalog: keep the live registry as truth (it already dropped the dead
   :free slugs); surface `openrouter/free` FIRST in the OpenRouter provider
   view (sort tweak: the free router + zero-priced entries at top).
Tests: unit pins for the buffer bump + both reasoning fields + the three
friendly branches; e2e mock-server rig replaying the three live error bodies.

── P2 · v0.93.2 — THE MISTRAL SURVIVABILITY WAVE (engine/llm) ───────
1. isTransientNetErr += `bad record mac|tls:|record mac|handshake failure`
   → the netPauseLadder retries on a FRESH connection (Go's transport drops
   the poisoned conn; the retry is the documented cure for mid-stream TLS
   record corruption through carriers/proxies).
2. llm.Chat producer goroutine: defer recover() → honest error chunk +
   terminal status ("internal error — turn recovered; the engine stayed up")
   instead of a process kill. The Android watchdog restart is the last
   resort, not the first responder.
Tests: unit pin for the regex; a panic-injection rig proving the turn ends
with an error chunk and the process survives.

── P3 · v0.93.3 — THE TOOL-CHAIN FLOW WAVE (engine/llm + server + brain)
THE CHAT-FLOW REDESIGN (user spec: "flow like a chat — many responses that
remain in the position they should be and stream with the conversation"):
1. runReActRoundStream: on ACTION detection, the held preamble (minus the
   ACTION line itself) EMITS as its own visible segment, then a new
   `round_end` chunk finalizes that assistant block. The leak-backstop
   assistant_reset becomes the rare edge (still kept, now only for the
   >700B flush-then-ACTION case where the text ALREADY streamed — and it
   finalizes the block instead of deleting it).
2. server/chat.go: assistantParts per SEGMENT — each round's text persists
   as its own `assistant` event (round_end splits segments) so replay
   reconstructs the exact same flow. The final answer is the last segment.
3. chatpanel.js: round_end closes the streaming bubble (complete=true) —
   the next round's deltas open a NEW bubble under the tool pills; the
   final answer streams at the bottom of the conversation. No more
   vanish/reappear.
4. brain/agent.py _build_tools: seed HARNESS.md into the chat workspace
   (copy-if-absent, same as StrandsAgentCore._seed_harness) + fix the stale
   AUTO_MODEL_FALLBACK (kimi-k2.6 → glm-latest class).
5. brain/pmproxy.mjs: on mesh-CA/attest/secret errors mid-call → evict the
   poisoned core for that key, retry ONCE with a fresh core (fresh
   attestation), honest error only if that fails too. Creation retry 3×
   stays.
6. RemoteBrain wake honesty (server/chat.go): quick 3s probe FIRST; only
   when it fails show "waking the HF sandbox…" + the patient 75s probe. A
   running space answers in ~1s with no scary message.
Tests: engine round-flow rig (preamble → ACTION → tool pill → round 2 →
final answer — events + persisted segments asserted); brain harness-seed
test (fresh workspace → HARNESS.md present); pmproxy poison test (mock core
failing with mesh error once → request still succeeds via fresh core).

── P4 · v0.93.4 — THE UI POLISH WAVE (web) ───────────────────────────
1. 2 X's: modelbrowser drops its own mb-close ✕ (the overlay's static ✕ is
   the single chrome; the close handler routes to ConnectOverlay.close()).
2. Nvidia connected box: dd-active ring uses var(--accent) (theme) — brand
   colors stop painting UI chrome (the dot avatar keeps its letter, drops
   the brand fill for theme surface).
3. Use-pill: renders whenever the key is active + onPick — synced count
   ("Use 38 models →") or lags ("Use NVIDIA → sync 38 models") with a tap
   triggering the catalog resync; modelbrowser re-syncs a dimmed provider
   on open instead of staying dimmed.
4. Loading repos box: moves ABOVE the create/connect pills; the static
   text becomes an indeterminate loading bar (primary theme colors —
   var(--accent) track/fill) + accompanying text.
5. Artifacts overlay: drag-down-from-the-top gesture — the header strip is
   the grab handle; translate the panel with the finger, >120px release
   closes, < snaps back (respects the live-editor dirty guard).
Tests: existing web rigs re-run + a gesture rig (pointer events sequence).

── P5 · v0.93.5 — THE REPO-CREATION WAVE (forge + server + web) ──────
1. License/gitignore lists ALWAYS fetch on form open; a 401 renders an
   inline "sign in to load the full list" hint instead of silent none.
   Licenses return key+name pairs ("mit — MIT License") from GitHub's
   /licenses (name is already in the response — we only kept the key).
2. handleCreateRepo accepts kind=hf: host huggingface.co, forge.HF HostInfo,
   hfCreateRepo returns RepoMeta; the fresh repo connects full-access.
3. The HF create form is TYPE-FIRST (the user's redesign): "what do you
   want to create?" → Space (the app sandbox — 1GB repo storage, runs the
   chat sandbox), Dataset (the data bucket), Model repo (weights/cards) —
   license/gitignore fields HIDE for HF (not HF concepts; an honest note
   says so). Device storage stays the fourth option (already exists).
4. forge DeleteFile: hfDeleteFile via the NDJSON `deletedFile` op
   ({"key":"deletedFile","value":{"path":…}} on /api/<type>/<repo>/commit/main);
   dispatch in Client.DeleteFile. The workspace tool's file_delete works on
   HF repos from then on.
5. workspace tool "create" action: kind=hf rides the same type-first
   options (the bot creates buckets/datasets/spaces on the user's behalf
   with their connected token + says what it made).
Tests: forge hfDeleteFile rig (mock commit endpoint — NDJSON shape pinned);
create-repo handler pin for kind=hf; web form unit pins.

── P6 · v0.93.6 — THE PERSONA DEFAULTS WAVE (personas + web) ─────────
1. Saving the UNTOUCHED default keeps text EMPTY (empty = "follow the
   mode's default") — a default never freezes into an edited persona.
2. Sandbox-method switch mid-chat: applySandbox fires
   doomalay:sandbox-changed; the persona module (and the engine PATCH
   handler) re-points personas whose text is empty OR verbatim-equal to a
   default template (unedited) to the new mode's default. Edited personas
   never move.
3. The editor's ↺ default pill keeps defaultPersonaFor(cur.sandbox) (fresh
   loadSession per open — verified) + the editor preview notes which mode's
   default is in view.
Tests: engine pin (sandbox PATCH re-points unedited personas); UI pin
(switch → persona preview swaps only when unedited).

── P7 · v0.93.7 — THE SPACE REFRESH + CLOSEOUT ───────────────────────
1. Deploy the refreshed brain (harness seeding, pmproxy poison-retry,
   AUTO_MODEL_FALLBACK fix, catalog with mistral — the deployed space's
   catalog lacks it: live /models shows no mistral) to BOTH spaces
   (doomalaysocreate + final-test).
2. LIVE RED-TEAM (the user's own test plan): fresh-session bash+HARNESS.md
   on every connected provider (PM, Mistral, Nvidia, OpenRouter); PM
   chaining 3+ tool calls; Mistral TLS-retry; OpenRouter reasoning + free
   models + lyria; persona default swaps; repo creation all kinds; delete
   file on HF repo; the 2 X's; the loading bar; artifacts slide-down;
   Nvidia pill/border.
3. The previous session's leftovers (if room): Kronos #readme → finance/
   prediction tags; superpowers/deep-research tag renames.

════════════════════════════════════════════════════════════════════
GUARDRAILS (every phase)
════════════════════════════════════════════════════════════════════
- No hardcoded colors: every new UI element rides theme vars (--accent,
  --surface-N, --text-N, rgb() alpha tints).
- New UI lives ONLY on the panel or the Overlay screen (no new surfaces).
- Push protocol: rebase (fetch + diff + merge errors check) → phase commit
  → tag → APK parity build → push. Phase numbers x.x.N.
- The user's keys are for LIVE red-teaming only — never committed (the
  v0.91.5 push-protection lesson; env-var pattern in every rig script).
