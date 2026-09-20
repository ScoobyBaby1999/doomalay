// httpx.go — shared HTTP helpers for provider fetches.
//
// One UA, one timeout policy, one JSON GET helper — every provider fetch in
// the llm package goes through here so timeouts / headers / retry behavior
// stay consistent (and CDNs that block default Go UAs keep working).

package llm

import (
        "bytes"
        crand "crypto/rand"
        "crypto/sha256"
        "encoding/hex"
        "encoding/json"
        "fmt"
        "io"
        "net/http"
        "strings"
        "sync"
        "time"

        "github.com/ScoobyBaby1999/doomalay/engine/internal/netx"
)

// browserUA mirrors a mobile Chrome client — several provider CDNs
// (Cloudflare-fronted portals especially) challenge or block the default
// Go http-client UA.
const browserUA = "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36"

// providerHTTP is the shared client for model syncs + key validation.
// v0.18: 9s timeout (was 15s) — a cold catalog sync runs 11 providers in
// parallel and /api/models blocked on the slowest black-holed connection;
// on congested mobile data one-press connect felt dead for the full 15s.
// 9s still tolerates slow-but-alive providers, but the catalog returns
// while the user is still looking at the screen. (Chat STREAMING uses
// providerStreamHTTP below — unaffected.)
var providerHTTP = &http.Client{
        Timeout:   9 * time.Second,
        Transport: netx.Transport(),
}

// probeSlowHTTP is the KEY-VALIDATION client (v0.35). NVIDIA's free tier
// queues chat completions for ~30s before the first byte (live-measured:
// nemotron-3.5-lightning max_tokens=1 → 29s TTFB), so the old 9s client
// made every NVIDIA validation time out and the badge sat on "unverified —
// provider unreachable" forever even though chat worked fine. Validation is
// async (background revalidate / save flow) so 40s only delays the badge.
var probeSlowHTTP = &http.Client{
        Timeout:   40 * time.Second,
        Transport: netx.Transport(),
}

// providerStreamHTTP is the STREAMING client (v0.16). Chat completions from
// reasoning models regularly exceed 15s WALL-CLOCK (nemotron/kimi think for
// a minute before the first token) — an overall Client.Timeout would abort
// mid-stream. Here: no wall-clock cap; the per-turn context (Stop button,
// WS disconnect, 10-min engine turn guard) is the ONLY deadline.
var providerStreamHTTP = &http.Client{
        Timeout:   0,
        Transport: netx.Transport(),
}

// Package-internal provider quirks live here too.

// opencodeSessionID derives a stable per-key session id for OpenCode Zen.
//
// v0.25 LIVE-DISCOVERY: zen's FREE models (big-pickle, *-free) reject
// requests without an `x-session-id` header —
//
//      400 MissingSessionID "OpenCode's free tier can only be used in OpenCode"
//
// (the upstream "Console" provider gates the free tier on a client session).
// With ANY session id the free models serve normally (verified live:
// real completions from big-pickle + nemotron-3.5-lightning-free). Derived
// from the API key so it is stable across restarts with zero storage —
// the closest match to how the real OpenCode client identifies a session.
var opencodeSessionCache sync.Map // apiKey → session id

func opencodeSessionID(apiKey string) string {
        if id, ok := opencodeSessionCache.Load(apiKey); ok {
                return id.(string)
        }
        sum := sha256.Sum256([]byte("doomalay-zen-session:" + apiKey))
        id := "doomalay-" + hex.EncodeToString(sum[:8])
        opencodeSessionCache.Store(apiKey, id)
        return id
}

// v0.35 OPENCODE CLIENT IDENTITY (2026-09 live research): the Zen gateway
// fingerprints callers — plain API requests on FREE models answer
// 403 FreeTierError "OpenCode's free tier can only be used from within
// OpenCode" even with a perfectly valid key (verified: the same key on a
// PAID model answers 402 "insufficient funds", i.e. auth PASSED). The
// official client sends this exact header set; the IDs mirror its
// algorithm — 48-bit (ms-timestamp*4096 + counter), bit-flipped for
// descending session IDs, plus 14 base62 random chars. We send the full
// authentic set so requests match OpenCode's documented client contract
// (routing + prompt caching via x-opencode-session) as closely as a
// third-party client legitimately can.
const opencodeCLIVersion = "1.18.31"

var opencodeIDChars = []byte("0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz")
var opencodeIDMu sync.Mutex
var opencodeLastTS int64
var opencodeCounter int64

func opencodeGenerateID(prefix string, descending bool, ts int64) string {
        opencodeIDMu.Lock()
        if ts != opencodeLastTS {
                opencodeLastTS = ts
                opencodeCounter = 0
        }
        opencodeCounter++
        counter := opencodeCounter
        opencodeIDMu.Unlock()
        cur := ts*0x1000 + int64(counter)
        if descending {
                cur = ^cur
        }
        const hexDigits = "0123456789abcdef"
        var sb strings.Builder
        sb.WriteString(prefix)
        sb.WriteByte('_')
        for i := 0; i < 6; i++ {
                v := byte((cur >> (40 - 8*i)) & 0xff)
                sb.WriteByte(hexDigits[v>>4])
                sb.WriteByte(hexDigits[v&0xf])
        }
        var rnd [14]byte
        if _, err := crand.Read(rnd[:]); err != nil {
                for i := range rnd {
                        rnd[i] = byte(time.Now().UnixNano() >> (uint(i) * 3))
                }
        }
        for _, v := range rnd {
                sb.WriteByte(opencodeIDChars[v%62])
        }
        return sb.String()
}

// providerExtraHeaders returns provider-specific request headers beyond
// auth (v0.35: the full OpenCode CLI identity set — UA, client, project,
// session and request IDs — on top of the v0.25 x-session-id patch).
func providerExtraHeaders(provider, apiKey string) map[string]string {
        if provider == "opencode" {
                now := time.Now().UnixMilli()
                return map[string]string{
                        "User-Agent":         "opencode/" + opencodeCLIVersion + " ai-sdk/provider-utils/4.0.40 runtime/bun/1.3.14",
                        "x-opencode-client":  "cli",
                        "x-opencode-project": "global",
                        "x-opencode-session": opencodeGenerateID("ses", true, now-3000),
                        "x-opencode-request": opencodeGenerateID("msg", false, now),
                        "x-session-id":       opencodeSessionID(apiKey), // v0.25 legacy — still accepted, kept stable per key
                }
        }
        return nil
}

// httpGetJSON fetches a JSON URL. apiKey != "" adds a Bearer header.
// Returns the raw body bytes (parsing is the caller's job — shapes vary).
func httpGetJSON(url, apiKey string) ([]byte, error) {
        req, err := http.NewRequest("GET", url, nil)
        if err != nil {
                return nil, err
        }
        req.Header.Set("User-Agent", browserUA)
        req.Header.Set("Accept", "application/json")
        if apiKey != "" {
                req.Header.Set("Authorization", "Bearer "+apiKey)
        }
        resp, err := providerHTTP.Do(req)
        if err != nil {
                return nil, fmt.Errorf("fetch %s: %w", redactURL(url), err)
        }
        defer resp.Body.Close()
        if resp.StatusCode != 200 {
                return nil, fmt.Errorf("HTTP %d from %s", resp.StatusCode, redactURL(url))
        }
        return io.ReadAll(io.LimitReader(resp.Body, 4<<20)) // 4MB cap
}

// httpPostJSON posts a JSON body. Returns status + body bytes.
func httpPostJSON(url, apiKey string, payload any, extraHeaders map[string]string) (int, []byte, error) {
        return httpPostJSONWith(providerHTTP, url, apiKey, payload, extraHeaders)
}

// httpPostJSONWith — same, on a caller-supplied client (key probes use the
// slow client; model-sync and friends keep the fast one).
func httpPostJSONWith(client *http.Client, url, apiKey string, payload any, extraHeaders map[string]string) (int, []byte, error) {
        bodyBytes, err := json.Marshal(payload)
        if err != nil {
                return 0, nil, err
        }
        req, err := http.NewRequest("POST", url, bytes.NewReader(bodyBytes))
        if err != nil {
                return 0, nil, err
        }
        req.Header.Set("Content-Type", "application/json")
        req.Header.Set("User-Agent", browserUA)
        if apiKey != "" {
                req.Header.Set("Authorization", "Bearer "+apiKey)
        }
        for k, v := range extraHeaders {
                req.Header.Set(k, v)
        }
        resp, err := client.Do(req)
        if err != nil {
                return 0, nil, fmt.Errorf("post %s: %w", redactURL(url), err)
        }
        defer resp.Body.Close()
        bts, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
        return resp.StatusCode, bts, nil
}

// httpPostJSONStream posts a JSON body on the STREAM client (no wall-clock
// cap — v0.16: ReAct rounds + research steps generate long completions).
func httpPostJSONStream(url, apiKey string, payload any, extraHeaders map[string]string) (int, []byte, error) {
        bodyBytes, err := json.Marshal(payload)
        if err != nil {
                return 0, nil, err
        }
        req, err := http.NewRequest("POST", url, bytes.NewReader(bodyBytes))
        if err != nil {
                return 0, nil, err
        }
        req.Header.Set("Content-Type", "application/json")
        req.Header.Set("User-Agent", browserUA)
        if apiKey != "" {
                req.Header.Set("Authorization", "Bearer "+apiKey)
        }
        for k, v := range extraHeaders {
                req.Header.Set(k, v)
        }
        resp, err := providerStreamHTTP.Do(req)
        if err != nil {
                return 0, nil, fmt.Errorf("post %s: %w", redactURL(url), err)
        }
        defer resp.Body.Close()
        bts, _ := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
        return resp.StatusCode, bts, nil
}

// httpGetRaw fetches a URL with a custom UA + Accept and returns the body
// (for HTML scrapes like build.nvidia.com's model cards). 15s timeout.
func httpGetRaw(url, ua, accept string) (string, error) {
        req, err := http.NewRequest("GET", url, nil)
        if err != nil {
                return "", err
        }
        req.Header.Set("User-Agent", ua)
        req.Header.Set("Accept", accept)
        req.Header.Set("Accept-Language", "en-US,en;q=0.9")
        resp, err := providerHTTP.Do(req)
        if err != nil {
                return "", fmt.Errorf("fetch %s: %w", redactURL(url), err)
        }
        defer resp.Body.Close()
        if resp.StatusCode != 200 {
                return "", fmt.Errorf("HTTP %d from %s", resp.StatusCode, redactURL(url))
        }
        b, err := io.ReadAll(io.LimitReader(resp.Body, 8<<20)) // 8MB cap
        if err != nil {
                return "", err
        }
        return string(b), nil
}

// redactURL strips query strings from URLs for logs (queries can carry keys).
func redactURL(u string) string {
        for i := 0; i < len(u); i++ {
                if u[i] == '?' {
                        return u[:i]
                }
        }
        return u
}
