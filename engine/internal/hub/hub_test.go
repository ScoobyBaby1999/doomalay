package hub

// hub_test.go — v0.31 engine behaviors: the registry, item ids + tag
// sanitation, the hub_items local store, and the service layer against an
// in-process mock Hugging Face (httptest.Server — the v301 Forwarder
// pattern, with handlers instead of forwarding).

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/ScoobyBaby1999/doomalay/engine/internal/secrets"
	"github.com/ScoobyBaby1999/doomalay/engine/internal/store"
)

// ── registry ──────────────────────────────────────────────────────────────

func TestRegistryBuiltins(t *testing.T) {
	if _, err := Get("persona"); err != nil {
		t.Fatalf("persona missing from registry: %v", err)
	}
	if _, err := Get("template"); err != nil {
		t.Fatalf("template missing from registry: %v", err)
	}
	spec, _ := Get("persona")
	if spec.Tag != "doomalay-persona" || spec.PayloadExt != ".md" {
		t.Fatalf("persona spec = %+v", spec)
	}
	if spec.RepoName() != "doomalay-personas" {
		t.Fatalf("persona repo name = %q", spec.RepoName())
	}
	if _, err := Get("icons"); err == nil {
		t.Fatal("unregistered type must error")
	}
	found := 0
	for _, s := range All() {
		if s.Type == "persona" || s.Type == "template" {
			found++
		}
	}
	if found != 2 {
		t.Fatalf("All() = %+v", All())
	}
}

func TestRegistryOneLineRegistration(t *testing.T) {
	Register(LibrarySpec{Type: "icons", Label: "Icons", Tag: "doomalay-icon", PayloadExt: ".svg"})
	defer func() { // keep the process registry clean for the other tests
		registry.Lock()
		delete(registry.byType, "icons")
		registry.Unlock()
	}()
	spec, err := Get("icons")
	if err != nil || spec.Tag != "doomalay-icon" {
		t.Fatalf("icons registration did not take: %+v %v", spec, err)
	}
}

// ── model ────────────────────────────────────────────────────────────────

func TestItemID(t *testing.T) {
	a := ItemID("Star Captain!!", "alice")
	if !strings.HasPrefix(a, "star-captain-") || len(a) != len("star-captain-")+6 {
		t.Fatalf("id = %q", a)
	}
	if a != ItemID("star   CAPTAIN__", "alice") {
		t.Fatalf("id not slug-stable: %q vs %q", a, ItemID("star   CAPTAIN__", "alice"))
	}
	if a == ItemID("Star Captain!!", "bob") {
		t.Fatal("author must be part of the digest")
	}
	if id := ItemID("!!!", "alice"); !strings.HasPrefix(id, "item-") {
		t.Fatalf("empty slug must fall back: %q", id)
	}
}

func TestSanitizeTags(t *testing.T) {
	got := SanitizeTags([]string{"  Sci-Fi ", "#hero", "HERO", "with spaces", "overlong-" + strings.Repeat("x", 40), "bad!chars"})
	want := []string{"sci-fi", "hero", "with spaces", "overlong-" + strings.Repeat("x", 15), "badchars"}
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Fatalf("SanitizeTags = %v, want %v", got, want)
	}
	var many []string
	for i := 0; i < 20; i++ {
		many = append(many, fmt.Sprintf("tag-%02d", i))
	}
	if got := SanitizeTags(many); len(got) != MaxTags {
		t.Fatalf("tag cap not enforced: %d", len(got))
	}
}

// ── local store ───────────────────────────────────────────────────────────

// v0.33→v0.44: normalizeDesign keeps up to FIFTEEN gradient stops (the
// web's gradient editor grew from 3 → 10 → 15) and drops anything that
// is not a strict hex color — the stops are re-emitted into CSS
// gradients client-side.
func TestNormalizeDesign(t *testing.T) {
	// 18 valid stops → capped at the first 15
	var eighteen []string
	for i := 0; i < 18; i++ {
		eighteen = append(eighteen, fmt.Sprintf("#%02x0000", i+1))
	}
	got := normalizeDesign(Design{Kind: "gradient", Colors: eighteen})
	if len(got.Colors) != 15 || got.Kind != "gradient" {
		t.Fatalf("18 stops → cap 15, got %d (%s)", len(got.Colors), got.Kind)
	}
	if got.Colors[0] != "#010000" {
		t.Fatalf("cap keeps the FIRST stops, got %v", got.Colors[0])
	}

	// junk entries are dropped, valid ones kept in order
	mixed := normalizeDesign(Design{Kind: "gradient",
		Colors: []string{"#ff0055", "url(evil)", "#0055ff", "red", "#abc"}})
	if fmt.Sprint(mixed.Colors) != fmt.Sprint([]string{"#ff0055", "#0055ff", "#abc"}) {
		t.Fatalf("junk stops dropped in order, got %v", mixed.Colors)
	}

	// all-junk (or empty) → degrades to none
	none := normalizeDesign(Design{Kind: "gradient", Colors: []string{"nope", "still nope"}})
	if none.Kind != "none" || none.Colors != nil {
		t.Fatalf("all-junk gradient → none, got %+v", none)
	}

	// a single valid stop stays a gradient (the editor's 1-color minimum)
	one := normalizeDesign(Design{Kind: "gradient", Colors: []string{"#38bdf8"}})
	if one.Kind != "gradient" || len(one.Colors) != 1 {
		t.Fatalf("1 stop stays a gradient, got %+v", one)
	}

	// non-gradient kinds still drop their colors (and v0.44 spec fields)
	png := normalizeDesign(Design{Kind: "png", Colors: eighteen,
		Dir: "swirl", Angle: 90, Tex: "data:image/png;base64,AAA"})
	if png.Kind != "png" || png.Colors != nil || png.Dir != "" || png.Angle != 0 || png.Tex != "" {
		t.Fatalf("png drops colors + spec fields, got %+v", png)
	}
}

// v0.44: normalizeDesign DESIGN SPEC v2 — the dir whitelist (missing or
// unknown → "auto", the legacy 135° linear render), the angle clamp,
// and the tex dataURL gate (must look like data:image/… and stay ≤200KB).
func TestNormalizeDesignV2(t *testing.T) {
	// every whitelisted dir survives verbatim
	for _, dir := range []string{"auto", "h", "v", "diag", "diag2", "radial",
		"swirl", "mesh", "pat-navy", "pat-pinstripe", "pat-gingham",
		"pat-sunburst", "pat-checker"} {
		got := normalizeDesign(Design{Kind: "gradient",
			Colors: []string{"#111111", "#222222"}, Dir: dir})
		if got.Dir != dir {
			t.Fatalf("whitelisted dir %q → %q", dir, got.Dir)
		}
	}

	// missing / unknown / injection dirs → "auto" (legacy rows keep
	// rendering the 135° linear sweep)
	for _, dir := range []string{"", "linear-gradient(evil", "none", "AUTO"} {
		got := normalizeDesign(Design{Kind: "gradient",
			Colors: []string{"#111111"}, Dir: dir})
		if got.Dir != "auto" {
			t.Fatalf("dir %q → %q, want auto", dir, got.Dir)
		}
	}

	// angle clamps into 0–360; in-range values pass
	ang := normalizeDesign(Design{Kind: "gradient", Colors: []string{"#111111"}, Angle: 400})
	if ang.Angle != 360 {
		t.Fatalf("angle 400 → %d, want 360", ang.Angle)
	}
	ang = normalizeDesign(Design{Kind: "gradient", Colors: []string{"#111111"}, Angle: -15})
	if ang.Angle != 0 {
		t.Fatalf("angle -15 → %d, want 0", ang.Angle)
	}
	ang = normalizeDesign(Design{Kind: "gradient", Colors: []string{"#111111"}, Angle: 90})
	if ang.Angle != 90 {
		t.Fatalf("angle 90 → %d, want 90", ang.Angle)
	}

	// tex: a real-shaped dataURL passes; wrong prefix, script, and
	// over-cap strings are dropped (card falls back to the gradient)
	okTex := "data:image/jpeg;base64,/9j/4AAQ"
	got := normalizeDesign(Design{Kind: "gradient", Colors: []string{"#111111"}, Tex: okTex})
	if got.Tex != okTex {
		t.Fatalf("valid tex dropped: %q", got.Tex)
	}
	for _, bad := range []string{
		"https://evil.example/x.png",                              // not inline — never fetchable
		"javascript:alert(1)",                                     // not an image
		"data:text/html;base64,PHNjcmlwdD4",                       // data URL, wrong kind
		"data:image/png;base64," + strings.Repeat("A", 200<<10+1), // over cap
	} {
		got := normalizeDesign(Design{Kind: "gradient", Colors: []string{"#111111"}, Tex: bad})
		if got.Tex != "" {
			t.Fatalf("bad tex kept: %.40s…", got.Tex)
		}
	}

	// an empty-gradient result with dir/angle/tex still degrades to none
	deg := normalizeDesign(Design{Kind: "gradient", Dir: "swirl", Angle: 45, Tex: okTex})
	if deg.Kind != "none" || deg.Dir != "" || deg.Angle != 0 || deg.Tex != "" {
		t.Fatalf("empty gradient → none, got %+v", deg)
	}
}

func openTestDB(t *testing.T) *store.DB {
	t.Helper()
	db, err := store.Open(t.TempDir())
	if err != nil {
		t.Fatalf("store: %v", err)
	}
	if err := db.Migrate(); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	return db
}

func TestLocalStoreRoundTrip(t *testing.T) {
	db := openTestDB(t)

	item := Item{
		ID: "star-captain-abc123", Type: "persona", Name: "Star Captain",
		Description: "boldly goes", Author: "alice", Repo: "alice/doomalay-personas",
		Tags: []string{"scifi"}, File: "items/star-captain-abc123.md",
	}
	if err := SaveLocalItem(db, item, "# Star Captain\nYou are..."); err != nil {
		t.Fatalf("save: %v", err)
	}
	row, err := GetLocalItem(db, "persona", "star-captain-abc123")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if row.Item.Name != "Star Captain" || row.Payload != "# Star Captain\nYou are..." {
		t.Fatalf("round-trip = %+v", row)
	}
	if row.Hearted || row.DownloadedAt != "" {
		t.Fatalf("fresh row state = %+v", row)
	}

	// download state stamps downloaded_at; the stored meta's counters stay
	// the remote base (the +1 the UI shows is applyCounts' DownloadedAt
	// overlay — a bumped counter here would double-count through countsFor).
	if err := MarkDownloaded(db, "persona", "star-captain-abc123"); err != nil {
		t.Fatalf("mark: %v", err)
	}
	if err := MarkDownloaded(db, "persona", "star-captain-abc123"); err != nil {
		t.Fatalf("mark 2: %v", err)
	}
	row, _ = GetLocalItem(db, "persona", "star-captain-abc123")
	if row.DownloadedAt == "" || row.Item.Downloads != 0 {
		t.Fatalf("downloaded = %+v", row)
	}

	// heart state
	if err := SetHearted(db, "persona", "star-captain-abc123", true); err != nil {
		t.Fatalf("heart: %v", err)
	}
	row, _ = GetLocalItem(db, "persona", "star-captain-abc123")
	if !row.Hearted || row.HeartedAt == "" {
		t.Fatalf("hearted = %+v", row)
	}
	if err := SetHearted(db, "persona", "ghost", true); err != ErrNotFound {
		t.Fatalf("hearting a missing row = %v", err)
	}

	// list
	rows, err := ListLocal(db, "persona")
	if err != nil || len(rows) != 1 {
		t.Fatalf("list = %v %v", rows, err)
	}
	if CountLocal(db, "persona") != 1 || CountLocal(db, "template") != 0 {
		t.Fatalf("counts wrong")
	}
}

func TestPersonaPickerHearts(t *testing.T) {
	db := openTestDB(t)

	// non-hub heart (name, id)
	if err := HeartLocalPersona(db, "Meadow Witch", "p_123"); err != nil {
		t.Fatalf("heart: %v", err)
	}
	hearted, err := ListHeartedPersonas(db)
	if err != nil || len(hearted) != 1 {
		t.Fatalf("hearted = %+v %v", hearted, err)
	}
	if hearted[0].Item.ID != "p_123" || hearted[0].Item.Name != "Meadow Witch" || !hearted[0].Hearted {
		t.Fatalf("hearted[0] = %+v", hearted[0])
	}
	// not a library item (repo=''+payload='')
	rows, _ := ListLocal(db, "persona")
	if len(rows) != 0 {
		t.Fatalf("non-hub heart leaked into the library list: %+v", rows)
	}

	// unheart deletes the row outright
	if err := UnheartLocalPersona(db, "Meadow Witch", "p_123"); err != nil {
		t.Fatalf("unheart: %v", err)
	}
	if hearted, _ := ListHeartedPersonas(db); len(hearted) != 0 {
		t.Fatalf("row survived unheart: %+v", hearted)
	}

	// a hub item's heart is a state flip, not a delete
	item := Item{ID: "h-1", Type: "persona", Name: "Hub", Repo: "a/doomalay-personas", Tags: []string{}}
	SaveLocalItem(db, item, "x")
	MarkDownloaded(db, "persona", "h-1")
	HeartLocalPersona(db, "Hub", "h-1") // same id as a hub row → state flip
	row, _ := GetLocalItem(db, "persona", "h-1")
	if !row.Hearted || row.Payload != "x" {
		t.Fatalf("hub heart = %+v", row)
	}
	UnheartLocalPersona(db, "Hub", "h-1")
	row, _ = GetLocalItem(db, "persona", "h-1")
	if row.Hearted {
		t.Fatalf("unheart failed: %+v", row)
	}
}

// ── mock Hugging Face ─────────────────────────────────────────────────────

// mockRepo is one in-memory dataset repo: files + the tags the mock derives
// from README frontmatter (exactly how the real hub surfaces dataset tags).
type mockRepo struct {
	files map[string][]byte
	tags  []string
}

type mockHF struct {
	mu      sync.Mutex
	repos   map[string]*mockRepo
	lfs     map[string][]byte // oid → bytes (the "S3" presigned bucket)
	likes   map[string]bool   // repo → liked by THE user
	commits []string          // raw NDJSON bodies (for assertions)
	srv     *httptest.Server
}

func newMockHF(t *testing.T) *mockHF {
	t.Helper()
	m := &mockHF{
		repos: map[string]*mockRepo{},
		lfs:   map[string][]byte{},
		likes: map[string]bool{},
	}
	mux := http.NewServeMux()

	// whoami — "goodtoken" is the only valid one.
	mux.HandleFunc("GET /api/whoami-v2", func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer goodtoken" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		writeMockJSON(w, map[string]any{"type": "user", "name": "mockuser"})
	})

	// discovery by tag.
	mux.HandleFunc("GET /api/datasets", func(w http.ResponseWriter, r *http.Request) {
		filter := r.URL.Query().Get("filter")
		m.mu.Lock()
		defer m.mu.Unlock()
		var out []map[string]any
		for id, repo := range m.repos {
			if !mockHasTag(repo, filter) {
				continue
			}
			out = append(out, map[string]any{
				"id": id, "author": strings.SplitN(id, "/", 2)[0],
				"likes": 0, "downloads": 0, "private": false,
				"lastModified": "2026-09-01T00:00:00.000Z", "tags": repo.tags,
			})
		}
		writeMockJSON(w, out)
	})

	// repo card.
	mux.HandleFunc("GET /api/datasets/{repo}", func(w http.ResponseWriter, r *http.Request) {
		m.mu.Lock()
		defer m.mu.Unlock()
		repo, ok := m.repos[r.PathValue("repo")]
		if !ok {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		writeMockJSON(w, map[string]any{"id": r.PathValue("repo"), "tags": repo.tags, "private": false})
	})

	// resolve (one repo 307s to prove redirect-following; one 500s to prove
	// skip-not-fail discovery).
	mux.HandleFunc("GET /datasets/{repo}/resolve/main/{path...}", func(w http.ResponseWriter, r *http.Request) {
		repo, path := r.PathValue("repo"), r.PathValue("path")
		m.mu.Lock()
		rp, ok := m.repos[repo]
		m.mu.Unlock()
		if !ok {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		if repo == "broken/doomalay-personas" {
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		if repo == "redir/doomalay-personas" && path == "items/index.json" {
			http.Redirect(w, r, "/datasets/redir%2Fdoomalay-personas/resolve/main/items/real-index.json", http.StatusTemporaryRedirect)
			return
		}
		m.mu.Lock()
		defer m.mu.Unlock()
		body, ok := rp.files[path]
		if !ok {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		w.Write(body)
	})

	// tree listing (index fallback).
	mux.HandleFunc("GET /api/datasets/{repo}/tree/main/{dir...}", func(w http.ResponseWriter, r *http.Request) {
		dir := r.PathValue("dir")
		m.mu.Lock()
		defer m.mu.Unlock()
		rp, ok := m.repos[r.PathValue("repo")]
		if !ok {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		prefix := strings.Trim(dir, "/") + "/"
		var out []map[string]any
		for path := range rp.files {
			if strings.HasPrefix(path, prefix) && !strings.Contains(strings.TrimPrefix(path, prefix), "/") {
				out = append(out, map[string]any{"type": "file", "path": path, "size": len(rp.files[path])})
			}
		}
		writeMockJSON(w, out)
	})

	// create repo.
	mux.HandleFunc("POST /api/repos/create", func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Type         string `json:"type"`
			Name         string `json:"name"`
			Organization string `json:"organization"`
			Private      bool   `json:"private"`
		}
		_ = json.NewDecoder(r.Body).Decode(&req)
		if req.Type != "dataset" || req.Name == "" {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		id := req.Name
		if req.Organization != "" {
			id = req.Organization + "/" + req.Name
		}
		m.mu.Lock()
		defer m.mu.Unlock()
		if _, exists := m.repos[id]; exists {
			w.WriteHeader(http.StatusConflict)
			return
		}
		m.repos[id] = &mockRepo{files: map[string][]byte{}}
		writeMockJSON(w, map[string]any{"url": "/api/datasets/" + id})
	})

	// preupload: *.png → LFS (dataset repos' default .gitattributes).
	mux.HandleFunc("POST /api/datasets/{repo}/preupload/main", func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Files []struct {
				Path string `json:"path"`
			} `json:"files"`
		}
		_ = json.NewDecoder(r.Body).Decode(&req)
		var files []map[string]any
		for _, f := range req.Files {
			mode := "regular"
			if strings.HasSuffix(f.Path, ".png") {
				mode = "lfs"
			}
			files = append(files, map[string]any{"path": f.Path, "uploadMode": mode})
		}
		writeMockJSON(w, map[string]any{"files": files})
	})

	// LFS batch. "{repo}.git" is not a legal ServeMux segment (a wildcard
	// must span the whole segment), so the /datasets/ subtree is matched
	// manually and the repo id unescaped out of the path.
	mux.HandleFunc("POST /datasets/", func(w http.ResponseWriter, r *http.Request) {
		// /datasets/<repo>.git/info/lfs/objects/batch
		esc := r.URL.EscapedPath()
		const pre, suf = "/datasets/", ".git/info/lfs/objects/batch"
		if !strings.HasPrefix(esc, pre) || !strings.HasSuffix(esc, suf) {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		repo, err := url.PathUnescape(strings.TrimSuffix(strings.TrimPrefix(esc, pre), ".git/info/lfs/objects/batch"))
		if err != nil {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		var req struct {
			Objects []struct {
				Oid  string `json:"oid"`
				Size int    `json:"size"`
			} `json:"objects"`
		}
		_ = json.NewDecoder(r.Body).Decode(&req)
		base := "http://" + r.Host
		var objects []map[string]any
		for _, o := range req.Objects {
			objects = append(objects, map[string]any{
				"oid": o.Oid, "size": o.Size,
				"actions": map[string]any{"upload": map[string]any{
					"href": base + "/lfs/" + url.PathEscape(repo) + "/" + o.Oid,
				}},
			})
		}
		writeMockJSON(w, map[string]any{"transfer": "basic", "objects": objects})
	})

	// LFS storage PUT.
	mux.HandleFunc("PUT /lfs/{repo}/{oid}", func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		m.mu.Lock()
		defer m.mu.Unlock()
		m.lfs[r.PathValue("oid")] = body
		w.WriteHeader(http.StatusOK)
	})

	// commit (NDJSON — the verified shape: header line + file/lfsFile lines).
	mux.HandleFunc("POST /api/datasets/{repo}/commit/main", func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		m.mu.Lock()
		m.commits = append(m.commits, string(body))
		rp, ok := m.repos[r.PathValue("repo")]
		m.mu.Unlock()
		if !ok {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		var err error
		for _, line := range strings.Split(strings.TrimSpace(string(body)), "\n") {
			if line == "" {
				continue
			}
			var op struct {
				Key   string `json:"key"`
				Value struct {
					Summary  string `json:"summary"`
					Path     string `json:"path"`
					Content  string `json:"content"`
					Encoding string `json:"encoding"`
					Oid      string `json:"oid"`
					Size     int    `json:"size"`
				} `json:"value"`
			}
			if err = json.Unmarshal([]byte(line), &op); err != nil {
				break
			}
			switch op.Key {
			case "file":
				content := []byte(op.Value.Content)
				if op.Value.Encoding == "base64" {
					content, err = base64.StdEncoding.DecodeString(op.Value.Content)
					if err != nil {
						break
					}
				}
				m.mu.Lock()
				rp.files[op.Value.Path] = content
				m.mu.Unlock()
			case "lfsFile":
				m.mu.Lock()
				rp.files[op.Value.Path] = m.lfs[op.Value.Oid]
				m.mu.Unlock()
			}
		}
		if err != nil {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		m.mu.Lock()
		defer m.mu.Unlock()
		mockDeriveTags(rp)
		writeMockJSON(w, map[string]any{"commitUrl": "/" + r.PathValue("repo") + "/commit/mocksha"})
	})

	// like / unlike.
	mux.HandleFunc("POST /api/datasets/{repo}/like", func(w http.ResponseWriter, r *http.Request) {
		m.mu.Lock()
		defer m.mu.Unlock()
		m.likes[r.PathValue("repo")] = true
		writeMockJSON(w, map[string]any{"liked": true})
	})
	mux.HandleFunc("DELETE /api/datasets/{repo}/like", func(w http.ResponseWriter, r *http.Request) {
		m.mu.Lock()
		defer m.mu.Unlock()
		m.likes[r.PathValue("repo")] = false
		w.WriteHeader(http.StatusOK)
	})

	m.srv = httptest.NewServer(mux)
	t.Cleanup(m.srv.Close)
	return m
}

// mockDeriveTags parses "- <tag>" lines out of the README frontmatter —
// the same way the real hub derives dataset tags.
func mockDeriveTags(rp *mockRepo) {
	readme, ok := rp.files["README.md"]
	if !ok {
		return
	}
	rp.tags = nil
	inFront := false
	for _, line := range strings.Split(string(readme), "\n") {
		if strings.TrimSpace(line) == "---" {
			if inFront {
				break
			}
			inFront = true
			continue
		}
		if inFront && strings.HasPrefix(line, "- ") {
			rp.tags = append(rp.tags, strings.TrimSpace(line[2:]))
		}
	}
}

func mockHasTag(rp *mockRepo, tag string) bool {
	for _, t := range rp.tags {
		if t == tag {
			return true
		}
	}
	return false
}

func writeMockJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}

// seedRepo adds a repo to the mock with explicit tags + files.
func (m *mockHF) seedRepo(id string, tags []string, files map[string]string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	rp := &mockRepo{files: map[string][]byte{}, tags: tags}
	for p, c := range files {
		rp.files[p] = []byte(c)
	}
	m.repos[id] = rp
}

func (m *mockHF) file(id, path string) ([]byte, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	rp, ok := m.repos[id]
	if !ok {
		return nil, false
	}
	b, ok := rp.files[path]
	return b, ok
}

func b64enc(b []byte) string { return base64.StdEncoding.EncodeToString(b) }

// newTestService boots a hub Service against the mock + fresh DB + vault.
func newTestService(t *testing.T, m *mockHF) *Service {
	t.Helper()
	db := openTestDB(t)
	vault, err := secrets.New(t.TempDir())
	if err != nil {
		t.Fatalf("vault: %v", err)
	}
	return NewService(m.srv.URL, db, vault)
}

// ── service: items / search / sort / aggregation ──────────────────────────

func seedHubFixtures(t *testing.T, m *mockHF) {
	alpha := Item{ID: "star-captain-aaaaaa", Type: "persona", Name: "Star Captain",
		Description: "boldly goes where no chat has gone", Author: "alice", Repo: "alice/doomalay-personas",
		Tags: []string{"scifi", "hero"}, UpdatedAt: "2026-08-01T00:00:00Z",
		Design: Design{Kind: "gradient", Colors: []string{"#ff0055", "#0055ff"}}, File: "items/star-captain-aaaaaa.md"}
	beta := Item{ID: "meadow-witch-bbbbbb", Type: "persona", Name: "Meadow Witch",
		Description: "herbal magic and calm rambles about hero soup", Author: "alice", Repo: "alice/doomalay-personas",
		Tags: []string{"fantasy"}, UpdatedAt: "2026-09-01T00:00:00Z", File: "items/meadow-witch-bbbbbb.md"}
	gamma := Item{ID: "noir-detective-cccccc", Type: "persona", Name: "Noir Detective",
		Description: "rain-soaked hero of the neon streets", Author: "bob", Repo: "bob/doomalay-personas",
		Tags: []string{"noir"}, UpdatedAt: "2026-07-01T00:00:00Z", File: "items/noir-detective-cccccc.md"}

	m.seedRepo("alice/doomalay-personas", []string{"doomalay-persona"}, map[string]string{
		"items/index.json":               mustJSON(t, []Item{alpha, beta}),
		"items/star-captain-aaaaaa.json": mustJSON(t, alpha),
		"items/star-captain-aaaaaa.md":   "# Star Captain\nyou command a starship",
		"items/meadow-witch-bbbbbb.json": mustJSON(t, beta),
		"items/meadow-witch-bbbbbb.md":   "# Meadow Witch\nyou brew potions",
	})
	m.seedRepo("bob/doomalay-personas", []string{"doomalay-persona"}, map[string]string{
		"items/index.json":                 mustJSON(t, []Item{gamma}),
		"items/noir-detective-cccccc.json": mustJSON(t, gamma),
		"items/noir-detective-cccccc.md":   "# Noir Detective\nyou smoke too much",
	})
	// A repo with NO index (tree fallback) + one that 500s (skip, not fail)
	// + one that serves its index via a 307 redirect.
	delta := Item{ID: "tree-fallback-dddddd", Type: "persona", Name: "Tree Fallback",
		Description: "discovered via the tree listing", Author: "carol", Repo: "carol/doomalay-personas",
		Tags: []string{"fallback"}, UpdatedAt: "2026-06-01T00:00:00Z", File: "items/tree-fallback-dddddd.md"}
	m.seedRepo("carol/doomalay-personas", []string{"doomalay-persona"}, map[string]string{
		"items/tree-fallback-dddddd.json": mustJSON(t, delta),
		"items/tree-fallback-dddddd.md":   "payload",
	})
	m.seedRepo("broken/doomalay-personas", []string{"doomalay-persona"}, map[string]string{})
	eps := Item{ID: "redirect-item-eeeeee", Type: "persona", Name: "Redirect Item",
		Description: "served via 307", Author: "redir", Repo: "redir/doomalay-personas",
		Tags: []string{}, UpdatedAt: "2026-05-01T00:00:00Z", File: "items/redirect-item-eeeeee.md"}
	m.seedRepo("redir/doomalay-personas", []string{"doomalay-persona"}, map[string]string{
		"items/real-index.json":           mustJSON(t, []Item{eps}),
		"items/redirect-item-eeeeee.json": mustJSON(t, eps),
	})

	// bob also owns the metrics sidecar with events for alice's items.
	m.seedRepo("bob/doomalay-metrics", []string{"doomalay-metrics"}, map[string]string{
		"metrics.jsonl": `{"op":"heart","target":"alice/doomalay-personas|star-captain-aaaaaa","ts":"2026-09-02T00:00:00Z"}
{"op":"download","target":"alice/doomalay-personas|star-captain-aaaaaa","ts":"2026-09-02T00:00:01Z"}
{"op":"heart","target":"alice/doomalay-personas|meadow-witch-bbbbbb","ts":"2026-09-03T00:00:00Z"}
{"op":"unheart","target":"alice/doomalay-personas|meadow-witch-bbbbbb","ts":"2026-09-04T00:00:00Z"}
{"op":"download","target":"alice/doomalay-personas|meadow-witch-bbbbbb","ts":"2026-09-04T00:00:00Z"}
`,
	})
}

func mustJSON(t *testing.T, v any) string {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	return string(b)
}

func TestItemsMergeSearchSort(t *testing.T) {
	m := newMockHF(t)
	seedHubFixtures(t, m)
	svc := newTestService(t, m)

	// full merge: alice(2) + bob(1) + carol(tree fallback) + redir(307
	// index) + broken (skipped — one failing repo must not fail the call).
	items, err := svc.Items("persona", "", "recent", "", true)
	if err != nil {
		t.Fatalf("items: %v", err)
	}
	if len(items) != 5 {
		for _, it := range items {
			t.Logf("  %s %s", it.ID, it.Repo)
		}
		t.Fatalf("want 5 merged items, got %d", len(items))
	}
	// recent: beta (Sep) → alpha (Aug) → gamma (Jul) → fallback (Jun) → redirect (May)
	wantOrder := []string{"meadow-witch-bbbbbb", "star-captain-aaaaaa", "noir-detective-cccccc", "tree-fallback-dddddd", "redirect-item-eeeeee"}
	for i, it := range items {
		if it.ID != wantOrder[i] {
			t.Fatalf("recent order[%d] = %s, want %s", i, it.ID, wantOrder[i])
		}
	}
	// metrics aggregation: star-captain hearts=1 downloads=1; meadow-witch
	// hearts=0 (heart+unheart), downloads=1.
	for _, it := range items {
		switch it.ID {
		case "star-captain-aaaaaa":
			if it.Hearts != 1 || it.Downloads != 1 {
				t.Fatalf("star captain counts = %d/%d", it.Hearts, it.Downloads)
			}
		case "meadow-witch-bbbbbb":
			if it.Hearts != 0 || it.Downloads != 1 {
				t.Fatalf("meadow witch counts = %d/%d", it.Hearts, it.Downloads)
			}
		}
	}

	// search by name
	got, _ := svc.Items("persona", "captain", "", "", true)
	if len(got) != 1 || got[0].ID != "star-captain-aaaaaa" {
		t.Fatalf("name search = %+v", ids(got))
	}
	// search by tag
	got, _ = svc.Items("persona", "scifi", "", "", true)
	if len(got) != 1 || got[0].ID != "star-captain-aaaaaa" {
		t.Fatalf("tag search = %+v", ids(got))
	}
	// search by description
	got, _ = svc.Items("persona", "rain-soaked", "", "", true)
	if len(got) != 1 || got[0].ID != "noir-detective-cccccc" {
		t.Fatalf("desc search = %+v", ids(got))
	}

	// sort: downloads (alpha=1, beta=1 — tie broken by recent)
	got, _ = svc.Items("persona", "", "downloads", "", true)
	if got[0].ID != "meadow-witch-bbbbbb" || got[1].ID != "star-captain-aaaaaa" {
		t.Fatalf("downloads order = %s, %s", got[0].ID, got[1].ID)
	}
	// sort: hearts (alpha=1 only)
	got, _ = svc.Items("persona", "", "hearts", "", true)
	if got[0].ID != "star-captain-aaaaaa" {
		t.Fatalf("hearts order = %s", got[0].ID)
	}

	// relevance: "hero" is star-captain's TAG (+2) and appears in the
	// descriptions of the witch (+1) and the detective (+1).
	got, _ = svc.Items("persona", "hero", "relevant", "", true)
	if len(got) != 3 || got[0].ID != "star-captain-aaaaaa" {
		t.Fatalf("relevance = %+v", ids(got))
	}
	// empty query + relevant falls back to recent ordering
	got, _ = svc.Items("persona", "", "relevant", "", true)
	if got[0].ID != "meadow-witch-bbbbbb" {
		t.Fatalf("empty-query relevant = %s", got[0].ID)
	}
	// default sort without a query is recent
	got, _ = svc.Items("persona", "", "", "", true)
	if got[0].ID != "meadow-witch-bbbbbb" {
		t.Fatalf("default sort = %s", got[0].ID)
	}
	// default sort WITH a query is relevant
	got, _ = svc.Items("persona", "witch", "", "", true)
	if got[0].ID != "meadow-witch-bbbbbb" {
		t.Fatalf("query default sort = %s", got[0].ID)
	}

	// tag filter
	got, _ = svc.Items("persona", "", "recent", "fantasy", true)
	if len(got) != 1 || got[0].ID != "meadow-witch-bbbbbb" {
		t.Fatalf("tag filter = %+v", ids(got))
	}

	// unknown library
	if _, err := svc.Items("icons", "", "", "", false); err == nil {
		t.Fatal("unknown type must error")
	}
}

func ids(items []Item) []string {
	out := make([]string, len(items))
	for i, it := range items {
		out[i] = it.ID
	}
	return out
}

// ── service: download / endorse / publish ─────────────────────────────────

func TestDownloadPersistsAndCounts(t *testing.T) {
	m := newMockHF(t)
	seedHubFixtures(t, m)
	svc := newTestService(t, m)

	item, payload, err := svc.Download("persona", "alice/doomalay-personas", "star-captain-aaaaaa")
	if err != nil {
		t.Fatalf("download: %v", err)
	}
	if item.Name != "Star Captain" || item.Author != "alice" {
		t.Fatalf("item = %+v", item)
	}
	if payload != "# Star Captain\nyou command a starship" {
		t.Fatalf("payload = %q", payload)
	}
	row, err := GetLocalItem(svc.db, "persona", "star-captain-aaaaaa")
	if err != nil || row.DownloadedAt == "" || row.Payload != payload {
		t.Fatalf("local row = %+v %v", row, err)
	}
	// not connected → no metrics event was written; the local state still
	// bumps the visible download count by one (2 = 1 federated + 1 local).
	items, _ := svc.Items("persona", "", "downloads", "", true)
	var sc *Item
	for i := range items {
		if items[i].ID == "star-captain-aaaaaa" {
			sc = &items[i]
		}
	}
	if sc == nil || sc.Downloads != 2 {
		t.Fatalf("star captain downloads = %+v", sc)
	}

	// detail now takes the local fast path.
	_, localPayload, err := svc.ItemDetail("persona", "alice/doomalay-personas", "star-captain-aaaaaa")
	if err != nil || localPayload != payload {
		t.Fatalf("detail = %q %v", localPayload, err)
	}
}

func TestEndorseRequiresDownload(t *testing.T) {
	m := newMockHF(t)
	seedHubFixtures(t, m)
	svc := newTestService(t, m)

	// NOT downloaded → rejected
	if _, err := svc.Endorse("persona", "alice/doomalay-personas", "star-captain-aaaaaa", true); err != ErrNotDownloaded {
		t.Fatalf("endorse without download = %v", err)
	}

	// download then endorse (still not connected: local heart only)
	if _, _, err := svc.Download("persona", "alice/doomalay-personas", "star-captain-aaaaaa"); err != nil {
		t.Fatalf("download: %v", err)
	}
	if _, err := svc.Endorse("persona", "alice/doomalay-personas", "star-captain-aaaaaa", true); err != nil {
		t.Fatalf("endorse: %v", err)
	}
	row, _ := GetLocalItem(svc.db, "persona", "star-captain-aaaaaa")
	if !row.Hearted {
		t.Fatal("heart state not set")
	}
	// unendorse mirrors
	if _, err := svc.Endorse("persona", "alice/doomalay-personas", "star-captain-aaaaaa", false); err != nil {
		t.Fatalf("unendorse: %v", err)
	}
	row, _ = GetLocalItem(svc.db, "persona", "star-captain-aaaaaa")
	if row.Hearted {
		t.Fatal("heart state not cleared")
	}
}

func TestEndorseWithTokenLikesAndRecordsMetrics(t *testing.T) {
	m := newMockHF(t)
	seedHubFixtures(t, m)
	svc := newTestService(t, m)

	if _, err := svc.Connect("goodtoken"); err != nil {
		t.Fatalf("connect: %v", err)
	}
	if _, _, err := svc.Download("persona", "alice/doomalay-personas", "star-captain-aaaaaa"); err != nil {
		t.Fatalf("download: %v", err)
	}
	if _, err := svc.Endorse("persona", "alice/doomalay-personas", "star-captain-aaaaaa", true); err != nil {
		t.Fatalf("endorse: %v", err)
	}

	m.mu.Lock()
	liked := m.likes["alice/doomalay-personas"]
	_, hasMetrics := m.repos["mockuser/doomalay-metrics"]
	m.mu.Unlock()
	if !liked {
		t.Fatal("publisher repo was not liked")
	}
	if !hasMetrics {
		t.Fatal("metrics repo was not created")
	}
	body, _ := m.file("mockuser/doomalay-metrics", "metrics.jsonl")
	if body == nil {
		t.Fatal("metrics.jsonl missing")
	}
	if n := strings.Count(string(body), "\n"); n != 2 { // download + heart
		t.Fatalf("metrics.jsonl = %q (%d events, want 2)", body, n)
	}
	if !strings.Contains(string(body), `"op":"heart"`) || !strings.Contains(string(body), `"op":"download"`) {
		t.Fatalf("metrics.jsonl = %q", body)
	}
	if !strings.Contains(string(body), `"target":"alice/doomalay-personas|star-captain-aaaaaa"`) {
		t.Fatalf("metrics target wrong: %q", body)
	}

	// the user's OWN metrics events must not double-count their local state:
	// hearts = 1 federated (bob) + 1 local = 2.
	items, _ := svc.Items("persona", "", "hearts", "", true)
	if items[0].ID != "star-captain-aaaaaa" || items[0].Hearts != 2 {
		t.Fatalf("hearts after own endorse = %+v", items[0])
	}
}

func TestPublishFlow(t *testing.T) {
	m := newMockHF(t)
	seedHubFixtures(t, m)
	svc := newTestService(t, m)

	// not connected → ErrNotConnected
	_, err := svc.Publish("persona", PublishRequest{Name: "X", Payload: "y"})
	if err != ErrNotConnected {
		t.Fatalf("publish without token = %v", err)
	}
	if _, err := svc.Connect("goodtoken"); err != nil {
		t.Fatalf("connect: %v", err)
	}

	png := []byte{0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 1, 2, 3, 4, 5}
	tags := []string{}
	for i := 0; i < 20; i++ {
		tags = append(tags, fmt.Sprintf("tag-%02d", i))
	}
	item, err := svc.Publish("persona", PublishRequest{
		Name:        "Mock Persona!!",
		Description: "published from a test",
		Tags:        tags,
		Design:      Design{Kind: "gradient", Colors: []string{"#111111", "#222222"}},
		Payload:     "# Mock Persona\nhello",
		PNGBase64:   b64enc(png),
	})
	if err != nil {
		t.Fatalf("publish: %v", err)
	}
	wantID := ItemID("Mock Persona!!", "mockuser")
	if item.ID != wantID || item.Author != "mockuser" || item.Repo != "mockuser/doomalay-personas" {
		t.Fatalf("item = %+v", item)
	}
	if item.File != "items/"+wantID+".md" || item.Design.Kind != "png" {
		t.Fatalf("item file/design = %+v", item)
	}

	// repos exist + files present (PNG went through the LFS path)
	repo := "mockuser/doomalay-personas"
	for _, path := range []string{
		"README.md",
		"items/" + wantID + ".json",
		"items/" + wantID + ".md",
		"items/" + wantID + ".png",
		"items/index.json",
	} {
		if b, ok := m.file(repo, path); !ok {
			t.Fatalf("missing %s in %s", path, repo)
		} else if path == "items/"+wantID+".png" && !strings.HasPrefix(string(b), "\x89PNG") {
			t.Fatalf("png bytes did not round-trip through LFS: %q", b)
		}
	}
	meta, _ := m.file(repo, "items/"+wantID+".json")
	var stored Item
	if err := json.Unmarshal(meta, &stored); err != nil {
		t.Fatalf("stored meta: %v", err)
	}
	if stored.Author != "mockuser" || stored.Type != "persona" {
		t.Fatalf("stored meta = %+v", stored)
	}
	if len(stored.Tags) != MaxTags {
		t.Fatalf("stored tags = %d, want cap %d", len(stored.Tags), MaxTags)
	}
	// the commits carried an NDJSON header line + the LFS pointer for the png
	foundHeader, foundLFS := false, false
	m.mu.Lock()
	allCommits := append([]string(nil), m.commits...)
	m.mu.Unlock()
	for _, commit := range allCommits {
		for _, line := range strings.Split(commit, "\n") {
			if strings.Contains(line, `"key":"header"`) {
				foundHeader = true
			}
			if strings.Contains(line, `"key":"lfsFile"`) && strings.Contains(line, `"path":"items/`+wantID+`.png"`) {
				foundLFS = true
			}
		}
	}
	if !foundHeader || !foundLFS {
		t.Fatalf("commit NDJSON missing shapes (header=%v lfs=%v)", foundHeader, foundLFS)
	}
	// the index was regenerated with the new item
	index, _ := m.file(repo, "items/index.json")
	if !strings.Contains(string(index), wantID) {
		t.Fatalf("index missing the item: %s", index)
	}
	m.mu.Lock()
	tagged := mockHasTag(m.repos[repo], "doomalay-persona")
	m.mu.Unlock()
	if !tagged {
		t.Fatal("repo not tagged doomalay-persona (README frontmatter)")
	}

	// the local copy exists (the publisher obviously has it) + the publish
	// event landed in the metrics sidecar
	row, err := GetLocalItem(svc.db, "persona", wantID)
	if err != nil || row.DownloadedAt == "" {
		t.Fatalf("local copy = %+v %v", row, err)
	}
	ev, _ := m.file("mockuser/doomalay-metrics", "metrics.jsonl")
	if !strings.Contains(string(ev), `"op":"publish"`) {
		t.Fatalf("publish event missing: %q", ev)
	}

	// the item now shows up in the (refreshed) listing
	items, _ := svc.Items("persona", "", "recent", "", true)
	found := false
	for _, it := range items {
		if it.ID == wantID {
			found = true
		}
	}
	if !found {
		t.Fatal("published item not in listing")
	}

	// name required
	if _, err := svc.Publish("persona", PublishRequest{Payload: "x"}); err == nil || !strings.Contains(err.Error(), "name is required") {
		t.Fatalf("nameless publish = %v", err)
	}
	// payload required
	if _, err := svc.Publish("persona", PublishRequest{Name: "x"}); err == nil || !strings.Contains(err.Error(), "payload is required") {
		t.Fatalf("payloadless publish = %v", err)
	}
}

func TestConnectAndDisconnect(t *testing.T) {
	m := newMockHF(t)
	svc := newTestService(t, m)

	if _, err := svc.Connect("badtoken"); !IsUnauthorized(err) {
		t.Fatalf("bad token must fail with 401: %v", err)
	}
	if svc.Token() != "" || svc.Username() != "" {
		t.Fatal("failed connect must not store anything")
	}
	name, err := svc.Connect("goodtoken")
	if err != nil || name != "mockuser" {
		t.Fatalf("connect = %q %v", name, err)
	}
	if svc.Token() != "goodtoken" || svc.Username() != "mockuser" {
		t.Fatalf("token=%q username=%q", svc.Token(), svc.Username())
	}
	if err := svc.Disconnect(); err != nil {
		t.Fatalf("disconnect: %v", err)
	}
	if svc.Token() != "" || svc.Username() != "" {
		t.Fatal("disconnect must clear the token")
	}
}

func TestTimeHelpers(t *testing.T) {
	now := time.Now().Unix()
	s := TimeString(now)
	if ParseTime(s) != now {
		t.Fatalf("time round-trip: %q", s)
	}
	if ParseTime("not-a-time") != 0 {
		t.Fatal("bad time must be 0")
	}
}
