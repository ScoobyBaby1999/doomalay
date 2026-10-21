package server

// fleettool.go — v1.47.2 THE FLEET HAND (PLAN-V147 §2): the other-
// chatbots roster + detail, behind llm.ChatRequest.FleetToolFn.
//
// The user's ask, verbatim: "implement a method to or tool you can use
// to check other chatbots that are active, and info about them — the
// canvas, the name, relevant metadata (sort of like a simple one with
// name/model - canvas - and essential info with a filter, then another
// method that expands and lists the full details of one chatbot,
// including its current actions and progress."
//
// The grammar is the A2A Agent Card model over the engine's OWN truth —
// identity (the session row), location (the canvas digests),
// capabilities (the armed pills + bindings), state (the turn gauge —
// the engine's live-turn truth, the same map /api/engine/busy reads),
// current actions (the events tail), progress (turns + the usage
// ledger). NO new state, NO new locks — an honest read surface.
//
// Honest limits on the face: brain-side swarm sub-agents are NOT
// sessions (invisible here); the detail is a SNAPSHOT (a running turn's
// phase can age between the read and the render).

import (
        "context"
        "encoding/json"
        "fmt"
        "sort"
        "strings"
        "time"

        "github.com/ScoobyBaby1999/doomalay/engine/internal/store"
)

const (
        fleetTailLen = 6 // events in the detail's current-action timeline
        // v1.50.1 THE WHOLE RETURN: fleetRosterCap (30) is DEAD — the roster
        // lists EVERY match; a device's real session count bounds the list.
)

// runFleetAction (v1.47.2) — the DIRECT-PATH fleet ACTION runner: the
// roster (every chat: title, provider/model, canvas, live state, last
// activity, turns; q filters) or one chat's full detail (identity,
// capabilities, the CURRENT action from the live events tail, progress).
// Returns OBSERVATION-ready text.
func (s *Server) runFleetAction(ctx context.Context, sessionID, argJSON string) string {
        var args map[string]any
        if err := json.Unmarshal([]byte(argJSON), &args); err != nil {
                trimmed := strings.TrimSpace(strings.Trim(argJSON, "\""))
                if trimmed != "" && !strings.HasPrefix(argJSON, "{") {
                        args = map[string]any{"action": "roster", "q": trimmed}
                } else {
                        return "OBSERVATION:\nerror: arguments must be a JSON object — " + err.Error()
                }
        }
        get := func(k string) string {
                v, _ := args[k].(string)
                return v
        }
        action := strings.ToLower(strings.TrimSpace(get("action")))
        switch action {
        case "", "roster", "list", "board", "status":
                return "OBSERVATION:\n" + s.fleetRoster(get("q"))
        case "detail", "info", "expand", "show":
                return "OBSERVATION:\n" + s.fleetDetail(sessionID, get("target"))
        case "help", "?":
                return "OBSERVATION:\n" + fleetHelp
        }
        return "OBSERVATION:\ndjournal-style honesty: unknown action '" + get("action") + "'.\n\n" + fleetHelp
}

const fleetHelp = `fleet — the other chatbots on this engine (roster + detail)

roster  q? → every chat: title · provider/model · canvas · live state
        (running/idle) · last activity · turns. q filters by
        title/model/provider/canvas (case-insensitive substring).
detail  target → ONE chat's full card: identity (persona, effort, mode,
        template, sandbox), its canvas home, the armed capabilities
        (pills, workspaces, termux), the CURRENT action (the live
        events tail — what it is doing right now) and progress (turns,
        tokens in/out/thinking, cost, last activity).
target  the chat's id, or a unique title prefix (case-insensitive).

honest limits: swarm sub-agents on a brain are not chats (not listed);
the detail is a snapshot, not a stream.`

// fleetRow is one roster row (sorted running-first, then recency).
type fleetRow struct {
        sess    *store.Session
        canvas  []string
        running bool
        turns   int
}

// fleetSnapshot gathers the roster's truth: sessions + canvas homes +
// the live turn gauge + per-session turn counts (one GROUP BY).
func (s *Server) fleetSnapshot() ([]fleetRow, map[string][]string, error) {
        if s.db == nil {
                return nil, nil, fmt.Errorf("no database")
        }
        sessions, err := s.db.ListSessions()
        if err != nil {
                return nil, nil, err
        }
        // canvas homes: digest → session_ids; name lookup alongside.
        c2s := map[string][]string{}
        if digests, derr := s.db.ListCanvasDigest(); derr == nil {
                names := map[string]string{}
                if rows, nerr := s.db.ListCanvases(); nerr == nil {
                        for _, r := range rows {
                                names[r.ID] = r.Name
                        }
                }
                for _, d := range digests {
                        name := names[d.ID]
                        if name == "" {
                                name = d.ID
                        }
                        for _, sid := range d.SessionIDs {
                                c2s[sid] = append(c2s[sid], name)
                        }
                }
        }
        turns := map[string]int{}
        if m, terr := s.db.CountUserTurnsPerSession(); terr == nil {
                turns = m
        }
        // the live turn gauge — the engine's OWN running-turn truth.
        turnGaugeMu.Lock()
        running := make(map[string]bool, len(turnGaugeSessions))
        for id := range turnGaugeSessions {
                running[id] = true
        }
        turnGaugeMu.Unlock()

        rows := make([]fleetRow, 0, len(sessions))
        for _, sess := range sessions {
                rows = append(rows, fleetRow{
                        sess:    sess,
                        canvas:  c2s[sess.ID],
                        running: running[sess.ID],
                        turns:   turns[sess.ID],
                })
        }
        sort.SliceStable(rows, func(i, j int) bool {
                if rows[i].running != rows[j].running {
                        return rows[i].running // running first
                }
                return rows[i].sess.UpdatedAt > rows[j].sess.UpdatedAt // recency
        })
        return rows, c2s, nil
}

func (s *Server) fleetRoster(filter string) string {
        rows, _, err := s.fleetSnapshot()
        if err != nil {
                return "error: " + err.Error()
        }
        q := strings.ToLower(strings.TrimSpace(filter))
        matches := []fleetRow{}
        for _, r := range rows {
                if q == "" {
                        matches = append(matches, r)
                        continue
                }
                hay := strings.ToLower(strings.Join([]string{
                        r.sess.Title, r.sess.Provider, r.sess.Model,
                        strings.Join(r.canvas, " "),
                }, " "))
                if strings.Contains(hay, q) {
                        matches = append(matches, r)
                }
        }
        if len(matches) == 0 {
                if q != "" && len(rows) > 0 {
                        return fmt.Sprintf("no chats match '%s' (%d on this engine). Pass an empty q to list them all.", filter, len(rows))
                }
                return "no chats on this engine yet — create one to begin."
        }
        running := 0
        for _, r := range matches {
                if r.running {
                        running++
                }
        }
        var b strings.Builder
        fmt.Fprintf(&b, "fleet — %d chat%s, %d running%s",
                len(matches), pluralS(len(matches)), running, filterSuffix(q))
        b.WriteString("\n")
        // v1.50.1 THE WHOLE RETURN: every match rides — no 30-row cap, no
        // "…and N more". A device's real session count bounds the list.
        for _, r := range matches {
                fmt.Fprintf(&b, "  %s\n", rosterLine(r, time.Now()))
        }
        b.WriteString("\nexpand one: fleet(action='detail', target='<id or title prefix>')")
        return b.String()
}

func rosterLine(r fleetRow, now time.Time) string {
        state := "idle"
        if r.running {
                state = "RUNNING"
        }
        canvas := "—"
        if len(r.canvas) > 0 {
                canvas = "\"" + strings.Join(r.canvas, "\", \"") + "\""
        }
        model := strings.TrimSpace(r.sess.Provider + "/" + r.sess.Model)
        age := relTime(r.sess.UpdatedAt, now)
        return fmt.Sprintf("%s — %s — canvas %s — %s · last %s · %d turn%s",
                strings.TrimSpace(r.sess.Title), model, canvas, state, age, r.turns, pluralS(r.turns))
}

func (s *Server) fleetDetail(callerID, target string) string {
        rows, c2s, err := s.fleetSnapshot()
        if err != nil {
                return "error: " + err.Error()
        }
        t := strings.TrimSpace(target)
        if t == "" {
                return "fleet: detail needs a target — the chat's id or a title prefix. The roster lists ids' titles; pass fleet(action='roster') first if unsure."
        }
        tl := strings.ToLower(t)
        var found *fleetRow
        for i := range rows {
                if rows[i].sess.ID == t {
                        found = &rows[i]
                        break
                }
        }
        if found == nil {
                // title prefix (case-insensitive); ambiguity is honest.
                var hits []*fleetRow
                for i := range rows {
                        if strings.HasPrefix(strings.ToLower(rows[i].sess.Title), tl) {
                                hits = append(hits, &rows[i])
                        }
                }
                if len(hits) == 1 {
                        found = hits[0]
                } else if len(hits) > 1 {
                        var names []string
                        for _, h := range hits {
                                names = append(names, h.sess.Title+" ("+h.sess.ID+")")
                        }
                        return fmt.Sprintf("fleet: '%s' is ambiguous — matched %d chats: %s. Pass the id or a longer prefix.",
                                target, len(hits), strings.Join(names, ", "))
                }
        }
        if found == nil {
                return fmt.Sprintf("fleet: no chat matches '%s' (id or title prefix). Pass fleet(action='roster') to list them.", target)
        }
        return s.fleetDetailCard(found, c2s, callerID)
}

func (s *Server) fleetDetailCard(r *fleetRow, c2s map[string][]string, callerID string) string {
        // the roster row is the LIST summary (ListSessions' cheap subset);
        // the detail card needs the FULL record — personas, pills, template,
        // sandbox — so hydrate it (one GetSession; falls back to the row).
        sess := r.sess
        if full, err := s.db.GetSession(r.sess.ID); err == nil && full != nil {
                sess = full
        }
        now := time.Now()
        var b strings.Builder
        you := ""
        if sess.ID == callerID {
                you = "  ·  THIS IS YOU"
        }
        fmt.Fprintf(&b, "fleet — detail: %s%s\n", strings.TrimSpace(sess.Title), you)

        // identity
        fmt.Fprintf(&b, "identity:\n")
        fmt.Fprintf(&b, "  id: %s · created %s\n", sess.ID, isoDayFromUnix(sess.CreatedAt))
        model := strings.TrimSpace(sess.Provider + "/" + sess.Model)
        if model == "" {
                model = "(model not set)"
        }
        fmt.Fprintf(&b, "  model: %s · effort: %s · mode: %s\n", model, orDash(sess.Effort), orDash(sess.Mode))
        if persona := s.fleetPersonaName(sess); persona != "" {
                fmt.Fprintf(&b, "  persona: %s\n", persona)
        }
        if sess.TemplateID != "" {
                fmt.Fprintf(&b, "  template: %s\n", sess.TemplateID)
        }
        sb := strings.TrimSpace(sess.Sandbox)
        if sb == "" {
                sb = "quick"
        }
        extra := ""
        if sb == "hf" {
                extra = " (turns route through a remote brain)"
        }
        fmt.Fprintf(&b, "  sandbox: %s%s\n", sb, extra)

        // home
        canvas := c2s[sess.ID]
        if len(canvas) == 0 {
                fmt.Fprintf(&b, "home:\n  canvas: — (not pinned on any canvas)\n")
        } else {
                fmt.Fprintf(&b, "home:\n  canvas: \"%s\"\n", strings.Join(canvas, "\", \""))
        }

        // capabilities
        fmt.Fprintf(&b, "capabilities:\n")
        fmt.Fprintf(&b, "  web search: %s · deep research: %s · template pill: %s · skills pill: %s · library: %s\n",
                onOff(sess.WebSearch), onOff(sess.DeepResearch), onOff(sess.TemplateAuto), onOff(sess.SkillsAuto), onOff(sess.LibAuto))
        if n := s.fleetWorkspaceCount(sess.ID); n > 0 {
                fmt.Fprintf(&b, "  workspaces: %d connected\n", n)
        }
        if sess.Termux {
                fmt.Fprintf(&b, "  termux: armed\n")
        }

        // current action + progress from the events tail
        tail, terr := s.db.ListEventsTail(sess.ID, fleetTailLen)
        if terr != nil {
                fmt.Fprintf(&b, "current action:\n  (events unreadable: %s)\n", terr.Error())
        } else {
                fmt.Fprintf(&b, "current action:\n")
                state := "idle"
                if r.running {
                        state = "RUNNING — a turn is in flight right now"
                }
                fmt.Fprintf(&b, "  state: %s\n", state)
                if len(tail) == 0 {
                        fmt.Fprintf(&b, "  no events yet — this chat has never run a turn\n")
                } else {
                        fmt.Fprintf(&b, "  recent events (oldest first):\n")
                        for _, ev := range tail {
                                fmt.Fprintf(&b, "    [%s] %s\n", clockFromUnix(ev.CreatedAt), fleetEventLine(ev))
                        }
                }
                fmt.Fprintf(&b, "progress:\n")
                fmt.Fprintf(&b, "  turns: %d · last activity: %s\n", r.turns, relTime(sess.UpdatedAt, now))
                if tot := s.fleetUsageLine(tail); tot != "" {
                        fmt.Fprintf(&b, "  last turn usage: %s\n", tot)
                }
        }
        b.WriteString("\n(snapshot — a running turn's phase may age between this read and your answer)")
        return b.String()
}

// fleetPersonaName resolves the chat's active persona name the same way
// a live turn does (trigger → always → shuffle; snapshot metrics).
func (s *Server) fleetPersonaName(sess *store.Session) string {
        specs := parsePersonas(sess)
        if len(specs) == 0 {
                return ""
        }
        if p := s.resolveActivePersonaMerged(specs, sess, personaMetrics{}); p != nil {
                return p.Name + " (" + p.Mode + ")"
        }
        return ""
}

// fleetWorkspaceCount counts the chat's connected cloud repos.
func (s *Server) fleetWorkspaceCount(sessionID string) int {
        n := 0
        if ws, err := s.db.ListSessionWorkspaces(sessionID); err == nil {
                n = len(ws)
        }
        return n
}

// fleetUsageLine lifts the last turn's usage out of the tail's status
// events (the v1.46.2 ledger's own shape: input/output/reasoning).
func (s *Server) fleetUsageLine(tail []*store.Event) string {
        for i := len(tail) - 1; i >= 0; i-- {
                ev := tail[i]
                if ev.EventType != "status" || ev.Content == "" {
                        continue
                }
                var st struct {
                        State string `json:"state"`
                        Usage *struct {
                                InputTokens     int   `json:"input_tokens"`
                                OutputTokens    int   `json:"output_tokens"`
                                ReasoningTokens int64 `json:"reasoning_tokens"`
                        } `json:"usage"`
                }
                if json.Unmarshal([]byte(ev.Content), &st) != nil || st.Usage == nil {
                        continue
                }
                line := fmt.Sprintf("%s in / %s out", commatizeI(st.Usage.InputTokens), commatizeI(st.Usage.OutputTokens))
                if st.Usage.ReasoningTokens > 0 {
                        line += fmt.Sprintf(" (🧠 %s thinking)", commatizeI(int(st.Usage.ReasoningTokens)))
                }
                return line
        }
        return ""
}

// fleetEventLine renders one events-tail row for the detail card.
func fleetEventLine(ev *store.Event) string {
        head := ev.EventType
        content := strings.TrimSpace(ev.Content)
        switch ev.EventType {
        case "user":
                return "user: " + content
        case "assistant":
                return "assistant: " + content
        case "thinking":
                return "thinking: " + content
        case "tool_use":
                // v1.50.1: the KNOWN JSON shape renders field-by-field (name,
                // args, summary) — full text, no 90-char snip.
                var u struct {
                        Name    string `json:"name"`
                        Args    string `json:"args"`
                        Summary string `json:"summary"`
                }
                if json.Unmarshal([]byte(content), &u) == nil && u.Name != "" {
                        line := "tool_use: " + u.Name + " " + u.Args
                        if u.Summary != "" {
                                line += " — " + u.Summary
                        }
                        return line
                }
                return "tool_use: " + content
        case "tool_result":
                // v1.50.1: the KNOWN JSON shape renders field-by-field (name,
                // summary, full text) — the whole observation rides the row.
                var p struct {
                        Name    string `json:"name"`
                        Summary string `json:"summary"`
                        Text    string `json:"text"`
                }
                if json.Unmarshal([]byte(content), &p) == nil && p.Name != "" {
                        line := "tool_result: " + p.Name + " — " + p.Text
                        if p.Summary != "" && p.Summary != p.Text {
                                line += " (" + p.Summary + ")"
                        }
                        return line
                }
                return "tool_result: " + content
        case "status":
                var st struct {
                        State string `json:"state"`
                }
                if json.Unmarshal([]byte(ev.Content), &st) == nil && st.State != "" {
                        return "status: " + st.State
                }
                return "status"
        case "error":
                var e struct {
                        Message string `json:"message"`
                }
                if json.Unmarshal([]byte(ev.Content), &e) == nil && e.Message != "" {
                        return "error: " + e.Message
                }
                return "error: " + content
        }
        return head + ": " + content
}

// ── small render helpers ───────────────────────────────────────────

func pluralS(n int) string {
        if n == 1 {
                return ""
        }
        return "s"
}

func filterSuffix(q string) string {
        if q == "" {
                return ""
        }
        return " · filter '" + q + "'"
}

// relTime renders a float-unix timestamp relative to now ("2m ago",
// "3h ago", "4d ago"); empty/zero → "never".
func relTime(ts float64, now time.Time) string {
        if ts <= 0 {
                return "never"
        }
        d := now.Sub(time.Unix(int64(ts), 0))
        switch {
        case d < 0:
                d = 0
        case d < time.Minute:
                return "just now"
        case d < time.Hour:
                return fmt.Sprintf("%dm ago", int(d.Minutes()))
        case d < 24*time.Hour:
                return fmt.Sprintf("%dh ago", int(d.Hours()))
        case d < 30*24*time.Hour:
                return fmt.Sprintf("%dd ago", int(d.Hours()/24))
        }
        return fmt.Sprintf("%dmo ago", int(d.Hours()/(24*30)))
}

func clockFromUnix(ts float64) string {
        if ts <= 0 {
                return "--:--"
        }
        return time.Unix(int64(ts), 0).Format("15:04:05")
}

func isoDayFromUnix(ts float64) string {
        if ts <= 0 {
                return "—"
        }
        return time.Unix(int64(ts), 0).UTC().Format("2006-01-02")
}

// snip died with v1.50.1 THE WHOLE RETURN — fleet rows carry full text.

func commatizeI(n int) string {
        s := fmt.Sprintf("%d", n)
        if len(s) <= 3 {
                return s
        }
        var parts []string
        for len(s) > 3 {
                parts = append([]string{s[len(s)-3:]}, parts...)
                s = s[:len(s)-3]
        }
        return strings.Join(append([]string{s}, parts...), ",")
}
