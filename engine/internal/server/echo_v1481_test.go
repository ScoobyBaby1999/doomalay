package server

// v1.48.1 THE SINGLE ECHO — the regression pin. The user's report: "the
// users messages send twice when talking to bots. Each user message is
// duplicate and sent twice." Root cause: handleTurn persists the user
// event (emit) BEFORE buildHistoryCompacted runs, so the history already
// carried the in-flight message; the direct-path append (chat.go) and the
// brain's own append (agent.py, the v0.38 contract) each supplied it a
// SECOND time — every user message reached the model twice on every
// provider. These pins run the REAL order (persist → build → trim →
// append) and assert the message rides exactly once, plus the trim's
// conservative law table (never a dropped history byte).

import (
	"testing"

	"github.com/ScoobyBaby1999/doomalay/engine/internal/llm"
	"github.com/ScoobyBaby1999/doomalay/engine/internal/store"
)

// seedEchoSession opens a store, creates a session, and seeds two full
// prior turns through the SAME append path the engine's emit uses.
func seedEchoSession(t *testing.T) (*Server, *store.Session) {
	t.Helper()
	dir := t.TempDir()
	db, err := store.Open(dir)
	if err != nil {
		t.Fatalf("store: %v", err)
	}
	if err := db.Migrate(); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	sess := &store.Session{ID: "s1", Title: "t", SlidingWindow: 40}
	if err := db.CreateSession(sess); err != nil {
		t.Fatalf("create: %v", err)
	}
	db.AppendEvent("s1", "user", "hello there", "")
	db.AppendEvent("s1", "assistant", "hi! what can I do?", "")
	db.AppendEvent("s1", "user", "what is 2+2?", "")
	db.AppendEvent("s1", "assistant", "4", "")
	return &Server{db: db}, sess
}

// countEcho counts exact-content user rows in a history slice.
func countEcho(hist []llm.Message, text string) int {
	n := 0
	for _, m := range hist {
		if m.Role == "user" && m.Content == text {
			n++
		}
	}
	return n
}

// TestSingleEchoDirectPath runs the REAL turn order — persist the user
// event, build the compacted history, trim, append — and pins that the
// in-flight message reaches the model EXACTLY ONCE as the final row.
func TestSingleEchoDirectPath(t *testing.T) {
	s, sess := seedEchoSession(t)
	const inFlight = "now tell me a joke"
	// the emit's persist (chat.go: the turn writes the user row first)
	db := s.db
	db.AppendEvent("s1", "user", inFlight, "")

	history := s.buildHistoryCompacted("s1", sess, 40)
	// the pre-fix flip, documented: without the trim the naive append
	// doubled the message (the user's exact symptom, at the model).
	if n := countEcho(history, inFlight); n != 1 {
		t.Fatalf("pre-trim: expected the log's single copy, got %d", n)
	}
	if got := append(trimInFlightUser(history, inFlight), llm.Message{Role: "user", Content: inFlight}); true {
		if n := countEcho(got, inFlight); n != 1 {
			t.Fatalf("THE ECHO SURVIVED: in-flight message rides %d times, want exactly 1", n)
		}
		if len(got) == 0 || got[len(got)-1].Content != inFlight {
			t.Fatalf("the in-flight message must be the FINAL model-facing row")
		}
		// prior turns byte-intact
		if got[0].Content != "hello there" || got[2].Content != "what is 2+2?" {
			t.Fatalf("prior history damaged by the trim: %q / %q", got[0].Content, got[2].Content)
		}
		if n := countEcho(got, "hello there"); n != 1 {
			t.Fatalf("prior user rows altered: hello x%d", n)
		}
	}
}

// TestSingleEchoBrainHistory pins the BRAIN path: brainReq["history"] must
// NOT carry the in-flight message (agent.py appends it — the v0.38
// contract the brain still honors).
func TestSingleEchoBrainHistory(t *testing.T) {
	s, sess := seedEchoSession(t)
	const inFlight = "brain turn please"
	s.db.AppendEvent("s1", "user", inFlight, "")
	hist := s.buildHistoryCompacted("s1", sess, 40)
	hist = trimInFlightUser(hist, inFlight)
	if n := countEcho(hist, inFlight); n != 0 {
		t.Fatalf("brain history must not carry the in-flight message (agent.py appends it), got %d copies", n)
	}
	if len(hist) == 0 || hist[len(hist)-1].Content != "4" {
		t.Fatalf("brain history damaged: last row %q, want the prior assistant reply", hist[len(hist)-1].Content)
	}
}

// TestTrimInFlightUserLaw is the trim's conservative law table: only ONE
// trailing user row, only on a byte-equal match — never anything else.
func TestTrimInFlightUserLaw(t *testing.T) {
	mk := func(role, content string) llm.Message { return llm.Message{Role: role, Content: content} }
	cases := []struct {
		name     string
		hist     []llm.Message
		text     string
		wantDrop bool
	}{
		{"byte-equal trailing user", []llm.Message{mk("user", "hi"), mk("assistant", "yo"), mk("user", "hi")}, "hi", true},
		{"trailing user, different text", []llm.Message{mk("user", "a"), mk("assistant", "b"), mk("user", "c")}, "d", false},
		{"trailing assistant", []llm.Message{mk("user", "hi"), mk("assistant", "hi")}, "hi", false},
		{"empty userText never trims", []llm.Message{mk("user", "")}, "", false},
		{"redacted copy never matches (fails soft)", []llm.Message{mk("user", "sk-…REDACTED")}, "sk-live-secret", false},
		{"repeated same-text keeps BOTH real events", []llm.Message{mk("user", "again"), mk("user", "again")}, "again", true},
	}
	for _, c := range cases {
		got := trimInFlightUser(c.hist, c.text)
		dropped := len(got) == len(c.hist)-1
		if dropped != c.wantDrop {
			t.Fatalf("%s: dropped=%v want=%v (in=%d out=%d)", c.name, dropped, c.wantDrop, len(c.hist), len(got))
		}
	}
	// the repeated-text edge, end to end: the user really sent "again"
	// twice (two logged events) — after trim+append BOTH copies ride.
	s, sess := seedEchoSession(t)
	s.db.AppendEvent("s1", "user", "again", "")
	s.db.AppendEvent("s1", "assistant", "ok", "")
	s.db.AppendEvent("s1", "user", "again", "")
	h := s.buildHistoryCompacted("s1", sess, 40)
	h = append(trimInFlightUser(h, "again"), llm.Message{Role: "user", Content: "again"})
	if n := countEcho(h, "again"); n != 2 {
		t.Fatalf("two REAL sends must both ride the history, got %d", n)
	}
}

// TestSingleEchoTurnsMetric pins the persona-metrics alignment: after the
// fixed construction the in-flight turn counts ONCE — the old +1 made a
// "trigger at 3 turns" persona fire on the chat's very first turn.
func TestSingleEchoTurnsMetric(t *testing.T) {
	s, sess := seedEchoSession(t)
	const inFlight = "third turn"
	s.db.AppendEvent("s1", "user", inFlight, "")
	history := s.buildHistoryCompacted("s1", sess, 40)
	history = trimInFlightUser(history, inFlight)
	history = append(history, llm.Message{Role: "user", Content: inFlight})
	turns := countUserTurns(history)
	if turns != 3 {
		t.Fatalf("third send must count 3 turns (2 logged + in-flight once), got %d", turns)
	}
}
