// hub.go — v1.69.2 THE SHARED CANVAS: the room registry. Get-or-create
// under one mutex (two joins can never birth two loops); Drop evicts
// (the journal-void law + canvas deletion); Snapshot feeds the
// introspection surface. An EMPTY hub runs zero goroutines — rooms are
// born on the first join/submit and die on the last leave (dormancy).
package collab

import (
	"fmt"
	"sync"
)

// Hub owns the live rooms.
type Hub struct {
	io        RoomIO
	serialize func(do func())

	mu    sync.Mutex
	rooms map[string]*Room
}

// NewHub binds the durable-truth interface + the scoped serializer.
func NewHub(io RoomIO, serialize func(do func())) *Hub {
	return &Hub{io: io, serialize: serialize, rooms: map[string]*Room{}}
}

// Room returns the canvas's live room, creating + starting its loop on
// first demand. A missing canvas row answers the store's error (the
// shared doc is born from a host row — the v1.69.1 law).
func (h *Hub) Room(canvasID string) (*Room, error) {
	h.mu.Lock()
	r, ok := h.rooms[canvasID]
	if ok {
		h.mu.Unlock()
		return r, nil
	}
	h.mu.Unlock()
	// create OUTSIDE the lock (NewRoom does IO — the row read + the
	// journal tail fold); a raced creator loses cleanly.
	nr, err := NewRoom(canvasID, h.io, h.serialize)
	if err != nil {
		return nil, err
	}
	h.mu.Lock()
	if r, ok := h.rooms[canvasID]; ok {
		// lost the race — the winner's loop serves; ours dies unborn (a
		// VOID drop: its load-time doc may already be stale — never a
		// flush).
		h.mu.Unlock()
		nr.DropVoid()
		return r, nil
	}
	// the self-drop eviction hook: a room that empties (the last leave,
	// or an HTTP-only submit on a memberless room) removes ITSELF — a
	// later Room() call births a fresh loop over the durable truth
	// instead of answering 410 from a dead one.
	nr.onDrop = func() {
		h.mu.Lock()
		if h.rooms[canvasID] == nr {
			delete(h.rooms, canvasID)
		}
		h.mu.Unlock()
	}
	h.rooms[canvasID] = nr
	h.mu.Unlock()
	go nr.Run()
	return nr, nil
}

// Drop evicts a room WITHOUT the trailing flush — the journal was
// voided under it (an old-shape PUT), the canvas row died (delete — a
// flush would resurrect it), or the room lost a creation race (its
// load-time doc may already be stale). All three must never write.
func (h *Hub) Drop(canvasID string) {
	h.mu.Lock()
	r, ok := h.rooms[canvasID]
	if ok {
		delete(h.rooms, canvasID)
	}
	h.mu.Unlock()
	if ok {
		r.DropVoid()
	}
}

// Get returns the canvas's live room when one exists (nil otherwise —
// no creation; the /doc endpoint's fast path).
func (h *Hub) Get(canvasID string) *Room {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.rooms[canvasID]
}

// Snapshot returns the live rooms' census (the introspection surface +
// the rig's dormancy pins).
func (h *Hub) Snapshot() []map[string]any {
	h.mu.Lock()
	defer h.mu.Unlock()
	out := make([]map[string]any, 0, len(h.rooms))
	for id, r := range h.rooms {
		members := r.SnapshotMembers()
		out = append(out, map[string]any{
			"canvas":  id,
			"members": len(members),
			"seq":     r.Latest(),
			"live":    len(members) > 0,
		})
	}
	return out
}

// ErrRoomGone is the honest eviction answer (HTTP 410).
var ErrRoomGone = fmt.Errorf("collab: room dropped")
