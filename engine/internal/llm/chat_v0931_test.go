package llm

// chat_v0931_test.go — THE OPENROUTER HONESTY WAVE pins.
//
// The user's live-device findings this wave answers:
//   1. google/lyria-3-clip-preview → "bufio.Scanner: token too long"
//      (media models stream multi-MB base64 SSE lines; the 256KB cap died).
//   2. "Using Openrouter. It's much more bland… we don't get reasoning"
//      (OpenRouter streams delta.reasoning; we parsed only reasoning_content).
//   3. "Most Openrouter models say they are no longer available for my
//      account" (the retired-:free 404 with "use this slug instead").
//   4. "even the free model says the quota is reached when I barley used it"
//      (the upstream shared-pool 429 + the never-purchased-credits 402 both
//      mislabeled by the generic branches).
//
// All four shapes below are the LIVE bodies captured 2026-10-02 with the
// user's key.

import (
        "context"
        "net/http"
        "net/http/httptest"
        "strings"
        "testing"
        "time"
)

// TestV931_OversizeSSELinePasses — a single >256KB data line (the lyria
// base64-media shape) streams through cleanly on the 16MB buffer instead of
// dying with "token too long".
func TestV931_OversizeSSELinePasses(t *testing.T) {
        big := strings.Repeat("A", 900*1024) // 900KB — 3.5× the old 256KB cap
        srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
                w.Header().Set("Content-Type", "text/event-stream")
                w.WriteHeader(200)
                fl := w.(http.Flusher)
                _, _ = w.Write([]byte(`data: {"choices":[{"delta":{"content":"ok "}}]}` + "\n\n"))
                _, _ = w.Write([]byte(`data: {"choices":[{"delta":{"content":"` + big + `"}}]}` + "\n\n"))
                _, _ = w.Write([]byte(`data: {"choices":[{"delta":{"content":" end"}}]}` + "\n\n"))
                _, _ = w.Write([]byte("data: [DONE]\n\n"))
                fl.Flush()
        }))
        defer srv.Close()

        ch := make(chan ChatChunk, 64)
        req := ChatRequest{
                Model: "openrouter/google/lyria-3-clip-preview", Provider: "openrouter",
                BaseURL: srv.URL, Messages: []Message{{Role: "user", Content: "a piano note"}},
        }
        var saw string
        usage, err := streamCompletion(context.Background(), req, ch, nil)
        close(ch)
        _ = usage
        if err != nil {
                t.Fatalf("oversize line must stream, got err: %v", err)
        }
        // drain note: streamCompletion forwarded deltas; assert the total text
        // via a second pass with a collector to keep the pin strict.
        var got strings.Builder
        ch2 := make(chan ChatChunk, 64)
        _, err = streamCompletion(context.Background(), req, ch2, nil)
        if err != nil {
                t.Fatalf("second pass err: %v", err)
        }
        close(ch2)
        for c := range ch2 {
                if c.Type == "assistant_delta" {
                        got.WriteString(c.Text)
                }
        }
        if !strings.HasPrefix(got.String(), "ok ") || !strings.HasSuffix(got.String(), " end") {
                t.Fatalf("content mangled: %q…%q", got.String()[:8], got.String()[len(got.String())-8:])
        }
        if len(got.String()) < 900*1024 {
                t.Fatalf("the 900KB payload was dropped (len=%d)", len(got.String()))
        }
        saw = got.String()
        _ = saw
}

// TestV931_OpenRouterReasoningFieldStreams — delta.reasoning (the OpenRouter
// convention, live-verified on liquid/lfm-2.5-2.6b:free) surfaces as thinking
// events, not silence.
func TestV931_OpenRouterReasoningFieldStreams(t *testing.T) {
        srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
                w.Header().Set("Content-Type", "text/event-stream")
                w.WriteHeader(200)
                fl := w.(http.Flusher)
                _, _ = w.Write([]byte(`data: {"choices":[{"delta":{"reasoning":"The user wants 17*23. "}}]}` + "\n\n"))
                _, _ = w.Write([]byte(`data: {"choices":[{"delta":{"reasoning":"17*20=340, 17*3=51. "}}]}` + "\n\n"))
                _, _ = w.Write([]byte(`data: {"choices":[{"delta":{"content":"391"}}]}` + "\n\n"))
                _, _ = w.Write([]byte("data: [DONE]\n\n"))
                fl.Flush()
        }))
        defer srv.Close()

        ch := make(chan ChatChunk, 64)
        req := ChatRequest{
                Model: "openrouter/liquid/lfm-2.5-2.6b:free", Provider: "openrouter",
                BaseURL: srv.URL, Messages: []Message{{Role: "user", Content: "17*23"}},
        }
        _, err := streamCompletion(context.Background(), req, ch, nil)
        if err != nil {
                t.Fatalf("err: %v", err)
        }
        close(ch)
        var think, text string
        for c := range ch {
                if c.Type == "thinking" {
                        think += c.Text
                }
                if c.Type == "assistant_delta" {
                        text += c.Text
                }
        }
        if !strings.Contains(think, "17*23") || !strings.Contains(think, "340") {
                t.Fatalf("OpenRouter reasoning dropped (think=%q)", think)
        }
        if text != "391" {
                t.Fatalf("content wrong: %q", text)
        }
}

// TestV931_OpenRouterFriendlyErrors — the three live error bodies get their
// honest labels (captured 2026-10-02 with the user's key).
func TestV931_OpenRouterFriendlyErrors(t *testing.T) {
        // (1) the retired-:free 404 (llama-3.3-70b-instruct:free, live body)
        retired := `{"error":{"message":"This model is unavailable for free. The paid version is available now - use this slug instead: meta-llama/llama-3.3-70b-instruct","code":404},"user_id":"user_3BueHkIET0r6EgKtaP7T95aJGq1"}`
        msg := friendlyHTTPError(404, retired, "openrouter")
        if !strings.Contains(msg, "retired this free model variant") {
                t.Fatalf("retired-:free branch missed: %q", msg)
        }
        if !strings.Contains(msg, "meta-llama/llama-3.3-70b-instruct") {
                t.Fatalf("the suggested paid slug was not extracted: %q", msg)
        }
        if !strings.Contains(msg, "openrouter/free") {
                t.Fatalf("the free-router pointer missing: %q", msg)
        }

        // (2) the never-purchased-credits 402 (deepseek/deepseek-r1, live body)
        credits := `{"error":{"message":"Insufficient credits. This account never purchased credits. Make sure your key is on the correct account or org, and if so, purchase more at https://openrouter.ai/settings/credits","code":402,"metadata":{"limit_source":"openrouter_credits"}}`
        msg = friendlyHTTPError(402, credits, "openrouter")
        if !strings.Contains(msg, "no credits") || !strings.Contains(msg, "your key works") {
                t.Fatalf("credits-402 branch wrong: %q", msg)
        }

        // (3) the upstream shared-pool 429 (qwen/qwen3.8-27b:free, live body)
        pool := `{"error":{"message":"Provider returned error","code":429,"metadata":{"raw":"qwen/qwen3.8-27b:free is temporarily rate-limited upstream. Please retry shortly, or add your own key to accumulate your rate limits: https://openrouter.ai/settings/integrations","provider_name":"ModelRun","is_byok":false,"provider_error_code":"429","limit_source":"upstream_provider_shared_pool"}}}`
        msg = friendlyHTTPError(429, pool, "openrouter")
        if !strings.Contains(msg, "not YOUR quota") {
                t.Fatalf("shared-pool 429 branch wrong: %q", msg)
        }
}

// TestV931_RetiredFreeIsModelGone — the one-tap suggestion chips attach to
// the retired-:free error (ModelGoneMessage class).
func TestV931_RetiredFreeIsModelGone(t *testing.T) {
        msg := friendlyHTTPError(404, `{"error":{"message":"This model is unavailable for free. The paid version is available now - use this slug instead: deepseek/deepseek-r1","code":404}}`, "openrouter")
        if !ModelGoneMessage(msg) {
                t.Fatalf("retired-:free must be model-gone class: %q", msg)
        }
}

// TestV931_FreeModelsSkipPaidWebPlugin — the `web` plugin is a PAID
// OpenRouter feature; on free-tier models it 402s (live-captured on the
// wire: plugins:[{id:web}] + liquid/lfm-2.5-2.6b:free → 402 "Insufficient
// credits. This account never purchased credits"). Free models must return
// nil so the turn rides the free client-side ReAct web_search loop.
func TestV931_FreeModelsSkipPaidWebPlugin(t *testing.T) {
        // registry-free checks first (no network in unit tests)
        if b := NativeWebSearchBody("openrouter", "liquid/lfm-2.5-2.6b:free"); b != nil {
                t.Fatalf(":free model must skip the paid plugin, got %v", b)
        }
        if b := NativeWebSearchBody("openrouter", "openrouter/free"); b != nil {
                t.Fatalf("the free router must skip the paid plugin, got %v", b)
        }
        // a paid model KEEPS the native plugin
        if b := NativeWebSearchBody("openrouter", "anthropic/claude-fable-5"); b == nil {
                t.Fatal("paid model must keep the native web plugin")
        }
        // non-openrouter never had one
        if b := NativeWebSearchBody("nvidia", "anything"); b != nil {
                t.Fatalf("nvidia must never get the plugin, got %v", b)
        }
}

// TestV931_FreeRouterSortsFirst — the OpenRouter provider view leads with
// openrouter/free, then the zero-priced entries, then the paid alphabet.
func TestV931_FreeRouterSortsFirst(t *testing.T) {
        // seam: the package-private registry cache (fresh TTL → the fetcher
        // serves it without any network).
        mk := func(prompt, completion string) *orModelMeta {
                m := &orModelMeta{}
                m.Pricing.Prompt = prompt
                m.Pricing.Completion = completion
                return m
        }
        orRegMu.Lock()
        oldCache, oldAt := orRegCache, orRegAt
        orRegCache = map[string]*orModelMeta{
                "z-paid/zzz":               mk("0.001", "0.002"),
                "openrouter/free":          mk("0", "0"),
                "a-paid/aaa":               mk("0.001", "0.002"),
                "liquid/lfm-2.5-2.6b:free": mk("0", "0"),
        }
        orRegAt = time.Now()
        orRegMu.Unlock()
        defer func() {
                orRegMu.Lock()
                orRegCache, orRegAt = oldCache, oldAt
                orRegMu.Unlock()
        }()

        out := fetchOpenRouterModels("k")
        if len(out) != 4 {
                t.Fatalf("want 4 models, got %d", len(out))
        }
        if out[0].RawID != "openrouter/free" {
                t.Fatalf("free router must lead, got %q", out[0].RawID)
        }
        if out[1].RawID != "liquid/lfm-2.5-2.6b:free" {
                t.Fatalf("second must be the zero-priced entry, got %q", out[1].RawID)
        }
        if out[2].RawID != "a-paid/aaa" || out[3].RawID != "z-paid/zzz" {
                t.Fatalf("paid alphabet broken: %q, %q", out[2].RawID, out[3].RawID)
        }
}
