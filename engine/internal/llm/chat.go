// Package llm is the direct cloud LLM proxy. When the Python brain is
// unavailable (e.g. the Android APK, which can't bundle Python), the Go
// engine talks to OpenAI-compatible providers directly.
//
// All providers (OpenRouter, NVIDIA, OpenAI, Groq, Together, Mistral,
// DeepSeek) use the same API: POST /v1/chat/completions with stream:true.
// The response is an SSE stream of chunks. We parse those and emit the
// same event format the brain emits, so chat.go doesn't know the difference.
package llm

import (
        "bufio"
        "bytes"
        "context"
        "encoding/json"
        "fmt"
        "io"
        "net/http"
        "strings"
)

// ChatRequest is the input to a direct LLM call.
type ChatRequest struct {
        Model        string    `json:"model"`
        Messages     []Message `json:"messages"`
        SystemPrompt string    `json:"-"`
        Effort       string    `json:"-"`
        APIKey       string    `json:"-"`
        BaseURL      string    `json:"-"`
        AuthStyle    string    `json:"-"` // "" (bearer) or "anthropic"
}

// Message is one chat message.
type Message struct {
        Role    string `json:"role"`
        Content string `json:"content"`
}

// ChatChunk is one streamed event. Matches the brain's wire format.
type ChatChunk struct {
        Type    string  `json:"type"`
        Text    string  `json:"text,omitempty"`
        State   string  `json:"state,omitempty"`
        Usage   *Usage  `json:"usage,omitempty"`
        Error   string  `json:"error,omitempty"`
        Message string  `json:"message,omitempty"`
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

// Chat streams a chat completion from an OpenAI-compatible provider.
// Yields ChatChunk events (same format the brain emits) so chat.go can
// use either path interchangeably.
//
// V0 fixes: fresh HTTP request per turn, no daemon timeout (ctx handles Stop),
// events emitted as they arrive, usage on the final status event.
func Chat(ctx context.Context, req ChatRequest) (<-chan ChatChunk, <-chan error) {
        ch := make(chan ChatChunk, 64)
        errs := make(chan error, 1)

        go func() {
                defer close(ch)
                defer close(errs)

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
                if extra := buildEffortBody(req.Model, req.Effort); extra != nil {
                        for k, v := range extra {
                                body[k] = v
                        }
                }

                bodyBytes, err := json.Marshal(body)
                if err != nil {
                        errs <- fmt.Errorf("marshal: %w", err)
                        return
                }

                // v0.12 FIX: catalog base URLs already end with "/v1"
                // (or Cloudflare's "/ai/v1") — appending "/v1/chat/completions"
                // produced ".../v1/v1/chat/completions" (404 on every provider
                // with a valid key). Only add the version segment when the base
                // URL doesn't already end in one.
                base := strings.TrimSuffix(req.BaseURL, "/")
                url := base + "/v1/chat/completions"
                if strings.HasSuffix(base, "/v1") {
                        url = base + "/chat/completions"
                }
                httpReq, err := http.NewRequestWithContext(ctx, "POST", url, bytes.NewReader(bodyBytes))
                if err != nil {
                        errs <- fmt.Errorf("new request: %w", err)
                        return
                }
                httpReq.Header.Set("Content-Type", "application/json")
                if req.AuthStyle == "anthropic" {
                        // Anthropic's OpenAI-compat endpoint wants x-api-key.
                        httpReq.Header.Set("x-api-key", req.APIKey)
                        httpReq.Header.Set("anthropic-version", "2023-06-01")
                } else {
                        httpReq.Header.Set("Authorization", "Bearer "+req.APIKey)
                }
                httpReq.Header.Set("Accept", "text/event-stream")
                httpReq.Header.Set("HTTP-Referer", "https://doomalay.app")
                httpReq.Header.Set("X-Title", "Doomalay")

                ch <- ChatChunk{Type: "status", State: "running"}

                resp, err := http.DefaultClient.Do(httpReq)
                if err != nil {
                        ch <- ChatChunk{Type: "error", Error: "llm_call", Message: err.Error()}
                        ch <- ChatChunk{Type: "status", State: "error"}
                        return
                }
                defer resp.Body.Close()

                if resp.StatusCode != 200 {
                        bts, _ := io.ReadAll(resp.Body)
                        ch <- ChatChunk{Type: "error", Error: "http", Message: fmt.Sprintf("%d: %s", resp.StatusCode, string(bts))}
                        ch <- ChatChunk{Type: "status", State: "error"}
                        return
                }

                scanner := bufio.NewScanner(resp.Body)
                scanner.Buffer(make([]byte, 0, 256*1024), 256*1024)
                var totalIn, totalOut int

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
                                totalIn = chunk.Usage.PromptTokens
                                totalOut = chunk.Usage.CompletionTokens
                        }
                }

                if err := scanner.Err(); err != nil {
                        ch <- ChatChunk{Type: "error", Error: "stream", Message: err.Error()}
                        ch <- ChatChunk{Type: "status", State: "error"}
                        return
                }

                ch <- ChatChunk{
                        Type:  "status",
                        State: "idle",
                        Usage: &Usage{
                                InputTokens:  totalIn,
                                OutputTokens: totalOut,
                                TotalTokens:  totalIn + totalOut,
                        },
                }
        }()

        return ch, errs
}

func buildEffortBody(model, effort string) map[string]any {
        if effort == "" || effort == "off" || effort == "med" {
                return nil
        }
        if strings.Contains(model, "o1") || strings.Contains(model, "o3") || strings.Contains(model, "o4") {
                mapping := map[string]string{"low": "low", "med": "medium", "high": "high", "max": "high"}
                if v, ok := mapping[effort]; ok {
                        return map[string]any{"reasoning_effort": v}
                }
        }
        if strings.Contains(model, "deepseek-r1") || strings.Contains(model, "deepseek-reasoner") {
                mapping := map[string]int{"low": 2000, "med": 8000, "high": 16000, "max": 32000}
                if v, ok := mapping[effort]; ok {
                        return map[string]any{"reasoning_effort": v}
                }
        }
        return nil
}
