package brain

// bridge_v1764_test.go — v1.76.4 THE HONEST SCANNER pins (PLAN-V176
// §v1.76.4): malformed data lines are LOGGED (first payload + stream-end
// total) instead of silently discarded, huge-but-legal lines parse inside
// the 2MiB cap, a hostile oversized line fails CLEANLY with ErrTooLong
// instead of growing memory forever, and the SSE semantics survive the
// scanner swap byte for byte (\r\n, non-data lines, [DONE], the final
// partial line).

import (
        "bufio"
        "bytes"
        "errors"
        "fmt"
        "log"
        "net/http"
        "net/http/httptest"
        "strings"
        "testing"
)

// TestV1764_MalformedLinesAreLoggedNotFatal — the conviction: the old loop
// DISCARDED json.Unmarshal errors, so a truncated line (Wi-Fi cut mid-JSON)
// or a Python serialization bug vanished without a trace. Now: first line
// logged with payload, total at stream end, valid events still flow.
func TestV1764_MalformedLinesAreLoggedNotFatal(t *testing.T) {
        srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
                w.Header().Set("Content-Type", "text/event-stream")
                fmt.Fprint(w, "data: {broken json\n\n")
                fmt.Fprint(w, "data: {\"type\":\"thinking\",\"text\":\"still alive\"}\n\n")
                fmt.Fprint(w, "data: [also broken\n\n")
                fmt.Fprint(w, "data: [DONE]\n\n")
        }))
        defer srv.Close()

        var buf bytes.Buffer
        log.SetOutput(&buf)
        log.SetFlags(0)
        defer log.SetOutput(nil) // restore the default (stderr)

        b := &Brain{url: srv.URL, healthy: true}
        events, errs, err := b.Chat(t.Context(), map[string]any{"message": "hi"})
        if err != nil {
                t.Fatalf("Chat: %v", err)
        }
        n := 0
        for ev := range events {
                n++
                if ev["type"] != "thinking" {
                        t.Fatalf("the valid event must flow through, got %+v", ev)
                }
        }
        if e := <-errs; e != nil {
                t.Fatalf("malformed lines are diagnostic, not fatal: errs = %v", e)
        }
        if n != 1 {
                t.Fatalf("events = %d, want 1", n)
        }
        logged := buf.String()
        if !strings.Contains(logged, "malformed SSE data line #1") {
                t.Fatalf("the first malformed line must be logged, log: %q", logged)
        }
        if !strings.Contains(logged, "{broken json") {
                t.Fatalf("the log must carry the payload for diagnosis, log: %q", logged)
        }
        if !strings.Contains(logged, "2 malformed SSE data lines total") {
                t.Fatalf("the stream end must report the total, log: %q", logged)
        }
}

// TestV1764_LongLineParses — a 300KB single data line (a big tool_result
// through a slow link) parses fine: the scanner's 64KB start buffer grows
// inside the 2MiB cap where the old loop reallocated per 4KB chunk.
func TestV1764_LongLineParses(t *testing.T) {
        big := strings.Repeat("x", 300*1024)
        srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
                w.Header().Set("Content-Type", "text/event-stream")
                fmt.Fprintf(w, "data: {\"type\":\"tool_result\",\"text\":\"%s\"}\n\n", big)
                fmt.Fprint(w, "data: [DONE]\n\n")
        }))
        defer srv.Close()

        b := &Brain{url: srv.URL, healthy: true}
        events, errs, err := b.Chat(t.Context(), map[string]any{"message": "hi"})
        if err != nil {
                t.Fatalf("Chat: %v", err)
        }
        var got int
        for ev := range events {
                got++
                if s, _ := ev["text"].(string); len(s) != len(big) {
                        t.Fatalf("the 300KB payload must arrive whole, got %d bytes", len(s))
                }
        }
        if e := <-errs; e != nil {
                t.Fatalf("errs = %v", e)
        }
        if got != 1 {
                t.Fatalf("events = %d, want 1", got)
        }
}

// TestV1764_OversizedLineFailsCleanly — a hostile/hung stream that never
// newlines past the 2MiB cap fails with bufio.ErrTooLong on errs instead
// of growing buf without bound (the old loop's unbounded memory class).
func TestV1764_OversizedLineFailsCleanly(t *testing.T) {
        srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
                w.Header().Set("Content-Type", "text/event-stream")
                chunk := strings.Repeat("a", 64*1024)
                for i := 0; i < 60; i++ { // 60 * 64KB = 3.75MB on ONE line
                        fmt.Fprint(w, chunk)
                        w.(http.Flusher).Flush()
                }
        }))
        defer srv.Close()

        b := &Brain{url: srv.URL, healthy: true}
        events, errs, err := b.Chat(t.Context(), map[string]any{"message": "hi"})
        if err != nil {
                t.Fatalf("Chat: %v", err)
        }
        for range events {
        } // closes with the error
        e := <-errs
        if !errors.Is(e, bufio.ErrTooLong) {
                t.Fatalf("oversized line must fail with ErrTooLong, got %v", e)
        }
}

// TestV1764_SemanticsUnchanged — the scanner swap preserves the wire laws:
// \r\n endings (TrimSpace law), non-data lines ignored, [DONE] terminates,
// and a final partial line at EOF is now DELIVERED (the one documented
// strictness gain).
func TestV1764_SemanticsUnchanged(t *testing.T) {
        srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
                w.Header().Set("Content-Type", "text/event-stream")
                fmt.Fprint(w, ": keep-alive comment\r\n")
                fmt.Fprint(w, "event: ping\r\n")
                fmt.Fprint(w, "data: {\"type\":\"a\"}\r\n")
                fmt.Fprint(w, "data: [DONE]") // final line, NO trailing newline
        }))
        defer srv.Close()

        b := &Brain{url: srv.URL, healthy: true}
        events, errs, err := b.Chat(t.Context(), map[string]any{"message": "hi"})
        if err != nil {
                t.Fatalf("Chat: %v", err)
        }
        n := 0
        for range events {
                n++
        }
        if e := <-errs; e != nil {
                t.Fatalf("clean [DONE] end must be error-free, errs = %v", e)
        }
        if n != 1 {
                t.Fatalf("events = %d, want 1 (the \\r\\n line + the partial [DONE] both handled)", n)
        }
}
