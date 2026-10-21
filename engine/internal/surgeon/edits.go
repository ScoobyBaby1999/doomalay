// Package surgeon — v1.52.5 THE BLADE: the surgical edit engine.
//
// The user's ask: "We need an unbelibably solid tool for this… the ability
// to edit repos and files and trees surgically." The research (PLAN-V152
// §2.3) settled the shape: the industry pattern is EXACT-MATCH SEARCH/
// REPLACE BLOCKS applied in-memory, then a whole-file write (Claude Code's
// Edit, the official MCP filesystem server's edit_file, Aider's blocks) —
// unified-diff application is the minority pattern and brittle against
// line-number drift in LLM output.
//
// This package is the ONE engine behind every editing surface (the
// workspace tool's patch/commit verbs, the termux tool's patch verb — the
// OOP law: one truth, no twin drift):
//
//   - EXACT match first (byte-for-byte strings.Index);
//   - then the INDENT-FLEX match (whitespace-normalized line matching
//     with re-indentation of the replacement — the MCP filesystem
//     server's documented behavior), because models read code with
//     context-line indentation and sometimes shift it;
//   - multiple occurrences never guess: "all" replaces every match,
//     "occurrence" picks the Nth (1-based), anything else is an honest
//     error with the count;
//   - a miss returns the NEAREST-CONTEXT diagnostic (the closest line by
//     prefix-similarity) so the model can re-read and correct in ONE
//     round instead of blind retries;
//   - DiffPreview renders a unified-style preview for dry-runs.
package surgeon

import (
        "fmt"
        "strings"
)

// EditSpec is one surgical edit: replace Old with New.
type EditSpec struct {
        Old        string // the text to find (must be non-empty)
        New        string // the replacement
        All        bool   // replace EVERY occurrence
        Occurrence int    // 1-based: replace the Nth occurrence
}

// EditReport tells what one edit did (the dry-run and the commit echo it).
type EditReport struct {
        Index  int    // 0-based edit position
        Mode   string // "exact" | "indent-flex"
        Count  int    // occurrences replaced
        At     int    // offset of the first replacement (byte for exact, line for flex)
        OldLen int
        NewLen int
}

// ApplyEdits applies the edits SEQUENTIALLY — edit N sees edit N-1's
// output (the aider/MCP semantics: the order is the contract).
func ApplyEdits(content string, edits []EditSpec) (string, []EditReport, error) {
        if len(edits) == 0 {
                return content, nil, fmt.Errorf("no edits given — pass edits: [{\"old\":\"…\",\"new\":\"…\"}]")
        }
        reports := make([]EditReport, 0, len(edits))
        for i, e := range edits {
                next, report, err := applyOne(content, i, e)
                if err != nil {
                        return content, reports, err
                }
                content = next
                reports = append(reports, report)
        }
        return content, reports, nil
}

func applyOne(content string, index int, e EditSpec) (string, EditReport, error) {
        rep := EditReport{Index: index, OldLen: len(e.Old), NewLen: len(e.New)}
        if strings.TrimSpace(e.Old) == "" {
                return content, rep, fmt.Errorf("edit %d: \"old\" is empty — a patch REPLACES existing text; to create a file, write its full content (the commit verb's content field); to insert at a point, include the surrounding lines in old", index+1)
        }
        // EXACT PATH: byte-for-byte offsets
        if offsets := allIndexes(content, e.Old); len(offsets) > 0 {
                chosen, err := chooseOffsets(offsets, e, index)
                if err != nil {
                        return content, rep, err
                }
                rep.Mode = "exact"
                rep.Count = len(chosen)
                rep.At = chosen[0]
                content = replaceExact(content, chosen, len(e.Old), e.New)
                return content, rep, nil
        }
        // INDENT-FLEX PATH: whitespace-normalized line windows, with the
        // replacement RE-INDENTED to the file's own indentation (the MCP
        // filesystem server's documented behavior — the model may shift the
        // context indentation when it copies code).
        rewritten, lineIdx, bases, oldLineCount, oldFirstIndent, err := flexMatch(content, e.Old)
        if err != nil {
                return content, rep, fmt.Errorf("edit %d: %v", index+1, err)
        }
        chosen, cerr := chooseOffsets(lineIdx, e, index)
        if cerr != nil {
                return content, rep, cerr
        }
        rep.Mode = "indent-flex"
        rep.Count = len(chosen)
        rep.At = chosen[0]
        rep.OldLen = oldLineCount
        texts := make([]string, len(chosen))
        for k, li := range chosen {
                texts[k] = reindentText(e.New, oldFirstIndent, bases[li])
        }
        rep.NewLen = len(texts[0])
        content = replaceLines(rewritten, chosen, oldLineCount, texts)
        return content, rep, nil
}

// chooseOffsets resolves the all/occurrence/nudge contract: a multi-match
// without "all" or "occurrence" never guesses.
func chooseOffsets(offsets []int, e EditSpec, index int) ([]int, error) {
        if len(offsets) > 1 && !e.All && e.Occurrence == 0 {
                return nil, fmt.Errorf("edit %d: \"old\" appears %d times — pass \"all\":true to replace every occurrence, or \"occurrence\":k (1-based) to pick one", index+1, len(offsets))
        }
        if e.Occurrence > len(offsets) {
                return nil, fmt.Errorf("edit %d: \"occurrence\":%d is out of range — \"old\" appears %d times", index+1, e.Occurrence, len(offsets))
        }
        switch {
        case e.All:
                return offsets, nil
        case e.Occurrence > 0:
                return []int{offsets[e.Occurrence-1]}, nil
        default:
                return offsets[:1], nil
        }
}

// replaceExact swaps len(old) bytes at each chosen byte offset for newStr.
func replaceExact(content string, offsets []int, oldLen int, newStr string) string {
        var sb strings.Builder
        prev := 0
        for _, at := range offsets {
                sb.WriteString(content[prev:at])
                sb.WriteString(newStr)
                prev = at + oldLen
        }
        sb.WriteString(content[prev:])
        return sb.String()
}

// replaceLines swaps oldLines consecutive lines at each chosen line index
// for the per-offset replacement text (flexMatch's contract). The split's
// trailing "" element rides as a normal line, so a trailing newline on the
// source survives the swap.
func replaceLines(content string, chosen []int, oldLines int, texts []string) string {
        lines := strings.Split(content, "\n")
        var out []string
        written := 0
        for k, li := range chosen {
                out = append(out, lines[written:li]...)
                out = append(out, strings.Split(texts[k], "\n")...)
                written = li + oldLines
        }
        if written < len(lines) {
                out = append(out, lines[written:]...)
        }
        return strings.Join(out, "\n")
}

// reindentText shifts newStr's lines from old's first-line indentation to
// the file's matched-window indentation (blank lines untouched).
func reindentText(newStr, oldFirstIndent, baseIndent string) string {
        if oldFirstIndent == baseIndent || strings.TrimSpace(newStr) == "" {
                return newStr
        }
        lines := strings.Split(newStr, "\n")
        for i, ln := range lines {
                if strings.TrimSpace(ln) == "" {
                        continue
                }
                if strings.HasPrefix(ln, oldFirstIndent) {
                        lines[i] = baseIndent + strings.TrimPrefix(ln, oldFirstIndent)
                } else {
                        lines[i] = baseIndent + ln
                }
        }
        return strings.Join(lines, "\n")
}

// allIndexes returns every byte offset of needle in hay.
func allIndexes(hay, needle string) []int {
        var out []int
        for i := 0; i+len(needle) <= len(hay); {
                j := strings.Index(hay[i:], needle)
                if j < 0 {
                        break
                }
                at := i + j
                out = append(out, at)
                i = at + 1
        }
        return out
}

// flexMatch finds whitespace-normalized line windows of old in content.
// It returns the rewritten content (each matched window re-indented to
// old's own indentation — a pure whitespace change), the LINE indexes
// where the windows start, the per-window base indentation the FILE used
// (for re-indenting the replacement), the window's line count, and old's
// first-line indent.
func flexMatch(content, old string) (rewritten string, lineIdx []int, bases map[int]string, oldLineCount int, oldFirstIndent string, err error) {
        oldLines, _ := splitLines(old)
        if len(oldLines) == 0 || (len(oldLines) == 1 && strings.TrimSpace(oldLines[0]) == "") {
                return "", nil, nil, 0, "", fmt.Errorf("old text is empty after normalization")
        }
        contentLines := strings.Split(content, "\n")
        norm := func(s string) string { return strings.TrimSpace(s) }
        oldNorm := make([]string, len(oldLines))
        for i, l := range oldLines {
                oldNorm[i] = norm(l)
        }
        var starts []int
        for c := 0; c+len(oldLines) <= len(contentLines); c++ {
                match := true
                for i := range oldLines {
                        if norm(contentLines[c+i]) != oldNorm[i] {
                                match = false
                                break
                        }
                }
                if match {
                        starts = append(starts, c)
                }
        }
        if len(starts) == 0 {
                return "", nil, nil, 0, "", notFoundError(contentLines, oldLines)
        }
        // capture the FILE's indentation of each window BEFORE rewriting
        bases = make(map[int]string, len(starts))
        for _, c := range starts {
                bases[c] = leadingWS(contentLines[c])
        }
        // re-indent every matched window to old's own indentation
        oldFirstIndent = leadingWS(oldLines[0])
        for _, c := range starts {
                base := bases[c]
                for i := range oldLines {
                        cl := contentLines[c+i]
                        if strings.TrimSpace(cl) == "" {
                                continue // blank lines stay blank
                        }
                        shifted := strings.TrimPrefix(cl, base)
                        if shifted == cl { // base wasn't its prefix — fall back to trim
                                shifted = strings.TrimSpace(cl)
                        }
                        contentLines[c+i] = oldFirstIndent + shifted
                }
        }
        rewritten = strings.Join(contentLines, "\n")
        // locate the (now-verbatim) windows as LINE indexes
        for i := 0; i+len(oldLines) <= len(contentLines); {
                found := true
                for j := range oldLines {
                        if contentLines[i+j] != oldLines[j] {
                                found = false
                                break
                        }
                }
                if found {
                        lineIdx = append(lineIdx, i)
                        i += len(oldLines)
                } else {
                        i++
                }
        }
        return rewritten, lineIdx, bases, len(oldLines), oldFirstIndent, nil
}

// notFoundError builds the nearest-context diagnostic: the content line
// most similar to the old text's first meaningful line, by common-prefix
// length after trimming.
func notFoundError(contentLines, oldLines []string) error {
        var probe string
        for _, l := range oldLines {
                if strings.TrimSpace(l) != "" {
                        probe = strings.TrimSpace(l)
                        break
                }
        }
        best, bestScore, bestIdx := "", 0, -1
        for i, cl := range contentLines {
                t := strings.TrimSpace(cl)
                if t == "" {
                        continue
                }
                score := commonPrefixLen(t, probe)
                if score > bestScore {
                        best, bestScore, bestIdx = t, score, i
                }
        }
        if bestIdx < 0 || bestScore < 4 {
                return fmt.Errorf("old text not found (exact and whitespace-flexible both failed) — re-read the file with a range around the target and copy the text verbatim")
        }
        return fmt.Errorf("old text not found (exact and whitespace-flexible both failed) — the closest line in the file is line %d: %q — re-read around it and copy the text verbatim", bestIdx+1, truncate(best, 120))
}

func splitLines(s string) (lines []string, hadTrailingNL bool) {
        hadTrailingNL = strings.HasSuffix(s, "\n")
        lines = strings.Split(strings.TrimSuffix(s, "\n"), "\n")
        return
}

func leadingWS(s string) string {
        for i := 0; i < len(s); i++ {
                if s[i] != ' ' && s[i] != '\t' {
                        return s[:i]
                }
        }
        return s
}

func commonPrefixLen(a, b string) int {
        n := 0
        for n < len(a) && n < len(b) && a[n] == b[n] {
                n++
        }
        return n
}

func truncate(s string, n int) string {
        if len(s) <= n {
                return s
        }
        return s[:n] + "…"
}

// ── DiffPreview ─────────────────────────────────────────────────────

type diffOp struct {
        kind byte // ' ', '-', '+'
        line string
}

// DiffPreview renders a unified-diff-style preview (hunks with 3 context
// lines). Hand-rolled LCS on lines — patches are small; no dependency.
func DiffPreview(old, new string) string {
        a, _ := splitLines(old)
        b, _ := splitLines(new)
        n, m := len(a), len(b)
        lcs := make([][]int, n+1)
        for i := range lcs {
                lcs[i] = make([]int, m+1)
        }
        for i := n - 1; i >= 0; i-- {
                for j := m - 1; j >= 0; j-- {
                        if a[i] == b[j] {
                                lcs[i][j] = lcs[i+1][j+1] + 1
                        } else if lcs[i+1][j] >= lcs[i][j+1] {
                                lcs[i][j] = lcs[i+1][j]
                        } else {
                                lcs[i][j] = lcs[i][j+1]
                        }
                }
        }
        var ops []diffOp
        i, j := 0, 0
        for i < n && j < m {
                switch {
                case a[i] == b[j]:
                        ops = append(ops, diffOp{' ', a[i]})
                        i++
                        j++
                case lcs[i+1][j] >= lcs[i][j+1]:
                        ops = append(ops, diffOp{'-', a[i]})
                        i++
                default:
                        ops = append(ops, diffOp{'+', b[j]})
                        j++
                }
        }
        for ; i < n; i++ {
                ops = append(ops, diffOp{'-', a[i]})
        }
        for ; j < m; j++ {
                ops = append(ops, diffOp{'+', b[j]})
        }
        if len(ops) == 0 {
                return "(no changes)"
        }
        allCtx := true
        for _, o := range ops {
                if o.kind != ' ' {
                        allCtx = false
                        break
                }
        }
        if allCtx {
                return "(no changes)"
        }
        const ctx = 3
        var sb strings.Builder
        idx := 0
        oldLn, newLn := 1, 1
        for idx < len(ops) {
                for idx < len(ops) && ops[idx].kind == ' ' {
                        idx++
                        oldLn++
                        newLn++
                }
                if idx >= len(ops) {
                        break
                }
                start := idx - ctx
                if start < 0 {
                        start = 0
                }
                hOld, hNew := oldLn, newLn
                for k := idx - 1; k >= start; k-- {
                        if ops[k].kind != '+' {
                                hOld--
                        }
                        if ops[k].kind != '-' {
                                hNew--
                        }
                }
                end := idx
                for k := idx; k < len(ops); k++ {
                        if ops[k].kind != ' ' {
                                end = k
                        }
                }
                end += ctx + 1
                if end > len(ops) {
                        end = len(ops)
                }
                oSpan, nSpan := 0, 0
                for k := start; k < end; k++ {
                        if ops[k].kind != '+' {
                                oSpan++
                        }
                        if ops[k].kind != '-' {
                                nSpan++
                        }
                }
                fmt.Fprintf(&sb, "@@ -%d,%d +%d,%d @@\n", hOld, oSpan, hNew, nSpan)
                for k := start; k < end; k++ {
                        sb.WriteByte(ops[k].kind)
                        sb.WriteByte(' ')
                        sb.WriteString(ops[k].line)
                        sb.WriteByte('\n')
                }
                for k := start; k < end; k++ {
                        if ops[k].kind != '+' {
                                oldLn++
                        }
                        if ops[k].kind != '-' {
                                newLn++
                        }
                }
                idx = end
        }
        return strings.TrimSuffix(sb.String(), "\n")
}
