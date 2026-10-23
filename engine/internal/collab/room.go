// room.go — v1.69.2 THE SHARED CANVAS (PLAN-V169 §v1.69.2): the live
// room — the gorilla hub pattern (one goroutine per room, channels in,
// buffered sends out, the slow client DISCONNECTED never the writer
// blocked), holding THE ONE authoritative in-memory doc (the Unreal
// mapping: the server holds the authoritative game state; clients send
// inputs — ops — never state).
//
// THE ONE-WRITER LAW: every op submission (WS frame or the HTTP
// dependency path) enters through the room's submit channel; the room
// goroutine alone journals, folds, broadcasts, and checkpoints. The
// row (canvases.state) is the CHECKPOINT; the journal (canvas_ops) is
// the truth the checkpoint trails (Figma's 2022 write-ahead shape).
//
// THE CHECKPOINT POLICY: an HTTP submit checkpoints IMMEDIATELY (the
// dependency path — no room pressure, the row answers the next GET
// honestly); a WS submit rides the CALM 2s debounce (the same cadence
// law as the client's flush — a drag settles into a burst of batches,
// the row takes ONE write). The checkpoint merges the room's doc plane
// onto the row's FRESHEST view plane through the scoped serializer
// (the server's collabMu — the host's camera/settings must never be
// clobbered by a stale-view fold).
//
// DORMANCY: the last member's leave flushes the trailing checkpoint,
// stops every timer, and drops the room from the hub — an unshared
// canvas runs zero goroutines, zero timers, zero frames (the owner's
// performance law, structural).
package collab

import (
	"encoding/json"
	"fmt"
	"log"
	"sync"
	"time"

	"github.com/ScoobyBaby1999/doomalay/engine/internal/store"
)

// Room timing laws (the researched constants: Cloudflare kills idle
// proxied WS at ~100s — the 75% rule keeps 30s pings comfortably clear;
// the checkpoint cadence matches the client's own calm flush).
const (
	MemberSendBuffer   = 256
	CheckpointCalm     = 2 * time.Second
	HTTPIdleDrop       = 2 * time.Second
	PresencePruneAfter = 30 * time.Second
	PresenceTickEvery  = 15 * time.Second
)

// RoomIO is the room's durable-truth interface (the store.DB satisfies
// it; tests may fake it). Kept tiny: the room journals + checkpoints
// through exactly these verbs.
type RoomIO interface {
	AppendCanvasOps(canvasID, deviceID string, ops []string) ([]*store.CanvasOp, error)
	ListCanvasOps(canvasID string, since int) ([]*store.CanvasOp, error)
	LatestCanvasOpSeq(canvasID string) (int, error)
	GetCanvas(id string) (*store.Canvas, error)
	UpsertCanvasState(id string, state string) error
	SetCanvasFoldSeq(canvasID string, seq int) error
}

// Member is one connected device in a room. Send is the member's
// outbound frame queue (the server's WS write pump owns the reading
// side); Close disconnects (the slow-client law's eviction hook).
type Member struct {
	ID     string
	Name   string
	send   chan []byte
	mu     sync.Mutex
	closed bool
	close  func()
}

// NewMember builds a member around a send channel.
func NewMember(id, name string, send chan []byte, close func()) *Member {
	return &Member{ID: id, Name: name, send: send, close: close}
}

func (m *Member) trySend(b []byte) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed {
		return false
	}
	select {
	case m.send <- b:
		return true
	default:
		// THE SLOW-CLIENT LAW: a full buffer disconnects the member —
		// never block the room; the client heals on reconnect via
		// sinceSeq replay (the self-healing the research mandated).
		m.closed = true
		if m.close != nil {
			go m.close()
		}
		return false
	}
}

func (m *Member) shutdown() {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed {
		return
	}
	m.closed = true
	if m.close != nil {
		go m.close()
	}
}

// Presence is one device's ephemeral state blob (viewport, cursor —
// latest-state semantics, NEVER persisted, NEVER replayed).
type Presence struct {
	Name     string         `json:"name"`
	State    map[string]any `json:"state,omitempty"`
	LastSeen time.Time      `json:"-"`
}

// SubmitResult is the room's answer to a batch submission.
type SubmitResult struct {
	Frames []map[string]any // the stamped ack frames
	Latest int
	Err    error
	HTTP   int // the mapped status (200 / 400 / 404 / 413 / 410 / 500)
}

type submitReq struct {
	device  string
	ops     []Op
	httpNow bool // the HTTP dependency path checkpoints NOW
	reply   chan *SubmitResult
}

type joinReq struct {
	member *Member
	since  int
	reply  chan *SubmitResult
}

// Room is one canvas's live collaboration surface.
type Room struct {
	CanvasID  string
	io        RoomIO
	serialize func(do func()) // the scoped collabMu executor for row writes
	onDrop    func()          // the hub's eviction hook (set at registration)

	mu        sync.Mutex // guards members/presence/doc/seq for reads outside the loop
	members   map[*Member]bool
	presence  map[string]*Presence
	doc       map[string]any // the authoritative in-memory DOC plane
	docBytes  int            // the doc's marshaled size (the over-cap guard's baseline)
	latestSeq int

	submits chan *submitReq
	joins   chan *joinReq
	leaves  chan *Member
	evicts  chan string   // device ids to evict (the revoke path)
	ckpt    chan struct{} // the calm-checkpoint tick (buffered 1)
	drops   chan struct{}
	exited  chan struct{} // closed when Run returns (tests await a clean drop)

	checkpointArmed bool
	idleDropGen     int // the HTTP-only room's cancelable idle-drop generation
	presenceTicker  *time.Ticker
	presenceStop    chan struct{}
	dropped         bool
	voided          bool // the eviction was a VOID/DELETE — the exit must NOT flush
}

// NewRoom loads a canvas's durable truth (the row state's doc plane +
// the journal tail past the row's own $.syncSeq watermark) into the
// in-memory doc. The row's $.syncSeq — not fold_seq — is the load
// watermark: the host's own whole-state PUT (syncSeq==latest) is the
// fresher witness whenever it landed last.
func NewRoom(canvasID string, rio RoomIO, serialize func(do func())) (*Room, error) {
	if serialize == nil {
		serialize = func(do func()) { do() }
	}
	r := &Room{
		CanvasID:  canvasID,
		io:        rio,
		serialize: serialize,
		members:   map[*Member]bool{},
		presence:  map[string]*Presence{},
		doc:       map[string]any{},
		submits:   make(chan *submitReq, 64),
		joins:     make(chan *joinReq, 16),
		leaves:    make(chan *Member, 16),
		evicts:    make(chan string, 16),
		ckpt:      make(chan struct{}, 1),
		drops:     make(chan struct{}, 1),
		exited:    make(chan struct{}),
	}
	c, err := rio.GetCanvas(canvasID)
	if err != nil {
		return nil, err
	}
	state, err := StateObject(c.State)
	if err != nil {
		return nil, err
	}
	syncSeq := 0
	if v, ok := state["syncSeq"].(float64); ok {
		syncSeq = int(v)
	}
	for _, k := range []string{"icons", "dots", "currentFamily", "worldSize"} {
		if v, ok := state[k]; ok {
			r.doc[k] = v
		}
	}
	if db, err := json.Marshal(r.doc); err == nil {
		r.docBytes = len(db)
	}
	r.latestSeq = syncSeq
	latest, err := rio.LatestCanvasOpSeq(canvasID)
	if err != nil {
		return nil, err
	}
	if latest > syncSeq {
		tail, err := rio.ListCanvasOps(canvasID, syncSeq+1)
		if err != nil {
			return nil, err
		}
		for _, row := range tail {
			var op Op
			if err := json.Unmarshal([]byte(row.Op), &op); err != nil {
				continue // a corrupt journal row never kills the room
			}
			_ = FoldOp(r.doc, op) // the fold laws are total (replay-safe)
		}
		r.latestSeq = latest
	}
	return r, nil
}

// Run is the room's single-threaded event loop (one goroutine per
// room — the serialization point the gorilla pattern mandates). On exit
// it drains every queued request with the honest 410 (a submitter that
// raced the drop can never hang on a dead reply channel).
func (r *Room) Run() {
	defer close(r.exited)
	defer r.drainOnExit()
	for {
		select {
		case req := <-r.joins:
			r.handleJoin(req)
		case req := <-r.submits:
			r.handleSubmit(req)
		case m := <-r.leaves:
			r.handleLeave(m)
		case dev := <-r.evicts:
			r.handleEvict(dev)
		case <-r.ckpt:
			r.mu.Lock()
			r.checkpointArmed = false
			r.mu.Unlock()
			r.checkpointNow()
		case <-r.drops:
			r.handleDrop()
			return
		}
	}
}

// drainOnExit answers everything still queued when the loop exits —
// the drop-race closer: a request that enqueued before the dropped flag
// set (under the same mu) is drained here with 410; one that checked the
// flag never enqueues at all.
func (r *Room) drainOnExit() {
	for {
		select {
		case req := <-r.submits:
			req.reply <- &SubmitResult{Err: ErrRoomGone, HTTP: 410}
		case req := <-r.joins:
			req.reply <- &SubmitResult{Err: ErrRoomGone, HTTP: 410}
		case m := <-r.leaves:
			m.shutdown()
		default:
			return
		}
	}
}

// Submit enqueues a batch (the HTTP path passes httpNow=true). The
// enqueue is mu-guarded + non-blocking: a room mid-drop can never leave
// a requester hanging, and a flooded buffer answers the honest 503
// (retry) instead of blocking the caller.
func (r *Room) Submit(device string, ops []Op, httpNow bool) *SubmitResult {
	req := &submitReq{device: device, ops: ops, httpNow: httpNow, reply: make(chan *SubmitResult, 1)}
	r.mu.Lock()
	if r.dropped {
		r.mu.Unlock()
		return &SubmitResult{Err: ErrRoomGone, HTTP: 410}
	}
	select {
	case r.submits <- req:
		r.mu.Unlock()
		return <-req.reply
	default:
		r.mu.Unlock()
		return &SubmitResult{Err: fmt.Errorf("room busy — retry"), HTTP: 503}
	}
}

// Join enqueues a member join with the replay cursor. A dropped room
// answers 410 honestly (never blocks on its dead channels); a flooded
// join buffer answers 503.
func (r *Room) Join(m *Member, since int) *SubmitResult {
	req := &joinReq{member: m, since: since, reply: make(chan *SubmitResult, 1)}
	r.mu.Lock()
	if r.dropped {
		r.mu.Unlock()
		return &SubmitResult{Err: ErrRoomGone, HTTP: 410}
	}
	select {
	case r.joins <- req:
		r.mu.Unlock()
		return <-req.reply
	default:
		r.mu.Unlock()
		return &SubmitResult{Err: fmt.Errorf("room busy — retry"), HTTP: 503}
	}
}

// Leave enqueues a member departure (the read pump's final act).
func (r *Room) Leave(m *Member) {
	select {
	case r.leaves <- m:
	default: // the room is dropping; the leave is moot
	}
}

// EvictDevice removes EVERY member connection of a device (the revoke
// path — a revoked token must kill its live sockets mid-stream). The
// room's own loop does the surgery (the one-writer law).
func (r *Room) EvictDevice(deviceID string) {
	r.mu.Lock()
	dropped := r.dropped
	r.mu.Unlock()
	if dropped {
		return
	}
	select {
	case r.evicts <- deviceID:
	default: // the room is busy dropping; its exit closes the sockets anyway
	}
}

func (r *Room) handleEvict(deviceID string) {
	r.mu.Lock()
	var gone []*Member
	for m := range r.members {
		if m.ID == deviceID {
			gone = append(gone, m)
			delete(r.members, m)
		}
	}
	stillLive := false
	for m := range r.members {
		if m.ID == deviceID {
			stillLive = true
		}
	}
	if !stillLive {
		delete(r.presence, deviceID)
	}
	empty := len(r.members) == 0
	r.mu.Unlock()
	for _, m := range gone {
		m.shutdown()
	}
	r.broadcastMembers()
	if empty {
		r.checkpointNow()
		r.stopPresenceLoop()
		r.Drop()
	}
}

// Drop signals the room to flush + exit (the natural death: the last
// member left, or the idle drop fired).
func (r *Room) Drop() {
	r.mu.Lock()
	if r.dropped {
		r.mu.Unlock()
		return
	}
	r.dropped = true
	r.mu.Unlock()
	select {
	case r.drops <- struct{}{}:
	default:
	}
}

// DropVoid evicts WITHOUT the trailing flush — the journal was voided
// under the room (an old-shape whole-state PUT took the row), or the row
// died (canvas delete): the room's in-memory doc is now someone else's
// stale truth, and flushing it would clobber the very write that killed
// it (or resurrect a deleted row — UpsertCanvas re-creates).
func (r *Room) DropVoid() {
	r.mu.Lock()
	r.voided = true
	r.mu.Unlock()
	r.Drop()
}

// WaitExited blocks until the room's loop returns (a clean drop —
// the trailing checkpoint has flushed by then). Tests use it to keep
// the db alive across the room's exit; production callers never need it.
func (r *Room) WaitExited() {
	select {
	case <-r.exited:
	case <-time.After(5 * time.Second):
	}
}

// SnapshotMembers returns the live member descriptors (the hello
// frame + the rig's introspection).
func (r *Room) SnapshotMembers() []map[string]any {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]map[string]any, 0, len(r.members))
	for m := range r.members {
		out = append(out, map[string]any{"id": m.ID, "name": m.Name})
	}
	return out
}

// Latest returns the room's current seq head.
func (r *Room) Latest() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.latestSeq
}

// DocSnapshot returns a deep copy of the in-memory doc plane (the /doc
// endpoint's truth).
func (r *Room) DocSnapshot() (map[string]any, int) {
	r.mu.Lock()
	defer r.mu.Unlock()
	b, err := json.Marshal(r.doc)
	if err != nil {
		return map[string]any{}, r.latestSeq
	}
	var out map[string]any
	_ = json.Unmarshal(b, &out)
	return out, r.latestSeq
}

func (r *Room) handleJoin(req *joinReq) {
	m := req.member
	r.mu.Lock()
	r.members[m] = true
	p := r.presence[m.ID]
	if p == nil {
		p = &Presence{Name: m.Name}
		r.presence[m.ID] = p
	}
	p.Name = m.Name
	p.LastSeen = time.Now()
	latest := r.latestSeq
	first := len(r.members) == 1
	r.mu.Unlock()
	if first {
		r.startPresenceLoop()
	}
	// any join cancels a pending HTTP-idle drop (members are live now)
	r.cancelIdleDrop()
	// the hello: the cursor truth + who's here
	hello, _ := json.Marshal(map[string]any{
		"t":       "hello",
		"canvas":  r.CanvasID,
		"seq":     latest,
		"members": r.SnapshotMembers(),
	})
	m.trySend(hello)
	// the replay: ops past the member's cursor (the chat_events law). A
	// cursor the journal can't serve (GC'd below) takes the SNAPSHOT
	// path — the hello named the live seq; the member fetches the row
	// and re-joins with the row's own $.syncSeq cursor.
	if req.since < latest {
		rows, err := r.io.ListCanvasOps(r.CanvasID, req.since+1)
		if err == nil && len(rows) > 0 {
			frames := make([]any, 0, len(rows))
			for _, row := range rows {
				fr, ferr := StampedFrame(row.Op, row.Seq, row.DeviceID, row.At)
				if ferr == nil {
					frames = append(frames, fr)
				}
			}
			batch, _ := json.Marshal(map[string]any{"t": "ops", "ops": frames, "replay": true})
			m.trySend(batch)
		}
	}
	// tell everyone who came
	r.broadcastMembers()
	req.reply <- &SubmitResult{Latest: latest, HTTP: 200}
}

func (r *Room) handleLeave(m *Member) {
	r.mu.Lock()
	if _, ok := r.members[m]; !ok {
		r.mu.Unlock()
		return
	}
	delete(r.members, m)
	// the presence entry dies only when NO other member shares the
	// device id (two tabs, one device — the survivor keeps the blob)
	shared := 0
	for other := range r.members {
		if other.ID == m.ID {
			shared++
		}
	}
	if shared == 0 {
		delete(r.presence, m.ID)
	}
	empty := len(r.members) == 0
	r.mu.Unlock()
	m.shutdown()
	r.broadcastMembers()
	if empty {
		// DORMANCY: the last light goes out — flush the trailing
		// checkpoint (the durable truth never trails an empty room),
		// stop the presence loop, and exit the room's loop.
		r.checkpointNow()
		r.stopPresenceLoop()
		r.Drop()
	}
}

func (r *Room) handleDrop() {
	r.mu.Lock()
	r.dropped = true
	voided := r.voided
	members := r.members
	r.members = map[*Member]bool{}
	r.presence = map[string]*Presence{}
	r.mu.Unlock()
	for m := range members {
		m.shutdown()
	}
	if !voided {
		r.checkpointNow()
	}
	r.stopPresenceLoop()
	// the hub's eviction LAST (the room is fully dead by now — a raced
	// Room() call would birth a fresh loop over the durable truth).
	if r.onDrop != nil {
		r.onDrop()
	}
}

func (r *Room) handleSubmit(req *submitReq) {
	// validate the whole batch first — a half-accepted batch is a
	// corruption vector (the v1.69.1 law, kept).
	if len(req.ops) == 0 {
		req.reply <- &SubmitResult{Err: fmt.Errorf("no ops"), HTTP: 400}
		return
	}
	if len(req.ops) > MaxOpsPerBatch {
		req.reply <- &SubmitResult{Err: fmt.Errorf("too many ops"), HTTP: 413}
		return
	}
	rawOps := make([]string, 0, len(req.ops))
	batchBytes := 0
	for i := range req.ops {
		op := req.ops[i]
		op.Seq = 0
		op.Device = ""
		op.At = 0
		if err := ValidateOp(op); err != nil {
			req.reply <- &SubmitResult{Err: err, HTTP: 400}
			return
		}
		jb, err := json.Marshal(op)
		if err != nil {
			req.reply <- &SubmitResult{Err: err, HTTP: 400}
			return
		}
		if len(jb) > MaxOpBytes {
			req.reply <- &SubmitResult{Err: fmt.Errorf("op over size cap"), HTTP: 413}
			return
		}
		batchBytes += len(jb)
		rawOps = append(rawOps, string(jb))
	}
	// THE OVER-CAP GUARD (the v1.69.1 tentative-fold law, marginal form):
	// the doc's tracked size + the batch's bytes must fit the checkpoint
	// cap — a batch that would balloon the row past 4MB is refused whole
	// BEFORE the journal or the in-memory doc ever see it.
	r.mu.Lock()
	if r.docBytes+batchBytes > MaxDocBytes {
		r.mu.Unlock()
		req.reply <- &SubmitResult{Err: fmt.Errorf("folded doc over the size cap"), HTTP: 413}
		return
	}
	r.mu.Unlock()
	appended, err := r.io.AppendCanvasOps(r.CanvasID, req.device, rawOps)
	if err != nil {
		req.reply <- &SubmitResult{Err: err, HTTP: 500}
		return
	}
	if len(appended) == 0 {
		req.reply <- &SubmitResult{Err: fmt.Errorf("no ops appended"), HTTP: 500}
		return
	}
	frames := make([]map[string]any, 0, len(appended))
	lastSeq := 0
	for _, row := range appended {
		var op Op
		if err := json.Unmarshal([]byte(row.Op), &op); err == nil {
			_ = FoldOp(r.doc, op) // total, replay-safe laws
		}
		lastSeq = row.Seq
		fr, ferr := StampedFrame(row.Op, row.Seq, row.DeviceID, row.At)
		if ferr == nil {
			frames = append(frames, fr)
		}
	}
	r.mu.Lock()
	r.latestSeq = lastSeq
	r.docBytes += batchBytes
	r.mu.Unlock()
	// THE ACK IS THE BROADCAST: the same frames go to everyone including
	// the author (one mechanism — ordering + fan-out + ack).
	batch, _ := json.Marshal(map[string]any{"t": "ops", "ops": frames})
	r.broadcast(batch)
	// the checkpoint policy: HTTP = now (the dependency path's honest
	// row), WS = the calm debounce (the hot path's cadence law).
	if req.httpNow {
		r.checkpointNow()
		// an HTTP-only room (no live members) dies on IDLE — not eagerly:
		// concurrent HTTP posts on one canvas must all land (the OneClock
		// conviction), and any join/submit within the grace window cancels
		// the drop. The dormancy law survives: the timer is 2s, once, and a
		// canvas nobody touches never births a room at all.
		r.mu.Lock()
		empty := len(r.members) == 0
		r.mu.Unlock()
		if empty {
			r.armIdleDrop()
		}
	} else {
		r.cancelIdleDrop()
		r.armCheckpoint()
	}
	req.reply <- &SubmitResult{Frames: frames, Latest: lastSeq, HTTP: 200}
}

func (r *Room) broadcast(b []byte) {
	r.mu.Lock()
	members := make([]*Member, 0, len(r.members))
	for m := range r.members {
		members = append(members, m)
	}
	r.mu.Unlock()
	for _, m := range members {
		m.trySend(b)
	}
}

// PresenceUpdate merges a member's ephemeral state blob (latest-state
// semantics — the blob REPLACES, never queues) and rebroadcasts it.
// A presence frame from a non-member is ignored; an entry deleted by a
// sibling tab's leave is RE-BORN when a live member still holds the
// device id.
func (r *Room) PresenceUpdate(device string, state map[string]any) {
	r.mu.Lock()
	p := r.presence[device]
	if p == nil {
		for m := range r.members {
			if m.ID == device {
				p = &Presence{Name: m.Name}
				r.presence[device] = p
				break
			}
		}
		if p == nil {
			r.mu.Unlock()
			return
		}
	}
	p.State = state
	p.LastSeen = time.Now()
	name := p.Name
	r.mu.Unlock()
	b, err := json.Marshal(map[string]any{"t": "presence", "id": device, "name": name, "state": state})
	if err == nil {
		r.broadcast(b)
	}
}

// Send is the member's exported frame post (the read pump's error
// frames + pong ride the same queue as the broadcasts — gorilla's one
// writer per connection, kept by construction).
func (m *Member) Send(b []byte) bool { return m.trySend(b) }

func (r *Room) broadcastMembers() {
	b, _ := json.Marshal(map[string]any{"t": "members", "members": r.SnapshotMembers()})
	r.broadcast(b)
}

// armCheckpoint schedules the calm write (one in flight; a burst of
// batches coalesces into ONE row write). The tick goroutine is
// drop-safe: a room that died during the calm window never fires.
func (r *Room) armCheckpoint() {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.checkpointArmed {
		return
	}
	r.checkpointArmed = true
	go func() {
		time.Sleep(CheckpointCalm)
		r.mu.Lock()
		dropped := r.dropped
		if dropped {
			r.checkpointArmed = false
		}
		r.mu.Unlock()
		if dropped {
			return
		}
		select {
		case r.ckpt <- struct{}{}:
		default: // a tick is already pending — the coalescing law
		}
	}()
}

// armIdleDrop schedules the HTTP-only room's death: 2s of no member,
// no submit, no join — then the room drops (the durable truth never
// trails an empty room; no goroutine outlives its last need). Every
// join/submit bumps the generation and cancels the pending drop.
func (r *Room) armIdleDrop() {
	r.mu.Lock()
	r.idleDropGen++
	gen := r.idleDropGen
	r.mu.Unlock()
	go func() {
		time.Sleep(HTTPIdleDrop)
		r.mu.Lock()
		cur := r.idleDropGen
		dropped := r.dropped
		r.mu.Unlock()
		if cur == gen && !dropped {
			r.Drop()
		}
	}()
}

func (r *Room) cancelIdleDrop() {
	r.mu.Lock()
	r.idleDropGen++
	r.mu.Unlock()
}

// checkpointNow writes the in-memory doc plane onto the row's FRESHEST
// view plane through the scoped serializer (the host's camera/settings
// survive; the doc is the room's truth). The marshaled doc also
// re-baselines docBytes (removals shrink; the marginal guard stays
// honest across churn).
func (r *Room) checkpointNow() {
	r.mu.Lock()
	doc := r.doc
	latest := r.latestSeq
	r.mu.Unlock()
	if db, err := json.Marshal(doc); err == nil {
		r.mu.Lock()
		r.docBytes = len(db)
		r.mu.Unlock()
	}
	r.serialize(func() {
		c, err := r.io.GetCanvas(r.CanvasID)
		if err != nil {
			log.Printf("collab: checkpoint read %s: %v", r.CanvasID, err)
			return
		}
		state, err := StateObject(c.State)
		if err != nil {
			log.Printf("collab: checkpoint state %s: %v", r.CanvasID, err)
			return
		}
		for _, k := range []string{"icons", "dots", "currentFamily", "worldSize"} {
			if v, ok := doc[k]; ok {
				state[k] = v
			}
		}
		state["syncSeq"] = latest
		folded, err := json.Marshal(state)
		if err != nil {
			return
		}
		if err := r.io.UpsertCanvasState(r.CanvasID, string(folded)); err != nil {
			log.Printf("collab: checkpoint write %s: %v", r.CanvasID, err)
			return
		}
		_ = r.io.SetCanvasFoldSeq(r.CanvasID, latest)
	})
}

// startPresenceLoop arms the 15s sweep (prunes presence entries whose
// member is gone + rebroadcasts the roster when it changed). Runs ONLY
// while members exist — the dormancy law.
func (r *Room) startPresenceLoop() {
	r.mu.Lock()
	if r.presenceTicker != nil {
		r.mu.Unlock()
		return
	}
	r.presenceTicker = time.NewTicker(PresenceTickEvery)
	r.presenceStop = make(chan struct{})
	stop := r.presenceStop
	r.mu.Unlock()
	go func() {
		defer func() {
			r.mu.Lock()
			r.presenceTicker.Stop()
			r.presenceTicker = nil
			r.mu.Unlock()
		}()
		for {
			select {
			case <-stop:
				return
			case <-r.presenceTicker.C:
				r.mu.Lock()
				live := map[string]bool{}
				for m := range r.members {
					live[m.ID] = true
				}
				changed := false
				for id := range r.presence {
					if !live[id] {
						delete(r.presence, id)
						changed = true
					}
				}
				r.mu.Unlock()
				if changed {
					r.broadcastMembers()
				}
			}
		}
	}()
}

func (r *Room) stopPresenceLoop() {
	r.mu.Lock()
	stop := r.presenceStop
	r.presenceStop = nil
	r.mu.Unlock()
	if stop != nil {
		close(stop)
	}
}
