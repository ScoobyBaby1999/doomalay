// debugtrace.go — v1.14.4 THE TRACE: the no-OTel debugging surface.
//
// GET /api/debug/trace            → live sessions + the resolved posture
// GET /api/debug/trace?session=X  → that session's event tail (oldest first)
//                                   (+limit=N, default 200; kind=FILTER to keep one kind)
// DELETE /api/debug/trace         → drop every ring
//
// The ring is in-memory (512 events / session, 128 sessions) — restart
// clears it. For the durable waterfall, point OTEL_EXPORTER_OTLP_ENDPOINT
// at a sink (docs/TRACE.md — Langfuse v3 first).
package server

import (
        "net/http"
        "strconv"
        "strings"

        "github.com/ScoobyBaby1999/doomalay/engine/internal/buildinfo"
        "github.com/ScoobyBaby1999/doomalay/engine/internal/obs"
)

func (s *Server) handleDebugTrace(w http.ResponseWriter, r *http.Request) {
        writeJSON(w, http.StatusOK, map[string]any{
                "config": map[string]any{
                        "service_name":   obs.Configured().ServiceName,
                        "otlp_endpoint":  obs.Configured().Endpoint, // "" = no-op (no export)
                        "delta_trace":    obs.DeltaTrace(),
                        "trace_bodies":   obs.TraceBodies(),
                        "engine_version": buildinfo.Version,
                },
                "sessions": obs.Sessions(),
                "events":   nil,
                "hint":     "add /api/debug/trace/{id} for the event tail (+limit=N, kind=<filter>)",
        })
}

func (s *Server) handleDebugTraceSession(w http.ResponseWriter, r *http.Request) {
        session := r.PathValue("id")
        limit := 200
        if n, err := strconv.Atoi(r.URL.Query().Get("limit")); err == nil && n > 0 {
                limit = n
        }
        events := obs.Snapshot(session, limit)
        if kind := r.URL.Query().Get("kind"); kind != "" {
                filtered := events[:0]
                for _, e := range events {
                        if strings.HasPrefix(string(e.Kind), kind) {
                                filtered = append(filtered, e)
                        }
                }
                events = filtered
        }
        writeJSON(w, http.StatusOK, map[string]any{
                "session": session,
                "count":   len(events),
                "events":  events,
        })
}

func (s *Server) handleDebugTraceClear(w http.ResponseWriter, r *http.Request) {
        obs.Clear()
        writeJSON(w, http.StatusOK, map[string]any{"cleared": true})
}
