package server

// compact.go — v0.21 AUTO-COMPACTING (ported from the HF space's
// SlidingWindowConversationManager proactive compression).
//
// WHY: a long chat eventually exceeds the model's context window and the
// provider starts silently dropping the oldest turns (or errors). The HF
// agent solved this with strands' proactive_compression — summarize the
// old turns into a compact summary once the context passes 70%.
//
// HOW (engine side, works on the APK where no Python brain exists):
//   1. Before each turn, estimate the live context (compact summary +
//      events after the compact point) against the model's window.
//   2. Above 70%: summarize the OLDER ~60% of live turns with the SAME
//      model (one non-streaming call), merge into the session's
//      CompactSummary, and advance CompactSeq.
//   3. buildHistoryCompacted then sends [summary] + [recent turns] —
//      nothing overflows, nothing is lost on disk (the FULL event log
//      stays intact; compacting only changes what the model sees).
//
// The summarizer prompt preserves the conversation's task, decisions and
// open threads — the same shape as the HF memory layer's "context for
// the agent".

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"

	"github.com/ScoobyBaby1999/doomalay/engine/internal/llm"
	"github.com/ScoobyBaby1999/doomalay/engine/internal/store"
)

const compactTriggerPct = 70 // of the model's context window
const compactKeepPct = 35    // of the window kept as recent live turns

// maybeCompact summarizes older turns when the context nears the limit.
// Best-effort: every failure path returns the session unchanged.
func (s *Server) maybeCompact(ctx context.Context, conn *websocket.Conn, sess *store.Session, keys map[string]string, llmModel, baseURL, apiKey, authStyle string) *store.Session {
	limit := llm.ContextLimitFor(sess.Model)
	if limit <= 0 {
		return sess
	}
	events, err := s.db.ListEvents(sess.ID, 0)
	if err != nil {
		return sess
	}
	// live tokens = summary + events after the compact point
	var liveChars int
	for _, ev := range events {
		if ev.Seq <= sess.CompactSeq {
			continue
		}
		switch ev.EventType {
		case "user", "assistant", "assistant_delta":
			liveChars += len(ev.Content)
		}
	}
	liveTokens := llm.EstimateTokens(sess.CompactSummary) + llm.EstimateTokensN(liveChars)
	if liveTokens*100 < limit*compactTriggerPct {
		return sess // plenty of room
	}

	// Need to compact: pick the cut so the KEPT part ≈ compactKeepPct.
	// Walk from the newest event backwards accumulating chars until the
	// kept budget is spent; everything older gets summarized.
	keepTokens := limit * compactKeepPct / 100
	keepChars := keepTokens * 38 / 10
	var kept int
	cutSeq := sess.CompactSeq
	for i := len(events) - 1; i >= 0; i-- {
		ev := events[i]
		if ev.Seq <= sess.CompactSeq {
			break
		}
		kept += len(ev.Content)
		cutSeq = ev.Seq
		if kept > keepChars {
			break
		}
	}
	if cutSeq <= sess.CompactSeq {
		return sess // nothing new to fold
	}

	// Gather the older turns (post-compact, pre-cut) as the summarizer input.
	var older []llm.Message
	for _, ev := range events {
		if ev.Seq <= sess.CompactSeq || ev.Seq >= cutSeq {
			continue
		}
		switch ev.EventType {
		case "user":
			older = append(older, llm.Message{Role: "user", Content: ev.Content})
		case "assistant":
			older = append(older, llm.Message{Role: "assistant", Content: ev.Content})
		case "assistant_delta":
			if n := len(older); n > 0 && older[n-1].Role == "assistant" && !older[n-1].FoldedDone {
				older[n-1].Content += ev.Content
			} else {
				older = append(older, llm.Message{Role: "assistant", Content: ev.Content, FoldedDone: true})
			}
		}
	}
	if len(older) < 4 {
		return sess // too small to be worth a summary round
	}
	// Cap the summarizer input (should fit — it's below the trigger).
	var sb strings.Builder
	for _, m := range older {
		sb.WriteString(m.Role + ": " + m.Content + "\n")
		if sb.Len() > 400_000 {
			break
		}
	}

	sumReq := llm.ChatRequest{
		Model:    llmModel,
		Provider: sess.Provider,
		Messages: []llm.Message{
			{Role: "system", Content: "You are a conversation summarizer. Produce a dense, factual summary that preserves: the user's goals and constraints, decisions made, key facts and numbers, artifacts/files mentioned, and any open questions or unfinished threads. Write it as compact notes a fresh assistant could continue from. No preamble."},
			{Role: "user", Content: "Summarize this earlier conversation:\n\n" + sb.String()},
		},
		Effort:    "low",
		APIKey:    apiKey,
		BaseURL:   baseURL,
		AuthStyle: authStyle,
	}
	sumCtx, cancel := context.WithTimeout(ctx, 90*time.Second)
	defer cancel()
	summary, err := llm.CompleteSync(sumCtx, sumReq, nil)
	if err != nil || strings.TrimSpace(summary) == "" {
		// best-effort: skip this cycle, try again next turn
		return sess
	}
	summary = clampServer(summary, 12_000)

	// merge with any earlier summary
	if sess.CompactSummary != "" {
		sess.CompactSummary = sess.CompactSummary + "\n\n---\n\n" + summary
	} else {
		sess.CompactSummary = summary
	}
	sess.CompactSeq = cutSeq - 1
	if err := s.db.UpdateSession(sess); err != nil {
		return sess
	}
	s.emit(conn, sess.ID, "compact",
		fmt.Sprintf(`{"fromSeq":%d,"toSeq":%d,"summaryTokens":%d,"contextLimit":%d}`,
			sess.CompactSeq, cutSeq, llm.EstimateTokens(summary), limit), "")
	return sess
}

// buildHistoryCompacted assembles the model-facing history: the compact
// summary (as a lead-in note) + events after the compact point, folded
// and windowed exactly like buildHistory.
func (s *Server) buildHistoryCompacted(sessionID string, sess *store.Session, window int) []llm.Message {
	var msgs []llm.Message
	if strings.TrimSpace(sess.CompactSummary) != "" {
		msgs = append(msgs, llm.Message{Role: "user", Content: "[conversation so far — compacted summary]\n" + sess.CompactSummary + "\n[end of summary; the messages below are the recent live conversation]"})
	}
	events, err := s.db.ListEvents(sessionID, 0)
	if err != nil {
		return msgs
	}
	var live []llm.Message
	for _, ev := range events {
		if ev.Seq <= sess.CompactSeq {
			continue
		}
		switch ev.EventType {
		case "user":
			live = append(live, llm.Message{Role: "user", Content: ev.Content})
		case "assistant":
			live = append(live, llm.Message{Role: "assistant", Content: ev.Content})
		case "assistant_delta":
			last := len(live) - 1
			if last >= 0 && live[last].Role == "assistant" && !live[last].FoldedDone {
				live[last].Content += ev.Content
			} else {
				live = append(live, llm.Message{Role: "assistant", Content: ev.Content, FoldedDone: true})
			}
		}
	}
	msgs = append(msgs, live...)
	if len(msgs) > window {
		// keep the summary note + the windowed tail
		if len(msgs) > 0 && strings.HasPrefix(msgs[0].Content, "[conversation so far") {
			msgs = append([]llm.Message{msgs[0]}, msgs[len(msgs)-window+1:]...)
		} else {
			msgs = msgs[len(msgs)-window:]
		}
	}
	return msgs
}

// clampServer truncates a string (compact summaries, observations).
func clampServer(s string, max int) string {
	if len(s) <= max {
		return s
	}
	return s[:max] + "…"
}

// RunDelegate is the SWARM FANOUT (ported from the HF space's panel
// delegate): run one prompt through up to `maxDelegates` OTHER models in
// parallel and return their replies. Cloud models void device limits —
// the fan-out costs tokens, never CPU.
func (s *Server) RunDelegate(ctx context.Context, prompt string, modelSlots []string, keys map[string]string) []map[string]any {
	type out struct {
		Model string
		Text  string
		Err   string
	}
	if len(modelSlots) > 3 {
		modelSlots = modelSlots[:3] // cost guard
	}
	results := make([]map[string]any, 0, len(modelSlots))
	var mu sync.Mutex
	var wg sync.WaitGroup
	for _, slot := range modelSlots {
		slot = strings.TrimSpace(slot)
		if slot == "" {
			continue
		}
		provider := ""
		if i := strings.Index(slot, "/"); i > 0 {
			provider = slot[:i]
		}
		wg.Add(1)
		go func(slot, provider string) {
			defer wg.Done()
			res := out{Model: slot}
			defer func() {
				mu.Lock()
				m := map[string]any{"model": slot}
				if res.Err != "" {
					m["error"] = res.Err
				} else {
					m["text"] = clampServer(res.Text, 2000)
				}
				results = append(results, m)
				mu.Unlock()
			}()
			if provider == "privatemodeai" {
				// PM's E2E-encrypted API only speaks through the WebView
				// bridge — the Go engine can't call it. Say so instead of
				// a cryptic handshake failure.
				res.Err = "PrivateMode AI is end-to-end encrypted and can only be consulted from a PrivateMode chat — pick another model"
				return
			}
			llmModel, baseURL, _, apiKey, authStyle, err := llm.ResolveModel(slot, provider, keys)
			if err != nil {
				res.Err = err.Error()
				return
			}
			dCtx, cancel := context.WithTimeout(ctx, 90*time.Second)
			defer cancel()
			req := llm.ChatRequest{
				Model:    llmModel,
				Provider: provider,
				Messages: []llm.Message{
					{Role: "system", Content: "You are one delegate in a multi-model consultation. Answer the question directly and concisely."},
					{Role: "user", Content: prompt},
				},
				APIKey:    apiKey,
				BaseURL:   baseURL,
				AuthStyle: authStyle,
			}
			text, err := llm.CompleteSync(dCtx, req, nil)
			if err != nil {
				res.Err = err.Error()
				return
			}
			res.Text = text
		}(slot, provider)
	}
	wg.Wait()
	return results
}
