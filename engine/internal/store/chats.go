package store

import (
	"encoding/json"
	"strings"
)

// ChatListItem is one row of GET /api/chats — the All-Chats index.
//
// The canvas shows chats as icons, but icons can be deleted while their
// sessions live on (and deep-research chats never materialize one until
// jumped to). This is the "browse every conversation" surface: a preview
// of where each chat left off, most recently active first — the
// WhatsApp/Telegram sidebar pattern adapted to the canvas.
type ChatListItem struct {
	SessionID   string  `json:"session_id"`
	Title       string  `json:"title"`
	Model       string  `json:"model"`
	Provider    string  `json:"provider"`
	Sandbox     string  `json:"sandbox"`
	UpdatedAt   float64 `json:"updated_at"`
	MsgCount    int     `json:"msg_count"`    // visible user+assistant events
	Preview     string  `json:"preview"`      // latest visible transcript text ("" if none)
	PreviewRole string  `json:"preview_role"` // "user" | "assistant" | ""
}

// previewTailLen — how many trailing user/assistant events to fetch per
// session when hunting for a visible preview. Deletes always append hide
// events AFTER their targets, so the newest VISIBLE message is within the
// last few in every realistic case; if a user hides all of them the
// preview honestly reads as empty (count stays exact via the ids pass).
const previewTailLen = 8

// ListChats returns every session (updated_at DESC, at most limit) with
// its VISIBLE message count and the latest visible transcript line as a
// preview. Hide-masked events (delete / edit / regenerate) are excluded
// with the same semantics as buildHistory: 'hide' events carry a JSON
// array of masked event ids.
//
// Three queries total, no N+1: (1) the session headers, (2) one ids-only
// pass over user/assistant events for exact counts, (3) the preview tail
// (last 8 with content) for the sessions that need it — plus best-effort
// hide-list reads (a hide-parse failure never fails the listing).
func (db *DB) ListChats(limit int) ([]*ChatListItem, error) {
	if limit <= 0 {
		limit = 200
	}
	rows, err := db.Query(`
SELECT id, title, model, provider, sandbox, updated_at
FROM chat_sessions
ORDER BY updated_at DESC
LIMIT ?`, limit)
	if err != nil {
		return nil, err
	}
	items := []*ChatListItem{}
	sessIndex := map[string]*ChatListItem{}
	for rows.Next() {
		var it ChatListItem
		if err := rows.Scan(&it.SessionID, &it.Title, &it.Model, &it.Provider, &it.Sandbox, &it.UpdatedAt); err != nil {
			rows.Close()
			return nil, err
		}
		items = append(items, &it)
		sessIndex[it.SessionID] = &it
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(items) == 0 {
		return items, nil
	}

	// Hidden-id sets per session (best-effort, exactly like search.go).
	hidden := db.hiddenSets(sessIDs(items))

	// One ids-only pass for exact visible counts. Local scale: a few
	// thousand (session, id) int pairs — instant, and immune to the
	// hide-tail edge cases the preview's 8-deep lookback can't see.
	crows, err := db.Query(`
SELECT session_id, id, event_type FROM chat_events
WHERE event_type IN ('user','assistant')
ORDER BY id ASC`)
	if err != nil {
		return nil, err
	}
	for crows.Next() {
		var sid, etype string
		var eid int64
		if err := crows.Scan(&sid, &eid, &etype); err != nil {
			crows.Close()
			return nil, err
		}
		it, ok := sessIndex[sid]
		if !ok {
			continue // a session beyond the limit — not our row
		}
		if hidden[sid][eid] {
			continue
		}
		it.MsgCount++
	}
	crows.Close()
	if err := crows.Err(); err != nil {
		return nil, err
	}

	// Preview tail: the newest visible transcript line. Only sessions
	// with at least one visible message need the tail query.
	var needPreview []string
	for _, it := range items {
		if it.MsgCount > 0 {
			needPreview = append(needPreview, it.SessionID)
		}
	}
	for _, sid := range needPreview {
		if pv, role, ok := db.latestVisible(sid, hidden[sid]); ok {
			sessIndex[sid].Preview = pv
			sessIndex[sid].PreviewRole = role
		}
	}
	return items, nil
}

// latestVisible walks the last previewTailLen user/assistant events of a
// session (newest first) and returns the first one not hidden.
func (db *DB) latestVisible(sessionID string, hidden map[int64]bool) (string, string, bool) {
	rows, err := db.Query(`
SELECT id, event_type, content FROM chat_events
WHERE session_id = ? AND event_type IN ('user','assistant')
ORDER BY id DESC LIMIT ?`, sessionID, previewTailLen)
	if err != nil {
		return "", "", false
	}
	defer rows.Close()
	for rows.Next() {
		var eid int64
		var etype, content string
		if err := rows.Scan(&eid, &etype, &content); err != nil {
			return "", "", false
		}
		if hidden[eid] {
			continue
		}
		return content, etype, true
	}
	return "", "", false
}

// hiddenSets reads every session's 'hide' events into id sets. Best
// effort: a malformed hide payload skips that event, never the listing.
func (db *DB) hiddenSets(ids []string) map[string]map[int64]bool {
	out := map[string]map[int64]bool{}
	for _, sid := range ids {
		rows, err := db.Query(
			`SELECT content FROM chat_events WHERE event_type='hide' AND session_id=?`, sid)
		if err != nil {
			continue
		}
		set := map[int64]bool{}
		for rows.Next() {
			var content string
			if err := rows.Scan(&content); err != nil || content == "" {
				continue
			}
			var masked []int64
			if json.Unmarshal([]byte(content), &masked) == nil {
				for _, id := range masked {
					set[id] = true
				}
			}
		}
		rows.Close()
		if len(set) > 0 {
			out[sid] = set
		}
	}
	return out
}

func sessIDs(items []*ChatListItem) []string {
	ids := make([]string, 0, len(items))
	for _, it := range items {
		ids = append(ids, it.SessionID)
	}
	return ids
}

// TrimPreview clamps a preview to max runes with an ellipsis — the
// caller (the HTTP handler) owns the wire length policy.
func TrimPreview(s string, max int) string {
	if max <= 0 {
		max = 140
	}
	r := []rune(strings.TrimSpace(s))
	if len(r) <= max {
		return string(r)
	}
	return string(r[:max]) + "…"
}
