// lenient.go — v1.74.2 THE SURGEON'S OATH: the leniency ladder.
//
// The user's bullet (the wave's heart): "the model always has to find
// workarounds to surgically edit files, it has to create patches and fix
// mistakes that shouldn't happen because the toolset we have for editing
// is bad and we rely too much on a rigid structure. Isn't there some
// open source project/s that can help us with this."
//
// The researched answer (aider Apache-2.0, Roo/Cline Apache-2.0,
// Anthropic's str_replace tool — the research record): the landing rate
// comes from LENIENCY RUNGS in front of the exact match, each one
// honest and reported — never silent fuzzy guessing:
//
//   1. INPUT NORMALIZATION — \r\n → \n on the model's old/new; the
//      cat -n line-number prefixes stripped when EVERY old line carries
//      one (Claude Code's own known failure: models copy the numbered
//      read verbatim into the search block — and we hand them numbered
//      reads on purpose now);
//   2. EXACT (byte-for-byte — unchanged);
//   3. INDENT-FLEX (whitespace-normalized windows, re-indent — the MCP
//      filesystem server's behavior, unchanged);
//   4. ELISION — aider's try_dotdotdots: `...` lines in old pair with
//      `...` in new, each real piece must occur exactly once in order,
//      the in-between content is PRESERVED (the "skip the unchanged
//      middle" shape);
//   5. FUZZY — Roo's compromise: a bounded Levenshtein line-window
//      match (average ratio ≥ 0.90 AND every line ≥ 0.75, best window
//      only), REPORTED as `fuzzy (NN%)` so the model can verify —
//      wrong-place edits stay scarier than re-asks, so the bounds are
//      tight and the report is loud.
package surgeon

import (
	"fmt"
	"strconv"
	"strings"
)

// fuzzyAvgMin / fuzzyLineMin — the bounded-fuzzy admission bounds (the
// research's compromise: fuzzy landing is allowed, silent mis-landing is
// not — Roo's own defaults are stricter still).
const (
	fuzzyAvgMin  = 0.90
	fuzzyLineMin = 0.75
	// fuzzyMaxLines / fuzzyMaxLineLen — the perf bounds: the O(windows×
	// lines×len²) scan only runs on edit blocks small enough to be
	// cheap; a giant block falls through to the honest miss.
	fuzzyMaxLines  = 40
	fuzzyMaxLineLn = 400
)

// normalizeEditSpec cleans the MODEL's inputs (never the file's bytes):
// CRLF → LF, and the cat -n line-number prefixes stripped when every
// non-empty old line carries one.
func normalizeEditSpec(e EditSpec) EditSpec {
	e.Old = strings.ReplaceAll(e.Old, "\r\n", "\n")
	e.New = strings.ReplaceAll(e.New, "\r\n", "\n")
	if old, ok := stripNumberedLines(e.Old); ok {
		e.Old = old
		// the new block carries the same prefixes (the model copied the
		// whole numbered region) — strip them too so the replacement is
		// bare code
		if nw, ok2 := stripNumberedLines(e.New); ok2 {
			e.New = nw
		}
	}
	return e
}

// stripNumberedLines strips `  123│ text` / `123: text` / `123  text`
// prefixes (cat -n shapes) from EVERY non-empty line. ok=false when any
// non-empty line lacks a prefix (a bare block — nothing to strip).
func stripNumberedLines(s string) (string, bool) {
	lines := strings.Split(s, "\n")
	stripped := make([]string, len(lines))
	sawAny := false
	for i, ln := range lines {
		if strings.TrimSpace(ln) == "" {
			stripped[i] = ""
			continue
		}
		rest, ok := stripNumberedPrefix(ln)
		if !ok {
			return s, false
		}
		stripped[i] = rest
		sawAny = true
	}
	if !sawAny {
		return s, false
	}
	return strings.Join(stripped, "\n"), true
}

// stripNumberedPrefix removes one leading `N│` / `N:` / `N␣` (N digits,
// optional right-alignment padding) line-number prefix.
func stripNumberedPrefix(line string) (string, bool) {
	i := 0
	for i < len(line) && (line[i] == ' ' || line[i] == '\t') {
		i++
	}
	start := i
	for i < len(line) && line[i] >= '0' && line[i] <= '9' {
		i++
	}
	if i == start || i-start > 8 {
		return line, false
	}
	// the separator: the multibyte │ (3 UTF-8 bytes), '│'-adjacent box
	// shapes, ':' , '|' , or ≥1 spaces/tab — byte-safe prefix checks
	rest0 := line[i:]
	switch {
	case strings.HasPrefix(rest0, "\u2502"): // │
		i += len("\u2502")
	case strings.HasPrefix(rest0, "|"), strings.HasPrefix(rest0, ":"):
		i++
	case strings.HasPrefix(rest0, " "), strings.HasPrefix(rest0, "\t"):
		for i < len(line) && (line[i] == ' ' || line[i] == '\t') {
			i++
		}
	default:
		return line, false
	}
	// cat -n's separator carries a trailing space (“  5┆ text”); strip the
	// leading whitespace — the flex path re-derives the real indentation.
	rest := strings.TrimLeft(line[i:], " \t")
	if strings.TrimSpace(line) == strings.TrimSpace(strconv.Itoa(0)) {
		// degenerate: the line is JUST a number — not a numbered line
		return line, false
	}
	// the remainder must not itself start with another number+separator
	// (a real code line `123: x` is rare; keep this simple)
	return rest, true
}

// ellipsisLine reports whether the line is a bare `...` elision marker.
func ellipsisLine(ln string) bool {
	return strings.TrimSpace(ln) == "..." || strings.TrimSpace(ln) == "…"
}

// splitOnEllipsis splits s on bare `...` lines (aider's dots_re).
func splitOnEllipsis(s string) []string {
	lines := strings.Split(s, "\n")
	var pieces []string
	var cur []string
	for _, ln := range lines {
		if ellipsisLine(ln) {
			pieces = append(pieces, strings.Join(cur, "\n"))
			cur = nil
			continue
		}
		cur = append(cur, ln)
	}
	pieces = append(pieces, strings.Join(cur, "\n"))
	return pieces
}

// elisionApply — aider's try_dotdotdots: the `...` lines in old pair
// with the `...` lines in new; each real old piece must occur exactly
// once in content, in order; the content BETWEEN the pieces is
// preserved; the result splices the new pieces in their place.
func elisionApply(content string, e EditSpec) (string, bool) {
	oldPieces := splitOnEllipsis(e.Old)
	newPieces := splitOnEllipsis(e.New)
	if len(oldPieces) != len(newPieces) || len(oldPieces) < 2 {
		return content, false
	}
	// every real piece: non-empty (after trim) and exactly once, in order
	positions := make([]int, len(oldPieces))
	prev := 0
	for i, p := range oldPieces {
		if strings.TrimSpace(p) == "" {
			return content, false
		}
		if strings.Count(content, p) != 1 {
			return content, false
		}
		at := strings.Index(content[prev:], p)
		if at < 0 {
			return content, false
		}
		positions[i] = prev + at
		prev = positions[i] + len(p)
	}
	// rebuild: new pieces joined by the ORIGINAL in-between content
	var sb strings.Builder
	sb.WriteString(newPieces[0])
	for i := 1; i < len(oldPieces); i++ {
		sb.WriteString(content[positions[i-1]+len(oldPieces[i-1]) : positions[i]])
		sb.WriteString(newPieces[i])
	}
	head := content[:positions[0]]
	last := len(oldPieces) - 1
	tail := content[positions[last]+len(oldPieces[last]):]
	return head + sb.String() + tail, true
}

// lineSimilarity — the Levenshtein ratio of two trimmed lines (1.0 =
// identical). Bounded inputs (the caller gates on length).
func lineSimilarity(a, b string) float64 {
	a, b = strings.TrimSpace(a), strings.TrimSpace(b)
	if a == b {
		return 1
	}
	la, lb := len(a), len(b)
	if la == 0 || lb == 0 {
		return 0
	}
	// classic two-row DP
	prev := make([]int, lb+1)
	cur := make([]int, lb+1)
	for j := 0; j <= lb; j++ {
		prev[j] = j
	}
	for i := 1; i <= la; i++ {
		cur[0] = i
		for j := 1; j <= lb; j++ {
			cost := 1
			if a[i-1] == b[j-1] {
				cost = 0
			}
			cur[j] = minInt(prev[j]+1, cur[j-1]+1, prev[j-1]+cost)
		}
		prev, cur = cur, prev
	}
	dist := prev[lb]
	return 1 - float64(dist)/float64(maxInt(la, lb))
}

func minInt(vs ...int) int {
	m := vs[0]
	for _, v := range vs[1:] {
		if v < m {
			m = v
		}
	}
	return m
}

func maxInt(a, b int) int {
	if a > b {
		return a
	}
	return b
}

// fuzzyWindow — the bounded fuzzy scan: the best line-window of old's
// line count whose average line similarity ≥ fuzzyAvgMin and whose
// WORST line ≥ fuzzyLineMin. Returns the window's start line index and
// the average ratio.
func fuzzyWindow(content, old string) (start int, ratio float64, ok bool) {
	oldLines, _ := splitLines(old)
	if len(oldLines) == 0 || len(oldLines) > fuzzyMaxLines {
		return -1, 0, false
	}
	for _, ln := range oldLines {
		if len(ln) > fuzzyMaxLineLn {
			return -1, 0, false
		}
	}
	contentLines := strings.Split(content, "\n")
	n := len(oldLines)
	if len(contentLines) < n {
		return -1, 0, false
	}
	best, bestAvg, bestWorst := -1, 0.0, 0.0
	for c := 0; c+n <= len(contentLines); c++ {
		total, worst := 0.0, 1.0
		for i := range oldLines {
			s := lineSimilarity(oldLines[i], contentLines[c+i])
			total += s
			if s < worst {
				worst = s
			}
		}
		avg := total / float64(n)
		if avg > bestAvg {
			best, bestAvg, bestWorst = c, avg, worst
		}
	}
	if best >= 0 && bestAvg >= fuzzyAvgMin && bestWorst >= fuzzyLineMin {
		return best, bestAvg, true
	}
	return -1, bestAvg, false
}

// nearestWindow — the re-ask diagnostic's "did you mean these actual
// lines": the content window whose average line similarity to old is
// highest (aider's SequenceMatcher±lines pattern, Levenshtein edition).
// Returns the window's 1-based start line, its lines, and ok=false when
// nothing scores above the noise floor.
func nearestWindow(content, old string, ctxLines int) (startLine int, window []string, ok bool) {
	oldLines, _ := splitLines(old)
	if len(oldLines) == 0 {
		return 0, nil, false
	}
	contentLines := strings.Split(content, "\n")
	n := len(oldLines)
	if len(contentLines) < n {
		n = len(contentLines) // a taller old than the file: compare per available line
	}
	if n == 0 {
		return 0, nil, false
	}
	best, bestAvg := -1, 0.0
	for c := 0; c+n <= len(contentLines); c++ {
		total := 0.0
		for i := 0; i < n; i++ {
			total += lineSimilarity(oldLines[i], contentLines[c+i])
		}
		avg := total / float64(n)
		if avg > bestAvg {
			best, bestAvg = c, avg
		}
	}
	if best < 0 || bestAvg < 0.35 {
		return 0, nil, false
	}
	from := best - ctxLines
	if from < 0 {
		from = 0
	}
	to := best + n + ctxLines
	if to > len(contentLines) {
		to = len(contentLines)
	}
	return from + 1, contentLines[from:to], true
}

// NumberLines renders lines with cat -n style anchors (the read verbs'
// line_numbers shape — the anchors the str_replace research hands the
// model; the surgeon's normalize rung strips them back out of old
// blocks the model copies verbatim).
func NumberLines(lines []string, startLine int) string {
	var sb strings.Builder
	for i, ln := range lines {
		fmt.Fprintf(&sb, "%6d│ %s\n", startLine+i, ln)
	}
	return strings.TrimSuffix(sb.String(), "\n")
}
