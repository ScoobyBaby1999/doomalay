package store

// maintain_v1633_test.go — v1.63.3 THE GENEROUS WINDOW pins (PLAN-V163 §3):
// the per-session retention budget. The user's law verbatim: "give a very
// generous amount (a month or couple worth of messages - 50ish mb maybe
// uncompressed)". A session past the budget loses its OLDEST rows first
// (the newest window survives whole, terminal included); a session whose
// tail is a PENDING turn is never touched (the active/interrupted window
// is sacred).

import (
	"strings"
	"testing"
)

func TestV1633_RetentionBudget(t *testing.T) {
	db, err := Open(t.TempDir())
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	defer db.Close()
	if err := db.Migrate(); err != nil {
		t.Fatalf("migrate: %v", err)
	}

	// session A: 60 events × ~2KB = ~120KB, settled (ends idle) — over the
	// 50KB test budget → the OLDEST rows trim, the newest survive whole
	if err := db.CreateSession(&Session{ID: "chat_fat", Title: "fat"}); err != nil {
		t.Fatalf("create A: %v", err)
	}
	big := strings.Repeat("y", 2048)
	for i := 0; i < 60; i++ {
		if _, err := db.AppendEvent("chat_fat", "user", big, ""); err != nil {
			t.Fatalf("seed A: %v", err)
		}
	}
	if _, err := db.AppendEvent("chat_fat", "status", `{"state":"idle"}`, ""); err != nil {
		t.Fatalf("settle A: %v", err)
	}
	// session B: past the budget but PENDING (the tail is mid-turn) — never trimmed
	if err := db.CreateSession(&Session{ID: "chat_busy", Title: "busy"}); err != nil {
		t.Fatalf("create B: %v", err)
	}
	for i := 0; i < 60; i++ {
		if _, err := db.AppendEvent("chat_busy", "user", big, ""); err != nil {
			t.Fatalf("seed B: %v", err)
		}
	}

	old := retentionBudget
	retentionBudget = 50 * 1024
	defer func() { retentionBudget = old }()
	rep, err := db.Maintain(false)
	if err != nil {
		t.Fatalf("maintain: %v", err)
	}
	if rep.RetentionTrimmedSessions != 1 || rep.RetentionDeletedRows == 0 {
		t.Fatalf("the budget pass must trim exactly the settled fat session (trimmed=%d rows=%d)", rep.RetentionTrimmedSessions, rep.RetentionDeletedRows)
	}
	after := db.SessionEventBytes("chat_fat")
	if after > 60*1024 {
		t.Fatalf("session A must fit the budget (got %d bytes)", after)
	}
	evs, _ := db.ListEvents("chat_fat", 0)
	if len(evs) == 0 || evs[len(evs)-1].EventType != "status" {
		t.Fatalf("the newest window (incl. the terminal) must survive whole")
	}
	if evs[0].Seq < 2 {
		t.Fatalf("the trim must be oldest-first (first surviving seq=%d — the head must go first)", evs[0].Seq)
	}
	busy := db.SessionEventBytes("chat_busy")
	if busy < 100*1024 {
		t.Fatalf("the pending-turn session B must NEVER trim (got %d bytes)", busy)
	}
}
