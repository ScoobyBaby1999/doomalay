package server

import (
        "net/http"
        "strings"
        "unicode/utf8"
)

// handleSearch is GET /api/search?q=<term> — GLOBAL CHAT SEARCH.
//
// Searches the visible transcript (user + assistant events) across every
// session, case-insensitive substring, honoring 'hide' masking. Returns
// results grouped by chat (most recently active first) with snippets
// centered on the first match and the match offset so the client can
// highlight it — the WhatsApp/Telegram "tap result → jump to message"
// pattern.
func (s *Server) handleSearch(w http.ResponseWriter, r *http.Request) {
        q := strings.TrimSpace(r.URL.Query().Get("q"))
        if len(q) < 2 {
                writeError(w, 400, "query too short — type at least 2 characters")
                return
        }
        if len(q) > 200 {
                q = q[:200]
        }
        hits, err := s.db.SearchTranscript(q, 500)
        if err != nil {
                writeError(w, 500, "search: "+err.Error())
                return
        }

        const (
                maxSessions = 12
                perSession  = 4
                snippetLen  = 160
        )

        type matchOut struct {
                ID         int64   `json:"id"`
                Seq        int     `json:"seq"`
                Role       string  `json:"role"`
                Ts         float64 `json:"ts"`
                Snippet    string  `json:"snippet"`
                MatchStart int     `json:"match_start"`
        }
        type sessionOut struct {
                SessionID string     `json:"session_id"`
                Title     string     `json:"title"`
                Model     string     `json:"model"`
                Provider  string     `json:"provider"`
                UpdatedAt float64    `json:"updated_at"`
                Matches   []matchOut `json:"matches"`
        }

        lq := strings.ToLower(q)
        out := make([]sessionOut, 0, 8)
        seen := map[string]*sessionOut{}
        total := 0
        for _, h := range hits {
                if len(out) >= maxSessions {
                        break
                }
                so, ok := seen[h.SessionID]
                if !ok {
                        out = append(out, sessionOut{
                                SessionID: h.SessionID,
                                Title:     h.Title,
                                Model:     h.Model,
                                Provider:  h.Provider,
                                UpdatedAt: h.UpdatedAt,
                                Matches:   []matchOut{},
                        })
                        so = &out[len(out)-1]
                        seen[h.SessionID] = so
                }
                if len(so.Matches) >= perSession {
                        continue
                }
                total++
                if total > 60 {
                        break
                }
                snip, ms := makeSnippet(h.Content, lq, snippetLen)
                so.Matches = append(so.Matches, matchOut{
                        ID: h.ID, Seq: h.Seq, Role: h.Role, Ts: h.CreatedAt,
                        Snippet: snip, MatchStart: ms,
                })
        }
        writeJSON(w, 200, map[string]any{"query": q, "results": out})
}

// makeSnippet cuts content to ~max chars centered on the first
// case-insensitive occurrence of q. Returns the snippet and the match
// offset INSIDE the snippet (for client-side <mark>). UTF-8 safe.
func makeSnippet(content, lq string, max int) (string, int) {
        if content == "" {
                return "", 0
        }
        lc := strings.ToLower(content)
        idx := strings.Index(lc, lq)
        if idx < 0 {
                // Should not happen (LIKE matched); be safe and take the head.
                r := []rune(content)
                if len(r) > max {
                        return string(r[:max]) + "…", 0
                }
                return content, 0
        }
        r := []rune(content)
        // rune-safe index of the match
        idxR := utf8.RuneCountInString(content[:idx])
        qR := utf8.RuneCountInString(lq)
        if len(r) <= max {
                return content, idxR
        }
        half := (max - qR) / 2
        if half < 0 {
                half = 0
        }
        start := idxR - half
        if start < 0 {
                start = 0
        }
        end := start + max
        if end > len(r) {
                end = len(r)
                start = end - max
                if start < 0 {
                        start = 0
                }
        }
        snip := string(r[start:end])
        prefix, suffix := "", ""
        if start > 0 {
                prefix = "…"
        }
        if end < len(r) {
                suffix = "…"
        }
        return prefix + snip + suffix, idxR - start + utf8.RuneCountInString(prefix)
}
