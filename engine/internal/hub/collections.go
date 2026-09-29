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
        "encoding/json"
        "sort"
        "strings"
        "time"

        "github.com/ScoobyBaby1999/doomalay/engine/internal/store"
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
        Repo      string         `json:"repo"`   // v0.61 (icons): the icon file's repo (file: icons)
        Members   int            `json:"members"`
        Hearts    int            `json:"hearts"`    // Σ member hearts
        Downloads int            `json:"downloads"` // Σ member downloads
        ByType    map[string]int `json:"byType"`    // members per library type
        UpdatedAt string         `json:"updatedAt"` // newest member update
        // v0.76.7: THE BY-LINE — the bundle's aggregate author (the member
        // author with the most members; ties break alphabetically — the
        // Tag pattern). The bunch detail card's "by X" row (the single
        // item's exact meta line): a bundle published by one publisher
        // reads "by mockuser", a mixed one reads its plurality author.
        By string `json:"by"`
        // v0.77.6: THE UPSTREAM CREDIT — the plurality member upstream
        // ("obra/superpowers by Jesse Vincent"). A PORTED bundle's
        // byline reads "by <publisher> — ported from <upstream>" so the
        // credit rides every surface the author does.
        Upstream string `json:"upstream,omitempty"`
        // v0.77.10: THE DESCRIPTION — the bundle's editorial one-or-two
        // line description (the publisher's collections/<id>.json
        // manifest; the fallback is the most-endorsed member's text).
        // The header shows this FIRST, the deterministic census line
        // BENEATH it (the user's spec — the census was never a
        // description).
        Description string `json:"description,omitempty"`
        // v0.77.10: THE PER-USER BUNDLE COUNTERS — Hearts/Downloads count
        // USERS of the WHOLE BUNDLE (per-user idempotent collection
        // events + the local +1), never Σ members: one user downloading
        // a 64-item bundle counts as ONE, and endorsing it as ONE.
        // Members display their OWN counts PLUS these (the member view
        // rides applyCollectionCounts).
        Hearted    bool `json:"hearted"`    // the local state (any member hearted / the collection event era)
        Downloaded bool `json:"downloaded"`  // any member row carries a download stamp
        // v0.72: THE TAG ROW — every member tag votes once per member
        // carrying it; Tags carries the top vote-getters (ties break
        // alphabetically for determinism, capped at 16 so a giant bundle
        // can't bloat the listing payload). The bunch detail card renders
        // the first five + "+N" (THE PARITY CARD: a bundle's card is
        // laid out exactly like a single item's).
        Tags []string `json:"tags"`
        // v0.58 (user spec pt 2): the bunch's card ART — the curated override
        // for known bunches, else the newest member's card design (any
        // publisher brands their own bunch by giving their items a look).
        // Zero value = the client paints its deterministic hash gradient.
        Design Design `json:"design"`
}

// Collections derives every collection bunch across all registered
// libraries, optionally filtered by a search substring over the bunch id,
// member names, member descriptions and member tags (v0.73: the matcher
// widened for million-entry hubs — a q must be able to find a needle), and
// by a badge tag filter. Sorted: most members first, then hearts, then name.
// One pass per library reuses Items() so the local overlay + federated
// counters ride in (a downloaded member counts its +1 in the bunch sum).
func (s *Service) Collections(q, tag string, refresh bool) ([]CollectionSummary, error) {
        q = strings.ToLower(strings.TrimSpace(q))
        tag = strings.ToLower(strings.TrimSpace(tag))
        type agg struct {
                sum   CollectionSummary
                icons map[string]int
                // v0.61 (icons): the repo each icon name was first seen in
                // — a file:<path> icon resolves against ITS contributor.
                iconRepos map[string]string
                names     []string
                descs     []string
                descSet   map[string]bool
                tags      map[string]int // v0.56: first-tag votes across members
                allTags   map[string]int // v0.72: EVERY-tag votes (the detail card's tag row)
                authors   map[string]int // v0.76.7: member-author votes (the by-line)
                upstreams map[string]int // v0.77.6: member-upstream votes (the credit)
                // v0.77.10: the DESCRIPTION fallback — the most-endorsed
                // member's text (ties break alphabetically); the publisher's
                // collections/<id>.json manifest OVERRIDES it when present.
                bestDesc     string
                bestDescRank int
                // v0.77.10: the distinct member repos (the manifest probe)
                repos map[string]bool
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
                                a = &agg{sum: CollectionSummary{ID: id, ByType: map[string]int{}}, icons: map[string]int{}, iconRepos: map[string]string{}, tags: map[string]int{}, allTags: map[string]int{}, authors: map[string]int{}, upstreams: map[string]int{}, descSet: map[string]bool{}, repos: map[string]bool{}}
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
                        // v0.72: every tag a member carries votes once per
                        // member — the tag row shows what the bundle is
                        // ABOUT, not just what its first items lead with
                        // (a member's second tag is as real as its first).
                        for _, tg := range it.Tags {
                                if tg = strings.TrimSpace(tg); tg != "" {
                                        a.allTags[tg]++
                                }
                        }
                        a.names = append(a.names, strings.ToLower(it.Name))
                        // v0.76.7: the by-line vote — the plurality member author
                        if au := strings.TrimSpace(it.Author); au != "" {
                                a.authors[au]++
                        }
                        // v0.77.6: the upstream vote — the plurality member
                        // credit (a ported bundle credits its source)
                        if up := strings.TrimSpace(it.Upstream); up != "" {
                                a.upstreams[up]++
                        }
                        // v0.77.10: the description fallback vote — the most
                        // endorsed member wins (ties alphabetical)
                        if d := strings.TrimSpace(it.Description); d != "" {
                                rank := it.Hearts*1000 - len(d)
                                if rank > a.bestDescRank || (rank == a.bestDescRank && d < a.bestDesc) {
                                        a.bestDesc, a.bestDescRank = d, rank
                                }
                        }
                        if it.Repo != "" {
                                a.repos[it.Repo] = true
                        }
                        // v0.73: the matcher widened — descriptions (deduped
                        // per bunch) now vote too, so a q like "brainstorm"
                        // finds bundles whose members carry that word in
                        // their when-to-use text.
                        if d := strings.ToLower(strings.Join(strings.Fields(it.Description), " ")); d != "" && !a.descSet[d] {
                                a.descSet[d] = true
                                a.descs = append(a.descs, d)
                        }
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
                                for _, d := range a.descs {
                                        if strings.Contains(d, q) {
                                                hit = true
                                                break
                                        }
                                }
                        }
                        if !hit {
                                for t := range a.tags {
                                        if strings.Contains(strings.ToLower(t), q) {
                                                hit = true
                                                break
                                        }
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
                // v0.73: the tag filter — badge-exact (case-insensitive),
                // applied AFTER the vote so it filters on the final badge.
                if tag != "" && strings.ToLower(bestTag) != tag {
                        continue
                }
                a.sum.Tag = bestTag
                // v0.72: THE TAG ROW — the every-tag votes, most votes
                // first (ties alphabetical), capped at 16. The client
                // shows the top five + "+N"; the cap keeps a 200-member
                // bundle's listing payload honest.
                tagList := make([]string, 0, len(a.allTags))
                for t := range a.allTags {
                        tagList = append(tagList, t)
                }
                sort.SliceStable(tagList, func(i, j int) bool {
                        if a.allTags[tagList[i]] != a.allTags[tagList[j]] {
                                return a.allTags[tagList[i]] > a.allTags[tagList[j]]
                        }
                        return tagList[i] < tagList[j]
                })
                if len(tagList) > 16 {
                        tagList = tagList[:16]
                }
                a.sum.Tags = tagList
                // v0.76.7: THE BY-LINE — the plurality member author (ties
                // break alphabetically, the Tag pattern)
                bestBy, bestByN := "", 0
                for au, n := range a.authors {
                        if n > bestByN || (n == bestByN && au < bestBy) {
                                bestBy, bestByN = au, n
                        }
                }
                a.sum.By = bestBy
                // v0.77.6: THE UPSTREAM CREDIT — the plurality member
                // upstream (same tie-break)
                bestUp, bestUpN := "", 0
                for up, n := range a.upstreams {
                        if n > bestUpN || (n == bestUpN && up < bestUp) {
                                bestUp, bestUpN = up, n
                        }
                }
                a.sum.Upstream = bestUp
                // v0.77.10: THE DESCRIPTION — the publisher's manifest wins
                // (collections/<id>.json in any member repo; cached 10min),
                // else the most-endorsed member's text (deterministic).
                a.sum.Description = s.collectionDescription(a.sum.ID, a.repos, a.bestDesc)
                // v0.77.10: THE PER-USER BUNDLE COUNTERS — the bunch card
                // counts USERS of the WHOLE bundle (one download/endorse per
                // user, on the collection), never Σ members.
                own := s.currentUser() + "/" + metricsRepo
                ch, cd := collectionCounts(s.allMetrics(), own, CollectionTarget(a.sum.ID))
                a.sum.Hearts = ch
                a.sum.Downloads = cd
                if via := LocalViaCollections(s.db); via[a.sum.ID] {
                        a.sum.Downloads++ // the local +1 (the applyCounts pattern)
                }
                a.sum.Downloaded, a.sum.Hearted = LocalCollectionState(s.db, a.sum.ID)
                if collectionHearted(s.db, a.sum.ID) {
                        a.sum.Hearted = true
                        a.sum.Hearts++ // the local +1 (once, never per member)
                }
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

// collectionDescription resolves a bunch's editorial description
// (v0.77.10): the publisher's collections/<id>.json manifest (probed in
// each distinct member repo, cached 10 minutes) wins; the fallback is
// the caller's deterministic member text (the most-endorsed member's).
func (s *Service) collectionDescription(id string, repos map[string]bool, fallback string) string {
        cid := SanitizeCollection(id)
        for repo := range repos {
                key := repo + "|" + cid
                s.manifestMu.Lock()
                hit, ok := s.manifests[key]
                s.manifestMu.Unlock()
                if !ok || time.Since(hit.at) > 10*time.Minute {
                        var m CollectionManifest
                        if body, err := s.hf.FetchFile(repo, "collections/"+cid+".json"); err == nil {
                                _ = json.Unmarshal(body, &m)
                        }
                        s.manifestMu.Lock()
                        s.manifests[key] = cachedManifest{m: m, at: time.Now()}
                        s.manifestMu.Unlock()
                        hit = cachedManifest{m: m, at: time.Now()}
                }
                if d := strings.TrimSpace(hit.m.Description); d != "" {
                        return d
                }
        }
        return fallback
}

// EndorseCollection hearts a BUNDLE as ONE (v0.77.10, the user's spec:
// "if one user endorses the bundle it counts as 1" — never +45 on the
// members). Requires the bundle downloaded (any member row carries a
// stamp — the same endorse-before-download rule as items). The event is
// toggle-idempotent per user; the members' own counters never move.
func (s *Service) EndorseCollection(id string, endorse bool) (hearts int, err error) {
        id = SanitizeCollection(id)
        if id == "" {
                return 0, ErrNotFoundLocal
        }
        downloaded, _ := LocalCollectionState(s.db, id)
        if !downloaded {
                return 0, ErrNotDownloaded
        }
        op := "unheart"
        if endorse {
                op = "heart"
        }
        s.appendMetricToggle(op, CollectionTarget(id))
        // the LOCAL heart marker (the member rows never move — a bundle
        // heart is ONE heart on the collection, not a member fan-out)
        _ = s.db.SetSetting("hub.collection.heart."+id, boolStr(endorse))
        s.Invalidate("") // the federated views re-read
        own := s.currentUser() + "/" + metricsRepo
        h, _ := collectionCounts(s.allMetrics(), own, CollectionTarget(id))
        if endorse {
                h++ // the local +1 (the applyCounts pattern)
        }
        return h, nil
}

// collectionHearted reads the local bundle-heart marker (v0.77.10).
func collectionHearted(db *store.DB, id string) bool {
        v, _ := db.GetSetting("hub.collection.heart." + id)
        return v == "1"
}

func boolStr(b bool) string {
        if b {
                return "1"
        }
        return "0"
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

// DownloadProgress (v0.67.2 THE PERSISTENT DOWNLOAD REGISTRY) is one
// streamed event during a bundle download. The frontend's Hub.downloads
// registry consumes these to drive the bunch view's download pill
// (phase-aware, persisted across panel pop/push — fixes the static
// 'downloading...' pill that reset on screen leave).
//
// Phases (per research 1-B — the robust download state machine):
//
//      enqueued → downloading (per member) → verifying → complete | failed
type DownloadProgress struct {
        Phase  string `json:"phase"` // enqueued | downloading | verifying | complete | failed
        Done   int    `json:"done"`
        Total  int    `json:"total"`
        Failed int    `json:"failed"`
        Member string `json:"member,omitempty"` // the item id last attempted
        Error  string `json:"error,omitempty"`
}

// DownloadCollection is the synchronous (legacy) path — calls the
// streaming core with a nil channel. Kept for any non-SSE caller; the
// v0.67.2 SSE HTTP handler uses DownloadCollectionStream so the user
// sees real progress.
func (s *Service) DownloadCollection(id string) ([]CollectionDownloadGroup, error) {
        return s.DownloadCollectionStream(id, nil)
}

// DownloadCollectionStream downloads EVERY member of a bunch and streams
// progress events through `progress` (nil for the synchronous path). Each
// member rides the ordinary Download path (local row + downloaded stamp +
// metric + the per-type counters). Individual member failures are skipped
// (a half-offline bunch still lands its rest) but counted in `failed`; an
// empty result (no members OR all members failed) errors.
//
// The progress channel is buffered (caller-side, cap 32) so a slow
// consumer never blocks the download. The caller closes the channel
// after the function returns.
//
// v0.67.2: the user reported "pressing download shows a static
// 'downloading...' pill; leaving and re-entering resets it to 'download
// all x'; the obra bundle doesn't actually download." The root cause was
// fire-and-forget POST + no progress + no in-memory registry — the bcur
// object was destroyed on panel.popView() so the in-flight fetch's .then
// resolved against stale state. This function + the SSE handler + the
// frontend Hub.downloads registry together fix it: the registry survives
// panel pop/push; bunchRender reads it for the pill label; the click
// handler is non-blocking and lets the registry drive the UI.
func (s *Service) DownloadCollectionStream(id string, progress chan<- DownloadProgress) ([]CollectionDownloadGroup, error) {
        id = SanitizeCollection(id)
        if id == "" {
                return nil, ErrNotFoundLocal
        }
        // First pass: gather ALL members across every library so the user
        // sees a real progress count (not a static 'downloading...' pill).
        // The legacy DownloadCollection gathered+downloaded per-type in one
        // loop; we split it so the total is known BEFORE the first download.
        type pending struct {
                spec LibrarySpec
                it   Item
        }
        var members []pending
        for _, spec := range All() {
                items, err := s.Items(spec.Type, "", "hearts", "", false)
                if err != nil {
                        continue
                }
                for _, it := range items {
                        if SanitizeCollection(it.Collection) == id {
                                members = append(members, pending{spec, it})
                        }
                }
        }
        total := len(members)
        if total == 0 {
                return nil, ErrNotFoundLocal
        }
        if progress != nil {
                progress <- DownloadProgress{Phase: "enqueued", Total: total, Done: 0, Failed: 0}
        }
        // Group the downloaded items by type for the final return.
        // v0.77.10: members ride downloadCore(via=true) — NO per-member
        // download events (one user's bundle download counts ONCE, on the
        // collection — the user's "counts as 1 regardless of the contents
        // and amount of files within").
        groupsByType := map[string]*CollectionDownloadGroup{}
        order := []string{}
        done, failed := 0, 0
        for _, m := range members {
                item, payload, err := s.downloadCore(m.spec.Type, m.it.Repo, m.it.ID, true)
                if err != nil {
                        // member failed — the rest of the bundle still lands
                        failed++
                        if progress != nil {
                                progress <- DownloadProgress{
                                        Phase: "downloading", Done: done, Total: total, Failed: failed,
                                        Member: m.it.ID, Error: err.Error(),
                                }
                        }
                        continue
                }
                done++
                g, ok := groupsByType[m.spec.Type]
                if !ok {
                        g = &CollectionDownloadGroup{Type: m.spec.Type}
                        groupsByType[m.spec.Type] = g
                        order = append(order, m.spec.Type)
                }
                g.Items = append(g.Items, CollectionDownload{Item: item, Payload: payload})
                if progress != nil {
                        progress <- DownloadProgress{
                                Phase: "downloading", Done: done, Total: total, Failed: failed,
                                Member: item.ID,
                        }
                }
        }
        if progress != nil {
                progress <- DownloadProgress{Phase: "verifying", Done: done, Total: total, Failed: failed}
        }
        // v0.77.10: THE ONE EVENT — the bundle's own download counter
        // (per-user idempotent); the members' own counters stay untouched.
        if done > 0 {
                s.appendMetricToggle("download", CollectionTarget(id))
        }
        if done == 0 {
                if progress != nil {
                        progress <- DownloadProgress{Phase: "failed", Done: 0, Total: total, Failed: failed, Error: "all members failed to download"}
                }
                return nil, ErrNotFoundLocal
        }
        // Build the output slice in stable type-registration order (the
        // same shape the legacy DownloadCollection returned).
        out := make([]CollectionDownloadGroup, 0, len(order))
        for _, t := range order {
                out = append(out, *groupsByType[t])
        }
        s.Invalidate("") // the collection counters changed
        if progress != nil {
                progress <- DownloadProgress{Phase: "complete", Done: done, Total: total, Failed: failed}
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
        // v0.77.10: deleting your copies unhearts the bundle (the heart
        // gate is download-first — a bundle you no longer have cannot
        // stay endorsed).
        _ = s.db.SetSetting("hub.collection.heart."+id, "0")
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
