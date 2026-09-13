// httpx.go — shared HTTP helpers for provider fetches.
//
// One UA, one timeout policy, one JSON GET helper — every provider fetch in
// the llm package goes through here so timeouts / headers / retry behavior
// stay consistent (and CDNs that block default Go UAs keep working).

package llm

import (
        "bytes"
        "encoding/json"
        "fmt"
        "io"
        "net/http"
        "time"

        "github.com/ScoobyBaby1999/doomalay/engine/internal/netx"
)

// browserUA mirrors a mobile Chrome client — several provider CDNs
// (Cloudflare-fronted portals especially) challenge or block the default
// Go http-client UA.
const browserUA = "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36"

// providerHTTP is the shared client: 15s timeout, sane connection pooling.
// v0.14: uses netx.Transport() — the DoH fallback dialer that fixes outbound
// HTTP on Android (pure-Go resolver without /etc/resolv.conf).
var providerHTTP = &http.Client{
        Timeout: 15 * time.Second,
        Transport: netx.Transport(),
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
        resp, err := providerHTTP.Do(req)
        if err != nil {
                return 0, nil, fmt.Errorf("post %s: %w", redactURL(url), err)
        }
        defer resp.Body.Close()
        bts, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
        return resp.StatusCode, bts, nil
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
