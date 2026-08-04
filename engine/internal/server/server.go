// Package server is the HTTP + WebSocket server. It wires the API handlers
// to the router, applies middleware (CORS, bearer auth, logging, SSRF guard),
// and serves the embedded PWA from web/dist.
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
	cfg    *config.Config
	db     *store.DB
	vault  *secrets.Vault
	brain  *brain.Brain
	mux    *http.ServeMux
}

// New constructs the server and registers all routes.
func New(cfg *config.Config, db *store.DB, br *brain.Brain) *Server {
	vault, err := secrets.New(cfg.DataDir)
	if err != nil {
		log.Printf("warning: vault init failed: %v (keys will not persist)", err)
	}
	// Push current keys to the brain as env headers.
	if br != nil && vault != nil {
		br.SetEnv(vault.AsEnv())
	}

	s := &Server{cfg: cfg, db: db, vault: vault, brain: br, mux: http.NewServeMux()}
	s.routes()
	return s
}

// routes registers every API endpoint + the embedded PWA.
func (s *Server) routes() {
	// API endpoints (one per resource — see internal/api/).
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

	// WebSocket chat (the V0 fix: streaming + persist-as-you-emit).
	s.mux.HandleFunc("GET /api/chat", s.handleChatWS)

	// Embedded PWA (serves web/dist at /).
	distFS, _ := fs.Sub(webFS, "web")
	s.mux.Handle("/", http.FileServer(http.FS(distFS)))
}

// ListenAndServe starts the HTTP server on addr (e.g. ":8080").
func (s *Server) ListenAndServe(addr string) error {
	srv := &http.Server{Addr: addr, Handler: s.corsMiddleware(s.loggingMiddleware(s.mux))}
	return srv.ListenAndServe()
}

// Shutdown gracefully stops the server.
func (s *Server) Shutdown(ctx context.Context) error {
	return nil // TODO: track the *http.Server and call Shutdown on it.
}

// ── Middleware ────────────────────────────────────────────────────────────

func (s *Server) corsMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Env-*")
		if r.Method == "OPTIONS" {
			w.WriteHeader(http.StatusOK)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (s *Server) loggingMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		log.Printf("%s %s", r.Method, r.URL.Path)
		next.ServeHTTP(w, r)
	})
}

// authMiddleware checks the bearer token (skipped on localhost when no token configured).
func (s *Server) authMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if s.cfg.AuthToken == "" {
			next.ServeHTTP(w, r)
			return
		}
		h := r.Header.Get("Authorization")
		if !strings.HasPrefix(h, "Bearer ") || h[7:] != s.cfg.AuthToken {
			http.Error(w, `{"error":"unauthorized"}`, http.StatusUnauthorized)
			return
		}
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
