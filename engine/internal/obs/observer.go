// observer.go — the mcpbus Observer adapter (v1.14.4 THE TRACE).
//
// The MCP wave left the hooks surface (mcpbus.Observer + Bus.AddObserver)
// with exactly one comment: "the parallel OTel/tiktoken bot can stack
// another Observer without touching this package." This file is that
// stack — the FIRST real consumer of AddObserver:
//
//   - every bus tool call opens an `execute_tool <name>` span parented to
//     the session's active chat span (the Observer carries no ctx, so the
//     session→span registry in semconv.go is the bridge);
//   - start/end/progress all become typed Events (tool.start / tool.end /
//     tool.progress) through the hook bus;
//   - timing, artifact names, error flags and observation sizes ride both.
//
// The llm package's own chunk-emission Observer contract is untouched —
// the UI byte-shape stays exactly as v1.13 shipped it.
package obs

import (
        "context"
        "sync"

        "github.com/ScoobyBaby1999/doomalay/engine/internal/mcpbus"

        "go.opentelemetry.io/otel/attribute"
        "go.opentelemetry.io/otel/trace"
)

var attachOnce sync.Once

// AttachBus registers the trace observer on the engine's MCP bus
// (idempotent — call it on every mcpBus() success; only the first wins).
func AttachBus(b *mcpbus.Bus) {
        if b == nil {
                return
        }
        attachOnce.Do(func() {
                b.AddObserver(busObserver{})
        })
}

type busObserver struct{}

func (busObserver) OnToolStart(e mcpbus.ToolStart) {
        Emit(context.Background(), Event{
                Kind:      ToolStart,
                SessionID: e.SessionID,
                Data: map[string]any{
                        "name":    e.Name,
                        "summary": e.Summary,
                },
        })
        // span: parent to the session's active chat span (root when none)
        if sp, ok := openSessionToolSpan(e.SessionID, e.Name); ok {
                _ = sp // registered in openToolSpans; OnToolEnd closes it
        }
}

func (busObserver) OnToolEnd(e mcpbus.ToolEnd) {
        Emit(context.Background(), Event{
                Kind:      ToolEnd,
                SessionID: e.SessionID,
                Data: map[string]any{
                        "name":        e.Name,
                        "duration_ms": e.DurationMS,
                        "is_error":    e.IsError,
                        "artifact":    e.Artifact,
                        "obs_bytes":   len(e.Text),
                        "sources":     len(e.Sources),
                },
        })
        closeSessionToolSpan(e.SessionID, spanEndAttrs{
                err:      e.IsError,
                duration: e.DurationMS,
                artifact: e.Artifact,
                obsBytes: len(e.Text),
        })
}

func (busObserver) OnProgress(e mcpbus.Progress) {
        Emit(context.Background(), Event{
                Kind:      ToolProgress,
                SessionID: e.SessionID,
                Data: map[string]any{
                        "text": e.Text,
                },
        })
}

// ── the session-keyed open tool-span registry ───────────────────────────
// Tool execution is sequential within a session turn (the wire loop runs
// calls in order), so ONE open tool span per session is the whole truth.
// The direct-dispatch path in nativetools.go uses the same helpers, so
// bus and direct calls share the registry.

var (
        toolSpanMu sync.Mutex
        openTool   = map[string]trace.Span{}
)

// openSessionToolSpan opens (and registers) a tool span for the session.
func openSessionToolSpan(sessionID, name string) (trace.Span, bool) {
        if sessionID == "" {
                return nil, false
        }
        toolSpanMu.Lock()
        defer toolSpanMu.Unlock()
        if _, dup := openTool[sessionID]; dup {
                return nil, false // never stack two on one session — the old one ends late, not never
        }
        parent := chatSpanFor(sessionID)
        ctx := context.Background()
        if parent != nil {
                ctx = trace.ContextWithSpan(ctx, parent)
        }
        _, sp := tracer.Start(ctx, "execute_tool "+name,
                trace.WithSpanKind(trace.SpanKindInternal),
                trace.WithAttributes(
                        attribute.String(KeyToolName, name),
                        attribute.String(KeyToolType, "function"),
                        attribute.String(KeyOperation, "execute_tool"),
                        attribute.String(KeySessionID, sessionID),
                ),
        )
        openTool[sessionID] = sp
        return sp, true
}

// spanEndAttrs carries the terminal attributes for a tool span.
type spanEndAttrs struct {
        err      bool
        duration int64 // ms
        artifact string
        obsBytes int
        extra    []attribute.KeyValue
}

func closeSessionToolSpan(sessionID string, a spanEndAttrs) {
        if sessionID == "" {
                return
        }
        toolSpanMu.Lock()
        sp, ok := openTool[sessionID]
        delete(openTool, sessionID)
        toolSpanMu.Unlock()
        if !ok {
                return
        }
        attrs := append([]attribute.KeyValue{
                attribute.Bool("error", a.err),
                attribute.Int64(KeyDurationMS, a.duration),
                attribute.Int(KeyObsBytes, a.obsBytes),
        }, a.extra...)
        if a.artifact != "" {
                attrs = append(attrs, attribute.String(KeyArtifact, a.artifact))
        }
        sp.SetAttributes(attrs...)
        if a.err {
                sp.SetAttributes(attribute.String("status.description", "tool returned an error observation"))
        }
        sp.End()
}

// SessionToolSpan is the manual-path handle: the direct-dispatch branch in
// the turn runner opens one of these, runs the tool, then MustEnd's it.
type SessionToolSpan struct {
        sessionID string
        sp        trace.Span
        name      string
}

// StartSessionToolSpan opens a tool span from the manual path (direct
// dispatch / cached repeats). The bool reports whether one opened —
// false is valid (no chat span, empty session) and MustEnd is then a no-op.
func StartSessionToolSpan(sessionID, name, callID string) (*SessionToolSpan, bool) {
        if sessionID == "" {
                return nil, false
        }
        if sp, ok := openSessionToolSpan(sessionID, name); ok {
                if callID != "" {
                        sp.SetAttributes(attribute.String(KeyToolCallID, callID))
                }
                return &SessionToolSpan{sessionID: sessionID, sp: sp, name: name}, true
        }
        return nil, false
}

// End closes the span with the outcome attributes.
func (s *SessionToolSpan) End(err bool, obsBytes int, kvs ...any) {
        if s == nil {
                return
        }
        extra := make([]attribute.KeyValue, 0, len(kvs)/2)
        for i := 0; i+1 < len(kvs); i += 2 {
                if k, ok := kvs[i].(string); ok {
                        switch v := kvs[i+1].(type) {
                        case string:
                                extra = append(extra, attribute.String("doom."+k, v))
                        case int:
                                extra = append(extra, attribute.Int("doom."+k, v))
                        case bool:
                                extra = append(extra, attribute.Bool("doom."+k, v))
                        }
                }
        }
        closeSessionToolSpan(s.sessionID, spanEndAttrs{err: err, obsBytes: obsBytes, extra: extra})
}
