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
        "fmt"
        "io"
        "log"
        "net/http"
        "os"
        "regexp"
        "strings"
        "sync"
        "sync/atomic"
        "time"
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
        // v0.21: SWARM FANOUT DELEGATE (the HF space's panel delegate, ported).
        // Set by the server (it owns the vault); the ReAct loop exposes it to
        // the model as the `delegate` ACTION — one prompt, up to 3 other
        // models answer in parallel, replies return as the OBSERVATION.
        DelegateFn func(ctx context.Context, prompt string, models []string) []map[string]any `json:"-"`
        // v0.22: FILE TOOLS SINK — docx_create/xlsx_create/zip_create save the
        // binaries they build here (the session's artifact drawer). Set by the
        // server; nil = file tools still run but don't persist.
        ArtifactSink ArtifactSink `json:"-"`
}

// Message is one chat message.
type Message struct {
        Role    string `json:"role"`
        Content string `json:"content"`
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
                } `json:"delta"`
                FinishReason string `json:"finish_reason"`
        } `json:"choices"`
        Usage *struct {
                PromptTokens     int `json:"prompt_tokens"`
                CompletionTokens int `json:"completion_tokens"`
                TotalTokens      int `json:"total_tokens"`
        } `json:"usage,omitempty"`
}

// Chat streams a chat completion from an OpenAI-compatible provider,
// dispatching to the capability pipelines when requested.
func Chat(ctx context.Context, req ChatRequest) (<-chan ChatChunk, <-chan error) {
        ch := make(chan ChatChunk, 64)
        errs := make(chan error, 1)

        go func() {
                defer close(ch)
                defer close(errs)

                switch {
                case req.DeepResearch && req.Provider != "":
                        runDeepResearch(ctx, ch, errs, req)
                case req.WebSearch && req.Provider != "":
                        runWebSearchTurn(ctx, ch, errs, req)
                default:
                        // v0.20: PLAIN turns run the unified ReAct tool loop too —
                        // the local tool set (calculator/time/uuid/hash/json/
                        // base64/random/url/regex/text_stats) is ALWAYS armed.
                        // It costs nothing when the model just answers, and it
                        // makes every quick chat dramatically more capable
                        // (the first big HF-space port: zero-setup tools).
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
                errs <- err
                return
        }
        _ = final
        ch <- ChatChunk{Type: "status", State: "idle", Usage: final}
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
// only kills true silence.
//
// v0.24: the timeout is now MODEL-AWARE (idleWaitFor): reasoning models
// (kimi-k3 observed live: 5+ minutes of server-side thinking with ZERO
// bytes) get 240s before the kill; everyone else keeps 90s. While the
// stream is still silent, waitNotices() keeps the UI informed instead of
// the old dead "thinking…" — the user sees "waiting for kimi-k3 · 60s…"
// and knows it's the provider, not the app.
type idleTimeoutReader struct {
        rc         io.ReadCloser
        timeout    time.Duration
        timer      *time.Timer
        stopped    chan struct{}
        timedOut   atomic.Bool
        lastDelta  atomic.Int64 // v0.24: unix-ms of the last REAL reasoning/content delta (0 = none yet)
        startMS    atomic.Int64 // v0.24: when the stream opened (for notices)
}

func newIdleTimeoutReader(rc io.ReadCloser, d time.Duration) *idleTimeoutReader {
        r := &idleTimeoutReader{rc: rc, timeout: d, stopped: make(chan struct{})}
        r.timer = time.AfterFunc(d, func() {
                select {
                case <-r.stopped:
                default:
                        r.timedOut.Store(true)
                        rc.Close()
                }
        })
        return r
}

func (r *idleTimeoutReader) Read(p []byte) (int, error) {
        n, err := r.rc.Read(p)
        if n > 0 {
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
        r.timer.Stop()
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

// idleWaitFor returns the no-data watchdog for a model. v0.24: reasoning
// models think server-side for MINUTES before the first byte (observed
// live: nvidia kimi-k3, 5+ min) — the old flat 90s killed those turns
// mid-action ("its response interrupted mid action", user report). They
// now get 240s; regular models keep 90s.
func idleWaitFor(model string) time.Duration {
        m := strings.ToLower(model)
        if matchesAny(m, reasonKws) || strings.Contains(m, "kimi") ||
                strings.Contains(m, "gpt-oss") || strings.Contains(m, "glm") {
                return 240 * time.Second
        }
        return 90 * time.Second
}

// IsSlowReasoningModel reports whether a model is known to take multi-minute
// turns (server-side thinking between tool rounds) and deserves a longer
// turn budget + idle watchdog. Exported for the server's turn timeout.
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


// silentClock is the pre-connect silence source (v0.24): NIM's kimi-k3
// can sit in http.Do for MINUTES before the response HEADERS arrive —
// observed live, a whole 3-minute turn never got past Do(). waitNotices
// needs to cover that phase too, so it runs on this until the body opens.
type silentClock struct{ start time.Time }

func (s *silentClock) silentFor() time.Duration { return time.Since(s.start) }

// waitNotices streams live "still waiting" progress chunks while the
// provider stays silent (v0.24 — the user's "let the user know instead of
// just displaying thinking…"). Chunks are WS-only progress events; they
// track REAL token gaps (not raw bytes — NIM trickles SSE keepalives while
// kimi-k3 thinks for 139-151s at a stretch, observed live), so the user
// always knows it's the model, not the app. Works for BOTH the connect
// phase (silentClock) and the body phase (idleTimeoutReader).
func waitNotices(ch chan<- ChatChunk, src interface{ silentFor() time.Duration }, model string) (stop func()) {
        shortModel := modelShort(model)
        done := make(chan struct{})
        go func() {
                var tick *time.Ticker
                defer func() { if tick != nil { tick.Stop() } }()
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
                                note := fmt.Sprintf("waiting for %s · %ds", shortModel, int(silent.Seconds()))
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
        // 404 "Function '<id>': Not found for account" — NIM dropped the model
        // for this key (observed live: kimi-k2.6 after NIM rotation).
        if status == 404 && strings.Contains(b, "Not found for account") {
                return "404: this model is no longer available for your " + provider + " account — pick another model"
        }
        // v0.25 OPENCODE ZEN billing clarifications (live-verified with a
        // working key): paid models answer 400 CreditsError "No payment
        // method …/billing" even though the KEY is perfectly valid — free
        // models (big-pickle, *-free) work on the same key. The raw message
        // read as "my key needs billing enabled", which is wrong.
        if strings.Contains(b, "CreditsError") || strings.Contains(b, "No payment method") {
                return "this model is PAID on OpenCode Zen — your key works, but this model needs a payment method at opencode.ai/settings/billing. Free options: big-pickle, nemotron-3.5-lightning-free, deepseek-v4-flash-free"
        }
        if strings.Contains(b, "MissingSessionID") {
                return "OpenCode Zen wants a client session for this model — try big-pickle or another free model"
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
        if req.Effort != "" && req.Effort != "off" && req.Effort != "med" {
                if extra := BuildEffortBodyFor(req.Provider, req.Model, req.Effort); extra != nil {
                        for k, v := range extra {
                                body[k] = v
                        }
                }
        }
        for k, v := range extraBody {
                body[k] = v
        }

        bodyBytes, err := json.Marshal(body)
        if err != nil {
                return nil, fmt.Errorf("marshal: %w", err)
        }

        base := strings.TrimSuffix(req.BaseURL, "/")
        url := base + "/v1/chat/completions"
        if strings.HasSuffix(base, "/v1") {
                url = base + "/chat/completions"
        }
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
        // too, then hand over to the body-phase notifier below.
        connClock := &silentClock{start: time.Now()}
        stopConnNotices := waitNotices(ch, connClock, req.Model)
        resp, err := providerStreamHTTP.Do(httpReq)
        if err != nil {
                stopConnNotices()
                ch <- ChatChunk{Type: "error", Error: "llm_call", Message: err.Error()}
                return nil, nil // error already emitted; keep the turn terminal state clean
        }
        stopConnNotices() // headers arrived — the body notifier takes over
        // v0.19: no-data watchdog — v0.24: MODEL-AWARE (idleWaitFor: reasoning
        // models get 240s — observed live: kimi-k3 thinks 5+ min server-side
        // with zero bytes; the flat 90s killed those turns mid-action). While
        // the stream stays silent, waitNotices keeps the UI informed
        // ("waiting for kimi-k3 · 60s…") instead of a dead "thinking…".
        // The 10-min turn timeout stays as the hard backstop.
        wd := newIdleTimeoutReader(resp.Body, idleWaitFor(req.Model))
        wd.startMS.Store(time.Now().UnixMilli())
        wd.lastDelta.Store(0)
        defer resp.Body.Close()
        defer wd.Close()
        stopNotices := waitNotices(ch, wd, req.Model)
        defer stopNotices()

        if resp.StatusCode != 200 {
                bts, _ := io.ReadAll(wd)
                ch <- ChatChunk{Type: "error", Error: "http", Message: friendlyHTTPError(resp.StatusCode, string(bts), req.Provider)}
                return nil, nil
        }

        scanner := bufio.NewScanner(wd)
        scanner.Buffer(make([]byte, 0, 256*1024), 256*1024)
        usage := &Usage{}
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
                        if choice.Delta.Reasoning != "" || choice.Delta.Content != "" {
                                wd.markDelta() // v0.24: real token — wait-notices go quiet
                                if onDelta != nil {
                                        onDelta(choice.Delta.Reasoning, choice.Delta.Content)
                                }
                        }
                }
                if chunk.Usage != nil {
                        usage.InputTokens = chunk.Usage.PromptTokens
                        usage.OutputTokens = chunk.Usage.CompletionTokens
                }
        }
        if err := scanner.Err(); err != nil {
                if wd.timedOut.Load() {
                        ch <- ChatChunk{Type: "error", Error: "timeout", Message: fmt.Sprintf("%s went silent (no data for %s) — it may be overloaded or at capacity; try again or switch models", modelShort(req.Model), idleWaitFor(req.Model))}
                        return usage, nil
                }
                ch <- ChatChunk{Type: "error", Error: "stream", Message: err.Error()}
                return usage, nil
        }
        usage.TotalTokens = usage.InputTokens + usage.OutputTokens
        return usage, nil
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
// Two paths:
//   A. NATIVE (OpenRouter): merge plugins:[{id:"web"}] into the request body
//      and stream normally — the provider searches server-side.
//   B. INJECTED ReAct (everyone else): append the TOOLS PROTOCOL to the
//      system prompt; the model emits "ACTION: web_search {...}" lines; we
//      execute the tool, append "OBSERVATION: ..." as a user message, and
//      loop until the model writes a final answer (max 8 rounds — the old
//      backend's RESEARCH_MAX_STEPS).

// toolsProtocol (v0.20 unified): the local tool set is ALWAYS part of the
// protocol; the web tools are appended only for web-search turns.
var toolsProtocol = `
You have access to tools. To call one, output a line in this exact shape:
ACTION: <tool> {<json arguments>}
A short one-line preamble before the ACTION line is allowed, but the ACTION line must be the LAST line of your reply and contain nothing else.
After every ACTION the system AUTOMATICALLY sends you an OBSERVATION (the tool's output) — you never wait for the user for this. IMMEDIATELY issue your next ACTION after reading an observation; you may chain many tool calls (up to 24) in one turn back-to-back without any user message in between. ONLY when you have everything you need do you write your FINAL answer as a normal reply (no ACTION line). Never fabricate tool results.`

// webToolsProtocol describes the network tools (web-search turns only).
const webToolsProtocol = `You also have web tools (live internet):
ACTION: web_search {"query": "<search terms>"}
ACTION: web_fetch {"url": "<https url>"}
Cite web sources inline as [1], [2] matching the search result numbering. Never fabricate URLs.`

func runWebSearchTurn(ctx context.Context, ch chan<- ChatChunk, errs chan<- error, req ChatRequest) {
        ch <- ChatChunk{Type: "status", State: "running"}

        // Path A: native provider-side search (OpenRouter only, web turns).
        if req.WebSearch {
                if native := NativeWebSearchBody(req.Provider, req.Model); native != nil {
                        _, err := streamCompletion(ctx, req, ch, native)
                        if err != nil {
                                errs <- err
                                return
                        }
                        ch <- ChatChunk{Type: "status", State: "idle"}
                        return
                }
        }

        // Path B: the unified ReAct tool loop (local tools + web tools).
        system := req.SystemPrompt
        if system != "" {
                system += "\n"
        }
        system += toolsProtocol + "\n\n" + localToolsProtocol
        if req.WebSearch {
                system += "\n\n" + webToolsProtocol
        }

        roundReq := req
        roundReq.SystemPrompt = system

        history := make([]Message, len(req.Messages))
        copy(history, req.Messages)

        var allSources []SearchResult
        var totalUsage *Usage // v0.21: accumulate across rounds for cost tracking
        nudged := false        // v0.24: the auto-proceed push fired (max once/turn)
        toolsRun := 0          // v0.24: tools executed so far this turn
        // v0.20: 16 rounds — the local tool chain can legitimately run
        // 10+ tools deep (each round is one tool use).
        for round := 0; round < 16; round++ {
                roundReq.Messages = history
                // v0.19: STREAMED rounds — thinking deltas stream live during
                // every round ("tool use streams like thinking does"), and the
                // final answer streams token-by-token instead of the old
                // completeSync + 220-char burst that popped all at once.
                // v0.20: EMPTY-ROUND GUARD — NIM (and others) intermittently
                // return a 200 stream with ZERO tokens (observed live, plus
                // outright 503s). A silent empty turn reads as "the new model
                // doesn't reply". Retry once; if it's still empty, surface a
                // real error instead of a silent no-op.
                answer, usage, err := runReActRoundWithRetry(ctx, roundReq, ch)
                if err != nil {
                        ch <- ChatChunk{Type: "error", Error: "llm_call", Message: err.Error()}
                        ch <- ChatChunk{Type: "status", State: "error", Usage: usage}
                        return
                }
                totalUsage = mergeUsage(totalUsage, usage)

                _, _, ok := parseAction(answer)
                if !ok {
                        // v0.24 AUTO-PROCEED NUDGE — the user report: models that
                        // "just say it will start and make me have to tell it go"
                        // (observed live: kimi via NVIDIA announcing its plan as
                        // prose, then ending the turn to wait for permission).
                        // When NO tool has run yet this turn, the reply is short,
                        // and it reads as intent-to-act, we push once: append the
                        // reply + a system-style "proceed" observation and run one
                        // more round instead of ending the turn.
                        if !nudged && round == 0 && toolsRun == 0 && looksLikeIntentOnly(answer) {
                                nudged = true
                                ch <- ChatChunk{Type: "progress", Text: "model announced a plan — telling it to proceed…"}
                                history = append(history, Message{Role: "assistant", Content: answer})
                                history = append(history, Message{Role: "user", Content: "(system: proceed now — do not wait for permission and do not ask. Emit your ACTION tool-call lines immediately and carry the task through to the final result.)"})
                                continue
                        }
                        // Final answer — ALREADY streamed live above.
                        if len(allSources) > 0 {
                                ch <- ChatChunk{Type: "sources", Sources: allSources}
                        }
                        ch <- ChatChunk{Type: "status", State: "idle", Usage: totalUsage}
                        return
                }
                toolsRun++

                // v0.25 MULTI-ACTION: a reply may carry SEVERAL executable
                // calls (glued "…} ACTION: hash {…" lines — the dock CSV
                // bug where the first tool ran with the second action's
                // text glued INSIDE its args). Execute every parsed action
                // in order; observations are numbered so the model can
                // attribute results.
                acts := parseActions(answer)
                var obsParts []string
                for ai, act := range acts {
                        observation := executeAction(ctx, req, ch, act.Name, act.Args, &allSources)
                        if len(acts) > 1 {
                                obsParts = append(obsParts, fmt.Sprintf("OBSERVATION (%d of %d — %s):\n%s", ai+1, len(acts), act.Name, strings.TrimPrefix(observation, "OBSERVATION:\n")))
                        } else {
                                obsParts = append(obsParts, observation)
                        }
                }
                observation := strings.Join(obsParts, "\n\n")

                // Append the assistant ACTION + user OBSERVATION to history.
                history = append(history, Message{Role: "assistant", Content: answer})
                history = append(history, Message{Role: "user", Content: observation})

                if round == 23 {
                        // Budget reached — force the final answer (old backend's rule).
                        history = append(history, Message{Role: "user", Content: "Tool budget reached. Write your FINAL answer now."})
                }
        }

        // One extra round to produce the forced final answer (streams live,
        // with the v0.20 empty-response retry).
        roundReq.Messages = history
        answer, usage, err := runReActRoundWithRetry(ctx, roundReq, ch)
        if err != nil {
                ch <- ChatChunk{Type: "error", Error: "llm_call", Message: err.Error()}
                ch <- ChatChunk{Type: "status", State: "error", Usage: usage}
                return
        }
        _ = answer // forced final — streamed, not emitted as one blob
        totalUsage = mergeUsage(totalUsage, usage)
        if len(allSources) > 0 {
                ch <- ChatChunk{Type: "sources", Sources: allSources}
        }
        ch <- ChatChunk{Type: "status", State: "idle", Usage: totalUsage}
}

// executeAction runs ONE parsed tool call and returns its observation
// (v0.25: extracted from runWebSearchTurn's body so the multi-action loop
// can call it per action). allSources accumulates web-search citations
// across calls.
func executeAction(ctx context.Context, req ChatRequest, ch chan<- ChatChunk, action, argJSON string, allSources *[]SearchResult) string {
        // v0.20 ALIASES: models invent plausible tool names (search,
        // google, fetch, browse, calc…) — map them onto the real tools
        // instead of erroring. Capability > pedantry.
        action = canonicalToolName(action)
        var observation string
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
                summary := summarizeLocalAction(action, argJSON)
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
                                obs = "(no results — try different terms)"
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
                        observation = "OBSERVATION:\nerror: unknown tool \"" + action + "\". Valid tools: " + strings.Join(LocalToolNames, ", ") + ", web_search {\"query\": \"...\"}, web_fetch {\"url\": \"...\"} (web tools when enabled)."
                }
        }
        return observation
}

// debugReact (env DOOMALAY_DEBUG_REACT=1) logs every content chunk + mode
// transition — the streaming ACTION decision is subtle enough to need it.
var debugReact = os.Getenv("DOOMALAY_DEBUG_REACT") == "1"

// runReActRoundStream runs ONE ReAct round with LIVE streaming (v0.19).
//
// Thinking deltas stream to ch immediately. Content is buffered ONLY
// until the round proves whether it is an ACTION (a tool call —
// suppressed from the chat, shown as a tool pill by the caller) or the
// final answer — then the final answer streams live too.
// Returns the round's full content (for parseAction + ReAct history),
// the round's usage, and whether any assistant_delta was emitted
// (v0.22: the retry layer must not double-render emitted rounds).
//
// v0.22 BOUNDED HOLD — the streaming decision. The v0.20 logic decided on
// the FIRST non-blank line: models that write a short preamble before
// their ACTION line ("Step 1/12:\nACTION: time_now {...}" — observed
// live on privatemodeai) leaked the preamble+ACTION into the chat as if
// it were the final answer. Now content is held while it could still be
// a preamble, and the mode flips the moment ANY complete line starts
// with ACTION:. The hold is bounded so long final answers still stream:
//
//      hold while: bytes < 700 AND complete non-blank lines < 3
//        → a complete ACTION line anywhere in the hold → mode 2 (suppressed)
//        → bound exceeded with no ACTION             → mode 1 (live stream)
//        → stream ends while held                     → decide on the tail
//
// Pathological preambles (>700 bytes) still flush as if final; the
// caller's parseAction backstop then runs the tool anyway and this
// function emits an assistant_reset chunk so the UI clears the leaked
// text before the tool pill renders (the chain NEVER breaks).
const (
        preambleHoldBytes = 700
        preambleHoldLines = 3
)

// indexActionLine returns the byte offset of the first COMPLETE line in s
// that starts with "ACTION:" (after optional blanks), or -1.
func indexActionLine(s string) int {
        start := 0
        for start <= len(s) {
                nl := strings.IndexByte(s[start:], '\n')
                if nl < 0 {
                        return -1 // last line still open — can't decide on it
                }
                line := s[start : start+nl]
                if isActionLine(line) {
                        return start
                }
                start += nl + 1
        }
        return -1
}

// startsLikeActionLine reports whether the held buffer's OPEN (final,
// newline-less) line begins with "ACTION:" — i.e. a tool call is composing
// right now and the line just hasn't ended yet. One-line ACTION JSONs (the
// 10-file zip_create pattern) stream this way for 60-80 seconds.
func startsLikeActionLine(s string) bool {
        last := s
        if i := strings.LastIndexByte(s, '\n'); i >= 0 {
                last = s[i+1:]
        }
        return isActionLine(strings.TrimLeft(last, " \t"))
}

// countCompleteNonBlankLines counts complete (newline-terminated),
// non-blank lines — the preamble-size heuristic.
func countCompleteNonBlankLines(s string) int {
        n, start := 0, 0
        for {
                nl := strings.IndexByte(s[start:], '\n')
                if nl < 0 {
                        return n
                }
                if strings.TrimSpace(s[start:start+nl]) != "" {
                        n++
                }
                start += nl + 1
        }
}

func runReActRoundStream(ctx context.Context, req ChatRequest, ch chan<- ChatChunk) (string, *Usage, bool, error) {
        var answer strings.Builder
        var buf strings.Builder // undecided content (final-answer candidate)
        mode := 0               // 0 undecided · 1 streaming final · 2 suppressed ACTION
        emitted := false        // any assistant_delta sent (v0.22: retry safety)
        var usage *Usage        // v0.21: the round's token usage (set after the stream)

        flush := func() { // decided: final answer — stream what we hold
                mode = 1
                if buf.Len() > 0 {
                        ch <- ChatChunk{Type: "assistant_delta", Text: buf.String()}
                        answer.WriteString(buf.String())
                        emitted = true
                        buf.Reset()
                }
        }

        var err error
        // v0.23 NO-SILENCE: the moment an ACTION round proves itself, this
        // helper streams live progress events ("building bundle.zip ·
        // 12.4 KB…") so the chat NEVER sits silent while the model composes
        // a tool call. A 10-file zip_create ACTION streams 60-80 SECONDS of
        // suppressed content — observed live as "the chat froze for 10
        // seconds, then everything arrived at once".
        prog := newActionProgress(ch)
        usage, err = scanSSE(ctx, req, nil, ch, func(reasoning, content string) {
                if reasoning != "" {
                        ch <- ChatChunk{Type: "thinking", Text: reasoning}
                        // v0.20 FIX: DO NOT return — a chunk can carry BOTH
                        // reasoning and content (NIM batches the thinking→
                        // answer transition into one delta). The old early
                        // return DROPPED the first content fragment: replies
                        // lost their opening words ("…otron-3-super" instead
                        // of "I am nemotron-3-super") and ACTION lines lost
                        // their "A" ("CTION: …" leaked into the chat).
                }
                if content == "" {
                        return
                }
                if debugReact {
                        log.Printf("[react] mode=%d chunk=%q", mode, content)
                }
                if mode == 2 { // an ACTION round — kept for the protocol, never shown
                        answer.WriteString(content)
                        prog.observe(answer.String())
                        return
                }
                if mode == 1 {
                        ch <- ChatChunk{Type: "assistant_delta", Text: content}
                        answer.WriteString(content)
                        emitted = true
                        return
                }
                // undecided — hold, then decide on complete lines + bounds
                buf.WriteString(content)
                s := buf.String()
                if idx := indexActionLine(s); idx >= 0 {
                        mode = 2
                        answer.WriteString(s)
                        buf.Reset()
                        prog.start(s[idx:])
                        return
                }
                if startsLikeActionLine(s) {
                        // v0.23: the open (newline-less) line starts with "ACTION:" —
                        // a tool call is COMPOSING (one-line JSONs run 60-80s on big
                        // zips). Never flush it as a final answer (the old 700-byte
                        // bound leaked the raw JSON into the chat, then assistant_reset
                        // wiped it — observed live in the v23 dogfood), and keep the
                        // progress stream alive while it grows.
                        if !prog.started {
                                prog.start(s)
                        }
                        prog.observe(s)
                        return
                }
                if len(s) >= preambleHoldBytes || countCompleteNonBlankLines(s) >= preambleHoldLines {
                        flush()
                }
        })
        if err != nil {
                return answer.String() + buf.String(), usage, emitted, err
        }
        if mode == 0 && buf.Len() > 0 {
                // stream ended while still holding — decide on the tail:
                // an ACTION tail (even partial) suppresses; else it streams.
                tail := buf.String()
                if isActionLine(strings.TrimLeft(tail, " \t")) || indexActionLine(tail+"\n") >= 0 {
                        mode = 2
                        answer.WriteString(tail)
                        buf.Reset()
                        if !prog.started {
                                prog.start(tail)
                        }
                        prog.emit(progressVerb(prog.tool, prog.name, len(tail)))
                } else {
                        ch <- ChatChunk{Type: "assistant_delta", Text: tail}
                        answer.WriteString(tail)
                        emitted = true
                        buf.Reset()
                }
        }
        prog.end()
        // v0.22 LEAK BACKSTOP: the bound flushed a very long preamble and
        // the round turned out to be a tool call anyway. parseAction (the
        // caller) will still execute it — emit assistant_reset so the UI
        // clears the leaked text instead of showing prose + "ACTION: …".
        if mode == 1 {
                if acts := parseActions(answer.String()); len(acts) > 0 && emitted {
                        ch <- ChatChunk{Type: "assistant_reset"}
                        emitted = false
                }
        }
        // v0.22b NEVER-LOSE-CONTENT: the round entered suppression (mode 2)
        // but its content does not parse as an ACTION call — the old flow
        // returned it silently: nothing streamed, the caller treated it as
        // a final answer, the turn ended idle with NO reply. Flush it now —
        // the user sees the raw text and the model corrects next turn.
        if mode == 2 {
                if acts := parseActions(answer.String()); len(acts) == 0 {
                        ch <- ChatChunk{Type: "assistant_delta", Text: answer.String()}
                        emitted = true
                }
        }
        return answer.String(), usage, emitted, nil
}

func isActionLine(line string) bool {
        return isValidActionLine(line)
}

// ── v0.23 ACTION-composition progress ─────────────────────────────────────
//
// The no-silence guarantee for tool rounds. The user report: "the chat
// froze for 10 seconds while creating the zip, then streamed all at once".
// Root cause: a big ACTION (a 10-file zip_create JSON) streams 60-80s of
// SUPPRESSED content — the ReAct loop correctly hides the tool call, but
// that also hides every sign of life. This helper turns the suppressed
// stream into live, throttled progress events the UI renders as an
// animated "building file …" indicator:
//
//      start(actionLine)  the moment suppression begins → "calling zip_create…"
//      observe(full)      every chunk → discovers the filename, updates size
//      end()              final flush
//
// Events are Type:"progress" — never persisted, WS-only (see forwardEvents).

type actionProgress struct {
        ch      chan<- ChatChunk
        tool    string    // canonical tool name ("" until known)
        name    string    // target file name discovered in the partial JSON
        lastAt  time.Time // last emitted update (throttle)
        started bool
}

var progressNameRe = regexp.MustCompile(`"name"\s*:\s*"([^"\n]{1,80})"`)

func newActionProgress(ch chan<- ChatChunk) *actionProgress {
        return &actionProgress{ch: ch}
}

// progressVerb maps a tool to its human phase line.
func progressVerb(tool, name string, bytes int) string {
        switch tool {
        case "web_search":
                return "searching the web…"
        case "web_fetch":
                if name != "" {
                        return "reading " + name + "…"
                }
                return "fetching page…"
        case "delegate":
                return "consulting other models…"
        case "docx_create", "xlsx_create", "zip_create", "archive_create":
                if name != "" {
                        if bytes > 0 {
                                return fmt.Sprintf("building %s · %s so far", name, humanBytes(int64(bytes)))
                        }
                        return "building " + name + "…"
                }
                if bytes > 0 {
                        return fmt.Sprintf("building file · %s so far", humanBytes(int64(bytes)))
                }
                return "building file…"
        case "zip_extract", "archive_extract":
                if name != "" {
                        return "unpacking " + name + "…"
                }
                return "unpacking archive…"
        }
        if bytes > 0 {
                return fmt.Sprintf("running %s · %s", tool, humanBytes(int64(bytes)))
        }
        if tool != "" {
                return "running " + tool + "…"
        }
        return "working…"
}

func (p *actionProgress) emit(text string) {
        // blocking is fine (the server's chunk loop always drains), and
        // progress must never silently drop — it IS the no-silence guarantee.
        p.ch <- ChatChunk{Type: "progress", Text: text}
        p.lastAt = time.Now()
}

// start fires when an ACTION line is detected in the hold buffer.
func (p *actionProgress) start(actionLine string) {
        if m := actionNameRe.FindStringSubmatch(strings.TrimSpace(firstLine(actionLine))); m != nil {
                p.tool = canonicalToolName(strings.ToLower(m[1]))
        }
        p.started = true
        p.emit(progressVerb(p.tool, "", 0))
}

// observe is called with the round's full suppressed content so far.
func (p *actionProgress) observe(full string) {
        if !p.started {
                return
        }
        // the ACTION line may still be OPEN (partial name streamed one token at
        // a time) — re-extract until the line completes, so "base" becomes
        // "base64" instead of sticking. The composing line is always the LAST
        // one; it is complete once the content ends with a newline.
        if last := strings.TrimLeft(lastLine(full), " \t"); !strings.HasSuffix(full, "\n") && len(last) < 4096 {
                if m := actionNameRe.FindStringSubmatch(last); m != nil {
                        if got := canonicalToolName(strings.ToLower(m[1])); got != p.tool {
                                p.tool = got
                        }
                }
        }
        if p.name == "" {
                if m := progressNameRe.FindStringSubmatch(full); m != nil {
                        p.name = m[1]
                        p.emit(progressVerb(p.tool, p.name, len(full)))
                        return
                }
        }
        if time.Since(p.lastAt) >= 1200*time.Millisecond {
                p.emit(progressVerb(p.tool, p.name, len(full)))
        }
}

// end lands one final state right before the round resolves (so the last
// size update isn't starved by the throttle).
func (p *actionProgress) end() {
        if p.started {
                p.emit(progressVerb(p.tool, p.name, 0))
        }
}

func firstLine(s string) string {
        if i := strings.IndexByte(s, '\n'); i >= 0 {
                return s[:i]
        }
        return s
}

func lastLine(s string) string {
        if i := strings.LastIndexByte(s, '\n'); i >= 0 {
                return s[i+1:]
        }
        return s
}

// isValidActionLine reports whether the line is an ACTION call with a
// REAL tool name (v0.22: a malformed "ACTION:" line — missing/garbled
// tool name — must NOT enter suppression mode 2, or the round's content
// vanishes: nothing streams, parseAction rejects it, the turn ends
// idle with no reply at all. Observed live: a 16-tool chain completed
// and the final summary round was swallowed whole by exactly this).
var actionNameRe = regexp.MustCompile(`^ACTION:\s*([a-zA-Z0-9_-]+)`)

func isValidActionLine(line string) bool {
        return actionNameRe.MatchString(strings.TrimSpace(line))
}

// runReActRoundWithRetry (v0.20): one ReAct round with an empty-response
// retry. Providers (NVIDIA NIM observed live; others too) intermittently
// return a 200 SSE stream that carries ZERO reasoning/content tokens, or
// fail with a 5xx. The first is invisible to the user (a turn that just
// ends with nothing — "the new model doesn't reply"); the retry catches
// the transient flavor, and a persistently-empty model gets a visible
// error instead of silence.
func runReActRoundWithRetry(ctx context.Context, req ChatRequest, ch chan<- ChatChunk) (string, *Usage, error) {
        answer, usage, emitted, err := runReActRoundStream(ctx, req, ch)
        if err != nil {
                // v0.22: TRANSIENT NETWORK RETRY — long tool chains (12+
                // ACTION/OBSERVATION rounds) died mid-chain on connection
                // blips ("reading stream chunk: network error", EOF,
                // resets — observed live). Rounds that emitted nothing
                // (every ACTION round is fully suppressed; undecided holds
                // emit nothing) can be retried without double-rendering.
                for attempt := 1; attempt <= 2 && isTransientNetErr(err) && !emitted; attempt++ {
                        ch <- ChatChunk{Type: "status", State: "running", Message: fmt.Sprintf("network hiccup — retry %d/2", attempt)}
                        select {
                        case <-time.After(time.Duration(attempt) * 1500 * time.Millisecond):
                        case <-ctx.Done():
                                return answer, usage, ctx.Err()
                        }
                        answer, usage, emitted, err = runReActRoundStream(ctx, req, ch)
                }
                if err != nil {
                        return answer, usage, err
                }
        }
        if strings.TrimSpace(answer) != "" {
                return answer, usage, nil
        }
        // empty round → one visible retry, then a diagnosable error.
        ch <- ChatChunk{Type: "status", State: "running", Message: "empty response — retrying"}
        answer, usage, emitted, err = runReActRoundStream(ctx, req, ch)
        if err != nil {
                return answer, usage, err
        }
        if strings.TrimSpace(answer) == "" {
                ch <- ChatChunk{Type: "error", Error: "empty_response", Message: "the model returned an empty response twice — try again or pick a different model"}
                return answer, usage, errEmptyRound
        }
        return answer, usage, nil
}

// isTransientNetErr reports whether the error looks like a recoverable
// network/provider blip (worth a silent retry) rather than an auth or
// protocol failure (retrying is pointless).
func isTransientNetErr(err error) bool {
        if err == nil {
                return false
        }
        s := err.Error()
        return regexp.MustCompile(`(?i)timeout|context deadline|connection reset|broken pipe|unexpected EOF|refused|temporary|HTTP 5[0-9][0-9]|503|502|network|went silent|no data`).MatchString(s)
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

// errEmptyRound signals a persistently-empty model response (surfaces as
// a turn error after the retry in runReActRoundWithRetry).
var errEmptyRound = fmt.Errorf("empty model response")

// parseAction detects a ReAct ACTION line (action + JSON arg).
// v0.20: the argument may be a BARE string (models often skip the JSON —
// `ACTION: search best cat food`) — it gets wrapped into the right JSON
// shape by tool kind.
// v0.25: delegates to parseActions and returns the LAST executable call.
var actionRe = regexp.MustCompile(`(?m)^ACTION:\s*([a-z0-9_]+)\s*(\{[\s\S]*\}|[^\n]*)\s*$`)

func parseAction(answer string) (action, argJSON string, ok bool) {
        acts := parseActions(answer)
        if len(acts) == 0 {
                return "", "", false
        }
        last := acts[len(acts)-1]
        return last.Name, last.Args, true
}

// parsedAction is one executable tool call extracted from a model reply.
type parsedAction struct {
        Name string
        Args string
}

// parseActions extracts EVERY executable ACTION from a reply (v0.25).
//
// Handles, in order:
//   - prose preambles before the ACTION line (protocol-legal)
//   - several ACTION LINES (the last line is operative)
//   - pretty-printed JSON spanning following lines (brace-extension)
//   - GLUED actions on one line — `base64 {...} ACTION: hash {"algo":...}`
//     (observed live in the dock CSV: the first tool ran with the second
//     action's text glued INSIDE its arguments). Depth-0 ACTION: markers
//     outside strings split the region; every piece runs in order.
//   - truncated JSON (repairJSON) and raw newlines inside strings
func parseActions(answer string) []parsedAction {
        // Trim leading fences/spaces the model may add.
        trimmed := strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(answer), "```"))
        lines := strings.Split(trimmed, "\n")
        hit := -1
        for i := len(lines) - 1; i >= 0; i-- {
                if isActionLine(lines[i]) {
                        hit = i
                        break
                }
        }
        if hit < 0 {
                return nil
        }
        head := strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(lines[hit]), "ACTION:"))
        var name, rest string
        // tool name = leading token; the JSON args may be separated by a
        // space, glued directly to the name ("time_now{"tz":...}" — no
        // space, observed live), or continue on following lines.
        if m := regexp.MustCompile(`^([a-zA-Z0-9_-]+)([\s\S]*)$`).FindStringSubmatch(head); m != nil {
                name, rest = m[1], strings.TrimSpace(m[2])
        } else {
                name, rest = head, ""
        }
        if name == "" || !regexp.MustCompile(`^[a-zA-Z0-9_-]+$`).MatchString(name) {
                return nil
        }
        if rest == "" {
                rest = "{}"
        }
        // pretty-printed JSON: the args line opens a brace but doesn't
        // close it on the same line — extend through following lines
        // until braces balance (or run out).
        if strings.HasPrefix(rest, "{") && !balancedJSON(rest) {
                for j := hit + 1; j < len(lines) && j <= hit+40; j++ {
                        rest += "\n" + lines[j]
                        if balancedJSON(rest) {
                                break
                        }
                }
        }
        // v0.25 GLUED-ACTION SPLIT: depth-0 "ACTION:" markers OUTSIDE strings
        // divide the region into separate calls. A marker inside a JSON string
        // value (text: "use ACTION: syntax") is inStr → never split.
        segments := splitGluedActions(name + " " + rest)
        var out []parsedAction
        for _, seg := range segments {
                seg = strings.TrimSpace(seg)
                // segment = "<tool name> <args…>" (the args may be glued on)
                m := regexp.MustCompile(`^([a-zA-Z0-9_-]+)([\s\S]*)$`).FindStringSubmatch(seg)
                if m == nil {
                        continue
                }
                n := strings.ToLower(m[1])
                r := strings.TrimSpace(m[2])
                if r == "" {
                        r = "{}"
                }
                if !strings.HasPrefix(r, "{") {
                        // bare argument — wrap it into the JSON shape the tool wants
                        esc, err := json.Marshal(r)
                        if err != nil {
                                esc = []byte(`""`)
                        }
                        switch canonicalToolName(n) {
                        case "web_search":
                                r = `{"query":` + string(esc) + `}`
                        case "web_fetch":
                                r = `{"url":` + string(esc) + `}`
                        case "calculator":
                                r = `{"expr":` + string(esc) + `}`
                        case "time_now":
                                r = `{"tz":` + string(esc) + `}`
                        case "regex_extract":
                                r = `{"pattern":` + string(esc) + `}`
                        case "archive_create":
                                r = `{"name":` + string(esc) + `}`
                        case "archive_extract":
                                r = `{"artifact":` + string(esc) + `}`
                        default:
                                r = `{"text":` + string(esc) + `}`
                        }
                } else if !json.Valid([]byte(r)) {
                        // v0.20: truncated JSON — models sometimes cut the closing
                        // brace/quote (observed live). Repair instead of losing the
                        // tool call to a parse error.
                        if fixed := repairJSON(r); json.Valid([]byte(fixed)) {
                                r = fixed
                        }
                }
                out = append(out, parsedAction{Name: n, Args: r})
        }
        return out
}

// splitGluedActions splits "name1 {json} ACTION: name2 {json} …" at every
// depth-0 ACTION: marker that sits OUTSIDE a JSON string. Returns the
// segments INCLUDING their leading tool names.
func splitGluedActions(region string) []string {
        var out []string
        inStr, esc, depth := false, false, 0
        start := 0 // segment start
        for i := 0; i < len(region); i++ {
                c := region[i]
                switch {
                case inStr && esc:
                        esc = false
                case inStr && c == '\\':
                        esc = true
                case inStr && c == '"':
                        inStr = false
                case c == '"':
                        inStr = true
                case c == '{':
                        depth++
                case c == '}':
                        depth--
                }
                // A marker candidate: "ACTION:" at depth 0 outside strings, at a
                // word boundary. Byte-level compare is safe (ASCII prefix).
                if !inStr && depth <= 0 && hasActionMarkerAt(region, i) {
                        if seg := strings.TrimSpace(region[start:i]); seg != "" {
                                out = append(out, seg)
                        }
                        i += len("ACTION:") - 1
                        start = i + 1
                }
        }
        if seg := strings.TrimSpace(region[start:]); seg != "" {
                out = append(out, seg)
        }
        if len(out) == 0 {
                out = append(out, region)
        }
        return out
}

// hasActionMarkerAt reports whether region[i:] starts with "ACTION:"
// (case-insensitive) at a position that is the START of the marker word.
func hasActionMarkerAt(region string, i int) bool {
        const marker = "ACTION:"
        if i+len(marker) > len(region) {
                return false
        }
        if !strings.EqualFold(region[i:i+len(marker)], marker) {
                return false
        }
        // must be a word START: preceded by whitespace/{/}/start — so a tool
        // named "raction:" or JSON keys like "xaction:" don't trigger.
        if i > 0 {
                prev := region[i-1]
                if prev != ' ' && prev != '\t' && prev != '\n' && prev != '\r' && prev != '{' && prev != '}' {
                        return false
                }
        }
        return true
}

// balancedJSON checks brace/quote balance of a candidate JSON prefix.
func balancedJSON(s string) bool {
        inStr, esc, depth := false, false, 0
        for _, r := range s {
                switch {
                case inStr && esc:
                        esc = false
                case inStr && r == '\\':
                        esc = true
                case inStr && r == '"':
                        inStr = false
                case r == '"':
                        inStr = true
                case r == '{':
                        depth++
                case r == '}':
                        depth--
                }
        }
        return depth == 0 && !inStr
}

// repairJSON fixes truncated / malformed tool-call JSON:
//   - closes an unterminated string (v0.20)
//   - v0.25: escapes RAW control characters inside string values — models
//     paste multi-line file content into zip_create/docx_create args with
//     literal newlines, which is invalid JSON. After the old brace-repair
//     the JSON still failed to parse and the tool saw EMPTY args
//     ("files is required" — dock CSV event 37). Escaping makes the
//     content survive verbatim.
//   - v0.25: closes BOTH braces and brackets, innermost-first (a truncated
//     "files": [{…} needs "]" AND "}" — the old brace-only repair left the
//     array open and the JSON stayed invalid).
func repairJSON(s string) string {
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
        return out
}

// canonicalToolName maps the plausible names models invent onto the real
// tools (v0.20) — observed live: gpt-oss called `ACTION: search {…}` instead
// of web_search. Aliases keep the chain alive instead of erroring.
func canonicalToolName(name string) string {
        switch name {
        case "search", "websearch", "google", "bing", "duckduckgo", "find":
                return "web_search"
        case "fetch", "open_url", "browse", "get", "visit", "read_url", "url":
                return "web_fetch"
        case "calc", "math", "compute", "evaluate":
                return "calculator"
        case "time", "now", "clock", "date":
                return "time_now"
        case "guid", "uuid4", "uuidgen":
                return "uuid"
        case "rand", "random_number", "dice":
                return "random"
        case "b64", "base_64":
                return "base64"
        case "md5", "sha", "sha1_hash", "digest":
                return "hash"
        case "json", "json_format", "validate_json", "jsonlint":
                return "json_tool"
        case "word_count", "count", "stats", "wc":
                return "text_stats"
        case "urldecode", "percent_encode", "urlencode":
                return "url_encode"
        case "regex", "grep", "findall", "match":
                return "regex_extract"
        case "pack", "compress", "make_archive", "create_archive", "7z", "7zip", "make_7z", "tar", "make_tar", "tarball", "gzip", "make_zip", "zip", "archive", "bundle":
                return "archive_create"
        case "unpack", "decompress", "unarchive", "untar", "unrar", "ungzip", "gunzip", "unzip", "extract_archive", "open_archive", "list_archive", "7z_extract", "tar_extract":
                return "archive_extract"
        }
        return name
}

// summarizeLocalAction builds a short pill summary for a local tool call
// (shown in the chat as the tool pill's title line).
func summarizeLocalAction(name, argJSON string) string {
        var args map[string]any
        _ = json.Unmarshal([]byte(argJSON), &args)
        get := func(k string) string {
                if v, ok := args[k].(string); ok {
                        return clampRunes(v, 80)
                }
                return ""
        }
        switch name {
        case "calculator":
                return get("expr")
        case "time_now":
                return get("tz")
        case "hash":
                return get("algo")
        case "base64", "json_tool", "url_encode":
                m := get("mode")
                if m != "" {
                        return m
                }
                return ""
        case "regex_extract":
                return get("pattern")
        case "docx_create", "xlsx_create", "zip_create", "zip_extract":
                return get("name")
        }
        return ""
}

// splitAnswer splits a final answer into stream-sized segments (the frontend
// renders deltas identically to streamed tokens).
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

        // 1. Initial search.
        emitStatus("initial_search", question)
        results, err := WebSearch(ctx, question, 8, req.TavilyKey)
        if err != nil {
                ch <- ChatChunk{Type: "error", Error: "web_search", Message: err.Error()}
                ch <- ChatChunk{Type: "status", State: "error"}
                return
        }
        ch <- ChatChunk{Type: "sources", Sources: results}
        allSources := results

        // 2. Read the top pages (parallel).
        emitStatus("reading", fmt.Sprintf("reading %d pages", min(5, len(results))))
        pages := readTopPages(ctx, results, 5)

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
