// Package brain manages the Python subprocess that runs the AI layer
// (Strands agent, judge panel, LiteLLM providers). The Go engine spawns
// brain/server.py on localhost:9090 and proxies AI requests to it.
//
// If Python is unavailable (e.g. minimal Android Termux without python
// installed), the bridge falls back to direct cloud LLM proxying — no
// local tools, no panel, but chat still works via OpenRouter/NVIDIA/etc.
package brain

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// Brain is the Python subprocess + HTTP client to it.
type Brain struct {
	cmd       *exec.Cmd
	url       string
	env       map[string]string // provider keys to inject
	mu        sync.RWMutex
	healthy   bool
	pythonBin string
}

// Start spawns `python brain/server.py --port <port>` in brainDir.
// Returns nil if Python is unavailable (caller falls back to direct proxy).
func Start(brainDir string, port int) (*Brain, error) {
	if brainDir == "" {
		brainDir = "./brain"
	}
	// Resolve brainDir to an absolute path so subprocess CWD + python path
	// both work regardless of where the engine binary lives.
	absBrain, err := filepath.Abs(brainDir)
	if err != nil {
		return nil, fmt.Errorf("resolve brain dir: %w", err)
	}
	brainDir = absBrain

	serverPath := filepath.Join(brainDir, "server.py")
	if _, err := os.Stat(serverPath); err != nil {
		return nil, fmt.Errorf("brain/server.py not found at %s: %w", serverPath, err)
	}
	pythonBin, err := findPython(brainDir)
	if err != nil {
		return nil, fmt.Errorf("python not found: %w", err)
	}
	// Verify deps installed.
	check := exec.Command(pythonBin, "-c", "import fastapi, uvicorn, litellm")
	if err := check.Run(); err != nil {
		return nil, fmt.Errorf("python deps missing (run: pip install -r brain/requirements.txt): %w", err)
	}

	cmd := exec.Command(pythonBin, serverPath, "--port", fmt.Sprintf("%d", port))
	cmd.Dir = brainDir
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("spawn brain: %w", err)
	}

	b := &Brain{
		cmd:       cmd,
		url:       fmt.Sprintf("http://localhost:%d", port),
		pythonBin: pythonBin,
	}
	if err := b.waitHealthy(10 * time.Second); err != nil {
		b.Stop()
		return nil, fmt.Errorf("brain health check: %w", err)
	}
	return b, nil
}

// findPython locates a python interpreter. Preference order:
//  1. <brainDir>/.venv/bin/python (a local venv — common for hybrid apps)
//  2. ./brain/.venv/bin/python (when running from repo root)
//  3. ../brain/.venv/bin/python (when running from engine/)
//  4. system python3
//  5. system python
func findPython(brainDir string) (string, error) {
	candidates := []string{
		filepath.Join(brainDir, ".venv", "bin", "python"),
		filepath.Join(brainDir, ".venv", "bin", "python3"),
		"./brain/.venv/bin/python",
		"../brain/.venv/bin/python",
	}
	for _, c := range candidates {
		if fi, err := os.Stat(c); err == nil && !fi.IsDir() {
			return c, nil
		}
	}
	for _, name := range []string{"python3", "python"} {
		if p, err := exec.LookPath(name); err == nil {
			return p, nil
		}
	}
	return "", fmt.Errorf("no python3/python in PATH and no .venv found")
}

func (b *Brain) waitHealthy(timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		resp, err := http.Get(b.url + "/health")
		if err == nil && resp.StatusCode == 200 {
			resp.Body.Close()
			b.mu.Lock()
			b.healthy = true
			b.mu.Unlock()
			return nil
		}
		if resp != nil {
			resp.Body.Close()
		}
		time.Sleep(200 * time.Millisecond)
	}
	return fmt.Errorf("timeout waiting for brain at %s", b.url)
}

// Stop terminates the Python subprocess.
func (b *Brain) Stop() {
	if b == nil || b.cmd == nil || b.cmd.Process == nil {
		return
	}
	_ = b.cmd.Process.Signal(os.Interrupt)
	done := make(chan error, 1)
	go func() { done <- b.cmd.Wait() }()
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		_ = b.cmd.Process.Kill()
	}
}

// Healthy reports whether the brain responded to /health recently.
func (b *Brain) Healthy() bool {
	if b == nil {
		return false
	}
	b.mu.RLock()
	defer b.mu.RUnlock()
	return b.healthy
}

// URL returns the brain's base URL (e.g. "http://localhost:9090").
func (b *Brain) URL() string {
	if b == nil {
		return ""
	}
	return b.url
}

// SetEnv sets the provider key env vars to inject when proxying to the brain.
// Called by the secrets vault when keys change.
func (b *Brain) SetEnv(env map[string]string) {
	if b == nil {
		return
	}
	b.mu.Lock()
	b.env = env
	b.mu.Unlock()
}

// Chat proxies a chat turn to the brain. The brain streams SSE events back;
// the engine converts them to a channel of raw event JSON for the WebSocket
// handler to forward to the PWA + persist to chat_events.
//
// Request body (sent to brain):
//
//	{ "session_id", "message", "model", "provider", "system_prompt",
//	  "effort", "temperature", "max_tokens", "tools", "history" }
//
// The brain streams SSE: data: {"type":"thinking","text":"..."}\n\n
// The engine parses each SSE line and yields the parsed JSON object.
func (b *Brain) Chat(ctx context.Context, req map[string]any) (<-chan map[string]any, <-chan error, error) {
	if b == nil || !b.Healthy() {
		return nil, nil, fmt.Errorf("brain not healthy")
	}
	body, err := json.Marshal(req)
	if err != nil {
		return nil, nil, err
	}
	httpReq, err := http.NewRequestWithContext(ctx, "POST", b.url+"/chat", bytes.NewReader(body))
	if err != nil {
		return nil, nil, err
	}
	httpReq.Header.Set("Content-Type", "application/json")
	// Inject provider keys as headers (so they don't sit in the brain's env forever).
	b.mu.RLock()
	for k, v := range b.env {
		// Avoid putting raw keys in headers visible to intermediaries — since
		// brain is localhost-only, this is acceptable. The brain reads them
		// and sets them as process env for the LiteLLM call.
		httpReq.Header.Set("X-Env-"+k, v)
	}
	b.mu.RUnlock()

	resp, err := http.DefaultClient.Do(httpReq)
	if err != nil {
		return nil, nil, err
	}
	if resp.StatusCode != 200 {
		bts, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		return nil, nil, fmt.Errorf("brain chat %d: %s", resp.StatusCode, string(bts))
	}

	events := make(chan map[string]any, 64)
	errs := make(chan error, 1)
	go func() {
		defer resp.Body.Close()
		defer close(events)
		defer close(errs)
		// Parse SSE stream.
		buf := make([]byte, 0, 4096)
		tmp := make([]byte, 4096)
		for {
			n, err := resp.Body.Read(tmp)
			if n > 0 {
				buf = append(buf, tmp[:n]...)
				// Process complete lines.
				for {
					idx := bytes.IndexByte(buf, '\n')
					if idx < 0 {
						break
					}
					line := strings.TrimSpace(string(buf[:idx]))
					buf = buf[idx+1:]
					if !strings.HasPrefix(line, "data: ") {
						continue
					}
					data := line[6:]
					if data == "[DONE]" {
						return
					}
					var ev map[string]any
					if err := json.Unmarshal([]byte(data), &ev); err == nil {
						select {
						case events <- ev:
						case <-ctx.Done():
							return
						}
					}
				}
			}
			if err != nil {
				if err != io.EOF {
					errs <- err
				}
				return
			}
		}
	}()
	return events, errs, nil
}

// Models proxies GET /models to the brain (provider catalog + syncStatus).
// Injects the current provider keys as X-Env-* headers so the brain can
// probe each provider's /v1/models endpoint.
func (b *Brain) Models(ctx context.Context) (json.RawMessage, error) {
	if b == nil || !b.Healthy() {
		return nil, fmt.Errorf("brain not healthy")
	}
	req, _ := http.NewRequestWithContext(ctx, "GET", b.url+"/models", nil)
	// Inject provider keys so the brain can sync /v1/models for each.
	b.mu.RLock()
	for k, v := range b.env {
		req.Header.Set("X-Env-"+k, v)
	}
	b.mu.RUnlock()
	if q := req.URL.Query(); q.Get("refresh") != "" {
		// pass through
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("brain models %d: %s", resp.StatusCode, string(body))
	}
	return json.RawMessage(body), nil
}

// MarkUnhealthy (v0.44.1) flips the brain dead after a live connection
// failure — Healthy() previously NEVER went false once true, so a brain
// that died mid-run left every later turn brain-routed into a connection
// refused (live-observed in the W5 redteam: two consecutive turns failed
// with dial tcp ::1:9090 while the engine's own direct pipeline sat
// ready). A quiet re-probe timer flips it back the moment the brain
// answers /health again (e.g. the engine supervisor respawns it).
func (b *Brain) MarkUnhealthy() {
	if b == nil {
		return
	}
	b.mu.Lock()
	if !b.healthy {
		b.mu.Unlock()
		return
	}
	b.healthy = false
	url := b.url
	b.mu.Unlock()
	go func() {
		// re-probe every 15s until the brain answers again
		for {
			time.Sleep(15 * time.Second)
			resp, err := http.Get(url + "/health")
			if err == nil {
				resp.Body.Close()
				if resp.StatusCode == 200 {
					b.mu.Lock()
					b.healthy = true
					b.mu.Unlock()
					return
				}
			} else if resp != nil {
				resp.Body.Close()
			}
		}
	}()
}
