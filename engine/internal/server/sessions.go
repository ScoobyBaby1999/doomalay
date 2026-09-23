package server

import (
        "crypto/rand"
        "encoding/hex"
        "encoding/json"
        "net/http"
        "strconv"
        "strings"
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
                // v0.44: the template pill's active method template (JSON
                // blob {id, name, brief}; "" = none).
                TemplateID string `json:"template"`
                // v0.46: HF-chat routing (sandbox="hf"): "shared" | "own" + the
                // own space's "user/name" repo.
                SandboxMode string `json:"sandbox_mode"`
                SandboxRepo string `json:"sandbox_repo"`
                // v0.28: compaction controls (nil = enabled default).
                CompactEnabled      *bool `json:"compact_enabled"`
                CompactThresholdPct int   `json:"compact_threshold"`
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
        // v0.28: compaction defaults (the DB column defaults would be
        // overridden by the explicit zero values in the INSERT otherwise).
        compactEnabled := true
        if req.CompactEnabled != nil {
                compactEnabled = *(req.CompactEnabled)
        }
        if req.CompactThresholdPct == 0 {
                req.CompactThresholdPct = 70
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
                TemplateID:    req.TemplateID,
                // v0.46: HF-chat routing.
                SandboxMode: req.SandboxMode,
                SandboxRepo: req.SandboxRepo,
                // v0.28: per-chat compaction controls.
                CompactEnabled:      compactEnabled,
                CompactThresholdPct: req.CompactThresholdPct,
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
        // v0.46: HF-chat routing — sandbox_mode ("shared"|"own"|"") + the
        // own space repo. Setting sandbox_mode implies sandbox="hf" (the
        // picker writes both, but be tolerant of partial writes).
        if v, ok := req["sandbox_mode"].(string); ok {
                sess.SandboxMode = v
                if v == "shared" || v == "own" {
                        sess.Sandbox = "hf"
                }
        }
        if v, ok := req["sandbox_repo"].(string); ok {
                sess.SandboxRepo = v
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
        // v0.19: the chat's editable persona (its system prompt). Empty string
        // resets to the app's default prompt.
        if v, ok := req["persona"].(string); ok {
                sess.Persona = v
        }
        // v0.26: the multi-persona list (JSON array of
        // {id,name,text,mode,trigger}) + the custom placeholder map.
        if v, ok := req["personas"].(string); ok {
                if strings.TrimSpace(v) == "" {
                        sess.Personas = ""
                } else {
                        sess.Personas = v
                }
        }
        if v, ok := req["placeholders"].(string); ok {
                sess.Placeholders = v
        }
        // v0.16: the memory-window pill PATCHes this (sliding context size).
        // v0.28: -1 = the WHOLE chat (no window — user spec, the mind
        // slider's minimum); 0 keeps the default 40.
        if v, ok := req["sliding_window"].(float64); ok && (v > 0 || v == -1) {
                sess.SlidingWindow = int(v)
        }
        // v0.28: per-chat compaction controls (the mind panel).
        if v, ok := req["compact_enabled"].(bool); ok {
                sess.CompactEnabled = v
        }
        if v, ok := req["compact_threshold"].(float64); ok {
                t := int(v)
                if t < 10 {
                        t = 10
                }
                if t > 95 {
                        t = 95
                }
                sess.CompactThresholdPct = t
        }
        // v0.28: the PM path compacted client-side — it persists the
        // summary + cut point here (the engine owns event seqs).
        if v, ok := req["compact_summary"].(string); ok {
                sess.CompactSummary = v
        }
        if v, ok := req["compact_seq"].(float64); ok {
                sess.CompactSeq = int(v)
        }
        if v, ok := req["workspace_id"].(string); ok {
                sess.WorkspaceID = v
        }
        // v0.44: the template pill's active method template — a JSON blob
        // {id, name, brief} the frontend resolves from the library ("" or
        // a JSON "null" clears it). The engine stores + echoes it back; the
        // per-message template_brief rides the turn WS payload instead.
        if v, ok := req["template"].(string); ok {
                t := strings.TrimSpace(v)
                if t == "" || t == "null" {
                        sess.TemplateID = ""
                } else {
                        sess.TemplateID = v
                }
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
        // v0.30: the chat's tweak + background kv rows ride along — a chat
        // must not leak preferences past its own life.
        s.deleteSessionTweaks(id)
        writeJSON(w, 200, map[string]bool{"ok": true})
}

// handleSessionsAppendEvent is POST /api/sessions/{id}/events (v0.15).
//
// The PrivateMode SDK bridge chats directly from the WebView (the engine
// cannot speak PM's E2E-encryption protocol), so its turns are FRONTEND-
// driven. This endpoint lets the bridge persist events with the exact same
// wire shape the WS emits, so replay/history/reload stay consistent.
//
// Body: {"type":"user"|"assistant"|"status"|"error","text":"...",...}
// (deliberately narrow — no tool_use/sources fabrication).
func (s *Server) handleSessionsAppendEvent(w http.ResponseWriter, r *http.Request) {
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
        var req struct {
                Type string `json:"type"`
                Text string `json:"text"`
        }
        if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
                writeError(w, 400, "invalid JSON: "+err.Error())
                return
        }
        switch req.Type {
        // v0.20 FIX: the PM bridge persists its tool pills + sources through
        // THIS endpoint — rejecting tool_use/tool_result/sources meant PM
        // tool events + citations silently vanished (400 on every tool turn,
        // histories lost their pills after reload).
        // v0.37: 'hide' — the PM path's edit/delete/regenerate masks events
        // the same way the WS path does (content = JSON array of event ids).
        // v0.38: + thinking / assistant_delta / compact — parity with the WS
        // path's event vocabulary (the PM bridge and test seeds persist the
        // same types the engine itself writes; thinking was rejected with a
        // 400 while the WS path happily logs it).
        // v0.52: + hublist — the bot-side hub cards (dt_hublib browse
        // results) persist through this endpoint too, same as tool pills.
        case "user", "assistant", "assistant_delta", "assistant_complete", "thinking", "status", "error", "tool_use", "tool_result", "sources", "hide", "compact", "hublist":
                // ok
        default:
                writeError(w, 400, "type must be user|assistant|assistant_delta|thinking|status|error|tool_use|tool_result|sources|hide|compact|hublist")
                return
        }
        persisted, err := s.db.AppendEvent(id, req.Type, req.Text, "")
        if err != nil {
                writeError(w, 500, "append: "+err.Error())
                return
        }
        writeJSON(w, 201, persisted)
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
