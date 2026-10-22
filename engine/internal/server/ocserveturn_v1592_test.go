package server

// v1.59.2 THE SERVE MEMORY — the binding's whole life, pinned against the
// protocol-honest fake serve (the live-probed 2.1.2 shapes: GET
// /api/session/{id} → 200 {data:{id}} / 404 SessionNotFoundError; DELETE
// /api/session/{id} → 204):
//
//   (a) a fresh chat's turn CREATES the serve session and PERSISTS the
//       binding (chat.ocserve.<sid> in the engine DB);
//   (b) an ENGINE RESTART (a fresh Server — empty memory map, SAME DB)
//       ADOPTS the binding: zero new POST /api/session, and the prompt
//       carries ONLY the user text (no "[[Conversation so far" recap —
//       the serve's own durable history IS the context; the model keeps
//       its thinking);
//   (c) a DEAD binding (the serve lost the session) self-heals: a fresh
//       session + the opening text ONCE;
//   (d) the recycle law drops the PERSISTED binding too (a poisoned
//       session must never be re-adopted after a restart);
//   (e) deleting the chat drops the binding row AND issues the serve-side
//       DELETE when the bridge is healthy — and NEVER spawns when it is
//       down (the no-long-hold law).

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/ScoobyBaby1999/doomalay/engine/internal/ocserve"
	"github.com/ScoobyBaby1999/doomalay/engine/internal/store"
)

// v1592Turn runs one ocServeStreamTurn and collects the emitted events.
func v1592Turn(t *testing.T, s *Server, m *ocserve.Manager, sess *store.Session, text string) []map[string]any {
	t.Helper()
	events := make(chan map[string]any, 64)
	collect := make(chan []map[string]any, 1)
	go func() {
		var got []map[string]any
		for ev := range events {
			got = append(got, ev)
		}
		collect <- got
	}()
	if err := s.ocServeStreamTurn(context.Background(), m, sess.ID, sess, text, events); err != nil {
		t.Fatalf("stream turn: %v", err)
	}
	close(events)
	return <-collect
}

func TestV1592_ServeMemoryBinding(t *testing.T) {
	t.Setenv("DOOMALAY_OPENCODE_SERVE_PASSWORD", "rig-pw")
	fake := &fakeServe{}
	srv := httptest.NewServer(http.HandlerFunc(fake.handler))
	defer srv.Close()

	dir := t.TempDir()
	db, err := store.Open(dir)
	if err != nil {
		t.Fatalf("store: %v", err)
	}
	if err := db.Migrate(); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	sess := &store.Session{ID: "chatA", Title: "t", Provider: "opencode", Model: "big-pickle", SlidingWindow: 40}
	if err := db.CreateSession(sess); err != nil {
		t.Fatalf("create: %v", err)
	}
	db.AppendEvent("chatA", "user", "the earlier turn", "")

	// ── (a) the first turn: CREATE + PERSIST ─────────────────────────
	m1 := ocserve.New("", "key", nil)
	m1.SetBaseURL(srv.URL)
	s1 := &Server{db: db}
	fake.mu.Lock()
	fake.sse = cleanTurnFrames("ses_fake_1")
	fake.mu.Unlock()
	v1592Turn(t, s1, m1, sess, "hello one")

	fake.mu.Lock()
	createsAfterFirst := fake.sessionN
	promptsAfterFirst := len(fake.promptTexts)
	fake.mu.Unlock()
	if createsAfterFirst != 1 {
		t.Fatalf("(a) the first turn must CREATE exactly one serve session, got %d", createsAfterFirst)
	}
	bound := s1.ocServeBindingGet("chatA")
	if bound == "" {
		t.Fatalf("(a) the binding must PERSIST (chat.ocserve.chatA)")
	}
	if bound != "ses_fake_1" {
		t.Fatalf("(a) the binding must hold the created session: %q", bound)
	}
	fake.mu.Lock()
	firstText := fake.promptTexts[0]
	fake.mu.Unlock()
	if !strings.Contains(firstText, "the earlier turn") {
		t.Fatalf("(a) a FRESH session's first prompt is the opening text (history recap rides it)")
	}

	// ── (b) the ENGINE RESTART: a fresh Server, same DB — ADOPTION ──
	m2 := ocserve.New("", "key", nil)
	m2.SetBaseURL(srv.URL)
	s2 := &Server{db: db} // the memory map is EMPTY — the restart
	fake.mu.Lock()
	fake.sse = cleanTurnFrames("ses_fake_1") // the ADOPTED session's feed
	fake.mu.Unlock()
	v1592Turn(t, s2, m2, sess, "hello two")

	fake.mu.Lock()
	createsAfterSecond := fake.sessionN
	textsAfterSecond := append([]string(nil), fake.promptTexts...)
	fake.mu.Unlock()
	if createsAfterSecond != 1 {
		t.Fatalf("(b) the restart must ADOPT the bound session — zero new POST /api/session, got %d", createsAfterSecond)
	}
	if len(textsAfterSecond) != promptsAfterFirst+1 {
		t.Fatalf("(b) exactly one new prompt, got %d", len(textsAfterSecond)-promptsAfterFirst)
	}
	secondText := textsAfterSecond[len(textsAfterSecond)-1]
	if secondText != "hello two" {
		t.Fatalf("(b) the adopted turn's prompt is ONLY the user text (no recap — the serve's own history is the context): %q", secondText)
	}
	if strings.Contains(secondText, "Conversation so far") {
		t.Fatalf("(b) the recap must NEVER ride an adopted turn")
	}
	// the adoption also re-seeded the memory map
	if s2.ocServeSessions["chatA"] != "ses_fake_1" {
		t.Fatalf("(b) the memory map must re-seed from the adoption")
	}

	// ── (c) the DEAD binding: self-heal fresh + the opening text ────
	fake.mu.Lock()
	delete(fake.sessions, "ses_fake_1") // the serve lost it (storage wiped)
	fake.sse = cleanTurnFrames("ses_fake_2")
	fake.mu.Unlock()
	s3 := &Server{db: db} // another restart
	v1592Turn(t, s3, m2, sess, "hello three")

	fake.mu.Lock()
	createsAfterThird := fake.sessionN
	textsAfterThird := append([]string(nil), fake.promptTexts...)
	fake.mu.Unlock()
	if createsAfterThird != 2 {
		t.Fatalf("(c) a dead binding births ONE fresh session, got %d", createsAfterThird)
	}
	thirdText := textsAfterThird[len(textsAfterThird)-1]
	if !strings.Contains(thirdText, "hello three") || !strings.Contains(thirdText, "the earlier turn") {
		t.Fatalf("(c) the self-healed fresh turn rides the opening text (recap + message): %q", thirdText)
	}
	if s3.ocServeBindingGet("chatA") != "ses_fake_2" {
		t.Fatalf("(c) the fresh binding must replace the dead one")
	}

	// ── (d) the recycle law drops the PERSISTED binding ─────────────
	s3.ocServeForgetSession("chatA")
	if s3.ocServeBindingGet("chatA") != "" {
		t.Fatalf("(d) the recycle must drop the persisted binding (a poisoned session must never be re-adopted)")
	}

	// ── (e) the DELETE path: serve-side cleanup when healthy ────────
	s3.ocServeMu.Lock()
	s3.ocServe = m2 // a healthy bridge is already up
	s3.ocServeMu.Unlock()
	// re-bind so the delete has something to clean
	if err := db.SetSetting(ocServeBindKey("chatA"), "ses_fake_2"); err != nil {
		t.Fatalf("rebind: %v", err)
	}
	s3.dropOcServeBinding("chatA")
	fake.mu.Lock()
	deletes := append([]string(nil), fake.deletes...)
	fake.mu.Unlock()
	if len(deletes) != 1 || deletes[0] != "ses_fake_2" {
		t.Fatalf("(e) the healthy-bridge delete must issue the serve-side DELETE for the bound session: %v", deletes)
	}
	if s3.ocServeBindingGet("chatA") != "" {
		t.Fatalf("(e) the binding row must die with the chat")
	}
	if _, ok := s3.ocServeSessions["chatA"]; ok {
		t.Fatalf("(e) the memory map entry must die with the chat")
	}

	// ── (e2) the bridge-down delete NEVER spawns ─────────────────────
	s4 := &Server{db: db}
	if err := db.SetSetting(ocServeBindKey("chatB"), "ses_never_existed"); err != nil {
		t.Fatalf("rebind b: %v", err)
	}
	t0 := fakeNow()
	s4.dropOcServeBinding("chatB")
	if el := fakeNow() - t0; el > 2_000_000_000 { // nanoseconds — a spawn would take seconds
		t.Fatalf("(e2) a bridge-down delete must return instantly, took %dns", el)
	}
	fake.mu.Lock()
	createsFinal := fake.sessionN
	fake.mu.Unlock()
	if createsFinal != 2 {
		t.Fatalf("(e2) a bridge-down delete must NEVER create a serve session, got %d", createsFinal)
	}
	if s4.ocServeBindingGet("chatB") != "" {
		t.Fatalf("(e2) the binding row still dies (the truth first)")
	}
}

// fakeNow is the (e2) timing probe's clock (nanoseconds).
func fakeNow() int64 { return time.Now().UnixNano() }

// TestV1592_NoHangGuard pins THE NO-HANG GUARD: the 2.x global /api/event
// stream is VOLATILE (events fired before the stream connects are missed),
// and a turn that fails between the prompt POST and the stream's connect
// never lands on the wire — the old pump spun FOREVER (the eternal spinner,
// live-convicted against the real 2.1.2 with the real key: a no-route
// failure fired within ~5ms of the prompt). The guard polls the session's
// own durable record on silence and synthesizes the honest terminal:
//
//	(a) the instant FAILURE → the honest error + terminal within ~2 probes;
//	(b) the instant SUCCESS (a stream that missed the whole turn) → the
//	    assistant text + the idle terminal.
func TestV1592_NoHangGuard(t *testing.T) {
	t.Setenv("DOOMALAY_OPENCODE_SERVE_PASSWORD", "rig-pw")
	fake := &fakeServe{volatileMiss: true}
	srv := httptest.NewServer(http.HandlerFunc(fake.handler))
	defer srv.Close()
	m := ocserve.New("", "key", nil)
	m.SetBaseURL(srv.URL)

	dir := t.TempDir()
	db, err := store.Open(dir)
	if err != nil {
		t.Fatalf("store: %v", err)
	}
	if err := db.Migrate(); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	s := &Server{db: db}
	sess := &store.Session{ID: "chatHang", Title: "t", Provider: "opencode", Model: "big-pickle", SlidingWindow: 40}
	if err := db.CreateSession(sess); err != nil {
		t.Fatalf("create: %v", err)
	}

	// the fast probe clock (the production 12s is honest on-device; the
	// rig proves the mechanism, not the patience)
	orig := ocServeSilenceProbe
	ocServeSilenceProbe = 150 * time.Millisecond
	defer func() { ocServeSilenceProbe = orig }()

	// (a) the instant FAILURE — the full real flow (create + select +
	// prompt + pump); the turn must END with the honest pair, never hang
	done := make(chan []map[string]any, 1)
	go func() {
		events := make(chan map[string]any, 64)
		var got []map[string]any
		go func() {
			for ev := range events {
				got = append(got, ev)
			}
			done <- got
		}()
		if err := s.ocServeStreamTurn(context.Background(), m, "chatHang", sess, "hello", events); err != nil {
			t.Errorf("(a) stream turn: %v", err)
		}
		close(events)
	}()
	var gotA []map[string]any
	select {
	case gotA = <-done:
	case <-time.After(6 * time.Second):
		t.Fatalf("(a) THE HANG: the turn never ended on the off-wire failure — the eternal spinner is back")
	}
	var sawErr, sawTerminal bool
	var errMsg string
	for _, ev := range gotA {
		if ev["type"] == "error" {
			sawErr = true
			errMsg, _ = ev["message"].(string)
		}
		if ev["type"] == "status" && ev["state"] == "error" {
			sawTerminal = true
		}
	}
	if !sawErr || !sawTerminal {
		t.Fatalf("(a) the honest failure pair must land: error=%v terminal=%v", sawErr, sawTerminal)
	}
	if !strings.Contains(errMsg, "No route for model") {
		t.Fatalf("(a) the serve's own error message must ride: %q", errMsg)
	}

	// (b) the off-wire SUCCESS — the whole turn missed the stream; the
	// durable record carries the assistant text + the idle marker
	fake.mu.Lock()
	fake.volatileMiss = false
	fake.volatileOK = true
	fake.mu.Unlock()
	done2 := make(chan []map[string]any, 1)
	go func() {
		events := make(chan map[string]any, 64)
		var got []map[string]any
		go func() {
			for ev := range events {
				got = append(got, ev)
			}
			done2 <- got
		}()
		if err := s.ocServeStreamTurn(context.Background(), m, "chatHang", sess, "hello again", events); err != nil {
			t.Errorf("(b) stream turn: %v", err)
		}
		close(events)
	}()
	var gotB []map[string]any
	select {
	case gotB = <-done2:
	case <-time.After(6 * time.Second):
		t.Fatalf("(b) THE HANG: the off-wire success never resolved")
	}
	var sawAssistant, sawIdle bool
	var ansText string
	for _, ev := range gotB {
		if ev["type"] == "assistant" {
			sawAssistant = true
			ansText, _ = ev["text"].(string)
		}
		if ev["type"] == "status" && ev["state"] == "idle" {
			sawIdle = true
		}
	}
	if !sawAssistant || !strings.Contains(ansText, "off-wire answer") {
		t.Fatalf("(b) the off-wire assistant text must land: %q", ansText)
	}
	if !sawIdle {
		t.Fatalf("(b) the idle terminal must land")
	}
}
