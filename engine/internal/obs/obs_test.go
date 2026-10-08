package obs

// obs_test.go — v1.14.4 THE TRACE: the hook bus, the ring, the gates.

import (
        "context"
        "strings"
        "sync"
        "testing"
        "time"
)

func withDeltaGate(t *testing.T, level int) {
        t.Helper()
        old := forceDeltaTrace
        forceDeltaTrace = level
        t.Cleanup(func() { forceDeltaTrace = old })
}

func TestEmitFanout(t *testing.T) {
        var got []Event
        var mu sync.Mutex
        unsub := Subscribe("test-fanout", func(e Event) {
                mu.Lock()
                got = append(got, e)
                mu.Unlock()
        })
        defer unsub()

        ctx := TurnScope(context.Background(), "sess-fanout")
        EmitS(ctx, ReasoningDelta, "provider", "nvidia", "model", "m1", "len", 42, "head", "hello")
        EmitS(ctx, Finish, "model", "m1", "output_cut", true)

        mu.Lock()
        defer mu.Unlock()
        if len(got) != 2 {
                t.Fatalf("hook saw %d events, want 2", len(got))
        }
        e := got[0]
        if e.Kind != ReasoningDelta || e.Provider != "nvidia" || e.Model != "m1" {
                t.Fatalf("event fields not lifted: %+v", e)
        }
        if e.SessionID != "sess-fanout" {
                t.Fatalf("session not stamped from scope: %+v", e)
        }
        if e.Turn != 1 {
                t.Fatalf("turn number not stamped: %+v", e)
        }
        if e.Data["len"].(int) != 42 {
                t.Fatalf("data lost: %+v", e.Data)
        }
        if !got[1].Data["output_cut"].(bool) {
                t.Fatalf("bool data lost: %+v", got[1].Data)
        }
}

func TestHookPanicIsolated(t *testing.T) {
        unsub := Subscribe("test-bomb", func(e Event) { panic("hook bomb") })
        defer unsub()
        done := make(chan struct{})
        go func() {
                EmitS(context.Background(), Usage, "ok", 1)
                close(done)
        }()
        select {
        case <-done:
        case <-time.After(2 * time.Second):
                t.Fatal("a panicking hook took Emit down")
        }
}

func TestTurnScopeMonotonic(t *testing.T) {
        ctx1 := TurnScope(context.Background(), "sess-turns")
        ctx2 := TurnScope(context.Background(), "sess-turns")
        if CurrentTurn(ctx1) != 1 || CurrentTurn(ctx2) != 2 {
                t.Fatalf("turn numbering not monotonic: %d then %d", CurrentTurn(ctx1), CurrentTurn(ctx2))
        }
        if CurrentTurn(context.Background()) != 0 {
                t.Fatal("bare ctx must report turn 0")
        }
}

func TestSanitizeTruncation(t *testing.T) {
        long := strings.Repeat("x", 2000)
        var got Event
        unsub := Subscribe("test-trunc", func(e Event) { got = e })
        defer unsub()
        EmitS(context.Background(), ContentDelta, "text", long)
        if v, ok := got.Data["text"].(string); !ok || len([]rune(v)) > 513 {
                t.Fatalf("string not truncated: %d runes", len([]rune(v)))
        }
}

func TestRingSessionTail(t *testing.T) {
        Clear()
        defer Clear()
        ctx := TurnScope(context.Background(), "sess-tail")
        for i := 0; i < 600; i++ {
                Emit(ctx, Event{Kind: Usage, Data: map[string]any{"i": i}})
                _ = ctx
        }
        snap := Snapshot("sess-tail", 0)
        if len(snap) != ringCap {
                t.Fatalf("ring holds %d events, want cap %d", len(snap), ringCap)
        }
        if snap[0].Data["i"].(int) != 600-ringCap {
                t.Fatalf("oldest kept event = %v, want %d", snap[0].Data["i"], 600-ringCap)
        }
        tail := Snapshot("sess-tail", 10)
        if len(tail) != 10 || tail[9].Data["i"].(int) != 599 {
                t.Fatalf("limit tail wrong: %d events, last=%v", len(tail), tail[len(tail)-1].Data)
        }
}

func TestRingDeltaGate(t *testing.T) {
        Clear()
        defer Clear()
        withDeltaGate(t, 0)
        ctx := TurnScope(context.Background(), "sess-gate")
        EmitS(ctx, ReasoningDelta, "head", "hidden")
        EmitS(ctx, Usage, "ok", 1)
        if snap := Snapshot("sess-gate", 0); len(snap) != 1 {
                t.Fatalf("gate 0 must drop delta events from the ring, got %d events", len(snap))
        }
        withDeltaGate(t, 1)
        EmitS(ctx, ReasoningDelta, "head", "shown")
        if snap := Snapshot("sess-gate", 0); len(snap) != 2 {
                t.Fatalf("gate 1 must keep delta events, got %d events", len(snap))
        }
}

func TestRingSessionEviction(t *testing.T) {
        Clear()
        defer Clear()
        for i := 0; i < sessionCap+8; i++ {
                id := "sess-evict-" + strings.Repeat("s", i+1) // unique ids
                Emit(TurnScope(context.Background(), id), Event{Kind: Usage})
        }
        if n := len(Sessions()); n > sessionCap {
                t.Fatalf("%d sessions survived, want cap %d", n, sessionCap)
        }
}
