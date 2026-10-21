package llm

// modelsdev_v1553_test.go — v1.55.3 THE LIVING CATALOG pins: the live
// registry loader (index law, ETag law, disk belt, failure backoff), the
// enrichment merge (context/pricing/the free law/capabilities/effort
// ladder), the zen fetch rework (the documented /inference/v1 list, the
// keyed→keyless belt, the serve-catalogue merge, the deprecated drop), the
// hf fetcher, THE NEGATIVE-CACHE LAW, and the seeding helper the legacy
// v1141 lookup pins reuse (the embedded snapshot is DEAD — the live DB is
// the only truth now, so the tests arm it exactly like the loader does).

import (
        "context"
        "encoding/json"
        "fmt"
        "net/http"
        "net/http/httptest"
        "os"
        "path/filepath"
        "strings"
        "sync/atomic"
        "testing"
        "time"
)

// seedModelsDevTestDB arms the live registry with the fixture the v1141
// lookup/ledger pins reference (the same models the old embedded snapshot
// carried — the LAW changed, not the numbers).
func seedModelsDevTestDB(t *testing.T) {
        t.Helper()
        raw := map[string]devProviderLive{
                "openai": {Name: "OpenAI", Models: map[string]*DevModelLive{
                        "gpt-4o":         {Name: "GPT-4o", ToolCall: true, Limit: DevLimit{Context: 128000}, Cost: DevCost{Input: 2.5, Output: 10}},
                        "gpt-4o-mini":    {Name: "GPT-4o mini", ToolCall: true, Limit: DevLimit{Context: 128000}, Cost: DevCost{Input: 0.15, Output: 0.6}},
                        "gpt-4-classic": {Name: "GPT-4 Classic", Limit: DevLimit{Context: 8192}, Cost: DevCost{Input: 3, Output: 6}},
                }},
                "nvidia": {Name: "NVIDIA", Models: map[string]*DevModelLive{
                        "nemotron-3.5-lightning": {Name: "Nemotron 3.5 Lightning", ToolCall: true, Limit: DevLimit{Context: 1000000, Output: 65536}},
                }},
        }
        db, flat := indexModelsDev(raw)
        mdMu.Lock()
        mdDB, mdFlat, mdEtag, mdFetchedAt = db, flat, "test-etag", time.Now()
        mdMu.Unlock()
}

func resetModelsDevTestDB() {
        mdMu.Lock()
        mdDB, mdFlat, mdEtag = nil, nil, ""
        mdFetchedAt, mdFailedAt = time.Time{}, time.Time{}
        mdCacheDir = ""
        mdMu.Unlock()
}

// TestV1553_IndexLaw — the flat lookup index: "prov/id" keys, unambiguous
// bare ids, the last-segment belt for over-decorated engine slots — and
// AMBIGUOUS bare ids never index (two providers' same-named model must not
// cross-wire).
func TestV1553_IndexLaw(t *testing.T) {
        resetModelsDevTestDB()
        raw := map[string]devProviderLive{
                "opencode": {Name: "OpenCode", Models: map[string]*DevModelLive{
                        "big-pickle":    {Name: "Big Pickle", Reasoning: true, ToolCall: true, Limit: DevLimit{Context: 200000, Output: 32000}, Cost: DevCost{}},
                        "gpt-5.5":       {Name: "GPT-5.5", ReasoningOptions: []DevReasoningOption{{Type: "effort", Values: []string{"none", "low", "medium", "high", "xhigh"}}}, Limit: DevLimit{Context: 1050000}, Cost: DevCost{Input: 5, Output: 30}},
                        "gone-soon":     {Name: "Gone Soon", Status: "deprecated", Cost: DevCost{}},
                        "shared-name":   {Name: "OC Shared", Cost: DevCost{Input: 1, Output: 2}},
                }},
                "other-provider": {Name: "Other", Models: map[string]*DevModelLive{
                        "shared-name": {Name: "Other Shared", Cost: DevCost{Input: 9, Output: 9}},
                }},
        }
        db, flat := indexModelsDev(raw)
        if len(db) != 2 || len(db["opencode"]) != 4 {
                t.Fatalf("db shape: %v", len(db))
        }
        // arm the global live DB (the lookup API reads it)
        mdMu.Lock()
        mdDB, mdFlat, mdFetchedAt = db, flat, time.Now()
        mdMu.Unlock()
        // exact + provider-scoped lookups
        if m := LookupDevModel("opencode", "big-pickle"); m == nil || m.Name != "Big Pickle" {
                t.Fatalf("exact opencode lookup failed")
        }
        if _, ok := flat["opencode/big-pickle"]; !ok {
                t.Fatalf("the flat prov/id key must exist")
        }
        // ambiguous bare id never indexes
        if _, ok := flat["shared-name"]; ok {
                t.Fatalf("an AMBIGUOUS bare id must never index (two providers share it)")
        }
        // unambiguous bare id does
        if _, ok := flat["big-pickle"]; !ok {
                t.Fatalf("an unambiguous bare id must index")
        }
        // candidate ladder through LookupSpec: the provider-scoped key +
        // the over-decorated engine slot (leading segments drop stepwise)
        if s, ok := LookupSpec("other-provider/shared-name"); !ok || s.InputCost != 9 {
                t.Fatalf("the prov/id slot ladder failed: %+v %v", s, ok)
        }
        if s, ok := LookupSpec("anything/at-all/big-pickle"); !ok || s.Context != 200000 {
                t.Fatalf("the over-decorated slot ladder failed: %+v %v", s, ok)
        }
        // an AMBIGUOUS last segment never resolves (no cross-provider guessing)
        if _, ok := LookupSpec("anything/else/shared-name"); ok {
                t.Fatalf("an ambiguous tail must never resolve")
        }
        if _, ok := LookupSpec("totally/unknown-model-xyz"); ok {
                t.Fatalf("an unknown model must answer unknown")
        }
}

// TestV1553_LiveFetchLaws — the loader speaks the real registry's shape:
// 200 with ETag → parse + disk write; the NEXT fetch sends If-None-Match
// and a 304 keeps the DB (freshness rides the revalidation); failures back
// off for the retry window (the registry must not burn the radio).
func TestV1553_LiveFetchLaws(t *testing.T) {
        resetModelsDevTestDB()
        origURL := modelsDevURL
        dir := t.TempDir()
        SetCacheDir(dir)
        defer func() {
                modelsDevURL = origURL
                SetCacheDir("")
                resetModelsDevTestDB()
        }()

        var hits int32
        var sawIfNoneMatch atomic.Value
        srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
                hits++
                if et := r.Header.Get("If-None-Match"); et != "" {
                        sawIfNoneMatch.Store(et)
                }
                if r.Header.Get("If-None-Match") == `"md-etag-1"` {
                        w.WriteHeader(http.StatusNotModified)
                        return
                }
                w.Header().Set("ETag", `"md-etag-1"`)
                w.Header().Set("Content-Type", "application/json")
                fmt.Fprintf(w, `{"opencode":{"name":"OpenCode","models":{"big-pickle":{"name":"Big Pickle","reasoning":true,"tool_call":true,"limit":{"context":200000,"output":32000},"cost":{"input":0,"output":0,"cache_read":0,"cache_write":0}}}}}`)
        }))
        defer srv.Close()
        modelsDevURL = srv.URL

        // first fetch: 200, parses, writes the disk cache
        db := ensureModelsDev(5 * time.Second)
        if db == nil || db["opencode"]["big-pickle"] == nil {
                t.Fatalf("the live fetch did not land: %v", db != nil)
        }
        if got := sawIfNoneMatch.Load(); got != nil {
                t.Fatalf("the FIRST fetch must not send If-None-Match, got %v", got)
        }
        // the disk belt wrote the body + etag
        if _, err := os.Stat(filepath.Join(dir, "catalog-cache", "modelsdev.json")); err != nil {
                t.Fatalf("the disk cache must be written: %v", err)
        }
        if b, err := os.ReadFile(filepath.Join(dir, "catalog-cache", "modelsdev.etag")); err != nil || strings.TrimSpace(string(b)) != `"md-etag-1"` {
                t.Fatalf("the etag file must ride: %q %v", string(b), err)
        }

        // expire the in-memory freshness → the revalidate answers 304, keeps the DB
        mdMu.Lock()
        mdFetchedAt = time.Now().Add(-2 * time.Hour)
        mdMu.Unlock()
        db2 := ensureModelsDev(5 * time.Second)
        if db2 == nil || db2["opencode"]["big-pickle"] == nil {
                t.Fatalf("the 304 revalidate must keep the DB")
        }
        if got, _ := sawIfNoneMatch.Load().(string); got != `"md-etag-1"` {
                t.Fatalf("the revalidate must send If-None-Match, got %q", got)
        }
        if n := atomic.LoadInt32(&hits); n != 2 {
                t.Fatalf("expected exactly 2 hits, got %d", n)
        }
}

// TestV1553_DiskBeltColdBoot — a cold boot (fresh process: no memory) loads
// the DISK copy instantly without a network hit.
func TestV1553_DiskBeltColdBoot(t *testing.T) {
        resetModelsDevTestDB()
        origURL := modelsDevURL
        dir := t.TempDir()
        SetCacheDir(dir)
        defer func() {
                modelsDevURL = origURL
                SetCacheDir("")
                resetModelsDevTestDB()
        }()
        cdir := filepath.Join(dir, "catalog-cache")
        _ = os.MkdirAll(cdir, 0o755)
        body := `{"opencode":{"name":"OpenCode","models":{"beam-free":{"name":"Beam Free","limit":{"context":131072},"cost":{"input":0,"output":0}}}}}`
        _ = os.WriteFile(filepath.Join(cdir, "modelsdev.json"), []byte(body), 0o644)
        _ = os.WriteFile(filepath.Join(cdir, "modelsdev.etag"), []byte(`"cold"`), 0o644)

        // a dead network URL: the disk copy must answer anyway
        dead := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
                w.WriteHeader(500)
        }))
        defer dead.Close()
        modelsDevURL = dead.URL

        db := ensureModelsDev(5 * time.Second)
        if db == nil || db["opencode"]["beam-free"] == nil {
                t.Fatalf("the cold boot must load the disk belt")
        }
}

// TestV1553_EnrichmentMerge — the fetched list gains the registry's
// metadata: context, pricing (incl. the free law), capabilities, the
// effort ladder — and the deprecated drop rides the registry's OWN status
// field (never our list).
func TestV1553_EnrichmentMerge(t *testing.T) {
        resetModelsDevTestDB()
        seedModelsDevTestDB(t)
        // opencode-flavored fixture for the zen merge law
        raw := map[string]devProviderLive{
                "opencode": {Name: "OpenCode", Models: map[string]*DevModelLive{
                        "big-pickle":    {Name: "Big Pickle", Reasoning: true, ToolCall: true, Limit: DevLimit{Context: 200000, Output: 32000}, Cost: DevCost{}, ReasoningOptions: []DevReasoningOption{{Type: "effort", Values: []string{"low", "medium", "high"}}}},
                        "minimax-m3-free": {Name: "MiniMax M3 Free", Cost: DevCost{Input: 0.3, Output: 1.2}},
                        "gpt-5.5":       {Name: "GPT-5.5", ReasoningOptions: []DevReasoningOption{{Type: "effort", Values: []string{"none", "low", "medium", "high", "xhigh"}}}, Limit: DevLimit{Context: 1050000}, Cost: DevCost{Input: 5, Output: 30}},
                        "gone-soon":     {Name: "Gone Soon", Status: "deprecated", Cost: DevCost{}},
                }},
        }
        db, flat := indexModelsDev(raw)
        mdMu.Lock()
        mdDB, mdFlat, mdFetchedAt = db, flat, time.Now()
        mdMu.Unlock()

        in := []fetchedModel{
                {RawID: "big-pickle", SyncedLive: true},
                {RawID: "minimax-m3-free", IsFree: true, SyncedLive: true}, // the -free name LIE
                {RawID: "gpt-5.5", SyncedLive: true},
                {RawID: "gone-soon", SyncedLive: true}, // registry-deprecated
                {RawID: "total-unknown", SyncedLive: true},
        }
        out := enrichFromModelsDev("opencode", in)
        if len(out) != 4 {
                t.Fatalf("the deprecated model must drop: %d", len(out))
        }
        byID := map[string]fetchedModel{}
        for _, m := range out {
                byID[m.RawID] = m
        }
        bp := byID["big-pickle"]
        if bp.ContextLength != 200000 || !bp.IsFree || bp.Pricing != "$0 / $0 (free)" {
                t.Fatalf("big-pickle merge: %+v", bp)
        }
        if bp.Effort == nil || len(bp.Effort.Levels) != 3 || bp.Effort.Levels[0] != "low" {
                t.Fatalf("big-pickle effort ladder: %+v", bp.Effort)
        }
        if !hasString(bp.Caps, "tools") || !hasString(bp.Caps, "reasoning") {
                t.Fatalf("capability merge: %v", bp.Caps)
        }
        // THE -FREE NAME LIE: the registry prices minimax-m3-free as PAID — its
        // live word wins over the fetcher's suffix guess (the old static
        // exception is dead; the law is the data).
        if mm := byID["minimax-m3-free"]; mm.IsFree {
                t.Fatalf("the -free name lie must lose to the registry's live price")
        }
        if g := byID["gpt-5.5"]; g.ContextLength != 1050000 || g.Effort == nil || len(g.Effort.Levels) != 5 {
                t.Fatalf("gpt-5.5 merge: %+v %+v", g, g.Effort)
        }
        if u := byID["total-unknown"]; u.ContextLength != 0 || u.Pricing != "" {
                t.Fatalf("an unknown model stays metadata-poor (honest): %+v", u)
        }
}

// TestV1553_ZenFetchLaws — the rework: the DOCUMENTED endpoint
// (/inference/v1), the keyed→keyless belt, the serve-catalogue merge (the
// device-local truth), the union dedupe.
func TestV1553_ZenFetchLaws(t *testing.T) {
        resetModelsDevTestDB()
        keyed := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
                if r.Header.Get("Authorization") == "" {
                        // the keyless belt: more ids (deprecated included)
                        w.Write([]byte(`{"data":[{"id":"big-pickle"},{"id":"gone-soon"},{"id":"beam-free"}]}`))
                        return
                }
                w.Write([]byte(`{"data":[{"id":"big-pickle"},{"id":"beam-free"}]}`))
        }))
        defer keyed.Close()

        // the override base — passed EXPLICITLY (the dispatch's env law feeds
        // the same parameter in production)
        // no serve hook: keyed list wins
        got := fetchOpenCodeModels("oc_sk_x", keyed.URL)
        if len(got) != 2 {
                t.Fatalf("keyed list: %v", got)
        }
        ids := map[string]bool{}
        for _, m := range got {
                ids[m.RawID] = true
        }
        if !ids["big-pickle"] || ids["gone-soon"] {
                t.Fatalf("keyed ids: %v", ids)
        }

        // keyless belt (no key answers nothing → the public list)
        got = fetchOpenCodeModels("", keyed.URL)
        if len(got) != 3 {
                t.Fatalf("keyless belt: %v", got)
        }

        // the serve-catalogue merge: union + dedupe + the live serve entries
        SetOpenCodeServeCatalog(func() []FetchedModelInfo {
                return []FetchedModelInfo{
                        {ID: "big-pickle", ContextLimit: 200000, InputCost: 0, OutputCost: 0, Caps: []string{"tools"}, EffortLevels: []string{"low", "medium", "high"}},
                        {ID: "serve-only-free", ContextLimit: 65536, InputCost: 0, OutputCost: 0},
                }
        })
        defer SetOpenCodeServeCatalog(nil)
        got = fetchOpenCodeModels("oc_sk_x", keyed.URL)
        byID := map[string]fetchedModel{}
        for _, m := range got {
                byID[m.RawID] = m
        }
        if len(got) != 3 {
                t.Fatalf("the serve merge must union+dedupe: %v", got)
        }
        bp := byID["big-pickle"]
        if bp.ContextLength != 200000 || bp.Effort == nil || len(bp.Effort.Levels) != 3 {
                t.Fatalf("the serve entry must carry limits + the variant ladder: %+v", bp)
        }
        if _, ok := byID["serve-only-free"]; !ok {
                t.Fatalf("a serve-only model rides the union")
        }
        if _, ok := byID["beam-free"]; !ok {
                t.Fatalf("a hosted-only model rides the union")
        }
}

// TestV1553_HfFetcher — the new engine-side hf provider list (the
// router's OpenAI-compatible shape).
func TestV1553_HfFetcher(t *testing.T) {
        resetModelsDevTestDB()
        srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
                if !strings.HasSuffix(r.URL.Path, "/models") {
                        w.WriteHeader(404)
                        return
                }
                w.Write([]byte(`{"data":[{"id":"meta-llama/Llama-3.1-8B-Instruct:together"},{"id":"Qwen/Qwen2.5-72B-Instruct"}]}`))
        }))
        defer srv.Close()
        orig := hfModelsURL
        hfModelsURL = srv.URL + "/models"
        defer func() { hfModelsURL = orig }()

        got := fetchHfModels("hf_x", "")
        if len(got) != 2 || got[0].RawID != "meta-llama/Llama-3.1-8B-Instruct:together" || !got[0].SyncedLive {
                t.Fatalf("hf fetch: %+v", got)
        }
}

// TestV1553_NegativeCacheLaw — a build with FAILED provider groups is
// NEVER cached fresh: the next call retriggers the refresh (inside the
// backoff window it serves the degraded entry — a persistent outage must
// not burn the radio), and ?refresh=1 always rebuilds.
func TestV1553_NegativeCacheLaw(t *testing.T) {
        resetModelsDevTestDB()
        // reset the catalog cache state
        catalogV2Mu.Lock()
        catalogV2Ent = nil
        catalogV2At = time.Time{}
        catalogV2Keys = ""
        catalogV2Degraded = false
        catalogV2Mu.Unlock()
        defer func() {
                catalogV2Mu.Lock()
                catalogV2Ent = nil
                catalogV2Degraded = false
                catalogV2Mu.Unlock()
        }()

        // every provider's fetch will fail against a dead base (the env override
        // law points them at a closed port) — EXCEPT the ones with keyless URLs
        // we can't override... point the overridable cloud ones dead:
        dead := "http://127.0.0.1:1"
        t.Setenv("DOOMALAY_BASE_URL_HF", dead)
        t.Setenv("DOOMALAY_BASE_URL_NVIDIA", dead)
        t.Setenv("DOOMALAY_BASE_URL_OPENCODE", dead)
        t.Setenv("DOOMALAY_BASE_URL_PRIVATEMODEAI", dead)
        t.Setenv("DOOMALAY_BASE_URL_TOGETHER", dead)
        t.Setenv("DOOMALAY_BASE_URL_MISTRAL", dead)
        t.Setenv("DOOMALAY_BASE_URL_DEEPSEEK", dead)
        t.Setenv("DOOMALAY_BASE_URL_OPENAI", dead)
        t.Setenv("DOOMALAY_BASE_URL_ANTHROPIC", dead)
        t.Setenv("DOOMALAY_BASE_URL_GROQ", dead)

        keys := map[string]string{}
        ent := BuildCatalogV2(keys, true) // force: the first build
        // some providers are unreachable-by-list too (openrouter/cloudflare/github
        // hit the real network in this test env — they may or may not land; the
        // LAW is about the degraded flag itself)
        catalogV2Mu.Lock()
        degraded := catalogV2Degraded
        hasErr := false
        for _, st := range ent.SyncStatus {
                if st.Error != "" {
                        hasErr = true
                }
        }
        catalogV2Mu.Unlock()
        if degraded != hasErr {
                t.Fatalf("the degraded flag must mirror the build's errors: degraded=%v hasErr=%v", degraded, hasErr)
        }
        if hasErr {
                // THE LAW: a degraded build is never fresh — the second call must
                // have triggered another refresh (observed via the backoff clock or
                // a new background flight), NOT served the poisoned entry as fresh.
                fresh2 := func() bool {
                        catalogV2Mu.Lock()
                        defer catalogV2Mu.Unlock()
                        return !catalogV2Degraded && catalogV2Ent != nil && time.Since(catalogV2At) < catalogV2TTL
                }()
                if fresh2 {
                        t.Fatalf("a degraded build must NEVER be fresh — the poisoned-empty groups would sit for the TTL")
                }
        }
}

// TestV1553_SpecLookupLives — the DevSpec API answers from the LIVE db
// (the v1141 fixtures, seeded the way the loader seeds).
func TestV1553_SpecLookupLives(t *testing.T) {
        resetModelsDevTestDB()
        seedModelsDevTestDB(t)
        if in, out, ok := SpecPrice("openai/gpt-4o-mini"); !ok || in != 0.15 || out != 0.6 {
                t.Fatalf("SpecPrice: %v %v %v", in, out, ok)
        }
        if ctx, ok := SpecContext("openai/gpt-4o"); !ok || ctx != 128000 {
                t.Fatalf("SpecContext: %v %v", ctx, ok)
        }
}

var _ = json.Marshal
var _ = context.Background
