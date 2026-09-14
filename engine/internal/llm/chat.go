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
        "net/http"
        "regexp"
        "strings"
        "sync"
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
        Type    string         `json:"type"`
        Text    string         `json:"text,omitempty"`
        State   string         `json:"state,omitempty"`
        Usage   *Usage         `json:"usage,omitempty"`
        Error   string         `json:"error,omitempty"`
        Message string         `json:"message,omitempty"`
        Name    string         `json:"name,omitempty"`    // tool name (tool_use)
        Summary string         `json:"summary,omitempty"` // tool arg summary (tool_use)
        Sources []SearchResult `json:"sources,omitempty"` // web sources (sources event)
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
                        runPlainTurn(ctx, ch, errs, req)
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
        httpReq.Header.Set("Accept", "text/event-stream")
        httpReq.Header.Set("HTTP-Referer", "https://doomalay.app")
        httpReq.Header.Set("X-Title", "Doomalay")

        // v0.16: the STREAM client — no wall-clock cap (reasoning models think
        // long before the first token; the turn ctx is the deadline).
        resp, err := providerStreamHTTP.Do(httpReq)
        if err != nil {
                ch <- ChatChunk{Type: "error", Error: "llm_call", Message: err.Error()}
                return nil, nil // error already emitted; keep the turn terminal state clean
        }
        defer resp.Body.Close()

        if resp.StatusCode != 200 {
                bts, _ := io.ReadAll(resp.Body)
                ch <- ChatChunk{Type: "error", Error: "http", Message: fmt.Sprintf("%d: %s", resp.StatusCode, string(bts))}
                return nil, nil
        }

        scanner := bufio.NewScanner(resp.Body)
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
                        if choice.Delta.Reasoning != "" {
                                ch <- ChatChunk{Type: "thinking", Text: choice.Delta.Reasoning}
                        }
                        if choice.Delta.Content != "" {
                                ch <- ChatChunk{Type: "assistant_delta", Text: choice.Delta.Content}
                        }
                }
                if chunk.Usage != nil {
                        usage.InputTokens = chunk.Usage.PromptTokens
                        usage.OutputTokens = chunk.Usage.CompletionTokens
                }
        }
        if err := scanner.Err(); err != nil {
                ch <- ChatChunk{Type: "error", Error: "stream", Message: err.Error()}
                return usage, nil
        }
        usage.TotalTokens = usage.InputTokens + usage.OutputTokens
        return usage, nil
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

var toolsProtocol = `
You have access to web tools. To use one, output EXACTLY ONE line as your ENTIRE reply, then stop:
ACTION: web_search {"query": "<search terms>"}
or
ACTION: web_fetch {"url": "<https url>"}
After each ACTION you will receive:
OBSERVATION:
<tool output>
Use observations to answer. When you have enough information, write your FINAL answer as a normal reply (no ACTION line) with sources cited inline as [1], [2] matching the search result numbering. Never fabricate URLs.`

func runWebSearchTurn(ctx context.Context, ch chan<- ChatChunk, errs chan<- error, req ChatRequest) {
        ch <- ChatChunk{Type: "status", State: "running"}

        // Path A: native provider-side search.
        if native := NativeWebSearchBody(req.Provider, req.Model); native != nil {
                _, err := streamCompletion(ctx, req, ch, native)
                if err != nil {
                        errs <- err
                        return
                }
                ch <- ChatChunk{Type: "status", State: "idle"}
                return
        }

        // Path B: injected ReAct tool loop.
        system := req.SystemPrompt
        if system != "" {
                system += "\n"
        }
        system += toolsProtocol

        roundReq := req
        roundReq.SystemPrompt = system

        history := make([]Message, len(req.Messages))
        copy(history, req.Messages)

        var allSources []SearchResult
        for round := 0; round < 8; round++ {
                roundReq.Messages = history
                answer, err := completeSync(ctx, roundReq, nil)
                if err != nil {
                        ch <- ChatChunk{Type: "error", Error: "llm_call", Message: err.Error()}
                        ch <- ChatChunk{Type: "status", State: "error"}
                        return
                }

                action, argJSON, ok := parseAction(answer)
                if !ok {
                        // Final answer — stream it out (split into chunks so the
                        // frontend renders it like any assistant reply).
                        for _, seg := range splitAnswer(answer) {
                                ch <- ChatChunk{Type: "assistant_delta", Text: seg}
                        }
                        if len(allSources) > 0 {
                                ch <- ChatChunk{Type: "sources", Sources: allSources}
                        }
                        ch <- ChatChunk{Type: "status", State: "idle"}
                        return
                }

                // Execute the tool.
                var observation string
                switch action {
                case "web_search":
                        var args struct {
                                Query string `json:"query"`
                        }
                        _ = json.Unmarshal([]byte(argJSON), &args)
                        if args.Query == "" {
                                observation = "OBSERVATION:\nerror: empty query"
                                break
                        }
                        ch <- ChatChunk{Type: "tool_use", Name: "web_search", Summary: args.Query}
                        results, err := WebSearch(ctx, args.Query, 5, req.TavilyKey)
                        if err != nil {
                                observation = "OBSERVATION:\nsearch error: " + err.Error()
                                break
                        }
                        allSources = append(allSources, results...)
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
                                break
                        }
                        ch <- ChatChunk{Type: "tool_use", Name: "web_fetch", Summary: args.URL}
                        text, err := WebFetch(ctx, args.URL, 12000)
                        if err != nil {
                                observation = "OBSERVATION:\nfetch error: " + err.Error()
                                break
                        }
                        observation = "OBSERVATION:\n" + text
                        ch <- ChatChunk{Type: "tool_result", Text: clamp(text, 600), Name: "web_fetch"}
                default:
                        observation = "OBSERVATION:\nunknown tool " + action + " — use web_search or web_fetch"
                }

                // Append the assistant ACTION + user OBSERVATION to history.
                history = append(history, Message{Role: "assistant", Content: answer})
                history = append(history, Message{Role: "user", Content: observation})

                if round == 7 {
                        // Budget reached — force the final answer (old backend's rule).
                        history = append(history, Message{Role: "user", Content: "Tool budget reached. Write your FINAL answer now."})
                }
        }

        // One extra round to produce the forced final answer.
        roundReq.Messages = history
        answer, err := completeSync(ctx, roundReq, nil)
        if err != nil {
                ch <- ChatChunk{Type: "error", Error: "llm_call", Message: err.Error()}
                ch <- ChatChunk{Type: "status", State: "error"}
                return
        }
        for _, seg := range splitAnswer(answer) {
                ch <- ChatChunk{Type: "assistant_delta", Text: seg}
        }
        if len(allSources) > 0 {
                ch <- ChatChunk{Type: "sources", Sources: allSources}
        }
        ch <- ChatChunk{Type: "status", State: "idle"}
}

// parseAction detects a ReAct ACTION line (action + JSON arg).
var actionRe = regexp.MustCompile(`(?m)^ACTION:\s*(web_search|web_fetch)\s*(\{.*\})?\s*$`)

func parseAction(answer string) (action, argJSON string, ok bool) {
        // Trim leading fences/spaces the model may add.
        trimmed := strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(answer), "```"))
        m := actionRe.FindStringSubmatch(trimmed)
        if m == nil {
                return "", "", false
        }
        if m[2] == "" {
                m[2] = "{}"
        }
        return m[1], m[2], true
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
