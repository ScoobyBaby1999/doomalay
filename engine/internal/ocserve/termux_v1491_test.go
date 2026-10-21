package ocserve

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"os"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/ScoobyBaby1999/doomalay/engine/internal/termuxbridge"
)

// v1.49.1 THE GUEST ROOM pins — the pocket-bridge provisioner's command
// shapes, the two honest gates, the artifact pin, the idempotence law, the
// reuse law, and the Manager's Android lifecycle. The fake client records
// every jailed command; the "spawn" behavior starts a REAL loopback serve so
// the health poll proves the full chain without a device (the phase-3 rig
// then drives the same code against a REAL exec'ing bridge + a REAL
// opencode binary).

// fakeTermux records every jailed command and answers from a scripted
// behavior: markers on the command substrings. spawn-port commands start a
// REAL listener on the requested port (the health-poll chain is real).
type fakeTermux struct {
	mu        sync.Mutex
	calls     []fakeCall
	status    termuxbridge.Status
	statusErr error
	// behavior: substring → stdout markers (evaluated in order)
	behaviors []fakeBehavior
	// when a command contains "--port <n>", start a real listener on n
	spawnRealServe bool
	// failNext makes the next Run answer the transport error
	failNextErr  error
	portsStarted map[int]net.Listener
}

type fakeCall struct {
	command string
	workdir string
	stdin   string
}

type fakeBehavior struct {
	substr string
	stdout string
}

func (f *fakeTermux) record(command, workdir, stdin string) {
	f.mu.Lock()
	f.calls = append(f.calls, fakeCall{command: command, workdir: workdir, stdin: stdin})
	f.mu.Unlock()
}

func (f *fakeTermux) Status(ctx context.Context) (*termuxbridge.Status, error) {
	f.mu.Lock()
	st, err := f.status, f.statusErr
	f.mu.Unlock()
	return &st, err
}

func (f *fakeTermux) Run(ctx context.Context, command, workdir string, timeoutMS int) (*termuxbridge.RunResult, error) {
	return f.exec(command, workdir, "")
}

func (f *fakeTermux) RunWithStdin(ctx context.Context, command, workdir string, timeoutMS int, stdin string) (*termuxbridge.RunResult, error) {
	return f.exec(command, workdir, stdin)
}

func (f *fakeTermux) exec(command, workdir, stdin string) (*termuxbridge.RunResult, error) {
	f.record(command, workdir, stdin)
	f.mu.Lock()
	err := f.failNextErr
	f.failNextErr = nil
	f.mu.Unlock()
	if err != nil {
		return nil, err
	}
	res := &termuxbridge.RunResult{Ok: true, ExitCode: 0}
	// scripted markers
	f.mu.Lock()
	for _, b := range f.behaviors {
		if strings.Contains(command, b.substr) {
			res.Stdout += b.stdout + "\n"
		}
	}
	f.mu.Unlock()
	// the spawn command: a real serve must come up for the health poll
	if f.spawnRealServe && strings.Contains(command, "serve --port ") {
		if m := regexp.MustCompile(`--port (\d+)`).FindStringSubmatch(command); m != nil {
			port, _ := strconv.Atoi(m[1])
			if l, lerr := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", port)); lerr == nil {
				f.mu.Lock()
				if f.portsStarted == nil {
					f.portsStarted = map[int]net.Listener{}
				}
				f.portsStarted[port] = l
				f.mu.Unlock()
				go http.Serve(l, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					w.WriteHeader(200)
				}))
			}
		}
		res.Stdout += "__dm_spawned__\n"
	}
	return res, nil
}

func (f *fakeTermux) closePorts() {
	f.mu.Lock()
	for _, l := range f.portsStarted {
		l.Close()
	}
	f.portsStarted = nil
	f.mu.Unlock()
}

func (f *fakeTermux) commands() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]string, 0, len(f.calls))
	for _, c := range f.calls {
		out = append(out, c.command)
	}
	return out
}

func (f *fakeTermux) find(substr string) *fakeCall {
	f.mu.Lock()
	defer f.mu.Unlock()
	for i := range f.calls {
		if strings.Contains(f.calls[i].command, substr) {
			return &f.calls[i]
		}
	}
	return nil
}

// readyFake is the two-gates-passed fake (installed + bootstrapped).
func readyFake() *fakeTermux {
	return &fakeTermux{status: termuxbridge.Status{Installed: true, Permission: true}}
}

// TestV1491CommandShapes byte-pins every jailed command the provisioner
// drives — the URLs, the $HOME-relative layout, the markers, the nohup/pid/
// port law, the wake-lock pair, and the 127.0.0.1 bind (never 0.0.0.0 — the
// serve must not leak off-device).
func TestV1491CommandShapes(t *testing.T) {
	if got, want := tmCmdMkdirs(),
		`mkdir -p $HOME/.doomalay/opencode $HOME/.doomalay/opencode-serve $HOME/.doomalay/cache && echo __dm_ok__`; got != want {
		t.Fatalf("mkdirs:\n got %q\nwant %q", got, want)
	}
	if got, want := tmCmdInstallCheck(),
		`test -x $HOME/.doomalay/opencode/opencode && test -f $HOME/.doomalay/opencode-serve/opencode.json && echo __dm_installed__ || echo __dm_missing__`; got != want {
		t.Fatalf("install check:\n got %q\nwant %q", got, want)
	}
	url, _ := androidArtifact()
	if got, want := tmCmdDownload(url),
		`curl -fL --retry 3 --connect-timeout 20 -o $HOME/.doomalay/cache/opencode-android.zip '`+androidZipURLDefault+`' && echo __dm_dl_ok__`; got != want {
		t.Fatalf("download:\n got %q\nwant %q", got, want)
	}
	if got, want := tmCmdShaCheck(androidZipSHADefault),
		`printf '%s  %s\n' '`+androidZipSHADefault+`' $HOME/.doomalay/cache/opencode-android.zip | sha256sum -c - >/dev/null 2>&1 && echo __dm_sha_ok__ || echo __dm_sha_bad__`; got != want {
		t.Fatalf("sha check:\n got %q\nwant %q", got, want)
	}
	if !strings.Contains(tmCmdUnzip(), `unzip -o $HOME/.doomalay/cache/opencode-android.zip -d $HOME/.doomalay/opencode/`) {
		t.Fatalf("unzip: %q", tmCmdUnzip())
	}
	if !strings.Contains(tmCmdUnzip(), `busybox unzip`) {
		t.Fatalf("unzip must carry the busybox belt: %q", tmCmdUnzip())
	}
	spawn := tmCmdSpawn(41234)
	for _, must := range []string{
		`cd "$HOME/.doomalay/opencode-serve" &&`, // THE RAW-WORKDIR LAW: the bridge passes workdir unexpanded — the command cd's itself
		`termux-wake-lock`,
		`. $HOME/.doomalay/opencode-serve/key.env`,
		`nohup $HOME/.doomalay/opencode/opencode serve --port 41234 --hostname 127.0.0.1 > $HOME/.doomalay/opencode-serve/serve.log 2>&1 &`,
		`echo $! > $HOME/.doomalay/opencode-serve/serve.pid`,
		`echo 41234 > $HOME/.doomalay/opencode-serve/bridge.port`,
	} {
		if !strings.Contains(spawn, must) {
			t.Fatalf("spawn is missing %q:\n%s", must, spawn)
		}
	}
	if strings.Contains(spawn, "0.0.0.0") {
		t.Fatalf("the spawn must bind 127.0.0.1 only (never 0.0.0.0): %s", spawn)
	}
	kill := tmCmdKill()
	for _, must := range []string{`serve.pid`, `termux-wake-unlock`} {
		if !strings.Contains(kill, must) {
			t.Fatalf("kill is missing %q: %s", must, kill)
		}
	}
}

// TestV1491ArtifactPins — the pinned v0.2.1 artifact + the env override law
// (both URL and SHA move together; a SHA must be 64 hex).
func TestV1491ArtifactPins(t *testing.T) {
	url, sha := androidArtifact()
	if url != androidZipURLDefault || sha != androidZipSHADefault {
		t.Fatalf("default artifact drifted: %s %s", url, sha)
	}
	if len(sha) != 64 || !regexp.MustCompile(`^[0-9a-f]{64}$`).MatchString(sha) {
		t.Fatalf("the pinned SHA is not 64-hex: %q", sha)
	}
	t.Setenv("DOOMALAY_OPENCODE_ANDROID_ZIP", "https://example.test/oc.zip")
	t.Setenv("DOOMALAY_OPENCODE_ANDROID_SHA256", strings.Repeat("ab", 32))
	url, sha = androidArtifact()
	if url != "https://example.test/oc.zip" || sha != strings.Repeat("ab", 32) {
		t.Fatalf("env override ignored: %s %s", url, sha)
	}
	// a partial override keeps the pinned twin (URL moves alone → the pin
	// stays under it; both must be re-pinned together in practice)
	t.Setenv("DOOMALAY_OPENCODE_ANDROID_ZIP", "https://example.test/oc2.zip")
	os.Unsetenv("DOOMALAY_OPENCODE_ANDROID_SHA256")
	url, sha = androidArtifact()
	if url != "https://example.test/oc2.zip" || sha != androidZipSHADefault {
		t.Fatalf("partial override: %s %s", url, sha)
	}
}

// TestV1491SpawnerKind — the env dominates; auto routes Android to the
// guest room and leaves every other platform on the v1.48.5 desktop law.
func TestV1491SpawnerKind(t *testing.T) {
	t.Setenv("DOOMALAY_OPENCODE_SPAWNER", "termux")
	if spawnerKindFor() != spawnerTermux {
		t.Fatalf("termux override ignored")
	}
	t.Setenv("DOOMALAY_OPENCODE_SPAWNER", "exec")
	if spawnerKindFor() != spawnerExec {
		t.Fatalf("exec override ignored")
	}
	os.Unsetenv("DOOMALAY_OPENCODE_SPAWNER")
	// the auto law: android → termux; this test binary is not android, so
	// auto must answer exec HERE (the android arm is exercised by the
	// GOOS=android cross-build + the rig).
	if spawnerKindFor() != spawnerExec {
		t.Fatalf("auto on non-android must stay on the desktop exec law")
	}
}

// TestV1491EnsureLadder — the two honest gates, the full install ORDER,
// the idempotence short-circuit, and every failure rung's honest error.
func TestV1491EnsureLadder(t *testing.T) {
	ctx := context.Background()
	logf := func(string, ...any) {}

	// gate 1: Termux missing
	f := readyFake()
	f.status.Installed = false
	p := &termuxProvisioner{client: f, apiKey: "oc_sk_test", logf: logf}
	if err := p.Ensure(ctx); err != ErrTermuxMissing {
		t.Fatalf("missing-Termux rung: got %v", err)
	}

	// gate 2: not bootstrapped
	f = readyFake()
	f.status.Permission = false
	p = &termuxProvisioner{client: f, apiKey: "oc_sk_test", logf: logf}
	if err := p.Ensure(ctx); err != ErrNotBootstrapped {
		t.Fatalf("not-bootstrapped rung: got %v", err)
	}

	// the bridge itself unreachable
	f = readyFake()
	f.statusErr = fmt.Errorf("connection refused")
	p = &termuxProvisioner{client: f, apiKey: "oc_sk_test", logf: logf}
	if err := p.Ensure(ctx); err == nil || !strings.Contains(err.Error(), "termux bridge unreachable") {
		t.Fatalf("bridge-unreachable rung: got %v", err)
	}

	// the full ladder — the ORDER is the contract (status → check →
	// mkdirs → deps → download → sha → unzip → config → key)
	f = readyFake()
	f.behaviors = []fakeBehavior{
		{substr: "test -x $HOME/.doomalay/opencode/opencode", stdout: "__dm_missing__"},
		{substr: "mkdir -p", stdout: "__dm_ok__"},
		{substr: "command -v unzip", stdout: "__dm_deps_ok__"},
		{substr: "curl -fL", stdout: "__dm_dl_ok__"},
		{substr: "sha256sum -c", stdout: "__dm_sha_ok__"},
		{substr: "chmod +x", stdout: "__dm_unzip_ok__"},
	}
	p = &termuxProvisioner{client: f, apiKey: "oc_sk_test_key_123", logf: logf}
	if err := p.Ensure(ctx); err != nil {
		t.Fatalf("full install failed: %v", err)
	}
	cmds := f.commands()
	order := []string{"__probe_status__", "test -x $HOME/.doomalay/opencode/opencode", "mkdir -p", "command -v unzip", "curl -fL", "sha256sum -c", "chmod +x", "cat > $HOME/.doomalay/opencode-serve/opencode.json", "cat > $HOME/.doomalay/opencode-serve/key.env"}
	last := -1
	for _, probe := range order[1:] { // the status call is not a command
		idx := -1
		for i, c := range cmds {
			if strings.Contains(c, probe) && i > last {
				idx = i
				break
			}
		}
		if idx < 0 {
			t.Fatalf("install order: %q never ran (commands: %v)", probe, cmds)
		}
		if idx < last {
			t.Fatalf("install order broke at %q", probe)
		}
		last = idx
	}
	// the config write carries the gate-law bytes; the key write carries the
	// key as the 0600 env file, NEVER in the command line
	cfgCall := f.find("cat > $HOME/.doomalay/opencode-serve/opencode.json")
	if cfgCall == nil || cfgCall.stdin != permissionConfig {
		t.Fatalf("the config write must carry the gate-law bytes verbatim")
	}
	keyCall := f.find("umask 077")
	if keyCall == nil || keyCall.stdin != "OPENCODE_API_KEY=oc_sk_test_key_123\n" {
		t.Fatalf("the key env file law: %+v", keyCall)
	}
	for _, c := range f.calls {
		if strings.Contains(c.command, "oc_sk_test_key_123") {
			t.Fatalf("THE KEY RODE A COMMAND LINE (ps-leak): %s", c.command)
		}
	}

	// the sha rung fails honestly
	f = readyFake()
	f.behaviors = []fakeBehavior{
		{substr: "test -x $HOME/.doomalay/opencode/opencode", stdout: "__dm_missing__"},
		{substr: "command -v unzip", stdout: "__dm_deps_ok__"},
		{substr: "curl -fL", stdout: "__dm_dl_ok__"},
		{substr: "sha256sum -c", stdout: "__dm_sha_bad__"},
	}
	p = &termuxProvisioner{client: f, apiKey: "k", logf: logf}
	if err := p.Ensure(ctx); err == nil || !strings.Contains(err.Error(), "SHA256") {
		t.Fatalf("sha-bad rung: got %v", err)
	}

	// deps missing (unzip unavailable) fails honestly BEFORE the download
	f = readyFake()
	f.behaviors = []fakeBehavior{
		{substr: "test -x $HOME/.doomalay/opencode/opencode", stdout: "__dm_missing__"},
		{substr: "command -v unzip", stdout: "__dm_deps_missing__"},
	}
	p = &termuxProvisioner{client: f, apiKey: "k", logf: logf}
	if err := p.Ensure(ctx); err == nil || !strings.Contains(err.Error(), "unzip is unavailable") {
		t.Fatalf("deps-missing rung: got %v", err)
	}

	// idempotence: an installed marker short-circuits (no download)
	f = readyFake()
	f.behaviors = []fakeBehavior{
		{substr: "test -x $HOME/.doomalay/opencode/opencode", stdout: "__dm_installed__"},
	}
	p = &termuxProvisioner{client: f, apiKey: "k", logf: logf}
	if err := p.Ensure(ctx); err != nil {
		t.Fatalf("installed short-circuit failed: %v", err)
	}
	if f.find("curl -fL") != nil {
		t.Fatalf("an installed bridge must not re-download")
	}
}

// TestV1491LaunchReuseAndSpawn — the reuse law (a live recorded serve is
// adopted, never stacked), the stale law (a dead recorded pid is killed),
// and the real health-poll chain on a fresh spawn.
func TestV1491LaunchReuseAndSpawn(t *testing.T) {
	ctx := context.Background()
	defer func() { androidServeBootWait = 45 * time.Second; androidHealthInterval = 500 * time.Millisecond }()
	androidHealthInterval = 30 * time.Millisecond

	// a REAL serve at some port, recorded in bridge.port → reuse, no spawn
	live, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Skipf("no loopback: %v", err)
	}
	defer live.Close()
	go http.Serve(live, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(200) }))
	livePort := live.Addr().(*net.TCPAddr).Port

	f := readyFake()
	f.spawnRealServe = true
	f.behaviors = []fakeBehavior{
		{substr: "test -x $HOME/.doomalay/opencode/opencode", stdout: "__dm_installed__"},
		{substr: "cat $HOME/.doomalay/opencode-serve/bridge.port", stdout: strconv.Itoa(livePort)},
	}
	p := &termuxProvisioner{client: f, apiKey: "k", logf: func(string, ...any) {}}
	got, err := p.Launch(ctx, 41234)
	if err != nil {
		t.Fatalf("reuse launch failed: %v", err)
	}
	if got != livePort {
		t.Fatalf("reuse must answer the recorded live port %d, got %d", livePort, got)
	}
	if f.find("serve --port") != nil {
		t.Fatalf("a live recorded serve must be ADOPTED, never stacked with a second spawn")
	}

	// stale: the recorded port is dead → kill the stale pid + fresh spawn
	// (the fake bridge really listens on the requested port → the health
	// poll proves the whole chain)
	f2 := readyFake()
	f2.spawnRealServe = true
	f2.behaviors = []fakeBehavior{
		{substr: "test -x $HOME/.doomalay/opencode/opencode", stdout: "__dm_installed__"},
		{substr: "cat $HOME/.doomalay/opencode-serve/bridge.port", stdout: "41919"},
	}
	defer f2.closePorts()
	p2 := &termuxProvisioner{client: f2, apiKey: "k", logf: func(string, ...any) {}}
	got, err = p2.Launch(ctx, 41234)
	if err != nil {
		t.Fatalf("fresh spawn launch failed: %v", err)
	}
	if got != 41234 {
		t.Fatalf("fresh spawn must answer the requested port, got %d", got)
	}
	if f2.find("serve.pid") == nil || f2.find("termux-wake-unlock") == nil {
		t.Fatalf("a stale pid must be killed (pid-file + wake-unlock) before a fresh spawn")
	}

	// spawn without a listener → the honest boot-failure detail
	androidServeBootWait = 300 * time.Millisecond
	f3 := readyFake()
	f3.behaviors = []fakeBehavior{
		{substr: "test -x $HOME/.doomalay/opencode/opencode", stdout: "__dm_installed__"},
		{substr: "tail -n 20", stdout: "some crash line"},
	}
	p3 := &termuxProvisioner{client: f3, apiKey: "k", logf: func(string, ...any) {}}
	_, err = p3.Launch(ctx, 41235)
	if err == nil || !strings.Contains(err.Error(), "did not become healthy") {
		t.Fatalf("boot-failure rung: got %v", err)
	}
	if !strings.Contains(err.Error(), "some crash line") {
		t.Fatalf("the boot failure must carry serve.log's tail honestly: %v", err)
	}
}

// TestV1491ManagerTermuxLifecycle — the Manager's Android arm end-to-end:
// Start provisions through the fake bridge (which really listens), the
// base URL is set, Healthy() is real, and Stop drives the kill command.
func TestV1491ManagerTermuxLifecycle(t *testing.T) {
	defer func() { androidServeBootWait = 45 * time.Second; androidHealthInterval = 500 * time.Millisecond }()
	androidHealthInterval = 30 * time.Millisecond

	f := readyFake()
	f.spawnRealServe = true
	f.behaviors = []fakeBehavior{
		{substr: "test -x $HOME/.doomalay/opencode/opencode", stdout: "__dm_installed__"},
	}
	defer f.closePorts()

	t.Setenv("DOOMALAY_OPENCODE_SPAWNER", "termux")
	m := New(t.TempDir(), "oc_sk_live", func(format string, args ...any) {})
	m.SetTermux(f)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	if err := m.Start(ctx); err != nil {
		t.Fatalf("Start through the guest room failed: %v", err)
	}
	if !m.Healthy() {
		t.Fatalf("the pocket bridge must be healthy after Start")
	}
	base := func() string {
		m.mu.Lock()
		defer m.mu.Unlock()
		return m.baseURL
	}()
	if !strings.HasPrefix(base, "http://127.0.0.1:") {
		t.Fatalf("the base URL must be the shared loopback: %q", base)
	}
	if f.find("serve.pid") == nil {
		t.Fatalf("the spawn must record its pid")
	}
	m.Stop()
	if f.find("termux-wake-unlock") == nil {
		t.Fatalf("Stop must kill the serve + free the wake-lock through the jailed exec")
	}
	if m.Healthy() {
		t.Fatalf("Stop must leave the bridge unhealthy (the fake listener died with the kill…)")
	}
	// NOTE: the fake's listener is NOT actually killed by the recorded
	// command (the fake does not execute) — the Healthy check below the
	// Stop is only about the Manager's own state, so assert THAT instead:
	m.mu.Lock()
	stopped := m.stopped
	m.mu.Unlock()
	if !stopped {
		t.Fatalf("Stop must arm the stopped latch")
	}
}

// TestV1491StartErrorsWithoutTermux — the honest unavailable copy when the
// engine has no Termux bridge configured (desktop builds, un-configured
// APKs).
func TestV1491StartErrorsWithoutTermux(t *testing.T) {
	t.Setenv("DOOMALAY_OPENCODE_SPAWNER", "termux")
	m := New(t.TempDir(), "k", func(string, ...any) {})
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	err := m.Start(ctx)
	if err == nil || !strings.Contains(err.Error(), "not available on this device") {
		t.Fatalf("the no-bridge rung must answer the honest unavailable copy, got %v", err)
	}
}
