// collabapi.go — v1.69.1 THE SHARED CANVAS (PLAN-V169 §v1.69.1): the
// document op-log's HTTP data plane. The room (v1.69.2) makes the
// journal LIVE; this file owns the durable surface both depend on:
//
//	GET  /api/collab/{canvas}/ops?since=N → the journal from seq N
//	     (inclusive — the chat_events replay law). When the GC has
//	     trimmed below the cursor the answer is an honest SNAPSHOT
//	     redirect ({snapshot:true}) — the client adopts the row state
//	     instead (Figma's journal/catch-up law).
//	POST /api/collab/{canvas}/ops         → submit a validated batch:
//	     fold-check → append (per-canvas seq, one tx) → checkpoint
//	     rewrite (state + fold_seq watermark + $.syncSeq stamped
//	     INSIDE the state). The response carries the stamped ops —
//	     the author's ack is the same frame everyone else gets.
//
// THE WRITE SERIALIZER: the fold (read state → fold → write) and the
// whole-state PUT gate share s.collabMu — a fold can never interleave a
// PUT's read-modify-write (the host's view slice — camera/settings —
// must never be clobbered by a fold that read the pre-PUT state).
//
// Auth: this phase rides the engine's existing gate (localhost-trust /
// global bearer) — the device-token ACL arrives with v1.69.3's
// handshake.
package server

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"

	"github.com/ScoobyBaby1999/doomalay/engine/internal/collab"
	"github.com/ScoobyBaby1999/doomalay/engine/internal/store"
)

// handleCollabOpsList is GET /api/collab/{canvas}/ops?since=N.
func (s *Server) handleCollabOpsList(w http.ResponseWriter, r *http.Request) {
	if s.db == nil {
		writeError(w, http.StatusServiceUnavailable, "no database")
		return
	}
	id := r.PathValue("canvas")
	if id == "" {
		writeError(w, http.StatusBadRequest, "canvas id required")
		return
	}
	since, _ := strconv.Atoi(r.URL.Query().Get("since"))
	if since < 0 {
		since = 0
	}
	if _, err := s.db.GetCanvas(id); err != nil {
		if errors.Is(err, store.ErrCanvasNotFound) {
			writeError(w, http.StatusNotFound, "canvas not found")
			return
		}
		writeError(w, http.StatusInternalServerError, "get: "+err.Error())
		return
	}
	latest, err := s.db.LatestCanvasOpSeq(id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "oplog: "+err.Error())
		return
	}
	minSeq, err := s.db.MinCanvasOpSeq(id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "oplog: "+err.Error())
		return
	}
	// The snapshot redirect: the cursor fell below the GC watermark —
	// the journal can no longer serve a complete replay. The client
	// adopts the row (GET /api/canvases/{id}) whose state carries its
	// own $.syncSeq cursor and resumes from there. since=0 with an
	// empty journal is NOT a redirect — it is an honest empty replay.
	if latest > 0 && since > 0 && since < minSeq {
		writeJSON(w, http.StatusOK, map[string]any{
			"snapshot": true,
			"latest":   latest,
			"ops":      []any{},
		})
		return
	}
	rows, err := s.db.ListCanvasOps(id, since)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "list: "+err.Error())
		return
	}
	c, err := s.db.GetCanvas(id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "get: "+err.Error())
		return
	}
	out := make([]any, 0, len(rows))
	for _, row := range rows {
		frame, err := collab.StampedFrame(row.Op, row.Seq, row.DeviceID, row.At)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "corrupt op frame in journal")
			return
		}
		out = append(out, frame)
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"ops":      out,
		"latest":   latest,
		"fold_seq": c.FoldSeq,
	})
}

// handleCollabOpsPost is POST /api/collab/{canvas}/ops {device, ops:[…]}.
//
// THE ONE-CLOCK LAW: the append assigns the seqs (the order IS the
// seq); the fold replays the batch in that same order onto the
// checkpoint; the checkpoint write carries $.syncSeq = the folded-through
// seq. The fold is checked BEFORE anything lands — an over-cap batch is
// refused whole (no half-accepted batch, no journal rollback).
func (s *Server) handleCollabOpsPost(w http.ResponseWriter, r *http.Request) {
	if s.db == nil {
		writeError(w, http.StatusServiceUnavailable, "no database")
		return
	}
	id := r.PathValue("canvas")
	if id == "" {
		writeError(w, http.StatusBadRequest, "canvas id required")
		return
	}
	body := http.MaxBytesReader(w, r.Body, collab.MaxOpBytes*collab.MaxOpsPerBatch)
	var req struct {
		Device string      `json:"device"`
		Ops    []collab.Op `json:"ops"`
	}
	if err := json.NewDecoder(body).Decode(&req); err != nil {
		var mbe *http.MaxBytesError
		if errors.As(err, &mbe) {
			writeError(w, http.StatusRequestEntityTooLarge, "ops batch over cap")
			return
		}
		writeError(w, http.StatusBadRequest, "invalid JSON: "+err.Error())
		return
	}
	if len(req.Ops) == 0 {
		writeError(w, http.StatusBadRequest, "no ops")
		return
	}
	if len(req.Ops) > collab.MaxOpsPerBatch {
		writeError(w, http.StatusRequestEntityTooLarge, "too many ops in one batch")
		return
	}
	if req.Device == "" {
		req.Device = "host"
	}
	// Validate the whole batch BEFORE anything lands, stripping any
	// client-sent server stamps (the client never names its own seq).
	rawOps := make([]string, 0, len(req.Ops))
	for i := range req.Ops {
		op := req.Ops[i]
		if len(op.Icon) > collab.MaxOpBytes || len(op.Dot) > collab.MaxOpBytes || len(op.Props) > collab.MaxOpBytes || len(op.Value) > collab.MaxOpBytes {
			writeError(w, http.StatusRequestEntityTooLarge, "op over size cap")
			return
		}
		op.Seq = 0
		op.Device = ""
		op.At = 0
		if err := collab.ValidateOp(op); err != nil {
			writeError(w, http.StatusBadRequest, "op "+strconv.Itoa(i)+": "+err.Error())
			return
		}
		jb, err := json.Marshal(op)
		if err != nil {
			writeError(w, http.StatusBadRequest, "op "+strconv.Itoa(i)+": marshal: "+err.Error())
			return
		}
		rawOps = append(rawOps, string(jb))
	}
	// the canvas must exist — a shared doc is born from a host row,
	// never minted by a bare op submit.
	if _, err := s.db.GetCanvas(id); err != nil {
		if errors.Is(err, store.ErrCanvasNotFound) {
			writeError(w, http.StatusNotFound, "canvas not found")
			return
		}
		writeError(w, http.StatusInternalServerError, "get: "+err.Error())
		return
	}
	// ▀▀ the write serializer: gate + fold + checkpoint are ONE critical
	// section against the whole-state PUT path (collabMu in both).
	s.collabMu.Lock()
	defer s.collabMu.Unlock()
	c, err := s.db.GetCanvas(id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "get: "+err.Error())
		return
	}
	stateObj, err := collab.StateObject(c.State)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "fold: "+err.Error())
		return
	}
	// the TENTATIVE fold — FoldOp is seq-agnostic (the laws key on id);
	// if the folded doc can't fit the checkpoint cap, nothing lands.
	for i := range req.Ops {
		if err := collab.FoldOp(stateObj, req.Ops[i]); err != nil {
			writeError(w, http.StatusInternalServerError, "fold: "+err.Error())
			return
		}
	}
	folded, err := json.Marshal(stateObj)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "fold: marshal: "+err.Error())
		return
	}
	// 64B headroom for the $.syncSeq stamp the final write adds.
	if len(folded) > canvasStateMaxBytes-64 {
		writeError(w, http.StatusRequestEntityTooLarge, "folded state over 4MB cap")
		return
	}
	appended, err := s.db.AppendCanvasOps(id, req.Device, rawOps)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "append: "+err.Error())
		return
	}
	lastSeq := 0
	for _, row := range appended {
		lastSeq = row.Seq
	}
	stateObj["syncSeq"] = lastSeq
	final, err := json.Marshal(stateObj)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "fold: marshal: "+err.Error())
		return
	}
	finalStr := string(final)
	if _, err := s.db.UpsertCanvas(id, nil, nil, &finalStr); err != nil {
		writeError(w, http.StatusInternalServerError, "checkpoint: "+err.Error())
		return
	}
	if err := s.db.SetCanvasFoldSeq(id, lastSeq); err != nil {
		writeError(w, http.StatusInternalServerError, "foldseq: "+err.Error())
		return
	}
	// the ack: the stamped frames (the same objects the room broadcasts).
	out := make([]any, 0, len(appended))
	for _, row := range appended {
		frame, err := collab.StampedFrame(row.Op, row.Seq, row.DeviceID, row.At)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "ack: corrupt journal row")
			return
		}
		out = append(out, frame)
	}
	writeJSON(w, http.StatusOK, map[string]any{"ops": out, "latest": lastSeq})
}
