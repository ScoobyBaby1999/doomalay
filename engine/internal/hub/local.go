// local.go — the hub's local SQLite store (the hub_items table created by
// store.Migrate). Keeps downloaded items (payload included), the heart
// state, and the persona picker's non-hub hearts (rows with repo=” and
// payload=” — they carry only type/id/name/hearted).
package hub

import (
        "database/sql"
        "encoding/json"
        "errors"

        "github.com/ScoobyBaby1999/doomalay/engine/internal/store"
)

// LocalItem is one hub_items row (meta decoded + the overlay columns).
type LocalItem struct {
        Item         Item
        Payload      string
        Hearted      bool
        HeartedAt    string
        DownloadedAt string
}

// ErrNotFound is returned when no row matches (type, id).
var ErrNotFound = errors.New("hub item not found")

// SaveLocalItem upserts one row. meta is the full Item JSON; payload may be
// "" (a publish-only record or a non-hub heart).
func SaveLocalItem(db *store.DB, item Item, payload string) error {
        if item.Tags == nil {
                item.Tags = []string{}
        }
        meta, err := json.Marshal(item)
        if err != nil {
                return err
        }
        _, err = db.Exec(`INSERT INTO hub_items (type, id, repo, name, meta, payload)
                VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(type, id) DO UPDATE SET
                        repo = excluded.repo, name = excluded.name, meta = excluded.meta,
                        payload = CASE WHEN excluded.payload != '' THEN excluded.payload ELSE hub_items.payload END`,
                item.Type, item.ID, item.Repo, item.Name, string(meta), payload)
        return err
}

// GetLocalItem reads one row.
func GetLocalItem(db *store.DB, typ, id string) (*LocalItem, error) {
        row := db.QueryRow(`SELECT meta, payload, hearted, hearted_at, downloaded_at
                FROM hub_items WHERE type = ? AND id = ?`, typ, id)
        return scanLocalItem(row)
}

// ListLocal returns every LIBRARY row of one type — downloaded items and
// publish records. Non-hub heart rows (repo=” + payload=” — the persona
// picker's local hearts) are EXCLUDED; ListHeartedPersonas covers those.
func ListLocal(db *store.DB, typ string) ([]*LocalItem, error) {
        rows, err := db.Query(`SELECT meta, payload, hearted, hearted_at, downloaded_at
                FROM hub_items WHERE type = ? AND (repo != '' OR payload != '')
                ORDER BY downloaded_at DESC, name ASC`, typ)
        if err != nil {
                return nil, err
        }
        defer rows.Close()
        var out []*LocalItem
        for rows.Next() {
                item, err := scanLocalItem(rows)
                if err != nil {
                        return nil, err
                }
                out = append(out, item)
        }
        return out, rows.Err()
}

// scanner is the common row reader (both *sql.Row and *sql.Rows).
type scanner interface{ Scan(dest ...any) error }

func scanLocalItem(row scanner) (*LocalItem, error) {
        var meta, payload sql.NullString
        var hearted int
        var heartedAt, downloadedAt sql.NullString
        if err := row.Scan(&meta, &payload, &hearted, &heartedAt, &downloadedAt); err != nil {
                if errors.Is(err, sql.ErrNoRows) {
                        return nil, ErrNotFound
                }
                return nil, err
        }
        out := &LocalItem{Hearted: hearted != 0}
        if meta.Valid {
                _ = json.Unmarshal([]byte(meta.String), &out.Item) // malformed row → zero Item
        }
        if payload.Valid {
                out.Payload = payload.String
        }
        if heartedAt.Valid {
                out.HeartedAt = heartedAt.String
        }
        if downloadedAt.Valid {
                out.DownloadedAt = downloadedAt.String
        }
        return out, nil
}

// SetHearted flips the heart state of a row that must already exist
// (endorsing requires the item be downloaded first — enforced by callers).
func SetHearted(db *store.DB, typ, id string, hearted bool) error {
        ts := ""
        if hearted {
                ts = NowString()
        }
        res, err := db.Exec(`UPDATE hub_items SET hearted = ?, hearted_at = ? WHERE type = ? AND id = ?`,
                boolToInt(hearted), ts, typ, id)
        if err != nil {
                return err
        }
        if n, _ := res.RowsAffected(); n == 0 {
                return ErrNotFound
        }
        return nil
}

// ListHeartedPersonas returns every hearted persona row (id + name) — the
// persona picker's hearted-first sort + badges. Includes non-hub hearts
// (repo=” + payload=”) and hearted hub downloads.
func ListHeartedPersonas(db *store.DB) ([]LocalItem, error) {
        rows, err := db.Query(`SELECT meta, payload, hearted, hearted_at, downloaded_at
                FROM hub_items WHERE type = 'persona' AND hearted = 1
                ORDER BY hearted_at DESC`)
        if err != nil {
                return nil, err
        }
        defer rows.Close()
        var out []LocalItem
        for rows.Next() {
                item, err := scanLocalItem(rows)
                if err != nil {
                        return nil, err
                }
                out = append(out, *item)
        }
        return out, rows.Err()
}

// HeartLocalPersona hearts a non-hub persona (the persona picker): upserts a
// repo=” row that carries only the name + heart state.
func HeartLocalPersona(db *store.DB, name, id string) error {
        if id == "" {
                return errors.New("persona id is required")
        }
        if name == "" {
                name = "Persona"
        }
        // Only heart non-hub rows this way — a hub-downloaded persona keeps its
        // full local row (hub hearts go through SetHearted).
        if existing, err := GetLocalItem(db, "persona", id); err == nil && existing.Item.Repo != "" {
                return SetHearted(db, "persona", id, true)
        }
        ts := NowString()
        item := Item{ID: id, Type: "persona", Name: name, Repo: "", Tags: []string{}}
        meta, err := json.Marshal(item)
        if err != nil {
                return err
        }
        _, err = db.Exec(`INSERT INTO hub_items (type, id, repo, name, meta, payload, hearted, hearted_at)
                VALUES ('persona', ?, '', ?, ?, '', 1, ?)
                ON CONFLICT(type, id) DO UPDATE SET name = excluded.name, meta = excluded.meta,
                        hearted = 1, hearted_at = excluded.hearted_at`,
                id, name, string(meta), ts)
        return err
}

// UnheartLocalPersona clears a heart. A non-hub heart row (repo=” +
// payload=”) is deleted outright — it has no reason to exist unhearted; a
// hub row keeps its downloaded payload with hearted=0.
func UnheartLocalPersona(db *store.DB, name, id string) error {
        if existing, err := GetLocalItem(db, "persona", id); err == nil {
                if existing.Item.Repo == "" && existing.Payload == "" {
                        _, err := db.Exec(`DELETE FROM hub_items WHERE type = 'persona' AND id = ?`, id)
                        return err
                }
                return SetHearted(db, "persona", id, false)
        }
        // No row yet — nothing to unheart (idempotent OK).
        return nil
}

// DeleteLocalItem removes one downloaded row (v0.60 pt A.3: the "delete
// downloaded bundle" feature — the user asked for an explicit remove with a
// confirm step in the UI). Only touches rows that exist; idempotent errors
// surface as ErrNotFound so the route can 404 cleanly.
func DeleteLocalItem(db *store.DB, typ, id string) error {
        res, err := db.Exec(`DELETE FROM hub_items WHERE type = ? AND id = ?`, typ, id)
        if err != nil {
                return err
        }
        if n, _ := res.RowsAffected(); n == 0 {
                return ErrNotFound
        }
        return nil
}

// MarkDownloaded stamps downloaded_at. The local +1 the UI displays comes
// from applyCounts' DownloadedAt overlay — a bumped counter in the stored
// meta here would DOUBLE-count it (countsFor bases itself on row.Item),
// so the meta keeps the remote base counters untouched.
func MarkDownloaded(db *store.DB, typ, id string) error {
        existing, err := GetLocalItem(db, typ, id)
        if err != nil {
                return err
        }
        existing.DownloadedAt = NowString()
        meta, err := json.Marshal(existing.Item)
        if err != nil {
                return err
        }
        _, err = db.Exec(`UPDATE hub_items SET meta = ?, downloaded_at = ? WHERE type = ? AND id = ?`,
                string(meta), existing.DownloadedAt, typ, id)
        return err
}

// CountLocal returns how many rows a library type has locally (the
// libraries endpoint shows it as "downloaded").
func CountLocal(db *store.DB, typ string) int {
        var n int
        if err := db.QueryRow(`SELECT COUNT(*) FROM hub_items WHERE type = ?`, typ).Scan(&n); err != nil {
                return 0
        }
        return n
}

func boolToInt(b bool) int {
        if b {
                return 1
        }
        return 0
}
