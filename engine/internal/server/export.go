package server

// export.go — v0.16 GET /api/sessions/{id}/export.{csv,md,json}
//
// The user asked for saved chat logs they can review ("If to save the chat
// you must add a method to export as cvs or whatever, then do so and add
// that capability to the app"). The engine renders the session's event log
// into three review formats straight from the source of truth:
//
//   .csv  — one row per conversation turn: seq, time, type, text
//            (spreadsheet-friendly; assistant_delta fragments are FOLDED
//            into the full reply, exactly like buildHistory folds them)
//   .md   — a readable transcript (You / <bot> blocks, collapsible
//            thinking, sources as links) with session metadata header
//   .json — the raw session + event log (machine-readable backup)
//
// Content-Disposition: attachment → the WebView's DownloadListener hands
// the URL to the system browser, which pulls it from the local engine.

import (
	"encoding/csv"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/ScoobyBaby1999/doomalay/engine/internal/store"
)

// foldedRow is one display row after folding the raw event stream.
type foldedRow struct {
	Seq    int
	Type   string // user | assistant | thinking | tool | sources | error
	Text   string
	At     float64
	Srcs   []map[string]string // sources rows only
	Hidden bool                // status rows: kept in json, hidden in csv/md
}

// foldEvents folds the raw event log into display rows (v0.16).
// assistant_delta fragments merge into one assistant row; the trailing
// full-reply "assistant" event (emitted at turn end) is deduped against
// the assembled deltas; consecutive thinking events merge.
func foldEvents(events []*store.Event) []foldedRow {
	var rows []foldedRow
	var curAssistant *foldedRow
	var curThinking *foldedRow
	assembled := ""

	for _, ev := range events {
		switch ev.EventType {
		case "user":
			curAssistant, curThinking = nil, nil
			rows = append(rows, foldedRow{Seq: ev.Seq, Type: "user", Text: ev.Content, At: ev.CreatedAt})
		case "assistant_delta":
			curThinking = nil
			if curAssistant == nil {
				curAssistant = &foldedRow{Seq: ev.Seq, Type: "assistant", At: ev.CreatedAt}
				rows = append(rows, *curAssistant)
			}
			curAssistant.Text += ev.Content
			rows[len(rows)-1] = *curAssistant
			assembled += ev.Content
		case "assistant":
			// Full reply at turn end — skip when the deltas already
			// assembled it (live turn); add when it's replay-only.
			if ev.Content != "" && !strings.Contains(assembled, ev.Content) {
				curAssistant = nil
				rows = append(rows, foldedRow{Seq: ev.Seq, Type: "assistant", Text: ev.Content, At: ev.CreatedAt})
			}
		case "thinking":
			curAssistant = nil
			if curThinking == nil {
				curThinking = &foldedRow{Seq: ev.Seq, Type: "thinking", At: ev.CreatedAt}
				rows = append(rows, *curThinking)
			}
			curThinking.Text += ev.Content
			rows[len(rows)-1] = *curThinking
		case "tool_use", "tool_result":
			curAssistant, curThinking = nil, nil
			rows = append(rows, foldedRow{Seq: ev.Seq, Type: "tool", Text: ev.Content, At: ev.CreatedAt})
		case "sources":
			var srcs []map[string]string
			var parsed []struct {
				Title   string `json:"title"`
				URL     string `json:"url"`
				Snippet string `json:"snippet"`
			}
			if json.Unmarshal([]byte(ev.Content), &parsed) == nil {
				for _, p := range parsed {
					srcs = append(srcs, map[string]string{"title": p.Title, "url": p.URL, "snippet": p.Snippet})
				}
			} else {
				srcs = append(srcs, map[string]string{"title": ev.Content})
			}
			rows = append(rows, foldedRow{Seq: ev.Seq, Type: "sources", Srcs: srcs, At: ev.CreatedAt})
		case "error":
			rows = append(rows, foldedRow{Seq: ev.Seq, Type: "error", Text: ev.Content, At: ev.CreatedAt})
		case "status":
			rows = append(rows, foldedRow{Seq: ev.Seq, Type: "status", Text: ev.Content, At: ev.CreatedAt, Hidden: true})
		}
	}
	return rows
}

func isoTime(unix float64) string {
	if unix <= 0 {
		return ""
	}
	return time.Unix(int64(unix), 0).UTC().Format(time.RFC3339)
}

func slugTitle(s *store.Session) string {
	t := strings.ToLower(strings.TrimSpace(s.Title))
	var b strings.Builder
	for _, r := range t {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') {
			b.WriteRune(r)
		} else if b.Len() > 0 && !strings.HasSuffix(b.String(), "-") {
			b.WriteRune('-')
		}
	}
	out := strings.Trim(b.String(), "-")
	if len(out) > 40 {
		out = out[:40]
	}
	if out == "" {
		out = "chat"
	}
	return out
}

// handleSessionExport is GET /api/sessions/{id}/export.{fmt}.
func (s *Server) handleSessionExport(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	format := strings.TrimPrefix(r.URL.Path, "/api/sessions/"+id+"/export.")
	format = strings.ToLower(strings.TrimPrefix(format, "."))

	sess, err := s.db.GetSession(id)
	if err != nil || sess == nil {
		writeError(w, 404, "session not found")
		return
	}
	events, err := s.db.ListEvents(id, 0)
	if err != nil {
		writeError(w, 500, "events: "+err.Error())
		return
	}

	name := fmt.Sprintf("doomalay-%s-%s", slugTitle(sess), id[:min(8, len(id))])

	switch format {
	case "csv":
		w.Header().Set("Content-Type", "text/csv; charset=utf-8")
		w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=%q", name+".csv"))
		ww := csv.NewWriter(w)
		ww.Write([]string{"seq", "time_utc", "type", "text"})
		for _, row := range foldEvents(events) {
			if row.Hidden {
				continue
			}
			text := row.Text
			if row.Type == "sources" {
				var parts []string
				for _, sc := range row.Srcs {
					parts = append(parts, fmt.Sprintf("[%s](%s)", sc["title"], sc["url"]))
				}
				text = strings.Join(parts, " ")
			}
			ww.Write([]string{fmt.Sprintf("%d", row.Seq), isoTime(row.At), row.Type, text})
		}
		ww.Flush()
	case "md":
		w.Header().Set("Content-Type", "text/markdown; charset=utf-8")
		w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=%q", name+".md"))
		var b strings.Builder
		fmt.Fprintf(&b, "# %s\n\n", sess.Title)
		fmt.Fprintf(&b, "- **Chat type:** %s\n", orDash(sess.Sandbox))
		fmt.Fprintf(&b, "- **Provider:** %s\n", orDash(sess.Provider))
		fmt.Fprintf(&b, "- **Model:** %s\n", orDash(sess.Model))
		if sess.Effort != "" {
			fmt.Fprintf(&b, "- **Effort:** %s\n", sess.Effort)
		}
		fmt.Fprintf(&b, "- **Memory window:** %d messages\n", or40(sess.SlidingWindow))
		fmt.Fprintf(&b, "- **Started:** %s\n", isoTime(sess.CreatedAt))
		fmt.Fprintf(&b, "- **Messages (folded):** see below\n\n---\n\n")
		for _, row := range foldEvents(events) {
			if row.Hidden {
				continue
			}
			switch row.Type {
			case "user":
				fmt.Fprintf(&b, "**You:**\n\n%s\n\n", row.Text)
			case "assistant":
				fmt.Fprintf(&b, "**Assistant:**\n\n%s\n\n", row.Text)
			case "thinking":
				fmt.Fprintf(&b, "<details>\n<summary>thinking</summary>\n\n%s\n\n</details>\n\n", row.Text)
			case "tool":
				fmt.Fprintf(&b, "> ⚙ %s\n\n", strings.TrimSpace(row.Text))
			case "sources":
				b.WriteString("**Sources:**\n\n")
				for i, sc := range row.Srcs {
					fmt.Fprintf(&b, "%d. [%s](%s)\n", i+1, sc["title"], sc["url"])
				}
				b.WriteString("\n")
			case "error":
				fmt.Fprintf(&b, "⚠️ **error:** %s\n\n", row.Text)
			}
		}
		w.Write([]byte(b.String()))
	case "json":
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=%q", name+".json"))
		if events == nil {
			events = []*store.Event{} // a nil slice marshals as null — keep [] shape
		}
		out := struct {
			Session *store.Session `json:"session"`
			Events  []*store.Event `json:"events"`
		}{Session: sess, Events: events}
		enc := json.NewEncoder(w)
		enc.SetIndent("", "  ")
		enc.SetEscapeHTML(false)
		enc.Encode(out)
	default:
		writeError(w, 400, "format must be csv, md or json")
	}
}

func orDash(s string) string {
	if strings.TrimSpace(s) == "" {
		return "—"
	}
	return s
}

func or40(n int) int {
	if n <= 0 {
		return 40
	}
	return n
}
