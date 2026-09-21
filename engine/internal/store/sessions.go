package store

import (
	"database/sql"
	"fmt"
	"time"
)

// Session is a chat session row (subset of ChatSession for persistence).
type Session struct {
	ID            string
	Title         string
	Model         string
	Provider      string
	Sandbox       string // 'quick' | 'hf' | 'terminal' | 'device' (v0.13)
	Effort        string
	Mode          string
	WebSearch     bool
	DeepResearch  bool
	WebTemplate   string
	DeepTemplate  string
	DeepMode      string
	JudgeCount    int
	JudgeTemplate string
	SlidingWindow int
	MaxContext    int
	ToolAllowlist string
	HooksConfig   string
	Routing       string
	WorkspaceID   string
	Persona       string // v0.19: the chat's editable persona (its system prompt)
	// v0.26: the multi-persona system — `personas` is a JSON array of
	// PersonaSpec {id,name,text,mode,trigger} (see server/personas.go);
	// `placeholders` is a JSON map of the chat's custom {key}s.
	Personas        string
	Placeholders    string
	ManuallyRenamed bool
	// v0.21 AUTO-COMPACT (ported from the HF space's proactive compression):
	// when the conversation nears the model's context limit, older turns
	// are summarized into CompactSummary and everything up to event seq
	// CompactSeq is replaced by it. Full history stays in the event log —
	// compacting only changes what's sent to the model.
	CompactSummary string
	CompactSeq     int
	// v0.28: per-chat compaction controls (user spec — the mind panel
	// owns these): CompactEnabled turns auto-compaction on/off,
	// CompactThresholdPct is the context-fill % that arms it (10-95).
	CompactEnabled      bool
	CompactThresholdPct int
	// v0.44 TEMPLATE PILL: the chat's active method template as a
	// JSON blob {id, name, brief} ("" = none; deep-research stays the
	// deep_research flag). The frontend writes it on every template
	// switch and restores it on reload — the engine only stores and
	// echoes it back.
	TemplateID string
	CreatedAt  float64
	UpdatedAt  float64
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
   workspace_id, persona, personas, placeholders, manually_renamed, compact_summary, compact_seq,
   compact_enabled, compact_threshold, template_id, created_at, updated_at)
VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
		s.ID, s.Title, s.Model, s.Provider, s.Sandbox, s.Effort, s.Mode,
		s.WebSearch, s.DeepResearch, s.WebTemplate, s.DeepTemplate, s.DeepMode,
		s.JudgeCount, s.JudgeTemplate, s.SlidingWindow, s.MaxContext,
		s.ToolAllowlist, s.HooksConfig, s.Routing, s.WorkspaceID,
		s.Persona, s.Personas, s.Placeholders, s.ManuallyRenamed, s.CompactSummary, s.CompactSeq,
		s.CompactEnabled, s.CompactThresholdPct, s.TemplateID, s.CreatedAt, s.UpdatedAt)
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
  routing=?, workspace_id=?, persona=?, personas=?, placeholders=?, manually_renamed=?,
  compact_summary=?, compact_seq=?, compact_enabled=?, compact_threshold=?, template_id=?, updated_at=?
WHERE id=?`,
		s.Model, s.Provider, s.Sandbox, s.Effort, s.Mode, s.WebSearch, s.DeepResearch,
		s.WebTemplate, s.DeepTemplate, s.DeepMode, s.JudgeCount, s.JudgeTemplate,
		s.SlidingWindow, s.MaxContext, s.ToolAllowlist, s.HooksConfig,
		s.Routing, s.WorkspaceID, s.Persona, s.Personas, s.Placeholders, s.ManuallyRenamed,
		s.CompactSummary, s.CompactSeq, s.CompactEnabled, s.CompactThresholdPct, s.TemplateID, s.UpdatedAt, s.ID)
	return err
}

// SetSessionTitle updates only the title, unless manually_renamed is set.
// v0.19: an OVERRIDE write is BY DEFINITION a manual rename — flag it so
// nothing else ever overwrites the user's chosen name again (the flag was
// previously never written by anyone — dead column).
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
		_, err = db.Exec(`UPDATE chat_sessions SET title=?, updated_at=? WHERE id=?`,
			title, float64(time.Now().UnixMilli())/1000.0, id)
		return err
	}
	_, err := db.Exec(`UPDATE chat_sessions SET title=?, manually_renamed=1, updated_at=? WHERE id=?`,
		title, float64(time.Now().UnixMilli())/1000.0, id)
	return err
}

// GetSession fetches one session by ID.
func (db *DB) GetSession(id string) (*Session, error) {
	s := &Session{}
	var ws, dr, mr int
	var persona, personas, placeholders, compactSummary sql.NullString
	var compactSeq sql.NullInt64
	var compactEnabled, compactThreshold sql.NullInt64
	var templateID sql.NullString
	err := db.QueryRow(`
SELECT id, title, model, provider, sandbox, effort, mode, web_search, deep_research,
       web_template, deep_template, deep_mode, judge_count, judge_template,
       sliding_window, max_context, tool_allowlist, hooks_config, routing,
       workspace_id, persona, personas, placeholders, manually_renamed,
       compact_summary, compact_seq, compact_enabled, compact_threshold, template_id, created_at, updated_at
FROM chat_sessions WHERE id=?`, id).Scan(
		&s.ID, &s.Title, &s.Model, &s.Provider, &s.Sandbox, &s.Effort, &s.Mode, &ws, &dr,
		&s.WebTemplate, &s.DeepTemplate, &s.DeepMode, &s.JudgeCount, &s.JudgeTemplate,
		&s.SlidingWindow, &s.MaxContext, &s.ToolAllowlist, &s.HooksConfig, &s.Routing,
		&s.WorkspaceID, &persona, &personas, &placeholders, &mr,
		&compactSummary, &compactSeq, &compactEnabled, &compactThreshold, &templateID, &s.CreatedAt, &s.UpdatedAt)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	s.WebSearch = ws != 0
	s.DeepResearch = dr != 0
	s.ManuallyRenamed = mr != 0
	if persona.Valid {
		s.Persona = persona.String
	}
	if personas.Valid {
		s.Personas = personas.String
	}
	if placeholders.Valid {
		s.Placeholders = placeholders.String
	}
	// v0.28 FIX: these were never scanned before — after a reload every
	// session PATCH (any field: effort, web_search, model…) wrote the
	// row back with a BLANK summary + seq 0, silently erasing compaction
	// state (the "auto-compaction doesn't work" report's engine-side half).
	if compactSummary.Valid {
		s.CompactSummary = compactSummary.String
	}
	if compactSeq.Valid {
		s.CompactSeq = int(compactSeq.Int64)
	}
	// v0.28 per-chat controls; absent (pre-migration rows) = defaults.
	s.CompactEnabled = true
	if compactEnabled.Valid {
		s.CompactEnabled = compactEnabled.Int64 != 0
	}
	s.CompactThresholdPct = 70
	if compactThreshold.Valid {
		s.CompactThresholdPct = int(compactThreshold.Int64)
	}
	// v0.44: the template pill's active-template blob (JSON string).
	if templateID.Valid {
		s.TemplateID = templateID.String
	}
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
