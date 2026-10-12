package server

// toolfold.go — v1.29.4 THE TOOL MEMORY (PLAN-V130 §4).
//
// The disease (the Doobie transcript, the user's words: "kept constantly
// avoiding execution… researching things it should have known and been
// able to research and find much faster… second guess itself all the
// time"): buildHistory/buildHistoryCompacted folded ONLY user/assistant
// events — every tool_use/tool_result was persisted for the UI replay
// but NEVER entered the model's history. Every new turn started
// fact-blind: the model re-read the same files (the transcript re-reads
// timer 769 twice, the scheduleUpdate region twice), re-ran the same
// greps, and narrated its plan instead of acting.
//
// The fix: fold COMPLETE (use → result) tool pairs into the history as
// the exact in-turn wire shape (an assistant message with tool_calls +
// a tool message), so the model's own observations ride the
// conversation. Laws:
//   · ONE pair = ONE window slot (the 40-message window keeps its
//     meaning — a tool exchange is one conversational unit)
//   · per-result clamp at toolFoldBytes with the HONEST marker (totals
//     carried — the model knows when a read was amputated)
//   · Redact() on every folded text (the pasted-PAT hazard never rides
//     the model's context)
//   · the newest toolFoldKeep pairs ride whole; older pairs collapse to
//     ONE-line stubs — the model sees THAT it acted, without the bytes
//   · orphaned uses/results (a turn died mid-call) are skipped —
//     providers validate call→result sequences
//   · "OBSERVATION:\n" prefixes stripped (the in-turn wire law)

import (
        "encoding/json"
        "fmt"
        "strings"

        "github.com/ScoobyBaby1999/doomalay/engine/internal/llm"
        "github.com/ScoobyBaby1999/doomalay/engine/internal/store"
)

const (
        toolFoldKeep  = 12   // newest pairs riding whole (older → one-line stubs)
        toolFoldBytes = 6000 // per-result byte clamp (the marker carries totals)
)

// historySlot — one window-countable unit: a plain message, or a tool
// PAIR (two wire messages — the assistant tool_calls + the tool result —
// counting as ONE conversational slot).
type historySlot struct {
        msgs   []llm.Message
        isTool bool
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
                        slots = append(slots, historySlot{msgs: []llm.Message{{Role: "assistant", Content: ev.Content}}})
                case "assistant_delta":
                        // Pre-v0.13 sessions: fold consecutive deltas into the
                        // previous assistant message (the slot's single message
                        // when it is an unsealed plain assistant).
                        if n := len(slots); n > 0 && !slots[n-1].isTool && len(slots[n-1].msgs) == 1 &&
                                slots[n-1].msgs[0].Role == "assistant" && !slots[n-1].msgs[0].FoldedDone {
                                slots[n-1].msgs[0].Content += ev.Content
                        } else {
                                slots = append(slots, historySlot{msgs: []llm.Message{{Role: "assistant", Content: ev.Content, FoldedDone: true}}})
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
                        slots = append(slots, historySlot{isTool: true, msgs: []llm.Message{
                                {Role: "assistant", ToolCalls: json.RawMessage(calls)},
                                {Role: "tool", ToolCallID: id, Name: u.name, Content: llm.ClampMarked(Redact(text), toolFoldBytes)},
                        }})
                }
        }

        // THE STUB LAW: the newest toolFoldKeep pairs ride whole; older
        // pairs collapse to one assistant line — the model sees that it
        // acted without paying the bytes (and the compaction summary owns
        // the deep past anyway).
        total := 0
        for i := range slots {
                if slots[i].isTool {
                        total++
                }
        }
        seen := 0
        for i := range slots {
                if !slots[i].isTool {
                        continue
                }
                seen++
                if total-seen >= toolFoldKeep {
                        name := ""
                        for _, m := range slots[i].msgs {
                                if m.Role == "tool" && m.Name != "" {
                                        name = m.Name
                                }
                        }
                        slots[i] = historySlot{msgs: []llm.Message{{Role: "assistant",
                                Content: fmt.Sprintf("[ran %s — output omitted (older tool call)]", name)}}}
                }
        }
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
