package llm

// modelsdev_live.go — v1.55.3 THE LIVING CATALOG: the models.dev registry,
// fetched LIVE (ETag/304-revalidated, disk-cached beside the engine's data)
// and REPLACING the build-time snapshot as the engine's per-model metadata
// ground truth (the user's law: "no static lists, not even fallback — we
// must derive all our cloud models dynamically").
//
// THE RESEARCH (live, /home/z/my-project/v155-research/): models.dev is
// OpenCode's own org's registry (anomalyco/models.dev — "we also use it
// internally in opencode"). GET https://models.dev/api.json answers 232
// providers / 601 canonical models, keyless, ~6MB, `must-revalidate` +
// ETag (a 304 costs nothing). Per model it carries EVERYTHING the catalog
// wants: name, limit.context/input/output, cost (input/output/cache_read/
// cache_write — verified EXACT against the console pricing docs), reasoning
// + reasoning_options (the variants/effort truth: [{type:"effort",
// values:[none..max]}] | toggle | budget_tokens), tool_call,
// structured_output, modalities, status (alpha|beta|deprecated),
// canonical_model_id. Providers covered include opencode (130), openrouter
// (389), nvidia (107), mistral (39), huggingface (84), privatemode-ai (11)
// — every cloud provider the engine ships.
//
// THE HONEST-ABSENCE LAW: when models.dev is unreachable the provider
// groups still render from the provider's OWN live list (metadata-poor,
// honestly) — the registry enriches, it never gates.

import (
        "encoding/json"
        "errors"
        "fmt"
        "io"
        "net/http"
        "os"
        "path/filepath"
        "strings"
        "sync"
        "time"

        "github.com/ScoobyBaby1999/doomalay/engine/internal/netx"
)

// var (not const) so the tests can point it at an httptest server (the
// privateModeModelsURL law).
var modelsDevURL = "https://models.dev/api.json"

const (
        modelsDevTTL     = 1 * time.Hour    // in-memory freshness (a background revalidate rides every build after it)
        modelsDevTimeout = 25 * time.Second // the one cold 6MB download per boot — chat never waits on it
        modelsDevRetry   = 60 * time.Second // the failure backoff (an unreachable registry must not burn the radio)
        modelsDevMaxBody = 16 << 20         // 16MB cap (the live doc is ~6MB; headroom for growth)
)

// DevReasoningOption is one models.dev reasoning control: type "effort"
// carries the exact ladder in Values, "toggle" is on/off, "budget_tokens"
// carries Min.
type DevReasoningOption struct {
        Type   string    `json:"type"`
        Values []string  `json:"values"`
        Min    *float64 `json:"min"`
}

// DevCost is models.dev's per-1M USD pricing (0 = free; -1/absent = unknown).
type DevCost struct {
        Input      float64 `json:"input"`
        Output     float64 `json:"output"`
        CacheRead  float64 `json:"cache_read"`
        CacheWrite float64 `json:"cache_write"`
}

// DevLimit is the documented context/output ceiling.
type DevLimit struct {
        Context int64 `json:"context"`
        Input   int64 `json:"input"`
        Output  int64 `json:"output"`
}

// DevModalities carries the input/output modality lists.
type DevModalities struct {
        Input  []string `json:"input"`
        Output []string `json:"output"`
}

// DevModelLive is one live models.dev model spec.
type DevModelLive struct {
        Name             string               `json:"name"`
        Description      string               `json:"description"`
        Reasoning        bool                 `json:"reasoning"`
        ReasoningOptions []DevReasoningOption `json:"reasoning_options"`
        ToolCall         bool                 `json:"tool_call"`
        StructuredOutput bool                 `json:"structured_output"`
        Limit            DevLimit             `json:"limit"`
        Cost             DevCost              `json:"cost"`
        Status           string               `json:"status"` // alpha | beta | deprecated
        Modalities       DevModalities        `json:"modalities"`
        CanonicalID      string               `json:"canonical_model_id"`
        Type             string               `json:"type"` // "decision" models are not chat
}

// IsFree answers the cost-0 law (both directions must be 0 — a model with
// zero input but nonzero output cost is NOT free).
func (m *DevModelLive) IsFree() bool {
        return m.Cost.Input == 0 && m.Cost.Output == 0
}

// IsChatable excludes the non-chat types from the catalog (decision models).
func (m *DevModelLive) IsChatable() bool {
        return m.Type == ""
}

type devProviderLive struct {
        Name   string                     `json:"name"`
        Models map[string]*DevModelLive   `json:"models"`
}

// ── the live DB state ─────────────────────────────────────────────────────

var (
        mdMu        sync.Mutex
        mdDB        map[string]map[string]*DevModelLive // models.dev provider id → model id → spec
        mdFlat      map[string]*DevModelLive            // lookup index ("prov/id", bare "id", last segment)
        mdEtag      string
        mdFetchedAt time.Time
        mdFailedAt  time.Time
        mdReady     chan struct{} // non-nil while a fetch is in flight (single-flight)
        mdCacheDir  string       // the engine's data dir (SetCacheDir; "" = memory-only)
)

// SetCacheDir arms the disk cache (the server startup call — the engine's
// DataDir). A cold engine start reuses the disk copy instantly and
// revalidates in the background instead of re-downloading 6MB.
func SetCacheDir(dir string) {
        mdMu.Lock()
        mdCacheDir = strings.TrimSpace(dir)
        mdMu.Unlock()
}

// modelsDevProviderID maps an ENGINE provider id to its models.dev id
// (structural config, like base URLs — one table, no model data).
func modelsDevProviderID(name string) string {
        switch name {
        case "opencode":
                return "opencode"
        case "privatemodeai":
                return "privatemode-ai"
        case "hf":
                return "huggingface"
        case "nvidia", "openrouter", "mistral", "groq", "together", "openai",
                "anthropic", "deepseek", "cloudflare", "github":
                return name
        }
        return ""
}

// ensureModelsDev answers the live DB, starting (or joining) the fetch when
// needed. `wait` bounds how long a CATALOG BUILD waits for the first fetch
// — a miss is honest (the provider lists render metadata-poor and the
// negative-cache law retries the build; the registry keeps loading behind
// it). Disk-cached copies load instantly on cold boots.
func ensureModelsDev(wait time.Duration) map[string]map[string]*DevModelLive {
        mdMu.Lock()
        if mdDB != nil && time.Since(mdFetchedAt) < modelsDevTTL {
                db := mdDB
                mdMu.Unlock()
                return db
        }
        ready := mdReady
        if ready == nil {
                if time.Since(mdFailedAt) < modelsDevRetry && mdDB == nil {
                        // the failure backoff (no data at all — honest absence)
                        mdMu.Unlock()
                        return nil
                }
                // kick the fetch (single-flight)
                ready = make(chan struct{})
                mdReady = ready
                mdMu.Unlock()
                go fetchModelsDev(ready)
        } else {
                mdMu.Unlock()
        }
        select {
        case <-ready:
        case <-time.After(wait):
        }
        mdMu.Lock()
        db := mdDB
        mdMu.Unlock()
        return db
}

// modelsDevSnapshot answers the current DB without fetching (the enrichment
// path — nil is honest absence).
func modelsDevSnapshot() map[string]map[string]*DevModelLive {
        mdMu.Lock()
        defer mdMu.Unlock()
        return mdDB
}

// fetchModelsDev loads the registry: disk first (instant, cold boots), then
// the network with ETag revalidation. Every exit path closes `ready`.
func fetchModelsDev(ready chan struct{}) {
        defer func() {
                mdMu.Lock()
                mdReady = nil
                mdMu.Unlock()
                close(ready)
        }()

        // the disk belt: a cold boot serves instantly, revalidates behind it
        if mdDB == nil {
                if db, etag, at := loadModelsDevDisk(); db != nil {
                        mdMu.Lock()
                        mdDB, mdEtag, mdFetchedAt = db, etag, at
                        mdMu.Unlock()
                }
        }

        req, err := http.NewRequest("GET", modelsDevURL, nil)
        if err != nil {
                mdMu.Lock()
                mdFailedAt = time.Now()
                mdMu.Unlock()
                return
        }
        req.Header.Set("User-Agent", browserUA)
        req.Header.Set("Accept", "application/json")
        mdMu.Lock()
        etag := mdEtag
        mdMu.Unlock()
        if etag != "" {
                req.Header.Set("If-None-Match", etag)
        }
        client := &http.Client{Timeout: modelsDevTimeout, Transport: netx.Transport()}
        resp, err := client.Do(req)
        if err != nil {
                mdMu.Lock()
                mdFailedAt = time.Now()
                mdMu.Unlock()
                return
        }
        defer resp.Body.Close()
        switch resp.StatusCode {
        case http.StatusNotModified:
                // the ETag still covers us — freshness rides the revalidation itself
                mdMu.Lock()
                mdFetchedAt = time.Now()
                mdMu.Unlock()
                return
        case http.StatusOK:
        default:
                mdMu.Lock()
                mdFailedAt = time.Now()
                mdMu.Unlock()
                return
        }
        body, err := io.ReadAll(io.LimitReader(resp.Body, modelsDevMaxBody))
        if err != nil {
                mdMu.Lock()
                mdFailedAt = time.Now()
                mdMu.Unlock()
                return
        }
        var raw map[string]devProviderLive
        if err := json.Unmarshal(body, &raw); err != nil {
                mdMu.Lock()
                mdFailedAt = time.Now()
                mdMu.Unlock()
                return
        }
        db, flat := indexModelsDev(raw)
        newEtag := strings.TrimSpace(resp.Header.Get("ETag"))
        mdMu.Lock()
        if len(db) > 0 {
                mdDB, mdFlat, mdEtag, mdFetchedAt = db, flat, newEtag, time.Now()
        } else {
                mdFailedAt = time.Now()
        }
        mdMu.Unlock()
        if len(db) > 0 {
                writeModelsDevDisk(body, newEtag)
        }
}

// indexModelsDev parses the raw doc into the provider→model DB + the flat
// lookup index (the LookupSpec law: "prov/id" keys, every bare id, and the
// unambiguous last segments — engine slots arrive over-decorated like
// "nvidia/nvidia/nemotron-3.5-lightning" and "openrouter/openai/gpt-4o").
func indexModelsDev(raw map[string]devProviderLive) (map[string]map[string]*DevModelLive, map[string]*DevModelLive) {
        db := make(map[string]map[string]*DevModelLive, len(raw))
        flat := map[string]*DevModelLive{}
        bareCounts := map[string]int{} // last-segment collision counter (ambiguity guard)
        for pid, p := range raw {
                if len(p.Models) == 0 {
                        continue
                }
                models := make(map[string]*DevModelLive, len(p.Models))
                for mid, m := range p.Models {
                        models[strings.ToLower(mid)] = m
                        flat[strings.ToLower(pid+"/"+mid)] = m
                        // bare + last-segment candidates (counted — only unambiguous ones index)
                        bare := strings.ToLower(mid)
                        bareCounts[bare]++
                        if i := strings.LastIndex(bare, "/"); i >= 0 {
                                bareCounts[bare[i+1:]]++
                        }
                }
                db[strings.ToLower(pid)] = models
        }
        // second pass: index the unambiguous bare keys
        for _, p := range raw {
                for mid, m := range p.Models {
                        bare := strings.ToLower(mid)
                        if bareCounts[bare] == 1 {
                                flat[bare] = m
                        }
                        if i := strings.LastIndex(bare, "/"); i >= 0 {
                                last := bare[i+1:]
                                if bareCounts[last] == 1 {
                                        flat[last] = m
                                }
                        }
                }
        }
        return db, flat
}

// LookupDevModel answers the live spec for an engine (provider, raw id)
// pair — the exact id first, then the models.dev suffix scan (host-specific
// renames behind a bare id). nil = honestly unknown.
func LookupDevModel(provider, rawID string) *DevModelLive {
        mdMu.Lock()
        db := mdDB
        mdMu.Unlock()
        if db == nil {
                return nil
        }
        pid := modelsDevProviderID(provider)
        if pid == "" {
                return nil
        }
        rid := strings.ToLower(strings.TrimSpace(rawID))
        if rid == "" {
                return nil
        }
        if models, ok := db[pid]; ok {
                if m, ok := models[rid]; ok {
                        return m
                }
                // suffix scan: engine ids may carry a vendor prefix models.dev keys
                // differently ("nvidia/nemotron-3.5-lightning" vs "nemotron-3.5-lightning")
                if i := strings.LastIndex(rid, "/"); i >= 0 {
                        if m, ok := models[rid[i+1:]]; ok {
                                return m
                        }
                }
        }
        // the flat index's "prov/id" key (cross-provider lookups)
        mdMu.Lock()
        flat := mdFlat
        mdMu.Unlock()
        if flat != nil {
                if m, ok := flat[pid+"/"+rid]; ok {
                        return m
                }
        }
        return nil
}

// LookupSpec — THE LIVE LAW (v1.55.3): the per-model ground truth is the
// LIVE registry now (the build-time snapshot is deleted from the serving
// path — "no static lists, not even fallback"). The DevSpec API stays for
// the ledger callers; an unknown model answers (zero, false) honestly.
func LookupSpec(modelSlot string) (DevSpec, bool) {
        m := strings.ToLower(strings.TrimSpace(modelSlot))
        if m == "" {
                return DevSpec{}, false
        }
        mdMu.Lock()
        flat := mdFlat
        mdMu.Unlock()
        if flat == nil {
                return DevSpec{}, false
        }
        // candidate ladder: the full slot, then drop leading segments stepwise
        cur := m
        for {
                if s, ok := flat[cur]; ok {
                        return devSpecFrom(s), true
                }
                i := strings.IndexByte(cur, '/')
                if i < 0 || i == len(cur)-1 {
                        break
                }
                cur = cur[i+1:]
        }
        return DevSpec{}, false
}

func devSpecFrom(m *DevModelLive) DevSpec {
        return DevSpec{
                Context:    int(m.Limit.Context),
                Output:     int(m.Limit.Output),
                InputCost:  m.Cost.Input,
                OutputCost: m.Cost.Output,
                ToolCall:   zeroOne(m.ToolCall),
                Reasoning:  zeroOne(m.Reasoning),
        }
}

// ── the disk belt ─────────────────────────────────────────────────────────

func modelsDevDiskPaths() (body, etag string, ok bool) {
        if mdCacheDir == "" {
                return "", "", false
        }
        dir := filepath.Join(mdCacheDir, "catalog-cache")
        return filepath.Join(dir, "modelsdev.json"), filepath.Join(dir, "modelsdev.etag"), true
}

func loadModelsDevDisk() (map[string]map[string]*DevModelLive, string, time.Time) {
        bodyPath, etagPath, ok := modelsDevDiskPaths()
        if !ok {
                return nil, "", time.Time{}
        }
        body, err := os.ReadFile(bodyPath)
        if err != nil || len(body) == 0 {
                return nil, "", time.Time{}
        }
        var raw map[string]devProviderLive
        if json.Unmarshal(body, &raw) != nil {
                return nil, "", time.Time{}
        }
        db, flat := indexModelsDev(raw)
        if len(db) == 0 {
                return nil, "", time.Time{}
        }
        etagB, _ := os.ReadFile(etagPath)
        st, _ := os.Stat(bodyPath)
        at := time.Time{}
        if st != nil {
                at = st.ModTime()
        }
        mdMu.Lock()
        mdFlat = flat
        mdMu.Unlock()
        return db, strings.TrimSpace(string(etagB)), at
}

func writeModelsDevDisk(body []byte, etag string) {
        bodyPath, etagPath, ok := modelsDevDiskPaths()
        if !ok {
                return
        }
        dir := filepath.Dir(bodyPath)
        if err := os.MkdirAll(dir, 0o755); err != nil {
                return
        }
        tmp := bodyPath + ".tmp"
        if err := os.WriteFile(tmp, body, 0o644); err != nil {
                return
        }
        _ = os.Rename(tmp, bodyPath)
        if etag != "" {
                _ = os.WriteFile(etagPath, []byte(etag), 0o644)
        }
}

// devPricingString renders the models.dev cost as the catalog's pricing line
// (the same format every provider view row speaks).
func devPricingString(m *DevModelLive) string {
        if m.IsFree() {
                return "$0 / $0 (free)"
        }
        if m.Cost.Input < 0 && m.Cost.Output < 0 {
                return ""
        }
        return fmt.Sprintf("$%.2f / $%.2f per M", m.Cost.Input, m.Cost.Output)
}

// ── the DevSpec API (the ledger's per-model truth — LIVE-fed now) ─────────

// DevSpec is one model's documented surface (the ledger callers' shape —
// kept byte-compatible; the SOURCE changed from the build-time snapshot to
// the live registry in v1.55.3).
type DevSpec struct {
        Context    int     `json:"ctx"` // limit.context (tokens; 0 = unknown)
        Output     int     `json:"out"` // limit.output (tokens; 0 = unknown)
        InputCost  float64 `json:"i"`   // cost.input, USD per 1M tokens (-1 = unknown)
        OutputCost float64 `json:"o"`   // cost.output, USD per 1M tokens (-1 = unknown)
        ToolCall   zeroOne `json:"t"`   // documented native tool-call support
        Reasoning  zeroOne `json:"r"`   // documented reasoning support
}

// zeroOne accepts the registry's true/false flags.
type zeroOne bool

func (z *zeroOne) UnmarshalJSON(b []byte) error {
        s := strings.TrimSpace(string(b))
        *z = zeroOne(s == "1" || strings.EqualFold(s, "true"))
        return nil
}

// SpecContext returns the live registry's context window for a model slot.
func SpecContext(modelSlot string) (int, bool) {
        if s, ok := LookupSpec(modelSlot); ok && s.Context > 0 {
                return s.Context, true
        }
        return 0, false
}

// SpecMaxOutput returns the live registry's max output tokens for a slot.
func SpecMaxOutput(modelSlot string) (int, bool) {
        if s, ok := LookupSpec(modelSlot); ok && s.Output > 0 {
                return s.Output, true
        }
        return 0, false
}

// SpecPrice returns the live registry's $/M rates for a slot.
func SpecPrice(modelSlot string) (in, out float64, ok bool) {
        s, known := LookupSpec(modelSlot)
        if !known || s.InputCost < 0 || s.OutputCost < 0 {
                return 0, 0, false
        }
        return s.InputCost, s.OutputCost, true
}

// SpecSupportsTools reports whether the live registry documents native
// tool-call support for a slot (informational — the MCP wave owns routing).
func SpecSupportsTools(modelSlot string) (bool, bool) {
        s, known := LookupSpec(modelSlot)
        if !known {
                return false, false
        }
        return bool(s.ToolCall), true
}

// SetModelsDevForTest arms the live registry from a raw api.json body —
// the rigs + the cross-package pins (the server preamble checks ride the
// same live data the engine serves; the embedded snapshot is gone and
// the live fetch never runs inside a unit test).
func SetModelsDevForTest(rawJSON []byte) error {
        var raw map[string]devProviderLive
        if err := json.Unmarshal(rawJSON, &raw); err != nil {
                return err
        }
        db, flat := indexModelsDev(raw)
        if len(db) == 0 {
                return errors.New("models.dev test seed: no providers")
        }
        mdMu.Lock()
        mdDB, mdFlat, mdEtag, mdFetchedAt = db, flat, "test-seed", time.Now()
        mdMu.Unlock()
        return nil
}

// ClearModelsDevForTest empties the live registry (the honest-absence path).
func ClearModelsDevForTest() {
        mdMu.Lock()
        mdDB, mdFlat, mdEtag = nil, nil, ""
        mdFetchedAt, mdFailedAt = time.Time{}, time.Time{}
        mdMu.Unlock()
}
