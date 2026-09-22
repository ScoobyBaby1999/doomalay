package server

import (
	"encoding/json"
	"net/http/httptest"
	"testing"

	"github.com/ScoobyBaby1999/doomalay/engine/internal/store"
)

// v0.42: THE ALL-CHATS INDEX — GET /api/chats. Covers: ordering (most
// recently active first), exact visible message counts, preview = latest
// visible transcript line, hide-masking of deleted/edited tails, empty
// listing shape, and the store-level preview trimming.
func chatsReq(t *testing.T, s *Server) (*httptest.ResponseRecorder, map[string]any) {
	t.Helper()
	req := httptest.NewRequest("GET", "/api/chats", nil)
	rec := httptest.NewRecorder()
	s.mux.ServeHTTP(rec, req)
	var out map[string]any
	if rec.Code == 200 {
		if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
			t.Fatalf("decode: %v", err)
		}
	}
	return rec, out
}

func chatsList(t *testing.T, out map[string]any) []map[string]any {
	t.Helper()
	raw, ok := out["chats"].([]any)
	if !ok {
		t.Fatalf("no chats array in response: %v", out)
	}
	list := make([]map[string]any, 0, len(raw))
	for _, r := range raw {
		if m, ok := r.(map[string]any); ok {
			list = append(list, m)
		}
	}
	return list
}

func TestChatsRouteEmpty(t *testing.T) {
	s := newSearchTestServer(t)
	rec, out := chatsReq(t, s)
	if rec.Code != 200 {
		t.Fatalf("code %d: %s", rec.Code, rec.Body.String())
	}
	list := chatsList(t, out)
	if len(list) != 0 {
		t.Fatalf("expected empty listing, got %d", len(list))
	}
}

func TestChatsRouteOrderAndPreview(t *testing.T) {
	s := newSearchTestServer(t)
	// oldest first in seed order; updatedOrder drives updated_at (2 newest)
	seedSearchSession(t, s, "chat-old", "Old Chat", 1, [][2]string{
		{"user", "first question about mountains"},
		{"assistant", "the mountain answer, quite long and full of detail about ridgelines"},
	})
	seedSearchSession(t, s, "chat-new", "New Chat", 5, [][2]string{
		{"user", "fresh question about the harbor"},
		{"assistant", "harbor reply"},
		{"user", "a follow-up question about lanterns"},
	})
	seedSearchSession(t, s, "chat-mid", "Mid Chat", 3, [][2]string{
		{"user", "midday question"},
		{"assistant", "midday reply"},
	})
	// a session with NO transcript events at all (created, never used)
	if err := s.db.CreateSession(&store.Session{ID: "chat-bare", Title: "Bare Chat", Provider: "nvidia", Sandbox: "quick"}); err != nil {
		t.Fatalf("create: %v", err)
	}
	if _, err := s.db.Exec(`UPDATE chat_sessions SET updated_at = 1700000002 WHERE id = 'chat-bare'`); err != nil {
		t.Fatalf("touch: %v", err)
	}

	rec, out := chatsReq(t, s)
	if rec.Code != 200 {
		t.Fatalf("code %d: %s", rec.Code, rec.Body.String())
	}
	list := chatsList(t, out)
	if len(list) != 4 {
		t.Fatalf("expected 4 chats, got %d", len(list))
	}
	// updated_at DESC: new(5) → mid(3) → bare(2) → old(1)
	wantOrder := []string{"chat-new", "chat-mid", "chat-bare", "chat-old"}
	for i, want := range wantOrder {
		if list[i]["session_id"] != want {
			t.Fatalf("order[%d] = %v, want %s (full: %v)", i, list[i]["session_id"], want, wantOrder)
		}
	}
	byID := map[string]map[string]any{}
	for _, m := range list {
		byID[m["session_id"].(string)] = m
	}

	// preview = the LATEST visible transcript line (a follow-up question)
	if got := byID["chat-new"]["preview"]; got != "a follow-up question about lanterns" {
		t.Fatalf("chat-new preview = %v", got)
	}
	if got := byID["chat-new"]["preview_role"]; got != "user" {
		t.Fatalf("chat-new preview_role = %v", got)
	}
	if got := byID["chat-new"]["msg_count"]; got != float64(3) {
		t.Fatalf("chat-new msg_count = %v", got)
	}
	// never-used session: empty preview, zero count, still listed
	if got := byID["chat-bare"]["preview"]; got != "" {
		t.Fatalf("chat-bare preview = %v", got)
	}
	if got := byID["chat-bare"]["msg_count"]; got != float64(0) {
		t.Fatalf("chat-bare msg_count = %v", got)
	}
	// session fields ride along (the badge + open path need them)
	if got := byID["chat-old"]["model"]; got != "nvidia/openai/gpt-oss-20b" {
		t.Fatalf("chat-old model = %v", got)
	}
	if got := byID["chat-old"]["provider"]; got != "nvidia" {
		t.Fatalf("chat-old provider = %v", got)
	}
	if got := byID["chat-old"]["sandbox"]; got != "quick" {
		t.Fatalf("chat-old sandbox = %v", got)
	}
}

func TestChatsRouteHideMasking(t *testing.T) {
	s := newSearchTestServer(t)
	seedSearchSession(t, s, "chat-h", "Hide Chat", 1, [][2]string{
		{"user", "question one"},
		{"assistant", "answer one"},
		{"user", "question two"},
		{"assistant", "answer two (the last line)"},
	})
	// hide the LAST assistant event (the delete-message path: hide ids
	// arrive as JSON arrays exactly like the frontend emits)
	hrows, err := s.db.Query(`SELECT id FROM chat_events WHERE session_id='chat-h' ORDER BY id`)
	if err != nil {
		t.Fatalf("ids: %v", err)
	}
	var ids []int64
	for hrows.Next() {
		var id int64
		_ = hrows.Scan(&id)
		ids = append(ids, id)
	}
	hrows.Close()
	lastID := ids[len(ids)-1]
	if _, err := s.db.AppendEvent("chat-h", "hide", "["+itoa(lastID)+"]", ""); err != nil {
		t.Fatalf("hide: %v", err)
	}

	_, out := chatsReq(t, s)
	list := chatsList(t, out)
	if len(list) != 1 {
		t.Fatalf("expected 1 chat, got %d", len(list))
	}
	// preview walks down to the newest VISIBLE line (question two)
	if got := list[0]["preview"]; got != "question two" {
		t.Fatalf("masked preview = %v, want 'question two'", got)
	}
	if got := list[0]["msg_count"]; got != float64(3) {
		t.Fatalf("masked msg_count = %v, want 3", got)
	}
}

func TestChatsPreviewTrimming(t *testing.T) {
	// store-level: TrimPreview clamps by runes (not bytes) with ellipsis
	long := ""
	for i := 0; i < 50; i++ {
		long += "härbor " // multi-byte runes on purpose
	}
	got := store.TrimPreview(long, 140)
	r := []rune(got)
	if len(r) != 141 {
		t.Fatalf("trimmed length = %d runes, want 141 (140 + ellipsis)", len(r))
	}
	if string(r[len(r)-1]) != "…" {
		t.Fatalf("trimmed tail = %q, want ellipsis", string(r[len(r)-1]))
	}
	// short strings pass through untouched
	if got := store.TrimPreview("  short  ", 140); got != "short" {
		t.Fatalf("short passthrough = %q", got)
	}
}

func itoa(n int64) string {
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	var b [24]byte
	i := len(b)
	for n > 0 {
		i--
		b[i] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		i--
		b[i] = '-'
	}
	return string(b[i:])
}
