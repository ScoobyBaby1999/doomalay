package store

import (
        "database/sql"
        "encoding/json"
        "time"
)

// Event is one row in the append-only chat_events log. The PWA replays
// events in seq order to reconstruct a conversation. The Go engine appends
// to this table AS THE BRAIN STREAMS EVENTS (the V0 fix — the frontend is
// no longer the sole writer of chat_events at turn-end).
type Event struct {
        ID        int64   `json:"id"`
        SessionID string  `json:"session_id"`
        Seq       int     `json:"seq"`
        EventType string  `json:"event_type"`
        Content   string  `json:"content,omitempty"`
        ToolUseID string  `json:"tool_use_id,omitempty"`
        CreatedAt float64 `json:"created_at"`
}

// AppendEvent inserts a new event with seq = max+1. Returns the inserted row.
// This is the V0 fix: backend writes events as it emits them, not the
// frontend at turn-end.
func (db *DB) AppendEvent(sessionID, eventType, content, toolUseID string) (*Event, error) {
        tx, err := db.Begin()
        if err != nil {
                return nil, err
        }
        var maxSeq sql.NullInt64
        if err := tx.QueryRow(`SELECT MAX(seq) FROM chat_events WHERE session_id=?`, sessionID).Scan(&maxSeq); err != nil {
                tx.Rollback()
                return nil, err
        }
        seq := 1
        if maxSeq.Valid {
                seq = int(maxSeq.Int64) + 1
        }
        ev := &Event{
                SessionID: sessionID,
                Seq:       seq,
                EventType: eventType,
                Content:   content,
                ToolUseID: toolUseID,
                CreatedAt: float64(time.Now().UnixMilli()) / 1000.0,
        }
        res, err := tx.Exec(`
INSERT INTO chat_events (session_id, seq, event_type, content, tool_use_id, created_at)
VALUES (?,?,?,?,?,?)`,
                ev.SessionID, ev.Seq, ev.EventType, ev.Content, ev.ToolUseID, ev.CreatedAt)
        if err != nil {
                tx.Rollback()
                return nil, err
        }
        ev.ID, _ = res.LastInsertId()
        if err := tx.Commit(); err != nil {
                return nil, err
        }
        return ev, nil
}

// ListEvents returns events for a session from `since` onward (inclusive).
// since=0 returns all events (used for full replay on session open).
func (db *DB) ListEvents(sessionID string, since int) ([]*Event, error) {
        rows, err := db.Query(`
SELECT id, session_id, seq, event_type, content, tool_use_id, created_at
FROM chat_events
WHERE session_id=? AND seq >= ?
ORDER BY seq ASC`, sessionID, since)
        if err != nil {
                return nil, err
        }
        defer rows.Close()
        var out []*Event
        for rows.Next() {
                ev := &Event{}
                if err := rows.Scan(&ev.ID, &ev.SessionID, &ev.Seq, &ev.EventType, &ev.Content, &ev.ToolUseID, &ev.CreatedAt); err != nil {
                        return nil, err
                }
                out = append(out, ev)
        }
        return out, rows.Err()
}

// EventToJSON serializes an Event for the PWA. Matches the wire format
// the PWA's streamWorker expects.
func (e *Event) ToJSON() ([]byte, error) {
        type wire struct {
                ID        int64            `json:"i"`
                Timestamp float64          `json:"ts"`
                Type      string           `json:"type"`
                Text      string           `json:"text,omitempty"`
                Name      string           `json:"name,omitempty"`
                Summary   string           `json:"summary,omitempty"`
                ToolUseID string           `json:"tool_use_id,omitempty"`
                IsError   bool             `json:"is_error,omitempty"`
                State     string           `json:"state,omitempty"`
                Usage     any              `json:"usage,omitempty"`
                Title     string           `json:"title,omitempty"`
                Sources   []map[string]any `json:"sources,omitempty"`
                SessionID string           `json:"session_id,omitempty"`
                Error     string           `json:"error,omitempty"`
                IDs       []int64          `json:"ids,omitempty"`
        }
        w := wire{
                ID:        e.ID,
                Timestamp: e.CreatedAt,
                Type:      e.EventType,
                Text:      e.Content,
                ToolUseID: e.ToolUseID,
                SessionID: e.SessionID,
        }
        // If content is a JSON object (usage, etc.), decode it into the right field.
        if e.EventType == "status" && e.Content != "" {
                var st struct {
                        State string `json:"state"`
                        Usage any    `json:"usage"`
                }
                if json.Unmarshal([]byte(e.Content), &st) == nil {
                        w.State = st.State
                        w.Usage = st.Usage
                }
        }
        // v0.37: 'hide' content is the JSON array of masked event ids — decode
        // it into the wire's ids field so replayed hides parse like live ones.
        if e.EventType == "hide" && e.Content != "" {
                var ids []int64
                if json.Unmarshal([]byte(e.Content), &ids) == nil {
                        w.IDs = ids
                }
        }
        // v0.16: "sources" content is the JSON array — decode it back into the
        // wire's sources field so REPLAYED events render the source list (live
        // turns always had it; reconnects used to lose it).
        if e.EventType == "sources" && e.Content != "" {
                var srcs []map[string]any
                if json.Unmarshal([]byte(e.Content), &srcs) == nil {
                        w.Sources = srcs
                }
        }
        return json.Marshal(w)
}
