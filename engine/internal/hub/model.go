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
        "encoding/json"
        "regexp"
        "strings"
        "time"
        "unicode"
)

// Design is an item's card background: either a client-uploaded PNG
// (Kind "png") or a gradient (Kind "gradient") — v0.44: a full gradient
// SPEC (the shared uikit contract: dir + angle + an optional texture
// dataURL). Legacy rows without Dir render exactly as before (the
// client treats a missing dir as "auto" = the old 135° linear sweep).
// "none" keeps the plain card surface.
type Design struct {
        Kind   string   `json:"kind"`            // "gradient" | "png" | "none"
        Colors []string `json:"colors"`          // gradient stops (hex), Kind == "gradient"
        Dir    string   `json:"dir,omitempty"`   // v0.44: uikit dir (whitelist, default "auto")
        Angle  int      `json:"angle,omitempty"` // v0.44: 0–360, meaningful for "diag"
        Tex    string   `json:"tex,omitempty"`   // v0.44: texture dataURL (≤200KB string, "data:image/…")
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
        // v0.52: the optional card icon (a Lucide-style kebab name rendered by
        // web/icons.js — "" renders no icon column) and the optional collection
        // bunch this item belongs to ("superpowers-obra") — items sharing a
        // collection render as ONE grouped listing that opens the members.
        Icon        string   `json:"icon"`
        Collection  string   `json:"collection"`
        // v0.58 (user spec pt 10): templates carry a deterministic stage count
        // — auto-counted from the payload's stages[] at scan/publish time, or
        // the manual override from the publish form. 0 = unknown (never shown).
        StageCount int      `json:"stageCount,omitempty"`
        // v0.60 pt C.8: REPO PUBLISHING — the companion files of a multi-file
        // bundle (repo-relative paths, committed at items/<id>/<path>). The
        // repo view lists them; empty = a plain single-payload item.
        Files  []string `json:"files,omitempty"`
        File   string   `json:"file"` // in-repo payload path ("items/<id><ext>")
}

// CountStages deterministically counts a TEMPLATE payload's stages: a JSON
// body carrying a "stages" array (the superpowers/brain shape) counts its
// entries; markdown-only templates return 0 = unknown (the publish form's
// manual field covers those — v0.58 user spec pt 10).
func CountStages(payload string) int {
        var doc struct {
                Stages []json.RawMessage `json:"stages"`
        }
        if err := json.Unmarshal([]byte(strings.TrimSpace(payload)), &doc); err != nil {
                return 0
        }
        return len(doc.Stages)
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

// SanitizeIcon normalizes a card icon / collection name: lowercase,
// [a-z0-9-] runs (spaces + punctuation collapse into single dashes), so
// "Superpowers Obra!!" and "superpowers-obra" are THE SAME id. Capped at
// 24 chars; empty stays empty (icons/collections are optional).
func SanitizeIcon(raw string) string {
        out := slugRun.ReplaceAllString(strings.ToLower(strings.TrimSpace(raw)), "-")
        out = strings.Trim(out, "-")
        if len(out) > MaxTagLen {
                out = strings.Trim(out[:MaxTagLen], "-")
        }
        return out
}

// SanitizeCollection normalizes a collection id the same way an icon name
// is normalized (kebab, [a-z0-9-], ≤24 chars) so "Superpowers Obra!!" and
// "superpowers-obra" are THE SAME bunch.
func SanitizeCollection(raw string) string { return SanitizeIcon(raw) }

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
