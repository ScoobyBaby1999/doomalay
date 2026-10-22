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
// v1.56.1 THE UNBOUNDED OBSERVATION: the old fixed 256KB floor is
// DEAD. The budget is now the WINDOW's physics ALONE (90% of the
// model's documented window minus what the in-turn history already
// holds) — so a 1M-context model rides a ~3.4MB result WHOLE, a 128K
// model ~437KB, and only a genuinely tiny window (or a history that
// already fills it) ever clamps.
//
// THE FLOOR (never amputate below what the model can carry): the floor
// is now 1MB, but it is CAPPED at a QUARTER of the window's own byte
// size — the floor must never eat a big share of the window it lives
// in (a 32K-context model gets a ~62KB floor, not a 1MB one that would
// overflow its window on the very first big result).
func turnObsBudget(model string, usedTokens int) int {
        limit := ContextLimitFor(model)
        // the window's own byte size (the compact.go heuristic: ≈3.8
        // chars/token — EstimateTokensN's own ratio).
        windowBytes := limit * 38 / 10
        roomTokens := limit*90/100 - usedTokens
        if roomTokens < 0 {
                roomTokens = 0
        }
        budget := roomTokens * 38 / 10
        floorBytes := 1 << 20 // 1 MB — but never more than a quarter of the window
        if quarter := windowBytes / 4; floorBytes > quarter {
                floorBytes = quarter
        }
        if budget < floorBytes {
                return floorBytes
        }
        return budget
}
