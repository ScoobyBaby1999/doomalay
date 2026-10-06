package server

import (
        "context"
        "encoding/json"
        "fmt"
        "log"
        "net/http"
        "os"
        "sort"
        "strconv"
        "strings"
        "sync"
        "sync/atomic"
        "time"

        "github.com/gorilla/websocket"

        "github.com/ScoobyBaby1999/doomalay/engine/internal/brain"
        "github.com/ScoobyBaby1999/doomalay/engine/internal/hfzero"
        "github.com/ScoobyBaby1999/doomalay/engine/internal/llm"
        "github.com/ScoobyBaby1999/doomalay/engine/internal/secrets"
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

// libraryPreamble (v0.67 THE LIBRARY AWARENESS WAVE — user report:
// "the agent doesn't even know the app has a library"). Mirrors the
// brain's _discipline_lines block (brain/agent.py:1025-1068) — the same
// opportunistic but disciplined tone, adapted for the engine direct-LLM
// path's tool surface (hublib + persona_list + persona_set + skills +
// artifact). Two variants:
//   - sess.LibAuto == true  -> LIB ON:  recommend + use; downloads armed.
//   - sess.LibAuto == false -> LIB OFF: browse + recommend only; loads/
//     downloads refuse until the user flips * tweaks -> Bot Library back on.
//
// In both variants the model is told the library EXISTS (the user's core
// ask: "it should not only know of the library's existence").
func libraryPreamble(sess *store.Session) string {
        if sess != nil && sess.LibAuto {
                return librarySystemPromptOn
        }
        return librarySystemPromptOff
}

// chatMetadataPreamble (v0.68 THE METADATA PERSONAS — user spec: "edit
// all default personas so that the bot knows about everything in its
// chat metadata, just basic information to encapsulate what each pill
// does"). A compact, LIVE-VALUED block describing every control the
// user can flip on THIS chat, appended for every persona (default or
// custom — it's factual context, not persona flavor), so the bot can
// name the exact pill + where to flip it when the user asks. The PM
// client composes the same block client-side (pmMetadataBlock — PM turns
// bypass the engine); keep the two texts in sync.
// v0.82.1: bundleName carries the turn's attached bundle ("" when none)
// — the session doesn't persist the armed bundle, the turn does.
func (s *Server) chatMetadataPreamble(sess *store.Session, bundleName string) string {
        if sess == nil {
                return ""
        }
        libOn := sess.LibAuto || sess.TemplateAuto || sess.SkillsAuto
        if !s.tweaksBotLibOn(sess.ID) {
                libOn = false // the tweaks half of the switch (either off = off)
        }
        dlOn := libOn && s.tweaksBotDLOn(sess.ID)
        var tplName string
        if raw := strings.TrimSpace(sess.TemplateID); raw != "" {
                var tpl struct {
                        Name string `json:"name"`
                }
                if json.Unmarshal([]byte(raw), &tpl) == nil && tpl.Name != "" {
                        tplName = tpl.Name
                } else {
                        tplName = raw
                }
        }
        b := &strings.Builder{}
        b.WriteString("\n\n## This chat's controls (what the user can flip — name the pill + the path when relevant)\n")
        b.WriteString("- effort (toolbar pill, currently \"" + effLabel(sess.Effort) + "\"): how deeply you reason per turn (low / med / high ladder).\n")
        b.WriteString("- web search: ON by default — you search whenever a live fact matters.\n")
        if sess.DeepResearch {
                b.WriteString("- deep research: currently ON — be thorough, multi-source, cross-referenced, cited.\n")
        } else {
                b.WriteString("- deep research: currently OFF (armed via the lib pill's + when a template owns the composer).\n")
        }
        if libOn {
                b.WriteString("- Bot Library (the 🛠 lib toolbar pill + ✦ tweaks → Bot Library): currently ON — you may browse, download and use the app's library on the fly.\n")
        } else {
                b.WriteString("- Bot Library (the 🛠 lib toolbar pill + ✦ tweaks → Bot Library): currently OFF — you can browse + recommend only; downloads/loads refuse until the user flips it back on.\n")
        }
        if dlOn {
                b.WriteString("- Can download bundles (✦ tweaks → Bot Library → Can download bundles): currently ON — you may download new bundles and use them right away.\n")
        } else {
                b.WriteString("- Can download bundles (✦ tweaks → Bot Library → Can download bundles): currently OFF — only bundles already in the user's library (\"Yours\") are usable; new downloads refuse with that switch path.\n")
        }
        if tplName != "" {
                b.WriteString("- active template (the ⧉ chip above the composer): \"" + tplName + "\" — its methodology is armed for every turn of this chat.\n")
        } else {
                b.WriteString("- active template: none armed (the user can apply one from the library's USE button).\n")
        }
        if w := sess.SlidingWindow; w > 0 {
                b.WriteString("- context (the mind pill + ✦ tweaks → mind): the last " + strconv.Itoa(w) + " messages ride each turn (the sliding window).\n")
        } else {
                b.WriteString("- context (the mind pill + ✦ tweaks → mind): the whole chat rides each turn (no sliding window).\n")
        }
        // v0.82.1 THE PILL LEDGER: the model had live truth about every
        // SETTING but zero knowledge of the UI pills that carry them — the
        // user's live repro asked "What does the workspaces pill do?" and
        // the bot answered "I don't have any information about a
        // workspaces pill — it isn't described in my instructions." Every
        // pill the chat's toolbar/header actually renders is now named
        // here with its live state, so pill questions are answered from
        // THIS block, never from guesswork.
        if n := len(s.boundWorkspaceLines(sess)); n > 0 {
                b.WriteString("- workspaces (the +workspace badge on the toolbar, right of the lib pill): repos bound to THIS chat — currently " + strconv.Itoa(n) + " (" + strings.Join(s.boundWorkspaceLines(sess), ", ") + "). Binding/unbinding is the user's move on that badge; the workspace tool works exactly on these repos at the access level shown.\n")
        } else {
                b.WriteString("- workspaces (the +workspace badge on the toolbar, right of the lib pill): NO repo is bound to this chat yet. The user binds one of their connected workspaces there; until then the workspace tool has nothing bound (the unbounded explore tool still reaches ANY public repo).\n")
        }
        b.WriteString("- bundle (the small pill immediately right of the lib pill): the bundle armed for the CURRENT turn — the user picks it in the library (USE button) or you load members via hublib; its members ride the turn when armed" + armedBundleNote(bundleName) + ".\n")
        b.WriteString("- ✦ tweaks (the header pill): this chat's OWN look — icon, colors, text sizes, background — purely cosmetic, plus the library switches above.\n")
        b.WriteString("- When the user asks what a pill or a setting does, answer from THIS block: these are your own controls and their live state. Name the pill, say what it does, and tell the user where to flip it. Never claim a pill wasn't described to you.\n")
        return b.String()
}

// boundWorkspaceLines renders this chat's bound workspaces compactly for
// the pill ledger (kind name (access)) — same source of truth as the
// session-context block (db-less Servers degrade to empty).
func (s *Server) boundWorkspaceLines(sess *store.Session) []string {
        if s.db == nil || sess == nil {
                return nil
        }
        wss, err := s.db.ListSessionWorkspaces(sess.ID)
        if err != nil {
                return nil
        }
        var out []string
        for _, w := range wss {
                out = append(out, describeWorkspace(w))
        }
        return out
}

// armedBundleNote names the turn's attached bundle when one rides the
// request (the engine sees it as the turn's bundle manifest; the session
// itself never persists it).
func armedBundleNote(bundleName string) string {
        if v := strings.TrimSpace(bundleName); v != "" {
                return " — currently armed: \"" + v + "\""
        }
        return ""
}

// bundleNameOf extracts the bundle's label from the composed manifest
// text ("THE ATTACHED BUNDLE — <label> (#tag) — N members…") for the
// pill ledger's live state. "" when no manifest rides the turn.
func bundleNameOf(manifest string) string {
        const mark = "THE ATTACHED BUNDLE — "
        i := strings.Index(manifest, mark)
        if i < 0 {
                return ""
        }
        rest := manifest[i+len(mark):]
        for _, cut := range []string{" (#", " — ", "\n"} {
                if j := strings.Index(rest, cut); j >= 0 {
                        rest = rest[:j]
                }
        }
        return strings.TrimSpace(rest)
}

// effLabel normalizes an effort value for the persona text.
func effLabel(e string) string {
        if v := strings.TrimSpace(e); v != "" {
                return v
        }
        return "med"
}

// librarySystemPromptOn — the LIB-ON preamble (the chat's Bot Library
// switch is ON). v0.73: the full everything-is-a-bundle contract — six
// types, bundles, the per-type use, BOTH gates (Bot Library + Can
// download bundles), and the deterministic pill display. The model is
// told to SEARCH before answering capability questions (Strands lesson:
// imperative phrasing beats passive), to RECOMMEND + USE when it
// advances the goal, and to BACK OFF in five listed cases (OpenAI's
// "describe when (and when not) to use each function" rule). The
// MUST/SHOULD/MAY/MUST NOT modal verbs are Strands' Agent SOP format.
const librarySystemPromptOn = "\n\n## The Doomalay Library\n" +
        "This chat's library is ON. The Doomalay app has a LIBRARY — the public hub where EVERY type is browsable, downloadable and usable: personas, templates, skills, themes, scripts, and docs (each single item is a bundle of one), plus curated BUNDLES (collections that work together). Browsing is via the `hublib` tool (search by keyword, popular, recent, by tag, by type; `bundles` lists the curated collections — always narrow with q or tag).\n\n" +
        "## Library discipline\n" +
        "MUST: Before answering any question that could be solved by an existing library entry (a methodology, a skill, a persona, a theme, a script), call `hublib` with a 1-3 keyword query and report the top result(s) in one line. Never answer from parametric memory for capability questions.\n" +
        "SHOULD: Recommend the smallest entry that solves the actual sub-problem; cite name + the one capability you'd use, and offer to download it for the user via the same tool.\n" +
        "MAY: Pull an entry via `hublib` once you have decided it is the right fit; the download lands in the user's library (\"Yours\") and is immediately usable in this chat. USE each type the way it is meant: load a SKILL before the work it covers (skills {\"action\":\"load\"}) and follow it; follow a template's methodology; arm a downloaded PERSONA with persona_set {\"from\": \"<name>\", \"activate\": true}; a THEME describes a look the user applies from the hub page; scripts and docs are reference reading. For BUNDLES: browse the member list first, pick the member that fits the actual sub-problem — never the whole bundle at once.\n" +
        "MUST NOT use a library entry when: the task fits in a few lines of trivial code or text; the entry's surface area exceeds the problem's; the user explicitly asked for a from-scratch implementation; the entry is clearly stale (unmaintained, broken); or pulling it would steer away from the user's stated direction rather than toward it.\n" +
        "When you recommend OR decline a library entry, state the reason in one clause (\"use X because Y\", \"skip X because Z\"). If unsure whether an entry exists, search first.\n" +
        "GATES: this Bot Library switch gates USE; the separate Can download bundles switch (✦ tweaks → Bot Library → Can download bundles) gates downloading NEW entries — when it is off only already-downloaded items are usable. When you download or load something, say which item you are using — it displays next to the lib+ pill for the user.\n"

// librarySystemPromptOff — the LIB-OFF preamble (the chat's Bot Library
// switch is OFF). The model is STILL told the library exists (the user's
// core ask); it can browse + recommend but cannot load or download — the
// app blocks those until the user flips * tweaks -> Bot Library back on.
// The model is instructed NOT to pretend the library is unavailable.
// v0.73: the six types + bundles wording + the exact two-gate paths.
const librarySystemPromptOff = "\n\n## The Doomalay Library\n" +
        "This chat's library switch is OFF (the user can flip it via * tweaks -> Bot Library). The Doomalay app still HAS a library — the public hub where every type is browsable: personas, templates, skills, themes, scripts, and docs (each single item is a bundle of one), plus curated BUNDLES (collections that work together). Browsing is via the `hublib` tool (search by keyword, popular, recent, by tag, by type; `bundles` lists the curated collections — always narrow with q or tag).\n\n" +
        "## Library discipline (browse-only mode)\n" +
        "MUST: When the user asks about capabilities (\"can the app do X?\", \"is there a skill for Y?\", \"do you have a template for Z?\"), call `hublib` with a 1-3 keyword query and report the top result(s) in one line — never answer from parametric memory.\n" +
        "SHOULD: Recommend entries by name + one-line capability; tell the user to flip * tweaks -> Bot Library ON to download + use them (and Can download bundles ON for new downloads).\n" +
        "MAY: Browse the public hub (popular, recent, by tag) when the user asks for inspiration or what's new.\n" +
        "MUST NOT attempt to download or load entries — loads and downloads refuse until the user flips the Bot Library switch back on. Do not pretend the library is unavailable; it IS available, just download-gated.\n"

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

// defaultPersonaHF (v0.48 task 6 → v0.89.3 THE BOT'S OWN MANUAL): the
// HF-chat default persona is now deliberately SHORT — identity + style +
// the BASIC tools the user named (calculator, time) + ONE pointer to
// HARNESS.md. The long "## Environment" enumeration is GONE (it burned
// tokens every turn and went stale whenever the harness evolved). The
// complete capability inventory lives in brain/HARNESS.md, which is
// seeded into the agent's workspace (agent_core.py _seed_harness) AND
// attached to the chat as the auto-seeded 'My harness' artifact on HF
// session create. {repo} is substituted by defaultPersonaFor (own-space
// repo name or the shared marker). Mirrors persona.js DEFAULT_PERSONA_HF.
const defaultPersonaHF = "## Identity\n" +
        "You are {model} (served via {provider}), the Doomalay assistant running INSIDE a Hugging Face Space{repo} — a real Linux sandbox in the cloud, not on the user's device. " +
        "Your name in this app is {name}. " +
        "If the user asks which model you are, tell them exactly that — never guess and never claim to be a different model. " +
        "This identity updates automatically when the user switches your model mid-conversation; trust it over any prior assumption.\n\n" +
        "## Style\n" +
        "Be direct and concise; lead with the outcome, not the process. " +
        "Use markdown freely — headings, lists, bold, links and fenced code blocks all render nicely in this app. " +
        "Prefer DOING over describing: when something can be checked by actually running it, run it and show the real output. " +
        "When you don't know something, say so.\n\n" +
        "## Tools\n" +
        "You always have a calculator and the current time. " +
        "That is the SAFE baseline — it is not your limit. " +
        "Your complete harness — every capability, tool and command of this sandbox, from the Linux shell to HF self-management to serving viewable apps — is HARNESS.md in your workspace. " +
        "Read it (file_read, or `cat HARNESS.md`) before claiming you cannot do something, whenever a task asks for more than plain chat, and any time the user asks what you can do.\n\n" +
        artifactSystemPrompt

// defaultPersonaFor (v0.48 task 6) picks the mode-aware default: HF chats
// get an assistant that knows it lives in a Hugging Face Space with the
// full toolchain; quick chats get the classic app persona. v0.67 THE
// LIBRARY AWARENESS WAVE: both defaults now append the library preamble
// (conditional on sess.LibAuto) so the engine direct-LLM path matches
// the brain's library-aware _build_system_prompt — the model knows the
// library exists, recommends when on, browse-only when off.
func defaultPersonaFor(sess *store.Session) string {
        if sess != nil && sess.Sandbox == "hf" {
                p := defaultPersonaHF
                if repo := strings.TrimSpace(sess.SandboxRepo); repo != "" {
                        p = strings.ReplaceAll(p, "{repo}", " (your Space: "+repo+")")
                } else {
                        p = strings.ReplaceAll(p, "{repo}", " (the shared sandbox)")
                }
                return p + libraryPreamble(sess)
        }
        return defaultPersonaQuick + libraryPreamble(sess)
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
        return s.systemPromptForMetrics(sess, personaMetrics{}, "")
}

func (s *Server) systemPromptForMetrics(sess *store.Session, m personaMetrics, bundleName string) string {
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
        // v0.68 THE METADATA PERSONAS: every persona (default or custom)
        // gets the live controls block — the bot knows what each pill does
        // + the current state, so it can name the exact flip path on ask.
        // v0.78.1: + the live session block (usage, pricing, context,
        // connections, bound repos) — the bot knows its own dashboard.
        meta := s.chatMetadataPreamble(sess, bundleName) + s.sessionContextPreamble(sess)
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
                b.WriteString(s.libStateLine(sess))
                b.WriteString(meta)
                return b.String()
        }
        persona := strings.TrimSpace(sess.Persona)
        if persona == "" {
                // No custom persona → the mode-aware default (v0.48 task 6:
                // quick vs HF — the HF default knows it lives in a Space
                // with the full toolchain).
                b.WriteString("\n\n" + substituteAllVars(defaultPersonaFor(sess), sess.Title, sess.Model, sess.Provider, ph))
                b.WriteString(s.libStateLine(sess))
                b.WriteString(meta)
                return b.String()
        }
        b.WriteString("\n\n" + substituteAllVars(persona, sess.Title, sess.Model, sess.Provider, ph))
        if !strings.Contains(strings.ToLower(persona), "artifact") {
                // Keep the file-save capability alive under custom personas.
                b.WriteString("\n\n" + artifactSystemPrompt)
        }
        b.WriteString(s.libStateLine(sess))
        b.WriteString(meta)
        return b.String()
}

// libStateLine (v0.67.2) — the LIVE library state, appended to every
// composed system prompt: which pills/switches gate the bot's library
// access this session. Without it the model GUESSES the switch state
// (observed live: a model claimed the library was off when it was on)
// — now the turn's prompt states the truth.
func (s *Server) libStateLine(sess *store.Session) string {
        if sess == nil {
                return ""
        }
        // the pills straight off the in-hand session (no db round-trip);
        // the tweaks Bot Library switch needs the store — guarded so a
        // db-less Server (tests) still composes.
        lib := sess.LibAuto || sess.TemplateAuto || sess.SkillsAuto
        if s.db != nil {
                lib = lib && s.tweaksBotLibOn(sess.ID)
        }
        tpl := sess.TemplateAuto
        state := "\n\n[Live library state: the Bot Library switch (the lib pill) is "
        if lib {
                state += "ON"
        } else {
                state += "OFF — downloads and skill loads refuse with the switch path; browsing and recommending still work"
        }
        state += " for this chat"
        if tpl {
                state += "; the template auto-search pill is ON"
        }
        state += ". The user flips it at ✦ tweaks → Bot Library.]"
        return state
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
                // v0.95.1 THE ISOLATION GUARD: a frame that names a session
                // must match the socket's session. The send frame historically
                // carried NO session identity — a client state cross-bind (two
                // chats sharing one stale ChatClient, or two icons bound to one
                // session) executed chat A's turn inside chat B's event log,
                // persisting A's user text and A's model's reply into B's
                // transcript (the live Nemotron leak: scooby/deepseek's log
                // carried another nvidia chat's "Hello! I'm Nemotron" turn).
                // Absent session_id = the legacy frame shape (allowed).
                if frameSid, _ := msg["session_id"].(string); frameSid != "" && frameSid != sessionID {
                        log.Printf("ws session mismatch: %s frame for %q on socket for %q — rejected", msgType, frameSid, sessionID)
                        // An EPHEMERAL error frame (the progress shape — never
                        // persisted: the socket's session log must not record
                        // another chat's rejected traffic).
                        if b, err := json.Marshal(map[string]any{
                                "type": "error", "session_id": sessionID,
                                "text": fmtError("session", "session mismatch — this connection serves another chat", "", ""),
                        }); err == nil {
                                _ = pipe.send(b)
                        }
                        continue
                }
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
// from context.Background(). v0.80.1: NO turn budget — the Stop button
// (abortTurn) and the stream's own end are the only cancellation paths; a
// WS drop just clears the pipe while the turn keeps persisting (a resumed
// client picks it up).
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
                // v0.60 pt C.9: the lib pill's effective gate.
                "lib_auto": sess.LibAuto || sess.TemplateAuto || sess.SkillsAuto,
                // v0.68: the effective tweaks gates (the standalone-brain
                // fallback prompt names them; the engine-sent system_prompt
                // already carries the full metadata block).
                "bot_lib": (sess.LibAuto || sess.TemplateAuto || sess.SkillsAuto) && s.tweaksBotLibOn(sess.ID),
                "bot_dl":  (sess.LibAuto || sess.TemplateAuto || sess.SkillsAuto) && s.tweaksBotLibOn(sess.ID) && s.tweaksBotDLOn(sess.ID),
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
        bundManifest := ""
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
        // v0.72: THE ATTACHED BUNDLE — the WS twin of the PM path's
        // opts.bundle (pmsdk.js). {name, id, members:[{type,name,desc,
        // repo,id}]} rides the send; the engine composes the manifest
        // block (members + the pick/load protocol) for BOTH paths (brain:
        // prepended to the system prompt here; direct: llm.ChatRequest.
        // BundleManifest via brainReq["bundle_manifest"] at the proxy
        // call sites).
        if bRaw, ok := msg["bundle"].(map[string]any); ok {
                if manifest := bundleManifestText(bRaw); manifest != "" {
                        bundManifest = manifest
                        brainReq["bundle_manifest"] = manifest
                        if sp, ok2 := brainReq["system_prompt"].(string); ok2 && sp != "" {
                                brainReq["system_prompt"] = manifest + "\n\n" + sp
                        }
                }
        }
        // v0.95.1: the send frame NEVER persists session config anymore.
        // The model/provider overrides above are PER-TURN ONLY (they ride
        // the fresh per-turn copy of the session) — the UI persists real
        // changes through PATCH /api/sessions (chatpanel.js updateSession,
        // the model picker / capability pills). The old engine-side
        // persistence was the leak's amplifier: one misrouted send frame
        // not only wrote chat A's turn into chat B's log, it also
        // REWROTE chat B's saved model to chat A's model.

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
        // v0.80.1 NO TURN BUDGET (user directive: "remove any timer that
        // canceles an output or reply — models should be able to keep going
        // as long as they like"). History: v0.16 added a 10-min backstop to
        // guarantee the turn lock always releases; v0.24 made it 20-min for
        // reasoning models; v0.76.6 raised brain-mediated turns to a 45-min
        // floor — and every one of those caps still killed HEALTHY turns
        // live (a 32-step tool chain died at exactly 600s mid-chain; the
        // shared-space path pays 2-6 min PER MODEL CALL). The deadline is
        // now GONE. Exactly two things cancel a turn: the Stop button
        // (abortTurn) and the stream's own natural end. A hung provider
        // connection is VISIBLE (the wait-notices keep counting "waiting
        // for kimi-k3 · Ns…") and Stop kills it instantly; the turn lock
        // is released when the stream goroutine returns and the deferred
        // terminal-status emit below guarantees the UI always unblocks.
        turnCtx, turnCancel := context.WithCancel(context.Background())
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
                // v1.10.1: PERSISTENT notice (the old transient progress
                // event vanished at turn end — the user never learned the
                // sandbox wasn't used). A short progress line still feeds
                // the live activity indicator mid-turn.
                s.emitNotice(pipe, sessionID,
                        "HF sandbox not configured — this turn (and every turn until you connect one) runs on the device's direct pipeline: no Linux sandbox, no bash, no installs. "+
                                "Fix: Hub → Hugging Face → sign in, then Sandbox → Hugging Face → create your free sandbox (or use the shared one).",
                        "hf-unconfigured")
                if b, jerr := json.Marshal(map[string]any{
                        "type": "progress", "session_id": sessionID,
                        "message": "HF sandbox not configured — running this turn on the direct pipeline",
                }); jerr == nil {
                        _ = pipe.send(b)
                }
                s.streamFromDirectProxy(turnCtx, pipe, sessionID, sess, userText, tplID, tplBrief, bundManifest, &terminal)
        } else if s.brain != nil && s.brain.Healthy() {
                s.streamFromBrain(turnCtx, pipe, sessionID, sess, brainReq, userText, &terminal)
        } else {
                s.streamFromDirectProxy(turnCtx, pipe, sessionID, sess, userText, tplID, tplBrief, bundManifest, &terminal)
        }
}

// turnRemoteEnv — the v0.75 per-turn minimal key set a THIRD-PARTY
// remote brain (the shared community space, or someone else's public
// space) receives: the resolved provider's key (+ its EXTRA field,
// e.g. the cloudflare account) + the HF tokens. One intercepted request
// leaks exactly ONE provider key — never the whole BYOK set (the v0.74
// structural finding, fixed). Own spaces keep the full vault (they are
// the user's own machines). Known trade: a sub-agent turn on the space
// that routes to a DIFFERENT provider falls back to the space's own
// community keys (os.environ there) instead of the user's key for that
// provider — the deliberate price of the minimized surface.
func (s *Server) turnRemoteEnv(sess *store.Session) map[string]string {
        third := s.thirdPartyRemoteEnv()
        var envVar, extra string
        provider := ""
        if sess != nil {
                provider = sess.Provider
        }
        if provider != "" {
                if catalog, err := llm.LoadCatalog(); err == nil {
                        if cfg, ok := catalog[provider]; ok {
                                envVar, extra = cfg.EnvVar, cfg.ExtraEnvVar
                        }
                }
        }
        // Legacy/edge: no provider on the session — the model id's
        // prefix carries it ("nvidia/z-ai/glm-5.3-flash").
        if envVar == "" && sess != nil {
                if i := strings.Index(sess.Model, "/"); i > 0 {
                        if catalog, err := llm.LoadCatalog(); err == nil {
                                if cfg, ok := catalog[sess.Model[:i]]; ok {
                                        envVar, extra = cfg.EnvVar, cfg.ExtraEnvVar
                                }
                        }
                }
        }
        if envVar == "" {
                return third // unknown provider: never worse than the v0.74 shape
        }
        out := make(map[string]string, 4)
        if v, ok := third[envVar]; ok && v != "" {
                out[envVar] = v
        }
        if extra != "" {
                if v, ok := third[extra]; ok && v != "" {
                        out[extra] = v
                }
        }
        // the HF tokens — hf-token-auth on the shared space + dt_hf's
        // per-request publish path (the ContextVar reads these).
        for _, k := range []string{"DOOMALAY_HF_TOKEN", "HF_TOKEN", "HUGGINGFACE_TOKEN"} {
                if v, ok := third[k]; ok && v != "" {
                        out[k] = v
                }
        }
        return out
}

// thirdPartyEnvDenied: vault entries that ARE allowlisted (users can set
// them through the keys API) but must NEVER cross to a third-party remote —
// the forges + the OAuth pair belong to THIS device's hub/workspace
// machinery. The space-create flow's HF_SPACE_<…> tokens never match the
// allowlist map, so they're excluded by construction.
var thirdPartyEnvDenied = map[string]bool{
        "GITHUB_PAT":                 true,
        "GITEA_TOKEN":                true,
        "GITHUB_OAUTH_CLIENT_ID":     true,
        "GITHUB_OAUTH_CLIENT_SECRET": true,
}

// thirdPartyRemoteEnv filters the vault env down to what a THIRD-PARTY remote
// brain (the shared community space, or someone else's public space) may
// receive: the BYOK provider keys + the HF tokens. Everything else the vault
// holds — GITHUB_PAT, per-space tokens, other services' credentials — NEVER
// crosses to a space we don't own. Own spaces keep the full vault (they are
// the user's own machines).
func (s *Server) thirdPartyRemoteEnv() map[string]string {
        full := map[string]string{}
        if s.vault != nil {
                full = s.vault.AsEnv()
        }
        out := make(map[string]string, len(full))
        for k, v := range full {
                if thirdPartyEnvDenied[k] {
                        continue
                }
                if _, ok := secrets.PROVIDER_KEY_ALLOWLIST[k]; ok {
                        out[k] = v
                        continue
                }
                // the provider "extra" fields (vault AsEnv appends _EXTRA) ride along
                // for the same allowlisted providers (e.g. cloudflare account).
                if strings.HasSuffix(k, "_EXTRA") {
                        if _, ok := secrets.PROVIDER_KEY_ALLOWLIST[strings.TrimSuffix(k, "_EXTRA")]; ok {
                                out[k] = v
                        }
                        continue
                }
                // the HF tokens — needed for hf-token-auth on the shared space and
                // dt_hf's per-request publish path.
                switch k {
                case "DOOMALAY_HF_TOKEN", "HF_TOKEN", "HUGGINGFACE_TOKEN":
                        out[k] = v
                }
        }
        return out
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
        // v0.74: PUBLIC mode — someone else's space connected by URL (the
        // sandbox picker's footer). Shared-style auth (the user's own HF
        // token) on an arbitrary repo; the remotes cache is namespaced so
        // it never collides with an own-mode client for the same repo.
        // Third-party space → the FILTERED env (BYOK keys + HF tokens only).
        if mode == "public" {
                env = s.thirdPartyRemoteEnv()
                repo := sess.SandboxRepo
                if repo == "" || s.hfToken() == "" {
                        return nil
                }
                cacheKey := "public:" + repo
                s.remoteMu.RLock()
                rb := s.remotes[cacheKey]
                s.remoteMu.RUnlock()
                if rb != nil {
                        rb.SetEnv(env)
                        return rb
                }
                url := hfzero.SpaceURL(repo)
                if url == "" {
                        return nil
                }
                rb = brain.NewSharedRemoteBrain(repo, url, s.hfToken, env)
                s.remoteMu.Lock()
                s.remotes[cacheKey] = rb
                s.remoteMu.Unlock()
                return rb
        }
        // shared
        // v0.74: third-party space → the FILTERED env (BYOK keys + HF tokens
        // only — never GITHUB_PAT or space tokens).
        env = s.thirdPartyRemoteEnv()
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

        // v0.75 KEY-IN-FLIGHT MINIMIZATION: a third-party space receives
        // ONLY this turn's provider key (+ HF tokens) — own spaces keep
        // the full vault. nil = rb.env (the legacy own-mode shape).
        var turnEnv map[string]string
        if rb.Mode != "own" {
                turnEnv = s.turnRemoteEnv(sess)
        }

        // First turn on this space (or it slept — HF gc's after 48h idle):
        // wake it with a patient probe so the user sees WHY it's slow.
        // v0.93.3 WAKE HONESTY: `healthy` starts false at every engine boot,
        // so the OLD flow claimed "waking the HF sandbox (up to a minute…)"
        // + a 75s patient probe on the first turn even when the space was
        // RUNNING and answers in ~1s (the user's "waking when it's already
        // running" report). A 3s quick probe first: alive → straight to
        // the turn, no scary message; only a dead/sleeping space gets the
        // honest waking note + the patient ladder.
        if !rb.Healthy() {
                if !rb.ProbeTimeout(3 * time.Second) {
                        if b, jerr := json.Marshal(map[string]any{
                                "type": "progress", "session_id": sessionID,
                                "message": "waking the HF sandbox (up to a minute if it slept)…",
                        }); jerr == nil {
                                _ = pipe.send(b)
                        }
                        rb.ProbeTimeout(75 * time.Second)
                }
        }

        // v1.10.2 THE NO-FIRST-BYTE GUARD (D1 — the NVIDIA black-hole):
        // a space running an OLD brain can sit in a provider call that
        // NEVER answers (live-observed: 125s+ of "still working" heartbeats
        // with zero LLM events and a per-call timeout of ONE DAY), while
        // the engine faithfully forwards the heartbeats forever. The guard:
        // if NO LLM-ish event (anything but progress/status/notice) arrives
        // within DOOMALAY_HF_STALL_KILL seconds (default 600 — comfortably
        // above the shared space's legitimate 2-6 min silent first call;
        // 0 disables), cancel the SPACE call only (a child context — the
        // turn itself survives) and run the direct fallback with an honest
        // persistent notice. This does NOT violate the v0.80.1 no-kill
        // directive: nothing has ever arrived, so there is no output to
        // cancel — and once ANY LLM evidence lands the guard disarms for
        // the rest of the turn (slow-but-alive turns keep going forever,
        // exactly as the user mandated). The Stop button remains the
        // manual override at any time.
        spaceCtx, cancelSpace := context.WithCancel(ctx)
        defer cancelSpace()
        events, errs, err := rb.Chat(spaceCtx, brainReq, turnEnv)
        if err != nil {
                rb.MarkUnhealthy()
                // v1.10.1 THE HONEST TURN: the fallback is a PERSISTENT
                // notice now — the D3 finding was this exact path: ONE
                // transient progress line, then the turn completed on the
                // direct pipeline (no bash) and the user never knew. The
                // notice names the cause + the fix; the code routes the
                // UI (reconnect vs wake vs generic).
                code := "hf-fallback"
                fix := "retry in a moment (the space may be waking), or check the space from the Hub panel"
                if strings.Contains(err.Error(), "401") {
                        code = "hf-auth"
                        fix = "reconnect Hugging Face (Hub → Hugging Face) — the sign-in token may have expired — or re-create/re-pin the space"
                }
                s.emitNotice(pipe, sessionID,
                        "HF sandbox unreachable — this turn ran on the device's direct pipeline (no Linux sandbox, no bash). Cause: "+err.Error()+
                                ". Fix: "+fix+".",
                        code)
                if b, jerr := json.Marshal(map[string]any{
                        "type": "progress", "session_id": sessionID,
                        "message": "HF sandbox unreachable (" + err.Error() + ") — running this turn on the engine's direct pipeline",
                }); jerr == nil {
                        _ = pipe.send(b)
                }
                tplID, _ := brainReq["template_id"].(string)
                tplBrief, _ := brainReq["template_brief"].(string)
                bundManifest, _ := brainReq["bundle_manifest"].(string)
                s.streamFromDirectProxy(ctx, pipe, sessionID, sess, userText, tplID, tplBrief, bundManifest, terminal)
                return
        }
        guarded, guardFired := guardFirstByte(events, stallKillSeconds(), cancelSpace)
        s.forwardEvents(ctx, pipe, sessionID, sess, userText, s.synthesizeRounds(sessionID, guarded), errs, terminal)
        if guardFired() {
                // The space call was cancelled by the guard — the honest
                // notice already streamed (persisted by forwardEvents);
                // mark the space unhealthy (a fresh probe on the next turn
                // revives it) and answer on the direct pipeline.
                rb.MarkUnhealthy()
                s.emitNotice(pipe, sessionID,
                        "The HF sandbox never answered — no model output for the whole guard window. This turn is running on the device's direct pipeline (no Linux sandbox, no bash). "+
                                "The space's provider connection may be stalling (observed with NVIDIA from HF egress); switch provider for sandbox work or retry in a while.",
                        "hf-stall")
                tplID, _ := brainReq["template_id"].(string)
                tplBrief, _ := brainReq["template_brief"].(string)
                bundManifest, _ := brainReq["bundle_manifest"].(string)
                s.streamFromDirectProxy(ctx, pipe, sessionID, sess, userText, tplID, tplBrief, bundManifest, terminal)
        }
}

// stallKillSeconds parses DOOMALAY_HF_STALL_KILL (seconds; default 600 =
// 10 min; 0 = guard disabled — the pure v0.80.1 mode).
func stallKillSeconds() int {
        if v := os.Getenv("DOOMALAY_HF_STALL_KILL"); v != "" {
                if n, err := strconv.Atoi(strings.TrimSpace(v)); err == nil && n >= 0 {
                        return n
                }
        }
        return 600
}

// isLLMEvidence — anything the brain streams that proves the model call is
// ALIVE. Progress heartbeats + status frames + notices are excluded (the
// black-hole signature is exactly: heartbeats forever, nothing else).
func isLLMEvidence(ev map[string]any) bool {
        switch ev["type"] {
        case "progress", "status", "notice":
                return false
        }
        return true
}

// guardFirstByte wraps a brain event stream with the no-first-byte
// watchdog. onFire (when non-nil) is called the instant the guard fires —
// streamFromRemoteBrain passes the space-call's cancel there so the SSE
// reader goroutine exits and its errs channel closes BEFORE forwardEvents
// blocks on it (the blocking <-errs drain at the end of forwardEvents —
// a deferred-only cancel would deadlock exactly there). The returned
// fired func tells (after the channel closed) whether the guard killed
// the stream. The synthetic notice rides the stream itself so
// forwardEvents persists it like any other.
func guardFirstByte(events <-chan map[string]any, killAfterSec int, onFire func()) (<-chan map[string]any, func() bool) {
        out := make(chan map[string]any)
        var fired atomic.Bool
        go func() {
                defer close(out)
                if killAfterSec <= 0 {
                        for ev := range events {
                                out <- ev
                        }
                        return
                }
                timer := time.NewTimer(time.Duration(killAfterSec) * time.Second)
                defer timer.Stop()
                for {
                        select {
                        case ev, ok := <-events:
                                if !ok {
                                        return
                                }
                                out <- ev
                                if isLLMEvidence(ev) {
                                        // First LLM evidence — the space is
                                        // ALIVE. Disarm: pass the rest
                                        // through untouched (no timer; slow
                                        // multi-minute rounds keep going).
                                        for ev2 := range events {
                                                out <- ev2
                                        }
                                        return
                                }
                        case <-timer.C:
                                fired.Store(true)
                                if onFire != nil {
                                        onFire() // cancel the space call NOW (see the doc comment)
                                }
                                out <- map[string]any{
                                        "type":    "notice",
                                        "message": "HF sandbox stall guard: no model output for " + strconv.Itoa(killAfterSec) + "s — cancelling the sandbox call and falling back to the direct pipeline…",
                                        "code":    "hf-stall",
                                }
                                return
                        }
                }
        }()
        return out, func() bool { return fired.Load() }
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
                bundManifest, _ := brainReq["bundle_manifest"].(string)
                s.streamFromDirectProxy(ctx, pipe, sessionID, sess, userText, tplID, tplBrief, bundManifest, terminal)
                return
        }
        s.forwardEvents(ctx, pipe, sessionID, sess, userText, s.synthesizeRounds(sessionID, events), errs, terminal)
}

// synthesizeRounds wraps a brain/remote-brain event stream with the v0.93.3
// ROUND CONTRACT the engine's own paths already emit — the brain emits NO
// segment events, so on multi-round tool turns the model's narration for
// round N glommed into round N-1's still-open bubble at its old position
// high up the transcript (the user's live report: "the final response
// replaces the previous final response in the previous final response's
// location while it spams tools down the chatlog, having its final output
// remain all the way up top").
//
// The synthesis (single choke point — works for every brain/space version):
//   · assistant_delta text accumulates in a segment buffer;
//   · a tool_use boundary closes the open segment FIRST (assistant
//     {round:true} + round_end), so the pill renders below a COMPLETED
//     block and the next round's deltas open a NEW bubble at the bottom;
//   · a terminal status/error closes the final segment before the terminal,
//     so replay reconstructs the same block-per-round flow.
// No-op for single-segment turns (nothing buffered at boundary) and for
// brains that grow their own round events (a tool_use with an empty buffer
// synthesizes nothing).
func (s *Server) synthesizeRounds(sessionID string, events <-chan map[string]any) <-chan map[string]any {
        out := make(chan map[string]any, 64)
        go func() {
                defer close(out)
                var seg strings.Builder
                for ev := range events {
                        t, _ := ev["type"].(string)
                        if t == "assistant_delta" {
                                if txt, ok := ev["text"].(string); ok {
                                        seg.WriteString(txt)
                                }
                                out <- ev
                                continue
                        }
                        boundary := false
                        round := false
                        switch t {
                        case "tool_use":
                                boundary, round = true, true
                        case "error":
                                boundary = true
                        case "status":
                                if st, _ := ev["state"].(string); st == "idle" || st == "error" {
                                        boundary = true
                                }
                        }
                        if boundary && seg.Len() > 0 {
                                out <- map[string]any{"type": "assistant", "text": seg.String(), "round": true, "session_id": sessionID}
                                if round {
                                        out <- map[string]any{"type": "round_end", "session_id": sessionID}
                                }
                                seg.Reset()
                        }
                        out <- ev
                }
        }()
        return out
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
func (s *Server) streamFromDirectProxy(ctx context.Context, pipe *chatPipe, sessionID string, sess *store.Session, userText, tplID, tplBrief, bundleManifest string, terminal *bool) {
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
        full = append(full, llm.Message{Role: "system", Content: s.systemPromptForMetrics(sess, pm, bundleNameOf(bundleManifest))})
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
                // v0.67.2: THE LIBRARY on the direct path — browse/get/
                // download the public hub from the quick chats. The runner
                // enforces the per-chat Bot Library switch per action.
                HublibToolFn: func(ctx context.Context, argJSON string) string {
                        return s.runHublibAction(sessionID, argJSON)
                },
                // v0.72: THE SKILLS HAND on the direct path — the quick
                // chats bootstrap the superpowers discipline and LOAD
                // downloaded skills as armed methodologies (the PM
                // bridge's /api/tools/skills twin, same dispatch).
                SkillsToolFn: func(ctx context.Context, argJSON string) string {
                        return s.runSkillsAction(sessionID, argJSON)
                },
                // v0.76.5: THE WORKSPACE HAND on the direct path — the
                // quick chats act on the chat's CONNECTED cloud repos
                // (tree/read/grep/view/put/fork/pr/create/discover).
                // Always armed (a bare "workspace" ACTION answers with
                // the map); the manifest below lists the actual repos.
                WorkspaceToolFn: func(ctx context.Context, argJSON string) string {
                        return s.runWorkspaceAction(ctx, sessionID, argJSON)
                },
                WorkspaceManifest: s.workspaceManifestFor(sessionID),
                // v0.44: the active method template (the template pill) —
                // the turn pipelines prepend the brief as a METHOD TEMPLATE
                // system block. v0.72: the attached whole bundle's manifest
                // rides above it (composeTurnSystem).
                TemplateID:     tplID,
                TemplateBrief:  tplBrief,
                BundleManifest: bundleManifest,
                // v0.52 THE 3 PILLS: the per-chat auto-search toggles —
                // TemplateAuto gates the template ACTION tools on the
                // direct path (off = the tools are not offered, so the
                // model cannot burn turns browsing a library the user
                // disabled). SkillsAuto rides for the brain path; the
                // v0.72 skills hand rides the direct path via
                // SkillsToolFn above (the dispatch enforces the lib pill
                // on bootstrap/load).
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
                        if chunk.Type == "round_end" {
                                // v0.93.3 THE ROUND SEGMENT: the model's
                                // narration before a tool call is its own
                                // chat block (the user's "flow like a chat"
                                // spec) — persist it as its OWN assistant
                                // event so replay reconstructs the same
                                // block-per-round flow, then start the next
                                // segment. The final segment persists at
                                // turn end (below) as before.
                                if len(assistantParts) > 0 {
                                        events <- map[string]any{"type": "assistant", "text": strings.Join(assistantParts, ""), "round": true}
                                        assistantParts = nil
                                }
                        }
                        // v0.95.2 THE ORDERING FIX: the terminal status chunk
                        // used to reach the client BEFORE the turn's final
                        // full-text assistant event (the goroutine only
                        // pushed it AFTER the chunk loop) — the client's
                        // completeAllStreaming ran on status:idle and marked
                        // the open bubble complete, so the trailing assistant
                        // event then DUPLICATED into a second full-text
                        // bubble. Flush the final segment BEFORE the terminal
                        // ships (the post-loop flush stays as the no-terminal
                        // backstop for died streams).
                        if chunk.Type == "status" && (chunk.State == "idle" || chunk.State == "error") && len(assistantParts) > 0 {
                                events <- map[string]any{"type": "assistant", "text": strings.Join(assistantParts, "")}
                                assistantParts = nil
                        }
                        if chunk.Type == "assistant_reset" {
                                // v0.22 legacy (pre-v0.93.3 the leak backstop
                                // wiped leaked preambles; kept for replays of
                                // old logs and any residual emitter).
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
                // v0.80.1: with the turn budget gone, Canceled can only mean the
                // Stop button — keep the honest errors for real stream errors.
                if evType == "error" && ctx.Err() == context.Canceled {
                        continue
                }
                // v0.75 IN-FLIGHT REDACTION: every error event's text fields
                // are scrubbed BEFORE anything downstream sees them — the
                // chat_events persistence, the WS forward, the replay — a
                // provider that echoes the Authorization header, a tool
                // result that prints a key: nothing survives in flight.
                if evType == "error" {
                        for _, k := range []string{"message", "error", "text", "detail"} {
                                if v, ok := ev[k].(string); ok {
                                        ev[k] = Redact(v)
                                }
                        }
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
                case "thinking", "assistant_delta", "assistant", "title", "hublist":
                        if t, ok := ev["text"].(string); ok {
                                content = t
                        }
                case "tool_use", "tool_result":
                        // v0.73: THE DETERMINISTIC REPLAY — tool events persist
                        // as the JSON payload {name, summary, text} (the PM-bridge
                        // shape). The bare "name summary" / text-only shapes lost
                        // the tool NAME on replay, so the chatpanel's lift
                        // (JSON.parse(pay.text)) fell back to {type, text} — the
                        // active-bundle pill derivation (turnBundleOf) and the
                        // transcript's tool pills both degraded after a reload.
                        // Live events carry name/summary top-level and are
                        // unchanged; only the persisted content becomes the
                        // self-describing shape the replay can lift.
                        toolEv := map[string]any{}
                        if v, ok := ev["name"].(string); ok && v != "" {
                                toolEv["name"] = v
                        }
                        if v, ok := ev["summary"].(string); ok && v != "" {
                                toolEv["summary"] = v
                        }
                        if v, ok := ev["text"].(string); ok && v != "" {
                                toolEv["text"] = v
                        }
                        if len(toolEv) == 0 {
                                if v, ok := ev["text"].(string); ok {
                                        content = v // the odd text-only tool event stays honest
                                }
                        } else if b, err := json.Marshal(toolEv); err == nil {
                                content = string(b)
                        }
                        if content == "" { // legacy fallback: name summary
                                name, _ := ev["name"].(string)
                                summary, _ := ev["summary"].(string)
                                content = name
                                if summary != "" {
                                        content += " " + summary
                                }
                        }
                case "notice":
                        // v1.10.1: stream-injected notices (the Phase-2
                        // watchdog, brain-side notices) persist their
                        // {message, code} payload exactly like errors.
                        nEv := map[string]any{}
                        for _, k := range []string{"message", "code"} {
                                if v, ok := ev[k]; ok && v != nil {
                                        nEv[k] = v
                                }
                        }
                        if len(nEv) == 0 {
                                if t, ok := ev["text"].(string); ok {
                                        content = t
                                }
                        } else if b, err := json.Marshal(nEv); err == nil {
                                content = string(b)
                        }
                case "error":
                        // v0.13: error events carry "message" (human text) +
                        // "error" (code) — persist the human-readable one.
                        // v0.75: persist the FULL error payload as JSON
                        // (message + provider + model + key_source + suggest)
                        // — the replay parser (chatpanel) lifts the fields
                        // back out, so a reopened chat keeps the BYOK
                        // attribution ("your key" vs "the community key")
                        // and the model-gone chips exactly as live.
                        errEv := map[string]any{}
                        for _, k := range []string{"message", "error", "provider", "model", "key_source", "env_var"} {
                                if v, ok := ev[k]; ok && v != nil {
                                        errEv[k] = v
                                }
                        }
                        if sug, ok := ev["suggest"].([]any); ok && len(sug) > 0 {
                                errEv["suggest"] = sug
                        }
                        if len(errEv) == 0 {
                                if t, ok := ev["text"].(string); ok {
                                        content = t
                                }
                        } else if b, err := json.Marshal(errEv); err == nil {
                                content = string(b)
                        } else if t, ok := ev["message"].(string); ok {
                                content = t
                        }
                case "sources":
                        b, _ := json.Marshal(ev["sources"])
                        content = string(b)
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
        case "notice":
                // v1.10.1 THE HONEST TURN: notices persist {message, code}
                // (like errors) — the wire shape mirrors error's so the
                // replay parser can lift the fields back out.
                var nobj map[string]any
                if json.Unmarshal([]byte(content), &nobj) == nil && len(nobj) > 0 {
                        for k, v := range nobj {
                                out[k] = v
                        }
                } else {
                        out["message"] = content
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

// emitNotice (v1.10.1 THE HONEST TURN) — persist + forward a system notice.
// The D3 root cause: sandbox degradation was announced as a TRANSIENT
// progress event (ephemeral by design — never persisted, gone at turn end,
// invisible on replay), so an HF-chat turn that silently fell back to the
// direct pipeline left the user believing bash had run. Notices are
// PERSISTED first-class events: they render as a permanent amber system
// bubble, survive reloads, and never park the send queue (unlike errors).
// code routes the UI styling/deep-links: "hf-fallback", "hf-unconfigured",
// "hf-auth", "hf-stall", "pm-local".
func (s *Server) emitNotice(pipe *chatPipe, sessionID, message, code string) {
        payload, _ := json.Marshal(map[string]string{"message": message, "code": code})
        s.emit(pipe, sessionID, "notice", string(payload), "")
}

// persistNoticeOnly — the no-pipe twin (session-create time notices: the
// WS may not exist yet; the replay carries them).
func (s *Server) persistNoticeOnly(sessionID, message, code string) {
        s.emitNotice(nil, sessionID, message, code)
}

// bundleManifestText (v0.72) — composes THE ATTACHED BUNDLE manifest block
// from the WS send's bundle payload ({name, id, tag?, members:[{type, name,
// desc, repo, id}]}). The PM path composes the same protocol client-side
// (vendor/pm/pmsdk.js, v0.71); this is the engine twin for WS/direct turns
// so BOTH paths teach the same pick-load-follow discipline. Skills-first
// member ordering, descriptions clipped to 140 (they are when-to-use
// conditions), the superpowers workflow appended when it is superpowers.
func bundleManifestText(b map[string]any) string {
        if b == nil {
                return ""
        }
        str := func(k string) string {
                v, _ := b[k].(string)
                return strings.TrimSpace(v)
        }
        name, id, tag := str("name"), str("id"), str("tag")
        rawMembers, _ := b["members"].([]any)
        if len(rawMembers) == 0 {
                return ""
        }
        type member struct {
                typ, name, desc, repo, id string
        }
        order := map[string]int{"skill": 0, "script": 1, "template": 2, "doc": 3, "persona": 4}
        members := make([]member, 0, len(rawMembers))
        for _, rm := range rawMembers {
                m, ok := rm.(map[string]any)
                if !ok {
                        continue
                }
                ms := func(k string) string {
                        v, _ := m[k].(string)
                        return strings.TrimSpace(v)
                }
                members = append(members, member{ms("type"), ms("name"), ms("desc"), ms("repo"), ms("id")})
        }
        sort.SliceStable(members, func(i, j int) bool {
                if order[members[i].typ] != order[members[j].typ] {
                        return order[members[i].typ] < order[members[j].typ]
                }
                return members[i].name < members[j].name
        })
        if len(members) > 60 {
                members = members[:60]
        }
        label := name
        if label == "" {
                label = id
        }
        var sb strings.Builder
        sb.WriteString("THE ATTACHED BUNDLE — " + label)
        if tag != "" {
                sb.WriteString(" (#" + tag + ")")
        }
        sb.WriteString(" — " + strconv.Itoa(len(rawMembers)) + " members\n")
        sb.WriteString("The user attached this WHOLE bundle instead of one member. For EVERY request:\n")
        sb.WriteString("1. Review the members below against the task BEFORE answering.\n")
        sb.WriteString("2. Decide which member(s) fit the work best — never guess or answer from memory when a member covers it. The descriptions state WHEN each member fires; pick the smallest fitting one, never the whole bundle at once.\n")
        sb.WriteString("3. LOAD the pick BEFORE starting: call the skills tool with action \"load\" + the skill name, or the hublib tool with action \"download\" + its type/repo/id from the manifest lines — as a native tool call when your tools are offered as functions, or as an `ACTION: <tool> {<json>}` line on text-protocol chats.\n")
        sb.WriteString("4. Follow the loaded member to the letter, and say briefly WHICH member you used and why.\n")
        if wf := superpowersWorkflowBlock(id, true); wf != "" {
                sb.WriteString(wf)
        }
        sb.WriteString("Members:\n")
        for _, m := range members {
                sb.WriteString("· " + m.typ + " — " + m.name)
                if m.desc != "" {
                        d := m.desc
                        if len(d) > 140 {
                                d = d[:140] + "…"
                        }
                        sb.WriteString(" — " + d)
                }
                if m.repo != "" && m.id != "" {
                        sb.WriteString(" [" + m.repo + " / " + m.id + "]")
                }
                sb.WriteString("\n")
        }
        return sb.String()
}
