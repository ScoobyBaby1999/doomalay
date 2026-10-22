package server

// ocservereconcile.go — v1.63.3 THE UNLOST TAIL (the engine-death half).
//
// THE CONVICTION (the user's words): "long chats get preserved malformed,
// with messages unordered, the bottom chunk of tools and reasoning calls
// after the final response doesn't save and gets lost." An Android engine
// kill mid-turn ends the engine's event log MID-STREAM while the serve —
// wake-locked in Termux — COMPLETES the turn. The boot heal then splices
// an "interrupted by engine restart" terminal (plus v1.52.3's synthesized
// never-ran tool results) over the dangling window, and the next
// continue/send interleaves with the splice → the unordered, tail-less
// transcript the user reopens.
//
// THE FIX — THE SERVE TRUTH RECONCILE: at OPEN (the events GET's
// bootstrap shape), a log whose LAST event is the healed terminal + a
// LIVING serve binding means the serve's own durable transcript holds the
// turn's whole truth. The dangling window (the engine's partial rows +
// the synthesized never-ran results + the healed terminal) is REPLACED —
// atomically, in ONE transaction — by the serve's completed turn mapped
// into the engine's event grammar: reasoning → thinking rows, tool parts
// → tool_use/tool_result pill pairs, text → assistant round rows, the
// idle marker → the honest terminal. The recovered transcript lands
// BEFORE the terminal's position, whole and ordered; "this call never
// ran" lies die; the user's reopened chat shows what the model ACTUALLY
// did.
//
// THE HONEST DEGRADATION: a dead serve, a missing binding, a turn the
// serve never received, or a turn still running on the serve → NO splice;
// today's healed log stands (the interrupted state is the truth). The
// next open retries (idempotent: the trigger is the healed terminal
// being the LAST event — a spliced log ends in a REAL terminal and never
// re-arms).

import (
        "encoding/json"
        "log"
        "strings"
        "sync"

        "github.com/ScoobyBaby1999/doomalay/engine/internal/ocserve"
        "github.com/ScoobyBaby1999/doomalay/engine/internal/store"
)

// ocServeReconcileMu serializes reconciles (two racing opens must not
// double-splice; the loser re-checks the trigger under the lock).
var ocServeReconcileMu sync.Mutex

// ocServeHealedTerminal answers whether ev is the boot heal's terminal
// (the splice trigger — the exact bytes healInterruptedTurns writes).
func ocServeHealedTerminal(ev *store.Event) bool {
        if ev == nil || ev.EventType != "status" {
                return false
        }
        var p struct {
                State   string `json:"state"`
                Healed  bool   `json:"healed"`
                Message string `json:"message"`
        }
        if json.Unmarshal([]byte(ev.Content), &p) != nil {
                return false
        }
        return p.State == "error" && p.Healed && strings.Contains(p.Message, "interrupted by engine restart")
}

// ocServeReconcileIfHealed runs THE SERVE TRUTH RECONCILE for a chat the
// user just opened. Bounded + best-effort: any miss (no binding, dead
// serve, still-running turn, transcript walk failure) answers false and
// the caller serves today's log untouched. The whole check+fetch+splice
// is one serialized unit; a log that was already reconciled (its last
// event is a REAL terminal) never re-arms.
func (s *Server) ocServeReconcileIfHealed(sessionID string) bool {
        if s.db == nil || sessionID == "" {
                return false
        }
        ocServeReconcileMu.Lock()
        defer ocServeReconcileMu.Unlock()

        // (1) THE TRIGGER: the last event is the healed terminal (the user has
        // not sent since the heal — nothing past it may be replaced).
        tail, err := s.db.ListEventsTail(sessionID, 1)
        if err != nil || len(tail) == 0 || !ocServeHealedTerminal(tail[0]) {
                return false
        }

        // (2) THE BINDING + A LIVING SERVE (the peek law: an open never BOOTS
        // a bridge — a cold serve answers "not now", the next open retries).
        binding := s.ocServeBindingGet(sessionID)
        if binding == "" {
                return false
        }
        m := s.ocServeManagerNow()
        if m == nil || !m.Healthy() {
                return false
        }
        if !m.SessionExists(binding) {
                return false
        }

        // (3) THE TURN WINDOW: the last user row bounds the dangling turn
        // (the same boundary the boot heal walks). Its created-ms anchors the
        // transcript match (the serve's own last user message must be THIS
        // turn's prompt — a fresh-session opening text makes content matching
        // unreliable; both clocks are the same machine's).
        events, err := s.db.ListEventsTail(sessionID, 20001)
        if err != nil || len(events) == 0 {
                return false
        }
        afterUserSeq, userAtMs := 0, int64(0)
        for i := len(events) - 1; i >= 0; i-- {
                if events[i].EventType == "user" {
                        afterUserSeq = events[i].Seq
                        userAtMs = int64(events[i].CreatedAt * 1000)
                        break
                }
        }
        if afterUserSeq == 0 {
                return false // no turn boundary in the window — nothing to splice safely
        }

        // (4) THE SERVE'S TRUTH (chronological). The newest entry must be an
        // IDLE marker (the turn COMPLETED on the serve) whose last user
        // message is this turn's prompt (time-anchored, 5s grace for the
        // prompt's dispatch latency).
        msgs, err := m.ListSessionMessages(binding, 4)
        if err != nil || len(msgs) == 0 {
                log.Printf("ocserve reconcile %s: transcript walk failed (%v) — the healed log stands", sessionID, err)
                return false
        }
        lastUser := -1
        for i := len(msgs) - 1; i >= 0; i-- {
                if msgs[i].Type == "user" {
                        lastUser = i
                        break
                }
        }
        if lastUser < 0 || msgs[lastUser].Time.Created < userAtMs-5000 {
                return false // the serve never got this turn (or holds only older ones)
        }
        newest := msgs[len(msgs)-1]
        if newest.Type != "idle" {
                return false // the serve is still working the turn — the next open retries
        }

        // (5) THE MAPPING: the serve's turn (everything after its user row)
        // becomes engine rows, in order, with the serve's own timestamps.
        rows := ocServeMapTurn(msgs[lastUser+1:])
        if len(rows) == 0 {
                return false
        }

        // (6) THE SPLICE: one transaction — the dangling window dies, the
        // serve's truth lands whole, the terminal is the serve's own verdict.
        inserted, err := s.db.SpliceSessionEvents(sessionID, afterUserSeq, rows)
        if err != nil {
                log.Printf("ocserve reconcile %s: splice failed (%v) — the healed log stands", sessionID, err)
                return false
        }
        log.Printf("ocserve reconcile %s: the serve's completed turn landed whole (%d rows replaced the healed splice)", sessionID, inserted)
        return true
}

// ocServeMapTurn maps the serve's turn entries (chronological, AFTER the
// turn's user message) into the engine's persisted event grammar — the
// EXACT shapes the live pump persists (chat.go's persist switch):
//
//      tool_use  → {"name","summary","args","tool_use_id"}
//      tool_result → {"name","text","tool_use_id"}
//      thinking/assistant → the raw text
//      status  → {"state","usage"} / error → {"message","error"}
//
// The whole-truth law: an unknown entry type degrades to an honest notice
// row, never a silent drop.
func ocServeMapTurn(entries []ocserve.ServeMessage) []store.SpliceEvent {
        var rows []store.SpliceEvent
        add := func(typ, content, toolID string, atMs int64) {
                rows = append(rows, store.SpliceEvent{EventType: typ, Content: persistRedact(typ, content), ToolUseID: toolID, CreatedAtMs: atMs})
        }
        var inTok, outTok, reaTok, cacheRead, cacheWrite int64
        var cost float64
        finish := ""
        for _, msg := range entries {
                switch msg.Type {
                case "assistant":
                        at := msg.Time.Created
                        if msg.Tokens != nil {
                                inTok += msg.Tokens.Input
                                outTok += msg.Tokens.Output
                                reaTok += msg.Tokens.Reasoning
                                cacheRead += msg.Tokens.Cache.Read
                                cacheWrite += msg.Tokens.Cache.Write
                        }
                        if msg.Cost != nil {
                                cost += *msg.Cost
                        }
                        if msg.Finish != "" {
                                finish = msg.Finish
                        }
                        for _, part := range msg.Content {
                                switch part.Type {
                                case "reasoning":
                                        if strings.TrimSpace(part.Text) != "" {
                                                add("thinking", part.Text, "", partTimeMs(part, at))
                                        }
                                case "text":
                                        if strings.TrimSpace(part.Text) != "" {
                                                add("assistant", part.Text, "", partTimeMs(part, at))
                                        }
                                case "tool":
                                        name := ocBareServeToolName(part.Name)
                                        args := "{}"
                                        if part.State != nil && len(part.State.Input) > 0 {
                                                args = string(part.State.Input)
                                        }
                                        if part.ID != "" || name != "" {
                                                b, _ := json.Marshal(map[string]any{
                                                        "name": name, "summary": ocToolSummary(name, args),
                                                        "args": args, "tool_use_id": part.ID,
                                                })
                                                add("tool_use", string(b), part.ID, partTimeMs(part, at))
                                        }
                                        if part.State != nil && (part.State.Status == "completed" || part.State.Status == "error") {
                                                text := ""
                                                if part.State.Status == "error" {
                                                        if part.State.Error != nil && part.State.Error.Message != "" {
                                                                text = part.State.Error.Message
                                                        } else {
                                                                text = "the tool call failed on the serve"
                                                        }
                                                } else {
                                                        var texts []string
                                                        for _, c := range part.State.Content {
                                                                texts = append(texts, c.Text)
                                                        }
                                                        text = strings.Join(texts, "\n")
                                                }
                                                rb, _ := json.Marshal(map[string]any{
                                                        "name": name, "text": text, "tool_use_id": part.ID,
                                                })
                                                add("tool_result", string(rb), part.ID, partTimeMs(part, at))
                                        }
                                default:
                                        // the whole-truth law: an unknown part degrades to an
                                        // honest notice, never a silent drop
                                        nb, _ := json.Marshal(map[string]any{
                                                "message": "recovered from the serve: an unrecognized " + part.Type + " part rode this turn",
                                        })
                                        add("notice", string(nb), "", at)
                                }
                        }
                case "idle":
                        // the terminal — the serve's own verdict, in the EXACT persist
                        // shapes chat.go's switch builds (the replay lift reads these)
                        if msg.Outcome == "failed" || msg.Outcome == "interrupted" {
                                et, em, st := "", "the turn failed on the serve", 0
                                if msg.Error != nil {
                                        et, st = msg.Error.Type, msg.Error.Status
                                        if strings.TrimSpace(msg.Error.Message) != "" {
                                                em = msg.Error.Message
                                        }
                                }
                                if msg.Outcome == "interrupted" {
                                        et, em = "interrupted", "the turn was interrupted on the serve (a stop or shutdown)"
                                }
                                kind := "oc_bridge_error"
                                if et == "provider.auth" || st == 401 {
                                        kind = "oc_bridge_auth"
                                }
                                errObj := map[string]any{"message": em, "error": kind}
                                // v1.61.3's sentinel shape: the free-limit class carries the
                                // retry marker exactly like the live persist switch
                                if st == 429 || strings.Contains(strings.ToLower(em), "free usage limit") || strings.Contains(strings.ToLower(em), "rate limit") {
                                        if kind != "oc_bridge_auth" {
                                                errObj["retry_class"] = "429"
                                                errObj["retry_provider"] = "opencode"
                                        }
                                }
                                eb, _ := json.Marshal(errObj)
                                add("error", string(eb), "", msg.Time.Created)
                                sb, _ := json.Marshal(map[string]any{"state": "error"})
                                add("status", string(sb), "", msg.Time.Created)
                        } else {
                                usage := map[string]any{
                                        "input_tokens": inTok, "output_tokens": outTok,
                                        "total_tokens":    inTok + outTok + reaTok,
                                        "reasoning_tokens": reaTok,
                                        "cache_read":     cacheRead, "cache_write": cacheWrite,
                                        "cost":           cost, "finish_reason": finish, "output_cut": false,
                                }
                                sb, _ := json.Marshal(map[string]any{"state": "idle", "usage": usage})
                                add("status", string(sb), "", msg.Time.Created)
                        }
                case "user":
                        // the turn's prompt echo — the engine logged its own user row
                        // at send time; skip (never duplicate the prompt)
                default:
                        // model-switched and friends: honest notices, never silent drops
                        nb, _ := json.Marshal(map[string]any{
                                "message": "recovered from the serve: a " + msg.Type + " marker rode this turn",
                        })
                        add("notice", string(nb), "", msg.Time.Created)
                }
        }
        return rows
}

// partTimeMs answers the part's own created time when the serve spoke it,
// else the message's (the serve's per-part time rides the live-captured
// shape; older builds may omit it).
func partTimeMs(part ocserve.ServeContentPart, fallback int64) int64 {
        if part.Time != nil && part.Time.Created > 0 {
                return part.Time.Created
        }
        return fallback
}
