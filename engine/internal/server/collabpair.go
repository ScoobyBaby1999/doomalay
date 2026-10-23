// collabpair.go — v1.69.3 THE HANDSHAKE (PLAN-V169 §v1.69.3): the
// pairing surface + the collab auth wrapper.
//
//	Route map:
//	  POST /api/collab/pair                    — the joiner's claim
//	          {canvas, code, name} → {device_code}      (rate-limited;
//	          OUTSIDE the global gate — the joiner has no credential yet)
//	  GET  /api/collab/pair/{device_code}      — the joiner's ~5s poll →
//	          {status: pending|approved|denied|expired|unknown} (+token)
//	  POST /api/collab/{canvas}/invite         — OWNER: mint (6-digit,
//	          ≤5min, one live invite per canvas)
//	  GET  /api/collab/{canvas}/invite         — OWNER: the live invite
//	          (the code + the pending claim for the Allow/Deny sheet)
//	  POST /api/collab/{canvas}/invite/approve — OWNER: THE TAP
//	  POST /api/collab/{canvas}/invite/deny    — OWNER
//	  GET  /api/collab/{canvas}/members        — OWNER: the roster
//	  POST /api/collab/{canvas}/members/{device}/revoke — OWNER: the
//	          grant dies + the live room evicts the device mid-stream
//	  GET  /api/collab/my                      — the DEVICE's own shared
//	          registry (token-gated; the guest's canvas list)
//
//	AUTH (collabAuthorized): a collab surface answers the OWNER (the
//	engine's own law: localhost-trust or the global bearer) OR a device
//	token that is a MEMBER of THAT canvas — the per-canvas sandbox.
//	Everything else under /api/collab/ (pair + my + live + ops + doc)
//	sits OUTSIDE the global gate and behind THIS gate instead.
package server

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/ScoobyBaby1999/doomalay/engine/internal/collab"
	"github.com/ScoobyBaby1999/doomalay/engine/internal/store"
)

// The pairing rate law: 10 claims per IP per minute (the online-guess
// ceiling — a 6-digit code is 1-in-10⁶ per try; the limiter keeps even
// scripted guessing pointless inside the 5-minute TTL).
const (
	collabPairRateMax  = 10
	collabPairRateWind = time.Minute
)

// ownerRequest is the engine's own law (the authMiddleware twin): no
// configured token → localhost trust; a token → the bearer check.
func (s *Server) ownerRequest(r *http.Request) bool {
	if s.cfg.AuthToken == "" {
		host := r.RemoteAddr
		return strings.HasPrefix(host, "127.0.0.1") || strings.HasPrefix(host, "[::1]") || strings.HasPrefix(host, "localhost")
	}
	h := r.Header.Get("Authorization")
	return strings.HasPrefix(h, "Bearer ") && h[7:] == s.cfg.AuthToken
}

// requestToken pulls the device credential (query param — the browser's
// WebSocket cannot set headers).
func requestToken(r *http.Request) string {
	if tok := r.URL.Query().Get("token"); tok != "" {
		return tok
	}
	return r.Header.Get("X-Doomalay-Device")
}

// collabDevice resolves + validates a device credential (a revoked
// token is dead). Touches last_seen on success.
func (s *Server) collabDevice(r *http.Request) *store.CollabDevice {
	tok := requestToken(r)
	if tok == "" || s.db == nil {
		return nil
	}
	dev, err := s.db.CollabDeviceByToken(collab.HashToken(tok))
	if err != nil || dev == nil {
		return nil
	}
	s.db.TouchCollabDevice(dev.ID)
	return dev
}

// collabAuthorized is THE gate: the owner OR a member device of THIS
// canvas. Returns the device (nil = the owner path). The global bearer
// may ride the QUERY for WebSocket upgrades (a browser WS cannot attach
// headers — the engine's logging never writes query strings, the
// documented law).
func (s *Server) collabAuthorized(r *http.Request, canvasID string) (*store.CollabDevice, bool) {
	if s.ownerRequest(r) {
		return nil, true
	}
	if tok := requestToken(r); tok != "" && s.cfg.AuthToken != "" && tok == s.cfg.AuthToken {
		return nil, true // the global bearer via query — the owner's WS path
	}
	dev := s.collabDevice(r)
	if dev == nil {
		return nil, false
	}
	ok, err := s.db.IsCollabMember(canvasID, dev.ID)
	if err != nil || !ok {
		return nil, false
	}
	return dev, true
}

// visibleCanvases is the requester's render set: the owner sees ALL
// canvases; a device sees its member canvases (+ the requested canvas
// itself — it is reading that one's doc).
func (s *Server) visibleCanvases(r *http.Request, dev *store.CollabDevice) map[string]bool {
	out := map[string]bool{}
	if dev == nil {
		rows, err := s.db.ListCanvases()
		if err == nil {
			for _, row := range rows {
				out[row.ID] = true
			}
		}
		return out
	}
	members, err := s.db.CollabCanvasesForDevice(dev.ID)
	if err == nil {
		for _, m := range members {
			if id, ok := m["id"].(string); ok {
				out[id] = true
			}
		}
	}
	return out
}

// filterDocForDevice strips the portals the requester may NOT jump to —
// THE GATED PORTALS law ("until then it is unknown to them"): a hole
// icon whose target is outside the requester's visible set does not
// exist for them. The owner path is never filtered.
func filterDocForDevice(doc map[string]any, visible map[string]bool) {
	icons, ok := doc["icons"].([]any)
	if !ok {
		return
	}
	out := make([]any, 0, len(icons))
	for _, ic := range icons {
		if m, ok := ic.(map[string]any); ok {
			if t, _ := m["type"].(string); t == "hole" {
				target, _ := m["targetWorldId"].(string)
				if target != "" && !visible[target] {
					continue // unknown to this device — never rendered
				}
			}
		}
		out = append(out, ic)
	}
	doc["icons"] = out
}

// handleCollabPair is POST /api/collab/pair — the joiner's single-use
// claim. OUTSIDE the global gate; rate-limited per IP.
func (s *Server) handleCollabPair(w http.ResponseWriter, r *http.Request) {
	if s.db == nil {
		writeError(w, http.StatusServiceUnavailable, "no database")
		return
	}
	if !s.collabPairAllowed(r) {
		writeError(w, http.StatusTooManyRequests, "too many pairing attempts — wait a minute")
		return
	}
	var req struct {
		Canvas string `json:"canvas"`
		Code   string `json:"code"`
		Name   string `json:"name"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 16<<10)).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON: "+err.Error())
		return
	}
	if req.Canvas == "" {
		writeError(w, http.StatusBadRequest, "canvas is required")
		return
	}
	// the canvas must exist (a pairing names a real host row).
	if _, err := s.db.GetCanvas(req.Canvas); err != nil {
		if errors.Is(err, store.ErrCanvasNotFound) {
			writeError(w, http.StatusNotFound, "canvas not found")
			return
		}
		writeError(w, http.StatusInternalServerError, "get: "+err.Error())
		return
	}
	deviceCode, err := s.collabEnroll.Pair(req.Canvas, req.Code, req.Name)
	if err != nil {
		switch {
		case errors.Is(err, collab.ErrPairBadCode), errors.Is(err, collab.ErrPairNoInvite):
			writeError(w, http.StatusNotFound, "no matching invite") // the honest miss — no oracle
		case errors.Is(err, collab.ErrPairExpired):
			writeError(w, http.StatusGone, "the code expired")
		case errors.Is(err, collab.ErrPairTaken):
			writeError(w, http.StatusConflict, "this invite was already claimed")
		case errors.Is(err, collab.ErrPairDenied):
			writeError(w, http.StatusForbidden, "denied")
		default:
			writeError(w, http.StatusInternalServerError, "pair: "+err.Error())
		}
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"device_code": deviceCode, "poll_ms": 5000})
}

// handleCollabPairStatus is GET /api/collab/pair?device_code=X — the
// joiner's poll (the token arrives here ONCE, minted from the pairing
// session's own device_code — idempotent across polls). The query-param
// form keeps the route map conflict-free (a literal segment-2 can't
// host a wildcard segment-3 beside {canvas}/ops — the mux's law).
func (s *Server) handleCollabPairStatus(w http.ResponseWriter, r *http.Request) {
	if s.db == nil {
		writeError(w, http.StatusServiceUnavailable, "no database")
		return
	}
	dc := r.URL.Query().Get("device_code")
	if dc == "" {
		writeError(w, http.StatusBadRequest, "device_code is required")
		return
	}
	res := s.collabEnroll.PairStatus(dc)
	body := map[string]any{"status": res.Status}
	if res.Status == "approved" {
		body["device_id"] = res.Device
		body["token"] = res.Token
	}
	if res.Err != nil && res.Status == "error" {
		writeError(w, http.StatusInternalServerError, "pair: "+res.Err.Error())
		return
	}
	writeJSON(w, http.StatusOK, body)
}

// handleCollabInviteMint is POST /api/collab/{canvas}/invite — OWNER.
func (s *Server) handleCollabInviteMint(w http.ResponseWriter, r *http.Request) {
	if s.db == nil {
		writeError(w, http.StatusServiceUnavailable, "no database")
		return
	}
	if !s.ownerRequest(r) {
		writeError(w, http.StatusUnauthorized, "owner only")
		return
	}
	id := r.PathValue("canvas")
	if _, err := s.db.GetCanvas(id); err != nil {
		if errors.Is(err, store.ErrCanvasNotFound) {
			writeError(w, http.StatusNotFound, "canvas not found")
			return
		}
		writeError(w, http.StatusInternalServerError, "get: "+err.Error())
		return
	}
	inv, err := s.collabEnroll.MintInvite(id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "mint: "+err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"code":       inv.Code,
		"expires_at": inv.ExpiresAt,
		"claimed":    inv.ClaimedName,
	})
}

// handleCollabInviteGet is GET /api/collab/{canvas}/invite — OWNER: the
// live invite + the pending claim (the Allow/Deny sheet's poll).
func (s *Server) handleCollabInviteGet(w http.ResponseWriter, r *http.Request) {
	if s.db == nil {
		writeError(w, http.StatusServiceUnavailable, "no database")
		return
	}
	if !s.ownerRequest(r) {
		writeError(w, http.StatusUnauthorized, "owner only")
		return
	}
	inv, err := s.db.GetCollabInvite(r.PathValue("canvas"))
	if err != nil {
		if errors.Is(err, store.ErrInviteNotFound) {
			writeJSON(w, http.StatusOK, map[string]any{"invite": nil})
			return
		}
		writeError(w, http.StatusInternalServerError, "invite: "+err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"invite": inv})
}

// handleCollabInviteApprove is POST /api/collab/{canvas}/invite/approve
// — OWNER: THE TAP (the human handshake).
func (s *Server) handleCollabInviteApprove(w http.ResponseWriter, r *http.Request) {
	if s.db == nil {
		writeError(w, http.StatusServiceUnavailable, "no database")
		return
	}
	if !s.ownerRequest(r) {
		writeError(w, http.StatusUnauthorized, "owner only")
		return
	}
	id := r.PathValue("canvas")
	if err := s.collabEnroll.Approve(id); err != nil {
		switch {
		case errors.Is(err, collab.ErrPairNoInvite):
			writeError(w, http.StatusNotFound, "no live invite")
		case errors.Is(err, collab.ErrPairNotClaimed):
			writeError(w, http.StatusConflict, "no one has claimed this code yet")
		case errors.Is(err, collab.ErrPairDenied):
			writeError(w, http.StatusConflict, "already denied")
		default:
			writeError(w, http.StatusInternalServerError, "approve: "+err.Error())
		}
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// handleCollabInviteDeny is POST /api/collab/{canvas}/invite/deny — OWNER.
func (s *Server) handleCollabInviteDeny(w http.ResponseWriter, r *http.Request) {
	if s.db == nil {
		writeError(w, http.StatusServiceUnavailable, "no database")
		return
	}
	if !s.ownerRequest(r) {
		writeError(w, http.StatusUnauthorized, "owner only")
		return
	}
	if err := s.collabEnroll.Deny(r.PathValue("canvas")); err != nil {
		writeError(w, http.StatusInternalServerError, "deny: "+err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// handleCollabMembers is GET /api/collab/{canvas}/members — OWNER (the
// roster with revoke affordances).
func (s *Server) handleCollabMembers(w http.ResponseWriter, r *http.Request) {
	if s.db == nil {
		writeError(w, http.StatusServiceUnavailable, "no database")
		return
	}
	if !s.ownerRequest(r) {
		writeError(w, http.StatusUnauthorized, "owner only")
		return
	}
	members, err := s.db.ListCollabMembers(r.PathValue("canvas"))
	if err != nil {
		writeError(w, http.StatusInternalServerError, "members: "+err.Error())
		return
	}
	if members == nil {
		members = []map[string]any{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"members": members})
}

// handleCollabMemberRevoke is POST /api/collab/{canvas}/members/{device}/revoke
// — OWNER: the grant dies, the live sockets die with it (the room's own
// evict surgery), and the device row dies when its LAST grant dies.
func (s *Server) handleCollabMemberRevoke(w http.ResponseWriter, r *http.Request) {
	if s.db == nil {
		writeError(w, http.StatusServiceUnavailable, "no database")
		return
	}
	if !s.ownerRequest(r) {
		writeError(w, http.StatusUnauthorized, "owner only")
		return
	}
	canvasID := r.PathValue("canvas")
	deviceID := r.PathValue("device")
	if err := s.db.RemoveCollabMember(canvasID, deviceID); err != nil {
		writeError(w, http.StatusInternalServerError, "revoke: "+err.Error())
		return
	}
	// no grants left → the device credential dies outright
	if rows, err := s.db.CollabCanvasesForDevice(deviceID); err == nil && len(rows) == 0 {
		_ = s.db.RevokeCollabDevice(deviceID)
	}
	// the live room evicts the device's sockets mid-stream
	if s.collabHub != nil {
		if room := s.collabHub.Get(canvasID); room != nil {
			room.EvictDevice(deviceID)
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// handleCollabMy is GET /api/collab/my — the DEVICE's own registry
// (token-gated; the guest's canvas list — the per-canvas sandbox made
// visible).
func (s *Server) handleCollabMy(w http.ResponseWriter, r *http.Request) {
	if s.db == nil {
		writeError(w, http.StatusServiceUnavailable, "no database")
		return
	}
	dev := s.collabDevice(r)
	if dev == nil {
		writeError(w, http.StatusUnauthorized, "device token required")
		return
	}
	rows, err := s.db.CollabCanvasesForDevice(dev.ID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "my: "+err.Error())
		return
	}
	if rows == nil {
		rows = []map[string]any{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"device": map[string]any{"id": dev.ID, "name": dev.Name}, "canvases": rows})
}

// ── the pairing rate limiter (per IP, in-memory) ────────────────────

func (s *Server) collabPairAllowed(r *http.Request) bool {
	s.collabPairMu.Lock()
	defer s.collabPairMu.Unlock()
	if s.collabPairHits == nil {
		s.collabPairHits = map[string][]time.Time{}
	}
	ip := r.RemoteAddr
	if i := strings.LastIndex(ip, ":"); i > 0 {
		ip = ip[:i]
	}
	now := time.Now()
	hits := s.collabPairHits[ip]
	keep := hits[:0]
	for _, t := range hits {
		if now.Sub(t) < collabPairRateWind {
			keep = append(keep, t)
		}
	}
	if len(keep) >= collabPairRateMax {
		s.collabPairHits[ip] = keep
		return false
	}
	keep = append(keep, now)
	s.collabPairHits[ip] = keep
	return true
}
