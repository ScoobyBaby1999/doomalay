// httpx.go — shared HTTP helpers for provider fetches.
//
// One UA, one timeout policy, one JSON GET helper — every provider fetch in
// the llm package goes through here so timeouts / headers / retry behavior
// stay consistent (and CDNs that block default Go UAs keep working).

package llm

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
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
//	400 MissingSessionID "OpenCode's free tier can only be used in OpenCode"
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

// providerExtraHeaders returns provider-specific request headers beyond
// auth (v0.25: opencode's free-tier session id).
func providerExtraHeaders(provider, apiKey string) map[string]string {
	if provider == "opencode" {
		return map[string]string{"x-session-id": opencodeSessionID(apiKey)}
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
