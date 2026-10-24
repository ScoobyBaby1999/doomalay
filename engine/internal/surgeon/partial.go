// partial.go — v1.74.2 THE SURGEON'S OATH: the partial-apply contract.
//
// The researched law (aider's apply_updates, Apache-2.0): an edit batch
// with one bad block applies the GOOD blocks, commits them, and answers
// ONE honest re-ask for the failed blocks —
//
//   - the failed block echoed,
//   - "did you mean these actual lines" (the nearest content window by
//     line similarity — not a common-prefix guess),
//   - "the new text is already in the file" (the classic double-apply
//     case: a retry after a phantom failure should VERIFY, not re-send),
//   - "the other N blocks applied — don't re-send them" (the model
//     sends ONLY the fixed block).
//
// aider's polyglot data: the re-ask loop is what rescues mid models
// (chatgpt-4o: 64% well-formed → 45% task pass ONLY through this
// contract). The old engine was all-or-nothing: one bad edit aborted
// the whole call, nothing landed, and the model re-sent EVERYTHING —
// the "create patches and fix mistakes that shouldn't happen" disease.
package surgeon

import (
	"fmt"
	"strings"
)

// EditOutcome — one edit's verdict in a partial apply.
type EditOutcome struct {
	Index      int     // 0-based edit position
	OK         bool    // the edit landed
	Mode       string  // "exact" | "indent-flex" | "elision" | "fuzzy"
	Count      int     // occurrences replaced
	Confidence float64 // the fuzzy rung's average ratio (0 otherwise)
	Err        string  // the re-ask diagnostic ("" when OK)
}

// PartialResult — the whole batch's verdict.
type PartialResult struct {
	Content  string         // the content with every SUCCESSFUL edit applied
	Outcomes []EditOutcome  // per-edit, in order
	Applied  int            // how many landed
	Failed   int            // how many did not
}

// ApplyEditsPartial applies every edit that lands, skips the ones that
// don't (a failed edit NEVER aborts the batch), and carries per-edit
// re-ask diagnostics for the failures. Edits apply sequentially — edit
// N sees edit N-1's output (the contract stays).
func ApplyEditsPartial(content string, edits []EditSpec) PartialResult {
	res := PartialResult{Content: content, Outcomes: make([]EditOutcome, 0, len(edits))}
	if len(edits) == 0 {
		res.Outcomes = append(res.Outcomes, EditOutcome{Index: 0, Err: `no edits given — pass edits: [{"old":"…","new":"…"}]`})
		res.Failed = 1
		return res
	}
	for i, e := range edits {
		next, outcome := applyOnePartial(res.Content, i, e)
		res.Outcomes = append(res.Outcomes, outcome)
		if outcome.OK {
			res.Content = next
			res.Applied++
		} else {
			res.Failed++
		}
	}
	return res
}

// applyOnePartial — the full leniency ladder for ONE edit, with the
// honest re-ask diagnostic on a miss.
func applyOnePartial(content string, index int, spec EditSpec) (string, EditOutcome) {
	e := normalizeEditSpec(spec)
	out := EditOutcome{Index: index}
	if strings.TrimSpace(e.Old) == "" {
		out.Err = fmt.Sprintf("edit %d: \"old\" is empty — a patch REPLACES existing text; to create a file, write its full content (the commit verb's content field); to insert at a point, include the surrounding lines in old", index+1)
		return content, out
	}
	// 2. EXACT
	if offsets := allIndexes(content, e.Old); len(offsets) > 0 {
		chosen, err := chooseOffsets(offsets, e, index)
		if err != nil {
			out.Err = fmt.Sprintf("edit %d: %v", index+1, err)
			return content, out
		}
		out.OK, out.Mode, out.Count = true, "exact", len(chosen)
		return replaceExact(content, chosen, len(e.Old), e.New), out
	}
	// 3. INDENT-FLEX
	rewritten, lineIdx, bases, oldLineCount, oldFirstIndent, err := flexMatch(content, e.Old)
	if err == nil {
		chosen, cerr := chooseOffsets(lineIdx, e, index)
		if cerr != nil {
			out.Err = fmt.Sprintf("edit %d: %v", index+1, cerr)
			return content, out
		}
		out.OK, out.Mode, out.Count = true, "indent-flex", len(chosen)
		texts := make([]string, len(chosen))
		for k, li := range chosen {
			texts[k] = reindentText(e.New, oldFirstIndent, bases[li])
		}
		return replaceLines(rewritten, chosen, oldLineCount, texts), out
	}
	// 4. ELISION (aider's `...` rung)
	if next, ok := elisionApply(content, e); ok {
		out.OK, out.Mode, out.Count = true, "elision", 1
		return next, out
	}
	// 5. FUZZY (bounded, reported)
	if at, ratio, ok := fuzzyWindow(content, e.Old); ok {
		lines := strings.Split(content, "\n")
		n := len(splitLinesOr(e.Old))
		newLines := strings.Split(strings.TrimSuffix(e.New, "\n"), "\n")
		merged := append(append([]string{}, lines[:at]...), newLines...)
		merged = append(merged, lines[at+n:]...)
		out.OK, out.Mode, out.Count = true, "fuzzy", 1
		out.Confidence = ratio
		return strings.Join(merged, "\n"), out
	}
	// MISS — the re-ask diagnostic (aider's contract)
	out.Err = missDiagnostic(content, e, index)
	return content, out
}

func splitLinesOr(s string) []string {
	lines, _ := splitLines(s)
	return lines
}

// missDiagnostic — the honest re-ask for a failed edit: the failed old
// echoed (clamped), the file's ACTUAL lines around the nearest window,
// and the already-applied hint when the new text is already present.
func missDiagnostic(content string, e EditSpec, index int) string {
	var b strings.Builder
	fmt.Fprintf(&b, "edit %d did not apply — old text not found (exact, whitespace-flexible, elision and fuzzy all failed)", index+1)
	if echo := strings.TrimSpace(e.Old); echo != "" {
		if len(echo) > 300 {
			echo = echo[:300] + "…"
		}
		fmt.Fprintf(&b, "\n  your \"old\" text:\n    %s", strings.ReplaceAll(echo, "\n", "\n    "))
	}
	if start, window, ok := nearestWindow(content, e.Old, 2); ok {
		fmt.Fprintf(&b, "\n  the file's actual lines around the closest match (lines %d–%d):\n%s", start, start+len(window)-1, indentBlock(NumberLines(window, start)))
	} else if line, at := nearestLine(content, e.Old); at >= 0 {
		fmt.Fprintf(&b, "\n  the closest line in the file is line %d: %q", at+1, line)
	}
	if len(e.New) >= 12 && strings.Contains(content, e.New) {
		b.WriteString("\n  NOTE: the \"new\" text is ALREADY in the file — this edit looks already applied; verify the current state instead of re-sending it.")
	}
	b.WriteString("\n  re-read the file with a range around the target and copy the text verbatim.")
	return b.String()
}

func indentBlock(s string) string {
	lines := strings.Split(s, "\n")
	for i, ln := range lines {
		lines[i] = "    " + ln
	}
	return strings.Join(lines, "\n")
}

// nearestLine — the single best line by similarity (the fallback when
// no window scores; the old common-prefix heuristic's replacement).
func nearestLine(content, old string) (string, int) {
	probe := ""
	for _, l := range strings.Split(old, "\n") {
		if strings.TrimSpace(l) != "" {
			probe = strings.TrimSpace(l)
			break
		}
	}
	if probe == "" {
		return "", -1
	}
	best, bestScore, bestIdx := "", 0.0, -1
	for i, cl := range strings.Split(content, "\n") {
		t := strings.TrimSpace(cl)
		if t == "" {
			continue
		}
		s := lineSimilarity(probe, t)
		if s > bestScore {
			best, bestScore, bestIdx = t, s, i
		}
	}
	if bestIdx < 0 || bestScore < 0.4 {
		return "", -1
	}
	return truncate(best, 120), bestIdx
}

// ReportLines renders the per-edit verdicts + aider's don't-re-send law —
// the shared tail of the patch verbs' observations (workspace patch /
// commit, termux patch): the applied edits as one-liners, then each
// failed edit's full re-ask block, then "the other N applied — don't
// re-send them".
func (p PartialResult) ReportLines() string {
        var b strings.Builder
        for _, o := range p.Outcomes {
                if !o.OK {
                        continue
                }
                mode := o.Mode
                if mode == "fuzzy" {
                        mode = fmt.Sprintf("fuzzy %.0f%% — verify the result", o.Confidence*100)
                }
                fmt.Fprintf(&b, "edit %d: %s match, %d replacement(s)\n", o.Index+1, mode, o.Count)
        }
        for _, o := range p.Outcomes {
                if o.OK {
                        continue
                }
                fmt.Fprintf(&b, "%s\n", o.Err)
        }
        if p.Failed > 0 && p.Applied > 0 {
                fmt.Fprintf(&b, "the other %d edit(s) APPLIED — do NOT re-send them; send only the fixed edit(s) above.\n", p.Applied)
        }
        return b.String()
}
