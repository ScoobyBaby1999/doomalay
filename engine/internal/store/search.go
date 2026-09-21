package store

import (
	"encoding/json"
	"strings"
)

// SearchHit is one matching transcript event (user or assistant text).
type SearchHit struct {
	ID        int64   `json:"id"`
	SessionID string  `json:"session_id"`
	Seq       int     `json:"seq"`
	Role      string  `json:"role"` // "user" | "assistant"
	Content   string  `json:"content"`
	CreatedAt float64 `json:"created_at"`
	// Session header fields (joined in — the client groups by chat).
	Title     string  `json:"title"`
	Model     string  `json:"model"`
	Provider  string  `json:"provider"`
	UpdatedAt float64 `json:"updated_at"`
}

// escapeLike escapes LIKE wildcards so a user query with % or _ matches
// literally. Used with ESCAPE '\'.
func escapeLike(s string) string {
	s = strings.ReplaceAll(s, `\`, `\\`)
	s = strings.ReplaceAll(s, `%`, `\%`)
	s = strings.ReplaceAll(s, `_`, `\_`)
	return s
}

// SearchTranscript finds chat_events whose content matches q as a
// case-insensitive substring, across ALL sessions.
//
// Scope: only the visible transcript — event types user + assistant
// (assistant_delta is redundant: the engine always persists the full
// 'assistant' event; thinking/tools/sources/status/error are not
// transcript text).
//
// Honors 'hide' events: sessions mask deleted/edited/regenerated
// messages by appending a 'hide' event naming the hidden event ids —
// those ids are excluded here exactly like buildHistory does.
//
// Ordering: most-recently-updated session first, then ascending event
// id within a session (conversational order). The caller trims to the
// per-session / per-result caps.
//
// A local single-user app has thousands of events — the substring scan
// is instant, and substring semantics match the in-chat find bar (FTS5
// token matching would not find "entangle" inside "entanglement"; LIKE
// keeps the two search surfaces feeling identical).
func (db *DB) SearchTranscript(q string, scanCap int) ([]SearchHit, error) {
	pat := "%" + escapeLike(strings.ToLower(q)) + "%"
	rows, err := db.Query(`
SELECT e.id, e.session_id, e.seq, e.event_type, e.content, e.created_at,
       s.title, s.model, s.provider, s.updated_at
FROM chat_events e
JOIN chat_sessions s ON s.id = e.session_id
WHERE e.event_type IN ('user','assistant')
  AND LOWER(e.content) LIKE ? ESCAPE '\'
ORDER BY s.updated_at DESC, e.id ASC
LIMIT ?`, pat, scanCap)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var hits []SearchHit
	for rows.Next() {
		var h SearchHit
		if err := rows.Scan(&h.ID, &h.SessionID, &h.Seq, &h.Role, &h.Content, &h.CreatedAt,
			&h.Title, &h.Model, &h.Provider, &h.UpdatedAt); err != nil {
			return nil, err
		}
		hits = append(hits, h)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if hits == nil {
		hits = []SearchHit{}
	}

	// Collect the hidden-event ids for the matched sessions so masked
	// messages (deleted / edited / regenerated) never surface in search.
	// Best-effort: a hide-parse failure never fails the search.
	sessIDs := map[string]bool{}
	for i := range hits {
		sessIDs[hits[i].SessionID] = true
	}
	hidden := map[int64]bool{}
	for sid := range sessIDs {
		hrows, err := db.Query(
			`SELECT content FROM chat_events WHERE event_type='hide' AND session_id=?`, sid)
		if err != nil {
			continue
		}
		for hrows.Next() {
			var content string
			if err := hrows.Scan(&content); err != nil || content == "" {
				continue
			}
			// hide content is a JSON array of event ids — the same
			// shape buildHistory parses.
			var ids []int64
			if json.Unmarshal([]byte(content), &ids) == nil {
				for _, id := range ids {
					hidden[id] = true
				}
			}
		}
		hrows.Close()
	}
	if len(hidden) > 0 {
		out := hits[:0]
		for _, h := range hits {
			if !hidden[h.ID] {
				out = append(out, h)
			}
		}
		hits = out
	}
	return hits, nil
}
