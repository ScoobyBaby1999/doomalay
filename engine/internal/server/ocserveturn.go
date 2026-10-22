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
        "encoding/json"
        "fmt"
        "log"
        "os"
        "path/filepath"
        "strings"
        "time"

        "github.com/ScoobyBaby1999/doomalay/engine/internal/llm"
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
//
// v1.55.1 THE NO-LONG-HOLD LAW: ocServeMu guards ONLY the manager pointer
// (held for microseconds — the bridge status route's peeks and every other
// reader stay live through an install). The SLOW work (provisioning,
// download, spawn, boot) runs under ocServeStartMu, so the only goroutines
// that ever wait on an install are the ones that genuinely need the bridge
// (a turn mid-self-heal, the installer itself) — never the API surface.
func (s *Server) ocServeManagerErr(ctx context.Context) (*ocserve.Manager, error) {
        // fast path: a healthy manager is answered without the start lock
        s.ocServeMu.Lock()
        m := s.ocServe
        s.ocServeMu.Unlock()
        if m != nil && m.Healthy() {
                return m, nil
        }
        dir := s.ocServeDataDir()
        if dir == "" {
                return nil, nil
        }
        if s.vault == nil {
                return nil, nil
        }
        key := s.vault.AsEnv()["OPENCODE_ZEN_API_KEY"]
        if strings.TrimSpace(key) == "" {
                return nil, nil
        }
        // the slow path — serialized (the start mutex; NOT ocServeMu)
        s.ocServeStartMu.Lock()
        defer s.ocServeStartMu.Unlock()
        // re-peek under the start lock: a racing starter may have finished
        s.ocServeMu.Lock()
        m = s.ocServe
        s.ocServeMu.Unlock()
        if m == nil {
                m = ocserve.New(dir, key, func(format string, args ...any) {
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
                // the manager is visible IMMEDIATELY (its InstallProgress is the
                // live ping the status route renders while the install runs)
                s.ocServeMu.Lock()
                if s.ocServe == nil {
                        s.ocServe = m
                } else {
                        m = s.ocServe // a racing creator won the pointer
                }
                s.ocServeMu.Unlock()
        }
        if m.Healthy() {
                return m, nil
        }
        if err := m.Start(ctx); err != nil {
                // v1.55.5: the REAL failure surfaces (the install route's
                // honest last_error names the download/spawn truth — the
                // v1550 rig convicted the old nil-swallow that answered
                // 'no data dir or key' for a dead download).
                return nil, err
        }
        return m, nil
}

// ocServeManager is the turn path's wrapper: the healthy manager or nil
// (the real failure goes to the engine log — the turn path has its own
// honest copy for every nil reason).
func (s *Server) ocServeManager(ctx context.Context) *ocserve.Manager {
        m, err := s.ocServeManagerErr(ctx)
        if err != nil {
                log.Printf("ocserve: bridge unavailable: %v", err)
                return nil
        }
        return m
}

// ocServeBindKey answers the persisted-binding setting key for an app chat
// (the chat.tweaks.<sid> kv pattern — app_settings rows that ride along with
// the session's life).
func ocServeBindKey(appSessionID string) string { return "chat.ocserve." + appSessionID }

// ocServeBindingGet reads the persisted serve-session binding ("" = none).
// An error is LOGGED (never swallowed silently — the v1590 live rig
// convicted a silent "" that hid the real failure from the diagnosis).
// Nil-DB safe (the unit-test convention: Servers without a store answer "").
func (s *Server) ocServeBindingGet(appSessionID string) string {
        if s.db == nil {
                return ""
        }
        v, err := s.db.GetSetting(ocServeBindKey(appSessionID))
        if err != nil {
                log.Printf("ocserve: binding read for %s failed: %v", appSessionID, err)
                return ""
        }
        return strings.TrimSpace(v)
}

// ocServeBindingSet persists the app→serve session binding. Nil-DB safe
// (the unit-test convention: a storeless Server skips the persistence).
func (s *Server) ocServeBindingSet(appSessionID, serveSessionID string) {
        if s.db == nil {
                return
        }
        if err := s.db.SetSetting(ocServeBindKey(appSessionID), serveSessionID); err != nil {
                log.Printf("ocserve: persist binding for %s failed: %v", appSessionID, err)
        }
}

// ocServeChatDir — v1.60 THE WIDE SHELF: writes the app chat's OWN
// per-serve-session config directory (the per-chat MCP binding) + answers
// the ABSOLUTE workspace dir the serve session moves into.
//
// THE BINDING LAW (live-proven, v158 research): each serve session is
// MOVED into its own directory (POST /api/session/{id}/move) whose
// opencode.json carries the doomalay MCP entry pointing at the engine's
// per-chat route /mcp/oc/<app-chat-id> — one config dir per app chat,
// concurrency-safe by construction (two chats turning at once each speak
// to their own binding). The session's working directory is the ws/
// SUBDIR (the model's file tools see a per-chat workspace, not the config
// file itself); the config resolves from the PARENT — opencode's own
// "current directory and its parents" law. On failure: ("", false) —
// the turn degrades gracefully to a native-only session (the honest
// unbound tools block says so; never a broken turn).
// ocServeChatDir — v1.58.2 THE WIDE SHELF: writes the app chat's OWN
// per-serve-session config directory (the per-chat MCP binding) + answers
// the ABSOLUTE workspace dir the serve session moves into.
//
// THE BINDING LAW (live-proven, v158 research): each serve session is
// MOVED into its own directory (POST /api/session/{id}/move) whose
// opencode.json carries the doomalay MCP entry pointing at the engine's
// per-chat route /mcp/oc/<app-chat-id> — one config dir per app chat,
// concurrency-safe by construction (two chats turning at once each speak
// to their own binding). The session's working directory is the ws/
// SUBDIR (the model's file tools see a per-chat workspace, not the config
// file itself); the config resolves from the PARENT — opencode's own
// "current directory and its parents" law. On failure: ("", false) —
// the turn degrades gracefully to a native-only session (the honest
// unbound tools block says so; never a broken turn).
func (s *Server) ocServeChatDir(m *ocserve.Manager, chatID string) (string, bool) {
        port := 8080
        if s.cfg != nil && s.cfg.Port > 0 { // the test server carries no cfg — the guard keeps the unit law
                port = s.cfg.Port
        }
        safeChat := filepath.Base(chatID) // the jail law: no path tricks ride the chat id
        entry := map[string]any{
                "type":     "remote",
                "url":      fmt.Sprintf("http://127.0.0.1:%d/mcp/oc/%s", port, safeChat),
                "headers":  map[string]string{"X-Doomalay-Session": safeChat}, // the belt: headers RIDED live-proven
                "oauth":    false,                                            // plain loopback HTTP — no OAuth probing
                "codemode": true, // THE PROVEN ROUTE: 2.1.2 serves MCP tools through Code Mode as tools.doomalay_<tool> (live-proven end-to-end: the attach probe computed 17*23=391 through tools.doomalay.calculator). codemode:false excluded them from Code Mode entirely (live-convicted: "Unknown tool 'doomalay_calculator'" + the empty search) with the direct exposure unproven on this build — never ship the unproven arm when the proven one works. The nested doomalay.* statuses ride the live pill (v1.58.1's toolCalls progress law).
                "timeout":  map[string]int{"startup": 20000, "catalog": 20000, "execution": 300000},
        }
        cfg := map[string]any{
                "$schema": "https://opencode.ai/config.json",
                "mcp":     map[string]any{"servers": map[string]any{"doomalay": entry}},
        }
        b, err := json.MarshalIndent(cfg, "", "  ")
        if err != nil {
                return "", false
        }
        if err := m.WriteServeFile("chats/"+safeChat+"/opencode.json", string(b)); err != nil {
                log.Printf("ocserve: per-chat mcp config write failed: %v", err)
                return "", false
        }
        // the ws dir must EXIST before the move (both platforms) — the .keep
        // forces the tree creation through the same write law.
        if err := m.WriteServeFile("chats/"+safeChat+"/ws/.keep", ""); err != nil {
                log.Printf("ocserve: per-chat ws dir create failed: %v", err)
                return "", false
        }
        dir, err := m.ServeDir("chats/" + safeChat + "/ws")
        if err != nil {
                log.Printf("ocserve: per-chat ws dir resolve failed: %v", err)
                return "", false
        }
        return dir, true
}

// ocServeSessionID get-or-creates the serve session for an app chat.
// v1.59.2 THE SERVE MEMORY: the binding now OUTLIVES the engine — a fresh
// map entry first consults the PERSISTED binding (chat.ocserve.<sid>) and,
// when the serve still holds that session (SessionExists — the 2.x serve's
// sessions are durable in its own SQLite, live-verified), ADOPTS it: the
// turn rides the serve's own full history (fresh=false — NO opening-text
// recap, the model keeps its context and its thinking). A dead binding
// self-heals exactly like before: fresh session + opening text, once.
//
// v1.60 THE WIDE SHELF: a FRESH session is created + MOVED into its own
// per-chat config dir (the doomalay MCP binding) — the third return is the
// BOUND state (the {tools} block speaks it honestly); an ADOPTED session
// keeps the binding it was born with (the config dir persists on the serve
// side with the session; the rewrite confirms the machinery still works).
func (s *Server) ocServeSessionID(m *ocserve.Manager, sess *store.Session) (string, bool, bool, error) {
                s.ocServeSessMu.Lock()
        defer s.ocServeSessMu.Unlock()
        if id, ok := s.ocServeSessions[sess.ID]; ok {
                return id, false, s.ocServeBound[sess.ID], nil
        }
        // v1.59.2 THE SERVE MEMORY: adopt a LIVING persisted binding (no recap —
        // the model keeps its context + thinking).
        persisted := s.ocServeBindingGet(sess.ID)
        if persisted != "" && m.SessionExists(persisted) {
                if s.ocServeSessions == nil {
                        s.ocServeSessions = map[string]string{}
                }
                if s.ocServeBound == nil {
                        s.ocServeBound = map[string]bool{}
                }
                // v1.60 THE WIDE SHELF: the adopted session KEEPS the per-chat MCP
                // binding it was born with (it was moved into its config dir at
                // creation; the config persists with the serve). The (re)write confirms
                // the machinery still serves this chat — a failure answers bound=false
                // honestly (the tools block degrades, never the turn).
                mcpBound := false
                if _, ok := s.ocServeChatDir(m, sess.ID); ok {
                        mcpBound = true
                }
                s.ocServeSessions[sess.ID] = persisted
                s.ocServeBound[sess.ID] = mcpBound
                log.Printf("ocserve: adopted serve session %s for chat %s (the binding survived the restart)", persisted, sess.ID)
                return persisted, false, mcpBound, nil
        }
        if persisted != "" {
                log.Printf("ocserve: the persisted binding %q for chat %s did not resolve on the serve — a fresh serve session is incoming", persisted, sess.ID)
        }
        // v1.60 THE WIDE SHELF: a FRESH session is born in its own per-chat
        // config dir (the doomalay MCP binding); a failed move degrades to an
        // unbound session honestly.
        mcpBound := false
        var id string
        var err error
        if dir, ok := s.ocServeChatDir(m, sess.ID); ok {
                uid, uerr := m.CreateSessionInDir(sess.Title, dir)
                if uerr == nil {
                        id, mcpBound = uid, true
                } else if uid != "" {
                        // the session exists but the MOVE failed (an Android build without
                        // /move, a full disk…): the honest degradation — keep it UNBOUND,
                        // the native tools still run, the tools block says the truth.
                        log.Printf("ocserve: per-chat move failed (%v) — session rides unbound", uerr)
                        id = uid
                } else {
                        err = uerr
                }
        } else {
                id, err = m.CreateSession(sess.Title)
        }
        if err != nil {
                return "", false, false, err
        }
        if s.ocServeSessions == nil {
                s.ocServeSessions = map[string]string{}
        }
        if s.ocServeBound == nil {
                s.ocServeBound = map[string]bool{}
        }
        s.ocServeSessions[sess.ID] = id
        s.ocServeBound[sess.ID] = mcpBound
        // v1.59.2: the binding OUTLIVES the engine
        s.ocServeBindingSet(sess.ID, id)
        return id, true, mcpBound, nil
}

// ocServeForgetSession drops a poisoned serve session (THE RECYCLE LAW: a
// shape violation or an upstream flag poisons the session — clean turns
// on it keep failing; a fresh session recovers). v1.59.2: the PERSISTED
// binding dies with it (a recycled session must never be re-adopted after
// a restart — the poison would outlive the engine).
func (s *Server) ocServeForgetSession(sessID string) {
        s.ocServeSessMu.Lock()
        delete(s.ocServeSessions, sessID)
        delete(s.ocServeBound, sessID)
        s.ocServeSessMu.Unlock()
        _ = s.db.DeleteSetting(ocServeBindKey(sessID))
}

// dropOcServeBinding is the chat-DELETE path's cleanup (v1.59.2): the
// app-side rows die first (memory map + the persisted binding — the truth),
// then the serve-side session is deleted BEST-EFFORT — only when a serve
// is ALREADY healthy (the delete never spawns, never installs, never
// blocks on the bridge — the v1.55.1 no-long-hold law). A failed or
// skipped delete leaves a tiny orphaned row in the serve's own storage —
// logged, honest, harmless.
func (s *Server) dropOcServeBinding(appSessionID string) {
        bound := s.ocServeBindingGet(appSessionID)
        s.ocServeForgetSession(appSessionID)
        if bound == "" {
                return
        }
        if !s.ocServeBridgeAvailable() {
                return
        }
        s.ocServeMu.Lock()
        m := s.ocServe
        s.ocServeMu.Unlock()
        if m == nil {
                return
        }
        if err := m.DeleteSession(bound); err != nil {
                log.Printf("ocserve: orphan serve session %s left behind (best-effort delete failed: %v)", bound, err)
        } else {
                log.Printf("ocserve: serve session %s deleted with chat %s", bound, appSessionID)
        }
}

// ocServeOpeningText composes a FRESH serve session's first message: the
// persona/system block + the compacted context + the current user text —
// ALL in the message text (THE GATE LAW: the per-turn `system` field
// poisons the turn; the persona must ride the text).
//
// v1.58.2: the compose rides systemPromptForMetricsMode in SERVE mode — the
// {artifacts} block speaks the serve truth (never the ACTION prose) and
// the {tools} block carries the merged catalog when the per-chat doomalay
// MCP binding landed (bound), or the honest native-only note when it did
// not (the model never hallucinates tools it does not have — the chatlog's
// Tier-0 disease, dead).
func (s *Server) ocServeOpeningText(sess *store.Session, userText string, mcpBound bool) string {
        var b strings.Builder
        sys := s.systemPromptForMetricsMode(sess, personaMetrics{}, bundleNameOf(""), true, mcpBound)
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
        // turn on the manager mutex (a 72.5MB download is minutes on mobile) and
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
        // v1.55.4 THE VARIANT LAW: the 2.x serve speaks effort through VARIANTS
        // (provider/model#variant — the docs' own grammar, live-captured from
        // the serve's catalogue: variants [{id:"low", settings:{reasoningEffort:
        // "low"}}, …]). The chat's effort knob maps onto the model's OWN variant
        // ladder — fetched LIVE from the healthy serve (never a static table);
        // no match → the base model (the serve's default reasoning).
        effort := strings.TrimSpace(sess.Effort)
        if effort != "" && effort != "med" && effort != "off" {
                if cat := m.LiveCatalog(); len(cat) > 0 {
                        for _, sm := range cat {
                                if sm.ModelID != modelID {
                                        continue
                                }
                                for _, v := range sm.Variants {
                                        if strings.EqualFold(v.Settings.ReasoningEffort, effort) {
                                                modelID = modelID + "#" + v.ID
                                                break
                                        }
                                }
                                break
                        }
                }
        }
        for attempt := 0; attempt < 2; attempt++ {
                // v1.59.2: the turn's start stamps BEFORE the prompt — the no-hang
                // guard's durable-record probe keys on it (an instant failure lands
                // its idle marker moments after this, often before the pump starts)
                turnStartedAt := time.Now().UnixMilli()
                serveSess, fresh, mcpBound, err := s.ocServeSessionID(m, sess)
                if err != nil {
                        return fmt.Errorf("serve bridge session: %w", err)
                }
                // v1.51.1 THE SECOND TONGUE: model selection lives on the SESSION
                // in 2.x — the adapter selects before EVERY prompt (the per-turn
                // model law; a cheap 204, the turn echoes it in session.step.started).
                if err := m.SelectModel(serveSess, modelID); err != nil {
                        return fmt.Errorf("serve bridge select model: %w", err)
                }
                // v1.58.2 THE TERMUX AUTO-ENABLE (R8): the pocket bridge LIVES in
                // the device's Termux — a chat running through it HAS the termux
                // capability by construction. The engine self-heals the per-chat
                // flag (the store update) + the progress line tells the user; the
                // chip reflects the truth on its next session read. Desktop serves
                // never trip this (ViaTermux is the pocket-bridge truth).
                if m.ViaTermux() && !sess.Termux {
                        sess.Termux = true
                        if err := s.db.UpdateSession(sess); err != nil {
                                sess.Termux = false // the flip never wedges the turn
                                log.Printf("ocserve: termux auto-enable failed: %v", err)
                        } else {
                                out <- map[string]any{"type": "progress", "session_id": sessionID,
                                        "message": "Termux capability enabled for this chat (the opencode pocket bridge runs there)"}
                        }
                }
                text := userText
                if fresh {
                        text = s.ocServeOpeningText(sess, userText, mcpBound)
                }
                // v1.58.2 THE DYNAMIC PROGRESS LINES: the static "turn in
                // flight" copy is DEAD — the pill now moves with the turn's own
                // truth (connecting → the model thinking → the tool lines ride
                // the tool_stream machinery from v1.58.1).
                out <- map[string]any{"type": "progress", "session_id": sessionID,
                        "message": "Connecting to OpenCode…"}
                if err := m.Prompt(serveSess, text); err != nil {
                        return fmt.Errorf("serve bridge prompt: %w", err)
                }
                out <- map[string]any{"type": "progress", "session_id": sessionID,
                        "message": "OpenCode: " + strings.TrimPrefix(modelID, "opencode/") + " is thinking…"}
                recycled, err := s.ocServePump(ctx, m, serveSess, sessionID, sess.Model, out, turnStartedAt)
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

// ocServeSilenceProbe is how long the pump stays quiet before polling the
// session's own durable record (the volatile-stream no-hang guard — a test
// may shorten it).
var ocServeSilenceProbe = 12 * time.Second

// ocServePump consumes the 2.x serve's SSE feed for one turn, mapping the
// v2 event vocabulary onto the engine's. It returns recycled=true when
// the turn hit OpenCode's free-tier wall (the recycle law's trigger).
// v1.58.1 THE INFORMATIVE PILL (PLAN-V158 §1): the tool events now speak
// the engine's OWN pill grammar — the name WITHOUT the "opencode:" prefix
// + a DERIVED summary (the operand table in ocservetools.go) — so the
// PWA's existing toolPillLabelParts else-branch renders opencode pills
// byte-identically to native ones (title=verb, body=operand — the OOP
// reuse the user asked for, zero new pill code). THE UNBOUNDED RESULT: the
// silent 6000-char clampServer is DEAD — the result rides ClampMarked
// with the window-physics budget (ocObsBudget — the v1.56.1 whole-return
// law) + the serve's OWN metadata.truncated verdict surfaces honestly.
// THE LIVE PILL: session.tool.progress frames ride the tool_stream
// machinery (the termux live-tail law) — the pending pill's stream area
// + the activity clock both move with the serve's real mid-tool truth.
//
// v1.59.2 THE NO-HANG GUARD: the global /api/event stream is VOLATILE (the
// 2.x contract — events fired while not connected are MISSED), and a turn
// that fails between the prompt POST and the stream's connect (no-route,
// the free-limit wall, auth) never lands on the wire — the old pump spun
// FOREVER (the eternal-spinner conviction: the user's "send/reply/continue
// behave as if I was mid flight", live-convicted by the v1590 rig against
// the real 2.1.2 + the real key). After ~ocServeSilenceProbe of silence
// the pump polls the session's OWN durable record (SessionIdleSince — the
// trailing idle message); a turn that already ended off-wire synthesizes
// the honest terminal (error + status, or the assistant text + idle) and
// RETURNS.
func (s *Server) ocServePump(ctx context.Context, m *ocserve.Manager, serveSess, sessionID, model string, out chan<- map[string]any, turnStartedAt int64) (bool, error) {
        toolNames := map[string]string{} // tool call id → tool name (input.started)
        usedEmitted := map[string]bool{}  // the pill law: use BEFORE result, exactly once
        var usage map[string]any
        finish := "stop"
        lastEvAt := time.Now().UnixMilli()
        emitToolUse := func(callID, name, args string) {
                if callID == "" || usedEmitted[callID] {
                        return
                }
                usedEmitted[callID] = true
                if args == "" {
                        args = "{}"
                }
                // v1.58.1: name BARE (the PWA titles the pill with it) + the
                // summary DERIVED from the args (never a static "running" —
                // an unparseable body still yields the tool's fallback law).
                out <- map[string]any{"type": "tool_use", "session_id": sessionID,
                        "name": name, "summary": ocToolSummary(name, args), "args": args,
                        "tool_use_id": callID}
        }
        pump := func(ev ocserve.Event) error {
                lastEvAt = time.Now().UnixMilli()
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
                case "session.tool.called":
                        // v1.58.1 THE CALLED BELT: the serve mirrors the call's args here as
                        // a STRUCTURED dict (live-captured: called rides AFTER input.ended
                        // on the healthy path). When input.ended never rode (an upstream
                        // event-shape change), the pill still gets its use row with the
                        // structured input marshaled as the args — never a missing pill.
                        if ev.Data.ID != "" {
                                if ev.Data.Name != "" {
                                        toolNames[ev.Data.ID] = ev.Data.Name
                                }
                                if len(ev.Data.Input) > 0 {
                                        emitToolUse(ev.Data.ID, toolNames[ev.Data.ID], string(ev.Data.Input))
                                }
                        }
                case "session.tool.progress":
                        // v1.58.1 THE LIVE PILL: the serve's OWN mid-tool progress (Code
                        // Mode's nested call statuses, a live shell session) rides the
                        // tool_stream machinery — the pending pill's live stream area
                        // grows + the activity clock bumps (the stall law) with the
                        // serve's real truth. Nothing is invented: empty metadata → no ping.
                        if line := ocProgressLine(ev.Data.Metadata); line != "" {
                                name := toolNames[ev.Data.ID]
                                if name == "" {
                                        name = "opencode"
                                }
                                out <- map[string]any{"type": "tool_stream", "session_id": sessionID,
                                        "name": name, "delta": line + "\n", "tool_use_id": ev.Data.ID}
                        }
                case "session.tool.success":
                        // belt: a result with no seen use still needs its use row
                        emitToolUse(ev.Data.ID, toolNames[ev.Data.ID], "")
                        var texts []string
                        for _, c := range ev.Data.Content {
                                texts = append(texts, c.Text)
                        }
                        // v1.58.1 THE UNBOUNDED RESULT: the silent 6000-char clamp is DEAD —
                        // the whole-return law (ClampMarked + the window-physics budget)
                        // + the serve's OWN truncated verdict (metadata.truncated) append
                        // honestly (we never invent a truncation the serve didn't declare).
                        res := llm.ClampMarked(strings.Join(texts, "\n"), ocObsBudget(model))
                        res = ocResultText(res, ev.Data.Metadata.Truncated != nil && *ev.Data.Metadata.Truncated)
                        out <- map[string]any{"type": "tool_result", "session_id": sessionID,
                                "name": toolNames[ev.Data.ID], "text": res,
                                "tool_use_id": ev.Data.ID}
                case "session.tool.failed":
                        emitToolUse(ev.Data.ID, toolNames[ev.Data.ID], "")
                        msg := ev.Data.Text
                        if ev.Data.Error != nil && ev.Data.Error.Message != "" {
                                msg = ev.Data.Error.Message
                        }
                        // v1.58.1: the failure text rides the same unbounded law (an
                        // honest long error is never amputated at 6000 chars).
                        out <- map[string]any{"type": "tool_result", "session_id": sessionID,
                                "name": toolNames[ev.Data.ID], "text": llm.ClampMarked(msg, ocObsBudget(model)),
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
                        errType, errMsg, status := "", "", 0
                        if ev.Data.Error != nil {
                                errType, errMsg, status = ev.Data.Error.Type, ev.Data.Error.Message, ev.Data.Error.Status
                        }
                        for _, e := range ocServeFailEvents(sessionID, errType, errMsg, status) {
                                out <- e
                        }
                }
                return nil
        }
        // v1.59.2: the stream rides its own goroutine; the silence watchdog
        // polls the durable record and owns the off-wire terminal (THE
        // NO-HANG GUARD — see the function comment).
        pctx, pcancel := context.WithCancel(ctx)
        defer pcancel()
        eventsDone := make(chan error, 1)
        go func() { eventsDone <- m.StreamEvents(pctx, serveSess, pump) }()
        probe := time.NewTicker(ocServeSilenceProbe)
        defer probe.Stop()
        for {
                select {
                case err := <-eventsDone:
                        if err == errRecycle {
                                return true, nil
                        }
                        return false, err
                case <-probe.C:
                        quiet := int64(ocServeSilenceProbe / time.Millisecond)
                        if time.Now().UnixMilli()-lastEvAt < quiet*3/4 {
                                continue // live events are flowing — no probe needed
                        }
                        ended, failed, errType, errMsg, ansText := m.SessionIdleSince(serveSess, turnStartedAt)
                        if !ended {
                                continue // still running — the quiet phase of a long turn
                        }
                        pcancel()
                        <-eventsDone // the cancelled stream returns shortly
                        if failed && strings.Contains(strings.ToLower(errMsg), "free tier") {
                                // the classic wall — the recycle law owns it
                                return true, nil
                        }
                        if failed {
                                for _, e := range ocServeFailEvents(sessionID, errType, errMsg, 0) {
                                        out <- e
                                }
                                return false, nil
                        }
                        // the off-wire SUCCESS: the assistant text + the idle terminal
                        if strings.TrimSpace(ansText) != "" {
                                out <- map[string]any{"type": "assistant", "session_id": sessionID, "text": ansText}
                        }
                        out <- map[string]any{"type": "status", "session_id": sessionID,
                                "state": "idle", "usage": map[string]any{"input_tokens": 0, "output_tokens": 0,
                                        "total_tokens": 0, "reasoning_tokens": 0, "finish_reason": "stop", "output_cut": false}}
                        return false, nil
                }
        }
}

// ocServeFailEvents builds the honest failure pair (error + terminal
// status) — ONE truth for both the wire path and the no-hang watchdog.
func ocServeFailEvents(sessionID, errType, errMsg string, status int) []map[string]any {
        msg := strings.TrimSpace(errMsg)
        if msg == "" {
                msg = "the OpenCode free bridge turn failed"
        }
        kind := "oc_bridge_error"
        if errType == "provider.auth" || status == 401 {
                kind = "oc_bridge_auth"
                msg = "OpenCode rejected the bridge key — check the OpenCode key in the providers screen (" + msg + ")"
        }
        // v1.61.3 THE RETRY SENTINEL: the free-limit / rate-limit class arms
        // the shared dynamic timer (the window rolls on opencode's own
        // ~11h clock; the probe checks the bridge's health; the turn
        // AUTO-RESUMES with no tap — the user's order. Auth failures never
        // arm.)
        retryClass := ""
        if status == 429 || strings.Contains(strings.ToLower(msg), "free usage limit") || strings.Contains(strings.ToLower(msg), "rate limit") {
                if kind != "oc_bridge_auth" {
                        retryClass = "429"
                }
        }
        errEv := map[string]any{"type": "error", "session_id": sessionID, "error": kind, "message": msg}
        if retryClass != "" {
                errEv["retry_class"] = retryClass
                errEv["retry_provider"] = "opencode"
        }
        return []map[string]any{
                errEv,
                {"type": "status", "session_id": sessionID, "state": "error", "usage": nil},
        }
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
