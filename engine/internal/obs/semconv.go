// semconv.go — the GenAI semantic-convention surface (v1.14.4 THE TRACE).
//
// Hand-rolled attribute keys (the gen_ai namespace is stable string
// territory) instead of pinning a semconv package version — the engine
// ships on Android and every dep is audited. The shape follows the OTel
// GenAI semconv: CLIENT spans named `chat <model>`, tool execution spans
// named `execute_tool <name>`, and the two defined metrics:
//
//	gen_ai.client.operation.duration  (histogram, seconds)
//	gen_ai.client.token.usage         (histogram, tokens, by gen_ai.token.type)
package obs

import (
	"context"
	"sync"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/metric"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/trace"
)

// The GenAI semconv attribute keys this engine sets.
const (
	KeySystem             = "gen_ai.system"
	KeyOperation          = "gen_ai.operation.name"
	KeyRequestModel       = "gen_ai.request.model"
	KeyRequestMaxTokens   = "gen_ai.request.max_tokens"
	KeyRequestTemperature = "gen_ai.request.temperature"
	KeyResponseModel      = "gen_ai.response.model"
	KeyFinishReasons      = "gen_ai.response.finish_reasons"
	KeyUsageInputTokens   = "gen_ai.usage.input_tokens"
	KeyUsageOutputTokens  = "gen_ai.usage.output_tokens"
	KeyToolName           = "gen_ai.tool.name"
	KeyToolCallID         = "gen_ai.tool.call.id"
	KeyToolType           = "gen_ai.tool.type"
	KeyTokenUsage         = "gen_ai.client.token.usage" // metric
	KeyOpDuration         = "gen_ai.client.operation.duration"
)

// The engine-native attribute keys (no semconv claim — these are ours).
const (
	KeySessionID  = "doom.session_id"
	KeyTurn       = "doom.turn"
	KeyRound      = "doom.round"
	KeyProvider   = "doom.provider" // the engine's provider id (gen_ai.system mirrors it)
	KeyPath       = "doom.path"     // turn dispatch path: native_tools / web_plugin / plain / deep_research / brain
	KeyOutputCut  = "doom.output_cut"
	KeyFinishRaw  = "doom.finish_reason"
	KeyDeltas     = "doom.deltas" // "reasoning=12 content=340 tool_call=3" tallies
	KeyGuardPct   = "doom.context_pct"
	KeyErrorKind  = "error.type"
	KeyBodyBytes  = "doom.request_bytes"
	KeyRetryWait  = "doom.retry_wait_ms"
	KeyStatus     = "http.response.status_code"
	KeyCached     = "doom.tool_cached"
	KeySkipped    = "doom.tool_skipped"
	KeyFault      = "doom.tool_fault"
	KeyArtifact   = "doom.tool_artifact"
	KeyObsBytes   = "doom.tool_observation_bytes"
	KeyDurationMS = "doom.duration_ms"
)

// StartTurnSpan opens the per-turn root span (`turn`). The ctx it returns
// carries it — every span and event inside the turn descends from here.
func StartTurnSpan(ctx context.Context, sessionID, provider, model, path string) (context.Context, trace.Span) {
	return tracer.Start(ctx, "turn",
		trace.WithSpanKind(trace.SpanKindInternal),
		trace.WithAttributes(
			attribute.String(KeySessionID, sessionID),
			attribute.String(KeySystem, provider),
			attribute.String(KeyProvider, provider),
			attribute.String(KeyRequestModel, model),
			attribute.String(KeyPath, path),
		),
	)
}

// StartChatSpan opens the GenAI client span for ONE upstream completion
// (`chat <model>` — the semconv span-name convention) and returns a
// *ChatSpan handle. The handle owns two duties: End() stamps the
// response-side semconv attrs and unregisters the session slot, and the
// registration itself lets the bus Observer's tool spans (which arrive
// without a ctx) parent to this span. bodyHead (optional, "" to skip)
// records the outgoing request JSON head for wire debugging —
// DOOM_TRACE_BODIES=1 in the caller.
type ChatSpan struct {
	sp        trace.Span
	sessionID string
	gen       int64
}

func StartChatSpan(ctx context.Context, sessionID, provider, model string, maxTokens int, bodyHead string) (context.Context, *ChatSpan) {
	attrs := []attribute.KeyValue{
		attribute.String(KeySystem, provider),
		attribute.String(KeyProvider, provider),
		attribute.String(KeyRequestModel, model),
		attribute.String(KeyOperation, "chat"),
		attribute.Bool("stream", true),
	}
	if maxTokens > 0 {
		attrs = append(attrs, attribute.Int(KeyRequestMaxTokens, maxTokens))
	}
	if bodyHead != "" {
		attrs = append(attrs, attribute.String("doom.request_body_head", bodyHead))
	}
	cctx, span := tracer.Start(ctx, "chat "+model,
		trace.WithSpanKind(trace.SpanKindClient),
		trace.WithAttributes(attrs...),
	)
	cs := &ChatSpan{sp: span, sessionID: sessionID}
	if sessionID != "" {
		cs.gen = setChatSpan(sessionID, span)
	}
	return cctx, cs
}

// End finishes the chat span with the response-side semconv attrs (finish
// reason, token usage, delta tallies) and unregisters the session slot
// (only if it still points at THIS span — a newer turn's span wins).
func (cs *ChatSpan) End(finishReason string, outputCut bool, inTok, outTok int, tally string) {
	cs.sp.SetAttributes(
		attribute.String(KeySessionID, cs.sessionID),
		attribute.String(KeyFinishRaw, finishReason),
		attribute.Bool(KeyOutputCut, outputCut),
		attribute.Int(KeyUsageInputTokens, inTok),
		attribute.Int(KeyUsageOutputTokens, outTok),
		attribute.String(KeyDeltas, tally),
	)
	if finishReason != "" {
		cs.sp.SetAttributes(attribute.StringSlice(KeyFinishReasons, []string{finishReason}))
	}
	if cs.sessionID != "" {
		clearChatSpan(cs.sessionID, cs.gen)
	}
	cs.sp.End()
}

// StartToolSpan opens an `execute_tool <name>` child span from an explicit
// ctx (the direct-dispatch path in the turn runner — ctx carries the chat
// span). The bus Observer path uses StartSessionToolSpan below.
func StartToolSpan(ctx context.Context, name, callID string) (context.Context, trace.Span) {
	attrs := []attribute.KeyValue{
		attribute.String(KeyToolName, name),
		attribute.String(KeyToolType, "function"),
		attribute.String(KeyOperation, "execute_tool"),
	}
	if callID != "" {
		attrs = append(attrs, attribute.String(KeyToolCallID, callID))
	}
	return tracer.Start(ctx, "execute_tool "+name,
		trace.WithSpanKind(trace.SpanKindInternal),
		trace.WithAttributes(attrs...),
	)
}

// ── the session → active chat span registry ─────────────────────────────
// The mcpbus Observer interface carries no context (it predates the trace
// wave), so the bus-adapter tool spans parent to the session's CURRENT
// chat span instead. One tool executes at a time per session turn, and
// the server serializes turns per session, so one span per session is
// the whole truth.

var (
	spanMu     sync.Mutex
	sessionSpn = map[string]chatSpanEntry{}
	spanGen    int64
)

type chatSpanEntry struct {
	sp  trace.Span
	gen int64
}

func setChatSpan(sessionID string, sp trace.Span) int64 {
	if sessionID == "" || sp == nil {
		return 0
	}
	spanMu.Lock()
	spanGen++
	g := spanGen
	sessionSpn[sessionID] = chatSpanEntry{sp: sp, gen: g}
	spanMu.Unlock()
	return g
}

func clearChatSpan(sessionID string, gen int64) {
	spanMu.Lock()
	if cur, ok := sessionSpn[sessionID]; ok && cur.gen == gen {
		delete(sessionSpn, sessionID)
	}
	spanMu.Unlock()
}

func chatSpanFor(sessionID string) trace.Span {
	spanMu.Lock()
	defer spanMu.Unlock()
	return sessionSpn[sessionID].sp
}

// ── the two GenAI semconv metrics ────────────────────────────────────────

var (
	mOpDuration metric.Float64Histogram
	mTokenUsage metric.Float64Histogram
	metricsOnce sync.Once
)

func initMetrics() {
	metricsOnce.Do(func() {
		meter := otel.Meter("doomalay/engine")
		mOpDuration, _ = meter.Float64Histogram(KeyOpDuration,
			metric.WithUnit("s"),
			metric.WithDescription("GenAI operation duration"),
			metric.WithExplicitBucketBoundaries(0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300, 600),
		)
		mTokenUsage, _ = meter.Float64Histogram(KeyTokenUsage,
			metric.WithUnit("{token}"),
			metric.WithDescription("GenAI token usage by type"),
			metric.WithExplicitBucketBoundaries(1, 10, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 50000, 200000),
		)
	})
}

// RecordChatMetrics feeds the two GenAI histograms after one upstream
// completion. No-op until the SDK is up (no-op instruments swallow it).
func RecordChatMetrics(provider, model string, d time.Duration, inTok, outTok int) {
	initMetrics()
	base := []attribute.KeyValue{
		attribute.String(KeySystem, provider),
		attribute.String(KeyRequestModel, model),
		attribute.String(KeyOperation, "chat"),
	}
	if mOpDuration != nil {
		mOpDuration.Record(context.Background(), d.Seconds(),
			metric.WithAttributeSet(attribute.NewSet(base...)))
	}
	if mTokenUsage != nil {
		inAttrs := metric.WithAttributeSet(attribute.NewSet(append(append([]attribute.KeyValue{}, base...),
			attribute.String("gen_ai.token.type", "input"))...))
		outAttrs := metric.WithAttributeSet(attribute.NewSet(append(append([]attribute.KeyValue{}, base...),
			attribute.String("gen_ai.token.type", "output"))...))
		mTokenUsage.Record(context.Background(), float64(inTok), inAttrs)
		mTokenUsage.Record(context.Background(), float64(outTok), outAttrs)
	}
}

// defaultPropagators builds the W3C tracecontext + baggage propagator set
// (kept here so obs.go stays setup-only).
func defaultPropagators() propagation.TextMapPropagator {
	return propagation.NewCompositeTextMapPropagator(
		propagation.TraceContext{},
		propagation.Baggage{},
	)
}
