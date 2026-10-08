// Package obs — v1.14.4 THE TRACE (PLAN-V114 §v1.14.2 spec; the label
// moved because the MCP wave's script commits took v1.14.2/v1.14.3).
//
// Everything the engine does gets a hook, a span, an event, or all three:
//
//   - every turn opens a `turn` span (session · provider · model · path);
//   - every upstream LLM call opens a GenAI `chat <model>` CLIENT span
//     carrying the semconv attributes (gen_ai.system, gen_ai.request.model,
//     gen_ai.request.max_tokens, gen_ai.response.finish_reasons,
//     gen_ai.usage.{input,output}_tokens) and records the two semconv
//     histograms (gen_ai.client.operation.duration, gen_ai.client.token.usage);
//   - every tool call — MCP bus or direct dispatch — opens an
//     `execute_tool <name>` child span, riding the MCP wave's Observer
//     chain (mcpbus.AddObserver — this package is its first consumer);
//   - every lifecycle moment (dispatch, rounds, upstream requests, retries,
//     provider fallbacks, capability strips, the 92% guard, stream open,
//     first token, reasoning/content/tool-call deltas, usage, finish,
//     errors) emits a typed Event through the hook bus → the per-session
//     ring buffer (GET /api/debug/trace) → every registered Go hook →
//     and, when a span is recording, onto that span's event timeline.
//
// Default posture: NO-OP. Without OTEL_EXPORTER_OTLP_ENDPOINT the OTel SDK
// never starts — zero network, zero goroutines; the only state is the
// capped per-session ring buffer. Android-safe: OTLP/HTTP only (no gRPC),
// batched export, bounded queues.
//
// Environment (all optional):
//
//      OTEL_EXPORTER_OTLP_ENDPOINT   turn on OTLP/HTTP export of traces + metrics
//                                    (e.g. http://localhost:3000/api/public/otel for Langfuse v3)
//      OTEL_EXPORTER_OTLP_HEADERS    extra headers, "key=value,key2=value2" (Langfuse: Authorization=Basic <b64 pk:sk>)
//      OTEL_SERVICE_NAME             resource service.name (default "doomalay-engine")
//      DOOM_TRACE_DELTAS             0 = counts only · 1 = heads (64 runes, default) · 2 = full delta text
//      DOOM_TRACE_BODIES             1 = record the outgoing request JSON (4KB head) on the chat span
package obs

import (
        "context"
        "fmt"
        "os"
        "runtime"
        "strings"
        "sync"
        "time"

        "github.com/ScoobyBaby1999/doomalay/engine/internal/buildinfo"

        "go.opentelemetry.io/otel"
        "go.opentelemetry.io/otel/attribute"
        "go.opentelemetry.io/otel/exporters/otlp/otlpmetric/otlpmetrichttp"
        "go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp"
        "go.opentelemetry.io/otel/sdk/metric"
        "go.opentelemetry.io/otel/sdk/resource"
        sdktrace "go.opentelemetry.io/otel/sdk/trace"
        "go.opentelemetry.io/otel/trace"
)

// Config is the resolved tracing posture (FromEnv fills it).
type Config struct {
        ServiceName string
        Endpoint    string // "" = no-op (no export, no SDK)
        Headers     map[string]string
        DeltaTrace  int  // 0 counts · 1 heads · 2 full text
        TraceBodies bool // record the request JSON head on the chat span
}

// FromEnv resolves the tracing posture from the environment (see the
// package comment for the variable table). Called once by Setup; tests
// may construct Config values directly.
func FromEnv() Config {
        cfg := Config{
                ServiceName: firstNonEmpty(os.Getenv("OTEL_SERVICE_NAME"), "doomalay-engine"),
                Endpoint:    os.Getenv("OTEL_EXPORTER_OTLP_ENDPOINT"),
                DeltaTrace:  1,
        }
        switch os.Getenv("DOOM_TRACE_DELTAS") {
        case "0":
                cfg.DeltaTrace = 0
        case "2":
                cfg.DeltaTrace = 2
        }
        if os.Getenv("DOOM_TRACE_BODIES") == "1" {
                cfg.TraceBodies = true
        }
        if h := os.Getenv("OTEL_EXPORTER_OTLP_HEADERS"); h != "" {
                cfg.Headers = map[string]string{}
                for _, pair := range strings.Split(h, ",") {
                        if k, v, ok := strings.Cut(strings.TrimSpace(pair), "="); ok && k != "" {
                                cfg.Headers[k] = v
                        }
                }
        }
        return cfg
}

var (
        cfgOnce sync.Once
        liveCfg Config
)

// Configured returns the active posture (safe to call any time; lazily
// resolves from the env on first use so tests that never call Setup still
// see the no-op default).
func Configured() Config {
        cfgOnce.Do(func() { liveCfg = FromEnv() })
        return liveCfg
}

// forceDeltaTrace overrides the env gate in tests (-1 = follow config).
var forceDeltaTrace = -1

// SetDeltaTraceForTest overrides the delta gate from other packages' tests
// (level < 0 restores the env-configured posture).
func SetDeltaTraceForTest(level int) { forceDeltaTrace = level }

// DeltaTrace reports the delta verbosity gate (0/1/2). Delta events below
// the gate are dropped from BOTH the ring and the span timeline — the
// per-round tallies still land on the finish event, so even gate 0 keeps
// the counts honest.
func DeltaTrace() int {
        if forceDeltaTrace >= 0 {
                return forceDeltaTrace
        }
        return Configured().DeltaTrace
}

// TraceBodies reports whether request bodies ride the chat span.
func TraceBodies() bool { return Configured().TraceBodies }

// Setup wires the OTel SDK when an OTLP endpoint is configured; without
// one it is a no-op (the global tracer/meter providers stay otel's
// built-in no-ops and every span/metric call below costs a branch). The
// returned shutdown flushes both pipelines — main defers it.
func Setup(ctx context.Context) (func(context.Context) error, error) {
        cfg := FromEnv()
        cfgOnce.Do(func() { liveCfg = cfg })

        shutdown := func(context.Context) error { return nil }
        if cfg.Endpoint == "" {
                return shutdown, nil
        }

        res, err := resource.New(ctx,
                resource.WithAttributes(
                        attribute.String("service.name", cfg.ServiceName),
                        attribute.String("service.version", buildinfo.Version),
                        attribute.String("process.runtime.name", "go"),
                        attribute.String("process.runtime.version", runtime.Version()),
                ),
        )
        if err != nil {
                return shutdown, fmt.Errorf("otel resource: %w", err)
        }

        traceExp, err := otlptracehttp.New(ctx,
                otlptracehttp.WithEndpointURL(cfg.Endpoint),
                otlptracehttp.WithHeaders(cfg.Headers),
                otlptracehttp.WithTimeout(10*time.Second),
        )
        if err != nil {
                return shutdown, fmt.Errorf("otel trace exporter: %w", err)
        }
        tp := sdktrace.NewTracerProvider(
                sdktrace.WithBatcher(traceExp),
                sdktrace.WithResource(res),
        )
        otel.SetTracerProvider(tp)

        metricExp, err := otlpmetrichttp.New(ctx,
                otlpmetrichttp.WithEndpointURL(cfg.Endpoint),
                otlpmetrichttp.WithHeaders(cfg.Headers),
                otlpmetrichttp.WithTimeout(10*time.Second),
        )
        if err != nil {
                return shutdown, fmt.Errorf("otel metric exporter: %w", err)
        }
        mp := metric.NewMeterProvider(
                metric.WithReader(metric.NewPeriodicReader(metricExp, metric.WithInterval(60*time.Second))),
                metric.WithResource(res),
        )
        otel.SetMeterProvider(mp)

        otel.SetTextMapPropagator(defaultPropagators())

        return func(ctx context.Context) error {
                var firstErr error
                if err := tp.Shutdown(ctx); err != nil {
                        firstErr = err
                }
                if err := mp.Shutdown(ctx); err != nil && firstErr == nil {
                        firstErr = err
                }
                return firstErr
        }, nil
}

// tracer comes from the GLOBAL provider — otel's delegating global picks
// up the SDK in Setup (or stays the no-op forever). Every span helper in
// this package goes through it, so instrumentation is always safe to call
// regardless of posture.
var tracer = otel.Tracer("doomalay/engine")

// Tracer exposes the engine tracer for call sites outside this package.
func Tracer() trace.Tracer { return tracer }

func firstNonEmpty(vals ...string) string {
        for _, v := range vals {
                if v != "" {
                        return v
                }
        }
        return ""
}
