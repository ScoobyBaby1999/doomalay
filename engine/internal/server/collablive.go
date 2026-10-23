// collablive.go — v1.69.2 THE SHARED CANVAS (PLAN-V169 §v1.69.2): the
// LIVE surface — the WebSocket room door, the POST reroute through the
// one-writer room, the authoritative /doc read, and the rooms census.
//
//	GET  /api/collab/live?canvas=&since=&device=&name= — the room door:
//	     upgrade → join (hello + replay-from-cursor) → the read pump
//	     (ops submits / presence / ping) + the write pump (the member's
//	     send queue + 30s pings — the researched constants: Cloudflare
//	     kills idle proxied WS at ~100s, the 75% rule keeps 30s clear).
//
//	POST /api/collab/{canvas}/ops — rerouted through the room (the
//	     ONE-WRITER law: the HTTP dependency path and the WS hot path
//	     fold through the same goroutine; HTTP checkpoints NOW).
//
//	GET  /api/collab/{canvas}/doc — the authoritative CURRENT doc (the
//	     live room's in-memory truth when it exists; the durable fold
//	     otherwise). The adoption read a joining client uses.
//
//	GET  /api/collab/rooms — the census (the rig's dormancy pins).
package server

import (
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"strconv"
	"time"

	"github.com/gorilla/websocket"

	"github.com/ScoobyBaby1999/doomalay/engine/internal/collab"
	"github.com/ScoobyBaby1999/doomalay/engine/internal/store"
)

// The live-wire timing laws (the researched constants).
const (
	collabReadDeadline = 60 * time.Second // pong-guarded
	collabWriteWait    = 10 * time.Second
	collabPingEvery    = 30 * time.Second
)

// handleCollabLive is GET /api/collab/live — the room door.
func (s *Server) handleCollabLive(w http.ResponseWriter, r *http.Request) {
	if s.db == nil || s.collabHub == nil {
		writeError(w, http.StatusServiceUnavailable, "no database")
		return
	}
	q := r.URL.Query()
	canvasID := q.Get("canvas")
	if canvasID == "" {
		writeError(w, http.StatusBadRequest, "canvas is required")
		return
	}
	since, _ := strconv.Atoi(q.Get("since"))
	if since < 0 {
		since = 0
	}
	device := q.Get("device")
	if device == "" {
		device = "host"
	}
	name := q.Get("name")
	if name == "" {
		name = device
	}
	if _, err := s.db.GetCanvas(canvasID); err != nil {
		if errors.Is(err, store.ErrCanvasNotFound) {
			writeError(w, http.StatusNotFound, "canvas not found")
			return
		}
		writeError(w, http.StatusInternalServerError, "get: "+err.Error())
		return
	}
	// v1.69.3 THE HANDSHAKE: the joiner is the owner OR a member device
	// — the credential names the device (never the query param).
	dev, ok := s.collabAuthorized(r, canvasID)
	if !ok {
		writeError(w, http.StatusUnauthorized, "not a member of this canvas")
		return
	}
	if dev != nil {
		device = dev.ID
		if name == "" || name == device {
			name = dev.Name
		}
	}
	room, err := s.collabHub.Room(canvasID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "room: "+err.Error())
		return
	}
	upgrader := s.newUpgrader()
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("collab ws upgrade: %v", err)
		return
	}
	defer conn.Close()

	send := make(chan []byte, collab.MemberSendBuffer)
	member := collab.NewMember(device, name, send, func() { _ = conn.Close() })

	// the join (hello + the replay batch land in the send queue; the
	// write pump drains them in order)
	res := room.Join(member, since)
	if res.HTTP != 200 {
		return
	}

	// the write pump — the ONE conn writer (gorilla's law), draining the
	// member queue + the 30s pings.
	go func() {
		ping := time.NewTicker(collabPingEvery)
		defer ping.Stop()
		for {
			select {
			case b := <-send:
				_ = conn.SetWriteDeadline(time.Now().Add(collabWriteWait))
				if err := conn.WriteMessage(websocket.TextMessage, b); err != nil {
					return
				}
			case <-ping.C:
				_ = conn.SetWriteDeadline(time.Now().Add(collabWriteWait))
				if err := conn.WriteMessage(websocket.PingMessage, nil); err != nil {
					return
				}
			}
		}
	}()

	// the read pump — this handler's own loop (the chat WS pattern).
	_ = conn.SetReadDeadline(time.Now().Add(collabReadDeadline))
	conn.SetPongHandler(func(string) error {
		return conn.SetReadDeadline(time.Now().Add(collabReadDeadline))
	})
	for {
		_, raw, err := conn.ReadMessage()
		if err != nil {
			room.Leave(member)
			return
		}
		var msg map[string]any
		if err := json.Unmarshal(raw, &msg); err != nil {
			continue
		}
		switch msg["t"] {
		case "ops":
			ops, err := parseOpsFrame(msg["ops"])
			if err != nil {
				errFrame, _ := json.Marshal(map[string]any{"t": "error", "code": 400, "error": err.Error()})
				member.Send(errFrame)
				continue
			}
			sub := room.Submit(device, ops, false)
			if sub.HTTP != 200 {
				errFrame, _ := json.Marshal(map[string]any{"t": "error", "code": sub.HTTP, "error": ""})
				if sub.Err != nil {
					errFrame, _ = json.Marshal(map[string]any{"t": "error", "code": sub.HTTP, "error": sub.Err.Error()})
				}
				member.Send(errFrame)
			}
			// the ack itself is the broadcast (the member's own queue).
		case "presence":
			state, _ := msg["state"].(map[string]any)
			room.PresenceUpdate(device, state)
		case "ping":
			pong, _ := json.Marshal(map[string]any{"t": "pong"})
			member.Send(pong)
		}
	}
}

// parseOpsFrame decodes the client's ops array (json.RawMessage → Op
// keeps the payloads verbatim).
func parseOpsFrame(v any) ([]collab.Op, error) {
	raw, err := json.Marshal(v)
	if err != nil {
		return nil, err
	}
	var ops []collab.Op
	if err := json.Unmarshal(raw, &ops); err != nil {
		return nil, err
	}
	if len(ops) == 0 {
		return nil, errors.New("no ops")
	}
	return ops, nil
}

// handleCollabDoc is GET /api/collab/{canvas}/doc — the authoritative
// CURRENT doc (the adoption read).
func (s *Server) handleCollabDoc(w http.ResponseWriter, r *http.Request) {
	if s.db == nil || s.collabHub == nil {
		writeError(w, http.StatusServiceUnavailable, "no database")
		return
	}
	id := r.PathValue("canvas")
	if id == "" {
		writeError(w, http.StatusBadRequest, "canvas id required")
		return
	}
	// v1.69.3 THE HANDSHAKE: THE GATE — the owner OR a member device of
	// THIS canvas; the same verdict drives THE GATED PORTALS filter (a
	// member sees only the portals it may jump to; the owner never
	// filtered).
	dev, ok := s.collabAuthorized(r, id)
	if !ok {
		writeError(w, http.StatusUnauthorized, "not a member of this canvas")
		return
	}
	if room := s.collabHub.Get(id); room != nil {
		doc, seq := room.DocSnapshot()
		if dev != nil {
			filterDocForDevice(doc, s.visibleCanvases(r, dev))
		}
		writeJSON(w, http.StatusOK, map[string]any{"doc": doc, "seq": seq, "live": true, "canvas": id})
		return
	}
	// the durable fold: the row's doc plane + the journal tail past the
	// row's own $.syncSeq watermark (the room-load twin, cold).
	c, err := s.db.GetCanvas(id)
	if err != nil {
		if errors.Is(err, store.ErrCanvasNotFound) {
			writeError(w, http.StatusNotFound, "canvas not found")
			return
		}
		writeError(w, http.StatusInternalServerError, "get: "+err.Error())
		return
	}
	state, err := collab.StateObject(c.State)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "state: "+err.Error())
		return
	}
	syncSeq := 0
	if v, ok := state["syncSeq"].(float64); ok {
		syncSeq = int(v)
	}
	doc := map[string]any{}
	for _, k := range []string{"icons", "dots", "currentFamily", "worldSize"} {
		if v, ok := state[k]; ok {
			doc[k] = v
		}
	}
	latest, err := s.db.LatestCanvasOpSeq(id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "oplog: "+err.Error())
		return
	}
	if latest > syncSeq {
		tail, err := s.db.ListCanvasOps(id, syncSeq+1)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "oplog: "+err.Error())
			return
		}
		for _, row := range tail {
			var op collab.Op
			if err := json.Unmarshal([]byte(row.Op), &op); err == nil {
				_ = collab.FoldOp(doc, op)
			}
		}
	}
	// v1.69.3 THE GATED PORTALS (the durable path filters too).
	if dev != nil {
		filterDocForDevice(doc, s.visibleCanvases(r, dev))
	}
	writeJSON(w, http.StatusOK, map[string]any{"doc": doc, "seq": latest, "fold_seq": c.FoldSeq, "live": false, "canvas": id})
}

// handleCollabRooms is GET /api/collab/rooms — the census. OWNER-ONLY
// (the census names canvases + devices — a guest's business never).
func (s *Server) handleCollabRooms(w http.ResponseWriter, r *http.Request) {
	if !s.ownerRequest(r) {
		writeError(w, http.StatusUnauthorized, "owner only")
		return
	}
	if s.collabHub == nil {
		writeJSON(w, http.StatusOK, map[string]any{"rooms": []any{}})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"rooms": s.collabHub.Snapshot()})
}
