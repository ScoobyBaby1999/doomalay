package hfzero

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestTemplateHackElements — the four things that MUST be in app.py for the
// ZeroGPU paywall hack to hold. If any is missing the space build will
// RUNTIME_ERROR with "No @spaces.GPU function detected during startup"
// (or accept unauthenticated traffic).
func TestTemplateHackElements(t *testing.T) {
	files, err := Files()
	if err != nil {
		t.Fatal(err)
	}
	var appPy, readme, reqs string
	brainCount := 0
	for _, f := range files {
		switch f.Path {
		case "app.py":
			appPy = string(f.Content)
		case "README.md":
			readme = string(f.Content)
		case "requirements.txt":
			reqs = string(f.Content)
		default:
			if strings.HasPrefix(f.Path, "brain/") {
				brainCount++
			}
		}
	}
	if appPy == "" || readme == "" || reqs == "" {
		t.Fatalf("missing template files: app=%d readme=%d reqs=%d", len(appPy), len(readme), len(reqs))
	}
	if brainCount < 40 {
		t.Fatalf("suspiciously few brain files embedded: %d", brainCount)
	}

	// 1. spaces import + @spaces.GPU noop (the shape-check satisfier)
	if !strings.Contains(appPy, "import spaces") {
		t.Error("app.py: missing `import spaces`")
	}
	if !strings.Contains(appPy, "@spaces.GPU") {
		t.Error("app.py: missing @spaces.GPU noop")
	}
	// 2. the manual startup report
	if !strings.Contains(appPy, "startup_report()") {
		t.Error("app.py: missing manual spaces.zero.client.startup_report()")
	}
	// 3. fail-closed auth (no accidental public sandbox)
	if !strings.Contains(appPy, "X-Space-Token") || !strings.Contains(appPy, "compare_digest") {
		t.Error("app.py: missing constant-time space-token auth")
	}
	// 4. workspace containment (sanitized ids, scoped roots)
	if !strings.Contains(appPy, "WORKSPACES_ROOT") || !strings.Contains(appPy, `[^a-zA-Z0-9_-]`) {
		t.Error("app.py: missing workspace sanitization/scoping")
	}

	// README front-matter must be the gradio SDK (the free ZeroGPU path)
	if !strings.Contains(readme, "sdk: gradio") {
		t.Error("README.md: sdk must be gradio (the free ZeroGPU creation path)")
	}
	// requirements must NOT pin gradio (preinstalled; pinning risks build conflicts)
	for _, bad := range []string{"gradio==", "gradio>=", "spaces=="} {
		if strings.Contains(reqs, bad) {
			t.Errorf("requirements.txt: must not pin %q (preinstalled in the image)", bad)
		}
	}
	// the brain's server must be embedded
	found := false
	for _, f := range files {
		if f.Path == "brain/server.py" {
			found = true
		}
	}
	if !found {
		t.Error("brain/server.py not embedded")
	}
}

// TestSanitizeSpaceName — HF repo name rules.
func TestSanitizeSpaceName(t *testing.T) {
	cases := map[string]string{
		"my cool space":  "my-cool-space",
		"-leading":       "leading",
		"trailing-":      "trailing",
		"we!@#ird":       "weird",
		"under_score":    "under-score",
		"":               "",
		strings.Repeat("a", 100): strings.Repeat("a", 48),
	}
	for in, want := range cases {
		if got := SanitizeSpaceName(in); got != want {
			t.Errorf("SanitizeSpaceName(%q) = %q, want %q", in, got, want)
		}
	}
}

// TestSpaceURL — the hf.space subdomain scheme.
func TestSpaceURL(t *testing.T) {
	if got, want := SpaceURL("ScoobyBaby1999/doomalay-abc123"),
		"https://scoobybaby1999-doomalay-abc123.hf.space"; got != want {
		t.Errorf("SpaceURL = %q, want %q", got, want)
	}
	if SpaceURL("noslash") != "" {
		t.Error("SpaceURL should reject malformed repos")
	}
}

// TestBrainSyncFreshness — the embedded brain/ copy must match the repo's
// brain/ (synced via `make sync-hfzero`). Skipped when the source tree is
// absent (e.g. module-only checkouts).
func TestBrainSyncFreshness(t *testing.T) {
	src := filepath.Join("..", "..", "..", "brain")
	if _, err := os.Stat(src); err != nil {
		t.Skip("brain/ source tree not present — skipping drift check")
	}
	embedded := map[string]bool{}
	files, err := Files()
	if err != nil {
		t.Fatal(err)
	}
	for _, f := range files {
		if strings.HasPrefix(f.Path, "brain/") {
			embedded[f.Path] = true
		}
	}
	drift := 0
	err = filepath.Walk(src, func(p string, info os.FileInfo, err error) error {
		if err != nil || info.IsDir() {
			return nil
		}
		rel, _ := filepath.Rel(src, p)
		rel = filepath.ToSlash(rel)
		if strings.HasPrefix(rel, "tests/") || strings.Contains(rel, "__pycache__") ||
			strings.Contains(rel, ".venv") || strings.Contains(rel, ".chat-ws") ||
			strings.HasSuffix(rel, ".pyc") || strings.Contains(rel, ".pytest_cache") {
			return nil
		}
		key := "brain/" + rel
		if !embedded[key] {
			t.Errorf("brain file not embedded: %s (run: make sync-hfzero)", rel)
			drift++
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}
