// remote.go — v0.46: the RemoteBrain — an HF Space running the brain
// (engine/internal/hfzero template) that the engine drives over HTTPS with
// the SAME protocol as the local Python brain (POST /chat → SSE events,
// GET /health, GET /models; provider keys ride X-Env-* headers).
//
// Two auth shapes:
//   - OWN space    → X-Space-Token: <secret minted at create time, stored in
//     the vault as HF_SPACE_<OWNER>_<NAME>> — only this engine knows it.
//   - SHARED space → X-HF-Token: <the user's own HF token> — the space
//     validates it against whoami-v2 (see template/app.py), so any real HF
//     user may drive the community sandbox, nobody else.
//
// Health: a successful /chat or /health flips healthy; a connection error
// flips unhealthy and arms a quiet 60s re-probe (spaces sleep after 48h —
// the first turn after sleep may need a wake via the restart API; the chat
// path surfaces that hint instead of a raw connection refused).
package brain

import (
        "bytes"
        "context"
        "encoding/json"
        "fmt"
        "io"
        "net/http"
        "strings"
        "sync"
        "time"
)

// RemoteBrain is an HTTP+SSE client to a brain running on an HF Space.
type RemoteBrain struct {
        Repo string // "user/name" ("" = unknown/shared anonymous)
        Mode string // "own" | "shared"

        mu      sync.RWMutex
        url     string
        spaceTk string            // own mode: the X-Space-Token secret
        hfTkFn  func() string     // shared mode: returns the user's HF token
        env     map[string]string // provider keys → X-Env-* headers
        healthy bool
        client  *http.Client
}

// NewRemoteBrain builds a client for an OWN space (token auth).
func NewRemoteBrain(repo, url, spaceToken string, env map[string]string) *RemoteBrain {
        return &RemoteBrain{Repo: repo, Mode: "own", url: strings.TrimSuffix(url, "/"),
                spaceTk: spaceToken, env: env, client: &http.Client{Timeout: 0}}
}

// NewSharedRemoteBrain builds a client for the SHARED community space
// (HF-token auth; the token is fetched per-turn via hfTokenFn so a fresh
// connect is picked up without rebuilding the client).
func NewSharedRemoteBrain(repo, url string, hfTokenFn func() string, env map[string]string) *RemoteBrain {
        return &RemoteBrain{Repo: repo, Mode: "shared", url: strings.TrimSuffix(url, "/"),
                hfTkFn: hfTokenFn, env: env, client: &http.Client{Timeout: 0}}
}

// SetEnv updates the provider keys injected on every call.
func (rb *RemoteBrain) SetEnv(env map[string]string) {
        if rb == nil {
                return
        }
        rb.mu.Lock()
        rb.env = env
        rb.mu.Unlock()
}

// URL returns the space's base URL.
func (rb *RemoteBrain) URL() string {
        if rb == nil {
                return ""
        }
        return rb.url
}

// Healthy reports the last-known health (flipped by probe/Chat; a failure
// arms a quiet re-probe — see MarkUnhealthy).
func (rb *RemoteBrain) Healthy() bool {
        if rb == nil {
                return false
        }
        rb.mu.RLock()
        defer rb.mu.RUnlock()
        return rb.healthy
}

// MarkUnhealthy flags the space dead and arms a quiet re-probe loop.
func (rb *RemoteBrain) MarkUnhealthy() {
        if rb == nil {
                return
        }
        rb.mu.Lock()
        if !rb.healthy {
                rb.mu.Unlock()
                return
        }
        rb.healthy = false
        url := rb.url
        rb.mu.Unlock()
        go func() {
                for {
                        time.Sleep(60 * time.Second)
                        if rb.probe(url) {
                                return
                        }
                }
        }()
}

// probe checks /health and flips the flag accordingly.
func (rb *RemoteBrain) probe(url string) bool {
        cli := &http.Client{Timeout: 15 * time.Second}
        req, err := http.NewRequest("GET", url+"/health", nil)
        if err != nil {
                return false
        }
        rb.applyAuth(req, nil)
        resp, err := cli.Do(req)
        if err != nil {
                return false
        }
        defer resp.Body.Close()
        if resp.StatusCode == 200 {
                rb.mu.Lock()
                rb.healthy = true
                rb.mu.Unlock()
                return true
        }
        return false
}

// Probe runs a one-shot health check (used before the first turn).
func (rb *RemoteBrain) Probe() bool {
        if rb == nil {
                return false
        }
        return rb.probe(rb.url)
}

// ProbeTimeout retries /health for up to dur — HF wakes sleeping Spaces on
// the first request, which can take ~30-60s. Returns the final verdict.
func (rb *RemoteBrain) ProbeTimeout(dur time.Duration) bool {
        if rb == nil {
                return false
        }
        deadline := time.Now().Add(dur)
        for {
                if rb.probe(rb.url) {
                        return true
                }
                if time.Now().After(deadline) {
                        return false
                }
                time.Sleep(5 * time.Second)
        }
}

// applyAuth sets the auth + provider-key headers on a request.
func (rb *RemoteBrain) applyAuth(req *http.Request, env map[string]string) {
        rb.mu.RLock()
        spaceTk := rb.spaceTk
        if rb.hfTkFn != nil && spaceTk == "" {
                if tk := rb.hfTkFn(); tk != "" {
                        req.Header.Set("X-HF-Token", tk)
                }
        }
        e := rb.env
        rb.mu.RUnlock()
        if spaceTk != "" {
                req.Header.Set("X-Space-Token", spaceTk)
        }
        if env != nil {
                e = env
        }
        for k, v := range e {
                req.Header.Set("X-Env-"+k, v)
        }
        // v0.48 task 7: alias DOOMALAY_HF_TOKEN → HF_TOKEN so the brain's
        // HF-facing code (dt_hf, libraries reading the canonical name)
        // always sees the connect-flow token. The brain's own dt_hf reads
        // DOOMALAY_HF_TOKEN first; the alias covers everything else.
        if v, ok := e["DOOMALAY_HF_TOKEN"]; ok && v != "" {
                if _, have := e["HF_TOKEN"]; !have {
                        req.Header.Set("X-Env-HF_TOKEN", v)
                }
        }
}

// Chat proxies one agent turn to the remote brain — same SSE event stream
// shape as the local Brain.Chat (each "data: {json}" line → one event map).
func (rb *RemoteBrain) Chat(ctx context.Context, req map[string]any) (<-chan map[string]any, <-chan error, error) {
        if rb == nil {
                return nil, nil, fmt.Errorf("no remote brain")
        }
        body, err := json.Marshal(req)
        if err != nil {
                return nil, nil, err
        }
        rb.mu.RLock()
        url := rb.url
        rb.mu.RUnlock()
        httpReq, err := http.NewRequestWithContext(ctx, "POST", url+"/chat", bytes.NewReader(body))
        if err != nil {
                return nil, nil, err
        }
        httpReq.Header.Set("Content-Type", "application/json")
        rb.applyAuth(httpReq, nil)
        httpReq.Header.Set("User-Agent", "doomalay-engine/0.46")

        resp, err := rb.client.Do(httpReq)
        if err != nil {
                rb.MarkUnhealthy()
                return nil, nil, fmt.Errorf("space unreachable (%s): %w — if it slept, wake it via the HF pill (restart), then retry", rb.Repo, err)
        }
        if resp.StatusCode != 200 {
                bts, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<16))
                resp.Body.Close()
                if resp.StatusCode == 401 {
                        return nil, nil, fmt.Errorf("space rejected the auth token (401) — reconnect HF or re-create the space")
                }
                if resp.StatusCode == 429 {
                        return nil, nil, fmt.Errorf("shared sandbox is busy (429) — retry in a moment or create your own space")
                }
                return nil, nil, fmt.Errorf("space chat %d: %s", resp.StatusCode, string(bts))
        }
        rb.mu.Lock()
        rb.healthy = true
        rb.mu.Unlock()

        events := make(chan map[string]any, 64)
        errs := make(chan error, 1)
        go func() {
                defer resp.Body.Close()
                defer close(events)
                defer close(errs)
                buf := make([]byte, 0, 8192)
                tmp := make([]byte, 8192)
                for {
                        n, err := resp.Body.Read(tmp)
                        if n > 0 {
                                buf = append(buf, tmp[:n]...)
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

// Models proxies GET /models (provider catalog) with the same auth.
func (rb *RemoteBrain) Models(ctx context.Context) (json.RawMessage, error) {
        if rb == nil {
                return nil, fmt.Errorf("no remote brain")
        }
        rb.mu.RLock()
        url := rb.url
        rb.mu.RUnlock()
        req, err := http.NewRequestWithContext(ctx, "GET", url+"/models", nil)
        if err != nil {
                return nil, err
        }
        rb.applyAuth(req, nil)
        cli := &http.Client{Timeout: 30 * time.Second}
        resp, err := cli.Do(req)
        if err != nil {
                return nil, err
        }
        defer resp.Body.Close()
        body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<22))
        if resp.StatusCode != 200 {
                return nil, fmt.Errorf("space models %d: %s", resp.StatusCode, string(body))
        }
        return json.RawMessage(body), nil
}
