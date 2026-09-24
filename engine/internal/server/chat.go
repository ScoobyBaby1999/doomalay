package server

import (
        "context"
        "encoding/json"
        "fmt"
        "log"
        "net/http"
        "strconv"
        "strings"
        "sync"
        "time"

        "github.com/gorilla/websocket"

        "github.com/ScoobyBaby1999/doomalay/engine/internal/brain"
        "github.com/ScoobyBaby1999/doomalay/engine/internal/hfzero"
        "github.com/ScoobyBaby1999/doomalay/engine/internal/llm"
        "github.com/ScoobyBaby1999/doomalay/engine/internal/store"
)

// chat.go implements the WebSocket chat endpoint — the heart of the V0 bug-fix.
//
// FLOW:
//  1. PWA opens WS /api/chat?session_id=<id>
//  2. Engine subscribes — replays existing chat_events (since=0) so the PWA
//     reconstructs state on reconnect (idempotent: dedup by seq client-side).
//  3. PWA sends a JSON message: {"type":"send","message":"...","model":...}
//  4. Engine acquires the per-session _turn_lock (non-blocking; rejects if busy).
//     V0 FIX: the lock is released in `defer` — never gets stuck.
//  5. Engine calls brain.Chat() with the message + session config.
//  6. As the brain streams SSE events back, the engine:
//       a. Appends each event to chat_events (V0 FIX: backend-writes-events-
//          as-it-emits — not the frontend at turn-end).
//       b. Forwards each event to the PWA over the WS.
//  7. On the brain's terminal event (status:idle / error), the engine releases
//     the lock.
//
// The PWA's streamWorker parses each WS frame and updates the per-session
// Zustand slice (sessions.ts) — only the changed session re-renders.

// newUpgrader returns a websocket.Upgrader with the origin check bound to
// this server's config (allowed origins).
func (s *Server) newUpgrader() websocket.Upgrader {
        return websocket.Upgrader{
                // SECURITY: check the Origin header on every WS upgrade. A malicious
                // website could otherwise open a WS to localhost:8080 and read your chat
                // events (or send messages on your behalf).
                CheckOrigin: func(r *http.Request) bool {
                        origin := r.Header.Get("Origin")
                        if origin == "" {
                                return true // non-browser client (curl) — allowed
                        }
                        // Same-origin (PWA served from the engine itself).
                        host := r.Host
                        if strings.HasPrefix(origin, "http://"+host) || strings.HasPrefix(origin, "https://"+host) {
                                return true
                        }
                        // localhost origins (dev server).
                        for _, prefix := range []string{"http://localhost", "http://127.0.0.1", "https://localhost", "https://127.0.0.1"} {
                                if strings.HasPrefix(origin, prefix) {
                                        return true
                                }
                        }
                        // Configured allowed origins.
                        for _, allowed := range s.cfg.AllowedOrigins {
                                if origin == allowed {
                                        return true
                                }
                        }
                        log.Printf("blocked WS upgrade from origin: %s", origin)
                        return false
                },
        }
}

// sessionLocks guards one-in-flight-turn per session (the V0 stuck-busy fix).
var (
        sessionLocksMu sync.Mutex
        sessionLocks   = make(map[string]chan struct{})
)

// ── v0.39 P8-FULL: the per-session live pipe ────────────────────────────
//
// A turn's events flow persist-first into the event log and THEN to the
// live WebSocket. Before v0.39 the turn captured the *websocket.Conn of
// the socket that SENT the message — a disconnect mid-turn (tunnel hiccup,
// Android doze, tab reload) cancelled the turn server-side AND a
// reconnecting client only got the connect-time replay while live frames
// kept going to the dead socket. The pipe decouples them:
//
//   - ALL frame writes serialize through the pipe mutex (turn + pings +
//     replay — no interleaved frames).
//   - swap(ws) installs a NEW connection (a resume takes over the live
//     feed; the previous socket is closed under it).
//   - clear(ws, gen) removes a dead connection ONLY if it is still the
//     current generation — a late read-error from a replaced socket can
//     never clobber the fresh one.
//   - writes to a dead/absent pipe are ERRORS, not turn-killers: the event
//     log keeps filling; the next swap resumes live delivery mid-stream.
type chatPipe struct {
        mu  sync.Mutex
        ws  *websocket.Conn
        gen int64
}

var (
        chatPipesMu sync.Mutex
        chatPipes   = map[string]*chatPipe{}
)

func pipeFor(sessionID string) *chatPipe {
        chatPipesMu.Lock()
        defer chatPipesMu.Unlock()
        p := chatPipes[sessionID]
        if p == nil {
                p = &chatPipe{}
                chatPipes[sessionID] = p
        }
        return p
}

// send writes one text frame (nil pipe / dead socket → error, never panic).
func (p *chatPipe) send(b []byte) error {
        if p == nil {
                return fmt.Errorf("pipe: no connection")
        }
        p.mu.Lock()
        defer p.mu.Unlock()
        if p.ws == nil {
                return fmt.Errorf("pipe: connection gone")
        }
        return p.ws.WriteMessage(websocket.TextMessage, b)
}

// sendControl writes a ping/pong control frame through the same lock.
func (p *chatPipe) sendControl(t int, b []byte) error {
        if p == nil {
                return fmt.Errorf("pipe: no connection")
        }
        p.mu.Lock()
        defer p.mu.Unlock()
        if p.ws == nil {
                return fmt.Errorf("pipe: connection gone")
        }
        return p.ws.WriteMessage(t, b)
}

// swap installs ws as the live connection and returns its generation.
// The previous socket (if any) is closed — its read loop exits, its
// handler returns, and the new socket owns the live feed.
func (p *chatPipe) swap(ws *websocket.Conn) int64 {
        p.mu.Lock()
        old := p.ws
        p.ws = ws
        p.gen++
        gen := p.gen
        p.mu.Unlock()
        if old != nil && old != ws {
                old.Close()
        }
        return gen
}

// clear removes ws if it is still the CURRENT one (generation match).
func (p *chatPipe) clear(ws *websocket.Conn, gen int64) {
        if p == nil {
                return
        }
        p.mu.Lock()
        defer p.mu.Unlock()
        if p.ws == ws && p.gen == gen {
                p.ws = nil
        }
}

// alive reports whether a live connection is installed.
func (p *chatPipe) alive() bool {
        if p == nil {
                return false
        }
        p.mu.Lock()
        defer p.mu.Unlock()
        return p.ws != nil
}

// wsPingEvery / wsReadDeadline: the server pings every 20s; a client that
// fails to pong (browsers auto-pong) for ~75s is treated as gone — the read
// deadline fires and the pipe clears. Half-dead sockets (tunnels, doze)
// used to linger forever because writes only fail when the OS buffer fills.
const (
        wsPingEvery    = 20 * time.Second
        wsReadDeadline = 75 * time.Second
)

// pingLoop keeps the connection honest for the life of the WS handler.
func pingLoop(ctx context.Context, pipe *chatPipe) {
        t := time.NewTicker(wsPingEvery)
        defer t.Stop()
        for {
                select {
                case <-ctx.Done():
                        return
                case <-t.C:
                        if err := pipe.sendControl(websocket.PingMessage, nil); err != nil {
                                return
                        }
                }
        }
}

// artifactSystemPrompt (v0.17) teaches the model the app's artifact
// protocol: fenced blocks tagged with a filename become downloadable
// files in the chat's artifact drawer (text formats open in an editor).
// base64 blocks let it emit true binaries (docx, zip, …) download-only.
// NOTE: double-quoted string — the protocol's fence marks can't live
// inside a Go raw (backtick) string.
const artifactSystemPrompt = "You are chatting inside the Doomalay app, which has an artifact system.\n" +
        "When the user asks for a file, document, dataset, or any standalone deliverable — or when you produce a substantial complete artifact-like output (e.g. a full markdown document, JSON dataset, CSV table, or a complete code file) — attach it as an ARTIFACT in addition to (or instead of) your normal answer.\n\n" +
        "Artifact format (a fenced code block whose info string starts with \"artifact\"):\n" +
        "  ```artifact file=<filename.ext>\n" +
        "  <the complete file content as plain text>\n" +
        "  ```\n" +
        "For binary file types (e.g. .docx, .xlsx, .pdf, .zip, images) provide the bytes base64-encoded instead:\n" +
        "  ```artifact file=<filename> encoding=base64\n" +
        "  <base64 payload>\n" +
        "  ```\n\n" +
        "Rules:\n" +
        "- Prefer text formats when the user has no strong preference (.md, .txt, .json, .csv, .html, code files, config files).\n" +
        "- Use a real, descriptive filename with the correct extension (report.md, data.json, notes.txt, script.py…).\n" +
        "- The artifact block must contain the COMPLETE file, never truncated with placeholders.\n" +
        "- Keep the spoken answer short and mention the attached file name.\n" +
        "- Regular markdown (headings, lists, bold, links, normal fenced code blocks) is rendered nicely — use it freely in your normal answers too."

// lockSession acquires the per-session turn lock. Returns a release function
// and false if already locked (busy).
func lockSession(id string) (release func(), ok bool) {
        sessionLocksMu.Lock()
        ch, exists := sessionLocks[id]
        if !exists {
                ch = make(chan struct{}, 1)
                sessionLocks[id] = ch
        }
        sessionLocksMu.Unlock()
        select {
        case ch <- struct{}{}:
                return func() { <-ch }, true
        default:
                return nil, false
        }
}

// turnAbort registers an in-flight turn's cancel per session, so a
// client "stop" aborts ONLY that turn — not the shared read-loop context
// (v0.19: the old code called cancel() on the loop's ctx, which poisoned
// every future turn on the same socket — "the new model doesn't reply").
// Each registration wraps the cancel in a unique struct so release can
// identify exactly ITS handle (funcs aren't comparable in Go).
type turnCancel struct{ cancel context.CancelFunc }

var (
        turnMu      sync.Mutex
        turnCancels = map[string][]*turnCancel{}
)

func abortTurn(sessionID string) {
        turnMu.Lock()
        cancels := turnCancels[sessionID]
        delete(turnCancels, sessionID)
        turnMu.Unlock()
        for _, c := range cancels {
                c.cancel()
        }
}

func registerTurnCancel(sessionID string, cancel context.CancelFunc) *turnCancel {
        tc := &turnCancel{cancel: cancel}
        turnMu.Lock()
        turnCancels[sessionID] = append(turnCancels[sessionID], tc)
        turnMu.Unlock()
        return tc
}

func releaseTurnCancel(sessionID string, tc *turnCancel) {
        if tc == nil {
                return
        }
        turnMu.Lock()
        list := turnCancels[sessionID]
        for i, f := range list {
                if f == tc {
                        turnCancels[sessionID] = append(list[:i], list[i+1:]...)
                        break
                }
        }
        if len(turnCancels[sessionID]) == 0 {
                delete(turnCancels, sessionID)
        }
        turnMu.Unlock()
}

// defaultPersonaQuick (v0.20→v0.48) — the QUICK-CHAT default persona: OUR
// default prompt (the artifact protocol) MERGED with the old HF space's
// system prompt style ("Be direct and concise; lead with outcomes", the
// explicit model-identity instruction, tool-use discipline). {model} and
// {provider} placeholders are substituted at composition time so the
// persona always knows exactly which model it currently is — and stays
// correct after mid-conversation model switches.
const defaultPersonaQuick = "## Identity\n" +
        "You are {model} (served via {provider}), chatting inside the Doomalay app on the user's own device. " +
        "Your name in this app is {name}. " +
        "If the user asks which model you are, tell them exactly that — never guess and never claim to be a different model. " +
        "This identity updates automatically when the user switches your model mid-conversation; trust it over any prior assumption.\n\n" +
        "## Style\n" +
        "Be direct and concise; lead with the outcome, not the process. " +
        "Use markdown freely — headings, lists, bold, links and fenced code blocks all render nicely in this app. " +
        "When a live fact matters and web search is enabled, search rather than guess. " +
        "When you don't know something, say so.\n\n" +
        "## Tools\n" +
        "When the app's tool protocol is active, invoke tools ONLY through the protocol's ACTION line format — never as plain text. " +
        "Cite search sources inline as [1], [2] matching the result numbering, and never fabricate URLs.\n\n" +
        artifactSystemPrompt

// defaultPersonaHF (v0.48 task 6) — the HF-chat default persona: the same
// style, but the assistant KNOWS it lives in a Hugging Face Space Linux
// sandbox with the full toolchain, can install packages, manages its own
// Space via the HF API, has a per-chat (ephemeral) workspace, and sleeps/
// wakes. {repo} is substituted by defaultPersonaFor (own-space repo name
// or the shared marker).
const defaultPersonaHF = "## Identity\n" +
        "You are {model} (served via {provider}), the Doomalay assistant running INSIDE a Hugging Face Space — a real Linux sandbox in the cloud, not on the user's phone. " +
        "Your name in this app is {name}. " +
        "If the user asks which model you are, tell them exactly that — never guess and never claim to be a different model. " +
        "This identity updates automatically when the user switches your model mid-conversation; trust it over any prior assumption.\n\n" +
        "## Environment — you are on Hugging Face{repo}\n" +
        "You have a REAL Linux sandbox with ROOT access and the full build toolchain: bash, python, git, Node 20, gcc/g++/make/cmake preinstalled. " +
        "You can install packages and libraries on demand (pip / npm / apt-get) — Go, Rust and Java too (apt openjdk, or download the toolchain). " +
        "You can write, compile AND run real code (C/C++, Go, Rust, Java, Node, Python), and manage this very Space through the HF API — edit your own files, manage secrets, read logs, restart. " +
        "Your workspace is per-chat and installs are ephemeral: after a sleep/restart, reinstall what you need (prefer fast paths: pip/npm, apt, cached tarballs in the workspace). " +
        "Tell the user to download anything they want to keep. The Space sleeps after inactivity; the first message after a nap can take a minute while it wakes.\n\n" +
        "## Style\n" +
        "Be direct and concise; lead with the outcome, not the process. " +
        "Use markdown freely — headings, lists, bold, links and fenced code blocks all render nicely in this app. " +
        "When a live fact matters and web search is enabled, search rather than guess. " +
        "When you don't know something, say so. " +
        "Prefer DOING over describing: when the user asks for something the sandbox can answer, actually run it and show the real output.\n\n" +
        "## Tools\n" +
        "When the app's tool protocol is active, invoke tools ONLY through the protocol's ACTION line format — never as plain text. " +
        "Chain tools freely — plan, run, read results, then run the next — including parallel commands when they are independent. " +
        "Cite search sources inline as [1], [2] matching the result numbering, and never fabricate URLs.\n\n" +
        artifactSystemPrompt

// defaultPersonaFor (v0.48 task 6) picks the mode-aware default: HF chats
// get an assistant that knows it lives in a Hugging Face Space with the
// full toolchain; quick chats get the classic app persona.
func defaultPersonaFor(sess *store.Session) string {
        if sess != nil && sess.Sandbox == "hf" {
                p := defaultPersonaHF
                if repo := strings.TrimSpace(sess.SandboxRepo); repo != "" {
                        p = strings.ReplaceAll(p, "{repo}", " (your Space: "+repo+")")
                } else {
                        p = strings.ReplaceAll(p, "{repo}", " (the shared sandbox)")
                }
                return p
        }
        return defaultPersonaQuick
}

// prettyModelName turns a model slot ("nvidia/nvidia/nemotron-…",
// "privatemodeai/kimi-k2.6", "openai/gpt-4o") into the name the model
// should know itself by (the last path segment). Mirrors the old HF
// space's model_display logic (chat_session.py).
func prettyModelName(slot string) string {
        s := strings.TrimSpace(slot)
        if s == "" {
                return ""
        }
        // strip an explicit provider/org prefix chain — the LAST segment
        // is the model's own name.
        if i := strings.LastIndex(s, "/"); i >= 0 {
                s = s[i+1:]
        }
        return s
}

// substitutePersonaVars replaces {model} / {provider} in a persona text
// with the live values so a saved persona stays correct across model
// switches (user spec v0.20: "use {model} in the persona to tell it the
// model and {provider} for the provider").
func substitutePersonaVars(text, model, provider string) string {
        if !strings.Contains(text, "{model}") && !strings.Contains(text, "{provider}") {
                return text
        }
        m := prettyModelName(model)
        if m == "" {
                m = "an AI assistant"
        }
        p := providerLabel(provider)
        r := strings.NewReplacer("{model}", m, "{provider}", p)
        return r.Replace(text)
}

// providerLabel maps a provider key to its catalog display label
// (privatemodeai → "PrivateMode AI", nvidia → "NVIDIA", …). Falls back
// to the raw key.
func providerLabel(provider string) string {
        p := strings.TrimSpace(provider)
        if p == "" {
                return "an unknown provider"
        }
        if cat, err := llm.LoadCatalog(); err == nil {
                if cfg, ok := cat[p]; ok && cfg.Label != "" {
                        return cfg.Label
                }
        }
        return p
}

// systemPromptFor composes the per-turn system message (v0.19 personas,
// v0.20 identity + placeholders, v0.26 MULTI-persona resolution):
//
//      [identity line — ALWAYS fresh: the CURRENT model + provider + date,
//       so a mid-conversation model switch instantly changes who the bot
//       thinks it is]
//      + [the ACTIVE persona — trigger-satisfied > shuffle-pick >
//         always-active; legacy single persona + the app default as
//         fallbacks]
//      + [the artifact protocol, unless the persona already carries it]
//
// {name} {model} {provider} {skills} + the chat's custom {key} placeholders
// inside the persona are substituted with the live values every turn.
func (s *Server) systemPromptFor(sess *store.Session) string {
        return s.systemPromptForMetrics(sess, personaMetrics{})
}

func (s *Server) systemPromptForMetrics(sess *store.Session, m personaMetrics) string {
        var b strings.Builder
        b.WriteString("You are ")
        if m := prettyModelName(sess.Model); m != "" {
                b.WriteString(m)
        } else {
                b.WriteString("an AI assistant")
        }
        if p := strings.TrimSpace(sess.Provider); p != "" {
                b.WriteString(", hosted via " + providerLabel(p))
        }
        if sess.Sandbox == "hf" {
                // v0.48 task 6: HF chats run the brain inside a Space, not
                // on the device — the identity line must say so.
                b.WriteString(", chatting inside the Doomalay app from your Hugging Face Space. ")
        } else {
                b.WriteString(", chatting inside the Doomalay app on the user's own device. ")
        }
        b.WriteString("Today is " + time.Now().Format("Monday, 2 January 2006") + ".")

        ph := s.mergedPlaceholders(sess) // v0.29: global customs + this chat's local customs
        if spec := s.resolveActivePersonaMerged(parsePersonas(sess), sess, m); spec != nil {
                persona := strings.TrimSpace(spec.Text)
                if persona == "" {
                        persona = defaultPersonaFor(sess)
                }
                b.WriteString("\n\n" + substituteAllVars(persona, sess.Title, sess.Model, sess.Provider, ph))
                if !strings.Contains(strings.ToLower(persona), "artifact") {
                        // Keep the file-save capability alive under custom personas.
                        b.WriteString("\n\n" + artifactSystemPrompt)
                }
                return b.String()
        }
        persona := strings.TrimSpace(sess.Persona)
        if persona == "" {
                // No custom persona → the mode-aware default (v0.48 task 6:
                // quick vs HF — the HF default knows it lives in a Space
                // with the full toolchain).
                b.WriteString("\n\n" + substituteAllVars(defaultPersonaFor(sess), sess.Title, sess.Model, sess.Provider, ph))
                return b.String()
        }
        b.WriteString("\n\n" + substituteAllVars(persona, sess.Title, sess.Model, sess.Provider, ph))
        if !strings.Contains(strings.ToLower(persona), "artifact") {
                // Keep the file-save capability alive under custom personas.
                b.WriteString("\n\n" + artifactSystemPrompt)
        }
        return b.String()
}

// handleChatWS is GET /api/chat?session_id=<id>[&since=<lastSeq>] — the
// WebSocket chat endpoint.
//
// v0.39 RESUME HANDSHAKE: a client that still holds its in-memory chat
// state reconnects with &since=<lastSeq it has> and gets ONLY the events
// after that seq (incremental replay) followed by the LIVE feed — a
// mid-turn disconnect (tunnel hiccup, tab sleep, page reload) no longer
// kills the in-flight turn server-side: the turn keeps running against
// the event log, and the resumed socket picks the stream back up.
// since=0 / absent → full replay (fresh open).
func (s *Server) handleChatWS(w http.ResponseWriter, r *http.Request) {
        sessionID := r.URL.Query().Get("session_id")
        if sessionID == "" {
                writeError(w, 400, "session_id is required")
                return
        }
        // Verify the session exists.
        sess, err := s.db.GetSession(sessionID)
        if err != nil {
                writeError(w, 500, "get session: "+err.Error())
                return
        }
        if sess == nil {
                writeError(w, 404, "session not found")
                return
        }

        upgrader := s.newUpgrader()
        conn, err := upgrader.Upgrade(w, r, nil)
        if err != nil {
                log.Printf("ws upgrade: %v", err)
                return
        }
        defer conn.Close()

        // v0.39 KEEPALIVE: pings every 20s + a 75s pong-guarded read
        // deadline — half-dead sockets surface as read errors instead of
        // lingering until the next write happens to fail.
        _ = conn.SetReadDeadline(time.Now().Add(wsReadDeadline))
        conn.SetPongHandler(func(string) error {
                return conn.SetReadDeadline(time.Now().Add(wsReadDeadline))
        })

        // v0.39: take over the session's live pipe — a previous socket (if
        // any) is closed under us; live events flow to THIS connection now.
        pipe := pipeFor(sessionID)
        gen := pipe.swap(conn)

        // Replay events so a reconnecting PWA catches up. Idempotency: the
        // PWA dedups by ev.i; with &since=N only events with seq > N ship.
        since := 1 // full replay default
        if v := r.URL.Query().Get("since"); v != "" {
                if n, perr := strconv.Atoi(v); perr == nil && n > 0 {
                        since = n + 1 // client has ≤ N; replay from N+1
                }
        }
        existing, err := s.db.ListEvents(sessionID, since)
        if err != nil {
                log.Printf("list events: %v", err)
        } else {
                for _, ev := range existing {
                        b, _ := ev.ToJSON()
                        if err := pipe.send(b); err != nil {
                                pipe.clear(conn, gen)
                                return // socket died mid-replay
                        }
                }
        }

        // Pings live for exactly as long as THIS handler.
        pingCtx, pingCancel := context.WithCancel(context.Background())
        defer pingCancel()
        go pingLoop(pingCtx, pipe)

        // Read loop: handle PWA messages (send / stop).
        // v0.39: the loop's context is NOT the turn's lifetime — a
        // disconnect clears the pipe but leaves in-flight turns running
        // (they persist into the event log; a resume picks them up).
        for {
                _, raw, err := conn.ReadMessage()
                if err != nil {
                        pipe.clear(conn, gen) // only if still current
                        return                // PWA disconnected
                }
                var msg map[string]any
                if err := json.Unmarshal(raw, &msg); err != nil {
                        continue
                }
                msgType, _ := msg["type"].(string)
                switch msgType {
                case "send":
                        go s.handleTurn(pipe, sessionID, sess, msg)
                case "stop":
                        // v0.19: abort ONLY the in-flight turn(s) for this session.
                        // The old cancel() killed the shared read-loop ctx — after ONE
                        // stop, every later send on this socket ran with an already-
                        // canceled context and died silently (no reply from any model).
                        abortTurn(sessionID)
                case "hide":
                        // v0.37: the client edited/deleted/regenerated messages —
                        // append a 'hide' event naming the masked event ids. The
                        // append-only log keeps everything (audit trail), but
                        // buildHistory + the frontend replay skip the hidden ids
                        // so the LLM context and the transcript agree.
                        var ids []int64
                        if raw, ok := msg["ids"].([]any); ok {
                                for _, v := range raw {
                                        if f, ok := v.(float64); ok {
                                                ids = append(ids, int64(f))
                                        }
                                }
                        }
                        if len(ids) > 0 {
                                b, _ := json.Marshal(ids)
                                s.emit(pipe, sessionID, "hide", string(b), "")
                        }
                }
        }
}

// handleTurn runs one chat turn: acquire lock → call brain → persist + forward events → release lock.
// v0.39: the turn is NOT tied to the sending socket's lifetime — it derives
// from context.Background() + the turn budget. The Stop button (abortTurn)
// and the budget remain the only cancellation paths; a WS drop just clears
// the pipe while the turn keeps persisting (a resumed client picks it up).
func (s *Server) handleTurn(pipe *chatPipe, sessionID string, sess *store.Session, msg map[string]any) {
        // v0.15 (crash fix): this runs in its own goroutine — a panic here
        // would take the whole engine down (dead app, white screen). The
        // recoverMiddleware can't see goroutine panics, so guard locally.
        defer func() {
                if rec := recover(); rec != nil {
                        log.Printf("PANIC recovered in turn %s: %v", sessionID, rec)
                        s.emit(pipe, sessionID, "error", fmtError("panic", "internal error — engine recovered", "", ""), "")
                        s.emit(pipe, sessionID, "status", `{"state":"error","usage":null}`, "")
                }
        }()

        // v0.15 — THE UNIVERSAL-401 FIX: the session snapshot passed in was
        // fetched ONCE at WS-connect time and went stale the moment the user
        // changed provider/model from the UI (the PATCH updates the DB, not
        // this struct). Every later turn then chatted through the OLD
        // provider — with the OLD key — producing 401s for "every" provider
        // while the UI showed the new one. Re-fetch per turn.
        if fresh, err := s.db.GetSession(sessionID); err == nil && fresh != nil {
                sess = fresh
        }

        // Persist the user's message immediately (V0 FIX: backend writes
        // events). s.emit persists AND forwards — no separate AppendEvent
        // (v0.13 fix: the direct AppendEvent + emit double-persisted every
        // user message, doubling them in reconstructed history).
        userText, _ := msg["message"].(string)

        // v0 FIX: per-session turn lock, non-blocking acquire, release in defer.
        release, ok := lockSession(sessionID)
        if !ok {
                // v0.44 INTERRUPT FIX (the orphaned optimistic bubble): a busy
                // reject used to persist ONLY the error — never the user message,
                // never a terminal status. The PWA's optimistic bubble never got
                // its engine echo (its dedupe had nothing to stamp), and a reload
                // made the sent message VANISH while the session waited on a
                // terminal that never existed. Persist the message FIRST (the
                // same emit the normal path does), then the error, then a
                // TERMINAL status error — a reload now shows the message + the
                // failure, and the client unblocks on the terminal.
                s.emit(pipe, sessionID, "user", userText, "")
                s.emit(pipe, sessionID, "error", `{"error":"busy","message":"agent already processing"}`, "")
                s.emit(pipe, sessionID, "status", `{"state":"error","usage":null}`, "")
                return
        }
        defer release()

        s.emit(pipe, sessionID, "user", userText, "")

        // v0.15: per-message model/provider overrides ride the send (the
        // frontend sends them on every message now — belt AND suspenders
        // against any staleness). They win over the (fresh) session values.
        if v, ok := msg["provider"].(string); ok && v != "" {
                sess.Provider = v
        }
        if v, ok := msg["model"].(string); ok && v != "" {
                sess.Model = v
        }
        // v0.44 AUTO RESOLUTION: a session can carry the "<provider>/auto"
        // pseudo-model (the brain's /models shape + the connect flow's
        // auto-pick). The brain CRASHED on it (IndexError on the empty
        // provider catalog) and providers 404 on a literal "auto" — resolve
        // it to the provider's best concrete model from the live v2 catalog
        // before the request leaves the engine. The direct path resolves
        // the same way inside llm.ResolveModel.
        if s.vault != nil {
                if r := llm.ResolveAutoModel(sess.Model, sess.Provider, s.vault.AsEnv()); r != "" && r != sess.Model {
                        log.Printf("resolved auto model %q -> %q (session %s)", sess.Model, r, sessionID)
                        sess.Model = r
                }
        }

        // Build the brain request.
        brainReq := map[string]any{
                "session_id":    sessionID,
                "message":       userText,
                "model":         sess.Model,
                "provider":      sess.Provider,
                "effort":        sess.Effort,
                "mode":          sess.Mode,
                "web_search":    sess.WebSearch || true, // v0.45 ITEM 2: default-on (pill removed)
                "deep_research": sess.DeepResearch,
                // v0.52 THE 3 PILLS: the auto-search toggles ride the brain
                // turn (the brain gates dtemplate/skills + the system-prompt
                // lines on them).
                "template_auto": sess.TemplateAuto,
                "skills_auto":   sess.SkillsAuto,
                // v0.19: persona system — the per-turn system message is
                // identity + the chat's persona (or the default prompt).
                "system_prompt": s.systemPromptFor(sess),
        }
        if v, ok := msg["model"].(string); ok && v != "" {
                brainReq["model"] = v // allow per-message override
        }
        // v0.13: per-message capability overrides (the chat toolbar) —
        // message flags win over the session defaults.
        if v, ok := msg["effort"].(string); ok && v != "" {
                brainReq["effort"] = v
                sess.Effort = v
        }
        if v, ok := msg["web_search"].(bool); ok {
                brainReq["web_search"] = v
                sess.WebSearch = v
        }
        if v, ok := msg["deep_research"].(bool); ok {
                brainReq["deep_research"] = v
                sess.DeepResearch = v
        }
        // v0.44 TEMPLATE PILL: the composer's active method template rides
        // every send (the frontend resolves the brief from the library —
        // template_id for labeling, template_brief is the methodology text
        // the turn pipelines inject). Per-message, like the flags above;
        // the sheet's own PATCH persists the selection for reload.
        tplID, _ := msg["template_id"].(string)
        tplBrief, _ := msg["template_brief"].(string)
        if strings.TrimSpace(tplBrief) != "" {
                brainReq["template_id"] = tplID
                brainReq["template_brief"] = tplBrief
                // BRAIN path: prepend the METHOD TEMPLATE block to the
                // turn's system prompt (the brain's agent uses it verbatim
                // when provided). The DIRECT path gets the same block via
                // llm.ChatRequest.TemplateBrief. Same shape both paths:
                //   METHOD TEMPLATE — <id>\nFollow this template's
                //   methodology for this task:\n<brief>
                if sp, ok := brainReq["system_prompt"].(string); ok && sp != "" {
                        label := tplID
                        if strings.TrimSpace(label) == "" {
                                label = "custom"
                        }
                        brainReq["system_prompt"] = "METHOD TEMPLATE — " + label +
                                "\nFollow this template's methodology for this task:\n" +
                                strings.TrimSpace(tplBrief) + "\n\n" + sp
                }
        }
        // Persist capability changes so the next turn / reload keeps them.
        // v0.15: also persist per-message model/provider overrides (they
        // ARE the session's new config — the UI already PATCHed them, this
        // is just the safety net).
        if _, ok := msg["effort"]; ok {
                if err := s.db.UpdateSession(sess); err != nil {
                        log.Printf("persist session caps: %v", err)
                }
        } else if _, ok := msg["model"]; ok {
                if err := s.db.UpdateSession(sess); err != nil {
                        log.Printf("persist session model: %v", err)
                }
        }

        // v0.38 BRAIN HISTORY: brain turns used to run with NO conversation
        // memory — brainReq never carried a "history" key, so the fresh
        // per-turn Strands agent saw only the current message (every brain
        // turn was amnesiac). Build it exactly like the direct proxy does
        // (event log → folded turns, the session's sliding window); the
        // brain appends the new user message itself.
        {
                hist := s.buildHistoryCompacted(sessionID, sess, sess.SlidingWindow)
                if sess.SlidingWindow == 0 {
                        hist = s.buildHistoryCompacted(sessionID, sess, 40)
                }
                brainHistory := make([]map[string]any, 0, len(hist))
                for _, m := range hist {
                        brainHistory = append(brainHistory, map[string]any{"role": m.Role, "content": m.Content})
                }
                brainReq["history"] = brainHistory
        }

        // v0.44 WORKSPACES: the chat's bound cloud repos ride the turn so
        // the brain's workspace/explore tools can act on them (ids only —
        // tokens stay in the engine vault; the tools call back via REST).
        // v0.46: device-storage rows are PWA-only (the engine can't reach
        // the PWA's FileSystemHandle) — they never ride the turn.
        {
                bound, err := s.db.ListSessionWorkspaces(sessionID)
                if err == nil && len(bound) > 0 {
                        rows := make([]map[string]any, 0, len(bound))
                        for _, ws := range bound {
                                if ws.Kind == "device" {
                                        continue
                                }
                                branches := []string{}
                                if m := ws.MetaJSON(); m != nil {
                                        if bs, ok := m["branches"].([]any); ok {
                                                for _, b := range bs {
                                                        if s, ok := b.(string); ok {
                                                                branches = append(branches, s)
                                                        }
                                                }
                                        }
                                }
                                row := map[string]any{
                                        "id": ws.ID, "name": ws.Name, "kind": ws.Kind,
                                        "host": ws.Host, "owner": ws.Owner, "repo": ws.Repo,
                                        "url": ws.RepoURL, "branch": ws.Branch,
                                        "access": ws.Access, "sandbox_path": ws.SandboxPath,
                                }
                                if len(branches) > 0 {
                                        row["branches"] = branches
                                }
                                rows = append(rows, row)
                        }
                        if len(rows) > 0 {
                                brainReq["workspaces"] = rows
                        }
                }
        }

        // Stream from the brain, OR the direct LLM proxy if brain is down.
        // v0.16: the streaming client has no wall-clock cap (reasoning models
        // think for minutes) — this per-turn timeout is the backstop that
        // guarantees the turn lock is always released.
        // v0.24: MODEL-AWARE — observed live, nvidia kimi-k3 needs >10 min for a
        // tool-demonstration turn (2.5-min thinking gaps per round × many
        // rounds): the flat 10-min cap killed those turns mid-chain ("its
        // response interrupted mid action", user report). Reasoning models get
        // 20 min; the Stop button cancels instantly (a WS drop does NOT —
        // v0.39: the turn survives its socket and a resume picks it up).
        turnBudget := 10 * time.Minute
        if llm.IsSlowReasoningModel(sess.Model) {
                turnBudget = 20 * time.Minute
        }
        // v0.39: Background (NOT the WS request ctx) — the turn survives its
        // socket. Stop (abortTurn) + this budget are the only cancellers.
        turnCtx, turnCancel := context.WithTimeout(context.Background(), turnBudget)
        tcHandle := registerTurnCancel(sessionID, turnCancel)
        terminal := false // did the stream end with a status idle/error?
        defer func() {
                releaseTurnCancel(sessionID, tcHandle)
                turnCancel()
                // v0.19: GUARANTEED TERMINAL STATUS — the UI unblocks (Send
                // button, isStreaming) only on a status idle/error event. A
                // Stop or an edge-case stream end could leave none arriving,
                // freezing the chat forever after. Emit one if the stream
                // forgot.
                if !terminal {
                        s.emit(pipe, sessionID, "status", `{"state":"idle","usage":null}`, "")
                }
        }()
        // v0.46 THE HF CHAT: sandbox=hf sessions route through the user's HF
        // Space sandbox (own or shared) — the full remote brain (real bash/
        // python/git/npm toolchain). Falls back to the direct pipeline with a
        // visible progress note when the space is unreachable/unconfigured.
        if rb := s.remoteBrainFor(sess); rb != nil {
                s.streamFromRemoteBrain(turnCtx, pipe, sessionID, sess, brainReq, userText, &terminal, rb)
        } else if sess.Sandbox == "hf" {
                if b, jerr := json.Marshal(map[string]any{
                        "type": "progress", "session_id": sessionID,
                        "message": "HF sandbox not configured (connect Hugging Face in the Hub panel, or pick a space via Sandbox → Hugging Face) — running this turn on the direct pipeline",
                }); jerr == nil {
                        _ = pipe.send(b)
                }
                s.streamFromDirectProxy(turnCtx, pipe, sessionID, sess, userText, tplID, tplBrief, &terminal)
        } else if s.brain != nil && s.brain.Healthy() {
                s.streamFromBrain(turnCtx, pipe, sessionID, sess, brainReq, userText, &terminal)
        } else {
                s.streamFromDirectProxy(turnCtx, pipe, sessionID, sess, userText, tplID, tplBrief, &terminal)
        }
}

// remoteBrainFor resolves the RemoteBrain for an HF-chat session (v0.46).
//   - sandbox_mode "own" + SandboxRepo → per-repo client (token from the
//     vault: HF_SPACE_<OWNER>_<NAME>, minted at create time)
//   - sandbox_mode "shared" (or repo empty) → the shared community space,
//     auth = the user's own HF token (needs an HF connection)
//
// Returns nil when the session isn't HF-routed or can't be (no token, no
// repo) — the caller falls back with an explanatory progress event.
func (s *Server) remoteBrainFor(sess *store.Session) *brain.RemoteBrain {
        if sess == nil || sess.Sandbox != "hf" {
                return nil
        }
        env := map[string]string{}
        if s.vault != nil {
                env = s.vault.AsEnv()
        }
        mode := sess.SandboxMode
        if mode == "" {
                // Legacy/edge: sandbox=hf without a mode. Own-repo if we have a
                // token for the session's repo, else shared.
                mode = "shared"
                if sess.SandboxRepo != "" {
                        if tk, _, err := s.vault.Get(spaceTokenEnvVar(sess.SandboxRepo)); err == nil && tk != "" {
                                mode = "own"
                        }
                }
        }
        if mode == "own" {
                repo := sess.SandboxRepo
                if repo == "" {
                        return nil
                }
                s.remoteMu.RLock()
                rb := s.remotes[repo]
                s.remoteMu.RUnlock()
                if rb != nil {
                        rb.SetEnv(env)
                        return rb
                }
                tk, _, err := s.vault.Get(spaceTokenEnvVar(repo))
                if err != nil || tk == "" {
                        return nil
                }
                url := hfzero.SpaceURL(repo)
                if url == "" {
                        return nil
                }
                rb = brain.NewRemoteBrain(repo, url, tk, env)
                s.remoteMu.Lock()
                s.remotes[repo] = rb
                s.remoteMu.Unlock()
                return rb
        }
        // shared
        s.remoteMu.RLock()
        rb := s.sharedBrain
        s.remoteMu.RUnlock()
        if rb != nil {
                rb.SetEnv(env)
                return rb
        }
        if s.hfToken() == "" {
                return nil // shared needs the user's HF token — not connected
        }
        url := sharedSpaceBaseURL()
        if url == "" {
                return nil
        }
        rb = brain.NewSharedRemoteBrain(sharedSpaceRepo, url, s.hfToken, env)
        s.remoteMu.Lock()
        s.sharedBrain = rb
        s.remoteMu.Unlock()
        return rb
}

// streamFromRemoteBrain routes one turn through an HF Space sandbox (v0.46
// — THE HF CHAT). Same event stream as the local brain path; on failure it
// degrades to the direct pipeline with a visible explanation (the quick-chat
// guarantee: the message still gets answered).
func (s *Server) streamFromRemoteBrain(ctx context.Context, pipe *chatPipe, sessionID string, sess *store.Session, brainReq map[string]any, userText string, terminal *bool, rb *brain.RemoteBrain) {
        // The remote sandbox scopes workspaces itself (sanitized session_id →
        // /data|/tmp/doomalay-workspaces/<id>) — never send device paths.
        delete(brainReq, "workspace")
        delete(brainReq, "workspaces")

        // First turn on this space (or it slept — HF gc's after 48h idle):
        // wake it with a patient probe so the user sees WHY it's slow.
        if !rb.Healthy() {
                if b, jerr := json.Marshal(map[string]any{
                        "type": "progress", "session_id": sessionID,
                        "message": "waking the HF sandbox (up to a minute if it slept)…",
                }); jerr == nil {
                        _ = pipe.send(b)
                }
                rb.ProbeTimeout(75 * time.Second)
        }

        events, errs, err := rb.Chat(ctx, brainReq)
        if err != nil {
                rb.MarkUnhealthy()
                if b, jerr := json.Marshal(map[string]any{
                        "type": "progress", "session_id": sessionID,
                        "message": "HF sandbox unreachable (" + err.Error() + ") — running this turn on the engine's direct pipeline",
                }); jerr == nil {
                        _ = pipe.send(b)
                }
                tplID, _ := brainReq["template_id"].(string)
                tplBrief, _ := brainReq["template_brief"].(string)
                s.streamFromDirectProxy(ctx, pipe, sessionID, sess, userText, tplID, tplBrief, terminal)
                return
        }
        s.forwardEvents(ctx, pipe, sessionID, sess, userText, events, errs, terminal)
}

// streamFromBrain proxies the chat turn through the Python brain (full
// agent: Strands, tools, panel, templates). Used when the brain is available.
func (s *Server) streamFromBrain(ctx context.Context, pipe *chatPipe, sessionID string, sess *store.Session, brainReq map[string]any, userText string, terminal *bool) {
        events, errs, err := s.brain.Chat(ctx, brainReq)
        if err != nil {
                // v0.44.1 BRAIN FAILOVER (W5 redteam fix): the brain died mid-run
                // (its healthy flag never went false once true) and every later
                // turn failed with "connection refused" while the engine's own
                // direct pipeline sat ready. Now: mark the brain dead (a quiet
                // 15s re-probe revives it), tell the user, and run THIS turn on
                // the direct path — the message still gets answered.
                s.brain.MarkUnhealthy()
                if b, err := json.Marshal(map[string]any{"type": "progress", "session_id": sessionID, "message": "brain unreachable — running this turn on the engine's direct pipeline"}); err == nil {
                        _ = pipe.send(b)
                }
                tplID, _ := brainReq["template_id"].(string)
                tplBrief, _ := brainReq["template_brief"].(string)
                s.streamFromDirectProxy(ctx, pipe, sessionID, sess, userText, tplID, tplBrief, terminal)
                return
        }
        s.forwardEvents(ctx, pipe, sessionID, sess, userText, events, errs, terminal)
}

// streamFromDirectProxy calls the cloud LLM directly from Go (no Python brain
// needed). Used when the brain is unavailable (e.g. the Android APK). Cloud
// chat only — no local tools, no panel, no templates. But the streaming,
// persistence, and V0 fixes are identical.
//
// v0.13: builds conversation HISTORY from the event log (multi-turn now
// works on the APK), and forwards capabilities (effort / web_search /
// deep_research) into the llm.Chat pipeline.
// v0.44: tplID/tplBrief carry the composer's active method template (the
// template pill) into llm.ChatRequest; s.brain's URL arms the
// template_list/template_show ACTION tools (nil brain = they degrade).
func (s *Server) streamFromDirectProxy(ctx context.Context, pipe *chatPipe, sessionID string, sess *store.Session, userText, tplID, tplBrief string, terminal *bool) {
        if s.vault == nil {
                s.emit(pipe, sessionID, "error", `{"error":"no_vault","message":"secrets vault not initialized"}`, "")
                s.emit(pipe, sessionID, "status", `{"state":"error","usage":null}`, "")
                return
        }
        keys := s.vault.AsEnv()
        model := sess.Model
        provider := sess.Provider
        if model == "" || provider == "" {
                s.emit(pipe, sessionID, "error", `{"error":"no_model","message":"no model selected for this chat"}`, "")
                s.emit(pipe, sessionID, "status", `{"state":"error","usage":null}`, "")
                return
        }

        llmModel, baseURL, _, apiKey, authStyle, err := llm.ResolveModel(model, provider, keys)
        if err != nil {
                s.emit(pipe, sessionID, "error", fmtError("model_resolve", err.Error(), provider, model), "")
                s.emit(pipe, sessionID, "status", `{"state":"error","usage":null}`, "")
                return
        }

        // v0.13: conversation history — walk the event log, fold consecutive
        // assistant_delta fragments into single assistant messages, keep
        // the last ~40 turns (sliding window, same default as the brain).
        // v0.16: the sliding memory window is per-session (the 'memory' pill in
        // the chat header dropdown cycles it). Default 40 (the brain's old default).
        // v0.21 AUTO-COMPACT (ported from the HF space's proactive compression):
        // summarize older turns when the context nears the model's window.
        sess = s.maybeCompact(ctx, pipe, sess, keys, llmModel, baseURL, apiKey, authStyle)

        history := s.buildHistoryCompacted(sessionID, sess, sess.SlidingWindow)
        if sess.SlidingWindow == 0 {
                // 0 = the legacy default (40); -1 = the WHOLE chat (v0.28 user
                // spec — the mind slider's minimum, no window at all).
                history = s.buildHistoryCompacted(sessionID, sess, 40)
        }
        history = append(history, llm.Message{Role: "user", Content: userText})

        // v0.17→v0.19: the system message = identity + persona (or the
        // default prompt) + the artifact protocol — composed fresh each
        // turn so model switches change the identity instantly.
        // v0.26: live metrics feed the trigger personas (messages/turns).
        pm := personaMetrics{Messages: len(history), Turns: countUserTurns(history) + 1}
        full := make([]llm.Message, 0, len(history)+1)
        full = append(full, llm.Message{Role: "system", Content: s.systemPromptForMetrics(sess, pm)})
        full = append(full, history...)

        req := llm.ChatRequest{
                Model:        llmModel,
                Provider:     provider,
                Messages:     full,
                Effort:       sess.Effort,
                WebSearch:    sess.WebSearch || true, // v0.45 ITEM 2: default-on (pill removed)
                DeepResearch: sess.DeepResearch,
                TavilyKey:    keys["TAVILY_API_KEY"],
                APIKey:       apiKey,
                BaseURL:      baseURL,
                AuthStyle:    authStyle,
                // v0.21: the swarm fanout delegate (models consult other models).
                DelegateFn: func(ctx context.Context, prompt string, models []string) []map[string]any {
                        return s.RunDelegate(ctx, prompt, models, keys)
                },
                // v0.22: file tools (docx/xlsx/zip) save into this session's
                // artifact drawer — the UI gets a download card per tool_result.
                ArtifactSink: &sessionArtifactSink{s: s, sessID: sessionID},
                // v0.28: persona tools — the bot's self-management hands
                // (persona_list/persona_set/persona_activate/placeholder_set),
                // executed against THIS session by the server's tool runner.
                PersonaToolFn: func(ctx context.Context, name, argJSON string) string {
                        return s.runPersonaTool(sessionID, name, argJSON)
                },
                // v0.44: the active method template (the template pill) —
                // the turn pipelines prepend the brief as a METHOD TEMPLATE
                // system block.
                TemplateID:    tplID,
                TemplateBrief: tplBrief,
                // v0.52 THE 3 PILLS: the per-chat auto-search toggles —
                // TemplateAuto gates the template ACTION tools on the
                // direct path (off = the tools are not offered, so the
                // model cannot burn turns browsing a library the user
                // disabled). SkillsAuto rides for the brain path (direct
                // chats have no skills tooling).
                TemplateAuto: sess.TemplateAuto,
                SkillsAuto:   sess.SkillsAuto,
        }
        // v0.44 SELF-ENABLE: the template ACTION tools need the brain URL
        // ("" on the APK → they degrade honestly). The brain may be
        // unhealthy on this path (that's WHY we're direct-proxying) — the
        // tools' 10s fetch then reports the honest unavailable observation.
        if s.brain != nil {
                req.BrainURL = s.brain.URL()
        }
        chunks, errs := llm.Chat(ctx, req)

        // Convert ChatChunk → map[string]any (the format forwardEvents expects).
        // v0.15: error events carry provider + model so a future UI/engine
        // desync is instantly diagnosable ("401 via opencode/claude-fable-5"
        // instead of a bare 401).
        events := make(chan map[string]any, 64)
        var assistantParts []string // v0.22: resettable (assistant_reset clears a leaked preamble)
        go func() {
                defer close(events)
                for chunk := range chunks {
                        ev := map[string]any{
                                "type":       chunk.Type,
                                "session_id": sessionID,
                        }
                        if chunk.Text != "" {
                                ev["text"] = chunk.Text
                        }
                        if chunk.State != "" {
                                ev["state"] = chunk.State
                        }
                        if chunk.Usage != nil {
                                ev["usage"] = map[string]any{
                                        "input_tokens":  chunk.Usage.InputTokens,
                                        "output_tokens": chunk.Usage.OutputTokens,
                                        "total_tokens":  chunk.Usage.TotalTokens,
                                }
                        }
                        if chunk.Error != "" {
                                ev["error"] = chunk.Error
                                ev["message"] = chunk.Message
                                ev["provider"] = provider
                                ev["model"] = llmModel
                                // v0.40 MODEL-GONE ONE-TAP RECOVERY: when the
                                // failure is the deprecation class (404 not-
                                // found-for-account / 410 end-of-life — the
                                // chronic NIM behavior) and the v0.38 alternate
                                // routing had nowhere to rotate, attach the top
                                // closest available replacements so the frontend
                                // renders one-tap "Switch to X" chips instead of
                                // a dead-end "pick another model".
                                if llm.ModelGoneMessage(chunk.Message) || llm.ModelGoneMessage(chunk.Error) {
                                        if sug := llm.SuggestReplacements(llmModel, provider, keys, 3); len(sug) > 0 {
                                                ev["suggest"] = sug
                                        }
                                }
                        }
                        if chunk.Name != "" {
                                ev["name"] = chunk.Name
                                ev["summary"] = chunk.Summary
                        }
                        // v0.22: file-tool results carry the saved artifact for the UI card
                        if chunk.Artifact != nil {
                                if name, ok := chunk.Artifact["name"].(string); ok && name != "" {
                                        if m, err := s.findArtifactByName(sessionID, name); err == nil {
                                                ev["artifact"] = map[string]any{
                                                        "id": m.ID, "name": m.Name, "size": m.Size,
                                                        "url": "/api/sessions/" + sessionID + "/artifacts/" + m.ID + "/download",
                                                }
                                        }
                                }
                        }
                        // v0.19: status running events may carry a human
                        // message ("round 2 · searching …") — pass it through
                        // so the frontend renders a live progress pill.
                        if chunk.Type == "status" && chunk.Message != "" {
                                ev["message"] = chunk.Message
                        }
                        if chunk.Sources != nil {
                                srcs := make([]map[string]any, 0, len(chunk.Sources))
                                for _, sr := range chunk.Sources {
                                        srcs = append(srcs, map[string]any{
                                                "title": sr.Title, "url": sr.URL, "snippet": sr.Snippet,
                                        })
                                }
                                ev["sources"] = srcs
                        }
                        if chunk.Type == "assistant_delta" && chunk.Text != "" {
                                assistantParts = append(assistantParts, chunk.Text)
                        }
                        if chunk.Type == "assistant_reset" {
                                // v0.22: a very long preamble leaked as if it were the final
                                // answer, then turned out to be a tool call — the llm loop emits
                                // this so the UI wipes it before the tool pill renders.
                                assistantParts = nil
                        }
                        events <- ev
                }
                // v0.19: BLOCKING drain — errs is always closed by the
                // llm.Chat producer (right after ch), so this returns as
                // soon as the chunks end. The old non-blocking
                // select/default RACED the producer and silently dropped
                // provider errors: the turn ended with NO error and NO
                // terminal status — the UI stayed stuck on "Stop" and the
                // chat looked dead ("the new model doesn't seem to reply").
                if e := <-errs; e != nil {
                        events <- map[string]any{"type": "error", "error": "llm", "message": e.Error()}
                }
                // v0.13: persist the full assistant reply as ONE event so
                // history reconstruction on later turns is exact.
                if len(assistantParts) > 0 {
                        events <- map[string]any{"type": "assistant", "text": strings.Join(assistantParts, "")}
                }
        }()

        // errs is consumed inside the goroutine above; hand forwardEvents a
        // pre-closed dummy so its trailing read doesn't block.
        dummyErrs := make(chan error, 1)
        close(dummyErrs)
        s.forwardEvents(ctx, pipe, sessionID, sess, userText, events, dummyErrs, terminal)
}

// buildHistory reconstructs the conversation from the event log: "user" and
// "assistant" events in seq order (assistant events carry the full reply —
// v0.13 emits one at turn end). Falls back to folding consecutive
// assistant_delta fragments for sessions created before v0.13. Windowed to
// the last N messages.
func (s *Server) buildHistory(sessionID string, window int) []llm.Message {
        events, err := s.db.ListEvents(sessionID, 0)
        if err != nil {
                return nil
        }
        // v0.37: 'hide' events name event ids the client masked (edit / delete /
        // regenerate). Deletes always come AFTER their targets, so one pass
        // collects the full hidden set before the history walk below.
        hidden := map[int64]bool{}
        for _, ev := range events {
                if ev.EventType != "hide" || ev.Content == "" {
                        continue
                }
                var ids []int64
                if json.Unmarshal([]byte(ev.Content), &ids) == nil {
                        for _, id := range ids {
                                hidden[id] = true
                        }
                }
        }
        var msgs []llm.Message
        for _, ev := range events {
                if hidden[ev.ID] {
                        continue
                }
                switch ev.EventType {
                case "user":
                        msgs = append(msgs, llm.Message{Role: "user", Content: ev.Content})
                case "assistant":
                        msgs = append(msgs, llm.Message{Role: "assistant", Content: ev.Content})
                case "assistant_delta":
                        // Pre-v0.13 sessions: fold consecutive deltas into one message.
                        last := len(msgs) - 1
                        if last >= 0 && msgs[last].Role == "assistant" && !msgs[last].FoldedDone {
                                msgs[last].Content += ev.Content
                        } else {
                                msgs = append(msgs, llm.Message{Role: "assistant", Content: ev.Content, FoldedDone: true})
                        }
                }
        }
        if len(msgs) > window {
                msgs = msgs[len(msgs)-window:]
        }
        return msgs
}

// forwardEvents is the shared event-handling loop for both brain and direct
// proxy paths. It persists each event to chat_events (V0 fix) + forwards to
// the PWA via WebSocket + handles auto-naming.
func (s *Server) forwardEvents(ctx context.Context, pipe *chatPipe, sessionID string, sess *store.Session, userText string, events <-chan map[string]any, errs <-chan error, terminal *bool) {
        // v0.22 FREEZE FIX: reasoning models emit thinking ONE WORD per SSE
        // chunk — a single kimi/glm turn produced 12k+ SQLite writes + 12k
        // WS frames (observed live: a 4-minute file-gen turn logged 12,150
        // thinking rows; the replay fetch hauled all of them back). Coalesce:
        // buffer thinking text and flush to the log + WS at most ~2×/second
        // or every 400 chars; every other event type flushes first (order
        // preserved) and the final flush lands at turn end. The client's
        // thinking-box render is identical — just fewer, bigger chunks.
        var thinkBuf strings.Builder
        lastThinkFlush := time.Now()
        flushThinking := func(force bool) {
                if thinkBuf.Len() == 0 {
                        return
                }
                if !force && thinkBuf.Len() < 400 && time.Since(lastThinkFlush) < 500*time.Millisecond {
                        return
                }
                persisted, err := s.db.AppendEvent(sessionID, "thinking", thinkBuf.String(), "")
                if err != nil {
                        log.Printf("persist thinking: %v", err)
                } else {
                        out := map[string]any{
                                "i": persisted.ID, "ts": persisted.CreatedAt, "type": "thinking",
                                "session_id": sessionID, "seq": persisted.Seq, "text": thinkBuf.String(),
                        }
                        if b, err := json.Marshal(out); err == nil {
                                _ = pipe.send(b) // v0.39: dead pipe ≠ dead turn — persisting continues
                        }
                }
                thinkBuf.Reset()
                lastThinkFlush = time.Now()
        }
        for ev := range events {
                // Normalize the event into the wire format + persist.
                evType, _ := ev["type"].(string)
                // v0.37: a user-initiated Stop (turnCtx CANCELED — the Stop button
                // or a mid-turn model switch) is NOT an error. The llm layer still
                // surfaces the aborted request as error chunks ("context canceled",
                // plus the empty-response retry noise that follows) — skip those so
                // stopping/switching doesn't spray error bubbles into the chat. A
                // DEADLINE (turn budget) keeps its honest errors.
                if evType == "error" && ctx.Err() == context.Canceled {
                        continue
                }
                // v0.23 NO-SILENCE: progress events are EPHEMERAL — forwarded
                // to the live WS only, never persisted, no i/seq (replay never
                // sees them; the indicator is a live-UI concern).
                if evType == "progress" {
                        out := map[string]any{"type": "progress", "session_id": sessionID}
                        if t, ok := ev["text"].(string); ok {
                                out["text"] = t
                        }
                        if m, ok := ev["message"].(string); ok {
                                out["message"] = m
                        }
                        if b, err := json.Marshal(out); err == nil {
                                _ = pipe.send(b)
                        }
                        continue
                }
                if evType == "thinking" {
                        if t, ok := ev["text"].(string); ok {
                                thinkBuf.WriteString(t)
                        }
                        flushThinking(false)
                        continue
                }
                flushThinking(true) // any other event orders AFTER buffered thinking
                // Extract text/content for persistence.
                var content string
                switch evType {
                // v0.52: "hublist" — the bot-side hub cards (dt_hublib): the
                // event's text is the FULL JSON payload ({summary, items}), so
                // replay rebuilds the exact same box the live path rendered
                // (unknown types persist EMPTY content — the box would vanish
                // on reload without this line).
                case "thinking", "assistant_delta", "assistant", "tool_result", "title", "hublist":
                        if t, ok := ev["text"].(string); ok {
                                content = t
                        }
                case "error":
                        // v0.13: error events carry "message" (human text) +
                        // "error" (code) — persist the human-readable one.
                        if t, ok := ev["message"].(string); ok {
                                content = t
                        } else if t, ok := ev["text"].(string); ok {
                                content = t
                        } else if t, ok := ev["error"].(string); ok {
                                content = t
                        }
                case "sources":
                        b, _ := json.Marshal(ev["sources"])
                        content = string(b)
                case "tool_use":
                        name, _ := ev["name"].(string)
                        summary, _ := ev["summary"].(string)
                        content = name
                        if summary != "" {
                                content += " " + summary
                        }
                case "status":
                        // Store the full status object as JSON (state + usage).
                        state, _ := ev["state"].(string)
                        usage := ev["usage"]
                        statusObj := map[string]any{"state": state}
                        if usage != nil {
                                statusObj["usage"] = usage
                        }
                        b, _ := json.Marshal(statusObj)
                        content = string(b)
                }
                toolUseID, _ := ev["tool_use_id"].(string)

                // V0 FIX: persist the event AS IT EMITS (not at turn-end).
                persisted, err := s.db.AppendEvent(sessionID, evType, content, toolUseID)
                if err != nil {
                        log.Printf("persist event: %v", err)
                        continue
                }
                // Forward to PWA with the assigned seq + id.
                out := map[string]any{
                        "i":          persisted.ID,
                        "ts":         persisted.CreatedAt,
                        "type":       evType,
                        "session_id": sessionID,
                }
                for k, v := range ev {
                        if k == "type" {
                                continue
                        }
                        out[k] = v
                }
                out["seq"] = persisted.Seq
                b, _ := json.Marshal(out)
                // v0.39: a dead pipe no longer kills the turn — the event
                // is already persisted; a resumed client will replay it.
                // Keep consuming so the llm goroutine never blocks.
                _ = pipe.send(b)

                // Auto-name on first turn (V0 FIX: flag-after-success).
                if evType == "status" {
                        state, _ := ev["state"].(string)
                        if state == "idle" || state == "error" {
                                if terminal != nil {
                                        *terminal = true
                                }
                        }
                        if state == "idle" {
                                // Try LLM title if not yet set + not manually renamed.
                                if sess.Title == "New Chat" && !sess.ManuallyRenamed {
                                        go s.maybeAutoTitle(sessionID, sess, userText)
                                }
                        }
                }
        }
        flushThinking(true) // turn over — land the tail of the thinking stream
        if err := <-errs; err != nil {
                log.Printf("brain stream error: %v", err)
        }
}

// maybeAutoTitle derives a title from the first user message (immediate,
// synchronous) and tries an LLM title (async, best-effort). V0 FIX: the
// "title generated" flag is set only AFTER a successful title write.
func (s *Server) maybeAutoTitle(sessionID string, sess *store.Session, firstMsg string) {
        // Immediate: truncate the first user message.
        if firstMsg == "" {
                return
        }
        title := firstMsg
        if len(title) > 48 {
                title = title[:48]
        }
        if err := s.db.SetSessionTitle(sessionID, title, true); err == nil {
                // Emit a title event so the PWA updates the sidebar.
                s.emit(nil, sessionID, "title", title, "")
        }
        // TODO: async LLM title via brain (best-effort, 20s timeout, falls back to truncation).
}

// fmtError builds the JSON content for an error emit, including which
// provider/model the engine actually used (v0.15: diagnosability).
func fmtError(code, message, provider, model string) string {
        b, _ := json.Marshal(map[string]string{
                "error":    code,
                "message":  message,
                "provider": provider,
                "model":    model,
        })
        return string(b)
}

// emit sends a JSON event to the live pipe (or persists only when the
// pipe is nil — the boot-time title path).
func (s *Server) emit(pipe *chatPipe, sessionID, evType, content, toolUseID string) {
        persisted, err := s.db.AppendEvent(sessionID, evType, content, toolUseID)
        if err != nil {
                log.Printf("emit persist: %v", err)
                return
        }
        if pipe == nil {
                return
        }
        out := map[string]any{
                "i":          persisted.ID,
                "ts":         persisted.CreatedAt,
                "type":       evType,
                "session_id": sessionID,
                "seq":        persisted.Seq,
        }
        if toolUseID != "" {
                out["tool_use_id"] = toolUseID
        }
        switch evType {
        case "user", "thinking", "assistant_delta", "tool_result", "title":
                out["text"] = content
        case "hide":
                // v0.37: content is a JSON array of masked event ids — the
                // frontend reads ev.ids (it never parses raw text for this).
                var ids []int64
                if json.Unmarshal([]byte(content), &ids) == nil {
                        out["ids"] = ids
                }
        case "error":
                // v0.14: error content is usually a JSON object
                // {"error":"code","message":"human text"} — parse it so the
                // frontend reads ev.message / ev.error (it never read the
                // old "text" field → showed "Unknown error").
                var obj map[string]any
                if json.Unmarshal([]byte(content), &obj) == nil && len(obj) > 0 {
                        for k, v := range obj {
                                out[k] = v
                        }
                } else {
                        out["text"] = content
                        out["message"] = content
                }
        case "tool_use":
                out["name"] = content
        case "status":
                // v0.14: status content is {"state":"idle"|"error","usage":…}
                // — the OLD code shipped the raw JSON string as "state", so
                // the frontend's ev.state === 'idle'/'error' checks never
                // matched → isStreaming stuck true, Send stuck on "Stop"
                // after any error turn.
                var obj map[string]any
                if json.Unmarshal([]byte(content), &obj) == nil && len(obj) > 0 {
                        if st, ok := obj["state"].(string); ok {
                                out["state"] = st
                        } else {
                                out["state"] = content
                        }
                        if u, ok := obj["usage"]; ok {
                                out["usage"] = u
                        }
                } else {
                        out["state"] = content
                }
        }
        b, _ := json.Marshal(out)
        _ = pipe.send(b)
}
