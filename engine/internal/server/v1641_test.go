package server

// v1641_test.go — v1.64.1 THE NATIVE SHELF pins (PLAN-V164 §1).
//
// THE CONVICTION (the device's own serve-side self-diagnosis, the user's
// paste): the 30 doomalay tools run at /mcp/oc/<chat-id> and answer — but
// the adopted serve session's tool schema carried ZERO of them, because an
// adoptee born before the per-chat era (or whose birth move failed) lives
// in the serve's ROOT location, whose opencode.json has no mcp block.
//
// THE LAWS PINNED HERE:
//
//   (a) THE ADOPTION RE-HOME — a persisted binding whose serve-side
//       directory is NOT the per-chat dir gets MOVED there on adoption;
//       a session already home NEVER re-moves (idempotence — no
//       location-switched transcript spam per engine restart);
//   (b) THE DIRECTORY-LESS BUILD — a serve that won't speak data.directory
//       (the pre-2.1 shape) still gets the one-shot move (known=false →
//       move once; the memory map caches);
//   (c) THE FAILED RE-HOME DEGRADES — a rejecting /move keeps the session
//       (bound=false, the honest tools block, never a broken turn);
//   (d) THE BARE-NAME PILL — doomalay_<tool> frames ride the pump as the
//       BARE name + mcpbus.DefaultSummary's operand (calculator | 17*23),
//       byte-identical to the native pills;
//   (e) THE DIRECT GRAMMAR — the {tools} block teaches doomalay_<name>
//       called DIRECTLY, never inside Code Mode's execute.

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/ScoobyBaby1999/doomalay/engine/internal/ocserve"
	"github.com/ScoobyBaby1999/doomalay/engine/internal/store"
)

// v1631Adopt runs one adoption through ocServeSessionID with a persisted
// binding already in the DB (the engine-restart shape: a fresh Server, an
// empty memory map, the binding row alive).
func v1631Adopt(t *testing.T, db *store.DB, m *ocserve.Manager, fake *fakeServe, chatID, serveSess string) (bool, bool) {
	t.Helper()
	if err := db.SetSetting(ocServeBindKey(chatID), serveSess); err != nil {
		t.Fatalf("persist binding: %v", err)
	}
	s := &Server{db: db}
	sess := &store.Session{ID: chatID, Title: "adoptee", Provider: "opencode", Model: "opencode/big-pickle"}
	_, fresh, bound, err := s.ocServeSessionID(m, sess)
	if err != nil {
		t.Fatalf("adopt: %v", err)
	}
	if fresh {
		t.Fatalf("the persisted binding must ADOPT (fresh=false) — a new session was created instead")
	}
	return bound, true
}

func TestV1641_AdoptionReHome(t *testing.T) {
	dataDir := t.TempDir()
	fake := &fakeServe{}
	srv := httptest.NewServer(http.HandlerFunc(fake.handler))
	defer srv.Close()
	m := ocserve.New(dataDir, "key", nil)
	m.SetBaseURL(srv.URL)

	// the serve holds a pre-v1.60 session (the device's shape: it EXISTS,
	// its directory is the serve ROOT — no per-chat dir, no mcp block)
	fake.mu.Lock()
	fake.sessions = map[string]bool{"ses_old_1": true}
	fake.sessionDirs = map[string]string{"ses_old_1": dataDir + "/opencode-serve"}
	fake.mu.Unlock()

	dir := t.TempDir()
	db, err := store.Open(dir)
	if err != nil {
		t.Fatalf("store: %v", err)
	}
	if err := db.Migrate(); err != nil {
		t.Fatalf("migrate: %v", err)
	}

	// ── (a) the unmoved adoptee gets RE-HOMED ──────────────────────────
	fake.mu.Lock()
	movesBefore := len(fake.moveBodies)
	fake.mu.Unlock()
	bound, _ := v1631Adopt(t, db, m, fake, "chat-rh-1", "ses_old_1")
	if !bound {
		t.Fatalf("(a) the re-homed adoption must bind (the per-chat config + the move both landed)")
	}
	fake.mu.Lock()
	moves := append([]map[string]any(nil), fake.moveBodies...)
	fake.mu.Unlock()
	if len(moves)-movesBefore != 1 {
		t.Fatalf("(a) the unmoved adoptee fires EXACTLY one move, got %d", len(moves)-movesBefore)
	}
	if d, _ := moves[len(moves)-1]["directory"].(string); !strings.HasSuffix(d, "chats/chat-rh-1/ws") {
		t.Fatalf("(a) the re-home must target the per-chat ws dir: %v", moves[len(moves)-1])
	}
	fake.mu.Lock()
	newDir := fake.sessionDirs["ses_old_1"]
	fake.mu.Unlock()
	if !strings.HasSuffix(newDir, "chats/chat-rh-1/ws") {
		t.Fatalf("(a) the serve's directory row must now point at the per-chat dir: %q", newDir)
	}

	// ── (a2) the session ALREADY home NEVER re-moves ───────────────────
	fake.mu.Lock()
	movesHome := len(fake.moveBodies)
	fake.mu.Unlock()
	bound2, _ := v1631Adopt(t, db, m, fake, "chat-rh-1", "ses_old_1")
	fake.mu.Lock()
	movesAfter := len(fake.moveBodies)
	fake.mu.Unlock()
	if !bound2 || movesAfter != movesHome {
		t.Fatalf("(a2) an at-home adoptee never re-moves (bound=%v, moves %d→%d)", bound2, movesHome, movesAfter)
	}

	// ── (b) the directory-less build still moves ONCE ──────────────────
	fake.mu.Lock()
	fake.sessions["ses_pre21"] = true
	delete(fake.sessionDirs, "ses_pre21") // the build omits data.directory
	fake.mu.Unlock()
	bound3, _ := v1631Adopt(t, db, m, fake, "chat-rh-2", "ses_pre21")
	fake.mu.Lock()
	lastDir := fake.sessionDirs["ses_pre21"]
	fake.mu.Unlock()
	if !bound3 || !strings.HasSuffix(lastDir, "chats/chat-rh-2/ws") {
		t.Fatalf("(b) the directory-less build gets the one-shot move (bound=%v dir=%q)", bound3, lastDir)
	}

	// ── (c) the FAILED re-home degrades honestly ───────────────────────
	fake.mu.Lock()
	fake.sessions["ses_rej"] = true
	fake.sessionDirs["ses_rej"] = dataDir + "/opencode-serve" // stuck at root
	fake.moveReject = true
	fake.mu.Unlock()
	bound4, _ := v1631Adopt(t, db, m, fake, "chat-rh-3", "ses_rej")
	if bound4 {
		t.Fatalf("(c) a rejected move must ride unbound (the honest tools block), not claim the binding")
	}
	fake.mu.Lock()
	fake.moveReject = false
	fake.mu.Unlock()
}

// TestV1641_BareNamePill pins the pump's bare-name law: the direct arm
// (codemode:false) names every tool doomalay_<name> on the wire — the pill
// events must speak the BARE name (calculator) with mcpbus.DefaultSummary's
// operand (the expression), byte-identical to a native pill.
func TestV1641_BareNamePill(t *testing.T) {
	t.Setenv("DOOMALAY_OPENCODE_SERVE_PASSWORD", "rig-pw")
	fake := &fakeServe{}
	srv := httptest.NewServer(http.HandlerFunc(fake.handler))
	defer srv.Close()
	m := ocserve.New("", "key", nil)
	m.SetBaseURL(srv.URL)

	fake.mu.Lock()
	fake.sse = []string{
		`data: {"id":"d0","type":"server.connected","data":{}}`,
		`data: {"id":"d1","type":"session.tool.input.started","data":{"sessionID":"ses_np","id":"call_dc1","name":"doomalay_calculator"}}`,
		`data: {"id":"d2","type":"session.tool.input.ended","data":{"sessionID":"ses_np","id":"call_dc1","text":"{\"expr\":\"17*23\"}"}}`,
		`data: {"id":"d3","type":"session.tool.success","data":{"sessionID":"ses_np","id":"call_dc1","content":[{"type":"text","text":"391"}]}}`,
		`data: {"id":"d4","type":"session.tool.input.started","data":{"sessionID":"ses_np","id":"call_ws","name":"doomalay_web_search"}}`,
		`data: {"id":"d5","type":"session.tool.input.ended","data":{"sessionID":"ses_np","id":"call_ws","text":"{\"query\":\"opencode 2.1 release notes\"}"}}`,
		`data: {"id":"d6","type":"session.tool.success","data":{"sessionID":"ses_np","id":"call_ws","content":[{"type":"text","text":"(no results)"}]}}`,
		`data: {"id":"d7","type":"session.tool.input.started","data":{"sessionID":"ses_np","id":"call_oc","name":"grep"}}`,
		`data: {"id":"d8","type":"session.tool.input.ended","data":{"sessionID":"ses_np","id":"call_oc","text":"{\"pattern\":\"TODO\"}"}}`,
		`data: {"id":"d9","type":"session.tool.success","data":{"sessionID":"ses_np","id":"call_oc","content":[{"type":"text","text":"2 matches"}]}}`,
		`data: {"id":"d10","type":"session.execution.succeeded","data":{"sessionID":"ses_np"}}`,
	}
	fake.mu.Unlock()

	var (
		mu      sync.Mutex
		useEvts []map[string]any
		resEvts []map[string]any
	)
	out := make(chan map[string]any, 64)
	done := make(chan struct{})
	go func() {
		for ev := range out {
			mu.Lock()
			switch ev["type"] {
			case "tool_use":
				useEvts = append(useEvts, ev)
			case "tool_result":
				resEvts = append(resEvts, ev)
			}
			mu.Unlock()
		}
		close(done)
	}()

	s := &Server{}
	recycled, err := s.ocServePump(context.Background(), m, "ses_np", "chat-np", "opencode/big-pickle", out, 0)
	close(out)
	<-done
	if recycled || err != nil {
		t.Fatalf("the pump must finish clean: recycled=%v err=%v", recycled, err)
	}

	mu.Lock()
	defer mu.Unlock()
	if len(useEvts) != 3 {
		t.Fatalf("three tool_use pills (calculator, web_search, grep), got %d", len(useEvts))
	}
	calc, ws, grep := useEvts[0], useEvts[1], useEvts[2]
	if calc["name"] != "calculator" {
		t.Fatalf("(d) the doomalay_ prefix must strip: %v", calc["name"])
	}
	if calc["summary"] != "17*23" {
		t.Fatalf("(d) the operand rides mcpbus.DefaultSummary (the ONE truth): %q", calc["summary"])
	}
	if ws["name"] != "web_search" || ws["summary"] != "opencode 2.1 release notes" {
		t.Fatalf("(d) the web_search pill (bare + the query): %v %v", ws["name"], ws["summary"])
	}
	if grep["name"] != "grep" || grep["summary"] != "TODO" {
		t.Fatalf("(d) the serve's OWN tools pass through untouched (bare already): %v %v", grep["name"], grep["summary"])
	}
	if len(resEvts) != 3 {
		t.Fatalf("three tool_result pills, got %d", len(resEvts))
	}
	if resEvts[0]["name"] != "calculator" || resEvts[0]["text"] != "391" {
		t.Fatalf("(d) the result pairs by id with the BARE name: %v %v", resEvts[0]["name"], resEvts[0]["text"])
	}
}

// TestV1641_ToolsBlockDirectGrammar pins the {tools} block's direct-arm
// teaching: the catalog lists doomalay_<name> (the names the MODEL must
// call), the block says DIRECTLY + never inside Code Mode's execute.
func TestV1641_ToolsBlockDirectGrammar(t *testing.T) {
	s := &Server{}
	sess := &store.Session{ID: "c1", Title: "t", Provider: "opencode", Model: "opencode/big-pickle"}
	bound := s.toolsBlockFor(sess, true, true)
	for _, want := range []string{"doomalay_calculator", "FIRST-CLASS tools", "DIRECTLY", "NOT inside Code Mode"} {
		if !strings.Contains(bound, want) {
			t.Fatalf("(e) the direct grammar must ride the tools block — missing %q: %s", want, bound[:min(200, len(bound))])
		}
	}
	if strings.Contains(bound, "tools.doomalay_") {
		t.Fatalf("(e) the Code Mode dotted grammar must be GONE from the teaching: %s", bound[:min(200, len(bound))])
	}
}
