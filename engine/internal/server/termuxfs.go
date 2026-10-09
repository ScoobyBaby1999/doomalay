package server

// termuxfs.go — v1.20.2 THE LOCAL HAND (PLAN-V120 §v1.20.2): the jailed
// device-storage file system + the termux workspace file verbs.
//
// window.showDirectoryPicker does not exist in the Android WebView, so
// the APK's device-storage workspace flow can never ride the File Access
// API (the user's report: "nothing in that screen works. The app never
// requests device storage permission"). Every device I/O routes through
// the Termux bridge — ONE jail point (the v1.17.2 decision).
//
// REST:
//
//      GET  /api/termux/fs?path=<p>   the jailed listing (machine lines)
//      POST /api/termux/fs            {"action":"mkdir","path","name"?}
//      GET  /api/workspaces/{id}/file?path=<rel>   cat (termux rows only)
//      PUT  /api/workspaces/{id}/file              {"path","content"} — the
//                                                   EXTRA_STDIN write law
//
// The listing/mkdir paths are ROOT ALIASES as Termux sees them (shared →
// $HOME/storage/shared, downloads, documents, home) or ABSOLUTE paths
// already under a safe root. The Termux-side script resolves the alias,
// canonicalizes with readlink -f, and REFUSES (exit 42) when the resolved
// path leaves the safe roots — symlinks can't launder (readlink resolves
// them, `..` collapses) — and the engine ALSO prefix-checks the resolved
// path the script echoes back (the P| jail echo).
//
// THE HONESTY LAW (termuxapi.go's): every Termux-side problem (bridge not
// configured, dead bridge, timeout, script failure) answers HTTP 200 with
// {"ok":false,"error":…} — a state, never a 5xx. Only malformed requests
// (a path that fails the shape check or the jail) get the act handler's
// 400 writeError.

import (
        "context"
        "encoding/json"
        "errors"
        "fmt"
        "io"
        "net/http"
        "strconv"
        "strings"
        "time"

        "github.com/ScoobyBaby1999/doomalay/engine/internal/store"
        "github.com/ScoobyBaby1999/doomalay/engine/internal/termuxbridge"
)

// The fs verbs are quick one-shots: 20s bridge-side (the bridge hard-caps
// at 180s — a listing never needs it), 25s engine-side slack.
const (
        termuxFSTimeoutMS = 20000
        termuxFSDeadline  = 25 * time.Second
        termuxFSListCap   = 500 // the listing script's honest entry cap
)

// termuxAliasCase maps the PWA's ROOT aliases onto the Termux-side paths
// (bare or with a subpath — ${p#alias} carries the rest along). Absolute
// paths fall through untouched.
const termuxAliasCase = `case "$p" in
  shared|shared/*) p="$HOME/storage/shared${p#shared}" ;;
  downloads|downloads/*) p="$HOME/storage/downloads${p#downloads}" ;;
  documents|documents/*) p="$HOME/storage/documents${p#documents}" ;;
  home|home/*) p="$HOME${p#home}" ;;
esac
`

// termuxJailResolve is THE JAIL's resolution half: readlink -f collapses
// `..` and resolves every symlink on the way, then lands the absolute
// path in $rp (exit 42 when unresolvable).
const termuxJailResolveTmpl = `rp=$(readlink -f -- %s 2>/dev/null) || { echo "cannot resolve path" >&2; exit 42; }
[ -n "$rp" ] || { echo "cannot resolve path" >&2; exit 42; }
`

// termuxJailCheck is THE JAIL's verdict half: $rp must sit under one of
// the two safe roots or the script exits 42 — the engine maps that onto
// a 400 (a jail violation is a malformed path, the act handler's
// unknown-what rule).
const termuxJailCheck = `case "$rp" in
  /storage/emulated/0|/storage/emulated/0/*|/data/data/com.termux/files/home|/data/data/com.termux/files/home/*) ;;
  *) echo "path escapes the termux jail: $rp" >&2; exit 42 ;;
esac
`

// termuxListScript builds the jailed listing script. Line protocol:
// P|<resolved> first (the jail echo), then T|name|size|mtime rows
// (T = d/f/l, size = bytes, 0 for dirs, mtime = epoch seconds) — dirs
// first then files, each alphabetical (LC_ALL=C glob order), dotted
// entries included (dotglob), capped at termuxFSListCap entries; when
// capped a final TRUNCATED|<total> line reports the honest count.
func termuxListScript(p string) string {
        return "LC_ALL=C\n" +
                "p=" + termuxQuote(p) + "\n" +
                termuxAliasCase +
                fmt.Sprintf(termuxJailResolveTmpl, "\"$p\"") + "\n" +
                termuxJailCheck + "\n" +
                `[ -d "$rp" ] || { echo "not a folder: $rp" >&2; exit 43; }
echo "P|$rp"
cd -- "$rp" || { echo "cannot enter folder: $rp" >&2; exit 44; }
shopt -s nullglob dotglob
n=0
total=0
dirs=()
rest=()
for e in *; do
  total=$((total+1))
  if [ -L "$e" ]; then rest+=("$e")
  elif [ -d "$e" ]; then dirs+=("$e")
  else rest+=("$e"); fi
done
for e in "${dirs[@]}"; do
  [ "$n" -lt ` + strconv.Itoa(termuxFSListCap) + ` ] || break
  st=$(stat -c '%s %Y' -- "$e" 2>/dev/null) || st='0 0'
  echo "d|$e|${st%% *}|${st#* }"
  n=$((n+1))
done
for e in "${rest[@]}"; do
  [ "$n" -lt ` + strconv.Itoa(termuxFSListCap) + ` ] || break
  st=$(stat -c '%s %Y' -- "$e" 2>/dev/null) || st='0 0'
  if [ -L "$e" ]; then t=l; else t=f; fi
  echo "$t|$e|${st%% *}|${st#* }"
  n=$((n+1))
done
if [ "$total" -gt "$n" ]; then echo "TRUNCATED|$total"; fi
`
}

// termuxMkdirScript builds the jailed mkdir -p script (target = the path
// as given — the name form's join happens engine-side). The deepest
// EXISTING ancestor is resolved + jail-checked BEFORE anything is
// created, then the target after mkdir -p: both halves must sit under
// the safe roots.
func termuxMkdirScript(target string) string {
        return "LC_ALL=C\n" +
                "p=" + termuxQuote(target) + "\n" +
                termuxAliasCase +
                `a="$p"
while [ ! -e "$a" ]; do a=$(dirname -- "$a"); done
` + fmt.Sprintf(termuxJailResolveTmpl, "\"$a\"") + "\n" +
                termuxJailCheck + "\n" +
                `mkdir -p -- "$p" 2>/dev/null || { echo "cannot create folder: $p" >&2; exit 45; }
` + fmt.Sprintf(termuxJailResolveTmpl, "\"$p\"") + "\n" +
                termuxJailCheck + "\n" +
                `echo "P|$rp"
`
}

// termuxReadScript builds the jailed single-file read: P|<resolved>,
// then B|TEXT|<size> followed by the whole content (or B|BINARY|<size>
// with no content — the sniff rides head -c 8000 | grep -qP over the
// control-char ranges, INSIDE the Termux script). Whole-truth law: no
// engine-side cap; the bridge's own 100KB result physics is the ceiling.
func termuxReadScript(p string) string {
        return "LC_ALL=C\n" +
                "p=" + termuxQuote(p) + "\n" +
                fmt.Sprintf(termuxJailResolveTmpl, "\"$p\"") + "\n" +
                termuxJailCheck + "\n" +
                `[ -f "$rp" ] || { echo "not a file: $rp" >&2; exit 43; }
sz=$(stat -c '%s' -- "$rp" 2>/dev/null) || sz=0
echo "P|$rp"
if head -c 8000 -- "$rp" | grep -qP '[\x00-\x08\x0e-\x1f]' 2>/dev/null; then
  echo "B|BINARY|$sz"
else
  echo "B|TEXT|$sz"
  cat -- "$rp"
fi
`
}

// termuxWriteCommand builds THE EXTRA_STDIN LAW's command: the bridge
// runs `bash -c <command>`, so this launches an inner `bash -c '…' _`
// with the path as $1 — no shell-escaping surface, the content arrives
// as stdin (Run's "stdin" body field → the Kotlin /run route's
// RUN_COMMAND_STDIN extra). The deepest existing ancestor is jail-checked
// BEFORE the write; the file itself is written through its readlink -f
// resolution so a symlinked final component cannot launder the write.
func termuxWriteCommand(p string) string {
        inner := `p="$1"; d=$(dirname -- "$p"); a="$d"; ` +
                `while [ ! -e "$a" ]; do a=$(dirname -- "$a"); done; ` +
                `ra=$(readlink -f -- "$a" 2>/dev/null) || exit 42; [ -n "$ra" ] || exit 42; ` +
                `case "$ra" in /storage/emulated/0|/storage/emulated/0/*|/data/data/com.termux/files/home|/data/data/com.termux/files/home/*) ;; *) exit 42 ;; esac; ` +
                `mkdir -p -- "$d" 2>/dev/null; ` +
                `rp=$(readlink -f -- "$p" 2>/dev/null) || exit 42; [ -n "$rp" ] || exit 42; ` +
                `case "$rp" in /storage/emulated/0|/storage/emulated/0/*|/data/data/com.termux/files/home|/data/data/com.termux/files/home/*) ;; *) exit 42 ;; esac; ` +
                `cat > "$rp" || exit 45; echo "P|$rp"; stat -c "%s" -- "$rp" 2>/dev/null || echo 0`
        return "bash -c '" + inner + "' _ " + termuxQuote(p)
}

// ── pure helpers (the rig + tests pin these directly) ───────────────────

// termuxQuote single-quotes s for safe embedding into the bash scripts
// the bridge runs (the '\'' idiom — every byte between the quotes is
// literal to bash; the engine refuses control chars before this runs).
func termuxQuote(s string) string {
        return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}

// termuxResolvedOK reports whether a RESOLVED absolute path sits under
// one of the two safe roots (the engine-side belt under the script's
// jail — the P| echo is checked against this).
func termuxResolvedOK(p string) bool {
        return p == "/storage/emulated/0" || strings.HasPrefix(p, "/storage/emulated/0/") ||
                p == "/data/data/com.termux/files/home" || strings.HasPrefix(p, "/data/data/com.termux/files/home/")
}

// termuxPathShapeOK reports whether p is a shape the engine will even
// forward to the bridge: a ROOT alias (shared | downloads | documents |
// home, bare or with a subpath) or an ABSOLUTE path under one of the
// safe roots. Anything else (/etc/passwd, ../.., relative junk, control
// chars) is a malformed request — the act handler's unknown-what 400.
// Absolute paths that LOOK rooted but launder out (/storage/emulated/0/
// ../../etc) pass the shape check on purpose: the Termux-side readlink
// resolution + jail refuses them there.
func termuxPathShapeOK(p string) bool {
        if p == "" || strings.ContainsFunc(p, func(r rune) bool { return r < 0x20 || r == 0x7f }) {
                return false
        }
        for _, a := range []string{"shared", "downloads", "documents", "home"} {
                if p == a || strings.HasPrefix(p, a+"/") {
                        return true
                }
        }
        return termuxResolvedOK(p)
}

// termuxRelOK guards a workspace-relative path (the cloud file verbs'
// `..` refusal, plus the control-char guard).
func termuxRelOK(rel string) bool {
        if rel == "" {
                return true
        }
        if strings.Contains(rel, "..") {
                return false
        }
        return !strings.ContainsFunc(rel, func(r rune) bool { return r < 0x20 || r == 0x7f })
}

// termuxJoin joins a jailed root and a workspace-relative path.
func termuxJoin(root, rel string) string {
        rel = strings.Trim(rel, "/")
        if rel == "" {
                return root
        }
        return strings.TrimRight(root, "/") + "/" + rel
}

// termuxEntry is one listing row (the PWA's fs response shape).
type termuxEntry struct {
        Name  string `json:"name"`
        Dir   bool   `json:"dir"`
        Size  int64  `json:"size"`
        Mtime int64  `json:"mtime"`
}

// splitTermuxLine splits one \n-terminated line off s.
func splitTermuxLine(s string) (line, rest string) {
        if i := strings.IndexByte(s, '\n'); i >= 0 {
                return s[:i], s[i+1:]
        }
        return s, ""
}

// parseTermuxEntryLine parses "T|name|size|mtime" FROM THE RIGHT — a
// name containing '|' stays whole (size/mtime are the last two numeric
// fields). Malformed lines are skipped, never fatal.
func parseTermuxEntryLine(line string) (termuxEntry, bool) {
        if i := strings.IndexByte(line, '|'); i != 1 {
                return termuxEntry{}, false
        }
        t := line[:1]
        if t != "d" && t != "f" && t != "l" {
                return termuxEntry{}, false
        }
        rest := line[2:]
        j := strings.LastIndexByte(rest, '|')
        if j < 0 {
                return termuxEntry{}, false
        }
        mtime, err := strconv.ParseInt(strings.TrimSpace(rest[j+1:]), 10, 64)
        if err != nil {
                return termuxEntry{}, false
        }
        rest = rest[:j]
        k := strings.LastIndexByte(rest, '|')
        if k < 0 {
                return termuxEntry{}, false
        }
        size, err := strconv.ParseInt(strings.TrimSpace(rest[k+1:]), 10, 64)
        if err != nil {
                return termuxEntry{}, false
        }
        name := rest[:k]
        if name == "" {
                return termuxEntry{}, false
        }
        return termuxEntry{Name: name, Dir: t == "d", Size: size, Mtime: mtime}, true
}

// parseTermuxLines parses the listing script's stdout: P|<resolved>
// first, T|name|size|mtime rows, an optional TRUNCATED|<total> cap line.
func parseTermuxLines(stdout string) (resolved string, entries []termuxEntry, total int, truncated bool, err error) {
        line, rest := splitTermuxLine(stdout)
        if !strings.HasPrefix(line, "P|") {
                return "", nil, 0, false, errors.New("no P line in the listing")
        }
        resolved = strings.TrimRight(line[2:], "\r")
        entries = []termuxEntry{}
        for rest != "" {
                line, rest = splitTermuxLine(rest)
                if line == "" {
                        continue
                }
                if strings.HasPrefix(line, "TRUNCATED|") {
                        if tot, terr := strconv.Atoi(strings.TrimSpace(strings.TrimPrefix(line, "TRUNCATED|"))); terr == nil {
                                total, truncated = tot, true
                        }
                        continue
                }
                if en, ok := parseTermuxEntryLine(line); ok {
                        entries = append(entries, en)
                }
        }
        if !truncated {
                total = len(entries)
        }
        return resolved, entries, total, truncated, nil
}

// parseTermuxPLine reads a single P|<resolved> echo (the mkdir result).
func parseTermuxPLine(stdout string) (string, error) {
        line, _ := splitTermuxLine(stdout)
        if !strings.HasPrefix(line, "P|") {
                return "", errors.New("no P line in the result")
        }
        return strings.TrimRight(line[2:], "\r"), nil
}

// parseTermuxFile splits the read script's output: P|<resolved>, the
// B|TEXT|<size> / B|BINARY|<size> marker, then the WHOLE file content
// (binary files carry no content — the honest 📦 row).
func parseTermuxFile(stdout string) (resolved string, binary bool, size int64, content string, err error) {
        line, rest := splitTermuxLine(stdout)
        if !strings.HasPrefix(line, "P|") {
                return "", false, 0, "", errors.New("no P line in the read result")
        }
        resolved = strings.TrimRight(line[2:], "\r")
        line, rest = splitTermuxLine(rest)
        parts := strings.Split(line, "|")
        if len(parts) != 3 || parts[0] != "B" {
                return "", false, 0, "", errors.New("no B marker in the read result")
        }
        size, perr := strconv.ParseInt(strings.TrimSpace(parts[2]), 10, 64)
        if perr != nil {
                return "", false, 0, "", errors.New("bad size in the read result")
        }
        return resolved, parts[1] == "BINARY", size, rest, nil
}

// parseTermuxWriteResult splits the write script's output: P|<resolved>
// then the byte size line.
func parseTermuxWriteResult(stdout string) (resolved string, size int64, err error) {
        line, rest := splitTermuxLine(stdout)
        if !strings.HasPrefix(line, "P|") {
                return "", 0, errors.New("no P line in the write result")
        }
        resolved = strings.TrimRight(line[2:], "\r")
        size, serr := strconv.ParseInt(strings.TrimSpace(rest), 10, 64)
        if serr != nil {
                return "", 0, errors.New("bad size in the write result")
        }
        return resolved, size, nil
}

// ── the honest response helpers (termuxapi.go's laws) ────────────────────

// termuxErr writes THE HONEST ERROR: HTTP 200 + {"ok":false,"error":…} —
// a Termux-side problem is a state the PWA renders, never a 5xx.
func termuxErr(w http.ResponseWriter, msg string) {
        writeJSON(w, 200, map[string]any{"ok": false, "error": msg})
}

// termuxStderrOf composes the script-failure text (stderr first, the
// exit code as the fallback).
func termuxStderrOf(res *termuxbridge.RunResult) string {
        if res == nil {
                return "termux script failed"
        }
        if res.Stderr != "" {
                return strings.TrimSpace(res.Stderr)
        }
        return fmt.Sprintf("termux script failed (exit %d)", res.ExitCode)
}

// termuxExec runs one script through the bridge. Returns
// (result, jail, errMsg): jail=true → the script's exit-42 refusal (the
// caller 400s — a malformed path); errMsg != "" → an honest 200 error
// (transport failure, undelivered run, non-jail script failure).
func (s *Server) termuxExec(r *http.Request, script, stdin string) (*termuxbridge.RunResult, bool, string) {
        ctx, cancel := context.WithTimeout(r.Context(), termuxFSDeadline)
        defer cancel()
        var res *termuxbridge.RunResult
        var err error
        if stdin != "" {
                res, err = s.termux.RunWithStdin(ctx, script, "", termuxFSTimeoutMS, stdin)
        } else {
                res, err = s.termux.Run(ctx, script, "", termuxFSTimeoutMS)
        }
        if err != nil {
                return nil, false, "termux bridge: " + err.Error()
        }
        if res == nil || !res.Ok {
                msg := "termux run did not deliver a result"
                if res != nil {
                        if res.Timeout {
                                msg = "termux run timed out"
                        }
                        if res.Errmsg != "" {
                                msg = "termux run error: " + res.Errmsg
                        }
                }
                return nil, false, msg
        }
        if res.ExitCode == 42 {
                return res, true, ""
        }
        if res.ExitCode != 0 {
                return res, false, termuxStderrOf(res)
        }
        return res, false, ""
}

// ── GET /api/termux/fs?path=<p> — the jailed listing ─────────────────────

// handleTermuxFSList lists one folder through the bridge. NO cache —
// each call is a fresh ls (the PWA navigates on tap).
func (s *Server) handleTermuxFSList(w http.ResponseWriter, r *http.Request) {
        if s.termux == nil {
                termuxErr(w, "termux bridge not configured on this engine")
                return
        }
        p := strings.TrimSpace(r.URL.Query().Get("path"))
        if !termuxPathShapeOK(p) {
                writeError(w, http.StatusBadRequest,
                        "path must be a root alias (shared | downloads | documents | home) or an absolute path under /storage/emulated/0/ or the Termux home")
                return
        }
        res, jail, errMsg := s.termuxExec(r, termuxListScript(p), "")
        switch {
        case jail:
                writeError(w, http.StatusBadRequest, termuxStderrOf(res))
                return
        case errMsg != "":
                termuxErr(w, errMsg)
                return
        }
        resolved, entries, total, truncated, perr := parseTermuxLines(res.Stdout)
        if perr != nil {
                termuxErr(w, "listing failed: "+perr.Error())
                return
        }
        if !termuxResolvedOK(resolved) {
                // the script's jail echo landed outside the safe roots — the
                // engine-side belt refuses it even though the script's own case
                // let it through (a lying/older bridge cannot launder a path).
                writeError(w, http.StatusBadRequest, "path escapes the termux jail: "+resolved)
                return
        }
        writeJSON(w, 200, map[string]any{
                "ok":        true,
                "path":      resolved,
                "entries":   entries,
                "total":     total,
                "truncated": truncated,
        })
}

// ── POST /api/termux/fs — mkdir ──────────────────────────────────────────

// handleTermuxFSMkdir creates a folder. THE DOCUMENTED FORM:
// {"action":"mkdir","path":"<current>","name":"<n>"} (the name is a
// plain name — no / or ..); the joined-path form
// {"action":"mkdir","path":"<p>/<n>"} rides the exact same jail
// resolution (the engine cannot split it reliably, the script can).
func (s *Server) handleTermuxFSMkdir(w http.ResponseWriter, r *http.Request) {
        if s.termux == nil {
                termuxErr(w, "termux bridge not configured on this engine")
                return
        }
        var body struct {
                Action string `json:"action"`
                Path   string `json:"path"`
                Name   string `json:"name"`
        }
        if err := json.NewDecoder(io.LimitReader(r.Body, 8192)).Decode(&body); err != nil {
                writeError(w, http.StatusBadRequest, "invalid JSON body: "+err.Error())
                return
        }
        if body.Action != "mkdir" {
                writeError(w, http.StatusBadRequest, "unknown action (expected mkdir)")
                return
        }
        target := strings.TrimSpace(body.Path)
        if name := strings.TrimSpace(body.Name); name != "" {
                if name == "." || strings.Contains(name, "/") || strings.Contains(name, "..") {
                        writeError(w, http.StatusBadRequest, "folder name must be a plain name (no / or ..)")
                        return
                }
                target = strings.TrimRight(target, "/") + "/" + name
        }
        if !termuxPathShapeOK(target) {
                writeError(w, http.StatusBadRequest,
                        "path must be a root alias (shared | downloads | documents | home) or an absolute path under /storage/emulated/0/ or the Termux home")
                return
        }
        res, jail, errMsg := s.termuxExec(r, termuxMkdirScript(target), "")
        switch {
        case jail:
                writeError(w, http.StatusBadRequest, termuxStderrOf(res))
                return
        case errMsg != "":
                termuxErr(w, errMsg)
                return
        }
        resolved, perr := parseTermuxPLine(res.Stdout)
        if perr != nil {
                termuxErr(w, "mkdir failed: "+perr.Error())
                return
        }
        if !termuxResolvedOK(resolved) {
                writeError(w, http.StatusBadRequest, "folder escapes the termux jail: "+resolved)
                return
        }
        writeJSON(w, 200, map[string]any{"ok": true, "path": resolved})
}

// ── the termux workspace file verbs (the cloud rows' REST twins) ─────────

// termuxRootOf pulls the jailed root out of a termux row's meta.
func termuxRootOf(ws *store.Workspace) string {
        if ws == nil {
                return ""
        }
        m := ws.MetaJSON()
        if m == nil {
                return ""
        }
        if p, ok := m["termux_path"].(string); ok {
                return strings.TrimSpace(p)
        }
        return ""
}

// termuxWSFor loads the {id} row when it is a termux workspace (the GET
// file verb's cheap pre-check — cloud/device rows fall through to their
// own paths, and the malformed-id 400/404s still come from wsTarget).
func (s *Server) termuxWSFor(r *http.Request) *store.Workspace {
        id := r.PathValue("id")
        if id == "" || !wsIDRe.MatchString(id) {
                return nil
        }
        ws, err := s.db.GetWorkspace(id)
        if err != nil || ws == nil || ws.Kind != "termux" {
                return nil
        }
        return ws
}

// handleTermuxWSFile is the loadWS-guarded entry (NOT route-registered:
// the v0.44 GET/PUT /api/workspaces/{id}/file patterns already own these
// paths and dispatch on Kind — workspaces.go calls termuxWSFile with the
// row loaded). It stays independently honest: a non-termux row answers
// the 404-style refusal, matching the handlers' not-found behavior.
func (s *Server) handleTermuxWSFile(w http.ResponseWriter, r *http.Request) {
        ws := s.loadWS(w, r)
        if ws == nil {
                return
        }
        if ws.Kind != "termux" {
                writeError(w, http.StatusNotFound, "not a termux workspace — this row's files do not ride the Termux bridge")
                return
        }
        s.termuxWSFile(w, r, ws)
}

// termuxWSFile is the /api/workspaces/{id}/file branch for termux rows —
// the SAME REST shape the cloud rows speak, so the PWA viewer/editor
// twins apply. GET = the jailed cat (binary-honest); PUT = the
// EXTRA_STDIN write law.
func (s *Server) termuxWSFile(w http.ResponseWriter, r *http.Request, ws *store.Workspace) {
        if s.termux == nil {
                termuxErr(w, "termux bridge not configured on this engine")
                return
        }
        root := termuxRootOf(ws)
        if root == "" {
                writeError(w, http.StatusBadRequest, "this termux workspace has no termux_path — re-connect it from the device picker")
                return
        }
        switch r.Method {
        case http.MethodGet:
                s.termuxWSRead(w, r, root)
        case http.MethodPut:
                s.termuxWSWrite(w, r, root)
        default:
                writeError(w, http.StatusMethodNotAllowed, "method not allowed")
        }
}

// termuxWSRead is GET /api/workspaces/{id}/file?path=<rel> for a termux
// row: cat the jailed join, sniff binaries honestly, report the size.
func (s *Server) termuxWSRead(w http.ResponseWriter, r *http.Request, root string) {
        rel := strings.TrimSpace(r.URL.Query().Get("path"))
        if rel == "" {
                writeError(w, http.StatusBadRequest, "path is required")
                return
        }
        if !termuxRelOK(rel) {
                writeError(w, http.StatusBadRequest, "path traversal refused")
                return
        }
        res, jail, errMsg := s.termuxExec(r, termuxReadScript(termuxJoin(root, rel)), "")
        switch {
        case jail:
                writeError(w, http.StatusBadRequest, termuxStderrOf(res))
                return
        case errMsg != "":
                termuxErr(w, errMsg)
                return
        }
        resolved, binary, size, content, perr := parseTermuxFile(res.Stdout)
        if perr != nil {
                termuxErr(w, "read failed: "+perr.Error())
                return
        }
        if !termuxResolvedOK(resolved) {
                writeError(w, http.StatusBadRequest, "path escapes the termux jail: "+resolved)
                return
        }
        writeJSON(w, 200, map[string]any{
                "ok":       true,
                "path":     rel,
                "resolved": resolved,
                "content":  content,
                "size":     size,
                "binary":   binary,
        })
}

// termuxWSWrite is PUT /api/workspaces/{id}/file {path, content} for a
// termux row: bash -c 'cat > "$1"' _ <quoted-path> with the CONTENT AS
// STDIN — zero shell-escaping surface. (The bridge's own 1MB request
// body physics is the size ceiling — bigger writes answer the honest
// transport error.)
func (s *Server) termuxWSWrite(w http.ResponseWriter, r *http.Request, root string) {
        var body struct {
                Path    string `json:"path"`
                Content string `json:"content"`
        }
        if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
                writeError(w, http.StatusBadRequest, "invalid JSON: "+err.Error())
                return
        }
        rel := strings.TrimSpace(body.Path)
        if rel == "" || !termuxRelOK(rel) {
                writeError(w, http.StatusBadRequest, "valid path is required")
                return
        }
        res, jail, errMsg := s.termuxExec(r, termuxWriteCommand(termuxJoin(root, rel)), body.Content)
        switch {
        case jail:
                writeError(w, http.StatusBadRequest, termuxStderrOf(res))
                return
        case errMsg != "":
                termuxErr(w, errMsg)
                return
        }
        resolved, size, perr := parseTermuxWriteResult(res.Stdout)
        if perr != nil {
                termuxErr(w, "write failed: "+perr.Error())
                return
        }
        if !termuxResolvedOK(resolved) {
                writeError(w, http.StatusBadRequest, "path escapes the termux jail: "+resolved)
                return
        }
        writeJSON(w, 200, map[string]any{
                "ok":       true,
                "path":     rel,
                "resolved": resolved,
                "size":     size,
        })
}
