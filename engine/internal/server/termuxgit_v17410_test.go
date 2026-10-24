package server

// termuxgit_v17410_test.go — v1.74.10 THE GIT HAND pins (PLAN-V175): the
// boonboon transcript's push-struggle convictions, all pinned end-to-end
// against the executing fake bridge (the same scripts Termux runs, a REAL
// git repo + a REAL local bare origin):
//
//   - the auth signature detector (git's own failure shapes convict; the
//     benign shapes never do)
//   - THE FAILURE-POINT TEACH: a git exec that dies on AUTH with a vault
//     token learns the exact remedy at the failure point; without a
//     token the teach stays quiet (git_setup's own error owns that story)
//   - git_status's one-call shape against a REAL repo
//   - git_commit's add + commit round-trip (the commit LANDS)
//   - git_push's WHOLE DANCE against a real origin: the happy path AND
//     THE SELF-HEALING AUTH — an origin that refuses the first push on
//     auth, the credentials arm inline, the retry lands (the
//     transcript's "Authentication failed" dead end, dead)
//   - the jail law (a repo outside the bound roots is refused)

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// v17410Env — a real repo bound as the chat's termux root, with a real
// local bare origin wired as "origin".
type v17410Env struct {
	s      *Server
	fb     *fakeArmBridge
	repo   string // the bound root — a REAL git repo
	origin string // the REAL bare origin (git push lands here)
}

func newV17410Env(t *testing.T) *v17410Env {
	t.Helper()
	fb := newFakeArmBridge(t)
	s := newArmServer(t, fb)

	repo := filepath.Join(fb.home, "myrepo")
	origin := filepath.Join(fb.home, "origin.git")
	if err := os.MkdirAll(repo, 0o755); err != nil {
		t.Fatalf("repo dir: %v", err)
	}
	if err := os.MkdirAll(origin, 0o755); err != nil {
		t.Fatalf("origin dir: %v", err)
	}
	git := func(dir string, args ...string) {
		t.Helper()
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		cmd.Env = append(os.Environ(),
			"GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@t",
			"GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@t",
			"HOME="+fb.home)
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v (in %s): %v\n%s", args, dir, err, out)
		}
	}
	git(repo, "init", "-q", "-b", "main")
	if err := os.WriteFile(filepath.Join(repo, "hello.txt"), []byte("hello\n"), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	git(repo, "add", "-A")
	git(repo, "commit", "-q", "-m", "init")
	// the bare origin + the upstream wiring (the dance's fetch/push land
	// here for real — a local bare repo needs no credentials)
	git(origin, "init", "-q", "--bare", "-b", "main")
	git(repo, "remote", "add", "origin", origin)
	git(repo, "push", "-q", "origin", "main")
	git(repo, "fetch", "-q", "origin")
	git(repo, "branch", "--set-upstream-to=origin/main", "main")

	// the fake HOME's git identity (what git_setup's arming leaves
	// behind — a setup'd Termux carries user.name/user.email + the
	// credential helper)
	if err := os.WriteFile(filepath.Join(fb.home, ".gitconfig"), []byte(
		"[user]\n\tname = t\n\temail = t@t\n[credential]\n\thelper = store\n"), 0o644); err != nil {
		t.Fatalf("gitconfig: %v", err)
	}
	armTermuxChat(t, s, "v17410", repo)
	return &v17410Env{s: s, fb: fb, repo: repo, origin: origin}
}

// TestV17410_AuthSignatures — git's own auth-failure shapes all convict,
// and the benign shapes never do.
func TestV17410_AuthSignatures(t *testing.T) {
	for _, fail := range []string{
		"fatal: Authentication failed for 'https://github.com/o/r.git/'",
		"fatal: could not read Username for 'https://github.com': terminal prompts disabled",
		"remote: Permission to ScoobyBaby1999/doomalay denied to crippy.",
		"error: RPC failed; HTTP 403 curl 22 The requested URL returned error: 403 Forbidden for github.com",
	} {
		if !termuxGitAuthFailed(fail) {
			t.Fatalf("an auth signature must convict: %q", fail)
		}
	}
	for _, ok := range []string{
		"To github.com:ScoobyBaby1999/doomalay.git\n   0eeef87..f9fa4bd  main -> main",
		"fast-forward\nREADME.md | 2 +-",
		"CONFLICT (content): Merge conflict in engine/internal/llm/chat.go",
		"already up to date (0 behind origin)",
	} {
		if termuxGitAuthFailed(ok) {
			t.Fatalf("a benign shape must never convict: %q", ok)
		}
	}
}

// TestV17410_ExecAuthTeach — the failure-point teach: an exec observation
// carrying git's auth signature grows the remedy ONLY when the vault holds
// a token (no token → the teach stays quiet).
func TestV17410_ExecAuthTeach(t *testing.T) {
	env := newV17410Env(t)
	s := env.s
	obs := "OBSERVATION:\nEXEC DONE — workdir /x\nexit_code: 128\nstdout:\nfatal: Authentication failed for 'https://github.com/o/r.git/'\n"
	// no vault token → no teach
	if got := s.termuxMaybeGitAuthTeach("cd x && git push origin main", obs); strings.Contains(got, "githand") {
		t.Fatalf("no vault token → no teach: %q", got)
	}
	// arm the token → the teach rides at the failure point
	if err := s.vault.Set("GITHUB_PAT", "github", "ghp_v17410test", ""); err != nil {
		t.Fatalf("vault: %v", err)
	}
	got := s.termuxMaybeGitAuthTeach("cd x && git push origin main", obs)
	for _, want := range []string{"githand", "GIT AUTH FAILED", `{"action":"git_setup"`, "git_push"} {
		if !strings.Contains(got, want) {
			t.Fatalf("the failure-point teach must carry %q: %q", want, got)
		}
	}
	// a NON-git command never teaches even with the same output
	if got := s.termuxMaybeGitAuthTeach("curl https://github.com/x", obs); strings.Contains(got, "githand") {
		t.Fatalf("the teach is git-shaped only: %q", got)
	}
	// a git command with clean output never teaches
	if got := s.termuxMaybeGitAuthTeach("git push origin main", "OBSERVATION:\nEXEC DONE\nexit_code: 0\nstdout:\nmain -> main\n"); strings.Contains(got, "githand") {
		t.Fatalf("a clean push never teaches: %q", got)
	}
}

// TestV17410_GitStatusShape — the one-call status against a real repo.
func TestV17410_GitStatusShape(t *testing.T) {
	env := newV17410Env(t)
	if err := os.WriteFile(filepath.Join(env.repo, "dirty.txt"), []byte("dirty\n"), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	out := tool(env.s, "v17410", "git_status", `{}`)
	for _, want := range []string{"GIT STATUS", "branch: main", "upstream: origin/main", "dirty.txt", "init"} {
		if !strings.Contains(out, want) {
			t.Fatalf("git_status must carry %q, got:\n%s", want, out)
		}
	}
}

// TestV17410_GitCommitRoundTrip — add + commit through the verb; the
// commit LANDS in the real repo.
func TestV17410_GitCommitRoundTrip(t *testing.T) {
	env := newV17410Env(t)
	if err := os.WriteFile(filepath.Join(env.repo, "second.txt"), []byte("more\n"), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	out := tool(env.s, "v17410", "git_commit", `{"message":"feat: v17410 second"}`)
	if !strings.Contains(out, "GIT COMMIT") || !strings.Contains(out, "feat: v17410 second") {
		t.Fatalf("the commit observation carries the summary, got:\n%s", out)
	}
	cmd := exec.Command("git", "log", "--oneline", "-2")
	cmd.Dir = env.repo
	cmd.Env = append(os.Environ(), "HOME="+env.fb.home)
	if log, err := cmd.CombinedOutput(); err != nil || !strings.Contains(string(log), "feat: v17410 second") {
		t.Fatalf("the commit must land in the repo: %v\n%s", err, log)
	}
}

// TestV17410_GitPushHappyPath — the whole dance against the real origin:
// fetch (nothing behind) → push → the honest report; the push LANDS.
func TestV17410_GitPushHappyPath(t *testing.T) {
	env := newV17410Env(t)
	if err := os.WriteFile(filepath.Join(env.repo, "push1.txt"), []byte("push\n"), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	if out := tool(env.s, "v17410", "git_commit", `{"message":"feat: push happy"}`); !strings.Contains(out, "feat: push happy") {
		t.Fatalf("commit, got:\n%s", out)
	}
	out := tool(env.s, "v17410", "git_push", `{}`)
	if !strings.Contains(out, "GIT PUSH") || !strings.Contains(out, "pushed HEAD to origin") {
		t.Fatalf("the push observation speaks the dance, got:\n%s", out)
	}
	// the push landed in the bare origin
	cmd := exec.Command("git", "--git-dir", env.origin, "log", "--oneline", "-1")
	cmd.Env = append(os.Environ(), "HOME="+env.fb.home)
	if log, err := cmd.CombinedOutput(); err != nil || !strings.Contains(string(log), "push happy") {
		t.Fatalf("the push must land in the origin: %v\n%s", err, log)
	}
}

// TestV17410_GitPushSelfHeal — THE SELF-HEALING AUTH: the origin refuses
// the FIRST push with git's auth signature (the fake's scalpel); the
// dance arms the vault's token INLINE (the credentials file lands in the
// fake HOME, 0600) and the RETRY pushes for real — the transcript's
// "Authentication failed" dead end, dead.
func TestV17410_GitPushSelfHeal(t *testing.T) {
	env := newV17410Env(t)
	s := env.s

	// the vault token (the self-heal's fuel)
	if err := s.vault.Set("GITHUB_PAT", "github", "ghp_v17410selfheal", ""); err != nil {
		t.Fatalf("vault: %v", err)
	}
	// a commit to push
	if err := os.WriteFile(filepath.Join(env.repo, "heal.txt"), []byte("heal\n"), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	if out := tool(s, "v17410", "git_commit", `{"message":"feat: self-heal"}`); !strings.Contains(out, "self-heal") {
		t.Fatalf("commit, got:\n%s", out)
	}
	// arm the scalpel: the FIRST git push dies on auth
	env.fb.mu.Lock()
	env.fb.pushAuthFailOnce = true
	env.fb.mu.Unlock()

	out := tool(s, "v17410", "git_push", `{}`)
	for _, want := range []string{
		"GIT PUSH",
		"the first push failed on AUTH",
		"RETRIED once",
		"pushed HEAD to origin",
	} {
		if !strings.Contains(out, want) {
			t.Fatalf("the self-healing push must carry %q, got:\n%s", want, out)
		}
	}
	// the retry landed in the bare origin
	cmd := exec.Command("git", "--git-dir", env.origin, "log", "--oneline", "-1")
	cmd.Env = append(os.Environ(), "HOME="+env.fb.home)
	if log, err := cmd.CombinedOutput(); err != nil || !strings.Contains(string(log), "self-heal") {
		t.Fatalf("the retried push must land in the origin: %v\n%s", err, log)
	}
	// the credentials file landed in the fake HOME (0600, the token line)
	cred, err := os.ReadFile(filepath.Join(env.fb.home, ".git-credentials"))
	if err != nil || !strings.Contains(string(cred), "@github.com") {
		t.Fatalf("the self-heal's arming must land the credentials file: %v %q", err, string(cred))
	}
	if st, _ := os.Stat(filepath.Join(env.fb.home, ".git-credentials")); st != nil && st.Mode().Perm() != 0600 {
		t.Fatalf("the credentials file must be 0600, got %v", st.Mode().Perm())
	}
	// the token NEVER rides the observation
	if strings.Contains(out, "ghp_v17410selfheal") {
		t.Fatalf("THE TOKEN LEAKED into the observation:\n%s", out)
	}
}

// TestV17410_JailLaw — a repo outside the bound roots is refused.
func TestV17410_JailLaw(t *testing.T) {
	env := newV17410Env(t)
	out := tool(env.s, "v17410", "git_status", `{"path":"/etc"}`)
	if !strings.Contains(out, "jail") && !strings.Contains(out, "outside") {
		t.Fatalf("an out-of-root repo is refused honestly, got:\n%s", out)
	}
}
