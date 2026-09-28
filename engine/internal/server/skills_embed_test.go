package server

// skills_embed_test.go — v0.69 THE EMBEDDED LIBRARY: on deployments that
// ship the engine binary without a brain/ directory (the APK, the desktop
// binaries), skillsDir() falls back to the hfzero-embedded agent_skills
// subtree, extracting it once per engine build into <DataDir>/brain/
// agent_skills. These tests pin that contract without depending on the
// repo layout (BrainDir pointed at a nonexistent path + a temp DataDir
// simulate a bare-binary install).

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/ScoobyBaby1999/doomalay/engine/internal/buildinfo"
	"github.com/ScoobyBaby1999/doomalay/engine/internal/config"
	"github.com/ScoobyBaby1999/doomalay/engine/internal/store"
)

func newEmbeddedSkillsTestServer(t *testing.T) *Server {
	t.Helper()
	dir := t.TempDir()
	db, err := store.Open(dir)
	if err != nil {
		t.Fatalf("store: %v", err)
	}
	if err := db.Migrate(); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	cfg := &config.Config{
		// a brain dir that does NOT exist — the bare-binary install shape
		BrainDir: filepath.Join(dir, "no-such-brain"),
		DataDir:  dir,
	}
	return New(cfg, db, nil)
}

func TestEmbeddedSkillsExtraction(t *testing.T) {
	s := newEmbeddedSkillsTestServer(t)

	// the embedded library must actually exist (make sync-hfzero keeps
	// engine/internal/hfzero/brain in step with brain/)
	entries, err := skillsIndexFor(s)
	if err != nil {
		t.Fatalf("skillsIndex on a bare-binary install: %v (the embedded fallback failed)", err)
	}
	if len(entries) == 0 {
		t.Fatal("the embedded skills index is empty")
	}
	// the flagship bootstrap skill must be there (the tool's first call)
	var hasBootstrap bool
	for _, e := range entries {
		if e.Name == "superpowers-using-superpowers" || e.Dir == "superpowers-using-superpowers" {
			hasBootstrap = true
		}
	}
	if !hasBootstrap {
		t.Fatal("superpowers-using-superpowers missing from the embedded library")
	}

	// the extraction landed inside DataDir, stamped for this build
	root := filepath.Join(s.cfg.DataDir, "brain", "agent_skills")
	if fi, err := os.Stat(filepath.Join(root, "superpowers-using-superpowers", "SKILL.md")); err != nil || fi.IsDir() {
		t.Fatalf("the extracted SKILL.md is missing: %v", err)
	}
	stamp, err := os.ReadFile(filepath.Join(s.cfg.DataDir, "brain", skillsStampName))
	if err != nil {
		t.Fatalf("the extraction stamp is missing: %v", err)
	}
	want := buildinfo.Version
	if want == "" {
		want = "dev"
	}
	if string(stamp) != want {
		t.Fatalf("stamp = %q, want %q", string(stamp), want)
	}
}

func TestEmbeddedSkillsReextractOnStampMismatch(t *testing.T) {
	s := newEmbeddedSkillsTestServer(t)
	root := filepath.Join(s.cfg.DataDir, "brain", "agent_skills")

	// first call extracts
	if _, err := skillsIndexFor(s); err != nil {
		t.Fatalf("first index: %v", err)
	}
	// simulate an upgrade: stale stamp + a stale marker file inside the tree
	if err := os.WriteFile(filepath.Join(s.cfg.DataDir, "brain", skillsStampName), []byte("v0.0.1-old"), 0o644); err != nil {
		t.Fatal(err)
	}
	stale := filepath.Join(root, "stale-skill", "SKILL.md")
	if err := os.MkdirAll(filepath.Dir(stale), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(stale, []byte("stale"), 0o644); err != nil {
		t.Fatal(err)
	}
	// a fresh engine-build stamp value forces re-extraction
	old := buildinfo.Version
	buildinfo.Version = "v9.9.9-test"
	defer func() { buildinfo.Version = old }()

	entries, err := skillsIndexFor(s)
	if err != nil {
		t.Fatalf("re-extract index: %v", err)
	}
	if _, err := os.Stat(stale); !os.IsNotExist(err) {
		t.Fatal("the stale tree survived the re-extraction (RemoveAll+Rename contract broken)")
	}
	found := false
	for _, e := range entries {
		if strings.HasPrefix(e.Dir, "superpowers") || strings.Contains(e.Name, "superpowers") {
			found = true
		}
	}
	if !found {
		t.Fatal("the re-extracted library lost the superpowers skills")
	}
}

func TestEmbeddedSkillsPrefersRealBrain(t *testing.T) {
	// a REAL brain dir always wins — the repo-root dev install and the HF
	// image keep reading brain/ directly, embedded copy untouched
	s := newEmbeddedSkillsTestServer(t)
	real := filepath.Join(s.cfg.DataDir, "real-brain", "agent_skills", "test-skill")
	if err := os.MkdirAll(real, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(real, "SKILL.md"),
		[]byte("---\nname: test-skill\ndescription: only on disk\n---\nbody"), 0o644); err != nil {
		t.Fatal(err)
	}
	s.cfg.BrainDir = filepath.Join(s.cfg.DataDir, "real-brain")
	if got := s.skillsDir(); got != filepath.Join(s.cfg.DataDir, "real-brain", "agent_skills") {
		t.Fatalf("skillsDir = %q, want the real brain dir", got)
	}
}

// skillsIndexFor forces a fresh index (the cache is sig'd on the dir mtime;
// a brand-new extraction dir has a fresh mtime anyway, but be explicit).
func skillsIndexFor(s *Server) ([]skillsEntry, error) {
	skillsIdxMu.Lock()
	skillsIdxCache = nil
	skillsIdxSig = ""
	skillsIdxMu.Unlock()
	return s.skillsIndex()
}
