package server

// v1.48.5 THE SERVE BRIDGE — OpenCode's FREE models through the genuine
// client. The user's ask: "Have another go at making opencode free via the
// API" — and the live-probed answer: the hosted API's free tier is walled
// BELOW HTTP to OpenCode's own apps (no header set passes; the engine
// already carries the honest 403 message), while `opencode serve` — the
// genuine client the user's own research found — serves free models with
// our plain API key. This file owns the ENGINE side: a lazily-managed
// serve child (ocserve.Manager), one serve session per app chat, the
// SSE→engine event mapping (reasoning deltas → thinking, text deltas →
// assistant_delta, tool parts → the pill grammar), THE GATE LAWS (the
// default turn shape only — persona/context ride the message text; a
// shape violation poisons the session → THE RECYCLE LAW), and the usage
// ledger (serve's own tokens + the reasoning share ride the v1.46.2
// ledger end-to-end).

import (
        "context"
        "fmt"
        "log"
        "os"
        "strings"

        "github.com/ScoobyBaby1999/doomalay/engine/internal/ocserve"
        "github.com/ScoobyBaby1999/doomalay/engine/internal/store"
)

// ocServeDataDir answers the bridge's data home — the engine's own data
// dir when configured, else unsuitable ("" → no bridge; honest).
func (s *Server) ocServeDataDir() string {
        if s.cfg == nil {
                return ""
        }
        return s.cfg.DataDir
}

// ocServeManager lazily builds + starts the bridge. It returns nil when
// the bridge is not available on this device (no binary, Android, no key)
// — the caller falls through to the normal direct path, whose honest
// error names the wall.
func (s *Server) ocServeManager(ctx context.Context) *ocserve.Manager {
        s.ocServeMu.Lock()
        defer s.ocServeMu.Unlock()
        if s.ocServe != nil {
                if !s.ocServe.Healthy() {
                        if err := s.ocServe.Start(ctx); err != nil {
                                log.Printf("ocserve: restart failed: %v", err)
                                return nil
                        }
                }
                return s.ocServe
        }
        dir := s.ocServeDataDir()
        if dir == "" {
                return nil
        }
        if s.vault == nil {
                return nil
        }
        key := s.vault.AsEnv()["OPENCODE_ZEN_API_KEY"]
        if strings.TrimSpace(key) == "" {
                return nil
        }
        m := ocserve.New(dir, key, func(format string, args ...any) {
                log.Printf(format, args...)
        })
        // v1.49.1 THE GUEST ROOM: the Android spawner needs the Termux bridge
        // client (the jailed exec); nil on every build without the bridge
        // configured keeps the desktop exec-child law.
        if s.termux != nil {
                m.SetTermux(s.termux)
        }
        // the external-serve override (the rigs + tests): a serve that is
        // already up wins over spawning our own child
        if v := strings.TrimSpace(os.Getenv("OPENCODE_SERVE_URL")); v != "" {
                m.SetBaseURL(v)
        }
        if err := m.Start(ctx); err != nil {
                log.Printf("ocserve: bridge unavailable: %v", err)
                return nil
        }
        s.ocServe = m
        return m
}

// ocServeSessionID get-or-creates the serve session for an app chat.
// In-memory only: an engine restart births a fresh serve session and the
// next turn replays the persona + compacted context (the opening text) —
// serve sessions are cheap and the recycle law is the same mechanism.
func (s *Server) ocServeSessionID(m *ocserve.Manager, sess *store.Session) (string, bool, error) {
        s.ocServeSessMu.Lock()
        defer s.ocServeSessMu.Unlock()
        if id, ok := s.ocServeSessions[sess.ID]; ok {
                return id, false, nil
        }
        id, err := m.CreateSession(sess.Title)
        if err != nil {
                return "", false, err
        }
        if s.ocServeSessions == nil {
                s.ocServeSessions = map[string]string{}
        }
        s.ocServeSessions[sess.ID] = id
        return id, true, nil
}

// ocServeForgetSession drops a poisoned serve session (THE RECYCLE LAW: a
// shape violation or an upstream flag poisons the session — clean turns
// on it keep failing; a fresh session recovers).
func (s *Server) ocServeForgetSession(sessID string) {
        s.ocServeSessMu.Lock()
        delete(s.ocServeSessions, sessID)
        s.ocServeSessMu.Unlock()
}

// ocServeOpeningText composes a FRESH serve session's first message: the
// persona/system block + the compacted context + the current user text —
// ALL in the message text (THE GATE LAW: the per-turn `system` field
// poisons the turn; the persona must ride the text).
func (s *Server) ocServeOpeningText(sess *store.Session, userText string) string {
        var b strings.Builder
        sys := s.systemPromptForMetrics(sess, personaMetrics{}, bundleNameOf(""))
        if t := strings.TrimSpace(sys); t != "" {
                b.WriteString("[[System persona — you follow this for the whole conversation:\n")
                b.WriteString(clampServer(t, 4000))
                b.WriteString("\n]]\n\n")
        }
        hist := trimInFlightUser(s.buildHistoryCompacted(sess.ID, sess, sess.SlidingWindow), userText)
        if sess.SlidingWindow == 0 {
                hist = trimInFlightUser(s.buildHistoryCompacted(sess.ID, sess, 40), userText)
        }
        if len(hist) > 0 {
                b.WriteString("[[Conversation so far:\n")
                for _, m := range hist {
                        switch m.Role {
                        case "user":
                                b.WriteString("User: ")
                        case "assistant":
                                b.WriteString("Assistant: ")
                        default:
                                continue
                        }
                        b.WriteString(clampServer(m.Content, 1500))
                        b.WriteString("\n")
                }
                b.WriteString("]]\n\n")
        }
        b.WriteString(userText)
        return b.String()
}

// runOcServeTurn runs ONE chat turn through the serve bridge. It returns
// true when the turn was handled (success or the bridge's own honest
// terminal error); false when the bridge is unavailable on this device —
// the caller falls through to the normal direct path (whose 403 answers
// with the honest walled-tier message).
func (s *Server) runOcServeTurn(ctx context.Context, pipe *chatPipe, sessionID string, sess *store.Session, userText string, terminal *bool) bool {
        // v1.49.2 THE OPEN HANDSHAKE: an in-flight install never blocks the
        // turn on the manager mutex (a 52MB download is minutes on mobile) and
        // never silently degrades to the walled 403 — the turn answers the
        // honest in-progress terminal so the user knows exactly what's
        // happening.
        if running, _ := s.ocBridgeState(); running {
                events := make(chan map[string]any, 8)
                errs := make(chan error, 2)
                go func() {
                        defer close(events)
                        defer close(errs)
                        events <- map[string]any{"type": "progress", "session_id": sessionID,
                                "message": "Setting up the OpenCode pocket bridge (one-time install through Termux)…"}
                        events <- map[string]any{"type": "error", "session_id": sessionID,
                                "error": "oc_bridge_installing", "message": "The OpenCode pocket bridge is still installing (one-time ~" + ocserve.AndroidZipSizeHint() + " download through Termux) — try again in a moment; the OpenCode provider card shows the live progress"}
                        events <- map[string]any{"type": "status", "session_id": sessionID, "state": "error", "usage": nil}
                }()
                s.forwardEvents(ctx, pipe, sessionID, sess, userText, s.synthesizeRounds(sessionID, events), errs, terminal)
                return true
        }
        m := s.ocServeManager(ctx)
        if m == nil {
                return false
        }
        events := make(chan map[string]any, 64)
        errs := make(chan error, 4)
        go func() {
                defer close(events)
                defer close(errs)
                if err := s.ocServeStreamTurn(ctx, m, sessionID, sess, userText, events); err != nil {
                        errs <- err
                }
        }()
        // the round synthesizer — the SAME wrap the direct path runs: it
        // folds assistant_delta accumulations into the assistant round events
        // the transcript grammar reads (the live probe convicted its absence:
        // thinking + usage landed, the answer never became an assistant row)
        s.forwardEvents(ctx, pipe, sessionID, sess, userText, s.synthesizeRounds(sessionID, events), errs, terminal)
        return true
}

// ocServeStreamTurn drives one serve turn and streams the engine's own
// event vocabulary onto out. THE RECYCLE LAW: a free-tier refusal inside
// the turn (ours never violates the shape, but upstream flags evolve)
// births a fresh serve session with the full opening text and retries
// ONCE; a second wall answers honestly with the bridge's own error +
// terminal (never a silent hang).
func (s *Server) ocServeStreamTurn(ctx context.Context, m *ocserve.Manager, sessionID string, sess *store.Session, userText string, out chan<- map[string]any) error {
        modelID := strings.TrimPrefix(sess.Model, "opencode/")
        for attempt := 0; attempt < 2; attempt++ {
                serveSess, fresh, err := s.ocServeSessionID(m, sess)
                if err != nil {
                        return fmt.Errorf("serve bridge session: %w", err)
                }
                // v1.51.1 THE SECOND TONGUE: model selection lives on the SESSION
                // in 2.x — the adapter selects before EVERY prompt (the per-turn
                // model law; a cheap 204, the turn echoes it in session.step.started).
                if err := m.SelectModel(serveSess, modelID); err != nil {
                        return fmt.Errorf("serve bridge select model: %w", err)
                }
                text := userText
                if fresh {
                        text = s.ocServeOpeningText(sess, userText)
                }
                if err := m.Prompt(serveSess, text); err != nil {
                        return fmt.Errorf("serve bridge prompt: %w", err)
                }
                out <- map[string]any{"type": "progress", "session_id": sessionID,
                        "message": "OpenCode free bridge: turn in flight (the genuine OpenCode 2 client)"}
                recycled, err := s.ocServePump(ctx, m, serveSess, sessionID, out)
                if recycled {
                        // THE RECYCLE LAW: drop the poisoned serve session; the next
                        // attempt composes the full opening text on a fresh one.
                        s.ocServeForgetSession(sessionID)
                        if attempt == 0 {
                                continue
                        }
                        // the second wall: the honest terminal (never a silent hang)
                        out <- map[string]any{"type": "error", "session_id": sessionID,
                                "error": "oc_free_walled", "message": "OpenCode's free tier refused this turn twice (their gate is evolving) — try again in a moment, or switch provider (NVIDIA / PrivateMode have working free models)"}
                        out <- map[string]any{"type": "status", "session_id": sessionID, "state": "error", "usage": nil}
                        return nil
                }
                return err
        }
        return nil
}

// ocServePump consumes the 2.x serve's SSE feed for one turn, mapping the
// v2 event vocabulary onto the engine's. It returns recycled=true when
// the turn hit OpenCode's free-tier wall (the recycle law's trigger).
func (s *Server) ocServePump(ctx context.Context, m *ocserve.Manager, serveSess, sessionID string, out chan<- map[string]any) (bool, error) {
        toolNames := map[string]string{} // tool call id → tool name (input.started)
        usedEmitted := map[string]bool{}  // the pill law: use BEFORE result, exactly once
        var usage map[string]any
        finish := "stop"
        emitToolUse := func(callID, name, args string) {
                if callID == "" || usedEmitted[callID] {
                        return
                }
                usedEmitted[callID] = true
                if args == "" {
                        args = "{}"
                }
                out <- map[string]any{"type": "tool_use", "session_id": sessionID,
                        "name": "opencode:" + name, "summary": "running", "args": args,
                        "tool_use_id": callID}
        }
        pump := func(ev ocserve.Event) error {
                switch ev.Type {
                case "session.reasoning.delta":
                        if ev.Data.Delta == "" {
                                return nil
                        }
                        out <- map[string]any{"type": "thinking", "session_id": sessionID, "text": ev.Data.Delta}
                case "session.text.delta":
                        if ev.Data.Delta == "" {
                                return nil
                        }
                        out <- map[string]any{"type": "assistant_delta", "session_id": sessionID, "text": ev.Data.Delta}
                case "session.tool.input.started":
                        if ev.Data.ID != "" {
                                toolNames[ev.Data.ID] = ev.Data.Name
                        }
                case "session.tool.input.ended":
                        // the pill's use event — with the serialized args the 2.x feed
                        // carries (input.ended's text IS the call's JSON)
                        emitToolUse(ev.Data.ID, toolNames[ev.Data.ID], ev.Data.Text)
                case "session.tool.success":
                        // belt: a result with no seen use still needs its use row
                        emitToolUse(ev.Data.ID, toolNames[ev.Data.ID], "")
                        var texts []string
                        for _, c := range ev.Data.Content {
                                texts = append(texts, c.Text)
                        }
                        out <- map[string]any{"type": "tool_result", "session_id": sessionID,
                                "name": "opencode:" + toolNames[ev.Data.ID], "text": clampServer(strings.Join(texts, "\n"), 6000),
                                "tool_use_id": ev.Data.ID}
                case "session.tool.failed":
                        emitToolUse(ev.Data.ID, toolNames[ev.Data.ID], "")
                        msg := ev.Data.Text
                        if ev.Data.Error != nil && ev.Data.Error.Message != "" {
                                msg = ev.Data.Error.Message
                        }
                        out <- map[string]any{"type": "tool_result", "session_id": sessionID,
                                "name": "opencode:" + toolNames[ev.Data.ID], "text": clampServer(msg, 6000),
                                "tool_use_id": ev.Data.ID}
                case "session.step.ended":
                        if ev.Data.Finish != "" {
                                finish = ev.Data.Finish
                        }
                case "session.usage.updated":
                        // THE LEDGER: the serve's own accounting (per step, cumulative
                        // over the serve session) — never invented, cost included.
                        usage = map[string]any{
                                "input_tokens":     ev.Data.Tokens.Input,
                                "output_tokens":    ev.Data.Tokens.Output,
                                "total_tokens":     ev.Data.Tokens.Input + ev.Data.Tokens.Output + ev.Data.Tokens.Reasoning,
                                "reasoning_tokens": ev.Data.Tokens.Reasoning,
                                "cache_read":       ev.Data.Tokens.Cache.Read,
                                "cache_write":      ev.Data.Tokens.Cache.Write,
                                "cost":             ev.Data.Cost,
                                "finish_reason":    finish,
                                "output_cut":       false,
                        }
                case "session.execution.succeeded":
                        if usage == nil {
                                usage = map[string]any{"input_tokens": 0, "output_tokens": 0,
                                        "total_tokens": 0, "reasoning_tokens": 0, "finish_reason": finish, "output_cut": false}
                        }
                        usage["finish_reason"] = finish
                        out <- map[string]any{"type": "status", "session_id": sessionID,
                                "state": "idle", "usage": usage}
                case "session.execution.failed":
                        if ev.IsFreeTierError() {
                                // the wall: the recycle law's trigger
                                return errRecycle
                        }
                        msg := "the OpenCode free bridge turn failed"
                        errKind := "oc_bridge_error"
                        if ev.Data.Error != nil && ev.Data.Error.Message != "" {
                                msg = ev.Data.Error.Message
                        }
                        if ev.IsAuthError() {
                                errKind = "oc_bridge_auth"
                                msg = "OpenCode rejected the bridge key — check the OpenCode key in the providers screen (" + msg + ")"
                        }
                        out <- map[string]any{"type": "error", "session_id": sessionID,
                                "error": errKind, "message": msg}
                        out <- map[string]any{"type": "status", "session_id": sessionID, "state": "error", "usage": nil}
                }
                return nil
        }
        err := m.StreamEvents(ctx, serveSess, pump)
        if err == errRecycle {
                return true, nil
        }
        return false, err
}

// errRecycle is the internal sentinel for the recycle law.
var errRecycle = fmt.Errorf("ocserve: free-tier wall")

// ocServeBridgeAvailable answers whether a serve is up right now (never
// starts one) — the dispatch gate's cheap half.
func (s *Server) ocServeBridgeAvailable() bool {
        s.ocServeMu.Lock()
        m := s.ocServe
        s.ocServeMu.Unlock()
        return m != nil && m.Healthy()
}
