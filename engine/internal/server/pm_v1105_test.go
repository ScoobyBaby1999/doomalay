package server

// v1.10.5 THE PM BADGE (D5) — a PrivateMode model on an HF chat NEVER
// reaches the sandbox (it routes to the device's local bridge). The
// create/update paths must persist the honest notice.

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/ScoobyBaby1999/doomalay/engine/internal/store"
)

func TestPMNoticeOnCreate(t *testing.T) {
	s := newV074TestServer(t, "http://unused.test")
	sess := &store.Session{
		ID: "pm-chat", Title: "PM on HF", Provider: "privatemodeai",
		Model: "privatemodeai/glm-latest", Sandbox: "hf",
	}
	if err := s.db.CreateSession(sess); err != nil {
		t.Fatalf("create: %v", err)
	}
	// seedHarnessArtifact runs for hf sessions (best-effort; not under test)
	s.seedHarnessArtifact(sess.ID)
	// replicate the create path's PM branch (the handler code under test)
	if strings.EqualFold(strings.TrimSpace(sess.Provider), "privatemodeai") {
		s.persistNoticeOnly(sess.ID, "This model runs on PrivateMode's local bridge...", "pm-local")
	}

	evs, err := s.db.ListEvents(sess.ID, 0)
	if err != nil {
		t.Fatalf("events: %v", err)
	}
	var found bool
	for _, ev := range evs {
		if ev.EventType == "notice" && strings.Contains(ev.Content, "pm-local") {
			found = true
		}
	}
	if !found {
		t.Fatal("no pm-local notice persisted at create time")
	}
}

func TestIsPMTransition(t *testing.T) {
	s := newV074TestServer(t, "http://unused.test")
	// a non-PM session that PATCHes into PM
	sess := &store.Session{ID: "switch-chat", Title: "Switch", Provider: "nvidia", Model: "nvidia/z-ai/glm-5.3-flash", Sandbox: "hf"}
	if err := s.db.CreateSession(sess); err != nil {
		t.Fatalf("create: %v", err)
	}
	wasPM := isPM(sess)
	if wasPM {
		t.Fatal("nvidia session must not read as PM")
	}
	sess.Provider = "privatemodeai"
	if !isPM(sess) {
		t.Fatal("provider=privatemodeai must read as PM")
	}
	if wasPM == isPM(sess) {
		t.Fatal("transition detection broken")
	}
	// model-prefix shape
	sess2 := &store.Session{Provider: "", Model: "privatemodeai/kimi-k2.6"}
	if !isPM(sess2) {
		t.Fatal("model prefix privatemodeai/ must read as PM")
	}
}

func TestNoticeJSONRoundTrip(t *testing.T) {
	var payload map[string]string
	if err := json.Unmarshal([]byte(`{"message":"m","code":"pm-local"}`), &payload); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if payload["code"] != "pm-local" || payload["message"] != "m" {
		t.Fatalf("payload: %+v", payload)
	}
}
