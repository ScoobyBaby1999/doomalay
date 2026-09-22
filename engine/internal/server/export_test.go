package server

// export_test.go — v0.27 the "exported latest" scope (?latest=N) and the
// folded-row boundary it cuts on.

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/ScoobyBaby1999/doomalay/engine/internal/config"
	"github.com/ScoobyBaby1999/doomalay/engine/internal/store"
)

func seedExportSession(t *testing.T) (*Server, string) {
	t.Helper()
	dir := t.TempDir()
	db, err := store.Open(dir)
	if err != nil {
		t.Fatalf("store: %v", err)
	}
	if err := db.Migrate(); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	sess := &store.Session{
		ID: "s1", Title: "Lippy", Provider: "nvidia",
		Model:   "nvidia/nvidia/nemotron-3-super-120b-a12b",
		Sandbox: "quick", SlidingWindow: 40,
	}
	if err := db.CreateSession(sess); err != nil {
		t.Fatalf("create: %v", err)
	}
	// 3 folded conversation rows (user / assistant / user) + status rows.
	// Seqs auto-increment: 1..7 in order.
	db.AppendEvent("s1", "user", "hello one", "")
	db.AppendEvent("s1", "status", `{"state":"idle"}`, "")
	db.AppendEvent("s1", "assistant_delta", "reply", "")
	db.AppendEvent("s1", "assistant", "reply one", "")
	db.AppendEvent("s1", "status", `{"state":"idle","usage":{"input_tokens":10,"output_tokens":5}}`, "")
	db.AppendEvent("s1", "user", "hello two", "")
	db.AppendEvent("s1", "assistant", "reply two", "")
	// a real mux — the {id} PathValue only exists when routed through it
	s := New(&config.Config{DataDir: dir}, db, nil)
	return s, "s1"
}

func getExport(t *testing.T, s *Server, sid, format, query string) string {
	t.Helper()
	req := httptest.NewRequest("GET", "/api/sessions/"+sid+"/export."+format+query, nil)
	rec := httptest.NewRecorder()
	s.mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("export %s%s -> %d: %s", format, query, rec.Code, rec.Body.String())
	}
	return rec.Body.String()
}

func TestExportLatestMD(t *testing.T) {
	s, sid := seedExportSession(t)

	full := getExport(t, s, sid, "md", "")
	if !strings.Contains(full, "hello one") || !strings.Contains(full, "hello two") {
		t.Fatalf("full export lost rows:\n%s", full)
	}

	// latest=2 keeps the LAST 2 conversation rows (user "hello two" +
	// assistant "reply two") and drops the older ones.
	two := getExport(t, s, sid, "md", "?latest=2")
	if !strings.Contains(two, "hello two") || !strings.Contains(two, "reply two") {
		t.Fatalf("latest=2 lost the tail rows:\n%s", two)
	}
	if strings.Contains(two, "hello one") || strings.Contains(two, "reply one") {
		t.Fatalf("latest=2 kept pre-cutoff rows:\n%s", two)
	}

	// latest larger than the log keeps everything.
	big := getExport(t, s, sid, "md", "?latest=999")
	if !strings.Contains(big, "hello one") || !strings.Contains(big, "reply two") {
		t.Fatalf("latest=999 should be a no-op:\n%s", big)
	}
}

func TestExportLatestCSVRows(t *testing.T) {
	s, sid := seedExportSession(t)

	full := getExport(t, s, sid, "csv", "")
	// 3 visible folded rows (user, assistant, user) — status rows are hidden
	if n := strings.Count(full, ",user,"); n != 2 {
		t.Fatalf("full csv user rows = %d, want 2:\n%s", n, full)
	}

	one := getExport(t, s, sid, "csv", "?latest=1")
	if !strings.Contains(one, "reply two") {
		t.Fatalf("latest=1 should keep the LAST visible row:\n%s", one)
	}
	if strings.Contains(one, "hello one") || strings.Contains(one, "hello two") {
		t.Fatalf("latest=1 kept earlier rows:\n%s", one)
	}
}

func TestExportLatestJSONTrimsEvents(t *testing.T) {
	s, sid := seedExportSession(t)

	var parsed struct {
		Session *store.Session `json:"session"`
		Events  []*store.Event `json:"events"`
	}
	body := getExport(t, s, sid, "json", "?latest=1")
	if err := json.Unmarshal([]byte(body), &parsed); err != nil {
		t.Fatalf("json parse: %v", err)
	}
	if len(parsed.Events) == 0 {
		t.Fatalf("latest=1 trimmed events to nothing")
	}
	for _, ev := range parsed.Events {
		if ev.Seq < 6 {
			t.Fatalf("latest=1 kept pre-cutoff event seq=%d", ev.Seq)
		}
	}
	if parsed.Session == nil || parsed.Session.Title != "Lippy" {
		t.Fatalf("latest=1 lost the session block")
	}
}
