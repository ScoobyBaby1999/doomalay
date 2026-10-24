package server

// termuxgit.go — v1.74.10 THE GIT HAND (PLAN-V175).
//
// The user's conviction (the boonboon transcript's first half): the model
// fought a git push for DOZENS of calls — it never knew git_setup existed
// until the user said "just use git setup. It's already available u have
// all the tolls"; then the push died on auth, non-fast-forward, and a
// rebase-conflict maze resolved by hand with sed/python heredocs.
// "This is embarrassing. … the bot needs better git access and knowledge."
//
// THE ANSWER, three layers:
//
//   - THE FIRST-CLASS VERBS: git_status / git_pull / git_push / git_commit
//     — the KNOWN dance as ONE call each. git_push is the whole ritual:
//     fetch → rebase when behind (honest conflict report, never
//     auto-resolved) → push (branch + --follow-tags; tags:true escalates
//     to --tags). git_pull is fetch + rebase with the same honesty.
//     git_status is branch + ahead/behind + status + recent log in one
//     observation. git_commit is add + commit with the summary back.
//
//   - THE SELF-HEALING AUTH: a push that fails with git's auth signatures
//     AND a vault GitHub token arms the credentials INLINE (the git_setup
//     core, factored below) and retries the push ONCE — the model never
//     sees "Authentication failed" as a dead end again. The token rides
//     bridge stdin (the v1.20.2 lane): never in a command, never in the
//     chat, never in an observation.
//
//   - THE FAILURE-POINT TEACH (the transcript's root conviction): when a
//     raw exec's output carries a git auth-failure signature and the
//     vault holds a token, the observation GROWS the exact remedy — the
//     answer meets the model WHERE IT FAILS, never in a manual it won't
//     read.
//
// Every verb is jailed like every verb (the workdir resolves inside the
// bound roots or is refused), rides the bridge /run (the one-shot law —
// git output is small), and composes an honest observation on every
// path (bridge dead, timeout, not-a-repo, conflicts, auth, success).

import (
	"context"
	"fmt"
	"regexp"
	"strings"
	"time"
)

// ── the arg shape + the resolution ────────────────────────────────────────

// termuxGitResolve resolves a git verb's repo workdir: the optional "path"
// arg (relative → the first bound root, absolute must jail), defaulting to
// the first bound root. obs != "" = the honest refusal.
func (s *Server) termuxGitResolve(get func(string) string, roots []string) (string, string) {
	rel := strings.TrimSpace(get("path"))
	workdir := termuxResolvePath(roots, rel)
	if !termuxJailOK(workdir, roots) {
		return workdir, termuxJailRefused(workdir, workdir, roots)
	}
	return workdir, ""
}

// termuxGitBudgets: local ops get a minute, network ops the exec default
// (a mobile-network fetch/push can be slow; 600s is the exec law's own
// default — the model can always re-run with a longer exec for the
// pathological cases).
const (
	termuxGitLocalBudgetMS   = 120000
	termuxGitNetworkBudgetMS = 600000
)

// The git-not-a-repo guard rides every script's head (exit 1 with the
// honest line).
const termuxGitRepoGuard = `git rev-parse --is-inside-work-tree >/dev/null 2>&1 || { echo "not a git repository (or any of the parent directories) — git verbs need a repo"; exit 1; }
`

// ── git_status ────────────────────────────────────────────────────────────

// The status script: branch, upstream ahead/behind, the short status, the
// last 5 commits — ONE observation. Output is the report (the engine adds
// the head + workdir line).
const termuxGitStatusScript = `set -u
` + termuxGitRepoGuard + `br="$(git branch --show-current 2>/dev/null)"
[ -n "$br" ] || br="(detached $(git rev-parse --short HEAD 2>/dev/null))"
echo "branch: $br"
if up="$(git rev-parse --abbrev-ref --symbolic-full-name @{u} 2>/dev/null)" && [ -n "$up" ]; then
  ahead="$(git rev-list --count @{u}..HEAD 2>/dev/null || echo '?')"
  behind="$(git rev-list --count HEAD..@{u} 2>/dev/null || echo '?')"
  echo "upstream: $up (ahead $ahead · behind $behind)"
else
  echo "upstream: (none set — git_push pushes HEAD to origin by name)"
fi
echo "--- status ---"
git status --short 2>&1
echo "--- recent commits ---"
git log --oneline -5 2>&1
`

// ── git_pull (fetch + rebase) ─────────────────────────────────────────────

// The pull script: fetch (exit 2 = the honest fetch failure with git's own
// output), then rebase when behind (exit 3 = conflicts + the conflicted
// file list; never auto-resolved).
const termuxGitPullScript = `set -u
` + termuxGitRepoGuard + `if ! git fetch origin 2>&1; then echo "(git fetch origin failed — network, remote, or credentials; the output above is git's own)"; exit 2; fi
behind="$(git rev-list --count HEAD..@{u} 2>/dev/null || echo '?')"
if [ "$behind" = "0" ]; then echo "already up to date (0 behind origin)"; exit 0; fi
if [ "$behind" = "?" ]; then echo "no upstream set — nothing to pull from"; exit 0; fi
if ! git rebase @{u} 2>&1; then
  echo "REBASE CONFLICTS — the files below need a human's eye:"
  git diff --name-only --diff-filter=U 2>/dev/null
  echo "(resolve them, git add the resolved files, then git_commit — or 'git rebase --abort' to undo)"
  exit 3
fi
echo "rebased onto origin ($behind behind were merged in)"
git log --oneline -3 2>&1
`

// ── git_push (the whole dance) ────────────────────────────────────────────

// The sync half: fetch + rebase-when-behind (the non-fast-forward death
// the transcript died on — the push NEVER pushes a stale branch). Exit
// codes: 1 = not a repo, 2 = fetch failed, 3 = rebase conflicts.
const termuxGitPushSyncScript = `set -u
` + termuxGitRepoGuard + `if ! git fetch origin 2>&1; then echo "(git fetch origin failed — network, remote, or credentials; the output above is git's own)"; exit 2; fi
behind="$(git rev-list --count HEAD..@{u} 2>/dev/null || echo '?')"
if [ "$behind" != "0" ] && [ "$behind" != "?" ]; then
  if ! git rebase @{u} 2>&1; then
    echo "REBASE CONFLICTS — the files below need a human's eye:"
    git diff --name-only --diff-filter=U 2>/dev/null
    echo "(resolve them, git add the resolved files, then git_commit — or 'git rebase --abort' to undo; the push did NOT run)"
    exit 3
  fi
  echo "rebased $behind commit(s) onto origin first"
fi
`

// The push half (its own engine step so the self-heal retries ONLY it):
// exit 4 = the push failed (git's output rides along).
const termuxGitPushScript = `set -u
` + termuxGitRepoGuard + `if ! git push origin HEAD %s 2>&1; then exit 4; fi
echo "pushed HEAD to origin"
`

// ── git_commit ────────────────────────────────────────────────────────────

// The commit script: $1 = the message, the remaining positionals = the
// paths (absent = add -A). Exit 2 = add failed, 3 = commit failed.
const termuxGitCommitScript = `set -u
msg="$1"; shift
` + termuxGitRepoGuard + `if [ $# -gt 0 ]; then
  git add -- "$@" 2>&1 || { echo "(git add failed — the paths above are git's own complaint)"; exit 2; }
else
  git add -A 2>&1 || { echo "(git add -A failed)"; exit 2; }
fi
if git diff --cached --quiet 2>/dev/null; then echo "nothing to commit (the index is empty after add)"; exit 0; fi
if ! git commit -m "$msg" 2>&1; then exit 3; fi
echo "--- committed ---"
git log --oneline -3 2>&1
echo "--- remaining status ---"
git status --short 2>&1 | head -10
`

// ── the auth-failure signatures + the failure-point teach ────────────────

// termuxGitAuthFailREs — git's own auth-failure output shapes (the exact
// lines the transcript died on): bad credentials, no credentials in a
// non-interactive shell, and the 403 permission wall.
var termuxGitAuthFailREs = []*regexp.Regexp{
	regexp.MustCompile(`(?i)Authentication failed for`),
	regexp.MustCompile(`(?i)could not read Username for`),
	regexp.MustCompile(`(?i)terminal prompts disabled`),
	regexp.MustCompile(`(?i)Permission to [^ ]+ denied to`),
	regexp.MustCompile(`(?i)403.*github\.com|github\.com.*403`),
	regexp.MustCompile(`(?i)Remote: Permission to`),
}

// termuxGitAuthFailed reports whether output carries an auth signature.
func termuxGitAuthFailed(out string) bool {
	for _, re := range termuxGitAuthFailREs {
		if re.MatchString(out) {
			return true
		}
	}
	return false
}

// termuxGitAuthTeach is the failure-point remedy line (the plan's law: the
// answer meets the failure, never a manual).
const termuxGitAuthTeach = "\n[githand: GIT AUTH FAILED — the vault's GitHub token arms Termux in ONE call: {\"action\":\"git_setup\",\"args\":{}} — or use git_push, which arms it automatically and retries. Never paste tokens into commands.]"

// termuxMaybeGitAuthTeach appends the remedy to an exec observation when
// the command was a git network op AND the output carries an auth
// signature AND the vault holds a token (the honest gate: no token, no
// teach — the git_setup verb's own error explains the connect flow).
func (s *Server) termuxMaybeGitAuthTeach(command, obs string) string {
	if !strings.Contains(command, "git ") || !termuxGitAuthFailed(obs) {
		return obs
	}
	if s.githubToken() == "" {
		return obs
	}
	return obs + termuxGitAuthTeach
}

// ── THE SELF-HEALING ARM (the git_setup core, factored) ──────────────────

// termuxGitArmVault arms the vault's GitHub token inside Termux: the token
// rides bridge STDIN (never a command, never the chat), the script writes
// ~/.git-credentials (umask 077, chmod 600) + credential.helper=store +
// the identity. Returns the arming script's output ("" on failure) and the
// honest error ("" on success). The git_setup verb and the self-healing
// git_push both ride this ONE core.
func (s *Server) termuxGitArmVault(ctx context.Context) (string, string) {
	tok := s.githubToken()
	if tok == "" {
		return "", "no GitHub token in the vault — the user connects once (the workspace connect flow: the +workspace pill → GitHub sign-in, or paste a PAT)"
	}
	login, err := ghLoginFor(ctx, tok)
	if err != nil || login == "" {
		login = "x-access-token" // the PAT convention — any username works
	}
	email := login + "@users.noreply.github.com"
	script := `set -u
umask 077
login="$1"; email="$2"
command -v git >/dev/null 2>&1 || pkg install -y git >/dev/null 2>&1
read -r cred
printf '%s\n' "$cred" > "$HOME/.git-credentials"
chmod 600 "$HOME/.git-credentials" 2>/dev/null || true
git config --global credential.helper store
git config --global user.name  >/dev/null 2>&1 || git config --global user.name  "$login"
git config --global user.email >/dev/null 2>&1 || git config --global user.email "$email"
echo "git $(git --version 2>&1 | cut -d' ' -f3)"
echo "credential.helper: $(git config --global credential.helper)"
echo "identity: $(git config --global user.name) <$(git config --global user.email)>"
`
	credLine := "https://" + login + ":" + tok + "@github.com"
	runCtx, cancel := context.WithTimeout(ctx, 185*time.Second)
	defer cancel()
	res, err := s.termux.RunWithStdin(runCtx, termuxCommand(script, login, email), "", 180000, credLine)
	if err != nil {
		return "", "the Termux bridge did not answer — " + err.Error()
	}
	if res.Timeout {
		return "", "the arming timed out (180s) — Termux may be busy; retry"
	}
	if res.ExitCode != 0 {
		return "", "the arming script exited " + fmt.Sprint(res.ExitCode) + ": " + firstLineOf(res.Stderr)
	}
	return strings.TrimRight(res.Stdout, "\n"), ""
}

// ── the verbs ─────────────────────────────────────────────────────────────

// termuxVerbGitStatus — {"path"?}: the one-call state of the repo.
func (s *Server) termuxVerbGitStatus(ctx context.Context, get func(string) string, roots []string) string {
	workdir, obs := s.termuxGitResolve(get, roots)
	if obs != "" {
		return obs
	}
	res, errObs := s.termuxRunOne(ctx, termuxCommand(termuxGitStatusScript), workdir, termuxGitLocalBudgetMS)
	if errObs != "" {
		return errObs
	}
	if res.Timeout {
		return s.termuxTimeoutObs(res, termuxGitLocalBudgetMS)
	}
	out := "OBSERVATION:\nGIT STATUS — workdir " + workdir + "\n" + strings.TrimRight(res.Stdout, "\n")
	if res.ExitCode != 0 {
		return termuxFailObs(res)
	}
	return Redact(out) + "\n"
}

// termuxVerbGitCommit — {"message", "paths"?, "path"?}: add + commit.
func (s *Server) termuxVerbGitCommit(ctx context.Context, get func(string) string, args map[string]any, roots []string) string {
	message := strings.TrimSpace(get("message"))
	if message == "" {
		return "OBSERVATION:\nerror: git_commit needs {\"action\":\"git_commit\",\"args\":{\"message\":\"feat: the thing\",\"paths\":[\"a.go\"]}} — the message is required; paths optional (absent = every change, git add -A)"
	}
	workdir, obs := s.termuxGitResolve(get, roots)
	if obs != "" {
		return obs
	}
	// the paths ride the script's positionals (the single-quoted law; the
	// pkg verb's packages array is the precedent — the raw args map is the
	// one honest source for an array). NOTE: "path" is the REPO (the
	// workdir); "paths" is the files to stage — two different args.
	vargs := []string{message}
	if raw, ok := args["paths"].([]any); ok {
		for _, p := range raw {
			if ps, ok := p.(string); ok && strings.TrimSpace(ps) != "" {
				vargs = append(vargs, strings.TrimSpace(ps))
			}
		}
	}
	res, errObs := s.termuxRunOne(ctx, termuxCommand(termuxGitCommitScript, vargs...), workdir, termuxGitLocalBudgetMS)
	if errObs != "" {
		return errObs
	}
	if res.Timeout {
		return s.termuxTimeoutObs(res, termuxGitLocalBudgetMS)
	}
	if res.ExitCode != 0 {
		return termuxFailObs(res)
	}
	return "OBSERVATION:\nGIT COMMIT — workdir " + workdir + "\n" + Redact(strings.TrimRight(res.Stdout, "\n")) + "\n"
}

// termuxVerbGitPull — {"path"?}: fetch + rebase, honest conflicts.
func (s *Server) termuxVerbGitPull(ctx context.Context, get func(string) string, roots []string) string {
	workdir, obs := s.termuxGitResolve(get, roots)
	if obs != "" {
		return obs
	}
	res, errObs := s.termuxRunOne(ctx, termuxCommand(termuxGitPullScript), workdir, termuxGitNetworkBudgetMS)
	if errObs != "" {
		return errObs
	}
	if res.Timeout {
		return s.termuxTimeoutObs(res, termuxGitNetworkBudgetMS)
	}
	head := "GIT PULL (fetch + rebase) — workdir " + workdir
	switch res.ExitCode {
	case 0:
		return "OBSERVATION:\n" + head + "\n" + Redact(strings.TrimRight(res.Stdout, "\n")) + "\n"
	case 2:
		// fetch failed — the auth teach rides when the signature + vault say so
		out := "OBSERVATION:\n" + head + "\n" + strings.TrimRight(res.Stdout, "\n")
		if s.githubToken() != "" && termuxGitAuthFailed(res.Stdout+res.Stderr) {
			out += termuxGitAuthTeach
		}
		return Redact(out) + "\n"
	default:
		return termuxFailObs(res)
	}
}

// termuxVerbGitPush — {"path"?, "tags"?}: THE WHOLE DANCE — fetch → rebase
// when behind (conflicts honest, push never runs on them) → push → and
// THE SELF-HEALING AUTH: an auth-failed push with a vault token arms the
// credentials inline and retries ONCE.
func (s *Server) termuxVerbGitPush(ctx context.Context, get func(string) string, roots []string) string {
	workdir, obs := s.termuxGitResolve(get, roots)
	if obs != "" {
		return obs
	}
	tagsFlag := "--follow-tags"
	if strings.EqualFold(strings.TrimSpace(get("tags")), "true") {
		tagsFlag = "--tags"
	}
	head := "GIT PUSH (fetch → rebase when behind → push" + map[bool]string{true: " + all tags", false: " + release tags"}[tagsFlag == "--tags"] + ") — workdir " + workdir

	// STEP 1 — the sync half (fetch + rebase-when-behind).
	syncRes, errObs := s.termuxRunOne(ctx, termuxCommand(termuxGitPushSyncScript), workdir, termuxGitNetworkBudgetMS)
	if errObs != "" {
		return errObs
	}
	if syncRes.Timeout {
		return s.termuxTimeoutObs(syncRes, termuxGitNetworkBudgetMS)
	}
	if syncRes.ExitCode != 0 {
		// 1 = not a repo, 2 = fetch failed, 3 = rebase conflicts — the
		// script's own output is the honest report (the auth teach rides
		// the fetch-failure shape when the signatures + vault say so).
		out := "OBSERVATION:\n" + head + "\n" + strings.TrimRight(syncRes.Stdout, "\n")
		if syncRes.ExitCode == 2 && s.githubToken() != "" && termuxGitAuthFailed(syncRes.Stdout+syncRes.Stderr) {
			out += termuxGitAuthTeach
		}
		return Redact(out) + "\n"
	}
	syncOut := strings.TrimRight(syncRes.Stdout, "\n")

	// STEP 2 — the push itself (its own step: the self-heal retries only it).
	pushScript := fmt.Sprintf(termuxGitPushScript, tagsFlag)
	pushRes, errObs := s.termuxRunOne(ctx, termuxCommand(pushScript), workdir, termuxGitNetworkBudgetMS)
	if errObs != "" {
		return errObs
	}
	if pushRes.Timeout {
		return s.termuxTimeoutObs(pushRes, termuxGitNetworkBudgetMS)
	}
	if pushRes.ExitCode == 0 {
		out := "OBSERVATION:\n" + head + "\n"
		if syncOut != "" {
			out += syncOut + "\n"
		}
		out += strings.TrimRight(pushRes.Stdout, "\n")
		return Redact(out) + "\n"
	}

	// STEP 3 — the push failed: THE SELF-HEALING AUTH. git's auth
	// signature + a vault token + the first try → arm INLINE, retry ONCE.
	pushOut := strings.TrimRight(pushRes.Stdout, "\n")
	if termuxGitAuthFailed(pushRes.Stdout+pushRes.Stderr) && s.githubToken() != "" {
		if _, armErr := s.termuxGitArmVault(ctx); armErr == "" {
			retry, errObs := s.termuxRunOne(ctx, termuxCommand(pushScript), workdir, termuxGitNetworkBudgetMS)
			if errObs != "" {
				return errObs
			}
			if !retry.Timeout && retry.ExitCode == 0 {
				out := "OBSERVATION:\n" + head + "\n"
				if syncOut != "" {
					out += syncOut + "\n"
				}
				out += "[githand: the first push failed on AUTH — the vault's GitHub token was armed in Termux automatically (~/.git-credentials, 0600) and the push RETRIED once]\n"
				out += strings.TrimRight(retry.Stdout, "\n")
				return Redact(out) + "\n"
			}
			// the retry failed too — the honest double failure (the token
			// may lack scope: the vault's connect flow re-connects)
			out := "OBSERVATION:\n" + head + "\n"
			if syncOut != "" {
				out += syncOut + "\n"
			}
			out += "[githand: auth failed BOTH times — the vault's token was armed and the retry still failed; the token may lack push rights for this repo (the +workspace connect flow re-connects a stronger one)]\n"
			out += strings.TrimRight(retry.Stdout, "\n") + "\nstderr:\n" + strings.TrimRight(retry.Stderr, "\n")
			return Redact(out) + "\n"
		} else {
			// the arming itself failed — honest, with the original failure
			out := "OBSERVATION:\n" + head + "\n"
			if syncOut != "" {
				out += syncOut + "\n"
			}
			out += pushOut + "\n[githand: the self-healing arm failed — " + armErr + "]\n"
			return Redact(out) + "\n"
		}
	}

	// non-auth failure — the honest report (the auth teach rides when the
	// vault is empty and the signature says credentials)
	out := "OBSERVATION:\n" + head + "\n"
	if syncOut != "" {
		out += syncOut + "\n"
	}
	out += pushOut
	if pushRes.Stderr != "" {
		out += "\nstderr:\n" + strings.TrimRight(pushRes.Stderr, "\n")
	}
	if termuxGitAuthFailed(pushRes.Stdout + pushRes.Stderr) {
		out += "\n[githand: this looks like a credentials failure — the vault holds no GitHub token, so the self-heal stayed quiet; the user connects once (the +workspace pill → GitHub) and then git_setup/git_push arm it]"
	}
	return Redact(out) + "\n"
}
