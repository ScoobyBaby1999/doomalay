package server

import (
        "crypto/rand"
        "encoding/hex"
        "encoding/json"
        "net/http"
        "strconv"
        "strings"
        "sync"
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
                // v1.21.2 THE CLEANSING: web search is ALWAYS ON — the field
                // is a pointer so "omitted" (every API client that doesn't
                // know the flag) births TRUE; an explicit false still wins
                // (API compat).
                WebSearch     *bool  `json:"web_search"`
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
                // v0.52 THE 3 PILLS: per-chat auto-search toggles (the
                // [template|+] / [skills|+] label press).
                TemplateAuto bool `json:"template_auto"`
                SkillsAuto   bool `json:"skills_auto"`
                // v0.60 pt C.9: THE LIB PILL — the single gatekeeping toggle.
                LibAuto bool `json:"lib_auto"`
                // v1.17.1 THE PIVOT: the Termux capability — the stacked
                // capability the capabilities library's gated toggle writes
                // (inert this wave; the bridge arrives v1.17.2).
                Termux bool `json:"termux"`
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
        // v1.17.5 THE REDTEAM honesty completion: new chats are quick by
        // birth (PLAN-V117 §v1.17.1) — the PWA always sends sandbox:"quick",
        // but an API client that omits it must not get a sandbox-less
        // ("") session. Legacy hf/terminal/device values pass untouched.
        if req.Sandbox == "" {
                req.Sandbox = "quick"
        }
        if req.Effort == "" {
                req.Effort = "med"
        }
        if req.Mode == "" {
                req.Mode = "auto"
        }
        // v1.21.2 THE CLEANSING: the always-on birth default (omitted = ON).
        webSearchOn := true
        if req.WebSearch != nil {
                webSearchOn = *req.WebSearch
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
                // v1.21.2: omitted web_search births ON (the always-on law).
                WebSearch:     webSearchOn,
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
                // v0.52: the auto-search pill toggles.
                TemplateAuto: req.TemplateAuto,
                SkillsAuto:   req.SkillsAuto,
                // v0.60 pt C.9: the lib pill.
                LibAuto: req.LibAuto,
                // v1.17.1 THE PIVOT: the Termux capability.
                Termux: req.Termux,
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
        // v0.89.3 THE BOT'S OWN MANUAL: an HF chat opens with the harness
        // doc in its artifact drawer — the user reads what the bot can do
        // from the SAME HARNESS.md the bot reads in its workspace (and the
        // Space ships at brain/HARNESS.md). Quick/other sandboxes: nothing
        // seeded (their bots have no harness doc).
        if sess.Sandbox == "hf" {
                s.seedHarnessArtifact(sess.ID)
                // v1.10.5 THE PM BADGE (D5): PrivateMode models route to the
                // LOCAL bridge on the device — an HF chat with a PM model
                // NEVER touches the sandbox, and nothing ever said so. Say
                // so, persistently, at create time (the Phase-1 notice class).
                if strings.EqualFold(strings.TrimSpace(sess.Provider), "privatemodeai") ||
                        strings.HasPrefix(strings.TrimSpace(sess.Model), "privatemodeai/") {
                        s.persistNoticeOnly(sess.ID,
                                "This model runs on PrivateMode's local bridge on your device — it never reaches the HF sandbox, so bash/Linux sandbox tools are unavailable in this chat. Switch to another provider (NVIDIA, OpenRouter, Mistral…) for sandbox work.",
                                "pm-local")
                }
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
        // v1.10.5: the PM-state BEFORE this PATCH applies (the mid-session
        // switch-to-PM notice fires on the TRANSITION only).
        wasPM := isPM(sess)
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
                // v0.93.6: THE PERSONA RE-POINT (server-side twin of
                // persona.js's sandbox-changed listener — belt and braces:
                // reloads and other devices stay honest too). When the
                // sandbox method CHANGES mid-chat, personas whose text is
                // empty (already following) or verbatim one of the default
                // templates (UNEDITED — the user hit ↺ default or saved the
                // prefilled editor untouched) re-point to the new mode's
                // default: their text clears to "" (= "follow the mode",
                // which now resolves to the new default). Edited personas
                // never move.
                if v != sess.Sandbox && (v == "hf" || sess.Sandbox == "hf" || v == "quick") {
                        rePointUneditedPersonas(sess, sess.Sandbox, v)
                }
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
        // v0.52 THE 3 PILLS: the [template|+] / [skills|+] label toggles —
        // per-chat auto-search flags the turn builder gates the
        // template/skills tools on.
        if v, ok := req["template_auto"].(bool); ok {
                sess.TemplateAuto = v
        }
        if v, ok := req["skills_auto"].(bool); ok {
                sess.SkillsAuto = v
        }
        // v0.60 pt C.9: THE LIB PILL — the single gatekeeping toggle. A
        // lib_auto PATCH stamps the legacy pill flags to match (the old
        // brain reads them); a legacy pill PATCH re-derives lib_auto as
        // their OR, so the three never disagree.
        if v, ok := req["lib_auto"].(bool); ok {
                sess.LibAuto = v
                sess.TemplateAuto = v
                sess.SkillsAuto = v
        } else if sess.LibAuto != (sess.TemplateAuto || sess.SkillsAuto) {
                sess.LibAuto = sess.TemplateAuto || sess.SkillsAuto
        }
        // v1.17.1 THE PIVOT: the Termux capability — the capabilities
        // library's gated toggle PATCHes it (bool→int at the column; the
        // GET/serialization round-trips it for the reload restore).
        if v, ok := req["termux"].(bool); ok {
                sess.Termux = v
        }
        if err := s.db.UpdateSession(sess); err != nil {
                writeError(w, 500, "update: "+err.Error())
                return
        }
        // v1.10.5 THE PM BADGE, mid-session switch (D5): the model/provider
        // just became PrivateMode on an HF chat — the local-bridge fact
        // must surface NOW (persist + live-forward if a WS is open). Fires
        // only on the TRANSITION (a stale re-PATCH of the same PM model
        // must not stack notices).
        if sess.Sandbox == "hf" && isPM(sess) && !wasPM {
                s.emitNotice(pipeFor(id), id,
                        "This model now runs on PrivateMode's local bridge on your device — it never reaches the HF sandbox, so bash/Linux sandbox tools are unavailable while it's active. Switch to another provider (NVIDIA, OpenRouter, Mistral…) for sandbox work.",
                        "pm-local")
        }
        writeJSON(w, 200, sess)
}

// isPM — the session's model/provider is PrivateMode (the local bridge).
func isPM(sess *store.Session) bool {
        return strings.EqualFold(strings.TrimSpace(sess.Provider), "privatemodeai") ||
                strings.HasPrefix(strings.TrimSpace(sess.Model), "privatemodeai/")
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

// rePointUneditedPersonas — v0.93.6 THE PERSONA DEFAULTS WAVE (user spec:
// "聊天中途切换 sandbox method 时，未编辑过的 persona 应自动切换为新默认").
// Personas whose text is EMPTY (already following the mode's default) or
// verbatim-equal to one of the two default templates (UNEDITED — a ↺
// default load or an untouched prefilled editor that got saved) re-point to
// the new mode: their text clears to "" which resolves to the NEW mode's
// default at composition time (chat.go defaultPersonaFor). Edited personas
// match neither template and never move. The {repo} placeholder stays
// unsubstituted in stored text, so the raw-template comparison is exact.
func rePointUneditedPersonas(sess *store.Session, oldSandbox, newSandbox string) {
        if oldSandbox == newSandbox {
                return // same mode — nothing re-points (belt AND braces)
        }
        raw := strings.TrimSpace(sess.Personas)
        if raw == "" {
                return // nothing stored → the chat rides the mode default already
        }
        var list []map[string]any
        if err := json.Unmarshal([]byte(raw), &list); err != nil || len(list) == 0 {
                return // the legacy single-persona column composes live; nothing to re-point
        }
        // the comparison set: BOTH sides' templates. The engine consts are
        // what defaultPersonaFor injects; the WEB templates (persona.js —
        // embedded in this very binary) are what the ↺ pill loads and what
        // the user actually saves. They diverge today (the web quick
        // template carries the Library section; the engine appends
        // libraryPreamble at compose time), so a persona frozen from the
        // editor matches the WEB form — both must count as unedited.
        quick := strings.TrimSpace(defaultPersonaQuick)
        hf := strings.TrimSpace(defaultPersonaHF)
        wq, wh := webPersonaTemplates()
        isDefault := func(t string) bool {
                return t == quick || t == hf || (wq != "" && t == wq) || (wh != "" && t == wh)
        }
        changed := false
        for _, p := range list {
                t, _ := p["text"].(string)
                t = strings.TrimSpace(t)
                if t == "" {
                        continue // empty = already following the mode
                }
                if isDefault(t) {
                        p["text"] = "" // unedited → follow the (new) mode's default
                        changed = true
                }
        }
        if !changed {
                return
        }
        b, err := json.Marshal(list)
        if err != nil {
                return
        }
        sess.Personas = string(b)
}

// webPersonaTemplates extracts DEFAULT_PERSONA_QUICK + DEFAULT_PERSONA_HF
// from the embedded web/persona.js (v0.93.6). The JS side builds them as
// 'segment' + 'segment' string concatenations — the parser walks the
// single-quoted segments after `var NAME =` up to the terminating `;`,
// decoding \n, \' and \\ escapes. Extracted ONCE (sync.Once); a parse
// failure returns "" and the re-point falls back to the engine consts
// only (never a hard failure).
var webPersonaOnce sync.Once
var webPersonaQuick, webPersonaHF string

func webPersonaTemplates() (quick, hf string) {
        webPersonaOnce.Do(func() {
                data, err := webFS.ReadFile("web/persona.js")
                if err != nil {
                        return
                }
                webPersonaQuick = extractJSConst(string(data), "DEFAULT_PERSONA_QUICK")
                webPersonaHF = extractJSConst(string(data), "DEFAULT_PERSONA_HF")
        })
        return strings.TrimSpace(webPersonaQuick), strings.TrimSpace(webPersonaHF)
}

// extractJSConst pulls `var <name> = 'a' + 'b' + …;` out of JS source.
// A segment-scanning parser (NOT a naive "cut at the first ;" — the
// persona templates carry literal semicolons INSIDE their text, e.g.
// (ACTION: skills {"action":"load"}); which used to truncate the extract).
// It walks quoted segments and their ` + ` glue, stopping at the
// concatenation's real terminator (a closing quote followed by `;`).
func extractJSConst(src, name string) string {
        marker := "var " + name + " ="
        i := strings.Index(src, marker)
        if i < 0 {
                return ""
        }
        src = src[i+len(marker):]
        var b strings.Builder
        j := 0
        for j < len(src) {
                // skip inter-segment glue (whitespace, +, whitespace)
                for j < len(src) && (src[j] == ' ' || src[j] == '\n' || src[j] == '\t' || src[j] == '+') {
                        j++
                }
                if j >= len(src) || src[j] != '\'' {
                        break // the real terminator (or junk) — done
                }
                j++ // enter the segment
                for ; j < len(src); j++ {
                        c := src[j]
                        if c == '\\' && j+1 < len(src) {
                                j++
                                switch src[j] {
                                case 'n':
                                        b.WriteByte('\n')
                                case 't':
                                        b.WriteByte('\t')
                                default: // \' \\ and anything else pass through
                                        b.WriteByte(src[j])
                                }
                                continue
                        }
                        if c == '\'' {
                                break // segment end — back to the glue walk
                        }
                        b.WriteByte(c)
                }
        }
        return b.String()
}
