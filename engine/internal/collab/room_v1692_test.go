package collab

// room_v1692_test.go — v1.69.2 THE SHARED CANVAS (PLAN-V169 §v1.69.2):
// the room laws, rig-proven at the goroutine layer (fake members over
// real channels; a real store.DB on a temp dir):
//
//   (1)  THE JOIN: hello names the cursor + the roster; a join behind
//        the cursor gets the replay batch; everyone hears the roster;
//   (2)  THE ONE-WRITER FOLD: a submit journals contiguous seqs, folds
//        the in-memory doc, and the ACK IS THE BROADCAST (both members
//        receive the same stamped frames);
//   (3)  THE CHECKPOINT POLICY: an HTTP submit lands in the row NOW
//        ($.syncSeq stamped); a WS submit rides the calm window and
//        lands within CheckpointCalm+slack;
//   (4)  THE SLOW-CLIENT LAW: a member that never drains disconnects at
//        a full buffer — the room never blocks;
//   (5)  DORMANCY: the last member's leave flushes the trailing
//        checkpoint and drops the room (a rejoin reloads from the
//        durable truth);
//   (6)  THE OVER-CAP GUARD: a batch that would balloon the doc past
//        MaxDocBytes is refused whole — journal and doc untouched;
//   (7)  presence: a member's blob rebroadcasts; a non-member's frame
//        is ignored.

import (
	"encoding/json"
	"fmt"
	"testing"
	"time"

	"github.com/ScoobyBaby1999/doomalay/engine/internal/store"
)

func v1692DB(t *testing.T) (*store.DB, func()) {
	t.Helper()
	db, err := store.Open(t.TempDir())
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	if err := db.Migrate(); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	seed := `{"offset":{"x":0,"y":0},"scale":1,"currentFamily":"default","icons":[{"id":"chat_a","type":"chat","x":10,"y":20}],"dots":[],"settings":{"theme":"aurora"},"savedAt":111}`
	if _, err := db.UpsertCanvas("cv_r", strp("Shared"), nil, strp(seed)); err != nil {
		t.Fatalf("seed: %v", err)
	}
	return db, func() { db.Close() }
}

func strp(s string) *string { return &s }

func v1692Room(t *testing.T, db *store.DB) *Room {
	t.Helper()
	r, err := NewRoom("cv_r", db, nil)
	if err != nil {
		t.Fatalf("room: %v", err)
	}
	go r.Run()
	t.Cleanup(func() {
		r.Drop()
		r.WaitExited() // the trailing checkpoint flushes BEFORE the db closes
	})
	return r
}

func v1692Member(id string, buf int) (*Member, chan []byte) {
	ch := make(chan []byte, buf)
	return NewMember(id, id, ch, func() {}), ch
}

func drainOne(ch chan []byte) map[string]any {
	select {
	case b := <-ch:
		var m map[string]any
		_ = json.Unmarshal(b, &m)
		return m
	case <-time.After(2 * time.Second):
		return nil
	}
}

func TestV1692_JoinHelloReplayRoster(t *testing.T) {
	db, done := v1692DB(t)
	defer done()
	// the seed submit is HTTP on a memberless room — by the dormancy law
	// that room dies clean after its immediate checkpoint; the JOIN room
	// is a fresh load of the same durable truth.
	seedRoom, err := NewRoom("cv_r", db, nil)
	if err != nil {
		t.Fatalf("seed room: %v", err)
	}
	go seedRoom.Run()
	res := seedRoom.Submit("seed", []Op{{OpID: "s:1", Kind: OpIconAdd, Icon: rawJSON(`{"id":"chat_b","type":"chat","x":50,"y":60}`)}}, true)
	if res.HTTP != 200 || res.Latest != 1 {
		t.Fatalf("seed submit: %+v", res)
	}

	r := v1692Room(t, db)
	defer r.Drop()

	m1, c1 := v1692Member("devA", 16)
	if j := r.Join(m1, 0); j.HTTP != 200 {
		t.Fatalf("join: %+v", j)
	}
	hello := drainOne(c1)
	if hello == nil || hello["t"] != "hello" || hello["seq"] != float64(1) {
		t.Fatalf("hello: %v", hello)
	}
	replay := drainOne(c1)
	if replay == nil || replay["t"] != "ops" || replay["replay"] != true {
		t.Fatalf("replay: %v", replay)
	}
	rops, _ := replay["ops"].([]any)
	if len(rops) != 1 || rops[0].(map[string]any)["seq"] != float64(1) {
		t.Fatalf("replay must carry seq 1: %v", rops)
	}
	roster := drainOne(c1)
	if roster == nil || roster["t"] != "members" {
		t.Fatalf("roster: %v", roster)
	}

	// a second join behind the cursor gets the same replay; the first
	// member hears the roster change
	m2, c2 := v1692Member("devB", 16)
	r.Join(m2, 0)
	if hello2 := drainOne(c2); hello2 == nil || hello2["t"] != "hello" {
		t.Fatalf("hello2: %v", hello2)
	}
	if rp2 := drainOne(c2); rp2 == nil || rp2["t"] != "ops" {
		t.Fatalf("replay2: %v", rp2)
	}
	if r2 := drainOne(c2); r2 == nil || r2["t"] != "members" {
		t.Fatalf("roster2: %v", r2)
	}
	if r1b := drainOne(c1); r1b == nil || r1b["t"] != "members" {
		t.Fatalf("member A must hear the roster: %v", r1b)
	}
}

func TestV1692_AckIsTheBroadcast(t *testing.T) {
	db, done := v1692DB(t)
	defer done()
	r := v1692Room(t, db)
	defer r.Drop()

	m1, c1 := v1692Member("devA", 16)
	m2, c2 := v1692Member("devB", 16)
	r.Join(m1, 0)
	r.Join(m2, 0)
	drainOne(c1) // hello
	drainOne(c1) // roster
	drainOne(c2) // hello
	drainOne(c2) // roster
	drainOne(c1) // roster (B joined)
	drainOne(c2) // roster (B joined — self)

	res := r.Submit("devA", []Op{{OpID: "a:1", Kind: OpIconSet, ID: "chat_a", Props: rawJSON(`{"x":15,"name":"Renamed"}`)}}, false)
	if res.HTTP != 200 || res.Latest != 1 || len(res.Frames) != 1 {
		t.Fatalf("submit: %+v", res)
	}
	fr := res.Frames[0]
	if fr["seq"] != float64(1) || fr["device"] != "devA" {
		t.Fatalf("stamps: %v", fr)
	}
	// BOTH members receive the same batch (the ack IS the broadcast)
	b1 := drainOne(c1)
	b2 := drainOne(c2)
	if b1 == nil || b1["t"] != "ops" || b2 == nil || b2["t"] != "ops" {
		t.Fatalf("broadcasts: %v %v", b1, b2)
	}
	o1, _ := b1["ops"].([]any)
	o2, _ := b2["ops"].([]any)
	if len(o1) != 1 || len(o2) != 1 {
		t.Fatalf("both must carry the one frame: %v %v", o1, o2)
	}
	// the in-memory doc folded
	doc, seq := r.DocSnapshot()
	if seq != 1 {
		t.Fatalf("room seq: %d", seq)
	}
	icons, _ := doc["icons"].([]any)
	a := icons[0].(map[string]any)
	if a["x"] != float64(15) || a["name"] != "Renamed" {
		t.Fatalf("fold: %v", a)
	}
}

func TestV1692_CheckpointPolicy(t *testing.T) {
	db, done := v1692DB(t)
	defer done()
	r := v1692Room(t, db)
	defer r.Drop()

	m, c := v1692Member("devA", 16)
	r.Join(m, 0)
	drainOne(c) // hello
	drainOne(c) // roster

	// a WS submit: the row must NOT carry the fold yet (the calm window)
	r.Submit("devA", []Op{{OpID: "w:1", Kind: OpIconSet, ID: "chat_a", Props: rawJSON(`{"x":42}`)}}, false)
	drainOne(c) // the ack broadcast
	cRow, err := db.GetCanvas("cv_r")
	if err != nil {
		t.Fatalf("row: %v", err)
	}
	var st map[string]any
	_ = json.Unmarshal([]byte(cRow.State), &st)
	icons, _, _ := v1692IconX(st, "chat_a")
	if icons && st["icons"].([]any)[0].(map[string]any)["x"] == float64(42) {
		t.Fatalf("WS submit must NOT checkpoint before the calm window")
	}
	// …and lands within the calm window + slack
	deadline := time.Now().Add(CheckpointCalm + 1500*time.Millisecond)
	for time.Now().Before(deadline) {
		cRow, _ = db.GetCanvas("cv_r")
		_ = json.Unmarshal([]byte(cRow.State), &st)
		if x, ok := v1692RowIconX(st, "chat_a"); ok && x == 42 {
			break
		}
		time.Sleep(100 * time.Millisecond)
	}
	if x, ok := v1692RowIconX(st, "chat_a"); !ok || x != 42 {
		t.Fatalf("the calm checkpoint never landed: %v", st)
	}
	if cRow.FoldSeq != 1 {
		t.Fatalf("watermark: %d", cRow.FoldSeq)
	}
}

func v1692RowIconX(st map[string]any, id string) (float64, bool) {
	icons, _ := st["icons"].([]any)
	for _, ic := range icons {
		m, _ := ic.(map[string]any)
		if m["id"] == id {
			x, _ := m["x"].(float64)
			return x, true
		}
	}
	return 0, false
}

func v1692IconX(st map[string]any, id string) (bool, bool, float64) {
	x, ok := v1692RowIconX(st, id)
	return ok, ok, x
}

func TestV1692_SlowClientDisconnects(t *testing.T) {
	db, done := v1692DB(t)
	defer done()
	r := v1692Room(t, db)
	defer r.Drop()

	// a member with a 1-slot buffer that never drains
	mSlow, _ := v1692Member("slow", 1)
	mFast, cFast := v1692Member("fast", 256)
	r.Join(mSlow, 0)
	r.Join(mFast, 0)

	// flood: enough batches to overflow the slow member's buffer — the
	// room must never block and the fast member must receive everything
	for i := 0; i < 8; i++ {
		res := r.Submit("devA", []Op{{OpID: fmt.Sprintf("f:%d", i), Kind: OpIconSet, ID: "chat_a", Props: rawJSON(fmt.Sprintf(`{"x":%d}`, i))}}, false)
		if res.HTTP != 200 {
			t.Fatalf("submit %d: %+v", i, res)
		}
	}
	got := 0
	for {
		m := drainOne(cFast)
		if m == nil {
			break
		}
		if m["t"] == "ops" {
			got++
		}
	}
	if got < 8 {
		t.Fatalf("the fast member must receive every batch: %d", got)
	}
	// the slow member is convicted disconnected
	mSlow.mu.Lock()
	closed := mSlow.closed
	mSlow.mu.Unlock()
	if !closed {
		t.Fatalf("the slow member must be disconnected at a full buffer")
	}
}

func TestV1692_DormancyLastLeaveFlushesAndDrops(t *testing.T) {
	db, done := v1692DB(t)
	defer done()
	r := v1692Room(t, db)

	m, c := v1692Member("devA", 16)
	r.Join(m, 0)
	drainOne(c) // hello
	drainOne(c) // roster
	r.Submit("devA", []Op{{OpID: "d:1", Kind: OpDocSet, Path: PathWorldSize, Value: rawJSON(`32768`)}}, false)
	drainOne(c) // the ack

	r.Leave(m)
	// the leave flushes the trailing checkpoint synchronously
	deadline := time.Now().Add(2 * time.Second)
	var row *store.Canvas
	for time.Now().Before(deadline) {
		row, _ = db.GetCanvas("cv_r")
		var st map[string]any
		_ = json.Unmarshal([]byte(row.State), &st)
		if st["worldSize"] == float64(32768) {
			break
		}
		time.Sleep(50 * time.Millisecond)
	}
	var st map[string]any
	_ = json.Unmarshal([]byte(row.State), &st)
	if st["worldSize"] != float64(32768) {
		t.Fatalf("the last leave must flush the checkpoint: %v", st)
	}
	// the room dropped: a submit answers 410
	time.Sleep(100 * time.Millisecond)
	if res := r.Submit("devA", []Op{{OpID: "d:2", Kind: OpDocSet, Path: PathWorldSize, Value: rawJSON(`65536`)}}, true); res.HTTP != 410 {
		t.Fatalf("a dropped room must answer 410: %+v", res)
	}
}

func TestV1692_OverCapGuard(t *testing.T) {
	db, done := v1692DB(t)
	defer done()
	r := v1692Room(t, db)
	defer r.Drop()

	m, _ := v1692Member("devA", 16)
	r.Join(m, 0)

	// pad the doc toward the cap (deterministic: pad until the headroom
	// can't fit another 60KB pad, then demand 120KB)
	big := make([]byte, 60<<10)
	for i := range big {
		big[i] = 'x'
	}
	filler := string(big)
	pads := 0
	for i := 0; i < 300; i++ {
		op := Op{OpID: fmt.Sprintf("p:%d", i), Kind: OpIconAdd, Icon: rawJSON(fmt.Sprintf(`{"id":"pad_%d","type":"chat","x":0,"y":0,"blob":"%s"}`, i, filler))}
		res := r.Submit("devA", []Op{op}, true)
		if res.HTTP == 413 {
			break
		}
		if res.HTTP != 200 {
			t.Fatalf("pad %d: %+v", i, res)
		}
		pads++
		r.mu.Lock()
		headroom := MaxDocBytes - r.docBytes
		r.mu.Unlock()
		// stop inside 200KB of the cap: the over-op below stays under
		// the per-op 256KB ceiling, so the 413 convicts THE MARGINAL
		// GUARD specifically, not the per-op cap.
		if headroom < 200<<10 {
			break
		}
	}
	if pads < 10 {
		t.Fatalf("the pad ladder must exercise a real doc, pads=%d", pads)
	}
	// THE OVER-CAP DEMAND: sized against the LIVE headroom — the guard's
	// own arithmetic, convicted from its own numbers (never a guess).
	r.mu.Lock()
	headroom := MaxDocBytes - r.docBytes
	r.mu.Unlock()
	if headroom <= 0 {
		t.Fatalf("the pad ladder overshot the cap: headroom=%d", headroom)
	}
	over := make([]byte, headroom+32<<10)
	for i := range over {
		over[i] = 'x'
	}
	op := Op{OpID: "p:over", Kind: OpIconAdd, Icon: rawJSON(fmt.Sprintf(`{"id":"pad_over","type":"chat","x":0,"y":0,"blob":"%s"}`, string(over)))}
	res := r.Submit("devA", []Op{op}, true)
	if res.HTTP != 413 {
		t.Fatalf("the over-cap batch must be refused 413: %+v", res)
	}
	// nothing landed: the journal holds exactly the accepted pads, the
	// doc has no pad_over
	if latest, _ := db.LatestCanvasOpSeq("cv_r"); latest != pads {
		t.Fatalf("the refused batch must not journal: latest=%d pads=%d", latest, pads)
	}
	doc, _ := r.DocSnapshot()
	icons, _ := doc["icons"].([]any)
	for _, ic := range icons {
		if ic.(map[string]any)["id"] == "pad_over" {
			t.Fatalf("the refused batch must not fold")
		}
	}
}

func TestV1692_PresenceLaws(t *testing.T) {
	db, done := v1692DB(t)
	defer done()
	r := v1692Room(t, db)
	defer r.Drop()

	m1, c1 := v1692Member("devA", 16)
	m2, c2 := v1692Member("devB", 16)
	r.Join(m1, 0)
	r.Join(m2, 0)
	drainOne(c1) // hello
	drainOne(c1) // roster
	drainOne(c2) // hello
	drainOne(c2) // roster
	drainOne(c1) // roster

	r.PresenceUpdate("devA", map[string]any{"viewport": "center"})
	p1 := drainOne(c1)
	p2 := drainOne(c2)
	if p1 == nil || p1["t"] != "presence" || p1["id"] != "devA" {
		t.Fatalf("presence broadcast 1: %v", p1)
	}
	if p2 == nil || p2["t"] != "presence" || p2["id"] != "devA" {
		t.Fatalf("presence broadcast 2: %v", p2)
	}
	// a non-member's presence frame is ignored (no broadcast)
	r.PresenceUpdate("ghost", map[string]any{"x": 1})
	if leak := drainOne(c1); leak != nil {
		t.Fatalf("a non-member's presence must not broadcast: %v", leak)
	}
}

func rawJSON(s string) json.RawMessage { return json.RawMessage(s) }
