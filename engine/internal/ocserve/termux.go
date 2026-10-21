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
//     OpenCode NATIVELY for Android/Termux aarch64.
//   - THE PIN (v1.51.2 THE YOUNGER GUEST): opencode2 **v1.0.3-rc3** (Oct 18
//     2026 — the newest release of the 2.x line, carrying the Android
//     seccomp SIGSYS fix) = OpenCode **2.0.0-android-termux** built on the
//     official Bun android target. opencode2-1.0.3rc3-android-aarch64.zip,
//     72.5MB, SHA256 0725f327… verified in-sandbox against the release's
//     own SHA256SUMS. The zip is FLAT: `opencode2` (a POSIX wrapper that
//     sets OPENTUI_LIB_PATH + LD_LIBRARY_PATH, disables @parcel/watcher,
//     then `exec`s opencode2.bin) + opencode2.bin (173MB) + libopentui.so —
//     NO libtagfix/libc++ (the official Bun android target made them
//     obsolete). Unzip → run. 2.0.0 speaks the SAME 2.x serve API family
//     as the pinned desktop 2.1.2 (its route strings carry every core
//     route: /api/session, :id/model, :id/prompt, /api/event, /api/provider)
//     — the v1.51.1 ocserve client is byte-compatible. The install also
//     best-effort removes the retired 1.x files (opencode, opencode.bin,
//     libtagfix.so, libc++_shared.so) so a v1.49 phone doesn't carry 194MB
//     of dead weight.
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
// as the desktop 2.1.2 npm pin). Env overrides move it without a release.
const (
        androidZipURLDefault = "https://github.com/guysoft/opencode-termux/releases/download/v1.0.3-rc3/opencode2-1.0.3rc3-android-aarch64.zip"
        androidZipSHADefault = "0725f3278cde20b39e30be1833966c67276a13829ea634f60d91f85ba3d13893"
        androidClientVersion = "2.0.0 (opencode2 v1.0.3-rc3 — the native Android/Termux build of OpenCode 2)"
        androidZipSizeHint   = "72.5MB"
)

// var (not const) so the tests can shorten the waits without touching the
// production values.
var (
        androidServeBootWait  = 45 * time.Second
        androidHealthInterval = 500 * time.Millisecond
        // v1.55.1: the download progress poll cadence (the sidecar `cat`).
        androidProgressInterval = 2 * time.Second
)

// androidZipSizeApproxBytes is the download's EXPECTED size (the pinned
// release's own size, ~72.5MB) — the percent denominator for the live pill.
// A larger actual file clamps at 99% until the marker lands (never lies).
const androidZipSizeApproxBytes int64 = 76_021_760 // 72.5 MiB

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
//      $HOME/.doomalay/opencode/            the unzipped client (opencode2,
//                                           opencode2.bin, libopentui.so)
//      $HOME/.doomalay/opencode-serve/      the serve CWD: the gate-law
//                                           opencode.json, key.env (0600),
//                                           serve.log, serve.pid, bridge.port
//      $HOME/.doomalay/cache/               the zip download
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
        // v1.55.1 THE HONEST LADDER: the download's live sidecars — dl.bytes is
        // the stat loop's byte checkpoint (the engine's progress poll reads it
        // every 2s → the provider pill pings the download), dl.status carries the
        // ok/fail marker out of the backgrounded curl.
        tmDlBytes  = "$HOME/.doomalay/cache/dl.bytes"
        tmDlStatus = "$HOME/.doomalay/cache/dl.status"
)

// ── the command builders (each one a named pin — the tests byte-match) ──

func tmCmdMkdirs() string {
        return fmt.Sprintf("mkdir -p %s %s %s && echo __dm_ok__", tmBinDir, tmServeDir, tmCacheDir)
}

func tmCmdInstallCheck() string {
        return fmt.Sprintf("test -x %s/opencode2 && test -f %s && echo __dm_installed__ || echo __dm_missing__",
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

// tmCmdDownload — v1.55.1 THE CHECKPOINT LAW: `-C -` makes the PARTIAL ZIP
// the checkpoint (a retry resumes from its byte offset — progress is never
// lost), `--retry 5 --retry-all-errors` rides through transient mobile
// drops, and the stat loop keeps dl.bytes live for the engine's progress
// poll (the provider pill's ping). The ok/fail marker rides dl.status out
// of the backgrounded curl (the command's own exit is the stat loop's,
// not curl's — the marker is the truth the Ensure ladder reads).
func tmCmdDownload(url string) string {
        return "rm -f " + tmDlStatus + "; " +
                "( curl -fL -C - --retry 5 --retry-all-errors --retry-delay 2 --connect-timeout 20 -o " + tmZipPath + " '" + url + "' " +
                "&& echo __dm_dl_ok__ > " + tmDlStatus + " || echo __dm_dl_fail__ > " + tmDlStatus + " ) & " +
                "__C=$!; while kill -0 $__C 2>/dev/null; do stat -c %s " + tmZipPath + " > " + tmDlBytes + " 2>/dev/null; sleep 2; done; " +
                "cat " + tmDlStatus
}

// tmCmdProgressBytes — the engine's live byte poll (best-effort; the
// progress is a UI ping, never a gate).
func tmCmdProgressBytes() string {
        return fmt.Sprintf("cat %s 2>/dev/null || true", tmDlBytes)
}

// tmCmdRmZip — the corrupt-download law: a zip that FINISHED downloading but
// failed its SHA must not be resumed (`-C -` on a complete-but-corrupt
// file can never heal — the retry starts honest and fresh).
func tmCmdRmZip() string {
        return fmt.Sprintf("rm -f %s %s 2>/dev/null; true", tmZipPath, tmDlBytes)
}

func tmCmdShaCheck(sha string) string {
        return fmt.Sprintf("printf '%%s  %%s\\n' '%s' %s | sha256sum -c - >/dev/null 2>&1 && echo __dm_sha_ok__ || echo __dm_sha_bad__",
                sha, tmZipPath)
}

func tmCmdUnzip() string {
        // busybox's unzip is Termux's built-in belt under a missing unzip pkg.
        // After the extract, the retired 1.x client files leave best-effort —
        // a v1.49 phone must not carry 194MB of dead opencode/opencode.bin
        // (the 2.x zip only ships opencode2, opencode2.bin, libopentui.so).
        return fmt.Sprintf("unzip -o %s -d %s/ >/dev/null 2>&1 || busybox unzip -o %s -d %s/ >/dev/null 2>&1; ", tmZipPath, tmBinDir, tmZipPath, tmBinDir) +
                fmt.Sprintf("rm -f %s/opencode %s/opencode.bin %s/libtagfix.so %s/libc++_shared.so 2>/dev/null; ", tmBinDir, tmBinDir, tmBinDir, tmBinDir) +
                fmt.Sprintf("chmod +x %s/opencode2 %s/opencode2.bin && echo __dm_unzip_ok__", tmBinDir, tmBinDir)
}

func tmCmdWriteConfig() (command, stdin string) {
        return fmt.Sprintf("cat > %s", tmServeJSON), permissionConfig
}

func tmCmdWriteKey() (command, stdin string) {
        // the key AND the 2.x serve password ride stdin (the RunWithStdin
        // zero-escaping law) as a 0600 env file — NEVER the command line
        // (ps-safe). Every line EXPORTS: a sourced bare `VAR=…` is a shell-local
        // and never reaches the nohup'd child (the v1510 rig convicted this
        // live — the serve generated its own random password and the engine's
        // auth'd health check honestly failed). __KEY__ + __PW__ replace via
        // strings.Replace (never Sprintf — a % in a secret must not break it).
        return fmt.Sprintf("umask 077 && cat > %s", tmKeyEnv), "export OPENCODE_API_KEY=__KEY__\nexport OPENCODE_SERVER_PASSWORD=__PW__\n"
}

func tmKeyStdin(key, serverPassword string) string {
        _, stdin := tmCmdWriteKey()
        s := strings.Replace(stdin, "__KEY__", key, 1)
        return strings.Replace(s, "__PW__", serverPassword, 1)
}

func tmCmdPortProbe() string {
        return fmt.Sprintf("cat %s 2>/dev/null || true", tmPortFile)
}

// tmCmdSpawn: the workdir stays EMPTY (the Kotlin bridge passes a RAW
// workdir to Termux — a $HOME-prefixed string would land as a literal,
// nonexistent dir; workdir "" defaults to the Termux home on the bridge
// side), so the command cd's itself (bash expands $HOME in the COMMAND).
// The wake-lock (Termux must outlive the Android phantom killer while
// serving), the key rides key.env (NEVER the command line — ps-safe, the
// RunWithStdin zero-escaping law wrote it 0600), nohup + `&` detach the
// serve from the jailed session (the wrapper `exec`s opencode2.bin, so
// the captured $! stays the serve's real pid), and the pid + port land
// in their files for reuse/kill.
func tmCmdSpawn(port int) string {
        return fmt.Sprintf("cd \"%s\" && termux-wake-lock 2>/dev/null; . %s; ", tmServeDir, tmKeyEnv) +
                fmt.Sprintf("nohup %s/opencode2 serve --port %d --hostname 127.0.0.1 > %s 2>&1 & ", tmBinDir, port, tmServeLog) +
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
        // v1.51.1: the 2.x serve's basic-auth password — the Manager owns it;
        // it rides key.env (NEVER the command line), and the engine-side
        // health poll speaks it on /api/provider.
        serverPassword string
        logf           func(format string, args ...any)
        // v1.55.1 THE HONEST LADDER: the live progress hook (stage, bytes,
        // total) — the Manager arms it so the provider screen's pill pings
        // the download for real. nil = no reporting (tests that don't care).
        report func(stage string, bytes, total int64)
}

// stage reports one progress tick (nil-guarded — the hook is optional).
func (p *termuxProvisioner) stage(name string) {
        if p.report != nil {
                p.report(name, 0, 0)
        }
}

// stageBytes reports a download-progress tick.
func (p *termuxProvisioner) stageBytes(name string, bytes, total int64) {
        if p.report != nil {
                p.report(name, bytes, total)
        }
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
// install short-circuits at the marker after a CHEAP REFRESH of the two
// stdin-written files: the gate-law config + key.env — a key rotation or
// a password re-derivation must reach the NEXT spawn even when the
// binary install itself is already done; the v1510 rig convicted the
// stale-key.env hang otherwise).
//
// v1.55.1 THE HONEST LADDER: every stage reports through the progress
// hook (deps → download-with-live-bytes → verify → unpack → configure →
// the caller's spawn/boot), and THE CHECKPOINT LAW rides the download —
// `-C -` resumes a partial zip from its byte offset so a retry never
// restarts from zero.
func (p *termuxProvisioner) Ensure(ctx context.Context) error {
        if err := p.statusLadder(ctx); err != nil {
                return err
        }
        if ok, err := p.installed(ctx); err == nil && ok {
                if err := p.refreshSecrets(ctx); err != nil {
                        return err
                }
                p.stage("installed")
                return nil
        }
        if _, err := p.run(ctx, tmCmdMkdirs(), "", 30_000, ""); err != nil {
                return err
        }
        p.stage("deps")
        res, err := p.run(ctx, tmCmdDeps(), "", 600_000, "")
        if err != nil {
                return err
        }
        if res != nil && strings.Contains(res.Stdout, "__dm_deps_missing__") {
                return errors.New("pocket bridge: unzip is unavailable in Termux (pkg install unzip failed — check the network and try again)")
        }
        url, sha := androidArtifact()
        p.logf("pocket bridge: downloading the native OpenCode client (%s)…", androidZipSizeHint)
        if err := p.download(ctx, url); err != nil {
                return fmt.Errorf("pocket bridge: download failed: %w", err)
        }
        p.stage("verify")
        res, err = p.run(ctx, tmCmdShaCheck(sha), "", 120_000, "")
        if err != nil {
                return err
        }
        if res != nil && strings.Contains(res.Stdout, "__dm_sha_bad__") {
                // THE CORRUPT-ZIP LAW: a COMPLETE download that failed its SHA must
                // not be resumed (checkpoint law covers partial files, never corrupt
                // ones) — drop it so the retry starts honest and fresh.
                _, _ = p.run(ctx, tmCmdRmZip(), "", 30_000, "")
                return errors.New("pocket bridge: the downloaded OpenCode client failed its SHA256 check (the pinned build changed or the download was truncated) — try again")
        }
        p.stage("unpack")
        if _, err := p.run(ctx, tmCmdUnzip(), "", 300_000, ""); err != nil {
                return fmt.Errorf("pocket bridge: extract failed: %w", err)
        }
        p.stage("configure")
        cmd, stdin := tmCmdWriteConfig()
        if _, err := p.run(ctx, cmd, "", 30_000, stdin); err != nil {
                return fmt.Errorf("pocket bridge: writing the permission config failed: %w", err)
        }
        kcmd, _ := tmCmdWriteKey()
        if _, err := p.run(ctx, kcmd, "", 30_000, tmKeyStdin(p.apiKey, p.serverPassword)); err != nil {
                return fmt.Errorf("pocket bridge: storing the OpenCode key failed: %w", err)
        }
        p.logf("pocket bridge: the native OpenCode client %s is installed", androidClientVersion)
        return nil
}

// download runs the CHECKPOINT download (the resumable curl) and pings the
// live byte sidecar every 2s through the progress hook — the downloading
// pill is never static. The sidecar poll is best-effort (a failed `cat` is
// a skipped tick, never a failure); the download's own truth is the marker.
func (p *termuxProvisioner) download(ctx context.Context, url string) error {
        type dlOut struct {
                res *termuxbridge.RunResult
                err error
        }
        done := make(chan dlOut, 1)
        go func() {
                res, err := p.run(ctx, tmCmdDownload(url), "", 900_000, "")
                done <- dlOut{res, err}
        }()
        // v1.55.1: the byte poll tick (short so the pill stays live; the fake
        // bridges in the tests can shorten it further without touching prod).
        tick := time.NewTicker(androidProgressInterval)
        defer tick.Stop()
        for {
                select {
                case out := <-done:
                        if out.err != nil {
                                return out.err
                        }
                        if out.res == nil || !strings.Contains(out.res.Stdout, "__dm_dl_ok__") {
                                return errors.New("the resumable download did not finish (marker missing)")
                        }
                        // the final 100% tick — the pill must reach its complete state
                        p.stageBytes("download", androidZipSizeApproxBytes, androidZipSizeApproxBytes)
                        return nil
                case <-tick.C:
                        // best-effort byte ping — never blocks the download itself
                        pctx, cancel := context.WithTimeout(ctx, 5*time.Second)
                        if res, err := p.client.Run(pctx, tmCmdProgressBytes(), "", 10_000); err == nil && res != nil {
                                if n, ok := tmParseBytes(res.Stdout); ok && n > 0 {
                                        p.stageBytes("download", n, androidZipSizeApproxBytes)
                                }
                        }
                        cancel()
                case <-ctx.Done():
                        return ctx.Err()
                }
        }
}

// tmParseBytes reads the sidecar's byte count (whitespace-tolerant;
// unparsable = no tick).
func tmParseBytes(s string) (int64, bool) {
        s = strings.TrimSpace(s)
        if s == "" {
                return 0, false
        }
        var n int64
        if _, err := fmt.Sscanf(s, "%d", &n); err != nil || n < 0 {
                return 0, false
        }
        return n, true
}

// refreshSecrets rewrites the two stdin-written files on an ALREADY
// installed guest (the idempotent belt: the config + key.env must always
// match THIS engine run's gate law + secrets before any spawn).
func (p *termuxProvisioner) refreshSecrets(ctx context.Context) error {
        cmd, stdin := tmCmdWriteConfig()
        if _, err := p.run(ctx, cmd, "", 30_000, stdin); err != nil {
                return fmt.Errorf("pocket bridge: refreshing the permission config failed: %w", err)
        }
        kcmd, _ := tmCmdWriteKey()
        if _, err := p.run(ctx, kcmd, "", 30_000, tmKeyStdin(p.apiKey, p.serverPassword)); err != nil {
                return fmt.Errorf("pocket bridge: refreshing the OpenCode key failed: %w", err)
        }
        return nil
}

// Launch answers a LIVE serve base port: reuse a healthy recorded serve
// (an engine restart must not leak a second one), else kill the stale pid
// and spawn fresh on the given port, then health-poll FROM THE ENGINE (the
// shared loopback — the same interface the checkin already rides).
func (p *termuxProvisioner) Launch(ctx context.Context, port int) (int, error) {
        p.stage("boot")
        if err := p.Ensure(ctx); err != nil {
                return 0, err
        }
        // reuse: a recorded port that answers health is a serve we can use now
        if res, err := p.run(ctx, tmCmdPortProbe(), "", 15_000, ""); err == nil && res != nil {
                if old, ok := tmParsePort(res.Stdout); ok && healthyUp(fmt.Sprintf("http://127.0.0.1:%d", old), p.serverPassword) {
                        p.logf("pocket bridge: reusing the live serve on port %d", old)
                        return old, nil
                }
        }
        // stale (or none): kill the recorded pid so a fresh spawn never stacks
        _, _ = p.run(ctx, tmCmdKill(), "", 15_000, "")
        if _, err := p.run(ctx, tmCmdSpawn(port), "", 30_000, ""); err != nil {
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
                if healthyUp(base, p.serverPassword) {
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
        p := &termuxProvisioner{client: m.termux, apiKey: m.apiKey, serverPassword: m.serverPassword, logf: m.logf}
        // v1.55.1: the live progress hook — every provisioning stage lands on
        // the Manager's snapshot for the bridge status route (the pill's ping).
        p.report = func(stage string, bytes, total int64) { m.setProgress(stage, bytes, total) }
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
// hint (the card's honest "one-time ~72.5MB" copy).
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
