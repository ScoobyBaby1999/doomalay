package llm

// chat_v0932_test.go — THE MISTRAL SURVIVABILITY WAVE pins.
//
// The user's live-device findings this wave answers:
//   1. "Mistral keeps sending Post "https://api.mistral.ai/v1/chat/completions":
//      remote error: tls: bad record MAC (via mistral · codestral-latest)
//      request failed: send: …" — the error TERMINALIZED the turn because
//      isTransientNetErr didn't know the TLS record-corruption class; the
//      pause ladder (fresh-connection retry — the documented cure) never ran.
//   2. "Also gets killed by engine restart for some reason which would never
//      happen" — the llm.Chat producer goroutine had NO recover(): a panic
//      anywhere in the tool chain killed the whole engine process, and the
//      Android watchdog restarted it mid-conversation.

import (
        "context"
        "net/http"
        "net/http/httptest"
        "strings"
        "testing"
        "time"
)

// TestV932_TLSBadRecordMACIsTransient — the exact error string from the
// user's device classifies as transient (retryable on a fresh connection),
// and auth/protocol errors still don't.
func TestV932_TLSBadRecordMACIsTransient(t *testing.T) {
        live := `Post "https://api.mistral.ai/v1/chat/completions": remote error: tls: bad record MAC`
        if !isTransientNetErr(contextStringError(live)) {
                t.Fatal("the user's live tls: bad record MAC error must classify as transient")
        }
        for _, s := range []string{
                `stream: remote error: tls: bad record MAC`,
                `send: tls: handshake failure`,
                `Post "https://x": tls: record MAC mismatch`,
        } {
                if !isTransientNetErrorString(s) {
                        t.Fatalf("tls-class error must be transient: %q", s)
                }
        }
        // the non-transient classes stay non-transient
        for _, s := range []string{
                `401: invalid api key`,
                `404: this model is no longer available`,
                `400: bad request shape`,
        } {
                if isTransientNetErrorString(s) {
                        t.Fatalf("auth/protocol error must stay terminal: %q", s)
                }
        }
}

// helpers so both the wrapped and bare string shapes are pinned
func contextStringError(s string) error { return &strErr{s} }

type strErr struct{ s string }

func (e *strErr) Error() string { return e.s }

func isTransientNetErrorString(s string) bool { return isTransientNetErr(&strErr{s}) }

// TestV932_PanicInTurnRecovers — a panic inside a TOOL (injected via the
// WorkspaceToolFn seam) must NOT kill the process. v1.13.2 THE HANDOFF
// changed the contract for the BETTER: the mcpbus contains handler panics
// at the tool level (one honest tool-error observation the model can
// self-correct from) — the turn now COMPLETES instead of dying, the
// channels close, the engine lives. (The old turn-level guard in
// llm.Chat remains as defense-in-depth for panics OUTSIDE the bus.)
func TestV932_PanicInTurnRecovers(t *testing.T) {
        // mistral rides the NATIVE tool_calls path (nativeToolProviders) — the
        // user's exact provider + failure surface. The mock answers the
        // poisoned workspace call once, then streams the final answer.
        calls := 0
        srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
                w.Header().Set("Content-Type", "text/event-stream")
                w.WriteHeader(200)
                fl := w.(http.Flusher)
                calls++
                if calls == 1 {
                        _, _ = w.Write([]byte(`data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"workspace","arguments":"{\"action\":\"list\"}"}}]}}]}` + "\n\n"))
                        _, _ = w.Write([]byte(`data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}` + "\n\n"))
                } else {
                        _, _ = w.Write([]byte(`data: {"choices":[{"delta":{"content":"recovered — the tool failed but I am fine"}}]}` + "\n\n"))
                        _, _ = w.Write([]byte(`data: {"choices":[{"delta":{},"finish_reason":"stop"}]}` + "\n\n"))
                }
                _, _ = w.Write([]byte("data: [DONE]\n\n"))
                fl.Flush()
        }))
        defer srv.Close()

        req := ChatRequest{
                Model:    "mistral/codestral-latest",
                Provider: "mistral",
                BaseURL:  srv.URL,
                Messages: []Message{{Role: "user", Content: "list my repos"}},
                WorkspaceToolFn: func(ctx context.Context, argJSON string) string {
                        panic("injected: a poisoned workspace tool (the engine-kill class)")
                },
        }
        ch, errs := Chat(context.Background(), req)

        var sawToolError, sawFinalAnswer, sawIdle bool
        var toolErr string
        deadline := time.After(15 * time.Second)
collect:
        for {
                select {
                case c, ok := <-ch:
                        if !ok {
                                break collect
                        }
                        if c.Type == "tool_result" && c.Name == "workspace" && strings.Contains(c.Text, "failed internally") {
                                sawToolError = true
                                toolErr = c.Text
                        }
                        if c.Type == "assistant_delta" && strings.Contains(c.Text, "recovered") {
                                sawFinalAnswer = true
                        }
                        if c.Type == "status" && c.State == "idle" {
                                sawIdle = true
                        }
                case e, ok := <-errs:
                        _ = e
                        _ = ok
                case <-deadline:
                        t.Fatal("channels never closed — the turn never completed")
                }
        }
        if !sawToolError || !sawFinalAnswer || !sawIdle {
                t.Fatalf("the contained-panic contract: toolError=%v finalAnswer=%v idle=%v (toolErr=%q)", sawToolError, sawFinalAnswer, sawIdle, toolErr)
        }
        if !strings.Contains(toolErr, "engine recovered") {
                t.Fatalf("the panic message must be honest, got %q", toolErr)
        }
        // reaching here means the TEST PROCESS survived the panic — the same
        // guarantee the engine needs on device.
}
