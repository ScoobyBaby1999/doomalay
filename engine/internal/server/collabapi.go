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
	// v1.69.3 THE HANDSHAKE: the owner OR a member device of THIS
	// canvas (the per-canvas sandbox).
	if _, ok := s.collabAuthorized(r, id); !ok {
		writeError(w, http.StatusUnauthorized, "not a member of this canvas")
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
// v1.69.2 THE ONE-WRITER LAW: the batch reroutes through the canvas's
// ROOM — the same goroutine the WS hot path folds through (journal →
// in-memory doc → broadcast → checkpoint). The HTTP path checkpoints
// NOW (the dependency path's honest row); the WS path rides the calm
// 2s debounce inside the room.
func (s *Server) handleCollabOpsPost(w http.ResponseWriter, r *http.Request) {
	if s.db == nil || s.collabHub == nil {
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
	if req.Device == "" {
		req.Device = "host"
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
	// v1.69.3 THE HANDSHAKE: the author must be the owner OR a member
	// device (a guest writes through ops, never through the row PUT).
	dev, ok := s.collabAuthorized(r, id)
	if !ok {
		writeError(w, http.StatusUnauthorized, "not a member of this canvas")
		return
	}
	if dev != nil {
		req.Device = dev.ID // the credential names the author — never the body
	}
	room, err := s.collabHub.Room(id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "room: "+err.Error())
		return
	}
	sub := room.Submit(req.Device, req.Ops, true)
	if sub.HTTP != 200 {
		writeError(w, sub.HTTP, "ops: "+sub.Err.Error())
		return
	}
	out := make([]any, 0, len(sub.Frames))
	for _, fr := range sub.Frames {
		out = append(out, fr)
	}
	writeJSON(w, http.StatusOK, map[string]any{"ops": out, "latest": sub.Latest})
}
