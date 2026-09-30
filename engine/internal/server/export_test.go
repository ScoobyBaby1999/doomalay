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

// TestV825_ExportTXT — v0.82.5 THE EXPORT TRUTH: the plain-text export
// rides the ENGINE (Content-Disposition — the client-side Blob-URL
// download never worked in the Android WebView, the user's "Export chat
// plain text does not work"), and carries the FULL log: metadata header
// + user/assistant/thinking/tool/sources rows.
func TestV825_ExportTXT(t *testing.T) {
	s, sid := seedExportSession(t)
	out := getExport(t, s, sid, "txt", "")
	if !strings.Contains(out, "Lippy — transcript") {
		t.Fatalf("missing the title:\n%s", out)
	}
	// the full metadata header
	for _, want := range []string{
		"Chat type: quick", "Provider: nvidia", "Model: nvidia/nvidia/nemotron-3-super-120b-a12b",
		"Memory window: 40 messages", "Usage: 1 turns", "Started:", "Counts: 2 user · 3 assistant",
	} {
		if !strings.Contains(out, want) {
			t.Fatalf("txt header missing %q:\n%s", want, out)
		}
	}
	// the conversation rows
	if !strings.Contains(out, "You:\nhello one") || !strings.Contains(out, "Assistant:\nreply one") {
		t.Fatalf("txt rows missing:\n%s", out)
	}
}

// TestV825_ExportHTML — the engine-side HTML twin: full metadata + escaped
// rows, a self-contained page.
func TestV825_ExportHTML(t *testing.T) {
	s, sid := seedExportSession(t)
	out := getExport(t, s, sid, "html", "")
	if !strings.Contains(out, "<!doctype html>") || !strings.Contains(out, "Lippy — transcript") {
		t.Fatalf("html shape:\n%.200s", out)
	}
	if !strings.Contains(out, "Chat type: quick") || !strings.Contains(out, "Usage: 1 turns") {
		t.Fatalf("html metadata missing:\n%.400s", out)
	}
	if !strings.Contains(out, "hello one") || !strings.Contains(out, "reply one") {
		t.Fatalf("html rows missing:\n%s", out)
	}
}

// TestV825_ExportMDHeaderEnriched — "make sure all export chat options
// include as much info as possible": the md header now carries the full
// metadata (web search, usage totals, counts, updated…), shared with
// txt/html through exportMetaLines.
func TestV825_ExportMDHeaderEnriched(t *testing.T) {
	s, sid := seedExportSession(t)
	out := getExport(t, s, sid, "md", "")
	for _, want := range []string{
		"**Chat type:** quick", "**Web search:** off", "**Deep research:** off",
		"**Usage:** 1 turns", "**Counts:** 2 user · 3 assistant",
	} {
		if !strings.Contains(out, want) {
			t.Fatalf("md header missing %q:\n%s", want, out)
		}
	}
}

// TestV825_TXTThinkingToolSources — the txt format carries the rows the
// client-side render never could (thinking, tool calls, sources).
func TestV825_TXTThinkingToolSources(t *testing.T) {
	dir := t.TempDir()
	db, err := store.Open(dir)
	if err != nil {
		t.Fatalf("store: %v", err)
	}
	if err := db.Migrate(); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	sess := &store.Session{ID: "s2", Title: "Full", Provider: "privatemodeai", Model: "privatemodeai/kimi-k2.6", Sandbox: "quick"}
	if err := db.CreateSession(sess); err != nil {
		t.Fatalf("create: %v", err)
	}
	db.AppendEvent("s2", "user", "go", "")
	db.AppendEvent("s2", "thinking", "pondering deeply", "")
	db.AppendEvent("s2", "tool_use", `{"name":"workspace","summary":"list","text":""}`, "")
	db.AppendEvent("s2", "tool_result", `{"name":"workspace","text":"1 workspace(s)"}`, "")
	db.AppendEvent("s2", "assistant", "done <script>alert(1)</script>", "")
	db.AppendEvent("s2", "sources", `[{"title":"Docs","url":"https://e.test/x","snippet":"the snippet"}]`, "")
	s := New(&config.Config{DataDir: dir}, db, nil)

	out := getExport(t, s, "s2", "txt", "")
	for _, want := range []string{"[thinking]\npondering deeply", "[tool] {\"name\":\"workspace\"", "Sources:\n1. Docs — https://e.test/x", "the snippet"} {
		if !strings.Contains(out, want) {
			t.Fatalf("txt missing %q:\n%s", want, out)
		}
	}
	html := getExport(t, s, "s2", "html", "")
	if !strings.Contains(html, "pondering deeply") || !strings.Contains(html, "https://e.test/x") {
		t.Fatalf("html missing the full rows:\n%.400s", html)
	}
	// escaping: a <script> in content must never ride raw
	if strings.Contains(html, "<script>alert(1)</script>") {
		t.Fatalf("html escaping failed")
	}
}
