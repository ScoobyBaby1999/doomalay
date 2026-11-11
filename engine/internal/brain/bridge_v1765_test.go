package brain

// bridge_v1765_test.go — v1.76.5 THE SINGLE PASS pins (PLAN-V176 §v1.76.5):
// the separate deps-check interpreter boot is GONE — server.py boots
// directly (this suite's fake brains use ONLY stdlib: the sandbox python
// has no fastapi/uvicorn/litellm, so a passing boot IS the single-pass
// proof — the old pre-check would have failed right here), a process that
// dies young fails the start fast with its own captured ImportError tail
// + the pip remedy, the health window is env-knobbed, and Stop is an
// idempotent no-second-Wait over the persistent reaper.

import (
        "fmt"
        "net"
        "os"
        "path/filepath"
        "strings"
        "testing"
        "time"
)

// goodBrainV1765 — a stdlib-only brain: answers /health, records each
// boot in boot.log (the single-boot pin).
const goodBrainV1765 = `
import sys, http.server
port = int(sys.argv[sys.argv.index("--port") + 1])
open("boot.log", "a").write("boot\n")
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/health":
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(b'{"status":"ok","brain":true}')
        else:
            self.send_response(404)
            self.end_headers()
    def log_message(self, *a):
        pass
http.server.ThreadingHTTPServer(("127.0.0.1", port), H).serve_forever()
`

func freePortV1765(t *testing.T) int {
        t.Helper()
        l, err := net.Listen("tcp", "127.0.0.1:0")
        if err != nil {
                t.Fatalf("listen: %v", err)
        }
        p := l.Addr().(*net.TCPAddr).Port
        _ = l.Close()
        return p
}

func writeBrainV1765(t *testing.T, script string) string {
        t.Helper()
        dir := t.TempDir()
        if err := os.WriteFile(filepath.Join(dir, "server.py"), []byte(script), 0o644); err != nil {
                t.Fatalf("write fake brain: %v", err)
        }
        return dir
}

// TestV1765_SinglePassBoot — THE MARQUEE PROOF: this sandbox's python has
// NO fastapi/uvicorn/litellm installed, so the old pre-boot deps check
// would have rejected this Start outright. Single-pass boots straight to
// healthy, and boot.log records exactly ONE server.py run.
func TestV1765_SinglePassBoot(t *testing.T) {
        dir := writeBrainV1765(t, goodBrainV1765)
        port := freePortV1765(t)

        b, err := Start(dir, port)
        if err != nil {
                t.Fatalf("single-pass boot must not depend on the deps pre-check: %v", err)
        }
        defer b.Stop()
        if !b.Healthy() {
                t.Fatal("the fake brain must be healthy after boot")
        }
        bootLog, rerr := os.ReadFile(filepath.Join(dir, "boot.log"))
        if rerr != nil {
                t.Fatalf("read boot.log: %v", rerr)
        }
        if n := strings.Count(string(bootLog), "boot"); n != 1 {
                t.Fatalf("server.py ran %d times, want exactly 1 (the deps-check boot is dead)", n)
        }
}

// TestV1765_ImportErrorFailsFastWithRemedy — a server.py that dies young
// on a missing module: the start fails in milliseconds (early exit, not
// the whole window) carrying the captured ImportError tail AND the pip
// remedy — the same honesty the old pre-check gave, one boot sooner.
func TestV1765_ImportErrorFailsFastWithRemedy(t *testing.T) {
        dir := writeBrainV1765(t, "import fastapi_missing_module_xyz\n")
        t.Setenv("DOOMALAY_BRAIN_BOOT_TIMEOUT", "8")

        start := time.Now()
        _, err := Start(dir, freePortV1765(t))
        el := time.Since(start)
        if err == nil {
                t.Fatal("an ImportErroring server.py must fail the start")
        }
        if !strings.Contains(err.Error(), "pip install -r brain/requirements.txt") {
                t.Fatalf("the pip remedy must ride the error, got: %v", err)
        }
        if !strings.Contains(err.Error(), "fastapi_missing_module_xyz") {
                t.Fatalf("the captured ImportError tail must ride the error, got: %v", err)
        }
        if el >= 5*time.Second {
                t.Fatalf("early exit took %s — a dead-young process must fail fast, not wait the window", el)
        }
}

// TestV1765_HealthTimeoutSurfacesStderr — a brain that binds nothing and
// talks forever: the start fails at the boot window with the honest
// timeout + the captured stderr attached.
func TestV1765_HealthTimeoutSurfacesStderr(t *testing.T) {
        dir := writeBrainV1765(t, "import sys, time\nprint('starting the thinking process...', file=sys.stderr, flush=True)\ntime.sleep(30)\n")
        t.Setenv("DOOMALAY_BRAIN_BOOT_TIMEOUT", "1")

        start := time.Now()
        _, err := Start(dir, freePortV1765(t))
        el := time.Since(start)
        if err == nil {
                t.Fatal("a never-listening brain must fail the start")
        }
        if !strings.Contains(err.Error(), "timeout waiting for brain") {
                t.Fatalf("the honest timeout error, got: %v", err)
        }
        if !strings.Contains(err.Error(), "starting the thinking process") {
                t.Fatalf("the stderr tail must ride the error, got: %v", err)
        }
        if el < time.Second || el > 6*time.Second {
                t.Fatalf("the boot window must be respected (knobbed to 1s), took %s", el)
        }
}

// TestV1765_StopIsIdempotentAndReaps — Stop closes done fast (the reaper
// already ran or runs now), and a second Stop is a safe no-op (never a
// second cmd.Wait — the old Stop double-Waited a dead child).
func TestV1765_StopIsIdempotentAndReaps(t *testing.T) {
        dir := writeBrainV1765(t, goodBrainV1765)
        port := freePortV1765(t)

        b, err := Start(dir, port)
        if err != nil {
                t.Fatalf("boot: %v", err)
        }
        if err := b.cmd.Process.Signal(os.Interrupt); err != nil {
                t.Fatalf("signal: %v", err)
        }
        select {
        case <-b.done:
        case <-time.After(5 * time.Second):
                t.Fatal("the persistent reaper never closed done after the process died")
        }
        b.Stop()  // idempotent over an already-dead brain
        b.Stop()  // and again — a no-op, never a panic or a second Wait
        if b.done == nil {
                t.Fatal("done must exist")
        }
}

// TestV1765_MemRingBounds — the diagnosis ring keeps only the LAST max
// bytes (a chatty dying process still reports its real tail).
func TestV1765_MemRingBounds(t *testing.T) {
        r := newMemRing(16)
        for i := 0; i < 10; i++ {
                _, _ = r.Write([]byte(fmt.Sprintf("%02d-", i)))
        }
        tail := r.tail()
        if len(tail) != 16 {
                t.Fatalf("ring len = %d, want the 16-byte cap", len(tail))
        }
        if !strings.HasSuffix(tail, "08-09-") {
                t.Fatalf("the ring must keep the TAIL, got %q", tail)
        }
}
