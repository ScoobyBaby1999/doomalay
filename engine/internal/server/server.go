// Package server is the HTTP + WebSocket server. It wires the API handlers
// to the router, applies middleware (CORS, bearer auth, logging, SSRF guard,
// WebSocket origin check), and serves the embedded PWA from web/dist.
package server

import (
        "context"
        "embed"
        "encoding/json"
        "io/fs"
        "log"
        "net"
        "net/http"
        "net/url"
        "path/filepath"
        "runtime"
        "strconv"
        "strings"
        "sync"

        "github.com/ScoobyBaby1999/doomalay/engine/internal/brain"
        "github.com/ScoobyBaby1999/doomalay/engine/internal/buildinfo"
        "github.com/ScoobyBaby1999/doomalay/engine/internal/config"
        "github.com/ScoobyBaby1999/doomalay/engine/internal/forge"
        "github.com/ScoobyBaby1999/doomalay/engine/internal/hub"
        "github.com/ScoobyBaby1999/doomalay/engine/internal/secrets"
        "github.com/ScoobyBaby1999/doomalay/engine/internal/store"

        "github.com/ScoobyBaby1999/doomalay/engine/internal/llm"
)

//go:embed all:web
var webFS embed.FS

// Server holds all dependencies needed to serve requests.
type Server struct {
        cfg     *config.Config
        db      *store.DB
        vault   *secrets.Vault
        brain   *brain.Brain
        mux     *http.ServeMux
        httpSrv *http.Server
        hub     *hub.Service
        // v0.46: HF-chat remote brains (one per own Space, keyed by repo) +
        // the shared community sandbox client. Lazily built; refreshed on
        // vault changes (SetEnv fans out to all of them).
        remoteMu    sync.RWMutex
        remotes     map[string]*brain.RemoteBrain
        sharedBrain *brain.RemoteBrain
}

// New constructs the server and registers all routes.
func New(cfg *config.Config, db *store.DB, br *brain.Brain) *Server {
        vault, err := secrets.New(cfg.DataDir)
        if err != nil {
                log.Printf("warning: vault init failed: %v (keys will not persist)", err)
        }
        if br != nil && vault != nil {
                br.SetEnv(vault.AsEnv())
        }
        // v0.27.1: an optional GITHUB_TOKEN in the vault upgrades the
        // api.github.com metadata fallback past the 60 req/h anonymous
        // per-IP limit (carrier CGNAT and shared cloud IPs exhaust it).
        if vault != nil {
                llm.SetGitHubToken(vault.AsEnv()["GITHUB_TOKEN"])
        }

        s := &Server{cfg: cfg, db: db, vault: vault, brain: br, mux: http.NewServeMux(), remotes: map[string]*brain.RemoteBrain{}}
        // v0.31: the hub service (local store + vault + HF client). Nil-DB
        // safe for the pathological test boot (routes would 500, not panic).
        s.hub = hub.NewService(cfg.Hub.HFBase, db, vault)
        // v0.29: the persona resolver needs DB access for the GLOBAL custom
        // placeholders (app_settings). Single server per process — as everywhere.
        currentServer = s
        s.routes()
        s.healInterruptedTurns() // v0.39: boot heal — close out turns orphaned by a crash/restart
        return s
}

// healInterruptedTurns (v0.39 P8-FULL) closes out chat turns that were
// orphaned by an engine crash / Android watchdog kill / force-stop: a
// session whose event log has a `user` (or in-flight activity) AFTER the
// last terminal status never got its final status, so the transcript's
// replay ends mid-turn — the frontend's boot heal then flags "this reply
// was interrupted", which is honest, but the event log itself must not lie
// by omission forever. We append the missing terminal status so:
//   - the next open replays a terminal state (Send button works immediately),
//   - the LLM history builder folds the turn correctly,
//   - a later reconnect resume doesn't sit waiting for a stream that will
//     never come (the resumed socket sees the terminal and stops waiting).
func (s *Server) healInterruptedTurns() {
        if s.db == nil {
                return
        }
        sessions, err := s.db.ListSessions()
        if err != nil {
                return
        }
        healed := 0
        for _, sess := range sessions {
                events, err := s.db.ListEvents(sess.ID, 0)
                if err != nil {
                        continue
                }
                pending := false
                for _, ev := range events {
                        switch ev.EventType {
                        case "user":
                                pending = true
                        case "status":
                                // only TERMINAL states close the pending turn — a
                                // status{"running"} (emitted at turn start) must not.
                                if strings.Contains(ev.Content, `"idle"`) || strings.Contains(ev.Content, `"error"`) {
                                        pending = false
                                }
                        }
                }
                if pending {
                        if _, err := s.db.AppendEvent(sess.ID, "status", `{"state":"error","healed":true,"message":"interrupted by engine restart"}`, ""); err == nil {
                                healed++
                        }
                }
        }
        if healed > 0 {
                log.Printf("boot heal: closed %d interrupted turn(s) with a terminal status", healed)
        }
}

// routes registers every API endpoint + the embedded PWA.
func (s *Server) routes() {
        // API endpoints (one per resource).
        s.mux.HandleFunc("GET /api/health", s.handleHealth)
        s.mux.HandleFunc("GET /api/capabilities", s.handleCapabilities)
        // v0.48 (task 5): dev-build-only shared public provider keys.
        s.mux.HandleFunc("POST /api/dev/use-public-keys", s.handleDevUsePublicKeys)
        s.mux.HandleFunc("GET /api/models", s.handleModels)
        s.mux.HandleFunc("GET /api/templates", s.handleTemplates)
        s.mux.HandleFunc("GET /api/templates/{id}", s.handleTemplateGet)
        s.mux.HandleFunc("GET /api/keys", s.handleKeysList)
        s.mux.HandleFunc("POST /api/keys", s.handleKeysSet)
        s.mux.HandleFunc("DELETE /api/keys/{envVar}", s.handleKeysDelete)
        s.mux.HandleFunc("GET /api/keys/validate", s.handleKeysValidate)
        // v0.15: the PrivateMode SDK bridge (running in the WebView) needs the
        // key to establish its E2E-encrypted channel. Scoped to PM ONLY (a
        // general key-value endpoint would leak every provider's secret to
        // any same-origin JS bug). CORS middleware blocks foreign origins.
        s.mux.HandleFunc("GET /api/keys/value", s.handleKeysValue)
        s.mux.HandleFunc("GET /api/probe-embed", s.handleProbeEmbed)
        s.mux.HandleFunc("GET /api/netdiag", s.handleNetDiag)
        s.mux.HandleFunc("GET /api/device-info", s.handleDeviceInfo)
        s.mux.HandleFunc("GET /api/local-models", s.handleLocalModels)

        // v0.16: browser-side tool server (the PM SDK bridge's ReAct loop
        // calls these same-origin — search + SSRF-guarded page fetch).
        s.mux.HandleFunc("GET /api/tools/websearch", s.handleToolsWebSearch)
        s.mux.HandleFunc("GET /api/tools/webfetch", s.handleToolsWebFetch)
        // v0.20: local tool server for the PM bridge (calculator/time/
        // uuid/hash/json/… — same Go implementations the engine uses).
        s.mux.HandleFunc("GET /api/tools/local", s.handleToolsLocal)

        // v0.21: usage + cost tracking (per chat + fleet-wide).
        s.mux.HandleFunc("GET /api/sessions/{id}/usage", s.handleSessionUsage)
        s.mux.HandleFunc("GET /api/usage", s.handleUsageGlobal)

        // v0.29: the GLOBAL custom placeholders (every chatbot recognizes
        // them; scope switch lives in the personas → placeholders view).
        s.mux.HandleFunc("GET /api/placeholders", s.handlePlaceholdersGet)
        s.mux.HandleFunc("PUT /api/placeholders", s.handlePlaceholdersSet)
        s.mux.HandleFunc("DELETE /api/placeholders/{key}", s.handlePlaceholdersDelete)

        // Chat session CRUD.
        s.mux.HandleFunc("GET /api/sessions", s.handleSessionsList)
        // v0.41: global chat search — the visible transcript across all
        // sessions (the in-chat find bar is per-conversation; this finds
        // WHICH conversation something lived in).
        s.mux.HandleFunc("GET /api/search", s.handleSearch)
        s.mux.HandleFunc("GET /api/chats", s.handleChats)
        s.mux.HandleFunc("POST /api/sessions", s.handleSessionsCreate)
        s.mux.HandleFunc("GET /api/sessions/{id}", s.handleSessionsGet)
        s.mux.HandleFunc("PATCH /api/sessions/{id}", s.handleSessionsUpdate)
        s.mux.HandleFunc("DELETE /api/sessions/{id}", s.handleSessionsDelete)
        s.mux.HandleFunc("GET /api/sessions/{id}/events", s.handleSessionsEvents)
        // v0.30: per-chat UI TWEAKS (the ✦ tweaks pill — colors, text size,
        // background) + the chat's background image bytes. v0.44: the
        // gradient spec's blended texture rides its own rev'd row.
        s.mux.HandleFunc("GET /api/sessions/{id}/tweaks", s.handleSessionTweaksGet)
        s.mux.HandleFunc("PUT /api/sessions/{id}/tweaks", s.handleSessionTweaksPut)
        s.mux.HandleFunc("GET /api/sessions/{id}/background", s.handleSessionBackgroundGet)
        s.mux.HandleFunc("PUT /api/sessions/{id}/background", s.handleSessionBackgroundPut)
        s.mux.HandleFunc("DELETE /api/sessions/{id}/background", s.handleSessionBackgroundDelete)
        s.mux.HandleFunc("GET /api/sessions/{id}/texture", s.handleSessionTextureGet)
        s.mux.HandleFunc("PUT /api/sessions/{id}/texture", s.handleSessionTexturePut)
        s.mux.HandleFunc("DELETE /api/sessions/{id}/texture", s.handleSessionTextureDelete)
        // v0.15: frontend-driven turns (the PrivateMode SDK bridge chats
        // directly from the WebView — the engine can't speak PM's encrypted
        // protocol) append their events here so history + replay stay exact.
        s.mux.HandleFunc("POST /api/sessions/{id}/events", s.handleSessionsAppendEvent)
        // v0.28: the PM path's client-driven compaction lands here (the
        // engine owns event seqs; the WebView owns the PM model call).
        s.mux.HandleFunc("POST /api/sessions/{id}/compact", s.handleSessionCompact)

        // v0.16: chat-log export (the user-reviewable transcript — csv/md/json).
        s.mux.HandleFunc("GET /api/sessions/{id}/export.csv", s.handleSessionExport)
        s.mux.HandleFunc("GET /api/sessions/{id}/export.md", s.handleSessionExport)
        s.mux.HandleFunc("GET /api/sessions/{id}/export.json", s.handleSessionExport)

        // v0.17: per-chat ARTIFACTS (files the model / user produce —
        // create, list, open, edit, rename, delete, download).
        s.mux.HandleFunc("GET /api/sessions/{id}/artifacts", s.handleArtifactsList)
        s.mux.HandleFunc("POST /api/sessions/{id}/artifacts", s.handleArtifactsCreate)
        s.mux.HandleFunc("GET /api/sessions/{id}/artifacts/{aid}", s.handleArtifactGet)
        s.mux.HandleFunc("PUT /api/sessions/{id}/artifacts/{aid}", s.handleArtifactUpdate)
        s.mux.HandleFunc("DELETE /api/sessions/{id}/artifacts/{aid}", s.handleArtifactDelete)
        s.mux.HandleFunc("GET /api/sessions/{id}/artifacts/{aid}/download", s.handleArtifactDownload)
        // v0.23: complex-file viewers — docx/xlsx/archive previews, member
        // reads, and user-driven extract-to-artifacts.
        s.mux.HandleFunc("GET /api/sessions/{id}/artifacts/{aid}/preview", s.handleArtifactPreview)
        s.mux.HandleFunc("GET /api/sessions/{id}/artifacts/{aid}/entry", s.handleArtifactEntry)
        s.mux.HandleFunc("POST /api/sessions/{id}/artifacts/{aid}/extract", s.handleArtifactExtract)

        // WebSocket chat.
        s.mux.HandleFunc("GET /api/chat", s.handleChatWS)

        // v0.31: the Hub (modular library system) — per-type libraries,
        // items, downloads, endorsements, publishing, the persona-picker
        // hearts, and the HF token connect flow.
        s.mux.HandleFunc("GET /api/hub/libraries", s.handleHubLibraries)
        s.mux.HandleFunc("GET /api/hub/{type}/items", s.handleHubItems)
        s.mux.HandleFunc("GET /api/hub/{type}/downloads", s.handleHubDownloads)
        s.mux.HandleFunc("GET /api/hub/{type}/item/{repo}/{id}", s.handleHubItem)
        s.mux.HandleFunc("GET /api/hub/{type}/png/{repo}/{id}", s.handleHubPNG)
        s.mux.HandleFunc("POST /api/hub/{type}/download", s.handleHubDownload)
        s.mux.HandleFunc("POST /api/hub/{type}/endorse", s.handleHubEndorse(true))
        s.mux.HandleFunc("POST /api/hub/{type}/unendorse", s.handleHubEndorse(false))
        s.mux.HandleFunc("POST /api/hub/{type}/publish", s.handleHubPublish)
        s.mux.HandleFunc("POST /api/hub/persona/heart", s.handleHubPersonaHeart(true))
        s.mux.HandleFunc("POST /api/hub/persona/unheart", s.handleHubPersonaHeart(false))
        s.mux.HandleFunc("GET /api/hub/personas/hearted", s.handleHubPersonasHearted)
        s.mux.HandleFunc("GET /api/hub/auth/status", s.handleHubAuthStatus)
        s.mux.HandleFunc("POST /api/hub/auth/connect", s.handleHubAuthConnect)
        s.mux.HandleFunc("POST /api/hub/auth/disconnect", s.handleHubAuthDisconnect)

        // v0.45 ITEM 7: HF Spaces OAuth + create-from-scratch + status/logs/restart
        s.mux.HandleFunc("GET /api/hf/oauth/start", s.handleHFOAuthStart)
        s.mux.HandleFunc("GET /api/hf/oauth/callback", s.handleHFOAuthCallback)
        s.mux.HandleFunc("POST /api/hf/space/create", s.handleHFSpaceCreate)
        // v0.47 (task 9): the Docker-sandbox builder (fork + brick-by-brick).
        s.mux.HandleFunc("POST /api/hf/space/docker-create", s.handleHFSpaceDockerCreate)
        // v0.48 (task 9): pause a Space — frees the account's cpu-basic slot
        // (HF's own remedy for the quota wall; used by the docker-sandbox
        // picker's paused_quota state).
        s.mux.HandleFunc("POST /api/hf/space/pause", s.handleHFSpacePause)
        // v0.47 (task 11): the GitHub connect panel's status endpoint.
        s.mux.HandleFunc("GET /api/gh/account", s.handleGHAccount)
        s.mux.HandleFunc("POST /api/hf/space/ensure", s.handleHFSpaceEnsure)
        s.mux.HandleFunc("GET /api/hf/spaces", s.handleHFSpacesList)
        s.mux.HandleFunc("GET /api/hf/shared", s.handleHFShared)
        s.mux.HandleFunc("GET /api/hf/account", s.handleHFAccount)
        s.mux.HandleFunc("GET /api/hf/space/status", s.handleHFSpaceStatus)
        s.mux.HandleFunc("GET /api/hf/space/logs", s.handleHFSpaceLogs)
        s.mux.HandleFunc("POST /api/hf/space/restart", s.handleHFSpaceRestart)

        // ── v0.44 WORKSPACES (cloud repos for quick chat) ──────────────
        s.mux.HandleFunc("POST /api/workspaces/connect", s.handleWorkspacesConnect)
        s.mux.HandleFunc("GET /api/workspaces", s.handleWorkspacesList)
        s.mux.HandleFunc("GET /api/workspaces/{id}", s.handleWorkspaceGet)
        s.mux.HandleFunc("DELETE /api/workspaces/{id}", s.handleWorkspaceDelete)
        s.mux.HandleFunc("POST /api/workspaces/{id}/bind", s.handleWorkspaceBind)
        s.mux.HandleFunc("DELETE /api/workspaces/{id}/bind", s.handleWorkspaceUnbind)
        s.mux.HandleFunc("POST /api/workspaces/{id}/token", s.handleWorkspaceToken)
        s.mux.HandleFunc("GET /api/workspaces/{id}/tree", s.handleWorkspaceTree)
        s.mux.HandleFunc("GET /api/workspaces/{id}/file", s.handleWorkspaceFile)
        s.mux.HandleFunc("GET /api/workspaces/{id}/readme", s.handleWorkspaceReadme)
        s.mux.HandleFunc("GET /api/workspaces/{id}/grep", s.handleWorkspaceGrep)
        s.mux.HandleFunc("GET /api/workspaces/{id}/view/{what}", s.handleWorkspaceView)
        s.mux.HandleFunc("PUT /api/workspaces/{id}/file", s.handleWorkspacePutFile)
        s.mux.HandleFunc("POST /api/workspaces/{id}/fork", s.handleWorkspaceFork)
        s.mux.HandleFunc("POST /api/workspaces/{id}/clone", s.handleWorkspaceClone)
        s.mux.HandleFunc("POST /api/workspaces/create-repo", s.handleWorkspaceCreateRepo)
        s.mux.HandleFunc("GET /api/workspaces/licenses", s.handleWorkspaceLicenses)
        s.mux.HandleFunc("GET /api/workspaces/gitignores", s.handleWorkspaceGitignores)
        s.mux.HandleFunc("GET /api/workspaces/discover", s.handleWorkspaceDiscover)
        s.mux.HandleFunc("GET /api/workspaces/resolve", s.handleWorkspaceResolve)
        s.mux.HandleFunc("GET /api/sessions/{id}/workspaces", s.handleSessionWorkspacesList)
        s.mux.HandleFunc("POST /api/sessions/{id}/workspaces", s.handleSessionWorkspaceBind)
        s.mux.HandleFunc("DELETE /api/sessions/{id}/workspaces/{wid}", s.handleSessionWorkspaceUnbind)

        // v0.46: global forge accounts (paste-once sign-in), GitHub App
        // OAuth (web flow + auto refresh), device-storage workspaces, and
        // per-workspace branch selections.
        s.mux.HandleFunc("GET /api/workspaces/accounts", s.handleWorkspaceAccountsList)
        s.mux.HandleFunc("POST /api/workspaces/accounts", s.handleWorkspaceAccountSet)
        s.mux.HandleFunc("DELETE /api/workspaces/accounts", s.handleWorkspaceAccountDelete)
        s.mux.HandleFunc("POST /api/workspaces/device", s.handleWorkspaceDevice)
        s.mux.HandleFunc("POST /api/workspaces/{id}/branches", s.handleWorkspaceBranches)
        s.mux.HandleFunc("GET /api/workspaces/oauth/github/status", s.handleGHOAuthStatus)
        s.mux.HandleFunc("POST /api/workspaces/oauth/github/config", s.handleGHOAuthConfig)
        s.mux.HandleFunc("GET /api/workspaces/oauth/github/start", s.handleGHOAuthStart)
        s.mux.HandleFunc("GET /api/workspaces/oauth/github/callback", s.handleGHOAuthCallback)
        // v0.47 (task 10): the GitHub App's registered redirect URLs use
        // /api/github/oauth/callback (localhost:8123/:8080) — answer BOTH
        // paths so the user's existing registration just works.
        s.mux.HandleFunc("GET /api/github/oauth/callback", s.handleGHOAuthCallback)
        // v0.44 EXPLORE — the same repo surface, keyed by ?url= instead of
        // a stored workspace id (the brain's explore tool: ANY repo URL,
        // no connect step)
        s.mux.HandleFunc("GET /api/explore/tree", s.handleWorkspaceTree)
        s.mux.HandleFunc("GET /api/explore/file", s.handleWorkspaceFile)
        s.mux.HandleFunc("GET /api/explore/files", s.handleExploreFiles)
        s.mux.HandleFunc("GET /api/explore/readme", s.handleWorkspaceReadme)
        s.mux.HandleFunc("GET /api/explore/grep", s.handleWorkspaceGrep)
        s.mux.HandleFunc("GET /api/explore/view/{what}", s.handleWorkspaceView)
        s.mux.HandleFunc("GET /api/explore/repo", s.handleWorkspaceResolve)
        // the forge generic-git adapter needs the clone root wired once
        forge.SetGenericCloneDir(filepath.Join(s.cfg.DataDir, "workspaces"))

        // Embedded PWA (serves web/dist at /).
        distFS, _ := fs.Sub(webFS, "web")
        s.mux.Handle("/", http.FileServer(http.FS(distFS)))

        // v0.15: the vendored PrivateMode WASM (5.9MB gzipped). Serve it with
        // Content-Encoding: gzip so the WebView decompresses transparently —
        // WebAssembly.instantiateStreaming requires the correct MIME type.
        wasmGz, err := fs.ReadFile(webFS, "web/vendor/pm/privatemode.wasm.gz")
        if err == nil {
                s.mux.HandleFunc("GET /vendor/pm/privatemode.wasm", func(w http.ResponseWriter, r *http.Request) {
                        w.Header().Set("Content-Type", "application/wasm")
                        w.Header().Set("Content-Encoding", "gzip")
                        w.Header().Set("Cache-Control", "public, max-age=86400")
                        w.Header().Set("Content-Length", strconv.Itoa(len(wasmGz)))
                        if r.Method == http.MethodGet {
                                _, _ = w.Write(wasmGz)
                        }
                })
        } else {
                log.Printf("warning: PM wasm asset missing: %v", err)
        }
}

// ListenAndServe starts the HTTP server on addr (e.g. ":8080").
// Middleware order (outermost → innermost): CORS → auth → logging → panic
// recovery → handler.
func (s *Server) ListenAndServe(addr string) error {
        handler := s.corsMiddleware(s.authMiddleware(s.loggingMiddleware(s.recoverMiddleware(s.mux))))
        s.httpSrv = &http.Server{
                Addr:              addr,
                Handler:           handler,
                ReadHeaderTimeout: 10_000_000_000,  // 10s — mitigate slowloris
                ReadTimeout:       0,               // no limit (streaming)
                WriteTimeout:      0,               // no limit (streaming/SSE)
                IdleTimeout:       120_000_000_000, // 120s
        }
        return s.httpSrv.ListenAndServe()
}

// Shutdown gracefully stops the server.
func (s *Server) Shutdown(ctx context.Context) error {
        if s.httpSrv == nil {
                return nil
        }
        return s.httpSrv.Shutdown(ctx)
}

// ── Middleware ────────────────────────────────────────────────────────────

// corsMiddleware restricts cross-origin access. SECURITY: the engine must
// NOT allow arbitrary websites to call its API (a malicious site could read
// your chats or keys if you have the engine running).
//
// Allowed origins:
//  1. The PWA itself (same-origin — always allowed)
//  2. localhost + 127.0.0.1 on any port (dev server, the PWA in dev)
//  3. Origins explicitly listed in cfg.AllowedOrigins (for LAN/remote access)
//
// When the engine is bound to localhost only (the default), this is defense-
// in-depth. When bound to 0.0.0.0 (LAN/remote), this is critical.
func (s *Server) corsMiddleware(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
                origin := r.Header.Get("Origin")
                // Same-origin requests have no Origin header, or it matches the Host.
                // For non-browser requests (curl), Origin is empty — allow.
                if origin == "" {
                        next.ServeHTTP(w, r)
                        return
                }
                // v0.30.1: SAME-ORIGIN CORS-MODE requests must pass too. Module
                // scripts (<script type="module"> — the PrivateMode SDK is one)
                // are fetched in CORS mode and ALWAYS send Origin, even when the
                // page is same-origin. Through a reverse proxy or tunnel (the
                // localhost.run red-team) the page origin is the proxy host,
                // which the localhost-only allowlist below rejected — 403 on
                // /vendor/pm/*, a missing PM SDK, and a dead boot (recovery
                // screen). The page was served BY THIS ENGINE through THAT host,
                // so origin-host == request-Host means the request IS same-origin.
                if s.isOriginAllowed(origin) || isSameOrigin(r, origin) {
                        w.Header().Set("Access-Control-Allow-Origin", origin)
                        w.Header().Set("Vary", "Origin")
                        w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS")
                        // NOTE: X-Env-* is intentionally NOT in this list. That header is for
                        // engine→brain communication only (localhost, no CORS). The PWA must
                        // never send provider keys — they live in the engine's vault.
                        w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
                        w.Header().Set("Access-Control-Allow-Credentials", "false")
                        if r.Method == "OPTIONS" {
                                w.WriteHeader(http.StatusOK)
                                return
                        }
                        next.ServeHTTP(w, r)
                        return
                }
                // Origin not allowed — reject.
                log.Printf("blocked cross-origin request from %s", origin)
                http.Error(w, `{"error":"origin not allowed"}`, http.StatusForbidden)
        })
}

// isOriginAllowed checks if an origin is permitted to call the API.
func (s *Server) isOriginAllowed(origin string) bool {
        // Always allow localhost origins (dev server + the PWA served from the engine itself).
        for _, prefix := range []string{"http://localhost", "http://127.0.0.1", "https://localhost", "https://127.0.0.1"} {
                if strings.HasPrefix(origin, prefix) {
                        return true
                }
        }
        // Allow configured origins (for LAN/remote access — user opts in).
        for _, allowed := range s.cfg.AllowedOrigins {
                if origin == allowed {
                        return true
                }
        }
        return false
}

// isSameOrigin reports whether an Origin header matches the Host the client
// addressed (ignoring scheme, allowing default-port equivalences). A browser
// only lets a page's Origin equal the origin it FETCHED — so Origin==Host
// means the requesting page was served from THIS server through THIS host
// (the reverse-proxy / tunnel case: the localhost.run red-team served the PWA
// at https://<tunnel>.lhr.life, and every module script / CORS-mode fetch from
// that page carries Origin: https://<tunnel>.lhr.life with the same Host).
// A cross-site page cannot make its Origin match a Host it is fetching.
// (DNS-rebinding pages that re-point their own hostname at 127.0.0.1 are the
// residual case; modern browsers block public→local requests, the tunnel
// host is unguessable, and authMiddleware remains the enforcement point for
// non-localhost connections.)
func isSameOrigin(r *http.Request, origin string) bool {
        u, err := url.Parse(origin)
        if err != nil || u.Host == "" {
                return false
        }
        reqHost := r.Host
        var reqPort string
        if h, p, splitErr := net.SplitHostPort(r.Host); splitErr == nil {
                reqHost, reqPort = h, p
        }
        if !strings.EqualFold(u.Hostname(), reqHost) {
                return false
        }
        if u.Port() == reqPort {
                return true
        }
        // Default-port equivalences (Origin omits :443/:80, proxies may add it).
        def := map[string]string{"https": "443", "http": "80"}
        if d, ok := def[u.Scheme]; ok {
                if (u.Port() == "" && reqPort == d) || (reqPort == "" && u.Port() == d) {
                        return true
                }
        }
        return false
}

// Prewarm touches the expensive first-hit paths in the background so the
// FIRST real request after boot is fast (v0.30.1, from the red-team finding
// that cold first hits on /api/sessions + /api/models could take tens of
// seconds on-device): the SQLite page cache (sessions list), the vault
// decrypt path, and the model catalog background live-sync (started at boot
// instead of on the first /api/models call). Best-effort — failures log only.
func (s *Server) Prewarm() {
        defer func() {
                if rec := recover(); rec != nil {
                        log.Printf("prewarm: recovered: %v", rec)
                }
        }()
        if s.db != nil {
                if sessions, err := s.db.ListSessions(); err != nil {
                        log.Printf("prewarm: sessions: %v", err)
                } else {
                        log.Printf("prewarm: %d sessions warm", len(sessions))
                }
        }
        var keys map[string]string
        if s.vault != nil {
                _ = s.vault.List()
                keys = s.vault.AsEnv()
        }
        if keys == nil {
                keys = map[string]string{}
        }
        go llm.BuildCatalogV2(keys, false) // cold path: instant static + background live sync
        log.Printf("prewarm: catalog background sync started (engine %s)", buildinfo.Version)
}

// authMiddleware enforces the bearer token (when configured). SECURITY:
// when the engine is exposed to LAN/remote (bound to 0.0.0.0), a token
// MUST be set — otherwise anyone on the network can read your chats/keys.
//
// On localhost (the default), the token is optional — localhost is trusted.
// The engine logs a warning at startup if it's bound non-localhost with no token.
func (s *Server) authMiddleware(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
                // Health + capabilities are public (needed for onboarding discovery).
                if r.URL.Path == "/api/health" || r.URL.Path == "/api/capabilities" {
                        next.ServeHTTP(w, r)
                        return
                }
                if s.cfg.AuthToken == "" {
                        // No token configured — only allow localhost.
                        host := r.RemoteAddr
                        if strings.HasPrefix(host, "127.0.0.1") || strings.HasPrefix(host, "[::1]") || strings.HasPrefix(host, "localhost") {
                                next.ServeHTTP(w, r)
                                return
                        }
                        log.Printf("rejected non-localhost request with no auth token: %s", host)
                        http.Error(w, `{"error":"auth required for non-localhost access. Set auth_token in config."}`, http.StatusUnauthorized)
                        return
                }
                // Token configured — enforce it for all requests (including localhost).
                h := r.Header.Get("Authorization")
                if !strings.HasPrefix(h, "Bearer ") || h[7:] != s.cfg.AuthToken {
                        http.Error(w, `{"error":"unauthorized"}`, http.StatusUnauthorized)
                        return
                }
                next.ServeHTTP(w, r)
        })
}

// loggingMiddleware logs requests. SECURITY: never logs headers, bodies, or
// query params (which could contain tokens/keys). Only method + path.
func (s *Server) loggingMiddleware(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
                // Only log the method + path. No headers (could contain Authorization),
                // no query string (could contain session_id, though that's not secret),
                // no body (could contain API keys on POST /api/keys).
                log.Printf("%s %s", r.Method, r.URL.Path)
                next.ServeHTTP(w, r)
        })
}

// recoverMiddleware (v0.15, the crash fix): a panic in ANY handler would
// kill the whole engine process — on Android that meant a dead app with a
// white screen and no restart. A panic is now logged, returned as a 500,
// and the engine keeps serving.
func (s *Server) recoverMiddleware(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
                defer func() {
                        if rec := recover(); rec != nil {
                                log.Printf("PANIC recovered in %s %s: %v\n%s", r.Method, r.URL.Path, rec, debugStack())
                                // Best-effort 500 — headers may already be written.
                                defer func() { recover() }()
                                http.Error(w, `{"error":"internal panic — engine recovered"}`, http.StatusInternalServerError)
                        }
                }()
                next.ServeHTTP(w, r)
        })
}

// debugStack returns the current stack (trimmed) for panic logs.
func debugStack() string {
        buf := make([]byte, 8192)
        n := runtime.Stack(buf, false)
        if n > len(buf) {
                n = len(buf)
        }
        return string(buf[:n])
}

// ── Helpers ───────────────────────────────────────────────────────────────

func writeJSON(w http.ResponseWriter, status int, v any) {
        w.Header().Set("Content-Type", "application/json")
        w.WriteHeader(status)
        _ = json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, status int, msg string) {
        writeJSON(w, status, map[string]string{"error": msg})
}
