// events.go — the hook bus (v1.14.4 THE TRACE).
//
// One typed Event type, one Emit call, three sinks:
//
//  1. the per-session ring buffer (ring.go — GET /api/debug/trace)
//  2. every registered Go hook (Subscribe — tests, the PWA bridge,
//     future sinks; each hook is recover-guarded, a panicking hook
//     never takes the turn down)
//  3. the active OTel span's event timeline (when a span from ctx is
//     recording — this is how Langfuse sees the full lifecycle in one
//     waterfall)
//
// Delta events are gated by DOOM_TRACE_DELTAS (see obs.go): gate 0 keeps
// only the per-round tallies on the finish event; gate 1 records a 64-rune
// head per delta; gate 2 records full text. Everything else always emits.
package obs

import (
	"context"
	"fmt"
	"reflect"
	"sync"
	"time"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/trace"
)

// Kind is the event taxonomy. Stable wire names (the /api/debug/trace
// contract) — add, never rename.
type Kind string

const (
	TurnStart      Kind = "turn.start"         // a chat turn began (any path: llm direct, brain, remote brain)
	TurnEnd        Kind = "turn.end"           // the turn reached a terminal state
	Dispatch       Kind = "turn.dispatch"      // which runner the dispatcher chose, and why inputs
	RoundStart     Kind = "llm.round.start"    // one tool-loop round begins
	RoundEnd       Kind = "llm.round.end"      // the round's outcome (calls count, tokens)
	Request        Kind = "llm.request"        // an upstream POST attempt (url, attempt, bytes)
	Retry          Kind = "llm.retry"          // 429/503 backoff (status, attempt, wait)
	Fallback       Kind = "llm.fallback"       // model-gone provider rotation
	ToolsRejected  Kind = "llm.tools_rejected" // the provider 400'd a tools-bearing request
	Strip          Kind = "llm.strip"          // a capability strip retry (effort / max_tokens)
	StreamOpen     Kind = "llm.stream.open"    // the provider answered 200, bytes may flow
	FirstToken     Kind = "llm.first_token"    // the first real delta of a stream
	Guard          Kind = "llm.guard"          // the 92% context guard spoke
	Notice         Kind = "llm.notice"         // a progress notice (nudge, budget, wait)
	ReasoningDelta Kind = "delta.reasoning"    // one reasoning fragment (gated)
	ContentDelta   Kind = "delta.content"      // one content fragment (gated)
	ToolCallDelta  Kind = "delta.tool_call"    // one tool_call argument fragment (gated)
	ToolStart      Kind = "tool.start"         // a tool call begins (bus observer + direct)
	ToolEnd        Kind = "tool.end"           // a tool call returned (timing, size, fault)
	ToolProgress   Kind = "tool.progress"      // a long tool's mid-flight status line
	ToolFault      Kind = "tool.fault"         // cut/malformed arguments — the honesty line
	Usage          Kind = "llm.usage"          // final token usage of one completion
	Finish         Kind = "llm.finish"         // terminal verdict (finish_reason, output_cut)
	ErrorEv        Kind = "llm.error"          // anything that failed
)

// Event is one observable moment. Data keys are free-form per kind but
// always JSON-serializable primitives (string/int/int64/float64/bool) —
// Emit truncates long strings, drops everything else.
type Event struct {
	Seq       int64          `json:"seq"`
	Kind      Kind           `json:"kind"`
	At        time.Time      `json:"at"`
	SessionID string         `json:"session_id,omitempty"`
	Turn      int64          `json:"turn,omitempty"`
	Provider  string         `json:"provider,omitempty"`
	Model     string         `json:"model,omitempty"`
	Round     int            `json:"round,omitempty"`
	Data      map[string]any `json:"data,omitempty"`
}

// ── the turn scope (ctx-carried identity) ───────────────────────────────

type scopeKey struct{}

type scope struct {
	sessionID string
	turn      int64
}

// turnCounters assigns monotonic per-session turn numbers (the server
// serializes turns per session, so a plain map + counter is exact).
var (
	turnMu    sync.Mutex
	turnCount = map[string]int64{}
)

// TurnScope stamps the ctx with the session identity and the NEXT turn
// number for that session. Every Emit down the turn inherits it.
func TurnScope(ctx context.Context, sessionID string) context.Context {
	if sessionID == "" {
		return ctx
	}
	turnMu.Lock()
	turnCount[sessionID]++
	n := turnCount[sessionID]
	turnMu.Unlock()
	if n > 1<<30 { // the counter is per-engine-lifetime; wrap never expected
		turnCount[sessionID] = 1
		n = 1
	}
	return context.WithValue(ctx, scopeKey{}, &scope{sessionID: sessionID, turn: n})
}

// CurrentTurn reports the turn number stamped on the ctx (0 = none).
func CurrentTurn(ctx context.Context) int64 {
	if s, ok := ctx.Value(scopeKey{}).(*scope); ok {
		return s.turn
	}
	return 0
}

// ── the emit pipeline ────────────────────────────────────────────────────

var seqCounter atomicInt64

// Emit publishes one event through the whole chain. Safe on a nil-ish ctx
// (Background works); never panics, never blocks the turn longer than the
// ring append + hook fan-out (hooks are synchronous by design — order
// matters for debugging — so keep them fast).
func Emit(ctx context.Context, e Event) {
	if e.At.IsZero() {
		e.At = time.Now()
	}
	e.Seq = seqCounter.Add(1)
	if s, ok := ctx.Value(scopeKey{}).(*scope); ok {
		if e.SessionID == "" {
			e.SessionID = s.sessionID
		}
		if e.Turn == 0 {
			e.Turn = s.turn
		}
	}
	recordEvent(e) // ring (kind-gated inside)
	emitSpanEvent(ctx, e)
	fanOut(e)
}

// EmitS is the sugar: Emit with key/value pairs (odd args are skipped).
// Well-known keys lift into the Event's own fields: "provider", "model",
// "round". Values must be primitives; long strings truncate at 512 runes.
func EmitS(ctx context.Context, kind Kind, kvs ...any) {
	e := Event{Kind: kind}
	for i := 0; i+1 < len(kvs); i += 2 {
		key, ok := kvs[i].(string)
		if !ok {
			continue
		}
		switch key {
		case "provider":
			e.Provider, _ = kvs[i+1].(string)
		case "model":
			e.Model, _ = kvs[i+1].(string)
		case "round":
			if n, ok := kvs[i+1].(int); ok {
				e.Round = n
			}
		default:
			if e.Data == nil {
				e.Data = map[string]any{}
			}
			e.Data[key] = sanitize(kvs[i+1])
		}
	}
	Emit(ctx, e)
}

// sanitize keeps Data JSON-primitive and bounded.
func sanitize(v any) any {
	switch x := v.(type) {
	case nil, bool, int, int64, float64, string:
		if s, ok := x.(string); ok {
			return truncateRunes(s, 512)
		}
		return x
	case error:
		return truncateRunes(x.Error(), 512)
	case time.Duration:
		return x.Milliseconds()
	default:
		// last resort for exotic primitives (e.g. named int types)
		switch rv := reflect.ValueOf(x); rv.Kind() {
		case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64:
			return rv.Int()
		case reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64:
			return int64(rv.Uint())
		case reflect.Float32, reflect.Float64:
			return rv.Float()
		case reflect.String:
			return truncateRunes(rv.String(), 512)
		default:
			return fmt.Sprintf("%v", truncateRunes(fmt.Sprint(x), 128))
		}
	}
}

func truncateRunes(s string, n int) string {
	if len(s) <= n {
		return s
	}
	r := []rune(s)
	if len(r) <= n {
		// multibyte head cut — fall back to rune-safe slice
		return string(r)
	}
	if n > 4 {
		return string(r[:n-1]) + "…"
	}
	return string(r[:n])
}

// emitSpanEvent mirrors the event onto the ctx's active span (a no-op
// when nothing is recording — the noop tracer's IsRecording is false).
func emitSpanEvent(ctx context.Context, e Event) {
	span := trace.SpanFromContext(ctx)
	if !span.IsRecording() {
		return
	}
	attrs := make([]attribute.KeyValue, 0, len(e.Data)+4)
	if e.Provider != "" {
		attrs = append(attrs, attribute.String(KeyProvider, e.Provider))
		attrs = append(attrs, attribute.String(KeySystem, e.Provider))
	}
	if e.Model != "" {
		attrs = append(attrs, attribute.String(KeyRequestModel, e.Model))
	}
	if e.Round != 0 {
		attrs = append(attrs, attribute.Int(KeyRound, e.Round))
	}
	if e.SessionID != "" {
		attrs = append(attrs, attribute.String(KeySessionID, e.SessionID))
	}
	if e.Turn != 0 {
		attrs = append(attrs, attribute.Int64(KeyTurn, e.Turn))
	}
	for k, v := range e.Data {
		switch x := v.(type) {
		case string:
			attrs = append(attrs, attribute.String("doom."+k, x))
		case int:
			attrs = append(attrs, attribute.Int("doom."+k, x))
		case int64:
			attrs = append(attrs, attribute.Int64("doom."+k, x))
		case float64:
			attrs = append(attrs, attribute.Float64("doom."+k, x))
		case bool:
			attrs = append(attrs, attribute.Bool("doom."+k, x))
		}
	}
	span.AddEvent(string(e.Kind), trace.WithAttributes(attrs...))
}

// ── the hook registry ────────────────────────────────────────────────────

type hookEntry struct {
	name string
	fn   func(Event)
}

var (
	hookMu     sync.RWMutex
	hookSerial int
	hooks      = map[int]hookEntry{}
)

// Subscribe registers a named hook receiving every event. Returns the
// unsubscribe func. Hooks run SYNCHRONOUSLY inside Emit (recover-guarded)
// — keep them fast or buffer internally.
func Subscribe(name string, fn func(Event)) (unsub func()) {
	hookMu.Lock()
	hookSerial++
	id := hookSerial
	hooks[id] = hookEntry{name: name, fn: fn}
	hookMu.Unlock()
	return func() {
		hookMu.Lock()
		delete(hooks, id)
		hookMu.Unlock()
	}
}

// HookCount reports the live hook count (tests).
func HookCount() int {
	hookMu.RLock()
	defer hookMu.RUnlock()
	return len(hooks)
}

func fanOut(e Event) {
	hookMu.RLock()
	entries := make([]hookEntry, 0, len(hooks))
	for _, h := range hooks {
		entries = append(entries, h)
	}
	hookMu.RUnlock()
	for _, h := range entries {
		func() {
			defer func() { _ = recover() }() // a hook never takes the turn down
			h.fn(e)
		}()
	}
}

// atomicInt64 — a tiny local atomic counter (avoids the sync/atomic
// import dance in three files).
type atomicInt64 struct {
	mu sync.Mutex
	v  int64
}

func (a *atomicInt64) Add(n int64) int64 {
	a.mu.Lock()
	a.v += n
	v := a.v
	a.mu.Unlock()
	return v
}
