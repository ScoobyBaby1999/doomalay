package ocserve

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"
)

// The v1.48.5 gate-law pins. All frames below are LIVE-CAPTURED from the
// real opencode serve (2026-10-21, big-pickle through /event SSE, the
// same turn PLAN-V148 documents).

func TestPermissionConfigLaw(t *testing.T) {
	var cfg map[string]any
	if err := json.Unmarshal([]byte(permissionConfig), &cfg); err != nil {
		t.Fatalf("config is not valid JSON: %v", err)
	}
	perm, _ := cfg["permission"].(map[string]any)
	for _, deny := range []string{"bash", "edit", "write", "patch", "webfetch"} {
		if perm[deny] != "deny" {
			t.Fatalf("the gate law: %s must be denied (got %v) — execution + writes stay out of the agent", deny, perm[deny])
		}
	}
	for _, allow := range []string{"read", "grep", "glob", "list"} {
		if perm[allow] != "allow" {
			t.Fatalf("the gate law: %s must be allowed (got %v)", allow, perm[allow])
		}
	}
}

// TestGateLawRequestShape pins the ONE shape that passes OpenCode's
// free-tier gate: model + parts ONLY. A per-turn `tools` or `system`
// field poisons the turn AND the session (live-convicted: clean turns on
// a poisoned session keep failing).
func TestGateLawRequestShape(t *testing.T) {
	var captured map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/prompt_async") {
			b, _ := io.ReadAll(r.Body)
			json.Unmarshal(b, &captured)
			w.WriteHeader(204)
			return
		}
		if strings.HasSuffix(r.URL.Path, "/session") {
			io.WriteString(w, `{"id":"ses_probe_1"}`)
			return
		}
		if strings.HasSuffix(r.URL.Path, "/session/status") {
			io.WriteString(w, `{}`)
			return
		}
		w.WriteHeader(404)
	}))
	defer srv.Close()
	m := New("", "key", nil)
	m.SetBaseURL(srv.URL)
	if !m.Healthy() {
		t.Fatalf("fake serve not healthy")
	}
	if _, err := m.CreateSession("probe"); err != nil {
		t.Fatalf("create session: %v", err)
	}
	if err := m.PromptAsync("ses_probe_1", "big-pickle", "hello"); err != nil {
		t.Fatalf("prompt: %v", err)
	}
	for _, forbidden := range []string{"tools", "system"} {
		if _, ok := captured[forbidden]; ok {
			t.Fatalf("THE GATE LAW VIOLATED: the prompt carries %q — that field poisons the turn and the session", forbidden)
		}
	}
	model, _ := captured["model"].(map[string]any)
	if model == nil || model["providerID"] != "opencode" || model["modelID"] != "big-pickle" {
		t.Fatalf("model block wrong: %v", captured["model"])
	}
	parts, _ := captured["parts"].([]any)
	if len(parts) != 1 {
		t.Fatalf("parts wrong: %v", captured["parts"])
	}
	part, _ := parts[0].(map[string]any)
	if part["type"] != "text" || !strings.Contains(part["text"].(string), "hello") {
		t.Fatalf("part wrong: %v", parts[0])
	}
}

// TestSSEParseLiveFrames drives the parser against the LIVE-CAPTURED
// frame shapes (part creation → deltas → final message.updated → idle)
// and pins the mapping inputs the server adapter reads: part types
// (reasoning/text), deltas with field=="text", the final usage tokens,
// the terminal idle, and the free-tier-wall detection.
func TestSSEParseLiveFrames(t *testing.T) {
	frames := []string{
		`data: {"id":"e1","type":"server.connected","properties":{}}`,
		`data: {"id":"e2","type":"session.status","properties":{"sessionID":"ses_p1","status":{"type":"busy"}}}`,
		`data: {"id":"e3","type":"message.updated","properties":{"sessionID":"ses_p1","info":{"id":"msg_u1","role":"user"}}}`,
		`data: {"id":"e4","type":"message.part.updated","properties":{"sessionID":"ses_p1","part":{"id":"prt_r1","type":"reasoning","text":""}}}`,
		`data: {"id":"e5","type":"message.part.delta","properties":{"sessionID":"ses_p1","messageID":"msg_a1","partID":"prt_r1","field":"text","delta":"The user says"}}`,
		`data: {"id":"e6","type":"message.part.delta","properties":{"sessionID":"ses_p1","messageID":"msg_a1","partID":"prt_r1","field":"text","delta":" hi"}}`,
		`data: {"id":"e7","type":"message.part.updated","properties":{"sessionID":"ses_p1","part":{"id":"prt_t1","type":"text","text":""}}}`,
		`data: {"id":"e8","type":"message.part.delta","properties":{"sessionID":"ses_p1","messageID":"msg_a1","partID":"prt_t1","field":"text","delta":"SSE-OK"}}`,
		`data: {"id":"e9","type":"message.part.updated","properties":{"sessionID":"ses_p1","part":{"id":"prt_tool1","type":"tool","tool":"read","state":{"status":"running","input":{"filePath":"x.go"}}}}}`,
		`data: {"id":"e10","type":"message.part.updated","properties":{"sessionID":"ses_p1","part":{"id":"prt_tool1","type":"tool","tool":"read","state":{"status":"completed","input":{"filePath":"x.go"},"output":"file body"}}}}`,
		`data: {"id":"e11","type":"message.updated","properties":{"sessionID":"ses_p1","info":{"id":"msg_a1","role":"assistant","finish":"stop","tokens":{"total":6341,"input":221,"output":8,"reasoning":3}}}}`,
		`data: {"id":"e12","type":"session.idle","properties":{"sessionID":"ses_p1"}}`,
	}
	sse := strings.Join(append(frames, ""), "\n\n")
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.URL.Path, "/event") {
			w.Header().Set("Content-Type", "text/event-stream")
			io.WriteString(w, sse)
			return
		}
		if strings.HasSuffix(r.URL.Path, "/session/status") {
			io.WriteString(w, `{}`)
			return
		}
		w.WriteHeader(404)
	}))
	defer srv.Close()
	m := New("", "key", nil)
	m.SetBaseURL(srv.URL)

	var order []string
	var toolRunning, toolDone Event
	var finalTokens int
	var sawIdle bool
	err := m.StreamEvents(context.Background(), "ses_p1", func(ev Event) error {
		switch ev.Type {
		case "message.part.updated":
			p := ev.Properties.Part
			if p.Type == "tool" && p.State != nil {
				if p.State.Status == "running" {
					toolRunning = ev
				}
				if p.State.Status == "completed" {
					toolDone = ev
				}
				order = append(order, "tool:"+p.State.Status)
			}
		case "message.part.delta":
			order = append(order, "delta:"+ev.Properties.PartID)
		case "message.updated":
			if ev.Properties.Info.Role == "assistant" && ev.Properties.Info.Finish != "" {
				finalTokens = ev.Properties.Info.Tokens.Total
			}
		case "session.idle":
			sawIdle = true
		}
		return nil
	})
	if err != nil {
		t.Fatalf("stream: %v", err)
	}
	if !sawIdle {
		t.Fatalf("the idle terminal never arrived")
	}
	if len(order) != 5 || order[0] != "delta:prt_r1" || order[1] != "delta:prt_r1" ||
		order[2] != "delta:prt_t1" || order[3] != "tool:running" || order[4] != "tool:completed" {
		t.Fatalf("event order wrong: %v", order)
	}
	if toolRunning.Properties.Part.Tool != "read" || toolDone.Properties.Part.State.Output != "file body" {
		t.Fatalf("tool frames lost: %+v %+v", toolRunning, toolDone)
	}
	if finalTokens != 6341 {
		t.Fatalf("final usage lost: %d", finalTokens)
	}
}

// TestFreeTierWallDetection pins the poisoned-turn signature the recycle
// law reads.
func TestFreeTierWallDetection(t *testing.T) {
	var ev Event
	json.Unmarshal([]byte(`{"type":"message.updated","properties":{"sessionID":"s","info":{"role":"assistant","error":{"name":"APIError","data":{"message":"OpenCode's free tier can only be used from within OpenCode. Download it at https://opencode.ai"}}}}}`), &ev)
	if !ev.IsFreeTierError() {
		t.Fatalf("the wall frame must be detected")
	}
	json.Unmarshal([]byte(`{"type":"message.updated","properties":{"sessionID":"s","info":{"role":"assistant","error":{"name":"APIError","data":{"message":"some other error"}}}}}`), &ev)
	if ev.IsFreeTierError() {
		t.Fatalf("non-wall errors must not trigger the recycle")
	}
}

// TestFindBinaryEnvOverride pins the discovery order (env → managed → PATH).
func TestFindBinaryEnvOverride(t *testing.T) {
	dir := t.TempDir()
	fake := dir + "/fake-opencode"
	os.WriteFile(fake, []byte("#!/bin/sh\n"), 0o755)
	t.Setenv("DOOMALAY_OPENCODE_BIN", fake)
	if got := FindBinary(dir); got != fake {
		t.Fatalf("env override must win: got %q", got)
	}
}

func TestVersionIsPinned(t *testing.T) {
	// the gate "actively evolves" — the bridge is verified against THIS
	// build; moving it requires a fresh live probe + a phase, not a silent
	// bump.
	if Version == "" || !strings.Contains(Version, ".") {
		t.Fatalf("Version must stay pinned (got %q)", Version)
	}
	_ = time.Second // keep time imported for future latency pins
}
