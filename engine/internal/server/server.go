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
	"strings"

	"github.com/ScoobyBaby1999/doomalay/engine/internal/brain"
	"github.com/ScoobyBaby1999/doomalay/engine/internal/config"
	"github.com/ScoobyBaby1999/doomalay/engine/internal/secrets"
	"github.com/ScoobyBaby1999/doomalay/engine/internal/store"
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

	s := &Server{cfg: cfg, db: db, vault: vault, brain: br, mux: http.NewServeMux()}
	s.routes()
	return s
}

// routes registers every API endpoint + the embedded PWA.
func (s *Server) routes() {
	// API endpoints (one per resource).
	s.mux.HandleFunc("GET /api/health", s.handleHealth)
	s.mux.HandleFunc("GET /api/capabilities", s.handleCapabilities)
	s.mux.HandleFunc("GET /api/models", s.handleModels)
	s.mux.HandleFunc("GET /api/keys", s.handleKeysList)
	s.mux.HandleFunc("POST /api/keys", s.handleKeysSet)
	s.mux.HandleFunc("DELETE /api/keys/{envVar}", s.handleKeysDelete)

	// Chat session CRUD.
	s.mux.HandleFunc("GET /api/sessions", s.handleSessionsList)
	s.mux.HandleFunc("POST /api/sessions", s.handleSessionsCreate)
	s.mux.HandleFunc("GET /api/sessions/{id}", s.handleSessionsGet)
	s.mux.HandleFunc("PATCH /api/sessions/{id}", s.handleSessionsUpdate)
	s.mux.HandleFunc("DELETE /api/sessions/{id}", s.handleSessionsDelete)
	s.mux.HandleFunc("GET /api/sessions/{id}/events", s.handleSessionsEvents)

	// WebSocket chat.
	s.mux.HandleFunc("GET /api/chat", s.handleChatWS)

	// Embedded PWA (serves web/dist at /).
	distFS, _ := fs.Sub(webFS, "web")
	s.mux.Handle("/", http.FileServer(http.FS(distFS)))
}

// ListenAndServe starts the HTTP server on addr (e.g. ":8080").
// Middleware order (outermost → innermost): CORS → auth → logging → handler.
func (s *Server) ListenAndServe(addr string) error {
	handler := s.corsMiddleware(s.authMiddleware(s.loggingMiddleware(s.mux)))
	s.httpSrv = &http.Server{
		Addr:              addr,
		Handler:           handler,
		ReadHeaderTimeout: 10_000_000_000, // 10s — mitigate slowloris
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
//   1. The PWA itself (same-origin — always allowed)
//   2. localhost + 127.0.0.1 on any port (dev server, the PWA in dev)
//   3. Origins explicitly listed in cfg.AllowedOrigins (for LAN/remote access)
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

// ── Helpers ───────────────────────────────────────────────────────────────

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}
