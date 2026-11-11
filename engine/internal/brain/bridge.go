// Package brain manages the Python subprocess that runs the AI layer
// (Strands agent, judge panel, LiteLLM providers). The Go engine spawns
// brain/server.py on localhost:9090 and proxies AI requests to it.
//
// If Python is unavailable (e.g. minimal Android Termux without python
// installed), the bridge falls back to direct cloud LLM proxying — no
// local tools, no panel, but chat still works via OpenRouter/NVIDIA/etc.
package brain

import (
        "bufio"
        "bytes"
        "context"
        "encoding/json"
        "fmt"
        "io"
        "log"
        "net/http"
        "os"
        "os/exec"
        "path/filepath"
        "strings"
        "sync"
        "time"

        "github.com/ScoobyBaby1999/doomalay/engine/internal/netx"
)

// v1.76.1 THE PATIENT BRIDGE WIRE: models retry pacing — 3 total tries,
// 1s base (the forge's pacing; a 1s Wi-Fi hiccup survives, validation
// classes never re-hammer). See PLAN-V176 §v1.76.1.
const (
        modelsRetryAttempts   = 3
        modelsRetryBaseDelay   = 1 * time.Second
        modelsBodyLimit       = 1 << 22 // 4MiB cap, remote-twin parity
)

// Brain is the Python subprocess + HTTP client to it.
type Brain struct {
        cmd       *exec.Cmd
        url       string
        env       map[string]string // provider keys to inject
        mu        sync.RWMutex
        healthy   bool
        pythonBin string

        // v1.76.1 test seams: nil → the production wire.go shapes.
        probeCli  *http.Client
        chatCli   *http.Client
        modelsCli *http.Client

        // v1.76.3 THE SINGLE RE-PROBE LAW: true while a re-probe loop is
        // in flight (guarded by mu) — MarkUnhealthy's single-flight guard.
        reprobing bool

        // v1.76.5 THE SINGLE PASS startup state:
        stderr   *memRing     // bounded early-stderr capture (the diagnosis ring)
        done     chan struct{} // closed exactly once when the process exits
        waitErr  error        // cmd.Wait()'s result (readable after done closes)
}

// Start spawns `python brain/server.py --port <port>` in brainDir.
// Returns nil if Python is unavailable (caller falls back to direct proxy).
//
// v1.76.5 THE SINGLE PASS: the separate deps-check interpreter boot
// ("import fastapi, uvicorn, litellm" — a whole SECOND Python start,
// 1-3s of pure latency on slow devices like Android Termux) is GONE:
// server.py boots directly, its early stderr is tee'd into a bounded
// diagnosis ring (live logs keep flowing to the engine console), and a
// process that dies young fails the start in milliseconds carrying its
// own ImportError tail + the same pip remedy the old pre-check gave —
// the same honest error, one boot sooner.
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

        cmd := exec.Command(pythonBin, serverPath, "--port", fmt.Sprintf("%d", port))
        cmd.Dir = brainDir
        stderrRing := newMemRing(8 * 1024)
        cmd.Stdout = os.Stdout // live brain logs keep flowing to the engine console
        cmd.Stderr = io.MultiWriter(os.Stderr, stderrRing) // …AND the diagnosis ring
        if err := cmd.Start(); err != nil {
                return nil, fmt.Errorf("spawn brain: %w", err)
        }

        b := &Brain{
                cmd:       cmd,
                url:       fmt.Sprintf("http://localhost:%d", port),
                pythonBin: pythonBin,
                stderr:    stderrRing,
                done:      make(chan struct{}),
        }
        // v1.76.5 THE PERSISTENT REAPER: cmd.Wait runs exactly once, for the
        // process's whole life (the old Stop-only Wait left an exited child
        // a zombie until Stop happened to run). done closes the moment the
        // process exits; waitErr is readable after (channel-close
        // happens-before).
        go func() {
                b.waitErr = cmd.Wait()
                close(b.done)
        }()

        if err := b.waitHealthy(brainBootTimeout()); err != nil {
                b.Stop()
                tail := strings.TrimSpace(b.stderr.tail())
                if hint := brainDepsHint(tail); hint != "" {
                        return nil, fmt.Errorf("%w — %s; stderr: %.400s", err, hint, tail)
                }
                if tail != "" {
                        return nil, fmt.Errorf("%w; stderr: %.400s", err, tail)
                }
                return nil, err
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

// probeHealth runs ONE /health probe through the dedicated probe client
// (total timeout, keep-alives disabled — a stale pooled socket must never
// answer a health check) and flips healthy=true on a 200. Never carries
// provider keys (the v0.75 smallest-secret-surface law). One component,
// three users: waitHealthy, the MarkUnhealthy re-probe loop, diagnostics.
func (b *Brain) probeHealth() bool {
        if b == nil {
                return false
        }
        req, err := http.NewRequest("GET", b.url+"/health", nil)
        if err != nil {
                return false
        }
        resp, err := b.probeClient().Do(req)
        if err != nil {
                return false
        }
        defer resp.Body.Close()
        if resp.StatusCode == 200 {
                b.mu.Lock()
                b.healthy = true
                b.mu.Unlock()
                return true
        }
        return false
}

func (b *Brain) waitHealthy(timeout time.Duration) error {
        deadline := time.Now().Add(timeout)
        for time.Now().Before(deadline) {
                // v1.76.5 EARLY EXIT: a process that died young fails the
                // start in milliseconds — with its own captured tail riding
                // Start's error — never after the whole window.
                select {
                case <-b.done:
                        return fmt.Errorf("brain exited during startup: %v", b.waitErr)
                default:
                }
                if b.probeHealth() {
                        return nil
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
        // v1.76.5: the persistent reaper owns cmd.Wait — Stop just signals
        // and watches done (idempotent: an already-dead brain closes it
        // instantly; a second Stop is a no-op; Stop is never a second Wait).
        select {
        case <-b.done:
        case <-time.After(3 * time.Second):
                _ = b.cmd.Process.Kill()
                select {
                case <-b.done:
                case <-time.After(3 * time.Second):
                        // unreachable in practice (Kill + the reaper); Stop never hangs
                }
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
//      { "session_id", "message", "model", "provider", "system_prompt",
//        "effort", "temperature", "max_tokens", "tools", "history" }
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
        // v1.76.2 THE STALL SENTINEL: the stream owns a cancelable child
        // context so the no-bytes watchdog can kill a frozen stream even
        // when the parent ctx would happily wait forever (the Python side
        // has no kill by its own v0.80.1 law — the engine is the only
        // place a watchdog can live).
        streamCtx, cancelStream := context.WithCancel(ctx)
        httpReq, err := http.NewRequestWithContext(streamCtx, "POST", b.url+"/chat", bytes.NewReader(body))
        if err != nil {
                cancelStream()
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

        // v1.76.1: the dedicated streaming client — NO total timeout (a long
        // AI answer is legitimate), ResponseHeaderTimeout instead (if the
        // brain never even starts replying, fail cleanly — see wire.go).
        resp, err := b.chatClient().Do(httpReq)
        if err != nil {
                // v1.76.1: the transport itself failed (refused/reset/black-
                // hole) — the same failure class MarkUnhealthy exists for.
                // The remote twin has wired this since v0.46; the local
                // bridge never did. The quiet 15s re-probe revives it.
                cancelStream()
                b.MarkUnhealthy()
                return nil, nil, err
        }
        if resp.StatusCode != 200 {
                bts, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<16))
                resp.Body.Close()
                cancelStream()
                return nil, nil, fmt.Errorf("brain chat %d: %s", resp.StatusCode, string(bts))
        }
        // v1.76.1: the brain answered — heal the flag without waiting for
        // a re-probe (the remote twin's Chat does the same).
        b.mu.Lock()
        b.healthy = true
        b.mu.Unlock()

        // v1.76.2: arm the no-bytes watchdog (0 = disabled — the pure
        // v0.80.1 no-kill mode). BYTES, not lines, feed it (a slow-dripping
        // long line is a LIVE stream); the brain's own 25s progress
        // heartbeat (agent.py v0.76.6) keeps healthy multi-minute tool
        // turns 20s clear of the 45s default.
        killSecs := brainStallKill()
        var wd *streamWatchdog
        if killSecs > 0 {
                wd = newStreamWatchdog(time.Duration(killSecs)*time.Second, cancelStream)
        }

        events := make(chan map[string]any, 64)
        errs := make(chan error, 1)
        go func() {
                defer cancelStream() // v1.76.2: the stream context dies with the stream
                if wd != nil {
                        defer wd.kill()
                }
                defer resp.Body.Close()
                defer close(events)
                defer close(errs)
                // v1.76.2: the byte-level feed wraps the body INSIDE the
                // reader goroutine (resp.Body stays the pristine closer).
                src := io.Reader(resp.Body)
                if wd != nil {
                        src = newFeedReader(src, wd.feed)
                }
                // v1.76.4 THE HONEST SCANNER: bufio.Scanner replaces the
                // hand-rolled IndexByte loop — native \r\n handling, one
                // reusable buffer, no repeated slice reallocation on long
                // responses, and a hard 2MiB line cap (the old loop grew
                // buf without bound on a hostile or hung stream). Malformed
                // data lines are LOUD now: the first is logged with its
                // payload, every stream end reports the total — network
                // truncation and Python serialization bugs surface
                // instead of vanishing (the old Unmarshal error was
                // discarded outright). One deliberate strictness gain: a
                // final partial line at EOF is now DELIVERED where the old
                // loop silently dropped it.
                sc := bufio.NewScanner(src)
                sc.Buffer(make([]byte, 64*1024), 2*1024*1024)
                var malformed int
                // the summary rides a defer so EVERY exit path reports it
                // ([DONE], ctx cancel, watchdog, error, EOF alike).
                defer func() {
                        if malformed > 0 {
                                log.Printf("brain stream ended: %d malformed SSE data lines total", malformed)
                        }
                }()
                for sc.Scan() {
                        line := strings.TrimSpace(sc.Text())
                        if !strings.HasPrefix(line, "data: ") {
                                continue // SSE comments/keep-alives — same law as before
                        }
                        data := line[6:]
                        if data == "[DONE]" {
                                return
                        }
                        var ev map[string]any
                        if err := json.Unmarshal([]byte(data), &ev); err != nil {
                                if malformed == 0 {
                                        log.Printf("brain: malformed SSE data line #1 (network truncation or a serialization bug): %.200s — %v", data, err)
                                }
                                malformed++
                                continue
                        }
                        select {
                        case events <- ev:
                        case <-streamCtx.Done():
                                return
                        }
                }
                if err := sc.Err(); err != nil {
                        // v1.76.2: a read error after the watchdog
                        // tripped is THE STALL — the typed sentinel
                        // rides errs (the server layer persists an
                        // honest error event; forwardEvents would
                        // otherwise only log it) and the brain flips
                        // dead for the quiet 15s re-probe.
                        if wd != nil && wd.didTrip() {
                                b.MarkUnhealthy()
                                errs <- fmt.Errorf("%w: no SSE bytes for %ds — the brain's stream froze mid-turn (provider black-hole or a stuck agent); the quiet 15s re-probe revives the brain when it answers (knob: DOOMALAY_BRAIN_STALL_KILL)", ErrStreamStalled, killSecs)
                                return
                        }
                        errs <- err
                        return
                }
                return
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
        // v1.76.3 THE DEAD-CODE FUNERAL: the refresh query check that lived
        // here never fired in its life — this method builds its own
        // queryless URL (the query param it polled was never present), and
        // it has had zero callers since v1.55.3 retired the /api/models
        // brain proxy. The v1.76.1 rewrite moved header injection into the
        // RetryDo request builder; the dead block is buried, not passed
        // through.
        // v1.76.1: GET /models is idempotent — ride netx.RetryDo (THE
        // PATIENT WIRE, v1.61.2) so a 1s Wi-Fi hiccup or a brain 5xx
        // survives; validation-class errors never re-hammer. The request
        // is rebuilt fresh per attempt (no consumed-body trap).
        cli := b.modelsClient()
        resp, err := netx.RetryDo(ctx, cli, func() (*http.Request, error) {
                req, err := http.NewRequestWithContext(ctx, "GET", b.url+"/models", nil)
                if err != nil {
                        return nil, err
                }
                b.mu.RLock()
                for k, v := range b.env {
                        req.Header.Set("X-Env-"+k, v)
                }
                b.mu.RUnlock()
                return req, nil
        }, modelsRetryAttempts, modelsRetryBaseDelay)
        if err != nil {
                // v1.76.1: transport-exhausted = the brain is unreachable
                // (the same class Chat wires) — flip it dead; a 5xx the
                // brain ANSWERED with means the process is alive, so it
                // does not (the remote twin's split).
                b.MarkUnhealthy()
                return nil, err
        }
        defer resp.Body.Close()
        body, _ := io.ReadAll(io.LimitReader(resp.Body, modelsBodyLimit))
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
//
// v1.76.3 THE SINGLE RE-PROBE LAW: the re-probe loop is SINGLE-FLIGHT —
// exactly one background probe loop may exist per Brain. The pile shape:
// loop #1 sleeps its 15s, a Chat 200 heals the flag mid-sleep, a fresh
// failure flips it again → the old code spawned loop #2 (and each repeat
// stacked another). Now the in-flight loop OWNS the revival: the flag
// still flips false on every conviction, but no second loop is ever born.
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
        reprobe := !b.reprobing
        b.reprobing = true
        b.mu.Unlock()
        if !reprobe {
                return // an in-flight loop owns the revival — never a second one
        }
        go func() {
                defer func() {
                        b.mu.Lock()
                        b.reprobing = false
                        b.mu.Unlock()
                }()
                // re-probe every 15s until the brain answers again
                // (v1.76.1: through the dedicated probe client — the bare
                // http.Get had no timeout, so a black-holed probe slept
                // on a dead socket forever).
                for {
                        time.Sleep(15 * time.Second)
                        if b.probeHealth() {
                                return
                        }
                }
        }()
}
