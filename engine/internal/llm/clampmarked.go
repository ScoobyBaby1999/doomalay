package llm

// clampmarked.go — v1.29.4 THE HONEST CLAMP (PLAN-V130 §4).
//
// The old clamp cut at N bytes and appended a bare "…" — the model could
// not know its read was amputated, so it never trusted its own
// observations and re-read files (the Doobie transcript's disease; the
// industry fix is Cline's honest marker: "[command truncated: N more
// chars…]"). ClampMarked carries the totals.

import (
        "fmt"
        "strings"
)

// ClampMarked truncates at n bytes with an honest marker carrying the
// totals (Cline's pattern). Byte-cut like the old clamp (a split rune
// at the boundary is acceptable — the marker follows immediately).
func ClampMarked(s string, n int) string {
        s = strings.TrimSpace(s)
        if len(s) <= n {
                return s
        }
        return s[:n] + fmt.Sprintf("\n[truncated: first %d of %d bytes shown]", n, len(s))
}

// messagesTokens estimates the token weight of a message slice (real BPE
// per content — the v1.14.1 ledger's counter).
func messagesTokens(msgs []Message) int {
        total := 0
        for _, m := range msgs {
                total += EstimateTokens(m.Content)
        }
        return total
}

// turnObsBudget — v1.50.2 THE ONE TRUTH: the in-turn observation budget in
// BYTES. 90% of the model's documented window minus the tokens the in-turn
// history already holds, converted at the compact.go heuristic (≈3.8
// chars/token — EstimateTokensN's own ratio). Floor 24,000: a tiny-window
// model is never worse off than the old fixed ceiling. A generous room on a
// big-window model means the observation rides WHOLE — the whole-return law.
//
// v1.56.0 THE WHOLE TOOL: the floor rises from 24,000 to 256,000 bytes
// (a 256KB tool result now rides WHOLE on any model). The budget is
// still the WINDOW's physics — a 300MB file on a 32K-context model is
// still physics, and the marker says so (ClampMarked carries the
// totals). The floor is what was amputating results on big-context
// models for no reason.
func turnObsBudget(model string, usedTokens int) int {
        const floorBytes = 256 << 10 // 256 KB
        limit := ContextLimitFor(model)
        roomTokens := limit*90/100 - usedTokens
        if roomTokens < 0 {
                roomTokens = 0
        }
        budget := roomTokens * 38 / 10
        if budget < floorBytes {
                return floorBytes
        }
        return budget
}
