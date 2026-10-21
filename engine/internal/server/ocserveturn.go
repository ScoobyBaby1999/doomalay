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
// event vocabulary onto out. THE RECYCLE LAW: a FreeTierError inside the
// turn (a poisoned session — ours never violates the shape, but upstream
// flags evolve) births a fresh serve session with the full opening text
// and retries ONCE; a second wall answers honestly with the bridge's own
// error + terminal (never a silent hang).
func (s *Server) ocServeStreamTurn(ctx context.Context, m *ocserve.Manager, sessionID string, sess *store.Session, userText string, out chan<- map[string]any) error {
	modelID := strings.TrimPrefix(sess.Model, "opencode/")
	for attempt := 0; attempt < 2; attempt++ {
		serveSess, fresh, err := s.ocServeSessionID(m, sess)
		if err != nil {
			return fmt.Errorf("serve bridge session: %w", err)
		}
		text := userText
		if fresh {
			text = s.ocServeOpeningText(sess, userText)
		}
		if err := m.PromptAsync(serveSess, modelID, text); err != nil {
			return fmt.Errorf("serve bridge prompt: %w", err)
		}
		out <- map[string]any{"type": "progress", "session_id": sessionID,
			"message": "OpenCode free bridge: turn in flight (the genuine OpenCode client)"}
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

// ocServePump consumes the serve SSE feed for one turn, mapping frames
// onto the engine's event vocabulary. It returns recycled=true when the
// turn hit OpenCode's free-tier wall (the recycle law's trigger).
func (s *Server) ocServePump(ctx context.Context, m *ocserve.Manager, serveSess, sessionID string, out chan<- map[string]any) (bool, error) {
	partTypes := map[string]string{} // partID → reasoning|text (deltas carry only the id)
	var usage map[string]any
	pump := func(ev ocserve.Event) error {
		switch ev.Type {
		case "message.part.updated":
			p := ev.Properties.Part
			if p.ID == "" {
				return nil
			}
			switch p.Type {
			case "reasoning", "text":
				partTypes[p.ID] = p.Type
			case "tool":
				if p.State == nil {
					return nil
				}
				name := "opencode:" + p.Tool
				switch p.State.Status {
				case "running":
					args := "{}"
					if b, err := json.Marshal(p.State.Input); err == nil {
						args = string(b)
					}
					out <- map[string]any{"type": "tool_use", "session_id": sessionID,
						"name": name, "summary": p.State.Status, "args": args,
						"tool_use_id": p.ID}
				case "completed":
					out <- map[string]any{"type": "tool_result", "session_id": sessionID,
						"name": name, "text": clampServer(p.State.Output, 6000),
						"tool_use_id": p.ID}
				}
			}
		case "message.part.delta":
			if ev.Properties.Field != "text" {
				return nil
			}
			d := ev.Properties.Delta
			if d == "" {
				return nil
			}
			switch partTypes[ev.Properties.PartID] {
			case "reasoning":
				out <- map[string]any{"type": "thinking", "session_id": sessionID, "text": d}
			case "text":
				out <- map[string]any{"type": "assistant_delta", "session_id": sessionID, "text": d}
			}
		case "message.updated":
			info := ev.Properties.Info
			if info.Role == "assistant" && info.Finish != "" {
				usage = map[string]any{
					"input_tokens":     info.Tokens.Input,
					"output_tokens":    info.Tokens.Output,
					"total_tokens":     info.Tokens.Total,
					"reasoning_tokens": info.Tokens.Reasoning,
					"finish_reason":    info.Finish,
					"output_cut":       false,
				}
			}
			if ev.IsFreeTierError() {
				// the wall: the poisoned-session signature
				return errRecycle
			}
		case "session.idle":
			if usage == nil {
				usage = map[string]any{"input_tokens": 0, "output_tokens": 0,
					"total_tokens": 0, "reasoning_tokens": 0, "finish_reason": "stop", "output_cut": false}
			}
			out <- map[string]any{"type": "status", "session_id": sessionID,
				"state": "idle", "usage": usage}
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
