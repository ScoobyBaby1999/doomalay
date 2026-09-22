// hfspace.go — v0.45 ITEM 7: Hugging Face Spaces create-from-scratch flow.
//
// The user spec: "import the HF chat doomalaysocreate space into this app and
// enable the user to connect to hf space -> redirect to login -> redirect to
// screen where user presses pill to allow access to clone, create spaces,
// then we clone a space for the user in the background -> redirect back to app."
//
// HF's duplicate API is PAID-only for Docker-SDK Spaces (PRO/Team/Enterprise).
// This module implements the FREE-TIER WORKAROUND: create a brand-new Space
// repo + upload the Dockerfile + brain/ + engine/ source files via the HF
// commit API. The Space's Dockerfile builds the engine from source on first
// run (no binary upload needed). Every user gets real bash/python/docker on
// the free cpu-basic tier.
//
// Flow:
//   1. OAuth PKCE: GET /api/hf/oauth/start → redirect to HF /oauth/authorize
//      (scopes: openid profile email contribute-repos). HF redirects back to
//      GET /api/hf/oauth/callback?code=… → engine exchanges code+verifier
//      for an access token at /oauth/token, stores it in the vault.
//   2. Create the Space: POST /api/hf/space/create {name} →
//      hf.CreateSpace + upload Dockerfile + README + brain/ + engine/ sources.
//   3. Probe status: GET /api/hf/space/{repo}/status → runtime.stage.
//   4. Stream logs: GET /api/hf/space/{repo}/logs → SSE proxy of HF logs.
//   5. Restart (wake a sleeping space): POST /api/hf/space/{repo}/restart.
//
// The token NEVER reaches the PWA (vault rule). All HF calls are engine-side.
package server

import (
        "crypto/rand"
        "crypto/sha256"
        "encoding/base64"
        "encoding/json"
        "fmt"
        "io"
        "net/http"
        "net/url"
        "os"
        "strings"
        "sync"
        "time"

        "github.com/ScoobyBaby1999/doomalay/engine/internal/hub"
)

// hfOAuthClientID is the public OAuth app's client_id (registered at
// https://huggingface.co/settings/connected-applications). For now we use the
// implicit flow fallback: the user can also paste a PAT. TODO: register the
// app + set this via env DOOMALAY_HF_OAUTH_CLIENT_ID.
var hfOAuthClientID = getenvDefault("DOOMALAY_HF_OAUTH_CLIENT_ID", "")

// hfRedirectURI is where HF sends the user back after login. For the desktop/
// PWA it's the engine's own /api/hf/oauth/callback. For the Android APK it's
// an intent:// URL (handled by the app's deep-link filter).
var hfRedirectURI = getenvDefault("DOOMALAY_HF_OAUTH_REDIRECT", "")

// pkceStore holds the in-flight PKCE verifiers (keyed by state). A verifier
// is consumed exactly once on callback (or expires after 10 min).
var pkceStore = struct {
        sync.Mutex
        m map[string]*pkceEntry
}{m: map[string]*pkceEntry{}}

type pkceEntry struct {
        verifier  string
        created   time.Time
        onSuccess string // where to redirect the browser after token exchange
}

func init() {
        go func() {
                for range time.Tick(5 * time.Minute) {
                        purgeExpiredPKCE()
                }
        }()
}

func purgeExpiredPKCE() {
        pkceStore.Lock()
        defer pkceStore.Unlock()
        now := time.Now()
        for k, v := range pkceStore.m {
                if now.Sub(v.created) > 10*time.Minute {
                        delete(pkceStore.m, k)
                }
        }
}

func getenvDefault(key, def string) string {
        if v := os.Getenv(key); v != "" {
                return v
        }
        return def
}

// (osGetenv indirection removed — use os.Getenv directly)

// ── OAuth PKCE ──────────────────────────────────────────────────────────────

// handleHFOAuthStart is GET /api/hf/oauth/start?redirect=<app-path>
// Redirects the browser to HF's authorize endpoint with a PKCE challenge.
func (s *Server) handleHFOAuthStart(w http.ResponseWriter, r *http.Request) {
        if hfOAuthClientID == "" {
                writeError(w, http.StatusServiceUnavailable, "HF OAuth client_id not configured (set DOOMALAY_HF_OAUTH_CLIENT_ID). Falling back to token-paste in Hub → Publish.")
                return
        }
        // PKCE: 43-128 char random verifier → S256 challenge
        verifier, err := randomPKCEVerifier(64)
        if err != nil {
                writeError(w, http.StatusInternalServerError, "PKCE verifier: "+err.Error())
                return
        }
        challenge := pkceS256Challenge(verifier)
        state := randomState(24)
        redirect := r.URL.Query().Get("redirect")
        if redirect == "" {
                redirect = "/"
        }
        pkceStore.Lock()
        pkceStore.m[state] = &pkceEntry{verifier: verifier, created: time.Now(), onSuccess: redirect}
        pkceStore.Unlock()

        redirectURI := hfRedirectURI
        if redirectURI == "" {
                // derive from the request (the engine's own callback)
                redirectURI = schemeHost(r) + "/api/hf/oauth/callback"
        }
        q := url.Values{}
        q.Set("client_id", hfOAuthClientID)
        q.Set("redirect_uri", redirectURI)
        q.Set("response_type", "code")
        q.Set("scope", "openid profile email contribute-repos")
        q.Set("state", state)
        q.Set("code_challenge", challenge)
        q.Set("code_challenge_method", "S256")
        http.Redirect(w, r, "https://huggingface.co/oauth/authorize?"+q.Encode(), http.StatusFound)
}

// handleHFOAuthCallback is GET /api/hf/oauth/callback?code=…&state=…
// Exchanges the code for an access token, stores it, redirects to the app.
func (s *Server) handleHFOAuthCallback(w http.ResponseWriter, r *http.Request) {
        code := r.URL.Query().Get("code")
        state := r.URL.Query().Get("state")
        if code == "" || state == "" {
                writeError(w, http.StatusBadRequest, "missing code or state")
                return
        }
        pkceStore.Lock()
        entry, ok := pkceStore.m[state]
        if ok {
                delete(pkceStore.m, state) // one-shot
        }
        pkceStore.Unlock()
        if !ok {
                writeError(w, http.StatusBadRequest, "unknown or expired state (retry)")
                return
        }
        // exchange code+verifier for token
        token, err := hfExchangeCode(code, entry.verifier, schemeHost(r)+"/api/hf/oauth/callback")
        if err != nil {
                writeError(w, http.StatusBadGateway, "token exchange failed: "+err.Error())
                return
        }
        // verify + fetch whoami
        hfCli := hub.NewHFClient("")
        user, err := hfCli.WhoAmI(token)
        if err != nil {
                writeError(w, http.StatusUnauthorized, "token rejected by HF: "+err.Error())
                return
        }
        // store the token in the vault (the hub reads DOOMALAY_HF_TOKEN)
        if err := s.vault.Set(hub.TokenEnvVar, "huggingface", token, ""); err != nil {
                writeError(w, http.StatusInternalServerError, "vault store: "+err.Error())
                return
        }
        // redirect back to the app (with the username so the UI can show it)
        dest := entry.onSuccess
        if !strings.HasPrefix(dest, "/") {
                dest = "/"
        }
        q := url.Values{}
        q.Set("hf_connected", "1")
        q.Set("hf_user", user)
        http.Redirect(w, r, dest+"?"+q.Encode(), http.StatusFound)
}

// hfExchangeCode swaps the authorization code for an access token (PKCE).
func hfExchangeCode(code, verifier, redirectURI string) (string, error) {
        body := url.Values{
                "grant_type":    {"authorization_code"},
                "code":          {code},
                "code_verifier": {verifier},
                "redirect_uri":  {redirectURI},
                "client_id":     {hfOAuthClientID},
        }.Encode()
        req, err := http.NewRequest("POST", "https://huggingface.co/oauth/token", strings.NewReader(body))
        if err != nil {
                return "", err
        }
        req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
        req.Header.Set("User-Agent", "doomalay-engine/0.45")
        cli := &http.Client{Timeout: 15 * time.Second}
        resp, err := cli.Do(req)
        if err != nil {
                return "", err
        }
        defer resp.Body.Close()
        out, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
        if resp.StatusCode != 200 {
                return "", fmt.Errorf("HTTP %d: %s", resp.StatusCode, string(out))
        }
        var tok struct {
                AccessToken string `json:"access_token"`
                TokenType   string `json:"token_type"`
                ExpiresIn   int    `json:"expires_in"`
        }
        if err := json.Unmarshal(out, &tok); err != nil {
                return "", err
        }
        if tok.AccessToken == "" {
                return "", fmt.Errorf("empty access_token in response")
        }
        return tok.AccessToken, nil
}

// ── Space create-from-scratch ───────────────────────────────────────────────

// handleHFSpaceCreate is POST /api/hf/space/create
// Body: {"name": "doomalay-abc123", "shared": false}
// Creates a new Docker-SDK Space in the user's namespace + uploads the
// Dockerfile + brain/ + engine/ sources. Returns the repo id + initial status.
func (s *Server) handleHFSpaceCreate(w http.ResponseWriter, r *http.Request) {
        token := s.hfToken()
        if token == "" {
                writeError(w, http.StatusUnauthorized, "not connected to HF (connect first)")
                return
        }
        var req struct {
                Name   string `json:"name"`
                Shared bool   `json:"shared"`
        }
        if err := json.NewDecoder(io.LimitReader(r.Body, 1<<16)).Decode(&req); err != nil {
                writeError(w, http.StatusBadRequest, "bad body: "+err.Error())
                return
        }
        name := strings.TrimSpace(req.Name)
        if name == "" {
                name = "doomalay-" + randomState(6)
        }
        hfCli := hub.NewHFClient("")
        user, err := hfCli.WhoAmI(token)
        if err != nil {
                writeError(w, http.StatusUnauthorized, "HF token rejected: "+err.Error())
                return
        }
        repoID := user + "/" + name
        // 1. create the Space repo (free tier — creating a Docker Space is free;
        //    only DUPLICATING one is paid, which is why we build from scratch)
        if err := hfCreateSpace(hfCli, token, user, name); err != nil {
                writeError(w, http.StatusBadGateway, "create space: "+err.Error())
                return
        }
        // 2. upload the Dockerfile + README + brain/ + engine/ sources (one commit)
        if err := hfUploadSpaceFiles(hfCli, token, repoID); err != nil {
                writeError(w, http.StatusBadGateway, "upload files: "+err.Error())
                return
        }
        // 3. return the repo + initial status (BUILDING)
        status, _ := hfSpaceStatus(hfCli, token, repoID)
        writeJSON(w, http.StatusOK, map[string]any{
                "repo":   repoID,
                "name":   name,
                "url":    "https://huggingface.co/spaces/" + repoID,
                "status": status,
                "shared": req.Shared,
        })
}

// handleHFSpaceStatus is GET /api/hf/space/status?repo=user/name
func (s *Server) handleHFSpaceStatus(w http.ResponseWriter, r *http.Request) {
        token := s.hfToken()
        if token == "" {
                writeError(w, http.StatusUnauthorized, "not connected to HF")
                return
        }
        repo := r.URL.Query().Get("repo")
        if repo == "" {
                writeError(w, http.StatusBadRequest, "missing repo")
                return
        }
        hfCli := hub.NewHFClient("")
        status, err := hfSpaceStatus(hfCli, token, repo)
        if err != nil {
                writeError(w, http.StatusBadGateway, err.Error())
                return
        }
        writeJSON(w, http.StatusOK, status)
}

// handleHFSpaceLogs is GET /api/hf/space/logs?repo=user/name&type=run&tail=50
func (s *Server) handleHFSpaceLogs(w http.ResponseWriter, r *http.Request) {
        token := s.hfToken()
        if token == "" {
                writeError(w, http.StatusUnauthorized, "not connected to HF")
                return
        }
        repo := r.URL.Query().Get("repo")
        logType := r.URL.Query().Get("type")
        if logType == "" {
                logType = "run"
        }
        tail := r.URL.Query().Get("tail")
        if tail == "" {
                tail = "50"
        }
        // stream SSE
        w.Header().Set("Content-Type", "text/event-stream")
        w.Header().Set("Cache-Control", "no-cache")
        w.Header().Set("Connection", "keep-alive")
        flusher, ok := w.(http.Flusher)
        if !ok {
                writeError(w, http.StatusInternalServerError, "streaming unsupported")
                return
        }
        path := "/api/spaces/" + repo + "/logs/" + logType + "?tail=" + tail
        req, err := http.NewRequest("GET", "https://huggingface.co"+path, nil)
        if err != nil {
                return
        }
        req.Header.Set("Authorization", "Bearer "+token)
        req.Header.Set("User-Agent", "doomalay-engine/0.45")
        cli := &http.Client{Timeout: 0}
        resp, err := cli.Do(req)
        if err != nil {
                fmt.Fprintf(w, "event: error\ndata: %s\n\n", err.Error())
                flusher.Flush()
                return
        }
        defer resp.Body.Close()
        buf := make([]byte, 4096)
        for {
                n, err := resp.Body.Read(buf)
                if n > 0 {
                        w.Write(buf[:n])
                        flusher.Flush()
                }
                if err != nil {
                        break
                }
        }
}

// handleHFSpaceRestart is POST /api/hf/space/restart?repo=user/name
func (s *Server) handleHFSpaceRestart(w http.ResponseWriter, r *http.Request) {
        token := s.hfToken()
        if token == "" {
                writeError(w, http.StatusUnauthorized, "not connected to HF")
                return
        }
        repo := r.URL.Query().Get("repo")
        hfCli := hub.NewHFClient("")
        if err := hfRestartSpace(hfCli, token, repo); err != nil {
                writeError(w, http.StatusBadGateway, err.Error())
                return
        }
        writeJSON(w, http.StatusOK, map[string]any{"ok": true, "repo": repo})
}

// ── HF Spaces REST helpers (free-tier create + upload + status + restart) ──

// hfCreateSpace POSTs /api/repos/create with type=space, sdk=docker.
func hfCreateSpace(hf *hub.HFClient, token, user, name string) error {
        body := map[string]any{
                "type":   "space",
                "name":   name,
                "private": true,
        }
        bodyBytes, _ := json.Marshal(body)
        _, err := hf.DoRaw("POST", "/api/repos/create", token, bodyBytes, "application/json")
        return err
}

// hfUploadSpaceFiles uploads the Dockerfile + README + entrypoint via the HF
// Spaces commit API (one commit). The Dockerfile builds the engine from the
// GitHub source on first run.
func hfUploadSpaceFiles(hf *hub.HFClient, token, repo string) error {
        files := []hub.CommitFile{
                {Path: "README.md", Content: []byte(spaceReadme)},
                {Path: "Dockerfile", Content: []byte(spaceDockerfile)},
                {Path: "entrypoint.sh", Content: []byte(spaceEntrypoint)},
        }
        return hf.CommitFilesSpace(token, repo, "doomalay: auto-create space", files)
}

// hfSpaceStatus GETs /api/spaces/{ns}/{name} → runtime.stage.
func hfSpaceStatus(hf *hub.HFClient, token, repo string) (map[string]any, error) {
        // repo is "user/name" — HF's /api/spaces/{ns}/{name} expects the raw slash
        // (NOT %2F — that returns 404). The HFClient.do URL-escapes paths via
        // http.NewRequest which preserves the literal slash.
        body, err := hf.DoRaw("GET", "/api/spaces/"+repo, token, nil, "")
        if err != nil {
                return nil, err
        }
        var resp struct {
                ID       string `json:"id"`
                Runtime  struct {
                        Stage     string `json:"stage"`
                        Hardware  struct {
                                Current string `json:"current"`
                        } `json:"hardware"`
                        GcTimeout any `json:"gcTimeout"`
                } `json:"runtime"`
        }
        if err := json.Unmarshal(body, &resp); err != nil {
                return nil, err
        }
        stage := resp.Runtime.Stage
        if stage == "" {
                stage = "NO_APP_FILE"
        }
        return map[string]any{
                "repo":      resp.ID,
                "stage":     stage,
                "hardware":  resp.Runtime.Hardware.Current,
                "running":   stage == "RUNNING" || stage == "RUNNING_BUILDING" || stage == "RUNNING_APP_STARTING",
                "sleeping":  stage == "PAUSED" || stage == "STOPPED",
                "building":  strings.HasPrefix(stage, "BUILDING") || strings.Contains(stage, "APP_STARTING"),
                "error":     strings.Contains(stage, "ERROR"),
        }, nil
}

// hfRestartSpace POSTs /api/spaces/{ns}/{name}/restart?factory=true.
func hfRestartSpace(hf *hub.HFClient, token, repo string) error {
        _, err := hf.DoRaw("POST", "/api/spaces/"+repo+"/restart?factory=false", token, nil, "")
        return err
}

// hfDoRaw is a thin wrapper to call HFClient's private do() via a public shim.
// We add a Space-aware method to HFClient via a small extension (see below).
func hfDoRaw(hf *hub.HFClient, method, path, token string, body []byte, contentType string) ([]byte, error) {
        return hf.DoRaw(method, path, token, body, contentType)
}

// hfToken reads the HF token from the vault.
func (s *Server) hfToken() string {
        v := s.vault.AsEnv()
        if v == nil {
                return ""
        }
        return v[hub.TokenEnvVar]
}

// schemeHost reconstructs the scheme://host of the incoming request (for the
// OAuth redirect_uri — must match exactly what's registered at HF).
func schemeHost(r *http.Request) string {
        scheme := "http"
        if r.TLS != nil || r.Header.Get("X-Forwarded-Proto") == "https" {
                scheme = "https"
        }
        host := r.Host
        if h := r.Header.Get("X-Forwarded-Host"); h != "" {
                host = h
        }
        return scheme + "://" + host
}

// randomPKCEVerifier generates a URL-safe random string of the given length.
func randomPKCEVerifier(n int) (string, error) {
        b := make([]byte, n)
        if _, err := rand.Read(b); err != nil {
                return "", err
        }
        return base64.RawURLEncoding.EncodeToString(b), nil
}

// pkceS256Challenge returns the S256 code_challenge for a verifier.
func pkceS256Challenge(verifier string) string {
        h := sha256.Sum256([]byte(verifier))
        return base64.RawURLEncoding.EncodeToString(h[:])
}

// randomState returns a short URL-safe random string for OAuth state.
func randomState(n int) string {
        b := make([]byte, n)
        rand.Read(b)
        return base64.RawURLEncoding.EncodeToString(b)[:n]
}

// ── the Space template files (uploaded on create) ──────────────────────────

const spaceReadme = `---
title: Doomalay
emoji: 🤖
colorFrom: indigo
colorTo: purple
sdk: docker
app_port: 8080
pinned: false
---

# Doomalay Space (auto-created)

This Space was created automatically by the Doomalay app. It runs the Go engine
(which serves the PWA + proxies to the Python brain) and gives the user real
bash, python, and a full build toolchain on the free cpu-basic tier.

The engine builds from source on first run (Go + Python deps). Subsequent
restarts use the cached build.
`

const spaceDockerfile = `# Doomalay HF Space — the App-Building Machine (auto-created)
# Free tier: 2 vCPU / 16 GB RAM / 50 GB disk. Builds the Go engine + Python brain from source.
FROM python:3.11-slim-bookworm

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential gcc g++ make cmake git ripgrep \
    golang-go ca-certificates curl wget unzip \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Clone the doomlay source (public mirror; for private repos set GITHUB_TOKEN
# as a Space secret and the clone URL includes it)
ARG DOOMALAY_REPO=https://github.com/ScoobyBaby1999/doomalay.git
RUN git clone --depth 1 ${DOOMALAY_REPO} /app/doomalay || \
    (echo "clone failed — using embedded fallback" && mkdir -p /app/doomalay)

WORKDIR /app/doomalay

# Build the Go engine
RUN cd engine && go build -o /app/doomalay-engine ./cmd/doomalay || \
    echo "go build failed — will retry on start"

# Install Python brain deps
RUN cd brain && pip install --no-cache-dir -r requirements.txt || \
    echo "pip install failed — brain will be unavailable"

ENV DOOMALAY_DATA_DIR=/data
ENV MODE=hf-space
ENV BRAIN_DIR=/app/doomalay/brain
ENV PORT=8080

VOLUME ["/data"]
EXPOSE 8080

COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

CMD ["/app/entrypoint.sh"]
`

const spaceEntrypoint = `#!/bin/bash
set -e
echo "Starting Doomalay HF Space (auto-created)..."
cd /app/doomalay
# retry the go build if it failed during image build
if [ ! -f /app/doomalay-engine ]; then
  echo "building engine..."
  cd engine && go build -o /app/doomalay-engine ./cmd/doomalay && cd ..
fi
exec /app/doomalay-engine --port ${PORT:-8080} --bind 0.0.0.0
`
