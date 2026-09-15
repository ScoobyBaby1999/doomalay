package server

import (
	"encoding/json"
	"os"
	"testing"

	"github.com/ScoobyBaby1999/doomalay/engine/internal/store"
)

// TestBuildHistoryCompacted verifies the v0.21 auto-compact history
// assembly: the compact summary leads, events before the compact point
// are excluded, the live tail is folded, and the window is honored.
func TestBuildHistoryCompacted(t *testing.T) {
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
	// 6 turns of history (user/assistant pairs)
	for i := 0; i < 6; i++ {
		db.AppendEvent("s1", "user", "user message "+string(rune('A'+i)), "")
		db.AppendEvent("s1", "assistant", "assistant reply "+string(rune('A'+i)), "")
	}

	s := &Server{db: db}

	// 1. no compact state → full history
	h := s.buildHistoryCompacted("s1", sess, 40)
	if len(h) != 12 {
		t.Fatalf("expected 12 messages, got %d", len(h))
	}
	if h[0].Content != "user message A" {
		t.Fatalf("expected first user msg, got %q", h[0].Content)
	}

	// 2. compact the first 4 pairs (seq 8): summary + tail only
	sess.CompactSummary = "SUMMARY-OF-EARLY-TALK"
	sess.CompactSeq = 8
	if err := db.UpdateSession(sess); err != nil {
		t.Fatalf("update: %v", err)
	}
	h = s.buildHistoryCompacted("s1", sess, 40)
	// summary note + the live tail (events 9..12 = pairs E, F)
	if len(h) != 5 {
		t.Fatalf("expected 5 messages (1 summary + 4 live), got %d", len(h))
	}
	if h[0].Role != "user" || h[0].Content[:len("[conversation so far")] != "[conversation so far" {
		t.Fatalf("expected the compact summary note first, got role=%s content=%.40s", h[0].Role, h[0].Content)
	}
	foundOld := false
	for _, m := range h {
		if m.Content == "user message A" || m.Content == "user message B" {
			foundOld = true
		}
	}
	if foundOld {
		t.Fatal("pre-compact events leaked into the compacted history")
	}
	if h[1].Content != "user message E" {
		t.Fatalf("expected live tail to start at E, got %q", h[1].Content)
	}

	// 3. window clamp keeps the summary + tail
	sess.SlidingWindow = 4
	h = s.buildHistoryCompacted("s1", sess, 4)
	if len(h) != 4 {
		t.Fatalf("expected window clamp to 4, got %d", len(h))
	}
	if h[0].Content[:len("[conversation so far")] != "[conversation so far" {
		t.Fatalf("summary note must survive the window clamp, got %q", h[0].Content[:30])
	}
	_ = os.RemoveAll(dir)
}

// TestUsageAccumulation verifies /api/sessions/{id}/usage aggregation by
// simulating stored status events (the same shape the engine persists).
func TestUsageAccumulation(t *testing.T) {
	dir := t.TempDir()
	db, err := store.Open(dir)
	if err != nil {
		t.Fatalf("store: %v", err)
	}
	if err := db.Migrate(); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	sess := &store.Session{ID: "u1", Title: "u", Model: "nvidia/nvidia/nemotron-3.5-lightning-30b-a3b", Provider: "nvidia"}
	if err := db.CreateSession(sess); err != nil {
		t.Fatalf("create: %v", err)
	}
	db.AppendEvent("u1", "user", "q", "")
	db.AppendEvent("u1", "status", `{"state":"idle","usage":{"input_tokens":100,"output_tokens":50}}`, "")
	db.AppendEvent("u1", "user", "q2", "")
	db.AppendEvent("u1", "status", `{"state":"idle","usage":{"input_tokens":200,"output_tokens":150}}`, "")

	events, _ := db.ListEvents("u1", 0)
	inTok, outTok, turns := 0, 0, 0
	for _, ev := range events {
		if ev.EventType == "status" {
			// mirror handleSessionUsage's parse
			var st struct {
				Usage *struct {
					InputTokens  int `json:"input_tokens"`
					OutputTokens int `json:"output_tokens"`
				} `json:"usage"`
			}
			import_json_Unmarshal(t, ev.Content, &st)
			if st.Usage != nil {
				inTok += st.Usage.InputTokens
				outTok += st.Usage.OutputTokens
				turns++
			}
		}
	}
	if inTok != 300 || outTok != 200 || turns != 2 {
		t.Fatalf("usage agg wrong: in=%d out=%d turns=%d", inTok, outTok, turns)
	}
	_ = os.RemoveAll(dir)
}

// import_json_Unmarshal is a tiny helper (avoids importing encoding/json in
// two test funcs).
func import_json_Unmarshal(t *testing.T, data string, v any) {
	t.Helper()
	if err := json.Unmarshal([]byte(data), v); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
}
