// Package ocserve manages a local `opencode serve` — the GENUINE OpenCode
// client — as the engine's one legitimate path to OpenCode's FREE models.
//
// v1.51.1 THE SECOND TONGUE — the whole bridge now speaks the OpenCode 2.x
// serve API (every shape below LIVE-PROBED against the real 2.1.2 npm CLI
// from this sandbox, 2026-10-21; see CAPTURED-TRUTH in the wave research):
//
//   - 2.x ships as npm `@opencode/cli` — platform binaries are
//     @opencode/cli-<os>-<arch> tarballs on registry.npmjs.org (GitHub
//     releases remain 1.x-only; the official install script itself says
//     "OpenCode 2 ships as @opencode/cli"). THE PIN is 2.1.2 + the
//     registry's own sha512 integrity constants, both byte-verified here.
//   - The serve is an HTTP-basic-auth server: user "opencode", password
//     $OPENCODE_SERVER_PASSWORD (if unset the serve generates a RANDOM
//     password and prints it to stdout — we always SET ours, generated in
//     New; it rides the spawn env and key.env, NEVER the command line).
//   - The API lives under /api/ (the 2.1.2 binary's own routes, extracted
//     from its strings and probed live — the website's bare /global/*
//     paths are the NEXT version, not this one). Health = auth'd
//     GET /api/provider → 200.
//   - THE TURN: POST /api/session {title} → {"data":{"id":"ses_…"}};
//     POST /api/session/{id}/model {"model":{"id":…,"providerID":"opencode"}}
//     → 204 (model selection lives on the SESSION — the prompt no longer
//     carries it; the adapter selects before every prompt, keeping the
//     per-turn model law); POST /api/session/{id}/prompt {"text": …} →
//     200 (the PromptInput is {text, files?, agents?, skills?} only — the
//     1.x shape-poison gate law is MOOT in 2.x; the persona + context
//     still ride the text).
//   - THE GATE: a genuine 2.1.2 client + our key answers real big-pickle
//     turns, cost 0, live-proven with thinking, text, tool turns, and
//     session reuse. The permission config keeps the agent honest: with
//     shell/edit/webfetch/task denied the model answers "I don't have a
//     shell tool available"; read/grep/glob/websearch stay (2.x's own
//     free-agent toolset: execute (sandboxed Code Mode), read, glob, grep,
//     question, skill, websearch).
//   - THE EVENTS: GET /api/event SSE (auth'd, MUST begin with
//     server.connected) with envelope {id, created, type, data:{…}} —
//     session.reasoning.delta / session.text.delta carry data.delta;
//     session.tool.input.started/ended + session.tool.called/success
//     carry the pill grammar (data.id/name/text/content);
//     session.usage.updated carries data.cost + data.tokens (the ledger);
//     the terminals are session.execution.succeeded / .failed (the latter
//     with data.error{type,message,status} — a bad key answers
//     provider.auth/401, a gate refusal answers its own message).
package ocserve

import (
        "archive/tar"
        "archive/zip"
        "bufio"
        "compress/gzip"
        "context"
        "crypto/hmac"
        "crypto/rand"
        "crypto/sha256"
        "crypto/sha512"
        "encoding/base64"
        "encoding/hex"
        "encoding/json"
        "errors"
        "fmt"
        "io"
        "net"
        "net/http"
        "os"
        "os/exec"
        "path/filepath"
        "runtime"
        "strings"
        "sync"
        "time"
)

// Version is the pinned OpenCode CLI this bridge is verified against (the
// npm 2.x line; the gate "actively evolves" — a pinned, live-proven build
// is the stable contract; the env overrides below can move it without a
// release).
const Version = "2.1.2"

// npmIntegrity holds the registry's own sha512 integrity strings for the
// pinned version's platform tarballs (captured from
// registry.npmjs.org/@opencode/cli-<platform>/<Version> and byte-verified
// in-sandbox: computed == published for every entry).
var npmIntegrity = map[string]string{
        "linux-x64":    "sha512-O8/8JT8SNmMReDmpYDsm04KmkrQQ2dzaKgaw06zCoUfh50ARGHs58E6zCh16GIUyEL8abrdSe268K5/ExE89Gw==",
        "linux-arm64":  "sha512-294IA9S1sXOAzOBRPMcnFuYpXlFeUaKTlpTk0a7TMvuc7cJbfS52poTw3AlIu7ycbn8TGmTmj27OOxsMmBCLEg==",
        "darwin-x64":   "sha512-ARVkU6v/nvJ9+5ymbHo9WERimPM2wdRK70XikpKgQu849DdBAehopLqhD9FJj4SbroBNVivfSR8ZWHx0H0khHQ==",
        "darwin-arm64": "sha512-H8Nx7ksbHpd5u0Q9BQMj2Mt5vs+dC/t3AslxrmJDY5TZbPyHt6OKJ5TMJc6nQZAFKPrVFGOA+TdzQ9tU5qt6Sg==",
}

// ErrUnavailable is the honest answer on platforms/kinds the bridge cannot
// serve (Android: the desktop binary needs the Termux provisioner — the
// pocket bridge's own law; the honest copy in the provider card + the turn
// error say so).
var ErrUnavailable = errors.New("the opencode serve bridge is not available on this device (needs the desktop engine or an installed opencode CLI)")

// Manager owns one `opencode serve` child process: lazy start, health,
// and a restart-with-backoff when it dies. All HTTP calls speak the 2.x
// serve API captured live (the shapes above), authenticated with the
// server password this Manager generates and passes to the spawn.
//
// v1.49.1 THE GUEST ROOM: on Android the "child" is a serve the engine
// provisions through the Termux jailed exec (termux.go) — the same
// client code, a different spawner (spawnerKindFor).
type Manager struct {
        mu             sync.Mutex
        dataDir        string // the ENGINE data dir — the scratch + managed binary live under it
        apiKey         string
        serverPassword string // the 2.x serve's basic-auth password (we set it, we speak it)
        binPath        string
        baseURL        string
        cmd            *exec.Cmd
        healthy        bool
        stopped        bool
        deaths         int
        logf           func(format string, args ...any)

        // spawnMu serializes serve STARTS (v1.51.4, the rig's conviction: the
        // turn path's self-heal and the watchdog's restart can race a died
        // child — one spawn wins, the loser re-checks health and returns).
        spawnMu sync.Mutex

        // v1.49.1: the Android arm — the Kotlin bridge client + the live
        // provisioner (nil on desktop; the exec-child law above is
        // untouched when the spawner kind says exec).
        termux TermuxClient
        tprov  *termuxProvisioner
}

// Config is the exact permission file the gate law prescribes for the 2.x
// agent (the 2.x tool names — live-probed: the legacy `permission` object
// is still valid, `shell` is the 2.x name for the command tool, `edit`
// covers edit/write/patch): execution + writes DENIED, the read-only
// explorer tools allowed, and the headless-hostile ask-flows denied (a
// serve turn has no human to answer an `ask` — deny answers the agent
// honestly instead of hanging).
const permissionConfig = `{
  "$schema": "https://opencode.ai/config.json",
  "permission": {
    "shell": "deny",
    "edit": "deny",
    "webfetch": "deny",
    "task": "deny",
    "question": "deny",
    "external_directory": "deny",
    "doom_loop": "deny",
    "read": "allow",
    "grep": "allow",
    "glob": "allow",
    "websearch": "allow"
  }
}
`

// FindBinary locates an opencode binary: the explicit env override first
// (the rigs + users who installed their own), then the engine-managed
// path, then PATH. It never downloads here — EnsureBinary does.
func FindBinary(dataDir string) string {
        if p := strings.TrimSpace(os.Getenv("DOOMALAY_OPENCODE_BIN")); p != "" {
                if st, err := os.Stat(p); err == nil && !st.IsDir() {
                        return p
                }
        }
        if p := managedBinPath(dataDir); p != "" {
                if st, err := os.Stat(p); err == nil && !st.IsDir() {
                        return p
                }
        }
        if p, err := exec.LookPath("opencode"); err == nil && p != "" {
                return p
        }
        return ""
}

func managedBinPath(dataDir string) string {
        if dataDir == "" {
                return ""
        }
        return filepath.Join(dataDir, "opencode", "bin", "opencode")
}

// downloadAssetURL answers the npm tarball + the registry's own sha512
// integrity for the host platform (OpenCode 2.x ships as npm
// @opencode/cli-<platform>; the tarball holds package/bin/opencode).
// Env overrides DOOMALAY_OPENCODE_TARBALL_URL + …_SHA512 move it without
// a release (the rigs + future bumps).
func downloadAssetURL(goos, goarch string) (url, integrity string, ok bool) {
        if u := strings.TrimSpace(os.Getenv("DOOMALAY_OPENCODE_TARBALL_URL")); u != "" {
                return u, strings.TrimSpace(os.Getenv("DOOMALAY_OPENCODE_TARBALL_SHA512")), true
        }
        platform := ""
        switch goos {
        case "linux":
                switch goarch {
                case "amd64":
                        platform = "linux-x64"
                case "arm64":
                        platform = "linux-arm64"
                }
        case "darwin":
                switch goarch {
                case "arm64":
                        platform = "darwin-arm64"
                case "amd64":
                        platform = "darwin-x64"
                }
        }
        if platform == "" {
                return "", "", false
        }
        url = fmt.Sprintf("https://registry.npmjs.org/@opencode/cli-%s/-/cli-%s-%s.tgz", platform, platform, Version)
        return url, npmIntegrity[platform], true
}

// EnsureBinary downloads + extracts the pinned 2.x CLI into the managed
// path when nothing usable exists. Android (and any platform without an
// npm platform package) answers ErrUnavailable honestly — the pocket
// bridge owns Android. Best-effort by design: the env override + PATH
// lookups happen first (FindBinary), so this only runs when the user
// asked for a free OpenCode model with no CLI around.
func EnsureBinary(dataDir string, logf func(format string, args ...any)) (string, error) {
        if runtime.GOOS == "android" {
                return "", ErrUnavailable
        }
        if p := FindBinary(dataDir); p != "" {
                return p, nil
        }
        url, integrity, ok := downloadAssetURL(runtime.GOOS, runtime.GOARCH)
        if !ok {
                return "", ErrUnavailable
        }
        bin := managedBinPath(dataDir)
        if bin == "" {
                return "", ErrUnavailable
        }
        if logf == nil {
                logf = func(string, ...any) {}
        }
        logf("ocserve: downloading opencode %s (the 2.x npm tarball)…", Version)
        resp, err := http.Get(url)
        if err != nil {
                return "", fmt.Errorf("ocserve download: %w", err)
        }
        defer resp.Body.Close()
        if resp.StatusCode != 200 {
                return "", fmt.Errorf("ocserve download: HTTP %d", resp.StatusCode)
        }
        tmpDir, err := os.MkdirTemp("", "ocserve-dl-")
        if err != nil {
                return "", err
        }
        defer os.RemoveAll(tmpDir)
        // stream to disk while hashing (the tarball is ~100MB — never fully
        // in memory) then verify THE PIN LAW against the registry's own
        // sha512 before extracting anything.
        tgzPath := filepath.Join(tmpDir, "opencode.tgz")
        out, err := os.OpenFile(tgzPath, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o755)
        if err != nil {
                return "", err
        }
        h := sha512.New()
        if _, err := io.Copy(io.MultiWriter(out, h), resp.Body); err != nil {
                out.Close()
                return "", fmt.Errorf("ocserve download: %w", err)
        }
        out.Close()
        if integrity != "" {
                sum := "sha512-" + base64.StdEncoding.EncodeToString(h.Sum(nil))
                if sum != integrity {
                        return "", errors.New("ocserve download: the tarball failed its sha512 integrity check (the pinned build changed or the download was truncated) — try again")
                }
        }
        tgz, err := os.Open(tgzPath)
        if err != nil {
                return "", err
        }
        defer tgz.Close()
        extractDir := filepath.Join(tmpDir, "x")
        if err := os.MkdirAll(extractDir, 0o755); err != nil {
                return "", err
        }
        if strings.HasSuffix(url, ".zip") {
                if err := extractZip(tgz, extractDir); err != nil {
                        return "", err
                }
        } else {
                if err := extractTarGz(tgz, extractDir); err != nil {
                        return "", err
                }
        }
        // the npm tarball holds package/bin/opencode — extractTarGz flattens
        // by basename, so the binary lands at the extract root; accept one
        // level of nesting just in case.
        src := filepath.Join(extractDir, "opencode")
        if st, err := os.Stat(src); err != nil || st.IsDir() {
                src2 := filepath.Join(extractDir, "opencode", "opencode")
                if st2, err2 := os.Stat(src2); err2 == nil && !st2.IsDir() {
                        src = src2
                } else {
                        return "", errors.New("ocserve download: unexpected archive layout")
                }
        }
        if err := os.MkdirAll(filepath.Dir(bin), 0o755); err != nil {
                return "", err
        }
        if err := copyFile(src, bin); err != nil {
                return "", err
        }
        return bin, nil
}

func copyFile(src, dst string) error {
        f, err := os.Open(src)
        if err != nil {
                return err
        }
        defer f.Close()
        out, err := os.OpenFile(dst+".tmp", os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o755)
        if err != nil {
                return err
        }
        if _, err := io.Copy(out, f); err != nil {
                out.Close()
                return err
        }
        if err := out.Close(); err != nil {
                return err
        }
        return os.Rename(dst+".tmp", dst)
}

func extractTarGz(r io.Reader, dir string) error {
        gz, err := gzip.NewReader(r)
        if err != nil {
                return err
        }
        defer gz.Close()
        tr := tar.NewReader(gz)
        for {
                hdr, err := tr.Next()
                if err == io.EOF {
                        return nil
                }
                if err != nil {
                        return err
                }
                if hdr.Typeflag != tar.TypeReg {
                        continue
                }
                name := filepath.Base(hdr.Name)
                out, err := os.OpenFile(filepath.Join(dir, name), os.O_CREATE|os.O_TRUNC|os.O_WRONLY, os.FileMode(hdr.Mode)&0o755|0o755)
                if err != nil {
                        return err
                }
                if _, err := io.Copy(out, tr); err != nil {
                        out.Close()
                        return err
                }
                out.Close()
        }
}

func extractZip(r io.Reader, dir string) error {
        // zip needs a ReaderAt — buffer the stream (the env-override path may
        // point at one; the pinned 2.x npm line is tar.gz)
        buf, err := io.ReadAll(r)
        if err != nil {
                return err
        }
        tmp, err := os.CreateTemp("", "ocserve-zip-")
        if err != nil {
                return err
        }
        defer os.Remove(tmp.Name())
        if _, err := tmp.Write(buf); err != nil {
                tmp.Close()
                return err
        }
        tmp.Close()
        zr, err := zip.OpenReader(tmp.Name())
        if err != nil {
                return err
        }
        defer zr.Close()
        for _, f := range zr.File {
                if f.FileInfo().IsDir() {
                        continue
                }
                rc, err := f.Open()
                if err != nil {
                        return err
                }
                out, err := os.OpenFile(filepath.Join(dir, filepath.Base(f.Name)), os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o755)
                if err != nil {
                        rc.Close()
                        return err
                }
                _, err = io.Copy(out, rc)
                rc.Close()
                out.Close()
                if err != nil {
                        return err
                }
        }
        return nil
}

// New builds a Manager. dataDir is the ENGINE's data dir (the scratch +
// the managed binary live under it); apiKey is the user's OpenCode key.
//
// THE STABLE-PASSWORD LAW (v1.51.4, the rig's conviction): the 2.x serve's
// basic-auth password is DERIVED from the key (HMAC-SHA256, hex) — the
// same key always computes the same password, so a pocket serve that
// OUTLIVES the engine (Termux hosts it across engine restarts) stays
// adoptable by the next engine run; a key rotation honestly re-derives a
// fresh password and the stale serve fails the auth'd health check → a
// fresh spawn with the refreshed key.env. The env override
// DOOMALAY_OPENCODE_SERVE_PASSWORD (the rigs + reproducible tests) wins
// over the derivation; a keyless engine gets a random one (no turns
// anyway). It rides the spawn env and key.env, never a URL, never a
// command line.
func New(dataDir, apiKey string, logf func(format string, args ...any)) *Manager {
        if logf == nil {
                logf = func(string, ...any) {}
        }
        pw := strings.TrimSpace(os.Getenv("DOOMALAY_OPENCODE_SERVE_PASSWORD"))
        if pw == "" {
                pw = derivedServePassword(apiKey)
        }
        return &Manager{
                dataDir:        dataDir,
                apiKey:         apiKey,
                serverPassword: pw,
                logf:           logf,
        }
}

// derivedServePassword answers the stable per-key password (THE
// STABLE-PASSWORD LAW above): empty key → random (nothing can serve).
func derivedServePassword(apiKey string) string {
        if strings.TrimSpace(apiKey) == "" {
                b := make([]byte, 24)
                if _, err := rand.Read(b); err != nil {
                        return fmt.Sprintf("pw-%d", time.Now().UnixNano())
                }
                return hex.EncodeToString(b)
        }
        mac := hmac.New(sha256.New, []byte("doomalay-oc2-serve-password-v1"))
        mac.Write([]byte(apiKey))
        return hex.EncodeToString(mac.Sum(nil))
}

// ServerPassword answers the serve's basic-auth password (the rigs +
// tests read it to fake the far side faithfully).
func (m *Manager) ServerPassword() string {
        m.mu.Lock()
        defer m.mu.Unlock()
        return m.serverPassword
}

// SetBaseURL points the manager at an ALREADY-RUNNING 2.x serve (the rigs +
// tests drive a fake; production discovers its own child). When set,
// Start only health-checks — it never spawns.
func (m *Manager) SetBaseURL(u string) {
        m.mu.Lock()
        m.baseURL = strings.TrimSuffix(u, "/")
        m.mu.Unlock()
}

// SetTermux arms the Android spawner (v1.49.1 THE GUEST ROOM): the Kotlin
// bridge client that owns the jailed exec. nil (the default on every
// non-Android build that doesn't configure the bridge) keeps the desktop
// exec-child law.
func (m *Manager) SetTermux(c TermuxClient) {
        m.mu.Lock()
        m.termux = c
        m.mu.Unlock()
}

// Healthy reports whether a serve is answering right now.
func (m *Manager) Healthy() bool {
        m.mu.Lock()
        base, pw := m.baseURL, m.serverPassword
        m.mu.Unlock()
        if base == "" {
                return false
        }
        return healthyUp(base, pw)
}

// healthyUp is THE health law for the 2.x serve: an authenticated
// GET /api/provider answering 200 (the bare /health serves the web IDE to
// anyone — a real API round-trip with our password is the decisive proof;
// a stale 1.x serve on the same port answers 404 and honestly fails).
func healthyUp(base, password string) bool {
        ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
        defer cancel()
        req, err := http.NewRequestWithContext(ctx, http.MethodGet, base+"/api/provider", nil)
        if err != nil {
                return false
        }
        req.Header.Set("Authorization", "Basic "+basicAuth("opencode", password))
        resp, err := http.DefaultClient.Do(req)
        if err != nil {
                return false
        }
        resp.Body.Close()
        return resp.StatusCode == 200
}

func basicAuth(user, password string) string {
        return base64.StdEncoding.EncodeToString([]byte(user + ":" + password))
}

// Start ensures a serve child is up: writes the permission config (THE
// GATE LAW — the 2.x permission names; execution + writes + the
// headless-hostile ask-flows denied, the read-only explorers allowed),
// spawns on a free local port with the API key AND the serve password in
// the env, waits for health, and arms a restart-with-backoff watcher.
// SetBaseURL callers skip straight to the health check. On Android
// (v1.49.1) the guest room owns the spawn: the engine drives Termux's
// jailed exec to install + host the native client (termux.go) — same
// client, same API, same laws.
func (m *Manager) Start(ctx context.Context) error {
        if m.Healthy() {
                return nil
        }
        m.mu.Lock()
        if m.stopped {
                m.mu.Unlock()
                return ErrUnavailable
        }
        // the EXTERNAL-serve mode (SetBaseURL, no managed child): never spawn,
        // just the honest not-healthy error. A MANAGED child with a stale
        // baseURL (killed between the death and the watchdog's reap) must
        // fall THROUGH to the spawn — the v1510 rig convicted the conflated
        // check killing the turn path's self-heal ("external serve not
        // healthy" on our own dead child).
        if m.baseURL != "" && m.cmd == nil {
                m.mu.Unlock()
                return errors.New("ocserve: external serve not healthy")
        }
        m.mu.Unlock()
        if spawnerKindFor() == spawnerTermux {
                return m.startViaTermux(ctx)
        }
        // one spawn at a time (the turn path + the watchdog may race); the
        // loser re-checks health and returns clean.
        m.spawnMu.Lock()
        defer m.spawnMu.Unlock()
        if m.Healthy() {
                return nil // a racing starter already brought the bridge up
        }
        m.mu.Lock()
        bin := m.binPath
        if bin == "" {
                // find or fetch the CLI (lazy: only a free-model turn gets here)
                p, err := EnsureBinary(m.dataDir, m.logf)
                if err != nil {
                        m.mu.Unlock()
                        return err
                }
                bin = p
        }
        m.mu.Unlock()

        scratch := filepath.Join(m.dataDir, "opencode-serve")
        if err := os.MkdirAll(scratch, 0o755); err != nil {
                return err
        }
        if err := os.WriteFile(filepath.Join(scratch, "opencode.json"), []byte(permissionConfig), 0o644); err != nil {
                return err
        }
        port, err := freePort()
        if err != nil {
                return err
        }
        cmd := exec.Command(bin, "serve", "--port", fmt.Sprintf("%d", port), "--hostname", "127.0.0.1")
        cmd.Dir = scratch
        cmd.Env = append(os.Environ(),
                "OPENCODE_API_KEY="+m.apiKey,
                "OPENCODE_SERVER_PASSWORD="+m.serverPassword)
        if out, err := os.OpenFile(filepath.Join(scratch, "serve.log"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644); err == nil {
                cmd.Stdout = out
                cmd.Stderr = out
        } else {
                cmd.Stdout = io.Discard
                cmd.Stderr = io.Discard
        }
        if err := cmd.Start(); err != nil {
                return err
        }
        base := fmt.Sprintf("http://127.0.0.1:%d", port)
        // health poll (the 2.x CLI boots in ~3-8s — the IDE assets load first)
        deadline := time.Now().Add(30 * time.Second)
        for time.Now().Before(deadline) {
                select {
                case <-ctx.Done():
                        _ = cmd.Process.Kill()
                        return ctx.Err()
                default:
                }
                if healthyUp(base, m.serverPassword) {
                        m.mu.Lock()
                        m.cmd = cmd
                        m.baseURL = base
                        m.healthy = true
                        m.mu.Unlock()
                        m.logf("ocserve: opencode %s bridge up on %s (free models: the genuine client)", Version, base)
                        go m.watchdog()
                        return nil
                }
                time.Sleep(300 * time.Millisecond)
        }
        _ = cmd.Process.Kill()
        return errors.New("ocserve: serve did not become healthy in 30s")
}

// watchdog restarts a died child with a bounded backoff (the bridge is
// opportunistic capacity — a crash-loop must not burn the device).
func (m *Manager) watchdog() {
        for {
                m.mu.Lock()
                cmd, base, stopped := m.cmd, m.baseURL, m.stopped
                m.mu.Unlock()
                if stopped || cmd == nil || base == "" {
                        return
                }
                err := cmd.Wait() // blocks until the child dies
                m.mu.Lock()
                if m.stopped || m.baseURL != base {
                        m.mu.Unlock()
                        return
                }
                m.healthy = false
                m.deaths++
                m.baseURL = ""
                deaths := m.deaths
                m.mu.Unlock()
                if deaths > 4 {
                        m.logf("ocserve: bridge died %d times — giving up this engine run", deaths)
                        return
                }
                m.logf("ocserve: bridge died (%v) — restarting (attempt %d)", err, deaths)
                time.Sleep(time.Duration(deaths) * 2 * time.Second)
                ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
                if err := m.Start(ctx); err != nil {
                        m.logf("ocserve: restart failed: %v", err)
                }
                cancel()
        }
}

// Stop kills the child (engine shutdown).
func (m *Manager) Stop() {
        m.mu.Lock()
        m.stopped = true
        cmd := m.cmd
        m.cmd = nil
        m.baseURL = ""
        m.mu.Unlock()
        if cmd != nil && cmd.Process != nil {
                _ = cmd.Process.Kill()
                return
        }
        // v1.49.1: the guest-room arm — a Termux-hosted serve dies through
        // the jailed exec (pid-file kill + wake-unlock, best-effort).
        m.stopTermux(context.Background())
}

func freePort() (int, error) {
        l, err := net.Listen("tcp", "127.0.0.1:0")
        if err != nil {
                return 0, err
        }
        defer l.Close()
        return l.Addr().(*net.TCPAddr).Port, nil
}

// ── the 2.x serve client (the live-captured shapes) ────────────────────

// CreateSession POSTs /api/session and returns the serve session id (the
// 2.x envelope wraps the session in "data").
func (m *Manager) CreateSession(title string) (string, error) {
        m.mu.Lock()
        base, pw := m.baseURL, m.serverPassword
        m.mu.Unlock()
        if base == "" {
                return "", errors.New("ocserve: not running")
        }
        body, _ := json.Marshal(map[string]any{"title": title})
        ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
        defer cancel()
        req, err := http.NewRequestWithContext(ctx, http.MethodPost, base+"/api/session", strings.NewReader(string(body)))
        if err != nil {
                return "", err
        }
        req.Header.Set("Content-Type", "application/json")
        req.Header.Set("Authorization", "Basic "+basicAuth("opencode", pw))
        resp, err := http.DefaultClient.Do(req)
        if err != nil {
                return "", err
        }
        defer resp.Body.Close()
        if resp.StatusCode >= 300 {
                return "", fmt.Errorf("ocserve create session: HTTP %d", resp.StatusCode)
        }
        var out struct {
                Data struct {
                        ID string `json:"id"`
                } `json:"data"`
        }
        if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
                return "", err
        }
        if out.Data.ID == "" {
                return "", errors.New("ocserve create session: no id")
        }
        return out.Data.ID, nil
}

// SelectModel pins the SESSION's model (the 2.x law: model selection
// lives on the session, not the prompt — the adapter calls this before
// every prompt, keeping the per-turn model choice).
func (m *Manager) SelectModel(serveSess, modelID string) error {
        m.mu.Lock()
        base, pw := m.baseURL, m.serverPassword
        m.mu.Unlock()
        if base == "" {
                return errors.New("ocserve: not running")
        }
        body, _ := json.Marshal(map[string]any{
                "model": map[string]string{"id": modelID, "providerID": "opencode"},
        })
        ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
        defer cancel()
        req, err := http.NewRequestWithContext(ctx, http.MethodPost, base+"/api/session/"+serveSess+"/model", strings.NewReader(string(body)))
        if err != nil {
                return err
        }
        req.Header.Set("Content-Type", "application/json")
        req.Header.Set("Authorization", "Basic "+basicAuth("opencode", pw))
        resp, err := http.DefaultClient.Do(req)
        if err != nil {
                return err
        }
        resp.Body.Close()
        if resp.StatusCode >= 300 {
                return fmt.Errorf("ocserve select model: HTTP %d", resp.StatusCode)
        }
        return nil
}

// Prompt fires one turn (200 with the user-message ack on accept). The
// 2.x PromptInput carries ONLY the text — no model, no parts, no
// system/tools fields exist to send (the persona + context ride the text
// the adapter composes; the 1.x shape-poison gate law is moot in 2.x).
func (m *Manager) Prompt(serveSess, text string) error {
        m.mu.Lock()
        base, pw := m.baseURL, m.serverPassword
        m.mu.Unlock()
        if base == "" {
                return errors.New("ocserve: not running")
        }
        body, _ := json.Marshal(map[string]any{"text": text})
        ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
        defer cancel()
        req, err := http.NewRequestWithContext(ctx, http.MethodPost, base+"/api/session/"+serveSess+"/prompt", strings.NewReader(string(body)))
        if err != nil {
                return err
        }
        req.Header.Set("Content-Type", "application/json")
        req.Header.Set("Authorization", "Basic "+basicAuth("opencode", pw))
        resp, err := http.DefaultClient.Do(req)
        if err != nil {
                return err
        }
        resp.Body.Close()
        if resp.StatusCode >= 300 {
                return fmt.Errorf("ocserve prompt: HTTP %d", resp.StatusCode)
        }
        return nil
}

// Event is one parsed SSE frame from GET /api/event (the live-captured
// 2.x envelope: the payload rides "data", the session filter key is
// data.sessionID).
type Event struct {
        Type string    `json:"type"`
        Data eventData `json:"data"`
}

type eventData struct {
        SessionID          string          `json:"sessionID"`
        AssistantMessageID string          `json:"assistantMessageID"`
        Agent              string          `json:"agent"`
        Model              eventModel      `json:"model"`
        Ordinal            int             `json:"ordinal"`
        Delta              string          `json:"delta"`   // reasoning./text. delta payload
        Text               string          `json:"text"`    // text.ended full text; tool.input.ended serialized input
        Name               string          `json:"name"`    // tool.input.started tool name
        ID                 string          `json:"id"`      // the tool call id
        Input              json.RawMessage `json:"input"`   // tool.called
        Content            []toolContent   `json:"content"` // tool.success/failed
        Finish             string          `json:"finish"`
        Cost               float64         `json:"cost"`
        Tokens             eventTokens     `json:"tokens"`
        Error              *eventError     `json:"error"`
}

type eventModel struct {
        ID         string `json:"id"`
        ProviderID string `json:"providerID"`
        Variant    string `json:"variant"`
}

type eventTokens struct {
        Input     int        `json:"input"`
        Output    int        `json:"output"`
        Reasoning int        `json:"reasoning"`
        Cache     eventCache `json:"cache"`
}

type eventCache struct {
        Read  int `json:"read"`
        Write int `json:"write"`
}

type eventError struct {
        Type    string `json:"type"`
        Message string `json:"message"`
        Status  int    `json:"status"`
}

type toolContent struct {
        Type string `json:"type"`
        Text string `json:"text"`
}

// IsTerminal reports the turn's terminal frames.
func (e Event) IsTerminal() bool {
        return e.Type == "session.execution.succeeded" || e.Type == "session.execution.failed"
}

// IsFreeTierError reports whether a terminal frame carries OpenCode's
// free-tier wall (the recycle law's trigger — upstream flags evolve).
func (e Event) IsFreeTierError() bool {
        if e.Type != "session.execution.failed" {
                return false
        }
        return e.Data.Error != nil && strings.Contains(strings.ToLower(e.Data.Error.Message), "free tier")
}

// IsAuthError reports the bad-key terminal (the honest reconnect answer).
func (e Event) IsAuthError() bool {
        if e.Type != "session.execution.failed" {
                return false
        }
        return e.Data.Error != nil && (e.Data.Error.Type == "provider.auth" || e.Data.Error.Status == 401)
}

// StreamEvents consumes the serve's SSE feed until the turn's terminal
// (session.execution.succeeded / .failed — this session's frames only),
// the ctx dies, or the connection breaks. onEvent gets every parsed frame
// in arrival order. The stream MUST begin with server.connected (the 2.x
// handshake — the empty-sessionID handshake frame rides the same wire and
// is filtered like every foreign frame).
func (m *Manager) StreamEvents(ctx context.Context, serveSess string, onEvent func(Event) error) error {
        m.mu.Lock()
        base, pw := m.baseURL, m.serverPassword
        m.mu.Unlock()
        if base == "" {
                return errors.New("ocserve: not running")
        }
        req, err := http.NewRequestWithContext(ctx, http.MethodGet, base+"/api/event", nil)
        if err != nil {
                return err
        }
        req.Header.Set("Accept", "text/event-stream")
        req.Header.Set("Authorization", "Basic "+basicAuth("opencode", pw))
        resp, err := http.DefaultClient.Do(req)
        if err != nil {
                return err
        }
        defer resp.Body.Close()
        if resp.StatusCode >= 300 {
                return fmt.Errorf("ocserve event stream: HTTP %d", resp.StatusCode)
        }
        r := bufio.NewReader(resp.Body)
        for {
                if ctx.Err() != nil {
                        return ctx.Err()
                }
                line, err := r.ReadString('\n')
                if err != nil {
                        return err
                }
                line = strings.TrimSpace(line)
                if !strings.HasPrefix(line, "data: ") {
                        continue
                }
                var ev Event
                if json.Unmarshal([]byte(line[6:]), &ev) != nil {
                        continue
                }
                // only this session's frames (the handshake server.connected and
                // global frames ride the same wire with a foreign or empty
                // sessionID)
                if p := ev.Data.SessionID; p == "" || p != serveSess {
                        continue
                }
                if err := onEvent(ev); err != nil {
                        return err
                }
                if ev.IsTerminal() {
                        return nil
                }
        }
}
