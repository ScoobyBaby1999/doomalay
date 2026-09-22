// grep.go — engine-side filtered grep across ANY forge.
//
// WHY: GitHub's code search needs a token + special media handling and
// Gitea/GitLab/sourcehut/generic have nothing universal. But EVERY forge
// client can walk its tree and fetch files — so a plain "grep" over the
// candidate text files is the universal search. This is the fallback
// Client.Search routes to.
//
// STRATEGY (no artificial caps — pagination, not refusal):
//  1. Tree() the repo root, filter to text-looking blobs (extension
//     allowlist + size ≤ 512KB), sorted smallest-first (cheap hits first)
//  2. Fetch candidates in bounded batches (8 concurrent — the netx
//     transport pools; more just trips provider rate limits and makes
//     everything slower), match case-insensitively
//  3. Stop when `limit` hits were found OR candidates are exhausted
//  4. Report progress + the resume cursor (the unscanned candidate list
//     is returned) so the caller can continue a big grep
//
// The 8-wide batch is a POLITENESS knob, not a capability cap: the scan
// itself covers every candidate file the repo has, however many.
package forge

import (
	"context"
	"path/filepath"
	"sort"
	"strings"
	"sync"
)

// textish: extensions whose blobs are worth grepping (the same list the
// drawer's FileTypes colors; binary extensions are skipped outright).
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

const (
	grepMaxFile    = 512 << 10 // skip blobs > 512KB (lockfiles, generated)
	grepBatchWidth = 8         // concurrent fetches per batch (politeness)
)

// GrepResult carries hits + the resume state for a continuation call.
type GrepResult struct {
	Hits       []SearchHit `json:"hits"`
	Scanned    int         `json:"scanned"`
	Candidates int         `json:"candidates"`
	Complete   bool        `json:"complete"`
	// Remaining: unscanned candidate paths (JSON-joined); pass back via
	// GrepResume to continue. "" when Complete.
	Remaining string `json:"remaining"`
}

// Grep scans the repo for a case-insensitive literal query.
func Grep(ctx context.Context, c *Client, query, ref, token string, limit int) ([]SearchHit, error) {
	limit = clampLimit(limit, 50)
	res, err := grepScan(ctx, c, query, ref, token, limit, nil)
	if err != nil {
		return nil, err
	}
	return res.Hits, nil
}

// GrepResume continues a previous scan from its remaining-candidate list.
func GrepResume(ctx context.Context, c *Client, query, ref, token string, limit int, remaining string) (*GrepResult, error) {
	limit = clampLimit(limit, 50)
	var cand []string
	if remaining != "" {
		cand = strings.Split(remaining, "\n")
	}
	return grepScan(ctx, c, query, ref, token, limit, cand)
}

func grepScan(ctx context.Context, c *Client, query, ref, token string, limit int, prefetched []string) (*GrepResult, error) {
	if strings.TrimSpace(query) == "" {
		return nil, errBadQuery
	}
	q := strings.ToLower(query)

	var candidates []string
	if len(prefetched) > 0 {
		candidates = prefetched
	} else {
		entries, _, err := c.Tree(ctx, "", ref, token)
		if err != nil {
			return nil, err
		}
		for _, e := range entries {
			if e.Type != "blob" || e.Size > grepMaxFile {
				continue
			}
			if !textishExts[strings.ToLower(filepath.Ext(e.Path))] {
				continue
			}
			candidates = append(candidates, e.Path)
		}
		// smallest first — early hits cost the least
		sort.Slice(candidates, func(i, j int) bool { return len(candidates[i]) < len(candidates[j]) })
	}

	var (
		mu       sync.Mutex
		hits     []SearchHit
		scanned  int
		nextCand []string
	)
	stop := false

	for batchStart := 0; batchStart < len(candidates) && !stop; batchStart += grepBatchWidth {
		end := batchStart + grepBatchWidth
		if end > len(candidates) {
			end = len(candidates)
		}
		batch := candidates[batchStart:end]
		var wg sync.WaitGroup
		for _, p := range batch {
			wg.Add(1)
			go func(path string) {
				defer wg.Done()
				if stop {
					return
				}
				fc, err := c.File(ctx, path, ref, "", token)
				if err != nil || fc.Binary || fc.Encoding != "utf8" {
					return
				}
				mu.Lock()
				scanned++
				lines := strings.Split(fc.Content, "\n")
				for i, ln := range lines {
					if strings.Contains(strings.ToLower(ln), q) {
						hits = append(hits, SearchHit{Path: path, Line: i + 1,
							Snippet: clip(strings.TrimSpace(ln), 200)})
						break // first hit per file — the path is the address
					}
				}
				if len(hits) >= limit {
					stop = true
				}
				mu.Unlock()
			}(p)
		}
		wg.Wait()
		// everything not yet scanned is a resume candidate
		if !stop && end < len(candidates) {
			nextCand = candidates[end:]
		} else if stop {
			nextCand = candidates[end:]
		}
	}

	complete := len(hits) < limit && (stop == false) && len(nextCand) == 0
	if stop && len(hits) >= limit {
		complete = false
	}
	if hits == nil {
		hits = []SearchHit{}
	}
	return &GrepResult{
		Hits:     hits,
		Scanned:  scanned,
		Complete: complete,
		Remaining: func() string {
			if complete {
				return ""
			}
			return strings.Join(nextCand, "\n")
		}(),
	}, nil
}

var errBadQuery = &StatusError{Status: 400, Path: "/grep", Body: "empty query"}
