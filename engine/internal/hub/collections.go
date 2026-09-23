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
type CollectionSummary struct {
        ID        string         `json:"id"`
        Icon      string         `json:"icon"`      // most common member icon ("" = no icon)
        Sample    string         `json:"sample"`    // first member name (a display fallback)
        Members   int            `json:"members"`
        Hearts    int            `json:"hearts"`    // Σ member hearts
        Downloads int            `json:"downloads"` // Σ member downloads
        ByType    map[string]int `json:"byType"`    // members per library type
        UpdatedAt string         `json:"updatedAt"` // newest member update
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
                names []string
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
                                a = &agg{sum: CollectionSummary{ID: id, ByType: map[string]int{}}, icons: map[string]int{}}
                                bunches[id] = a
                        }
                        a.sum.Members++
                        a.sum.Hearts += it.Hearts
                        a.sum.Downloads += it.Downloads
                        a.sum.ByType[it.Type]++
                        if it.Icon != "" {
                                a.icons[it.Icon]++
                        }
                        a.names = append(a.names, strings.ToLower(it.Name))
                        if a.sum.Sample == "" {
                                a.sum.Sample = it.Name
                        }
                        if ParseTime(it.UpdatedAt) > ParseTime(a.sum.UpdatedAt) {
                                a.sum.UpdatedAt = it.UpdatedAt
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
