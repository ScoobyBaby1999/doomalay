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
	"encoding/base64"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/ScoobyBaby1999/doomalay/engine/internal/llm"
)

// handleToolsLocal is GET /api/tools/local?name=<tool>&args=<json>&session=<id> (v0.20).
//
// The PrivateMode bridge chats run in the WebView, so its browser-side
// ReAct loop needs a way to reach the engine's LOCAL tool set
// (calculator/time/uuid/hash/…) — same implementations the Go pipeline
// uses, one source of truth. Pure compute: no network, no FS, no keys,
// size-capped inputs.
//
// v0.22: `session` scopes the FILE tools (docx/xlsx/zip) — the binaries
// they build save into that session's artifact drawer, and zip_extract
// can re-read an artifact the model saved earlier in the same chat.
// The response carries the saved artifact meta so the PM UI renders a
// download card.
func (s *Server) handleToolsLocal(w http.ResponseWriter, r *http.Request) {
	name := r.URL.Query().Get("name")
	args := r.URL.Query().Get("args")
	// v0.25: DELEGATE on the PrivateMode path — the client-side ReAct loop
	// (pmsdk.js) parses `ACTION: delegate {…}` like any tool and POSTs here;
	// until now it got "unknown tool" (dock CSV event 31). Route it to the
	// same swarm fanout the Go loop uses (vault-resolved models).
	if name == "delegate" {
		s.handleToolsDelegate(w, r, args)
		return
	}
	if !llm.IsLocalTool(name) {
		// v0.20: unknown tool → a 200 OBSERVATION the model can learn
		// from. The old HTTP 400 just surfaced as "tool error" and
		// burned the retry without teaching the model anything.
		writeJSON(w, 200, map[string]any{
			"tool":   name,
			"result": "error: unknown tool \"" + name + "\". Valid local tools: " + strings.Join(llm.LocalToolNames, ", ") + ". Web tools: web_search {\"query\": \"...\"} and web_fetch {\"url\": \"...\"} (when web search is enabled).",
		})
		return
	}

	var sink llm.ArtifactSink
	sessID := r.URL.Query().Get("session")
	if sessID != "" {
		if sess, err := s.db.GetSession(sessID); err == nil && sess != nil {
			sink = &sessionArtifactSink{s: s, sessID: sessID}

			// zip_extract referencing a saved artifact by name → inject
			// the zip bytes as "b64" so the llm tool just sees bytes.
			if (name == "zip_extract" || name == "archive_extract") && args != "" && strings.Contains(args, "\"artifact\"") {
				var probe struct {
					Artifact string `json:"artifact"`
				}
				if json.Unmarshal([]byte(args), &probe) == nil && probe.Artifact != "" {
					if m, err := s.findArtifactByName(sessID, probe.Artifact); err == nil {
						if raw, err := os.ReadFile(filepath.Join(s.artifactDir(sessID), m.ID)); err == nil {
							var patched struct {
								B64 string `json:"b64"`
							}
							patched.B64 = base64.StdEncoding.EncodeToString(raw)
							if pb, err := json.Marshal(patched); err == nil {
								args = string(pb)
							}
						}
					}
				}
			}
		}
	}

	obs := llm.RunLocalTool(name, args, sink)
	text := strings.TrimPrefix(obs, "OBSERVATION:\n")
	resp := map[string]any{"tool": name, "result": text}
	// surface the saved file (name + id) so the PM chat can show a card
	if sink != nil && strings.Contains(text, "Saved as artifact ") {
		var probe struct {
			Name string `json:"name"`
		}
		if json.Unmarshal([]byte(args), &probe) == nil && probe.Name != "" {
			if m, err := s.findArtifactByName(sessID, probe.Name); err == nil {
				resp["artifact"] = map[string]any{
					"id": m.ID, "name": m.Name, "size": m.Size,
					"url": "/api/sessions/" + sessID + "/artifacts/" + m.ID + "/download",
				}
			}
		}
	}
	writeJSON(w, 200, resp)
}

// handleToolsDelegate runs the swarm fanout for the PM path's delegate
// ACTION (GET /api/tools/local?name=delegate&args={…}).
func (s *Server) handleToolsDelegate(w http.ResponseWriter, r *http.Request, args string) {
	var parsed struct {
		Prompt string   `json:"prompt"`
		Models []string `json:"models"`
	}
	if err := json.Unmarshal([]byte(args), &parsed); err != nil || parsed.Prompt == "" {
		writeJSON(w, 200, map[string]any{
			"tool":   "delegate",
			"result": "error: delegate needs {\"prompt\": \"...\", \"models\": [\"provider/model\", \"…\"]}",
		})
		return
	}
	var keys map[string]string
	if s.vault != nil {
		keys = s.vault.AsEnv()
	}
	outs := s.RunDelegate(r.Context(), parsed.Prompt, parsed.Models, keys)
	b, _ := json.Marshal(outs)
	writeJSON(w, 200, map[string]any{"tool": "delegate", "result": string(b)})
}

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
