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

// DB wraps the sql.DB connection. path is the main database file
// ("<dataDir>/doomalay.db") — the maintenance pass (maintain.go) sizes
// the -wal/-shm siblings from it.
type DB struct {
        *sql.DB
        path string
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
        out := &DB{DB: db}
        out.path = path
        // v1.42.1 THE LONG HAUL (H1a): bound the WAL file so post-checkpoint
        // TRUNCATEs actually return disk space — without this the -wal file
        // keeps its lifetime high-water size on disk forever (it only ever
        // grew with install age).
        _ = out.SetJournalSizeLimit(JournalSizeLimitBytes)
        return out, nil
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
  updated_at      REAL NOT NULL,
  skill_name      TEXT,
  skill_head      TEXT
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

-- v1.69.1 THE SHARED CANVAS (PLAN-V169 v1.69.1): the canvas op-log —
-- the chat_events law promoted to the DOCUMENT. One row per accepted
-- op; per-canvas seq = the server's one clock (Figma's multiplayer
-- law: LWW per (id, property), server arrival order is the order).
-- the op column is the validated op JSON; device_id names the author.
-- The row's canvases.state is the CHECKPOINT; canvases.fold_seq is the
-- watermark of what that checkpoint already contains (ops at or below
-- fold_seq are journal-replay history, GC-able after the idle sweep;
-- ops above fold_seq are the live tail a cold boot folds onto the
-- checkpoint).
CREATE TABLE IF NOT EXISTS canvas_ops (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  canvas_id   TEXT NOT NULL,
  seq         INTEGER NOT NULL,
  device_id   TEXT NOT NULL DEFAULT '',
  op          TEXT NOT NULL CHECK (json_valid(op)),
  at          REAL NOT NULL,
  UNIQUE(canvas_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_canvas_ops_canvas ON canvas_ops(canvas_id, seq);

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

-- v0.44: per-chat workspace bindings (a chat can hold MANY cloud repos).
CREATE TABLE IF NOT EXISTS session_workspaces (
  session_id   TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  created_at   REAL NOT NULL,
  PRIMARY KEY (session_id, workspace_id)
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

-- v1.42.4 THE LEDGER (PLAN-V142 §3.2): the multi-canvas home. One row
-- per canvas/world. "state" is the WorldState JSON the web layer owns
-- (offset, scale, currentFamily, icons[], dots[], savedAt) — OPAQUE
-- to the engine except the JSON1 probes (icon_count via
-- json_array_length, savedAt via json_extract, the id digest via
-- json_each); the json_valid CHECK makes corrupt writes die at the DB
-- boundary (R-L1, live-probed against modernc.org/sqlite v1.34.4).
-- "thumb" is the ≤64KB PNG/JPEG card image (R-L2: rows ≤~100KB stay
-- inline per SQLite's intern-v-extern-blob guidance). NO parent_id —
-- REV 2 retired the tree for a flat portal-ref graph (v1.42.6's
-- portals hold canvas refs; cycles fine, no caps).
CREATE TABLE IF NOT EXISTS canvases (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL DEFAULT 'Canvas',
  sort       INTEGER NOT NULL DEFAULT 0,
  state      TEXT CHECK (state IS NULL OR json_valid(state)),
  thumb      BLOB,
  created_at REAL NOT NULL,
  updated_at REAL NOT NULL
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
                // v1.22.0 THE MIRROR: the Preamble system — preambles is a
                // JSON array of {id,name,text} (the chat's saved preamble
                // library); preamble_sel is the active selection
                // ("" = the app default · "off" = disabled · "<id>").
                {"chat_sessions", "preambles", "ALTER TABLE chat_sessions ADD COLUMN preambles TEXT"},
                {"chat_sessions", "preamble_sel", "ALTER TABLE chat_sessions ADD COLUMN preamble_sel TEXT"},
                // v0.28: per-chat compaction controls (the mind panel owns
                // them) — enabled by default, arms at 70% context fill.
                {"chat_sessions", "compact_enabled", "ALTER TABLE chat_sessions ADD COLUMN compact_enabled INTEGER DEFAULT 1"},
                {"chat_sessions", "compact_threshold", "ALTER TABLE chat_sessions ADD COLUMN compact_threshold INTEGER DEFAULT 70"},
                // v0.44: the template pill's active method template (JSON
                // blob {id, name, brief} — "" = none).
                {"chat_sessions", "template_id", "ALTER TABLE chat_sessions ADD COLUMN template_id TEXT"},
                // v0.52 THE 3 PILLS: per-chat auto-search toggles — the
                // [template|+] / [skills|+] pill label press flips these;
                // the turn builder gates the template/skills tools on them.
                {"chat_sessions", "template_auto", "ALTER TABLE chat_sessions ADD COLUMN template_auto INTEGER DEFAULT 0"},
                {"chat_sessions", "skills_auto", "ALTER TABLE chat_sessions ADD COLUMN skills_auto INTEGER DEFAULT 0"},
                // v0.60 pt C.9: THE LIB PILL — the single gatekeeping toggle
                // (migrates from template_auto||skills_auto: the effective
                // read ORs the old two until a PATCH stamps the new one).
                {"chat_sessions", "lib_auto", "ALTER TABLE chat_sessions ADD COLUMN lib_auto INTEGER DEFAULT 0"},
                // v0.46: HF chat — sandbox=hf sessions carry the space routing:
                // sandbox_mode ("shared" | "own") + sandbox_repo ("user/name"
                // for own spaces; "" for shared).
                {"chat_sessions", "sandbox_mode", "ALTER TABLE chat_sessions ADD COLUMN sandbox_mode TEXT"},
                {"chat_sessions", "sandbox_repo", "ALTER TABLE chat_sessions ADD COLUMN sandbox_repo TEXT"},
                // v1.17.1 THE PIVOT: the Termux capability — the stacked
                // capability field the capabilities library's gated toggle
                // writes (termux INTEGER DEFAULT 0, exactly like the
                // lib_auto/skills_auto siblings). INERT this wave: the
                // Termux bridge + tools arrive with v1.17.2/v1.18.
                {"chat_sessions", "termux", "ALTER TABLE chat_sessions ADD COLUMN termux INTEGER DEFAULT 0"},
                // v1.29.6 THE PERSISTED SKILL: the loaded skill's name +
                // head (~3KB methodology) ride the session row — the
                // follow-through fix (the old behavior evaporated the
                // methodology at turn end).
                {"chat_sessions", "skill_name", "ALTER TABLE chat_sessions ADD COLUMN skill_name TEXT"},
                {"chat_sessions", "skill_head", "ALTER TABLE chat_sessions ADD COLUMN skill_head TEXT"},
                // v1.36.4 THE HONEST BLOCKS (PLAN-V137 §4): the live-block
                // toggle (ph_blocks_off INTEGER DEFAULT 0 — off = the five
                // MIRROR blocks ride every turn, the default) + the per-chat
                // block overrides map ({blockKey: text} JSON — an edited
                // truth that replaces that block's live expansion).
                {"chat_sessions", "ph_blocks_off", "ALTER TABLE chat_sessions ADD COLUMN ph_blocks_off INTEGER DEFAULT 0"},
                {"chat_sessions", "block_overrides", "ALTER TABLE chat_sessions ADD COLUMN block_overrides TEXT"},
                // v0.44: the workspaces wave — the bare v0.17 workspaces
                // table grows the cloud-repo columns (host kind, owner/repo,
                // access level, token vault key, default branch, meta JSON).
                {"workspaces", "name", "ALTER TABLE workspaces ADD COLUMN name TEXT"},
                {"workspaces", "kind", "ALTER TABLE workspaces ADD COLUMN kind TEXT"},
                {"workspaces", "host", "ALTER TABLE workspaces ADD COLUMN host TEXT"},
                {"workspaces", "owner", "ALTER TABLE workspaces ADD COLUMN owner TEXT"},
                {"workspaces", "repo", "ALTER TABLE workspaces ADD COLUMN repo TEXT"},
                {"workspaces", "access", "ALTER TABLE workspaces ADD COLUMN access TEXT"},
                {"workspaces", "token_env", "ALTER TABLE workspaces ADD COLUMN token_env TEXT"},
                {"workspaces", "default_branch", "ALTER TABLE workspaces ADD COLUMN default_branch TEXT"},
                {"workspaces", "meta", "ALTER TABLE workspaces ADD COLUMN meta TEXT"},
                // v0.77.10: the bundle-counting wave — via_collection marks a
                // row downloaded as PART of a bundle (its +1 rides the
                // COLLECTION, not the member; a direct download keeps 0),
                // collection indexes the row's bunch for the per-collection
                // local state queries (downloaded? hearted?).
                {"hub_items", "via_collection", "ALTER TABLE hub_items ADD COLUMN via_collection INTEGER NOT NULL DEFAULT 0"},
                {"hub_items", "collection", "ALTER TABLE hub_items ADD COLUMN collection TEXT NOT NULL DEFAULT ''"},
                // v1.69.1 THE SHARED CANVAS (PLAN-V169 §v1.69.1): the
                // checkpoint watermark — the highest canvas_ops.seq whose
                // effect the row's state already contains. 0 = the state
                // predates the journal (or no journal at all).
                {"canvases", "fold_seq", "ALTER TABLE canvases ADD COLUMN fold_seq INTEGER NOT NULL DEFAULT 0"},
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

// ListSettingsLike returns every row whose key matches the prefix
// (v1.61.3 THE RETRY SENTINEL: the boot scan walks retry.sentinel.*).
func (db *DB) ListSettingsLike(prefix string) (map[string]string, error) {
        rows, err := db.Query("SELECT key, value FROM app_settings WHERE key LIKE ?", prefix+"%")
        if err != nil {
                return nil, err
        }
        defer rows.Close()
        out := map[string]string{}
        for rows.Next() {
                var k, v string
                if err := rows.Scan(&k, &v); err != nil {
                        return nil, err
                }
                out[k[len(prefix):]] = v
        }
        return out, rows.Err()
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
