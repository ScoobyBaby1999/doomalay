// jobwrap_v1741_test.go — v1.74.1 THE ONCE-DELIVERY LAW pins.
//
// The conviction (audit-a): at the window's edge Go's select picks
// randomly between a ready `done` and a ready timer — the old shape could
// hand the caller the JOB_STARTED ticket for work that had ALREADY
// finished (and then the settler reported the same finish as a job row:
// "still working" for done work + double event noise). THE DRAIN: when
// the timer branch fires and `done` is already filled, the NATURAL
// result returns — the ticket and the natural finish are mutually
// exclusive, ever.
package mcpbus

import (
        "context"
        "os"
        "strings"
        "testing"
        "time"

        "github.com/ScoobyBaby1999/doomalay/engine/internal/jobmgr"
)

// TestV1741_OnceDeliveryDrainExists — the source pin: the timer branch
// carries the non-blocking drain BEFORE jm.Begin (the race guard is load-
// bearing; removing it re-opens the double-report window).
func TestV1741_OnceDeliveryDrainExists(t *testing.T) {
        b, err := os.ReadFile("jobwrap.go")
        if err != nil {
                t.Fatalf("read jobwrap.go: %v", err)
        }
        src := string(b)
        if !strings.Contains(src, "THE ONCE-DELIVERY LAW") {
                t.Fatalf("the drain comment is gone")
        }
        if !strings.Contains(src, "case o := <-done:\n                        cancel()\n                        return o.res, o.err\n                default:") {
                t.Fatalf("the non-blocking drain is missing from the timer branch")
        }
        begins := strings.Index(src, "jm.Begin(sess, name, argJSON, cancel, dispatchStart)")
        drainAt := strings.Index(src, "return o.res, o.err\n                default:")
        if begins < 0 || drainAt < 0 || drainAt > begins {
                t.Fatalf("the drain must run BEFORE the lane is born")
        }
}

// TestV1741_WindowEdgeNeverDoubleReports — the behavior pin: a dispatch
// finishing in the window's edge zone lands EXACTLY once — either the
// natural result (no lane ever born) or the ticket (one lane, settled
// once, delivered once). Never a lane born for already-finished work
// alongside the caller's natural result, never a settle storm.
func TestV1741_WindowEdgeNeverDoubleReports(t *testing.T) {
        t.Setenv("DOOMALAY_JOB_GRACE_MS", "120")
        b, _ := newTestBus(t)
        for i := 0; i < 12; i++ {
                sess := "v1741-edge"
                turn := slowTurn(sess, 125*time.Millisecond) // finishes ~5ms past the window
                res := b.CallTool(context.Background(), turn, "time_now", args(t, map[string]any{"tz": "UTC"}))
                if strings.Contains(res.Text, "JOB_STARTED") {
                        // the ticket path: the lane exists, settles exactly once, the
                        // ring delivers once — the caller NEVER also sees the natural
                        // text in the same result
                        if strings.Contains(res.Text, "the slow clock answered") {
                                t.Fatalf("iteration %d: the ticket AND the natural text in one result", i)
                        }
                        deadline := time.Now().Add(3 * time.Second)
                        for time.Now().Before(deadline) {
                                if lanes := jobmgr.Default().List(sess); len(lanes) == 1 && lanes[0].State != jobmgr.StateWorking {
                                        break
                                }
                                time.Sleep(20 * time.Millisecond)
                        }
                        ring := jobmgr.Default().DrainSettled(sess)
                        if len(ring) > 1 {
                                t.Fatalf("iteration %d: the lane delivered more than once: %+v", i, ring)
                        }
                        if again := jobmgr.Default().DrainSettled(sess); len(again) != 0 {
                                t.Fatalf("iteration %d: the ring re-delivered: %+v", i, again)
                        }
                } else {
                        // the natural path (done won the race or the drain caught it):
                        // NO lane may exist for this session
                        if lanes := jobmgr.Default().List(sess); len(lanes) != 0 {
                                t.Fatalf("iteration %d: a natural result was returned AND a lane exists: %+v", i, lanes)
                        }
                }
        }
}
