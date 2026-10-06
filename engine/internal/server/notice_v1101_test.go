package server

// v1.10.1 THE HONEST TURN — the D3 regression test: an HF-chat turn that
// cannot reach its sandbox must leave a PERSISTED notice event in
// chat_events (the old transient progress note vanished at turn end — the
// user never learned bash never ran). Also covers emitNotice's wire shape
// (message + code lifted by the replay parser).

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/ScoobyBaby1999/doomalay/engine/internal/store"
)

func TestNoticeEventPersists(t *testing.T) {
	s := newV074TestServer(t, "http://unused.test")
	if err := s.db.CreateSession(&store.Session{ID: "notice-chat", Title: "Notice Chat", Provider: "nvidia", Sandbox: "hf"}); err != nil {
		t.Fatalf("create session: %v", err)
	}

	// The no-pipe twin (session-create time notices).
	s.persistNoticeOnly("notice-chat", "HF sandbox not configured — this turn runs on the direct pipeline", "hf-unconfigured")

	evs, err := s.db.ListEvents("notice-chat", 0)
	if err != nil {
		t.Fatalf("events: %v", err)
	}
	var found bool
	for _, ev := range evs {
		if ev.EventType != "notice" {
			continue
		}
		found = true
		var payload map[string]string
		if err := json.Unmarshal([]byte(ev.Content), &payload); err != nil {
			t.Fatalf("notice content not JSON: %q (%v)", ev.Content, err)
		}
		if payload["code"] != "hf-unconfigured" {
			t.Errorf("code = %q, want hf-unconfigured", payload["code"])
		}
		if !strings.Contains(payload["message"], "direct pipeline") {
			t.Errorf("message = %q, want the direct-pipeline honesty", payload["message"])
		}
	}
	if !found {
		t.Fatal("no notice event persisted — the fallback is silent again (D3 regression)")
	}
}
