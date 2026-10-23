// canvases.go — v1.42.4 THE LEDGER (PLAN-V142 §3.2 W2): the engine-side
// multi-canvas home. The web layer's Worlds registry (worlds.js) is the
// ONLY intended client; the engine treats `state` as opaque JSON except
// the JSON1 probes this file owns:
//
//   - ListCanvases:  icon_count  (json_array_length on $.icons)
//   - savedAt:       json_extract($.savedAt) — the boot-convergence
//     clock (the freshest-wins heal, see worlds.js)
//   - ListDigest:    icon + session ids (json_each) — the storage
//     hygiene sweep joins them (storagehygiene.js)
//
// Why engine-side at all (R3, the plan's decision): WebView localStorage
// is 5-10 MB, evictable, and wiped by WebView updates — it cannot hold
// N worlds + thumbnails. The engine dir is durable, already the chats'
// home, already the sync/export origin.
package store

import (
	"database/sql"
	"errors"
)

// ErrCanvasNotFound is returned by GetCanvas/PutCanvasThumb when the row
// is absent (the server maps it to 404).
var ErrCanvasNotFound = errors.New("canvas not found")

// Canvas is a full canvas row (GetCanvas/UpsertCanvas shape). State is
// the raw JSON text; Thumb is excluded from this struct — thumbs ride
// their own endpoints (a list/get must not drag megabytes of card
// images through JSON). FoldSeq (v1.69.1) is the op-log watermark: the
// highest canvas_ops.seq whose effect State already contains (0 = the
// state predates the journal).
type Canvas struct {
	ID        string  `json:"id"`
	Name      string  `json:"name"`
	Sort      int64   `json:"sort"`
	State     string  `json:"-"`
	FoldSeq   int     `json:"fold_seq"`
	CreatedAt float64 `json:"created_at"`
	UpdatedAt float64 `json:"updated_at"`
}

// CanvasRow is the LIST shape (no state, no thumb) — the boot registry
// fetch and the manager's gallery rows. IconCount/SavedAt are the JSON1
// probes; HasThumb says whether /thumb has bytes. StateBytes (v1.42.7
// THE MANAGER) is the stored state's size — the manager rows' size line
// (additive JSON: every existing consumer reads named fields, none breaks).
// Imported (v1.54 THE LIBRARY SHIP) is the state's $.imported.from probe —
// the provenance chip on the manager rows (an imported world remembers
// where it came from; "" = a home-grown world).
type CanvasRow struct {
	ID         string  `json:"id"`
	Name       string  `json:"name"`
	Sort       int64   `json:"sort"`
	IconCount  int64   `json:"icon_count"`
	HasThumb   bool    `json:"has_thumb"`
	StateBytes int64   `json:"state_bytes"`
	Imported   string  `json:"imported"`
	CreatedAt  float64 `json:"created_at"`
	UpdatedAt  float64 `json:"updated_at"`
	SavedAt    float64 `json:"saved_at"`
}

// CanvasDigest is the hygiene-sweep join shape: every icon id + every
// bound session id across ALL canvases (an icon on any canvas is live).
type CanvasDigest struct {
	ID         string   `json:"id"`
	IconIDs    []string `json:"icon_ids"`
	SessionIDs []string `json:"session_ids"`
}

// ListCanvases returns every canvas as a summary row, sort-ascending
// then updated_at-descending (the manager's order).
func (db *DB) ListCanvases() ([]*CanvasRow, error) {
	rows, err := db.Query(`
                SELECT id, name, sort,
                       COALESCE(json_array_length(state, '$.icons'), 0),
                       thumb IS NOT NULL,
                       COALESCE(length(state), 0),
                       COALESCE(json_extract(state, '$.imported.from'), ''),
                       created_at, updated_at,
                       COALESCE(CAST(json_extract(state, '$.savedAt') AS REAL), 0)
                FROM canvases
                ORDER BY sort ASC, updated_at DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []*CanvasRow{}
	for rows.Next() {
		r := &CanvasRow{}
		if err := rows.Scan(&r.ID, &r.Name, &r.Sort, &r.IconCount, &r.HasThumb, &r.StateBytes, &r.Imported, &r.CreatedAt, &r.UpdatedAt, &r.SavedAt); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// ListCanvasDigest returns the icon/session id digests for every canvas
// (the hygiene sweep's live-id join). Poison-tolerant per row: a canvas
// whose state lacks icons contributes empty arrays, never an error.
func (db *DB) ListCanvasDigest() ([]*CanvasDigest, error) {
	cids, err := db.ListCanvases()
	if err != nil {
		return nil, err
	}
	out := []*CanvasDigest{}
	for _, c := range cids {
		d := &CanvasDigest{ID: c.ID, IconIDs: []string{}, SessionIDs: []string{}}
		// icon ids (je.value ->> 'id'; NULLs skipped — poison tolerance)
		rows, err := db.Query(`
                        SELECT je.value ->> 'id'
                        FROM canvases, json_each(canvases.state, '$.icons') je
                        WHERE canvases.id = ?`, c.ID)
		if err == nil {
			for rows.Next() {
				var v sql.NullString
				if rows.Scan(&v) == nil && v.Valid && v.String != "" {
					d.IconIDs = append(d.IconIDs, v.String)
				}
			}
			rows.Close()
		}
		// session ids (nullable — only bound chats carry one)
		rows2, err2 := db.Query(`
                        SELECT je.value ->> 'sessionId'
                        FROM canvases, json_each(canvases.state, '$.icons') je
                        WHERE canvases.id = ?`, c.ID)
		if err2 == nil {
			for rows2.Next() {
				var v sql.NullString
				if rows2.Scan(&v) == nil && v.Valid && v.String != "" {
					d.SessionIDs = append(d.SessionIDs, v.String)
				}
			}
			rows2.Close()
		}
		out = append(out, d)
	}
	return out, nil
}

// GetCanvas returns one full row (state included, thumb excluded).
func (db *DB) GetCanvas(id string) (*Canvas, error) {
	c := &Canvas{}
	err := db.QueryRow(`
                SELECT id, name, sort, COALESCE(state, ''), COALESCE(fold_seq, 0), created_at, updated_at
                FROM canvases WHERE id = ?`, id).
		Scan(&c.ID, &c.Name, &c.Sort, &c.State, &c.FoldSeq, &c.CreatedAt, &c.UpdatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrCanvasNotFound
	}
	if err != nil {
		return nil, err
	}
	return c, nil
}

// UpsertCanvas is the ONE write path (PUT semantics — the RFC 7231
// PUT-create the house already runs for /api/placeholders; idempotent
// retries after a network partition land on the same row). Absent
// fields (nil pointers) KEEP their row values — a state-only sync PUT
// must never clobber a user-chosen name or sort (the v1.42.7 manager's
// rename PUT must never clobber state). The create path defaults
// name='Canvas', sort=0. Atomic: one tx holds the single conn across
// the update-then-insert (the raced-insert case retries the update).
func (db *DB) UpsertCanvas(id string, name *string, sort *int64, state *string) (*Canvas, error) {
	now := nowF()
	var nameV, sortV, stateV any
	if name != nil {
		nameV = *name
	}
	if sort != nil {
		sortV = *sort
	}
	if state != nil && *state != "" {
		stateV = *state
	}
	tx, err := db.Begin()
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	upd := func() (int64, error) {
		res, err := tx.Exec(`
                        UPDATE canvases SET
                          name = COALESCE(?, name),
                          sort = COALESCE(?, sort),
                          state = COALESCE(?, state),
                          updated_at = ?
                        WHERE id = ?`, nameV, sortV, stateV, now, id)
		if err != nil {
			return 0, err
		}
		return res.RowsAffected()
	}
	n, err := upd()
	if err != nil {
		return nil, err
	}
	if n == 0 {
		// the create path: defaults ride the COALESCEs (absent name →
		// 'Canvas', absent sort → 0, absent state → NULL)
		if _, err := tx.Exec(`
                        INSERT OR IGNORE INTO canvases (id, name, sort, state, created_at, updated_at)
                        VALUES (?, COALESCE(?, 'Canvas'), COALESCE(?, 0), ?, ?, ?)`,
			id, nameV, sortV, stateV, now, now); err != nil {
			return nil, err
		}
		// a raced insert (another goroutine won the birth): re-run the
		// update so OUR fields land too.
		if _, err := upd(); err != nil {
			return nil, err
		}
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return db.GetCanvas(id)
}

// PutCanvasThumb stores the card image bytes (the server layer has
// already sniffed + capped them — this layer trusts its only caller).
func (db *DB) PutCanvasThumb(id string, thumb []byte) error {
	if _, err := db.GetCanvas(id); err != nil {
		return err
	}
	_, err := db.Exec(`UPDATE canvases SET thumb = ?, updated_at = ? WHERE id = ?`, thumb, nowF(), id)
	return err
}

// GetCanvasThumb returns the stored bytes (nil when never set).
func (db *DB) GetCanvasThumb(id string) ([]byte, error) {
	var thumb []byte
	err := db.QueryRow(`SELECT thumb FROM canvases WHERE id = ?`, id).Scan(&thumb)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrCanvasNotFound
	}
	if err != nil {
		return nil, err
	}
	return thumb, nil
}

// DeleteCanvas removes a row (idempotent — deleting an absent canvas is
// not an error, the sessions-delete parity).
func (db *DB) DeleteCanvas(id string) error {
	_, err := db.Exec(`DELETE FROM canvases WHERE id = ?`, id)
	return err
}

// CountCanvases feeds the honest storage dashboard (Usage()).
func (db *DB) CountCanvases() int64 {
	var n int64
	_ = db.QueryRow(`SELECT COUNT(*) FROM canvases`).Scan(&n)
	return n
}
