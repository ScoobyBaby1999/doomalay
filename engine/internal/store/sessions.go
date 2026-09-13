package store

import (
        "database/sql"
        "fmt"
        "time"
)

// Session is a chat session row (subset of ChatSession for persistence).
type Session struct {
        ID              string
        Title           string
        Model           string
        Provider        string
        Sandbox         string // 'quick' | 'hf' | 'terminal' | 'device' (v0.13)
        Effort          string
        Mode            string
        WebSearch       bool
        DeepResearch    bool
        WebTemplate     string
        DeepTemplate    string
        DeepMode        string
        JudgeCount      int
        JudgeTemplate   string
        SlidingWindow   int
        MaxContext      int
        ToolAllowlist   string
        HooksConfig     string
        Routing         string
        WorkspaceID     string
        ManuallyRenamed bool
        CreatedAt       float64
        UpdatedAt       float64
}

// CreateSession inserts a new chat session.
func (db *DB) CreateSession(s *Session) error {
        now := float64(time.Now().UnixMilli()) / 1000.0
        if s.CreatedAt == 0 {
                s.CreatedAt = now
        }
        s.UpdatedAt = now
        _, err := db.Exec(`
INSERT INTO chat_sessions
  (id, title, model, provider, sandbox, effort, mode, web_search, deep_research,
   web_template, deep_template, deep_mode, judge_count, judge_template,
   sliding_window, max_context, tool_allowlist, hooks_config, routing,
   workspace_id, manually_renamed, created_at, updated_at)
VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
                s.ID, s.Title, s.Model, s.Provider, s.Sandbox, s.Effort, s.Mode,
                s.WebSearch, s.DeepResearch, s.WebTemplate, s.DeepTemplate, s.DeepMode,
                s.JudgeCount, s.JudgeTemplate, s.SlidingWindow, s.MaxContext,
                s.ToolAllowlist, s.HooksConfig, s.Routing, s.WorkspaceID,
                s.ManuallyRenamed, s.CreatedAt, s.UpdatedAt)
        return err
}

// UpdateSession updates mutable fields. Title is updated separately by
// SetSessionTitle to respect manually_renamed.
func (db *DB) UpdateSession(s *Session) error {
        s.UpdatedAt = float64(time.Now().UnixMilli()) / 1000.0
        _, err := db.Exec(`
UPDATE chat_sessions SET
  model=?, provider=?, sandbox=?, effort=?, mode=?, web_search=?, deep_research=?,
  web_template=?, deep_template=?, deep_mode=?, judge_count=?, judge_template=?,
  sliding_window=?, max_context=?, tool_allowlist=?, hooks_config=?,
  routing=?, workspace_id=?, updated_at=?
WHERE id=?`,
                s.Model, s.Provider, s.Sandbox, s.Effort, s.Mode, s.WebSearch, s.DeepResearch,
                s.WebTemplate, s.DeepTemplate, s.DeepMode, s.JudgeCount, s.JudgeTemplate,
                s.SlidingWindow, s.MaxContext, s.ToolAllowlist, s.HooksConfig,
                s.Routing, s.WorkspaceID, s.UpdatedAt, s.ID)
        return err
}

// SetSessionTitle updates only the title, unless manually_renamed is set.
func (db *DB) SetSessionTitle(id, title string, overrideManual bool) error {
        if !overrideManual {
                var manual bool
                err := db.QueryRow(`SELECT manually_renamed FROM chat_sessions WHERE id=?`, id).Scan(&manual)
                if err == sql.ErrNoRows {
                        return nil
                }
                if err != nil {
                        return err
                }
                if manual {
                        return nil // respect the user's manual rename
                }
        }
        _, err := db.Exec(`UPDATE chat_sessions SET title=?, updated_at=? WHERE id=?`,
                title, float64(time.Now().UnixMilli())/1000.0, id)
        return err
}

// GetSession fetches one session by ID.
func (db *DB) GetSession(id string) (*Session, error) {
        s := &Session{}
        var ws, dr, mr int
        err := db.QueryRow(`
SELECT id, title, model, provider, sandbox, effort, mode, web_search, deep_research,
       web_template, deep_template, deep_mode, judge_count, judge_template,
       sliding_window, max_context, tool_allowlist, hooks_config, routing,
       workspace_id, manually_renamed, created_at, updated_at
FROM chat_sessions WHERE id=?`, id).Scan(
                &s.ID, &s.Title, &s.Model, &s.Provider, &s.Sandbox, &s.Effort, &s.Mode, &ws, &dr,
                &s.WebTemplate, &s.DeepTemplate, &s.DeepMode, &s.JudgeCount, &s.JudgeTemplate,
                &s.SlidingWindow, &s.MaxContext, &s.ToolAllowlist, &s.HooksConfig, &s.Routing,
                &s.WorkspaceID, &mr, &s.CreatedAt, &s.UpdatedAt)
        if err == sql.ErrNoRows {
                return nil, nil
        }
        if err != nil {
                return nil, err
        }
        s.WebSearch = ws != 0
        s.DeepResearch = dr != 0
        s.ManuallyRenamed = mr != 0
        return s, nil
}

// ListSessions returns all sessions, newest first.
func (db *DB) ListSessions() ([]*Session, error) {
        rows, err := db.Query(`
SELECT id, title, model, provider, sandbox, effort, mode, web_search, deep_research,
       web_template, deep_template, deep_mode, judge_count, judge_template,
       sliding_window, max_context, tool_allowlist, hooks_config, routing,
       workspace_id, manually_renamed, created_at, updated_at
FROM chat_sessions ORDER BY updated_at DESC`)
        if err != nil {
                return nil, err
        }
        defer rows.Close()
        var out []*Session
        for rows.Next() {
                s := &Session{}
                var ws, dr, mr int
                if err := rows.Scan(
                        &s.ID, &s.Title, &s.Model, &s.Provider, &s.Sandbox, &s.Effort, &s.Mode, &ws, &dr,
                        &s.WebTemplate, &s.DeepTemplate, &s.DeepMode, &s.JudgeCount, &s.JudgeTemplate,
                        &s.SlidingWindow, &s.MaxContext, &s.ToolAllowlist, &s.HooksConfig, &s.Routing,
                        &s.WorkspaceID, &mr, &s.CreatedAt, &s.UpdatedAt); err != nil {
                        return nil, err
                }
                s.WebSearch = ws != 0
                s.DeepResearch = dr != 0
                s.ManuallyRenamed = mr != 0
                out = append(out, s)
        }
        return out, rows.Err()
}

// DeleteSession removes a session and its events.
func (db *DB) DeleteSession(id string) error {
        tx, err := db.Begin()
        if err != nil {
                return err
        }
        if _, err := tx.Exec(`DELETE FROM chat_events WHERE session_id=?`, id); err != nil {
                tx.Rollback()
                return err
        }
        if _, err := tx.Exec(`DELETE FROM chat_sessions WHERE id=?`, id); err != nil {
                tx.Rollback()
                return err
        }
        return tx.Commit()
}

// MaxSeq returns the highest event seq for a session, or 0 if none.
func (db *DB) MaxSeq(sessionID string) (int, error) {
        var max sql.NullInt64
        err := db.QueryRow(`SELECT MAX(seq) FROM chat_events WHERE session_id=?`, sessionID).Scan(&max)
        if err != nil {
                return 0, err
        }
        if !max.Valid {
                return 0, nil
        }
        return int(max.Int64), nil
}

// CountSessions returns the total session count.
func (db *DB) CountSessions() (int, error) {
        var n int
        err := db.QueryRow(`SELECT COUNT(*) FROM chat_sessions`).Scan(&n)
        if err != nil {
                return 0, fmt.Errorf("count sessions: %w", err)
        }
        return n, nil
}
