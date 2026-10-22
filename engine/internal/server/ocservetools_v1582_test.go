package server

// ocservetools_v1582_test.go — v1.58.2 THE OPEN HANDS + THE WIDE SHELF pins
// (PLAN-V158 §2). The user's ask: "let's also add to all our default tools
// the tools that come with opencode (explore, edit, ext) so the opencode
// model may pick and choose from a wider variety, use our apps native
// tools and it's own native tools via opencode termux. All tools should
// reflect from the simple placeholder we have using our persona system
// as it currently does."
//
// THE ANSWER, live-proven before the build (v158 research): the app's tools
// are an MCP server the opencode serve attaches per-chat — each serve
// session MOVED into its own config dir (POST /api/session/{id}/move,
// live-probed) whose opencode.json points at the engine's /mcp/oc/<chat>
// route; the {tools} MIRROR block (the simple placeholder, persona system)
// carries the merged catalog honestly; the model picks from BOTH shelves.

import (
        "encoding/json"
        "net/http"
        "net/http/httptest"
        "os"
        "path/filepath"
        "strings"
        "testing"

        "github.com/ScoobyBaby1999/doomalay/engine/internal/mcpbus"
        "github.com/ScoobyBaby1999/doomalay/engine/internal/ocserve"
        "github.com/ScoobyBaby1999/doomalay/engine/internal/store"
)

// TestV1582_PerChatConfigLaw pins the per-chat binding's own bytes: the
// config dir <scratch>/chats/<chat>/opencode.json carries the doomalay MCP
// entry pointing at THIS engine's /mcp/oc/<chat> route with codemode:false
// (DIRECT tools — bare-name calls, the 1:1 pill law), oauth:false (plain
// loopback), the header belt, generous timeouts; the ws/ workspace dir
// exists (the session moves there; the config resolves from the parent).
func TestV1582_PerChatConfigLaw(t *testing.T) {
        dataDir := t.TempDir()
        m := ocserve.New(dataDir, "key", nil)
        s := &Server{cfg: nil} // the test server: the default port fallback (8080)
        dir, ok := s.ocServeChatDir(m, "chat-abc")
        if !ok {
                t.Fatalf("the per-chat dir must bind on the desktop path")
        }
        raw, err := os.ReadFile(filepath.Join(dataDir, "opencode-serve", "chats", "chat-abc", "opencode.json"))
        if err != nil {
                t.Fatalf("the per-chat config must land under the scratch: %v", err)
        }
        var cfg struct {
                MCP struct {
                        Servers map[string]struct {
                                Type     string `json:"type"`
                                URL      string `json:"url"`
                                OAuth    bool   `json:"oauth"`
                                CodeMode bool   `json:"codemode"`
                                Headers  map[string]string `json:"headers"`
                                Timeout  map[string]int   `json:"timeout"`
                        } `json:"servers"`
                } `json:"mcp"`
        }
        if err := json.Unmarshal(raw, &cfg); err != nil {
                t.Fatalf("the config must be valid JSON: %v (%s)", err, raw)
        }
        entry, ok := cfg.MCP.Servers["doomalay"]
        if !ok {
                t.Fatalf("the doomalay server entry must ride the per-chat config: %s", raw)
        }
        if entry.Type != "remote" || entry.OAuth {
                t.Fatalf("remote + oauth:false (plain loopback): %+v", entry)
        }
        if !strings.HasSuffix(entry.URL, "/mcp/oc/chat-abc") {
                t.Fatalf("the URL must carry the per-chat route: %q", entry.URL)
        }
        if entry.CodeMode != true {
                t.Fatalf("THE PROVEN ROUTE: codemode:true puts the doomalay tools in Code Mode as tools.doomalay_<tool> (live-proven 391 end-to-end; codemode:false excluded them entirely on 2.1.2 — live-convicted): %+v", entry)
        }
        if entry.Headers["X-Doomalay-Session"] != "chat-abc" {
                t.Fatalf("the header belt must ride: %+v", entry.Headers)
        }
        if entry.Timeout["execution"] < 60_000 {
                t.Fatalf("the execution timeout must be generous (artifact tools can take a while): %+v", entry.Timeout)
        }
        if dir == "" || !strings.HasSuffix(dir, "chats/chat-abc/ws") {
                t.Fatalf("the move dir must be the per-chat ws: %q", dir)
        }
        if st, err := os.Stat(dir); err != nil || !st.IsDir() {
                t.Fatalf("the ws dir must exist before the move: %v", err)
        }
}

// TestV1582_ToolsBlockLaw pins the {tools} MIRROR block's three truths:
// native chats collapse empty (zero native-prompt change), bound serve
// chats carry the merged catalog (the opencode native toolset + EVERY
// mcpbus registry name — live-built, never a static list), unbound serve
// chats carry the honest native-only note.
func TestV1582_ToolsBlockLaw(t *testing.T) {
        s := &Server{}
        sess := &store.Session{ID: "c1", Title: "t", Provider: "opencode", Model: "opencode/big-pickle"}
        if got := s.toolsBlockFor(sess, false, false); got != "" {
                t.Fatalf("native chats collapse the block: %q", got)
        }
        bound := s.toolsBlockFor(sess, true, true)
        if !strings.Contains(bound, "Never write") || !strings.Contains(bound, "ACTION") {
                t.Fatalf("the never-ACTION note must ride (the serve grammar truth): %q", bound[:min(120, len(bound))])
        }
        for _, want := range []string{"read, write, edit, patch", "subagent", "execute (Code Mode"} {
                if !strings.Contains(bound, want) {
                        t.Fatalf("the opencode native toolset must ride: missing %q", want)
                }
        }
        for _, d := range mcpbus.Defs() {
                if !strings.Contains(bound, d.Name) {
                        t.Fatalf("the merged catalog is built LIVE from the registry — %q missing", d.Name)
                }
        }
        unbound := s.toolsBlockFor(sess, true, false)
        if !strings.Contains(unbound, "NOT connected") {
                t.Fatalf("the unbound note must speak the honest truth: %q", unbound)
        }
        if strings.Contains(unbound, "calculator") {
                t.Fatalf("an unbound session must NOT advertise tools it cannot call: %q", unbound)
        }
}

// TestV1582_ServePromptCompose pins the serve compose: serveMode swaps the
// {artifacts} ACTION teaching for the serve truth, the {tools} block
// carries the bound/unbound catalog, and the NATIVE compose stays
// byte-identical to the pre-v158 law (the {tools} slot collapses empty —
// zero native-prompt change).
func TestV1582_ServePromptCompose(t *testing.T) {
        s := newMCPTestServer(t)
        sess := &store.Session{ID: "c1", Title: "Compose Chat", Provider: "opencode", Model: "opencode/big-pickle"}
        if err := s.db.CreateSession(sess); err != nil {
                t.Fatalf("create: %v", err)
        }
        serveBound := s.systemPromptForMetricsMode(sess, personaMetrics{}, "", true, true)
        if !strings.Contains(serveBound, "doomalay") || !strings.Contains(serveBound, "calculator") {
                t.Fatalf("the bound serve compose carries the merged catalog")
        }
        // the ```artifact fence protocol is reply-TEXT grammar the PWA formatter
        // extracts for every provider (the serve included) — the personas' own
        // teaching rides unchanged; the MCP tools complement it via the catalog.
        if !strings.Contains(serveBound, "ARTIFACT") && !strings.Contains(serveBound, "artifact") {
                t.Fatalf("the artifact fence protocol still rides the serve compose (one protocol everywhere)")
        }
        serveUnbound := s.systemPromptForMetricsMode(sess, personaMetrics{}, "", true, false)
        if !strings.Contains(serveUnbound, "NOT connected") {
                t.Fatalf("the unbound serve compose speaks the honest note")
        }
        native := s.systemPromptForMetricsMode(sess, personaMetrics{}, "", false, false)
        if strings.Contains(native, "Never write") || strings.Contains(native, "NOT connected") {
                t.Fatalf("the native compose never carries the serve tools block")
        }
        if strings.Contains(native, "{tools}") {
                t.Fatalf("the {tools} slot collapses clean on native: %q", native)
        }
}

// TestV1582_MCPChatRoute pins the /mcp/oc/{chatID} wrapper: a tools/call
// through the per-chat route resolves THIS chat's session turn (the fleet
// roster names the chat — the binding proof, live-probed end-to-end), and
// a bare /mcp/oc/ answers 404.
func TestV1582_MCPChatRoute(t *testing.T) {
        s := newMCPTestServer(t)
        sess := &store.Session{ID: "chat-route-1", Title: "ROUTE PROOF CHAT", Provider: "opencode", Model: "opencode/big-pickle"}
        if err := s.db.CreateSession(sess); err != nil {
                t.Fatalf("create: %v", err)
        }
        raw, _ := json.Marshal(map[string]any{
                "jsonrpc": "2.0", "id": 3, "method": "tools/call",
                "params": map[string]any{"name": "fleet", "arguments": map[string]any{"action": "roster"}},
        })
        req := httptest.NewRequest(http.MethodPost, "/mcp/oc/chat-route-1", strings.NewReader(string(raw)))
        req.Header.Set("Content-Type", "application/json")
        req.Host = "127.0.0.1"
        rec := httptest.NewRecorder()
        s.mux.ServeHTTP(rec, req)
        if rec.Code != 200 {
                t.Fatalf("the per-chat route answers 200, got %d: %s", rec.Code, rec.Body.String()[:min(200, rec.Body.Len())])
        }
        var out struct {
                Result struct {
                        Content []struct {
                                Text string `json:"text"`
                        } `json:"content"`
                        IsError bool `json:"isError"`
                } `json:"result"`
        }
        if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
                t.Fatalf("decode: %v", err)
        }
        if out.Result.IsError || len(out.Result.Content) == 0 {
                t.Fatalf("the fleet call through the per-chat route must run: %s", rec.Body.String()[:min(300, rec.Body.Len())])
        }
        if !strings.Contains(out.Result.Content[0].Text, "ROUTE PROOF CHAT") {
                t.Fatalf("THE BINDING PROOF: the roster must name THIS chat — got %q", out.Result.Content[0].Text[:min(200, len(out.Result.Content[0].Text))])
        }
        // the bare route refuses honestly
        req2 := httptest.NewRequest(http.MethodPost, "/mcp/oc/", strings.NewReader("{}"))
        req2.Host = "127.0.0.1"
        rec2 := httptest.NewRecorder()
        s.mux.ServeHTTP(rec2, req2)
        if rec2.Code != 404 {
                t.Fatalf("a chatless per-chat route must 404, got %d", rec2.Code)
        }
}

// TestV1582_SessionMcpTurnArms pins the wide shelf's engine-side arms: the
// session-bound /mcp turn now wires Fleet + Djournal (the v1.47 waves left
// the /mcp path without them — the live truth-probe's conviction).
func TestV1582_SessionMcpTurnArms(t *testing.T) {
        s := newMCPTestServer(t)
        sess := &store.Session{ID: "chat-arms-1", Title: "t", Provider: "opencode", Model: "opencode/big-pickle"}
        if err := s.db.CreateSession(sess); err != nil {
                t.Fatalf("create: %v", err)
        }
        turn := s.sessionMcpTurn("chat-arms-1")
        if turn == nil {
                t.Fatalf("the session turn must resolve for a real chat")
        }
        if turn.Fleet == nil {
                t.Fatalf("THE FLEET ARM: the /mcp session turn must wire fleet (the roster)")
        }
        if turn.Djournal == nil {
                t.Fatalf("THE JOURNAL ARM: the /mcp session turn must wire djournal")
        }
        if turn.Workspace == nil || turn.Hublib == nil || turn.Termux == nil || turn.Persona == nil || turn.Delegate == nil {
                t.Fatalf("the full app toolset must ride the session turn")
        }
        roster := turn.Fleet(nil, `{"action":"roster"}`)
        if !strings.Contains(roster, "chat-arms-1") && !strings.Contains(roster, "Title") && !strings.Contains(roster, "t") {
                t.Fatalf("the fleet arm answers the engine's own roster: %q", roster[:min(160, len(roster))])
        }
}

// TestV1582_BindingLoop pins the ocServeSessionID binding against the fake
// serve: the per-chat config is written, the session is CREATED + MOVED
// into the ws dir (the move body carries it), the bound state caches; a
// move-rejecting build degrades gracefully (the session survives,
// bound=false, never a broken turn).
func TestV1582_BindingLoop(t *testing.T) {
        dataDir := t.TempDir()
        fake := &fakeServe{}
        srv := httptest.NewServer(http.HandlerFunc(fake.handler))
        defer srv.Close()
        m := ocserve.New(dataDir, "key", nil)
        m.SetBaseURL(srv.URL)
        s := &Server{ocServeSessions: map[string]string{}, ocServeBound: map[string]bool{}}
        sess := &store.Session{ID: "chat-bind-1", Title: "Binding", Provider: "opencode", Model: "opencode/big-pickle"}

        id, fresh, bound, err := s.ocServeSessionID(m, sess)
        if err != nil || !fresh {
                t.Fatalf("the first ask creates + binds: id=%q fresh=%v err=%v", id, fresh, err)
        }
        if !bound {
                t.Fatalf("a healthy move must bind")
        }
        fake.mu.Lock()
        moves := append([]map[string]any(nil), fake.moveBodies...)
        fake.mu.Unlock()
        if len(moves) != 1 {
                t.Fatalf("exactly one move fires per fresh session, got %d", len(moves))
        }
        if d, _ := moves[0]["directory"].(string); !strings.HasSuffix(d, "chats/chat-bind-1/ws") {
                t.Fatalf("the move must target the per-chat ws dir: %v", moves[0])
        }
        if _, err := os.Stat(filepath.Join(dataDir, "opencode-serve", "chats", "chat-bind-1", "opencode.json")); err != nil {
                t.Fatalf("the per-chat config must exist: %v", err)
        }
        // the cache: the second ask neither creates nor moves
        id2, fresh2, bound2, err2 := s.ocServeSessionID(m, sess)
        if err2 != nil || fresh2 || id2 != id || !bound2 {
                t.Fatalf("the cached binding: id2=%q fresh2=%v bound2=%v err2=%v", id2, fresh2, bound2, err2)
        }
        fake.mu.Lock()
        n2 := len(fake.moveBodies)
        fake.mu.Unlock()
        if n2 != 1 {
                t.Fatalf("the cached session never re-moves, got %d", n2)
        }
        // the graceful degradation: a move-rejecting serve keeps the session
        s2 := &Server{ocServeSessions: map[string]string{}, ocServeBound: map[string]bool{}}
        fake.mu.Lock()
        fake.moveReject = true
        fake.mu.Unlock()
        sess2 := &store.Session{ID: "chat-degrade", Title: "D", Provider: "opencode", Model: "opencode/big-pickle"}
        id3, fresh3, bound3, err3 := s2.ocServeSessionID(m, sess2)
        if err3 != nil || !fresh3 || id3 == "" || bound3 {
                t.Fatalf("THE GRACEFUL DEGRADATION: the session survives unbound (id=%q fresh=%v bound=%v err=%v)", id3, fresh3, bound3, err3)
        }
}

// TestV1582_WriteServeFileLaw pins the scratch write law: the desktop path
// lands under the serve's scratch, the escaping paths refuse (the jail law).
func TestV1582_WriteServeFileLaw(t *testing.T) {
        dataDir := t.TempDir()
        m := ocserve.New(dataDir, "key", nil)
        if err := m.WriteServeFile("chats/x/opencode.json", "{}"); err != nil {
                t.Fatalf("the desktop write: %v", err)
        }
        if _, err := os.Stat(filepath.Join(dataDir, "opencode-serve", "chats", "x", "opencode.json")); err != nil {
                t.Fatalf("the file must land under the scratch: %v", err)
        }
        for _, bad := range []string{"../escape.json", "/abs.json"} {
                if err := m.WriteServeFile(bad, "{}"); err == nil {
                        t.Fatalf("the escaping path %q must refuse", bad)
                }
        }
        if _, err := m.ServeDir("chats/x"); err != nil {
                t.Fatalf("the desktop serve dir resolves: %v", err)
        }
        if dir, _ := m.ServeDir("chats/x"); !filepath.IsAbs(dir) {
                t.Fatalf("the serve dir must be absolute (the move API needs it): %q", dir)
        }
        if _, err := m.ServeDir("../escape"); err == nil {
                t.Fatalf("the escaping serve dir must refuse")
        }
}

// TestV1582_OpeningTextToolsLaw pins the opening composer's tools truth:
// bound openings carry the merged catalog, unbound openings carry the
// honest note — and the in-flight trim law survives both.
func TestV1582_OpeningTextToolsLaw(t *testing.T) {
        s := newMCPTestServer(t)
        sess := &store.Session{ID: "chat-open-1", Title: "Opening", Provider: "opencode", Model: "opencode/big-pickle", SlidingWindow: 40}
        if err := s.db.CreateSession(sess); err != nil {
                t.Fatalf("create: %v", err)
        }
        bound := s.ocServeOpeningText(sess, "hello there", true)
        if !strings.Contains(bound, "calculator") || !strings.Contains(bound, "Never write") {
                t.Fatalf("the bound opening carries the merged catalog + the never-ACTION note")
        }
        if n := strings.Count(bound, "hello there"); n != 1 {
                t.Fatalf("the user text rides once: %d", n)
        }
        unbound := s.ocServeOpeningText(sess, "hello again", false)
        if !strings.Contains(unbound, "NOT connected") || strings.Contains(unbound, "calculator") {
                t.Fatalf("the unbound opening speaks the honest note without the catalog")
        }
}

// min mirrors the builtin for the older toolchain used by some rigs.
func min(a, b int) int {
        if a < b {
                return a
        }
        return b
}
