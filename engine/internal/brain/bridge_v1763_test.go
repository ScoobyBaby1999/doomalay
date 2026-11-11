package brain

// bridge_v1763_test.go — v1.76.3 pins (PLAN-V176 §v1.76.3): the dead
// refresh check stays dead (source pin), and THE SINGLE RE-PROBE LAW —
// a heal-then-fail flap while a re-probe loop is mid-sleep must never
// spawn a second loop, the conviction flip must still land, and the one
// loop must revive the brain on its next probe.

import (
        "bytes"
        "net/http"
        "net/http/httptest"
        "os"
        "sync"
        "testing"
        "time"
)

// TestV1763_DeadRefreshCheckRemoved — the source pin (the repo's source-
// pin culture): the never-firing refresh query block stays dead. It could
// never fire (the URL is built queryless) and has had zero callers since
// v1.55.3 retired the /api/models brain proxy.
func TestV1763_DeadRefreshCheckRemoved(t *testing.T) {
        src, err := os.ReadFile("bridge.go")
        if err != nil {
                t.Fatalf("read source: %v", err)
        }
        if bytes.Contains(src, []byte(`q.Get("refresh")`)) {
                t.Fatal("the dead refresh check must stay buried (v1.76.3)")
        }
        if bytes.Contains(src, []byte("// pass through")) {
                t.Fatal("the dead block's corpse must not resurface")
        }
}

// TestV1763_SingleReprobeLoop — the pile shape, step by step: a brain
// stalls (loop #1 armed, reprobing=true) → the flag heals mid-sleep (a
// Chat 200 does exactly this) → a fresh failure flips the flag again.
// The OLD code spawned loop #2 right there (stacking one per repeat);
// the LAW keeps loop #1 the sole owner of the revival — and it revives
// the brain on its next 15s probe with exactly one probe's traffic.
func TestV1763_SingleReprobeLoop(t *testing.T) {
        var mu sync.Mutex
        probes := 0
        srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
                mu.Lock()
                probes++
                mu.Unlock()
                w.WriteHeader(200) // the brain is alive again — the probe must revive it
        }))
        defer srv.Close()

        b := &Brain{url: srv.URL, healthy: true, probeCli: &http.Client{Timeout: 2 * time.Second}}

        b.MarkUnhealthy() // conviction #1 → loop #1 armed (sleeps its 15s)
        b.mu.RLock()
        if !b.reprobing {
                b.mu.RUnlock()
                t.Fatal("the first conviction must arm the re-probe loop")
        }
        b.mu.RUnlock()

        b.MarkUnhealthy() // repeat while unhealthy → the early return, no flags touched
        if b.Healthy() {
                t.Fatal("the flag must stay dead after the repeat conviction")
        }

        // THE PILE SHAPE: the flag heals mid-sleep (v1.76.1's Chat-heal
        // does exactly this)…
        b.mu.Lock()
        b.healthy = true
        b.mu.Unlock()
        // …and a fresh failure flips it again — the old code stacked a
        // second loop here; the LAW hands revival back to loop #1.
        b.MarkUnhealthy()
        b.mu.RLock()
        reprobe := b.reprobing
        b.mu.RUnlock()
        if !reprobe {
                t.Fatal("the in-flight loop must keep its single-flight ownership")
        }
        if b.Healthy() {
                t.Fatal("the conviction flip must still land on the pile shape")
        }

        // loop #1's next 15s probe revives the brain — and no pile means
        // exactly one probe's traffic in the window.
        deadline := time.Now().Add(25 * time.Second)
        for time.Now().Before(deadline) {
                if b.Healthy() {
                        break
                }
                time.Sleep(100 * time.Millisecond)
        }
        if !b.Healthy() {
                t.Fatal("the single re-probe loop never revived the brain")
        }
        // the loop returns on revival — reprobing must clear (bounded wait)
        clearDeadline := time.Now().Add(3 * time.Second)
        for time.Now().Before(clearDeadline) {
                b.mu.RLock()
                rp := b.reprobing
                b.mu.RUnlock()
                if !rp {
                        break
                }
                time.Sleep(50 * time.Millisecond)
        }
        b.mu.RLock()
        still := b.reprobing
        b.mu.RUnlock()
        if still {
                t.Fatal("revival must retire the loop (reprobing cleared)")
        }
        mu.Lock()
        n := probes
        mu.Unlock()
        if n > 2 {
                t.Fatalf("probes = %d — loops piled up (the old bug)", n)
        }
}
