package server

// ocbridgeapi_v1551_test.go — v1.55.1 THE HONEST LADDER pins, the server
// half: the bridge status route NEVER blocks on an in-flight install (the
// v155-A audit convicted the old all-hold — every bridge GET queued behind
// a 72.5MB download until the WebView's 6-slot connection pool exhausted
// and the provider screen rendered "No providers"), and while an install
// runs the route answers the LIVE progress (stage + bytes + percent +
// attempt) that the provider pill pings.

import (
        "context"
        "encoding/json"
        "net/http"
        "net/http/httptest"
        "sync/atomic"
        "testing"
        "time"

        "github.com/ScoobyBaby1999/doomalay/engine/internal/ocserve"
        "github.com/ScoobyBaby1999/doomalay/engine/internal/termuxbridge"
)

// v1551SlowBridge is a stub termux bridge whose commands STALL (the
// provisioning hangs mid-install — exactly the window the status route
// must survive).
type v1551SlowBridge struct {
        stalled atomic.Bool
        answers atomic.Int64
}

func (b *v1551SlowBridge) Status(ctx context.Context) (*termuxbridge.Status, error) {
        return &termuxbridge.Status{Installed: true, Permission: true}, nil
}

func (b *v1551SlowBridge) Run(ctx context.Context, command, workdir string, timeoutMS int) (*termuxbridge.RunResult, error) {
        b.answers.Add(1)
        if b.stalled.Load() {
                <-ctx.Done() // the stalled install window
        }
        return &termuxbridge.RunResult{Ok: true, ExitCode: 0, Stdout: "__dm_ok__\n"}, nil
}

func (b *v1551SlowBridge) RunWithStdin(ctx context.Context, command, workdir string, timeoutMS int, stdin string) (*termuxbridge.RunResult, error) {
        return b.Run(ctx, command, workdir, timeoutMS)
}

// TestV1551StatusNeverBlocksDuringInstall — THE NO-LONG-HOLD LAW: with an
// install goroutine stuck in the jailed provisioning, the bridge status GET
// must answer in milliseconds (state=installing), never queue behind the
// manager's work. This is the conviction test for the user's "while
// opencode installs, the cloud provider screen doesn't work and returns no
// providers".
func TestV1551StatusNeverBlocksDuringInstall(t *testing.T) {
        t.Setenv("DOOMALAY_OPENCODE_SPAWNER", "termux")

        br := &v1551SlowBridge{}
        s := newTermuxTestServer(t, "http://127.0.0.1:1/badtoken")
        v1492SetKey(t, s, "oc_sk_x")

        // arm a manager whose jailed provisioning STALLS (the START mutex is
        // held by the install — exactly the window the status route +
        // /api/models must survive)
        m := ocserve.New(t.TempDir(), "oc_sk_x", func(string, ...any) {})
        m.SetTermux(br)
        s.ocServeMu.Lock()
        s.ocServe = m
        s.ocServeMu.Unlock()
        s.ocBridgeStartAttempt()

        ctx, cancel := context.WithTimeout(context.Background(), 20*time.Minute)
        defer cancel()
        br.stalled.Store(true)
        go func() {
                _ = s.ocServeManager(ctx) // stalls inside the provisioner
        }()

        // let the install goroutine get into the stalled command
        deadline := time.Now().Add(2 * time.Second)
        for time.Now().Before(deadline) && br.answers.Load() == 0 {
                time.Sleep(10 * time.Millisecond)
        }
        if br.answers.Load() == 0 {
                t.Fatalf("the install goroutine never reached the jailed exec")
        }

        // THE LAW: the status GET answers FAST while the install is in flight
        done := make(chan map[string]any, 1)
        go func() {
                done <- v1492BridgeGET(s)
        }()
        select {
        case out := <-done:
                if out["_code"] != nil || out["_decode"] != nil {
                        t.Fatalf("status route failed during install: %v", out)
                }
                if out["state"] != "installing" {
                        t.Fatalf("during an in-flight install the rung must be installing, got: %v", out)
                }
                if out["attempt"] == nil || out["attempt"].(float64) < 1 {
                        t.Fatalf("the attempt counter must ride: %v", out)
                }
        case <-time.After(2 * time.Second):
                t.Fatalf("THE NO-LONG-HOLD LAW BROKEN: the bridge status GET blocked >2s on an in-flight install (the provider screen starves)")
        }

        // AND the rest of the API surface stays live: /api/models answers fast
        // (the user's convicted symptom — the screen returned NO providers
        // because /api/models queued behind the blocked polls).
        start := time.Now()
        rec := httptest.NewRecorder()
        req := httptest.NewRequest(http.MethodGet, "/api/models", nil)
        s.handleModels(rec, req)
        if time.Since(start) > 3*time.Second {
                t.Fatalf("/api/models starved during the install window: %v", time.Since(start))
        }
        if rec.Code != 200 {
                t.Fatalf("/api/models must answer 200 during an install, got %d", rec.Code)
        }
        var mc map[string]json.RawMessage
        if err := json.Unmarshal(rec.Body.Bytes(), &mc); err != nil {
                t.Fatalf("/api/models decode: %v", err)
        }
        if _, ok := mc["groups"]; !ok {
                t.Fatalf("/api/models must answer the full catalog shape during an install")
        }
}

// TestV1551ProgressFieldsRide — the installing rung carries the LIVE
// progress snapshot from the manager (stage + bytes + total + percent) so
// the pill pings the download for real.
func TestV1551ProgressFieldsRide(t *testing.T) {
        t.Setenv("DOOMALAY_OPENCODE_SPAWNER", "termux")
        s := newTermuxTestServer(t, "http://127.0.0.1:1/badtoken")
        v1492SetKey(t, s, "oc_sk_x")

        // build a manager directly + arm the in-flight install truth
        m := ocserve.New(t.TempDir(), "oc_sk_x", func(string, ...any) {})
        s.ocServeMu.Lock()
        s.ocServe = m
        s.ocServeMu.Unlock()
        s.ocBridgeStartAttempt()
        m.SetProgressForTest("download", 38_010_880, 76_021_760) // exactly 50%

        out := v1492BridgeGET(s)
        if out["state"] != "installing" {
                t.Fatalf("installing rung: %v", out)
        }
        if out["stage"] != "download" {
                t.Fatalf("stage must ride: %v", out)
        }
        if out["progress_bytes"].(float64) != 38010880 {
                t.Fatalf("bytes: %v", out["progress_bytes"])
        }
        if out["progress_percent"].(float64) != 50 {
                t.Fatalf("percent: %v", out["progress_percent"])
        }
        // shape stability: the fields are ALWAYS present even when empty
        if out["progress_total"] == nil || out["attempt"] == nil {
                t.Fatalf("shape-stable fields must always ride: %v", out)
        }
}

// TestV1551PercentClamps — never claim done before the marker lands (99
// cap) and never show zero-onwards (1 floor once bytes exist).
func TestV1551PercentClamps(t *testing.T) {
        t.Setenv("DOOMALAY_OPENCODE_SPAWNER", "termux")
        s := newTermuxTestServer(t, "http://127.0.0.1:1/badtoken")
        v1492SetKey(t, s, "oc_sk_x")

        m := ocserve.New(t.TempDir(), "oc_sk_x", func(string, ...any) {})
        s.ocServeMu.Lock()
        s.ocServe = m
        s.ocServeMu.Unlock()
        s.ocBridgeStartAttempt()

        // bytes beyond the total → clamped at 99 (never claims done)
        m.SetProgressForTest("download", 80_000_000, 76_021_760)
        out := v1492BridgeGET(s)
        if out["progress_percent"].(float64) != 99 {
                t.Fatalf("over-total must clamp at 99: %v", out["progress_percent"])
        }
        // a byte count with a zero total → no percent yet (honest nothing)
        m.SetProgressForTest("download", 5_000, 0)
        out = v1492BridgeGET(s)
        if out["progress_percent"].(float64) != 0 {
                t.Fatalf("no total → no percent: %v", out["progress_percent"])
        }
}
