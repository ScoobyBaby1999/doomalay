// ring.go — the per-session debug event buffer (v1.14.4 THE TRACE).
//
// A bounded in-memory tail of every event, per session, served by
// GET /api/debug/trace — the no-OTel debugging path (works on a phone
// with zero infrastructure). Caps: 512 events per session, 128 sessions
// (least-recently-updated evicted). Delta events only land when
// DOOM_TRACE_DELTAS >= 1 — gate 0 keeps the ring for the structural
// story (turns, rounds, requests, tools, usage, finish).
package obs

import (
	"sync"
	"time"
)

const (
	ringCap        = 512
	sessionCap     = 128
	deltaRingPrune = 4096 // hard global cap on delta events across all rings
)

type ringBuf struct {
	buf      []Event // circular; len == ringCap after wrap
	head     int     // next write position
	count    int
	total    int
	last     time.Time
	deltaCnt int
}

var (
	ringMu   sync.Mutex
	sessionR = map[string]*ringBuf{}
)

// recordEvent appends to the session's ring (kind-gated).
func recordEvent(e Event) {
	if isDeltaKind(e.Kind) && DeltaTrace() == 0 {
		return
	}
	ringMu.Lock()
	defer ringMu.Unlock()
	r, ok := sessionR[e.SessionID]
	if !ok {
		if len(sessionR) >= sessionCap {
			evictOldestSessionLocked()
		}
		r = &ringBuf{}
		sessionR[e.SessionID] = r
	}
	if r.head >= len(r.buf) {
		if len(r.buf) < ringCap {
			r.buf = append(r.buf, e)
			r.head = len(r.buf)
			r.count = len(r.buf)
			r.total++
			r.last = e.At
			if isDeltaKind(e.Kind) {
				r.deltaCnt++
			}
			return
		}
		r.head = 0 // wrap
	}
	if isDeltaKind(r.buf[r.head].Kind) {
		r.deltaCnt--
	}
	r.buf[r.head] = e
	r.head++
	r.total++
	r.last = e.At
	if isDeltaKind(e.Kind) {
		r.deltaCnt++
	}
	// global delta flood valve: when every ring is drowning in deltas,
	// drop the OLDEST delta entries across this ring until it breathes
	if isDeltaKind(e.Kind) && totalDeltasLocked() > deltaRingPrune {
		pruneOldestDeltasLocked(totalDeltasLocked() - deltaRingPrune)
	}
}

func isDeltaKind(k Kind) bool {
	switch k {
	case ReasoningDelta, ContentDelta, ToolCallDelta:
		return true
	}
	return false
}

func totalDeltasLocked() int {
	n := 0
	for _, r := range sessionR {
		n += r.deltaCnt
	}
	return n
}

func pruneOldestDeltasLocked(n int) {
	// walk all rings oldest-first (by Seq) dropping delta events
	for n > 0 {
		var oldest *Event
		var oldestRing *ringBuf
		var oldestIdx int
		for _, r := range sessionR {
			for i := 0; i < r.count; i++ {
				pos := (r.head - r.count + i + len(r.buf)*2) % len(r.buf)
				ev := &r.buf[pos]
				if ev.Kind != "" && isDeltaKind(ev.Kind) {
					if oldest == nil || ev.Seq < oldest.Seq {
						oldest = ev
						oldestRing = r
						oldestIdx = pos
					}
					break // only the oldest entry of each ring is a candidate per pass
				}
			}
		}
		if oldest == nil {
			return
		}
		var zero Event
		oldestRing.buf[oldestIdx] = zero
		oldestRing.deltaCnt--
		n--
	}
}

func evictOldestSessionLocked() {
	var oldestID string
	var oldest time.Time
	first := true
	for id, r := range sessionR {
		if first || r.last.Before(oldest) {
			oldestID, oldest, first = id, r.last, false
		}
	}
	if oldestID != "" {
		delete(sessionR, oldestID)
	}
}

// SessionInfo is one live session's ring summary.
type SessionInfo struct {
	SessionID string    `json:"session_id"`
	Events    int       `json:"events"`
	Total     int       `json:"total"`
	Deltas    int       `json:"deltas"`
	LastAt    time.Time `json:"last_at"`
}

// Sessions lists the rings (newest activity first).
func Sessions() []SessionInfo {
	ringMu.Lock()
	defer ringMu.Unlock()
	out := make([]SessionInfo, 0, len(sessionR))
	for id, r := range sessionR {
		out = append(out, SessionInfo{
			SessionID: id,
			Events:    r.count,
			Total:     r.total,
			Deltas:    r.deltaCnt,
			LastAt:    r.last,
		})
	}
	for i := 1; i < len(out); i++ {
		for j := i; j > 0 && out[j].LastAt.After(out[j-1].LastAt); j-- {
			out[j], out[j-1] = out[j-1], out[j]
		}
	}
	return out
}

// Snapshot returns up to limit events of one session, oldest first.
// limit <= 0 means everything the ring holds.
func Snapshot(sessionID string, limit int) []Event {
	ringMu.Lock()
	defer ringMu.Unlock()
	r, ok := sessionR[sessionID]
	if !ok {
		return nil
	}
	out := make([]Event, 0, r.count)
	for i := 0; i < r.count; i++ {
		pos := (r.head - r.count + i + len(r.buf)*2) % len(r.buf)
		out = append(out, r.buf[pos])
	}
	if limit > 0 && len(out) > limit {
		out = out[len(out)-limit:]
	}
	return out
}

// Clear drops every ring (the debug endpoint's reset).
func Clear() {
	ringMu.Lock()
	sessionR = map[string]*ringBuf{}
	ringMu.Unlock()
}
