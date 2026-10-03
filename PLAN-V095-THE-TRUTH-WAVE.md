# PLAN-V095 — THE TRUTH WAVE (8 live-reported issues, all root-caused)

Evidence: the four exported chatlogs (scooby/boonboon/trippy/faqous, 2026-10-03,
on the v0.94.x tree) + four parallel deep traces + live probes (litellm
reasoning strip proven against a mock NIM; the raw openai client proven to
preserve `reasoning_content`) + web research (DSML leak is an industry-known
class — llama.cpp/openclaw/OMP all carry DSML strippers; native function
calling measurably beats prompt-shaped JSON for schema-validity; MCP is a
tool-discovery interop protocol, complementary — NOT a weak-model accuracy fix).

## Issue → root cause → fix map

| # | User report | Root cause (proven) | Phase |
|---|---|---|---|
| 8 | Cross-chat leak (Nemotron reply in Scooby's log) | Client cross-bind: send frames carry NO session_id (chatclient.js:244), engine executes them in whatever session the socket was opened for (chat.go:807); connectWS revives stale clients bound to another session (chatpanel.js:3938-3947); the v0.38 two-icons-one-session heal runs only at restore (app.js:2048-2071); engine silently PERSISTS send-frame model overrides (chat.go:895-900,1009-1012) so a misrouted send rewrites the session's model too | **v0.95.1** |
| 5 | Final response replaces the previous one's position; tools spam below | THREE defects: (a) brain path emits NO round/segment events (v0.93.3 instrumented only the two engine paths) → pill-less segment boundaries glom into the last open bubble (chatpanel.js:4474-4487 singleton-by-position); (b) direct path ships the trailing full-text `assistant` event AFTER `status:idle` (chat.go:1651-1665) → completeAllStreaming breaks roundFlowApply → duplicate bubble; (c) no new-bubble rule on segment start after a completed message | **v0.95.2** |
| 7 | No reasoning for nvidia/mistral (only PM) | litellm 1.55.10's transformation layer strips `reasoning_content` before BrainLiteLLMModel sees it (live-proven); PM reads raw SSE in-browser (works), engine direct path reads raw SSE (works) → only the brain path is blind. kimi-k3 missing from reasoning_catalog.json (only k2.6) → no thinking param → raw garbage | **v0.95.3** |
| 6 | Tool system unreliable, weird chars, cut-off .MD contents, nudge spam | Protocol mixing (ACTION text syntax taught alongside native tools); ZERO DSML stripping anywhere (deepseek markup leaks into content); NO max_tokens ever set → provider defaults (4-1024) silently cut long outputs, finish_reason=length never checked; repairJSON silently executes TRUNCATED calls; no repeat-call dedup; 11 nudge injection sites across 4 paths | **v0.95.4** |
| 4 | HF chats: harness.md a liar, no bash | CLIENT routing: chatframework.js only registers QuickChatType; send() checks provider BEFORE sandbox → PM + hf runs the local PM bridge, never the Space (engine routing is correct + the Space HAS real bash + a PM sidecar). Compounding: pmSystemMessage promises the Space persona; no artifact_read tool exists so models can't even read the drawer's HARNESS.md | **v0.95.5** |
| 1 | Double X on catalogue; no auto-refresh on provider connect | connectoverlay.js renders the static ✕ on every overlay (v0.46) AND modelbrowser.js renders its own mb-close ✕; catalog caches in localStorage, only key add/remove inside the browser invalidates it | **v0.95.6** |
| 2 | Loading repos box: static text | workspace.js .wsp-loading is plain text (line 695/841) | **v0.95.6** |
| 3 | Artifacts drawer can't slide down to close | artifacts.js overlay has no top-edge gesture | **v0.95.6** |

## Phase plan (build order = dependency order)

### v0.95.1 THE ISOLATION WAVE (issue 8 — the leak)
- Engine chat.go handleChatWS: send/stop/hide frames MUST carry session_id;
  mismatch vs the socket's session → error event, never executed. Absent
  session_id (old client) → allowed (back-compat).
- Engine: send-frame model/provider = per-turn override ONLY, never persisted
  (the UI already persists via PATCH /api/sessions — verified chatpanel.js:5573).
- chatclient.js: send() always includes session_id.
- chatpanel.js connectWS: rebuild the client when state.client.sessionId !==
  state.sessionId (kill stale-client revival).
- app.js chatframework: runtime duplicate-bind heal — binding a session already
  bound to a LIVE icon rebinds the stale icon (extend the restore-time v0.38 heal).
- Rig: two sessions, one mock provider, interleaved sends + a forged
  session_id frame → assert rejection + zero cross-contamination in both logs.

### v0.95.2 THE SEGMENTED FLOW WAVE (issue 5)
- Engine streamFromBrain converter: synthesize the SAME round events the
  engine paths emit — when a tool_use arrives after assistant text, close the
  segment (assistant {round:true} + round_end) before the pill; on the next
  assistant_delta after a pill → new segment. Single choke point, works for
  every brain/space version.
- Engine streamFromDirectProxy: final full-text assistant event BEFORE the
  terminal status chunk (fix the idle-then-assistant ordering).
- chatpanel.js: (1) assistant_delta when the last message is a COMPLETE
  assistant or a tool pill → ALWAYS push a new bubble; (2) roundFlowApply
  idempotent against a text-matching assistant event on a completed bubble
  (no duplicate push).
- Rig: mock two-round tool chains on BOTH paths (brain + direct) via the
  existing bug-live/bug-brain drivers → assert N distinct bubbles in order,
  no duplicates, no glomming (extend scripts/test_round_flow.js to the full
  handleEvent pipeline).

### v0.95.3 THE REASONING RESCUE WAVE (issue 7)
- brain/agent.py BrainLiteLLMModel: when a custom base_url exists (engine
  registry — every non-PM provider), stream through a raw openai.OpenAI client
  (same key/base_url/timeout/retries; unknown kwargs → extra_body so thinking
  params reach the wire). Verified live: preserves reasoning_content. litellm
  remains the path for provider-native ids (no base_url).
- reasoning_content + reasoning field reads (both spellings).
- kimi-k3 entries in BOTH reasoning_catalog.json files (nvidia shape =
  chat_template_kwargs:{thinking:true}; openrouter = reasoning:{enabled:true};
  empty fallback for unlisted hosts).
- Rig: mock emitting reasoning on the brain path → thinking events on the wire;
  catalog test pins the kimi-k3 rows.

### v0.95.4 THE PROTOCOL HONESTY WAVE (issue 6)
- DSML: strip `<｜DSML｜…>` blocks from visible content on all three stream
  paths (engine scanSSE, pmsdk.js, brain stream); on the PM path (text
  protocol) PARSE the DSML calls into real tool calls instead of losing them.
- max_tokens: explicit high cap on every request (engine body + brain request)
  from the model catalog where known, sane default otherwise. finish_reason ==
  "length" → visible warning event "(hit the provider token cap — say
  'continue' to resume)". Unterminated ```artifact fence → salvage the partial
  file with an honest "(truncated)" marker + warning (never silent loss).
- repairJSON: when the original JSON was truncated (unterminated at source),
  REFUSE to execute — return "your call was cut off mid-JSON — re-send the
  complete call" (the .MD-contents-cutoff killer).
- Repeat-call dedup: per-turn hash of (tool, args); exact repeat → cached
  observation + note, no new LLM round-trip.
- Nudge budget: ONE nudge per turn across all flavors (shared per-turn flag);
  the empty-round root causes die with v0.95.2/3 anyway.
- Native paths stop teaching ACTION syntax: when runNativeToolsTurn is active,
  the ACTION-teaching blocks are omitted from the system prompt (protocol
  mixing is the #1 malformation source).
- Rig: malformed-call matrix (smart quotes / truncated JSON / DSML / glued /
  repeats) + artifact-cutoff repro → assert the new honest behaviors.

### v0.95.5 THE HF TRUTH WAVE (issue 4)
- chatframework.js: sandbox-first routing — hf sandbox → runWSTurn BEFORE the
  PM check (PM+hf now rides engine→Space→pm_sidecar; the Space supports it).
- artifact_read tool: engine local registry + PM protocol + brain dt_registry
  — reads the session's artifacts drawer (HARNESS.md included).
- defaultPersonaHF + pmSystemMessage: point at the drawer copy explicitly
  ("your manual is HARNESS.md — in the artifacts drawer; read it with
  artifact_read, or in the Space's workspace with file_read/cat").
- HARNESS.md: drop the stale `delegate` promise.
- Rig: routing test (hf+PM → WS), artifact_read e2e, persona-text pins.

### v0.95.6 THE FACE WAVE (issues 1, 2, 3 — UI)
- modelbrowser.js: remove the duplicate mb-close ✕ (the overlay's static ✕ is
  the one close); rewire ESC/x to ConnectOverlay.close().
- Catalogue auto-refresh: every provider-connect completion site (keys.js,
  providers.js, devkeys install, OAuth flows) invalidates the localStorage
  catalog cache + refreshes ModelBrowser if open.
- workspace.js: the loading-repos box gets a themed indeterminate bar
  (var(--accent)) + accent-colored "loading your repos…" text + a live counter
  once repos stream in. Both sites (connect screen + workspaces screen).
  Zero hardcoded colors.
- artifacts.js: top-edge slide-down-to-close gesture (drag handle zone at the
  top, translate-follow, threshold/fling close — same physics as the panel).
- Rig: theme-twin sweep (no new hardcoded colors), gesture test, browser pass.

### Closeout
- Full sweep: go test ./... + brain pytest + existing rigs (v0899, v0911, v0723,
  theme twins, uikit) + the new v095 rigs.
- Real-user red-team: engine + brain up, mock NIM + real keys where available,
  two concurrent chats same provider (the leak repro), chained tool turns on
  brain + direct paths, HF chat with PM provider (bash on the Space), artifacts
  drawer gestures, catalogue after connecting a provider.
- Rebase onto origin/main, resolve, rebuild binaries (embed parity), push
  phases + the wave tag, bump buildinfo → 0.95.0 at the final phase.

## Non-goals (spaghettification guard)
- No MCP adoption (it's a discovery/interop protocol; our tools are in-process;
  native function calling is already the reliability answer — the fix is
  removing the protocol MIXING, not a framework swap).
- No litellm version bump (raw-client bypass is surgical and version-proof).
- No rewrite of the four tool paths into one (too invasive for this wave; the
  honesty fixes remove the failure modes).
- The React PWA under app/ is not the served UI — untouched.
