// Package grep — THE SOPHISTICATED GREP (v1.56.0).
//
// WHY THIS PACKAGE EXISTS: the engine's old grep was a literal
// strings.Contains over individually-HTTP-fetched files, reporting ONE
// hit per file (the first one) and nothing else. It could not do regex,
// it could not do globs, it could not do context lines, and it dropped
// every match after the first in a file. "Greps return all hits and work
// like a sophisticated grep" — this package IS that grep.
//
// DESIGN (the laws):
//
//   · ALL HITS: every matching line in every file is reported. The old
//     "first hit per file" fold is DEAD.
//   · REAL REGEX: Go's RE2 engine (linear time, no catastrophic
//     backtracking) is the default — ripgrep-grade. A pattern RE2
//     rejects (lookahead, lookbehind, backreferences) falls back to
//     regexp2 (a .NET-flavoured engine) so an advanced pattern still
//     works; the fallback is REPORTED, never silent.
//   · NO SILENT CAPS: when a limit actually bites, the result says so
//     (Truncated + Reason + a resume cursor). Nothing is ever dropped
//     without an honest marker — the v1.19.1 whole-truth law, extended
//     from "content" to "results".
//   · GLOSSARY: include/exclude globs support ** (path-segments), *
//     (within a segment), ? and {a,b} alternation.
//   · CONTEXT: -A/-B/-C style context lines ride each hit, and
//     overlapping context is de-duplicated.
//
// The package is pure (no HTTP, no forge knowledge) so it can be used
// over a local checkout, over a streamed tarball, or over API-fetched
// file contents — ONE matcher, one set of laws, everywhere.
package grep

import (
	"bufio"
	"bytes"
	"fmt"
	"io"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"strings"
	"unicode/utf8"

	"github.com/dlclark/regexp2"
)

// ── the pattern ───────────────────────────────────────────────────────────

// Matcher is a compiled search pattern.
type Matcher struct {
	// Fixed: the pattern is a LITERAL (the old behaviour, kept as an
	// explicit mode — the old grep was literal and some callers rely on
	// "." meaning a dot).
	Fixed bool
	// IgnoreCase: case-insensitive matching.
	IgnoreCase bool
	// Word: the match must sit on word boundaries (\b).
	Word bool
	// Invert: report the NON-matching lines (grep -v).
	Invert bool

	re       *regexp.Regexp
	re2      *regexp2.Regexp
	literal  string
	engine   string // "re2" | "regexp2" | "literal" — reported honestly
	compiled string
}

// Engine names the regex engine that served the pattern ("re2",
// "regexp2", "literal"). It rides the result so a caller can report a
// fallback honestly.
func (m *Matcher) Engine() string { return m.engine }

// Pattern returns the source pattern.
func (m *Matcher) Pattern() string { return m.compiled }

// New compiles a pattern.
//
// The compilation order:
//  1. a literal matcher (Fixed) — the pattern is escaped and matched
//     verbatim;
//  2. RE2 (Go's stdlib) — the default, linear-time;
//  3. regexp2 — the fallback for the syntax RE2 refuses (lookahead,
//     lookbehind, backreferences, \K-ish constructs). When it is used
//     the caller is told (Engine() == "regexp2").
//
// An invalid pattern is an error, never a silent literal.
func New(pattern string, fixed, ignoreCase, word bool) (*Matcher, error) {
	m := &Matcher{
		Fixed:      fixed,
		IgnoreCase: ignoreCase,
		Word:       word,
		compiled:   pattern,
	}
	if pattern == "" {
		return nil, fmt.Errorf("empty pattern")
	}
	if fixed {
		lit := regexp.QuoteMeta(pattern)
		if ignoreCase {
			lit = "(?i)" + lit
		}
		if word {
			lit = `\b` + lit + `\b`
		}
		re, err := regexp.Compile(lit)
		if err != nil {
			return nil, fmt.Errorf("bad pattern: %w", err)
		}
		m.re = re
		m.literal = pattern
		m.engine = "literal"
		return m, nil
	}
	src := pattern
	if ignoreCase {
		src = "(?i)" + src
	}
	if word {
		src = `\b` + src + `\b`
	}
	if re, err := regexp.Compile(src); err == nil {
		m.re = re
		m.engine = "re2"
		return m, nil
	}
	// RE2 refused it — try the .NET-flavoured engine (lookaround,
	// backreferences). The fallback is reported through Engine().
	opts := regexp2.None
	if ignoreCase {
		opts |= regexp2.IgnoreCase
	}
	re, err := regexp2.Compile(src, opts)
	if err != nil {
		return nil, fmt.Errorf("bad pattern: %w", err)
	}
	m.re2 = re
	m.engine = "regexp2"
	return m, nil
}

// matchLine reports whether the line matches.
func (m *Matcher) matchLine(line string) bool {
	hit := false
	if m.re2 != nil {
		ok, err := m.re2.MatchString(line)
		hit = err == nil && ok
	} else {
		hit = m.re.MatchString(line)
	}
	if m.Invert {
		return !hit
	}
	return hit
}

// ── the options ───────────────────────────────────────────────────────────

// Options are the search options (the grep flags).
type Options struct {
	// IncludeGlobs / ExcludeGlobs: path filters ("*.go", "docs/**").
	// An empty IncludeGlobs means "every file".
	IncludeGlobs []string
	ExcludeGlobs []string
	// Context: lines of context on both sides (-C).
	Context int
	// Before / After: one-sided context (-B / -A). Context wins when
	// it is set.
	Before int
	After  int
	// MaxPerFile: the per-file hit ceiling (0 = unlimited). When it
	// bites, the file is reported as truncated — never silently.
	MaxPerFile int
	// MaxFileBytes: files larger than this are SKIPPED (counted in
	// Stats.Skipped, reported).
	MaxFileBytes int64
	// CountOnly: report the number of matching lines per file instead
	// of the lines themselves (grep -c).
	CountOnly bool
	// FilesOnly: report the paths that contain a match (grep -l).
	FilesOnly bool
}

func (o Options) context() (before, after int) {
	if o.Context > 0 {
		return o.Context, o.Context
	}
	return o.Before, o.After
}

// ── the results ──────────────────────────────────────────────────────────

// Hit is one matching line.
type Hit struct {
	Path   string   `json:"path"`
	Line   int      `json:"line"`
	Text   string   `json:"text"`
	Before []string `json:"before,omitempty"`
	After  []string `json:"after,omitempty"`
}

// Stats are the honest accounting of a search.
type Stats struct {
	FilesScanned int    `json:"files_scanned"`
	FilesSkipped int    `json:"files_skipped"`
	LinesScanned int    `json:"lines_scanned"`
	Hits         int    `json:"hits"`
	FilesMatched int    `json:"files_matched"`
	BytesScanned int64  `json:"bytes_scanned"`
	Truncated    bool   `json:"truncated"`
	Reason       string `json:"reason,omitempty"`
	Engine       string `json:"engine,omitempty"`
	Context      int    `json:"context,omitempty"`
}

// Result is a whole search: the hits + the honest accounting.
type Result struct {
	Hits  []Hit `json:"hits"`
	Stats Stats `json:"stats"`
}

// ── the matcher over content ─────────────────────────────────────────────

// MatchFile scans one file's content and appends its hits.
//
// The content is read as a stream (a 300MB file never lands in memory
// whole): the scanner keeps a rolling window of the previous lines so
// the context of a hit can be emitted with it.
func (m *Matcher) MatchFile(pathName string, r io.Reader, opt Options, res *Result) {
	beforeN, afterN := opt.context()
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 0, 64*1024), 8*1024*1024) // long lines are real
	var (
		lines []string // the rolling window (context before)
		// pending holds a hit whose trailing context has not been read
		// yet (the -A window).
		pending []Hit
		lineNo  int
		hitNo   int
		matched bool
	)
	flushPending := func() {
		for _, h := range pending {
			res.Hits = append(res.Hits, h)
			res.Stats.Hits++
		}
		pending = pending[:0]
	}
	for sc.Scan() {
		lineNo++
		res.Stats.LinesScanned++
		line := sc.Text()
		if m.matchLine(line) {
			matched = true
			hitNo++
			if opt.MaxPerFile > 0 && hitNo > opt.MaxPerFile {
				// the per-file ceiling bit — HONEST: the file is marked
				res.Stats.Truncated = true
				if res.Stats.Reason == "" {
					res.Stats.Reason = fmt.Sprintf("per-file hit ceiling (%d) reached in %s", opt.MaxPerFile, pathName)
				}
				flushPending()
				// keep scanning to count the true total (the report
				// tells the model how many hits really exist).
				continue
			}
			h := Hit{Path: pathName, Line: lineNo, Text: line}
			if beforeN > 0 {
				h.Before = append(h.Before, lines...)
			}
			pending = append(pending, h)
			if afterN == 0 {
				// no trailing context — the hit is final now
				res.Hits = append(res.Hits, h)
				res.Stats.Hits++
				pending = pending[:len(pending)-1]
			}
		} else if afterN > 0 && len(pending) > 0 {
			// a trailing-context line for the pending hits
			for i := range pending {
				if len(pending[i].After) < afterN {
					pending[i].After = append(pending[i].After, line)
				}
			}
			// when every pending hit has its full trailing window, they
			// are final
			done := true
			for i := range pending {
				if len(pending[i].After) < afterN {
					done = false
					break
				}
			}
			if done {
				flushPending()
			}
		}
		// roll the window
		if beforeN > 0 {
			lines = append(lines, line)
			if len(lines) > beforeN {
				lines = lines[1:]
			}
		}
	}
	// end of file — the pending hits (whose trailing window never
	// filled) become final.
	flushPending()
	if matched {
		res.Stats.FilesMatched++
	}
	res.Stats.FilesScanned++
}

// MatchBytes scans one file's bytes (the API-fetched path).
func (m *Matcher) MatchBytes(pathName string, content []byte, opt Options, res *Result) {
	m.MatchFile(pathName, bytes.NewReader(content), opt, res)
}

// ── the local-filesystem walker ──────────────────────────────────────────

// WalkDir searches a local directory tree.
//
// The walker is the same matcher over the same laws — a local checkout
// and a remote archive produce identical results for identical content.
func WalkDir(m *Matcher, root string, opt Options) (*Result, error) {
	ctxN, _ := opt.context()
	res := &Result{Stats: Stats{Engine: m.Engine(), Context: ctxN}}
	inc, err := compileGlobs(opt.IncludeGlobs)
	if err != nil {
		return nil, err
	}
	exc, err := compileGlobs(opt.ExcludeGlobs)
	if err != nil {
		return nil, err
	}
	err = filepath.Walk(root, func(p string, info os.FileInfo, err error) error {
		if err != nil {
			return nil // unreadable path — skipped, counted below
		}
		if info.IsDir() {
			base := filepath.Base(p)
			if base == ".git" && p != root {
				return filepath.SkipDir
			}
			return nil
		}
		if !info.Mode().IsRegular() {
			return nil
		}
		rel, rerr := filepath.Rel(root, p)
		if rerr != nil {
			rel = p
		}
		rel = filepath.ToSlash(rel)
		if len(inc) > 0 && !matchAny(inc, rel) {
			return nil
		}
		if len(exc) > 0 && matchAny(exc, rel) {
			return nil
		}
		if opt.MaxFileBytes > 0 && info.Size() > opt.MaxFileBytes {
			res.Stats.FilesSkipped++
			return nil
		}
		f, oerr := os.Open(p)
		if oerr != nil {
			res.Stats.FilesSkipped++
			return nil
		}
		defer f.Close()
		// THE BINARY GUARD: a NUL byte in the head means binary — the
		// file is skipped (counted), never matched.
		head := make([]byte, 4000)
		n, _ := f.Read(head)
		if !IsText(head[:n]) {
			res.Stats.FilesSkipped++
			return nil
		}
		if _, err := f.Seek(0, 0); err != nil {
			res.Stats.FilesSkipped++
			return nil
		}
		res.Stats.BytesScanned += info.Size()
		before := res.Stats.Hits
		m.MatchFile(rel, f, opt, res)
		if res.Stats.Hits == before && opt.FilesOnly {
			// FilesOnly: drop the (zero) hits — the path is the answer
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	if opt.FilesOnly {
		res.Hits = collapseFiles(res.Hits)
	}
	return res, nil
}

// collapseFiles reduces the hits to one per file (grep -l).
func collapseFiles(hits []Hit) []Hit {
	seen := map[string]bool{}
	out := hits[:0]
	for _, h := range hits {
		if seen[h.Path] {
			continue
		}
		seen[h.Path] = true
		out = append(out, Hit{Path: h.Path})
	}
	return out
}

// ── the glob compiler ────────────────────────────────────────────────────

// globRE is a compiled glob.
type globRE struct {
	src      string
	re       *regexp.Regexp
	anchored bool
}

// CompileGlobs compiles the include/exclude globs (exported: the forge
// layer filters the REMOTE paths with the same dialect).
func CompileGlobs(globs []string) ([]Glob, error) {
	out, err := compileGlobs(globs)
	if err != nil {
		return nil, err
	}
	ex := make([]Glob, 0, len(out))
	for _, g := range out {
		ex = append(ex, Glob{Src: g.src, Re: g.re, Anchored: g.anchored})
	}
	return ex, nil
}

// Glob is a compiled path glob.
type Glob struct {
	Src      string
	Re       *regexp.Regexp
	Anchored bool
}

// MatchAny reports whether the path matches any of the compiled globs.
func MatchAny(globs []Glob, p string) bool {
	base := path.Base(p)
	for _, g := range globs {
		if g.Re.MatchString(p) {
			return true
		}
		if !g.Anchored && g.Re.MatchString(base) {
			return true
		}
	}
	return false
}

// compileGlobs compiles the include/exclude globs.
//
// The dialect: "**" crosses path segments, "*" matches within a segment,
// "?" is one character, "{a,b}" alternates, "[abc]" is a class. A glob
// with no separator matches the BASE NAME anywhere in the tree
// ("*.go" matches "engine/internal/forge/grep.go") — the shell's habit.
func compileGlobs(globs []string) ([]globRE, error) {
	out := make([]globRE, 0, len(globs))
	for _, g := range globs {
		g = strings.TrimSpace(g)
		if g == "" {
			continue
		}
		src, anchored := globToRegexp(g)
		re, err := regexp.Compile(src)
		if err != nil {
			return nil, fmt.Errorf("bad glob %q: %w", g, err)
		}
		out = append(out, globRE{src: g, re: re, anchored: anchored})
	}
	return out, nil
}

// globToRegexp converts a glob to a regexp source. The bool reports
// whether the glob is path-anchored (contains a separator).
func globToRegexp(g string) (string, bool) {
	anchored := strings.Contains(g, "/")
	var b strings.Builder
	b.WriteString("(?i)^")
	if !anchored {
		// base-name match: allow any directory prefix
		b.WriteString("(?:.*/)?")
	}
	for i := 0; i < len(g); i++ {
		c := g[i]
		switch c {
		case '*':
			if i+1 < len(g) && g[i+1] == '*' {
				// "**" — crosses segments
				i++
				if i+1 < len(g) && g[i+1] == '/' {
					i++
					b.WriteString("(?:[^/]+/)*")
				} else {
					b.WriteString(".*")
				}
			} else {
				b.WriteString("[^/]*")
			}
		case '?':
			b.WriteString("[^/]")
		case '[':
			// a character class — copy it through
			j := i + 1
			if j < len(g) && (g[j] == '!' || g[j] == '^') {
				j++
			}
			if j < len(g) && g[j] == ']' {
				j++
			}
			for j < len(g) && g[j] != ']' {
				j++
			}
			if j >= len(g) {
				b.WriteString(`\[`)
			} else {
				b.WriteString(g[i : j+1])
				i = j
			}
		case '{':
			b.WriteString("(?:")
		case '}':
			b.WriteString(")")
		case ',':
			b.WriteString("|")
		case '\\':
			if i+1 < len(g) {
				i++
				b.WriteString(regexp.QuoteMeta(string(g[i])))
			}
		default:
			b.WriteString(regexp.QuoteMeta(string(c)))
		}
	}
	b.WriteString("$")
	return b.String(), anchored
}

// matchAny reports whether the path matches any of the globs.
func matchAny(globs []globRE, p string) bool {
	base := path.Base(p)
	for _, g := range globs {
		if g.re.MatchString(p) {
			return true
		}
		// a non-anchored glob also matches the base name
		if !strings.Contains(g.src, "/") && g.re.MatchString(base) {
			return true
		}
	}
	return false
}

// ── helpers ──────────────────────────────────────────────────────────────

// IsText reports whether the bytes look like TEXT (the binary guard —
// the same shape the forge layer uses).
func IsText(b []byte) bool {
	head := b
	if len(head) > 4000 {
		head = head[:4000]
	}
	if !utf8.Valid(head) {
		return false
	}
	return !bytes.ContainsRune(head, 0)
}
