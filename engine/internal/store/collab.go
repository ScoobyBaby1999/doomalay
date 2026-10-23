// collab.go — v1.69.1 THE SHARED CANVAS (PLAN-V169 §v1.69.1): the canvas
// op-log accessors — the chat_events law (store/events.go) promoted to the
// document. The server is the ONE sequencer: per-canvas seq = max+1 in a
// single tx (the single SQLite connection serializes writers anyway); the
// appended op rows are the journal, canvases.state is the checkpoint, and
// canvases.fold_seq is the watermark of what the checkpoint contains.
//
// The v1.69.2 room folds ops onto the checkpoint in memory and rewrites
// the row on a calm cadence (Figma's checkpoint+journal pair); this layer
// owns the durable truth both shapes serve.
package store

import (
	"database/sql"
	"time"
)

// CanvasOp is one row of the canvas op-log. Op is the validated op JSON
// (the collab.Op wire shape); DeviceID names the author ("" = the host's
// own whole-state saves, which never journal — they ARE checkpoints).
type CanvasOp struct {
	ID       int64   `json:"id"`
	CanvasID string  `json:"canvas_id"`
	Seq      int     `json:"seq"`
	DeviceID string  `json:"device_id"`
	Op       string  `json:"op"`
	At       float64 `json:"at"`
}

// AppendCanvasOps appends a batch of validated ops to one canvas in ONE
// transaction, stamping per-canvas seqs max+1..max+n (the one-clock law:
// a batch lands contiguous — a client's derived diff is never
// interleaved mid-batch by another device's batch). Returns the inserted
// rows in order. Empty batch → empty result, no tx.
func (db *DB) AppendCanvasOps(canvasID, deviceID string, ops []string) ([]*CanvasOp, error) {
	if len(ops) == 0 {
		return nil, nil
	}
	tx, err := db.Begin()
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	var maxSeq sql.NullInt64
	if err := tx.QueryRow(`SELECT MAX(seq) FROM canvas_ops WHERE canvas_id=?`, canvasID).Scan(&maxSeq); err != nil {
		return nil, err
	}
	seq := 0
	if maxSeq.Valid {
		seq = int(maxSeq.Int64)
	}
	now := float64(time.Now().UnixMilli()) / 1000.0
	out := make([]*CanvasOp, 0, len(ops))
	for _, opJSON := range ops {
		seq++
		res, err := tx.Exec(`
INSERT INTO canvas_ops (canvas_id, seq, device_id, op, at)
VALUES (?,?,?,?,?)`, canvasID, seq, deviceID, opJSON, now)
		if err != nil {
			return nil, err
		}
		row := &CanvasOp{CanvasID: canvasID, Seq: seq, DeviceID: deviceID, Op: opJSON, At: now}
		row.ID, _ = res.LastInsertId()
		out = append(out, row)
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return out, nil
}

// ListCanvasOps returns ops for a canvas from `since` onward (INCLUSIVE —
// the chat_events replay law: since=the last applied seq).
func (db *DB) ListCanvasOps(canvasID string, since int) ([]*CanvasOp, error) {
	rows, err := db.Query(`
SELECT id, canvas_id, seq, device_id, op, at
FROM canvas_ops
WHERE canvas_id=? AND seq >= ?
ORDER BY seq ASC`, canvasID, since)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*CanvasOp
	for rows.Next() {
		op := &CanvasOp{}
		if err := rows.Scan(&op.ID, &op.CanvasID, &op.Seq, &op.DeviceID, &op.Op, &op.At); err != nil {
			return nil, err
		}
		out = append(out, op)
	}
	return out, rows.Err()
}

// LatestCanvasOpSeq is the canvas's journal head (0 = no journal).
func (db *DB) LatestCanvasOpSeq(canvasID string) (int, error) {
	var maxSeq sql.NullInt64
	if err := db.QueryRow(`SELECT MAX(seq) FROM canvas_ops WHERE canvas_id=?`, canvasID).Scan(&maxSeq); err != nil {
		return 0, err
	}
	if maxSeq.Valid {
		return int(maxSeq.Int64), nil
	}
	return 0, nil
}

// MinCanvasOpSeq is the journal's oldest live seq (the GC watermark — a
// catch-up request below it must take the snapshot path instead).
func (db *DB) MinCanvasOpSeq(canvasID string) (int, error) {
	var minSeq sql.NullInt64
	if err := db.QueryRow(`SELECT MIN(seq) FROM canvas_ops WHERE canvas_id=?`, canvasID).Scan(&minSeq); err != nil {
		return 0, err
	}
	if minSeq.Valid {
		return int(minSeq.Int64), nil
	}
	return 0, nil
}

// TrimCanvasOps GCs the journal THROUGH a seq (inclusive) — the idle
// sweep's compaction once the checkpoint (fold_seq) has moved past them.
// Returns the number of rows dropped.
func (db *DB) TrimCanvasOps(canvasID string, throughSeq int) (int64, error) {
	if throughSeq <= 0 {
		return 0, nil
	}
	res, err := db.Exec(`DELETE FROM canvas_ops WHERE canvas_id=? AND seq <= ?`, canvasID, throughSeq)
	if err != nil {
		return 0, err
	}
	n, _ := res.RowsAffected()
	return n, nil
}

// SetCanvasFoldSeq advances the checkpoint watermark (never backward —
// a stale write can't un-fold the row).
func (db *DB) SetCanvasFoldSeq(canvasID string, seq int) error {
	if seq < 0 {
		seq = 0
	}
	_, err := db.Exec(`UPDATE canvases SET fold_seq = MAX(fold_seq, ?) WHERE id = ?`, seq, canvasID)
	return err
}

// CanvasJournalStats is the idle sweep's census of one canvas's journal
// (row count + the seq span) — the GC decision input.
func (db *DB) CanvasJournalStats(canvasID string) (count int64, minSeq, maxSeq int, err error) {
	var nullMin, nullMax sql.NullInt64
	err = db.QueryRow(`SELECT COUNT(*), MIN(seq), MAX(seq) FROM canvas_ops WHERE canvas_id=?`, canvasID).
		Scan(&count, &nullMin, &nullMax)
	if err != nil {
		return 0, 0, 0, err
	}
	if nullMin.Valid {
		minSeq = int(nullMin.Int64)
	}
	if nullMax.Valid {
		maxSeq = int(nullMax.Int64)
	}
	return count, minSeq, maxSeq, nil
}
