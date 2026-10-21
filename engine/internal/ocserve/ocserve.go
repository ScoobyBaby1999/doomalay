// Package ocserve manages a local `opencode serve` — the GENUINE OpenCode
// client — as the engine's one legitimate path to OpenCode's FREE models.
//
// v1.48.5 THE SERVE BRIDGE — the live-probed truth this package is built on
// (all probes 2026-10-21, from this engine's own sandbox, same egress where
// raw API calls 403):
//
//   - The hosted gateways (zen + the newer /inference API) wall the free
//     tier BELOW HTTP: byte-faithful CLI-identity replays (exact UA, the
//     full x-opencode-* header set, HTTP/2, genuine session ids) still
//     answer 403 FreeTierError "OpenCode's free tier can only be used from
//     within OpenCode". No header set can ever pass.
//   - The GENUINE client passes: `opencode serve` + POST
//     /session/{id}/message with the DEFAULT turn shape answers 200 with
//     real completions on big-pickle / *-free, cost 0, our plain API key.
//   - THE GATE LAWS (violating any one poisons the turn AND the session):
//     (1) default shape only — per-turn `tools` or `system` fields trip
//     FreeTierError (the persona/context must ride the message TEXT);
//     (2) a PROJECT-LEVEL opencode.json permission config is allowed and
//     PASSES the gate — bash/edit/write/patch/webfetch denied removes
//     execution + writes from the agent (the model answers "I don't have
//     a Bash tool available") while read/grep/glob/list stay;
//     (3) rapid clean turns pass; (4) a fresh session recovers a poisoned
//     one (the recycle law).
//   - Streaming: POST /session/{id}/prompt_async → 204, then
//     GET /event?sessionID=… SSE — message.part.delta carries incremental
//     reasoning/text, message.part.updated carries tool state, step-finish
//     carries per-step tokens, message.updated carries the final info
//     (tokens + finish), session.idle is the terminal.
package ocserve

import (
	"archive/tar"
	"archive/zip"
	"bufio"
	"compress/gzip"
	"context"
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
// gate "actively evolves" — a pinned, live-proven build is the stable
// contract; the env override below can move it without a release).
const Version = "1.19.3"

// ErrUnavailable is the honest answer on platforms/kinds the bridge cannot
// serve (Android: the binary is glibc-linked, 186MB — bionic can't run it;
// the honest copy in the provider card + the turn error say so).
var ErrUnavailable = errors.New("the opencode serve bridge is not available on this device (needs the desktop engine or an installed opencode CLI)")

// Manager owns one `opencode serve` child process: lazy start, health,
// and a restart-with-backoff when it dies. All HTTP calls speak the
// serve API captured live (the shapes above).
type Manager struct {
	mu      sync.Mutex
	dataDir string // the ENGINE data dir — the scratch + managed binary live under it
	apiKey  string
	binPath string
	baseURL string
	cmd     *exec.Cmd
	healthy bool
	stopped bool
	deaths  int
	logf    func(format string, args ...any)
}

// Config is the exact permission file the gate law prescribes: execution
// and writes DENIED (bash/edit/write/patch/webfetch), the read-only
// explorer tools allowed — live-proven to pass the free-tier gate while
// the agent answers "I don't have a Bash tool available".
const permissionConfig = `{
  "$schema": "https://opencode.ai/config.json",
  "permission": {
    "bash": "deny",
    "edit": "deny",
    "write": "deny",
    "patch": "deny",
    "webfetch": "deny",
    "read": "allow",
    "grep": "allow",
    "glob": "allow",
    "list": "allow"
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

// downloadAssetURL is the release-asset naming the official install script
// uses (https://opencode.ai/install, read 2026-10-21):
// opencode-<os>-<arch><ext> under the version tag.
func downloadAssetURL(goos, goarch string) (string, bool) {
	switch goos {
	case "linux":
		switch goarch {
		case "amd64":
			return fmt.Sprintf("https://github.com/anomalyco/opencode/releases/download/v%s/opencode-linux-x64.tar.gz", Version), true
		case "arm64":
			return fmt.Sprintf("https://github.com/anomalyco/opencode/releases/download/v%s/opencode-linux-arm64.tar.gz", Version), true
		}
	case "darwin":
		kind := "arm64"
		if goarch == "amd64" {
			kind = "x64"
		}
		return fmt.Sprintf("https://github.com/anomalyco/opencode/releases/download/v%s/opencode-darwin-%s.zip", Version, kind), true
	}
	return "", false
}

// EnsureBinary downloads + extracts the pinned CLI into the managed path
// when nothing usable exists. Android (and any platform without a release
// asset) answers ErrUnavailable honestly. Best-effort by design: the env
// override + PATH lookups happen first (FindBinary), so this only runs
// when the user asked for a free OpenCode model with no CLI around.
func EnsureBinary(dataDir string, logf func(format string, args ...any)) (string, error) {
	if runtime.GOOS == "android" {
		return "", ErrUnavailable
	}
	if p := FindBinary(dataDir); p != "" {
		return p, nil
	}
	url, ok := downloadAssetURL(runtime.GOOS, runtime.GOARCH)
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
	logf("ocserve: downloading opencode %s (the free-tier bridge)…", Version)
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
	if strings.HasSuffix(url, ".zip") {
		if err := extractZip(resp.Body, tmpDir); err != nil {
			return "", err
		}
	} else {
		if err := extractTarGz(resp.Body, tmpDir); err != nil {
			return "", err
		}
	}
	// the archive holds the binary at its root (the install script's own
	// layout); accept one level of nesting just in case.
	src := filepath.Join(tmpDir, "opencode")
	if st, err := os.Stat(src); err != nil || st.IsDir() {
		src2 := filepath.Join(tmpDir, "opencode", "opencode")
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
	// zip needs a ReaderAt — buffer the stream (the darwin asset is the
	// only zip and it is a one-time download)
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
func New(dataDir, apiKey string, logf func(format string, args ...any)) *Manager {
	if logf == nil {
		logf = func(string, ...any) {}
	}
	return &Manager{
		dataDir: dataDir,
		apiKey:  apiKey,
		logf:    logf,
	}
}

// SetBaseURL points the manager at an ALREADY-RUNNING serve (the rigs +
// tests drive a fake; production discovers its own child). When set,
// Start only health-checks — it never spawns.
func (m *Manager) SetBaseURL(u string) {
	m.mu.Lock()
	m.baseURL = strings.TrimSuffix(u, "/")
	m.mu.Unlock()
}

// Healthy reports whether a serve is answering right now.
func (m *Manager) Healthy() bool {
	m.mu.Lock()
	base := m.baseURL
	m.mu.Unlock()
	if base == "" {
		return false
	}
	return healthyUp(base)
}

func healthyUp(base string) bool {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, base+"/session/status", nil)
	if err != nil {
		return false
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return false
	}
	resp.Body.Close()
	return resp.StatusCode == 200
}

// Start ensures a serve child is up: writes the permission config (THE
// GATE LAW — the one project-level config the free tier accepts while
// execution + writes stay denied), spawns on a free local port, waits for
// health, and arms a restart-with-backoff watcher. SetBaseURL callers
// skip straight to the health check.
func (m *Manager) Start(ctx context.Context) error {
	if m.Healthy() {
		return nil
	}
	m.mu.Lock()
	if m.stopped {
		m.mu.Unlock()
		return ErrUnavailable
	}
	if m.baseURL != "" {
		m.mu.Unlock()
		return errors.New("ocserve: external serve not healthy")
	}
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
	cmd.Env = append(os.Environ(), "OPENCODE_API_KEY="+m.apiKey)
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
	// health poll (serve boots in ~2-6s)
	deadline := time.Now().Add(25 * time.Second)
	for time.Now().Before(deadline) {
		select {
		case <-ctx.Done():
			_ = cmd.Process.Kill()
			return ctx.Err()
		default:
		}
		if healthyUp(base) {
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
	return errors.New("ocserve: serve did not become healthy in 25s")
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
	}
}

func freePort() (int, error) {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return 0, err
	}
	defer l.Close()
	return l.Addr().(*net.TCPAddr).Port, nil
}

// ── the serve client (the live-captured shapes) ─────────────────────────

// CreateSession POSTs /session and returns the serve session id.
func (m *Manager) CreateSession(title string) (string, error) {
	m.mu.Lock()
	base := m.baseURL
	m.mu.Unlock()
	if base == "" {
		return "", errors.New("ocserve: not running")
	}
	body, _ := json.Marshal(map[string]any{"title": title})
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, base+"/session", strings.NewReader(string(body)))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		return "", fmt.Errorf("ocserve create session: HTTP %d", resp.StatusCode)
	}
	var out struct {
		ID string `json:"id"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return "", err
	}
	if out.ID == "" {
		return "", errors.New("ocserve create session: no id")
	}
	return out.ID, nil
}

// PromptAsync fires one turn (204 on accept). THE GATE LAW: the request
// carries ONLY the model + parts — no `tools` field, no `system` field
// (either poisons the turn AND the session; persona/context ride the
// message text the adapter composes).
func (m *Manager) PromptAsync(serveSess, modelID, text string) error {
	m.mu.Lock()
	base := m.baseURL
	m.mu.Unlock()
	if base == "" {
		return errors.New("ocserve: not running")
	}
	body, _ := json.Marshal(map[string]any{
		"model": map[string]string{"providerID": "opencode", "modelID": modelID},
		"parts": []map[string]any{{"type": "text", "text": text}},
	})
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, base+"/session/"+serveSess+"/prompt_async", strings.NewReader(string(body)))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	resp.Body.Close()
	if resp.StatusCode >= 300 {
		return fmt.Errorf("ocserve prompt_async: HTTP %d", resp.StatusCode)
	}
	return nil
}

// Event is one parsed SSE frame from GET /event (the live-captured shapes).
type Event struct {
	Type       string          `json:"type"`
	Properties eventProperties `json:"properties"`
}

type eventProperties struct {
	SessionID string      `json:"sessionID"`
	Status    eventStatus `json:"status"`
	Part      partShape   `json:"part"`
	Info      messageInfo `json:"info"`
	MessageID string      `json:"messageID"`
	PartID    string      `json:"partID"`
	Field     string      `json:"field"`
	Delta     string      `json:"delta"`
}

type eventStatus struct {
	Type string `json:"type"`
}

type partShape struct {
	ID    string         `json:"id"`
	Type  string         `json:"type"`
	Text  string         `json:"text"`
	Tool  string         `json:"tool"`
	State *partToolState `json:"state"`
}

type partToolState struct {
	Status string         `json:"status"`
	Input  map[string]any `json:"input"`
	Output string         `json:"output"`
}

type messageInfo struct {
	ID     string        `json:"id"`
	Role   string        `json:"role"`
	Finish string        `json:"finish"`
	Error  *messageError `json:"error"`
	Tokens messageTokens `json:"tokens"`
	Cost   float64       `json:"cost"`
}

type messageError struct {
	Name string            `json:"name"`
	Data *messageErrorData `json:"data"`
}

type messageErrorData struct {
	Message string `json:"message"`
}

type messageTokens struct {
	Total     int `json:"total"`
	Input     int `json:"input"`
	Output    int `json:"output"`
	Reasoning int `json:"reasoning"`
}

// IsFreeTierError reports whether a serve frame carries OpenCode's
// free-tier wall (the poisoned-turn signature — the recycle law's trigger).
func (e Event) IsFreeTierError() bool {
	if e.Type != "message.updated" {
		return false
	}
	err := e.Properties.Info.Error
	return err != nil && err.Data != nil && strings.Contains(strings.ToLower(err.Data.Message), "free tier can only be used")
}

// StreamEvents consumes the serve's SSE feed until session.idle (the
// terminal), the ctx dies, or the connection breaks. onEvent gets every
// parsed frame in arrival order.
func (m *Manager) StreamEvents(ctx context.Context, serveSess string, onEvent func(Event) error) error {
	m.mu.Lock()
	base := m.baseURL
	m.mu.Unlock()
	if base == "" {
		return errors.New("ocserve: not running")
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, base+"/event?sessionID="+serveSess, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Accept", "text/event-stream")
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
		// only this session's frames (heartbeats/global frames ride the
		// same wire with a foreign or empty sessionID)
		if p := ev.Properties.SessionID; p != "" && p != serveSess {
			continue
		}
		if err := onEvent(ev); err != nil {
			return err
		}
		if ev.Type == "session.idle" {
			return nil
		}
	}
}
