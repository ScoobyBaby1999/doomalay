// service.go — the hub orchestration layer: discovery + aggregation
// (Items), download, endorse, publish, metrics sidecars, and the local
// persona hearts. Owns a 10-minute per-type remote cache (the models-cache
// pattern: fresh → serve, stale/expired → rebuild — hub discovery is a
// fan-out over many repos, too slow to redo per keystroke).
package hub

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/ScoobyBaby1999/doomalay/engine/internal/secrets"
	"github.com/ScoobyBaby1999/doomalay/engine/internal/store"
)

// metricsTag marks the metrics sidecar repos; metricsFile is the event log
// inside each of them.
const (
	metricsTag  = "doomalay-metrics"
	metricsRepo = "doomalay-metrics" // repo NAME (under each user's namespace)
	metricsFile = "metrics.jsonl"
)

// itemsTTL is the remote catalog cache window (mirrors the models catalog).
const itemsTTL = 10 * time.Minute

// discovery concurrency bound (repos fan out; one slow repo must not stall
// the whole list).
const maxWorkers = 6

// TokenEnvVar is the vault entry holding the hub's HF token (repo.write).
const TokenEnvVar = "DOOMALAY_HF_TOKEN"

// Errors callers map to HTTP statuses.
var (
	ErrNotConnected  = errors.New("not connected to Hugging Face (connect a write-scoped token first)")
	ErrNotDownloaded = errors.New("download the item before endorsing it")
	ErrNotFoundLocal = errors.New("item not found")
)

// Service is the hub engine (one per process, like everything here).
type Service struct {
	db    *store.DB
	hf    *HFClient
	vault *secrets.Vault

	mu    sync.Mutex
	cache map[string]*typeCache // library type → remote view

	userMu sync.Mutex
	user   string // whoami cache (token may be swapped underneath)
}

// typeCache is the remote view of one library type.
type typeCache struct {
	items   []Item                        // remote items (Repo stamped)
	metrics map[string]map[string]*counts // metrics repo id → "repo|id" → counts
	at      time.Time
}

// counts is the per-target reduction of one metrics repo's event log.
type counts struct {
	Hearts    int
	Downloads int
}

// metricEvent is one line of metrics.jsonl.
type metricEvent struct {
	Op     string `json:"op"`     // heart | unheart | download | publish
	Target string `json:"target"` // "{repo}|{id}"
	TS     string `json:"ts"`
}

// NewService wires the hub to the local store + vault + an HF base URL.
func NewService(hfBase string, db *store.DB, vault *secrets.Vault) *Service {
	return &Service{
		db:    db,
		hf:    NewHFClient(hfBase),
		vault: vault,
		cache: map[string]*typeCache{},
	}
}

// ── auth ─────────────────────────────────────────────────────────────────

// Token returns the stored HF hub token ("" when disconnected).
func (s *Service) Token() string {
	if s.vault == nil {
		return ""
	}
	key, _, err := s.vault.Get(TokenEnvVar)
	if err != nil {
		return ""
	}
	return key
}

// Username returns the connected account name (vault extra — survives
// restarts without a whoami round-trip; "" when disconnected).
func (s *Service) Username() string {
	if s.vault == nil {
		return ""
	}
	_, extra, err := s.vault.Get(TokenEnvVar)
	if err != nil {
		return ""
	}
	return extra
}

// Connect verifies a token via whoami and stores it (username as the vault
// extra). Returns the verified username. A 401 comes back as an *HFError so
// HTTP callers can map it cleanly.
func (s *Service) Connect(token string) (string, error) {
	if strings.TrimSpace(token) == "" {
		return "", errors.New("token is required")
	}
	name, err := s.hf.WhoAmI(token)
	if err != nil {
		return "", err
	}
	if s.vault != nil {
		if err := s.vault.Set(TokenEnvVar, "huggingface", token, name); err != nil {
			return "", err
		}
	}
	s.userMu.Lock()
	s.user = name
	s.userMu.Unlock()
	s.Invalidate("") // the own-metrics-repo identity changed
	return name, nil
}

// Disconnect drops the stored token.
func (s *Service) Disconnect() error {
	if s.vault == nil {
		return nil
	}
	if err := s.vault.Delete(TokenEnvVar); err != nil {
		return err
	}
	s.userMu.Lock()
	s.user = ""
	s.userMu.Unlock()
	s.Invalidate("")
	return nil
}

// currentUser prefers the in-memory whoami cache, falls back to the vault
// extra, and only hits the API as a last resort (whoami is rate-limited).
func (s *Service) currentUser() string {
	s.userMu.Lock()
	cached := s.user
	s.userMu.Unlock()
	if cached != "" {
		return cached
	}
	if name := s.Username(); name != "" {
		return name
	}
	token := s.Token()
	if token == "" {
		return ""
	}
	name, err := s.hf.WhoAmI(token)
	if err != nil {
		return ""
	}
	s.userMu.Lock()
	s.user = name
	s.userMu.Unlock()
	return name
}

// ── cache ────────────────────────────────────────────────────────────────

// Invalidate drops the remote cache (typ "" = every type — used when the
// auth identity or the metrics sidecars change).
func (s *Service) Invalidate(typ string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if typ == "" {
		s.cache = map[string]*typeCache{}
		return
	}
	delete(s.cache, typ)
}

// view returns the (possibly cached) remote view for a library type.
func (s *Service) view(spec LibrarySpec, refresh bool) *typeCache {
	s.mu.Lock()
	v := s.cache[spec.Type]
	fresh := v != nil && time.Since(v.at) < itemsTTL
	s.mu.Unlock()
	if fresh && !refresh {
		return v
	}
	nv := s.discover(spec)
	s.mu.Lock()
	s.cache[spec.Type] = nv
	s.mu.Unlock()
	return nv
}

// discover rebuilds the remote view: every repo tagged with the library's
// tag contributes items/ (index.json, falling back to the tree listing),
// and every repo tagged doomalay-metrics contributes counters. One failing
// repo never fails the call — it is logged and skipped.
func (s *Service) discover(spec LibrarySpec) *typeCache {
	v := &typeCache{metrics: map[string]map[string]*counts{}, at: time.Now()}

	repos, err := s.hf.ListReposByTag(spec.Tag)
	if err != nil {
		log.Printf("hub: discovery %s: %v", spec.Type, err)
	}
	metricsRepos, err := s.hf.ListReposByTag(metricsTag)
	if err != nil {
		log.Printf("hub: metrics discovery: %v", err)
	}

	var mu sync.Mutex
	runBounded(len(repos), func(i int) {
		items := s.itemsFromRepo(spec, repos[i].ID)
		if len(items) == 0 {
			return
		}
		mu.Lock()
		v.items = append(v.items, items...)
		mu.Unlock()
	})
	runBounded(len(metricsRepos), func(i int) {
		per := s.metricsFromRepo(metricsRepos[i].ID)
		if len(per) == 0 {
			return
		}
		mu.Lock()
		v.metrics[metricsRepos[i].ID] = per
		mu.Unlock()
	})
	return v
}

// itemsFromRepo reads one repo's items: items/index.json when present,
// else the items/ tree listing + per-item meta fetches.
func (s *Service) itemsFromRepo(spec LibrarySpec, repo string) []Item {
	var items []Item
	if body, err := s.hf.FetchFile(repo, "items/index.json"); err == nil {
		_ = json.Unmarshal(body, &items)
	} else if IsNotFound(err) {
		entries, terr := s.hf.ListTree(repo, "/items")
		if terr != nil {
			log.Printf("hub: repo %s: %v", repo, terr)
			return nil
		}
		for _, e := range entries {
			if e.Type != "file" || !strings.HasSuffix(e.Path, ".json") || strings.HasSuffix(e.Path, "index.json") {
				continue
			}
			if body, ferr := s.hf.FetchFile(repo, e.Path); ferr == nil {
				var item Item
				if json.Unmarshal(body, &item) == nil && item.ID != "" {
					items = append(items, item)
				}
			}
		}
	} else {
		log.Printf("hub: repo %s: %v", repo, err)
		return nil
	}
	out := items[:0]
	for _, item := range items {
		if item.ID == "" {
			continue
		}
		item.Repo = repo
		item.Type = spec.Type
		if item.Tags == nil {
			item.Tags = []string{}
		}
		out = append(out, item)
	}
	return out
}

// metricsFromRepo reduces one metrics repo's metrics.jsonl to per-target
// counts (hearts = heart − unheart, clamped ≥0).
func (s *Service) metricsFromRepo(repo string) map[string]*counts {
	body, err := s.hf.FetchFile(repo, metricsFile)
	if err != nil {
		if !IsNotFound(err) {
			log.Printf("hub: metrics %s: %v", repo, err)
		}
		return nil
	}
	per := map[string]*counts{}
	for _, line := range strings.Split(string(body), "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		var ev metricEvent
		if json.Unmarshal([]byte(line), &ev) != nil || ev.Target == "" {
			continue
		}
		c := per[ev.Target]
		if c == nil {
			c = &counts{}
			per[ev.Target] = c
		}
		switch ev.Op {
		case "heart":
			c.Hearts++
		case "unheart":
			c.Hearts--
		case "download":
			c.Downloads++
		}
	}
	for _, c := range per {
		if c.Hearts < 0 {
			c.Hearts = 0
		}
	}
	return per
}

// runBounded runs f(i) for 0..n-1 with at most maxWorkers in flight.
func runBounded(n int, f func(i int)) {
	if n <= 0 {
		return
	}
	width := n
	if width > maxWorkers {
		width = maxWorkers
	}
	sem := make(chan struct{}, width)
	var wg sync.WaitGroup
	for i := 0; i < n; i++ {
		wg.Add(1)
		sem <- struct{}{}
		go func(i int) {
			defer wg.Done()
			defer func() { <-sem }()
			f(i)
		}(i)
	}
	wg.Wait()
}

// Items is the library listing: local downloads merged with every remote
// item, federated metrics applied, then tag filter + search + sort.
//
//	sort: "recent" (updatedAt desc — the default without a query),
//	      "downloads" | "hearts" (count desc), "relevant" (score desc; an
//	      empty query falls back to recent).
func (s *Service) Items(typ, q, sortMode, tagFilter string, refresh bool) ([]Item, error) {
	spec, err := Get(typ)
	if err != nil {
		return nil, err
	}
	q = strings.TrimSpace(q)
	v := s.view(spec, refresh)

	// Local overlay: downloaded rows (skipping non-hub heart rows).
	local := map[string]*LocalItem{}
	if rows, err := ListLocal(s.db, typ); err == nil {
		for _, row := range rows {
			if row.Item.Repo == "" && row.Payload == "" {
				continue // persona-picker heart, not a library item
			}
			local[row.Item.ID] = row
		}
	}

	own := s.currentUser() + "/" + metricsRepo
	merged := make([]Item, 0, len(v.items)+len(local))
	seen := map[string]bool{}
	addItem := func(item Item, state *LocalState) {
		if seen[item.ID] {
			return
		}
		seen[item.ID] = true
		merged = append(merged, applyCounts(item, state, v.metrics, own))
	}
	for _, item := range v.items {
		addItem(item, rowState(local[item.ID]))
		delete(local, item.ID)
	}
	for _, row := range local { // downloaded locally but no longer indexed remotely
		addItem(row.Item, rowState(row))
	}

	// Tag filter (exact, case-insensitive).
	if tagFilter = strings.TrimSpace(tagFilter); tagFilter != "" {
		want := strings.ToLower(tagFilter)
		kept := merged[:0]
		for _, it := range merged {
			for _, tag := range it.Tags {
				if strings.ToLower(tag) == want {
					kept = append(kept, it)
					break
				}
			}
		}
		merged = kept
	}

	// Search (name + description + tags, case-insensitive substring).
	if q != "" {
		lq := strings.ToLower(q)
		kept := merged[:0]
		for _, it := range merged {
			if strings.Contains(strings.ToLower(it.Name), lq) ||
				strings.Contains(strings.ToLower(it.Description), lq) ||
				hasTag(it, lq) {
				kept = append(kept, it)
			}
		}
		merged = kept
	}

	scores := make([]int, len(merged))
	for i := range merged {
		scores[i] = relevance(merged[i], strings.ToLower(q))
	}
	if q != "" && (sortMode == "" || sortMode == "relevant") {
		sortMode = "relevant"
	} else if sortMode == "" {
		sortMode = "recent"
	}
	switch sortMode {
	case "downloads":
		sort.SliceStable(merged, func(i, j int) bool {
			if merged[i].Downloads != merged[j].Downloads {
				return merged[i].Downloads > merged[j].Downloads
			}
			return ParseTime(merged[i].UpdatedAt) > ParseTime(merged[j].UpdatedAt)
		})
	case "hearts":
		sort.SliceStable(merged, func(i, j int) bool {
			if merged[i].Hearts != merged[j].Hearts {
				return merged[i].Hearts > merged[j].Hearts
			}
			return ParseTime(merged[i].UpdatedAt) > ParseTime(merged[j].UpdatedAt)
		})
	case "relevant":
		sort.SliceStable(merged, func(i, j int) bool {
			if scores[i] != scores[j] {
				return scores[i] > scores[j]
			}
			return ParseTime(merged[i].UpdatedAt) > ParseTime(merged[j].UpdatedAt)
		})
	default: // recent
		sort.SliceStable(merged, func(i, j int) bool {
			return ParseTime(merged[i].UpdatedAt) > ParseTime(merged[j].UpdatedAt)
		})
	}
	return merged, nil
}

func hasTag(item Item, lq string) bool {
	for _, tag := range item.Tags {
		if strings.Contains(strings.ToLower(tag), lq) {
			return true
		}
	}
	return false
}

// rowState projects a local row onto the overlay shape applyCounts uses.
func rowState(row *LocalItem) *LocalState {
	if row == nil {
		return nil
	}
	return &LocalState{Hearted: row.Hearted, DownloadedAt: row.DownloadedAt}
}

// applyCounts computes the displayed counters:
//
//	hearts    = base + federatedHearts(others) + (locally hearted ? 1 : 0)
//	downloads = base + federatedDownloads(others) + (downloaded ? 1 : 0)
//
// The LOCAL user's own metrics events are excluded ("others" only) — the
// local binary state carries them instead, so a disconnected heart still
// counts once and never twice.
func applyCounts(item Item, state *LocalState, metrics map[string]map[string]*counts, ownRepo string) Item {
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
}

// countsFor returns the item with the DISPLAYED counters applied — the
// same aggregate the items list shows (federated metrics + the local
// heart/download state, the user's own metrics repo excluded). ItemDetail /
// Download / Endorse serve this view so the detail panel's counters match
// the card the user tapped.
func (s *Service) countsFor(typ string, item Item) Item {
	spec, err := Get(typ)
	if err != nil {
		return item
	}
	v := s.view(spec, false) // cached (≤10 min); never a discovery round-trip when warm
	own := s.currentUser() + "/" + metricsRepo
	var state *LocalState
	if row, lerr := GetLocalItem(s.db, typ, item.ID); lerr == nil {
		state = rowState(row)
	}
	return applyCounts(item, state, v.metrics, own)
}

// ItemDetail returns one item's meta + payload: the local copy when it is
// downloaded (fast path), else a remote fetch without saving.
func (s *Service) ItemDetail(typ, repo, id string) (Item, string, error) {
	spec, err := Get(typ)
	if err != nil {
		return Item{}, "", err
	}
	if row, err := GetLocalItem(s.db, typ, id); err == nil && row.DownloadedAt != "" {
		return s.countsFor(typ, row.Item), row.Payload, nil
	}
	meta, err := s.hf.FetchFile(repo, "items/"+id+".json")
	if err != nil {
		return Item{}, "", err
	}
	var item Item
	if err := json.Unmarshal(meta, &item); err != nil {
		return Item{}, "", fmt.Errorf("item meta is not valid JSON: %w", err)
	}
	item.Repo = repo
	item.Type = spec.Type
	if item.Tags == nil {
		item.Tags = []string{}
	}
	payload, err := s.hf.FetchFile(repo, item.File)
	if err != nil {
		return Item{}, "", err
	}
	return s.countsFor(typ, item), string(payload), nil
}

// PNG returns an item's card image bytes (nil when it has none).
func (s *Service) PNG(typ, repo, id string) ([]byte, error) {
	if _, err := Get(typ); err != nil {
		return nil, err
	}
	return s.hf.FetchFile(repo, "items/"+id+".png")
}

// Download fetches an item's meta + payload, saves it locally (downloaded
// state + local counter bump), and appends the metrics download event.
func (s *Service) Download(typ, repo, id string) (Item, string, error) {
	spec, err := Get(typ)
	if err != nil {
		return Item{}, "", err
	}
	meta, err := s.hf.FetchFile(repo, "items/"+id+".json")
	if err != nil {
		if IsNotFound(err) {
			return Item{}, "", ErrNotFoundLocal
		}
		return Item{}, "", err
	}
	var item Item
	if err := json.Unmarshal(meta, &item); err != nil {
		return Item{}, "", fmt.Errorf("item meta is not valid JSON: %w", err)
	}
	item.Repo = repo
	item.Type = spec.Type
	item.ID = id
	if item.File == "" {
		item.File = "items/" + id + spec.PayloadExt
	}
	if item.Tags == nil {
		item.Tags = []string{}
	}
	payload, err := s.hf.FetchFile(repo, item.File)
	if err != nil {
		return Item{}, "", err
	}
	if err := SaveLocalItem(s.db, item, string(payload)); err != nil {
		return Item{}, "", err
	}
	if err := MarkDownloaded(s.db, typ, id); err != nil {
		return Item{}, "", err
	}
	s.appendMetric("download", target(repo, id)) // best-effort
	s.Invalidate("")                             // counts changed
	if row, err := GetLocalItem(s.db, typ, id); err == nil {
		return s.countsFor(typ, row.Item), row.Payload, nil
	}
	return item, string(payload), nil
}

// Endorse hearts an item (REQUIRES it downloaded locally), likes the
// publisher's repo, and records the metrics heart event.
func (s *Service) Endorse(typ, repo, id string, endorse bool) (Item, error) {
	if _, err := Get(typ); err != nil {
		return Item{}, err
	}
	row, err := GetLocalItem(s.db, typ, id)
	if err != nil {
		return Item{}, ErrNotDownloaded
	}
	if row.DownloadedAt == "" {
		return Item{}, ErrNotDownloaded
	}
	if err := SetHearted(s.db, typ, id, endorse); err != nil {
		return Item{}, err
	}
	if token := s.Token(); token != "" {
		if endorse {
			if err := s.hf.LikeRepo(token, repo); err != nil {
				log.Printf("hub: like %s: %v", repo, err) // non-fatal
			}
		} else if err := s.hf.UnlikeRepo(token, repo); err != nil {
			log.Printf("hub: unlike %s: %v", repo, err)
		}
		op := "unheart"
		if endorse {
			op = "heart"
		}
		s.appendMetric(op, target(repo, id))
	}
	s.Invalidate("") // counts changed
	if row, err := GetLocalItem(s.db, typ, id); err == nil {
		return s.countsFor(typ, row.Item), nil
	}
	return Item{}, nil
}

// PublishRequest is the publish payload (the server decodes + size-caps it).
type PublishRequest struct {
	Name        string   `json:"name"`
	Description string   `json:"description"`
	Tags        []string `json:"tags"`
	Design      Design   `json:"design"`
	Payload     string   `json:"payload"`
	PNGBase64   string   `json:"pngBase64"`
}

// Publish uploads an item under the connected user's per-type dataset repo
// (creating the repo + the metrics sidecar when missing), regenerating the
// repo's items/index.json. Returns the published item.
func (s *Service) Publish(typ string, req PublishRequest) (Item, error) {
	spec, err := Get(typ)
	if err != nil {
		return Item{}, err
	}
	token := s.Token()
	if token == "" {
		return Item{}, ErrNotConnected
	}
	user := s.currentUser()
	if user == "" {
		return Item{}, ErrNotConnected
	}
	name := strings.TrimSpace(req.Name)
	if name == "" {
		return Item{}, errors.New("name is required")
	}
	if strings.TrimSpace(req.Payload) == "" {
		return Item{}, errors.New("payload is required")
	}
	id := ItemID(name, user)
	repo := user + "/" + spec.RepoName()

	// Ensure both repos exist (library + metrics sidecar).
	if _, err := s.ensureRepo(token, user, spec.RepoName(), spec.Tag); err != nil {
		return Item{}, err
	}
	if _, err := s.ensureRepo(token, user, metricsRepo, metricsTag); err != nil {
		return Item{}, err
	}

	now := NowString()
	item := Item{
		ID: id, Type: spec.Type, Name: name,
		Description: strings.TrimSpace(req.Description),
		Author:      user, Repo: repo,
		Tags:      SanitizeTags(req.Tags),
		CreatedAt: now, UpdatedAt: now,
		Design: normalizeDesign(req.Design),
		File:   "items/" + id + spec.PayloadExt,
	}
	if png := decodeB64(req.PNGBase64); len(png) > 0 && isPNG(png) {
		item.Design = Design{Kind: "png"}
	}

	// Republish keeps the original createdAt + any baked counters.
	if existing, err := s.hf.FetchFile(repo, "items/"+id+".json"); err == nil {
		var prev Item
		if json.Unmarshal(existing, &prev) == nil {
			if prev.CreatedAt != "" {
				item.CreatedAt = prev.CreatedAt
			}
			item.Hearts, item.Downloads = prev.Hearts, prev.Downloads
		}
	}

	var files []CommitFile
	metaJSON, err := json.MarshalIndent(item, "", "  ")
	if err != nil {
		return Item{}, err
	}
	files = append(files,
		CommitFile{Path: "items/" + id + ".json", Content: metaJSON},
		CommitFile{Path: item.File, Content: []byte(req.Payload)},
	)
	if item.Design.Kind == "png" {
		if png := decodeB64(req.PNGBase64); len(png) > 0 {
			files = append(files, CommitFile{Path: "items/" + id + ".png", Content: png})
		}
	}
	index, err := s.regenIndex(repo, item)
	if err == nil {
		files = append(files, CommitFile{Path: "items/index.json", Content: index})
	}
	if err := s.hf.CommitFiles(token, repo, "publish "+name, files); err != nil {
		return Item{}, err
	}

	// Save locally (the publisher obviously has it) + record the event.
	if err := SaveLocalItem(s.db, item, req.Payload); err != nil {
		return item, nil // remote succeeded; local is a bonus
	}
	_ = MarkDownloaded(s.db, typ, id)
	s.appendMetric("publish", target(repo, id))
	s.Invalidate("") // the library + metrics views changed
	return item, nil
}

// ensureRepo makes sure <user>/<name> exists and carries the tag (tags live
// in the README frontmatter — POST /api/repos/create has no tags field).
// Returns the repo id.
func (s *Service) ensureRepo(token, user, name, tag string) (string, error) {
	repo := user + "/" + name
	if card, err := s.hf.GetRepo(repo); err == nil && card != nil {
		return repo, nil // exists
	}
	if err := s.hf.CreateRepo(token, user, name); err != nil {
		return "", err
	}
	// Seed the README so the tag is discoverable via ?filter=.
	readme := "---\ntags:\n- " + tag + "\n---\n\n# " + name + "\n\nDoomalay hub library data.\n"
	if err := s.hf.CommitFiles(token, repo, "init "+name, []CommitFile{
		{Path: "README.md", Content: []byte(readme)},
	}); err != nil {
		return repo, err // the repo exists; the README is retried next publish
	}
	return repo, nil
}

// regenIndex merges the item into the repo's items/index.json (fetch →
// upsert by id → newest-first).
func (s *Service) regenIndex(repo string, item Item) ([]byte, error) {
	var items []Item
	if body, err := s.hf.FetchFile(repo, "items/index.json"); err == nil {
		_ = json.Unmarshal(body, &items)
	} else if !IsNotFound(err) {
		return nil, err
	}
	kept := items[:0]
	for _, it := range items {
		if it.ID != item.ID {
			kept = append(kept, it)
		}
	}
	kept = append(kept, item)
	sort.SliceStable(kept, func(i, j int) bool {
		return ParseTime(kept[i].UpdatedAt) > ParseTime(kept[j].UpdatedAt)
	})
	return json.MarshalIndent(kept, "", "  ")
}

// appendMetric appends one event line to the connected user's metrics.jsonl
// (creating the sidecar repo when missing). Best-effort: errors log only.
func (s *Service) appendMetric(op, tgt string) {
	token := s.Token()
	if token == "" {
		return
	}
	user := s.currentUser()
	if user == "" {
		return
	}
	repo := user + "/" + metricsRepo
	if _, err := s.ensureRepo(token, user, metricsRepo, metricsTag); err != nil {
		log.Printf("hub: metrics repo: %v", err)
		return
	}
	var body []byte
	if existing, err := s.hf.FetchFile(repo, metricsFile); err == nil {
		body = existing
	} else if !IsNotFound(err) {
		log.Printf("hub: metrics read: %v", err)
		return
	}
	ev := metricEvent{Op: op, Target: tgt, TS: NowString()}
	line, _ := json.Marshal(ev)
	merged := append(bytesTrimSpace(body), '\n')
	merged = append(merged, line...)
	merged = append(merged, '\n')
	if err := s.hf.CommitFiles(token, repo, "metrics "+op, []CommitFile{
		{Path: metricsFile, Content: merged},
	}); err != nil {
		log.Printf("hub: metrics write: %v", err)
	}
}

func target(repo, id string) string { return repo + "|" + id }

// ── local persona hearts (the persona picker) ─────────────────────────────

// HeartPersonaLocal hearts a non-hub persona (name + chat persona id).
func (s *Service) HeartPersonaLocal(personaID, name string) error {
	return HeartLocalPersona(s.db, name, personaID)
}

// UnheartPersonaLocal clears one (deleting a non-hub heart row outright).
func (s *Service) UnheartPersonaLocal(personaID, name string) error {
	return UnheartLocalPersona(s.db, name, personaID)
}

// HeartedPersonas lists hearted personas (hub + non-hub) for the picker.
func (s *Service) HeartedPersonas() ([]LocalItem, error) {
	return ListHeartedPersonas(s.db)
}

// ── tiny helpers ─────────────────────────────────────────────────────────

func decodeB64(s string) []byte {
	if s == "" {
		return nil
	}
	b, err := base64.StdEncoding.DecodeString(s)
	if err != nil {
		// Tolerate data-URL prefixes ("data:image/png;base64,…").
		if i := strings.LastIndex(s, "base64,"); i >= 0 {
			s = s[i+len("base64,"):]
		} else if i := strings.IndexByte(s, ','); i >= 0 {
			s = s[i+1:]
		}
		if b, err = base64.StdEncoding.DecodeString(strings.TrimSpace(s)); err != nil {
			return nil
		}
	}
	return b
}

func isPNG(b []byte) bool {
	return len(b) >= 4 && b[0] == 0x89 && b[1] == 0x50 && b[2] == 0x4E && b[3] == 0x47
}

// isHexColor accepts the CSS hex forms we allow as gradient stops:
// #rgb, #rrggbb and #rrggbbaa (case-insensitive).
func isHexColor(s string) bool {
	if len(s) != 4 && len(s) != 7 && len(s) != 9 {
		return false
	}
	if s[0] != '#' {
		return false
	}
	for i := 1; i < len(s); i++ {
		c := s[i]
		if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f' || c >= 'A' && c <= 'F') {
			return false
		}
	}
	return true
}

// v0.44 design caps: the uikit gradient editor grew to 15 stops and
// gained dir/angle/tex (the shared spec contract). Tex rides the item
// JSON as a dataURL string — it must LOOK like one and stay under the
// 200KB cap or it's dropped (the card still renders the bare gradient).
const (
	designMaxColors = 15
	designTexMax    = 200 << 10 // dataURL string length (chars ≈ bytes × 4/3 raw)
)

// designDirs is the v2 dir whitelist — exactly GradientUI's 12 dirs.
var designDirs = map[string]bool{
	"auto": true, "h": true, "v": true, "diag": true, "diag2": true,
	"radial": true, "swirl": true, "mesh": true,
	"pat-navy": true, "pat-pinstripe": true, "pat-gingham": true,
	"pat-sunburst": true, "pat-checker": true,
}

// normalizeDesign keeps up to 15 gradient stops (v0.44 — was 10; old
// ≤10-color rows pass untouched), dropping any stop that is not a
// strict hex color (the stops are re-emitted into CSS gradients
// client-side — they must be colors, not arbitrary strings). Dir must
// be on the whitelist (missing/unknown → "auto" — the legacy 135°
// linear sweep, so pre-v0.44 rows render exactly as before). Angle is
// clamped to 0–360. Tex must be a data:image/… URL under 200KB, else
// it's dropped. An empty color result degrades to "none".
func normalizeDesign(d Design) Design {
	switch d.Kind {
	case "gradient":
		kept := d.Colors[:0]
		for _, c := range d.Colors {
			if isHexColor(c) {
				kept = append(kept, c)
			}
			if len(kept) == designMaxColors {
				break
			}
		}
		d.Colors = kept
		if len(d.Colors) == 0 {
			d.Kind = "none"
		}
		if !designDirs[d.Dir] {
			d.Dir = "auto"
		}
		if d.Angle < 0 || d.Angle > 360 {
			d.Angle = clampInt(d.Angle, 0, 360)
		}
		if d.Tex != "" {
			if !strings.HasPrefix(d.Tex, "data:image/") || len(d.Tex) > designTexMax {
				d.Tex = ""
			}
		}
	case "png":
		// kept only when a PNG is actually attached (checked by the caller)
	default:
		d.Kind = "none"
	}
	if d.Kind != "gradient" {
		d.Colors = nil
		d.Dir = ""
		d.Angle = 0
		d.Tex = ""
	}
	return d
}

// clampInt pins v into [lo,hi] (angle sanitation helper).
func clampInt(v, lo, hi int) int {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}

func bytesTrimSpace(b []byte) []byte {
	return bytes.TrimSpace(b)
}
