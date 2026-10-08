package server

// termuxfs_test.go — v1.20.2 THE LOCAL HAND: the jailed fs surface
// (/api/termux/fs list + mkdir, the ws file verbs for termux rows) against
// a fake bridge that answers /run from a scriptable map — the v1.17.2
// stub pattern (termuxapi_test.go), grown a brain for the fs verbs.
//
// Pinned here:
//   1. THE JAIL MATRIX — path-shape refusals (.. / /etc/passwd / relative
//      junk / control chars) are 400s exactly like the act handler's
//      unknown whats; the script's exit-42 refusal is a 400 carrying the
//      stderr; a lying P| echo outside the safe roots is refused
//      engine-side (the belt under the script's braces);
//   2. THE LISTING PARSE — dirs first, sizes/mtimes, TRUNCATED|total,
//      malformed lines skipped (never a crash), names containing '|' whole;
//   3. mkdir — the name form + the joined-path form, the name guard
//      (no / or ..), jail + honest-failure ladder;
//   4. THE DEVICE-POST ROUND-TRIP — a termux_path saves Kind "termux" +
//      meta, wsJSON surfaces it;
//   5. THE WS FILE VERBS — the read (content/size/binary sniff), THE
//      EXTRA_STDIN WRITE LAW (bash -c 'cat >' + the content as the body's
//      stdin field), the rel-path guards, the non-termux refusal;
//   6. the scripts themselves parse as bash (bash -n, when bash exists).

import (
        "bytes"
        "encoding/json"
        "net/http"
        "net/http/httptest"
        "os"
        "os/exec"
        "path/filepath"
        "strings"
        "sync"
        "testing"

        "github.com/ScoobyBaby1999/doomalay/engine/internal/config"
        "github.com/ScoobyBaby1999/doomalay/engine/internal/store"
)

// fsRunResult is what the fake bridge answers one /run with.
type fsRunResult struct {
        stdout   string
        stderr   string
        exit     int
        delivered bool // false → the run never came back (timeout-style)
}

// fsStub is the fake bridge: /run answers from a scriptable function and
// records every command + stdin it saw (the EXTRA_STDIN pin).
type fsStub struct {
        srv    *httptest.Server
        mu     sync.Mutex
        fn     func(command, stdin string) fsRunResult
        runs   []string
        stdins []string
}

func newFSStub(t *testing.T, fn func(command, stdin string) fsRunResult) *fsStub {
        t.Helper()
        st := &fsStub{fn: fn}
        mux := http.NewServeMux()
        mux.HandleFunc("POST /run", func(w http.ResponseWriter, r *http.Request) {
                var body map[string]any
                _ = json.NewDecoder(r.Body).Decode(&body)
                cmd, _ := body["command"].(string)
                stdin, _ := body["stdin"].(string)
                st.mu.Lock()
                st.runs = append(st.runs, cmd)
                st.stdins = append(st.stdins, stdin)
                fn := st.fn
                st.mu.Unlock()
                res := fn(cmd, stdin)
                writeStubBridgeJSON(w, map[string]any{
                        "ok": res.delivered, "stdout": res.stdout, "stderr": res.stderr,
                        "exit_code": res.exit, "err": 0, "errmsg": nil,
                        "timeout": !res.delivered,
                })
        })
        st.srv = httptest.NewServer(mux)
        t.Cleanup(st.srv.Close)
        return st
}

// lastRun returns the most recent (command, stdin) the bridge saw.
func (st *fsStub) lastRun() (string, string) {
        st.mu.Lock()
        defer st.mu.Unlock()
        if len(st.runs) == 0 {
                return "", ""
        }
        return st.runs[len(st.runs)-1], st.stdins[len(st.stdins)-1]
}

func (st *fsStub) runCount() int {
        st.mu.Lock()
        defer st.mu.Unlock()
        return len(st.runs)
}

func newV1202Server(t *testing.T, bridgeURL string) (*Server, *store.DB) {
        t.Helper()
        dir := t.TempDir()
        db, err := store.Open(dir)
        if err != nil {
                t.Fatalf("store: %v", err)
        }
        if err := db.Migrate(); err != nil {
                t.Fatalf("migrate: %v", err)
        }
        cfg := &config.Config{DataDir: dir, TermuxBridge: bridgeURL}
        return New(cfg, db, nil), db
}

func v1202Req(t *testing.T, s *Server, method, path, body string) (int, map[string]any) {
        t.Helper()
        var rd *bytes.Reader
        if body == "" {
                rd = bytes.NewReader(nil)
        } else {
                rd = bytes.NewReader([]byte(body))
        }
        req := httptest.NewRequest(method, path, rd)
        if body != "" {
                req.Header.Set("Content-Type", "application/json")
        }
        rec := httptest.NewRecorder()
        s.mux.ServeHTTP(rec, req)
        var out map[string]any
        if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
                t.Fatalf("response not JSON (%d): %s", rec.Code, rec.Body.String())
        }
        return rec.Code, out
}

// the canonical fake listing: shared resolved under /storage/emulated/0
// with one dir, one file, one symlink.
const fakeSharedListing = "P|/storage/emulated/0\n" +
        "d|Doomalay|0|1700000000\n" +
        "f|notes.txt|1234|1700000001\n" +
        "l|link|7|1700000002\n"

// ── 1. THE JAIL MATRIX ────────────────────────────────────────────────────

func TestV1202_TermuxFS_JailMatrix(t *testing.T) {
        st := newFSStub(t, func(command, stdin string) fsRunResult {
                return fsRunResult{stdout: fakeSharedListing, delivered: true}
        })
        s, _ := newV1202Server(t, st.srv.URL)

        t.Run("dot-dot escape refused as malformed", func(t *testing.T) {
                code, out := v1202Req(t, s, "GET", "/api/termux/fs?path=../../etc", "")
                if code != 400 {
                        t.Fatalf("path escaping the shape gate must 400, got %d: %v", code, out)
                }
                if _, has := out["error"]; !has {
                        t.Fatalf("the 400 must carry the writeError shape: %v", out)
                }
        })

        t.Run("etc passwd refused as malformed", func(t *testing.T) {
                code, out := v1202Req(t, s, "GET", "/api/termux/fs?path=/etc/passwd", "")
                if code != 400 {
                        t.Fatalf("/etc/passwd must 400, got %d: %v", code, out)
                }
        })

        t.Run("relative junk refused as malformed", func(t *testing.T) {
                code, _ := v1202Req(t, s, "GET", "/api/termux/fs?path=foo", "")
                if code != 400 {
                        t.Fatalf("relative junk must 400, got %d", code)
                }
        })

        t.Run("control chars refused before any bridge call", func(t *testing.T) {
                before := st.runCount()
                code, _ := v1202Req(t, s, "GET", "/api/termux/fs?path=shared%00x", "")
                if code != 400 {
                        t.Fatalf("control chars must 400, got %d", code)
                }
                if st.runCount() != before {
                        t.Fatalf("a malformed path must never reach the bridge")
                }
        })

        t.Run("alias resolves + the command embeds it quoted", func(t *testing.T) {
                code, out := v1202Req(t, s, "GET", "/api/termux/fs?path=shared", "")
                if code != 200 {
                        t.Fatalf("the shared alias must list, got %d: %v", code, out)
                }
                if out["ok"] != true {
                        t.Fatalf("ok must be true: %v", out)
                }
                if out["path"] != "/storage/emulated/0" {
                        t.Fatalf("the resolved path must surface: %v", out)
                }
                cmd, stdin := st.lastRun()
                if !strings.Contains(cmd, "'shared'") {
                        t.Fatalf("the script must embed the alias single-quoted: %q", cmd)
                }
                if stdin != "" {
                        t.Fatalf("a listing never sends stdin, got %q", stdin)
                }
        })

        t.Run("termux home root accepted", func(t *testing.T) {
                st.fn = func(command, stdin string) fsRunResult {
                        return fsRunResult{stdout: "P|/data/data/com.termux/files/home\n", delivered: true}
                }
                code, out := v1202Req(t, s, "GET", "/api/termux/fs?path=home", "")
                if code != 200 || out["path"] != "/data/data/com.termux/files/home" {
                        t.Fatalf("the home root must resolve, got %d: %v", code, out)
                }
        })

        t.Run("script exit 42 (jail) is a 400 with the stderr", func(t *testing.T) {
                st.fn = func(command, stdin string) fsRunResult {
                        return fsRunResult{stderr: "path escapes the termux jail: /etc", exit: 42, delivered: true}
                }
                code, out := v1202Req(t, s, "GET", "/api/termux/fs?path=/storage/emulated/0/../../etc", "")
                if code != 400 {
                        t.Fatalf("the jail's exit 42 must 400, got %d: %v", code, out)
                }
                if got, _ := out["error"].(string); !strings.Contains(got, "jail") {
                        t.Fatalf("the 400 must carry the script's stderr, got %q", got)
                }
        })

        t.Run("symlink laundering refused via the P echo (the belt)", func(t *testing.T) {
                // a lying/older bridge echoes a resolved path outside the roots
                // with exit 0 — the engine-side prefix check still refuses.
                st.fn = func(command, stdin string) fsRunResult {
                        return fsRunResult{stdout: "P|/etc/passwd\nf|x|1|1\n", delivered: true}
                }
                code, out := v1202Req(t, s, "GET", "/api/termux/fs?path=shared", "")
                if code != 400 {
                        t.Fatalf("the laundered echo must 400, got %d: %v", code, out)
                }
                if got, _ := out["error"].(string); !strings.Contains(got, "/etc/passwd") {
                        t.Fatalf("the refusal names the path, got %q", got)
                }
        })
}

// No bridge configured (every desktop build) → the honest 200 with
// {"ok":false,"error":…} — never a 5xx, never silence.
func TestV1202_TermuxFS_NoBridge_Honest200(t *testing.T) {
        s, _ := newV1202Server(t, "")
        code, out := v1202Req(t, s, "GET", "/api/termux/fs?path=shared", "")
        if code != 200 {
                t.Fatalf("no-bridge must answer 200, got %d: %v", code, out)
        }
        if out["ok"] != false {
                t.Fatalf("ok must be false: %v", out)
        }
        if got, _ := out["error"].(string); got != "termux bridge not configured on this engine" {
                t.Fatalf("the exact honest error, got %q", got)
        }
        code, out = v1202Req(t, s, "POST", "/api/termux/fs", `{"action":"mkdir","path":"shared","name":"x"}`)
        if code != 200 || out["ok"] != false {
                t.Fatalf("no-bridge mkdir must answer the same honest 200: %d %v", code, out)
        }
}

// A dead bridge is an honest state (transport error → 200 ok:false), never 5xx.
func TestV1202_TermuxFS_DeadBridge_Honest200(t *testing.T) {
        dead := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
        deadURL := dead.URL
        dead.Close()
        s, _ := newV1202Server(t, deadURL)
        code, out := v1202Req(t, s, "GET", "/api/termux/fs?path=shared", "")
        if code != 200 {
                t.Fatalf("Termux-side problems must never 5xx — got %d: %v", code, out)
        }
        if out["ok"] != false {
                t.Fatalf("ok must be false: %v", out)
        }
        if got, _ := out["error"].(string); got == "" {
                t.Fatalf("the error must carry the typed reason: %v", out)
        }
}

// An undelivered run (bridge timeout) is the same honest state.
func TestV1202_TermuxFS_UndeliveredRun_Honest200(t *testing.T) {
        st := newFSStub(t, func(command, stdin string) fsRunResult {
                return fsRunResult{delivered: false}
        })
        s, _ := newV1202Server(t, st.srv.URL)
        code, out := v1202Req(t, s, "GET", "/api/termux/fs?path=shared", "")
        if code != 200 || out["ok"] != false {
                t.Fatalf("undelivered run → honest 200 ok:false, got %d %v", code, out)
        }
}

// ── 2. THE LISTING PARSE ──────────────────────────────────────────────────

func TestV1202_TermuxFS_ListingParse(t *testing.T) {
        t.Run("dirs first, sizes + mtimes, TRUNCATED + total", func(t *testing.T) {
                st := newFSStub(t, func(command, stdin string) fsRunResult {
                        return fsRunResult{stdout: fakeSharedListing + "TRUNCATED|812\n", delivered: true}
                })
                s, _ := newV1202Server(t, st.srv.URL)
                code, out := v1202Req(t, s, "GET", "/api/termux/fs?path=shared", "")
                if code != 200 {
                        t.Fatalf("listing must 200, got %d: %v", code, out)
                }
                entries, _ := out["entries"].([]any)
                if len(entries) != 3 {
                        t.Fatalf("3 entries expected, got %d: %v", len(entries), out)
                }
                first, _ := entries[0].(map[string]any)
                if first["name"] != "Doomalay" || first["dir"] != true {
                        t.Fatalf("dirs first — the dir row leads: %v", first)
                }
                second, _ := entries[1].(map[string]any)
                if second["size"].(float64) != 1234 || second["mtime"].(float64) != 1700000001 {
                        t.Fatalf("the file row carries size + mtime: %v", second)
                }
                if out["truncated"] != true || out["total"].(float64) != 812 {
                        t.Fatalf("TRUNCATED|812 must surface honestly: %v", out)
                }
        })

        t.Run("malformed lines are skipped, never fatal", func(t *testing.T) {
                stdout := "P|/storage/emulated/0\n" +
                        "X|notype|1|1\n" +        // no type letter
                        "d|nonum|notanum\n" +     // unparsable tail
                        "d|nosize\n" +            // missing fields
                        "d||1|1\n" +              // empty name
                        "garbage\n" +             // not even a pipe
                        "f|good.txt|9|1700000000\n"
                st := newFSStub(t, func(command, stdin string) fsRunResult {
                        return fsRunResult{stdout: stdout, delivered: true}
                })
                s, _ := newV1202Server(t, st.srv.URL)
                code, out := v1202Req(t, s, "GET", "/api/termux/fs?path=shared", "")
                if code != 200 {
                        t.Fatalf("a garbled line is a lost row, not a 500: %d %v", code, out)
                }
                entries, _ := out["entries"].([]any)
                if len(entries) != 1 {
                        t.Fatalf("only the good row survives, got %d: %v", len(entries), out)
                }
        })

        t.Run("names containing pipes stay whole", func(t *testing.T) {
                stdout := "P|/storage/emulated/0\nf|we|ird|name.txt|12|34\n"
                st := newFSStub(t, func(command, stdin string) fsRunResult {
                        return fsRunResult{stdout: stdout, delivered: true}
                })
                s, _ := newV1202Server(t, st.srv.URL)
                _, out := v1202Req(t, s, "GET", "/api/termux/fs?path=shared", "")
                entries, _ := out["entries"].([]any)
                if len(entries) != 1 {
                        t.Fatalf("one row, got %v", out)
                }
                row, _ := entries[0].(map[string]any)
                if row["name"] != "we|ird|name.txt" {
                        t.Fatalf("parsing from the right keeps the name whole: %v", row)
                }
        })

        t.Run("empty folder lists zero entries, total zero", func(t *testing.T) {
                st := newFSStub(t, func(command, stdin string) fsRunResult {
                        return fsRunResult{stdout: "P|/storage/emulated/0\n", delivered: true}
                })
                s, _ := newV1202Server(t, st.srv.URL)
                _, out := v1202Req(t, s, "GET", "/api/termux/fs?path=shared", "")
                entries, _ := out["entries"].([]any)
                if len(entries) != 0 || out["total"].(float64) != 0 || out["truncated"] != false {
                        t.Fatalf("the empty folder is honest: %v", out)
                }
        })

        t.Run("no P line is an honest failure, not a crash", func(t *testing.T) {
                st := newFSStub(t, func(command, stdin string) fsRunResult {
                        return fsRunResult{stdout: "d|x|1|1\n", delivered: true}
                })
                s, _ := newV1202Server(t, st.srv.URL)
                code, out := v1202Req(t, s, "GET", "/api/termux/fs?path=shared", "")
                if code != 200 || out["ok"] != false {
                        t.Fatalf("a missing P line answers the honest 200: %d %v", code, out)
                }
        })
}

// ── 3. mkdir ──────────────────────────────────────────────────────────────

func TestV1202_TermuxFS_Mkdir(t *testing.T) {
        t.Run("the name form creates + resolves", func(t *testing.T) {
                st := newFSStub(t, func(command, stdin string) fsRunResult {
                        return fsRunResult{stdout: "P|/storage/emulated/0/Doomalay/newdir\n", delivered: true}
                })
                s, _ := newV1202Server(t, st.srv.URL)
                code, out := v1202Req(t, s, "POST", "/api/termux/fs",
                        `{"action":"mkdir","path":"/storage/emulated/0/Doomalay","name":"newdir"}`)
                if code != 200 || out["ok"] != true {
                        t.Fatalf("mkdir must succeed, got %d %v", code, out)
                }
                if out["path"] != "/storage/emulated/0/Doomalay/newdir" {
                        t.Fatalf("the resolved folder surfaces: %v", out)
                }
                cmd, _ := st.lastRun()
                if !strings.Contains(cmd, "mkdir -p") {
                        t.Fatalf("the script mkdir -p's the join: %q", cmd)
                }
                if !strings.Contains(cmd, `'/storage/emulated/0/Doomalay/newdir'`) {
                        t.Fatalf("the JOINED target rides the script as one quoted path: %q", cmd)
                }
        })

        t.Run("the joined-path form rides the same jail", func(t *testing.T) {
                st := newFSStub(t, func(command, stdin string) fsRunResult {
                        return fsRunResult{stdout: "P|/storage/emulated/0/A/B\n", delivered: true}
                })
                s, _ := newV1202Server(t, st.srv.URL)
                code, out := v1202Req(t, s, "POST", "/api/termux/fs",
                        `{"action":"mkdir","path":"/storage/emulated/0/A/B"}`)
                if code != 200 || out["ok"] != true || out["path"] != "/storage/emulated/0/A/B" {
                        t.Fatalf("the joined form must work: %d %v", code, out)
                }
        })

        t.Run("a name with / or .. is refused outright", func(t *testing.T) {
                st := newFSStub(t, func(command, stdin string) fsRunResult {
                        return fsRunResult{stdout: "P|/nope\n", delivered: true}
                })
                s, _ := newV1202Server(t, st.srv.URL)
                for _, name := range []string{"a/b", "..", "a..b", "."} {
                        code, out := v1202Req(t, s, "POST", "/api/termux/fs",
                                `{"action":"mkdir","path":"shared","name":"`+name+`"}`)
                        if code != 400 {
                                t.Fatalf("name %q must 400, got %d %v", name, code, out)
                        }
                }
                if st.runCount() != 0 {
                        t.Fatalf("a bad name never reaches the bridge")
                }
        })

        t.Run("unknown action 400s like the act handler's unknown what", func(t *testing.T) {
                st := newFSStub(t, func(command, stdin string) fsRunResult {
                        return fsRunResult{delivered: true}
                })
                s, _ := newV1202Server(t, st.srv.URL)
                code, out := v1202Req(t, s, "POST", "/api/termux/fs", `{"action":"rm","path":"shared"}`)
                if code != 400 {
                        t.Fatalf("unknown action must 400, got %d %v", code, out)
                }
        })

        t.Run("jail (exit 42) is a 400", func(t *testing.T) {
                st := newFSStub(t, func(command, stdin string) fsRunResult {
                        return fsRunResult{stderr: "path escapes the termux jail: /etc", exit: 42, delivered: true}
                })
                s, _ := newV1202Server(t, st.srv.URL)
                code, out := v1202Req(t, s, "POST", "/api/termux/fs",
                        `{"action":"mkdir","path":"shared","name":"x"}`)
                if code != 400 {
                        t.Fatalf("jail mkdir must 400, got %d %v", code, out)
                }
        })

        t.Run("a failed mkdir (exit 45) is the honest 200 error", func(t *testing.T) {
                st := newFSStub(t, func(command, stdin string) fsRunResult {
                        return fsRunResult{stderr: "cannot create folder: /storage/emulated/0/x", exit: 45, delivered: true}
                })
                s, _ := newV1202Server(t, st.srv.URL)
                code, out := v1202Req(t, s, "POST", "/api/termux/fs",
                        `{"action":"mkdir","path":"shared","name":"x"}`)
                if code != 200 || out["ok"] != false {
                        t.Fatalf("a Termux-side mkdir failure is a state, got %d %v", code, out)
                }
                if got, _ := out["error"].(string); !strings.Contains(got, "cannot create folder") {
                        t.Fatalf("the stderr text surfaces, got %q", got)
                }
        })
}

// ── 4. THE DEVICE-POST ROUND-TRIP ─────────────────────────────────────────

func TestV1202_DevicePost_TermuxRow(t *testing.T) {
        s, db := newV1202Server(t, "http://127.0.0.1:1/dead") // bridge never called for the POST itself
        sid := "v1202sess"
        if err := db.CreateSession(&store.Session{ID: sid, Title: "t", Model: "nvidia/x", Provider: "nvidia"}); err != nil {
                t.Fatalf("session: %v", err)
        }
        code, out := v1202Req(t, s, "POST", "/api/workspaces/device",
                `{"name":"My Notes","termux_path":"/storage/emulated/0/Doomalay/notes","session_id":"`+sid+`"}`)
        if code != 200 {
                t.Fatalf("the termux device POST must succeed, got %d: %v", code, out)
        }
        if out["kind"] != "termux" || out["host"] != "device" || out["owner"] != "this device" {
                t.Fatalf("the row saves the termux shape: %v", out)
        }
        if out["access"] != "full" {
                t.Fatalf("termux rows keep AccessFull: %v", out)
        }
        if out["termux"] != true {
                t.Fatalf("the response surfaces the termux bit (the device:true pattern): %v", out)
        }
        meta, _ := out["meta"].(map[string]any)
        if meta == nil || meta["termux"] != true ||
                meta["termux_path"] != "/storage/emulated/0/Doomalay/notes" ||
                meta["display_path"] != "/storage/emulated/0/Doomalay/notes" {
                t.Fatalf("meta carries termux + termux_path + display_path (decoded): %v", out)
        }
        wsID, _ := out["id"].(string)
        if wsID == "" {
                t.Fatalf("the row id must surface: %v", out)
        }
        // the row binds the chat + lists globally with the same shape
        bound, err := db.ListSessionWorkspaces(sid)
        if err != nil || len(bound) != 1 || bound[0].Kind != "termux" {
                t.Fatalf("the bind landed: %v %v", bound, err)
        }
        _, listOut := v1202Req(t, s, "GET", "/api/workspaces", "")
        wsRows, _ := listOut["workspaces"].([]any)
        if len(wsRows) != 1 {
                t.Fatalf("the row lists globally: %v", listOut)
        }
        row, _ := wsRows[0].(map[string]any)
        if row["kind"] != "termux" {
                t.Fatalf("the list row keeps the termux kind: %v", row)
        }

        t.Run("a bad termux_path shape is refused honestly", func(t *testing.T) {
                code, out := v1202Req(t, s, "POST", "/api/workspaces/device",
                        `{"name":"X","termux_path":"../../etc","session_id":"`+sid+`"}`)
                if code != 400 {
                        t.Fatalf("junk termux_path must 400, got %d %v", code, out)
                }
        })

        t.Run("the desktop flow stays byte-identical (no termux_path)", func(t *testing.T) {
                code, out := v1202Req(t, s, "POST", "/api/workspaces/device",
                        `{"name":"Plain","path":"Downloads/Plain","session_id":"`+sid+`"}`)
                if code != 200 {
                        t.Fatalf("the desktop device POST still works, got %d %v", code, out)
                }
                if out["kind"] != "device" || out["termux"] != nil {
                        t.Fatalf("the non-termux row stays the v0.46 shape: %v", out)
                }
                if out["device"] != true {
                        t.Fatalf("the device:true extra stays: %v", out)
                }
        })
}

// ── 5. THE WS FILE VERBS ──────────────────────────────────────────────────

// newTermuxWS POSTs a termux device row and returns its id.
func newTermuxWS(t *testing.T, s *Server, db *store.DB, root string) string {
        t.Helper()
        sid := "v1202ws" + strings.ReplaceAll(strings.TrimPrefix(root, "/"), "/", "")
        if err := db.CreateSession(&store.Session{ID: sid, Title: "t", Model: "nvidia/x", Provider: "nvidia"}); err != nil {
                t.Fatalf("session: %v", err)
        }
        code, out := v1202Req(t, s, "POST", "/api/workspaces/device",
                `{"name":"Notes","termux_path":"`+root+`","session_id":"`+sid+`"}`)
        if code != 200 {
                t.Fatalf("termux ws: %d %v", code, out)
        }
        id, _ := out["id"].(string)
        return id
}

func TestV1202_WSFile_Read(t *testing.T) {
        st := newFSStub(t, func(command, stdin string) fsRunResult {
                return fsRunResult{stdout: "P|/storage/emulated/0/notes/a.txt\nB|TEXT|11\nhello world", delivered: true}
        })
        s, db := newV1202Server(t, st.srv.URL)
        id := newTermuxWS(t, s, db, "/storage/emulated/0/notes")

        code, out := v1202Req(t, s, "GET", "/api/workspaces/"+id+"/file?path=a.txt", "")
        if code != 200 {
                t.Fatalf("the read must 200, got %d: %v", code, out)
        }
        if out["ok"] != true || out["content"] != "hello world" || out["binary"] != false ||
                out["size"].(float64) != 11 || out["path"] != "a.txt" {
                t.Fatalf("the read answer carries content/size/binary/path: %v", out)
        }
        if out["resolved"] != "/storage/emulated/0/notes/a.txt" {
                t.Fatalf("the resolved path surfaces: %v", out)
        }
        cmd, stdin := st.lastRun()
        if !strings.Contains(cmd, `'/storage/emulated/0/notes/a.txt'`) {
                t.Fatalf("the jailed join rides the script quoted: %q", cmd)
        }
        if stdin != "" {
                t.Fatalf("a read never sends stdin")
        }

        t.Run("the binary sniff is honest", func(t *testing.T) {
                st.fn = func(command, stdin string) fsRunResult {
                        return fsRunResult{stdout: "P|/storage/emulated/0/notes/a.bin\nB|BINARY|99\n", delivered: true}
                }
                _, out := v1202Req(t, s, "GET", "/api/workspaces/"+id+"/file?path=a.bin", "")
                if out["binary"] != true || out["size"].(float64) != 99 || out["content"] != "" {
                        t.Fatalf("binary rows carry no content, honestly: %v", out)
                }
        })

        t.Run("rel traversal refused engine-side", func(t *testing.T) {
                before := st.runCount()
                code, _ := v1202Req(t, s, "GET", "/api/workspaces/"+id+"/file?path=../escape.txt", "")
                if code != 400 {
                        t.Fatalf(".. in rel must 400 (the cloud verbs' rule), got %d", code)
                }
                if st.runCount() != before {
                        t.Fatalf("a traversal never reaches the bridge")
                }
        })

        t.Run("empty rel refused", func(t *testing.T) {
                code, _ := v1202Req(t, s, "GET", "/api/workspaces/"+id+"/file?path=", "")
                if code != 400 {
                        t.Fatalf("an empty rel must 400, got %d", code)
                }
        })

        t.Run("jail (exit 42) is a 400", func(t *testing.T) {
                st.fn = func(command, stdin string) fsRunResult {
                        return fsRunResult{stderr: "path escapes the termux jail: /etc", exit: 42, delivered: true}
                }
                code, _ := v1202Req(t, s, "GET", "/api/workspaces/"+id+"/file?path=a.txt", "")
                if code != 400 {
                        t.Fatalf("the read jail must 400, got %d", code)
                }
        })

        t.Run("a lying P echo is refused by the belt", func(t *testing.T) {
                st.fn = func(command, stdin string) fsRunResult {
                        return fsRunResult{stdout: "P|/etc/passwd\nB|TEXT|2\nx", delivered: true}
                }
                code, out := v1202Req(t, s, "GET", "/api/workspaces/"+id+"/file?path=a.txt", "")
                if code != 400 {
                        t.Fatalf("the laundered read must 400, got %d %v", code, out)
                }
        })

        t.Run("not-a-file exits honestly (exit 43)", func(t *testing.T) {
                st.fn = func(command, stdin string) fsRunResult {
                        return fsRunResult{stderr: "not a file: /storage/emulated/0/notes/a.txt", exit: 43, delivered: true}
                }
                code, out := v1202Req(t, s, "GET", "/api/workspaces/"+id+"/file?path=a.txt", "")
                if code != 200 || out["ok"] != false {
                        t.Fatalf("a missing file is an honest state, got %d %v", code, out)
                }
        })
}

func TestV1202_WSFile_Write_TheExtraStdinLaw(t *testing.T) {
        var gotCmd, gotStdin string
        st := newFSStub(t, func(command, stdin string) fsRunResult {
                gotCmd, gotStdin = command, stdin
                return fsRunResult{stdout: "P|/storage/emulated/0/notes/a.txt\n11\n", delivered: true}
        })
        s, db := newV1202Server(t, st.srv.URL)
        id := newTermuxWS(t, s, db, "/storage/emulated/0/notes")

        code, out := v1202Req(t, s, "PUT", "/api/workspaces/"+id+"/file",
                `{"path":"a.txt","content":"hello world"}`)
        if code != 200 || out["ok"] != true {
                t.Fatalf("the write must succeed, got %d %v", code, out)
        }
        if out["size"].(float64) != 11 || out["resolved"] != "/storage/emulated/0/notes/a.txt" {
                t.Fatalf("the write answer carries size + resolved: %v", out)
        }
        // THE EXTRA_STDIN LAW: bash -c 'cat > …' _ <quoted path>, content as
        // the body's stdin — zero shell-escaping surface.
        if !strings.HasPrefix(gotCmd, "bash -c '") {
                t.Fatalf("the write rides the inner bash -c law, got %q", gotCmd)
        }
        if !strings.Contains(gotCmd, `cat > "$rp"`) {
                t.Fatalf("the write cats into the resolved path, got %q", gotCmd)
        }
        if !strings.Contains(gotCmd, `' _ '/storage/emulated/0/notes/a.txt'`) {
                t.Fatalf("the path rides as $1 quoted, got %q", gotCmd)
        }
        if gotStdin != "hello world" {
                t.Fatalf("THE CONTENT RIDES STDIN, got %q", gotStdin)
        }

        t.Run("empty content is a legal (truncating) write", func(t *testing.T) {
                code, out := v1202Req(t, s, "PUT", "/api/workspaces/"+id+"/file",
                        `{"path":"a.txt","content":""}`)
                if code != 200 || out["ok"] != true {
                        t.Fatalf("the empty write must succeed, got %d %v", code, out)
                }
        })

        t.Run("content with shell metacharacters rides stdin raw", func(t *testing.T) {
                st.fn = func(command, stdin string) fsRunResult {
                        gotCmd, gotStdin = command, stdin
                        return fsRunResult{stdout: "P|/storage/emulated/0/notes/a.txt\n2\n", delivered: true}
                }
                code, _ := v1202Req(t, s, "PUT", "/api/workspaces/"+id+"/file",
                        `{"path":"a.txt","content":"$(rm -rf /); ` + "`whoami`" + `"}`)
                if code != 200 {
                        t.Fatalf("metacharacters must ride stdin untouched, got %d", code)
                }
                if !strings.Contains(gotStdin, "$(rm -rf /)") {
                        t.Fatalf("the payload arrived whole: %q", gotStdin)
                }
        })

        t.Run("rel traversal refused", func(t *testing.T) {
                code, _ := v1202Req(t, s, "PUT", "/api/workspaces/"+id+"/file",
                        `{"path":"../../etc/passwd","content":"x"}`)
                if code != 400 {
                        t.Fatalf("the write traversal must 400, got %d", code)
                }
        })

        t.Run("jail (exit 42) is a 400", func(t *testing.T) {
                st.fn = func(command, stdin string) fsRunResult {
                        return fsRunResult{stderr: "path escapes the termux jail: /etc", exit: 42, delivered: true}
                }
                code, _ := v1202Req(t, s, "PUT", "/api/workspaces/"+id+"/file",
                        `{"path":"a.txt","content":"x"}`)
                if code != 400 {
                        t.Fatalf("the write jail must 400, got %d", code)
                }
        })

        t.Run("a failed write (exit 45) is the honest 200 error", func(t *testing.T) {
                st.fn = func(command, stdin string) fsRunResult {
                        return fsRunResult{stderr: "cat failed", exit: 45, delivered: true}
                }
                code, out := v1202Req(t, s, "PUT", "/api/workspaces/"+id+"/file",
                        `{"path":"a.txt","content":"x"}`)
                if code != 200 || out["ok"] != false {
                        t.Fatalf("a Termux-side write failure is a state, got %d %v", code, out)
                }
        })
}

// The read→write ROUND-TRIP: what the read returned, the write can put
// back (the PWA editor's exact loop).
func TestV1202_WSFile_RoundTrip(t *testing.T) {
        st := newFSStub(t, func(command, stdin string) fsRunResult {
                return fsRunResult{stdout: "P|/storage/emulated/0/notes/a.md\nB|TEXT|13\n# hello\nworld", delivered: true}
        })
        s, db := newV1202Server(t, st.srv.URL)
        id := newTermuxWS(t, s, db, "/storage/emulated/0/notes")
        _, out := v1202Req(t, s, "GET", "/api/workspaces/"+id+"/file?path=a.md", "")
        content, _ := out["content"].(string)
        if content != "# hello\nworld" {
                t.Fatalf("the read content must ride whole, got %q", content)
        }
        st.fn = func(command, stdin string) fsRunResult {
                return fsRunResult{stdout: "P|/storage/emulated/0/notes/a.md\n20\n", delivered: true}
        }
        code, out2 := v1202Req(t, s, "PUT", "/api/workspaces/"+id+"/file",
                `{"path":"a.md","content":`+quoteJSON(content)+`}`)
        if code != 200 || out2["ok"] != true {
                t.Fatalf("the edited write must succeed: %d %v", code, out2)
        }
}

func quoteJSON(s string) string {
        raw, _ := json.Marshal(s)
        return string(raw)
}

// A non-termux row answers the honest 404-style refusal through the
// guarded entry (the guard the dispatcher makes dead code — pinned here).
func TestV1202_WSFile_NonTermuxRefused(t *testing.T) {
        s, db := newV1202Server(t, "")
        ws := &store.Workspace{ID: "0000000000aa", Name: "me/r", Kind: "github", Host: "github.com",
                Owner: "me", Repo: "r", Branch: "main", Access: "full"}
        if err := db.CreateWorkspace(ws); err != nil {
                t.Fatalf("ws: %v", err)
        }
        req := httptest.NewRequest("GET", "/api/workspaces/0000000000aa/file?path=x", nil)
        req.SetPathValue("id", "0000000000aa")
        rec := httptest.NewRecorder()
        s.handleTermuxWSFile(rec, req)
        if rec.Code != 404 {
                t.Fatalf("a non-termux row must refuse with 404, got %d: %s", rec.Code, rec.Body.String())
        }
        var out map[string]any
        _ = json.Unmarshal(rec.Body.Bytes(), &out)
        if got, _ := out["error"].(string); !strings.Contains(got, "not a termux workspace") {
                t.Fatalf("the refusal says what it is: %v", out)
        }
        // a termux row with no bridge answers the honest 200 instead
        _ = db.CreateWorkspace(&store.Workspace{ID: "0000000000bb", Name: "d", Kind: "termux",
                Host: "device", Owner: "this device", Access: "full",
                Meta: `{"termux":true,"termux_path":"/storage/emulated/0"}`})
        req2 := httptest.NewRequest("GET", "/api/workspaces/0000000000bb/file?path=x", nil)
        req2.SetPathValue("id", "0000000000bb")
        rec2 := httptest.NewRecorder()
        s.handleTermuxWSFile(rec2, req2)
        if rec2.Code != 200 {
                t.Fatalf("a termux row with no bridge answers the honest 200, got %d: %s", rec2.Code, rec2.Body.String())
        }
}

// ── 6. the scripts parse as bash (when bash exists on the host) ───────────

func TestV1202_TermuxFS_ScriptsParse(t *testing.T) {
        if _, err := exec.LookPath("bash"); err != nil {
                t.Skip("no bash on this host")
        }
        scripts := map[string]string{
                "list":  termuxListScript("shared"),
                "list-abs": termuxListScript("/storage/emulated/0/Doomalay"),
                "list-quoted": termuxListScript(`/storage/emulated/0/it's "quoted"`),
                "mkdir": termuxMkdirScript("shared/Doomalay/New Folder"),
                "read":  termuxReadScript("/storage/emulated/0/notes/a.txt"),
                "write": termuxWriteCommand("/storage/emulated/0/notes/a.txt"),
        }
        for name, script := range scripts {
                cmd := exec.Command("bash", "-n")
                cmd.Stdin = strings.NewReader(script)
                if err := cmd.Run(); err != nil {
                        t.Errorf("%s script must parse as bash (%v):\n%s", name, err, script)
                }
        }
}

// THE REAL-SCRIPT EXECUTION TEST: the shipped scripts run against a REAL
// local filesystem with the two safe roots remapped onto temp dirs (the
// jail logic, the alias map, readlink -f resolution, dotglob, dirs-first
// order, the 500 cap, mkdir, the read sniff and the stdin write law all
// execute — not just parse).
func TestV1202_TermuxFS_ScriptsExecute(t *testing.T) {
        if _, err := exec.LookPath("bash"); err != nil {
                t.Skip("no bash on this host")
        }
        dir := t.TempDir()
        home := filepath.Join(dir, "home")
        shared := filepath.Join(home, "storage", "shared")
        if err := os.MkdirAll(filepath.Join(shared, "Doomalay"), 0o755); err != nil {
                t.Fatal(err)
        }
        if err := os.WriteFile(filepath.Join(shared, "Doomalay", "a.txt"), []byte("hello"), 0o644); err != nil {
                t.Fatal(err)
        }
        if err := os.WriteFile(filepath.Join(shared, "z.txt"), []byte("x"), 0o644); err != nil {
                t.Fatal(err)
        }
        if err := os.WriteFile(filepath.Join(shared, ".dotfile"), []byte("d"), 0o644); err != nil {
                t.Fatal(err)
        }
        if err := os.WriteFile(filepath.Join(shared, "bin.dat"), []byte{0x00, 0x01, 'x'}, 0o644); err != nil {
                t.Fatal(err)
        }
        // a symlink laundering OUTSIDE the roots (points at the temp root)
        if err := os.Symlink(dir, filepath.Join(shared, "escape")); err != nil {
                t.Fatal(err)
        }
        // a symlink laundering through the HOME root (points inside home but
        // outside shared — legal under the safe roots, must list fine)
        if err := os.Symlink(home, filepath.Join(shared, "homelink")); err != nil {
                t.Fatal(err)
        }

        // remap the two safe roots onto the temp layout
        remap := strings.NewReplacer(
                "/storage/emulated/0", shared,
                "/data/data/com.termux/files/home", home,
        )
        run := func(script, stdin string) (string, string, int) {
                cmd := exec.Command("bash", "-c", remap.Replace(script))
                cmd.Env = append(os.Environ(), "HOME="+home, "LC_ALL=C")
                cmd.Dir = home // the bridge's default workdir (TERMUX_HOME)
                if stdin != "" {
                        cmd.Stdin = strings.NewReader(stdin)
                }
                var out, errb bytes.Buffer
                cmd.Stdout, cmd.Stderr = &out, &errb
                err := cmd.Run()
                exit := 0
                if ee, ok := err.(*exec.ExitError); ok {
                        exit = ee.ExitCode()
                } else if err != nil {
                        t.Fatalf("bash run: %v", err)
                }
                return out.String(), errb.String(), exit
        }

        t.Run("the shared alias lists: dirs first, dotted included, honest types", func(t *testing.T) {
                out, _, exit := run(termuxListScript("shared"), "")
                if exit != 0 {
                        t.Fatalf("the listing must succeed (exit %d): %s", exit, out)
                }
                resolved, entries, _, _, err := parseTermuxLines(out)
                if err != nil {
                        t.Fatalf("the real script's lines parse: %v\n%s", err, out)
                }
                if resolved != shared {
                        t.Fatalf("the alias resolved to the real shared root: %q", resolved)
                }
                var names []string
                var kinds []string
                for _, e := range entries {
                        names = append(names, e.Name)
                        if e.Dir {
                                kinds = append(kinds, "d")
                        } else {
                                kinds = append(kinds, "f")
                        }
                }
                // dirs first, then C-collation: .dotfile, bin.dat, escape, homelink, z.txt
                want := []string{"Doomalay", ".dotfile", "bin.dat", "escape", "homelink", "z.txt"}
                if strings.Join(names, ",") != strings.Join(want, ",") {
                        t.Fatalf("dirs first + dotted + sorted: got %v\n%s", names, out)
                }
                if kinds[0] != "d" {
                        t.Fatalf("the dir leads: %v", kinds)
                }
                // the symlinks type as 'l' (parseTermuxLines folds them into the
                // entry list as non-dirs — the PWA renders them as plain rows)
                for i, n := range names {
                        if (n == "escape" || n == "homelink") && kinds[i] != "f" {
                                t.Fatalf("symlink rows are non-dir rows: %v", kinds)
                        }
                }
                // sizes are real bytes
                for _, e := range entries {
                        if e.Name == "a.txt" && e.Size != 5 {
                                t.Fatalf("a.txt is 5 bytes: %v", e)
                        }
                }
        })

        t.Run("symlink laundering outside the roots is jailed (exit 42)", func(t *testing.T) {
                _, stderr, exit := run(termuxListScript("shared/escape"), "")
                if exit != 42 {
                        t.Fatalf("the laundering listing must exit 42, got %d: %s", exit, stderr)
                }
        })

        t.Run("dot-dot escape is jailed (exit 42)", func(t *testing.T) {
                _, stderr, exit := run(termuxListScript("/storage/emulated/0/../../../../etc"), "")
                if exit != 42 {
                        t.Fatalf("the .. collapse must exit 42, got %d: %s", exit, stderr)
                }
        })

        t.Run("not a folder is exit 43 (the honest script failure)", func(t *testing.T) {
                _, stderr, exit := run(termuxListScript("/storage/emulated/0/z.txt"), "")
                if exit != 43 {
                        t.Fatalf("a file listing must exit 43, got %d: %s", exit, stderr)
                }
        })

        t.Run("mkdir creates the joined folder + resolves it", func(t *testing.T) {
                out, _, exit := run(termuxMkdirScript("shared/Doomalay/New Folder"), "")
                if exit != 0 {
                        t.Fatalf("mkdir must succeed (exit %d): %s", exit, out)
                }
                resolved, err := parseTermuxPLine(out)
                if err != nil {
                        t.Fatalf("the P line parses: %v\n%s", err, out)
                }
                if resolved != filepath.Join(shared, "Doomalay", "New Folder") {
                        t.Fatalf("the resolved folder: %q", resolved)
                }
                if st, err := os.Stat(resolved); err != nil || !st.IsDir() {
                        t.Fatalf("the folder really exists: %v %v", st, err)
                }
        })

        t.Run("mkdir through a laundering symlink is jailed BEFORE creating", func(t *testing.T) {
                _, stderr, exit := run(termuxMkdirScript("shared/escape/evil"), "")
                if exit != 42 {
                        t.Fatalf("the jailed mkdir must exit 42, got %d: %s", exit, stderr)
                }
                if _, err := os.Stat(filepath.Join(dir, "evil")); !os.IsNotExist(err) {
                        t.Fatalf("nothing was created outside the roots")
                }
        })

        t.Run("the read script: text whole, binary sniffed, sizes real", func(t *testing.T) {
                out, _, exit := run(termuxReadScript("/storage/emulated/0/Doomalay/a.txt"), "")
                if exit != 0 {
                        t.Fatalf("the read must succeed (exit %d): %s", exit, out)
                }
                resolved, binary, size, content, err := parseTermuxFile(out)
                if err != nil {
                        t.Fatalf("the read lines parse: %v\n%s", err, out)
                }
                if resolved != filepath.Join(shared, "Doomalay", "a.txt") || binary || size != 5 || content != "hello" {
                        t.Fatalf("the whole text rides: %q binary=%v size=%d content=%q", resolved, binary, size, content)
                }
                out, _, exit = run(termuxReadScript("/storage/emulated/0/bin.dat"), "")
                if exit != 0 {
                        t.Fatalf("the binary read must succeed (exit %d)", exit)
                }
                _, binary, size, content, err = parseTermuxFile(out)
                if err != nil || !binary || size != 3 || content != "" {
                        t.Fatalf("the sniff is honest: binary=%v size=%d content=%q err=%v", binary, size, content, err)
                }
        })

        t.Run("THE EXTRA_STDIN WRITE LAW: content lands through stdin, jailed", func(t *testing.T) {
                out, _, exit := run(termuxWriteCommand("/storage/emulated/0/Doomalay/b.txt"), "written!")
                if exit != 0 {
                        t.Fatalf("the write must succeed (exit %d): %s", exit, out)
                }
                resolved, size, err := parseTermuxWriteResult(out)
                if err != nil {
                        t.Fatalf("the write lines parse: %v\n%s", err, out)
                }
                if resolved != filepath.Join(shared, "Doomalay", "b.txt") || size != 8 {
                        t.Fatalf("the write result: %q %d", resolved, size)
                }
                got, err := os.ReadFile(resolved)
                if err != nil || string(got) != "written!" {
                        t.Fatalf("the content landed verbatim: %q %v", got, err)
                }
        })

        t.Run("the write through a laundering symlink is jailed", func(t *testing.T) {
                out, _, exit := run(termuxWriteCommand("/storage/emulated/0/escape"), "evil")
                if exit != 42 {
                        t.Fatalf("the laundering write must exit 42, got %d: %s", exit, out)
                }
        })

        t.Run("the empty write truncates to zero bytes", func(t *testing.T) {
                out, _, exit := run(termuxWriteCommand("/storage/emulated/0/z.txt"), "")
                if exit != 0 {
                        t.Fatalf("the empty write must succeed (exit %d): %s", exit, out)
                }
                got, err := os.ReadFile(filepath.Join(shared, "z.txt"))
                if err != nil || len(got) != 0 {
                        t.Fatalf("the empty write truncated the file: %q %v", got, err)
                }
        })
}

// ── the pure helpers (the shapes the PWA + the rig depend on) ─────────────

func TestV1202_PureHelpers(t *testing.T) {
        // the jail shapes
        for _, ok := range []string{"shared", "downloads", "documents", "home",
                "shared/Doomalay", "/storage/emulated/0", "/storage/emulated/0/x",
                "/data/data/com.termux/files/home", "/data/data/com.termux/files/home/x"} {
                if !termuxPathShapeOK(ok) {
                        t.Errorf("shape %q must pass", ok)
                }
        }
        for _, bad := range []string{"", "foo", "/etc/passwd", "../..", "shared\x00"} {
                if termuxPathShapeOK(bad) {
                        t.Errorf("shape %q must fail", bad)
                }
        }
        for _, ok := range []string{"/storage/emulated/0", "/storage/emulated/0/x",
                "/data/data/com.termux/files/home", "/data/data/com.termux/files/home/x"} {
                if !termuxResolvedOK(ok) {
                        t.Errorf("resolved %q must pass", ok)
                }
        }
        for _, bad := range []string{"/etc/passwd", "/storage", "/data/data/com.termux", ""} {
                if termuxResolvedOK(bad) {
                        t.Errorf("resolved %q must fail", bad)
                }
        }
        // the join + rel guards
        if got := termuxJoin("/storage/emulated/0", "a/b"); got != "/storage/emulated/0/a/b" {
                t.Errorf("join: %q", got)
        }
        if got := termuxJoin("/storage/emulated/0/", ""); got != "/storage/emulated/0/" {
                t.Errorf("join of the root: %q", got)
        }
        if !termuxRelOK("") || !termuxRelOK("a/b.txt") {
                t.Errorf("plain rels must pass")
        }
        if termuxRelOK("../x") || termuxRelOK("a\x00b") {
                t.Errorf("traversal + control chars must fail")
        }
        // the quote idiom
        if got := termuxQuote("it's"); got != `'it'\''s'` {
                t.Errorf("the quote idiom: %q", got)
        }
        // parseTermuxLines' total without TRUNCATED = the entry count
        _, entries, total, truncated, err := parseTermuxLines("P|/storage/emulated/0\nf|a|1|2\nf|b|3|4\n")
        if err != nil || len(entries) != 2 || total != 2 || truncated {
                t.Fatalf("the honest total: %v %d %v", entries, total, err)
        }
}
