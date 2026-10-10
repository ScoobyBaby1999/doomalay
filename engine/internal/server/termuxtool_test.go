package server

// termuxtool_test.go — v1.20.3 THE ARM: the bot-facing Termux hand,
// tested end to end against a fake bridge that EXECUTES the real
// scripts through the local bash (the same scripts Termux runs — the
// jail, the verb bodies, the session lifecycle all run for real, with
// HOME overridden to a temp dir so $HOME/.doomalay/sessions lands
// there, never in the real home).
//
// Matrix: the arming ladder, the verb matrix, the BLOCKLIST, the
// cooldown + rate cap, the truncation honesty, the JAIL matrix (..
// escape, root-eating rm, symlink laundering through the fake's REAL
// readlink -f), the write/append round-trip, grep's unlimited hits,
// pkg sanitization, and the full SESSION LIFECYCLE (start → live →
// log → kill → dead).

import (
        "bytes"
        "context"
        "encoding/json"
        "fmt"
        "net/http"
        "net/http/httptest"
        "os"
        "os/exec"
        "path/filepath"
        "strconv"
        "strings"
        "sync"
        "testing"
        "time"

        "github.com/ScoobyBaby1999/doomalay/engine/internal/store"
        "github.com/ScoobyBaby1999/doomalay/engine/internal/termuxbridge"
)

// fakeArmBridge serves the bridge's /run contract by executing the
// command through the local bash — every jailed script, the session
// lifecycle, the pkg stub (a PATH shim) — with HOME pointed at a temp
// dir. A canned response can be injected (truncation/timeout physics).
type fakeArmBridge struct {
        srv     *httptest.Server
        home    string
        stubBin string

        mu          sync.Mutex
        runs        int
        lastBody    map[string]any
        lastTimeout float64
        canned      map[string]any
}

// newFakeArmBridge builds the executing fake (the /status + /probe +
// /act routes ride along so newTermuxTestServer is happy).
func newFakeArmBridge(t *testing.T) *fakeArmBridge {
        t.Helper()
        home := t.TempDir()
        stubBin := t.TempDir()
        // the pkg shim: Termux's package manager, stubbed to echo honestly.
        if err := os.WriteFile(filepath.Join(stubBin, "pkg"), []byte("#!/bin/sh\necho \"stub pkg $*\"\necho \"stub pkg done\"\n"), 0o755); err != nil {
                t.Fatalf("pkg stub: %v", err)
        }
        fb := &fakeArmBridge{home: home, stubBin: stubBin}
        mux := http.NewServeMux()
        mux.HandleFunc("POST /run", func(w http.ResponseWriter, r *http.Request) {
                var body map[string]any
                if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
                        writeStubBridgeJSON(w, map[string]any{"ok": false, "errmsg": "bad body"})
                        return
                }
                fb.mu.Lock()
                fb.runs++
                fb.lastBody = body
                if v, ok := body["timeout_ms"].(float64); ok {
                        fb.lastTimeout = v
                }
                canned := fb.canned
                fb.mu.Unlock()
                if canned != nil {
                        writeStubBridgeJSON(w, canned)
                        return
                }
                command, _ := body["command"].(string)
                workdir, _ := body["workdir"].(string)
                timeoutMS := 60000
                if v, ok := body["timeout_ms"].(float64); ok && v > 0 {
                        timeoutMS = int(v)
                }
                writeStubBridgeJSON(w, fb.exec(command, workdir, timeoutMS))
        })
        // the three other bridge routes (v1.17.2 contract — status ladder).
        mux.HandleFunc("GET /status", func(w http.ResponseWriter, r *http.Request) {
                writeStubBridgeJSON(w, map[string]any{"installed": true, "version_code": 1022, "version_name": "0.119.0-beta.3", "permission": true})
        })
        mux.HandleFunc("POST /probe", func(w http.ResponseWriter, r *http.Request) {
                writeStubBridgeJSON(w, map[string]any{"ok": true, "storage_ok": true, "props_ok": true,
                        "stdout": "__doomalay_probe__\nstorage_ok\nprops_ok\n", "stderr": "", "exit_code": 0, "err": 0, "errmsg": nil, "timeout": false})
        })
        mux.HandleFunc("POST /act", func(w http.ResponseWriter, r *http.Request) {
                writeStubBridgeJSON(w, map[string]any{"ok": true})
        })
        fb.srv = httptest.NewServer(mux)
        t.Cleanup(fb.srv.Close)
        return fb
}

// exec runs one bridge command through the local bash with HOME + PATH
// overridden (the pkg shim dir first) — the honest /run twin.
func (fb *fakeArmBridge) exec(command, workdir string, timeoutMS int) map[string]any {
        ctx, cancel := context.WithTimeout(context.Background(), time.Duration(timeoutMS)*time.Millisecond)
        defer cancel()
        cmd := exec.CommandContext(ctx, "bash", "-c", command)
        if workdir != "" {
                cmd.Dir = workdir
        }
        cmd.Env = []string{
                "HOME=" + fb.home,
                "PATH=" + fb.stubBin + ":" + os.Getenv("PATH"),
        }
        var out, errOut bytes.Buffer
        cmd.Stdout = &out
        cmd.Stderr = &errOut
        runErr := cmd.Run()
        if ctx.Err() == context.DeadlineExceeded {
                // the bridge's own timeout killed it (the Kotlin twin's timeout
                // semantics: partial output + timeout flag).
                return map[string]any{"ok": true, "stdout": out.String(), "stderr": errOut.String(),
                        "exit_code": 124, "err": 0, "errmsg": nil, "timeout": true}
        }
        code := 0
        if runErr != nil {
                if ee, ok := runErr.(interface{ ExitCode() int }); ok {
                        code = ee.ExitCode()
                } else {
                        code = 1
                }
        }
        return map[string]any{"ok": true, "stdout": out.String(), "stderr": errOut.String(),
                "exit_code": code, "err": 0, "errmsg": nil, "timeout": false}
}

func (fb *fakeArmBridge) runCount() int {
        fb.mu.Lock()
        defer fb.mu.Unlock()
        return fb.runs
}

func (fb *fakeArmBridge) setCanned(c map[string]any) {
        fb.mu.Lock()
        fb.canned = c
        fb.mu.Unlock()
}

// armTermuxChat binds a session with the ⌨ Termux capability + ONE
// termux workspace whose termux_path is the (real, local) root dir —
// the fake bridge's bash resolves and touches it for real.
func armTermuxChat(t *testing.T, s *Server, sessionID, root string) {
        t.Helper()
        if err := s.db.CreateSession(&store.Session{ID: sessionID, Title: "t", Model: "m", Provider: "p", Termux: true}); err != nil {
                t.Fatalf("session: %v", err)
        }
        ws := &store.Workspace{Kind: "termux", Name: "device", Access: "full",
                Meta: `{"termux_path":"` + root + `"}`}
        if err := s.db.CreateWorkspace(ws); err != nil {
                t.Fatalf("workspace: %v", err)
        }
        if err := s.db.BindWorkspace(sessionID, ws.ID); err != nil {
                t.Fatalf("bind: %v", err)
        }
        if err := os.MkdirAll(root, 0o755); err != nil {
                t.Fatalf("root: %v", err)
        }
}

// newArmServer builds a server wired to the executing fake bridge.
func newArmServer(t *testing.T, fb *fakeArmBridge) *Server {
        t.Helper()
        return newTermuxTestServer(t, fb.srv.URL)
}

// tool runs one termux action for a session (the runner under test).
func tool(s *Server, sessionID, action, argsJSON string) string {
        return s.runTermuxAction(context.Background(), sessionID, `{"action":"`+action+`","args":`+argsJSON+`}`)
}

// shrinkPacing shrinks the exec pacing for fast tests (restored on
// cleanup): window w. (v1.23.1: the cooldown is GONE — only the rolling
// window remains.)
func shrinkPacing(t *testing.T, w time.Duration) {
        t.Helper()
        oldW := termuxExecWindow
        termuxExecWindow = w
        t.Cleanup(func() { termuxExecWindow = oldW })
}

// ── the arming matrix ────────────────────────────────────────────────────

func TestV1203_ArmingMatrix(t *testing.T) {
        fb := newFakeArmBridge(t)
        s := newArmServer(t, fb)

        // no ⌨ capability stacked → the honest teach, bridge never touched
        s.db.CreateSession(&store.Session{ID: "nocap", Title: "t", Model: "m", Provider: "p"})
        out := tool(s, "nocap", "exec", `{"command":"echo hi"}`)
        if !strings.Contains(out, "the ⌨ Termux capability is not stacked") {
                t.Fatalf("no-capability teach, got:\n%s", out)
        }
        if fb.runCount() != 0 {
                t.Fatalf("an unarmed chat must never touch the bridge (runs=%d)", fb.runCount())
        }

        // capability stacked, no bound folder → the armed-but-no-folder teach
        s.db.CreateSession(&store.Session{ID: "nows", Title: "t", Model: "m", Provider: "p", Termux: true})
        out = tool(s, "nows", "exec", `{"command":"echo hi"}`)
        if !strings.Contains(out, "no device folder is connected") {
                t.Fatalf("no-folder teach, got:\n%s", out)
        }
        if fb.runCount() != 0 {
                t.Fatalf("an unbound chat must never touch the bridge (runs=%d)", fb.runCount())
        }

        // both → ARMED (help needs no bridge; exec runs)
        root := t.TempDir()
        armTermuxChat(t, s, "armed", root)
        out = tool(s, "armed", "help", `{}`)
        if !strings.Contains(out, "termux tool — a real Termux Linux shell") {
                t.Fatalf("help text, got:\n%s", out)
        }
        for _, verb := range []string{"exec", "ls", "read", "write", "append", "rm", "mkdir", "grep", "find", "pkg", "session_start", "session_list", "session_log", "session_kill"} {
                if !strings.Contains(out, verb) {
                        t.Fatalf("help must teach the %s verb:\n%s", verb, out)
                }
        }
        if !strings.Contains(out, root) {
                t.Fatalf("help must list the REAL bound root:\n%s", out)
        }

        // malformed args → honest error, never a panic
        out = s.runTermuxAction(context.Background(), "armed", "not-json")
        if !strings.Contains(out, "arguments must be a JSON object") {
                t.Fatalf("malformed args teach, got:\n%s", out)
        }
        // args that is a bad JSON string → the honest parse error
        out = s.runTermuxAction(context.Background(), "armed", `{"action":"exec","args":"not-json"}`)
        if !strings.Contains(out, "args must be a JSON object") {
                t.Fatalf("bad nested args teach, got:\n%s", out)
        }
        // unknown action → the help teach with the unknown-action line
        out = tool(s, "armed", "explode", `{}`)
        if !strings.Contains(out, `unknown termux action "explode"`) {
                t.Fatalf("unknown action teach, got:\n%s", out)
        }
}

// No bridge on this engine (every desktop build) → the honest
// observation, never a panic, never silence.
func TestV1203_NilBridge_HonestObservation(t *testing.T) {
        s := newTermuxTestServer(t, "")
        root := t.TempDir()
        armTermuxChat(t, s, "nobridge", root)
        out := tool(s, "nobridge", "exec", `{"command":"echo hi"}`)
        if !strings.Contains(out, "no Termux bridge") {
                t.Fatalf("nil-bridge observation, got:\n%s", out)
        }
        out = tool(s, "nobridge", "read", `{"path":"x.txt"}`)
        if !strings.Contains(out, "no Termux bridge") {
                t.Fatalf("nil-bridge observation (read), got:\n%s", out)
        }
        out = tool(s, "nobridge", "session_list", `{}`)
        if !strings.Contains(out, "no Termux bridge") {
                t.Fatalf("nil-bridge observation (sessions), got:\n%s", out)
        }
}

// A dead bridge (connection refused) → the honest typed-error report.
func TestV1203_DeadBridge_HonestError(t *testing.T) {
        dead := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
        deadURL := dead.URL
        dead.Close()
        s := newTermuxTestServer(t, deadURL)
        root := t.TempDir()
        armTermuxChat(t, s, "deadbr", root)
        out := tool(s, "deadbr", "exec", `{"command":"echo hi"}`)
        if !strings.Contains(out, "the Termux bridge did not answer") {
                t.Fatalf("dead-bridge observation, got:\n%s", out)
        }
}

// ── exec ─────────────────────────────────────────────────────────────────

func TestV1203_Exec_Echo(t *testing.T) {
        fb := newFakeArmBridge(t)
        s := newArmServer(t, fb)
        root := t.TempDir()
        armTermuxChat(t, s, "exec1", root)
        shrinkPacing(t, time.Minute)

        out := tool(s, "exec1", "exec", `{"command":"echo hello-arm"}`)
        if !strings.Contains(out, "EXEC DONE — workdir "+root) {
                t.Fatalf("exec head + workdir (the FIRST bound root), got:\n%s", out)
        }
        if !strings.Contains(out, "hello-arm") {
                t.Fatalf("stdout must ride whole, got:\n%s", out)
        }
        if !strings.Contains(out, "exit_code: 0") {
                t.Fatalf("exit code line, got:\n%s", out)
        }
        if !strings.Contains(out, "stdout:") || !strings.Contains(out, "stderr:") {
                t.Fatalf("both streams must be reported, got:\n%s", out)
        }
        if fb.runCount() != 1 {
                t.Fatalf("exec is ONE bridge call, got %d", fb.runCount())
        }

        // a failing command reports its exit code + stderr honestly
        out = tool(s, "exec1", "exec", `{"command":"echo oops >&2; exit 3"}`)
        if !strings.Contains(out, "exit_code: 3") || !strings.Contains(out, "oops") {
                t.Fatalf("honest failure report, got:\n%s", out)
        }

        // the timeout_ms the bridge received: default 60000
        fb.mu.Lock()
        lastTimeout := fb.lastTimeout
        fb.mu.Unlock()
        if lastTimeout != 60000 {
                t.Fatalf("default timeout must be 60s, got %v", lastTimeout)
        }
}

// The timeout cap: a huge timeout_ms is clamped to the bridge's own
// 180s ceiling.
func TestV1203_Exec_TimeoutClamp(t *testing.T) {
        fb := newFakeArmBridge(t)
        s := newArmServer(t, fb)
        root := t.TempDir()
        armTermuxChat(t, s, "clamp", root)
        tool(s, "clamp", "exec", `{"command":"true","timeout_ms":999999}`)
        fb.mu.Lock()
        lastTimeout := fb.lastTimeout
        fb.mu.Unlock()
        if lastTimeout != 180000 {
                t.Fatalf("timeout_ms must clamp at 180000, got %v", lastTimeout)
        }
}

// The bridge's own timeout → the honest TIMEOUT observation.
func TestV1203_Exec_Timeout_Honest(t *testing.T) {
        fb := newFakeArmBridge(t)
        s := newArmServer(t, fb)
        root := t.TempDir()
        armTermuxChat(t, s, "slow", root)
        out := tool(s, "slow", "exec", `{"command":"echo partial; sleep 5","timeout_ms":1000}`)
        if !strings.Contains(out, "TIMEOUT — Termux killed the command at its 1s budget") {
                t.Fatalf("timeout observation, got:\n%s", out)
        }
        if !strings.Contains(out, "partial") {
                t.Fatalf("the partial stdout must ride whole, got:\n%s", out)
        }
}

// ── the blocklist ────────────────────────────────────────────────────────

func TestV1203_Exec_Blocklist(t *testing.T) {
        fb := newFakeArmBridge(t)
        s := newArmServer(t, fb)
        root := t.TempDir()
        armTermuxChat(t, s, "blk", root)

        // every blocklist class, pinned one by one (the compiled law).
        blocked := []struct{ cmd, why string }{
                {"rm -rf /", "recursive delete of / or the home directory"},
                {"rm -rf ~", "recursive delete of / or the home directory"},
                {"rm -fr $HOME", "recursive delete of / or the home directory"},
                {"sudo rm -rf /", "recursive delete of / or the home directory"},
                {"rm -r -f /", "recursive delete of / or the home directory"},
                {"rm --recursive --force /", "recursive delete of / or the home directory"},
                {"rm -rf ~/*", "recursive delete of / or the home directory"},
                {"cd x && rm -rf /", "recursive delete of / or the home directory"},
                {"dd if=/dev/zero of=/dev/sda", "dd writing into a raw block device"},
                {"dd of=/dev/mmcblk0", "dd writing into a raw block device"},
                {"mkfs.ext4 /dev/sda1", "making a filesystem on a device"},
                {"mkfs -t ext4 /dev/sda1", "making a filesystem on a device"},
                {"mke2fs /dev/sda1", "making a filesystem on a device"},
                {"reboot", "system power command"},
                {"shutdown -h now", "system power command"},
                {"sudo poweroff", "system power command"},
                {"sync && halt", "system power command"},
                {":(){:|:&};:", "fork bomb"},
                {":() { :|:& };:", "fork bomb"},
                {"cat x > /dev/sda", "redirecting output into a raw device node"},
                {"echo y > /dev/mmcblk0", "redirecting output into a raw device node"},
                {"chmod -R 777 /", "chmod -R 777 against / or the home directory"},
                {"chmod -R 777 ~", "chmod -R 777 against / or the home directory"},
        }
        for _, b := range blocked {
                out := tool(s, "blk", "exec", fmt.Sprintf(`{"command":%q}`, b.cmd))
                if !strings.Contains(out, "REFUSED") || !strings.Contains(out, b.why) {
                        t.Fatalf("blocklist %q must refuse as %q, got:\n%s", b.cmd, b.why, out)
                }
        }
        // NEVER executed: the whole class ran with the bridge untouched.
        if fb.runCount() != 0 {
                t.Fatalf("blocked commands must never reach the bridge (runs=%d)", fb.runCount())
        }

        // the surgical edge: the neighbors stay legal.
        legal := []string{
                "rm -rf " + root + "/build", // a path INSIDE the jail
                "echo the system will reboot soon",
                "cat x > /dev/null",
                "dd if=big.img of=copy.img",
                "rm -rf ./subdir",
        }
        for _, cmd := range legal {
                if why := termuxBlocklistHit(cmd); why != "" {
                        t.Fatalf("clean command %q must not match the blocklist (matched %q)", cmd, why)
                }
        }
        // unit-level: every regex pinned through termuxBlocklistHit.
        for _, c := range []string{"rm -rf //", "rm -rf $HOME/", "kill -9 1 2 && reboot"} {
                if termuxBlocklistHit(c) == "" {
                        t.Fatalf("blocklist must catch %q", c)
                }
        }
}

// ── the pacing gates ─────────────────────────────────────────────────────

func TestV1231_Exec_NoCooldown_CapHolds(t *testing.T) {
	fb := newFakeArmBridge(t)
	s := newArmServer(t, fb)
	root := t.TempDir()
	armTermuxChat(t, s, "pace", root)
	armTermuxChat(t, s, "pace2", root) // a different session — isolation proof
	shrinkPacing(t, time.Hour)
	// v1.23.1 THE PACING: two execs back-to-back on the SAME session, zero
	// wait — BOTH run (the ≥4s cooldown is gone; the user's ask)
	for _, cmd := range []string{"echo one", "echo two"} {
		out := tool(s, "pace", "exec", fmt.Sprintf(`{"command":"%s"}`, cmd))
		if !strings.Contains(out, "EXEC DONE") {
			t.Fatalf("no-cooldown law — a rapid exec must run, got:\n%s", out)
		}
	}
	// a different session is not capped by the first's window
	out := tool(s, "pace2", "exec", `{"command":"echo three"}`)
	if !strings.Contains(out, "EXEC DONE") {
		t.Fatalf("per-SESSION window — a different session must run, got:\n%s", out)
	}
	if fb.runCount() != 3 {
		t.Fatalf("all three execs reached the bridge (runs=%d)", fb.runCount())
	}
}

// The rate cap: 12 execs in the rolling window, the 13th refuses.
func TestV1203_Exec_RateCap(t *testing.T) {
        fb := newFakeArmBridge(t)
        s := newArmServer(t, fb)
        root := t.TempDir()
        armTermuxChat(t, s, "capwin", root)
        shrinkPacing(t, time.Minute)

        for i := 0; i < termuxExecCap; i++ {
                if out := tool(s, "capwin", "exec", fmt.Sprintf(`{"command":"echo n%d"}`, i)); !strings.Contains(out, "EXEC DONE") {
                        t.Fatalf("exec %d within the window must run, got:\n%s", i, out)
                }
        }
        out := tool(s, "capwin", "exec", `{"command":"echo over"}`)
        if !strings.Contains(out, "exec rate cap") || !strings.Contains(out, "12 one-shot execs") {
                t.Fatalf("rate cap verdict, got:\n%s", out)
        }
        // the capped call consumed nothing (exactly 12 runs reached the bridge)
        if fb.runCount() != termuxExecCap {
                t.Fatalf("a capped exec must not touch the bridge (runs=%d)", fb.runCount())
        }
}

// ── the truncation honesty ───────────────────────────────────────────────

func TestV1203_TruncationHonesty(t *testing.T) {
        fb := newFakeArmBridge(t)
        s := newArmServer(t, fb)
        root := t.TempDir()
        armTermuxChat(t, s, "trunc", root)
        // the window is wide (the canned responses are instant — the
        // deterministic way to test the truncation physics alone).
        shrinkPacing(t, time.Minute)

        // stdout alone at the full 100KB budget → the cap fired.
        fb.setCanned(map[string]any{"ok": true, "stdout": strings.Repeat("x", termuxCapBytes), "stderr": "", "exit_code": 0, "timeout": false})
        out := tool(s, "trunc", "exec", `{"command":"big"}`)
        if !strings.Contains(out, termuxTruncatedMarker) {
                t.Fatalf("100KB stdout must carry the honest truncation marker")
        }

        // both streams at the halved budget → the cap fired.
        fb.setCanned(map[string]any{"ok": true, "stdout": strings.Repeat("x", termuxCapBytes/2), "stderr": "e", "exit_code": 0, "timeout": false})
        out = tool(s, "trunc", "exec", `{"command":"big"}`)
        if !strings.Contains(out, termuxTruncatedMarker) {
                t.Fatalf("50KB stdout + stderr must carry the honest truncation marker (the halved bundle)")
        }

        // normal sizes → no marker, whole output.
        fb.setCanned(map[string]any{"ok": true, "stdout": "plain output\n", "stderr": "", "exit_code": 0, "timeout": false})
        out = tool(s, "trunc", "exec", `{"command":"small"}`)
        if strings.Contains(out, termuxTruncatedMarker) {
                t.Fatalf("small output must NOT carry the marker")
        }
        if !strings.Contains(out, "plain output") {
                t.Fatalf("whole output must ride, got:\n%s", out)
        }
        // 60KB stdout alone (no stderr) → under the 100KB budget, no marker.
        fb.setCanned(map[string]any{"ok": true, "stdout": strings.Repeat("x", 60*1024), "stderr": "", "exit_code": 0, "timeout": false})
        out = tool(s, "trunc", "exec", `{"command":"mid"}`)
        if strings.Contains(out, termuxTruncatedMarker) {
                t.Fatalf("60KB stdout alone is under Termux's 100KB physics — no marker")
        }
}

// ── the jail matrix ──────────────────────────────────────────────────────

func TestV1203_JailMatrix(t *testing.T) {
        fb := newFakeArmBridge(t)
        s := newArmServer(t, fb)
        root := t.TempDir()
        armTermuxChat(t, s, "jail", root)

        // ../ escape → pre-flight refusal, the bridge is never touched.
        out := tool(s, "jail", "read", `{"path":"../outside.txt"}`)
        if !strings.Contains(out, "JAIL REFUSED") {
                t.Fatalf(".. escape must be refused, got:\n%s", out)
        }
        if !strings.Contains(out, "Nothing was executed") {
                t.Fatalf("the refusal must say nothing ran:\n%s", out)
        }

        // an absolute path outside the roots → refused pre-flight.
        out = tool(s, "jail", "read", `{"path":"/etc/passwd"}`)
        if !strings.Contains(out, "JAIL REFUSED") {
                t.Fatalf("outside absolute path must be refused, got:\n%s", out)
        }
        if fb.runCount() != 0 {
                t.Fatalf("pre-flight refusals never touch the bridge (runs=%d)", fb.runCount())
        }

        // the jail root itself is safe to read (ls) but NEVER removable.
        out = tool(s, "jail", "rm", `{"path":""}`)
        if !strings.Contains(out, "refusing to remove a bound workspace root") {
                t.Fatalf("rm on the root itself must refuse, got:\n%s", out)
        }
        if fb.runCount() != 0 {
                t.Fatalf("the root-eating rm never touches the bridge (runs=%d)", fb.runCount())
        }

        // symlink laundering: a link INSIDE the jail pointing outside — the
        // script's readlink -f resolves it, exits 42 before touching anything.
        outside := filepath.Join(fb.home, "secret.txt")
        if err := os.WriteFile(outside, []byte("secrets"), 0o644); err != nil {
                t.Fatalf("secret: %v", err)
        }
        if err := os.Symlink(outside, filepath.Join(root, "launder")); err != nil {
                t.Fatalf("symlink: %v", err)
        }
        out = tool(s, "jail", "read", `{"path":"launder"}`)
        if !strings.Contains(out, "JAIL REFUSED") || !strings.Contains(out, outside) {
                t.Fatalf("symlink laundering must be refused with the resolved path, got:\n%s", out)
        }
        if fb.runCount() != 1 {
                t.Fatalf("the laundering read DID reach the bridge (the script's exit 42 caught it), runs=%d", fb.runCount())
        }
        // and the file was never read
        if strings.Contains(out, "secrets") {
                t.Fatalf("the laundered file's content must never appear, got:\n%s", out)
        }

        // a directory symlink for ls: same laundering death.
        if err := os.Symlink(fb.home, filepath.Join(root, "dirlink")); err != nil {
                t.Fatalf("dirlink: %v", err)
        }
        out = tool(s, "jail", "ls", `{"path":"dirlink"}`)
        if !strings.Contains(out, "JAIL REFUSED") {
                t.Fatalf("dir symlink laundering must be refused, got:\n%s", out)
        }
}

// ── the file verbs ───────────────────────────────────────────────────────

func TestV1203_WriteReadAppend_RoundTrip(t *testing.T) {
        fb := newFakeArmBridge(t)
        s := newArmServer(t, fb)
        root := t.TempDir()
        armTermuxChat(t, s, "files", root)

        // write (nested args as a live JSON object — the tolerated shape)
        out := s.runTermuxAction(context.Background(), "files", `{"action":"write","args":{"path":"notes.txt","content":"hello arm"}}`)
        if !strings.Contains(out, "WROTE — ") || !strings.Contains(out, filepath.Join(root, "notes.txt")) || !strings.Contains(out, "(9 bytes)") {
                t.Fatalf("write verdict, got:\n%s", out)
        }
        // read it back whole
        out = tool(s, "files", "read", `{"path":"notes.txt"}`)
        if !strings.Contains(out, "READ — ") || !strings.Contains(out, "hello arm") || !strings.Contains(out, "(9 bytes)") {
                t.Fatalf("read verdict, got:\n%s", out)
        }
        // append (flat top-level keys — the tolerated workspace shape)
        out = s.runTermuxAction(context.Background(), "files", `{"action":"append","path":"notes.txt","content":"!"}`)
        if !strings.Contains(out, "APPENDED — ") || !strings.Contains(out, "(file now 10 bytes)") {
                t.Fatalf("append verdict, got:\n%s", out)
        }
        out = tool(s, "files", "read", `{"path":"notes.txt"}`)
        if !strings.Contains(out, "hello arm!") {
                t.Fatalf("the append must have landed, got:\n%s", out)
        }

        // a binary file → the honest binary line, never garbage.
        if err := os.WriteFile(filepath.Join(root, "blob.bin"), []byte{0x00, 0x01, 0x02, 'A'}, 0o644); err != nil {
                t.Fatalf("blob: %v", err)
        }
        out = tool(s, "files", "read", `{"path":"blob.bin"}`)
        if !strings.Contains(out, "binary file, 4 bytes — no text to read") {
                t.Fatalf("binary honesty, got:\n%s", out)
        }

        // writing onto an existing DIRECTORY → refused honestly.
        if err := os.MkdirAll(filepath.Join(root, "d"), 0o755); err != nil {
                t.Fatalf("d: %v", err)
        }
        out = tool(s, "files", "write", `{"path":"d","content":"x"}`)
        if !strings.Contains(out, "refusing to write") || !strings.Contains(out, "existing directory") {
                t.Fatalf("dir write refusal, got:\n%s", out)
        }

        // the 1MB intent cap.
        out = tool(s, "files", "write", fmt.Sprintf(`{"path":"big.txt","content":%q}`, strings.Repeat("a", termuxWriteCap+1)))
        if !strings.Contains(out, "1MB intent cap") {
                t.Fatalf("write cap refusal, got:\n%s", out)
        }

        // quoting safety: a path with spaces + a content with shell-active
        // characters round-trips byte-for-byte (zero interpolation).
        weird := "it's a $(rm -rf ~) `danger` ; rm -rf / file.txt"
        out = tool(s, "files", "write", fmt.Sprintf(`{"path":%q,"content":%q}`, "weird name.txt", weird))
        if !strings.Contains(out, "WROTE") {
                t.Fatalf("weird write, got:\n%s", out)
        }
        out = tool(s, "files", "read", `{"path":"weird name.txt"}`)
        if !strings.Contains(out, weird) {
                t.Fatalf("the weird content must round-trip byte-for-byte, got:\n%s", out)
        }
        // and the blocklist class inside the CONTENT never fired (it is
        // data, not a command) — the file landed.
        if _, err := os.Stat(filepath.Join(root, "weird name.txt")); err != nil {
                t.Fatalf("the quoted write must have landed: %v", err)
        }
}

func TestV1203_LsMkdirRmFind(t *testing.T) {
        fb := newFakeArmBridge(t)
        s := newArmServer(t, fb)
        root := t.TempDir()
        armTermuxChat(t, s, "lsmrf", root)

        tool(s, "lsmrf", "write", `{"path":"a.txt","content":"aaa"}`)
        tool(s, "lsmrf", "write", `{"path":"z.txt","content":"zzzzzz"}`)
        out := tool(s, "lsmrf", "mkdir", `{"path":"sub"}`)
        if !strings.Contains(out, "CREATED — ") || !strings.Contains(out, filepath.Join(root, "sub")) {
                t.Fatalf("mkdir verdict, got:\n%s", out)
        }
        // a file INSIDE the new dir proves mkdir -p chains.
        out = tool(s, "lsmrf", "write", `{"path":"sub/nested.txt","content":"n"}`)
        if !strings.Contains(out, "WROTE") {
                t.Fatalf("nested write, got:\n%s", out)
        }

        out = tool(s, "lsmrf", "ls", `{"path":""}`)
        if !strings.Contains(out, "LS — "+root) || !strings.Contains(out, "(3 entries") {
                t.Fatalf("ls verdict, got:\n%s", out)
        }
        // dirs first + sizes + mtimes, hidden included.
        if !strings.Contains(out, "sub/ (dir) — 20") {
                t.Fatalf("dirs first with mtime, got:\n%s", out)
        }
        if !strings.Contains(out, "a.txt (3B)") || !strings.Contains(out, "z.txt (6B)") {
                t.Fatalf("sizes, got:\n%s", out)
        }
        if strings.Index(out, "sub/ (dir)") > strings.Index(out, "a.txt (") {
                t.Fatalf("dirs must list FIRST:\n%s", out)
        }
        // hidden entries included
        if err := os.WriteFile(filepath.Join(root, ".hidden"), []byte("h"), 0o644); err != nil {
                t.Fatalf("hidden: %v", err)
        }
        out = tool(s, "lsmrf", "ls", `{}`)
        if !strings.Contains(out, ".hidden") {
                t.Fatalf("hidden entries must be listed, got:\n%s", out)
        }

        // ls of a subfolder
        out = tool(s, "lsmrf", "ls", `{"path":"sub"}`)
        if !strings.Contains(out, "nested.txt") {
                t.Fatalf("subfolder ls, got:\n%s", out)
        }
        // ls of a FILE → the honest not-a-directory line.
        out = tool(s, "lsmrf", "ls", `{"path":"a.txt"}`)
        if !strings.Contains(out, "not a directory") {
                t.Fatalf("ls on a file, got:\n%s", out)
        }

        // find by name
        out = tool(s, "lsmrf", "find", `{"name":"*.txt"}`)
        if !strings.Contains(out, "FIND — "+root) || !strings.Contains(out, "a.txt") || !strings.Contains(out, "nested.txt") {
                t.Fatalf("find verdict, got:\n%s", out)
        }
        // find everything (no name)
        out = tool(s, "lsmrf", "find", `{}`)
        if !strings.Contains(out, filepath.Join(root, "sub", "nested.txt")) {
                t.Fatalf("find-all verdict, got:\n%s", out)
        }

        // rm a file → REMOVED; ls reflects it.
        out = tool(s, "lsmrf", "rm", `{"path":"a.txt"}`)
        if !strings.Contains(out, "REMOVED — ") {
                t.Fatalf("rm verdict, got:\n%s", out)
        }
        out = tool(s, "lsmrf", "ls", `{"path":""}`)
        if strings.Contains(out, "a.txt") {
                t.Fatalf("a.txt must be gone, got:\n%s", out)
        }
        // rm a whole subdir (rm -r semantics)
        out = tool(s, "lsmrf", "rm", `{"path":"sub"}`)
        if !strings.Contains(out, "REMOVED") {
                t.Fatalf("rm -r subdir, got:\n%s", out)
        }
}

func TestV1203_Grep_UnlimitedHits(t *testing.T) {
        fb := newFakeArmBridge(t)
        s := newArmServer(t, fb)
        root := t.TempDir()
        armTermuxChat(t, s, "grep", root)

        // 8 files × 3 TODO hits each = 24 hits — ALL must ride (the v1.19.1
        // whole-truth law: unlimited hits).
        for i := 0; i < 8; i++ {
                tool(s, "grep", "write", fmt.Sprintf(`{"path":"f%d.go","content":"line1 TODO %d\nline2 TODO\nplain\nTODO again"}`, i, i))
        }
        out := tool(s, "grep", "grep", `{"pattern":"TODO"}`)
        if !strings.Contains(out, "GREP — \"TODO\" in "+root) {
                t.Fatalf("grep verdict, got:\n%s", out)
        }
        if got := strings.Count(out, "TODO"); got < 24 {
                t.Fatalf("unlimited hits: want ≥24 TODO occurrences, got %d:\n%s", got, out)
        }
        // the pattern rides a positional arg — a shell-active pattern is
        // DATA, never executed (it matches nothing, and that is the honest
        // verdict — no shell substitution ever ran).
        out = tool(s, "grep", "grep", fmt.Sprintf(`{"pattern":%q}`, "$(echo pwned); rm -rf /"))
        if !strings.Contains(out, "no matches") {
                t.Fatalf("a shell-active pattern must match nothing, never execute:\n%s", out)
        }
        // glob narrowing
        out = tool(s, "grep", "grep", `{"pattern":"TODO","glob":"f0.go"}`)
        if !strings.Contains(out, "f0.go") || strings.Contains(out, "f1.go:") {
                t.Fatalf("glob narrowing, got:\n%s", out)
        }
        // no matches → the honest line
        out = tool(s, "grep", "grep", `{"pattern":"zzz-not-there"}`)
        if !strings.Contains(out, "no matches") {
                t.Fatalf("no-matches honesty, got:\n%s", out)
        }
}

// ── pkg ──────────────────────────────────────────────────────────────────

func TestV1203_Pkg(t *testing.T) {
        fb := newFakeArmBridge(t)
        s := newArmServer(t, fb)
        root := t.TempDir()
        armTermuxChat(t, s, "pkg", root)

        out := tool(s, "pkg", "pkg", `{"op":"install","packages":["python","git"]}`)
        if !strings.Contains(out, "PKG INSTALL — full Termux pkg output") {
                t.Fatalf("pkg verdict, got:\n%s", out)
        }
        if !strings.Contains(out, "stub pkg install -y python git") {
                t.Fatalf("the pkg packages ride positional args, got:\n%s", out)
        }

        // update (no packages needed)
        out = tool(s, "pkg", "pkg", `{"op":"update"}`)
        if !strings.Contains(out, "PKG UPDATE") || !strings.Contains(out, "stub pkg update -y") {
                t.Fatalf("pkg update, got:\n%s", out)
        }

        // name sanitization: shell metacharacters refused engine-side.
        out = tool(s, "pkg", "pkg", `{"op":"install","packages":["evil;rm -rf /"]}`)
        if !strings.Contains(out, "package name \"evil;rm -rf /\" refused") {
                t.Fatalf("pkg sanitization, got:\n%s", out)
        }

        // unknown op + missing packages → honest errors.
        out = tool(s, "pkg", "pkg", `{"op":"purge"}`)
        if !strings.Contains(out, `unknown pkg op "purge"`) {
                t.Fatalf("unknown op, got:\n%s", out)
        }
        out = tool(s, "pkg", "pkg", `{"op":"install","packages":[]}`)
        if !strings.Contains(out, "pkg install needs") {
                t.Fatalf("missing packages, got:\n%s", out)
        }
}

// ── the session lifecycle ────────────────────────────────────────────────

func TestV1203_SessionLifecycle(t *testing.T) {
        fb := newFakeArmBridge(t)
        s := newArmServer(t, fb)
        root := t.TempDir()
        armTermuxChat(t, s, "sess", root)

        // start: a real background process (echo + sleep), pid reported.
        out := tool(s, "sess", "session_start", `{"name":"web","command":"echo started-arm; sleep 30"}`)
        if !strings.Contains(out, "SESSION STARTED — web (pid ") {
                t.Fatalf("session start verdict, got:\n%s", out)
        }
        if !strings.Contains(out, "log: ") || !strings.Contains(out, "/out.log") {
                t.Fatalf("the start verdict must teach the log path, got:\n%s", out)
        }

        // list: live + the ps line + the log size.
        out = tool(s, "sess", "session_list", `{}`)
        if !strings.Contains(out, "SESSIONS — 1 total") || !strings.Contains(out, "web (pid ") {
                t.Fatalf("session list verdict, got:\n%s", out)
        }
        if !strings.Contains(out, "live") {
                t.Fatalf("the fresh session must be LIVE, got:\n%s", out)
        }
        if !strings.Contains(out, "run.sh") {
                t.Fatalf("the ps line must ride, got:\n%s", out)
        }

        // log: the background process's output, tailed.
        out = tool(s, "sess", "session_log", `{"name":"web"}`)
        if !strings.Contains(out, "SESSION LOG — web (tail 200)") || !strings.Contains(out, "started-arm") {
                t.Fatalf("session log verdict, got:\n%s", out)
        }

        // a second session (isolation) that dies immediately → honest verdict.
        out = tool(s, "sess", "session_start", `{"name":"flash","command":"true"}`)
        if !strings.Contains(out, "SESSION EXITED IMMEDIATELY — flash") {
                t.Fatalf("immediate-exit honesty, got:\n%s", out)
        }

        // kill: SIGTERM first (the sleep dies with the wrapper's trap).
        out = tool(s, "sess", "session_kill", `{"name":"web"}`)
        if !strings.Contains(out, "SESSION KILLED — web (pid ") {
                t.Fatalf("session kill verdict, got:\n%s", out)
        }
        // the list now shows dead (and the flash session too).
        out = tool(s, "sess", "session_list", `{}`)
        if !strings.Contains(out, "dead") {
                t.Fatalf("the killed session must show dead, got:\n%s", out)
        }

        // killing an unknown session → the honest no-session error.
        out = tool(s, "sess", "session_kill", `{"name":"ghost"}`)
        if !strings.Contains(out, "no session named ghost") {
                t.Fatalf("unknown session honesty, got:\n%s", out)
        }
        // log of an unknown session → the honest error.
        out = tool(s, "sess", "session_log", `{"name":"ghost"}`)
        if !strings.Contains(out, "no session named ghost") {
                t.Fatalf("unknown session log honesty, got:\n%s", out)
        }
        // bad names refused engine-side.
        out = tool(s, "sess", "session_start", `{"name":"../escape","command":"true"}`)
        if !strings.Contains(out, "session name \"../escape\" refused") {
                t.Fatalf("session name sanitization, got:\n%s", out)
        }
        // missing command/name → the teach.
        out = tool(s, "sess", "session_start", `{"name":"x"}`)
        if !strings.Contains(out, "session_start needs") {
                t.Fatalf("session_start teach, got:\n%s", out)
        }
}

// The sessions root is the fake's HOME (never the real home, never the
// workspace jail): pin where the dir landed.
func TestV1203_SessionRootIsHome(t *testing.T) {
        fb := newFakeArmBridge(t)
        s := newArmServer(t, fb)
        root := t.TempDir()
        armTermuxChat(t, s, "rootcheck", root)
        out := tool(s, "rootcheck", "session_start", `{"name":"r","command":"sleep 5"}`)
        if !strings.Contains(out, "dir: "+fb.home+"/.doomalay/sessions/r") {
                t.Fatalf("sessions live under $HOME/.doomalay/sessions, got:\n%s", out)
        }
        tool(s, "rootcheck", "session_kill", `{"name":"r"}`)
}

// ── the args-shape tolerance + the mcpbus handler twin ───────────────────

// All three arg shapes land: nested JSON string (the Def's shape), a
// live JSON object, and flat top-level keys.
func TestV1203_ArgShapeTolerance(t *testing.T) {
        fb := newFakeArmBridge(t)
        s := newArmServer(t, fb)
        root := t.TempDir()
        armTermuxChat(t, s, "shapes", root)

        out := s.runTermuxAction(context.Background(), "shapes", `{"action":"write","args":"{\"path\":\"one.txt\",\"content\":\"1\"}"}`)
        if !strings.Contains(out, "WROTE") {
                t.Fatalf("nested JSON-string args, got:\n%s", out)
        }
        out = s.runTermuxAction(context.Background(), "shapes", `{"action":"write","args":{"path":"two.txt","content":"2"}}`)
        if !strings.Contains(out, "WROTE") {
                t.Fatalf("live-object args, got:\n%s", out)
        }
        out = s.runTermuxAction(context.Background(), "shapes", `{"action":"write","path":"three.txt","content":"3"}`)
        if !strings.Contains(out, "WROTE") {
                t.Fatalf("flat args, got:\n%s", out)
        }
}

// The mcpbus twin: the unarmed Turn's termux call answers the honest
// not-armed error (the handler's law — the runner is behind the gate).
func TestV1203_McpHandlerNotArmed(t *testing.T) {
        // The MCP-path not-armed text is pinned in mcpbus's own suite; here
        // pin the RUNNER's side of the same law: an armed session's tool
        // text is the runner's observation, byte-shape identical.
        fb := newFakeArmBridge(t)
        s := newArmServer(t, fb)
        root := t.TempDir()
        armTermuxChat(t, s, "mcp", root)
        out := tool(s, "mcp", "exec", `{"command":"echo arm-ok"}`)
        if !strings.HasPrefix(strings.TrimPrefix(out, "OBSERVATION:\n"), "EXEC DONE") {
                t.Fatalf("the runner's marker heads are the MCP tool's text, got:\n%s", out)
        }
}

// ── pure helpers ─────────────────────────────────────────────────────────

func TestV1203_Helpers(t *testing.T) {
        roots := []string{"/storage/emulated/0/Doomalay", "/data/home"}

        // resolve: relative → first root; absolute kept; "" → first root.
        if got := termuxResolvePath(roots, "notes/a.txt"); got != "/storage/emulated/0/Doomalay/notes/a.txt" {
                t.Fatalf("resolve relative: %q", got)
        }
        if got := termuxResolvePath(roots, "/data/home/x"); got != "/data/home/x" {
                t.Fatalf("resolve absolute: %q", got)
        }
        if got := termuxResolvePath(roots, ""); got != roots[0] {
                t.Fatalf("resolve empty: %q", got)
        }

        // jail: prefix-with-boundary, never a string-prefix trick.
        if !termuxJailOK("/storage/emulated/0/Doomalay", roots) ||
                !termuxJailOK("/storage/emulated/0/Doomalay/a", roots) {
                t.Fatalf("in-jail paths must pass")
        }
        if termuxJailOK("/storage/emulated/0/Doomalay-evil", roots) {
                t.Fatalf("the boundary must require / after the root")
        }
        if termuxJailOK("/storage/emulated/0/Doomalay/../other", roots) {
                t.Fatalf("… must be caught by the component check")
        }
        if termuxJailOK("/etc", roots) {
                t.Fatalf("outside paths must fail")
        }

        // the shell quoting law: single-quote wrap, embedded quotes escaped.
        if got := termuxShellQuote("it's"); got != `'it'\''s'` {
                t.Fatalf("shellQuote, got %q", got)
        }
        cmd := termuxCommand(`p="$1"`, "a b", "c'd")
        if !strings.Contains(cmd, `bash -c 'p="$1"' bash 'a b' 'c'\''d'`) {
                t.Fatalf("termuxCommand, got %q", cmd)
        }

        // the jail script: the prologue's resolve-check-act order + exit 42.
        script := termuxJailScript(nil, "echo body\n")
        for _, pin := range []string{
                `readlink -f -- "$p"`,
                `case "$r" in "$root"|"$root"/*) ok=1; break ;; esac`,
                `exit 42`,
        } {
                if !strings.Contains(script, pin) {
                        t.Fatalf("the jail script must contain %q:\n%s", pin, script)
                }
        }
        // the extra args are saved BEFORE the shift (the body can read them)
        script = termuxJailScript([]string{"b64"}, "printf %s \"$b64\" | base64 -d > \"$r\"\n")
        if !strings.Contains(script, "b64=\"$2\"\n") || !strings.Contains(script, "shift $((1+1))") {
                t.Fatalf("the extra-arg capture, got:\n%s", script)
        }

        // the truncation physics table (this worktree's client struct
        // carries no original-length fields — the exact originals are zero
        // here and the physics heuristic decides).
        if termuxTruncated(&termuxbridge.RunResult{}) {
                t.Fatalf("empty result is not truncated")
        }
        if !termuxTruncated(&termuxbridge.RunResult{Stdout: strings.Repeat("x", termuxCapBytes)}) {
                t.Fatalf("100KB stdout alone is AT the cap")
        }
        if !termuxTruncated(&termuxbridge.RunResult{Stdout: strings.Repeat("x", termuxCapBytes/2), Stderr: "e"}) {
                t.Fatalf("50KB stdout with stderr present is at the halved cap")
        }
        if termuxTruncated(&termuxbridge.RunResult{Stdout: strings.Repeat("x", 60*1024)}) {
                t.Fatalf("60KB stdout alone is under the 100KB physics")
        }
        // the reflection path is UNKNOWN-safe: a struct without the
        // original-length tags answers zero, never an error.
        if got := termuxOriginalLen(&termuxbridge.RunResult{Stdout: "x"}, "stdout_original_length"); got != 0 {
                t.Fatalf("unknown original-length fields must read zero, got %d", got)
        }

        // the bytes renderer.
        if termuxBytes(strconv.Itoa(12)) != "12B" ||
                termuxBytes(strconv.Itoa(2048)) != "2.0KB" ||
                termuxBytes(strconv.Itoa(5<<20)) != "5.0MB" {
                t.Fatalf("termuxBytes drifted")
        }
}

// ── v1.21.1 THE ARMED HAND ───────────────────────────────────────────────

// TestV1211_SessionMcpTurnTermuxClosure — THE PM PATH PIN: the /mcp session
// Turn (the ONLY tool path every PrivateMode chat's browser loop uses —
// PM turns are frontend-driven and never touch the engine's direct
// ChatRequest) must carry the Termux closure. The v1.20.3 blind spot
// (nil closure) made PM bots answer "the termux tool is not armed for
// this chat" forever while the user had the ⌨ stacked AND device
// folders bound — the live repro.
func TestV1211_SessionMcpTurnTermuxClosure(t *testing.T) {
        fb := newFakeArmBridge(t)
        s := newArmServer(t, fb)
        root := t.TempDir()
        armTermuxChat(t, s, "pmchat", root)

        turn := s.sessionMcpTurn("pmchat")
        if turn == nil {
                t.Fatalf("sessionMcpTurn must resolve the armed session")
        }
        if turn.Termux == nil {
                t.Fatalf("THE PM ARM: the session Turn must carry the Termux closure (the v1.20.3 blind spot)")
        }
        out := turn.Termux(context.Background(), `{"action":"help"}`)
        if !strings.Contains(out, "termux tool — a real Termux Linux shell") || !strings.Contains(out, root) {
                t.Fatalf("the PM-path termux call must answer the real help with the bound root, got:\n%s", out)
        }
        // armed exec through the PM path — the real bridge round trip
        out = turn.Termux(context.Background(), `{"action":"exec","args":{"command":"echo pm-arm-alive"}}`)
        if !strings.Contains(out, "pm-arm-alive") {
                t.Fatalf("the PM-path exec must run for real, got:\n%s", out)
        }

        // unarmed session: the closure wires UNCONDITIONALLY (the runner
        // gates, not the resolver) and the teach is honest, bridge untouched.
        s.db.CreateSession(&store.Session{ID: "pmbare", Title: "t", Model: "m", Provider: "p"})
        turn = s.sessionMcpTurn("pmbare")
        if turn == nil || turn.Termux == nil {
                t.Fatalf("the closure wires unconditionally (the runner gates, not the resolver)")
        }
        out = turn.Termux(context.Background(), `{"action":"exec","args":{"command":"echo hi"}}`)
        if !strings.Contains(out, "the ⌨ Termux capability is not stacked") {
                t.Fatalf("the unarmed PM chat gets the honest not-stacked teach, got:\n%s", out)
        }
        if fb.runCount() != 1 {
                t.Fatalf("the unarmed chat must never touch the bridge (runs=%d)", fb.runCount())
        }
}

// TestV1211_AutoStackOnDeviceBind — THE BIND IS THE CONSENT: POSTing a
// termux workspace with a session_id stacks the capability the same
// moment; the bind route re-stacks after an unstack (the toggle stays
// the kill-switch only until the user binds again); a non-termux device
// row never touches the flag.
func TestV1211_AutoStackOnDeviceBind(t *testing.T) {
        fb := newFakeArmBridge(t)
        s := newArmServer(t, fb)

        s.db.CreateSession(&store.Session{ID: "bindchat", Title: "t", Model: "m", Provider: "p"})
        code, out := v1202Req(t, s, "POST", "/api/workspaces/device",
                `{"name":"my folder","termux_path":"/storage/emulated/0/Doomalay/myfolder","session_id":"bindchat"}`)
        if code != 200 {
                t.Fatalf("device POST: %d %v", code, out)
        }
        sess, _ := s.db.GetSession("bindchat")
        if sess == nil || !sess.Termux {
                t.Fatalf("the termux bind must auto-stack the capability (the bind IS the consent)")
        }

        // unstack sticks (the kill-switch works between binds)
        v1202Req(t, s, "PATCH", "/api/sessions/bindchat", `{"termux":false}`)
        sess, _ = s.db.GetSession("bindchat")
        if sess == nil || sess.Termux {
                t.Fatalf("unstacking must stick after the bind")
        }

        // re-binding through the workspace bind route re-stacks
        wss, _ := s.db.ListSessionWorkspaces("bindchat")
        if len(wss) != 1 {
                t.Fatalf("the bound row must exist (got %d)", len(wss))
        }
        code, out = v1202Req(t, s, "POST", "/api/workspaces/"+wss[0].ID+"/bind", `{"session_id":"bindchat"}`)
        if code != 200 {
                t.Fatalf("bind route: %d %v", code, out)
        }
        sess, _ = s.db.GetSession("bindchat")
        if sess == nil || !sess.Termux {
                t.Fatalf("re-binding a termux workspace must re-stack the capability")
        }

        // a NON-termux device row never touches the flag
        s.db.CreateSession(&store.Session{ID: "cloudchat", Title: "t", Model: "m", Provider: "p"})
        code, out = v1202Req(t, s, "POST", "/api/workspaces/device", `{"name":"local","path":"/x","session_id":"cloudchat"}`)
        if code != 200 {
                t.Fatalf("plain device POST: %d %v", code, out)
        }
        sess, _ = s.db.GetSession("cloudchat")
        if sess == nil || sess.Termux {
                t.Fatalf("a non-termux device row must not stack the capability")
        }
}

// TestV1211_CmdsInventory — the new cmds action: the FIXED script (zero
// model strings — the pkg idiom) inventories PATH + PREFIX + the
// $PREFIX/bin userland through the bridge, whole-truth, fail-soft when
// PREFIX is unset (the ${PREFIX:-default} law under set -u).
func TestV1211_CmdsInventory(t *testing.T) {
        fb := newFakeArmBridge(t)
        s := newArmServer(t, fb)
        root := t.TempDir()
        armTermuxChat(t, s, "cmdchat", root)

        out := tool(s, "cmdchat", "cmds", `{}`)
        if !strings.Contains(out, "CMDS — every command available") {
                t.Fatalf("the cmds header, got:\n%s", out)
        }
        if !strings.Contains(out, "PATH=") || !strings.Contains(out, "PREFIX=") {
                t.Fatalf("the inventory must carry PATH + PREFIX, got:\n%s", out)
        }
        // the fake bridge's bash runs the script for real: the fail-soft
        // default PREFIX path doesn't exist locally → ls prints nothing,
        // the script still exits 0 (the honesty: no crash, no junk).
        if !strings.Contains(out, "exit_code: 0") {
                t.Fatalf("the fixed fail-soft script must exit 0, got:\n%s", out)
        }
        // the armed chat's help must teach the new verb + the userland
        out = tool(s, "cmdchat", "help", `{}`)
        if !strings.Contains(out, `"action":"cmds"`) || !strings.Contains(out, "WHOLE LINUX USERLAND") {
                t.Fatalf("the help must teach cmds + the whole-userland capability, got:\n%s", out)
        }
}
