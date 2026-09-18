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
	"net/http"
	"runtime"
	"strconv"
	"strings"

	"github.com/ScoobyBaby1999/doomalay/engine/internal/brain"
	"github.com/ScoobyBaby1999/doomalay/engine/internal/config"
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

	s := &Server{cfg: cfg, db: db, vault: vault, brain: br, mux: http.NewServeMux()}
	// v0.29: the persona resolver needs DB access for the GLOBAL custom
	// placeholders (app_settings). Single server per process — as everywhere.
	currentServer = s
	s.routes()
	return s
}

// routes registers every API endpoint + the embedded PWA.
func (s *Server) routes() {
	// API endpoints (one per resource).
	s.mux.HandleFunc("GET /api/health", s.handleHealth)
	s.mux.HandleFunc("GET /api/capabilities", s.handleCapabilities)
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
	s.mux.HandleFunc("POST /api/sessions", s.handleSessionsCreate)
	s.mux.HandleFunc("GET /api/sessions/{id}", s.handleSessionsGet)
	s.mux.HandleFunc("PATCH /api/sessions/{id}", s.handleSessionsUpdate)
	s.mux.HandleFunc("DELETE /api/sessions/{id}", s.handleSessionsDelete)
	s.mux.HandleFunc("GET /api/sessions/{id}/events", s.handleSessionsEvents)
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
		if s.isOriginAllowed(origin) {
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
