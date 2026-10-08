// Package llm is the direct cloud LLM proxy. When the Python brain is
// unavailable (e.g. the Android APK, which can't bundle Python), the Go
// engine talks to OpenAI-compatible providers directly.
//
// v0.13 — capabilities (ported from the doomalaysocreate backend):
//   - EFFORT: per-provider reasoning bodies (reasoning:{effort} on OpenRouter,
//     reasoning_effort / chat_template_kwargs on NVIDIA/CF/PMAI — see effort.go)
//   - WEB SEARCH: OpenRouter gets its native plugins:[{id:"web"}] body; every
//     other provider gets the injected ReAct "ACTION:" tool loop driving
//     DuckDuckGo (keyless) + Tavily (when keyed) + SSRF-guarded page fetch
//   - DEEP RESEARCH: the multi-round pipeline (search → read → follow-ups →
//     synthesize) with status + sources events
//   - THINKING: SSE delta.reasoning_content → "thinking" events
package llm

import (
        "bufio"
        "bytes"
        "context"
        "encoding/json"
        "errors"
        "fmt"
        "io"
        "log"
        "net/http"
        "regexp"
        "strings"
        "sync"
        "sync/atomic"
        "time"

        "github.com/ScoobyBaby1999/doomalay/engine/internal/mcpbus"
)

// ChatRequest is the input to a direct LLM call.
type ChatRequest struct {
        Model        string    `json:"model"`
        Provider     string    `json:"-"` // provider id (effort + search dispatch)
        Messages     []Message `json:"-"`
        SystemPrompt string    `json:"-"`
        Effort       string    `json:"-"`
        WebSearch    bool      `json:"-"`
        DeepResearch bool      `json:"-"`
        TavilyKey    string    `json:"-"`
        APIKey       string    `json:"-"`
        BaseURL      string    `json:"-"`
        AuthStyle    string    `json:"-"` // "" (bearer) or "anthropic"
        // v1.13.2 THE BUS: the chat session id (observer trace
        // attribution — every mcpbus event carries it) and the honest
        // tools-off degrade flag (providers that 400 tools).
        SessionID     string `json:"-"`
        ToolsDisabled bool   `json:"-"`
        // v0.21: SWARM FANOUT DELEGATE (the HF space's panel delegate, ported).
        // Set by the server (it owns the vault); the ReAct loop exposes it to
        // the model as the `delegate` ACTION — one prompt, up to 3 other
        // models answer in parallel, replies return as the OBSERVATION.
        DelegateFn func(ctx context.Context, prompt string, models []string) []map[string]any `json:"-"`
        // v0.22: FILE TOOLS SINK — docx_create/xlsx_create/zip_create save the
        // binaries they build here (the session's artifact drawer). Set by the
        // server; nil = file tools still run but don't persist.
        ArtifactSink ArtifactSink `json:"-"`
        // v0.28: PERSONA TOOLS — the bot's hands for its own personality
        // (persona_list/persona_set/persona_activate/placeholder_set). Set by
        // the server (it owns the session store); nil = the tools report
        // "need a session" instead of running.
        PersonaToolFn func(ctx context.Context, name, argJSON string) string `json:"-"`

        // v0.67.2: HUBLIB — the public-hub library ACTION tool for the
        // direct path (the quick chats). Set by the server (it owns the
        // hub service + the per-chat Bot Library switch). The runner
        // enforces the switch per action: browse/get always answer;
        // download refuses with the exact switch path when OFF.
        HublibToolFn func(ctx context.Context, argJSON string) string `json:"-"`
        // v0.72: the skills hand on the direct path — bootstrap/list/
        // search/load a downloaded skill's methodology (the PM bridge's
        // /api/tools/skills twin, riding the quick chats).
        SkillsToolFn func(ctx context.Context, argJSON string) string `json:"-"`
        // v0.76.5: THE WORKSPACE HAND on the direct path — the chat's
        // connected cloud repos (tree/read/grep/view/put/fork/pr/create/
        // discover). Set by the server (it owns the workspace rows + the
        // vault tokens); nil = the tool is not offered. WorkspaceManifest
        // carries the CONNECTED CLOUD WORKSPACES block (repo rows) when
        // any are bound — composeTurnSystem prepends it above the
        // protocols, mirroring the brain's _build_system_prompt.
        WorkspaceToolFn   func(ctx context.Context, argJSON string) string `json:"-"`
        WorkspaceManifest string                                           `json:"-"`
        // v0.38 FALLBACK ROUTING: the full key map (set by the server at resolve
        // time) lets a deprovisioned model rotate to another provider hosting
        // the same logical model; FallbackTried caps it at one rotation/turn.
        Keys          map[string]string `json:"-"`
        FallbackTried bool              `json:"-"`
        // v0.44 TEMPLATE PILL (user spec: "change the deep research pill
        // entirely to a template pill"): when the composer has a method
        // template active, TemplateID is its id and TemplateBrief the
        // resolved methodology text (the frontend resolves it from the
        // template library — no engine-side fetch on the turn path). The
        // turn pipelines prepend it to the system prompt as a METHOD
        // TEMPLATE block. Empty = no template.
        TemplateID    string `json:"-"`
        TemplateBrief string `json:"-"`
        // v0.72: THE ATTACHED BUNDLE — when the user armed a whole bundle
        // (the v0.71 use-bundle flow), BundleManifest carries the
        // composed manifest block (members + the pick/load protocol);
        // composeTurnSystem prepends it above everything. Mirrors the PM
        // path's opts.bundle handling in vendor/pm/pmsdk.js.
        BundleManifest string `json:"-"`
        // v0.44 SELF-ENABLE (user spec: the model may reach for the template
        // library itself): the brain's base URL so the template_list /
        // template_show ACTION tools can browse /templates. "" (APK / brain
        // down) → the tools degrade with an honest observation.
        BrainURL string `json:"-"`
        // v0.52 THE 3 PILLS (user item 6): per-chat auto-search toggles.
        // TemplateAuto=true → the template ACTION tools are offered in the
        // protocol AND executable; false → they are neither advertised nor
        // run (the [template|+] pill's label press flips the session flag).
        // SkillsAuto rides for the brain path (direct chats have no skills
        // tooling — the flag persists for when the chat moves to a brain).
        TemplateAuto bool `json:"-"`
        SkillsAuto   bool `json:"-"`
}

// Message is one chat message.
type Message struct {
        Role    string `json:"role"`
        Content string `json:"content"`
        // v0.38 NATIVE TOOLS: assistant messages may carry structured
        // tool_calls (JSON, OpenAI shape) and tool results reply with
        // tool_call_id — both marshal onto the wire, both stay empty for
        // every legacy path.
        ToolCalls  json.RawMessage `json:"tool_calls,omitempty"`
        ToolCallID string          `json:"tool_call_id,omitempty"`
        Name       string          `json:"name,omitempty"`
        // FoldedDone marks assistant messages assembled from assistant_delta
        // fragments (pre-v0.13 sessions) so later deltas don't append to them.
        FoldedDone bool `json:"-"`
}

// ChatChunk is one streamed event. Matches the brain's wire format.
type ChatChunk struct {
        Type     string         `json:"type"`
        Text     string         `json:"text,omitempty"`
        State    string         `json:"state,omitempty"`
        Usage    *Usage         `json:"usage,omitempty"`
        Error    string         `json:"error,omitempty"`
        Message  string         `json:"message,omitempty"`
        Name     string         `json:"name,omitempty"`     // tool name (tool_use)
        Summary  string         `json:"summary,omitempty"`  // tool arg summary (tool_use)
        Sources  []SearchResult `json:"sources,omitempty"`  // web sources (sources event)
        Artifact map[string]any `json:"artifact,omitempty"` // v0.22: file tool result (name/id/size) — the UI renders a download card
}

// Usage is the token usage from the final chunk.
type Usage struct {
        InputTokens  int `json:"input_tokens"`
        OutputTokens int `json:"output_tokens"`
        TotalTokens  int `json:"total_tokens"`
}

// openAIChunk is the raw SSE chunk from an OpenAI-compatible provider.
type openAIChunk struct {
        Choices []struct {
                Delta struct {
                        Content   string `json:"content"`
                        Reasoning string `json:"reasoning_content"`
                        // v0.93.1: OpenRouter (and OpenAI's newer shapes)
                        // stream reasoning as plain `reasoning` — the
                        // DeepSeek-style `reasoning_content` above covers the
                        // China-hosted convention, this one the Western one
                        // (live-verified on liquid/lfm-2.5-2.6b:free — the
                        // user's "OpenRouter is bland, no reasoning" report:
                        // every token arrived and was DROPPED here).
                        ReasoningOR string `json:"reasoning"`
                        // v0.38: native function-calling deltas — the FIRST
                        // chunk of a call carries id+name; the rest ride the
                        // index and append argument fragments (per the OpenAI
                        // streaming spec, verified against NVIDIA NIM).
                        ToolCalls []openAIToolCallDelta `json:"tool_calls"`
                } `json:"delta"`
                FinishReason string `json:"finish_reason"`
        } `json:"choices"`
        Usage *struct {
                PromptTokens     int `json:"prompt_tokens"`
                CompletionTokens int `json:"completion_tokens"`
                TotalTokens      int `json:"total_tokens"`
        } `json:"usage,omitempty"`
}

// openAIToolCallDelta is one streamed tool-call fragment.
type openAIToolCallDelta struct {
        Index    int    `json:"index"`
        ID       string `json:"id"`
        Type     string `json:"type"`
        Function struct {
                Name      string `json:"name"`
                Arguments string `json:"arguments"`
        } `json:"function"`
}

// Chat streams a chat completion from an OpenAI-compatible provider,
// dispatching to the capability pipelines when requested.
func Chat(ctx context.Context, req ChatRequest) (<-chan ChatChunk, <-chan error) {
        ch := make(chan ChatChunk, 64)
        errs := make(chan error, 1)

        go func() {
                // v0.93.2 THE ENGINE-KILL GUARD: this producer goroutine is
                // OUTSIDE every server-side recover middleware (it runs on
                // its own stack, spawned per turn) — a panic anywhere in the
                // ReAct loop / tool chain / stream parsing killed the WHOLE
                // ENGINE (the Android watchdog restarted it, the user's
                // 'gets killed by engine restart' report). The guard turns
                // a would-be crash into one honest error chunk + a terminal
                // status; the engine lives, the next turn works.
                defer func() {
                        if rec := recover(); rec != nil {
                                log.Printf("PANIC recovered in llm.Chat (%s · %s): %v", providerLabel(req.Provider), modelShort(req.Model), rec)
                                ch <- ChatChunk{Type: "error", Error: "panic", Message: "internal error — the turn was cancelled but the engine recovered; try again"}
                                ch <- ChatChunk{Type: "status", State: "error"}
                        }
                        close(ch)
                        close(errs)
                }()

                switch {
                case req.DeepResearch && req.Provider != "":
                        runDeepResearch(ctx, ch, errs, req)
                case req.Provider != "" && req.AuthStyle != "anthropic" && !nativeToolsBlacklisted(req.Provider):
                        // v0.38 NATIVE FUNCTION CALLING + v1.13.2 THE HANDOFF +
                        // v1.13.3 THE GUT + v1.13.6 THE THIRD CARRIER: EVERY
                        // OpenAI-compatible provider — openrouter INCLUDED —
                        // runs the structured tool_calls loop against the
                        // mcpbus. The v1.13.6 rig's S12 finding: the old
                        // plugin-first ordering + the always-on WebSearch flag
                        // meant openrouter turns NEVER reached the bus (a
                        // single plugin round, zero of the 100+ tools); now
                        // the bus's web_search tool grounds web questions in
                        // the loop, and a provider that 400s tools is
                        // blacklisted once and ladders DOWN to the plugin
                        // path below (openrouter keeps provider-side web
                        // grounding without tools) or the tool-less loop.
                        // Anthropic-wire providers (their native tool format
                        // is a future wave) fall to the plain paths below.
                        runNativeToolsTurn(ctx, ch, errs, req)
                case req.WebSearch && req.Provider != "" && NativeWebSearchBody(req.Provider, req.Model) != nil:
                        // v1.13.6: OpenRouter's provider-side search is now the
                        // FALLBACK (blacklisted or anthropic-wire turns) —
                        // provider-side web grounding without tools instead of
                        // a tools dead end.
                        runWebSearchTurn(ctx, ch, errs, req)
                case req.Provider != "" && req.AuthStyle != "anthropic":
                        // a BLACKLISTED provider without the plugin: the loop
                        // skips tools upfront (v1.13.4 — no wasted 400s per
                        // turn) and answers honestly.
                        runNativeToolsTurn(ctx, ch, errs, req)
                default:
                        // v0.20's unified ReAct tool loop is gone (v1.13.3 THE
                        // GUT); what remains here is the plain streaming path
                        // for anthropic-wire providers and provider-less
                        // requests (runWebSearchTurn's Path A fires only for
                        // the plugin case routed above).
                        runWebSearchTurn(ctx, ch, errs, req)
                }
        }()

        return ch, errs
}

// ── Plain turn: single streaming completion ────────────────────────────────

func runPlainTurn(ctx context.Context, ch chan<- ChatChunk, errs chan<- error, req ChatRequest) {
        ch <- ChatChunk{Type: "status", State: "running"}
        final, err := streamCompletion(ctx, req, ch, nil)
        if err != nil {
                emitTurnError(ch, err)
                errs <- err
                return
        }
        _ = final
        ch <- ChatChunk{Type: "status", State: "idle", Usage: final}
}

// emitTurnError (v0.39): the ONE honest error chunk + terminal status pair
// for a failed turn — emitted where the pause ladder gave up (or a non-
// retryable error surfaced), never inside the retry loop (an early chunk
// terminalizes the UI: the frontend treats error events as end-of-turn).
func emitTurnError(ch chan<- ChatChunk, err error) {
        ch <- ChatChunk{Type: "error", Error: "stream", Message: friendlyStreamError(err)}
        ch <- ChatChunk{Type: "status", State: "error"}
}

// friendlyStreamError humanizes the raw transport/stream error.
func friendlyStreamError(err error) string {
        if err == nil {
                return "unknown error"
        }
        s := err.Error()
        msg := s
        for _, pair := range [][2]string{
                {"request failed: ", ""},
                {"stream: ", ""},
                {"send: ", ""},
        } {
                msg = strings.Replace(msg, pair[0], pair[1], 1)
        }
        if len(msg) > 300 {
                msg = msg[:300] + "…"
        }
        return msg
}

// streamCompletion performs ONE streaming chat completion, forwarding
// thinking + assistant deltas to ch. Returns the final usage.
func streamCompletion(ctx context.Context, req ChatRequest, ch chan<- ChatChunk, extraBody map[string]any) (*Usage, error) {
        return scanSSE(ctx, req, extraBody, ch, func(reasoning, content string) {
                if reasoning != "" {
                        ch <- ChatChunk{Type: "thinking", Text: reasoning}
                }
                if content != "" {
                        ch <- ChatChunk{Type: "assistant_delta", Text: content}
                }
        })
}

// idleTimeoutReader closes the underlying body when no bytes arrive for
// the timeout (reset on every Read) — v0.19.
//
// WHY: observed live — a NIM model accepted the request and then streamed
// NOTHING for 10 minutes: the turn lock held, the UI sat on "Stop", no
// error, no terminal status. Reasoning models can think long before the
// FIRST token, but once bytes flow the stream is alive — this watchdog
// only killed true silence.
//
// v0.80.1 THE KILL IS DISABLED (user directive: "remove any timer that
// canceles an output or reply"): idleWaitFor now returns 0 and a zero
// timeout never arms the timer — a silent-but-thinking stream (observed:
// kimi-k3, 5+ min of server-side thinking with zero bytes; NVIDIA's free
// queue, minutes before the first token) lives as long as it needs to.
// The reader itself stays: waitNotices() still uses silentFor()/gotData
// to keep the user informed ("waiting for kimi-k3 · 60s…"), and any
// caller that passes a positive timeout still gets the old kill. The
// user's Stop button is the escape hatch for a truly dead connection.
type idleTimeoutReader struct {
        rc        io.ReadCloser
        timeout   time.Duration
        timer     *time.Timer
        stopped   chan struct{}
        timedOut  atomic.Bool
        lastDelta atomic.Int64 // v0.24: unix-ms of the last REAL reasoning/content delta (0 = none yet)
        startMS   atomic.Int64 // v0.24: when the stream opened (for notices)
}

func newIdleTimeoutReader(rc io.ReadCloser, d time.Duration) *idleTimeoutReader {
        r := &idleTimeoutReader{rc: rc, timeout: d, stopped: make(chan struct{})}
        if d > 0 { // v0.80.1: d <= 0 means the watchdog is DISABLED (no kill timer)
                r.timer = time.AfterFunc(d, func() {
                        select {
                        case <-r.stopped:
                        default:
                                r.timedOut.Store(true)
                                rc.Close()
                        }
                })
        }
        return r
}

func (r *idleTimeoutReader) Read(p []byte) (int, error) {
        n, err := r.rc.Read(p)
        if n > 0 && r.timer != nil {
                // v0.24 NOTE: raw bytes reset the KILL timer (the connection is
                // alive — SSE keepalive comments count), but NOT gotData: that flag
                // means "a real reasoning/content delta reached the user" and is set
                // by scanSSE's parse loop. NIM trickles keepalives for minutes while
                // kimi-k3 thinks (observed live: 139-151s gaps) — the kill must stay
                // off, but the wait-notices must keep talking to the user.
                r.timer.Reset(r.timeout)
        }
        return n, err
}

func (r *idleTimeoutReader) Close() error {
        close(r.stopped)
        if r.timer != nil {
                r.timer.Stop()
        }
        return r.rc.Close()
}

func (r *idleTimeoutReader) markDelta() {
        r.lastDelta.Store(time.Now().UnixMilli())
}

// silentFor returns how long since the last REAL token (or since the
// stream opened, if none arrived yet).
func (r *idleTimeoutReader) silentFor() time.Duration {
        last := r.lastDelta.Load()
        if last == 0 {
                return time.Since(time.UnixMilli(r.startMS.Load()))
        }
        return time.Since(time.UnixMilli(last))
}

// idleWaitFor returns the no-data watchdog for a model. v0.24 made it
// MODEL-AWARE (reasoning models think server-side for MINUTES before the
// first byte — observed live: nvidia kimi-k3, 5+ min) after the old flat
// 90s killed turns mid-action. v0.80.1: it returns 0 — the kill is
// DISABLED per the user directive ("remove any timer that canceles an
// output or reply"): a silent stream is a LIVE stream as far as anyone
// knows, waitNotices keeps the user informed, and Stop is the canceller.
// The model-aware shape stays for documentation + any future opt-in.
func idleWaitFor(model string) time.Duration {
        return 0
}

// IsSlowReasoningModel reports whether a model is known to take multi-minute
// turns (server-side thinking between tool rounds). v0.80.1: no longer drives
// any timeout — the turn budget is gone and the idle kill is disabled; kept
// as the shared classification helper (UI hints, analytics).
func IsSlowReasoningModel(model string) bool {
        m := strings.ToLower(model)
        return matchesAny(m, reasonKws) || strings.Contains(m, "kimi") ||
                strings.Contains(m, "gpt-oss") || strings.Contains(m, "glm")
}

// modelShort strips the provider prefix for UI text ("kimi-k3", not
// "nvidia/moonshotai/kimi-k3").
func modelShort(model string) string {
        if i := strings.LastIndex(model, "/"); i >= 0 {
                return model[i+1:]
        }
        return model
}

// ── v0.24 intent detection (the auto-proceed nudge) ────────────────────────
//
// looksLikeIntentOnly reports whether a final (no-ACTION) reply reads as
// "I will now do X…" — an announcement instead of the deed. Observed live
// (user report, kimi via NVIDIA): the model lays out its plan, ends the
// turn, and waits for the user to say "go". We detect that and push once.
var intentPhrases = []string{
        "i will now", "i'll now", "i will start", "i'll start", "i will begin", "i'll begin",
        "i will demonstrate", "i'll demonstrate", "i will show", "i'll show you",
        "i'm going to", "im going to", "let me start", "let me begin", "let me demonstrate",
        "let me show", "i will walk", "i'll walk you", "i will create", "i'll create",
        "i will use", "i'll use", "i will run", "i'll run", "i will call", "i'll call",
        "i will first", "i'll first", "starting now", "shall i proceed", "should i proceed",
        "would you like me to", "want me to", "ready when you are", "say go", "give me the go",
        "tell me to", "i am about to", "i'm about to", "here's my plan", "here is my plan",
        "my plan is", "i plan to",
        // v0.28: the “proactively search” flavors — models that announce
        // a search instead of just running it.
        "i'll search", "i will search", "let me search", "i'll look", "let me look",
        "i'll check", "let me check", "i'll fetch", "let me fetch", "i'll go ahead",
        "i will go ahead", "let me try", "i'll try", "i'll find out", "let me find out",
}

// denialPhrases — v0.28 CAPABILITY-DENIAL NUDGE (the user's "models don't
// proactively discover/use tools" report): models with stale training
// assert they have no internet/no tools and end the turn; the user then
// has to manually nudge "you have web_search, use it" — exactly what the
// nudge exists to automate. Observed live with the repo-explain convo:
// the model DID have web tools armed but announced it couldn't access
// the repo, and only a manual push made it try web_fetch.
var denialPhrases = []string{
        "i can't search", "i cannot search", "i can't browse", "i cannot browse",
        "i can't access the internet", "i cannot access the internet",
        "i don't have internet access", "i don't have access to the internet",
        "no internet access", "i can't go online", "i can't fetch", "i cannot fetch",
        "i can't access the web", "i cannot access the web", "i can't access external",
        "i can't visit websites", "i cannot visit websites", "i can't look that up",
        "i can't check the time", "i don't have the ability to search",
        "i don't have the ability to browse", "i'm not able to access",
        "i am not able to access", "i don't have access to that",
        "i don't have real-time", "i don't have live", "as an ai language model, i",
        "my knowledge cutoff", "i can't verify", "i cannot verify",
}

func looksLikeIntentOnly(reply string) bool {
        r := strings.ToLower(reply)
        if len(r) > 900 {
                return false // a real, substantial answer — not an announcement
        }
        for _, p := range intentPhrases {
                if strings.Contains(r, p) {
                        return true
                }
        }
        return false
}

// looksLikeCapabilityDenial — the second nudge flavor (v0.28): the model
// claims it CAN'T do something the tools do. Slightly longer budget
// than intent (denials can carry an apologetic preamble).
func looksLikeCapabilityDenial(reply string) bool {
        r := strings.ToLower(reply)
        if len(r) > 1200 {
                return false
        }
        for _, p := range denialPhrases {
                if strings.Contains(r, p) {
                        return true
                }
        }
        return false
}

// silentClock is the pre-connect silence source (v0.24): NIM's kimi-k3
// can sit in http.Do for MINUTES before the response HEADERS arrive —
// observed live, a whole 3-minute turn never got past Do(). waitNotices
// needs to cover that phase too, so it runs on this until the body opens.
type silentClock struct{ start time.Time }

func (s *silentClock) silentFor() time.Duration { return time.Since(s.start) }

// providerLabel maps an internal provider id to its display name (v0.35 —
// the wait notices now say "waiting on Nvidia" per the user's spec #9:
// "If it's a Nvidia side issue have it change from thinking... to waiting
// on Nvidia...". The PROVIDER is what the user picked; the model underneath
// can change mid-flow).
func providerLabel(provider string) string {
        switch strings.ToLower(strings.TrimSpace(provider)) {
        case "nvidia":
                return "Nvidia"
        case "opencode":
                return "OpenCode"
        case "privatemodeai":
                return "PrivateMode"
        case "openrouter":
                return "OpenRouter"
        case "cloudflare":
                return "Cloudflare"
        case "groq":
                return "Groq"
        case "together":
                return "Together"
        case "mistral":
                return "Mistral"
        case "anthropic":
                return "Anthropic"
        case "openai":
                return "OpenAI"
        case "deepseek":
                return "DeepSeek"
        case "":
                return ""
        default:
                return provider
        }
}

// waitNotices streams live "still waiting" progress chunks while the
// provider stays silent (v0.24 — the user's "let the user know instead of
// just displaying thinking…"). Chunks are WS-only progress events; they
// track REAL token gaps (not raw bytes — NIM trickles SSE keepalives while
// kimi-k3 thinks for 139-151s at a stretch, observed live), so the user
// always knows it's the model, not the app. Works for BOTH the connect
// phase (silentClock) and the body phase (idleTimeoutReader).
func waitNotices(ch chan<- ChatChunk, src interface{ silentFor() time.Duration }, model, provider string) (stop func()) {
        shortModel := modelShort(model)
        who := shortModel
        if p := providerLabel(provider); p != "" {
                who = p // v0.35: "waiting on Nvidia · 25s" — provider first, per spec
        }
        done := make(chan struct{})
        go func() {
                var tick *time.Ticker
                defer func() {
                        if tick != nil {
                                tick.Stop()
                        }
                }()
                for {
                        select {
                        case <-time.After(12 * time.Second): // first notice — below that, waiting is normal
                        case <-done:
                                return
                        }
                        tick = time.NewTicker(15 * time.Second) // steady cadence from the FIRST notice
                        for {
                                silent := src.silentFor()
                                if silent < 10*time.Second {
                                        break // tokens are flowing — go quiet
                                }
                                note := fmt.Sprintf("waiting on %s · %ds", who, int(silent.Seconds()))
                                if silent >= 60*time.Second {
                                        note += " — still no data; the model may be at capacity"
                                }
                                select {
                                case ch <- ChatChunk{Type: "progress", Text: note}:
                                default: // never block the stream on UI notices
                                }
                                select {
                                case <-tick.C:
                                case <-done:
                                        return
                                }
                        }
                        tick.Stop()
                        tick = nil
                }
        }()
        var once sync.Once
        return func() { once.Do(func() { close(done) }) }
}

// friendlyHTTPError rewrites provider HTTP failures into actionable text
// (v0.24 — the user's spec: "if the issue is 429, or some issue where the
// model is at capacity, or taking too long, let the user know... We can
// suggest a switch of models as well").
func friendlyHTTPError(status int, body string, provider string) string {
        b := strings.TrimSpace(body)
        // v0.93.1 THE OPENROUTER HONESTY SET (live-probed 2026-10-02 with the
        // user's key): three provider states the generic branches mislabeled —
        // each now says what actually happened and what to do next.
        if provider == "openrouter" {
                // (1) The retired-:free 404. OpenRouter pulled the popular
                // free variants (llama-3.3-70b:free, deepseek-r1:free, … all
                // 404 with a "use this slug instead" pointer to the PAID
                // slug — live-verified on 4 slugs). The user read it as "my
                // account lost the models".
                if status == 404 && strings.Contains(b, "use this slug instead") {
                        paid := ""
                        if i := strings.LastIndex(b, "instead: "); i >= 0 {
                                rest := b[i+9:]
                                // the slug runs to the closing quote (the body is
                                // the raw JSON error: …instead: slug","code"…)
                                if j := strings.IndexByte(rest, '"'); j >= 0 {
                                        rest = rest[:j]
                                } else if j := strings.IndexAny(rest, ",}"); j >= 0 {
                                        rest = rest[:j]
                                }
                                paid = strings.TrimSpace(rest)
                        }
                        msg := "OpenRouter retired this free model variant (the :free tier was pared down in Sept 2026)"
                        if paid != "" {
                                msg += " — the paid slug is " + paid + " (needs credits)"
                        }
                        msg += ". Try openrouter/free — it routes to whatever is genuinely free right now"
                        return msg
                }
                // (2) The never-purchased-credits 402. The generic 402 branch
                // said "free quota used up" — wrong account state entirely
                // (the key is FINE, the account just has no credits and this
                // model isn't free).
                if status == 402 || strings.Contains(b, "Insufficient credits") {
                        return "this model is PAID on OpenRouter and your key's account has no credits — your key works; use openrouter/free or one of the live :free models instead"
                }
                // (3) The upstream shared-pool 429. The free pool is shared
                // by ALL OpenRouter free users — it is NOT the user's quota
                // (their own daily budget: 50 free requests, live-checked:
                // 50/50 remaining while the model still 429'd upstream).
                if status == 429 && strings.Contains(b, "upstream_provider_shared_pool") {
                        return "the FREE pool for this model is rate-limited upstream right now (shared by all OpenRouter free users — not YOUR quota) — retry in a moment, or try openrouter/free which routes around it"
                }
        }
        // 404 "Function '<id>': Not found for account" — NIM dropped the model
        // for this key (observed live: kimi-k2.6 after NIM rotation).
        if status == 404 && strings.Contains(b, "Not found for account") {
                return "404: this model is no longer available for your " + provider + " account — pick another model"
        }
        // v0.35: 410 Gone — the model reached end-of-life upstream (live hit:
        // deepseek-ai/deepseek-v4-flash EOL'd 2026-08-07 but still appears in
        // older cached catalogs). Say it plainly so the user picks another.
        if status == 410 || strings.Contains(b, "end of life") || strings.Contains(b, "end-of-life") {
                return "this model has been retired by the provider (end of life) — pick another model"
        }
        // v0.38: 402 from the OpenCode bridge ("Upstream request failed:
        // Insufficient account funds" — live hit during testing; the user's
        // "GLM flash hit its capacity" report). The key is fine; the FREE
        // quota is spent.
        if status == 402 || strings.Contains(strings.ToLower(b), "insufficient account funds") {
                return "this provider's free quota for this model is used up (402) — try again later, another provider hosting the same model, or a different model"
        }
        // v0.25 OPENCODE ZEN billing clarifications (live-verified with a
        // working key): paid models answer 400 CreditsError "No payment
        // method …/billing" even though the KEY is perfectly valid — free
        // models (big-pickle, *-free) work on the same key. The raw message
        // read as "my key needs billing enabled", which is wrong.
        if strings.Contains(b, "CreditsError") || strings.Contains(b, "No payment method") {
                return "this model is PAID on OpenCode Zen — your key works, but this model needs a payment method at opencode.ai/settings/billing, or switch provider (NVIDIA / PrivateMode have working free models)"
        }
        if strings.Contains(b, "MissingSessionID") {
                return "OpenCode Zen wants a client session for this model — try big-pickle or another free model"
        }
        // v0.26 (2026-09-17): upstream walled the free tier to their own
        // client — even WITH the x-session-id header big-pickle/*-free now
        // answer 403 FreeTierError "OpenCode's free tier can only be used
        // from within OpenCode" (live-verified; worked on 09-14). Honest
        // message: nothing wrong with the key or the app.
        if strings.Contains(b, "FreeTierError") || strings.Contains(b, "free tier can only be used") {
                return "OpenCode just walled their FREE models to their own client — your key and the app are fine. Paid zen models still work with a payment method, or switch provider (NVIDIA / PrivateMode work great right now)"
        }
        if strings.Contains(b, "FreeUsageLimitError") {
                return "OpenCode Zen free-tier limit for this model right now — wait a moment or switch models"
        }
        if status == 429 || strings.Contains(b, "rate limit") || strings.Contains(b, "Too Many Requests") {
                msg := "429: the model is at capacity / rate-limited — wait ~15s and try again, or switch models"
                if provider == "nvidia" {
                        msg += " (each NVIDIA model has its own limit)"
                }
                return msg
        }
        if status >= 500 {
                return fmt.Sprintf("%d: provider error (model may be at capacity) — try again or switch models", status)
        }
        if len(b) > 220 {
                b = b[:220] + "…"
        }
        return fmt.Sprintf("%d: %s", status, b)
}

// scanSSE performs ONE streaming chat completion, invoking onDelta for every
// reasoning/content fragment AS IT ARRIVES (v0.19: extracted from
// streamCompletion so ReAct rounds can stream live — the old loop used
// completeSync, and tool turns were dead-silent until everything popped
// at once). ch receives error chunks (so the UI sees provider failures);
// onDelta receives the fragments.
func scanSSE(ctx context.Context, req ChatRequest, extraBody map[string]any, ch chan<- ChatChunk, onDelta func(reasoning, content string)) (*Usage, error) {
        usage, _, err := scanSSECollect(ctx, req, extraBody, ch, onDelta)
        return usage, err
}

// scanSSECollect is scanSSE + native tool-call accumulation (v0.38): streams
// one completion, forwards thinking/content, and ALSO assembles any streamed
// tool_calls deltas (index-keyed, per the OpenAI streaming spec) into a
// complete call list. The legacy callers ignore the second return.
func scanSSECollect(ctx context.Context, req ChatRequest, extraBody map[string]any, ch chan<- ChatChunk, onDelta func(reasoning, content string)) (*Usage, []nativeCall, error) {
        messages := make([]Message, 0, len(req.Messages)+1)
        if req.SystemPrompt != "" {
                messages = append(messages, Message{Role: "system", Content: req.SystemPrompt})
        }
        messages = append(messages, req.Messages...)

        body := map[string]any{
                "model":          req.Model,
                "messages":       messages,
                "stream":         true,
                "stream_options": map[string]bool{"include_usage": true},
        }
        // v0.13: effort body from the ported reasoning catalog (replaces the
        // v0.12 hardcoded o1/deepseek guesses).
        // v0.26: remember WHICH keys the effort body added — the 400-resilience
        // below strips exactly these on retry.
        // v0.42: "off" now flows through too — BuildEffortBodyFor resolves the
        // DYNAMIC per-model surface (effort.go registry) and only emits a
        // disable when the model actually documents one (kimi
        // chat_template_kwargs.thinking:false, deepseek reasoning_effort
        // "none"); mandatory reasoners get nil (never a disable). "med"
        // remains the session-default sentinel (unset — sends nothing).
        var effortKeys []string
        if req.Effort != "" && req.Effort != "med" {
                if extra := BuildEffortBodyFor(req.Provider, req.Model, req.Effort); extra != nil {
                        for k, v := range extra {
                                body[k] = v
                                effortKeys = append(effortKeys, k)
                        }
                }
        }
        for k, v := range extraBody {
                body[k] = v
        }
        _, hasTools := body["tools"]

        // v1.13.3 THE GUT: the DSML filter's reinject mode (re-render
        // rescued calls as ACTION lines for the ReAct parser) is gone
        // with the parser — the filter now only STRIPS the markup from
        // the visible stream; rescued calls feed the native loop's
        // consumer when a tools array rides the request.
        var dsml dsmlFilter
        dsml.takeNative = hasTools

        // v0.95.4 THE OUTPUT FLOOR (the .MD-artifact cutoff class): no
        // max_tokens was EVER set on any chat request — providers that
        // default LOW (NIM: 1024 output tokens ≈ 4KB) silently cut long
        // outputs mid-file, which reads downstream as "the artifact's
        // contents got cut off". Set an explicit floor for the providers
        // KNOWN to default low; every other host keeps its server default
        // (never cap a host that would have given more). A 400 that names
        // max_tokens strips it and retries once (the effortKeys pattern).
        var bodyKeys []string
        if _, exists := body["max_tokens"]; !exists {
                if floor, known := providerMaxTokensFloor(req.Provider); known {
                        body["max_tokens"] = floor
                        bodyKeys = append(bodyKeys, "max_tokens")
                }
        }

        bodyBytes, err := json.Marshal(body)
        if err != nil {
                return nil, nil, fmt.Errorf("marshal: %w", err)
        }

        base := strings.TrimSuffix(req.BaseURL, "/")
        url := base + "/v1/chat/completions"
        if strings.HasSuffix(base, "/v1") {
                url = base + "/chat/completions"
        }

        // v0.26: EFFORT-PARAM RESILIENCE — a model that rejects an unverified
        // reasoning shape (reasoning_effort / chat_template_kwargs / thinking)
        // with a 400 is retried ONCE without the param, and the (provider,
        // model) is blacklisted for this engine's lifetime so every later
        // request skips it. The effort button keeps working; the model just
        // never sees the param again.
        if len(effortKeys) > 0 && effortBlacklisted(req.Provider, req.Model) {
                for _, k := range effortKeys {
                        delete(body, k)
                }
                bodyBytes, _ = json.Marshal(body)
                effortKeys = nil
        }

        // v0.39 PACING (P8-FULL, socreate scheduler.py:338-361): reserve the
        // provider's rpm slot — reserve-under-lock, sleep outside — so
        // concurrent turns (parallel chats) stagger instead of bursting
        // into a 429. Bounded: pacing alone never stalls a turn >5s.
        if wait := PaceProvider(req.Provider); wait > 0 {
                select {
                case ch <- ChatChunk{Type: "progress", Text: fmt.Sprintf("pacing %s — sending in %.1fs", providerLabel(req.Provider), wait.Seconds())}:
                default:
                }
                select {
                case <-ctx.Done():
                        ch <- ChatChunk{Type: "error", Error: "cancelled", Message: "turn stopped while pacing the provider"}
                        return nil, nil, nil
                case <-time.After(wait):
                }
        }

        resp, reqErr := doPostSSE(ctx, req, url, bodyBytes, ch)
        if resp == nil {
                return nil, nil, fmt.Errorf("request failed: %w", reqErr)
        }
        // v0.36: 429/503 RETRY-WITH-BACKOFF (mirrors the brain's
        // num_retries=3): NVIDIA's per-model rate limits answer 429 on
        // burst sends — failing the whole turn on the first 429 was harsh
        // when a short pause clears it. Up to 2 retries (3 attempts total)
        // with 4s/8s backoff, each wait announced as a progress notice so
        // the UI explains the pause. Non-retryable statuses flow straight
        // to friendlyHTTPError; a turn cancelled mid-wait ends quietly.
        //
        // v0.39 COOLDOWN TABLE (P8-FULL): every 429/503 is RECORDED (the
        // provider's proportional cooldown informs alternate routing), and
        // the SECOND retry waits the LONGER of the flat backoff and the
        // cooldown — diverging from socreate's rotate-immediately because
        // this engine usually has exactly ONE keyed provider (rotate has
        // nowhere to go; the honest move is the proportional wait).
        for attempt := 1; (resp.StatusCode == 429 || resp.StatusCode == 503) && attempt < 3; attempt++ {
                wait := time.Duration(attempt*4) * time.Second // 4s, then 8s
                class := "429"
                if resp.StatusCode == 503 {
                        class = "5xx"
                }
                RecordProviderFailure(req.Provider, class, fmt.Sprintf("HTTP %d on %s", resp.StatusCode, modelShort(req.Model)))
                if attempt >= 2 {
                        if r := ProviderCooldownRemaining(req.Provider); r > wait {
                                if r > 30*time.Second {
                                        r = 30 * time.Second // single-provider cap: never wedge one wait past 30s
                                }
                                wait = r
                        }
                }
                io.Copy(io.Discard, resp.Body)
                resp.Body.Close()
                note := fmt.Sprintf("429: rate-limited by %s — retrying in %ds (attempt %d of 3)",
                        providerLabel(req.Provider), int(wait.Seconds()), attempt+1)
                if resp.StatusCode == 503 {
                        note = fmt.Sprintf("%s is overloaded (503) — retrying in %ds (attempt %d of 3)",
                                providerLabel(req.Provider), int(wait.Seconds()), attempt+1)
                }
                select {
                case ch <- ChatChunk{Type: "progress", Text: note}:
                default: // never block the stream on UI notices
                }
                select {
                case <-ctx.Done():
                        ch <- ChatChunk{Type: "error", Error: "cancelled", Message: "turn stopped while waiting to retry after the rate limit"}
                        return nil, nil, nil
                case <-time.After(wait):
                }
                resp, reqErr = doPostSSE(ctx, req, url, bodyBytes, ch)
                if resp == nil {
                        return nil, nil, fmt.Errorf("request failed: %w", reqErr)
                }
        }
        if resp.StatusCode != 200 {
                bts, _ := io.ReadAll(resp.Body)
                resp.Body.Close()
                // v0.38 MODEL-GONE FALLBACK ROUTING (live-observed: NIM models
                // get deprovisioned mid-session — 404 "Not found for account"):
                // rotate to another provider hosting the same logical model,
                // once per turn, announced as a progress notice.
                if (resp.StatusCode == 404 || resp.StatusCode == 410) && !req.FallbackTried && modelGoneBody(string(bts)) {
                        if am, ab, _, ak, as, altProv, ok := ResolveModelAlternate(req.Model, req.Provider, req.Keys); ok {
                                req.FallbackTried = true
                                note := fmt.Sprintf("%s no longer hosts %s — switching to %s (same model)",
                                        providerLabel(req.Provider), modelShort(req.Model), providerLabel(altProv))
                                select {
                                case ch <- ChatChunk{Type: "progress", Text: note}:
                                default:
                                }
                                req.Model, req.APIKey, req.BaseURL, req.AuthStyle = am, ak, ab, as
                                body["model"] = am
                                bodyBytes, _ = json.Marshal(body)
                                resp, reqErr = doPostSSE(ctx, req, url, bodyBytes, ch)
                                if resp == nil {
                                        return nil, nil, fmt.Errorf("request failed: %w", reqErr)
                                }
                                if resp.StatusCode != 200 {
                                        bts, _ = io.ReadAll(resp.Body)
                                        resp.Body.Close()
                                }
                        }
                }
                if resp.StatusCode != 200 {
                        // v0.38 NATIVE-TOOLS REJECTION: a 400 that names tools/function
                        // calling on a tools-bearing request is a capability gap, not a
                        // user error — suppress the UI error, blacklist the provider
                        // for this engine's lifetime, and let the caller fall back to
                        // the ACTION text protocol.
                        if hasTools && resp.StatusCode == 400 && toolsRejectedBody(string(bts)) {
                                blacklistNativeTools(req.Provider)
                                return nil, nil, errToolsRejected
                        }
                        if len(effortKeys) > 0 && resp.StatusCode == 400 && mentionsEffortParam(string(bts)) {
                                blacklistEffort(req.Provider, req.Model)
                                for _, k := range effortKeys {
                                        delete(body, k)
                                }
                                clean, _ := json.Marshal(body)
                                resp2, reqErr2 := doPostSSE(ctx, req, url, clean, ch)
                                if resp2 != nil {
                                        if resp2.StatusCode != 200 {
                                                bts2, _ := io.ReadAll(resp2.Body)
                                                resp2.Body.Close()
                                                RecordProviderFailure(req.Provider,
                                                        ClassifyProviderError(resp2.StatusCode, string(bts2)),
                                                        fmt.Sprintf("HTTP %d on %s (post effort-strip)", resp2.StatusCode, modelShort(req.Model)))
                                                ch <- ChatChunk{Type: "error", Error: "http", Message: friendlyHTTPError(resp2.StatusCode, string(bts2), req.Provider)}
                                                return nil, nil, nil
                                        }
                                        resp = resp2
                                } else {
                                        return nil, nil, fmt.Errorf("request failed: %w", reqErr2)
                                }
                        } else {
                                // v0.95.4 OUTPUT-FLOOR RESILIENCE: a 400 that
                                // names max_tokens means the host rejected the
                                // floor (a model with a lower output headroom)
                                // — strip it and retry once, then never send
                                // it to this provider again (the effortKeys
                                // pattern; the server's own default returns).
                                if len(bodyKeys) > 0 && resp.StatusCode == 400 && mentionsMaxTokens(string(bts)) {
                                        for _, k := range bodyKeys {
                                                delete(body, k)
                                        }
                                        bodyKeys = nil
                                        clean, _ := json.Marshal(body)
                                        resp2, reqErr2 := doPostSSE(ctx, req, url, clean, ch)
                                        if resp2 == nil {
                                                return nil, nil, fmt.Errorf("request failed: %w", reqErr2)
                                        }
                                        if resp2.StatusCode == 200 {
                                                resp = resp2
                                        } else {
                                                bts2, _ := io.ReadAll(resp2.Body)
                                                resp2.Body.Close()
                                                RecordProviderFailure(req.Provider,
                                                        ClassifyProviderError(resp2.StatusCode, string(bts2)),
                                                        fmt.Sprintf("HTTP %d on %s (post max_tokens-strip)", resp2.StatusCode, modelShort(req.Model)))
                                                ch <- ChatChunk{Type: "error", Error: "http", Message: friendlyHTTPError(resp2.StatusCode, string(bts2), req.Provider)}
                                                return nil, nil, nil
                                        }
                                        // fall through to the stream with the stripped body
                                } else {
                                        // v0.39: record the provider failure class (auth →
                                        // engine-lifetime blacklist, quota/payload/5xx →
                                        // 60s cooldown) — alternate routing + later
                                        // turns consult the table.
                                        RecordProviderFailure(req.Provider,
                                                ClassifyProviderError(resp.StatusCode, string(bts)),
                                                fmt.Sprintf("HTTP %d on %s", resp.StatusCode, modelShort(req.Model)))
                                        ch <- ChatChunk{Type: "error", Error: "http", Message: friendlyHTTPError(resp.StatusCode, string(bts), req.Provider)}
                                        return nil, nil, nil
                                }
                        }
                }
        }

        // v0.39: a landed 200 clears the provider's EXPIRED cooldown (the
        // socreate race guard — an ACTIVE 429 cooldown recorded by a sibling
        // request survives).
        RecordProviderSuccess(req.Provider)

        // v0.19: no-data watchdog — v0.80.1: DISARMED. idleWaitFor returns 0
        // (no kill timer is armed — the user directive: no timer may cancel
        // an output). The reader still tracks silentFor()/lastDelta so
        // waitNotices keeps the UI informed ("waiting for kimi-k3 · 60s…")
        // for as long as the provider needs; Stop is the canceller.
        wd := newIdleTimeoutReader(resp.Body, idleWaitFor(req.Model))
        wd.startMS.Store(time.Now().UnixMilli())
        wd.lastDelta.Store(0)
        defer resp.Body.Close()
        // v0.95.4: finish_reason == "length" honesty — the provider cut the
        // output at its token cap. NEVER silently: the note rides the visible
        // stream so it persists, replays, and the user knows to say
        // "continue" (the silent .MD-artifact cutoff class).
        hitLength := false
        defer wd.Close()
        stopNotices := waitNotices(ch, wd, req.Model, req.Provider)
        defer stopNotices()

        scanner := bufio.NewScanner(wd)
        // v0.93.1: 256KB → 16MB max (64KB initial). Media models
        // (google/lyria-3-clip-preview — the user's live hit) stream ONE
        // SSE data line carrying a full base64-encoded media payload:
        // multi-megabyte tokens that 256KB aborted with "bufio.Scanner:
        // token too long", killing the whole turn. 16MB covers every
        // observed payload class (images/audio clips) while still capping
        // runaway hosts.
        scanner.Buffer(make([]byte, 0, 64*1024), 16*1024*1024)
        usage := &Usage{}
        var calls []nativeCall
        callIdx := map[int]int{} // delta index → position in calls
        for scanner.Scan() {
                line := scanner.Text()
                if !strings.HasPrefix(line, "data: ") {
                        continue
                }
                data := strings.TrimPrefix(line, "data: ")
                if data == "[DONE]" {
                        break
                }
                var chunk openAIChunk
                if err := json.Unmarshal([]byte(data), &chunk); err != nil {
                        continue
                }
                for _, choice := range chunk.Choices {
                        if choice.FinishReason == "length" {
                                hitLength = true
                        }
                        // v0.38: assemble streamed tool-call fragments — the
                        // first carries id+name, later ones only arguments.
                        for _, tc := range choice.Delta.ToolCalls {
                                wd.markDelta()
                                pos, ok := callIdx[tc.Index]
                                if !ok {
                                        pos = len(calls)
                                        callIdx[tc.Index] = pos
                                        calls = append(calls, nativeCall{ID: tc.ID, Name: tc.Function.Name})
                                }
                                if tc.ID != "" && calls[pos].ID == "" {
                                        calls[pos].ID = tc.ID
                                }
                                if tc.Function.Name != "" && calls[pos].Name == "" {
                                        calls[pos].Name = tc.Function.Name
                                }
                                calls[pos].Arguments += tc.Function.Arguments
                        }
                        // v0.95.4 THE DSML FILTER: deepseek-family models
                        // stream their native tool markup (<｜DSML｜calls>…)
                        // as CONTENT when they fall back to their own format
                        // — the markup leaked into the visible transcript and
                        // the calls inside never executed (the user's live
                        // scooby export). Split each fragment: visible text
                        // passes through, the markup is stripped, and a
                        // closed block's calls are RESCUED (native call list
                        // when the request carries tools; ACTION lines in the
                        // content stream for the ReAct parser when not).
                        if choice.Delta.Reasoning != "" || choice.Delta.ReasoningOR != "" || choice.Delta.Content != "" {
                                wd.markDelta() // v0.24: real token — wait-notices go quiet
                                visible := dsml.feed(choice.Delta.Content)
                                if onDelta != nil {
                                        // v0.93.1: merge the two reasoning field
                                        // conventions (reasoning_content · reasoning);
                                        // only one is ever non-empty per chunk.
                                        onDelta(choice.Delta.Reasoning+choice.Delta.ReasoningOR, visible)
                                }
                        }
                }
                if chunk.Usage != nil {
                        usage.InputTokens = chunk.Usage.PromptTokens
                        usage.OutputTokens = chunk.Usage.CompletionTokens
                }
        }
        // v0.95.4 END-OF-STREAM: flush the DSML filter (salvage an
        // unterminated block — the finish_reason=length class — release held
        // partial openers, deliver rescued calls to the right consumer) and
        // surface the token-cap note when the provider cut the output.
        if dCalls, dVisible := dsml.flush(); len(dCalls) > 0 || dVisible != "" {
                if dsml.takeNative {
                        calls = append(calls, dCalls...)
                }
                if onDelta != nil && dVisible != "" {
                        onDelta("", dVisible)
                }
        }
        if hitLength {
                note := "\n\n_(the provider cut this output at its token cap — say \"continue\" to resume)_"
                if onDelta != nil {
                        onDelta("", note)
                }
        }
        if err := scanner.Err(); err != nil {
                if wd.timedOut.Load() {
                        ch <- ChatChunk{Type: "error", Error: "timeout", Message: fmt.Sprintf("%s went silent (no data for %s) — it may be overloaded or at capacity; try again or switch models", modelShort(req.Model), idleWaitFor(req.Model))}
                        return usage, calls, nil
                }
                // v0.93.1: the oversize-line case gets a plain-language name —
                // "bufio.Scanner: token too long" told the user nothing. The
                // 16MB cap means this is now a genuine runaway host or a
                // media payload class the chat can't render.
                if errors.Is(err, bufio.ErrTooLong) {
                        return usage, calls, fmt.Errorf("stream: %s's response lines exceeded the 16MB line cap (a media/base64 payload the chat view can't render) — try a text model", modelShort(req.Model))
                }
                // v0.39: mid-stream transport failure — RETURN the error (the
                // round-level pause ladder retries transient ones; the turn
                // runners emit the single honest error chunk on give-up).
                return usage, calls, fmt.Errorf("stream: %w", err)
        }
        usage.TotalTokens = usage.InputTokens + usage.OutputTokens
        return usage, calls, nil
}

// doPostSSE issues the POST and returns the response — or (nil, err) when
// the request failed BEFORE any response (transport / NewRequest errors).
// v0.39: failures are RETURNED, not emitted as chunks — the round-level
// pause ladder retries transient ones quietly, and the turn runners emit
// the honest error chunk only when the ladder gives up (the old emit-here
// pattern terminalized the UI on recoverable blips: the frontend treats
// an error event as end-of-turn).
func doPostSSE(ctx context.Context, req ChatRequest, url string, bodyBytes []byte, ch chan<- ChatChunk) (*http.Response, error) {
        httpReq, err := http.NewRequestWithContext(ctx, "POST", url, bytes.NewReader(bodyBytes))
        if err != nil {
                return nil, fmt.Errorf("new request: %w", err)
        }
        httpReq.Header.Set("Content-Type", "application/json")
        httpReq.Header.Set("User-Agent", browserUA)
        if req.AuthStyle == "anthropic" {
                httpReq.Header.Set("x-api-key", req.APIKey)
                httpReq.Header.Set("anthropic-version", "2023-06-01")
        } else {
                httpReq.Header.Set("Authorization", "Bearer "+req.APIKey)
        }
        // v0.25: OpenCode Zen free-tier session id (x-session-id) — without it
        // big-pickle + *-free models 400 with MissingSessionID.
        for k, v := range providerExtraHeaders(req.Provider, req.APIKey) {
                httpReq.Header.Set(k, v)
        }
        httpReq.Header.Set("Accept", "text/event-stream")
        httpReq.Header.Set("HTTP-Referer", "https://doomalay.app")
        httpReq.Header.Set("X-Title", "Doomalay")

        // v0.24: CONNECT-PHASE notices — kimi-k3 can sit in http.Do for
        // MINUTES before even the response HEADERS arrive (observed live:
        // a whole 3-min turn never reached the body). Cover that silence
        // too, then hand over to the body-phase notifier in scanSSE.
        connClock := &silentClock{start: time.Now()}
        stopConnNotices := waitNotices(ch, connClock, req.Model, req.Provider)
        resp, err := providerStreamHTTP.Do(httpReq)
        if err != nil {
                stopConnNotices()
                // v0.39: transport-level failure (timeout/reset/refused) —
                // network class: 60s provider cooldown so alternate routing
                // skips the dead host; the round-level pause ladder retries.
                RecordProviderFailure(req.Provider, "net", err.Error())
                return nil, fmt.Errorf("send: %w", err)
        }
        stopConnNotices()
        return resp, nil
}

// ── v0.26: the effort-param blacklist (400-resilience state) ──────────

var (
        effortBLMu   sync.Mutex
        effortBlackl = map[string]bool{} // "provider|model" → skip the param
)

func effortBLKey(provider, model string) string {
        return strings.ToLower(provider) + "|" + strings.ToLower(model)
}

func blacklistEffort(provider, model string) {
        effortBLMu.Lock()
        effortBlackl[effortBLKey(provider, model)] = true
        effortBLMu.Unlock()
}

func effortBlacklisted(provider, model string) bool {
        effortBLMu.Lock()
        defer effortBLMu.Unlock()
        return effortBlackl[effortBLKey(provider, model)]
}

// mentionsEffortParam reports whether a 400 body is complaining about the
// reasoning/effort/thinking request fields (rather than auth, quota, the
// model id, the payload, etc.).
// v0.69: the Pydantic validation shapes join the trigger list — PM's
// deployed glm-5.3 rejects out-of-enum values with
//
//      {'type': 'literal_error', 'loc': ('body', 'reasoning_effort'),
//       'msg': "Input should be 'none', 'minima…"}
//
// which contains NONE of the old trigger words ("unexpected"/"unknown"/…),
// so the retry-without-param rescue never fired and the raw 400 surfaced
// (the user's report). A body that names a reasoning field AND carries a
// validation/literal_error shape is an effort-param rejection.
func mentionsEffortParam(body string) bool {
        b := strings.ToLower(body)
        if !strings.Contains(b, "reason") && !strings.Contains(b, "effort") && !strings.Contains(b, "thinking") && !strings.Contains(b, "chat_template") {
                return false
        }
        return strings.Contains(b, "unexpected") || strings.Contains(b, "unknown") ||
                strings.Contains(b, "unrecognized") || strings.Contains(b, "not supported") ||
                strings.Contains(b, "unsupported") || strings.Contains(b, "invalid") ||
                strings.Contains(b, "additional") || strings.Contains(b, "not allowed") ||
                strings.Contains(b, "prohibited") ||
                // v0.69: the Pydantic/FastAPI validation family
                strings.Contains(b, "literal_error") ||
                strings.Contains(b, "validation error") ||
                strings.Contains(b, "input should be")
}

// CompleteSync performs ONE non-streaming completion and returns the full
// text (exported for the server's auto-compact summarizer + the delegate
// fan-out; the ReAct loop + research steps also use it).
func CompleteSync(ctx context.Context, req ChatRequest, extraBody map[string]any) (string, error) {
        return completeSync(ctx, req, extraBody)
}

// completeSync performs ONE non-streaming completion (ReAct rounds + research
// steps need the full text before deciding the next move).
func completeSync(ctx context.Context, req ChatRequest, extraBody map[string]any) (string, error) {
        messages := make([]Message, 0, len(req.Messages)+1)
        if req.SystemPrompt != "" {
                messages = append(messages, Message{Role: "system", Content: req.SystemPrompt})
        }
        messages = append(messages, req.Messages...)

        body := map[string]any{
                "model":    req.Model,
                "messages": messages,
        }
        if extra := BuildEffortBodyFor(req.Provider, req.Model, req.Effort); extra != nil {
                for k, v := range extra {
                        body[k] = v
                }
        }
        for k, v := range extraBody {
                body[k] = v
        }
        status, bodyBytes, err := httpPostJSONStream(chatURL(req.BaseURL), req.APIKey, body, authHeaders(req))
        if err != nil {
                return "", err
        }
        if status != 200 {
                return "", fmt.Errorf("HTTP %d: %s", status, string(bodyBytes))
        }
        var resp struct {
                Choices []struct {
                        Message struct {
                                Content   string `json:"content"`
                                Reasoning string `json:"reasoning_content"`
                        } `json:"message"`
                } `json:"choices"`
        }
        if err := json.Unmarshal(bodyBytes, &resp); err != nil {
                return "", fmt.Errorf("decode: %w", err)
        }
        if len(resp.Choices) == 0 {
                return "", fmt.Errorf("empty choices")
        }
        if resp.Choices[0].Message.Content == "" && resp.Choices[0].Message.Reasoning != "" {
                return resp.Choices[0].Message.Reasoning, nil // reasoning-only response
        }
        return resp.Choices[0].Message.Content, nil
}

// chatURL builds the chat-completions URL from a base URL (v0.12 double-/v1 fix).
func chatURL(baseURL string) string {
        base := strings.TrimSuffix(baseURL, "/")
        if strings.HasSuffix(base, "/v1") {
                return base + "/chat/completions"
        }
        return base + "/v1/chat/completions"
}

// authHeaders returns provider-specific headers for httpPostJSON.
func authHeaders(req ChatRequest) map[string]string {
        h := map[string]string{}
        if req.AuthStyle == "anthropic" {
                h["x-api-key"] = req.APIKey
                h["anthropic-version"] = "2023-06-01"
        }
        // v0.25: OpenCode Zen — the free-tier models require a session id
        // (x-session-id); paid models ignore it. Harmless to always send.
        for k, v := range providerExtraHeaders(req.Provider, req.APIKey) {
                h[k] = v
        }
        return h
}

// ── Web search turn ────────────────────────────────────────────────────────
//
// runWebSearchTurn — the web turn, v1.13.3 THE GUT edition: Path A only
// (OpenRouter's provider-side search plugin streams one native round).
// The ACTION ReAct loop (Path B) is DELETED — every tools-capable provider
// runs runNativeToolsTurn against the mcpbus instead. A request that
// reaches here without a native search body falls through to a plain
// streaming completion (the honest no-tools answer).
func runWebSearchTurn(ctx context.Context, ch chan<- ChatChunk, errs chan<- error, req ChatRequest) {
        ch <- ChatChunk{Type: "status", State: "running"}

        // Path A: native provider-side search (OpenRouter only, web turns).
        if req.WebSearch {
                if native := NativeWebSearchBody(req.Provider, req.Model); native != nil {
                        // v0.44: Path A never walks the ReAct composition below —
                        // a method template's brief still rides the system message
                        // (prepended to the persona system message, the direct
                        // path's messages[0]).
                        aReq := req
                        if req.TemplateBrief != "" && len(aReq.Messages) > 0 && aReq.Messages[0].Role == "system" {
                                msgs := make([]Message, len(aReq.Messages))
                                copy(msgs, aReq.Messages)
                                msgs[0].Content = templateBriefBlock(req.TemplateID, req.TemplateBrief) + "\n" + msgs[0].Content
                                aReq.Messages = msgs
                        }
                        _, err := streamCompletion(ctx, aReq, ch, native)
                        if err != nil {
                                emitTurnError(ch, err)
                                errs <- err
                                return
                        }
                        ch <- ChatChunk{Type: "status", State: "idle"}
                        return
                }
        }

        // v1.13.3: no native search body — stream plainly (the routing in
        // Chat sends OpenRouter web turns here; anything else landing on
        // this branch still gets an honest streamed answer, just no
        // provider-side search).
        _, err := streamCompletion(ctx, req, ch, nil)
        if err != nil {
                emitTurnError(ch, err)
                errs <- err
                return
        }
        ch <- ChatChunk{Type: "status", State: "idle"}
}

// executeAction runs ONE parsed tool call and returns its observation
// (v0.25: extracted from runWebSearchTurn's body so the multi-action loop
// can call it per action). allSources accumulates web-search citations
// across calls.
func executeAction(ctx context.Context, req ChatRequest, ch chan<- ChatChunk, action, argJSON string, allSources *[]SearchResult) string {
        // v1.13.3 THE GUT: no alias layer — native tool_calls carry exact
        // manifest names; a hallucinated name gets the honest unknown-tool
        // teaching (the model self-corrects in one round).
        var observation string
        // v0.28: PERSONA TOOLS — the bot's self-management hands. Routed
        // through the server callback (it owns the session store); the
        // pill + observation mirror the local-tool shape so the UI and the
        // model both see a normal tool round.
        if action == "persona_list" || action == "persona_set" || action == "persona_activate" || action == "placeholder_set" {
                var args map[string]any
                summary := ""
                if json.Unmarshal([]byte(argJSON), &args) == nil {
                        if v, ok := args["name"].(string); ok {
                                summary = v
                        } else if v, ok := args["id"].(string); ok {
                                summary = v
                        } else if v, ok := args["key"].(string); ok {
                                summary = v
                        }
                }
                ch <- ChatChunk{Type: "tool_use", Name: action, Summary: summary}
                if req.PersonaToolFn != nil {
                        observation = req.PersonaToolFn(ctx, action, argJSON)
                } else {
                        observation = "OBSERVATION:\nerror: persona tools need a live session on this server"
                }
                ch <- ChatChunk{Type: "tool_result", Text: clamp(strings.TrimPrefix(observation, "OBSERVATION:\n"), 600), Name: action}
                return observation
        }
        if action == "hublib" && req.HublibToolFn != nil {
                // v0.67.2: THE LIBRARY on the direct path — browse/get/
                // download the public hub through the server's runner
                // (it owns the hub service + the per-chat Bot Library
                // switch; downloads refuse with the switch path when
                // OFF). Pill + observation mirror the local-tool shape.
                var args map[string]any
                summary := ""
                if json.Unmarshal([]byte(argJSON), &args) == nil {
                        for _, k := range []string{"q", "id", "action"} {
                                if v, ok := args[k].(string); ok && v != "" {
                                        summary = v
                                        break
                                }
                        }
                }
                ch <- ChatChunk{Type: "tool_use", Name: "hublib", Summary: summary}
                observation = req.HublibToolFn(ctx, argJSON)
                ch <- ChatChunk{Type: "tool_result", Text: clamp(strings.TrimPrefix(observation, "OBSERVATION:\n"), 600), Name: "hublib"}
                return observation
        }
        if action == "skills" && req.SkillsToolFn != nil {
                // v0.72: THE SKILLS HAND on the direct path — bootstrap/
                // list/search/load a DOWNLOADED skill's methodology
                // through the server's runner (same dispatch as the PM
                // bridge). The load result's "SKILL LOADED — <name>"
                // head feeds the active-bundle pill (deterministic:
                // tool_use/tool_result ride the event log, replays match).
                var args map[string]any
                summary := ""
                if json.Unmarshal([]byte(argJSON), &args) == nil {
                        for _, k := range []string{"skill", "q", "action"} {
                                if v, ok := args[k].(string); ok && v != "" {
                                        summary = v
                                        break
                                }
                        }
                }
                ch <- ChatChunk{Type: "tool_use", Name: "skills", Summary: summary}
                observation = req.SkillsToolFn(ctx, argJSON)
                ch <- ChatChunk{Type: "tool_result", Text: clamp(strings.TrimPrefix(observation, "OBSERVATION:\n"), 600), Name: "skills"}
                return observation
        }
        if action == "workspace" && req.WorkspaceToolFn != nil {
                // v0.76.5: THE WORKSPACE HAND on the direct path — the
                // chat's connected cloud repos through the server's
                // runner (it owns the rows + vault tokens). Marker heads
                // (COMMITTED / PR OPENED / FORKED — …) are deterministic.
                var args map[string]any
                summary := ""
                if json.Unmarshal([]byte(argJSON), &args) == nil {
                        for _, k := range []string{"ws", "path", "query", "what", "action"} {
                                if v, ok := args[k].(string); ok && v != "" {
                                        summary = v
                                        break
                                }
                        }
                }
                ch <- ChatChunk{Type: "tool_use", Name: "workspace", Summary: summary}
                observation = req.WorkspaceToolFn(ctx, argJSON)
                ch <- ChatChunk{Type: "tool_result", Text: clamp(strings.TrimPrefix(observation, "OBSERVATION:\n"), 600), Name: "workspace"}
                return observation
        }
        if action == "delegate" && req.DelegateFn != nil {
                // v0.21: SWARM FANOUT (the HF panel delegate, ported) —
                // one prompt, up to 3 other models answer in parallel.
                var args struct {
                        Prompt string   `json:"prompt"`
                        Models []string `json:"models"`
                }
                _ = json.Unmarshal([]byte(argJSON), &args)
                if args.Prompt == "" {
                        observation = "OBSERVATION:\nerror: delegate needs {\"prompt\": \"...\", \"models\": [\"provider/model\", \"…\"]}"
                } else {
                        ch <- ChatChunk{Type: "progress", Text: "consulting other models…"}
                        ch <- ChatChunk{Type: "tool_use", Name: "delegate", Summary: clamp(args.Prompt, 80)}
                        outs := req.DelegateFn(ctx, args.Prompt, args.Models)
                        b, _ := json.Marshal(outs)
                        observation = "OBSERVATION:\n" + string(b)
                        ch <- ChatChunk{Type: "tool_result", Text: clamp(string(b), 600), Name: "delegate"}
                }
        } else if IsLocalTool(action) {
                // v0.20: local tools — pure Go, zero latency, zero setup.
                summary := mcpbus.DefaultSummary(action, argJSON)
                ch <- ChatChunk{Type: "tool_use", Name: action, Summary: summary}
                observation = RunLocalTool(action, argJSON, req.ArtifactSink)
                obs := strings.TrimPrefix(observation, "OBSERVATION:\n")
                res := ChatChunk{Type: "tool_result", Text: clamp(obs, 600), Name: action}
                // v0.22: file tools report the saved artifact so the UI
                // can render a real download card right after the pill.
                if strings.Contains(obs, "Saved as artifact ") {
                        var fargs struct {
                                Name string `json:"name"`
                        }
                        _ = json.Unmarshal([]byte(argJSON), &fargs)
                        if fargs.Name != "" {
                                res.Artifact = map[string]any{"name": fargs.Name}
                        }
                }
                ch <- res
        } else {
                switch action {
                case "template_list":
                        // v0.52 THE 3 PILLS: the chat's template auto-search
                        // pill gates the tools — the protocol does not
                        // advertise them when it's off, but a model can
                        // still invent the call (or remember it from an
                        // earlier turn): answer honestly, don't run it.
                        if !req.TemplateAuto {
                                observation = "OBSERVATION:\nerror: the template library is disabled for this chat (the template pill is off). Ask the user to enable the template pill, or answer without it."
                                return observation
                        }
                        // v0.44 TEMPLATE SELF-SERVE: the model can browse the
                        // app's template library (the same index the template
                        // pill shows) and pick a methodology to follow.
                        ch <- ChatChunk{Type: "tool_use", Name: "template_list", Summary: "browse the template library"}
                        obs := runTemplateList(ctx, req)
                        observation = obs
                        ch <- ChatChunk{Type: "tool_result", Text: clamp(strings.TrimPrefix(obs, "OBSERVATION:\n"), 600), Name: "template_list"}
                case "template_show":
                        if !req.TemplateAuto {
                                observation = "OBSERVATION:\nerror: the template library is disabled for this chat (the template pill is off). Ask the user to enable the template pill, or answer without it."
                                return observation
                        }
                        var args struct {
                                ID string `json:"id"`
                        }
                        _ = json.Unmarshal([]byte(argJSON), &args)
                        if args.ID == "" {
                                observation = "OBSERVATION:\nerror: template_show needs {\"id\": \"...\"} — get ids from template_list"
                                return observation
                        }
                        ch <- ChatChunk{Type: "tool_use", Name: "template_show", Summary: clamp(args.ID, 80)}
                        obs := runTemplateShow(ctx, req, args.ID)
                        observation = obs
                        ch <- ChatChunk{Type: "tool_result", Text: clamp(strings.TrimPrefix(obs, "OBSERVATION:\n"), 600), Name: "template_show"}
                case "web_search":
                        var args struct {
                                Query string `json:"query"`
                        }
                        _ = json.Unmarshal([]byte(argJSON), &args)
                        if args.Query == "" {
                                observation = "OBSERVATION:\nerror: empty query"
                                return observation
                        }
                        ch <- ChatChunk{Type: "tool_use", Name: "web_search", Summary: args.Query}
                        results, err := WebSearch(ctx, args.Query, 5, req.TavilyKey)
                        if err != nil {
                                observation = "OBSERVATION:\nsearch error: " + err.Error()
                                return observation
                        }
                        *allSources = append(*allSources, results...)
                        ch <- ChatChunk{Type: "sources", Sources: results}
                        obs := FormatSearchResults(results)
                        if obs == "" {
                                // v0.27.1: mirrors the PM path — "no results" for a specific
                                // named project usually means private/nonexistent; say that
                                // so the model stops instead of re-searching (it used to see
                                // a fake network error here and retry the same query).
                                obs = "(no results — try different terms; a specific named project or account may be private or nonexistent, in which case say so instead of retrying)"
                        }
                        observation = "OBSERVATION:\n" + obs
                        ch <- ChatChunk{Type: "tool_result", Text: clamp(obs, 600), Name: "web_search"}
                case "web_fetch":
                        var args struct {
                                URL string `json:"url"`
                        }
                        _ = json.Unmarshal([]byte(argJSON), &args)
                        if args.URL == "" {
                                observation = "OBSERVATION:\nerror: empty url"
                                return observation
                        }
                        ch <- ChatChunk{Type: "tool_use", Name: "web_fetch", Summary: args.URL}
                        text, err := WebFetch(ctx, args.URL, 12000)
                        if err != nil {
                                observation = "OBSERVATION:\nfetch error: " + err.Error()
                                return observation
                        }
                        observation = "OBSERVATION:\n" + text
                        ch <- ChatChunk{Type: "tool_result", Text: clamp(text, 600), Name: "web_fetch"}
                default:
                        observation = "OBSERVATION:\nerror: unknown tool \"" + action + "\". Valid tools: " + strings.Join(LocalToolNames, ", ") + ", web_search {\"query\": \"...\"}, web_fetch {\"url\": \"...\"} (live internet), template_list {}, template_show {\"id\": \"...\"} (the method-template library)" + (func() string {
                                if req.HublibToolFn != nil {
                                        return ", hublib {\"action\": \"search|get|download|bundles|bundle|download_bundle\", ...} (the public hub library AND its bundles)"
                                }
                                return ""
                        }()) + (func() string {
                                if req.SkillsToolFn != nil {
                                        return ", skills {\"action\": \"bootstrap|list|search|load|files|read\", ...} (the installed skill methodologies)"
                                }
                                return ""
                        }()) + (func() string {
                                // v0.81.6: the repo hand joins the teaching — the
                                // user's repro had the model guessing "repo_list"
                                // and dead-ending. Name the real tool + verbs.
                                if req.WorkspaceToolFn != nil {
                                        return ", workspace {\"action\": \"help|list|ls|read|grep|view|put|pr|pr_diff|pr_review|pr_comment|pr_merge|issue_create|issue_comment|issue_close|discussion_post|workflow_dispatch|file_delete|release_create|branch|fork\", \"ws\": \"owner/repo\", ...} (this chat's CONNECTED cloud repos — grep, read, push, PR, code review, issues, discussions, workflows)"
                                }
                                return ""
                        }()) + "."
                }
        }
        return observation
}
// netPauseWaits (v0.39 P8-FULL): two quick hiccup retries, then the
// pause-not-fail ladder — 15/30/60s waits that keep the turn ALIVE through
// a network outage (timemanager's NetworkPauseError semantics: network-class
// failure = paused, not failed). The turn budget + Stop button backstop it.
var netPauseWaits = []time.Duration{
        1500 * time.Millisecond,
        3 * time.Second,
        15 * time.Second,
        30 * time.Second,
        60 * time.Second,
}

// netPauseLadder retries a network-class failure. fn returns (emitted, err):
// rounds that already streamed VISIBLE content are never retried (double-
// render). Quick hiccups announce via status-running (v0.20 behavior); the
// pause rungs announce via EPHEMERAL progress (live-only — a replayed log
// must not contain stale "network paused" noise). Every failure refreshes
// the provider's 60s network cooldown for alternate routing.
func netPauseLadder(ctx context.Context, ch chan<- ChatChunk, provider string, fn func() (bool, error)) error {
        emitted, err := fn()
        if err == nil || !isTransientNetErr(err) || emitted {
                return err
        }
        for i, w := range netPauseWaits {
                RecordProviderFailure(provider, "net", err.Error())
                if w >= 15*time.Second {
                        select {
                        case ch <- ChatChunk{Type: "progress", Text: fmt.Sprintf("network paused — %s unreachable, retrying in %ds (your turn is safe)", providerLabel(provider), int(w.Seconds()))}:
                        default:
                        }
                } else {
                        ch <- ChatChunk{Type: "status", State: "running", Message: fmt.Sprintf("network hiccup — retry %d/2", i+1)}
                }
                select {
                case <-time.After(w):
                case <-ctx.Done():
                        return ctx.Err()
                }
                emitted, err = fn()
                if err == nil || !isTransientNetErr(err) || emitted {
                        return err
                }
        }
        return err
}

// isTransientNetErr reports whether the error looks like a recoverable
// network/provider blip (worth a silent retry) rather than an auth or
// protocol failure (retrying is pointless).
func isTransientNetErr(err error) bool {
        if err == nil {
                return false
        }
        s := err.Error()
        // v0.93.2 THE MISTRAL TLS CLASS: 'tls: bad record MAC' (and the tls/
        // handshake family) is mid-stream TLS record corruption — carrier
        // NAT rebinds, mobile-network proxies, connection reuse through
        // flaky middleboxes (the Go issue tracker's own diagnosis: 'network
        // corruption of some sort'). The user's live hit: Mistral tool
        // chains died terminal on api.mistral.ai with
        //   Post "https://api.mistral.ai/v1/chat/completions": remote error:
        //   tls: bad record MAC
        // The cure is EXACTLY what the pause ladder does — retry on a FRESH
        // connection (Go's transport discards the poisoned one). These are
        // transient by nature; auth/protocol errors never match this set.
        return regexp.MustCompile(`(?i)timeout|context deadline|connection reset|broken pipe|unexpected EOF|refused|temporary|HTTP 5[0-9][0-9]|503|502|network|went silent|no data|bad record mac|tls:|record mac|handshake failure`).MatchString(s)
}

// mergeUsage sums two usage reports (nil-safe).
func mergeUsage(a, b *Usage) *Usage {
        if b == nil {
                return a
        }
        if a == nil {
                return b
        }
        return &Usage{InputTokens: a.InputTokens + b.InputTokens, OutputTokens: a.OutputTokens + b.OutputTokens}
}

// (v1.13.3 THE GUT: parseAction/parseActions/actionRe died with the
// ACTION protocol — the native tool_calls wire carries structured
// arguments; there is nothing to parse out of prose. repairJSON and
// repairJSONReport SURVIVE: they repair TRUNCATED STREAMED tool_call
// arguments (a different, real failure class) and enforce the honesty
// line for calls cut mid-string.)

func repairJSON(s string) string {
        fixed, _ := repairJSONReport(s)
        return fixed
}

// repairJSONReport repairs malformed model JSON AND reports whether the
// original was cut MID-STRING (v0.95.4). The distinction is the honesty
// line: a call that only misses closing braces (the model forgot the
// closers, the VALUES are complete) repairs safely; a call cut inside a
// string value (the provider's token cap ate the tail — the live .MD
// artifact cutoff class) would, repaired, EXECUTE WITH TRUNCATED CONTENT
// and no error. Callers refuse the inString-truncated class and tell the
// model to re-send instead.
func repairJSONReport(s string) (string, bool) {
        var b strings.Builder
        // open bracket stack: '{' or '[' for each currently-open container
        var stack []byte
        inStr, esc := false, false
        for _, r := range s {
                switch {
                case inStr && esc:
                        esc = false
                        b.WriteRune(r)
                case inStr && r == '\\':
                        esc = true
                        b.WriteRune(r)
                case inStr && r == '"':
                        inStr = false
                        b.WriteRune(r)
                case inStr:
                        switch r {
                        case '\n':
                                b.WriteString(`\n`)
                        case '\r':
                                b.WriteString(`\r`)
                        case '\t':
                                b.WriteString(`\t`)
                        default:
                                b.WriteRune(r)
                        }
                case r == '"':
                        inStr = true
                        b.WriteRune(r)
                case r == '{':
                        stack = append(stack, '}')
                        b.WriteRune(r)
                case r == '[':
                        stack = append(stack, ']')
                        b.WriteRune(r)
                case (r == '}' || r == ']') && len(stack) > 0:
                        stack = stack[:len(stack)-1]
                        b.WriteRune(r)
                default:
                        b.WriteRune(r)
                }
        }
        out := b.String()
        if inStr {
                out += `"`
        }
        // close remaining containers innermost-first (stack is already in
        // open order; appending from the END closes innermost-first)
        for i := len(stack) - 1; i >= 0; i-- {
                out += string(stack[i])
        }
        return out, inStr
}

func lenientJSON(s string) string {
        s = strings.Map(func(r rune) rune {
                switch r {
                case '\u201c', '\u201d':
                        return '"'
                case '\u2018', '\u2019':
                        return '\''
                }
                return r
        }, s)
        var b strings.Builder
        inD, inS, esc := false, false, false
        lastCh := byte(0) // last non-space byte EMITTED (key-position test)
        runes := []rune(s)
        emit := func(str string) {
                b.WriteString(str)
                for i := 0; i < len(str); i++ {
                        if str[i] != ' ' && str[i] != '\t' && str[i] != '\n' && str[i] != '\r' {
                                lastCh = str[i]
                        }
                }
        }
        for i := 0; i < len(runes); i++ {
                r := runes[i]
                if inD {
                        emit(string(r))
                        if esc {
                                esc = false
                        } else if r == '\\' {
                                esc = true
                        } else if r == '"' {
                                inD = false
                        }
                        continue
                }
                if inS {
                        if r == '\'' {
                                // ' → ": escape inner straight doubles
                                emit("\"")
                                inS = false
                        } else if r == '"' {
                                emit("\\\"")
                        } else {
                                emit(string(r))
                        }
                        continue
                }
                switch r {
                case '"':
                        inD = true
                        emit("\"")
                case '\'':
                        inS = true
                        emit("\"")
                case ',':
                        // drop a trailing comma (next non-space is } or ])
                        j := i + 1
                        for j < len(runes) && (runes[j] == ' ' || runes[j] == '\t' || runes[j] == '\n' || runes[j] == '\r') {
                                j++
                        }
                        if j < len(runes) && (runes[j] == '}' || runes[j] == ']') {
                                continue
                        }
                        emit(",")
                case '}', ']', '{', '[', ':':
                        emit(string(r))
                default:
                        // bare-word key: an identifier followed by ':' where a
                        // key is expected ({ or , before it)
                        if isIdentRune(r) {
                                j := i
                                for j < len(runes) && isIdentRune(runes[j]) {
                                        j++
                                }
                                k := j
                                for k < len(runes) && (runes[k] == ' ' || runes[k] == '\t') {
                                        k++
                                }
                                if k < len(runes) && runes[k] == ':' && (lastCh == '{' || lastCh == ',') {
                                        emit("\"" + string(runes[i:j]) + "\"")
                                        i = j - 1
                                        continue
                                }
                        }
                        emit(string(r))
                }
        }
        return b.String()
}

func isIdentRune(r rune) bool {
        return r == '_' || (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9')
}

func splitAnswer(s string) []string {
        s = strings.TrimSpace(s)
        if s == "" {
                return []string{}
        }
        const seg = 220
        var out []string
        for len(s) > seg {
                // split on a space near the boundary for cleaner rendering
                cut := strings.LastIndexAny(s[:seg], " \n")
                if cut < seg/2 {
                        cut = seg
                }
                out = append(out, s[:cut])
                s = s[cut:]
        }
        if len(s) > 0 {
                out = append(out, s)
        }
        return out
}

// ── Deep research pipeline (ported from research_templates.run_deep_research,
// "default" mode) ──────────────────────────────────────────────────────────
//
// initial search (8 results) → fetch + read top 5 pages → the model generates
// 2-4 follow-up queries → search them (3 results each) → read the tops →
// synthesize a cited answer. Emits status/sources/thinking events throughout;
// the synthesis streams.

func runDeepResearch(ctx context.Context, ch chan<- ChatChunk, errs chan<- error, req ChatRequest) {
        ch <- ChatChunk{Type: "status", State: "running"}
        question := lastUserMessage(req.Messages)

        emitStatus := func(stage, detail string) {
                ch <- ChatChunk{Type: "status", State: "running", Text: stage, Message: detail}
        }
        // v0.38 TRACEABLE RESEARCH (user spec: "no tool pills or anything of
        // the sort — a black box"): every research stage now emits the SAME
        // tool_use/tool_result pill pairs the ReAct path uses — the research
        // is fully traceable in the transcript, exactly like the GLM/nemotron
        // web-search chains the user praised.
        emitPill := func(name, summary, result string) {
                ch <- ChatChunk{Type: "tool_use", Name: name, Summary: clamp(summary, 80)}
                ch <- ChatChunk{Type: "tool_result", Name: name, Text: clamp(result, 600)}
        }

        // 1. Initial search.
        emitStatus("initial_search", question)
        ch <- ChatChunk{Type: "tool_use", Name: "web_search", Summary: clamp(question, 80)}
        results, err := WebSearch(ctx, question, 8, req.TavilyKey)
        if err != nil {
                ch <- ChatChunk{Type: "error", Error: "web_search", Message: err.Error()}
                ch <- ChatChunk{Type: "status", State: "error"}
                return
        }
        if len(results) > 0 {
                ch <- ChatChunk{Type: "tool_result", Name: "web_search",
                        Text: clamp(fmt.Sprintf("%d results — %s", len(results), results[0].Title), 600)}
        } else {
                ch <- ChatChunk{Type: "tool_result", Name: "web_search", Text: "(no results)"}
        }
        ch <- ChatChunk{Type: "sources", Sources: results}
        allSources := results

        // 2. Read the top pages (parallel).
        emitStatus("reading", fmt.Sprintf("reading %d pages", min(5, len(results))))
        pages := readTopPages(ctx, results, 5)
        for _, pr := range pages {
                if pr.idx >= 0 && pr.idx < len(results) {
                        emitPill("web_fetch", results[pr.idx].URL, clamp(pr.text, 600))
                }
        }

        // 3. Follow-up queries from the model.
        emitStatus("followups", "generating follow-up queries")
        followPrompt := buildResearchPrompt(question, results, pages, true)
        followReq := req
        followReq.SystemPrompt = "You are a research planner. Output ONLY a JSON array of 2-4 short search queries (strings) that would fill gaps in the material. No prose, no markdown fences."
        followReq.Messages = []Message{{Role: "user", Content: followPrompt}}
        followupsJSON, err := completeSync(ctx, followReq, nil)
        if err == nil {
                var queries []string
                trimmed := strings.TrimPrefix(strings.TrimSuffix(strings.TrimSpace(followupsJSON), "```"), "```json")
                if json.Unmarshal([]byte(trimmed), &queries) == nil {
                        emitStatus("followup_search", fmt.Sprintf("%d follow-up searches", len(queries)))
                        for _, q := range queries {
                                if r, err := WebSearch(ctx, q, 3, req.TavilyKey); err == nil {
                                        allSources = append(allSources, r...)
                                        res := fmt.Sprintf("%d results", len(r))
                                        if len(r) > 0 {
                                                res += " — " + r[0].Title
                                        }
                                        emitPill("web_search", q, res)
                                        ch <- ChatChunk{Type: "sources", Sources: r}
                                }
                        }
                }
        }

        // 4. Synthesize with citations (streams).
        emitStatus("synthesizing", "writing the report")
        synthReq := req
        synthReq.SystemPrompt = "You are a meticulous research analyst. Write a thorough, well-structured answer with inline citations like [1], [2] referring to the numbered sources. If sources conflict, say so. End with a short 'Sources' list. Never fabricate facts or URLs."
        synthReq.Messages = []Message{{Role: "user", Content: buildResearchPrompt(question, allSources, pages, false)}}
        _, err = streamCompletion(ctx, synthReq, ch, nil)
        if err != nil {
                emitTurnError(ch, err)
                errs <- err
                return
        }
        ch <- ChatChunk{Type: "status", State: "idle"}
}

// pageRead is one fetched page for the research pipeline.
type pageRead struct {
        idx  int
        text string
}

// readTopPages fetches the top N result pages in parallel (best-effort).
func readTopPages(ctx context.Context, results []SearchResult, n int) []pageRead {
        if n > len(results) {
                n = len(results)
        }
        pageCh := make(chan pageRead, n)
        var wg sync.WaitGroup
        for i := 0; i < n; i++ {
                wg.Add(1)
                go func(i int, u string) {
                        defer wg.Done()
                        text, err := WebFetch(ctx, u, 9000)
                        if err != nil {
                                return
                        }
                        pageCh <- pageRead{idx: i, text: text}
                }(i, results[i].URL)
        }
        wg.Wait()
        close(pageCh)
        pages := make([]pageRead, 0, n)
        for p := range pageCh {
                pages = append(pages, p)
        }
        return pages
}

// buildResearchPrompt assembles the research context for the model.
func buildResearchPrompt(question string, results []SearchResult, pages []pageRead, planning bool) string {
        var b strings.Builder
        b.WriteString("QUESTION: " + question + "\n\nSEARCH RESULTS:\n")
        b.WriteString(FormatSearchResults(results))
        if len(pages) > 0 {
                b.WriteString("\n\nPAGE EXCERPTS:\n")
                for _, p := range pages {
                        fmt.Fprintf(&b, "--- [page %d] ---\n%s\n\n", p.idx+1, clamp(p.text, 4000))
                }
        }
        if planning {
                b.WriteString("\nIdentify the most important GAPS in this material about the question.")
        } else {
                b.WriteString("\nWrite the final research report now.")
        }
        return b.String()
}

// lastUserMessage extracts the final user message (the research question).
func lastUserMessage(msgs []Message) string {
        for i := len(msgs) - 1; i >= 0; i-- {
                if msgs[i].Role == "user" {
                        return msgs[i].Content
                }
        }
        return ""
}

func min(a, b int) int {
        if a < b {
                return a
        }
        return b
}
