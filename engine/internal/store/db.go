// Package store is the SQLite persistence layer (pure-Go modernc.org/sqlite,
// no CGO so the engine cross-compiles cleanly).
//
// Tables:
//   - chat_sessions (one row per ChatSession)
//   - chat_events   (append-only event log, seq-ordered per session)
//   - provider_keys (AES-256-GCM encrypted API keys)
//   - workspaces    (cloned repo metadata)
//   - chat_artifacts (file index per chat)
//
// The V0 bug-fix "backend-writes-events-as-it-emits" lives in events.go:
// the Go engine appends to chat_events as the brain streams events back,
// not the frontend at turn-end.
package store

import (
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"time"

	_ "modernc.org/sqlite"
)

// DB wraps the sql.DB connection.
type DB struct {
	*sql.DB
}

// Open opens (or creates) the SQLite database at dataDir/doomalay.db.
// WAL journal mode for concurrent reads during writes.
//
// SECURITY: the DB file is created with 0600 perms (owner-only). Chat
// sessions, events, and workspaces live here — they're plaintext at rest
// (SQLite doesn't encrypt by default) but only the user can read them.
// For full at-rest encryption, a future phase can use SQLCipher.
func Open(dataDir string) (*DB, error) {
	path := filepath.Join(dataDir, "doomalay.db")
	dsn := fmt.Sprintf("file:%s?_journal_mode=WAL&_busy_timeout=5000&_foreign_keys=on&_busy_timeout=5000", path)
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("open %s: %w", path, err)
	}
	db.SetMaxOpenConns(1) // SQLite serializes writes; one conn avoids SQLITE_BUSY.
	if err := db.Ping(); err != nil {
		return nil, fmt.Errorf("ping %s: %w", path, err)
	}
	// SECURITY: tighten file perms to 0600 (SQLite creates 0644 by default).
	// Also the WAL + SHM files. Best-effort — ignore errors (the dir is already 0700).
	_ = os.Chmod(path, 0o600)
	_ = os.Chmod(path+"-wal", 0o600)
	_ = os.Chmod(path+"-shm", 0o600)
	return &DB{db}, nil
}

// Migrate creates the schema if missing. Idempotent.
func (db *DB) Migrate() error {
	const schema = `
CREATE TABLE IF NOT EXISTS chat_sessions (
  id              TEXT PRIMARY KEY,
  title           TEXT NOT NULL DEFAULT 'New Chat',
  model           TEXT,
  provider        TEXT,
  sandbox         TEXT,
  effort          TEXT DEFAULT 'med',
  mode            TEXT DEFAULT 'auto',
  web_search      INTEGER DEFAULT 0,
  deep_research   INTEGER DEFAULT 0,
  web_template    TEXT,
  deep_template   TEXT,
  deep_mode       TEXT,
  judge_count     INTEGER DEFAULT 3,
  judge_template  TEXT DEFAULT 'critique',
  sliding_window  INTEGER DEFAULT 40,
  max_context     INTEGER DEFAULT 128000,
  tool_allowlist  TEXT,
  hooks_config    TEXT,
  routing         TEXT,
  workspace_id    TEXT,
  persona         TEXT,
  manually_renamed INTEGER DEFAULT 0,
  template_id     TEXT,
  created_at      REAL NOT NULL,
  updated_at      REAL NOT NULL
);

-- ONE definition of chat_events (resolves the schema conflict from the old
-- c-branch where db.py and chat_routes.py disagreed). AUTOINCREMENT id is
-- the source of truth; (session_id, seq) is unique for dedup.
CREATE TABLE IF NOT EXISTS chat_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  TEXT NOT NULL,
  seq         INTEGER NOT NULL,
  event_type  TEXT NOT NULL,
  content     TEXT,
  tool_use_id TEXT,
  created_at  REAL NOT NULL,
  UNIQUE(session_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_chat_events_session ON chat_events(session_id, seq);

CREATE TABLE IF NOT EXISTS provider_keys (
  env_var     TEXT PRIMARY KEY,
  provider    TEXT NOT NULL,
  key_enc     BLOB NOT NULL,
  key_nonce   BLOB NOT NULL,
  extra       TEXT,
  extra_enc   BLOB,
  extra_nonce BLOB,
  created_at  REAL NOT NULL,
  updated_at  REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS workspaces (
  id          TEXT PRIMARY KEY,
  session_id  TEXT,
  repo_url    TEXT,
  branch      TEXT,
  sandbox_path TEXT NOT NULL,
  provider    TEXT,
  created_at  REAL NOT NULL,
  updated_at  REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS chat_artifacts (
  id          TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL,
  path        TEXT NOT NULL,
  kind        TEXT,
  size        INTEGER,
  produced_by TEXT,
  created_at  REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chat_artifacts_session ON chat_artifacts(session_id);

-- v0.29: engine-wide key/value settings (currently home of the GLOBAL
-- custom placeholders — the ones every chatbot recognizes, stored as one
-- JSON blob under the 'global_placeholders' key).
CREATE TABLE IF NOT EXISTS app_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at REAL NOT NULL
);

-- v0.31: the Hub (modular library system) — items downloaded from (or
-- published to) HF dataset repos, plus the heart state. One row per
-- (type, id). Non-hub local hearts (the persona picker) are rows with
-- repo='' and payload='' — they carry only type/id/name/hearted.
CREATE TABLE IF NOT EXISTS hub_items (
  type          TEXT NOT NULL,
  id            TEXT NOT NULL,
  repo          TEXT NOT NULL DEFAULT '',
  name          TEXT NOT NULL DEFAULT '',
  meta          TEXT NOT NULL DEFAULT '{}',  -- the full item JSON
  payload       TEXT,
  hearted       INTEGER NOT NULL DEFAULT 0,
  hearted_at    TEXT,
  downloaded_at TEXT,
  PRIMARY KEY (type, id)
);
`
	_, err := db.Exec(schema)
	if err != nil {
		return err
	}
	// v0.13: sandbox column added for chat_sessions (older installs
	// created the table without it). Idempotent column adds for any
	// field introduced after first release.
	migrations := []struct{ table, col, ddl string }{
		{"chat_sessions", "sandbox", "ALTER TABLE chat_sessions ADD COLUMN sandbox TEXT"},
		// v0.19: per-chat persona (the editable system prompt /
		// identity for this chat's bot).
		{"chat_sessions", "persona", "ALTER TABLE chat_sessions ADD COLUMN persona TEXT"},
		// v0.21: auto-compact state (summary of the turns folded out
		// of the model's context + the event seq it covers).
		{"chat_sessions", "compact_summary", "ALTER TABLE chat_sessions ADD COLUMN compact_summary TEXT"},
		{"chat_sessions", "compact_seq", "ALTER TABLE chat_sessions ADD COLUMN compact_seq INTEGER DEFAULT 0"},
		// v0.26: the multi-persona system — personas is a JSON array
		// of {id,name,text,mode,trigger}; placeholders is the chat's
		// custom {key} map.
		{"chat_sessions", "personas", "ALTER TABLE chat_sessions ADD COLUMN personas TEXT"},
		{"chat_sessions", "placeholders", "ALTER TABLE chat_sessions ADD COLUMN placeholders TEXT"},
		// v0.28: per-chat compaction controls (the mind panel owns
		// them) — enabled by default, arms at 70% context fill.
		{"chat_sessions", "compact_enabled", "ALTER TABLE chat_sessions ADD COLUMN compact_enabled INTEGER DEFAULT 1"},
		{"chat_sessions", "compact_threshold", "ALTER TABLE chat_sessions ADD COLUMN compact_threshold INTEGER DEFAULT 70"},
		// v0.44: the template pill's active method template (JSON
		// blob {id, name, brief} — "" = none).
		{"chat_sessions", "template_id", "ALTER TABLE chat_sessions ADD COLUMN template_id TEXT"},
	}
	for _, m := range migrations {
		if err := db.ensureColumn(m.table, m.col, m.ddl); err != nil {
			return err
		}
	}
	return nil
}

// GetSetting reads one app_settings value ("" when absent).
func (db *DB) GetSetting(key string) (string, error) {
	var v string
	err := db.QueryRow("SELECT value FROM app_settings WHERE key = ?", key).Scan(&v)
	if err == sql.ErrNoRows {
		return "", nil
	}
	return v, err
}

// SetSetting upserts one app_settings value.
func (db *DB) SetSetting(key, value string) error {
	_, err := db.Exec(`INSERT INTO app_settings (key, value, updated_at)
                VALUES (?, ?, ?)
                ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
		key, value, float64(time.Now().UnixMilli())/1000.0)
	return err
}

// DeleteSetting removes one app_settings row (idempotent).
func (db *DB) DeleteSetting(key string) error {
	_, err := db.Exec("DELETE FROM app_settings WHERE key = ?", key)
	return err
}

// ensureColumn adds a column to a table if it doesn't exist yet (SQLite has
// no ADD COLUMN IF NOT EXISTS).
func (db *DB) ensureColumn(table, col, ddl string) error {
	rows, err := db.Query("PRAGMA table_info(" + table + ")")
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var cid int
		var name, ctype string
		var notNull int
		var dfltValue any
		var pk int
		if err := rows.Scan(&cid, &name, &ctype, &notNull, &dfltValue, &pk); err != nil {
			return err
		}
		if name == col {
			return nil // already exists
		}
	}
	_, err = db.Exec(ddl)
	return err
}
