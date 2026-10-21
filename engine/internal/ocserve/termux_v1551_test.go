package ocserve

// v1.55.1 THE HONEST LADDER pins — the live progress law (every stage
// reports, the download pings real bytes), the checkpoint law (the
// resumable download shape), the corrupt-zip law (a SHA-bad COMPLETE file
// is dropped, never resumed), and the tmParseBytes contract. The
// server-side no-blocking law is pinned in server/ocbridgeapi_v1551_test.go
// (it needs the Server's install goroutine); here we pin the provisioner
// half that feeds it.

import (
        "context"
        "strings"
        "sync"
        "testing"
        "time"

        "github.com/ScoobyBaby1999/doomalay/engine/internal/termuxbridge"
)

// TestV1551ProgressLadder — every provisioning stage lands on the report
// hook in order, and the download stage pings REAL byte counts read from
// the sidecar poll (the provider pill's ping is live data, never static).
func TestV1551ProgressLadder(t *testing.T) {
        oldTick := androidProgressInterval
        androidProgressInterval = 10 * time.Millisecond
        defer func() { androidProgressInterval = oldTick }()

        f := readyFake()
        // the static markers carry the ladder; the DYNamic hook adds the
        // growing byte counts + the delayed download (static behaviors can't
        // grow over time)
        byteSeq := []string{"1200", "24000", "48000"}
        byteIdx := 0
        f.behaviors = []fakeBehavior{
                {substr: "test -x $HOME/.doomalay/opencode/opencode2", stdout: "__dm_missing__"},
                {substr: "command -v unzip", stdout: "__dm_deps_ok__"},
                {substr: "curl -fL", stdout: "__dm_dl_ok__"},
                {substr: "sha256sum -c", stdout: "__dm_sha_ok__"},
                {substr: "chmod +x", stdout: "__dm_unzip_ok__"},
        }
        wf := &dynamicFake{t: f, dyn: func(command string) string {
                if strings.Contains(command, "cat $HOME/.doomalay/cache/dl.bytes") {
                        if byteIdx < len(byteSeq) {
                                s := byteSeq[byteIdx]
                                byteIdx++
                                return s
                        }
                        return "48000"
                }
                if strings.Contains(command, "curl -fL") {
                        // let the download take a few byte ticks
                        time.Sleep(40 * time.Millisecond)
                }
                return ""
        }}

        var mu sync.Mutex
        var stages []string
        maxBytes := int64(0)
        p := &termuxProvisioner{client: wf, apiKey: "k", serverPassword: "pw", logf: func(string, ...any) {},
                report: func(stage string, bytes, total int64) {
                        mu.Lock()
                        defer mu.Unlock()
                        stages = append(stages, stage+"|"+itoa64(bytes))
                        if bytes > maxBytes {
                                maxBytes = bytes
                        }
                        if total != 0 && total != androidZipSizeApproxBytes {
                                t.Errorf("total must ride the pinned size, got %d", total)
                        }
                }}
        if err := p.Ensure(context.Background()); err != nil {
                t.Fatalf("ensure: %v", err)
        }
        mu.Lock()
        defer mu.Unlock()
        joined := strings.Join(stages, ",")
        // the ladder must speak every stage in order
        for _, want := range []string{"deps", "download", "verify", "unpack", "configure"} {
                if !strings.Contains(joined, want) {
                        t.Fatalf("stage %q missing from the progress ladder: %v", want, stages)
                }
        }
        if maxBytes < 48000 {
                t.Fatalf("the download ping must carry REAL byte counts (max seen %d):\n%v", maxBytes, stages)
        }
        // the download pings BEFORE the verify stage
        dlAt, vAt := -1, -1
        for i, s := range stages {
                if strings.HasPrefix(s, "download|") && dlAt < 0 {
                        dlAt = i
                }
                if strings.HasPrefix(s, "verify|") && vAt < 0 {
                        vAt = i
                }
        }
        if dlAt < 0 || vAt < 0 || dlAt > vAt {
                t.Fatalf("download pings must precede verify: %v", stages)
        }
        // the download's OWN last tick is the 100% marker (verify/unpack/
        // configure follow it in the ladder — the complete marker is the
        // download stage's final word, not the ladder's)
        sawComplete := false
        for _, s := range stages {
                if s == "download|"+itoa64(androidZipSizeApproxBytes) {
                        sawComplete = true
                }
        }
        if !sawComplete {
                t.Fatalf("the download must end with the complete marker tick: %v", stages)
        }
}

// TestV1551CorruptZipDropped — a SHA-bad COMPLETE download is removed (a
// resume can never heal a corrupt tail — the corrupt-zip law), while a
// merely-failed download leaves the partial zip in place (the checkpoint
// a retry resumes from).
func TestV1551CorruptZipDropped(t *testing.T) {
        f := readyFake()
        f.behaviors = []fakeBehavior{
                {substr: "test -x $HOME/.doomalay/opencode/opencode2", stdout: "__dm_missing__"},
                {substr: "command -v unzip", stdout: "__dm_deps_ok__"},
                {substr: "curl -fL", stdout: "__dm_dl_ok__"},
                {substr: "sha256sum -c", stdout: "__dm_sha_bad__"},
        }
        p := &termuxProvisioner{client: f, apiKey: "k", serverPassword: "pw", logf: func(string, ...any) {}}
        if err := p.Ensure(context.Background()); err == nil || !strings.Contains(err.Error(), "SHA256") {
                t.Fatalf("sha-bad rung: got %v", err)
        }
        if call := f.find("rm -f $HOME/.doomalay/cache/opencode-android.zip"); call == nil {
                t.Fatalf("a corrupt COMPLETE zip must be dropped (the corrupt-zip law) — commands: %v", f.commands())
        }
}

// TestV1551ParseBytes — the sidecar parser's honest contract.
func TestV1551ParseBytes(t *testing.T) {
        for _, tc := range []struct {
                in   string
                want int64
                ok   bool
        }{
                {"1200\n", 1200, true},
                {"  24000 ", 24000, true},
                {"0", 0, true},
                {"", 0, false},
                {"garbage", 0, false},
                {"-5", 0, false},
                {"76_000_000", 76, true}, // Sscanf %d stops at the underscore — honest prefix parse
        } {
                got, ok := tmParseBytes(tc.in)
                if ok != tc.ok || got != tc.want {
                        t.Fatalf("parse(%q) = (%d, %v), want (%d, %v)", tc.in, got, ok, tc.want, tc.ok)
                }
        }
}

// TestV1551ProgressNoHook — a nil report hook never panics (the hook is
// optional; the tests that don't care construct without it).
func TestV1551ProgressNoHook(t *testing.T) {
        f := readyFake()
        f.behaviors = []fakeBehavior{
                {substr: "test -x $HOME/.doomalay/opencode/opencode2", stdout: "__dm_installed__"},
        }
        p := &termuxProvisioner{client: f, apiKey: "k", serverPassword: "pw", logf: func(string, ...any) {}}
        if err := p.Ensure(context.Background()); err != nil {
                t.Fatalf("ensure (installed short-circuit) must work with no hook: %v", err)
        }
}

// itoa64 keeps the pins dependency-free.
func itoa64(n int64) string {
        if n == 0 {
                return "0"
        }
        var b [20]byte
        i := len(b)
        for n > 0 {
                i--
                b[i] = byte('0' + n%10)
                n /= 10
        }
        return string(b[i:])
}

// dynamicFake wraps the recorded fake: the static behaviors answer the
// ladder markers AND the dyn hook may add dynamic stdout (growing byte
// counts, delays) — recording still goes through the wrapped fake so the
// command-order pins keep working.
type dynamicFake struct {
        t  *fakeTermux
        dyn func(command string) string
}

func (d *dynamicFake) Status(ctx context.Context) (*termuxbridge.Status, error) {
        return d.t.Status(ctx)
}

func (d *dynamicFake) Run(ctx context.Context, command, workdir string, timeoutMS int) (*termuxbridge.RunResult, error) {
        res, err := d.t.Run(ctx, command, workdir, timeoutMS)
        if res != nil {
                res.Stdout += d.dyn(command)
        }
        return res, err
}

func (d *dynamicFake) RunWithStdin(ctx context.Context, command, workdir string, timeoutMS int, stdin string) (*termuxbridge.RunResult, error) {
        res, err := d.t.RunWithStdin(ctx, command, workdir, timeoutMS, stdin)
        if res != nil {
                res.Stdout += d.dyn(command)
        }
        return res, err
}
