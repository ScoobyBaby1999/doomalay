// Package hub — collections.go (v0.52).
//
// THE BUNCH (user spec, item 1): "Let's add a method to group or bunch
// skills of the same category… all the scattered superpowers templates
// and skills may all fall under the superpowers template/skill. When
// clicked, it opens up all the skills/templates tagged with
// superpowers-obra… the goal of anybody being able to clamp many
// templates and skills into one listing in the public hub, and also
// allowing others to contribute by listing their own."
//
// A collection is just an id items carry (corpus rows already say
// "collection": "superpowers-obra"; the publish form writes it too).
// Collections() derives the bunch summaries ACROSS every registered
// library so one grouped listing covers templates + skills + personas
// at once. Members stay ordinary items — the grouping is a view, never
// a copy, so hearts/downloads/metrics keep working per item and the
// bunch simply aggregates them.
package hub

import (
        "sort"
        "strings"
)

// CollectionSummary is one bunch: N items (possibly across libraries)
// sharing a collection id. The hub renders it as ONE grouped card that
// opens the member list.
// v0.56 (user spec): Tag carries the bunch's FIRST tag — the most common
// leading tag among its members ("a pristine clean polished badge with a
// bright text for bundles that dynamically displays the first tag or #
// the bundle uses"). Empty = no badge.
type CollectionSummary struct {
        ID        string         `json:"id"`
        Icon      string         `json:"icon"`   // most common member icon ("" = no icon)
        Sample    string         `json:"sample"` // first member name (a display fallback)
        Tag       string         `json:"tag"`    // most-common first member tag ("" = none)
        Repo      string         `json:"repo"`    // v0.61 (icons): the icon file's repo (file: icons)
        Members   int            `json:"members"`
        Hearts    int            `json:"hearts"`    // Σ member hearts
        Downloads int            `json:"downloads"` // Σ member downloads
        ByType    map[string]int `json:"byType"`    // members per library type
        UpdatedAt string         `json:"updatedAt"` // newest member update
        // v0.58 (user spec pt 2): the bunch's card ART — the curated override
        // for known bunches, else the newest member's card design (any
        // publisher brands their own bunch by giving their items a look).
        // Zero value = the client paints its deterministic hash gradient.
        Design Design `json:"design"`
}

// Collections derives every collection bunch across all registered
// libraries, optionally filtered by a search substring over the bunch id
// and member names. Sorted: most members first, then hearts, then name.
// One pass per library reuses Items() so the local overlay + federated
// counters ride in (a downloaded member counts its +1 in the bunch sum).
func (s *Service) Collections(q string, refresh bool) ([]CollectionSummary, error) {
        q = strings.ToLower(strings.TrimSpace(q))
        type agg struct {
                sum   CollectionSummary
                icons map[string]int
                // v0.61 (icons): the repo each icon name was first seen in
                // — a file:<path> icon resolves against ITS contributor.
                iconRepos map[string]string
                names     []string
                tags      map[string]int // v0.56: first-tag votes across members
                // v0.58: the newest member carrying a usable card design — the
                // bunch card's art when no curated override exists.
                bestDesign   Design
                bestDesignAt int64
        }
        bunches := map[string]*agg{}

        for _, spec := range All() {
                items, err := s.Items(spec.Type, "", "recent", "", refresh)
                if err != nil {
                        continue // one broken library never breaks the bunches
                }
                for _, it := range items {
                        id := SanitizeCollection(it.Collection)
                        if id == "" {
                                continue
                        }
                        a := bunches[id]
                        if a == nil {
                                a = &agg{sum: CollectionSummary{ID: id, ByType: map[string]int{}}, icons: map[string]int{}, iconRepos: map[string]string{}, tags: map[string]int{}}
                                bunches[id] = a
                        }
                        a.sum.Members++
                        a.sum.Hearts += it.Hearts
                        a.sum.Downloads += it.Downloads
                        a.sum.ByType[it.Type]++
                        if it.Icon != "" {
                                a.icons[it.Icon]++
                                if _, seen := a.iconRepos[it.Icon]; !seen {
                                        a.iconRepos[it.Icon] = it.Repo
                                }
                        }
                        // v0.56: each member's FIRST tag votes once — the
                        // most common becomes the bunch's badge tag.
                        if len(it.Tags) > 0 {
                                a.tags[it.Tags[0]]++
                        }
                        a.names = append(a.names, strings.ToLower(it.Name))
                        if a.sum.Sample == "" {
                                a.sum.Sample = it.Name
                        }
                        if ParseTime(it.UpdatedAt) > ParseTime(a.sum.UpdatedAt) {
                                a.sum.UpdatedAt = it.UpdatedAt
                        }
                        // v0.58: track the NEWEST member that carries a usable
                        // design — that's the bunch's inherited look.
                        if usableDesign(it.Design) && ParseTime(it.UpdatedAt) > a.bestDesignAt {
                                a.bestDesignAt = ParseTime(it.UpdatedAt)
                                a.bestDesign = it.Design
                        }
                }
        }

        out := make([]CollectionSummary, 0, len(bunches))
        for _, a := range bunches {
                if q != "" {
                        hit := strings.Contains(a.sum.ID, q)
                        for _, n := range a.names {
                                if strings.Contains(n, q) {
                                        hit = true
                                        break
                                }
                        }
                        if !hit {
                                continue
                        }
                }
                // the bunch icon: the members' most common icon
                best, bestN := "", 0
                for name, n := range a.icons {
                        if n > bestN || (n == bestN && name < best) {
                                best, bestN = name, n
                        }
                }
                a.sum.Icon = best
                a.sum.Repo = a.iconRepos[best] // v0.61 (icons): where the icon file lives
                // v0.56: the bunch tag — the members' most common FIRST tag
                // (ties break alphabetically for determinism).
                bestTag, bestTagN := "", 0
                for t, n := range a.tags {
                        if n > bestTagN || (n == bestTagN && t < bestTag) {
                                bestTag, bestTagN = t, n
                        }
                }
                a.sum.Tag = bestTag
                a.sum.Design = bunchDesign(a.sum.ID, a.bestDesign)
                out = append(out, a.sum)
        }
        sort.SliceStable(out, func(i, j int) bool {
                if out[i].Members != out[j].Members {
                        return out[i].Members > out[j].Members
                }
                if out[i].Hearts != out[j].Hearts {
                        return out[i].Hearts > out[j].Hearts
                }
                return out[i].ID < out[j].ID
        })
        return out, nil
}

// CollectionMembers is one library's slice of a bunch.
type CollectionMembers struct {
        Type  string `json:"type"`
        Items []Item `json:"items"`
}

// CollectionItems returns the members of one bunch grouped per library,
// sorted hearts-first within each group (the bunch view's sectioned list).
// Unknown/empty ids return an empty set, never an error — the hub just
// shows "nothing here".
func (s *Service) CollectionItems(id string) ([]CollectionMembers, error) {
        id = SanitizeCollection(id)
        out := []CollectionMembers{}
        if id == "" {
                return out, nil
        }
        for _, spec := range All() {
                items, err := s.Items(spec.Type, "", "hearts", "", false)
                if err != nil {
                        continue
                }
                members := make([]Item, 0, 4)
                for _, it := range items {
                        if SanitizeCollection(it.Collection) == id {
                                members = append(members, it)
                        }
                }
                if len(members) > 0 {
                        out = append(out, CollectionMembers{Type: spec.Type, Items: members})
                }
        }
        return out, nil
}

// usableDesign reports whether a design can paint a card (a gradient with
// stops, or a PNG). Zero/"none" designs don't count.
func usableDesign(d Design) bool {
        return (d.Kind == "gradient" && len(d.Colors) > 0) || d.Kind == "png"
}

// ── v0.60 pt C.6: EVERYTHING IS A BUNDLE — collection downloads + deletes ──

// CollectionDownload is one downloaded member of a bunch (item + payload,
// the same shape a single-item download returns).
type CollectionDownload struct {
        Item    Item   `json:"item"`
        Payload string `json:"payload"`
}

// CollectionDownloadGroup is one library's slice of a downloaded bunch.
type CollectionDownloadGroup struct {
        Type  string               `json:"type"`
        Items []CollectionDownload `json:"items"`
}

// DownloadCollection downloads EVERY member of a bunch (v0.60 pt C.6: the
// one-press bundle download). Each member rides the ordinary Download path
// (local row + downloaded stamp + metric + the per-type counters), so the
// per-item effects are identical to tapping every card in turn — the client
// then applies the per-TYPE side effects (template/skill → the user's
// library, persona → the chat, theme → the look). Individual member
// failures are skipped (a half-offline bunch still lands its rest); an
// empty result errors.
func (s *Service) DownloadCollection(id string) ([]CollectionDownloadGroup, error) {
        id = SanitizeCollection(id)
        if id == "" {
                return nil, ErrNotFoundLocal
        }
        out := []CollectionDownloadGroup{}
        for _, spec := range All() {
                items, err := s.Items(spec.Type, "", "hearts", "", false)
                if err != nil {
                        continue
                }
                group := CollectionDownloadGroup{Type: spec.Type}
                for _, it := range items {
                        if SanitizeCollection(it.Collection) != id {
                                continue
                        }
                        item, payload, err := s.Download(spec.Type, it.Repo, it.ID)
                        if err != nil {
                                continue // member failed — the rest of the bundle still lands
                        }
                        group.Items = append(group.Items, CollectionDownload{Item: item, Payload: payload})
                }
                if len(group.Items) > 0 {
                        out = append(out, group)
                }
        }
        if len(out) == 0 {
                return nil, ErrNotFoundLocal
        }
        return out, nil
}

// CollectionDeleted is one removed local row (the client cleans its
// session marks + "Yours" copies from the list).
type CollectionDeleted struct {
        Type string `json:"type"`
        ID   string `json:"id"`
}

// DeleteCollection removes every locally-downloaded member of a bunch
// (v0.60 pt C.6: the delete-your-copy rule, bundle edition — the remote
// listings are untouched). Returns the removed rows.
func (s *Service) DeleteCollection(id string) ([]CollectionDeleted, error) {
        id = SanitizeCollection(id)
        if id == "" {
                return nil, ErrNotFoundLocal
        }
        var refs []CollectionDeleted
        for _, spec := range All() {
                rows, err := ListLocal(s.db, spec.Type)
                if err != nil {
                        continue
                }
                for _, row := range rows {
                        if row.DownloadedAt == "" || SanitizeCollection(row.Item.Collection) != id {
                                continue // publish-only records + other bunches stay
                        }
                        if err := DeleteLocalItem(s.db, spec.Type, row.Item.ID); err == nil {
                                refs = append(refs, CollectionDeleted{Type: spec.Type, ID: row.Item.ID})
                        }
                }
        }
        if len(refs) == 0 {
                return nil, ErrNotFoundLocal
        }
        s.Invalidate("") // counts changed
        return refs, nil
}

// builtinBunchDesigns — curated art for known bunches (v0.58 user spec pt 2:
// "let's make the superpowers bundle have a random color + random gradient
// of your choosing"). superpowers-obra, the flagship port, wears a hot mesh.
var builtinBunchDesigns = map[string]Design{
        "superpowers-obra": {
                Kind:   "gradient",
                Colors: []string{"#f59e0b", "#ef4444", "#7c3aed"},
                Dir:    "mesh",
        },
}

// bunchDesign resolves a bunch's card art: the curated override wins, else
// the newest member's card design (how any user brands their own bundle),
// else the zero Design — the client then paints its deterministic hash
// gradient from the bunch id, so EVERY bundle has stable art.
func bunchDesign(id string, newest Design) Design {
        if d, ok := builtinBunchDesigns[id]; ok {
                return d
        }
        return newest
}
