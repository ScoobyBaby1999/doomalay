package store

// maintain_test.go — v1.42.1 THE LONG HAUL (PLAN-V142 §3.0 H1a): the
// idle-maintenance contract.
//
//   (1) Open() applies the journal_size_limit (the WAL file bound —
//       without it the -wal file keeps its lifetime high-water size).
//   (2) Maintain() truncates the WAL after writes.
//   (3) VACUUM obeys its gates: force runs it + stamps; unforced it
//       needs BOTH the freelist ratio AND the 7-day spacing.
//   (4) Usage() reports the honest snapshot (counts + sizes).

import (
	"path/filepath"
	"strconv"
	"testing"
	"time"
)

func openMaintainDB(t *testing.T) *DB {
	t.Helper()
	dir := t.TempDir()
	db, err := Open(dir)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	if err := db.Migrate(); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	return db
}

// TestV1421_JournalSizeLimitAppliedAtOpen — the DSN-level WAL bound.
func TestV1421_JournalSizeLimitAppliedAtOpen(t *testing.T) {
	db := openMaintainDB(t)
	defer db.Close()
	var limit int64
	if err := db.QueryRow("PRAGMA journal_size_limit").Scan(&limit); err != nil {
		t.Fatalf("read journal_size_limit: %v", err)
	}
	if limit != JournalSizeLimitBytes {
		t.Fatalf("journal_size_limit = %d, want %d", limit, JournalSizeLimitBytes)
	}
}

// TestV1421_MaintainTruncatesWAL — a burst of committed writes grows the
// WAL; one idle pass drains it to (near) zero.
func TestV1421_MaintainTruncatesWAL(t *testing.T) {
	db := openMaintainDB(t)
	defer db.Close()
	for i := 0; i < 120; i++ {
		if _, err := db.AppendEvent("wal-sess", "assistant_delta", "x", ""); err != nil {
			t.Fatalf("seed event: %v", err)
		}
	}
	pre := fileSize(db.walPath())
	rep, err := db.Maintain(false)
	if err != nil {
		t.Fatalf("maintain: %v", err)
	}
	if !rep.Checkpointed {
		t.Fatalf("checkpoint did not complete: %+v", rep)
	}
	if rep.WALBytesPost > 64<<10 {
		t.Fatalf("wal after maintain = %d bytes, want ≤64KB (pre %d)", rep.WALBytesPost, pre)
	}
	if rep.WALBytesPost > pre {
		t.Fatalf("wal grew across a maintain pass: %d → %d", pre, rep.WALBytesPost)
	}
}

// TestV1421_VacuumGates — force bypasses; unforced needs BOTH ratio and
// the 7-day spacing (a just-stamped vacuum refuses an immediate rerun).
func TestV1421_VacuumGates(t *testing.T) {
	db := openMaintainDB(t)
	defer db.Close()
	// Seed then delete enough rows to leave free pages behind.
	for i := 0; i < 200; i++ {
		if _, err := db.AppendEvent("vac-sess", "assistant_delta", "some payload text here", ""); err != nil {
			t.Fatalf("seed: %v", err)
		}
	}
	if err := db.DeleteSession("vac-sess"); err != nil {
		t.Fatalf("delete session: %v", err)
	}

	// Unforced + never-vacuumed: the ratio may qualify, so this CAN run —
	// the gate we can pin deterministically is the STAMP: after any vacuum,
	// an immediate second unforced pass must NOT vacuum again (7-day law).
	first, err := db.Maintain(false)
	if err != nil {
		t.Fatalf("first maintain: %v", err)
	}
	second, err := db.Maintain(false)
	if err != nil {
		t.Fatalf("second maintain: %v", err)
	}
	if first.VacuumRan && second.VacuumRan {
		t.Fatalf("back-to-back unforced vacuums — the 7-day spacing gate failed")
	}

	// Force always runs it (the storage page's button + the rig).
	if _, err := db.Maintain(true); err != nil {
		t.Fatalf("forced maintain: %v", err)
	}
	last := db.LastVacuumAt()
	if last == 0 || time.Since(time.Unix(last, 0)) > time.Minute {
		t.Fatalf("last_vacuum_at stamp missing or stale: %d", last)
	}
}

// TestV1421_VacuumReclaimsDeletedEvents — the aged-install shape: months
// of deleted chats leave free pages; a forced pass shrinks the file.
func TestV1421_VacuumReclaimsDeletedEvents(t *testing.T) {
	db := openMaintainDB(t)
	defer db.Close()
	for i := 0; i < 400; i++ {
		if _, err := db.AppendEvent("recl-sess", "assistant_delta", "payload that occupies real pages payload that occupies real pages", ""); err != nil {
			t.Fatalf("seed: %v", err)
		}
	}
	before := fileSize(db.path)
	if err := db.DeleteSession("recl-sess"); err != nil {
		t.Fatalf("delete: %v", err)
	}
	rep, err := db.Maintain(true)
	if err != nil {
		t.Fatalf("forced maintain: %v", err)
	}
	if !rep.VacuumRan {
		t.Fatalf("forced vacuum did not run")
	}
	after := fileSize(db.path)
	if after >= before {
		t.Fatalf("db file did not shrink after vacuum+delete: %d → %d", before, after)
	}
	if rep.FreePages > rep.PageCount/10 {
		t.Fatalf("freelist still high after vacuum: %d/%d", rep.FreePages, rep.PageCount)
	}
}

// TestV1421_UsageSnapshot — counts and sizes are present and sane.
func TestV1421_UsageSnapshot(t *testing.T) {
	db := openMaintainDB(t)
	defer db.Close()
	if _, err := db.AppendEvent("u-sess", "user", "hi", ""); err != nil {
		t.Fatalf("seed: %v", err)
	}
	u := db.Usage()
	if u.Events != 1 || u.Sessions != 0 {
		t.Fatalf("usage counts: events=%d sessions=%d, want 1/0 (a session-less event row is the seed shape)", u.Events, u.Sessions)
	}
	if u.PageBytes == 0 || u.PageCount == 0 {
		t.Fatalf("usage page shape: %+v", u)
	}
	if u.DbBytes == 0 {
		t.Fatalf("usage db size missing")
	}
}

// TestV1421_WALPathHelper — the sibling paths derive from the DB path.
func TestV1421_WALPathHelper(t *testing.T) {
	db := openMaintainDB(t)
	defer db.Close()
	if filepath.Base(db.walPath()) != "doomalay.db-wal" {
		t.Fatalf("walPath = %q", db.walPath())
	}
}

// TestV1421_LastVacuumAtNever — zero before any vacuum.
func TestV1421_LastVacuumAtNever(t *testing.T) {
	db := openMaintainDB(t)
	defer db.Close()
	if got := db.LastVacuumAt(); got != 0 {
		t.Fatalf("last vacuum = %d, want 0 (never)", got)
	}
	_ = strconv.Itoa // shape guard
}
