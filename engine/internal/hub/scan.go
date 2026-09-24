// scan.go — the repo scanner (v0.48): turns ANY public doomalay-* HF
// dataset into hub items, whatever layout it uses.
//
// The hub used to understand exactly one layout (items/index.json + per
// item meta files) and discover repos ONLY by doomalay-* tag — so the
// superpowers corpus (published with topical tags, payloads as root-level
// *.jsonl corpora) was invisible. The scanner accepts three layouts,
// probed in order (first one that yields items wins — no double-counting
// a repo that ships several):
//
//   1. HUB-NATIVE   items/index.json (an array of Item) — the publish
//      path's layout. Items carry their own type.
//
//   2. CORPUS JSONL root-level *.jsonl files, one line per item:
//          {"template": "<key>", "file": "...", "content": "<payload>"}
//          {"skill":    "<key>", "file": "...", "description": "...",
//           "content": "<SKILL.md>"}
//          {"persona":  "<key>", "file": "...", "content": "<.md>"}
//          {"theme":    "<key>", "file": "...", "content": "<bundle>"}
//      The kind comes from the row's key field (fallback: the filename).
//      A template row whose content is a JSON ARRAY of user templates
//      (e.g. superpowers_user_templates) expands to one item per entry —
//      each stays individually downloadable.
//
//   3. DIRECTORY     personas/*.md, templates/*.json, skills/<name>/
//      SKILL.md trees (the agentskills.io layout), themes/*.doomtheme —
//      for casually posted datasets with no corpus index at all.
//
// Payload refs for corpus rows are "<jsonl path>#<row key>" (plus
// ":<child name>" for expanded array entries) — resolvePayload() is the
// single place that understands them.
package hub

import (
        "encoding/json"
        "log"
        "strings"
        "sync"
        "time"
)

// scanTTL mirrors itemsTTL: a repo scan is a fan-out (tree + several file
// fetches), too slow to redo per keystroke.
const scanTTL = itemsTTL

// scanEntry is the cached result of scanning one repo.
type scanEntry struct {
        byType map[string][]Item
        at     time.Time
}

// scanMu guards scans (several library types share one repo scan).
//
// v0.48 note: Service.mu guards the per-type caches; the scan cache is
// deliberately separate so a template-library rebuild can reuse a scan
// the skill library just paid for.
func (s *Service) scanRepo(card RepoCard) *scanEntry {
        s.scanMu.Lock()
        cached := s.scans[card.ID]
        fresh := cached != nil && time.Since(cached.at) < scanTTL
        s.scanMu.Unlock()
        if fresh {
                return cached
        }
        res := s.scanRepoFresh(card)
        s.scanMu.Lock()
        s.scans[card.ID] = res
        s.scanMu.Unlock()
        return res
}

// corpusRow is one line of a *.jsonl corpus (the key field that is set
// names the kind — template | skill | persona).
type corpusRow struct {
        Template    string `json:"template"`
        Skill       string `json:"skill"`
        Persona     string `json:"persona"`
        Theme       string `json:"theme"`
        File        string `json:"file"`
        Description string `json:"description"`
        Content     string `json:"content"`
        Icon        string `json:"icon"`
        Collection  string `json:"collection"`
}

// scanRepoFresh probes one repo's layout and builds items per type.
// One failing fetch never fails the scan — it is logged and skipped.
func (s *Service) scanRepoFresh(card RepoCard) *scanEntry {
        res := &scanEntry{byType: map[string][]Item{}, at: time.Now()}

        // 1) hub-native index.
        if body, err := s.hf.FetchFile(card.ID, "items/index.json"); err == nil {
                var items []Item
                if json.Unmarshal(body, &items) == nil {
                        for _, item := range items {
                                if item.ID == "" {
                                        continue
                                }
                                if item.Type == "" {
                                        item.Type = "template" // native items carry a type; default sensibly
                                }
                                stampScanItem(&item, &card, "")
                                res.byType[item.Type] = append(res.byType[item.Type], item)
                        }
                }
                return res // the publish path's layout — authoritative
        } else if !IsNotFound(err) {
                log.Printf("hub: scan %s: %v", card.ID, err)
                return res
        }

        // 1b) hub-native fallback: no index, but per-item metas in items/
        // (the old v0.31 probe — kept for crashed-publish recovery).
        if entries, err := s.hf.ListTree(card.ID, "/items"); err == nil {
                for _, e := range entries {
                        if e.Type != "file" || !strings.HasSuffix(e.Path, ".json") || strings.HasSuffix(e.Path, "index.json") {
                                continue
                        }
                        if body, ferr := s.hf.FetchFile(card.ID, e.Path); ferr == nil {
                                var item Item
                                if json.Unmarshal(body, &item) == nil && item.ID != "" {
                                        stampScanItem(&item, &card, "")
                                        res.byType[item.Type] = append(res.byType[item.Type], item)
                                }
                        }
                }
                if len(res.byType) > 0 {
                        return res
                }
        }

        // 2) corpus JSONL files at the root.
        entries, err := s.hf.ListTree(card.ID, "/")
        if err != nil {
                log.Printf("hub: scan %s: tree: %v", card.ID, err)
                return res
        }
        for _, e := range entries {
                if e.Type != "file" || !strings.HasSuffix(e.Path, ".jsonl") {
                        continue
                }
                body, err := s.hf.FetchFile(card.ID, e.Path)
                if err != nil {
                        log.Printf("hub: scan %s: %s: %v", card.ID, e.Path, err)
                        continue
                }
                s.scanCorpusLines(card, e.Path, string(body), res)
        }
        if len(res.byType) > 0 {
                return res // corpus wins — the dir trees below are the same data
        }

        // 3) conventional directories (casually posted datasets).
        type dirSpec struct {
                path string
                typ  string
                ext  string
        }
        for _, d := range []dirSpec{
                {"personas", "persona", ".md"},
                {"templates", "template", ".json"},
                {"skills", "skill", ".md"},
                {"themes", "theme", ".doomtheme"},
        } {
                list, err := s.hf.ListTree(card.ID, "/"+d.path)
                if err != nil {
                        continue // no such dir — fine
                }
                for _, e := range list {
                        if e.Type != "file" || !strings.HasSuffix(e.Path, d.ext) || strings.HasSuffix(strings.ToLower(e.Path), "index.json") {
                                continue
                        }
                        name := prettifyKey(strings.TrimSuffix(lastSegment(e.Path), d.ext))
                        if name == "" {
                                continue
                        }
                        item := Item{
                                ID:      ItemID(name, repoOwner(card.ID)),
                                Type:    d.typ,
                                Name:    name,
                                Repo:    card.ID,
                                File:    e.Path,
                        }
                        stampScanItem(&item, &card, "")
                        res.byType[d.typ] = append(res.byType[d.typ], item)
                }
                // agentskills.io layout: skills/<name>/SKILL.md — the dir listing
                // shows directories, one extra listing each (bounded, cached 10min).
                if d.typ == "skill" {
                        var dirs []string
                        for _, e := range list {
                                if e.Type == "directory" {
                                        dirs = append(dirs, e.Path)
                                }
                        }
                        var mu sync.Mutex
                        runBounded(len(dirs), func(i int) {
                                sub, err := s.hf.ListTree(card.ID, "/"+strings.TrimPrefix(dirs[i], "/"))
                                if err != nil {
                                        return
                                }
                                for _, e := range sub {
                                        if e.Type != "file" || lastSegment(e.Path) != "SKILL.md" {
                                                continue
                                        }
                                        name := prettifyKey(lastSegment(dirs[i]))
                                        item := Item{
                                                ID:   ItemID(name, repoOwner(card.ID)),
                                                Type: "skill",
                                                Name: name,
                                                Repo: card.ID,
                                                File: e.Path,
                                        }
                                        stampScanItem(&item, &card, "")
                                        mu.Lock()
                                        res.byType["skill"] = append(res.byType["skill"], item)
                                        mu.Unlock()
                                }
                        })
                }
        }
        return res
}

// scanCorpusLines reduces one corpus file's lines into items. Rows whose
// key field names the kind are classified by it; otherwise the filename
// hints (…templates… → template, …skills… → skill, …personas… → persona);
// otherwise JSON content means template, markdown content means persona.
func (s *Service) scanCorpusLines(card RepoCard, path, body string, res *scanEntry) {
        owner := repoOwner(card.ID)
        for _, line := range strings.Split(body, "\n") {
                line = strings.TrimSpace(line)
                if line == "" {
                        continue
                }
                var row corpusRow
                if json.Unmarshal([]byte(line), &row) != nil {
                        continue
                }
                if row.Content == "" && row.Description == "" {
                        continue
                }
                typ, key := classifyCorpusRow(row, path)
                if typ == "" || key == "" {
                        continue
                }
                name := prettifyKey(key)
                tags := scanTags(card, key)

                // Template rows may carry a JSON ARRAY of user templates — expand.
                if typ == "template" {
                        if children := expandUserTemplates(row.Content); len(children) > 0 {
                                for _, child := range children {
                                        childName := child["name"]
                                        if childName == "" {
                                                continue
                                        }
                                        payload, err := json.Marshal(child)
                                        if err != nil {
                                                continue
                                        }
                                        item := Item{
                                                ID:          ItemID(childName, owner+"\x00"+key),
                                                Type:        typ,
                                                Name:        childName,
                                                Description: firstNonEmpty(child["description"], row.Description),
                                                Author:      owner,
                                                Repo:        card.ID,
                                                Tags:        tags,
                                                Icon:        SanitizeIcon(row.Icon),
                                                Collection:  SanitizeCollection(row.Collection),
                                                UpdatedAt:   card.LastModified,
                                                File:        path + "#" + key + ":" + childName,
                                        }
                                        s.registerScanItem(res, item, string(payload))
                                }
                                continue
                        }
                }

                item := Item{
                        ID:          ItemID(name, owner),
                        Type:        typ,
                        Name:        name,
                        Description: firstNonEmpty(row.Description, jsonDocComment(row.Content)),
                        Author:      owner,
                        Repo:        card.ID,
                        Tags:        tags,
                        Icon:        SanitizeIcon(row.Icon),
                        Collection:  SanitizeCollection(row.Collection),
                        UpdatedAt:   card.LastModified,
                        File:        path + "#" + key,
                }
                s.registerScanItem(res, item, row.Content)
        }
}

// registerScanItem adds one scanned item, deduping by id (two corpus
// files could describe the same key — first one wins).
func (s *Service) registerScanItem(res *scanEntry, item Item, _ string) {
        for _, existing := range res.byType[item.Type] {
                if existing.ID == item.ID {
                        return
                }
        }
        res.byType[item.Type] = append(res.byType[item.Type], item)
}

// classifyCorpusRow decides (type, key) for one corpus row.
func classifyCorpusRow(row corpusRow, path string) (string, string) {
        switch {
        case row.Template != "":
                return "template", row.Template
        case row.Skill != "":
                return "skill", row.Skill
        case row.Persona != "":
                return "persona", row.Persona
        case row.Theme != "":
                return "theme", row.Theme
        }
        lower := strings.ToLower(path)
        switch {
        case strings.Contains(lower, "theme"):
                return "theme", row.File
        case strings.Contains(lower, "template"):
                return "template", row.File
        case strings.Contains(lower, "skill"):
                return "skill", row.File
        case strings.Contains(lower, "persona"):
                return "persona", row.File
        }
        trimmed := strings.TrimSpace(row.Content)
        if strings.HasPrefix(trimmed, "{") || strings.HasPrefix(trimmed, "[") {
                return "template", row.File
        }
        return "persona", row.File
}

// resolvePayload fetches one item's payload, understanding corpus refs:
// "<path>#<row key>" (and "<path>#<row key>:<child name>" for expanded
// array entries). Plain paths hit FetchFile directly.
func (s *Service) resolvePayload(repo, ref string) (string, error) {
        hash := strings.IndexByte(ref, '#')
        if hash < 0 {
                body, err := s.hf.FetchFile(repo, ref)
                if err != nil {
                        return "", err
                }
                return string(body), nil
        }
        path, sel := ref[:hash], ref[hash+1:]
        key, child := sel, ""
        if colon := strings.IndexByte(sel, ':'); colon >= 0 {
                key, child = sel[:colon], sel[colon+1:]
        }
        body, err := s.hf.FetchFile(repo, path)
        if err != nil {
                return "", err
        }
        for _, line := range strings.Split(string(body), "\n") {
                line = strings.TrimSpace(line)
                if line == "" {
                        continue
                }
                var row corpusRow
                if json.Unmarshal([]byte(line), &row) != nil {
                        continue
                }
                if row.Template != key && row.Skill != key && row.Persona != key && row.Theme != key {
                        continue
                }
                if child != "" {
                        for _, el := range expandUserTemplates(row.Content) {
                                if el["name"] == child {
                                        if b, err := json.Marshal(el); err == nil {
                                                return string(b), nil
                                        }
                                }
                        }
                }
                return row.Content, nil
        }
        return "", ErrNotFoundLocal
}

// expandUserTemplates returns the entries of a JSON array of user
// templates ({"name", "description", "markdown", …}) — nil when the
// content is not such an array.
func expandUserTemplates(content string) []map[string]string {
        trimmed := strings.TrimSpace(content)
        if !strings.HasPrefix(trimmed, "[") {
                return nil
        }
        var raw []map[string]any
        if json.Unmarshal([]byte(trimmed), &raw) != nil || len(raw) == 0 {
                return nil
        }
        out := make([]map[string]string, 0, len(raw))
        for _, el := range raw {
                name, _ := el["name"].(string)
                if name == "" {
                        continue // not template-shaped
                }
                entry := map[string]string{"name": name}
                if desc, ok := el["description"].(string); ok {
                        entry["description"] = desc
                }
                if md, ok := el["markdown"].(string); ok {
                        entry["markdown"] = md
                } else if md, ok := el["template"].(string); ok {
                        entry["markdown"] = md
                }
                if _, hasBody := entry["markdown"]; !hasBody && entry["description"] == "" {
                        continue
                }
                out = append(out, entry)
        }
        if len(out) == 0 {
                return nil
        }
        return out
}

// jsonDocComment pulls the first "//" header comment out of a stage-JSON
// payload (the superpowers orchestrator files describe themselves there).
func jsonDocComment(content string) string {
        trimmed := strings.TrimSpace(content)
        if !strings.HasPrefix(trimmed, "{") {
                return ""
        }
        var m map[string]any
        if json.Unmarshal([]byte(trimmed), &m) != nil {
                return ""
        }
        if v, ok := m["//"].(string); ok {
                return oneLineComment(v)
        }
        if v, ok := m["task"].(string); ok && v != "" {
                return v
        }
        return ""
}

func oneLineComment(s string) string {
        s = strings.TrimSpace(s)
        if i := strings.IndexByte(s, '\n'); i >= 0 {
                s = s[:i]
        }
        if len(s) > 180 {
                s = s[:180] + "…"
        }
        return s
}

// scanTags derives an item's tags: the corpus key's prefix ("superpowers"
// out of "superpowers_brainstorm") plus the repo card's topical tags.
func scanTags(card RepoCard, key string) []string {
        var out []string
        seen := map[string]bool{}
        add := func(t string) {
                t = strings.ToLower(strings.TrimSpace(t))
                if t == "" || seen[t] || len(out) >= 8 {
                        return
                }
                seen[t] = true
                out = append(out, t)
        }
        if key != "" {
                prefix := key
                if i := strings.IndexAny(prefix, "-_"); i > 0 {
                        prefix = prefix[:i]
                }
                add(prefix)
        }
        for _, t := range card.Tags {
                lower := strings.ToLower(t)
                if strings.ContainsAny(lower, ":") { // region:us, license:mit, …
                        continue
                }
                add(lower)
        }
        return out
}

// stampScanItem fills the shared scan-derived fields on a hub-native or
// directory-probed item (corpus rows set them inline).
func stampScanItem(item *Item, card *RepoCard, _ string) {
        if item.Type == "" {
                item.Type = "template"
        }
        if item.Author == "" {
                item.Author = repoOwner(card.ID)
        }
        if item.UpdatedAt == "" {
                item.UpdatedAt = card.LastModified
        }
        if item.Tags == nil {
                item.Tags = scanTags(*card, item.Name)
        }
}

// prettifyKey turns a corpus key into a display name:
// "superpowers_brainstorm" → "Superpowers Brainstorm".
func prettifyKey(key string) string {
        fields := strings.FieldsFunc(strings.TrimSpace(key), func(r rune) bool {
                return r == '_' || r == '-' || r == ' '
        })
        acronyms := map[string]string{
                "tdd": "TDD", "sdd": "SDD", "pr": "PR", "ci": "CI",
                "qa": "QA", "llm": "LLM", "api": "API", "ui": "UI",
        }
        var out []string
        for _, f := range fields {
                if f == "" {
                        continue
                }
                if up, ok := acronyms[strings.ToLower(f)]; ok {
                        out = append(out, up)
                        continue
                }
                out = append(out, strings.ToUpper(f[:1])+f[1:])
        }
        return strings.Join(out, " ")
}

// repoOwner splits "user/name" → "user" (whole id when no slash).
func repoOwner(repo string) string {
        if i := strings.IndexByte(repo, '/'); i >= 0 {
                return repo[:i]
        }
        return repo
}

// lastSegment returns the path's final segment.
func lastSegment(path string) string {
        if i := strings.LastIndexByte(path, '/'); i >= 0 {
                return path[i+1:]
        }
        return path
}

func firstNonEmpty(vals ...string) string {
        for _, v := range vals {
                if v != "" {
                        return v
                }
        }
        return ""
}
