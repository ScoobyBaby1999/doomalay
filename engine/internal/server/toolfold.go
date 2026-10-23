package server

// toolfold.go — v1.29.4 THE TOOL MEMORY (PLAN-V130 §4) · reworked by
// v1.49 THE UNLOST MIND (PLAN-V149 §2+§4).
//
// The disease (the Doobie transcript, the user's words: "kept constantly
// avoiding execution… researching things it should have known and been
// able to research and find much faster… second guess itself all the
// time"): buildHistory/buildHistoryCompacted folded ONLY user/assistant
// events — every tool_use/tool_result was persisted for the UI replay
// but NEVER entered the model's history. Every new turn started
// fact-blind: the model re-read the same files, re-ran the same greps,
// and narrated its plan instead of acting.
//
// The fix: fold COMPLETE (use → result) tool pairs into the history as
// the exact in-turn wire shape (an assistant message with tool_calls +
// a tool message), so the model's own observations ride the
// conversation. Laws:
//   · ONE pair = ONE window slot (the 40-message window keeps its
//     meaning — a tool exchange is one conversational unit)
//   · v1.50.2 THE ONE TRUTH: results ride WHOLE — the v1.30.4 per-result
//     6,000-byte clamp and the 12-pair stub law are DEAD. They silently
//     deleted the model's own findings on later turns (the trippy loop:
//     "it caught bugs and continuously lost and looped over" them).
//     Context budgeting is NOT this layer's job — the auto-compactor
//     (70% trigger, counts tool_result bytes since v1.29.4) + the count
//     window + the context-aware in-turn guard (nativetools.go) own the
//     budget, in exactly ONE place.
//   · Redact() on every folded text (the pasted-PAT hazard never rides
//     the model's context)
//   · orphaned uses/results (a turn died mid-call) are skipped —
//     providers validate call→result sequences
//   · "OBSERVATION:\n" prefixes stripped (the in-turn wire law)
//   · v1.50.4 THE SINGLE VOICE: assistant_deltas ACCUMULATE into one
//     slot and the full `assistant` event SEALS it (its content is
//     authoritative — it replaces the accumulated prefix). The old
//     first-delta-sealed-itself bug made every later delta its OWN
//     model-history message plus the full event as another copy — a
//     streamed reply rode the model's context N+1 times (in-context
//     self-repetition + window flooding). A reply now rides EXACTLY
//     ONCE.

import (
	"encoding/json"
	"fmt"
	"strings"

	"github.com/ScoobyBaby1999/doomalay/engine/internal/llm"
	"github.com/ScoobyBaby1999/doomalay/engine/internal/store"
)

// historySlot — one window-countable unit: a plain message, or a tool
// PAIR (two wire messages — the assistant tool_calls + the tool result —
// counting as ONE conversational slot).
type historySlot struct {
	msgs   []llm.Message
	isTool bool
}

// isAccumulating reports whether the slot is a single plain assistant
// message still collecting assistant_delta text (not yet sealed by the
// full `assistant` event).
func isAccumulating(s historySlot) bool {
	return !s.isTool && len(s.msgs) == 1 && s.msgs[0].Role == "assistant" && !s.msgs[0].FoldedDone
}

// foldSlots folds an event run into window-countable slots. Events the
// client masked (edit/delete/regenerate hides) never ride.
func foldSlots(events []*store.Event, hidden map[int64]bool) []historySlot {
	var slots []historySlot
	type pendingUse struct{ name, args string }
	var pending []pendingUse
	foldSeq := 0

	for _, ev := range events {
		if hidden[ev.ID] {
			continue
		}
		switch ev.EventType {
		case "user":
			slots = append(slots, historySlot{msgs: []llm.Message{{Role: "user", Content: ev.Content}}})
		case "assistant":
			// v1.50.4: the SEAL. The full event is authoritative —
			// it replaces the accumulating slot's content (the
			// deltas were its prefix) and marks it sealed; a seal
			// with no accumulator opens a sealed slot of its own
			// (the non-streaming provider shape). An EMPTY seal
			// never wipes an accumulator (belt and suspenders —
			// the deltas are the only witness of that text).
			if strings.TrimSpace(ev.Content) == "" {
				continue
			}
			if n := len(slots); n > 0 && isAccumulating(slots[n-1]) {
				slots[n-1].msgs[0].Content = ev.Content
				slots[n-1].msgs[0].FoldedDone = true
			} else {
				slots = append(slots, historySlot{msgs: []llm.Message{{Role: "assistant", Content: ev.Content, FoldedDone: true}}})
			}
		case "assistant_delta":
			// v1.50.4: deltas ACCUMULATE into the previous
			// assistant slot; the old FoldedDone mis-seal made
			// every delta after the first its OWN message — the
			// self-repetition disease.
			if n := len(slots); n > 0 && isAccumulating(slots[n-1]) {
				slots[n-1].msgs[0].Content += ev.Content
			} else {
				slots = append(slots, historySlot{msgs: []llm.Message{{Role: "assistant", Content: ev.Content}}})
			}
		case "tool_use":
			var p struct {
				Name    string `json:"name"`
				Args    string `json:"args"`
				Summary string `json:"summary"`
			}
			if json.Unmarshal([]byte(ev.Content), &p) != nil || p.Name == "" {
				continue // legacy "name summary" shapes carry no args — skip
			}
			pending = append(pending, pendingUse{name: p.Name, args: p.Args})
		case "tool_result":
			var p struct {
				Name string `json:"name"`
				Text string `json:"text"`
			}
			if json.Unmarshal([]byte(ev.Content), &p) != nil {
				continue
			}
			// match the oldest pending use by name; a NAME-LESS
			// result (legacy shapes) falls back to any pending —
			// a NAMED mismatch is an orphan (its use never rode,
			// or died) and must not cross-match
			idx := -1
			for i, u := range pending {
				if u.name == p.Name {
					idx = i
					break
				}
			}
			if idx < 0 && p.Name == "" && len(pending) > 0 {
				idx = 0
			}
			if idx < 0 {
				continue // an orphan result — no use to pair
			}
			u := pending[idx]
			pending = append(pending[:idx], pending[idx+1:]...)
			foldSeq++
			id := fmt.Sprintf("fold%d", foldSeq)
			args := u.args
			if strings.TrimSpace(args) == "" {
				args = "{}"
			}
			calls, err := json.Marshal([]map[string]any{{
				"id":   id,
				"type": "function",
				"function": map[string]any{
					"name":      u.name,
					"arguments": args,
				},
			}})
			if err != nil {
				continue
			}
			text := strings.TrimPrefix(p.Text, "OBSERVATION:\n")
			// v1.50.2: the WHOLE result rides — Redact stays (the
			// pasted-PAT hazard law is security, not truncation),
			// the byte clamp and the stub law are dead.
			slots = append(slots, historySlot{isTool: true, msgs: []llm.Message{
				{Role: "assistant", ToolCalls: json.RawMessage(calls)},
				{Role: "tool", ToolCallID: id, Name: u.name, Content: Redact(text)},
			}})
		}
	}

	// v1.50.2: THE STUB LAW IS DEAD — no "[ran X — output omitted]"
	// collapsing. Every tool pair rides whole; the auto-compactor owns
	// the deep past when the context actually nears its limit (the
	// threshold-driven policy — not a fixed amputation).
	return slots
}

// slotsWindowed flattens the slots into wire messages, keeping the last
// `window` slots (window < 0 = the whole chat — the mind slider's law).
func slotsWindowed(slots []historySlot, window int) []llm.Message {
	if window >= 0 && len(slots) > window {
		slots = slots[len(slots)-window:]
	}
	out := make([]llm.Message, 0, len(slots)*2)
	for _, s := range slots {
		out = append(out, s.msgs...)
	}
	return out
}
