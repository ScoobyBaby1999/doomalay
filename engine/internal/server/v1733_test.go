package server

// v1733 pins — v1.73.3 THE HONEST CLOCK + THE AFTER-THE-FACT UI (PLAN-V173
// §v1.73.3). THE USER'S ASK (verbatim): "The UI be dealt with after the
// fact, tool calls that take a long time can re-render once complete,
// possibly in a different theme color indicating they took time, we can
// even display the time it took for each tool call if we don't already."
//
// The chain: every tool_result carries duration_ms (the bus Result → the
// ChatChunk → the live event top-level → INSIDE the persisted replay
// JSON); the serve's own tool calls clock their pills the same way; the
// "job" completion row lifts its payload top-level on the wire (the PWA
// renders ✓/✗/⊘ + the duration); the exports carry the job line.

import (
	"encoding/json"
	"strings"
	"testing"
)

// TestV1733_DurationPersistsInsideToolResult — the pump's persist folds
// duration_ms INTO the replayed tool_result JSON (the chip + the slow
// tone survive a reload).
func TestV1733_DurationPersistsInsideToolResult(t *testing.T) {
	s, sid := newSentinelServer(t)
	pipe := pipeFor(sid)
	s.emit(pipe, sid, "tool_use", "web_fetch", "call-1")
	s.emit(pipe, sid, "tool_result", `{"name":"web_fetch","text":"the page","duration_ms":12400}`, "call-1")
	evs, err := s.db.ListEvents(sid, 0)
	if err != nil {
		t.Fatalf("events: %v", err)
	}
	var found bool
	for _, ev := range evs {
		if ev.EventType != "tool_result" {
			continue
		}
		var pay map[string]any
		if json.Unmarshal([]byte(ev.Content), &pay) != nil {
			t.Fatalf("the persisted tool_result is JSON: %q", ev.Content)
		}
		if pay["name"] == "web_fetch" {
			if d, ok := pay["duration_ms"].(float64); !ok || d != 12400 {
				t.Fatalf("duration_ms rides INSIDE the persisted payload: %v", pay)
			}
			found = true
		}
	}
	if !found {
		t.Fatalf("the tool_result row persisted")
	}
}

// TestV1733_JobEventLiftsTopLevel — the emit "job" case lifts the JSON
// payload onto the live frame top-level (the source law — the PWA + the
// rigs read id/tool/state/duration_ms without a second parse; the LIVE
// frame pin is the rig's LEG B/C over the real WS); the persist keeps
// the raw JSON as content (the replay lift — pinned here against the
// real DB).
func TestV1733_JobEventLiftsTopLevel(t *testing.T) {
	chatSrc := srcOf(t, "chat.go")
	if !strings.Contains(chatSrc, `case "job":`) {
		t.Fatalf("emit carries the job case (the live-frame lift)")
	}
	s, sid := newSentinelServer(t)
	pipe := pipeFor(sid)
	payload := `{"id":"j_abcd","session_id":"` + sid + `","tool":"web_fetch","state":"completed","duration_ms":32000,"text":"the slow page"}`
	s.emit(pipe, sid, "job", payload, "")
	// the persist: the raw JSON is the content (the replay lift parses it)
	evs, err := s.db.ListEvents(sid, 0)
	if err != nil {
		t.Fatalf("events: %v", err)
	}
	var persisted bool
	for _, ev := range evs {
		if ev.EventType == "job" {
			var pay map[string]any
			if json.Unmarshal([]byte(ev.Content), &pay) != nil || pay["id"] != "j_abcd" {
				t.Fatalf("the persisted job row keeps the JSON payload: %q", ev.Content)
			}
			if pay["state"] != "completed" || pay["duration_ms"] != float64(32000) {
				t.Fatalf("the payload is whole: %v", pay)
			}
			persisted = true
		}
	}
	if !persisted {
		t.Fatalf("the job row persisted")
	}
}

// TestV1733_ExportCarriesJobLine — the md export renders the job line
// (the glyph + the tool + the honest duration + the clamped result).
func TestV1733_ExportCarriesJobLine(t *testing.T) {
	s, sid := newSentinelServer(t)
	pipe := pipeFor(sid)
	payload := `{"id":"j_ef12","session_id":"` + sid + `","tool":"termux","state":"completed","duration_ms":91200,"text":"pip install done"}`
	s.emit(pipe, sid, "job", payload, "")
	line := jobLine(payload)
	for _, want := range []string{"✓", "j_ef12", "termux", "finished after 91.2s", "pip install done"} {
		if !strings.Contains(line, want) {
			t.Fatalf("the job export line carries %q: %q", want, line)
		}
	}
	failLine := jobLine(`{"id":"j_x","tool":"web_fetch","state":"failed","duration_ms":1500,"text":"error: refused"}`)
	if !strings.Contains(failLine, "✗") || !strings.Contains(failLine, "FAILED") {
		t.Fatalf("the failed line: %q", failLine)
	}
	stopLine := jobLine(`{"id":"j_y","tool":"calculator","state":"cancelled","duration_ms":900}`)
	if !strings.Contains(stopLine, "⊘") || !strings.Contains(stopLine, "was stopped") || strings.Contains(stopLine, ":") {
		t.Fatalf("the cancelled line has no result colon: %q", stopLine)
	}
	if garbage := jobLine(`not json`); garbage != "" {
		t.Fatalf("a garbage row skips honestly: %q", garbage)
	}
}

// TestV1733_PWASourcePins — §A-style: the PWA carries the three laws (the
// duration chip, the slow tone, the job row) — the shipped rigs pin the
// source so a regression cannot silently drop the UI.
func TestV1733_PWASourcePins(t *testing.T) {
	panel := srcOf(t, "web/chatpanel.js")
	for _, want := range []string{
		"tool-pill-dur",            // the duration chip rides the pill head
		"fmtDurationMs",           // the shared duration formatter
		"SLOW_TOOL_MS",             // the slow threshold
		"data-slow=\"1\"",            // the slow tone attr
		"type === 'job'",           // the job event branch
		"role: 'job'",              // the job row message
		"data-job-state",           // the state-driven tone
	} {
		if !strings.Contains(panel, want) {
			t.Fatalf("chatpanel.js must carry %q", want)
		}
	}
	html := srcOf(t, "web/index.html")
	for _, want := range []string{
		".msg-job",                 // the job row CSS
		".tool-pill-dur",           // the chip CSS
		".tool-pill[data-slow=\"1\"]", // the slow tone CSS
		"--warn-rgb",               // theme tokens only (the slow tone composes the warn token)
	} {
		if !strings.Contains(html, want) {
			t.Fatalf("index.html must carry %q", want)
		}
	}
}

// TestV1733_ServePumpClocksItsPills — the serve pump's own tool calls
// carry the per-call clock (the source law — the live pin is the rig's
// LEG C: the fake serve's tool round answers with duration_ms on the
// tool_result frames).
func TestV1733_ServePumpClocksItsPills(t *testing.T) {
	src := srcOf(t, "ocserveturn.go")
	for _, want := range []string{
		"toolStarts[callID] = time.Now().UnixMilli()",
		`successEv["duration_ms"]`,
		`failedEv["duration_ms"]`,
	} {
		if !strings.Contains(src, want) {
			t.Fatalf("the serve pump must carry %q", want)
		}
	}
}

// TestV1733_NativeLoopDeliversSettled — the round-boundary drain + the
// serve opening drain (the source law; the live pins are the rig's LEGs
// B and C).
func TestV1733_NativeLoopDeliversSettled(t *testing.T) {
	native := srcOf(t, "../llm/nativetools.go")
	if !strings.Contains(native, "DrainSettled(req.SessionID)") {
		t.Fatalf("the native loop drains the settled ring at the round top")
	}
	if !strings.Contains(native, `history = append(history, Message{Role: "user", Content: "(system: " + block + ")"}`) {
		t.Fatalf("the settled block rides the history as the loud system row")
	}
	serve := srcOf(t, "ocserveturn.go")
	if !strings.Contains(serve, "DrainSettled(sessionID)") {
		t.Fatalf("the serve path drains the settled ring into the turn's opening")
	}
	srv := srcOf(t, "server.go")
	if !strings.Contains(srv, "jobmgr.SetEventSink") {
		t.Fatalf("the server wires the completion rail at boot")
	}
}

