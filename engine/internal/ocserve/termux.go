package ocserve

// v1.49.1 THE GUEST ROOM (PLAN-V149 THE POCKET BRIDGE) — the Android
// spawner. The user's ask: "We can run opencode directly on termux … we
// want the opencode provider to work with as few gates as possible."
//
// The researched truth this file is built on (live from the sandbox,
// 2026-10-21+):
//
//   - The official opencode CLI has NO Android build (anomalyco/opencode
//     #10504/#12515/#21043 — the linux-aarch64 release is glibc +
//     non-PIE, bionic can't load it; upstream closed Android as "not
//     planned"). The desktop law (v1.48.5: glibc 186MB) is the same truth.
//   - guysoft/opencode-termux (291★, 30 releases, active Oct 2026) builds
//     OpenCode NATIVELY for Android/Termux aarch64: Bun patched for
//     Android seccomp/bionic, WebKit/JSC ported, Zig sigaction fixed —
//     "all backend services (server, provider, LSP) [working]".
//   - THE PIN: v0.2.1 "OpenCode 1.17.9 Android/Termux" (Jun 25 2026, the
//     latest STABLE of the v1 line) — opencode-1.17.9-android-aarch64.zip,
//     52.0MB, SHA256 0c77d4b8… verified in-sandbox. The zip is FLAT:
//     `opencode` (a POSIX wrapper that LD_PRELOADs libtagfix, sets
//     LD_LIBRARY_PATH/OPENTUI_LIB_PATH, disables the x86 filewatcher, then
//     `exec`s opencode.bin) + opencode.bin + three native libs. Unzip →
//     run. 1.17.9 speaks the SAME serve API family as the pinned desktop
//     1.19.3 (POST /session, prompt_async, GET /event SSE,
//     /session/status) — the ocserve client is byte-compatible.
//   - The app ALREADY owns the gates: termux/setup.sh (the one-line
//     bootstrap → allow-external-apps = the jailed RUN_COMMAND path) +
//     the Kotlin loopback bridge (/status, /run, RunWithStdin's
//     zero-escaping stdin law, 30-min budget). Loopback is SHARED between
//     apps on Android (the checkin already rides Termux→APK; APK→Termux
//     is the same interface) — the engine probes a free port, Termux
//     binds it, the engine connects.
//
// THE GATES (the minimum Android allows — the user's own law: "if we
// require termux … so be it"): (1) Termux installed, (2) the one-line
// bootstrap, (3) a tap — the ENGINE drives everything else through the
// jailed exec: download (SHA-verified) → unzip → gate-law config →
// wake-lock → nohup spawn → health poll → SetBaseURL. Termux must stay
// alive while chatting (the wake-lock + the honest card status); a
// phantom-killed Termux answers honestly, never a hang.

import (
	"context"
	"errors"
	"fmt"
	"os"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"time"

	"github.com/ScoobyBaby1999/doomalay/engine/internal/termuxbridge"
)

// TermuxClient is the narrow slice of the Kotlin bridge contract the
// provisioner needs. *termuxbridge.Client satisfies it structurally; the
// tests drive a fake (no device needed for the unit pins).
type TermuxClient interface {
	Status(ctx context.Context) (*termuxbridge.Status, error)
	Run(ctx context.Context, command, workdir string, timeoutMS int) (*termuxbridge.RunResult, error)
	RunWithStdin(ctx context.Context, command, workdir string, timeoutMS int, stdin string) (*termuxbridge.RunResult, error)
}

// The pinned Android artifact (THE PIN LAW — the gate "actively evolves";
// a pinned, community-proven release is the stable contract, the same law
// as the desktop 1.19.3 pin). Env overrides move it without a release.
const (
	androidZipURLDefault = "https://github.com/guysoft/opencode-termux/releases/download/v0.2.1/opencode-1.17.9-android-aarch64.zip"
	androidZipSHADefault = "0c77d4b8f286e01ba08c9e9aeca8c73a0e0c655342044ab3a59cf1953093a9b0"
	androidClientVersion = "1.17.9 (opencode-termux v0.2.1 — the native Android/Termux build)"
	androidZipSizeHint   = "52MB"
)

// var (not const) so the tests can shorten the waits without touching the
// production values.
var (
	androidServeBootWait  = 45 * time.Second
	androidHealthInterval = 500 * time.Millisecond
)

// ErrTermuxMissing: the first gate is absent — Termux isn't installed.
var ErrTermuxMissing = errors.New("the OpenCode bridge on Android needs Termux — install Termux from F-Droid (the app's Termux screen has the link), then come back and tap Install OpenCode")

// ErrNotBootstrapped: the second gate — Termux exists but the one-line
// Doomalay bootstrap (allow-external-apps) hasn't run, so the jailed
// command path is closed.
var ErrNotBootstrapped = errors.New("Termux is installed but the Doomalay setup line hasn't run in it yet — paste the setup line in Termux once (it opens the command path), then tap Install OpenCode again")

// androidArtifact answers the (url, sha) the provisioner downloads — the
// pinned defaults, overridable by DOOMALAY_OPENCODE_ANDROID_ZIP /
// DOOMALAY_OPENCODE_ANDROID_SHA256 (the rigs + future bumps).
func androidArtifact() (url, sha string) {
	url = strings.TrimSpace(os.Getenv("DOOMALAY_OPENCODE_ANDROID_ZIP"))
	sha = strings.TrimSpace(os.Getenv("DOOMALAY_OPENCODE_ANDROID_SHA256"))
	if url == "" {
		url = androidZipURLDefault
	}
	if sha == "" {
		sha = androidZipSHADefault
	}
	return url, sha
}

// The in-Termux layout (ALWAYS $HOME-relative — never a hard-coded prefix;
// the Play/F-Droid layouts differ. The /run contract runs with Termux's
// own HOME in scope):
//
//	$HOME/.doomalay/opencode/            the unzipped client (opencode,
//	                                     opencode.bin, libtagfix.so, …)
//	$HOME/.doomalay/opencode-serve/      the serve CWD: the gate-law
//	                                     opencode.json, key.env (0600),
//	                                     serve.log, serve.pid, bridge.port
//	$HOME/.doomalay/cache/               the zip download
const (
	tmBinDir    = "$HOME/.doomalay/opencode"
	tmServeDir  = "$HOME/.doomalay/opencode-serve"
	tmCacheDir  = "$HOME/.doomalay/cache"
	tmZipPath   = "$HOME/.doomalay/cache/opencode-android.zip"
	tmServeJSON = "$HOME/.doomalay/opencode-serve/opencode.json"
	tmKeyEnv    = "$HOME/.doomalay/opencode-serve/key.env"
	tmServeLog  = "$HOME/.doomalay/opencode-serve/serve.log"
	tmServePid  = "$HOME/.doomalay/opencode-serve/serve.pid"
	tmPortFile  = "$HOME/.doomalay/opencode-serve/bridge.port"
)

// ── the command builders (each one a named pin — the tests byte-match) ──

func tmCmdMkdirs() string {
	return fmt.Sprintf("mkdir -p %s %s %s && echo __dm_ok__", tmBinDir, tmServeDir, tmCacheDir)
}

func tmCmdInstallCheck() string {
	return fmt.Sprintf("test -x %s/opencode && test -f %s && echo __dm_installed__ || echo __dm_missing__",
		tmBinDir, tmServeJSON)
}

// deps: unzip is REQUIRED (the extraction); ripgrep is BEST-EFFORT (the
// model's grep tool degrades honestly when absent). pkg is Termux's own
// non-interactive installer — the v1.35.1 pending-ledger already drove pkg
// steps through this exact jailed path in production.
func tmCmdDeps() string {
	return `command -v unzip >/dev/null 2>&1 || pkg install -y unzip >/dev/null 2>&1; ` +
		`command -v unzip >/dev/null 2>&1 && echo __dm_deps_ok__ || echo __dm_deps_missing__; ` +
		`command -v rg >/dev/null 2>&1 || pkg install -y ripgrep >/dev/null 2>&1; true`
}

func tmCmdDownload(url string) string {
	return fmt.Sprintf("curl -fL --retry 3 --connect-timeout 20 -o %s '%s' && echo __dm_dl_ok__",
		tmZipPath, url)
}

func tmCmdShaCheck(sha string) string {
	return fmt.Sprintf("printf '%%s  %%s\\n' '%s' %s | sha256sum -c - >/dev/null 2>&1 && echo __dm_sha_ok__ || echo __dm_sha_bad__",
		sha, tmZipPath)
}

func tmCmdUnzip() string {
	// busybox's unzip is Termux's built-in belt under a missing unzip pkg.
	return fmt.Sprintf("unzip -o %s -d %s/ >/dev/null 2>&1 || busybox unzip -o %s -d %s/ >/dev/null 2>&1; ", tmZipPath, tmBinDir, tmZipPath, tmBinDir) +
		fmt.Sprintf("chmod +x %s/opencode %s/opencode.bin && echo __dm_unzip_ok__", tmBinDir, tmBinDir)
}

func tmCmdWriteConfig() (command, stdin string) {
	return fmt.Sprintf("cat > %s", tmServeJSON), permissionConfig
}

func tmCmdWriteKey() (command, stdin string) {
	// the key rides stdin (the RunWithStdin zero-escaping law) as a 0600
	// env file — NEVER the command line (ps-safe). __KEY__ replaces via
	// strings.Replace (never Sprintf — a % in a key must not break it).
	return fmt.Sprintf("umask 077 && cat > %s", tmKeyEnv), "OPENCODE_API_KEY=__KEY__\n"
}

func tmKeyStdin(key string) string {
	cmd, stdin := tmCmdWriteKey()
	_ = cmd
	return strings.Replace(stdin, "__KEY__", key, 1)
}

func tmCmdPortProbe() string {
	return fmt.Sprintf("cat %s 2>/dev/null || true", tmPortFile)
}

// tmCmdSpawn: the wake-lock (Termux must outlive the Android phantom
// killer while serving), the key rides key.env (NEVER the command line —
// ps-safe, the RunWithStdin zero-escaping law wrote it 0600), nohup +
// `&` detach the serve from the jailed session (the wrapper `exec`s
// opencode.bin, so the captured $! stays the serve's real pid), and the
// pid + port land in their files for reuse/kill.
func tmCmdSpawn(port int) string {
	return fmt.Sprintf("termux-wake-lock 2>/dev/null; . %s; ", tmKeyEnv) +
		fmt.Sprintf("nohup %s/opencode serve --port %d --hostname 127.0.0.1 > %s 2>&1 & ", tmBinDir, port, tmServeLog) +
		fmt.Sprintf("echo $! > %s; echo %d > %s; echo __dm_spawned__", tmServePid, port, tmPortFile)
}

func tmCmdKill() string {
	return fmt.Sprintf("if [ -f %s ]; then kill \"$(cat %s)\" 2>/dev/null; fi; ", tmServePid, tmServePid) +
		"termux-wake-unlock 2>/dev/null; true"
}

func tmCmdServeLogTail() string {
	return fmt.Sprintf("tail -n 20 %s 2>/dev/null || true", tmServeLog)
}

// ── the provisioner ─────────────────────────────────────────────────────

// termuxProvisioner drives the guest room through the jailed exec: the
// status ladder, the idempotent install, the spawn, the reuse, the kill.
type termuxProvisioner struct {
	client TermuxClient
	apiKey string
	logf   func(format string, args ...any)
}

// run is one jailed command with the honest ladder: transport error →
// wrapped; non-zero exit → wrapped with the stderr tail.
func (p *termuxProvisioner) run(ctx context.Context, command, workdir string, timeoutMS int, stdin string) (*termuxbridge.RunResult, error) {
	var res *termuxbridge.RunResult
	var err error
	if stdin != "" {
		res, err = p.client.RunWithStdin(ctx, command, workdir, timeoutMS, stdin)
	} else {
		res, err = p.client.Run(ctx, command, workdir, timeoutMS)
	}
	if err != nil {
		return res, fmt.Errorf("termux bridge: %w", err)
	}
	if res == nil {
		return nil, errors.New("termux bridge: no result")
	}
	if res.ExitCode != 0 {
		return res, fmt.Errorf("termux command failed (exit %d): %s", res.ExitCode, tmTail(res.Stderr))
	}
	return res, nil
}

func tmTail(s string) string {
	s = strings.TrimSpace(s)
	if len(s) > 200 {
		s = s[len(s)-200:]
	}
	if s == "" {
		return "(no stderr)"
	}
	return s
}

// statusLadder walks the two gates honestly before any command runs.
func (p *termuxProvisioner) statusLadder(ctx context.Context) error {
	st, err := p.client.Status(ctx)
	if err != nil {
		return fmt.Errorf("termux bridge unreachable: %w", err)
	}
	if st == nil {
		return errors.New("termux bridge: no status")
	}
	if !st.Installed {
		return ErrTermuxMissing
	}
	if !st.Permission {
		return ErrNotBootstrapped
	}
	return nil
}

// installed answers the idempotence marker (the zip + config both present).
func (p *termuxProvisioner) installed(ctx context.Context) (bool, error) {
	res, err := p.run(ctx, tmCmdInstallCheck(), "", 15_000, "")
	if err != nil {
		return false, err
	}
	return strings.Contains(res.Stdout, "__dm_installed__"), nil
}

// Ensure installs the guest (idempotent — a re-run overwrites; a finished
// install short-circuits at the marker).
func (p *termuxProvisioner) Ensure(ctx context.Context) error {
	if err := p.statusLadder(ctx); err != nil {
		return err
	}
	if ok, err := p.installed(ctx); err == nil && ok {
		return nil
	}
	if _, err := p.run(ctx, tmCmdMkdirs(), "", 30_000, ""); err != nil {
		return err
	}
	res, err := p.run(ctx, tmCmdDeps(), "", 600_000, "")
	if err != nil {
		return err
	}
	if res != nil && strings.Contains(res.Stdout, "__dm_deps_missing__") {
		return errors.New("pocket bridge: unzip is unavailable in Termux (pkg install unzip failed — check the network and try again)")
	}
	url, sha := androidArtifact()
	p.logf("pocket bridge: downloading the native OpenCode client (%s)…", androidZipSizeHint)
	if _, err := p.run(ctx, tmCmdDownload(url), "", 900_000, ""); err != nil {
		return fmt.Errorf("pocket bridge: download failed: %w", err)
	}
	res, err = p.run(ctx, tmCmdShaCheck(sha), "", 120_000, "")
	if err != nil {
		return err
	}
	if res != nil && strings.Contains(res.Stdout, "__dm_sha_bad__") {
		return errors.New("pocket bridge: the downloaded OpenCode client failed its SHA256 check (the pinned build changed or the download was truncated) — try again")
	}
	if _, err := p.run(ctx, tmCmdUnzip(), "", 300_000, ""); err != nil {
		return fmt.Errorf("pocket bridge: extract failed: %w", err)
	}
	cmd, stdin := tmCmdWriteConfig()
	if _, err := p.run(ctx, cmd, "", 30_000, stdin); err != nil {
		return fmt.Errorf("pocket bridge: writing the permission config failed: %w", err)
	}
	kcmd, _ := tmCmdWriteKey()
	if _, err := p.run(ctx, kcmd, "", 30_000, tmKeyStdin(p.apiKey)); err != nil {
		return fmt.Errorf("pocket bridge: storing the OpenCode key failed: %w", err)
	}
	p.logf("pocket bridge: the native OpenCode client %s is installed", androidClientVersion)
	return nil
}

// Launch answers a LIVE serve base port: reuse a healthy recorded serve
// (an engine restart must not leak a second one), else kill the stale pid
// and spawn fresh on the given port, then health-poll FROM THE ENGINE (the
// shared loopback — the same interface the checkin already rides).
func (p *termuxProvisioner) Launch(ctx context.Context, port int) (int, error) {
	if err := p.Ensure(ctx); err != nil {
		return 0, err
	}
	// reuse: a recorded port that answers health is a serve we can use now
	if res, err := p.run(ctx, tmCmdPortProbe(), "", 15_000, ""); err == nil && res != nil {
		if old, ok := tmParsePort(res.Stdout); ok && healthyUp(fmt.Sprintf("http://127.0.0.1:%d", old)) {
			p.logf("pocket bridge: reusing the live serve on port %d", old)
			return old, nil
		}
	}
	// stale (or none): kill the recorded pid so a fresh spawn never stacks
	_, _ = p.run(ctx, tmCmdKill(), "", 15_000, "")
	if _, err := p.run(ctx, tmCmdSpawn(port), tmServeDir, 30_000, ""); err != nil {
		// the honest detail: serve.log's tail says why it wouldn't start
		if res, lerr := p.run(ctx, tmCmdServeLogTail(), "", 15_000, ""); lerr == nil && res != nil && strings.TrimSpace(res.Stdout) != "" {
			return 0, fmt.Errorf("pocket bridge: spawn failed: %v — serve.log: %s", err, tmTail(res.Stdout))
		}
		return 0, fmt.Errorf("pocket bridge: spawn failed: %w", err)
	}
	base := fmt.Sprintf("http://127.0.0.1:%d", port)
	deadline := time.Now().Add(androidServeBootWait)
	for time.Now().Before(deadline) {
		select {
		case <-ctx.Done():
			return 0, ctx.Err()
		default:
		}
		if healthyUp(base) {
			return port, nil
		}
		time.Sleep(androidHealthInterval)
	}
	// honest boot-failure detail before giving up
	if res, lerr := p.run(ctx, tmCmdServeLogTail(), "", 15_000, ""); lerr == nil && res != nil && strings.TrimSpace(res.Stdout) != "" {
		return 0, fmt.Errorf("pocket bridge: the serve did not become healthy in %s — serve.log: %s", androidServeBootWait, tmTail(res.Stdout))
	}
	return 0, fmt.Errorf("pocket bridge: the serve did not become healthy in %s", androidServeBootWait)
}

// Stop kills the serve + releases the wake-lock (engine shutdown —
// best-effort: a dead Termux answers the transport error, never a panic).
func (p *termuxProvisioner) Stop(ctx context.Context) {
	if p == nil || p.client == nil {
		return
	}
	cctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	_, _ = p.run(cctx, tmCmdKill(), "", 15_000, "")
}

var tmPortRe = regexp.MustCompile(`\b([1-9][0-9]{1,4})\b`)

func tmParsePort(s string) (int, bool) {
	m := tmPortRe.FindStringSubmatch(strings.TrimSpace(s))
	if m == nil {
		return 0, false
	}
	n, err := strconv.Atoi(m[1])
	if err != nil || n < 1024 || n > 65535 {
		return 0, false
	}
	return n, true
}

// ── the spawner law (ocserve.go's Start routes here on Android) ─────────

type spawnerKind int

const (
	spawnerAuto   spawnerKind = iota
	spawnerExec               // the v1.48.5 desktop law (exec-child, unchanged)
	spawnerTermux             // THE GUEST ROOM (the jailed-exec provisioner)
)

// spawnerKindFor answers which spawner builds the serve. The env override
// dominates (the rigs force the termux path on linux; a user can force the
// classic child); the default routes Android to the guest room and leaves
// every other platform on the desktop law.
func spawnerKindFor() spawnerKind {
	switch strings.TrimSpace(strings.ToLower(os.Getenv("DOOMALAY_OPENCODE_SPAWNER"))) {
	case "termux":
		return spawnerTermux
	case "exec":
		return spawnerExec
	}
	if runtime.GOOS == "android" {
		return spawnerTermux
	}
	return spawnerExec
}

// startViaTermux is Start's Android arm: the ladder → provisioner →
// SetBaseURL, then the health-poll watchdog (a died serve re-provisions
// through the jailed exec; a died TERMTUX answers honestly and the bridge
// turns unavailable until the user revives it).
func (m *Manager) startViaTermux(ctx context.Context) error {
	if m.termux == nil {
		return fmt.Errorf("%w (the Termux bridge is not configured on this device)", ErrUnavailable)
	}
	p := &termuxProvisioner{client: m.termux, apiKey: m.apiKey, logf: m.logf}
	port, err := freePort()
	if err != nil {
		return fmt.Errorf("ocserve: no free port for the pocket bridge: %w", err)
	}
	port, err = p.Launch(ctx, port)
	if err != nil {
		return err
	}
	m.mu.Lock()
	m.baseURL = fmt.Sprintf("http://127.0.0.1:%d", port)
	m.healthy = true
	m.tprov = p
	m.mu.Unlock()
	m.logf("ocserve: pocket bridge up on %s (the native %s through Termux)", m.baseURL, androidClientVersion)
	go m.watchdogTermux(p)
	return nil
}

// watchdogTermux re-provisions a died serve through the jailed exec —
// bounded like the desktop watchdog (4 lives per engine run), honest
// unavailable when Termux itself is gone.
func (m *Manager) watchdogTermux(p *termuxProvisioner) {
	misses := 0
	for {
		m.mu.Lock()
		stopped, base := m.stopped, m.baseURL
		m.mu.Unlock()
		if stopped || base == "" {
			return
		}
		time.Sleep(20 * time.Second)
		if m.Healthy() {
			misses = 0
			continue
		}
		misses++
		if misses < 3 {
			continue
		}
		m.deaths++
		if m.deaths > 4 {
			m.logf("ocserve: pocket bridge died %d times — giving up this engine run", m.deaths)
			m.mu.Lock()
			m.baseURL = ""
			m.healthy = false
			m.mu.Unlock()
			return
		}
		m.logf("ocserve: pocket bridge unhealthy (attempt %d) — re-provisioning through Termux", m.deaths)
		m.mu.Lock()
		m.baseURL = ""
		m.healthy = false
		m.mu.Unlock()
		ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
		fport, ferr := freePort()
		if ferr != nil {
			cancel()
			m.logf("ocserve: pocket bridge re-provision failed: no free port: %v", ferr)
			continue
		}
		port, err := p.Launch(ctx, fport)
		cancel()
		if err != nil {
			m.logf("ocserve: pocket bridge re-provision failed: %v", err)
			continue // next loop: still stopped? honest give-up after the bound
		}
		m.mu.Lock()
		m.baseURL = fmt.Sprintf("http://127.0.0.1:%d", port)
		m.healthy = true
		m.mu.Unlock()
		misses = 0
	}
}

// stopTermux is Stop's guest-room arm: kill the serve + free the wake-lock.
func (m *Manager) stopTermux(ctx context.Context) {
	m.mu.Lock()
	p := m.tprov
	m.tprov = nil
	m.mu.Unlock()
	if p != nil {
		p.Stop(context.Background())
	}
}

// ── the server-facing projections (v1.49.2 THE OPEN HANDSHAKE) ─────────

// SpawnerIsTermux answers whether THIS engine routes the bridge through
// the guest room (the status ladder + the card states render on it).
func SpawnerIsTermux() bool { return spawnerKindFor() == spawnerTermux }

// AndroidClientInfo answers the pinned guest's version + download-size
// hint (the card's honest "one-time ~52MB" copy).
func AndroidClientInfo() (version, sizeHint string) {
	return androidClientVersion, androidZipSizeHint
}

// AndroidZipSizeHint is the size alone (the turn's in-progress terminal).
func AndroidZipSizeHint() string { return androidZipSizeHint }

// Port answers the live serve's port (0 when none).
func (m *Manager) Port() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.baseURL == "" {
		return 0
	}
	if i := strings.LastIndex(m.baseURL, ":"); i >= 0 {
		if n, err := strconv.Atoi(m.baseURL[i+1:]); err == nil {
			return n
		}
	}
	return 0
}
