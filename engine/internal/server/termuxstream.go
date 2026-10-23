package server

// termuxstream.go — v1.23.3 THE LIVE STREAM (PLAN-V123 §3): long-running
// Termux output streams into the chat pill TWICE A SECOND instead of
// popping in at once.
//
// THE PHYSICS (research receipt): Termux's RUN_COMMAND returns ONE
// result broadcast (stdout+stderr capped at 100KB) — there is NO
// incremental channel on the intent API. So the stream originates
// INSIDE Termux: the wrapper script (termuxtool.go) writes the command's
// stdout/stderr to log files, flushes each log's increment every 0.5s via
// `tail -c +N | curl --data-binary @-` to this route, and curls the done
// marker with the true exit code. The checkin route (v1.20.1) is the
// precedent: Termux can reach the engine's loopback directly.
//
// THE AUTH: the token in the path is an unguessable crypto/rand UUID per
// stream (the checkin law — same device, same loopback, unguessable is
// the gate). A wrong token 404s.
//
// THE TWO TRANSPORTS OUT:
//   · the WS path: the runner emits `tool_stream` events through the
//     session's emitter (set per turn by chat.go; the event is EPHEMERAL —
//     never persisted, the replay law stays use + result).
//   · the PM path: pmsdk.js polls GET /api/termux/stream?session=<sid>&
//     after=<len> while a termux tools/call is in flight (the /mcp call
//     itself is one blocking POST — the poll is the side channel).
//
// THE HONESTY: entries die 5min after done (lazy GC on every hit); a
// closed entry (engine timeout) rejects appends; the buffers keep the
// TAIL under a hard memory cap with the true total tracked for the
// truncation marker.

import (
	"crypto/rand"
	"encoding/hex"
	"net/http"
	"strconv"
	"sync"
	"time"
)

// termuxStreamMemCap bounds one stream's buffers (the tail is kept when
// the cap fires — recent output is the useful output; totalSeen tracks
// the truth for the honest marker).
//
// v1.56.1 THE UNBOUNDED DEVICE OUTPUT: the cap rises 2MB → 8MB. The
// 100KB Termux result-bundle cap is DEAD on the streamed path (the
// output rides the loopback HTTP — Termux's intent bundle never sees
// it); this memory cap is the engine's own hygiene, and the honest
// marker carries the TRUE total when it fires.
const termuxStreamMemCap = 8 * 1024 * 1024

// termuxStreamGCTTL — a finished/closed stream lives this long for late
// polls (the wrapper's final curls may trail the result broadcast).
const termuxStreamGCTTL = 5 * time.Minute

// termuxStream is ONE live stream (a single exec/pkg call).
type termuxStream struct {
	mu      sync.Mutex
	token   string
	session string
	out     string // the stdout tail (capped)
	errS    string // the stderr tail (capped)
	disp    string // the display tail (out+err interleaved by arrival — the PM poll's source)
	outSeen int    // the TRUE total stdout bytes
	errSeen int    // the TRUE total stderr bytes
	done    bool
	ec      int
	closed  bool // the engine gave up (timeout) — appends rejected
	at      time.Time
}

// termuxStreams is the engine-lifetime registry.
type termuxStreams struct {
	mu      sync.Mutex
	byToken map[string]*termuxStream
	// the WS emitter per session (set by chat.go for the turn's
	// lifetime; every chunk append fires it).
	emitMu sync.Mutex
	emit   map[string]func(delta string)
}

func (t *termuxStreams) gcLocked(now time.Time) {
	for k, st := range t.byToken {
		if (st.done || st.closed) && now.Sub(st.at) > termuxStreamGCTTL {
			delete(t.byToken, k)
		}
	}
}

// register mints a stream for a session and returns it.
func (t *termuxStreams) register(session string) *termuxStream {
	buf := make([]byte, 16)
	_, _ = rand.Read(buf)
	token := hex.EncodeToString(buf)
	st := &termuxStream{token: token, session: session, at: time.Now()}
	t.mu.Lock()
	if t.byToken == nil {
		t.byToken = map[string]*termuxStream{}
	}
	t.gcLocked(time.Now())
	t.byToken[token] = st
	t.mu.Unlock()
	return st
}

// get looks a stream up by token (nil when unknown/expired).
func (t *termuxStreams) get(token string) *termuxStream {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.byToken[token]
}

// activeFor returns the session's ACTIVE (not done, not closed) stream
// (the PM poll's target — one turn runs one termux call at a time) and
// its current display length.
func (t *termuxStreams) activeFor(session string) *termuxStream {
	t.mu.Lock()
	defer t.mu.Unlock()
	var best *termuxStream
	for _, st := range t.byToken {
		if st.session == session && !st.done && !st.closed {
			if best == nil || st.at.After(best.at) {
				best = st
			}
		}
	}
	return best
}

// setEmitter installs the session's WS chunk emitter (the turn's
// lifetime; nil clears).
func (t *termuxStreams) setEmitter(session string, fn func(delta string)) {
	t.emitMu.Lock()
	if t.emit == nil {
		t.emit = map[string]func(string){}
	}
	if fn == nil {
		delete(t.emit, session)
	} else {
		t.emit[session] = fn
	}
	t.emitMu.Unlock()
}

func (t *termuxStreams) fire(session, delta string) {
	t.emitMu.Lock()
	fn := t.emit[session]
	t.emitMu.Unlock()
	if fn != nil {
		fn(delta)
	}
}

// append adds a chunk (ch "o"|"e") to the stream + fires the emitter.
// Returns false when the stream is closed/unknown (the wrapper's curls
// fail harmlessly via `|| true`).
func (t *termuxStreams) append(st *termuxStream, ch, delta string) bool {
	if st == nil || delta == "" {
		return false
	}
	st.mu.Lock()
	if st.closed || st.done {
		// A late chunk after the done marker: still honest to fold into the
		// buffers (the observation may already be composed — the tail only
		// grows), but a CLOSED stream rejects everything.
		if st.closed {
			st.mu.Unlock()
			return false
		}
	}
	if ch == "e" {
		st.errSeen += len(delta)
		st.errS = tailCap(st.errS+delta, termuxStreamMemCap)
	} else {
		st.outSeen += len(delta)
		st.out = tailCap(st.out+delta, termuxStreamMemCap)
	}
	st.disp = tailCap(st.disp+delta, termuxStreamMemCap)
	session := st.session
	st.mu.Unlock()
	t.fire(session, delta)
	return true
}

// setFull REPLACES one stream's buffer with the COMPLETE log (the
// wrapper's final ?full=1 POST — the whole-truth path). The true total
// is the full length (the buffer now holds everything). An empty body
// is ignored (a zero-byte log never wipes a good buffer).
func (t *termuxStreams) setFull(st *termuxStream, ch, full string) {
	if st == nil || full == "" {
		return
	}
	st.mu.Lock()
	if st.closed {
		st.mu.Unlock()
		return
	}
	if ch == "e" {
		st.errS = tailCap(full, termuxStreamMemCap)
		if len(full) > st.errSeen {
			st.errSeen = len(full)
		}
	} else {
		st.out = tailCap(full, termuxStreamMemCap)
		if len(full) > st.outSeen {
			st.outSeen = len(full)
		}
	}
	st.mu.Unlock()
}

// complete marks the stream done with the true exit code.
func (t *termuxStreams) complete(st *termuxStream, ec int) {
	if st == nil {
		return
	}
	st.mu.Lock()
	st.done = true
	st.ec = ec
	st.at = time.Now()
	st.mu.Unlock()
}

// closeStream marks the stream closed (the engine gave up — timeout).
func (t *termuxStreams) closeStream(st *termuxStream) {
	if st == nil {
		return
	}
	st.mu.Lock()
	st.closed = true
	st.at = time.Now()
	st.mu.Unlock()
}

// tailCap keeps the tail of s under cap (the head drops; the truth rides
// in the *Seen counters).
func tailCap(s string, cap int) string {
	if len(s) <= cap {
		return s
	}
	return s[len(s)-cap:]
}

// snapshot returns the display text + its length (the PM poll's delta
// math: after=<previous length> → text = disp[after:]).
func (st *termuxStream) snapshot() (string, int) {
	st.mu.Lock()
	defer st.mu.Unlock()
	return st.disp, len(st.disp)
}

// ── the routes ───────────────────────────────────────────────────────────

// handleTermuxStreamPost is POST /api/termux/stream/{token} — the
// wrapper's chunk carrier. Body = RAW chunk bytes; ?ch=o|e selects the
// stream; ?done=1&ec=N completes. Token-gated (wrong token = 404).
// Content-Type is not enforced (curl --data-binary sends
// application/x-www-form-urlencoded by default — the body is opaque).
func (s *Server) handleTermuxStreamPost(w http.ResponseWriter, r *http.Request) {
	token := r.PathValue("token")
	st := s.txstreams.get(token)
	if st == nil {
		http.NotFound(w, r)
		return
	}
	if r.URL.Query().Get("done") == "1" {
		ec := 0
		if v := r.URL.Query().Get("ec"); v != "" {
			ec, _ = strconv.Atoi(v)
		}
		s.txstreams.complete(st, ec)
		writeJSON(w, 200, map[string]any{"ok": true})
		return
	}
	ch := r.URL.Query().Get("ch")
	if ch != "o" && ch != "e" {
		ch = "o"
	}
	// v1.56.1 THE WHOLE OUTPUT: ?full=1 carries the COMPLETE log file
	// (the wrapper's final POST) — the engine replaces the buffer with
	// it, so the observation rides the whole output even when the
	// incremental flushes were cut. An empty body is ignored (a zero-byte
	// log must never wipe a good buffer).
	full := r.URL.Query().Get("full") == "1"
	body := make([]byte, 0, 4096)
	buf := make([]byte, 32*1024)
	for {
		n, err := r.Body.Read(buf)
		if n > 0 {
			body = append(body, buf[:n]...)
			if len(body) > termuxStreamMemCap {
				body = body[len(body)-termuxStreamMemCap:]
			}
		}
		if err != nil {
			break
		}
	}
	if full {
		s.txstreams.setFull(st, ch, string(body))
		writeJSON(w, 200, map[string]any{"ok": true})
		return
	}
	s.txstreams.append(st, ch, string(body))
	writeJSON(w, 200, map[string]any{"ok": true})
}

// handleTermuxStreamPoll is GET /api/termux/stream?session=<sid>&after=N —
// the PM loop's side channel: while a termux tools/call blocks, pmsdk.js
// polls this for the display delta (the SAME chunks the WS path gets as
// tool_stream events). Answers honestly when no stream is active.
func (s *Server) handleTermuxStreamPoll(w http.ResponseWriter, r *http.Request) {
	session := r.URL.Query().Get("session")
	if session == "" {
		writeError(w, http.StatusBadRequest, "session query parameter required")
		return
	}
	after := 0
	if v := r.URL.Query().Get("after"); v != "" {
		after, _ = strconv.Atoi(v)
		if after < 0 {
			after = 0
		}
	}
	st := s.txstreams.activeFor(session)
	if st == nil {
		writeJSON(w, 200, map[string]any{"active": false})
		return
	}
	disp, l := st.snapshot()
	delta := ""
	if after < l {
		delta = disp[after:]
	}
	st.mu.Lock()
	done, closed, ec := st.done, st.closed, st.ec
	st.mu.Unlock()
	writeJSON(w, 200, map[string]any{
		"active": true,
		"len":    l,
		"text":   delta,
		"done":   done,
		"closed": closed,
		"ec":     ec,
	})
}
