package store

import (
        "database/sql"
        "encoding/json"
        "strings"
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

// ListEventsTail returns the LAST `limit` events in seq order (v1.15.3 THE
// TRIM: the turn history assembly reads a bounded tail instead of the whole
// log — O(window) per turn, not O(events)). len(out) < limit means the tail
// reaches the session's head.
func (db *DB) ListEventsTail(sessionID string, limit int) ([]*Event, error) {
        if limit <= 0 {
                return nil, nil
        }
        rows, err := db.Query(`
SELECT id, session_id, seq, event_type, content, tool_use_id, created_at
FROM chat_events
WHERE session_id=?
ORDER BY seq DESC
LIMIT ?`, sessionID, limit)
        if err != nil {
                return nil, err
        }
        defer rows.Close()
        var rev []*Event
        for rows.Next() {
                ev := &Event{}
                if err := rows.Scan(&ev.ID, &ev.SessionID, &ev.Seq, &ev.EventType, &ev.Content, &ev.ToolUseID, &ev.CreatedAt); err != nil {
                        return nil, err
                }
                rev = append(rev, ev)
        }
        if err := rows.Err(); err != nil {
                return nil, err
        }
        // reverse → seq ASC
        for i, j := 0, len(rev)-1; i < j; i, j = i+1, j-1 {
                rev[i], rev[j] = rev[j], rev[i]
        }
        return rev, nil
}

// ListEventsByType returns the events of one type in seq order (v1.15.3:
// the hidden-id set for history assembly is its own tiny query — 'hide'
// events — instead of hauling the whole log to find them).
func (db *DB) ListEventsByType(sessionID, eventType string) ([]*Event, error) {
        rows, err := db.Query(`
SELECT id, session_id, seq, event_type, content, tool_use_id, created_at
FROM chat_events
WHERE session_id=? AND event_type=?
ORDER BY seq ASC`, sessionID, eventType)
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

// ListEventsTailN answers the LAST n events in seq order plus whether
// OLDER rows exist beyond the window (v1.63.3 THE UNLOST TAIL: the
// bootstrap fetch caps at the tail — "the most recent chats are what's
// important, older messages can stay dormant until scrolled to"). len<n
// means the window reaches the session's head.
func (db *DB) ListEventsTailN(sessionID string, n int) ([]*Event, bool, error) {
        if n <= 0 {
                return nil, false, nil
        }
        evs, err := db.ListEventsTail(sessionID, n)
        if err != nil {
                return nil, false, err
        }
        if len(evs) < n {
                return evs, false, nil // the window reaches the head
        }
        var older int
        if err := db.QueryRow(`SELECT COUNT(*) FROM chat_events WHERE session_id=? AND seq < ?`, sessionID, evs[0].Seq).Scan(&older); err != nil {
                return evs, false, nil // honest default — the page walk answers the truth
        }
        return evs, older > 0, nil
}

// ListEventsBefore answers up to n events with seq < before, in seq order
// (the OLDER-history page the backfill boundary fetches when the reader
// scrolls up past the bootstrap window — v1.63.3), plus whether even
// older rows exist.
func (db *DB) ListEventsBefore(sessionID string, before, n int) ([]*Event, bool, error) {
        if n <= 0 || before <= 1 {
                return nil, false, nil
        }
        rows, err := db.Query(`
SELECT id, session_id, seq, event_type, content, tool_use_id, created_at
FROM chat_events
WHERE session_id=? AND seq < ?
ORDER BY seq DESC
LIMIT ?`, sessionID, before, n)
        if err != nil {
                return nil, false, err
        }
        defer rows.Close()
        var rev []*Event
        for rows.Next() {
                ev := &Event{}
                if err := rows.Scan(&ev.ID, &ev.SessionID, &ev.Seq, &ev.EventType, &ev.Content, &ev.ToolUseID, &ev.CreatedAt); err != nil {
                        return nil, false, err
                }
                rev = append(rev, ev)
        }
        if err := rows.Err(); err != nil {
                return nil, false, err
        }
        // reverse → seq ASC
        for i, j := 0, len(rev)-1; i < j; i, j = i+1, j-1 {
                rev[i], rev[j] = rev[j], rev[i]
        }
        if len(rev) < n {
                return rev, false, nil // reached the head
        }
        var older int
        if err := db.QueryRow(`SELECT COUNT(*) FROM chat_events WHERE session_id=? AND seq < ?`, sessionID, rev[0].Seq).Scan(&older); err != nil {
                return rev, false, nil
        }
        return rev, older > 0, nil
}

// SessionEventBytes answers the session's total content bytes (the
// retention budget's measure — v1.63.3).
func (db *DB) SessionEventBytes(sessionID string) int64 {
        var total sql.NullInt64
        _ = db.QueryRow(`SELECT SUM(LENGTH(content)) FROM chat_events WHERE session_id=?`, sessionID).Scan(&total)
        if !total.Valid {
                return 0
        }
        return total.Int64
}

// TrimSessionEventsOlderThan deletes this session's events with seq <
// splitSeq (the retention trim's vehicle — v1.63.3: the OLDEST rows die
// first, the newest window survives). Returns the deleted row count.
func (db *DB) TrimSessionEventsOlderThan(sessionID string, splitSeq int) int64 {
        if splitSeq <= 1 {
                return 0
        }
        res, err := db.Exec(`DELETE FROM chat_events WHERE session_id=? AND seq < ?`, sessionID, splitSeq)
        if err != nil {
                return 0
        }
        n, _ := res.RowsAffected()
        return n
}

// OldestEventSeq answers the session's smallest seq (0 = no rows) — the
// trim's split-point walk reads lengths only, never content.
func (db *DB) OldestEventSeq(sessionID string) int {
        var seq sql.NullInt64
        _ = db.QueryRow(`SELECT MIN(seq) FROM chat_events WHERE session_id=?`, sessionID).Scan(&seq)
        if !seq.Valid {
                return 0
        }
        return int(seq.Int64)
}

// SessionEventSeqLengths walks the session's (seq, bytes) pairs in seq
// order (no content haul — the trim's budget arithmetic is lengths only).
func (db *DB) SessionEventSeqLengths(sessionID string) ([][2]int, error) {
        rows, err := db.Query(`SELECT seq, LENGTH(content) FROM chat_events WHERE session_id=? ORDER BY seq ASC`, sessionID)
        if err != nil {
                return nil, err
        }
        defer rows.Close()
        var out [][2]int
        for rows.Next() {
                var seq, n int
                if err := rows.Scan(&seq, &n); err != nil {
                        return nil, err
                }
                out = append(out, [2]int{seq, n})
        }
        return out, rows.Err()
}

// SpliceEvent is one row of a splice (v1.63.3 THE SERVE TRUTH RECONCILE):
// the serve's own completed turn mapped into the engine's event grammar.
// CreatedAtMs carries the serve's own clock for the row (0 = now) — the
// recovered transcript keeps its true day dividers.
type SpliceEvent struct {
        EventType  string
        Content    string
        ToolUseID  string
        CreatedAtMs int64
}

// SpliceSessionEvents atomically REPLACES everything after afterSeq with
// the given rows (v1.63.3 THE UNLOST TAIL): the engine died mid-turn and
// the boot heal spliced an "interrupted by engine restart" terminal (plus
// v1.52.3's synthesized never-ran tool results) over the turn's dangling
// window — while the serve, wake-locked in Termux, COMPLETED the turn.
// The serve's durable transcript is the whole truth; this vehicle deletes
// the dangling window (seq > afterSeq) and inserts the mapped rows with
// fresh monotonic seqs (afterSeq+1…, NEVER a reuse — a client cursor at
// or below afterSeq re-fetches cleanly). ONE transaction: the log is
// never seen half-spliced. Returns the inserted row count.
//
// SAFETY: the caller owns the trigger (the healed terminal must be the
// LAST event — nothing the user already saw past it may exist); the rows
// were never on any wire at their old seqs (the boot heal runs before
// the server accepts connections, the reconcile before the events GET
// answers).
func (db *DB) SpliceSessionEvents(sessionID string, afterSeq int, rows []SpliceEvent) (int, error) {
        if len(rows) == 0 {
                return 0, nil
        }
        tx, err := db.Begin()
        if err != nil {
                return 0, err
        }
        defer func() { _ = tx.Rollback() }()
        if _, err := tx.Exec(`DELETE FROM chat_events WHERE session_id=? AND seq > ?`, sessionID, afterSeq); err != nil {
                return 0, err
        }
        now := float64(time.Now().UnixMilli()) / 1000.0
        inserted := 0
        for i, row := range rows {
                ts := now
                if row.CreatedAtMs > 0 {
                        ts = float64(row.CreatedAtMs) / 1000.0
                }
                res, err := tx.Exec(`
INSERT INTO chat_events (session_id, seq, event_type, content, tool_use_id, created_at)
VALUES (?,?,?,?,?,?)`,
                        sessionID, afterSeq+1+i, row.EventType, row.Content, row.ToolUseID, ts)
                if err != nil {
                        return inserted, err
                }
                if n, _ := res.RowsAffected(); n > 0 {
                        inserted++
                }
        }
        if err := tx.Commit(); err != nil {
                return 0, err
        }
        return inserted, nil
}

// EventToJSON serializes an Event for the PWA. Matches the wire format
// the PWA's streamWorker expects.
// v0.39: seq rides on replayed events — the resume handshake (&since=N)
// lets a reconnecting client track its cursor by seq as well as id.
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
                // v0.44 INTERRUPT FIX: a status event may carry a human
                // message — the v0.39 boot-heal writes "interrupted by
                // engine restart" — but ToJSON decoded only state+usage,
                // so the message was DROPPED on the wire: a replayed
                // healed turn ended silently and the PWA had no text to
                // show for why the reply died. Pass both through when
                // the content actually carries them.
                Message   string           `json:"message,omitempty"`
                Healed    bool             `json:"healed,omitempty"`
                Title     string           `json:"title,omitempty"`
                Sources   []map[string]any `json:"sources,omitempty"`
                SessionID string           `json:"session_id,omitempty"`
                Error     string           `json:"error,omitempty"`
                IDs       []int64          `json:"ids,omitempty"`
                Seq       int              `json:"seq,omitempty"`
        }
        w := wire{
                ID:        e.ID,
                Timestamp: e.CreatedAt,
                Type:      e.EventType,
                Text:      e.Content,
                ToolUseID: e.ToolUseID,
                SessionID: e.SessionID,
                Seq:       e.Seq,
        }
        // If content is a JSON object (usage, etc.), decode it into the right field.
        if e.EventType == "status" && e.Content != "" {
                var st struct {
                        State   string `json:"state"`
                        Usage   any    `json:"usage"`
                        Message string `json:"message"`
                        Healed  bool   `json:"healed"`
                }
                if json.Unmarshal([]byte(e.Content), &st) == nil {
                        w.State = st.State
                        w.Usage = st.Usage
                        if st.Message != "" {
                                w.Message = st.Message
                                w.Healed = st.Healed
                        }
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

// TailPendingTurn answers "does this session's log end with an UNCLOSED
// turn?" WITHOUT scanning the whole log — v1.42.1 THE LONG HAUL (PLAN-V142
// §3.0, hypothesis H3: the boot heal's O(lifetime-events) scan was the
// install-age boot storm; a 90-day install paid a full read of every
// chat_event ever written on EVERY engine start).
//
// The verdict only depends on the LAST 'user' vs terminal-'status' event
// (the full-scan heal's final pending flag flips true on user, false on
// terminal, in order — so its end state is decided by whichever of the
// two comes last). Walking DESC from the newest event, the FIRST of
// {user, terminal status} encountered IS that decider:
//
//   - 'user' seen first  → pending (the turn never closed)
//   - terminal status    → closed
//
// Every other event type (assistant_delta ×N, thinking, tool_use, …) is
// turn-middle noise: skipped. The common closed-session shape stops after
// 1-2 rows; a session that died mid-mega-turn walks only that turn's tail
// (tailLimit caps the walk). 'status' events that are NOT terminal
// (state "running") also keep the walk going, exactly like the old scan.
//
// decided=false means the tail window exhausted with neither marker —
// for any realistic turn (≤ a few thousand streamed events) this cannot
// happen; the caller treats it as closed and logs it honestly.
func (db *DB) TailPendingTurn(sessionID string, tailLimit int) (pending, decided bool) {
        if tailLimit <= 0 {
                tailLimit = 20001
        }
        rows, err := db.Query(`SELECT event_type, content FROM chat_events
WHERE session_id=? ORDER BY seq DESC LIMIT ?`, sessionID, tailLimit)
        if err != nil {
                return false, false
        }
        defer rows.Close()
        for rows.Next() {
                var typ, content string
                if err := rows.Scan(&typ, &content); err != nil {
                        return false, false
                }
                switch typ {
                case "user":
                        return true, true
                case "status":
                        // the SAME terminal test the full-scan heal used — a
                        // status{"running"} (turn start) does not close a turn.
                        if strings.Contains(content, `"idle"`) || strings.Contains(content, `"error"`) {
                                return false, true
                        }
                }
        }
        return false, false
}

// CountUserTurnsPerSession (v1.47.2 THE FLEET HAND) — ONE query for the
// whole roster: session_id → user-event count (a "turn" is a user
// message + everything it triggered). Cheap on the (session_id, seq)
// index; the roster never pays N round-trips.
func (db *DB) CountUserTurnsPerSession() (map[string]int, error) {
        rows, err := db.Query(`
SELECT session_id, COUNT(*)
FROM chat_events
WHERE event_type='user'
GROUP BY session_id`)
        if err != nil {
                return nil, err
        }
        defer rows.Close()
        out := map[string]int{}
        for rows.Next() {
                var id string
                var n int
                if err := rows.Scan(&id, &n); err != nil {
                        return nil, err
                }
                out[id] = n
        }
        return out, rows.Err()
}
