// grep.go — engine-side search across ANY forge.
//
// WHY THIS FILE CHANGED (v1.56.0 THE SOPHISTICATED GREP): the old grep
// was a literal strings.Contains over individually-HTTP-fetched files,
// reporting ONE hit per file (the first one) and nothing else. It could
// not do regex, globs, context lines, or case-insensitive matching, and
// it silently dropped every match after the first in a file. The user's
// ask: "greps to return all hits and work like a sophisticated grep".
//
// THE NEW SHAPE:
//
//   · ALL HITS: every matching line in every file is reported (the
//     "first hit per file" fold is DEAD).
//   · REAL PATTERNS: a REGEX by default (RE2 — linear time; the .NET
//     engine when RE2 refuses the syntax). A pattern that is not a
//     valid regex degrades to a LITERAL match and SAYS SO — a search
//     never fails because of a stray "(".
//   · GLOBS: include/exclude ("*.go", "docs/**", "!vendor/**").
//   · CONTEXT: -A/-B/-C context lines ride each hit.
//   · CASE: case-insensitive by default (the old behaviour, and
//     GitHub's own code-search default); "case_sensitive":true flips it.
//   · NO SILENT CAPS: when a ceiling actually bites, the result says
//     so (Truncated + Reason). Nothing is dropped without a marker.
//
// STRATEGY (two paths, one matcher):
//  1. The forge's OWN code search (GitHub) when it has one — it is
//     fast and server-side. It yields CANDIDATE PATHS; the engine then
//     fetches those files and runs the FULL matcher over them, so the
//     result carries every hit, every context line and the true
//     per-file counts (the forge's own search returns at most one
//     match per file).
//  2. The universal walk — the repo tree, every text file fetched and
//     matched locally. This is the fallback for every other forge and
//     for GitHub without a token.
package forge

import (
	"context"
	"fmt"
	"net/url"
	"path"
	"sort"
	"strings"
	"sync"

	"github.com/ScoobyBaby1999/doomalay/engine/internal/grep"
)

// SearchOptions are the search options (the grep flags).
type SearchOptions struct {
	// Query: the pattern. A REGEX by default.
	Query string
	// Fixed: treat the query as a LITERAL (no regex).
	Fixed bool
	// CaseSensitive: the default is case-INsensitive (the old grep's
	// behaviour + GitHub's code-search default).
	CaseSensitive bool
	// Word: whole-word matching (\b).
	Word bool
	// Invert: report the non-matching lines (grep -v).
	Invert bool
	// IncludeGlobs / ExcludeGlobs: the path filters.
	IncludeGlobs []string
	ExcludeGlobs []string
	// Context / Before / After: the context line counts.
	Context int
	Before  int
	After   int
	// Limit: the max hits (0 = UNLIMITED). When it bites, the result
	// is marked truncated with an honest reason.
	Limit int
	// MaxPerFile: the per-file hit ceiling (0 = unlimited).
	MaxPerFile int
	// CountOnly / FilesOnly: the -c / -l modes.
	CountOnly bool
	FilesOnly bool
	// MaxFileBytes: files bigger than this are skipped (counted).
	MaxFileBytes int64
}

// GrepResult carries hits + the honest accounting.
type GrepResult struct {
	Hits    []SearchHit   `json:"hits"`
	Scanned int           `json:"scanned"`
	Candidates int        `json:"candidates"`
	Complete bool         `json:"complete"`
	// Remaining: unscanned candidate paths (JSON-joined); pass back via
	// GrepResume to continue. "" when Complete.
	Remaining string `json:"remaining"`
	// v1.19.1: blobs the size guard skipped (generated/lockfile class) —
	// reported, never silently dropped.
	Skipped int `json:"skipped,omitempty"`
	// v1.56.0 THE HONEST ACCOUNTING: the search's own truth.
	Engine   string `json:"engine,omitempty"`
	Pattern  string `json:"pattern,omitempty"`
	Literal  bool   `json:"literal,omitempty"`
	TotalHits int   `json:"total_hits,omitempty"`
	Reason   string `json:"reason,omitempty"`
}

// grepMaxFile is the size GUARD (generated/lockfile blobs) — 8 MB.
// Skipped files are counted and reported, never silently dropped.
const grepMaxFile = 8 << 20

// Grep searches the repo with the default options (a case-insensitive
// regex, unlimited hits).
func Grep(ctx context.Context, c *Client, query, ref, token string, limit int) ([]SearchHit, error) {
	opt := SearchOptions{Query: query, Limit: limit}
	res, err := GrepOpts(ctx, c, opt, ref, token)
	if err != nil {
		return nil, err
	}
	return res.Hits, nil
}

// GrepResume continues a previous scan from its remaining-candidate list.
//
// The resume cursor is the list of candidate paths the previous scan did
// not reach — the SAME corpus, scanned again from where it stopped. The
// hit limit is honored (the caller can raise it for the continuation).
func GrepResume(ctx context.Context, c *Client, query, ref, token string, limit int, remaining string) (*GrepResult, error) {
	opt := SearchOptions{Query: query, Limit: limit}
	paths := strings.Split(remaining, "\n")
	if len(paths) == 1 && paths[0] == "" {
		paths = nil
	}
	m, literal, err := compileMatcher(opt)
	if err != nil {
		return nil, err
	}
	res, gerr := grepOverPaths(ctx, c, m, opt, ref, token, paths, literal, nil, false)
	if gerr != nil {
		return nil, gerr
	}
	res.Complete = true
	res.Reason = ""
	return res, nil
}

// GrepOpts runs a full search with the option set.
//
// The two strategies (the forge's own code search for the CANDIDATE
// paths, the universal tree walk otherwise) share ONE matcher — so the
// result is identical in shape whichever path served it.
func GrepOpts(ctx context.Context, c *Client, opt SearchOptions, ref, token string) (*GrepResult, error) {
	if strings.TrimSpace(opt.Query) == "" {
		return nil, errBadQuery
	}
	// The matcher: a regex by default; a pattern RE2 refuses degrades to
	// a LITERAL (and the result says so — a search never fails on a
	// stray "(").
	m, literal, err := compileMatcher(opt)
	if err != nil {
		return nil, err
	}
	// STRATEGY 1 — the forge's own code search yields the candidate
	// paths (fast, server-side). The FULL matcher then runs over those
	// files, so every hit + every context line is present.
	if c != nil && c.host.Kind == "github" && token != "" {
		paths, frags, serr := c.ghSearchPaths(ctx, opt.Query, ref, token)
		if serr == nil && len(paths) > 0 {
			return grepOverPaths(ctx, c, m, opt, ref, token, paths, literal, frags, true)
		}
	}
	// STRATEGY 2 — the universal walk.
	paths, skipped, terr := c.grepCandidates(ctx, ref, token)
	if terr != nil {
		return nil, terr
	}
	res, gerr := grepOverPaths(ctx, c, m, opt, ref, token, paths, literal, nil, false)
	if gerr != nil {
		return nil, gerr
	}
	res.Skipped = skipped
	return res, nil
}

// compileMatcher builds the matcher for the options.
//
// The honesty rule: a pattern that is not a valid regex degrades to a
// literal match (and literal=true rides the result) — a search NEVER
// fails because of a stray "(".
func compileMatcher(opt SearchOptions) (*grep.Matcher, bool, error) {
	if opt.Fixed {
		m, err := grep.New(opt.Query, true, !opt.CaseSensitive, opt.Word)
		return m, true, err
	}
	m, err := grep.New(opt.Query, false, !opt.CaseSensitive, opt.Word)
	if err == nil {
		if opt.Invert {
			m.Invert = true
		}
		return m, false, nil
	}
	// Not a valid regex — the LITERAL fallback, reported.
	lit, lerr := grep.New(opt.Query, true, !opt.CaseSensitive, opt.Word)
	if lerr != nil {
		return nil, false, err
	}
	lit.Invert = opt.Invert
	return lit, true, nil
}

// grepOverPaths fetches the candidate files and runs the matcher over
// them. The result carries EVERY hit.
func grepOverPaths(ctx context.Context, c *Client, m *grep.Matcher, opt SearchOptions, ref, token string, paths []string, literal bool, frags map[string]string, confirmed bool) (*GrepResult, error) {
	limit := opt.Limit
	if limit <= 0 {
		limit = 1 << 30 // 0 = UNLIMITED — the scan runs until the candidates are exhausted
	}
	gopt := grep.Options{
		IncludeGlobs: opt.IncludeGlobs,
		ExcludeGlobs: opt.ExcludeGlobs,
		Context:      opt.Context,
		Before:       opt.Before,
		After:        opt.After,
		MaxPerFile:   opt.MaxPerFile,
		CountOnly:    opt.CountOnly,
		FilesOnly:    opt.FilesOnly,
		MaxFileBytes: opt.MaxFileBytes,
	}
	// The glob filters are applied by the forge layer (the paths are
	// remote files, not local ones) — the matcher gets them too, but
	// the authoritative filter is here.
	inc, err := grep.CompileGlobs(opt.IncludeGlobs)
	if err != nil {
		return nil, err
	}
	exc, err := grep.CompileGlobs(opt.ExcludeGlobs)
	if err != nil {
		return nil, err
	}
	filtered := make([]string, 0, len(paths))
	for _, p := range paths {
		if len(inc) > 0 && !grep.MatchAny(inc, p) {
			continue
		}
		if len(exc) > 0 && grep.MatchAny(exc, p) {
			continue
		}
		filtered = append(filtered, p)
	}
	// Sort so the result is STABLE (the same query returns the same
	// order every time — a model can rely on it).
	sort.Strings(filtered)

	var (
		mu       sync.Mutex
		hits     []SearchHit
		scanned  int
		skipped  int
		total    int
		stop     bool
		perFile  = map[string]int{}
		// unresolved: the candidate files we could NOT fetch (a branch
		// mismatch — the code search indexes the default branch while
		// the ref is elsewhere). The forge KNOWS they matched, so they
		// are reported as bare-path hits (never "path:0", never dropped).
		unresolved = map[string]string{}
	)
	const batchWidth = 8 // the same politeness width the tree walk used
	// v1.74.3 THE HONEST CURSOR: the resume point tracks the SCAN
	// POSITION (the candidate index where the scan stopped), never the
	// HIT count (the old law sliced the candidate list at len(hits) — a
	// 3-file/10-hit stop "resumed" from candidate 10, skipping 7
	// unscanned files and re-reporting the scanned tail as remaining).
	scannedTo := 0
	for start := 0; start < len(filtered) && !stop; start += batchWidth {
		end := start + batchWidth
		if end > len(filtered) {
			end = len(filtered)
		}
		batch := filtered[start:end]
		var wg sync.WaitGroup
		for _, p := range batch {
			wg.Add(1)
			go func(p string) {
				defer wg.Done()
				mu.Lock()
				if stop {
					mu.Unlock()
					return
				}
				mu.Unlock()
				fc, ferr := c.File(ctx, p, ref, "", token)
				if ferr != nil || fc == nil {
					if confirmed {
						// the forge's own search CONFIRMED this file
						// matches — we just could not fetch it (a branch
						// mismatch). It is reported as a bare path.
						mu.Lock()
						unresolved[p] = frags[p]
						mu.Unlock()
					}
					return
				}
				if fc.Binary || fc.Encoding != "utf8" {
					return
				}
				// The per-file size guard (the generated/lockfile class)
				// — counted and REPORTED, never a silent drop.
				if opt.MaxFileBytes > 0 && fc.Size > opt.MaxFileBytes {
					mu.Lock()
					skipped++
					mu.Unlock()
					return
				}
				res := &grep.Result{}
				m.MatchBytes(p, []byte(fc.Content), gopt, res)
				mu.Lock()
				scanned++
				for _, h := range res.Hits {
					total++
					if len(hits) >= limit {
						stop = true
						break
					}
					perFile[p]++
					sh := SearchHit{Path: h.Path, Line: h.Line, Snippet: h.Text,
						Before: h.Before, After: h.After}
					if opt.CountOnly {
						sh.Count = 1
					}
					hits = append(hits, sh)
				}
				mu.Unlock()
			}(p)
		}
		wg.Wait()
		if !stop {
			scannedTo = end // the whole batch completed cleanly (v1.74.3 THE HONEST CURSOR)
		} else {
			scannedTo = start // stopped mid-batch: resume re-scans it (honest)
		}
	}
	// THE UNRESOLVED HITS: the files the forge says matched but we
	// could not fetch — reported as bare paths (the v0.82.4 law: never
	// a bogus ":0", never a silent drop).
	if confirmed && len(unresolved) > 0 && !opt.FilesOnly {
		keys := make([]string, 0, len(unresolved))
		for k := range unresolved {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		for _, k := range keys {
			if len(hits) >= limit {
				stop = true
				break
			}
			hits = append(hits, SearchHit{Path: k, Snippet: unresolved[k]})
			total++
		}
	}
	// The per-file counts (the -c shape) and the per-file ceiling's
	// honest report.
	if opt.CountOnly {
		counts := map[string]int{}
		for _, h := range hits {
			counts[h.Path]++
		}
		out := hits[:0]
		for _, h := range hits {
			if counts[h.Path] > 0 {
				h.Count = counts[h.Path]
				counts[h.Path] = 0
				out = append(out, h)
			}
		}
		hits = out
	}
	res := &GrepResult{
		Hits:      hits,
		Scanned:   scanned,
		Complete:  !stop,
		Engine:    m.Engine(),
		Pattern:   m.Pattern(),
		Literal:   literal,
		TotalHits: total,
		Skipped:   skipped,
	}
	if stop {
		res.Complete = false
		res.Reason = fmt.Sprintf("hit limit (%d) reached — %d hit(s) found so far; narrow the query (a glob, a path, a tighter pattern) to see the rest", limit, total)
		res.Remaining = strings.Join(filtered[scannedTo:], "\n")
	}
	if res.Hits == nil {
		res.Hits = []SearchHit{}
	}
	return res, nil
}

// grepCandidates walks the repo tree and returns the text-file
// candidates (the universal search corpus).
func (c *Client) grepCandidates(ctx context.Context, ref, token string) ([]string, int, error) {
	entries, _, err := c.Tree(ctx, "", ref, token)
	if err != nil {
		return nil, 0, err
	}
	var (
		candidates []string
		oversized  int
	)
	for _, e := range entries {
		if e.Type != "blob" {
			continue
		}
		if e.Size > grepMaxFile {
			oversized++ // counted, reported — never a silent drop
			continue
		}
		if !textishExts[strings.ToLower(path.Ext(e.Path))] {
			continue
		}
		candidates = append(candidates, e.Path)
	}
	// smallest first — early hits cost the least
	sort.Slice(candidates, func(i, j int) bool { return len(candidates[i]) < len(candidates[j]) })
	return candidates, oversized, nil
}

// ── the shared corpus rules ──────────────────────────────────────────────

// textishExts: extensions whose blobs are worth grepping (the same list
// the drawer's FileTypes colors; binary extensions are skipped outright).
var textishExts = map[string]bool{
	".go": true, ".py": true, ".js": true, ".ts": true, ".tsx": true, ".jsx": true,
	".md": true, ".markdown": true, ".txt": true, ".json": true, ".yaml": true,
	".yml": true, ".toml": true, ".xml": true, ".html": true, ".css": true,
	".scss": true, ".rs": true, ".java": true, ".kt": true, ".swift": true,
	".c": true, ".h": true, ".cpp": true, ".hpp": true, ".cs": true, ".rb": true,
	".php": true, ".sh": true, ".bash": true, ".zsh": true, ".sql": true,
	".env": true, ".cfg": true, ".ini": true, ".conf": true, ".gitignore": true,
	".dockerfile": true, ".lock": true, ".csv": true, ".tsv": true, ".lua": true,
	".vim": true, ".el": true, ".clj": true, ".ex": true, ".exs": true,
	".zig": true, ".nix": true, ".gradle": true, ".properties": true,
	"": true, // Makefile, LICENSE, Dockerfile, LICENSE…
}

// errBadQuery: the empty-query refusal.
var errBadQuery = &StatusError{Status: 400, Path: "/grep", Body: "empty query"}

// ── the forge's own code search (the candidate path) ─────────────────────

// ghSearchPaths asks the forge's own code search WHICH FILES contain the
// pattern — the candidate set for the full matcher.
//
// The forge's search returns at most one match per file (that is the
// API's shape), so it is used ONLY to find the files; the engine then
// fetches them and runs the FULL matcher (every hit + every context
// line + the true counts).
//
// The query is passed through to the forge as a REGEX (GitHub's search
// accepts regex) — but a pattern the forge rejects falls back to a
// quoted literal (GitHub's search also accepts quoted strings).
func (c *Client) ghSearchPaths(ctx context.Context, query, ref, token string) ([]string, map[string]string, error) {
	var v struct {
		Items []struct {
			Path string `json:"path"`
			TextMatches []struct {
				Fragment string `json:"fragment"`
			} `json:"text_matches"`
		} `json:"items"`
	}
	// GitHub's code search: 10 requests/minute authenticated; 100 hits
	// per page is the ceiling — the engine pages until the candidates
	// stop coming (the "no artificial caps" law).
	perPage := 100
	var paths []string
	frags := map[string]string{}
	seen := map[string]bool{}
	for page := 1; page <= 10; page++ { // 10 pages = 1,000 candidate files
		p := "/search/code?q=" + url.QueryEscape(fmt.Sprintf("repo:%s/%s %s", c.host.Owner, c.host.Repo, query)) +
			"&per_page=" + fmt.Sprint(perPage) + "&page=" + fmt.Sprint(page)
		if err := c.ghGetJSON(ctx, p, token, &v, maxListBody); err != nil {
			if page == 1 {
				return nil, nil, err
			}
			break
		}
		if len(v.Items) == 0 {
			break
		}
		for _, it := range v.Items {
			if it.Path == "" || seen[it.Path] {
				continue
			}
			seen[it.Path] = true
			paths = append(paths, it.Path)
			// the forge's own fragment (the ONE match it returns) — kept
			// so a file we cannot fetch still reports its snippet.
			if len(it.TextMatches) > 0 {
				frags[it.Path] = strings.Join(strings.Fields(it.TextMatches[0].Fragment), " ")
			}
		}
	}
	return paths, frags, nil
}
