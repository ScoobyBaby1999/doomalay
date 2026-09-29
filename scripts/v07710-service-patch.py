#!/usr/bin/env python3
"""v07710-service-patch.py — the metric/counting rework (service.go + collections.go)."""
import sys

P = 'engine/internal/hub/service.go'
s = open(P, encoding='utf-8').read()

# ── 1. the Service struct gains the manifest cache ────────────────────────
old = '''        userMu sync.Mutex
        user   string // whoami cache (token may be swapped underneath)
}'''
new = '''        userMu sync.Mutex
        user   string // whoami cache (token may be swapped underneath)

        // v0.77.10: the collections/<id>.json manifest cache (the bundle's
        // editorial description) — repo|id → {manifest, fetchedAt}; the
        // 10-minute TTL matches the typeCache views.
        manifestMu sync.Mutex
        manifests  map[string]cachedManifest
}'''
assert old in s, 'Service struct anchor'
s = s.replace(old, new)

# the cachedManifest type + the collection target helpers after the metricEvent type
old = '''// NewService wires the hub to the local store + vault + an HF base URL.'''
new = '''// cachedManifest is one bundle's editorial manifest (v0.77.10).
type cachedManifest struct {
        m  CollectionManifest
        at time.Time
}

// CollectionManifest is the collections/<id>.json document a bundle's
// publisher commits alongside the items (v0.77.10, the user's spec: the
// bundle header shows a REAL one-or-two-line description — what it does,
// where it's ported from — with the deterministic census line BENEATH
// it, not in place of it). The corpus script writes it for
// superpowers-obra; any publisher can brand their own bundle.
type CollectionManifest struct {
        Description string `json:"description"`
        Upstream    string `json:"upstream,omitempty"`
        By          string `json:"by,omitempty"`
}

// CollectionTarget is the metrics namespace for bundle-level events
// (v0.77.10: one user's bundle download/endorse counts ONCE — the
// per-user idempotent events live under "collection|<id>", never under
// the 64 members).
func CollectionTarget(id string) string {
        return "collection|" + SanitizeCollection(id)
}

// NewService wires the hub to the local store + vault + an HF base URL.'''
assert old in s, 'NewService anchor'
s = s.replace(old, new, 1)

s = s.replace('''        return &Service{
                db:    db,
                hf:    NewHFClient(hfBase),
                vault: vault,
                cache: map[string]*typeCache{},
                scans: map[string]*scanEntry{},
        }''',
'''        return &Service{
                db:        db,
                hf:        NewHFClient(hfBase),
                vault:     vault,
                cache:     map[string]*typeCache{},
                scans:     map[string]*scanEntry{},
                manifests: map[string]cachedManifest{},
        }''')

# ── 2. appendMetricToggle (per-user idempotent) after appendMetric ────────
# find appendMetric and append after its function
import re
m = re.search(r'func \(s \*Service\) appendMetric\(op, tgt string\) \{.*?\n\}\n', s, re.S)
assert m, 'appendMetric not found'
toggle_fn = '''
// appendMetricToggle (v0.77.10) appends a BUNDLE-level event ONCE per
// user per state: the own metrics log is read first and the event lands
// only when the LAST event for this target carries a DIFFERENT op (the
// toggle-idempotency: heart→heart skips, heart→unheart lands,
// unheart→heart lands — net per-user counts stay 0/1; a download lands
// exactly once ever). This is what makes "one user downloads a 64-item
// bundle" count as ONE, on the collection, never +64 on the members.
func (s *Service) appendMetricToggle(op, tgt string) {
        token := s.Token()
        if token == "" {
                return
        }
        own := s.currentUser() + "/" + metricsRepo
        body, err := s.hf.FetchFile(own, metricsFile)
        if err != nil && !IsNotFound(err) {
                log.Printf("hub: toggle-metric read %s: %v", own, err)
                return
        }
        last := ""
        for _, line := range strings.Split(string(body), "\\n") {
                line = strings.TrimSpace(line)
                if line == "" {
                        continue
                }
                var ev metricEvent
                if json.Unmarshal([]byte(line), &ev) != nil || ev.Target != tgt {
                        continue
                }
                last = ev.Op
        }
        if last == op {
                return // already in this state — no duplicate event
        }
        s.appendMetric(op, tgt)
}

// collectionCounts aggregates the bundle-level metric events across every
// metrics repo EXCEPT the user's own (the local binary state carries the
// own +1 — the applyCounts pattern, collection edition). metricsByRepo
// must be DEDUPED per repo id (every type cache carries the same set).
func collectionCounts(metricsByRepo map[string]map[string]*counts, ownRepo, target string) (hearts, downloads int) {
        for repo, per := range metricsByRepo {
                if repo == ownRepo {
                        continue
                }
                if c := per[target]; c != nil {
                        hearts += c.Hearts
                        downloads += c.Downloads
                }
        }
        return hearts, downloads
}

// allMetrics merges every type cache's metrics maps into one deduped
// repo→target view (the same metrics repos appear in each type's cache).
func (s *Service) allMetrics() map[string]map[string]*counts {
        out := map[string]map[string]*counts{}
        for _, v := range s.cache {
                for repo, per := range v.metrics {
                        if _, seen := out[repo]; seen {
                                continue
                        }
                        out[repo] = per
                }
        }
        return out
}
'''
s = s.replace(m.group(0), m.group(0) + toggle_fn, 1)

# ── 3. Download core extraction (member downloads without member metrics) ─
old = '''func (s *Service) Download(typ, repo, id string) (Item, string, error) {
        if _, err := Get(typ); err != nil {
                return Item{}, "", err
        }
        item, err := s.remoteItem(typ, repo, id)
        if err != nil {
                return Item{}, "", err
        }
        item.ID = id
        payload, err := s.resolvePayload(repo, item.File)
        if err != nil {
                return Item{}, "", err
        }
        if err := SaveLocalItem(s.db, item, payload); err != nil {
                return Item{}, "", err
        }
        if err := MarkDownloaded(s.db, typ, id); err != nil {
                return Item{}, "", err
        }
        if repo != BuiltinRepo { // builtins carry no metrics repo of their own
                s.appendMetric("download", target(repo, id)) // best-effort
        }
        s.Invalidate("")                                     // counts changed
        if row, err := GetLocalItem(s.db, typ, id); err == nil {
                return s.countsFor(typ, row.Item), row.Payload, nil
        }
        return item, payload, nil
}'''
new = '''func (s *Service) Download(typ, repo, id string) (Item, string, error) {
        item, payload, err := s.downloadCore(typ, repo, id, false)
        if err != nil {
                return Item{}, "", err
        }
        if repo != BuiltinRepo { // builtins carry no metrics repo of their own
                s.appendMetric("download", target(repo, id)) // best-effort
        }
        s.Invalidate("") // counts changed
        return s.countsFor(typ, item), payload, nil
}

// downloadCore fetches + stores one item WITHOUT stamping any metric
// (v0.77.10: a bundle download's members never carry per-member download
// events — the +1 rides the collection — so the core is shared by the
// direct path (which stamps) and the bundle path (which doesn't)).
// via=true marks the local row as bundle-downloaded (the member's own
// displayed +1 is suppressed; a direct re-download clears it).
func (s *Service) downloadCore(typ, repo, id string, via bool) (Item, string, error) {
        if _, err := Get(typ); err != nil {
                return Item{}, "", err
        }
        item, err := s.remoteItem(typ, repo, id)
        if err != nil {
                return Item{}, "", err
        }
        item.ID = id
        payload, err := s.resolvePayload(repo, item.File)
        if err != nil {
                return Item{}, "", err
        }
        if err := SaveLocalItem(s.db, item, payload); err != nil {
                return Item{}, "", err
        }
        if via {
                if err := MarkDownloadedVia(s.db, typ, id); err != nil {
                        return Item{}, "", err
                }
        } else {
                if err := MarkDownloaded(s.db, typ, id); err != nil {
                        return Item{}, "", err
                }
        }
        if row, err := GetLocalItem(s.db, typ, id); err == nil {
                return row.Item, row.Payload, nil
        }
        return item, payload, nil
}'''
assert old in s, 'Download anchor'
s = s.replace(old, new)

# ── 4. applyCounts: the ViaCollection suppress + the collection totals ────
old = '''func applyCounts(item Item, state *LocalState, metrics map[string]map[string]*counts, ownRepo string) Item {
        target := item.Repo + "|" + item.ID
        var hearts, dls int
        for repo, per := range metrics {
                if repo == ownRepo {
                        continue
                }
                if c := per[target]; c != nil {
                        hearts += c.Hearts
                        dls += c.Downloads
                }
        }
        if state != nil {
                if state.Hearted {
                        hearts++
                }
                if state.DownloadedAt != "" {
                        dls++
                }
                item.Hearts += hearts
                item.Downloads += dls
                return item
        }
        item.Hearts += hearts
        item.Downloads += dls
        return item
}'''
new = '''func applyCounts(item Item, state *LocalState, metrics map[string]map[string]*counts, ownRepo string) Item {
        target := item.Repo + "|" + item.ID
        var hearts, dls int
        for repo, per := range metrics {
                if repo == ownRepo {
                        continue
                }
                if c := per[target]; c != nil {
                        hearts += c.Hearts
                        dls += c.Downloads
                }
        }
        if state != nil {
                if state.Hearted {
                        hearts++
                }
                // v0.77.10: a bundle-downloaded member does NOT count its
                // own +1 — the download rode the COLLECTION (the user's
                // per-user bundle counting). A direct download keeps it.
                if state.DownloadedAt != "" && !state.ViaCollection {
                        dls++
                }
                item.Hearts += hearts
                item.Downloads += dls
                return item
        }
        item.Hearts += hearts
        item.Downloads += dls
        return item
}

// applyCollectionCounts (v0.77.10) adds the bundle's totals to a MEMBER's
// displayed counters — the user's spec: "Each file in the bundle should
// reflect the bundles total downloads + that files specific downloads,
// same with endorsements." collCounts comes pre-aggregated (others'
// collection events + the local via-collection +1); items with no
// collection are untouched.
func applyCollectionCounts(item Item, collHearts, collDls int) Item {
        if item.Collection == "" || (collHearts == 0 && collDls == 0) {
                return item
        }
        item.Hearts += collHearts
        item.Downloads += collDls
        return item
}'''
assert old in s, 'applyCounts anchor'
s = s.replace(old, new)

open(P, 'w', encoding='utf-8').write(s)
print('service.go patched')

# ── collections.go: the summary rework ────────────────────────────────────
P2 = 'engine/internal/hub/collections.go'
c = open(P2, encoding='utf-8').read()

# CollectionSummary gains Description
old = '''        // v0.77.6: THE UPSTREAM CREDIT — the plurality member upstream
        // ("obra/superpowers by Jesse Vincent"). A PORTED bundle's
        // byline reads "by <publisher> — ported from <upstream>" so the
        // credit rides every surface the author does.
        Upstream string `json:"upstream,omitempty"`'''
new = '''        // v0.77.6: THE UPSTREAM CREDIT — the plurality member upstream
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
        Downloaded bool `json:"downloaded"`  // any member row carries a download stamp'''
assert old in c, 'CollectionSummary upstream anchor'
c = c.replace(old, new)

open(P2, 'w', encoding='utf-8').write(c)
print('collections.go summary patched')
