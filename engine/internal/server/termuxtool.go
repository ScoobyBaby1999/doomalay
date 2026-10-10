package server

// termuxtool.go — v1.20.3 THE ARM (PLAN-V120 §v1.20.3).
//
// USER SPEC: "focus on adding capabilities and maxing out termux…
// sessions might be something that the bot should be able to create and
// kill on the fly like python processes."
//
// The bot-facing Termux hand: ONE tool ("termux") whose every verb is
// ONE bridge /run call. The JAIL SET = the termux_path of every
// workspace of Kind "termux" bound to the chat (the v1.20.2 connect-a-
// workspace device-storage rows) — nothing outside those folders is
// ever touched, and every path is validated on BOTH sides: the engine
// prefix-checks the joined path, then the Termux-side script resolves
// it (readlink -f), echoes the resolved path as stdout line 1, and
// case-prefix-checks it against the roots — exit 42 BEFORE any action.
// The engine re-checks the echoed resolved path too (symlink
// laundering dies on both sides).
//
// LAWS (the wave's, non-negotiable):
//   - WHOLE TRUTH: no local output caps anywhere; Termux's own 100KB
//     result Bundle is the only physics, and it is reported honestly
//     ("[termux: output truncated at 100KB by Termux's result cap]").
//   - ZERO shell interpolation of model/user strings: every path,
//     pattern, name, package, command and file content rides a
//     POSITIONAL ARG (single-quoted on the command line — see
//     termuxShellQuote) or base64 for file bodies. The only strings
//     ever embedded in a script are the static verb bodies.
//   - Every failure is an honest OBSERVATION string — never a panic,
//     never silence, never an error swallowed.
//   - Deterministic marker heads (EXEC DONE / READ / WROTE / SESSION
//     STARTED — …) mirror the workspace tool's marker-line law.
//
// VERBS: help, exec, ls, read, write, append, rm, mkdir, grep, find,
// pkg, session_start, session_list, session_log, session_kill.
//
// Background-process SESSIONS (the "python processes" ask) live under
// $HOME/.doomalay/sessions/<name>/{run.sh,out.log,pid} — a NEW safe
// root, chat-global by design (NOT a workspace jail root): a session's
// process outlives the tool call, nohup'd with its log tailable and
// its pid killable (SIGTERM → 3s → SIGKILL, honestly reported).

import (
        "context"
        "encoding/base64"
        "encoding/json"
        "fmt"
        "path"
        "reflect"
        "regexp"
        "sort"
        "strconv"
        "strings"
        "time"

        "github.com/ScoobyBaby1999/doomalay/engine/internal/termuxbridge"
)

// ── the verb registry + the honesty constants ────────────────────────────

// termuxVerbs is the canonical verb list (help + unknown-action teach).
const termuxVerbs = "help, exec, cmds, ls, read, write, append, rm, mkdir, grep, find, pkg, session_start, session_list, session_log, session_kill"

// termuxCapBytes is Termux's own result-Bundle physics (ResultSender's
// TRANSACTION_SIZE_LIMIT_IN_BYTES): stdout+stderr ride the
// PendingIntent result capped at 100KB total — ÷2 per stream when both
// are present. THE WHOLE-TRUTH LAW: this is the ONLY cap in the whole
// termux hand, and when it fires the observation says so.
const (
        termuxCapBytes        = 100 * 1024
        termuxTruncatedMarker = "[termux: output truncated at 100KB by Termux's result cap]"
)

// termuxWriteCap bounds one write/append's content (1MB) — an intent
// size guard, not an output cap: the base64 body rides the bridge
// command line, and intents must stay small enough to fit the request
// bundle honestly.
const termuxWriteCap = 1 << 20

// Exec pacing (the shell-wave anti-burst law): a rolling-window cap of
// 12 execs/minute per session. v1.23.1 THE PACING: the ≥4s one-shot
// cooldown is GONE (the user's ask — streaming results pace the calls
// naturally and the model's own serial tool loop waits for each result;
// the rolling cap stays the real anti-burst guard). Vars (not consts) so
// the tests shrink them.
var (
        termuxExecWindow = 60 * time.Second
)

// The exec blocklist (PLAN-V116's shell-jail law, kept surgical per the
// wave plan): the file-destroying + device-destroying + system-power
// class NEVER runs — refused honestly before the bridge is touched.
var termuxBlocklist = []struct {
        re  *regexp.Regexp
        why string
}{
        // rm -rf against / or ~ (or $HOME) — a recursive delete of the
        // filesystem root or the whole home directory is unrecoverable by
        // design (sudo-prefixed, split flags, --no-preserve-root and
        // trailing /* all covered; a DEEPER path under them does not match).
        {regexp.MustCompile(`(?i)\brm\s+((--?)[a-z]*[rf][a-z]*\s+|-[rf]+\s+)*(/+|~|\$\{?HOME\}?)(/\*?)?(\s|[';|&)]|$)`),
                "a recursive delete of / or the home directory"},
        // dd writing into a block device — raw device destruction.
        {regexp.MustCompile(`(?i)\bdd\s+[^;|&]*\bof=/*dev/(sd|mmc|blk|loop|nvme|hd|raw|ram)`),
                "dd writing into a raw block device"},
        // mkfs/mke2fs targeting a device — filesystem creation destroys the
        // device's contents.
        {regexp.MustCompile(`(?i)\b(mkfs(\.\w+)?|mke2fs)\b[^;|&]{0,80}/dev/`),
                "making a filesystem on a device"},
        // reboot/poweroff/halt/shutdown — the system-power class (anchored
        // to command position so an echo ABOUT a reboot never matches).
        {regexp.MustCompile(`(?i)(^|[;&|\n])\s*(sudo\s+|busybox\s+)*(reboot|poweroff|halt|shutdown)\b`),
                "a system power command (reboot/shutdown/poweroff/halt)"},
        // The classic fork bomb (spaced and unspaced variants).
        {regexp.MustCompile(`:\s*\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:`),
                "a fork bomb"},
        // Redirection INTO a raw device node (> /dev/sdX… — /dev/null and
        // friends stay legal: only the device class is refused).
        {regexp.MustCompile(`(?i)>\s*/dev/(sd|mmc|blk|loop|nvme|hd|raw|ram|mem|port)`),
                "redirecting output into a raw device node"},
        // chmod -R 777 on / or ~ — wrecking the whole tree's permissions.
        {regexp.MustCompile(`(?i)\bchmod\s+((--?)[a-z]*r[a-z]*\s+|-[r]+\s+)*777\s+(/+|~|\$\{?HOME\}?)(/\*?)?(\s|[';|&)]|$)`),
                "chmod -R 777 against / or the home directory"},
}

// termuxBlocklistHit reports the first matching blocklist class for a
// command ("" when clean). The check runs BEFORE the bridge is ever
// touched — a refused command never executes, and the observation says
// exactly which class fired.
func termuxBlocklistHit(command string) string {
        for _, b := range termuxBlocklist {
                if b.re.MatchString(command) {
                        return b.why
                }
        }
        return ""
}

// termuxSessionNameRE and termuxPkgNameRE are the two string inputs the
// scripts embed structurally (a session dir name, a package list): both
// are validated engine-side FIRST — safe-charset-only, length-capped.
var (
        termuxSessionNameRE = regexp.MustCompile(`^[a-zA-Z0-9._-]{1,40}$`)
        termuxPkgNameRE     = regexp.MustCompile(`^[a-zA-Z0-9._+-]+$`)
)

// ── the runner ───────────────────────────────────────────────────────────

// runTermuxAction executes one "termux" tool call for the chat paths
// (the MCP handler + the direct ACTION twin both land here). Returns
// OBSERVATION-ready text. EVERY branch is an honest string — never a
// panic, never silence.
func (s *Server) runTermuxAction(ctx context.Context, sessionID, argJSON string) string {
        var args map[string]any
        if err := json.Unmarshal([]byte(argJSON), &args); err != nil {
                return "OBSERVATION:\nerror: arguments must be a JSON object — " + err.Error()
        }
        if args == nil {
                args = map[string]any{}
        }
        // The Def's "args" prop is a JSON-object STRING (the one-tool/verb-
        // map shape the workspace tool proved); a live JSON object is
        // tolerated too (providers sometimes promote it), and flat top-level
        // keys (the workspace shape) keep working — all three land in one
        // merged lookup.
        switch nested := args["args"].(type) {
        case string:
                if strings.TrimSpace(nested) != "" {
                        var m map[string]any
                        if err := json.Unmarshal([]byte(nested), &m); err != nil {
                                return "OBSERVATION:\nerror: args must be a JSON object of the action's arguments (e.g. {\"path\":\"notes.txt\"}) — " + err.Error()
                        }
                        for k, v := range m {
                                if _, exists := args[k]; !exists {
                                        args[k] = v
                                }
                        }
                }
        case map[string]any:
                for k, v := range nested {
                        if _, exists := args[k]; !exists {
                                args[k] = v
                        }
                }
        }
        get := func(k string) string {
                v, _ := args[k].(string)
                return strings.TrimSpace(v)
        }
        action := get("action")

        // ── THE ARMING CHECK (the gate lives in the runner too, not just
        // the manifest — the workspace tool's law). Not armed → the honest
        // teach, NEVER a refusal-shaped silence. ──
        if s.db == nil || sessionID == "" {
                return termuxTeachNotStacked()
        }
        sess, err := s.db.GetSession(sessionID)
        if err != nil || sess == nil || !sess.Termux {
                return termuxTeachNotStacked()
        }
        roots := s.sessionTermuxRoots(sessionID)
        if len(roots) == 0 {
                return termuxTeachNoFolder()
        }

        switch action {
        case "", "help":
                return "OBSERVATION:\n" + termuxHelpText(roots)
        case "exec":
                return s.termuxVerbExec(ctx, sessionID, get, args, roots)
        case "cmds":
                return s.termuxVerbCmds(ctx)
        case "ls":
                return s.termuxVerbLs(ctx, get, roots)
        case "read":
                return s.termuxVerbRead(ctx, get, roots)
        case "write", "append":
                return s.termuxVerbWrite(ctx, action, get, roots)
        case "rm":
                return s.termuxVerbRm(ctx, get, roots)
        case "mkdir":
                return s.termuxVerbMkdir(ctx, get, roots)
        case "grep":
                return s.termuxVerbGrep(ctx, get, roots)
        case "find":
                return s.termuxVerbFind(ctx, get, roots)
        case "pkg":
                return s.termuxVerbPkg(ctx, get, args)
        case "session_start":
                return s.termuxVerbSessionStart(ctx, get)
        case "session_list":
                return s.termuxVerbSessionList(ctx)
        case "session_log":
                return s.termuxVerbSessionLog(ctx, get, args)
        case "session_kill":
                return s.termuxVerbSessionKill(ctx, get)
        default:
                return "OBSERVATION:\nerror: unknown termux action \"" + action + "\".\n" + termuxHelpText(roots)
        }
}

// termuxTeachNotStacked — the ⌨ capability is not stacked on this chat.
func termuxTeachNotStacked() string {
        return "OBSERVATION:\nerror: the termux tool is not armed for this chat — the ⌨ Termux capability is not stacked. The user stacks it from the chat's capabilities library (the 🧩 row in the chat header); tell them how, never apologize for the lack."
}

// termuxTeachNoFolder — armed but nothing to work in.
func termuxTeachNoFolder() string {
        return "OBSERVATION:\nerror: the termux tool is armed but no device folder is connected to this chat yet — there is no jailed folder to work in. The user connects one from the chat header's +workspace pill → device storage (the Termux browser page on the APK). Until then, ask the user for the file's content instead of guessing."
}

// sessionTermuxRoots lists the termux_path of every bound workspace of
// Kind "termux" (the v1.20.2 device-storage rows) — THE JAIL SET,
// sorted for stable prompts. Cloud and PWA-only device rows never
// qualify (no termux_path, nothing to jail to).
func (s *Server) sessionTermuxRoots(sessionID string) []string {
        if s.db == nil || sessionID == "" {
                return nil
        }
        bound, err := s.db.ListSessionWorkspaces(sessionID)
        if err != nil {
                return nil
        }
        var roots []string
        for _, ws := range bound {
                if ws == nil || ws.Kind != "termux" {
                        continue
                }
                p, _ := ws.MetaJSON()["termux_path"].(string)
                p = strings.TrimSpace(p)
                if p == "" {
                        continue
                }
                roots = append(roots, p)
        }
        sort.Strings(roots)
        return roots
}

// ── the path jail (engine side — the script re-checks Termux-side) ───────

// termuxResolvePath maps a tool "path" argument onto an absolute path:
// absolute paths are taken as-is (validated next); relative paths join
// the FIRST bound root (exec's workdir law — the model addresses other
// roots absolutely; help + the session block teach the real paths).
func termuxResolvePath(roots []string, rel string) string {
        rel = strings.TrimSpace(rel)
        if rel == "" {
                return roots[0]
        }
        if strings.HasPrefix(rel, "/") {
                return path.Clean(rel)
        }
        return path.Join(roots[0], rel)
}

// termuxJailOK is the engine-side jail check: no ".." component may
// survive, and the path must BE a jail root or sit UNDER one (string
// prefix with a / boundary — the script's readlink -f pass catches
// what strings cannot: symlink laundering).
func termuxJailOK(p string, roots []string) bool {
        for _, comp := range strings.Split(p, "/") {
                if comp == ".." {
                        return false
                }
        }
        for _, root := range roots {
                root = strings.TrimSuffix(root, "/")
                if p == root || strings.HasPrefix(p, root+"/") {
                        return true
                }
        }
        return false
}

// termuxJailRefused — the honest refusal (the action NEVER ran; the
// script exits 42 before touching anything, or the engine caught it
// pre-flight).
func termuxJailRefused(asked, resolved string, roots []string) string {
        return "OBSERVATION:\nJAIL REFUSED — " + asked + " resolves to " + resolved +
                ", outside this chat's bound device folders. The jail set: " + strings.Join(roots, ", ") +
                ". Nothing was executed — rephrase with a path inside a bound folder."
}

// termuxShellQuote single-quotes one command-line piece (the only safe
// POSIX quoting) — every dynamic value rides the command line through
// THIS, never string-concatenated into the script.
func termuxShellQuote(s string) string {
        return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}

// termuxCommand builds the bridge command: bash -c '<script>' bash
// '<arg1>' '<arg2>' … — the script body is STATIC, every dynamic value
// a single-quoted positional arg. "$1".."$n" inside the script are the
// only way user data is ever read.
func termuxCommand(script string, vargs ...string) string {
        parts := make([]string, 0, len(vargs)+3)
        parts = append(parts, "bash", "-c", termuxShellQuote(script), "bash")
        for _, a := range vargs {
                parts = append(parts, termuxShellQuote(a))
        }
        return strings.Join(parts, " ")
}

// termuxJailScript builds one path verb's script: the extra names are
// the verb's OWN positional args (saved BEFORE the shift so the body
// can still read them — "$pattern", "$b64", …), then the shared
// resolve-then-check-then-act prologue: readlink -f → echo the resolved
// path (stdout line 1 — the engine re-checks it) → the root
// case-prefix check → exit 42 BEFORE any action. The ONLY strings ever
// embedded are these static arg names.
func termuxJailScript(extra []string, body string) string {
        var b strings.Builder
        b.WriteString("set -u\np=\"$1\"\n")
        for i, name := range extra {
                fmt.Fprintf(&b, "%s=\"$%d\"\n", name, i+2)
        }
        b.WriteString(`r="$(readlink -f -- "$p" 2>/dev/null)" || r=""
if [ -z "$r" ]; then echo "cannot resolve path: $p" >&2; exit 1; fi
echo "$r"
ok=""
shift $((1+`)
        b.WriteString(strconv.Itoa(len(extra)))
        b.WriteString(`))
for root in "$@"; do
  case "$r" in "$root"|"$root"/*) ok=1; break ;; esac
done
if [ -z "$ok" ]; then echo "jail violation: $r is outside the bound device folders" >&2; exit 42; fi
`)
        b.WriteString(body)
        return b.String()
}

// termuxOutcome is one jailed script run's parsed outcome: resolved =
// stdout line 1 (the Termux-resolved path every jailed script echoes),
// body = the remaining stdout, res = the raw bridge result.
type termuxOutcome struct {
        resolved string
        body     string
        res      *termuxbridge.RunResult
}

// termuxRunScript executes ONE jailed script through the bridge and
// applies THE SHARED LAW for every path verb:
//   - bridge nil/dead/timeout → the honest observation, nothing ran;
//   - exit 42, or the echoed resolved path failing the engine-side jail
//     re-check → the honest JAIL REFUSED (never executed);
//   - any other non-zero exit → the honest failure (full stderr);
//   - rc 0 → the parsed outcome for the verb to format.
//
// obs != "" means the honest observation is already built (the verb
// returns it verbatim).
func (s *Server) termuxRunScript(ctx context.Context, script string, vargs []string, roots []string, workdir string, timeoutMS int) (oc termuxOutcome, obs string) {
        res, errObs := s.termuxRunOne(ctx, termuxCommand(script, vargs...), workdir, timeoutMS)
        if errObs != "" {
                return oc, errObs
        }
        oc.res = res
        if res.Timeout {
                return oc, termuxTimeoutObs(res, timeoutMS)
        }
        stdout := res.Stdout
        if idx := strings.IndexByte(stdout, '\n'); idx >= 0 {
                oc.resolved, oc.body = stdout[:idx], stdout[idx+1:]
        } else {
                oc.resolved = stdout
        }
        if res.ExitCode == 42 {
                return oc, termuxJailRefused(firstLineOf(oc.resolved), oc.resolved, roots)
        }
        if oc.resolved != "" && !termuxJailOK(oc.resolved, roots) {
                return oc, termuxJailRefused(firstLineOf(oc.resolved), oc.resolved, roots)
        }
        if res.ExitCode != 0 {
                return oc, termuxFailObs(res)
        }
        return oc, ""
}

// termuxRunOne is the single bridge choke point every verb shares: nil
// bridge → the honest no-bridge observation; a transport error → the
// honest typed-error observation. The engine bounds the HTTP call just
// past the bridge's own kill (timeoutMS + 5s slack) so a sick bridge
// can never hang a chat turn.
func (s *Server) termuxRunOne(ctx context.Context, command, workdir string, timeoutMS int) (*termuxbridge.RunResult, string) {
        if s.termux == nil {
                return nil, "OBSERVATION:\nerror: this engine has no Termux bridge (a desktop build, or the APK's loopback bridge is down) — the termux tool cannot run anything here."
        }
        runCtx, cancel := context.WithTimeout(ctx, time.Duration(timeoutMS)*time.Millisecond+5*time.Second)
        defer cancel()
        res, err := s.termux.Run(runCtx, command, workdir, timeoutMS)
        if err != nil {
                return nil, "OBSERVATION:\nerror: the Termux bridge did not answer — " + err.Error()
        }
        return res, ""
}

// termuxTimeoutObs — the bridge's own timeout killed the script: the
// honest partial-output report.
func termuxTimeoutObs(res *termuxbridge.RunResult, timeoutMS int) string {
        var sb strings.Builder
        fmt.Fprintf(&sb, "OBSERVATION:\nTIMEOUT — Termux killed the command at its %ds budget", timeoutMS/1000)
        if res != nil && res.Stdout != "" {
                sb.WriteString("; partial stdout:\n" + res.Stdout)
        }
        if res != nil && res.Stderr != "" {
                sb.WriteString("\nstderr:\n" + res.Stderr)
        }
        return sb.String()
}

// termuxFailObs — the script failed (not 42, not timeout): the full
// stderr is the honest diagnosis; stdout rides along when present.
func termuxFailObs(res *termuxbridge.RunResult) string {
        if res == nil {
                return "OBSERVATION:\nerror: the Termux side failed with no result"
        }
        var sb strings.Builder
        fmt.Fprintf(&sb, "OBSERVATION:\nerror: %s (exit %d)", firstLineOf(res.Stderr), res.ExitCode)
        if res.Stderr != "" {
                sb.WriteString("\nstderr:\n" + res.Stderr)
        }
        if res.Stdout != "" {
                sb.WriteString("\nstdout:\n" + res.Stdout)
        }
        if termuxTruncated(res) {
                sb.WriteString("\n" + termuxTruncatedMarker)
        }
        return sb.String()
}

// firstLineOf returns the first non-empty line ("" when none) — the
// one-line diagnosis for failure observations.
func firstLineOf(s string) string {
        for _, line := range strings.Split(s, "\n") {
                if line = strings.TrimRight(line, "\r"); strings.TrimSpace(line) != "" {
                        return line
                }
        }
        return ""
}

// ── the truncation honesty (Termux's 100KB physics, reported) ────────────

// termuxOriginalLen reads one optional original-length field off a
// RunResult DEFENSIVELY (reflection): agent A's v1.20.1 bridge + client
// carry stdout_original_length / stderr_original_length (the true sizes
// Termux saw before its 100KB result-Bundle cap); this worktree's
// client struct does not have the fields yet, and reflection keeps the
// code compiling on BOTH sides of that merge — zero (unknown) here, the
// real number the moment the fields land.
func termuxOriginalLen(r *termuxbridge.RunResult, jsonTag string) int {
        if r == nil {
                return 0
        }
        v := reflect.Indirect(reflect.ValueOf(r))
        if v.Kind() != reflect.Struct {
                return 0
        }
        t := v.Type()
        for i := 0; i < t.NumField(); i++ {
                f := t.Field(i)
                if f.Type.Kind() != reflect.Int {
                        continue
                }
                if tag, ok := f.Tag.Lookup("json"); ok && strings.EqualFold(strings.Split(tag, ",")[0], jsonTag) {
                        return int(v.Field(i).Int())
                }
        }
        return 0
}

// termuxTruncated honestly reports whether Termux's 100KB result-Bundle
// cap cut this result: EXACT when the original lengths are carried
// (agent A's bridge), the cap-physics heuristic when they are not —
// stdout alone owns the whole 100KB budget, but when both streams are
// present the Bundle halves it (≥50KB observed in either stream means
// the cap fired or grazed it).
func termuxTruncated(r *termuxbridge.RunResult) bool {
        if r == nil {
                return false
        }
        if orig := termuxOriginalLen(r, "stdout_original_length"); orig > 0 && orig > len(r.Stdout) {
                return true
        }
        if orig := termuxOriginalLen(r, "stderr_original_length"); orig > 0 && orig > len(r.Stderr) {
                return true
        }
        if len(r.Stderr) == 0 {
                return len(r.Stdout) >= termuxCapBytes
        }
        return len(r.Stdout) >= termuxCapBytes/2 || len(r.Stderr) >= termuxCapBytes/2
}

// termuxMaybeTrunc appends the honest marker when the physics fired.
func termuxMaybeTrunc(res *termuxbridge.RunResult, text string) string {
        if termuxTruncated(res) {
                if text != "" && !strings.HasSuffix(text, "\n") {
                        text += "\n"
                }
                return text + termuxTruncatedMarker
        }
        return text
}

// ── exec ─────────────────────────────────────────────────────────────────

// termuxVerbExec — {command, timeout_ms?}: workdir = the FIRST bound
// root, the blocklist gate, the pacing gate (the rolling cap), FULL
// stdout+stderr+exit_code.
func (s *Server) termuxVerbExec(ctx context.Context, sessionID string, get func(string) string, args map[string]any, roots []string) string {
        command := get("command")
        if command == "" {
                return "OBSERVATION:\nerror: exec needs {\"action\":\"exec\",\"args\":{\"command\":\"…\",\"timeout_ms\":60000}} — the shell command to run in the first bound folder (" + roots[0] + ")"
        }
        if why := termuxBlocklistHit(command); why != "" {
                // NEVER executed — the blocklist class is reported honestly.
                return "OBSERVATION:\nREFUSED — the command looks like " + why +
                        ". The termux exec blocklist (the shell-jail law) never runs the file-destroying / device-destroying / system-power class. Rephrase without the destructive operation; a command inside the bound folders stays yours to run."
        }
        // timeout: default 60s, the bridge's own 180s hard cap.
        timeoutMS := 60000
        if v, ok := args["timeout_ms"].(float64); ok && v > 0 {
                timeoutMS = int(v)
        }
        if timeoutMS > 180000 {
                timeoutMS = 180000
        }
        // the pacing gate (per-SESSION rolling window — a refused exec never
        // consumes the window; the cap verdict tells the model exactly what
        // to do). v1.23.1: no cooldown — rapid short commands run.
        if s.termuxExecGate(sessionID) {
                return "OBSERVATION:\nerror: exec rate cap — this chat already ran 12 one-shot execs in the last minute (the anti-burst law). Ask the user whether they want more, or wait for the window to roll."
        }
        res, errObs := s.termuxRunOne(ctx, command, roots[0], timeoutMS)
        if errObs != "" {
                return errObs
        }
        if res.Timeout {
                return termuxTimeoutObs(res, timeoutMS)
        }
        var sb strings.Builder
        fmt.Fprintf(&sb, "OBSERVATION:\nEXEC DONE — workdir %s\nexit_code: %d\nstdout:\n", roots[0], res.ExitCode)
        if res.Stdout == "" {
                sb.WriteString("(empty)\n")
        } else {
                sb.WriteString(res.Stdout)
                if !strings.HasSuffix(res.Stdout, "\n") {
                        sb.WriteString("\n")
                }
        }
        sb.WriteString("stderr:\n")
        if res.Stderr == "" {
                sb.WriteString("(empty)\n")
        } else {
                sb.WriteString(res.Stderr)
                if !strings.HasSuffix(res.Stderr, "\n") {
                        sb.WriteString("\n")
                }
        }
        return termuxMaybeTrunc(res, sb.String())
}

// termuxExecCap — 12 one-shot execs per rolling 60s window per
// session (the per-turn-equivalent law: the runner is per-call, so the
// rolling window carries the cap).
const termuxExecCap = 12

// termuxExecGate enforces THE ARM's pacing: ≤termuxExecCap execs in the
// rolling window, per SESSION. It stamps the clock ONLY when the exec
// will actually run (a refused call consumes nothing — the model
// retries honestly). capped = the window verdict. (v1.23.1: the ≥4s
// cooldown verdict is gone — rapid-fire short commands run.)
func (s *Server) termuxExecGate(sessionID string) (capped bool) {
        key := sessionID
        if key == "" {
                key = "(sessionless)"
        }
        now := time.Now()
        s.termuxExecMu.Lock()
        defer s.termuxExecMu.Unlock()
        if s.termuxExecLog == nil {
                s.termuxExecLog = map[string][]time.Time{}
        }
        cutoff := now.Add(-termuxExecWindow)
        kept := s.termuxExecLog[key][:0]
        for _, ts := range s.termuxExecLog[key] {
                if ts.After(cutoff) {
                        kept = append(kept, ts)
                }
        }
        s.termuxExecLog[key] = kept
        if len(kept) >= termuxExecCap {
                return true
        }
        s.termuxExecLog[key] = append(kept, now)
        return false
}

// ── the file verbs ───────────────────────────────────────────────────────

// termuxPathArgs resolves + pre-flights one path verb's target: the
// engine-side jail check (no "..", root prefix) runs BEFORE the bridge
// is ever touched. obs != "" = the honest refusal/error.
func (s *Server) termuxPathArgs(get func(string) string, roots []string, need string) (joined string, obs string) {
        rel := get("path")
        if rel == "" && need != "" {
                return "", "OBSERVATION:\nerror: " + need
        }
        joined = termuxResolvePath(roots, rel)
        if !termuxJailOK(joined, roots) {
                return joined, termuxJailRefused(joined, joined, roots)
        }
        return joined, ""
}

// termuxVerbLs — {path?}: the jailed listing (dirs first, sizes,
// mtimes, hidden included), emitted by the script, formatted by the
// engine. FULL output — the only cap is Termux's own.
func (s *Server) termuxVerbLs(ctx context.Context, get func(string) string, roots []string) string {
        joined, obs := s.termuxPathArgs(get, roots, "")
        if obs != "" {
                return obs
        }
        script := termuxJailScript(nil, `if [ ! -d "$r" ]; then echo "not a directory: $r" >&2; exit 1; fi
find "$r" -maxdepth 1 -mindepth 1 -printf '%y|%f|%s|%TY-%Tm-%Td %TH:%TM\n' | sort -t'|' -k1,1 -k2,2
`)
        oc, obs := s.termuxRunScript(ctx, script, append([]string{joined}, roots...), roots, "", 60000)
        if obs != "" {
                return obs
        }
        lines := nonEmptyLines(oc.body)
        var sb strings.Builder
        fmt.Fprintf(&sb, "OBSERVATION:\nLS — %s (%d entries, dirs first, hidden included):\n", oc.resolved, len(lines))
        for _, line := range lines {
                parts := strings.SplitN(line, "|", 4)
                if len(parts) != 4 {
                        continue
                }
                switch parts[0] {
                case "d":
                        fmt.Fprintf(&sb, "%s/ (dir) — %s\n", parts[1], parts[3])
                case "l":
                        fmt.Fprintf(&sb, "%s (symlink) — %s\n", parts[1], parts[3])
                default:
                        fmt.Fprintf(&sb, "%s (%s) — %s\n", parts[1], termuxBytes(parts[2]), parts[3])
                }
        }
        return termuxMaybeTrunc(oc.res, sb.String())
}

// termuxVerbRead — {path}: cat, binary-sniffed inside the script, FULL
// text (no local cap — the whole-truth law).
func (s *Server) termuxVerbRead(ctx context.Context, get func(string) string, roots []string) string {
        joined, obs := s.termuxPathArgs(get, roots, `read needs {"path":"the/file"} (relative to the first bound folder, or absolute inside one)`)
        if obs != "" {
                return obs
        }
        script := termuxJailScript(nil, `if [ ! -f "$r" ]; then echo "not a file: $r" >&2; exit 1; fi
if head -c 4096 -- "$r" | grep -qP '[\x00-\x08\x0e-\x1f]'; then echo "binary $(stat -c%s -- "$r")"; exit 0; fi
echo "text $(stat -c%s -- "$r")"
cat -- "$r"
`)
        oc, obs := s.termuxRunScript(ctx, script, append([]string{joined}, roots...), roots, "", 60000)
        if obs != "" {
                return obs
        }
        head := firstLineOf(oc.body)
        rest := strings.TrimPrefix(oc.body, head)
        rest = strings.TrimPrefix(rest, "\n")
        if strings.HasPrefix(head, "binary ") {
                return "OBSERVATION:\nREAD — " + oc.resolved + ": binary file, " + strings.TrimPrefix(head, "binary ") + " bytes — no text to read"
        }
        if strings.HasPrefix(head, "text ") {
                out := "OBSERVATION:\nREAD — " + oc.resolved + " (" + strings.TrimPrefix(head, "text ") + " bytes)\n" + rest
                return termuxMaybeTrunc(oc.res, out)
        }
        return "OBSERVATION:\nREAD — " + oc.resolved + "\n" + oc.body
}

// termuxVerbWrite — {path, content} (write) / the >> twin (append):
// the content rides base64 (safe chars only, ≤1MB) — ZERO shell
// interpolation; an existing directory is refused; the byte count is
// honestly reported.
func (s *Server) termuxVerbWrite(ctx context.Context, action string, get func(string) string, roots []string) string {
        joined, obs := s.termuxPathArgs(get, roots, action+` needs {"path":"the/file","content":"…"}`)
        if obs != "" {
                return obs
        }
        content := get("content")
        if len(content) > termuxWriteCap {
                return "OBSERVATION:\nerror: " + action + " content is " + strconv.Itoa(len(content)) + " bytes — over the 1MB intent cap. Split the write into chunks (append) or write a smaller file."
        }
        b64 := base64.StdEncoding.EncodeToString([]byte(content))
        var script string
        if action == "append" {
                script = termuxJailScript([]string{"b64"}, `if [ -d "$r" ]; then echo "refusing to append: $r is an existing directory" >&2; exit 1; fi
printf %s "$b64" | base64 -d >> "$r" || { echo "append failed: $r" >&2; exit 1; }
echo "appended $(stat -c%s -- "$r")"
`)
        } else {
                script = termuxJailScript([]string{"b64"}, `if [ -d "$r" ]; then echo "refusing to write: $r is an existing directory" >&2; exit 1; fi
printf %s "$b64" | base64 -d > "$r" || { echo "write failed: $r" >&2; exit 1; }
echo "wrote $(stat -c%s -- "$r")"
`)
        }
        oc, obs := s.termuxRunScript(ctx, script, append([]string{joined, b64}, roots...), roots, "", 30000)
        if obs != "" {
                return obs
        }
        head := firstLineOf(oc.body)
        if action == "append" {
                if strings.HasPrefix(head, "appended ") {
                        return "OBSERVATION:\nAPPENDED — " + oc.resolved + " (file now " + strings.TrimPrefix(head, "appended ") + " bytes)"
                }
        } else if strings.HasPrefix(head, "wrote ") {
                return "OBSERVATION:\nWROTE — " + oc.resolved + " (" + strings.TrimPrefix(head, "wrote ") + " bytes)"
        }
        return "OBSERVATION:\n" + strings.ToUpper(action) + " — " + oc.resolved + "\n" + oc.body
}

// termuxVerbRm — {path}: jailed; the bound roots themselves are
// REFUSED (never delete the jail — a bare path resolves to the first
// root, which is exactly the refusal).
func (s *Server) termuxVerbRm(ctx context.Context, get func(string) string, roots []string) string {
        joined, obs := s.termuxPathArgs(get, roots, "")
        if obs != "" {
                return obs
        }
        for _, root := range roots {
                if joined == strings.TrimSuffix(root, "/") {
                        return "OBSERVATION:\nerror: refusing to remove a bound workspace root itself (" + joined + ") — the jail stays. Remove the contents (a path INSIDE the root) or have the user unbind the folder."
                }
        }
        script := termuxJailScript(nil, `for root in "$@"; do
  if [ "$r" = "$root" ]; then echo "refusing to remove a bound workspace root: $r" >&2; exit 1; fi
done
rm -r -- "$r" || { echo "remove failed: $r" >&2; exit 1; }
echo "removed"
`)
        oc, obs := s.termuxRunScript(ctx, script, append([]string{joined}, roots...), roots, "", 30000)
        if obs != "" {
                return obs
        }
        return "OBSERVATION:\nREMOVED — " + oc.resolved
}

// termuxVerbMkdir — {path}: mkdir -p, jailed.
func (s *Server) termuxVerbMkdir(ctx context.Context, get func(string) string, roots []string) string {
        joined, obs := s.termuxPathArgs(get, roots, `mkdir needs {"path":"the/folder"}`)
        if obs != "" {
                return obs
        }
        script := termuxJailScript(nil, `mkdir -p -- "$r" || { echo "mkdir failed: $r" >&2; exit 1; }
echo "created"
`)
        oc, obs := s.termuxRunScript(ctx, script, append([]string{joined}, roots...), roots, "", 30000)
        if obs != "" {
                return obs
        }
        return "OBSERVATION:\nCREATED — " + oc.resolved
}

// termuxVerbGrep — {pattern, path?, glob?}: grep -rn, the pattern a
// POSITIONAL ARG (zero interpolation), UNLIMITED hits (the v1.19.1
// whole-truth law); the honest "no matches" line.
func (s *Server) termuxVerbGrep(ctx context.Context, get func(string) string, roots []string) string {
        pattern := get("pattern")
        if pattern == "" {
                return "OBSERVATION:\nerror: grep needs {\"action\":\"grep\",\"args\":{\"pattern\":\"text\",\"path\":\"…\",\"glob\":\"*.go\"}}"
        }
        joined, obs := s.termuxPathArgs(get, roots, "")
        if obs != "" {
                return obs
        }
        glob := get("glob")
        if glob == "" {
                glob = get("include")
        }
        script := termuxJailScript([]string{"pattern", "include"}, `if [ ! -e "$r" ]; then echo "no such path: $r" >&2; exit 1; fi
if [ -n "$include" ]; then
  grep -rn --include="$include" -- "$pattern" "$r"; rc=$?
else
  grep -rn -- "$pattern" "$r"; rc=$?
fi
if [ "$rc" -eq 1 ]; then echo "no matches for the pattern"; exit 0; fi
if [ "$rc" -ne 0 ]; then echo "grep failed (exit $rc)" >&2; exit "$rc"; fi
`)
        oc, obs := s.termuxRunScript(ctx, script, append([]string{joined, pattern, glob}, roots...), roots, "", 60000)
        if obs != "" {
                return obs
        }
        lines := nonEmptyLines(oc.body)
        if len(lines) == 1 && lines[0] == "no matches for the pattern" {
                return "OBSERVATION:\nGREP — \"" + pattern + "\" in " + oc.resolved + ": no matches"
        }
        var sb strings.Builder
        fmt.Fprintf(&sb, "OBSERVATION:\nGREP — \"%s\" in %s (unlimited hits, %d line(s)):\n", pattern, oc.resolved, len(lines))
        sb.WriteString(oc.body)
        if oc.body != "" && !strings.HasSuffix(oc.body, "\n") {
                sb.WriteString("\n")
        }
        return termuxMaybeTrunc(oc.res, sb.String())
}

// termuxVerbFind — {path?, name?}: find by name, FULL output (the
// 100KB Termux cap is the only physics).
func (s *Server) termuxVerbFind(ctx context.Context, get func(string) string, roots []string) string {
        joined, obs := s.termuxPathArgs(get, roots, "")
        if obs != "" {
                return obs
        }
        name := get("name")
        script := termuxJailScript([]string{"name"}, `if [ ! -e "$r" ]; then echo "no such path: $r" >&2; exit 1; fi
if [ -n "$name" ]; then
  find "$r" -name "$name" -print
else
  find "$r" -print
fi
`)
        oc, obs := s.termuxRunScript(ctx, script, append([]string{joined, name}, roots...), roots, "", 60000)
        if obs != "" {
                return obs
        }
        lines := nonEmptyLines(oc.body)
        if len(lines) == 0 {
                return "OBSERVATION:\nFIND — " + oc.resolved + ": nothing found"
        }
        var sb strings.Builder
        fmt.Fprintf(&sb, "OBSERVATION:\nFIND — %s (%d result(s)):\n", oc.resolved, len(lines))
        sb.WriteString(oc.body)
        if !strings.HasSuffix(oc.body, "\n") {
                sb.WriteString("\n")
        }
        return termuxMaybeTrunc(oc.res, sb.String())
}

// ── pkg ──────────────────────────────────────────────────────────────────

// termuxVerbCmds — v1.21.1 THE ARMED HAND ("add everything that termux
// supports… all the linux commands, and if any package is installed,
// all that packages commands"): the FULL command inventory, one honest
// listing. A FIXED script (zero model/user strings anywhere near it —
// the pkg idiom): PATH, PREFIX, then every executable in $PREFIX/bin
// (the coreutils userland + every command every pkg-installed package
// shipped + the termux-api commands when that package is in). The model
// runs any of them with exec, discovers new ones after pkg with cmds
// again, and pokes single names with exec's `command -v <name>`.
func (s *Server) termuxVerbCmds(ctx context.Context) string {
        script := `set -u
echo "PATH=${PATH:-}"
echo "PREFIX=${PREFIX:-/data/data/com.termux/files/usr}"
ls "${PREFIX:-/data/data/com.termux/files/usr}/bin" 2>/dev/null | tr '\n' ' '
echo
`
        res, errObs := s.termuxRunOne(ctx, termuxCommand(script), "", 60000)
        if errObs != "" {
                return errObs
        }
        if res.Timeout {
                return termuxTimeoutObs(res, 60000)
        }
        var sb strings.Builder
        sb.WriteString("OBSERVATION:\nCMDS — every command available in this Termux (run ANY of them with exec; pkg install adds a package's commands instantly — cmds again to see them):\n")
        if res.Stdout != "" {
                sb.WriteString(res.Stdout)
                if !strings.HasSuffix(res.Stdout, "\n") {
                        sb.WriteString("\n")
                }
        }
        if res.Stderr != "" {
                sb.WriteString("stderr:\n" + res.Stderr)
                if !strings.HasSuffix(res.Stderr, "\n") {
                        sb.WriteString("\n")
                }
        }
        fmt.Fprintf(&sb, "exit_code: %d\n", res.ExitCode)
        return termuxMaybeTrunc(res, sb.String())
}

// termuxVerbPkg — {op, packages}: pkg install -y / update / remove;
// every package name sanitized engine-side (safe charset only) BEFORE
// it ever rides a command line.
func (s *Server) termuxVerbPkg(ctx context.Context, get func(string) string, args map[string]any) string {
        op := get("op")
        if op == "" {
                op = get("action2")
        }
        switch op {
        case "install", "update", "remove":
        case "":
                return "OBSERVATION:\nerror: pkg needs {\"action\":\"pkg\",\"args\":{\"op\":\"install|update|remove\",\"packages\":[\"python\",\"git\"]}}"
        default:
                return "OBSERVATION:\nerror: unknown pkg op \"" + op + "\" (install, update or remove)"
        }
        var pkgs []string
        if raw, ok := args["packages"].([]any); ok {
                for _, p := range raw {
                        if ps, ok := p.(string); ok && strings.TrimSpace(ps) != "" {
                                pkgs = append(pkgs, strings.TrimSpace(ps))
                        }
                }
        }
        if p := get("package"); p != "" {
                pkgs = append(pkgs, p)
        }
        if (op == "install" || op == "remove") && len(pkgs) == 0 {
                return "OBSERVATION:\nerror: pkg " + op + " needs {\"packages\":[\"name\",…]}"
        }
        for _, p := range pkgs {
                if !termuxPkgNameRE.MatchString(p) {
                        return "OBSERVATION:\nerror: package name \"" + p + "\" refused — package names are letters, digits and . _ + - only (no spaces, no shell metacharacters)."
                }
        }
        vargs := append([]string{op}, pkgs...)
        script := `set -u
op="$1"
shift
case "$op" in
  install) pkg install -y "$@" ;;
  update) pkg update -y ;;
  remove) pkg uninstall -y "$@" ;;
esac
rc=$?
if [ "$rc" -ne 0 ]; then echo "pkg $op failed (exit $rc)" >&2; exit "$rc"; fi
echo "pkg $op done"
`
        res, errObs := s.termuxRunOne(ctx, termuxCommand(script, vargs...), "", 180000)
        if errObs != "" {
                return errObs
        }
        if res.Timeout {
                return termuxTimeoutObs(res, 180000)
        }
        var sb strings.Builder
        fmt.Fprintf(&sb, "OBSERVATION:\nPKG %s — full Termux pkg output:\n", strings.ToUpper(op))
        if res.Stdout != "" {
                sb.WriteString(res.Stdout)
                if !strings.HasSuffix(res.Stdout, "\n") {
                        sb.WriteString("\n")
                }
        }
        if res.Stderr != "" {
                sb.WriteString("stderr:\n" + res.Stderr)
                if !strings.HasSuffix(res.Stderr, "\n") {
                        sb.WriteString("\n")
                }
        }
        fmt.Fprintf(&sb, "exit_code: %d\n", res.ExitCode)
        return termuxMaybeTrunc(res, sb.String())
}

// ── background-process sessions ─────────────────────────────────────────

// termuxVerbSessionStart — {name, command}: $HOME/.doomalay/sessions/
// <name>/{run.sh,out.log,pid}; run.sh wraps the command with a TERM
// trap (session_kill actually kills the child, not just the shell);
// the pid returns in the observation.
func (s *Server) termuxVerbSessionStart(ctx context.Context, get func(string) string) string {
        name := get("name")
        command := get("command")
        if name == "" || command == "" {
                return "OBSERVATION:\nerror: session_start needs {\"action\":\"session_start\",\"args\":{\"name\":\"web\",\"command\":\"python -m http.server 8000\"}} — the name is [a-zA-Z0-9._-]{1,40}, the command runs as a background script"
        }
        if !termuxSessionNameRE.MatchString(name) {
                return "OBSERVATION:\nerror: session name \"" + name + "\" refused — names are letters, digits, dots, underscores and dashes, 1-40 chars (it names a folder under $HOME/.doomalay/sessions)."
        }
        script := `set -u
name="$1"
cmd="$2"
d="$HOME/.doomalay/sessions/$name"
mkdir -p -- "$d" || { echo "cannot create $d" >&2; exit 1; }
{ echo "trap 'kill \"\$child\" 2>/dev/null; exit 0' TERM INT"; echo "$cmd &"; echo 'child=$!'; echo 'wait "$child"'; } > "$d/run.sh" || { echo "cannot write $d/run.sh" >&2; exit 1; }
nohup bash "$d/run.sh" > "$d/out.log" 2>&1 &
echo $! > "$d/pid"
echo "$d"
sleep 1
if kill -0 "$(cat "$d/pid")" 2>/dev/null; then echo "live $(cat "$d/pid")"; else echo "exited $(cat "$d/pid")"; fi
`
        res, errObs := s.termuxRunOne(ctx, termuxCommand(script, name, command), "", 20000)
        if errObs != "" {
                return errObs
        }
        if res.Timeout {
                return termuxTimeoutObs(res, 20000)
        }
        if res.ExitCode != 0 {
                return termuxFailObs(res)
        }
        lines := nonEmptyLines(res.Stdout)
        if len(lines) < 2 {
                return termuxFailObs(res)
        }
        dir, state := lines[len(lines)-2], lines[len(lines)-1]
        if strings.HasPrefix(state, "live ") {
                return "OBSERVATION:\nSESSION STARTED — " + name + " (pid " + strings.TrimPrefix(state, "live ") + ")\ndir: " + dir +
                        "\nlog: " + dir + "/out.log (session_log {\"name\":\"" + name + "\"} tails it)\nkill: session_kill {\"name\":\"" + name + "\"}"
        }
        return "OBSERVATION:\nSESSION EXITED IMMEDIATELY — " + name + " (pid " + strings.TrimPrefix(state, "exited ") + "): the command died within its first second. Read the log: session_log {\"name\":\"" + name + "\"} — the last lines say why."
}

// termuxVerbSessionList — the sessions dir: name + pid + kill -0
// liveness + the ps line + the out.log size.
func (s *Server) termuxVerbSessionList(ctx context.Context) string {
        script := `set -u
d="$HOME/.doomalay/sessions"
if [ ! -d "$d" ]; then echo "no sessions yet"; exit 0; fi
for s in "$d"/*/; do
  [ -d "$s" ] || continue
  name="$(basename -- "$s")"
  pid="$(cat "$s/pid" 2>/dev/null)" || pid="-"
  if [ "$pid" != "-" ] && kill -0 "$pid" 2>/dev/null; then st="live"; else st="dead"; fi
  echo "$name|$pid|$st|$(stat -c%s -- "$s/out.log" 2>/dev/null || echo 0)|$(ps -o args= -p "$pid" 2>/dev/null || echo -)"
done
`
        res, errObs := s.termuxRunOne(ctx, termuxCommand(script), "", 15000)
        if errObs != "" {
                return errObs
        }
        if res.Timeout {
                return termuxTimeoutObs(res, 15000)
        }
        if res.ExitCode != 0 {
                return termuxFailObs(res)
        }
        lines := nonEmptyLines(res.Stdout)
        if len(lines) == 0 || lines[0] == "no sessions yet" {
                return "OBSERVATION:\nSESSIONS — none yet. session_start {\"name\":\"…\",\"command\":\"…\"} creates one (e.g. a python server: \"python -m http.server 8000\")."
        }
        var sb strings.Builder
        fmt.Fprintf(&sb, "OBSERVATION:\nSESSIONS — %d total (root: $HOME/.doomalay/sessions):\n", len(lines))
        for _, line := range lines {
                parts := strings.SplitN(line, "|", 5)
                if len(parts) != 5 {
                        continue
                }
                fmt.Fprintf(&sb, "- %s (pid %s, %s, log %s) — %s\n", parts[0], parts[1], parts[2], termuxBytes(parts[3]), parts[4])
        }
        return termuxMaybeTrunc(res, sb.String())
}

// termuxVerbSessionLog — {name, tail?}: tail -n (default 200) out.log,
// FULL bytes (the whole-truth law).
func (s *Server) termuxVerbSessionLog(ctx context.Context, get func(string) string, args map[string]any) string {
        name := get("name")
        if name == "" {
                return "OBSERVATION:\nerror: session_log needs {\"action\":\"session_log\",\"args\":{\"name\":\"web\",\"tail\":200}}"
        }
        if !termuxSessionNameRE.MatchString(name) {
                return "OBSERVATION:\nerror: session name \"" + name + "\" refused — names are [a-zA-Z0-9._-]{1,40}."
        }
        tail := 200
        if v, ok := args["tail"].(float64); ok && v > 0 {
                tail = int(v)
        }
        if tail > 100000 {
                tail = 100000
        }
        script := `set -u
name="$1"
n="$2"
d="$HOME/.doomalay/sessions/$name"
if [ ! -f "$d/out.log" ]; then echo "no session named $name (or no out.log yet)" >&2; exit 1; fi
echo "$d/out.log"
tail -n "$n" -- "$d/out.log"
`
        res, errObs := s.termuxRunOne(ctx, termuxCommand(script, name, strconv.Itoa(tail)), "", 30000)
        if errObs != "" {
                return errObs
        }
        if res.Timeout {
                return termuxTimeoutObs(res, 30000)
        }
        if res.ExitCode != 0 {
                return termuxFailObs(res)
        }
        stdout := res.Stdout
        logPath := firstLineOf(stdout)
        body := strings.TrimPrefix(stdout, logPath)
        body = strings.TrimPrefix(body, "\n")
        var sb strings.Builder
        fmt.Fprintf(&sb, "OBSERVATION:\nSESSION LOG — %s (tail %d):\n", name, tail)
        sb.WriteString(body)
        if body != "" && !strings.HasSuffix(body, "\n") {
                sb.WriteString("\n")
        }
        return termuxMaybeTrunc(res, sb.String())
}

// termuxVerbSessionKill — {name}: SIGTERM → 3s wait → kill -0 check →
// SIGKILL if alive; the honest report either way.
func (s *Server) termuxVerbSessionKill(ctx context.Context, get func(string) string) string {
        name := get("name")
        if name == "" {
                return "OBSERVATION:\nerror: session_kill needs {\"action\":\"session_kill\",\"args\":{\"name\":\"web\"}}"
        }
        if !termuxSessionNameRE.MatchString(name) {
                return "OBSERVATION:\nerror: session name \"" + name + "\" refused — names are [a-zA-Z0-9._-]{1,40}."
        }
        script := `set -u
name="$1"
d="$HOME/.doomalay/sessions/$name"
pid="$(cat "$d/pid" 2>/dev/null)" || { echo "no session named $name (no pid file)" >&2; exit 1; }
kill -TERM "$pid" 2>/dev/null || { echo "session $name (pid $pid) is not running" >&2; exit 1; }
for i in 1 2 3; do kill -0 "$pid" 2>/dev/null || break; sleep 1; done
if kill -0 "$pid" 2>/dev/null; then
  kill -KILL "$pid" 2>/dev/null; sleep 1
  if kill -0 "$pid" 2>/dev/null; then echo "pid $pid survived SIGKILL" >&2; exit 1; fi
  echo "killed $name (pid $pid) — SIGTERM ignored, SIGKILL used"
else
  echo "killed $name (pid $pid) — SIGTERM"
fi
`
        res, errObs := s.termuxRunOne(ctx, termuxCommand(script, name), "", 30000)
        if errObs != "" {
                return errObs
        }
        if res.Timeout {
                return termuxTimeoutObs(res, 30000)
        }
        if res.ExitCode != 0 {
                return termuxFailObs(res)
        }
        body := strings.TrimPrefix(firstLineOf(res.Stdout), "killed ")
        return "OBSERVATION:\nSESSION KILLED — " + body
}

// ── help + the text helpers ─────────────────────────────────────────────

// termuxHelpText — the verb map + the jail explanation + the honesty
// caps, with the chat's REAL bound roots.
func termuxHelpText(roots []string) string {
        var sb strings.Builder
        sb.WriteString("termux tool — a real Termux Linux shell on the user's device, jailed to this chat's bound device folders.\n")
        fmt.Fprintf(&sb, "Bound folders (THE JAIL — every path verb stays inside one; relative paths resolve against the first):\n")
        for _, root := range roots {
                fmt.Fprintf(&sb, "- %s\n", root)
        }
        sb.WriteString(`THE CAPABILITY IS THE WHOLE LINUX USERLAND: exec runs ANY command in $PATH — coreutils (ls, cat, cp, mv, head, tail, wc, sort, tr, cut…), findutils, grep/sed/awk, bash scripting, python, git, ssh, curl, tar, and EVERY command of EVERY package pkg installs (node, gcc, clang, rust, ffmpeg, imagemagick, sqlite… the new commands go live the moment the install finishes). The termux-api package adds the device commands (termux-battery-status, termux-wifi-connectioninfo, termux-notification, termux-clipboard-set…). Compile with gcc/clang, serve with python -m http.server as a session, pipe and redirect freely — the only refusals are the file/device/power-destroying class. Discover the live inventory any time with the cmds action (or exec 'command -v <name>').

Actions (one JSON object of arguments per tool call):
  {"action":"exec","args":{"command":"python -V","timeout_ms":60000}}   run ANY shell command (workdir = the first bound folder; 60s default, 180s max; 12 per minute per chat)
  {"action":"cmds","args":{}}                 inventory EVERY available command (PATH, PREFIX, $PREFIX/bin — including all pkg-installed package commands)
  {"action":"ls","args":{"path":""}}           list a folder (dirs first, sizes, mtimes, hidden included)
  {"action":"read","args":{"path":"a.txt"}}    read a WHOLE file (binary files reported honestly)
  {"action":"write","args":{"path":"f.txt","content":"…"}}   write (overwrite) a file — ≤1MB per call
  {"action":"append","args":{"path":"f.txt","content":"…"}}  append to a file
  {"action":"rm","args":{"path":"f.txt"}}      remove a file/folder (a bound root itself is refused)
  {"action":"mkdir","args":{"path":"d"}}       create a folder (mkdir -p)
  {"action":"grep","args":{"pattern":"TODO","path":"","glob":"*.py"}}   search file contents — UNLIMITED hits
  {"action":"find","args":{"path":"","name":"*.go"}}   find files by name
  {"action":"pkg","args":{"op":"install","packages":["python","git"]}}  install|update|remove Termux packages (the package's commands go live instantly)
  {"action":"session_start","args":{"name":"web","command":"python -m http.server 8000"}}  background process (nohup + pid + out.log) — create AND kill on the fly, like python processes
  {"action":"session_list","args":{}}         every session: name, pid, live/dead, log size, the ps line
  {"action":"session_log","args":{"name":"web","tail":200}}    the session's full log tail
  {"action":"session_kill","args":{"name":"web"}}   SIGTERM → 3s → SIGKILL, honestly reported
Honesty caps: output is FULL everywhere — the only cap is Termux's own 100KB result bundle, reported when it hits. Commands that destroy files, devices or the system power state are refused (never executed).`)
        return sb.String()
}

// termuxBytes renders a byte count the way the repo's helpers do
// (workspacetool's humanBytes shape).
func termuxBytes(s string) string {
        n, err := strconv.ParseInt(s, 10, 64)
        if err != nil {
                return s + "B"
        }
        switch {
        case n >= 1<<20:
                return fmt.Sprintf("%.1fMB", float64(n)/(1<<20))
        case n >= 1<<10:
                return fmt.Sprintf("%.1fKB", float64(n)/(1<<10))
        default:
                return fmt.Sprintf("%dB", n)
        }
}

// nonEmptyLines splits a block into its non-empty lines.
func nonEmptyLines(s string) []string {
        var out []string
        for _, line := range strings.Split(s, "\n") {
                if strings.TrimSpace(line) != "" {
                        out = append(out, strings.TrimRight(line, "\r"))
                }
        }
        return out
}
