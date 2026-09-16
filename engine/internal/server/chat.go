package server

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"

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

// defaultPersona (v0.20) — the app's default persona: OUR default prompt
// (the artifact protocol) MERGED with the old HF space's system prompt
// style ("Be direct and concise; lead with outcomes", the explicit
// model-identity instruction, tool-use discipline). {model} and
// {provider} placeholders are substituted at composition time so the
// persona always knows exactly which model it currently is — and stays
// correct after mid-conversation model switches.
const defaultPersona = "## Identity\n" +
	"You are {model} (served via {provider}), chatting inside the Doomalay app on the user's own device. " +
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
// v0.20 identity + placeholders):
//
//	[identity line — ALWAYS fresh: the CURRENT model + provider + date,
//	 so a mid-conversation model switch instantly changes who the bot
//	 thinks it is]
//	+ [the chat's persona, or the merged default persona when none]
//	+ [the artifact protocol, unless the persona already carries it]
//
// {model} / {provider} placeholders inside the persona are substituted
// with the live values every turn.
func (s *Server) systemPromptFor(sess *store.Session) string {
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
	b.WriteString(", chatting inside the Doomalay app on the user's own device. ")
	b.WriteString("Today is " + time.Now().Format("Monday, 2 January 2006") + ".")

	persona := strings.TrimSpace(sess.Persona)
	if persona == "" {
		// No custom persona → the app's merged default persona
		// (v0.20: the default prompt + the HF-space identity
		// style, with the live model + provider baked in).
		b.WriteString("\n\n" + substitutePersonaVars(defaultPersona, sess.Model, sess.Provider))
		return b.String()
	}
	b.WriteString("\n\n" + substitutePersonaVars(persona, sess.Model, sess.Provider))
	if !strings.Contains(strings.ToLower(persona), "artifact") {
		// Keep the file-save capability alive under custom personas.
		b.WriteString("\n\n" + artifactSystemPrompt)
	}
	return b.String()
}

// handleChatWS is GET /api/chat?session_id=<id> — the WebSocket chat endpoint.
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

	// Replay existing events (since=0) so a reconnecting PWA sees full history.
	// V0 idempotency: the PWA dedups by seq.
	existing, err := s.db.ListEvents(sessionID, 0)
	if err != nil {
		log.Printf("list events: %v", err)
	} else {
		for _, ev := range existing {
			b, _ := ev.ToJSON()
			if err := conn.WriteMessage(websocket.TextMessage, b); err != nil {
				return
			}
		}
	}

	// Read loop: handle PWA messages (send / stop).
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()

	for {
		_, raw, err := conn.ReadMessage()
		if err != nil {
			return // PWA disconnected
		}
		var msg map[string]any
		if err := json.Unmarshal(raw, &msg); err != nil {
			continue
		}
		msgType, _ := msg["type"].(string)
		switch msgType {
		case "send":
			go s.handleTurn(ctx, conn, sessionID, sess, msg)
		case "stop":
			// v0.19: abort ONLY the in-flight turn(s) for this session.
			// The old cancel() killed the shared read-loop ctx — after ONE
			// stop, every later send on this socket ran with an already-
			// canceled context and died silently (no reply from any model).
			abortTurn(sessionID)
		}
	}
}

// handleTurn runs one chat turn: acquire lock → call brain → persist + forward events → release lock.
func (s *Server) handleTurn(ctx context.Context, conn *websocket.Conn, sessionID string, sess *store.Session, msg map[string]any) {
	// v0.15 (crash fix): this runs in its own goroutine — a panic here
	// would take the whole engine down (dead app, white screen). The
	// recoverMiddleware can't see goroutine panics, so guard locally.
	defer func() {
		if rec := recover(); rec != nil {
			log.Printf("PANIC recovered in turn %s: %v", sessionID, rec)
			s.emit(conn, sessionID, "error", fmtError("panic", "internal error — engine recovered", "", ""), "")
			s.emit(conn, sessionID, "status", `{"state":"error","usage":null}`, "")
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

	// v0 FIX: per-session turn lock, non-blocking acquire, release in defer.
	release, ok := lockSession(sessionID)
	if !ok {
		s.emit(conn, sessionID, "error", `{"error":"busy","message":"agent already processing"}`, "")
		return
	}
	defer release()

	// Persist the user's message immediately (V0 FIX: backend writes
	// events). s.emit persists AND forwards — no separate AppendEvent
	// (v0.13 fix: the direct AppendEvent + emit double-persisted every
	// user message, doubling them in reconstructed history).
	userText, _ := msg["message"].(string)
	s.emit(conn, sessionID, "user", userText, "")

	// v0.15: per-message model/provider overrides ride the send (the
	// frontend sends them on every message now — belt AND suspenders
	// against any staleness). They win over the (fresh) session values.
	if v, ok := msg["provider"].(string); ok && v != "" {
		sess.Provider = v
	}
	if v, ok := msg["model"].(string); ok && v != "" {
		sess.Model = v
	}

	// Build the brain request.
	brainReq := map[string]any{
		"session_id":    sessionID,
		"message":       userText,
		"model":         sess.Model,
		"provider":      sess.Provider,
		"effort":        sess.Effort,
		"mode":          sess.Mode,
		"web_search":    sess.WebSearch,
		"deep_research": sess.DeepResearch,
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

	// Stream from the brain, OR the direct LLM proxy if brain is down.
	// v0.16: the streaming client has no wall-clock cap (reasoning models
	// think for minutes) — this per-turn timeout is the backstop that
	// guarantees the turn lock is always released.
	turnCtx, turnCancel := context.WithTimeout(ctx, 10*time.Minute)
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
			s.emit(conn, sessionID, "status", `{"state":"idle","usage":null}`, "")
		}
	}()
	if s.brain != nil && s.brain.Healthy() {
		s.streamFromBrain(turnCtx, conn, sessionID, sess, brainReq, userText, &terminal)
	} else {
		s.streamFromDirectProxy(turnCtx, conn, sessionID, sess, userText, &terminal)
	}
}

// streamFromBrain proxies the chat turn through the Python brain (full
// agent: Strands, tools, panel, templates). Used when the brain is available.
func (s *Server) streamFromBrain(ctx context.Context, conn *websocket.Conn, sessionID string, sess *store.Session, brainReq map[string]any, userText string, terminal *bool) {
	events, errs, err := s.brain.Chat(ctx, brainReq)
	if err != nil {
		s.emit(conn, sessionID, "error", `{"error":"brain","message":"`+err.Error()+`"}`, "")
		s.emit(conn, sessionID, "status", `{"state":"error","usage":null}`, "")
		return
	}
	s.forwardEvents(ctx, conn, sessionID, sess, userText, events, errs, terminal)
}

// streamFromDirectProxy calls the cloud LLM directly from Go (no Python brain
// needed). Used when the brain is unavailable (e.g. the Android APK). Cloud
// chat only — no local tools, no panel, no templates. But the streaming,
// persistence, and V0 fixes are identical.
//
// v0.13: builds conversation HISTORY from the event log (multi-turn now
// works on the APK), and forwards capabilities (effort / web_search /
// deep_research) into the llm.Chat pipeline.
func (s *Server) streamFromDirectProxy(ctx context.Context, conn *websocket.Conn, sessionID string, sess *store.Session, userText string, terminal *bool) {
	if s.vault == nil {
		s.emit(conn, sessionID, "error", `{"error":"no_vault","message":"secrets vault not initialized"}`, "")
		s.emit(conn, sessionID, "status", `{"state":"error","usage":null}`, "")
		return
	}
	keys := s.vault.AsEnv()
	model := sess.Model
	provider := sess.Provider
	if model == "" || provider == "" {
		s.emit(conn, sessionID, "error", `{"error":"no_model","message":"no model selected for this chat"}`, "")
		s.emit(conn, sessionID, "status", `{"state":"error","usage":null}`, "")
		return
	}

	llmModel, baseURL, _, apiKey, authStyle, err := llm.ResolveModel(model, provider, keys)
	if err != nil {
		s.emit(conn, sessionID, "error", fmtError("model_resolve", err.Error(), provider, model), "")
		s.emit(conn, sessionID, "status", `{"state":"error","usage":null}`, "")
		return
	}

	// v0.13: conversation history — walk the event log, fold consecutive
	// assistant_delta fragments into single assistant messages, keep
	// the last ~40 turns (sliding window, same default as the brain).
	// v0.16: the sliding memory window is per-session (the 'memory' pill in
	// the chat header dropdown cycles it). Default 40 (the brain's old default).
	// v0.21 AUTO-COMPACT (ported from the HF space's proactive compression):
	// summarize older turns when the context nears the model's window.
	sess = s.maybeCompact(ctx, conn, sess, keys, llmModel, baseURL, apiKey, authStyle)

	history := s.buildHistoryCompacted(sessionID, sess, sess.SlidingWindow)
	if sess.SlidingWindow <= 0 {
		history = s.buildHistoryCompacted(sessionID, sess, 40)
	}
	history = append(history, llm.Message{Role: "user", Content: userText})

	// v0.17→v0.19: the system message = identity + persona (or the
	// default prompt) + the artifact protocol — composed fresh each
	// turn so model switches change the identity instantly.
	full := make([]llm.Message, 0, len(history)+1)
	full = append(full, llm.Message{Role: "system", Content: s.systemPromptFor(sess)})
	full = append(full, history...)

	req := llm.ChatRequest{
		Model:        llmModel,
		Provider:     provider,
		Messages:     full,
		Effort:       sess.Effort,
		WebSearch:    sess.WebSearch, // quick chat capability (not bash/app-building)
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
	s.forwardEvents(ctx, conn, sessionID, sess, userText, events, dummyErrs, terminal)
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
	var msgs []llm.Message
	for _, ev := range events {
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
func (s *Server) forwardEvents(ctx context.Context, conn *websocket.Conn, sessionID string, sess *store.Session, userText string, events <-chan map[string]any, errs <-chan error, terminal *bool) {
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
		} else if conn != nil {
			out := map[string]any{
				"i": persisted.ID, "ts": persisted.CreatedAt, "type": "thinking",
				"session_id": sessionID, "seq": persisted.Seq, "text": thinkBuf.String(),
			}
			if b, err := json.Marshal(out); err == nil {
				_ = conn.WriteMessage(websocket.TextMessage, b)
			}
		}
		thinkBuf.Reset()
		lastThinkFlush = time.Now()
	}
	for ev := range events {
		// Normalize the event into the wire format + persist.
		evType, _ := ev["type"].(string)
		// v0.23 NO-SILENCE: progress events are EPHEMERAL — forwarded
		// to the live WS only, never persisted, no i/seq (replay never
		// sees them; the indicator is a live-UI concern).
		if evType == "progress" {
			if conn != nil {
				out := map[string]any{"type": "progress", "session_id": sessionID}
				if t, ok := ev["text"].(string); ok {
					out["text"] = t
				}
				if m, ok := ev["message"].(string); ok {
					out["message"] = m
				}
				if b, err := json.Marshal(out); err == nil {
					_ = conn.WriteMessage(websocket.TextMessage, b)
				}
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
		case "thinking", "assistant_delta", "assistant", "tool_result", "title":
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
		if err := conn.WriteMessage(websocket.TextMessage, b); err != nil {
			return
		}

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

// emit sends a JSON event to the WebSocket (or no-op if conn is nil).
func (s *Server) emit(conn *websocket.Conn, sessionID, evType, content, toolUseID string) {
	persisted, err := s.db.AppendEvent(sessionID, evType, content, toolUseID)
	if err != nil {
		log.Printf("emit persist: %v", err)
		return
	}
	if conn == nil {
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
	_ = conn.WriteMessage(websocket.TextMessage, b)
}
