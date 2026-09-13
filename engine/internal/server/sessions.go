package server

import (
        "crypto/rand"
        "encoding/hex"
        "encoding/json"
        "net/http"
        "strconv"
        "time"

        "github.com/ScoobyBaby1999/doomalay/engine/internal/store"
)

// handleSessionsList is GET /api/sessions — list all chat sessions (newest first).
func (s *Server) handleSessionsList(w http.ResponseWriter, r *http.Request) {
        sessions, err := s.db.ListSessions()
        if err != nil {
                writeError(w, 500, "list: "+err.Error())
                return
        }
        if sessions == nil {
                sessions = []*store.Session{}
        }
        writeJSON(w, 200, map[string]any{"sessions": sessions})
}

// handleSessionsCreate is POST /api/sessions — create a new chat session.
func (s *Server) handleSessionsCreate(w http.ResponseWriter, r *http.Request) {
        var req struct {
                ID            string `json:"id"`
                Title         string `json:"title"`
                Model         string `json:"model"`
                Provider      string `json:"provider"`
                Sandbox       string `json:"sandbox"`
                Effort        string `json:"effort"`
                Mode          string `json:"mode"`
                WebSearch     bool   `json:"web_search"`
                DeepResearch  bool   `json:"deep_research"`
                WebTemplate   string `json:"web_template"`
                DeepTemplate  string `json:"deep_template"`
                DeepMode      string `json:"deep_mode"`
                JudgeCount    int    `json:"judge_count"`
                JudgeTemplate string `json:"judge_template"`
                SlidingWindow int    `json:"sliding_window"`
                MaxContext    int    `json:"max_context"`
                ToolAllowlist string `json:"tool_allowlist"`
                Routing       string `json:"routing"`
                WorkspaceID   string `json:"workspace_id"`
        }
        if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
                writeError(w, 400, "invalid JSON: "+err.Error())
                return
        }
        if req.ID == "" {
                req.ID = generateID()
        }
        if req.Title == "" {
                req.Title = "New Chat"
        }
        if req.Effort == "" {
                req.Effort = "med"
        }
        if req.Mode == "" {
                req.Mode = "auto"
        }
        if req.JudgeCount == 0 {
                req.JudgeCount = 3
        }
        if req.JudgeTemplate == "" {
                req.JudgeTemplate = "critique"
        }
        if req.SlidingWindow == 0 {
                req.SlidingWindow = 40
        }
        if req.MaxContext == 0 {
                req.MaxContext = 128000
        }
        sess := &store.Session{
                ID:            req.ID,
                Title:         req.Title,
                Model:         req.Model,
                Provider:      req.Provider,
                Sandbox:       req.Sandbox,
                Effort:        req.Effort,
                Mode:          req.Mode,
                WebSearch:     req.WebSearch,
                DeepResearch:  req.DeepResearch,
                WebTemplate:   req.WebTemplate,
                DeepTemplate:  req.DeepTemplate,
                DeepMode:      req.DeepMode,
                JudgeCount:    req.JudgeCount,
                JudgeTemplate: req.JudgeTemplate,
                SlidingWindow: req.SlidingWindow,
                MaxContext:    req.MaxContext,
                ToolAllowlist: req.ToolAllowlist,
                Routing:       req.Routing,
                WorkspaceID:   req.WorkspaceID,
        }
        if err := s.db.CreateSession(sess); err != nil {
                writeError(w, 500, "create: "+err.Error())
                return
        }
        writeJSON(w, 201, sess)
}

// handleSessionsGet is GET /api/sessions/{id} — fetch one session.
func (s *Server) handleSessionsGet(w http.ResponseWriter, r *http.Request) {
        id := r.PathValue("id")
        sess, err := s.db.GetSession(id)
        if err != nil {
                writeError(w, 500, "get: "+err.Error())
                return
        }
        if sess == nil {
                writeError(w, 404, "not found")
                return
        }
        writeJSON(w, 200, sess)
}

// handleSessionsUpdate is PATCH /api/sessions/{id} — update mutable fields.
func (s *Server) handleSessionsUpdate(w http.ResponseWriter, r *http.Request) {
        id := r.PathValue("id")
        var req map[string]any
        if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
                writeError(w, 400, "invalid JSON: "+err.Error())
                return
        }
        sess, err := s.db.GetSession(id)
        if err != nil {
                writeError(w, 500, "get: "+err.Error())
                return
        }
        if sess == nil {
                writeError(w, 404, "not found")
                return
        }
        // Title update respects manually_renamed unless override_manual is true.
        if title, ok := req["title"].(string); ok {
                override, _ := req["override_manual"].(bool)
                if err := s.db.SetSessionTitle(id, title, override); err != nil {
                        writeError(w, 500, "set title: "+err.Error())
                        return
                }
                sess.Title = title
        }
        if mr, ok := req["manually_renamed"].(bool); ok {
                sess.ManuallyRenamed = mr
        }
        if v, ok := req["model"].(string); ok {
                sess.Model = v
        }
        if v, ok := req["provider"].(string); ok {
                sess.Provider = v
        }
        if v, ok := req["sandbox"].(string); ok {
                sess.Sandbox = v
        }
        if v, ok := req["effort"].(string); ok {
                sess.Effort = v
        }
        if v, ok := req["mode"].(string); ok {
                sess.Mode = v
        }
        if v, ok := req["web_search"].(bool); ok {
                sess.WebSearch = v
        }
        if v, ok := req["deep_research"].(bool); ok {
                sess.DeepResearch = v
        }
        if v, ok := req["routing"].(string); ok {
                sess.Routing = v
        }
        if v, ok := req["workspace_id"].(string); ok {
                sess.WorkspaceID = v
        }
        if err := s.db.UpdateSession(sess); err != nil {
                writeError(w, 500, "update: "+err.Error())
                return
        }
        writeJSON(w, 200, sess)
}

// handleSessionsDelete is DELETE /api/sessions/{id} — remove a session + its events.
func (s *Server) handleSessionsDelete(w http.ResponseWriter, r *http.Request) {
        id := r.PathValue("id")
        if err := s.db.DeleteSession(id); err != nil {
                writeError(w, 500, "delete: "+err.Error())
                return
        }
        writeJSON(w, 200, map[string]bool{"ok": true})
}

// handleSessionsEvents is GET /api/sessions/{id}/events?since=N — replay
// the event log. since=0 returns all events.
func (s *Server) handleSessionsEvents(w http.ResponseWriter, r *http.Request) {
        id := r.PathValue("id")
        sinceStr := r.URL.Query().Get("since")
        since := 0
        if sinceStr != "" {
                if n, err := strconv.Atoi(sinceStr); err == nil {
                        since = n
                }
        }
        events, err := s.db.ListEvents(id, since)
        if err != nil {
                writeError(w, 500, "list events: "+err.Error())
                return
        }
        out := make([]json.RawMessage, 0, len(events))
        for _, ev := range events {
                b, _ := ev.ToJSON()
                out = append(out, b)
        }
        writeJSON(w, 200, map[string]any{"events": out, "session_id": id})
}

// generateID returns a short unique ID (timestamp prefix + random hex).
func generateID() string {
        b := make([]byte, 8)
        _, _ = rand.Read(b)
        return strconv.FormatInt(time.Now().Unix(), 16) + hex.EncodeToString(b)
}
