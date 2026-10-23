package ocserve

import (
        "archive/tar"
        "archive/zip"
        "bytes"
        "compress/gzip"
        "context"
        "crypto/sha512"
        "encoding/base64"
        "encoding/json"
        "fmt"
        "io"
        "net/http"
        "net/http/httptest"
        "os"
        "path/filepath"
        "strings"
        "testing"
        "time"
)

// The v1.51.1 pins. All frames below are LIVE-CAPTURED from the real
// OpenCode 2.1.2 npm CLI serve (2026-10-21, big-pickle turns through
// /api/event SSE, the same probes CAPTURED-TRUTH documents).

// TestPermissionConfigLaw pins the v1.58.2 OPEN-HANDS gate-law config: the
// V2 RULES ARRAY (ordered {action, resource, effect}, last-match-wins,
// layered on the agent's own allow-all base policy) with exactly the
// honest exceptions — question DENIED (a headless serve turn has no human
// to answer an ask), the doomalay_* MCP tools explicitly ALLOWED (the
// wide-shelf belt — never hostage to an upstream default-policy change),
// the *.env secrets reads DENIED. Everything else (shell, edit, webfetch,
// subagent, execute…) carries NO rule — the base policy allows it: the
// user's 1:1-native-parity law ("full access as a real user"), and the
// v157 live probes proved open hands pass the free gate. The websearch
// provider selection rides alongside (R5: the missing selection was the
// device's "Web search cancelled" disease; tavily rides the serve's own
// authenticated account — no key needed).
func TestPermissionConfigLaw(t *testing.T) {
        var cfg map[string]any
        if err := json.Unmarshal([]byte(permissionConfig), &cfg); err != nil {
                t.Fatalf("config is not valid JSON: %v", err)
        }
        rules, ok := cfg["permissions"].([]any)
        if !ok {
                t.Fatalf("the V2 grammar: the config must carry the rules array, got %T", cfg["permissions"])
        }
        if cfg["permission"] != nil {
                t.Fatalf("the V1 legacy object is DEAD: %v", cfg["permission"])
        }
        type rule struct{ action, resource, effect string }
        got := []rule{}
        for _, r := range rules {
                m, _ := r.(map[string]any)
                got = append(got, rule{m["action"].(string), m["resource"].(string), m["effect"].(string)})
        }
        // QUESTION DENY — the one headless-hostile ask-flow
        qdeny := false
        for _, r := range got {
                if r.action == "question" && r.resource == "*" && r.effect == "deny" {
                        qdeny = true
                }
        }
        if !qdeny {
                t.Fatalf("the headless law: question must be DENIED — %v", got)
        }
        // THE WIDE SHELF BELT — doomalay_* explicitly allowed
        dallow := false
        for _, r := range got {
                if r.action == "doomalay_*" && r.resource == "*" && r.effect == "allow" {
                        dallow = true
                }
        }
        if !dallow {
                t.Fatalf("the wide-shelf belt: doomalay_* must be explicitly ALLOWED — %v", got)
        }
        // THE SECRETS LINE — *.env / *.env.* reads denied
        envDenies := 0
        for _, r := range got {
                if r.action == "read" && r.effect == "deny" && (r.resource == "*.env" || r.resource == "*.env.*") {
                        envDenies++
                }
        }
        if envDenies != 2 {
                t.Fatalf("the secrets line: both *.env and *.env.* reads must be DENIED — %v", got)
        }
        // THE OPEN HANDS — no shell/edit/webfetch/subagent/execute deny rules
        // remain (the base allow-all policy carries them; the user's law)
        for _, r := range got {
                switch r.action {
                case "shell", "edit", "webfetch", "task", "subagent", "execute", "external_directory", "doom_loop":
                        t.Fatalf("the open hands: %s must carry NO rule (the base allow-all owns it) — %v", r.action, got)
                }
        }
        // THE WEBSEARCH SELECTION (R5)
        ws, _ := cfg["websearch"].(map[string]any)
        if ws == nil || ws["provider"] != "tavily" {
                t.Fatalf("the websearch provider selection must ride the config (R5): %v", cfg["websearch"])
        }
}

// TestNPMPinLaw pins the desktop artifact law: the pinned 2.x CLI ships as
// the npm platform tarball, its URL is derived from the pin, and every
// platform carries the registry's own sha512 integrity constant.
func TestNPMPinLaw(t *testing.T) {
        t.Setenv("DOOMALAY_OPENCODE_TARBALL_URL", "")
        t.Setenv("DOOMALAY_OPENCODE_TARBALL_SHA512", "")
        cases := []struct{ goos, goarch, platform string }{
                {"linux", "amd64", "linux-x64"},
                {"linux", "arm64", "linux-arm64"},
                {"darwin", "arm64", "darwin-arm64"},
                {"darwin", "amd64", "darwin-x64"},
        }
        for _, c := range cases {
                url, integ, ok := downloadAssetURL(c.goos, c.goarch)
                if !ok {
                        t.Fatalf("%s/%s must resolve to an npm tarball", c.goos, c.goarch)
                }
                want := "https://registry.npmjs.org/@opencode/cli-" + c.platform + "/-/cli-" + c.platform + "-" + Version + ".tgz"
                if url != want {
                        t.Fatalf("npm URL law: got %q want %q", url, want)
                }
                if !strings.HasPrefix(integ, "sha512-") || len(integ) < 40 {
                        t.Fatalf("the %s tarball must carry the registry's sha512 integrity (got %q)", c.platform, integ)
                }
                if _, err := base64.StdEncoding.DecodeString(strings.TrimPrefix(integ, "sha512-")); err != nil {
                        t.Fatalf("the %s integrity is not valid base64: %v", c.platform, err)
                }
        }
        // the override law (the rigs + future bumps)
        t.Setenv("DOOMALAY_OPENCODE_TARBALL_URL", "http://rig.local/opencode.tgz")
        t.Setenv("DOOMALAY_OPENCODE_TARBALL_SHA512", "sha512-rigsum=")
        url, integ, ok := downloadAssetURL("linux", "amd64")
        if !ok || url != "http://rig.local/opencode.tgz" || integ != "sha512-rigsum=" {
                t.Fatalf("the tarball env override law broke: %q %q %v", url, integ, ok)
        }
}

// TestServerPasswordLaw pins the 2.x basic-auth law: the Manager owns a
// serve password (env-overridable for the rigs), every request carries it,
// and it never leaks into a URL.
func TestServerPasswordLaw(t *testing.T) {
        t.Setenv("DOOMALAY_OPENCODE_SERVE_PASSWORD", "rig-fixed-pw")
        m := New("", "key", nil)
        if m.ServerPassword() != "rig-fixed-pw" {
                t.Fatalf("the env override must win (got %q)", m.ServerPassword())
        }
        var gotAuth, gotPath string
        srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
                gotAuth = r.Header.Get("Authorization")
                gotPath = r.URL.Path
                io.WriteString(w, `{"data":[]}`)
        }))
        defer srv.Close()
        m.SetBaseURL(srv.URL)
        if !m.Healthy() {
                t.Fatalf("the auth'd health check must pass against the fake serve")
        }
        if !strings.HasPrefix(gotAuth, "Basic ") {
                t.Fatalf("the health check must speak basic auth (got %q)", gotAuth)
        }
        want := "Basic " + basicAuth("opencode", "rig-fixed-pw")
        if gotAuth != want {
                t.Fatalf("auth wrong: got %q want %q", gotAuth, want)
        }
        if gotPath != "/api/provider" {
                t.Fatalf("the 2.x health route is /api/provider (got %q)", gotPath)
        }
}

// TestTheTurnShapeClient pins the 2.x client flow against a fake serve:
// POST /api/session → data.id, POST /api/session/{id}/model with the
// {model:{id,providerID}} wrapper, POST /api/session/{id}/prompt with the
// TEXT-ONLY body (no model, no parts, no system/tools fields exist in the
// 2.x PromptInput — the 1.x shape-poison gate law is moot), and basic auth
// on every call.
func TestTheTurnShapeClient(t *testing.T) {
        var capturedAuth, capturedPath, capturedBody string
        var sawAuth [3]bool // session, model, prompt
        srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
                capturedAuth = r.Header.Get("Authorization")
                capturedPath = r.URL.Path
                b, _ := io.ReadAll(r.Body)
                capturedBody = string(b)
                switch {
                case r.URL.Path == "/api/session" && r.Method == "POST":
                        sawAuth[0] = capturedAuth == "Basic "+basicAuth("opencode", "pw")
                        io.WriteString(w, `{"data":{"id":"ses_probe_2x","title":"probe"}}`)
                case strings.HasSuffix(r.URL.Path, "/model") && r.Method == "POST":
                        sawAuth[1] = capturedAuth == "Basic "+basicAuth("opencode", "pw")
                        w.WriteHeader(204)
                case strings.HasSuffix(r.URL.Path, "/prompt") && r.Method == "POST":
                        sawAuth[2] = capturedAuth == "Basic "+basicAuth("opencode", "pw")
                        io.WriteString(w, `{"data":{"id":"msg_u1","type":"user","payload":{"text":"hello"}}}`)
                default:
                        w.WriteHeader(404)
                }
        }))
        defer srv.Close()
        t.Setenv("DOOMALAY_OPENCODE_SERVE_PASSWORD", "pw")
        m := New("", "key", nil)
        m.SetBaseURL(srv.URL)
        sid, err := m.CreateSession("probe")
        if err != nil || sid != "ses_probe_2x" {
                t.Fatalf("create session: %q %v", sid, err)
        }
        if err := m.SelectModel(sid, "big-pickle"); err != nil {
                t.Fatalf("select model: %v", err)
        }
        var modelBody map[string]any
        json.Unmarshal([]byte(capturedBody), &modelBody)
        mod, _ := modelBody["model"].(map[string]any)
        if mod == nil || mod["id"] != "big-pickle" || mod["providerID"] != "opencode" {
                t.Fatalf("the model block must be {id, providerID} on the session: %v", modelBody)
        }
        if err := m.Prompt(sid, "hello big pickle"); err != nil {
                t.Fatalf("prompt: %v", err)
        }
        var promptBody map[string]any
        json.Unmarshal([]byte(capturedBody), &promptBody)
        if promptBody["text"] != "hello big pickle" {
                t.Fatalf("the prompt body is text-only: %v", promptBody)
        }
        for _, forbidden := range []string{"model", "parts", "tools", "system", "providerID", "modelID"} {
                if _, ok := promptBody[forbidden]; ok {
                        t.Fatalf("THE SHAPE LAW: the 2.x prompt must not carry %q (the PromptInput is {text, files?, agents?, skills?})", forbidden)
                }
        }
        if !sawAuth[0] || !sawAuth[1] || !sawAuth[2] {
                t.Fatalf("basic auth must ride EVERY client call: %v", sawAuth)
        }
        _ = capturedPath
}

// TestSSEParseLiveFrames drives the parser against the LIVE-CAPTURED 2.x
// frame shapes (handshake → inbox → step → reasoning/text deltas → tool
// pill → usage → terminal) and pins the mapping inputs the server adapter
// reads: the data envelope, the session filter, the delta payloads, the
// tool pill fields, the ledger tokens, and the two terminals.
func TestSSEParseLiveFrames(t *testing.T) {
        frames := []string{
                `data: {"id":"evt_0","type":"server.connected","data":{}}`,
                `data: {"id":"evt_1","created":1792592480579,"type":"session.inbox.enqueued","data":{"inboxID":"msg_u1","sessionID":"ses_2x1"}}`,
                `data: {"id":"evt_2","type":"session.execution.started","data":{"sessionID":"ses_2x1"}}`,
                `data: {"id":"evt_3","type":"session.step.started","data":{"sessionID":"ses_2x1","agent":"build","model":{"id":"big-pickle","providerID":"opencode"},"assistantMessageID":"msg_a1"}}`,
                `data: {"id":"evt_4","type":"session.reasoning.delta","data":{"sessionID":"ses_2x1","assistantMessageID":"msg_a1","ordinal":0,"delta":"The user says"}}`,
                `data: {"id":"evt_5","type":"session.reasoning.delta","data":{"sessionID":"ses_2x1","assistantMessageID":"msg_a1","ordinal":0,"delta":" hi"}}`,
                `data: {"id":"evt_6","type":"session.text.delta","data":{"sessionID":"ses_2x1","assistantMessageID":"msg_a1","ordinal":0,"delta":"SSE-OK"}}`,
                `data: {"id":"evt_7","type":"session.tool.input.started","data":{"sessionID":"ses_2x1","assistantMessageID":"msg_a1","id":"call_r1","name":"read"}}`,
                `data: {"id":"evt_8","type":"session.tool.input.ended","data":{"sessionID":"ses_2x1","assistantMessageID":"msg_a1","id":"call_r1","text":"{\"filePath\":\"secret-note.txt\"}"}}`,
                `data: {"id":"evt_9","type":"session.tool.success","data":{"sessionID":"ses_2x1","assistantMessageID":"msg_a1","id":"call_r1","content":[{"type":"text","text":"THE ANSWER IS 42"}],"executed":false}}`,
                `data: {"id":"evt_10","type":"session.usage.updated","data":{"sessionID":"ses_2x1","cost":0,"tokens":{"input":4016,"output":258,"reasoning":253,"cache":{"read":15698,"write":0}}}}`,
                `data: {"id":"evt_11","type":"session.execution.succeeded","data":{"sessionID":"ses_2x1"}}`,
                // a FOREIGN frame must be filtered
                `data: {"id":"evt_12","type":"session.text.delta","data":{"sessionID":"ses_OTHER","delta":"not mine"}}`,
        }
        sse := strings.Join(frames, "\n\n") + "\n\n"
        t.Setenv("DOOMALAY_OPENCODE_SERVE_PASSWORD", "pw")
        srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
                if r.URL.Path == "/api/event" {
                        w.Header().Set("Content-Type", "text/event-stream")
                        io.WriteString(w, sse)
                        return
                }
                w.WriteHeader(404)
        }))
        defer srv.Close()
        m := New("", "key", nil)
        m.SetBaseURL(srv.URL)

        var order []string
        var reasoning, textOut, toolName, toolArgs, toolOut, usageTok string
        var usageCost float64
        var terminal bool
        err := m.StreamEvents(context.Background(), "ses_2x1", func(ev Event) error {
                switch ev.Type {
                case "session.reasoning.delta":
                        reasoning += ev.Data.Delta
                        order = append(order, "reasoning")
                case "session.text.delta":
                        textOut += ev.Data.Delta
                        order = append(order, "text")
                case "session.tool.input.started":
                        toolName = ev.Data.Name
                        order = append(order, "tool:"+ev.Data.ID)
                case "session.tool.input.ended":
                        toolArgs = ev.Data.Text
                        order = append(order, "args")
                case "session.tool.success":
                        if len(ev.Data.Content) > 0 {
                                toolOut = ev.Data.Content[0].Text
                        }
                        order = append(order, "result")
                case "session.usage.updated":
                        usageCost = ev.Data.Cost
                        usageTok = fmt.Sprintf("%d/%d/%d", ev.Data.Tokens.Input, ev.Data.Tokens.Output, ev.Data.Tokens.Reasoning)
                        order = append(order, "usage")
                case "session.execution.succeeded":
                        terminal = true
                }
                return nil
        })
        if err != nil {
                t.Fatalf("stream: %v", err)
        }
        if !terminal {
                t.Fatalf("the terminal law: the turn must end on session.execution.succeeded")
        }
        if reasoning != "The user says hi" || textOut != "SSE-OK" {
                t.Fatalf("deltas lost: reasoning=%q text=%q", reasoning, textOut)
        }
        if toolName != "read" || toolArgs != `{"filePath":"secret-note.txt"}` || toolOut != "THE ANSWER IS 42" {
                t.Fatalf("tool pill lost: name=%q args=%q out=%q", toolName, toolArgs, toolOut)
        }
        if usageCost != 0 || usageTok != "4016/258/253" {
                t.Fatalf("the ledger lost: cost=%v tokens=%q", usageCost, usageTok)
        }
        if len(order) != 7 {
                t.Fatalf("event order wrong: %v", order)
        }
        if strings.Contains(strings.Join(order, " "), "not mine") {
                t.Fatalf("a foreign session's frame leaked in")
        }
}

// TestTerminalFailureDetection pins the 2.x failure shapes: the free-tier
// wall triggers the recycle law; a provider.auth/401 is the honest
// reconnect answer; neither is misread for the other.
func TestTerminalFailureDetection(t *testing.T) {
        var ev Event
        json.Unmarshal([]byte(`{"type":"session.execution.failed","data":{"sessionID":"s","error":{"type":"provider.error","message":"OpenCode's free tier can only be used from within OpenCode. Download it at https://opencode.ai","status":403}}}`), &ev)
        if !ev.IsTerminal() || !ev.IsFreeTierError() {
                t.Fatalf("the wall frame must be a free-tier terminal")
        }
        if ev.IsAuthError() {
                t.Fatalf("a gate refusal is not a key error")
        }
        json.Unmarshal([]byte(`{"type":"session.execution.failed","data":{"sessionID":"s","error":{"type":"provider.auth","message":"Reconnect OpenCode Console to continue.","status":401}}}`), &ev)
        if !ev.IsTerminal() || !ev.IsAuthError() {
                t.Fatalf("the auth frame must be a 401 terminal")
        }
        if ev.IsFreeTierError() {
                t.Fatalf("a key error must not trigger the recycle")
        }
        json.Unmarshal([]byte(`{"type":"session.usage.updated","data":{"sessionID":"s"}}`), &ev)
        if ev.IsTerminal() {
                t.Fatalf("usage frames are not terminals")
        }
}

// TestFindBinaryEnvOverride pins the discovery order (env → managed → PATH).
func TestFindBinaryEnvOverride(t *testing.T) {
        dir := t.TempDir()
        fake := filepath.Join(dir, "fake-opencode")
        os.WriteFile(fake, []byte("#!/bin/sh\n"), 0o755)
        t.Setenv("DOOMALAY_OPENCODE_BIN", fake)
        if got := FindBinary(dir); got != fake {
                t.Fatalf("env override must win: got %q", got)
        }
}

// TestVersionIsPinned pins the npm 2.x line (the gate "actively evolves" —
// moving the pin requires a fresh live probe + a phase, never a silent
// bump).
func TestVersionIsPinned(t *testing.T) {
        if !strings.HasPrefix(Version, "2.") {
                t.Fatalf("the bridge is on the 2.x npm line (got %q)", Version)
        }
        _ = time.Second // keep time imported for future latency pins
}

// TestEnsureBinaryVerifiesIntegrity pins THE PIN LAW end-to-end with a
// fake registry: a tarball whose sha512 matches the declared integrity
// extracts to the managed path; a corrupted one answers the honest error
// and nothing lands.
func TestEnsureBinaryVerifiesIntegrity(t *testing.T) {
        // build a fake opencode tarball: package/bin/opencode
        payload := []byte("#!/bin/sh\necho opencode 2.1.2\n")
        var tarBuf bytes.Buffer
        gw := gzip.NewWriter(&tarBuf)
        tw := tar.NewWriter(gw)
        hdr := &tar.Header{Name: "package/bin/opencode", Mode: 0o755, Size: int64(len(payload)), Typeflag: tar.TypeReg}
        tw.WriteHeader(hdr)
        tw.Write(payload)
        tw.Close()
        gw.Close()
        sum := sha512.Sum512(tarBuf.Bytes())
        integrity := "sha512-" + base64.StdEncoding.EncodeToString(sum[:])

        bad := append([]byte(nil), tarBuf.Bytes()...)
        bad[20] ^= 0xFF // corrupt one byte

        serveBytes := func(b []byte) *httptest.Server {
                return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
                        w.Write(b)
                }))
        }
        good := serveBytes(tarBuf.Bytes())
        defer good.Close()
        badSrv := serveBytes(bad)
        defer badSrv.Close()

        dir := t.TempDir()
        t.Setenv("DOOMALAY_OPENCODE_BIN", "")
        t.Setenv("DOOMALAY_OPENCODE_TARBALL_URL", good.URL + "/cli.tgz")
        t.Setenv("DOOMALAY_OPENCODE_TARBALL_SHA512", integrity)
        bin, err := EnsureBinary(dir, nil)
        if err != nil {
                t.Fatalf("a matching tarball must install: %v", err)
        }
        if got, _ := os.ReadFile(bin); !bytes.HasPrefix(got, []byte("#!/bin/sh")) {
                t.Fatalf("the managed binary must be the tarball's package/bin/opencode")
        }
        t.Setenv("DOOMALAY_OPENCODE_TARBALL_URL", badSrv.URL + "/cli.tgz")
        dir2 := t.TempDir()
        if _, err := EnsureBinary(dir2, nil); err == nil || !strings.Contains(err.Error(), "sha512") {
                t.Fatalf("a corrupted tarball must fail the integrity law honestly: %v", err)
        }
        if p := managedBinPath(dir2); p != "" {
                if _, err := os.Stat(p); err == nil {
                        t.Fatalf("nothing may land from a failed integrity check")
                }
        }
        _ = zip.OpenReader // keep zip imported (the env-override .zip path)
}

// TestStablePasswordLaw pins THE STABLE-PASSWORD LAW (the rig's
// conviction): the password is DERIVED from the key — the same key always
// derives the same password (a pocket serve that outlives the engine stays
// adoptable across engine restarts), a different key honestly derives a
// different one (a key rotation re-spawns with the refreshed key.env).
func TestStablePasswordLaw(t *testing.T) {
        t.Setenv("DOOMALAY_OPENCODE_SERVE_PASSWORD", "")
        m1 := New("", "key-one", nil)
        m2 := New("", "key-one", nil)
        m3 := New("", "key-two", nil)
        if m1.ServerPassword() == "" || m1.ServerPassword() != m2.ServerPassword() {
                t.Fatalf("the same key must derive the same password (the adoption law)")
        }
        if m1.ServerPassword() == m3.ServerPassword() {
                t.Fatalf("a different key must derive a different password")
        }
        if len(m1.ServerPassword()) < 32 || strings.ContainsAny(m1.ServerPassword(), " \t") {
                t.Fatalf("the derived password must be a clean full HMAC hex (got %q)", m1.ServerPassword())
        }
}

// TestV1703_FreeTierWallShapes pins THE STALE WALL MATCHER fix (the
// campaign's live conviction, 2026-10-23): zen's wall message is now
// "Free usage limit reached. Connect a provider or subscribe to OpenCode
// Go to keep going, or switch models." — the old matcher ("free tier"
// only) never fired, so THE WALL WALK was dead and every walled turn
// died on the raw oc_bridge_error path. Every live phrasing matches.
func TestV1703_FreeTierWallShapes(t *testing.T) {
        walls := []string{
                "Free usage limit reached. Connect a provider or subscribe to OpenCode Go to keep going, or switch models.",
                "You've hit the free tier limit for this model",
                "free usage limit reached",
                "usage limit reached — subscribe to continue",
        }
        for _, msg := range walls {
                ev := Event{Type: "session.execution.failed", Data: eventData{Error: &eventError{Type: "provider.free-limit", Message: msg, Status: 429}}}
                if !ev.IsFreeTierError() {
                        t.Fatalf("wall message must match: %q", msg)
                }
        }
        // non-walls stay non-walls
        for _, msg := range []string{"connection refused", "model not found", ""} {
                ev := Event{Type: "session.execution.failed", Data: eventData{Error: &eventError{Message: msg}}}
                if ev.IsFreeTierError() {
                        t.Fatalf("non-wall must not match: %q", msg)
                }
        }
        // a success frame never matches
        ev := Event{Type: "session.execution.succeeded", Data: eventData{Error: &eventError{Message: "free usage limit"}}}
        if ev.IsFreeTierError() {
                t.Fatalf("a succeeded frame must never be the wall")
        }
}
