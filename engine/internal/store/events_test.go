package store

import (
	"encoding/json"
	"testing"
)

// openTestDB opens + migrates a throwaway SQLite DB (the server tests go
// through NewServer; the store package needs nothing heavier).
func openTestDB(t *testing.T) *DB {
	t.Helper()
	db, err := Open(t.TempDir())
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	t.Cleanup(func() { db.Close() })
	if err := db.Migrate(); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	return db
}

// TestStatusEventMessageRoundTrip — v0.44 INTERRUPT FIX: a status event
// whose content carries a human message (the v0.39 boot-heal writes
// {"state":"error","healed":true,"message":"interrupted by engine
// restart"}) must round-trip that message through EventToJSON. ToJSON used
// to decode only state+usage, so the replay wire dropped the message and a
// healed turn ended SILENTLY client-side.
func TestStatusEventMessageRoundTrip(t *testing.T) {
	db := openTestDB(t)
	sid := "sess-interrupt"

	// The exact content healInterruptedTurns appends at boot.
	ev, err := db.AppendEvent(sid, "status",
		`{"state":"error","healed":true,"message":"interrupted by engine restart"}`, "")
	if err != nil {
		t.Fatalf("append: %v", err)
	}
	b, err := ev.ToJSON()
	if err != nil {
		t.Fatalf("tojson: %v", err)
	}
	var w map[string]any
	if err := json.Unmarshal(b, &w); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if w["type"] != "status" {
		t.Fatalf("type = %v, want status", w["type"])
	}
	if w["state"] != "error" {
		t.Fatalf("state = %v, want error", w["state"])
	}
	if w["message"] != "interrupted by engine restart" {
		t.Fatalf("message = %v, want the heal text", w["message"])
	}
	if w["healed"] != true {
		t.Fatalf("healed = %v, want true", w["healed"])
	}

	// The message must survive the REPLAY path too (ListEvents → ToJSON is
	// what a reconnecting client and GET /api/sessions/{id}/events use).
	all, err := db.ListEvents(sid, 0)
	if err != nil || len(all) != 1 {
		t.Fatalf("list: %v (%d events)", err, len(all))
	}
	b2, err := all[0].ToJSON()
	if err != nil {
		t.Fatalf("replay tojson: %v", err)
	}
	var w2 map[string]any
	if err := json.Unmarshal(b2, &w2); err != nil {
		t.Fatalf("replay unmarshal: %v", err)
	}
	if w2["message"] != "interrupted by engine restart" {
		t.Fatalf("replay message = %v, want the heal text", w2["message"])
	}
}

// TestStatusEventPlainShapeUnchanged — ordinary statuses (idle/error with
// usage) must keep their old wire shape: no message/healed keys appear when
// the content carries none (backward compat for every existing row).
func TestStatusEventPlainShapeUnchanged(t *testing.T) {
	db := openTestDB(t)
	sid := "sess-plain"

	ev, err := db.AppendEvent(sid, "status", `{"state":"idle","usage":null}`, "")
	if err != nil {
		t.Fatalf("append: %v", err)
	}
	b, err := ev.ToJSON()
	if err != nil {
		t.Fatalf("tojson: %v", err)
	}
	var w map[string]any
	if err := json.Unmarshal(b, &w); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if w["state"] != "idle" {
		t.Fatalf("state = %v, want idle", w["state"])
	}
	if _, present := w["message"]; present {
		t.Fatalf("message leaked onto a messageless status: %v", w["message"])
	}
	if _, present := w["healed"]; present {
		t.Fatalf("healed leaked onto a messageless status: %v", w["healed"])
	}

	// Non-status events are untouched by the new decode branch: a user
	// row still round-trips its text verbatim.
	uev, err := db.AppendEvent(sid, "user", "hello", "")
	if err != nil {
		t.Fatalf("append user: %v", err)
	}
	ub, err := uev.ToJSON()
	if err != nil {
		t.Fatalf("user tojson: %v", err)
	}
	var uw map[string]any
	if err := json.Unmarshal(ub, &uw); err != nil {
		t.Fatalf("user unmarshal: %v", err)
	}
	if uw["type"] != "user" || uw["text"] != "hello" {
		t.Fatalf("user wire = %v / %v, want user / hello", uw["type"], uw["text"])
	}
}
