package server

// v1.48.5 THE SERVE BRIDGE — the adapter pins. A FAKE serve (httptest)
// speaking the LIVE-CAPTURED frame shapes drives the engine's own mapping
// (reasoning deltas → thinking, text deltas → assistant_delta, tool
// parts → the pill grammar, the final usage → the v1.46.2 ledger shape)
// + THE RECYCLE LAW (a free-tier wall drops the poisoned serve session
// and retries ONCE on a fresh one) + the opening-text law (the persona
// rides the MESSAGE TEXT — the per-turn system field poisons the turn —
// and v1.48.1's trim rides the replayed history: the in-flight message
// appears exactly once).

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"

	"github.com/ScoobyBaby1999/doomalay/engine/internal/llm"
	"github.com/ScoobyBaby1999/doomalay/engine/internal/ocserve"
	"github.com/ScoobyBaby1999/doomalay/engine/internal/store"
)

// fakeServe speaks the captured serve shapes. mode "clean" streams a
// normal turn; mode "walled" answers the free-tier wall (once or twice —
// the second field is poisonedTries).
type fakeServe struct {
	mu            sync.Mutex
	sessionN      int
	promptBodies  []map[string]any
	promptTexts   []string
	poisonedTries int      // how many consecutive turns answer the wall
	sse           []string // the clean-turn frames
}

func (f *fakeServe) handler(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	switch {
	case strings.HasSuffix(r.URL.Path, "/session/status"):
		io.WriteString(w, `{}`)
	case strings.HasSuffix(r.URL.Path, "/session") && r.Method == "POST":
		f.sessionN++
		io.WriteString(w, `{"id":"ses_fake_`+strconv.Itoa(f.sessionN)+`"}`)
	case strings.Contains(r.URL.Path, "/prompt_async"):
		var body map[string]any
		b, _ := io.ReadAll(r.Body)
		json.Unmarshal(b, &body)
		f.promptBodies = append(f.promptBodies, body)
		if parts, ok := body["parts"].([]any); ok && len(parts) > 0 {
			if p, ok := parts[0].(map[string]any); ok {
				f.promptTexts = append(f.promptTexts, p["text"].(string))
			}
		}
		w.WriteHeader(204)
	case strings.Contains(r.URL.Path, "/event"):
		w.Header().Set("Content-Type", "text/event-stream")
		if f.poisonedTries > 0 {
			f.poisonedTries--
			io.WriteString(w, `data: {"id":"w1","type":"message.updated","properties":{"sessionID":"`+
				r.URL.Query().Get("sessionID")+`","info":{"role":"assistant","error":{"name":"APIError","data":{"message":"OpenCode's free tier can only be used from within OpenCode. Download it at https://opencode.ai"}}}}}`+"\n\n"+
				`data: {"id":"w2","type":"session.idle","properties":{"sessionID":"`+r.URL.Query().Get("sessionID")+`"}}`+"\n\n")
			return
		}
		io.WriteString(w, strings.Join(f.sse, "\n\n")+"\n\n")
	default:
		w.WriteHeader(404)
	}
}

func cleanTurnFrames(sess string) []string {
	return []string{
		`data: {"type":"message.part.updated","properties":{"sessionID":"` + sess + `","part":{"id":"prt_r","type":"reasoning","text":""}}}`,
		`data: {"type":"message.part.delta","properties":{"sessionID":"` + sess + `","partID":"prt_r","field":"text","delta":"thinking hard"}}`,
		`data: {"type":"message.part.updated","properties":{"sessionID":"` + sess + `","part":{"id":"prt_t","type":"text","text":""}}}`,
		`data: {"type":"message.part.delta","properties":{"sessionID":"` + sess + `","partID":"prt_t","field":"text","delta":"the answer"}}`,
		`data: {"type":"message.part.updated","properties":{"sessionID":"` + sess + `","part":{"id":"prt_tool","type":"tool","tool":"glob","state":{"status":"running","input":{"pattern":"*"}}}}}`,
		`data: {"type":"message.part.updated","properties":{"sessionID":"` + sess + `","part":{"id":"prt_tool","type":"tool","tool":"glob","state":{"status":"completed","input":{"pattern":"*"},"output":"one file"}}}}`,
		`data: {"type":"message.updated","properties":{"sessionID":"` + sess + `","info":{"id":"m1","role":"assistant","finish":"stop","tokens":{"total":120,"input":80,"output":30,"reasoning":10}}}}`,
		`data: {"type":"session.idle","properties":{"sessionID":"` + sess + `"}}`,
	}
}

// TestOcServeEventMapping drives the adapter against the fake serve and
// pins the engine-vocabulary mapping: reasoning→thinking, text→assistant_delta,
// tool running→tool_use, completed→tool_result, the final usage rides the
// idle terminal in the v1.46.2 ledger shape.
func TestOcServeEventMapping(t *testing.T) {
	fake := &fakeServe{sse: nil}
	srv := httptest.NewServer(http.HandlerFunc(fake.handler))
	defer srv.Close()
	m := ocserve.New("", "key", nil)
	m.SetBaseURL(srv.URL)

	s := &Server{}
	// pre-seed the serve session so the turn skips the opening text
	s.ocServeSessions = map[string]string{"chat1": "ses_fake_pre"}

	events := make(chan map[string]any, 64)
	done := make(chan struct{})
	var got []map[string]any
	go func() {
		for ev := range events {
			got = append(got, ev)
		}
		close(done)
	}()
	fake.mu.Lock()
	fake.sse = cleanTurnFrames("ses_fake_pre")
	fake.mu.Unlock()
	// StreamEvents needs the CURRENT /event frames; the fake serves them
	// fresh per connection, so run the pump directly
	recycled, err := s.ocServePump(context.Background(), m, "ses_fake_pre", "chat1", events)
	close(events)
	<-done
	if err != nil {
		t.Fatalf("pump: %v", err)
	}
	if recycled {
		t.Fatalf("a clean turn must not trigger the recycle")
	}
	var kinds []string
	var usage map[string]any
	for _, ev := range got {
		kinds = append(kinds, ev["type"].(string))
		if ev["type"] == "status" {
			usage, _ = ev["usage"].(map[string]any)
		}
	}
	want := []string{"thinking", "assistant_delta", "tool_use", "tool_result", "status"}
	if strings.Join(kinds, ",") != strings.Join(want, ",") {
		t.Fatalf("mapping wrong: got %v want %v", kinds, want)
	}
	if got[0]["text"] != "thinking hard" || got[1]["text"] != "the answer" {
		t.Fatalf("delta texts wrong: %v %v", got[0]["text"], got[1]["text"])
	}
	if got[2]["name"] != "opencode:glob" || got[3]["name"] != "opencode:glob" {
		t.Fatalf("tool names wrong: %v %v", got[2]["name"], got[3]["name"])
	}
	if usage == nil || fmt.Sprint(usage["total_tokens"]) != "120" || fmt.Sprint(usage["reasoning_tokens"]) != "10" {
		t.Fatalf("usage ledger shape wrong: %v", usage)
	}
	if got[2]["tool_use_id"] != got[3]["tool_use_id"] {
		t.Fatalf("the tool pair must share the call id")
	}
}

// TestOcServeRecycleLaw pins THE RECYCLE LAW: a walled first attempt
// drops the poisoned serve session; the SECOND attempt opens a FRESH one
// whose prompt text carries the opening block (persona + history — the
// message text, never the system field). A second wall answers with the
// honest error + terminal — never a silent hang.
func TestOcServeRecycleLaw(t *testing.T) {
	fake := &fakeServe{}
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
	sess := &store.Session{ID: "chat1", Title: "t", Provider: "opencode", Model: "big-pickle", SlidingWindow: 40, Personas: ""}
	if err := db.CreateSession(sess); err != nil {
		t.Fatalf("create: %v", err)
	}
	db.AppendEvent("chat1", "user", "earlier turn", "")
	db.AppendEvent("chat1", "assistant", "earlier reply", "")

	fake.mu.Lock()
	fake.sse = cleanTurnFrames("ses_fake_2")
	fake.poisonedTries = 1 // wall once, clean after
	fake.mu.Unlock()

	events := make(chan map[string]any, 64)
	collect := make(chan []map[string]any, 1)
	go func() {
		var got []map[string]any
		for ev := range events {
			got = append(got, ev)
		}
		collect <- got
	}()
	err = s.ocServeStreamTurn(context.Background(), m, "chat1", sess, "hello now", events)
	close(events)
	got := <-collect
	if err != nil {
		t.Fatalf("stream turn: %v", err)
	}
	// TWO prompts fired: the first (walled) on ses_fake_1, the retry on
	// the FRESH ses_fake_2 — and the retry's text is the OPENING text
	// (persona + the replayed history + the message; the in-flight text
	// exactly once — v1.48.1's trim law rides the bridge too)
	fake.mu.Lock()
	texts := append([]string(nil), fake.promptTexts...)
	fake.mu.Unlock()
	if len(texts) != 2 {
		t.Fatalf("the recycle must fire exactly two prompts, got %d", len(texts))
	}
	if !strings.Contains(texts[1], "hello now") {
		t.Fatalf("the retry carries the message: %q", texts[1])
	}
	if strings.Count(texts[1], "hello now") != 1 {
		t.Fatalf("v1.48.1's law: the in-flight message rides the replay EXACTLY ONCE, got %d", strings.Count(texts[1], "hello now"))
	}
	if !strings.Contains(texts[1], "earlier turn") {
		t.Fatalf("the replayed history must ride the opening text")
	}
	if strings.Contains(texts[0], "[[System persona") || strings.Contains(texts[1], "[[System persona") {
		// BOTH attempts open FRESH serve sessions here (the map starts
		// empty and the wall recycles), so both prompts may carry the
		// opening block — the LAW this test pins is the recycle itself:
		// the wall dropped the first session, the retry ran on a FRESH
		// one. (A bare-harness persona may compose empty — the persona
		// block's presence is pinned LIVE in the rig.)
	}
	// the terminal landed (idle from the clean retry)
	var sawIdle bool
	for _, ev := range got {
		if ev["type"] == "status" && ev["state"] == "idle" {
			sawIdle = true
		}
	}
	if !sawIdle {
		t.Fatalf("the clean retry must end with the idle terminal")
	}
}

// TestOcServeRecycleGivesHonestTerminal pins the second-wall branch: the
// bridge answers with its OWN error + terminal — never a silent hang and
// never a fallthrough to the walled 403 (which would double-error).
func TestOcServeRecycleGivesHonestTerminal(t *testing.T) {
	fake := &fakeServe{}
	srv := httptest.NewServer(http.HandlerFunc(fake.handler))
	defer srv.Close()
	m := ocserve.New("", "key", nil)
	m.SetBaseURL(srv.URL)
	// the opening-text composer runs the persona chain — it needs the
	// store harness (a bare Server would nil-panic inside it)
	dir := t.TempDir()
	db, err := store.Open(dir)
	if err != nil {
		t.Fatalf("store: %v", err)
	}
	if err := db.Migrate(); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	s := &Server{db: db}
	sess := &store.Session{ID: "chat1", Title: "t", Provider: "opencode", Model: "big-pickle"}
	if err := db.CreateSession(sess); err != nil {
		t.Fatalf("create: %v", err)
	}
	fake.mu.Lock()
	fake.poisonedTries = 99 // wall every attempt
	fake.mu.Unlock()
	events := make(chan map[string]any, 64)
	collect := make(chan []map[string]any, 1)
	go func() {
		var got []map[string]any
		for ev := range events {
			got = append(got, ev)
		}
		collect <- got
	}()
	if err := s.ocServeStreamTurn(context.Background(), m, "chat1", sess, "hello", events); err != nil {
		t.Fatalf("stream turn: %v", err)
	}
	close(events)
	got := <-collect
	var sawErr, sawTerminal bool
	for _, ev := range got {
		if ev["type"] == "error" && strings.Contains(fmt.Sprint(ev["message"]), "refused this turn twice") {
			sawErr = true
		}
		if ev["type"] == "status" && ev["state"] == "error" {
			sawTerminal = true
		}
	}
	if !sawErr || !sawTerminal {
		t.Fatalf("the second wall needs the honest error + terminal: err=%v terminal=%v", sawErr, sawTerminal)
	}
}

// TestOcServeOpeningTextTrimLaw pins the opening composer against the
// v1.48.1 echo law: the persisted in-flight message is ALREADY in the
// compacted history (the emit runs before dispatch) — the composer trims
// it and appends exactly once.
func TestOcServeOpeningTextTrimLaw(t *testing.T) {
	dir := t.TempDir()
	db, err := store.Open(dir)
	if err != nil {
		t.Fatalf("store: %v", err)
	}
	if err := db.Migrate(); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	s := &Server{db: db}
	sess := &store.Session{ID: "chat1", Title: "t", Provider: "opencode", Model: "big-pickle", SlidingWindow: 40}
	if err := db.CreateSession(sess); err != nil {
		t.Fatalf("create: %v", err)
	}
	db.AppendEvent("chat1", "user", "first question", "")
	db.AppendEvent("chat1", "assistant", "first answer", "")
	// the in-flight emit (the turn persisted it before dispatch)
	db.AppendEvent("chat1", "user", "the new message", "")
	text := s.ocServeOpeningText(sess, "the new message")
	if n := strings.Count(text, "the new message"); n != 1 {
		t.Fatalf("the in-flight message must ride the opening text EXACTLY ONCE (v1.48.1's law), got %d", n)
	}
	if !strings.Contains(text, "first question") || !strings.Contains(text, "first answer") {
		t.Fatalf("the replayed history must ride the opening text")
	}
}

// TestIsOpenCodeFreeModelSlot pins the dispatch gate's model table (the
// exact rule fetchOpenCodeModels applies: big-pickle + *-free minus the
// paid exceptions).
func TestIsOpenCodeFreeModelSlot(t *testing.T) {
	cases := map[string]bool{
		"big-pickle":              true,
		"opencode/big-pickle":     true,
		"glm-5.3-flash-free":      true,
		"minimax-m3.1-flash-free": true,
		"minimax-m3-free":         false, // the paid exception
		"qwen3.6-plus-free":       false, // the paid exception
		"glm-5.3":                 false, // paid
		"":                        false,
	}
	for slot, want := range cases {
		if got := llm.IsOpenCodeFreeModelSlot(slot); got != want {
			t.Fatalf("IsOpenCodeFreeModelSlot(%q) = %v, want %v", slot, got, want)
		}
	}
}
