package server

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/ScoobyBaby1999/doomalay/engine/internal/buildinfo"
	"github.com/ScoobyBaby1999/doomalay/engine/internal/store"
)

// TestHFSpaceDockerCreateStaticToDocker — v0.48 task 9, the Vite-blank
// trick, end to end against the mock HF:
//
//   1. the space is CREATED as sdk:static (free on every account — direct
//      docker creation is PRO-gated since Jul-2026);
//   2. the brick-by-brick commit lands on the SPACE path with README
//      (sdk: docker — the flip), the full Dockerfile, the app and the
//      brain tree;
//   3. the DOOMALAY_SPACE_TOKEN secret is set on the space + copied to the
//      vault;
//   4. the response reports the honest runtime state — paused_quota on the
//      free tier (HF gates cpu-basic runtime behind PRO), running when the
//      account has a slot.
func TestHFSpaceDockerCreateStaticToDocker(t *testing.T) {
	m := newMockHubHF(t)
	m.spaceRuntime = map[string]any{
		"stage":        "PAUSED",
		"errorMessage": "Quota exceeded for flavor cpu-basic (requested=1): current=1, limit=0",
		"hardware":     map[string]any{"current": nil, "requested": "cpu-basic"},
	}
	s := newHubTestServer(t, m)

	// connect HF first (the handler 401s without a token)
	if rec := hubReq(t, s, "POST", "/api/hub/auth/connect", map[string]string{"token": "goodtoken"}); rec.Code != 200 {
		t.Fatalf("connect = %d body %s", rec.Code, rec.Body.String())
	}

	rec := hubReq(t, s, "POST", "/api/hf/space/docker-create", map[string]any{"name": "mydocker", "fork": false})
	if rec.Code != 200 {
		t.Fatalf("docker-create = %d body %s", rec.Code, rec.Body.String())
	}
	var out map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("parse: %v", err)
	}

	// 1. created as STATIC — the Vite-blank trick
	m.mu.Lock()
	sdk := m.spaceSDK["mockuser/mydocker"]
	files := m.repos["mockuser/mydocker"]
	secrets := m.spaceSecrets["mockuser/mydocker"]
	m.mu.Unlock()
	if sdk != "static" {
		t.Fatalf("created sdk = %q, want %q (direct docker creation is PRO-gated; the commit must flip it)", sdk, "static")
	}

	// 2. the commit carries the docker flip + toolchain + brain
	if files == nil {
		t.Fatal("no files committed to the space")
	}
	readme := string(files["README.md"])
	if !strings.Contains(readme, "sdk: docker") {
		t.Fatalf("README front matter must flip the sdk to docker, got: %q", firstLine(readme, 200))
	}
	if _, ok := files["Dockerfile"]; !ok {
		t.Fatal("commit must include the full-toolchain Dockerfile")
	}
	if _, ok := files["app.py"]; !ok {
		t.Fatal("commit must include the token-gated app")
	}
	if _, ok := files["brain/requirements.txt"]; !ok {
		t.Fatal("commit must include the brain tree")
	}

	// 3. space secret set + vault copy
	if secrets == nil || secrets["DOOMALAY_SPACE_TOKEN"] == "" {
		t.Fatalf("DOOMALAY_SPACE_TOKEN secret not set on the space: %v", secrets)
	}
	if _, _, err := s.vault.Get("HF_SPACE_MOCKUSER_MYDOCKER"); err != nil {
		t.Fatalf("vault copy of the space token missing: %v", err)
	}

	// 4. honest state on the free tier
	if out["state"] != "paused_quota" {
		t.Fatalf("state = %v, want paused_quota (the mock reports the quota wall)", out["state"])
	}
	if out["quota_paused"] != true {
		t.Fatalf("quota_paused = %v, want true", out["quota_paused"])
	}
	note, _ := out["note"].(string)
	if !strings.Contains(note, "PRO") {
		t.Fatalf("note must explain the PRO gate honestly, got: %q", note)
	}
	if out["repo"] != "mockuser/mydocker" {
		t.Fatalf("repo = %v", out["repo"])
	}
}

// TestHFSpaceDockerCreateRunning — same flow on an account that HAS a
// cpu-basic slot: the response state is running.
func TestHFSpaceDockerCreateRunning(t *testing.T) {
	m := newMockHubHF(t)
	m.spaceRuntime = map[string]any{
		"stage":    "RUNNING",
		"hardware": map[string]any{"current": "cpu-basic", "requested": "cpu-basic"},
	}
	s := newHubTestServer(t, m)
	if rec := hubReq(t, s, "POST", "/api/hub/auth/connect", map[string]string{"token": "goodtoken"}); rec.Code != 200 {
		t.Fatalf("connect = %d", rec.Code)
	}
	rec := hubReq(t, s, "POST", "/api/hf/space/docker-create", map[string]any{"name": "withslot", "fork": false})
	if rec.Code != 200 {
		t.Fatalf("docker-create = %d body %s", rec.Code, rec.Body.String())
	}
	var out map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	if out["state"] != "running" {
		t.Fatalf("state = %v, want running", out["state"])
	}
}

// TestHFSpacePause — the swap-slot endpoint: pause hits the space API and
// reports ok; without an HF token it 401s.
func TestHFSpacePause(t *testing.T) {
	m := newMockHubHF(t)
	s := newHubTestServer(t, m)

	// not connected → 401
	if rec := hubReq(t, s, "POST", "/api/hf/space/pause?repo=mockuser/x", nil); rec.Code != 401 {
		t.Fatalf("pause without token = %d, want 401", rec.Code)
	}

	if rec := hubReq(t, s, "POST", "/api/hub/auth/connect", map[string]string{"token": "goodtoken"}); rec.Code != 200 {
		t.Fatalf("connect = %d", rec.Code)
	}
	if rec := hubReq(t, s, "POST", "/api/hf/space/pause?repo=mockuser/mydocker", nil); rec.Code != 200 {
		t.Fatalf("pause = %d body %s", rec.Code, rec.Body.String())
	}
	m.mu.Lock()
	calls := m.spaceCalls["mockuser/mydocker#pause"]
	m.mu.Unlock()
	if calls != 1 {
		t.Fatalf("pause API calls = %d, want 1", calls)
	}
	if rec := hubReq(t, s, "POST", "/api/hf/space/pause", nil); rec.Code != 400 {
		t.Fatalf("pause without repo = %d, want 400", rec.Code)
	}
}

// TestGHAccount — the GitHub connect panel's status endpoint: not connected
// → connected:false + the built-in client id + has_secret flag.
func TestGHAccount(t *testing.T) {
	m := newMockHubHF(t)
	s := newHubTestServer(t, m)
	rec := hubReq(t, s, "GET", "/api/gh/account", nil)
	if rec.Code != 200 {
		t.Fatalf("gh account = %d", rec.Code)
	}
	var out map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	if out["connected"] != false {
		t.Fatalf("connected = %v, want false", out["connected"])
	}
	if id, _ := out["client_id"].(string); id == "" && out["oauth"] == true {
		t.Fatal("oauth advertised but no client id")
	}
}

// TestDevUsePublicKeys — dev-gated: the local default build is a dev build
// (Version carries -dev), so the endpoint installs the shared keys; with
// Dev forced off it must 404.
func TestDevUsePublicKeys(t *testing.T) {
	m := newMockHubHF(t)
	s := newHubTestServer(t, m)

	savedDev := buildinfo.Dev
	buildinfo.Dev = true
	rec := hubReq(t, s, "POST", "/api/dev/use-public-keys", nil)
	if rec.Code != 200 {
		t.Fatalf("use-public-keys (dev) = %d body %s", rec.Code, rec.Body.String())
	}
	var out map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	installed, _ := out["installed"].([]any)
	if len(installed) != 3 {
		t.Fatalf("installed = %v, want the 3 provider keys", installed)
	}
	if _, _, err := s.vault.Get("NVIDIA_API_KEY"); err != nil {
		t.Fatalf("NVIDIA key not in vault: %v", err)
	}

	buildinfo.Dev = false
	rec = hubReq(t, s, "POST", "/api/dev/use-public-keys", nil)
	if rec.Code != 404 {
		t.Fatalf("use-public-keys (release) = %d, want 404", rec.Code)
	}
	buildinfo.Dev = savedDev
}

func firstLine(s string, n int) string {
	s = strings.ReplaceAll(s, "\n", "\\n")
	if len(s) > n {
		return s[:n]
	}
	return s
}

// TestModePersonas — v0.48 task 6: the default persona is mode-aware. A
// quick-chat session gets the classic app persona; an HF session gets an
// assistant that KNOWS it lives in a Hugging Face Space with the full
// toolchain, and names its own Space repo when it has one.
func TestModePersonas(t *testing.T) {
	m := newMockHubHF(t)
	s := newHubTestServer(t, m)

	quick := &store.Session{ID: "t1", Model: "openai/gpt-4o", Provider: "openai"}
	prompt := s.systemPromptFor(quick)
	if !strings.Contains(prompt, "on the user's own device") {
		t.Fatal("quick persona must keep the on-device identity line")
	}
	if strings.Contains(prompt, "Hugging Face Space") {
		t.Fatal("quick persona must not claim to be on HF")
	}

	hf := &store.Session{ID: "t2", Model: "openai/gpt-4o", Provider: "openai", Sandbox: "hf"}
	prompt = s.systemPromptFor(hf)
	if !strings.Contains(prompt, "Hugging Face Space") {
		t.Fatal("HF persona must know it lives on a Hugging Face Space")
	}
	if !strings.Contains(prompt, "full build toolchain") {
		t.Fatal("HF persona must advertise the toolchain")
	}
	if strings.Contains(prompt, "your Space: ") {
		t.Fatal("shared/unknown repo must not name a Space")
	}

	own := &store.Session{ID: "t3", Model: "openai/gpt-4o", Provider: "openai",
		Sandbox: "hf", SandboxMode: "own", SandboxRepo: "someone/my-sandbox"}
	prompt = s.systemPromptFor(own)
	if !strings.Contains(prompt, "your Space: someone/my-sandbox") {
		t.Fatal("own-space persona must name the Space repo")
	}
}
