// canvases.go — v1.42.4 THE LEDGER (PLAN-V142 §3.2 W2): the multi-canvas
// CRUD surface. The web layer's Worlds registry (worlds.js) is the only
// intended client; every handler is a thin, honest gate over
// store/canvases.go:
//
//	GET    /api/canvases              → list rows (summary — no state bytes)
//	GET    /api/canvases?digest=1     → + icon/session ids (hygiene sweep)
//	POST   /api/canvases              → create (id minted when absent)
//	GET    /api/canvases/{id}         → full row (state as raw JSON)
//	PUT    /api/canvases/{id}         → upsert (absent fields keep row values)
//	DELETE /api/canvases/{id}         → idempotent delete
//	PUT    /api/canvases/{id}/thumb   → ≤64KB PNG/JPEG (magic-sniffed, not
//	                                    header-trusted)
//	GET    /api/canvases/{id}/thumb   → the bytes, sniffed content-type
//
// Caps (the plan's ladder; rig-asserted): state ≤ 4 MB (a 500-icon world
// serializes to ~500 KB — 8x headroom), thumb ≤ 64 KB (hub icon parity).
// The body readers are MaxBytesReader-bounded so a hostile/large body
// dies at the door, not mid-parse.
package server

import (
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"

	"github.com/ScoobyBaby1999/doomalay/engine/internal/store"
)

// v1.42.4 caps (bytes).
const (
	canvasStateMaxBytes = 4 << 20  // 4 MB
	canvasThumbMaxBytes = 64 << 10 // 64 KB
)

// handleCanvasesList is GET /api/canvases[?digest=1].
func (s *Server) handleCanvasesList(w http.ResponseWriter, r *http.Request) {
	if s.db == nil {
		writeError(w, http.StatusServiceUnavailable, "no database")
		return
	}
	if r.URL.Query().Get("digest") == "1" {
		digest, err := s.db.ListCanvasDigest()
		if err != nil {
			writeError(w, 500, "digest: "+err.Error())
			return
		}
		writeJSON(w, 200, map[string]any{"canvases": digest})
		return
	}
	rows, err := s.db.ListCanvases()
	if err != nil {
		writeError(w, 500, "list: "+err.Error())
		return
	}
	writeJSON(w, 200, map[string]any{"canvases": rows})
}

// handleCanvasesCreate is POST /api/canvases {id?, name?, sort?, state?}.
func (s *Server) handleCanvasesCreate(w http.ResponseWriter, r *http.Request) {
	if s.db == nil {
		writeError(w, http.StatusServiceUnavailable, "no database")
		return
	}
	var req struct {
		ID    string          `json:"id"`
		Name  *string         `json:"name"`
		Sort  *int64          `json:"sort"`
		State json.RawMessage `json:"state"`
	}
	body := http.MaxBytesReader(w, r.Body, canvasStateMaxBytes+64<<10)
	if err := json.NewDecoder(body).Decode(&req); err != nil {
		var mbe *http.MaxBytesError
		if errors.As(err, &mbe) {
			writeError(w, http.StatusRequestEntityTooLarge, "canvas body over cap")
			return
		}
		writeError(w, 400, "invalid JSON: "+err.Error())
		return
	}
	if req.ID == "" {
		req.ID = "cv_" + generateID()
	}
	// The state contract (same as PUT): a JSON OBJECT, under the cap.
	if len(req.State) > 0 {
		if len(req.State) > canvasStateMaxBytes {
			writeError(w, http.StatusRequestEntityTooLarge, "canvas state over 4MB cap")
			return
		}
		if !isObjectJSON(req.State) {
			writeError(w, 400, "state must be a JSON object")
			return
		}
	}
	var statePtr *string
	if len(req.State) > 0 {
		s := string(req.State)
		statePtr = &s
	}
	out, err := s.db.UpsertCanvas(req.ID, req.Name, req.Sort, statePtr)
	if err != nil {
		writeError(w, 500, "create: "+err.Error())
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"canvas": canvasResponse(out, req.State)})
}

// handleCanvasGet is GET /api/canvases/{id} — the state rides as RAW
// JSON (one client-side parse, not a double-encoded string).
func (s *Server) handleCanvasGet(w http.ResponseWriter, r *http.Request) {
	if s.db == nil {
		writeError(w, http.StatusServiceUnavailable, "no database")
		return
	}
	c, err := s.db.GetCanvas(r.PathValue("id"))
	if errors.Is(err, store.ErrCanvasNotFound) {
		writeError(w, 404, "canvas not found")
		return
	}
	if err != nil {
		writeError(w, 500, "get: "+err.Error())
		return
	}
	writeJSON(w, 200, map[string]any{"canvas": canvasResponse(c, nil)})
}

// handleCanvasUpdate is PUT /api/canvases/{id} {name?, sort?, state?} —
// UPSERT (idempotent migration retries converge on one row). Absent
// fields keep their row values.
func (s *Server) handleCanvasUpdate(w http.ResponseWriter, r *http.Request) {
	if s.db == nil {
		writeError(w, http.StatusServiceUnavailable, "no database")
		return
	}
	id := r.PathValue("id")
	if id == "" || strings.ContainsAny(id, "/\\") {
		writeError(w, 400, "invalid canvas id")
		return
	}
	var req struct {
		Name  *string         `json:"name"`  // absent/null/"" = keep (or default on birth)
		Sort  *int64          `json:"sort"`  // absent = keep (or 0 on birth)
		State json.RawMessage `json:"state"` // absent = keep
	}
	body := http.MaxBytesReader(w, r.Body, canvasStateMaxBytes+64<<10)
	if err := json.NewDecoder(body).Decode(&req); err != nil {
		var mbe *http.MaxBytesError
		if errors.As(err, &mbe) {
			writeError(w, http.StatusRequestEntityTooLarge, "canvas body over cap")
			return
		}
		writeError(w, 400, "invalid JSON: "+err.Error())
		return
	}
	// The state contract: a JSON OBJECT (the WorldState shape — a bare
	// string/number is valid JSON but not a world), under the size cap.
	if len(req.State) > 0 {
		if len(req.State) > canvasStateMaxBytes {
			writeError(w, http.StatusRequestEntityTooLarge, "canvas state over 4MB cap")
			return
		}
		if !isObjectJSON(req.State) {
			writeError(w, 400, "state must be a JSON object")
			return
		}
	}
	// An empty-string name is not a name — treat as absent (keep).
	var namePtr *string
	if req.Name != nil && *req.Name != "" {
		namePtr = req.Name
	}
	var statePtr *string
	if len(req.State) > 0 {
		st := string(req.State)
		statePtr = &st
	}
	// ▀▀ v1.69.1 THE SHARED CANVAS — the doc-staleness gate (PLAN-V169
	// §v1.69.1) ▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀
	// A collab-aware client stamps its state with $.syncSeq — the
	// op-log seq its doc reflects. A whole-state PUT is only legal
	// when the journal has moved no further (Figma's rebase demand):
	// stale → 409, the client fetches the missed ops, rebases its
	// un-acked diff on top, and retries. An OLD-SHAPE state (no
	// syncSeq — a pre-collab client, which this wave never mixes with
	// a journal) writes through as v1.67 did; if a journal somehow
	// exists under it, the journal is VOID (last-write-wins is the
	// documented pre-collab law, made explicit: the ops die with it).
	// Gate + write + watermark are ONE collabMu critical section — a
	// concurrent op-fold can never interleave this read-modify-write
	// (the fold path holds the same mutex through its checkpoint).
	if statePtr != nil {
		s.collabMu.Lock()
		var syncSeq sql.NullInt64
		_ = s.db.QueryRow(`SELECT json_extract(?, '$.syncSeq')`, *statePtr).Scan(&syncSeq)
		latest, lerr := s.db.LatestCanvasOpSeq(id)
		if lerr != nil {
			s.collabMu.Unlock()
			writeError(w, 500, "oplog: "+lerr.Error())
			return
		}
		if syncSeq.Valid && latest > int(syncSeq.Int64) {
			s.collabMu.Unlock()
			writeJSON(w, http.StatusConflict, map[string]any{
				"error":     "stale-doc",
				"ops_since": int(syncSeq.Int64),
				"latest":    latest,
			})
			return
		}
		if !syncSeq.Valid && latest > 0 {
			// old-shape PUT over a journal: the journal is void —
			// and the live room (if any) dies with it (its
			// in-memory doc just became someone else's truth).
			if _, terr := s.db.TrimCanvasOps(id, latest); terr != nil {
				s.collabMu.Unlock()
				writeError(w, 500, "trim: "+terr.Error())
				return
			}
			if s.collabHub != nil {
				s.collabHub.Drop(id)
			}
		}
		out, uerr := s.db.UpsertCanvas(id, namePtr, req.Sort, statePtr)
		if uerr != nil {
			s.collabMu.Unlock()
			writeError(w, 500, "upsert: "+uerr.Error())
			return
		}
		// the checkpoint watermark follows the accepted write:
		// syncSeq (the doc's own truth) when present, else the
		// journal head the write declared itself ahead of.
		if syncSeq.Valid {
			_ = s.db.SetCanvasFoldSeq(id, int(syncSeq.Int64))
		} else if latest > 0 {
			_ = s.db.SetCanvasFoldSeq(id, latest)
		}
		s.collabMu.Unlock()
		writeJSON(w, 200, map[string]any{"canvas": canvasResponse(out, req.State)})
		return
	}
	out, err := s.db.UpsertCanvas(id, namePtr, req.Sort, statePtr)
	if err != nil {
		writeError(w, 500, "upsert: "+err.Error())
		return
	}
	writeJSON(w, 200, map[string]any{"canvas": canvasResponse(out, req.State)})
}

// handleCanvasDelete is DELETE /api/canvases/{id} — idempotent.
func (s *Server) handleCanvasDelete(w http.ResponseWriter, r *http.Request) {
	if s.db == nil {
		writeError(w, http.StatusServiceUnavailable, "no database")
		return
	}
	// v1.69.2 THE ROOM: a deleted canvas's live room dies FIRST — a
	// live room would checkpoint-resurrect the row on its next fold
	// (UpsertCanvas re-creates deleted rows).
	if s.collabHub != nil {
		s.collabHub.Drop(r.PathValue("id"))
	}
	if err := s.db.DeleteCanvas(r.PathValue("id")); err != nil {
		writeError(w, 500, "delete: "+err.Error())
		return
	}
	writeJSON(w, 200, map[string]bool{"ok": true})
}

// handleCanvasThumbPut is PUT /api/canvases/{id}/thumb — raw image
// bytes. The verdict comes from the MAGIC BYTES, never the client's
// Content-Type (a header is a claim, not a proof).
func (s *Server) handleCanvasThumbPut(w http.ResponseWriter, r *http.Request) {
	if s.db == nil {
		writeError(w, http.StatusServiceUnavailable, "no database")
		return
	}
	id := r.PathValue("id")
	body := http.MaxBytesReader(w, r.Body, canvasThumbMaxBytes+1)
	thumb, err := io.ReadAll(body)
	if err != nil {
		var mbe *http.MaxBytesError
		if errors.As(err, &mbe) || len(thumb) > canvasThumbMaxBytes {
			writeError(w, http.StatusRequestEntityTooLarge, "thumbnail over 64KB cap")
			return
		}
		writeError(w, 400, "read: "+err.Error())
		return
	}
	if len(thumb) > canvasThumbMaxBytes {
		writeError(w, http.StatusRequestEntityTooLarge, "thumbnail over 64KB cap")
		return
	}
	ct := sniffImage(thumb)
	if ct == "" {
		writeError(w, http.StatusUnsupportedMediaType, "thumbnail must be PNG or JPEG bytes")
		return
	}
	if err := s.db.PutCanvasThumb(id, thumb); err != nil {
		if errors.Is(err, store.ErrCanvasNotFound) {
			writeError(w, 404, "canvas not found")
			return
		}
		writeError(w, 500, "thumb: "+err.Error())
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true, "content_type": ct, "bytes": len(thumb)})
}

// handleCanvasThumbGet is GET /api/canvases/{id}/thumb — the bytes with
// the sniffed type (404 both for a missing canvas AND a canvas without
// a thumb — one honest shape).
func (s *Server) handleCanvasThumbGet(w http.ResponseWriter, r *http.Request) {
	if s.db == nil {
		writeError(w, http.StatusServiceUnavailable, "no database")
		return
	}
	thumb, err := s.db.GetCanvasThumb(r.PathValue("id"))
	if errors.Is(err, store.ErrCanvasNotFound) || (err == nil && len(thumb) == 0) {
		writeError(w, 404, "no thumbnail")
		return
	}
	if err != nil {
		writeError(w, 500, "thumb: "+err.Error())
		return
	}
	ct := sniffImage(thumb)
	if ct == "" {
		ct = "application/octet-stream" // stored pre-sniff epoch — serve raw
	}
	w.Header().Set("Content-Type", ct)
	w.Header().Set("Cache-Control", "no-store") // thumbs change with the canvas
	w.WriteHeader(200)
	_, _ = w.Write(thumb)
}

// canvasResponse builds the API shape: the row fields + the state as
// raw JSON when present (pass the caller's own RawMessage to avoid a
// re-parse round-trip; nil reads the stored text). fold_seq (v1.69.1)
// rides along — the op-log watermark a collab client's cursor starts
// from when it adopts a row snapshot.
func canvasResponse(c *store.Canvas, state json.RawMessage) map[string]any {
	if state == nil && c.State != "" {
		state = json.RawMessage(c.State)
	}
	out := map[string]any{
		"id":         c.ID,
		"name":       c.Name,
		"sort":       c.Sort,
		"fold_seq":   c.FoldSeq,
		"created_at": c.CreatedAt,
		"updated_at": c.UpdatedAt,
	}
	if len(state) > 0 {
		out["state"] = state
	} else {
		out["state"] = nil
	}
	return out
}

// isObjectJSON reports whether raw (already-valid JSON bytes) is an
// OBJECT — the WorldState contract. A quoted string is valid JSON but
// not a world; refusing it here keeps worlds.js's state.icons access
// honest.
func isObjectJSON(raw []byte) bool {
	for _, b := range raw {
		switch b {
		case ' ', '\t', '\r', '\n':
			continue
		case '{':
			return true
		default:
			return false
		}
	}
	return false
}

// sniffImage returns the content type for PNG/JPEG magic bytes ("" when
// neither — the caller maps that to 415).
func sniffImage(b []byte) string {
	if len(b) >= 8 && b[0] == 0x89 && b[1] == 'P' && b[2] == 'N' && b[3] == 'G' &&
		b[4] == 0x0D && b[5] == 0x0A && b[6] == 0x1A && b[7] == 0x0A {
		return "image/png"
	}
	if len(b) >= 3 && b[0] == 0xFF && b[1] == 0xD8 && b[2] == 0xFF {
		return "image/jpeg"
	}
	return ""
}
