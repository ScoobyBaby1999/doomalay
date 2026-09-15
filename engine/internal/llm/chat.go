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
type idleTimeoutReader struct {
	rc       io.ReadCloser
	timeout  time.Duration
	timer    *time.Timer
	stopped  chan struct{}
	timedOut atomic.Bool
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
		r.timer.Reset(r.timeout)
	}
	return n, err
}

func (r *idleTimeoutReader) Close() error {
	close(r.stopped)
	r.timer.Stop()
	return r.rc.Close()
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
	// v0.19: no-data watchdog — 90s of total silence from the provider
	// ends the stream (see idleTimeoutReader). The 10-min turn timeout
	// stays as the hard backstop; this makes a HANG end in a minute and
	// a half with a diagnosable error instead.
	wd := newIdleTimeoutReader(resp.Body, 90*time.Second)
	defer resp.Body.Close()
	defer wd.Close()

	if resp.StatusCode != 200 {
		bts, _ := io.ReadAll(wd)
		ch <- ChatChunk{Type: "error", Error: "http", Message: fmt.Sprintf("%d: %s", resp.StatusCode, string(bts))}
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
			ch <- ChatChunk{Type: "error", Error: "timeout", Message: "the model went silent (no data for 90s) — try it again or pick another model"}
			return usage, nil
		}
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

// toolsProtocol (v0.20 unified): the local tool set is ALWAYS part of the
// protocol; the web tools are appended only for web-search turns.
var toolsProtocol = `
You have access to tools. To use one, output EXACTLY ONE line as your ENTIRE reply, then stop:
ACTION: <tool> {<json arguments>}
After each ACTION you will receive:
OBSERVATION:
<tool output>
Use observations to answer. One tool per reply; chain tools across replies when a task needs several steps. When you have enough information, write your FINAL answer as a normal reply (no ACTION line). Never fabricate tool results.`

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
		answer, err := runReActRoundWithRetry(ctx, roundReq, ch)
		if err != nil {
			ch <- ChatChunk{Type: "error", Error: "llm_call", Message: err.Error()}
			ch <- ChatChunk{Type: "status", State: "error"}
			return
		}

		action, argJSON, ok := parseAction(answer)
		if !ok {
			// Final answer — ALREADY streamed live above.
			if len(allSources) > 0 {
				ch <- ChatChunk{Type: "sources", Sources: allSources}
			}
			ch <- ChatChunk{Type: "status", State: "idle"}
			return
		}

		// Execute the tool.
		// v0.20 ALIASES: models invent plausible tool names (search,
		// google, fetch, browse, calc…) — map them onto the real
		// tools instead of erroring. Capability > pedantry.
		action = canonicalToolName(action)
		var observation string
		if IsLocalTool(action) {
			// v0.20: local tools — pure Go, zero latency, zero setup.
			summary := summarizeLocalAction(action, argJSON)
			ch <- ChatChunk{Type: "tool_use", Name: action, Summary: summary}
			observation = RunLocalTool(action, argJSON)
			obs := strings.TrimPrefix(observation, "OBSERVATION:\n")
			ch <- ChatChunk{Type: "tool_result", Text: clamp(obs, 600), Name: action}
		} else {
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
				observation = "OBSERVATION:\nerror: unknown tool \"" + action + "\". Valid tools: " + strings.Join(LocalToolNames, ", ") + ", web_search {\"query\": \"...\"}, web_fetch {\"url\": \"...\"} (web tools when enabled)."
			}
		}

		// Append the assistant ACTION + user OBSERVATION to history.
		history = append(history, Message{Role: "assistant", Content: answer})
		history = append(history, Message{Role: "user", Content: observation})

		if round == 15 {
			// Budget reached — force the final answer (old backend's rule).
			history = append(history, Message{Role: "user", Content: "Tool budget reached. Write your FINAL answer now."})
		}
	}

	// One extra round to produce the forced final answer (streams live,
	// with the v0.20 empty-response retry).
	roundReq.Messages = history
	answer, err := runReActRoundWithRetry(ctx, roundReq, ch)
	if err != nil {
		ch <- ChatChunk{Type: "error", Error: "llm_call", Message: err.Error()}
		ch <- ChatChunk{Type: "status", State: "error"}
		return
	}
	_ = answer // forced final — streamed, not emitted as one blob
	if len(allSources) > 0 {
		ch <- ChatChunk{Type: "sources", Sources: allSources}
	}
	ch <- ChatChunk{Type: "status", State: "idle"}
}

// runReActRoundStream runs ONE ReAct round with LIVE streaming (v0.19).
//
// Thinking deltas stream to ch immediately. Content is buffered ONLY
// until the first line proves whether this round is an ACTION (a tool
// call — suppressed from the chat, shown as a tool pill by the caller)
// or the final answer — then the final answer streams live too.
// Returns the round's full content (for parseAction + ReAct history).
//
// debugReact (env DOOMALAY_DEBUG_REACT=1) logs every content chunk + mode
// transition — the streaming ACTION decision is subtle enough to need it.
var debugReact = os.Getenv("DOOMALAY_DEBUG_REACT") == "1"

func runReActRoundStream(ctx context.Context, req ChatRequest, ch chan<- ChatChunk) (string, error) {
	var answer strings.Builder
	var buf strings.Builder // undecided content (final-answer candidate)
	mode := 0               // 0 undecided · 1 streaming final · 2 suppressed ACTION

	flush := func() { // decided: final answer — stream what we hold
		mode = 1
		if buf.Len() > 0 {
			ch <- ChatChunk{Type: "assistant_delta", Text: buf.String()}
			answer.WriteString(buf.String())
			buf.Reset()
		}
	}

	_, err := scanSSE(ctx, req, nil, ch, func(reasoning, content string) {
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
		if mode == 2 { // an ACTION line — kept for the protocol, never shown
			answer.WriteString(content)
			return
		}
		if mode == 1 {
			ch <- ChatChunk{Type: "assistant_delta", Text: content}
			answer.WriteString(content)
			return
		}
		buf.WriteString(content)
		s := buf.String()
		if i := strings.IndexAny(s, "\r\n"); i >= 0 {
			// v0.20 FIX (the "CTION:" leak): models sometimes
			// prefix the ACTION line with a BLANK line. The old
			// logic treated the blank first line as proof of a
			// final answer, flushed it, and then streamed the
			// ACTION text into the chat. Skip leading blank lines
			// and decide on the first NON-BLANK line instead.
			rest := s
			decided := false
			for {
				k := strings.IndexAny(rest, "\r\n")
				if k < 0 {
					break // no more complete lines
				}
				line := rest[:k]
				if strings.TrimSpace(line) == "" {
					rest = rest[k+1:] // blank — keep looking
					continue
				}
				if isActionLine(line) {
					mode = 2
					answer.WriteString(s)
					buf.Reset()
				} else {
					flush()
				}
				decided = true
				break
			}
			if !decided {
				// only blank lines so far — hold the buffer
				// (the ACTION may still start on a later line)
				buf.Reset()
				buf.WriteString(rest)
			}
			return
		}
		// line still open: decide early once it provably can't be
		// an ACTION (the protocol's ACTION prefix is "ACTION:").
		trimmed := strings.TrimLeft(s, " \t")
		if len(trimmed) >= 8 && !strings.HasPrefix(trimmed, "ACTION") {
			flush()
		}
	})
	if err != nil {
		return answer.String() + buf.String(), err
	}
	if mode == 0 && buf.Len() > 0 {
		// stream ended mid-first-line — decide on what we have
		if isActionLine(strings.TrimLeft(buf.String(), " \t")) {
			answer.WriteString(buf.String())
		} else {
			ch <- ChatChunk{Type: "assistant_delta", Text: buf.String()}
			answer.WriteString(buf.String())
		}
	}
	return answer.String(), nil
}

func isActionLine(line string) bool {
	return strings.HasPrefix(strings.TrimSpace(line), "ACTION:")
}

// runReActRoundWithRetry (v0.20): one ReAct round with an empty-response
// retry. Providers (NVIDIA NIM observed live; others too) intermittently
// return a 200 SSE stream that carries ZERO reasoning/content tokens, or
// fail with a 5xx. The first is invisible to the user (a turn that just
// ends with nothing — "the new model doesn't reply"); the retry catches
// the transient flavor, and a persistently-empty model gets a visible
// error instead of silence.
func runReActRoundWithRetry(ctx context.Context, req ChatRequest, ch chan<- ChatChunk) (string, error) {
	answer, err := runReActRoundStream(ctx, req, ch)
	if err != nil {
		return answer, err
	}
	if strings.TrimSpace(answer) != "" {
		return answer, nil
	}
	// empty round → one visible retry, then a diagnosable error.
	ch <- ChatChunk{Type: "status", State: "running", Message: "empty response — retrying"}
	answer, err = runReActRoundStream(ctx, req, ch)
	if err != nil {
		return answer, err
	}
	if strings.TrimSpace(answer) == "" {
		ch <- ChatChunk{Type: "error", Error: "empty_response", Message: "the model returned an empty response twice — try again or pick a different model"}
		return answer, errEmptyRound
	}
	return answer, nil
}

// errEmptyRound signals a persistently-empty model response (surfaces as
// a turn error after the retry in runReActRoundWithRetry).
var errEmptyRound = fmt.Errorf("empty model response")

// parseAction detects a ReAct ACTION line (action + JSON arg).
// v0.20: the argument may be a BARE string (models often skip the JSON —
// `ACTION: search best cat food`) — it gets wrapped into the right JSON
// shape by tool kind.
var actionRe = regexp.MustCompile(`(?m)^ACTION:\s*([a-z0-9_]+)\s*(\{[\s\S]*\}|[^\n]*)\s*$`)

func parseAction(answer string) (action, argJSON string, ok bool) {
	// Trim leading fences/spaces the model may add.
	trimmed := strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(answer), "```"))
	m := actionRe.FindStringSubmatch(trimmed)
	if m == nil {
		return "", "", false
	}
	action = strings.ToLower(m[1])
	rest := strings.TrimSpace(m[2])
	if rest == "" {
		rest = "{}"
	}
	if !strings.HasPrefix(rest, "{") {
		// bare argument — wrap it into the JSON shape the tool wants
		esc, err := json.Marshal(rest)
		if err != nil {
			esc = []byte(`""`)
		}
		switch canonicalToolName(action) {
		case "web_search":
			rest = `{"query":` + string(esc) + `}`
		case "web_fetch":
			rest = `{"url":` + string(esc) + `}`
		case "calculator":
			rest = `{"expr":` + string(esc) + `}`
		case "time_now":
			rest = `{"tz":` + string(esc) + `}`
		case "regex_extract":
			rest = `{"pattern":` + string(esc) + `}`
		default:
			rest = `{"text":` + string(esc) + `}`
		}
	} else if !json.Valid([]byte(rest)) {
		// v0.20: truncated JSON — models sometimes cut the closing
		// brace/quote (observed live). Repair instead of losing the
		// tool call to a parse error.
		if fixed := repairJSON(rest); json.Valid([]byte(fixed)) {
			rest = fixed
		}
	}
	return action, rest, true
}

// repairJSON appends the missing closing quotes/braces of a truncated JSON
// object (tracks string state + brace depth over the raw text).
func repairJSON(s string) string {
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
	out := s
	if inStr {
		out += `"`
	}
	for depth > 0 {
		out += "}"
		depth--
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
