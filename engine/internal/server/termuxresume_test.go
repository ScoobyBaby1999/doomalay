package server

// termuxresume_test.go — v1.35.2 THE QUIET FINISHER (PLAN-V136 §v1.35.2).
// The ledger state-read + the resume executor + the throttled auto-attempt,
// against the stub bridge (the /run route is observable + configurable —
// the harness extension lives in termuxapi_test.go).
//
// THE CONVICTIONS:
//   R1  THE MARKER LAW: no marker → the honest unknown (the command never
//       ran); marker + empty body → the honest ABSENT (an old script's
//       device); marker + lines → the parsed ledger.
//   R2  THE QUIET GATE extends to the state read: gate closed → zero
//       /run round-trips, the stale (zero) snapshot serves.
//   R3  the additive status fields: pkgs_state / pkgs_pending /
//       resume_* — an old-script device answers the honest empty state.
//   R4  THE RESUME DOOR: nothing pending → 400 with the reason; pending →
//       200 started + the exact command composed
//       (bash "$HOME/.doomalay-setup/resume.sh" --checkin <legal url>);
//       an ILLEGAL checkin URL never reaches the shell line.
//   R5  single-flight: while one attempt runs, every other caller joins
//       (started=false, already_running=true) — never two resumes.
//   R6  THE THROTTLE: the auto-attempt fires once, then holds the window;
//       a forced fetch rides the SHORT window (the user's explicit moment).
//   R7  the executor's honest outcome: a bridge error lands in
//       resume_last_error + resume_last_ok=false — never a panic, never a
//       500; the state cache invalidates so the next poll re-reads.

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

const ledgerPendingStdout = "__doomalay_state__\npkgs=pending\nstorage=granted\nworkspace=ok\n"
const ledgerOKStdout = "__doomalay_state__\npkgs=ok\nstorage=granted\nworkspace=ok\n"

// R1 — the marker law (pure function).
func TestV1352_ParseTermuxState(t *testing.T) {
	if got := parseTermuxState("no marker here\nkey=value\n"); got != nil {
		t.Fatalf("no marker must parse to nil (the honest unknown), got %v", got)
	}
	got := parseTermuxState(ledgerPendingStdout)
	if got == nil || got["pkgs"] != "pending" || got["storage"] != "granted" || got["workspace"] != "ok" {
		t.Fatalf("the pending ledger must parse fully, got %v", got)
	}
	if got := parseTermuxState("__doomalay_state__\n\n"); got == nil || len(got) != 0 {
		t.Fatalf("marker + empty body = the ABSENT state (empty map, not nil), got %v", got)
	}
	got = parseTermuxState("__doomalay_state__\npkgs=ok\nfuture_key=whatever\n")
	if got == nil || got["pkgs"] != "ok" || got["future_key"] != "whatever" {
		t.Fatalf("unknown keys ride along (the additive future), got %v", got)
	}
	got = parseTermuxState("__doomalay_state__\nbroken line\n=empty\nok=valid\n")
	if got == nil || len(got) != 1 || got["ok"] != "valid" {
		t.Fatalf("malformed lines are skipped, valid ones ride, got %v", got)
	}
}

// R2 — the state read obeys the quiet gate.
func TestV1352_StateRead_GateClosed(t *testing.T) {
	s, ts := newTestServerV1352(t)
	ts.statusMu.Lock()
	ts.bootstrapD = false
	ts.propsOK = false // the probe answers props_missing
	ts.runStdout = ledgerPendingStdout
	ts.statusMu.Unlock()

	_, out := termuxStatus(t, s, "")
	if out["pkgs_pending"] != false || out["pkgs_state"] != "" {
		t.Fatalf("gate closed → the honest empty state, got %v / %v", out["pkgs_state"], out["pkgs_pending"])
	}
	if runs := ts.runHits(); len(runs) != 0 {
		t.Fatalf("THE QUIET GATE: gate closed must fire ZERO /run round-trips, got %d (%v)", len(runs), runs)
	}
}

// R3 — the gate open + a pending ledger → the additive fields speak.
func TestV1352_Status_AdditiveFields(t *testing.T) {
	s, ts := newTestServerV1352(t)
	ts.statusMu.Lock()
	ts.bootstrapD = true // the checkin landed → the gate is open
	ts.runStdout = ledgerPendingStdout
	ts.statusMu.Unlock()

	_, out := termuxStatus(t, s, "")
	if out["pkgs_state"] != "pending" || out["pkgs_pending"] != true {
		t.Fatalf("pending ledger must surface (pkgs_state=%v pkgs_pending=%v)", out["pkgs_state"], out["pkgs_pending"])
	}
	if out["resume_running"] != false || out["resume_last_error"] != "" {
		t.Fatalf("a fresh executor answers honestly idle, got %v", out)
	}

	// the old-script device: the marker + empty body → the honest ABSENT
	s2, ts2 := newTestServerV1352(t)
	ts2.statusMu.Lock()
	ts2.bootstrapD = true
	ts2.runStdout = "__doomalay_state__\n"
	ts2.statusMu.Unlock()
	_, out = termuxStatus(t, s2, "")
	if out["pkgs_state"] != "" || out["pkgs_pending"] != false {
		t.Fatalf("the absent ledger is the honest empty state, got %v", out)
	}
}

// R4 — the resume door: honest refusals + the exact composed command.
func TestV1352_ResumeDoor(t *testing.T) {
	s, ts := newTestServerV1352(t)

	// nothing pending (the default stub /run → the unknown state) → 400
	code, body := termuxResumePost(t, s, ts)
	if code != http.StatusBadRequest {
		t.Fatalf("nothing pending must refuse honestly (400), got %d: %v", code, body)
	}
	if msg, _ := body["error"].(string); !strings.Contains(msg, "nothing pending") {
		t.Fatalf("the refusal must carry its reason, got %q", msg)
	}

	// the pending ledger + a LEGAL checkin URL → 200 started + the command
	ts.statusMu.Lock()
	ts.bootstrapD = true
	ts.runStdout = ledgerPendingStdout
	ts.checkinURL = "https://127.0.0.1:8081/550e8400-e29b-41d4-a716-446655440000/checkin"
	ts.statusMu.Unlock()

	// the forced poll primes the state cache (pending) AND auto-fires the
	// resume (the executor's completion invalidates the cache) — waiting
	// for it makes the door's own read below a FRESH pending read:
	// deterministic, no goroutine races.
	termuxStatus(t, s, "?refresh=1")
	waitResumeDone(t, s)

	code, body = termuxResumePost(t, s, ts)
	if code != http.StatusOK {
		t.Fatalf("pending + legal URL must start (200), got %d: %v", code, body)
	}
	if body["started"] != true {
		t.Fatalf("the executor must report started=true, got %v", body)
	}

	// wait for the executor to finish (the stub answers instantly)
	waitResumeDone(t, s)

	ts.statusMu.Lock()
	var resumeCmd string
	for _, c := range ts.runLog {
		if strings.Contains(c, "resume.sh") {
			resumeCmd = c
		}
	}
	ts.statusMu.Unlock()
	want := `bash "$HOME/.doomalay-setup/resume.sh" --checkin https://127.0.0.1:8081/550e8400-e29b-41d4-a716-446655440000/checkin`
	if resumeCmd != want {
		t.Fatalf("the composed command must be exact\n want: %s\n got:  %s", want, resumeCmd)
	}
}

// R4b — an ILLEGAL checkin URL never reaches the shell line.
func TestV1352_Resume_IllegalURLDropped(t *testing.T) {
	s, ts := newTestServerV1352(t)
	ts.statusMu.Lock()
	ts.bootstrapD = true
	ts.runStdout = ledgerPendingStdout
	ts.checkinURL = "https://evil.example.com/steal?x=1" // not loopback/legal
	ts.statusMu.Unlock()

	termuxStatus(t, s, "?refresh=1")
	waitResumeDone(t, s) // the forced poll auto-fires the attempt; let it land

	code, body := termuxResumePost(t, s, ts)
	if code != http.StatusOK || body["started"] != true {
		t.Fatalf("pending must still start, got %d: %v", code, body)
	}
	waitResumeDone(t, s)

	ts.statusMu.Lock()
	var resumeCmd string
	for _, c := range ts.runLog {
		if strings.Contains(c, "resume.sh") {
			resumeCmd = c
		}
	}
	ts.statusMu.Unlock()
	if strings.Contains(resumeCmd, "evil.example.com") {
		t.Fatalf("an illegal URL must NEVER be composed into the command, got %q", resumeCmd)
	}
	if resumeCmd != `bash "$HOME/.doomalay-setup/resume.sh"` {
		t.Fatalf("without a legal URL the command is the bare finisher, got %q", resumeCmd)
	}
}

// R5 — single-flight: a running executor swallows every extra caller.
func TestV1352_Resume_SingleFlight(t *testing.T) {
	s, ts := newTestServerV1352(t)
	ts.statusMu.Lock()
	ts.bootstrapD = true
	ts.runStdout = ledgerPendingStdout
	ts.statusMu.Unlock()
	termuxStatus(t, s, "?refresh=1")
	waitResumeDone(t, s) // the forced poll auto-fires; let it land FIRST

	s.termuxResumeMu.Lock()
	s.termuxResumeRunning = true // pretend one is in flight (no auto left to race)
	s.termuxResumeMu.Unlock()
	started, already := s.termuxResumeTry()
	if started || !already {
		t.Fatalf("a running executor: started=false already=true, got %v/%v", started, already)
	}
	// the door reports the same truth over HTTP
	code, body := termuxResumePost(t, s, ts)
	if code != http.StatusOK || body["started"] != false || body["already_running"] != true {
		t.Fatalf("the door must report already_running, got %d: %v", code, body)
	}
	s.termuxResumeMu.Lock()
	s.termuxResumeRunning = false
	s.termuxResumeMu.Unlock()
}

// R6 — the throttle: one auto-attempt per window; forced rides the short one.
func TestV1352_AutoResume_Throttle(t *testing.T) {
	s, ts := newTestServerV1352(t)
	ts.statusMu.Lock()
	ts.bootstrapD = true
	ts.runStdout = ledgerPendingStdout
	ts.statusMu.Unlock()

	// the FIRST status poll auto-fires (the throttle is zero-timed)
	_, out := termuxStatus(t, s, "")
	if out["pkgs_pending"] != true {
		t.Fatalf("the pending ledger must surface first")
	}
	waitResumeDone(t, s) // the stub answers instantly; the attempt completes

	// an immediate second poll must NOT re-fire (the 10-minute window holds)
	baseline := len(ts.runHits())
	_, _ = termuxStatus(t, s, "")
	scanForResume(t, ts, baseline, "the throttle must hold on a background poll")

	// the forced fetch rides the SHORT window: pretend the last auto-attempt
	// was 2 minutes ago (inside the 10-min auto window, outside the 60s
	// forced one) → a forced poll re-fires, a background poll does not
	s.termuxResumeMu.Lock()
	s.termuxResumeAutoAt = time.Now().Add(-2 * time.Minute).Unix()
	s.termuxResumeMu.Unlock()
	baseline = len(ts.runHits())
	_, _ = termuxStatus(t, s, "") // background poll: held
	scanForResume(t, ts, baseline, "2min-old attempt + background poll must NOT re-fire")
	waitResumeDone(t, s)
	baseline = len(ts.runHits())
	_, _ = termuxStatus(t, s, "?refresh=1") // forced: the 60s window allows it
	waitResumeDone(t, s)                    // the executor's /run precedes its completion
	scanForResume(t, ts, baseline, "2min-old attempt + FORCED poll must re-fire (want >=1)", true)
	waitResumeDone(t, s)
}

// scanForResume fails when a resume command appears in runLog[baseline:]
// (wantFound=false — the held case) or fails to appear (wantFound=true).
func scanForResume(t *testing.T, ts *termuxStub, baseline int, msg string, wantFound ...bool) {
	t.Helper()
	want := len(wantFound) > 0 && wantFound[0]
	found := false
	for _, c := range ts.runHits()[baseline:] {
		if strings.Contains(c, "resume.sh") {
			found = true
		}
	}
	if found != want {
		t.Fatalf("%s (found=%v want=%v, log tail=%v)", msg, found, want, ts.runHits()[baseline:])
	}
}

// R7 — the executor's honest outcome on a bridge failure (never a panic).
func TestV1352_Resume_BridgeFailure_Honest(t *testing.T) {
	s, ts := newTestServerV1352(t)
	ts.statusMu.Lock()
	ts.bootstrapD = true
	ts.runStdout = ledgerPendingStdout
	ts.statusMu.Unlock()
	termuxStatus(t, s, "?refresh=1")

	// kill the bridge mid-flight: the executor records the failure honestly
	ts.srv.Close()
	s.termuxResumeTry()
	waitResumeDone(t, s)

	_, out := termuxStatus(t, s, "") // the bridge is dead — the honest ladder
	if out["resume_last_ok"] != false {
		t.Fatalf("a failed attempt must record last_ok=false, got %v", out["resume_last_ok"])
	}
	if msg, _ := out["resume_last_error"].(string); msg == "" {
		t.Fatalf("a failed attempt must name its error, got %v", out["resume_last_error"])
	}
}

// ── the harness ────────────────────────────────────────────────

// newTestServerV1352 builds a Server on a stub bridge (the termuxapi_test.go
// harness) — the resume tests' shared shape. Returns the Server (for direct
// executor/throttle access) + the stub (for /run observation + flip-ups).
func newTestServerV1352(t *testing.T) (*Server, *termuxStub) {
	t.Helper()
	ts := newTermuxStubBridge(t, true, true)
	s := newTermuxTestServer(t, ts.srv.URL)
	return s, ts
}

// runHits snapshots the stub's /run log.
func (st *termuxStub) runHits() []string {
	st.statusMu.Lock()
	defer st.statusMu.Unlock()
	out := make([]string, len(st.runLog))
	copy(out, st.runLog)
	return out
}

// termuxResumePost POSTs /api/termux/resume and decodes the JSON.
func termuxResumePost(t *testing.T, s *Server, ts *termuxStub) (int, map[string]any) {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/api/termux/resume", nil)
	rec := httptest.NewRecorder()
	s.mux.ServeHTTP(rec, req)
	var out map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("resume response not JSON (%d): %s", rec.Code, rec.Body.String())
	}
	return rec.Code, out
}

// waitResumeDone polls until the executor's flight lands (the stub answers
// instantly; the deadline is generosity, not expectation).
func waitResumeDone(t *testing.T, s *Server) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		s.termuxResumeMu.Lock()
		running := s.termuxResumeRunning
		s.termuxResumeMu.Unlock()
		if !running {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("the resume executor never landed within 5s")
}
