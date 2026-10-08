package llm

// turnfsm_v1146_test.go — v1.14.6 THE SOLID STREAM: the per-bot terminal
// state machine. Pins the verdict matrix, the isolation law (nil-safe,
// per-turn instance), and the two stream integrations: the plain-path
// silent-stop net (empty → ONE announced retry) and the silent-stop record
// (deltas without a wire verdict → honest status, never a retry).

import (
        "context"
        "errors"
        "fmt"
        "net/http"
        "net/http/httptest"
        "sync/atomic"
        "testing"

        "github.com/ScoobyBaby1999/doomalay/engine/internal/obs"
)

func TestV1146_FSMVerdictMatrix(t *testing.T) {
        t.Run("no-stream", func(t *testing.T) {
                f := newTurnFSM(context.Background(), ChatRequest{SessionID: "s"})
                if v := f.seal(nil, nil); v != "no-stream" {
                        t.Fatalf("verdict = %q, want no-stream", v)
                }
        })
        t.Run("empty", func(t *testing.T) {
                f := newTurnFSM(context.Background(), ChatRequest{SessionID: "s"})
                f.markOpen()
                if v := f.seal(nil, nil); v != "empty" {
                        t.Fatalf("verdict = %q, want empty", v)
                }
        })
        t.Run("silent-stop", func(t *testing.T) {
                f := newTurnFSM(context.Background(), ChatRequest{SessionID: "s"})
                f.markOpen()
                f.streamed()
                if v := f.seal(nil, nil); v != "silent-stop" {
                        t.Fatalf("verdict = %q, want silent-stop", v)
                }
        })
        t.Run("wire-stop-wins-over-deltas", func(t *testing.T) {
                f := newTurnFSM(context.Background(), ChatRequest{SessionID: "s"})
                f.markOpen()
                f.streamed()
                f.noteWire(&Usage{FinishReason: "stop"})
                if v := f.seal(nil, nil); v != "stop" {
                        t.Fatalf("verdict = %q, want stop", v)
                }
        })
        t.Run("length-flags-output-cut", func(t *testing.T) {
                f := newTurnFSM(context.Background(), ChatRequest{SessionID: "s"})
                f.noteWire(&Usage{FinishReason: "length"})
                u := &Usage{}
                if v := f.seal(nil, u); v != "length" || !u.OutputCut || u.FinishReason != "length" {
                        t.Fatalf("verdict=%q usage=%+v", v, u)
                }
        })
        t.Run("aborted-by-ctx", func(t *testing.T) {
                ctx, cancel := context.WithCancel(context.Background())
                f := newTurnFSM(ctx, ChatRequest{SessionID: "s"})
                f.markOpen()
                f.streamed()
                cancel() // the user stop: ctx dies, the runner returns nil err
                if v := f.seal(nil, nil); v != "aborted" {
                        t.Fatalf("verdict = %q, want aborted", v)
                }
        })
        t.Run("aborted-by-err", func(t *testing.T) {
                f := newTurnFSM(context.Background(), ChatRequest{SessionID: "s"})
                if v := f.seal(context.Canceled, nil); v != "aborted" {
                        t.Fatalf("verdict = %q, want aborted", v)
                }
        })
        t.Run("error", func(t *testing.T) {
                f := newTurnFSM(context.Background(), ChatRequest{SessionID: "s"})
                if v := f.seal(errors.New("boom"), nil); v != "error" {
                        t.Fatalf("verdict = %q, want error", v)
                }
        })
        t.Run("later-seal-overwrites", func(t *testing.T) {
                f := newTurnFSM(context.Background(), ChatRequest{SessionID: "s"})
                if v := f.seal(nil, nil); v != "no-stream" {
                        t.Fatalf("first seal = %q", v)
                }
                f.markOpen()
                f.streamed()
                f.noteWire(&Usage{FinishReason: "stop"})
                if v := f.seal(nil, nil); v != "stop" {
                        t.Fatalf("second seal = %q, want stop (later state wins)", v)
                }
        })
        t.Run("nil-fsm-is-safe", func(t *testing.T) {
                var f *turnFSM
                f.dispatched("plain")
                f.markOpen()
                f.streamed()
                f.roundStart(3)
                f.noteWire(&Usage{})
                if v := f.seal(nil, nil); v != "" {
                        t.Fatalf("nil fsm verdict = %q, want empty", v)
                }
                if v, _, _, _ := f.report(); v != "" {
                        t.Fatalf("nil fsm report = %q", v)
                }
                if fsmFrom(context.Background()) != nil {
                        t.Fatal("ctx without fsm must yield nil")
                }
        })
        t.Run("phases-are-forward-only", func(t *testing.T) {
                f := newTurnFSM(context.Background(), ChatRequest{SessionID: "s"})
                f.dispatched("native_tools")
                f.roundStart(0)
                f.markOpen()  // a second round's stream open — must not downgrade
                f.streamed()  // nor this
                f.roundStart(1)
                if f.phase != phaseToolRounds {
                        t.Fatalf("phase = %v, want tool_rounds", f.phase)
                }
                if f.rounds != 2 {
                        t.Fatalf("rounds = %d, want 2", f.rounds)
                }
        })
        t.Run("report-carries-rounds-path-duration", func(t *testing.T) {
                f := newTurnFSM(context.Background(), ChatRequest{SessionID: "s", Provider: "p", Model: "m"})
                f.dispatched("native_tools")
                f.roundStart(0)
                f.roundStart(1)
                f.noteWire(&Usage{FinishReason: "tool_calls"})
                v, rounds, path, _ := f.report()
                if v != "tool_calls" || rounds != 2 || path != "native_tools" {
                        t.Fatalf("report = %q %d %q", v, rounds, path)
                }
        })
}

// emptyThenStopStub: request 1 = a clean 200 with ONLY [DONE] (the empty
// class); request 2 = a real completion with a stop verdict.
func emptyThenStopStub(hits *atomic.Int32) *httptest.Server {
        return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
                n := hits.Add(1)
                w.Header().Set("Content-Type", "text/event-stream")
                w.WriteHeader(200)
                if n == 1 {
                        _, _ = w.Write([]byte("data: [DONE]\n\n"))
                        return
                }
                _, _ = w.Write([]byte("data: {\"choices\":[{\"delta\":{\"content\":\"the real answer\"}}]}\n\n"))
                _, _ = w.Write([]byte("data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":3,\"completion_tokens\":4}}\n\n"))
                _, _ = w.Write([]byte("data: [DONE]\n\n"))
        }))
}

func drainChunks(ch chan ChatChunk) (lastStatus ChatChunk, progresses int) {
        for c := range ch {
                if c.Type == "status" {
                        lastStatus = c
                }
                if c.Type == "progress" {
                        progresses++
                }
        }
        return lastStatus, progresses
}

func TestV1146_PlainTurnEmptyHealedByOneRetry(t *testing.T) {
        var hits atomic.Int32
        srv := emptyThenStopStub(&hits)
        defer srv.Close()

        f := newTurnFSM(context.Background(), ChatRequest{SessionID: "sess-empty"})
        ctx := withFSM(obs.TurnScope(context.Background(), "sess-empty"), f)
        ch := make(chan ChatChunk, 64)
        errs := make(chan error, 1)
        req := ChatRequest{Model: "m", Provider: "stubprov", SessionID: "sess-empty",
                BaseURL: srv.URL, Messages: []Message{{Role: "user", Content: "go"}}}
        runPlainTurn(ctx, ch, errs, req)
        close(ch)
        select {
        case e := <-errs:
                t.Fatalf("turn errored: %v", e)
        default:
        }
        if n := hits.Load(); n != 2 {
                t.Fatalf("stub hits = %d, want 2 (the empty + the retry)", n)
        }
        status, progresses := drainChunks(ch)
        if status.Usage == nil || status.Usage.FinishReason != "stop" {
                t.Fatalf("final status usage wrong: %+v", status.Usage)
        }
        if progresses == 0 {
                t.Fatal("the retry must be announced (progress chunk)")
        }
}

func TestV1146_PlainTurnSilentStopRecordedNotRetried(t *testing.T) {
        // deltas then a clean close with NO finish_reason — the silent-stop
        // class: content is already on screen, so NO retry (a retry would
        // double-render); the verdict is recorded into the status usage.
        var hits atomic.Int32
        srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
                hits.Add(1)
                w.Header().Set("Content-Type", "text/event-stream")
                w.WriteHeader(200)
                _, _ = w.Write([]byte("data: {\"choices\":[{\"delta\":{\"content\":\"partial answer\"}}]}\n\n"))
                _, _ = w.Write([]byte("data: [DONE]\n\n"))
        }))
        defer srv.Close()

        // (distinct provider id — the empty-retry test above leaves provider
        // state keyed by name, and these pins must not inherit it)
        f := newTurnFSM(context.Background(), ChatRequest{SessionID: "sess-silent"})
        ctx := withFSM(obs.TurnScope(context.Background(), "sess-silent"), f)
        ch := make(chan ChatChunk, 64)
        errs := make(chan error, 1)
        req := ChatRequest{Model: "m", Provider: "stubsilent", SessionID: "sess-silent",
                BaseURL: srv.URL, Messages: []Message{{Role: "user", Content: "go"}}}
        runPlainTurn(ctx, ch, errs, req)
        close(ch)
        select {
        case e := <-errs:
                t.Fatalf("turn errored: %v", e)
        default:
        }
        if n := hits.Load(); n != 1 {
                t.Fatalf("stub hits = %d, want 1 (silent-stop is NEVER retried)", n)
        }
        status, progresses := drainChunks(ch)
        if status.Usage == nil || status.Usage.FinishReason != "silent-stop" {
                t.Fatalf("final status usage wrong: %+v — the verdict must persist", status.Usage)
        }
        if progresses != 0 {
                t.Fatalf("silent-stop must not announce a retry, got %d progress chunks", progresses)
        }
        _ = fmt.Sprint() // keep fmt imported for future stubs
}
