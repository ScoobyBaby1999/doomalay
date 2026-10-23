// maintain.go — v1.42.1 THE LONG HAUL (PLAN-V142 §3.0, hypothesis H1a).
//
// Idle-time SQLite hygiene. The aged-install diagnosis: the DB opens in
// WAL journal mode with NO journal_size_limit and NO truncate checkpoint
// anywhere — SQLite's passive auto-checkpoint (1000 pages) moves frames
// into the main DB but the -wal FILE keeps its high-water size on disk
// forever, so doomalay.db-wal only ever grows. Deleted rows (chat_events
// of removed sessions) leave free pages behind — without auto_vacuum or
// a VACUUM cadence the main file also only ever grows. Neither is a leak
// (bounded by lifetime writes) but both scale with install age exactly
// like the user reported ("degrades the longer the app is downloaded"),
// and cold boots pay bigger files.
//
// The fix rides the sqlite.org guidance (the WAL page): checkpoint
// TRUNCATE after idle, and VACUUM only when it can shrink something
// (freelist ratio) and rarely (7-day min interval, stamped in
// app_settings) — a VACUUM on a big DB is expensive and writes through
// the WAL, so it must be idle-time, never boot-blocking, never while a
// turn streams (the caller gates on the busy gauge).
//
// Exposed for the Settings storage page + the aged-state rig:
// POST /api/storage/maintain (server/maintenance.go) runs this on demand.
package store

import (
        "fmt"
        "os"
        "strconv"
        "time"
)

// MaintenanceReport is the honest account of one Maintain() pass.
type MaintenanceReport struct {
        Checkpointed  bool   // wal_checkpoint(TRUNCATE) ran to completion
        OptimizeRan   bool   // PRAGMA optimize ran
        VacuumRan     bool   // VACUUM actually executed (gates passed / forced)
        SkippedBusy   bool   // not used here; the HTTP layer reports turn-busy skips
        WALBytesPre   int64  // -wal file size before the pass
        WALBytesPost  int64  // -wal file size after the pass
        FreePages     int64  // PRAGMA freelist_count after the pass
        PageCount     int64  // PRAGMA page_count after the pass
        PageBytes     int64  // PRAGMA page_size
        DbBytes       int64  // main DB file size after the pass
        LastVacuumAgo string // human-readable age of the last VACUUM stamp ("" = never)
        // v1.64.3 THE GENEROUS WINDOW: the per-session retention pass
        // (sessions trimmed, rows deleted) — the user's law: "give a very
        // generous amount (a month or couple worth of messages - 50ish mb
        // maybe uncompressed)"; the trim keeps the newest 48MB of content
        // per session, oldest-first, never a pending turn's window.
        RetentionTrimmedSessions int
        RetentionDeletedRows     int64
}

const (
        // maintainVacuumKey is the app_settings stamp (unix seconds, float —
        // the store's REAL convention) of the last executed VACUUM.
        maintainVacuumKey = "maintain.vacuum_at"
        // vacuumMinInterval is the minimum spacing between real VACUUMs. A
        // VACUUM rewrites the whole DB through the WAL — it is the most
        // expensive thing this module does, so it stays rare.
        vacuumMinInterval = 7 * 24 * time.Hour
        // vacuumFreeRatio gates VACUUM on actual reclaimable space: only
        // vacuum when ≥25% of pages are free (deleted-session events etc.).
        vacuumFreeRatio = 0.25
        // JournalSizeLimitBytes bounds the -wal file after checkpoints (the
        // sqlite.org WAL advice: set journal_size_limit so post-checkpoint
        // TRUNCATEs actually return the space to the filesystem).
        JournalSizeLimitBytes = 8 << 20 // 8MB
)

// retentionBudget is the per-session event-content budget
// (v1.64.3 THE GENEROUS WINDOW): 48MB ≈ the user's "50ish mb maybe
// uncompressed" — a month or couple of messages rides whole per chat;
// only beyond it do the OLDEST rows go. (A var, not a const: the test
// budget overrides it — the v1633 rig never seeds 48MB.)
var retentionBudget = int64(48 << 20)

// dbPath returns the path of the main database file. The DB struct is
// opened with a "file:<path>?..." DSN; the path is kept in db.path by
// store.Open.

func (db *DB) walPath() string { return db.path + "-wal" }

// SetJournalSizeLimit applies the WAL file-size bound. Called once from
// Open(); idempotent and cheap enough to call again (the settings page
// does not, but tests may).
func (db *DB) SetJournalSizeLimit(bytes int64) error {
        _, err := db.Exec(fmt.Sprintf("PRAGMA journal_size_limit = %d", bytes))
        return err
}

// Maintain runs one idle-time maintenance pass:
//
//  1. PRAGMA wal_checkpoint(TRUNCATE) — flush + truncate the WAL.
//  2. PRAGMA optimize — the sqlite.org-analyze cadence.
//  3. VACUUM when (force) OR (freelist ≥ 25% AND last VACUUM ≥ 7d ago);
//     a forced VACUUM still checkpoints before and after so the file
//     shrink actually reaches the filesystem (the photostructure study:
//     vacuum-without-checkpoint is wasted work in WAL mode).
//
// It never returns an error for the optional steps being unavailable —
// the report tells the truth, the caller logs it.
func (db *DB) Maintain(force bool) (*MaintenanceReport, error) {
        rep := &MaintenanceReport{}
        rep.WALBytesPre = fileSize(db.walPath())

        // 1. checkpoint TRUNCATE
        var busy, log, checkpointed int
        if err := db.QueryRow("PRAGMA wal_checkpoint(TRUNCATE)").Scan(&busy, &log, &checkpointed); err == nil {
                rep.Checkpointed = busy == 0
        }

        // 2. optimize (cheap; sqlite.org recommends post-checkpoint)
        if _, err := db.Exec("PRAGMA optimize"); err == nil {
                rep.OptimizeRan = true
        }

        // 3. conditional VACUUM
        var freePages, pageCount int64
        _ = db.QueryRow("PRAGMA freelist_count").Scan(&freePages)
        _ = db.QueryRow("PRAGMA page_count").Scan(&pageCount)
        last, _ := db.GetSetting(maintainVacuumKey)
        lastAt := float64(0)
        if last != "" {
                lastAt, _ = strconv.ParseFloat(last, 64)
        }
        lastT := time.Unix(int64(lastAt), 0)
        rep.LastVacuumAgo = "never"
        if lastAt > 0 {
                rep.LastVacuumAgo = time.Since(lastT).Truncate(time.Second).String()
        }
        ratio := 0.0
        if pageCount > 0 {
                ratio = float64(freePages) / float64(pageCount)
        }
        if force || (pageCount > 0 && ratio >= vacuumFreeRatio && (lastAt == 0 || time.Since(lastT) >= vacuumMinInterval)) {
                if _, err := db.Exec("VACUUM"); err == nil {
                        // VACUUM wrote through the WAL — checkpoint AGAIN so the
                        // main file's new shape is committed and the WAL drains.
                        // QueryRow+Scan (NOT bare Query): the checkpoint returns a
                        // row, and an unclosed *sql.Rows pins the ONE connection —
                        // every later call would deadlock (the V1421 rig caught it).
                        var a, b, c int
                        _ = db.QueryRow("PRAGMA wal_checkpoint(TRUNCATE)").Scan(&a, &b, &c)
                        rep.VacuumRan = true
                        _ = db.SetSetting(maintainVacuumKey, strconv.FormatFloat(float64(time.Now().Unix()), 'f', -1, 64))
                        // re-read the post-vacuum shape
                        _ = db.QueryRow("PRAGMA freelist_count").Scan(&freePages)
                        _ = db.QueryRow("PRAGMA page_count").Scan(&pageCount)
                }
        }

        rep.FreePages = freePages
        rep.PageCount = pageCount
        _ = db.QueryRow("PRAGMA page_size").Scan(&rep.PageBytes)
        rep.WALBytesPost = fileSize(db.walPath())
        rep.DbBytes = fileSize(db.path)

        // 4. v1.64.3 THE GENEROUS WINDOW — the per-session retention trim:
        // a session whose CONTENT bytes exceed 48MB loses its OLDEST rows
        // until it fits (a month or couple of messages rides whole; the
        // trim walks (seq, bytes) pairs — never content). NEVER a pending
        // turn's window: a session whose tail is mid-turn (an in-flight or
        // interrupted-but-unhealed turn) is skipped wholesale — the trim
        // only touches settled logs. Best-effort by law: a failed walk
        // skips the session, the report tells the truth.
        sessions, err := db.ListSessions()
        if err == nil {
                for _, sess := range sessions {
                        total := db.SessionEventBytes(sess.ID)
                        if total <= retentionBudget {
                                continue
                        }
                        if pending, _ := db.TailPendingTurn(sess.ID, 20001); pending {
                                continue // the active/interrupted window is sacred
                        }
                        lengths, lerr := db.SessionEventSeqLengths(sess.ID)
                        if lerr != nil || len(lengths) == 0 {
                                continue
                        }
                        excess := total - retentionBudget
                        cum := int64(0)
                        split := 0
                        for _, p := range lengths {
                                if cum >= excess {
                                        split = p[0]
                                        break
                                }
                                cum += int64(p[1])
                        }
                        if split <= 1 {
                                continue // the whole log is the newest window — nothing to trim
                        }
                        if n := db.TrimSessionEventsOlderThan(sess.ID, split); n > 0 {
                                rep.RetentionTrimmedSessions++
                                rep.RetentionDeletedRows += n
                        }
                }
        }
        return rep, nil
}

// LastVacuumAt returns the unix-seconds stamp of the last VACUUM (0 =
// never) — the storage usage row shows its age.
func (db *DB) LastVacuumAt() int64 {
        last, _ := db.GetSetting(maintainVacuumKey)
        if last == "" {
                return 0
        }
        f, _ := strconv.ParseFloat(last, 64)
        return int64(f)
}

func fileSize(p string) int64 {
        if st, err := os.Stat(p); err == nil {
                return st.Size()
        }
        return 0
}

// StorageUsage is the honest aged-state snapshot the Settings storage
// page (and the aged-state rig) reads: file sizes + row counts + the
// maintenance stamps. No paths, no payloads — counts and bytes only.
type StorageUsage struct {
        DbBytes   int64 `json:"db_bytes"`
        WALBytes  int64 `json:"wal_bytes"`
        SHMBytes  int64 `json:"shm_bytes"`
        Sessions  int64 `json:"sessions"`
        Events    int64 `json:"chat_events"`
        HubItems  int64 `json:"hub_items"`
        Canvases  int64 `json:"canvases"` // v1.42.4 THE LEDGER: the multi-canvas home joins the honest dashboard
        FreePages int64 `json:"freelist_pages"`
        PageCount int64 `json:"page_count"`
        PageBytes int64 `json:"page_bytes"`
        // LastVacuumAt: unix seconds, 0 = never.
        LastVacuumAt int64 `json:"last_vacuum_at"`
}

// Usage collects the StorageUsage snapshot (cheap COUNTs — the tables
// stay in the thousands, never millions).
func (db *DB) Usage() *StorageUsage {
        u := &StorageUsage{
                DbBytes:   fileSize(db.path),
                WALBytes:  fileSize(db.walPath()),
                SHMBytes:  fileSize(db.path + "-shm"),
        }
        _ = db.QueryRow("SELECT COUNT(*) FROM chat_sessions").Scan(&u.Sessions)
        _ = db.QueryRow("SELECT COUNT(*) FROM chat_events").Scan(&u.Events)
        _ = db.QueryRow("SELECT COUNT(*) FROM hub_items").Scan(&u.HubItems)
        u.Canvases = db.CountCanvases() // v1.42.4: the ledger rows join the dashboard
        _ = db.QueryRow("PRAGMA freelist_count").Scan(&u.FreePages)
        _ = db.QueryRow("PRAGMA page_count").Scan(&u.PageCount)
        _ = db.QueryRow("PRAGMA page_size").Scan(&u.PageBytes)
        u.LastVacuumAt = db.LastVacuumAt()
        return u
}
