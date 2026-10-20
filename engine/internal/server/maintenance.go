// maintenance.go — v1.42.1 THE LONG HAUL (PLAN-V142 §3.0, H1+H3).
//
// The idle-time maintenance loop + the storage dashboard surface:
//
//   · the loop: one pass 30s after boot (NEVER on the boot path — the
//     boot storm law), then every 6h. Each pass skips while a turn
//     streams (the busy gauge) — a VACUUM under a live turn would stall
//     the event log behind the single write connection.
//
//   · GET /api/storage/usage — the honest aged-state dashboard: engine
//     DB/WAL sizes, row counts, free-page ratio, last-VACUUM age, the
//     OTA overlay footprint. The Settings storage page renders it; the
//     aged-state rig asserts on it.
//
//   · POST /api/storage/maintain {force} — run one Maintain() pass now
//     (force bypasses the 7-day VACUUM spacing + ratio gate; a busy
//     engine answers 409 honestly, never queues silently).
package server

import (
        "encoding/json"
        "io/fs"
        "log"
        "net/http"
        "path/filepath"
        "time"

        "github.com/ScoobyBaby1999/doomalay/engine/internal/store"
)

const (
        // maintainBootDelay keeps the first pass OFF the boot path: the engine
        // is up, the WebView is loading, the heal already ran — maintenance
        // waits for the idle window.
        maintainBootDelay = 30 * time.Second
        // maintainPeriod is the idle cadence between passes.
        maintainPeriod = 6 * time.Hour
)

// maintenanceLoop runs on its own goroutine from New().
func (s *Server) maintenanceLoop() {
        time.Sleep(maintainBootDelay)
        s.runMaintenance(false)
        t := time.NewTicker(maintainPeriod)
        defer t.Stop()
        for range t.C {
                s.runMaintenance(false)
        }
}

// runMaintenance executes one idle pass behind the busy gate. The report
// lands in the log (the storage page shows the stamps, not the reports).
func (s *Server) runMaintenance(force bool) *store.MaintenanceReport {
        if s.db == nil {
                return nil
        }
        if engineBusy() {
                log.Printf("maintenance: engine busy — deferring this pass")
                return nil
        }
        rep, err := s.db.Maintain(force)
        if err != nil {
                log.Printf("maintenance: %v", err)
                return rep
        }
        if rep != nil {
                log.Printf("maintenance: checkpoint=%v optimize=%v vacuum=%v wal %d→%d bytes, db %d bytes, freelist %d/%d pages",
                        rep.Checkpointed, rep.OptimizeRan, rep.VacuumRan,
                        rep.WALBytesPre, rep.WALBytesPost, rep.DbBytes, rep.FreePages, rep.PageCount)
        }
        return rep
}

// engineBusy reports whether any turn is streaming (the wake-lock gauge's
// own counter — chat.go's turnGaugeN).
func engineBusy() bool {
        turnGaugeMu.Lock()
        defer turnGaugeMu.Unlock()
        return turnGaugeN > 0
}

// handleStorageUsage is GET /api/storage/usage.
func (s *Server) handleStorageUsage(w http.ResponseWriter, r *http.Request) {
        out := map[string]any{"ok": true}
        if s.db != nil {
                out["engine"] = s.db.Usage()
        }
        // The OTA overlay footprint (absent/disabled = zeroed shape, not null —
        // the storage page renders one honest row either way).
        files, bytes := int64(0), int64(0)
        if s.ota != nil {
                files, bytes = otaOverlayFootprint(s.ota.root)
        }
        out["overlay"] = map[string]any{"files": files, "bytes": bytes}
        writeJSON(w, http.StatusOK, out)
}

// handleStorageMaintain is POST /api/storage/maintain {"force":bool}.
// A busy engine answers 409 (the pass is a burst, never queued).
func (s *Server) handleStorageMaintain(w http.ResponseWriter, r *http.Request) {
        if s.db == nil {
                writeJSON(w, http.StatusServiceUnavailable, map[string]any{"ok": false, "error": "no database"})
                return
        }
        force := false
        if r.Body != nil {
                var req struct {
                        Force bool `json:"force"`
                }
                if json.NewDecoder(r.Body).Decode(&req) == nil {
                        force = req.Force
                }
        }
        if engineBusy() {
                writeJSON(w, http.StatusConflict, map[string]any{
                        "ok": false, "error": "a turn is running — try again when the engine is idle",
                })
                return
        }
        rep, err := s.db.Maintain(force)
        if err != nil {
                writeJSON(w, http.StatusInternalServerError, map[string]any{"ok": false, "error": err.Error()})
                return
        }
        writeJSON(w, http.StatusOK, map[string]any{"ok": true, "report": rep})
}

// otaOverlayFootprint counts the overlay's files + bytes (no secrets —
// sizes only).
func otaOverlayFootprint(root string) (files, bytes int64) {
        _ = filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
                if err != nil || d.IsDir() {
                        return nil
                }
                if info, ierr := d.Info(); ierr == nil {
                        files++
                        bytes += info.Size()
                }
                return nil
        })
        return files, bytes
}
