# THE TRACE — everything the bot does has a hook (v1.14.4)

> PLAN-V114 §v1.14.2 spec, shipped as **v1.14.4** (the MCP wave's script
> commits took the v1.14.2/v1.14.3 labels). The design rule: **every
> lifecycle moment of every turn is observable three ways at once** —
> a typed Event on the hook bus, a per-session ring entry (no OTel
> needed), and a span event on the active OTel span (when a sink is
> wired). Nothing blocks the turn: emit is synchronous and bounded, the
> span layer is a no-op until configured.

## The span model (the Langfuse waterfall)

```
turn  (session · provider · model · path)                    ← every turn, all paths
├── turn.start / turn.dispatch / llm.guard / llm.error / turn.end events
├── chat <model>  (GenAI CLIENT span)                        ← every upstream completion
│   ├── gen_ai.system · gen_ai.request.model · gen_ai.request.max_tokens
│   ├── llm.request → llm.retry → llm.fallback → llm.strip → llm.stream.open
│   ├── llm.first_token
│   ├── delta.reasoning · delta.content · delta.tool_call   ← DOOM_TRACE_DELTAS gate
│   ├── llm.finish (finish_reason · output_cut · usage · delta tallies)
│   └── gen_ai.response.finish_reasons · gen_ai.usage.{input,output}_tokens
│       └── execute_tool <name>  (per tool call, bus OR direct dispatch)
│           ├── tool.start / tool.progress / tool.end
│           └── error · doom.duration_ms · doom.tool_artifact · doom.tool_observation_bytes
└── metrics: gen_ai.client.operation.duration · gen_ai.client.token.usage (by type)
```

The tool spans ride the **MCP wave's Observer chain** — `obs.AttachBus`
is the first consumer of `mcpbus.Bus.AddObserver` (the extension point
the v1.13 bus left open). Bus tools (local, web, external MCP servers,
the PM browser bridge) and direct-dispatch calls share the same
session-keyed span registry.

## The event taxonomy (`/api/debug/trace` wire contract — add, never rename)

| kind | what | payload highlights |
|------|------|--------------------|
| `turn.start` / `turn.end` | the turn boundary (llm direct, brain, remote brain) | provider · model · panicked |
| `turn.dispatch` | which runner the dispatcher chose, and why | path · reason |
| `llm.round.start` / `llm.round.end` | tool-loop round boundary | round · messages · tools · calls · tokens |
| `llm.request` | one upstream POST attempt | url · attempt · body_bytes |
| `llm.retry` | 429/503 backoff | status · attempt · wait_ms |
| `llm.fallback` | model-gone provider rotation | from_provider · provider · model |
| `llm.tools_rejected` | provider 400'd a tools request | provider · model |
| `llm.strip` | capability strip retry (effort / max_tokens) | what |
| `llm.stream.open` | provider answered 200 | status |
| `llm.first_token` | the first real delta of the stream | kind (delta / tool_call) |
| `llm.guard` | the 92% context guard spoke | used · limit · pct |
| `llm.notice` | progress notices (nudge, budget) | text |
| `delta.reasoning` / `delta.content` / `delta.tool_call` | stream fragments (gated) | len · head (or text at gate 2) · chunk (tool args) |
| `tool.start` / `tool.end` / `tool.progress` | tool lifecycle | name · summary · duration_ms · cached · skipped · direct · obs_bytes |
| `tool.fault` | cut/malformed arguments (the honesty line) | fault · call_id |
| `llm.finish` | the completion's terminal verdict | finish_reason · output_cut · tokens · delta tallies · duration_ms |
| `llm.usage` | (reserved for explicit usage records) | |
| `llm.error` | anything that failed | where · error |

## The no-OTel path (works on the phone, zero infrastructure)

```bash
# live sessions + resolved posture
curl localhost:8080/api/debug/trace
# one session's tail (oldest first; +limit=N, kind=delta. to filter)
curl 'localhost:8080/api/debug/trace/<session-id>?limit=200&kind=llm.'
# reset
curl -X DELETE localhost:8080/api/debug/trace
```

The ring holds **512 events / session, 128 sessions**, deltas included
only when `DOOM_TRACE_DELTAS >= 1`, with a global flood valve. Restarts
clear it — for durability, wire a sink.

## Wiring a sink (OTLP/HTTP — traces + metrics, default OFF)

The engine never phones home unless `OTEL_EXPORTER_OTLP_ENDPOINT` is
set. Exporter is OTLP/**HTTP** (no gRPC — Android-friendly), batched.

| env | default | meaning |
|-----|---------|---------|
| `OTEL_EXPORTER_OTLP_ENDPOINT` | *(unset = no-op)* | e.g. `http://127.0.0.1:3000/api/public/otel` |
| `OTEL_EXPORTER_OTLP_HEADERS` | — | `Key=Value,Key2=Value2` (auth lives here) |
| `OTEL_SERVICE_NAME` | `doomalay-engine` | resource service.name |
| `DOOM_TRACE_DELTAS` | `1` | `0` counts only · `1` 64-rune heads · `2` full delta text |
| `DOOM_TRACE_BODIES` | off | `1` = record the request JSON head (4 KB) on the chat span |

### Langfuse v3 self-host (the first sink)

Langfuse v3 ingests OTLP natively — traces become a waterfall per
trace, the GenAI attrs power its token/cost views.

```yaml
# docker-compose.yml (minimal; see upstream langfuse/langfuse v3 compose for the full stack)
services:
  langfuse:
    image: langfuse/langfuse:3
    ports: ["3000:3000"]
    environment:
      DATABASE_URL: postgresql://postgres:postgres@postgres:5432/postgres
      NEXTAUTH_SECRET: changeme
      SALT: changeme
      # OTLP intake is served under /api/public/otel on the same port
  postgres:
    image: postgres:16
    environment:
      POSTGRES_PASSWORD: postgres
```

Point the engine at it (keys from the Langfuse project settings):

```bash
export OTEL_EXPORTER_OTLP_ENDPOINT="http://<langfuse-host>:3000/api/public/otel"
export OTEL_EXPORTER_OTLP_HEADERS="Authorization=Basic $(printf '%s' "pk-lf-...:sk-lf-..." | base64)"
```

Any OTLP/HTTP collector also works (Grafana Tempo, Jaeger all-in-one
`16686`, Seq, HyperDX…).

## The Go hook API (for consumers: tests, the PWA bridge, future sinks)

```go
// tap everything the engine does
unsub := obs.Subscribe("my-sink", func(e obs.Event) {
    log.Printf("[%s] %s turn=%d %v", e.Kind, e.SessionID, e.Turn, e.Data)
})
defer unsub()

// publish from new code — one line, three sinks (ring + hooks + span timeline)
obs.EmitS(ctx, obs.Kind("my.feature.event"), "detail", "whatever matters")
```

Rules: events are JSON-primitive (`string/int/int64/float64/bool`),
strings truncate at 512 runes, session/turn/round lift into the Event
from the ctx scope (`obs.TurnScope`) or the kv pairs. Hooks run
synchronously and recover-guarded — a panicking hook never takes a turn
down. Delta kinds respect the `DOOM_TRACE_DELTAS` gate; everything else
always emits.
