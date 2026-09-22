// workspaces.go — store accessors for the v0.44 workspaces wave.
//
// A workspace row is ONE connected cloud repo (github/gitea/gitlab/
// sourcehut/generic). Tokens are NOT stored here — token_env names the
// vault key (secrets.Vault), keeping the provider-keys rule: secrets only
// ever live encrypted in the vault, and the brain/PWA only ever see the
// env NAME. session_workspaces binds chats ↔ workspaces (many↔many: one
// repo can be bound to several chats, a chat can hold several repos).
package store

import (
        "crypto/rand"
        "encoding/hex"
        "database/sql"
        "encoding/json"
        "time"
)

// Workspace is one connected cloud repo.
type Workspace struct {
        ID            string  `json:"id"`
        Name          string  `json:"name"`   // owner/repo (display)
        Kind          string  `json:"kind"`   // github|gitea|gitlab|sourcehut|generic
        Host          string  `json:"host"`   // github.com
        Owner         string  `json:"owner"`
        Repo          string  `json:"repo"`
        RepoURL       string  `json:"repo_url"` // the original connect URL
        Branch        string  `json:"branch"`   // preferred ref ("" = default)
        DefaultBranch string  `json:"default_branch"`
        Access        string  `json:"access"`   // read|partial|full
        TokenEnv      string  `json:"token_env"` // vault key (never the token)
        SandboxPath   string  `json:"sandbox_path,omitempty"`
        Provider      string  `json:"provider,omitempty"` // legacy column
        Meta          string  `json:"meta,omitempty"`    // JSON: description, stars…
        CreatedAt     float64 `json:"created_at"`
        UpdatedAt     float64 `json:"updated_at"`
        // SessionID mirrors the legacy nullable column (single-chat connects
        // prebind; multi-chat binding lives in session_workspaces).
        SessionID string `json:"-"`
}

// MetaJSON decodes the meta blob (nil on garbage — never fatal).
func (w *Workspace) MetaJSON() map[string]any {
        if w.Meta == "" {
                return nil
        }
        var m map[string]any
        if err := json.Unmarshal([]byte(w.Meta), &m); err != nil {
                return nil
        }
        return m
}

func newWorkspaceID() string {
        b := make([]byte, 6)
        _, _ = rand.Read(b)
        return hex.EncodeToString(b) // 12 hex, artifact-id-shaped
}

func nowF() float64 { return float64(time.Now().UnixMilli()) / 1000.0 }

// CreateWorkspace inserts a row (ID minted when empty).
func (db *DB) CreateWorkspace(w *Workspace) error {
        if w.ID == "" {
                w.ID = newWorkspaceID()
        }
        if w.CreatedAt == 0 {
                w.CreatedAt = nowF()
        }
        w.UpdatedAt = nowF()
        _, err := db.Exec(`INSERT INTO workspaces
                (id, session_id, repo_url, branch, sandbox_path, provider,
                 name, kind, host, owner, repo, access, token_env, default_branch, meta,
                 created_at, updated_at)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
                w.ID, w.SessionIDOrNil(), w.RepoURL, w.Branch, w.SandboxPath, w.Provider,
                w.Name, w.Kind, w.Host, w.Owner, w.Repo, w.Access, w.TokenEnv,
                w.DefaultBranch, w.Meta, w.CreatedAt, w.UpdatedAt)
        return err
}

// SessionIDOrNil: the legacy session_id column is nullable — "" → NULL.
func (w *Workspace) SessionIDOrNil() any {
        if w.SessionID == "" {
                return nil
        }
        return w.SessionID
}

// GetWorkspace by id.
func (db *DB) GetWorkspace(id string) (*Workspace, error) {
        row := db.QueryRow(`SELECT id, session_id, repo_url, branch, sandbox_path,
                provider, name, kind, host, owner, repo, access, token_env,
                default_branch, meta, created_at, updated_at
                FROM workspaces WHERE id = ?`, id)
        var w Workspace
        var sessionID sql.NullString
        err := row.Scan(&w.ID, &sessionID, &w.RepoURL, &w.Branch, &w.SandboxPath,
                &w.Provider, &w.Name, &w.Kind, &w.Host, &w.Owner, &w.Repo, &w.Access,
                &w.TokenEnv, &w.DefaultBranch, &w.Meta, &w.CreatedAt, &w.UpdatedAt)
        if err == sql.ErrNoRows {
                return nil, nil
        }
        if err != nil {
                return nil, err
        }
        w.SessionID = sessionID.String
        return &w, nil
}

// ListWorkspaces returns every workspace, newest first.
func (db *DB) ListWorkspaces() ([]*Workspace, error) {
        rows, err := db.Query(`SELECT id, session_id, repo_url, branch, sandbox_path,
                provider, name, kind, host, owner, repo, access, token_env,
                default_branch, meta, created_at, updated_at
                FROM workspaces ORDER BY updated_at DESC`)
        if err != nil {
                return nil, err
        }
        defer rows.Close()
        var out []*Workspace
        for rows.Next() {
                var w Workspace
                var sessionID sql.NullString
                if err := rows.Scan(&w.ID, &sessionID, &w.RepoURL, &w.Branch, &w.SandboxPath,
                        &w.Provider, &w.Name, &w.Kind, &w.Host, &w.Owner, &w.Repo, &w.Access,
                        &w.TokenEnv, &w.DefaultBranch, &w.Meta, &w.CreatedAt, &w.UpdatedAt); err != nil {
                        return nil, err
                }
                w.SessionID = sessionID.String
                out = append(out, &w)
        }
        return out, rows.Err()
}

// UpdateWorkspaceColumns updates mutable columns by id (kv pairs built
// from the non-empty fields the caller passes).
func (db *DB) UpdateWorkspace(w *Workspace) error {
        w.UpdatedAt = nowF()
        _, err := db.Exec(`UPDATE workspaces SET name=?, kind=?, host=?, owner=?,
                repo=?, repo_url=?, branch=?, access=?, token_env=?, default_branch=?,
                sandbox_path=?, meta=?, session_id=?, updated_at=? WHERE id=?`,
                w.Name, w.Kind, w.Host, w.Owner, w.Repo, w.RepoURL, w.Branch, w.Access,
                w.TokenEnv, w.DefaultBranch, w.SandboxPath, w.Meta, w.SessionIDOrNil(),
                w.UpdatedAt, w.ID)
        return err
}

// DeleteWorkspace removes the row (bindings cascade in the caller).
func (db *DB) DeleteWorkspace(id string) error {
        if _, err := db.Exec("DELETE FROM session_workspaces WHERE workspace_id = ?", id); err != nil {
                return err
        }
        _, err := db.Exec("DELETE FROM workspaces WHERE id = ?", id)
        return err
}

// ── chat bindings ─────────────────────────────────────────────────────────

// BindWorkspace attaches a workspace to a chat (idempotent).
func (db *DB) BindWorkspace(sessionID, workspaceID string) error {
        _, err := db.Exec(`INSERT INTO session_workspaces (session_id, workspace_id, created_at)
                VALUES (?,?,?) ON CONFLICT(session_id, workspace_id) DO NOTHING`,
                sessionID, workspaceID, nowF())
        return err
}

// UnbindWorkspace detaches one workspace from a chat.
func (db *DB) UnbindWorkspace(sessionID, workspaceID string) error {
        _, err := db.Exec("DELETE FROM session_workspaces WHERE session_id = ? AND workspace_id = ?",
                sessionID, workspaceID)
        return err
}

// ListSessionWorkspaces returns the workspaces bound to a chat, newest
// bind first.
func (db *DB) ListSessionWorkspaces(sessionID string) ([]*Workspace, error) {
        rows, err := db.Query(`SELECT w.id, w.session_id, w.repo_url, w.branch, w.sandbox_path,
                w.provider, w.name, w.kind, w.host, w.owner, w.repo, w.access, w.token_env,
                w.default_branch, w.meta, w.created_at, w.updated_at
                FROM workspaces w JOIN session_workspaces b ON b.workspace_id = w.id
                WHERE b.session_id = ? ORDER BY b.created_at DESC`, sessionID)
        if err != nil {
                return nil, err
        }
        defer rows.Close()
        var out []*Workspace
        for rows.Next() {
                var w Workspace
                var sessionID sql.NullString
                if err := rows.Scan(&w.ID, &sessionID, &w.RepoURL, &w.Branch, &w.SandboxPath,
                        &w.Provider, &w.Name, &w.Kind, &w.Host, &w.Owner, &w.Repo, &w.Access,
                        &w.TokenEnv, &w.DefaultBranch, &w.Meta, &w.CreatedAt, &w.UpdatedAt); err != nil {
                        return nil, err
                }
                w.SessionID = sessionID.String
                out = append(out, &w)
        }
        return out, rows.Err()
}

// ListWorkspaceSessions returns the chat ids a workspace is bound to.
func (db *DB) ListWorkspaceSessions(workspaceID string) ([]string, error) {
        rows, err := db.Query("SELECT session_id FROM session_workspaces WHERE workspace_id = ?", workspaceID)
        if err != nil {
                return nil, err
        }
        defer rows.Close()
        var out []string
        for rows.Next() {
                var s string
                if err := rows.Scan(&s); err != nil {
                        return nil, err
                }
                out = append(out, s)
        }
        return out, rows.Err()
}
