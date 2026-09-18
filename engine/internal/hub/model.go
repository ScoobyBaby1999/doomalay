// model.go — the hub item model.
//
// One Item is one library entry. The metadata JSON (items/<id>.json inside
// the publisher's dataset repo) marshals from this struct; the same shape
// serves the HTTP API, the local store's meta column, and the items/index.json
// list (an array of these).
package hub

import (
	"crypto/sha256"
	"encoding/hex"
	"regexp"
	"strings"
	"time"
	"unicode"
)

// Design is an item's card background: either a client-uploaded PNG
// (Kind "png") or a gradient (Kind "gradient") built from 2–3 colors.
// "none" keeps the plain card surface.
type Design struct {
	Kind   string   `json:"kind"`   // "gradient" | "png" | "none"
	Colors []string `json:"colors"` // gradient stops (hex), Kind == "gradient"
}

// Item is one library item (metadata only — the payload lives in its own
// file inside the repo: items/<id><ext>).
type Item struct {
	ID          string   `json:"id"`          // kebab-slug(name) + "-" + 6-hex(sha256(name+author))
	Type        string   `json:"type"`        // persona | template | …
	Name        string   `json:"name"`        // display name (REQUIRED on publish)
	Description string   `json:"description"` // free text
	Author      string   `json:"author"`      // HF username of the publisher
	Repo        string   `json:"repo"`        // "user/doomalay-personas" ("" for local-only rows)
	Tags        []string `json:"tags"`        // sanitized, ≤15 × ≤24 chars
	CreatedAt   string   `json:"createdAt"`   // RFC3339
	UpdatedAt   string   `json:"updatedAt"`   // RFC3339
	Hearts      int      `json:"hearts"`      // endorsements (aggregate; see service.go)
	Downloads   int      `json:"downloads"`   // downloads (aggregate)
	Design      Design   `json:"design"`
	File        string   `json:"file"` // in-repo payload path ("items/<id><ext>")
}

// LocalState is the per-user overlay the engine keeps in hub_items (never
// serialized into the repo — merged into Item at serve time).
type LocalState struct {
	Hearted      bool
	HeartedAt    string
	Downloaded   bool
	DownloadedAt string
}

// slugRun keeps [a-z0-9] runs; everything else collapses into one '-'.
var slugRun = regexp.MustCompile(`[^a-z0-9]+`)

// ItemID derives the stable item id: kebab-slug of the name plus a 6-hex
// digest of slug+author. The digest runs over the SLUG (not the raw name)
// so "Star Captain!!" and "star captain" are the SAME item: same visible
// name under two authors → two ids; same name+author republished → same
// id, so updates replace, never fork.
func ItemID(name, author string) string {
	slug := slugRun.ReplaceAllString(strings.ToLower(strings.TrimSpace(name)), "-")
	slug = strings.Trim(slug, "-")
	if slug == "" {
		slug = "item"
	}
	sum := sha256.Sum256([]byte(slug + "\x00" + author))
	return slug + "-" + hex.EncodeToString(sum[:])[:6]
}

// Tag sanitation limits (spec: 15 tags × 24 chars each).
const (
	MaxTags   = 15
	MaxTagLen = 24
)

// SanitizeTags normalizes a raw tag list into the stored form: lowercase,
// [a-z0-9- ] only (control chars + '#' stripped, whitespace collapsed),
// deduped, capped at 15 tags of 24 chars each.
func SanitizeTags(raw []string) []string {
	seen := map[string]bool{}
	out := make([]string, 0, len(raw))
	for _, tag := range raw {
		var b strings.Builder
		for _, r := range strings.ToLower(strings.TrimSpace(tag)) {
			if r == '#' || unicode.IsControl(r) {
				continue
			}
			if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') || r == '-' || r == ' ' {
				b.WriteRune(r)
			}
		}
		t := strings.Join(strings.Fields(b.String()), " ") // collapse whitespace
		if len(t) > MaxTagLen {
			t = strings.TrimSpace(t[:MaxTagLen])
		}
		if t == "" || seen[t] {
			continue
		}
		seen[t] = true
		out = append(out, t)
		if len(out) >= MaxTags {
			break
		}
	}
	return out
}

// ParseTime parses an Item timestamp into unix seconds (0 on failure) so
// sorters never choke on a malformed remote meta.
func ParseTime(s string) int64 {
	if s == "" {
		return 0
	}
	if t, err := time.Parse(time.RFC3339, s); err == nil {
		return t.Unix()
	}
	return 0
}

// TimeString renders unix seconds as UTC RFC3339 — the same shape HF's
// lastModified uses ("2026-07-29T02:59:16Z").
func TimeString(unixSec int64) string {
	return time.Unix(unixSec, 0).UTC().Format(time.RFC3339)
}

// NowString is the current time in the canonical item-timestamp shape.
func NowString() string { return time.Now().UTC().Format(time.RFC3339) }

// relevance scores one item against a lowercased query:
// 3×name-match + 2×tag-match + 1×description-match (0 = no match).
func relevance(item Item, q string) int {
	if q == "" {
		return 0
	}
	name := strings.ToLower(item.Name)
	desc := strings.ToLower(item.Description)
	score := 0
	if strings.Contains(name, q) {
		score += 3
	}
	for _, tag := range item.Tags {
		if strings.Contains(strings.ToLower(tag), q) {
			score += 2
			break
		}
	}
	if strings.Contains(desc, q) {
		score++
	}
	return score
}
