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
