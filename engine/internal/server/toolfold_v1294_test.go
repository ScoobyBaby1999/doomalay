package server

// toolfold_v1294_test.go — v1.29.4 THE TOOL MEMORY (PLAN-V130 §4): the
// model's own tool observations ride the history (the slot fold), one
// pair = ONE window slot, honest markers, redaction, stubs, orphans.

import (
        "encoding/json"
        "strings"
        "testing"

        "github.com/ScoobyBaby1999/doomalay/engine/internal/store"
)

// testToken — a ghp_-shaped fake built at RUNTIME (a literal would trip
// secret scanners; the shape exercises Redact's regex honestly).
func testToken() string {
	return "ghp_" + strings.Repeat("t", 8) + "synthetic" + strings.Repeat("0", 12)
}

func toolUseEv(t *testing.T, name, args string) string {
        t.Helper()
        b, err := json.Marshal(map[string]string{"name": name, "args": args, "summary": "exec"})
        if err != nil {
                t.Fatal(err)
        }
        return string(b)
}

func toolResultEv(t *testing.T, name, text string) string {
        t.Helper()
        b, err := json.Marshal(map[string]string{"name": name, "text": text})
        if err != nil {
                t.Fatal(err)
        }
        return string(b)
}

func TestV1294_FoldSlots_PairsRide(t *testing.T) {
        events := []*store.Event{
                {ID: 1, EventType: "user", Content: "check the timers"},
                {ID: 2, EventType: "tool_use", Content: toolUseEv(t, "termux", `{"action":"exec","args":"{\"command\":\"sed -n '760,790p' chatpanel.js\"}"}`)},
                {ID: 3, EventType: "tool_result", Content: toolResultEv(t, "termux", "OBSERVATION:\nEXEC DONE — exit_code 0\n=== timer 769 ===")},
                {ID: 4, EventType: "assistant", Content: "three timers found"},
        }
        slots := foldSlots(events, nil)
        if len(slots) != 3 {
                t.Fatalf("expected 3 slots (user, pair, assistant), got %d", len(slots))
        }
        if slots[0].msgs[0].Role != "user" {
                t.Fatalf("slot 0 role: %s", slots[0].msgs[0].Role)
        }
        if !slots[1].isTool {
                t.Fatalf("slot 1 should be the tool pair")
        }
        pair := slots[1].msgs
        if len(pair) != 2 {
                t.Fatalf("pair = 2 wire messages, got %d", len(pair))
        }
        if pair[0].Role != "assistant" || len(pair[0].ToolCalls) == 0 {
                t.Fatalf("pair[0] should be the assistant tool_calls carrier: %+v", pair[0])
        }
        if pair[1].Role != "tool" || pair[1].ToolCallID == "" || pair[1].Name != "termux" {
                t.Fatalf("pair[1] should be the tool result: %+v", pair[1])
        }
        // the OBSERVATION prefix strips (the in-turn wire law)
        if strings.HasPrefix(pair[1].Content, "OBSERVATION:") {
                t.Fatalf("OBSERVATION prefix should strip: %.40s", pair[1].Content)
        }
        if !strings.Contains(pair[1].Content, "timer 769") {
                t.Fatalf("the result text should ride: %.40s", pair[1].Content)
        }
        // the tool_call_id on the assistant message and the tool message AGREE
        var call struct {
                ID       string `json:"id"`
                Function struct {
                        Name      string `json:"name"`
                        Arguments string `json:"arguments"`
                } `json:"function"`
        }
        if err := json.Unmarshal(pair[0].ToolCalls, &[]map[string]any{{}}); err != nil {
                t.Fatalf("tool_calls must be a JSON array: %v", err)
        }
        var calls []struct {
                ID       string `json:"id"`
                Function struct {
                        Name      string `json:"name"`
                        Arguments string `json:"arguments"`
                } `json:"function"`
        }
        if err := json.Unmarshal(pair[0].ToolCalls, &calls); err != nil || len(calls) != 1 {
                t.Fatalf("tool_calls parse: %v len=%d", err, len(calls))
        }
        if calls[0].ID != pair[1].ToolCallID {
                t.Fatalf("call ids disagree: %q vs %q", calls[0].ID, pair[1].ToolCallID)
        }
        if calls[0].Function.Name != "termux" {
                t.Fatalf("call name: %q", calls[0].Function.Name)
        }
        if !strings.Contains(calls[0].Function.Arguments, "sed -n") {
                t.Fatalf("call args should carry the command: %q", calls[0].Function.Arguments)
        }
        _ = call
}

func TestV1294_FoldSlots_OrphansSkipped(t *testing.T) {
        events := []*store.Event{
                {ID: 1, EventType: "tool_use", Content: toolUseEv(t, "termux", `{"action":"exec"}`)}, // no result (turn died)
                {ID: 2, EventType: "tool_result", Content: toolResultEv(t, "web_search", "orphan result")}, // no use
                {ID: 3, EventType: "assistant", Content: "partial"},
        }
        slots := foldSlots(events, nil)
        if len(slots) != 1 {
                t.Fatalf("orphans must not ride (1 slot expected), got %d", len(slots))
        }
        if slots[0].msgs[0].Content != "partial" {
                t.Fatalf("unexpected slot: %+v", slots[0])
        }
}

func TestV1294_FoldSlots_StubLaw(t *testing.T) {
        var events []*store.Event
        events = append(events, &store.Event{ID: 0, EventType: "user", Content: "go"})
        for i := 0; i < 15; i++ {
                events = append(events,
                        &store.Event{ID: int64(i*2 + 1), EventType: "tool_use", Content: toolUseEv(t, "termux", `{"action":"exec"}`)},
                        &store.Event{ID: int64(i*2 + 2), EventType: "tool_result", Content: toolResultEv(t, "termux", "out "+string(rune('a'+i%26)))},
                )
        }
        slots := foldSlots(events, nil)
        // 1 user + 15 pairs
        if len(slots) != 16 {
                t.Fatalf("slot count: %d", len(slots))
        }
        whole, stubs := 0, 0
        for _, s := range slots {
                if s.isTool {
                        whole++
                } else if len(s.msgs) == 1 && strings.HasPrefix(s.msgs[0].Content, "[ran ") {
                        stubs++
                }
        }
        if whole != 12 || stubs != 3 {
                t.Fatalf("stub law: 12 whole + 3 stubs expected, got %d whole + %d stubs", whole, stubs)
        }
        // the NEWEST pair rides whole (the last slot)
        if !slots[len(slots)-1].isTool {
                t.Fatalf("the newest pair must ride whole")
        }
        // the OLDEST pairs stubbed
        if !strings.Contains(slots[1].msgs[0].Content, "[ran termux — output omitted") {
                t.Fatalf("the oldest pair should be a stub: %q", slots[1].msgs[0].Content)
        }
}

func TestV1294_FoldSlots_MarkerAndRedact(t *testing.T) {
        long := strings.Repeat("z", 10000)
        events := []*store.Event{
                {ID: 1, EventType: "tool_use", Content: toolUseEv(t, "termux", `{"action":"exec"}`)},
                {ID: 2, EventType: "tool_result", Content: toolResultEv(t, "termux", long)},
        }
        slots := foldSlots(events, nil)
        if !strings.Contains(slots[0].msgs[1].Content, "[truncated: first 6000 of 10000 bytes shown]") {
                t.Fatalf("the honest marker missing: %.60s", slots[0].msgs[1].Content[len(slots[0].msgs[1].Content)-80:])
        }

        // the pasted-PAT hazard: a token in the result NEVER rides the history
        events = []*store.Event{
                {ID: 3, EventType: "tool_use", Content: toolUseEv(t, "termux", `{"action":"exec"}`)},
                {ID: 4, EventType: "tool_result", Content: toolResultEv(t, "termux", "the push worked with " + testToken() + "")},
        }
        slots = foldSlots(events, nil)
        if strings.Contains(slots[0].msgs[1].Content, "ghp_") {
                t.Fatalf("the PAT must be redacted from the folded history")
        }
}

func TestV1294_BuildHistory_ToolPairsRide(t *testing.T) {
        dir := t.TempDir()
        db, err := store.Open(dir)
        if err != nil {
                t.Fatalf("store: %v", err)
        }
        if err := db.Migrate(); err != nil {
                t.Fatalf("migrate: %v", err)
        }
        sess := &store.Session{ID: "tf1", Title: "t", SlidingWindow: 40}
        if err := db.CreateSession(sess); err != nil {
                t.Fatalf("create: %v", err)
        }
        db.AppendEvent("tf1", "user", "check the timers", "")
        db.AppendEvent("tf1", "tool_use", toolUseEv(t, "termux", `{"action":"exec","args":"{\"command\":\"sed -n '760,790p' chatpanel.js\"}"}`), "")
        db.AppendEvent("tf1", "tool_result", toolResultEv(t, "termux", "EXEC DONE — timer 769 found"), "")
        db.AppendEvent("tf1", "assistant", "three timers", "")

        s := &Server{db: db}
        h := s.buildHistory("tf1", 40)
        // user + (assistant.tool_calls + tool) + assistant = 4 messages
        if len(h) != 4 {
                t.Fatalf("expected 4 messages (the pair rides), got %d", len(h))
        }
        if h[1].Role != "assistant" || len(h[1].ToolCalls) == 0 {
                t.Fatalf("h[1] should be the tool_calls carrier: %+v", h[1])
        }
        if h[2].Role != "tool" || !strings.Contains(h[2].Content, "timer 769") {
                t.Fatalf("h[2] should be the tool result: %+v", h[2])
        }

        // THE WINDOW LAW: one pair = ONE slot — a window of 2 keeps
        // [pair, assistant] = 3 messages (the old flat count would keep 2)
        h2 := s.buildHistory("tf1", 2)
        if len(h2) != 3 {
                t.Fatalf("window=2 over 3 slots should keep the last 2 slots (3 messages), got %d", len(h2))
        }
        if h2[0].Role != "assistant" || len(h2[0].ToolCalls) == 0 {
                t.Fatalf("windowed h[0] should be the pair's carrier: %+v", h2[0])
        }
}

func TestV1294_BuildHistoryCompacted_ToolPairsRide(t *testing.T) {
        dir := t.TempDir()
        db, err := store.Open(dir)
        if err != nil {
                t.Fatalf("store: %v", err)
        }
        if err := db.Migrate(); err != nil {
                t.Fatalf("migrate: %v", err)
        }
        sess := &store.Session{ID: "tf2", Title: "t", SlidingWindow: 40}
        if err := db.CreateSession(sess); err != nil {
                t.Fatalf("create: %v", err)
        }
        db.AppendEvent("tf2", "user", "check the timers", "")
        db.AppendEvent("tf2", "tool_use", toolUseEv(t, "termux", `{"action":"exec"}`), "")
        db.AppendEvent("tf2", "tool_result", toolResultEv(t, "termux", "EXEC DONE"), "")
        db.AppendEvent("tf2", "assistant", "done", "")

        s := &Server{db: db}
        h := s.buildHistoryCompacted("tf2", sess, 40)
        if len(h) != 4 {
                t.Fatalf("expected 4 messages (pair rides, no summary), got %d", len(h))
        }
        if h[1].Role != "assistant" || h[2].Role != "tool" || h[2].ToolCallID == "" {
                t.Fatalf("the pair should ride: %+v %+v", h[1], h[2])
        }

        // the compact-summary note rides OUTSIDE the window count — the pair
        // rides when its use+result BOTH sit after the compact point
        sess.CompactSummary = "SUMMARY"
        sess.CompactSeq = 1 // only the user turn compacted; the pair is live
        h = s.buildHistoryCompacted("tf2", sess, 40)
        if len(h) != 4 { // note + pair(2) + assistant
                t.Fatalf("summary + live pair expected, got %d", len(h))
        }
        if h[0].Role != "user" || !strings.HasPrefix(h[0].Content, "[conversation so far") {
                t.Fatalf("the note should lead: %.40s", h[0].Content)
        }
}

// the pre-v0.13 delta law still holds around pairs: consecutive deltas
// fold into the previous plain assistant message; a delta AFTER a pair
// opens a NEW message (never appends into the tool result).
func TestV1294_FoldSlots_DeltaLawAroundPairs(t *testing.T) {
        events := []*store.Event{
                {ID: 1, EventType: "assistant", Content: "part1 "},
                {ID: 2, EventType: "assistant_delta", Content: "part2"},
                {ID: 3, EventType: "tool_use", Content: toolUseEv(t, "termux", `{"action":"exec"}`)},
                {ID: 4, EventType: "tool_result", Content: toolResultEv(t, "termux", "res")},
                {ID: 5, EventType: "assistant_delta", Content: "after the pair"},
        }
        slots := foldSlots(events, nil)
        if len(slots) != 3 {
                t.Fatalf("slots: %d", len(slots))
        }
        if slots[0].msgs[0].Content != "part1 part2" {
                t.Fatalf("delta fold broken: %q", slots[0].msgs[0].Content)
        }
        if !slots[1].isTool {
                t.Fatalf("slot 1 should be the pair")
        }
        if slots[2].isTool {
                t.Fatalf("slot 2 should be the post-pair delta message")
        }
        if slots[2].msgs[0].Content != "after the pair" {
                t.Fatalf("the post-pair delta opens a new message: %q", slots[2].msgs[0].Content)
        }
}

// hidden events (edit/delete masks) never ride the fold
func TestV1294_FoldSlots_HiddenNeverRide(t *testing.T) {
        events := []*store.Event{
                {ID: 1, EventType: "tool_use", Content: toolUseEv(t, "termux", `{"action":"exec"}`)},
                {ID: 2, EventType: "tool_result", Content: toolResultEv(t, "termux", "res")},
                {ID: 3, EventType: "assistant", Content: "visible"},
        }
        slots := foldSlots(events, map[int64]bool{1: true, 2: true})
        if len(slots) != 1 || slots[0].msgs[0].Content != "visible" {
                t.Fatalf("hidden tool events must not ride: %+v", slots)
        }
}
