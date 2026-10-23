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
                "codemode": false, // v1.64.1 THE NATIVE SHELF: codemode:true bundled every doomalay tool INSIDE Code Mode's single execute tool (tools.doomalay_<name> dotted calls — the schema's own default, "Expose this server's tools through Code Mode") — the user saw opencode's own execute pill and our tools armed NOWHERE natively, and the nested calls rode EPHEMERAL progress frames (the "bottom chunk of tools… doesn't save" half). codemode:false exposes every tool DIRECTLY to the model as a first-class doomalay_<tool> (the permission config's own doomalay_* allow-rules), every call a real session.tool.* frame → a persisted pill. The v1.60.4 conviction ("Unknown tool 'doomalay_calculator'" from inside execute) was the OLD {tools} block teaching Code Mode naming under the false arm — the block now teaches the direct grammar, and the v1640 rig live-proves the direct route end-to-end (the unproven-arm law honored: prove it or revert it).
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
// is RE-HOMED into its per-chat dir by v1.64.1 THE NATIVE SHELF (below).
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
                // v1.64.1 THE NATIVE SHELF — THE UNMOVED ADOPTEE: the device's own
                // conviction was an adopted session whose serve-side directory was
                // still the ROOT (born pre-v1.60, or a move that failed at birth) —
                // the root config carries NO mcp block, so 30 running tools armed
                // ZERO sessions natively. The adoption path now RE-HOMES the
                // session: when the serve's own directory row differs from the
                // per-chat dir (or the build won't speak it — move once, the map
                // caches), MoveSession puts it where its config lives. The move is
                // the live-proven attach vehicle (the destination's location
                // instance re-resolves config + MCP — the 2.1.x per-location
                // instance law). A failed move degrades to bound=false honestly
                // (the tools block degrades, never the turn).
                mcpBound := false
                if dir, ok := s.ocServeChatDir(m, sess.ID); ok {
                        mcpBound = true
                        if cur, known := m.SessionDirectory(persisted); !known || cur != dir {
                                if err := m.MoveSession(persisted, dir); err != nil {
                                        mcpBound = false
                                        log.Printf("ocserve: adoption re-home failed for serve session %s (%v) — riding unbound", persisted, err)
                                } else {
                                        log.Printf("ocserve: re-homed serve session %s into its per-chat dir (was %q)", persisted, cur)
                                }
                        }
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
                // v1.67.1 THE ZOMBIE GUARD: a previous turn still in flight on
                // this serve session (its pump gone engine-side — a restart, a
                // cancel, an off-wire terminal, the old forever-stall) would
                // queue this prompt behind it FOREVER (the serve serializes per
                // session — the user's "the chat throttled and halted… changing
                // models didn't fix it; a new chat works"). Interrupt the orphan
                // first (a no-op on an idle session); a STALE orphan whose
                // interrupt fails is recycled wholesale (delete + fresh birth).
                if inFlight, tailAt := m.SessionInFlight(serveSess); inFlight {
                        age := time.Now().UnixMilli() - tailAt
                        if _, ierr := m.InterruptSession(serveSess); ierr != nil {
                                if age > int64(ocServeStallCeilingDur()/time.Millisecond) {
                                        log.Printf("ocserve: zombie turn on %s (tail %dms old, interrupt failed: %v) — recycling the serve session", serveSess, age, ierr)
                                        s.ocServeForgetSession(sess.ID)
                                        if nSess, _, _, nerr := s.ocServeSessionID(m, sess); nerr == nil {
                                                serveSess = nSess
                                                if err := m.SelectModel(serveSess, modelID); err != nil {
                                                        return fmt.Errorf("serve bridge select model: %w", err)
                                                }
                                        } else {
                                                return fmt.Errorf("serve bridge session: %w", nerr)
                                        }
                                } else {
                                        log.Printf("ocserve: in-flight turn on %s (tail %dms old) — interrupt failed (%v); the prompt queues behind it", serveSess, age, ierr)
                                }
                        } else {
                                log.Printf("ocserve: interrupted an orphaned in-flight turn on %s (tail %dms old) — the prompt runs free", serveSess, age)
                        }
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
                        // v1.64.4 THE WALL WALK: the free-limit wall is PER-MODEL
                        // (the live conviction, v1630's rig: each free model carries
                        // its own small window — a 429 on one says NOTHING about the
                        // roster; the user's law verbatim: "We are not rate limited,
                        // if you hit rate limits it's a false positive"). The walk
                        // REPLACES the old session-recycle for this class: SAME serve
                        // session (the model's context survives — no opening-text
                        // recap), the NEXT free (cost-0) opencode-zen model from the
                        // LIVE catalog, one honest notice, ONE retry. A second wall
                        // (the roster exhausted) answers the honest terminal — the
                        // windows reset on OpenCode's own clock. The walk is
                        // PER-TURN: the chat's own model choice never silently
                        // changes (the chip stays true; the notice tells the story).
                        if attempt == 0 {
                                if next := ocNextFreeModel(m, modelID); next != "" {
                                        out <- map[string]any{"type": "notice", "session_id": sessionID,
                                                "message": "OpenCode: " + strings.TrimPrefix(modelID, "opencode/") + "'s free window is full — this turn rides " + next + " (the free windows reset on OpenCode's clock)"}
                                        modelID = next
                                        log.Printf("ocserve: the wall walk — %s is walled, %s takes the turn (chat %s)", strings.TrimPrefix(sess.Model, "opencode/"), next, sessionID)
                                        continue
                                }
                        }
                        // the second wall (or no roster to walk): the honest terminal
                        // (never a silent hang). v1.67.3 THE LOUD 429: the wall now
                        // ARMS THE RETRY SENTINEL — the windows reset on OpenCode's
                        // own clock, the bridge-health probe + the auto-continue ARE
                        // the window test (a still-closed window re-parks with the
                        // attempts preserved — the sentinel's own law), and the pill
                        // below the error is the visual the user asked for ("nothing
                        // to tell me that the chat joined a listener"). The progress
                        // line names the arm so the wait is never unexplained.
                        out <- map[string]any{"type": "progress", "session_id": sessionID,
                                "message": "OpenCode: the free windows are full — the auto-retry timer is armed (it probes and resumes the conversation the moment a window opens)"}
                        walled := map[string]any{"type": "error", "session_id": sessionID,
                                "error": "oc_free_walled", "message": "OpenCode's free-tier windows are all full right now (the limit is per-model and resets on OpenCode's own clock) — try again in a little while, or switch provider (NVIDIA / PrivateMode have working free models)",
                                "retry_class": "429", "retry_provider": "opencode"}
                        out <- walled
                        out <- map[string]any{"type": "status", "session_id": sessionID, "state": "error", "usage": nil}
                        return nil
                }
                return err
        }
        return nil
}

// ocNextFreeModel answers the next cost-0 opencode-zen model from the
// serve's LIVE catalogue (v1.64.4 THE WALL WALK) — the first free model
// that is not the walled one, in the catalogue's own order. "" = the
// roster holds no alternative (the honest terminal answers).
func ocNextFreeModel(m *ocserve.Manager, walled string) string {
        walled = strings.TrimPrefix(walled, "opencode/")
        if i := strings.IndexByte(walled, '#'); i >= 0 {
                walled = walled[:i] // the variant suffix never rides the comparison
        }
        for _, sm := range m.LiveCatalog() {
                if sm.ProviderID != "opencode" || sm.ID == walled {
                        continue
                }
                if len(sm.Cost) == 0 || sm.Cost[0].Input != 0 || sm.Cost[0].Output != 0 {
                        continue
                }
                if !sm.Capabilities.Tools {
                        continue
                }
                return sm.ID
        }
        return ""
}

// ocServeSilenceProbe is how long the pump stays quiet before polling the
// session's own durable record (the volatile-stream no-hang guard — a test
// may shorten it; DOOMALAY_OC_SILENCE_PROBE_MS overrides for the rigs).
var ocServeSilenceProbe = 12 * time.Second

func init() {
        if v := envInt("DOOMALAY_OC_SILENCE_PROBE_MS"); v > 0 {
                ocServeSilenceProbe = time.Duration(v) * time.Millisecond
        }
}

// ocServeStallCeiling — v1.67.1 THE INTERRUPT HAND: how long a turn may
// stay ABSOLUTELY silent (no live frames AND no durable-record mutation —
// neither the feed nor the transcript moved) before it is convicted a
// zombie: a tool that will never return (the complex multi-pipe command
// parked on stdin, a wedged termux exec) parks the pump in the "still
// working… Ns" loop FOREVER — the user's "loaded indefinitely… the chat
// throttled and halted" report. At the ceiling the engine interrupts the
// turn serve-side (POST /api/session/{id}/interrupt — the researched v2
// abort), closes every pending pill honestly, and answers the terminal so
// the chat's lock releases. The engine's own termux runner carries a
// 30-min budget for LEGITIMATE long tools — the serve's tools stream
// progress frames while they work (the bash tool emits output chunks), so
// a genuinely-alive tool keeps bumping lastEvAt and never nears the
// ceiling; absolute silence is the zombie's signature. Env-rigged
// (DOOMALAY_OC_STALL_CEILING_MS); 0 disables (the old forever-wait).
var ocServeStallCeiling = 5 * time.Minute

func ocServeStallCeilingDur() time.Duration {
        if v := envInt("DOOMALAY_OC_STALL_CEILING_MS"); v > 0 {
                return time.Duration(v) * time.Millisecond
        }
        return ocServeStallCeiling
}

// ocBareServeToolName — v1.64.1 THE NATIVE SHELF: the direct arm
// (codemode:false) names every doomalay MCP tool doomalay_<name>; the
// pill grammar speaks the BARE name (calculator | 17*23) so the pills
// render byte-identically to native ones (the OOP reuse law — the PWA's
// own toolPillLabelParts table keys on the bare names). The serve's own
// tools (read/grep/shell/…) pass through untouched; no opencode native
// name collides with the stripped set (websearch/webfetch are the
// serve's spellings, web_search/web_fetch are ours).
func ocBareServeToolName(name string) string {
        if strings.HasPrefix(name, "doomalay_") {
                return strings.TrimPrefix(name, "doomalay_")
        }
        return name
}

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
//
// v1.64.1 THE NATIVE SHELF: tool names ride the pump BARE (ocBareServeToolName
// strips the doomalay_ prefix — every pill reads like a native one).
func (s *Server) ocServePump(ctx context.Context, m *ocserve.Manager, serveSess, sessionID, model string, out chan<- map[string]any, turnStartedAt int64) (bool, error) {
        toolNames := map[string]string{} // tool call id → tool name (input.started) — the BARE name (v1.63.1)
        usedEmitted := map[string]bool{}  // the pill law: use BEFORE result, exactly once
        // v1.67.2 THE UNLOST MID-TURN: the result ledger — every call ID whose
        // tool_result already rode (live OR recovered). The reconcile diff
        // (the probe loop below) reads it; the stall ceiling's honest pill
        // closes read its complement.
        resultsEmitted := map[string]bool{}
        var usage map[string]any
        finish := "stop"
        lastEvAt := time.Now().UnixMilli()
        // v1.67.2: the durable record's last-seen newest-message stamp — the
        // stall ceiling convicts on NEITHER the feed NOR the record moving.
        lastRecordAt := int64(0)
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
                                toolNames[ev.Data.ID] = ocBareServeToolName(ev.Data.Name)
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
                                        toolNames[ev.Data.ID] = ocBareServeToolName(ev.Data.Name)
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
                        resultsEmitted[ev.Data.ID] = true // v1.67.2: the ledger
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
                        resultsEmitted[ev.Data.ID] = true // v1.67.2: the ledger
                        out <- map[string]any{"type": "tool_result", "session_id": sessionID,
                                "name": toolNames[ev.Data.ID], "text": llm.ClampMarked(msg, ocObsBudget(model)),
                                "tool_use_id": ev.Data.ID}
                case "session.step.started":
                        // v1.64.2 THE LIVING WIRE: a new model step is the honest
                        // mid-turn signal — the turn moves (reasoning round, a tool
                        // wave) even when its outputs are quiet. Rides the progress
                        // machinery (ephemeral, never persisted) so the activity
                        // line + the stall clock both move with the truth.
                        out <- map[string]any{"type": "progress", "session_id": sessionID,
                                "message": "OpenCode: " + strings.TrimPrefix(model, "opencode/") + " — a new step started…"}
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
                case "session.execution.interrupted":
                        // v1.67.1 THE INTERRUPT HAND: the serve's own interrupted
                        // terminal (our stall ceiling's interrupt, a stop, an
                        // inactivity/superseded kill) — an honest failure, never a
                        // silent end. The pending pills close honestly first.
                        ocClosePendingPills(sessionID, model, toolNames, usedEmitted, resultsEmitted, out,
                                "the turn was interrupted on the serve (a stop or a stall conviction)")
                        for _, e := range ocServeFailEvents(sessionID, "interrupted", "the turn was interrupted on the serve (a stop, a shutdown, or the stall ceiling's conviction)", 0) {
                                out <- e
                        }
                }
                return nil
        }
        // v1.59.2: the stream rides its own goroutine; the silence watchdog
        // polls the durable record and owns the off-wire terminal (THE
        // NO-HANG GUARD — see the function comment).
        // v1.67.1 THE INTERRUPT HAND + v1.67.2 THE UNLOST MID-TURN: the
        // probe tick now also (a) RECONCILES the durable record against the
        // live emission — a tool result the volatile feed lost in a
        // reconnect gap re-emits from the transcript so its pill closes
        // honestly (the "bot continued on past the spinning pill" death),
        // and (b) convicts a turn ABSOLUTELY silent past the stall ceiling —
        // the interrupt POST kills the zombie, every pending pill closes
        // honestly, the terminal lands, the chat's lock releases.
        pctx, pcancel := context.WithCancel(ctx)
        defer pcancel()
        eventsDone := make(chan error, 1)
        go func() { eventsDone <- m.StreamEvents(pctx, serveSess, pump) }()
        probe := time.NewTicker(ocServeSilenceProbe)
        defer probe.Stop()
        ceilingMS := int64(ocServeStallCeilingDur() / time.Millisecond)
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
                        // v1.67.2 THE MID-TURN RECONCILE — ONE transcript read
                        // serves THREE laws (the record's own truth): the tool
                        // states (missed results re-emit so their pills close),
                        // the newest stamp (a mutation between ticks is LIFE),
                        // and the ended check (the newest idle marker ≥ the
                        // turn's start → SessionIdleSince owns the verdict).
                        msgs, merr := m.ListSessionMessages(serveSess, 1)
                        endedFromRecord := false
                        if merr != nil || len(msgs) == 0 {
                                msgs = nil // unreadable — the idle probe below still runs
                        } else {
                                newest := msgs[len(msgs)-1]
                                // the ended check FIRST (a settled turn is never
                                // "record activity" — the marker's arrival ends
                                // the wait, it does not extend it)
                                if newest.Type == "idle" && newest.Time.Created >= turnStartedAt {
                                        endedFromRecord = true
                                        msgs = nil // the turn is over — nothing to reconcile
                                }
                        }
                        // v1.67.1 THE STALL CEILING — the record-activity
                        // tracker: the FIRST observation is the BASELINE (no
                        // refresh — the pre-pump messages are not life); a
                        // CHANGED stamp between ticks is life (a message
                        // landed serve-side without a live frame).
                        if len(msgs) > 0 && !endedFromRecord {
                                newest := msgs[len(msgs)-1]
                                newestAt := newest.Time.Created
                                if newest.Time.Completed > newestAt {
                                        newestAt = newest.Time.Completed
                                }
                                if lastRecordAt == 0 {
                                        lastRecordAt = newestAt // the baseline
                                } else if newestAt > lastRecordAt {
                                        lastRecordAt = newestAt
                                        lastEvAt = time.Now().UnixMilli() // the record moved — still alive
                                        msgs = nil                             // nothing stale to reconcile
                                }
                        }
                        // the missed-result diff: any tool call the transcript
                        // holds COMPLETE/ERROR whose result never rode (live)
                        // re-emits NOW — the pill closes in place (the PWA
                        // merges by tool_use_id), the transcript never lies.
                        if len(msgs) > 0 {
                                for mi := len(msgs) - 1; mi >= 0; mi-- {
                                        if msgs[mi].Type == "idle" {
                                                msgs = msgs[mi+1:] // this turn's window only
                                                break
                                        }
                                }
                                for _, msg := range msgs {
                                        for _, part := range msg.Content {
                                                if part.Type != "tool" || part.ID == "" {
                                                        continue
                                                }
                                                if part.State == nil || (part.State.Status != "completed" && part.State.Status != "error") {
                                                        continue // still running serve-side
                                                }
                                                callID := part.ID
                                                if resultsEmitted[callID] {
                                                        continue // already rode (live or a prior pass)
                                                }
                                                name := toolNames[callID]
                                                args := ""
                                                if name == "" {
                                                        name = ocBareServeToolName(part.Name)
                                                        toolNames[callID] = name
                                                }
                                                if part.State != nil && len(part.State.Input) > 0 {
                                                        args = string(part.State.Input)
                                                }
                                                if !usedEmitted[callID] {
                                                        // the use itself was lost in the gap — the
                                                        // pill is born whole right before its result
                                                        if args == "" {
                                                                args = "{}"
                                                        }
                                                        out <- map[string]any{"type": "tool_use", "session_id": sessionID,
                                                                "name": name, "summary": ocToolSummary(name, args), "args": args,
                                                                "tool_use_id": callID}
                                                        usedEmitted[callID] = true
                                                }
                                                txt := ""
                                                for _, c := range part.State.Content {
                                                        txt += c.Text
                                                        if txt != "" {
                                                                txt += "\n"
                                                        }
                                                }
                                                truncated := false
                                                if part.State.Metadata != nil && part.State.Metadata.Truncated != nil {
                                                        truncated = *part.State.Metadata.Truncated
                                                }
                                                if part.State.Status == "error" {
                                                        if part.State.Error != nil && part.State.Error.Message != "" {
                                                                txt = part.State.Error.Message
                                                        } else if txt == "" {
                                                                txt = "the tool failed on the serve"
                                                        }
                                                }
                                                res := llm.ClampMarked(txt, ocObsBudget(model))
                                                res = ocResultText(res, truncated)
                                                resultsEmitted[callID] = true
                                                lastEvAt = time.Now().UnixMilli() // the record IS activity
                                                out <- map[string]any{"type": "tool_result", "session_id": sessionID,
                                                        "name": name, "text": res,
                                                        "tool_use_id": callID}
                                        }
                                }
                        }
                        // v1.67.1 THE STALL CEILING: neither the feed nor the
                        // record moved since the last tick — absolute silence
                        // past the ceiling is the zombie's signature.
                        if ceilingMS > 0 && time.Now().UnixMilli()-lastEvAt >= ceilingMS {
                                elapsedMin := int(time.Since(time.UnixMilli(turnStartedAt)).Minutes())
                                // THE CONVICTION: interrupt the zombie turn serve-side,
                                // close every pending pill honestly, answer the terminal.
                                interrupted := false
                                if v, err := m.InterruptSession(serveSess); err != nil {
                                        log.Printf("ocserve: stall ceiling (%dms) — interrupt failed on %s (%v); the terminal answers anyway", ceilingMS, serveSess, err)
                                } else {
                                        interrupted = v
                                        log.Printf("ocserve: stall ceiling (%dms) — turn on %s interrupted=%v (a tool never returned; the chat's lock releases)", ceilingMS, serveSess, v)
                                }
                                pcancel()
                                <-eventsDone // the cancelled stream returns shortly
                                ocClosePendingPills(sessionID, model, toolNames, usedEmitted, resultsEmitted, out,
                                        fmt.Sprintf("the command never returned within %d minute(s) — the turn was cancelled", elapsedMin))
                                msg := fmt.Sprintf("OpenCode: the turn stalled — no output for %d minute(s) (a tool that never returned). The turn was %s. Try again, or continue the conversation", elapsedMin, map[bool]string{true: "interrupted on the serve", false: "cancelled engine-side"}[interrupted])
                                for _, e := range ocServeFailEvents(sessionID, "oc_stalled", msg, 0) {
                                        out <- e
                                }
                                return false, nil
                        }
                        // v1.67.2: the record's own ended check is the cheap
                        // authority — SessionIdleSince (its ?limit=2 read) runs
                        // ONLY for the verdict extraction (the error shape +
                        // the answer text) once the marker is seen, or when the
                        // record read failed. A quiet ALIVE tick costs exactly
                        // ONE transcript read.
                        ended, failed, errType, errMsg, ansText := endedFromRecord, false, "", "", ""
                        if endedFromRecord || merr != nil {
                                ended, failed, errType, errMsg, ansText = m.SessionIdleSince(serveSess, turnStartedAt)
                        }
                        if !ended {
                                // v1.64.2 THE LIVING WIRE — THE HONEST WAIT: the turn is
                                // alive but quiet (a long reasoning phase, a slow tool) —
                                // SAY SO every probe tick instead of letting the pill sit
                                // static for minutes (the user's "no visual feedback of
                                // accurate things going on to explain the wait"). Ephemeral
                                // progress, never persisted; the elapsed count is the
                                // durable record's own truth (the turn's start stamp).
                                // v1.67.1: the ping names the PENDING tool + the ceiling —
                                // the wait is never "uninsightful".
                                elapsed := int(time.Since(time.UnixMilli(turnStartedAt)).Seconds())
                                if elapsed < 0 {
                                        elapsed = 0
                                }
                                waitingOn := ""
                                for callID, done := range resultsEmitted {
                                        if done || !usedEmitted[callID] {
                                                continue
                                        }
                                        if n := toolNames[callID]; n != "" {
                                                waitingOn = n
                                                break
                                        }
                                }
                                ping := fmt.Sprintf("OpenCode: %s is still working… %ds in this turn", strings.TrimPrefix(model, "opencode/"), elapsed)
                                if waitingOn != "" {
                                        ping = fmt.Sprintf("OpenCode: %s still running… %ds in this turn", waitingOn, elapsed)
                                        if ceilingMS > 0 {
                                                ping += fmt.Sprintf(" — auto-cancels at %d min", int(ceilingMS/60000))
                                        }
                                }
                                out <- map[string]any{"type": "progress", "session_id": sessionID,
                                        "message": ping}
                                continue
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

// ocClosePendingPills — v1.67.1 THE INTERRUPT HAND: every tool use whose
// result never rode (the zombie turn's orphaned pills) closes HONESTLY —
// a synthetic tool_result with the why, merged into its own pill by the
// PWA's tool_use_id law. The transcript never shows a pill spinning
// forever, not even on replay (the row persists like any result).
func ocClosePendingPills(sessionID, model string, toolNames map[string]string, usedEmitted, resultsEmitted map[string]bool, out chan<- map[string]any, why string) {
        for callID, used := range usedEmitted {
                if !used || resultsEmitted[callID] || callID == "" {
                        continue
                }
                name := toolNames[callID]
                if name == "" {
                        name = "tool"
                }
                resultsEmitted[callID] = true
                out <- map[string]any{"type": "tool_result", "session_id": sessionID,
                        "name": name, "text": llm.ClampMarked(why, ocObsBudget(model)),
                        "tool_use_id": callID}
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
        // v1.67.1/2: the engine's own verdict kinds ride through (the stall
        // conviction + the serve's interrupted outcome — the PWA + the
        // transcript name what actually happened, not the generic bridge
        // error).
        if errType == "oc_stalled" || errType == "interrupted" {
                kind = errType
        }
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
        // v1.67.3 THE LOUD 429: the arm rides with a PROGRESS LINE FIRST —
        // the opencode 429's long wait is never "uninsightful" (the user's
        // report): the wait names the auto-retry timer before the error +
        // the sentinel's pill land below it.
        var events []map[string]any
        if retryClass != "" {
                events = append(events, map[string]any{"type": "progress", "session_id": sessionID,
                        "message": "OpenCode: rate-limited — the auto-retry timer is armed (it probes every few minutes and resumes the conversation the moment the limit clears)"})
        }
        events = append(events,
                errEv,
                map[string]any{"type": "status", "session_id": sessionID, "state": "error", "usage": nil})
        return events
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
