package collab

// enroll_v1711_test.go — v1.71.1 THE DASHBOARD (PLAN-V169 §v1.169.4 + the
// renumber addendum): the code-only pairing laws.
//
//   (1)  THE CODE IS THE LOCATOR: a foreign guest pairs with an EMPTY
//        canvas id — GetCollabInviteByCode resolves the row; the approved
//        PairResult carries the canvas (the activation's truth);
//   (2)  THE COLLISION-FREE MINT: a code held by another canvas's LIVE
//        invite is never re-minted (the unambiguity law);
//   (3)  THE HONEST MISS: an unknown code, an expired code → the same
//        ErrPairNoInvite (no oracle);
//   (4)  THE JOURNAL GC: the checkpoint's trim fires only past the
//        threshold, then the ops ≤ the checkpoint's latest are gone
//        (the SNAPSHOT-redirect law keeps every reader recoverable).

import (
        "fmt"
        "testing"
        "time"

        "github.com/ScoobyBaby1999/doomalay/engine/internal/store"
)

func v1711Store(t *testing.T) *store.DB {
        t.Helper()
        db, err := store.Open(t.TempDir())
        if err != nil {
                t.Fatalf("store: %v", err)
        }
        if err := db.Migrate(); err != nil {
                t.Fatalf("migrate: %v", err)
        }
        return db
}

func v1711Canvas(t *testing.T, db *store.DB, id, name string) {
        t.Helper()
        if _, err := db.UpsertCanvas(id, strp(name), nil, strp(`{}`)); err != nil {
                t.Fatalf("seed %s: %v", id, err)
        }
}

func TestV1711_CodeOnlyPair(t *testing.T) {
        db := v1711Store(t)
        e := NewEnroller(db)

        v1711Canvas(t, db, "cv_home", "Home World")
        inv, err := e.MintInvite("cv_home")
        if err != nil {
                t.Fatalf("mint: %v", err)
        }

        // THE FOREIGN GUEST: an EMPTY canvas — the code resolves the row
        deviceCode, err := e.Pair("", inv.Code, "Pixel 9")
        if err != nil {
                t.Fatalf("code-only pair: %v", err)
        }
        if deviceCode == "" {
                t.Fatalf("the device_code must land")
        }
        if res := e.PairStatus(deviceCode); res.Status != "pending" {
                t.Fatalf("poll after claim = %q, want pending", res.Status)
        }
        // THE TAP
        if err := e.Approve("cv_home"); err != nil {
                t.Fatalf("approve: %v", err)
        }
        res := e.PairStatus(deviceCode)
        if res.Status != "approved" {
                t.Fatalf("poll = %q, want approved", res.Status)
        }
        if res.Canvas != "cv_home" {
                t.Fatalf("the approved poll must carry the paired canvas, got %q", res.Canvas)
        }
        // the member row landed on the RESOLVED canvas
        ok, err := db.IsCollabMember("cv_home", res.Device)
        if err != nil || !ok {
                t.Fatalf("the code-only guest must be a member of cv_home: %v %v", ok, err)
        }
}

func TestV1711_CollisionFreeMint(t *testing.T) {
        db := v1711Store(t)
        e := NewEnroller(db)
        for _, id := range []string{"cv_a", "cv_b", "cv_c"} {
                v1711Canvas(t, db, id, id)
        }
        a, err := e.MintInvite("cv_a")
        if err != nil {
                t.Fatalf("mint a: %v", err)
        }
        // FORCE the collision shape: cv_b's live invite holds cv_a's code (an
        // explicitly LATER expiry — the freshest witness is deterministic)
        future := float64(time.Now().Add(2*InviteTTL).UnixMilli()) / 1000.0
        if err := db.UpsertCollabInvite("cv_b", a.Code, "devcode_b", future); err != nil {
                t.Fatalf("seed colliding invite: %v", err)
        }
        // cv_c's mint must NEVER land on the taken code
        c, err := e.MintInvite("cv_c")
        if err != nil {
                t.Fatalf("mint c: %v", err)
        }
        if c.Code == a.Code {
                t.Fatalf("the collision-free mint re-minted the taken code %q", a.Code)
        }
        // the by-code lookup resolves the FRESHEST holder (the pre-collision
        // defense) — cv_b expires later, so it wins
        resolved, err := db.GetCollabInviteByCode(a.Code)
        if err != nil {
                t.Fatalf("by-code lookup: %v", err)
        }
        if resolved.CanvasID != "cv_b" {
                t.Fatalf("by-code lookup must take the freshest witness, got %s", resolved.CanvasID)
        }
        // an EXPIRED code never resolves (the honest miss)
        past := float64(time.Now().UnixMilli())/1000.0 - 1
        if err := db.UpsertCollabInvite("cv_dead", "999998", "devcode_dead2", past); err != nil {
                t.Fatalf("seed expired: %v", err)
        }
        if _, err := db.GetCollabInviteByCode("999998"); err != store.ErrInviteNotFound {
                t.Fatalf("the expired code must not resolve, got %v", err)
        }
}

func TestV1711_UnknownCodeIsTheHonestMiss(t *testing.T) {
        db := v1711Store(t)
        e := NewEnroller(db)
        if _, err := e.Pair("", "123456", "Ghost"); err != ErrPairNoInvite {
                t.Fatalf("an unknown code must be the honest miss, got %v", err)
        }
        if _, err := e.Pair("", "12x456", "Ghost"); err != ErrPairBadCode {
                t.Fatalf("a malformed code must be ErrPairBadCode, got %v", err)
        }
}

func TestV1711_JournalGC(t *testing.T) {
        db := v1711Store(t)
        v1711Canvas(t, db, "cv_gc", "GC World")
        r, err := NewRoom("cv_gc", db, nil)
        if err != nil {
                t.Fatalf("room: %v", err)
        }
        go r.Run()
        t.Cleanup(func() {
                r.Drop()
                r.WaitExited() // the trailing checkpoint flushes BEFORE the db closes
        })

        counter := 0
        submit := func(n int) {
                t.Helper()
                for batch := 0; batch < n; batch += 64 {
                        size := n - batch
                        if size > 64 {
                                size = 64
                        }
                        ops := make([]Op, 0, size)
                        for i := 0; i < size; i++ {
                                counter++
                                ops = append(ops, Op{
                                        OpID:  "gc:" + time.Now().Format("150405.000000000") + ":" + fmt.Sprint(counter),
                                        Kind:  OpDocSet, ID: "_doc_",
                                        Path:  PathCurrentFamily, Value: rawJSON(`"fam_gc"`),
                                })
                        }
                        res := r.Submit("dev_gc", ops, true)
                        if res.Err != nil {
                                t.Fatalf("submit: %v", res.Err)
                        }
                }
        }

        // BELOW the threshold: 10 ops, checkpoint, NO trim
        submit(10)
        r.checkpointNow()
        ops, err := db.ListCanvasOps("cv_gc", 0)
        if err != nil {
                t.Fatalf("list: %v", err)
        }
        if len(ops) != 10 {
                t.Fatalf("below threshold the journal must keep all ops, got %d", len(ops))
        }

        // PAST the threshold: 300 more ops, checkpoint — the trim fires (the
        // HTTP submit path checkpoints per batch; the honest invariant: every
        // op ≤ the last trim point is GONE and the remainder fits ONE
        // threshold window — the SNAPSHOT-redirect keeps readers whole)
        submit(300)
        r.checkpointNow()
        ops, err = db.ListCanvasOps("cv_gc", 0)
        if err != nil {
                t.Fatalf("list: %v", err)
        }
        if len(ops) > JournalGCThreshold {
                t.Fatalf("the journal's remainder must fit one threshold window, got %d", len(ops))
        }
        minSeq := int64(1<<62)
        for _, op := range ops {
                if int64(op.Seq) < minSeq {
                        minSeq = int64(op.Seq)
                }
        }
        // the folded-off past is GONE — the oldest survivor sits past the trim
        if minSeq < int64(JournalGCThreshold) {
                t.Fatalf("the ops ≤ the trim point must be gone; oldest survivor seq=%d", minSeq)
        }
        // the fold survived on the ROW (the checkpoint is the truth, not the journal)
        c, err := db.GetCanvas("cv_gc")
        if err != nil {
                t.Fatalf("row: %v", err)
        }
        if c.FoldSeq == 0 {
                t.Fatalf("the fold watermark must have advanced")
        }
}
