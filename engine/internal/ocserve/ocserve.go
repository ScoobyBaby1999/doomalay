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
        "net/url"
        "os"
        "os/exec"
        "path"
        "path/filepath"
        "runtime"
        "strings"
        "sync"
        "sync/atomic"
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

        // v1.55.1 THE HONEST LADDER: the live install progress (stage +
        // bytes/total of the download). Readable WITHOUT touching any long-held
        // lock via Progress() — the bridge status route pings it every poll and
        // the provider pill renders the download for real.
        progMu   sync.Mutex
        progress InstallProgress
}

// InstallProgress is the live install snapshot (v1.55.1): which stage the
// pocket-bridge provisioning is in, and how many bytes of the pinned zip
// have landed out of the expected total. Stage names are a stable contract
// for the PWA pill: "" (idle) | "boot" | "deps" | "download" | "verify" |
// "unpack" | "configure" | "installed".
type InstallProgress struct {
        Stage string `json:"stage"`
        Bytes int64  `json:"bytes"`
        Total int64  `json:"total"`
}

// Progress answers the current install snapshot (always safe — a tiny
// mutex, never the spawn/start path).
func (m *Manager) Progress() InstallProgress {
        m.progMu.Lock()
        defer m.progMu.Unlock()
        return m.progress
}

// setProgress records one provisioning tick (the provisioner's report
// hook lands here).
func (m *Manager) setProgress(stage string, bytes, total int64) {
        m.progMu.Lock()
        m.progress = InstallProgress{Stage: stage, Bytes: bytes, Total: total}
        m.progMu.Unlock()
}

// SetProgressForTest arms the progress snapshot directly (the rigs + the
// server pins render a live install window without provisioning).
func (m *Manager) SetProgressForTest(stage string, bytes, total int64) {
        m.setProgress(stage, bytes, total)
}

// Config is the exact permission file the gate law prescribes for the 2.x
// agent. v1.58.2 THE OPEN HANDS (PLAN-V158 §2): the DENY-everything shackles
// are DEAD — the user's law is 1:1 native parity ("full access as a real
// user"), and the v157 live probes proved open hands pass the free gate
// (permissive config, real turns, cost 0). The V2 RULES-ARRAY grammar
// (live-captured from the docs): ordered {action, resource, effect} rules,
// LAST-MATCH-WINS, layered ON TOP of the agent's own base policy
// ({"action":"*","resource":"*","effect":"allow"} — the shipped default),
// so everything unmatched stays allowed. Our rules carve only the honest
// exceptions:
//   · question deny — a serve turn has no human to answer an ask; deny
//     answers the agent honestly instead of hanging headlessly.
//   · doomalay_* allow — THE WIDE SHELF belt: the app's MCP tools (the
//     direct-tool permission action is <server>_<tool>, the docs' own
//     grammar) are explicitly, visibly allowed — never hostage to an
//     upstream default-policy change.
//   · *.env / *.env.* reads deny — the honest secrets line (API keys live
//     in .env files; a deny teaches, an ask would hang).
// websearch rides the serve's own authenticated account through the tavily
// provider selection (R5 — the device's "Web search cancelled" disease was
// the missing provider selection; NO tavily key needed, live-proven).
const permissionConfig = `{
  "$schema": "https://opencode.ai/config.json",
  "permissions": [
    { "action": "question", "resource": "*", "effect": "deny" },
    { "action": "doomalay_*", "resource": "*", "effect": "allow" },
    { "action": "read", "resource": "*.env", "effect": "deny" },
    { "action": "read", "resource": "*.env.*", "effect": "deny" }
  ],
  "websearch": { "provider": "tavily" }
}`

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

// SessionExists answers whether the serve still holds the session (v1.59.2
// THE SERVE MEMORY — the adoption check). The 2.x serve's sessions are
// durable in its own SQLite, so a binding that survived an engine restart
// usually points at a LIVING session. THE SHAPE GUARD: the 2.x router
// falls through unknown /api/* routes to the bundled web IDE (HTTP 200 +
// HTML — the SDK's own version-mismatch trap), so a 200 is only proof when
// the body is JSON carrying the session's own id. 404 = honestly gone;
// anything else = not provable → false (the caller self-heals a fresh
// session + the opening text — never a hard failure).
func (m *Manager) SessionExists(serveSess string) bool {
        if serveSess == "" {
                return false
        }
        m.mu.Lock()
        base, pw := m.baseURL, m.serverPassword
        m.mu.Unlock()
        if base == "" {
                return false
        }
        ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
        defer cancel()
        req, err := http.NewRequestWithContext(ctx, http.MethodGet, base+"/api/session/"+serveSess, nil)
        if err != nil {
                return false
        }
        req.Header.Set("Accept", "application/json")
        req.Header.Set("Authorization", "Basic "+basicAuth("opencode", pw))
        resp, err := http.DefaultClient.Do(req)
        if err != nil {
                return false
        }
        defer resp.Body.Close()
        if resp.StatusCode == 404 {
                return false
        }
        if resp.StatusCode != 200 {
                return false
        }
        var out struct {
                Data struct {
                        ID string `json:"id"`
                } `json:"data"`
        }
        if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&out); err != nil {
                return false // HTML or any non-JSON body — the SPA trap, not a session
        }
        return out.Data.ID == serveSess
}

// SessionDirectory answers the serve session's CURRENT working directory
// (GET /api/session/{id} → data.directory — the projector's own row; the
// same GET SessionExists probes). v1.64.1 THE NATIVE SHELF: the adoption
// path needs it to decide whether a persisted binding's session still
// lives in its per-chat config directory — an unmoved adoptee resolves
// the serve's ROOT config (permissions only, NO mcp block: the device's
// own conviction — 30 tools running at /mcp/oc/<id>, zero of them in the
// session's tool schema).
//
//      dir, true            → the session's directory ("" is a legal value:
//                             a root-location session on builds that omit it)
//      "", false            → the session/serve is unreachable (the caller
//                             treats it as today: no move, honest bound=false)
func (m *Manager) SessionDirectory(serveSess string) (string, bool) {
        if serveSess == "" {
                return "", false
        }
        m.mu.Lock()
        base, pw := m.baseURL, m.serverPassword
        m.mu.Unlock()
        if base == "" {
                return "", false
        }
        ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
        defer cancel()
        req, err := http.NewRequestWithContext(ctx, http.MethodGet, base+"/api/session/"+serveSess, nil)
        if err != nil {
                return "", false
        }
        req.Header.Set("Accept", "application/json")
        req.Header.Set("Authorization", "Basic "+basicAuth("opencode", pw))
        resp, err := http.DefaultClient.Do(req)
        if err != nil {
                return "", false
        }
        defer resp.Body.Close()
        if resp.StatusCode != 200 {
                return "", false
        }
        var out struct {
                Data struct {
                        ID        string `json:"id"`
                        Directory string `json:"directory"`
                } `json:"data"`
        }
        if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&out); err != nil {
                return "", false // HTML or any non-JSON body — the SPA trap, not a session
        }
        if out.Data.ID != serveSess {
                return "", false // the shape guard's law: only proof counts
        }
        return out.Data.Directory, true
}

// SessionIdleSince polls the session's OWN durable record — the last
// messages (GET /api/session/{id}/message?limit=2, newest first). It answers
// whether the turn that started at sinceMs has ALREADY ENDED off-wire (the
// v1.59.2 NO-HANG GUARD: the global /api/event stream is volatile — events
// fired before the stream connects are missed, and an instantly-failed turn
// would otherwise hang the pump forever). ended=true means the newest
// message is an idle marker NEWER than sinceMs; failed carries the idle
// outcome (with errType/errMsg for the honest error), and a non-failed
// ending carries the assistant text (the off-wire success path).
func (m *Manager) SessionIdleSince(serveSess string, sinceMs int64) (ended, failed bool, errType, errMsg, assistantText string) {
        if serveSess == "" {
                return false, false, "", "", ""
        }
        m.mu.Lock()
        base, pw := m.baseURL, m.serverPassword
        m.mu.Unlock()
        if base == "" {
                return false, false, "", "", ""
        }
        ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
        defer cancel()
        req, err := http.NewRequestWithContext(ctx, http.MethodGet, base+"/api/session/"+serveSess+"/message?limit=2", nil)
        if err != nil {
                return false, false, "", "", ""
        }
        req.Header.Set("Accept", "application/json")
        req.Header.Set("Authorization", "Basic "+basicAuth("opencode", pw))
        resp, err := http.DefaultClient.Do(req)
        if err != nil {
                return false, false, "", "", ""
        }
        defer resp.Body.Close()
        if resp.StatusCode != 200 {
                return false, false, "", "", ""
        }
        var out struct {
                Data []struct {
                        Type    string `json:"type"`
                        Time    struct {
                                Created int64 `json:"created"`
                        } `json:"time"`
                        Outcome string `json:"outcome"`
                        Error   *struct {
                                Type    string `json:"type"`
                                Message string `json:"message"`
                        } `json:"error"`
                        Text string `json:"text"`
                } `json:"data"`
        }
        if err := json.NewDecoder(io.LimitReader(resp.Body, 4<<20)).Decode(&out); err != nil {
                return false, false, "", "", "" // HTML or any non-JSON body — not an answer
        }
        if len(out.Data) == 0 {
                return false, false, "", "", ""
        }
        newest := out.Data[0]
        // >= not >: an instant failure lands its idle marker in the SAME
        // millisecond the turn started (live-observed: the no-route failure
        // fired ~5ms after the prompt, often the same ms as the stamp). The
        // false-positive guard is the SILENCE window itself — the probe only
        // fires well into the turn, and a PREVIOUS turn's idle marker can
        // only collide when that turn ended the very ms this one started
        // (the serve serializes prompts per session; the recycle births a
        // FRESH session anyway).
        if newest.Type != "idle" || newest.Time.Created < sinceMs {
                return false, false, "", "", "" // still running (or a PREVIOUS turn's idle)
        }
        if newest.Outcome == "failed" || newest.Outcome == "interrupted" {
                // v1.64.2 THE LIVING WIRE: the idle marker carries outcome ∈
                // succeeded|failed|interrupted (the 2.x schema, live-verified) —
                // an INTERRUPTED turn (a serve-side stop/shutdown) is an honest
                // failure, never the empty-text "success" the old code answered
                // (an empty assistant + a bare idle terminal: the turn just
                // evaporated for the user).
                et, em := "", ""
                if newest.Error != nil {
                        et, em = newest.Error.Type, newest.Error.Message
                }
                if newest.Outcome == "interrupted" {
                        et, em = "interrupted", "the turn was interrupted on the serve (a stop or shutdown)"
                }
                return true, true, et, em, ""
        }
        // the off-wire success: the assistant message rides just under the idle
        at := ""
        if len(out.Data) > 1 && out.Data[1].Type == "assistant" {
                at = out.Data[1].Text
        }
        return true, false, "", "", at
}

// InterruptSession cancels an in-flight turn serve-side — v1.67.1 THE
// INTERRUPT HAND (PLAN-V167 §v1.67.1). Researched against the v2 API
// (opencode.ai/v2/docs/api, sst/opencode v2.1.4 packages/protocol/src/
// groups/session.ts): POST /api/session/{id}/interrupt, empty body, answers
// 200 {"interrupted":bool} — the v2 abort (v1's /abort route does not exist
// here). The interrupt only works on turns owned by THIS serve process and
// resolves once the interruption is ACCEPTED (cleanup settles async); the
// durable session.execution.interrupted event rides the feed right after.
// Best-effort by contract: the caller logs the verdict, never blocks the
// recovery on it (a session whose interrupt fails is recycled instead —
// DeleteSession + a fresh birth).
func (m *Manager) InterruptSession(serveSess string) (bool, error) {
        if serveSess == "" {
                return false, errors.New("ocserve: empty session id")
        }
        m.mu.Lock()
        base, pw := m.baseURL, m.serverPassword
        m.mu.Unlock()
        if base == "" {
                return false, errors.New("ocserve: not running")
        }
        ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
        defer cancel()
        req, err := http.NewRequestWithContext(ctx, http.MethodPost, base+"/api/session/"+serveSess+"/interrupt", nil)
        if err != nil {
                return false, err
        }
        req.Header.Set("Accept", "application/json")
        req.Header.Set("Authorization", "Basic "+basicAuth("opencode", pw))
        resp, err := http.DefaultClient.Do(req)
        if err != nil {
                return false, err
        }
        defer resp.Body.Close()
        body, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
        if resp.StatusCode >= 200 && resp.StatusCode < 300 {
                var out struct {
                        Interrupted bool `json:"interrupted"`
                }
                _ = json.Unmarshal(body, &out) // the 200 body carries the verdict
                return out.Interrupted, nil
        }
        msg := string(body)
        if len(msg) > 120 {
                msg = msg[:120]
        }
        return false, fmt.Errorf("ocserve interrupt session: HTTP %d, body %q", resp.StatusCode, msg)
}

// SessionTailToolStates answers, for the session's most recent
// still-unresolved tools, the durable record's own verdict per call ID —
// v1.67.2 THE UNLOST MID-TURN's probe half: which call IDs the transcript
// holds (name + status + the joined text) so the pump can diff its live
// emission against the serve's truth. Newest-first walk, bounded by the
// newest idle marker: the current turn's window only.
func (m *Manager) SessionTailToolStates(serveSess string) map[string]ServeToolState {
        out := map[string]ServeToolState{}
        if serveSess == "" {
                return out
        }
        msgs, err := m.ListSessionMessages(serveSess, 4)
        if err != nil {
                return out
        }
        // chronological (oldest-first): walk BACK from the newest, stop at
        // the newest idle marker — everything above it is THIS turn's window
        for i := len(msgs) - 1; i >= 0; i-- {
                msg := msgs[i]
                if msg.Type == "idle" {
                        break
                }
                for _, part := range msg.Content {
                        if part.Type != "tool" || part.ID == "" {
                                continue
                        }
                        st := ServeToolState{ID: part.ID, Name: part.Name, Status: "pending"}
                        if part.State != nil {
                                st.Status = part.State.Status
                                for _, c := range part.State.Content {
                                        st.Text += c.Text
                                        if st.Text != "" {
                                                st.Text += "\n"
                                        }
                                }
                                if part.State.Error != nil {
                                        st.ErrType = part.State.Error.Type
                                        st.ErrMsg = part.State.Error.Message
                                }
                                if part.State.Metadata != nil && part.State.Metadata.Truncated != nil {
                                        st.Truncated = *part.State.Metadata.Truncated
                                }
                                st.Input = string(part.State.Input)
                        }
                        out[part.ID] = st
                }
        }
        return out
}

// ServeToolState — the durable record's verdict for ONE tool call
// (v1.67.2): the ID, the bare name, the status (running|pending|
// completed|error), the joined result text, the error shape, the serve's
// own truncated flag, and the raw input JSON (the re-emit path's args).
type ServeToolState struct {
        ID        string
        Name      string
        Status    string
        Text      string
        ErrType   string
        ErrMsg    string
        Truncated bool
        Input     string
}

// SessionNewestAt answers the durable record's newest message stamp
// (created ms; 0 = unreadable/empty) — v1.67.1's stall-ceiling half: the
// record itself moving (a message landing) is LIFE, exactly like a live
// frame; absolute silence (neither feed nor record) is the zombie's
// signature.
func (m *Manager) SessionNewestAt(serveSess string) int64 {
        if serveSess == "" {
                return 0
        }
        msgs, err := m.ListSessionMessages(serveSess, 1)
        if err != nil || len(msgs) == 0 {
                return 0
        }
        newest := msgs[len(msgs)-1]
        at := newest.Time.Created
        if newest.Time.Completed > at {
                at = newest.Time.Completed
        }
        if at <= 0 {
                at = newest.Time.Created
        }
        return at
}

// SessionInFlight answers whether the session's durable tail is a
// still-unterminated turn (newest message is NOT an idle marker) and that
// newest message's stamp — v1.67.1 THE ZOMBIE GUARD's probe: a previous
// turn whose pump died engine-side (a restart, a cancel, an off-wire
// terminal) leaves the serve-side turn running; a NEW prompt on the same
// session queues behind it forever ("the chat throttled and halted").
func (m *Manager) SessionInFlight(serveSess string) (bool, int64) {
        if serveSess == "" {
                return false, 0
        }
        msgs, err := m.ListSessionMessages(serveSess, 1)
        if err != nil || len(msgs) == 0 {
                return false, 0
        }
        newest := msgs[len(msgs)-1]
        if newest.Type == "idle" {
                return false, newest.Time.Created
        }
        at := newest.Time.Created
        if at <= 0 {
                at = newest.Time.Completed
        }
        return true, at
}

// DeleteSession removes a serve-side session (v1.59.2: the chat-delete
// path's best-effort cleanup — a deleted app chat must not leave its serve
// twin behind). LIVE-PROBED against the pinned 2.1.2: DELETE
// /api/session/{id} answers 204 and the session is GONE (a follow-up GET
// answers 404 SessionNotFoundError; a second DELETE answers 404) — the
// legacy DELETE /session/{id} answers 405 on this build and is NOT used.
// Best-effort by contract: the caller logs, never blocks.
func (m *Manager) DeleteSession(serveSess string) error {
        if serveSess == "" {
                return errors.New("ocserve: empty session id")
        }
        m.mu.Lock()
        base, pw := m.baseURL, m.serverPassword
        m.mu.Unlock()
        if base == "" {
                return errors.New("ocserve: not running")
        }
        ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
        defer cancel()
        req, err := http.NewRequestWithContext(ctx, http.MethodDelete, base+"/api/session/"+serveSess, nil)
        if err != nil {
                return err
        }
        req.Header.Set("Accept", "application/json")
        req.Header.Set("Authorization", "Basic "+basicAuth("opencode", pw))
        resp, err := http.DefaultClient.Do(req)
        if err != nil {
                return err
        }
        defer resp.Body.Close()
        body, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
        if resp.StatusCode >= 200 && resp.StatusCode < 300 {
                return nil // 204 = deleted (the live-probed truth)
        }
        msg := string(body)
        if len(msg) > 120 {
                msg = msg[:120]
        }
        return fmt.Errorf("ocserve delete session: HTTP %d, body %q", resp.StatusCode, msg)
}

// ServeContentPart is one part of a serve transcript message's content
// (v1.64.3 THE UNLOST TAIL — the shapes LIVE-CAPTURED against the pinned
// 2.1.2 with a real tool-using turn):
//
//      {"type":"reasoning","text":…,"native":{…},"time":{created,completed}}
//      {"type":"tool","id":"call_…","name":"read","executed":bool,
//       "state":{"status":"completed"|"error"|"running"|"pending",
//                "input":{…},"content":[{"type":"text","text":…}],
//                "metadata":{"truncated":bool},"error":{"type":…,"message":…}},
//       "time":{created,ran,completed}}
//      {"type":"text","text":…}
type ServeContentPart struct {
        Type string `json:"type"`
        Text string `json:"text"`
        ID   string `json:"id"`
        Name string `json:"name"`
        State *struct {
                Status   string          `json:"status"`
                Input    json.RawMessage `json:"input"`
                Content  []struct {
                        Type string `json:"type"`
                        Text string `json:"text"`
                } `json:"content"`
                Metadata *struct {
                        Truncated *bool `json:"truncated"`
                } `json:"metadata"`
                Error *struct {
                        Type    string `json:"type"`
                        Message string `json:"message"`
                } `json:"error"`
        } `json:"state"`
        Time *struct {
                Created   int64 `json:"created"`
                Ran       int64 `json:"ran"`
                Completed int64 `json:"completed"`
        } `json:"time"`
}

// ServeMessage is one entry of the serve's durable transcript
// (GET /api/session/{id}/message — newest-first, cursor-paginated).
// Types live-captured: user (top-level text) · assistant (content parts,
// model, tokens, cost, finish) · idle (the turn marker: outcome ∈
// succeeded|failed|interrupted + error) · model-switched. The whole-truth
// law: unknown types ride the list untouched — the mapper degrades them
// honestly, never drops them silently.
type ServeMessage struct {
        Type    string `json:"type"`
        Text    string `json:"text"`
        ID      string `json:"id"`
        Agent   string `json:"agent"`
        Content []ServeContentPart `json:"content"`
        Finish  string `json:"finish"`
        Model   *struct {
                ID         string `json:"id"`
                ProviderID string `json:"providerID"`
                Variant    string `json:"variant"`
        } `json:"model"`
        Tokens *struct {
                Input    int64 `json:"input"`
                Output   int64 `json:"output"`
                Reasoning int64 `json:"reasoning"`
                Cache    struct {
                        Read  int64 `json:"read"`
                        Write int64 `json:"write"`
                } `json:"cache"`
        } `json:"tokens"`
        Cost    *float64 `json:"cost"`
        Outcome string   `json:"outcome"`
        Error   *struct {
                Type    string `json:"type"`
                Message string `json:"message"`
                Status  int    `json:"status"`
        } `json:"error"`
        Time struct {
                Created    int64 `json:"created"`
                Streaming  int64 `json:"streamed"`
                Completed  int64 `json:"completed"`
        } `json:"time"`
}

// ListSessionMessages walks the serve's DURABLE transcript (the whole
// truth — v1.64.3 THE SERVE TRUTH RECONCILE's source) and answers it in
// CHRONOLOGICAL order (oldest-first). The wire is newest-first with
// base64 cursor pagination (live-probed: ?limit=N returns the newest N;
// ?cursor=<cursor.next> walks older); this reader reverses each page and
// stops when the cursor runs out. Bounded: maxPages × perPage entries
// (the reconcile's turn window is small; a runaway transcript answers
// what it holds — the caller's own bounds apply).
func (m *Manager) ListSessionMessages(serveSess string, maxPages int) ([]ServeMessage, error) {
        if serveSess == "" {
                return nil, errors.New("ocserve: empty session id")
        }
        m.mu.Lock()
        base, pw := m.baseURL, m.serverPassword
        m.mu.Unlock()
        if base == "" {
                return nil, errors.New("ocserve: not running")
        }
        if maxPages <= 0 {
                maxPages = 4
        }
        const perPage = 100 // live-probed: the serve 400s past ~200 — 100 is the safe page
        var chrono []ServeMessage
        cursor := ""
        for page := 0; page < maxPages; page++ {
                u := fmt.Sprintf("%s/api/session/%s/message?limit=%d", base, serveSess, perPage)
                if cursor != "" {
                        u += "&cursor=" + url.QueryEscape(cursor)
                }
                ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
                req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
                if err != nil {
                        cancel()
                        return nil, err
                }
                req.Header.Set("Accept", "application/json")
                req.Header.Set("Authorization", "Basic "+basicAuth("opencode", pw))
                resp, err := http.DefaultClient.Do(req)
                if err != nil {
                        cancel()
                        return nil, err
                }
                var out struct {
                        Data []ServeMessage `json:"data"`
                        Cursor struct {
                                Next string `json:"next"`
                        } `json:"cursor"`
                }
                decodeErr := json.NewDecoder(io.LimitReader(resp.Body, 32<<20)).Decode(&out)
                resp.Body.Close()
                cancel()
                if resp.StatusCode != 200 {
                        return nil, fmt.Errorf("ocserve list messages: HTTP %d", resp.StatusCode)
                }
                if decodeErr != nil {
                        return nil, fmt.Errorf("ocserve list messages: %w", decodeErr)
                }
                // the wire is newest-first — reverse into chronological order
                for i := len(out.Data) - 1; i >= 0; i-- {
                        chrono = append(chrono, out.Data[i])
                }
                if len(out.Data) < perPage || out.Cursor.Next == "" {
                        break // the head — everything rides
                }
                cursor = out.Cursor.Next
        }
        return chrono, nil
}

// ScratchDir answers the serve's scratch directory (its cwd/HOME — where
// the global opencode.json lives). v1.58.2 THE WIDE SHELF: the server layer
// writes each app chat's PER-CHAT config directory under it.
func (m *Manager) ScratchDir() string {
        if m.dataDir == "" {
                return ""
        }
        return filepath.Join(m.dataDir, "opencode-serve")
}

// ViaTermux answers whether this serve lives in the Termux guest room (the
// Android pocket bridge) — v1.58.2 THE TERMUX AUTO-ENABLE: a chat running
// through the pocket bridge HAS the device's termux capability by
// construction; the engine self-heals the per-chat flag so the gates + the
// chip reflect the truth.
func (m *Manager) ViaTermux() bool {
        m.mu.Lock()
        defer m.mu.Unlock()
        return m.termux != nil
}

// MoveSession moves a serve session into a directory — v1.58.2 THE WIDE
// SHELF's per-chat binding vehicle (live-probed against the real 2.1.2:
// POST /api/session/{id}/move {"directory": …} is accepted and the moved
// session re-resolves THAT directory's opencode.json — the per-session MCP
// attach that gives every app chat its own X-Doomalay-Session binding,
// concurrency-safe by construction: one config dir per chat).
func (m *Manager) MoveSession(serveSess, dir string) error {
        m.mu.Lock()
        base, pw := m.baseURL, m.serverPassword
        m.mu.Unlock()
        if base == "" {
                return errors.New("ocserve: not running")
        }
        body, _ := json.Marshal(map[string]any{"directory": dir})
        ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
        defer cancel()
        req, err := http.NewRequestWithContext(ctx, http.MethodPost, base+"/api/session/"+serveSess+"/move", strings.NewReader(string(body)))
        if err != nil {
                return err
        }
        req.Header.Set("Content-Type", "application/json")
        req.Header.Set("Authorization", "Basic "+basicAuth("opencode", pw))
        resp, err := http.DefaultClient.Do(req)
        if err != nil {
                return err
        }
        defer resp.Body.Close()
        if resp.StatusCode >= 300 {
                return fmt.Errorf("ocserve move session: HTTP %d", resp.StatusCode)
        }
        _, _ = io.Copy(io.Discard, resp.Body)
        return nil
}

// CreateSessionInDir creates a session AND moves it into dir in one call —
// the per-chat binding law (the config dir must be resolved before the
// first prompt; the move is the live-proven attach vehicle). A failed move
// returns the error honestly: a mis-bound session would answer another
// chat's tools — the caller drops it (the recycle law).
func (m *Manager) CreateSessionInDir(title, dir string) (string, error) {
        id, err := m.CreateSession(title)
        if err != nil {
                return "", err
        }
        if err := m.MoveSession(id, dir); err != nil {
                return id, err
        }
        return id, nil
}

// WriteServeFile writes a file UNDER the serve's scratch tree on the
// platform the serve actually runs on — v1.58.2 THE WIDE SHELF's per-chat
// config vehicle. Desktop (exec child): the plain engine filesystem (the
// scratch IS an engine-side dir). Android (termux child): the jailed
// exec's `cat >` heredoc under $HOME/.doomalay/opencode-serve/ (the
// tmCmdWriteConfig law — RunWithStdin carries the bytes, zero-escaping;
// the command's mkdir -p builds the parent first). relPath is
// slash-separated and NEVER escapes the tree (path.Clean + the .. refuse).
func (m *Manager) WriteServeFile(relPath, content string) error {
        clean := path.Clean(relPath)
        if strings.HasPrefix(clean, "..") || path.IsAbs(clean) || strings.HasPrefix(clean, "/") {
                return fmt.Errorf("ocserve: serve file refuses an escaping path: %q", relPath)
        }
        m.mu.Lock()
        termux := m.termux
        m.mu.Unlock()
        if termux != nil {
                cmd := fmt.Sprintf("mkdir -p \"$(dirname \"$HOME/.doomalay/opencode-serve/%s\")\" && cat > \"$HOME/.doomalay/opencode-serve/%s\"", clean, clean)
                res, err := termux.RunWithStdin(context.Background(), cmd, "", 30_000, content)
                if err != nil {
                        return err
                }
                if res == nil || !res.Ok || res.ExitCode != 0 {
                        exit, stderr := -1, "no result"
                        if res != nil {
                                exit, stderr = res.ExitCode, res.Stderr
                        }
                        return fmt.Errorf("ocserve: termux serve write failed (exit %d): %s", exit, stderr)
                }
                return nil
        }
        scratch := m.ScratchDir()
        if scratch == "" {
                return errors.New("ocserve: no scratch dir")
        }
        full := filepath.Join(scratch, filepath.FromSlash(clean))
        if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
                return err
        }
        return os.WriteFile(full, []byte(content), 0o644)
}

// ServeDir answers the ABSOLUTE path of a scratch subtree AS THE SERVE SEES
// IT — the move API (POST /api/session/{id}/move {"directory": …}) needs
// the serve's own filesystem truth, which differs by platform: desktop
// (exec child) the engine path IS the serve's path; Android (termux child)
// the jailed exec expands $HOME (the Play/F-Droid layouts differ — NEVER a
// hard-coded prefix; the echo answers the real path through the bridge).
func (m *Manager) ServeDir(relPath string) (string, error) {
        clean := path.Clean(relPath)
        if strings.HasPrefix(clean, "..") || path.IsAbs(clean) || strings.HasPrefix(clean, "/") {
                return "", fmt.Errorf("ocserve: serve dir refuses an escaping path: %q", relPath)
        }
        m.mu.Lock()
        termux := m.termux
        scratch := filepath.Join(m.dataDir, "opencode-serve")
        m.mu.Unlock()
        if termux != nil {
                res, err := termux.Run(context.Background(),
                        fmt.Sprintf("echo -n \"$HOME/.doomalay/opencode-serve/%s\"", clean), "", 15_000)
                if err != nil {
                        return "", err
                }
                if res == nil || !res.Ok {
                        return "", errors.New("ocserve: termux serve dir resolve failed")
                }
                dir := strings.TrimSpace(res.Stdout)
                if dir == "" {
                        return "", errors.New("ocserve: termux serve dir resolve answered empty")
                }
                return dir, nil
        }
        abs, err := filepath.Abs(filepath.Join(scratch, filepath.FromSlash(clean)))
        if err != nil {
                return "", err
        }
        return abs, nil
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

// ServeModel is one entry of the serve's own catalogue (GET /api/model —
// the genuine client's LIVE model list: ids, limits, cost, variants, the
// per-model effort ladders). v1.55.3 THE LIVING CATALOG: this is the
// device-local truth that merges into the engine's opencode group when a
// bridge is up (limits/cost/variants straight from the client the turns
// actually ride).
type ServeModel struct {
        ID         string          `json:"id"`
        ModelID    string          `json:"modelID"`
        ProviderID string          `json:"providerID"`
        Name       string          `json:"name"`
        Status     string          `json:"status"`
        Limit      struct {
                Context int64 `json:"context"`
                Input   int64 `json:"input"`
                Output  int64 `json:"output"`
        } `json:"limit"`
        Cost []struct {
                Input  float64 `json:"input"`
                Output float64 `json:"output"`
                Cache  struct {
                        Read  float64 `json:"read"`
                        Write float64 `json:"write"`
                } `json:"cache"`
        } `json:"cost"`
        Variants []struct {
                ID       string `json:"id"`
                Settings struct {
                        ReasoningEffort string `json:"reasoningEffort"`
                } `json:"settings"`
        } `json:"variants"`
        Capabilities struct {
                Tools bool `json:"tools"`
        } `json:"capabilities"`
        Compatibility struct {
                ReasoningField string `json:"reasoningField"`
        } `json:"compatibility"`
}

// LiveCatalog answers the serve's own model catalogue (nil = the serve is
// down or answered a shape we don't speak — the hosted list stands alone).
// Only opencode-zen entries ride (the serve also lists the Go workspace's
// models under providerID opencode-go — a different entitlement surface).
func (m *Manager) LiveCatalog() []ServeModel {
        m.mu.Lock()
        base, pw := m.baseURL, m.serverPassword
        m.mu.Unlock()
        if base == "" {
                return nil
        }
        ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
        defer cancel()
        req, err := http.NewRequestWithContext(ctx, http.MethodGet, base+"/api/model", nil)
        if err != nil {
                return nil
        }
        req.Header.Set("Accept", "application/json")
        req.Header.Set("Authorization", "Basic "+basicAuth("opencode", pw))
        resp, err := http.DefaultClient.Do(req)
        if err != nil {
                return nil
        }
        defer resp.Body.Close()
        if resp.StatusCode != 200 {
                return nil
        }
        var out struct {
                Data []ServeModel `json:"data"`
        }
        if err := json.NewDecoder(io.LimitReader(resp.Body, 8<<20)).Decode(&out); err != nil {
                return nil
        }
        var models []ServeModel
        for _, sm := range out.Data {
                if sm.ProviderID != "opencode" || strings.EqualFold(sm.Status, "deprecated") {
                        continue
                }
                models = append(models, sm)
        }
        return models
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
        SessionID          string            `json:"sessionID"`
        AssistantMessageID string            `json:"assistantMessageID"`
        Agent              string            `json:"agent"`
        Model              eventModel        `json:"model"`
        Ordinal            int               `json:"ordinal"`
        Delta              string            `json:"delta"`   // reasoning./text. delta payload
        Text               string            `json:"text"`    // text.ended full text; tool.input.ended serialized input
        Name               string            `json:"name"`    // tool.input.started tool name
        ID                 string            `json:"id"`      // the tool call id
        Input              json.RawMessage   `json:"input"`   // tool.called
        Content            []toolContent     `json:"content"` // tool.success/failed
        Finish             string            `json:"finish"`
        Cost               float64           `json:"cost"`
        Tokens             eventTokens       `json:"tokens"`
        Error              *eventError       `json:"error"`
        // v1.58.1 THE INFORMATIVE PILL: the serve streams LIVE progress and
        // an honest truncation verdict on the tool frames — metadata.toolCalls
        // (Code Mode's nested calls with status), metadata.shellID (a live
        // shell session), metadata.truncated (the serve shortened the
        // result itself — surfaced to the user, never silently dropped).
        Metadata EventToolMetadata `json:"metadata"`
}

// EventToolMetadata is the tool frames' metadata block (live-captured:
// the execute frames carry toolCalls[]; the shell frames carry shellID;
// the success frames carry the truncated verdict). Exported for the
// server package's pill derivation (v1.57.1).
type EventToolMetadata struct {
        ToolCalls []EventToolCallStatus `json:"toolCalls"`
        ShellID   string                `json:"shellID"`
        Truncated *bool                 `json:"truncated"`
}

// EventToolCallStatus is one Code Mode nested call's live status.
type EventToolCallStatus struct {
        Tool   string          `json:"tool"`
        Status string          `json:"status"`
        Input  json.RawMessage `json:"input"`
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
        // v1.67.1: session.execution.interrupted is a TERMINAL too (the
        // documented durable trio succeeded|failed|interrupted — the stall
        // ceiling's interrupt and every serve-side stop end the turn here).
        return e.Type == "session.execution.succeeded" || e.Type == "session.execution.failed" ||
                e.Type == "session.execution.interrupted"
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

// ocStreamByteDeadline is how long the event stream may stay byte-silent
// before the connection is convicted dead and reconnected (v1.64.2 THE
// LIVING WIRE). The 2.x serve sends an SSE `: heartbeat` comment every 15s
// and the first frame is server.connected (live-verified, 2026-10-22) —
// 45s without a byte (3 missed heartbeats, the official client's own idle
// law) means the TCP session is a corpse: the old reader blocked in
// ReadString FOREVER while the turn kept running serve-side, the pump's
// durable probe honestly answered "still running", and the user watched a
// static thinking pill for minutes ("one chat has the thinking pill for
// so long, another gets a direct reply" — whichever connection survived).
var ocStreamByteDeadline = 45 * time.Second

// StreamEvents consumes the serve's SSE feed until the turn's terminal
// (session.execution.succeeded / .failed — this session's frames only),
// the ctx dies, or a HARD error (auth, an unexpected status) breaks it.
//
// v1.64.2 THE LIVING WIRE: connection deaths mid-turn no longer end the
// stream — a broken/dead/silent connection RECONNECTS (bounded backoff,
// 250ms→2s) until the terminal lands on a live wire or the ctx dies. The
// bus is global + multi-subscriber (a Set of per-connection queues,
// live-verified) so a fresh connection keeps receiving this session's
// frames; frames missed during the gap are covered by the pump's durable
// record probe (the volatile contract — SessionIdleSince owns the end
// state) and the byte watchdog (ocStreamByteDeadline) convicts a silently
// dead connection the heartbeat would have exposed.
func (m *Manager) StreamEvents(ctx context.Context, serveSess string, onEvent func(Event) error) error {
        backoff := 250 * time.Millisecond
        for {
                terminal, err := m.streamOnce(ctx, serveSess, onEvent)
                if terminal || err != nil {
                        return err
                }
                // the connection died without a terminal — reconnect until the
                // turn's truth lands (the ctx guard honors Stop/shutdown).
                select {
                case <-ctx.Done():
                        return ctx.Err()
                case <-time.After(backoff):
                }
                if backoff < 2*time.Second {
                        backoff *= 2
                }
        }
}

// streamOnce is ONE SSE connection of the StreamEvents loop. It answers
// terminal=true when this session's terminal frame rode the wire (the
// caller returns), terminal=false + nil error for a RECONNECTABLE death
// (network break, the byte watchdog, the slow-consumer overflow — the
// 2.x bus drops a subscriber past 4096 queued frames), and a non-nil
// error for hard failures (the parent ctx, an HTTP status a retry cannot
// fix). onEvent gets every parsed frame in arrival order; the session
// filter (the handshake server.connected + foreign frames ride the same
// wire) is the same law as ever.
func (m *Manager) streamOnce(ctx context.Context, serveSess string, onEvent func(Event) error) (terminal bool, err error) {
        m.mu.Lock()
        base, pw := m.baseURL, m.serverPassword
        m.mu.Unlock()
        if base == "" {
                return false, errors.New("ocserve: not running")
        }
        sctx, cancel := context.WithCancel(ctx)
        defer cancel()
        req, err := http.NewRequestWithContext(sctx, http.MethodGet, base+"/api/event", nil)
        if err != nil {
                return false, err
        }
        req.Header.Set("Accept", "text/event-stream")
        req.Header.Set("Authorization", "Basic "+basicAuth("opencode", pw))
        resp, err := http.DefaultClient.Do(req)
        if err != nil {
                if ctx.Err() != nil {
                        return false, ctx.Err()
                }
                return false, nil // the serve hiccuped — reconnectable
        }
        defer resp.Body.Close()
        if resp.StatusCode >= 300 {
                return false, fmt.Errorf("ocserve event stream: HTTP %d", resp.StatusCode)
        }
        // THE BYTE WATCHDOG: the serve heartbeats every 15s; a connection
        // silent past ocStreamByteDeadline is dead — cancel the request so
        // the blocked read unblocks and the outer loop reconnects.
        var lastByte atomic.Int64
        lastByte.Store(time.Now().UnixMilli())
        watchDone := make(chan struct{})
        defer close(watchDone)
        go func() {
                tick := time.NewTicker(5 * time.Second)
                defer tick.Stop()
                for {
                        select {
                        case <-watchDone:
                                return
                        case <-tick.C:
                                if time.Since(time.UnixMilli(lastByte.Load())) > ocStreamByteDeadline {
                                        cancel()
                                        return
                                }
                        }
                }
        }()
        r := bufio.NewReader(resp.Body)
        for {
                line, rerr := r.ReadString('\n')
                if rerr != nil {
                        if ctx.Err() != nil {
                                return false, ctx.Err()
                        }
                        // the watchdog fired, the socket reset, or the serve
                        // closed — all reconnectable (the loop owns the terminal)
                        return false, nil
                }
                lastByte.Store(time.Now().UnixMilli())
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
                        return false, err
                }
                if ev.IsTerminal() {
                        return true, nil
                }
        }
}
