package server

// tools.go — v0.16 GET /api/tools/websearch + /api/tools/webfetch.
//
// The PrivateMode SDK bridge chats directly from the WebView (PM's E2E
// encryption only speaks in the browser). Until now that meant PM turns
// had NO web-search capability — the engine's ReAct loop lives on the Go
// side, which can't drive a PM conversation.
//
// These routes give the browser-side PM agent the SAME tools the Go
// pipeline uses: the engine becomes the tool server (SSRF-guarded page
// fetch + DDG/Tavily search), and pmsdk.js runs the ReAct ACTION loop
// client-side. Same-origin, so no CORS, and the key never leaves the
// device vault except through PM's own encrypted channel.

import (
	"encoding/json"
	"net/http"
	"strconv"

	"github.com/ScoobyBaby1999/doomalay/engine/internal/llm"
)

// handleToolsWebSearch is GET /api/tools/websearch?q=<query>&max=<n>
func (s *Server) handleToolsWebSearch(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query().Get("q")
	if q == "" {
		writeError(w, 400, "missing q")
		return
	}
	max := 8
	if v := r.URL.Query().Get("max"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 && n <= 20 {
			max = n
		}
	}
	tavilyKey := ""
	if s.vault != nil {
		env := s.vault.AsEnv()
		tavilyKey = env["TAVILY_API_KEY"]
	}
	results, err := llm.WebSearch(r.Context(), q, max, tavilyKey)
	if err != nil {
		writeError(w, 502, "search: "+err.Error())
		return
	}
	writeJSON(w, 200, map[string]any{"query": q, "results": results})
}

// handleToolsWebFetch is GET /api/tools/webfetch?url=<url>&max=<chars>
func (s *Server) handleToolsWebFetch(w http.ResponseWriter, r *http.Request) {
	rawURL := r.URL.Query().Get("url")
	if rawURL == "" {
		writeError(w, 400, "missing url")
		return
	}
	maxChars := 8000
	if v := r.URL.Query().Get("max"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 && n <= 50000 {
			maxChars = n
		}
	}
	text, err := llm.WebFetch(r.Context(), rawURL, maxChars)
	if err != nil {
		writeError(w, 502, "fetch: "+err.Error())
		return
	}
	var b []byte
	b, _ = json.Marshal(map[string]any{"url": rawURL, "text": text})
	w.Header().Set("Content-Type", "application/json")
	w.Write(b)
}
