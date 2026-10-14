package server

// termuxresume.go — v1.35.2 THE QUIET FINISHER (PLAN-V136 §v1.35.2).
//
// The engine side of THE FINISHER WAVE: an offline Termux setup leaves a
// ledger ($HOME/.doomalay-setup/state, written by termux/setup.sh v1.35.1)
// saying what stayed pending — and THIS file is how the pending steps
// complete when the device is back online, without the user remembering,
// re-running, or babysitting anything.
//
// Three moving parts, all riding the EXISTING bridge routes (zero Kotlin
// changes, the additive law all the way down):
//
//   - THE STATE READ: a bridge /run of a one-liner that cats the ledger
//     behind a round-trip marker (the probe's marker law — no marker → the
//     command never ran → the honest unknown). TTL-cached + single-flight
//     (the probe-cache pattern in termuxapi.go), and gated by THE QUIET
//     GATE (bootstrapDone || propsOK) exactly like the auto-probe: zero
//     RUN_COMMANDs pre-bootstrap, zero notification-spam risk.
//
//   - THE RESUME EXECUTOR: POST /api/termux/resume (the UI's finish button,
//     and the throttled auto-attempt below) fires
//     `bash "$HOME/.doomalay-setup/resume.sh" --checkin <fresh url>` through
//     the bridge /run. resume.sh (setup.sh's own artifact) is offline-safe
//     by construction: still-offline it exits 0 in seconds with nothing
//     touched; online it completes the pending steps, rewrites the ledger,
//     and re-checkins. Single-flight: one attempt at a time, ever. The
//     executor answers "started" immediately — the UI's existing poll
//     observes resume_running / resume_last_*.
//
//   - THE THROTTLED AUTO-ATTEMPT: handleTermuxStatus sees pkgs=pending and
//     fires the executor in a goroutine when the throttle allows — 10 min
//     for background polls, 60s for forced fetches (?refresh=1: the user's
//     explicit moment — a check-now tap, the WebView's `online` event).
//     Never blocks the status answer; never two at once.
//
// THE HONESTY LAW (the file this lives beside): every failure is a STATUS
// FIELD (resume_last_ok / resume_last_error), never a 500; a missing ledger
// is the honest empty state (an old script never wrote one), never an error.

import (
	"context"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// termuxCheckinRE is the engine-side twin of the PWA's CHECKIN_URL_RE
// (termuxsetup.js): the exact legal checkin URL shape — loopback host,
// port, UUID-ish token path, /checkin tail. Nothing else is ever composed
// into a shell line.
var termuxCheckinRE = regexp.MustCompile(`^https?://127\.0\.0\.1:[0-9]+/[a-f0-9-]+/checkin$`)

// The state-read command: the round-trip marker first (the probe's law —
// proves the command RAN in Termux), then the ledger (absent file → empty
// output → the honest old-script state). $HOME inside the command resolves
// on the TERMUX side (the bridge runs it as Termux).
const termuxStateCmd = `echo __doomalay_state__; cat "$HOME/.doomalay-setup/state" 2>/dev/null`

// termuxStateMarker — without it the stdout proves nothing.
const termuxStateMarker = "__doomalay_state__"

// The state-read costs a RUN_COMMAND round-trip like the probe (~1-15s);
// the setup UI polls every 3s — cache it (a shorter TTL than the probe's
// 30s: the ledger is the recovery's live truth, the pending→ok flip should
// surface in one poll after a resume lands).
const termuxStateTTL = 15 * time.Second

// termuxStateDeadline bounds one state-read round-trip (the bridge's own
// run default is minutes — we want a snappy failure instead; a busy Termux
// gets retried on the next TTL miss).
const termuxStateDeadline = 20 * time.Second

// The auto-attempt throttles (PLAN-V136 §v1.35.2): background polls pace
// themselves at 10 minutes; a FORCED status fetch (?refresh=1 — the user's
// explicit moment: the check-now tap, the WebView's online event) gets the
// 60s window — "when the user does try to use the network" is exactly when
// the finisher should be allowed to sprint.
const (
	termuxResumeAutoEvery   = 10 * time.Minute
	termuxResumeForcedEvery = 60 * time.Second
	termuxResumeDeadline    = 12 * time.Minute
)

// termuxStateSnapshot is one cached ledger read.
type termuxStateSnapshot struct {
	at    time.Time
	state map[string]string // nil = unknown (no marker / read error)
	// absent: the marker landed and the ledger file was not there — the
	// honest "the script predates the ledger" state (NOT an error).
	absent bool
}

// parseTermuxState turns the state-read stdout into the ledger map.
// Marker law: no marker → nil (the command never ran — honest unknown).
// Lines are strict key=value; unknown keys ride along (additive future).
func parseTermuxState(stdout string) map[string]string {
	if !strings.Contains(stdout, termuxStateMarker) {
		return nil
	}
	out := map[string]string{}
	for _, line := range strings.Split(stdout, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || line == termuxStateMarker || !strings.Contains(line, "=") {
			continue
		}
		k, v, _ := strings.Cut(line, "=")
		k = strings.TrimSpace(k)
		v = strings.TrimSpace(v)
		if k == "" || v == "" {
			continue
		}
		out[k] = v
	}
	return out
}

// termuxStateCached returns the cached state snapshot (TTL termuxStateTTL),
// reading on miss. gateOpen is THE QUIET GATE (bootstrapDone || propsOK):
// closed → the stale snapshot serves and NO RUN_COMMAND fires (the same
// suppression shape as the probe). force=true (a ?refresh=1 fetch — the
// user's explicit moment: a check-now tap, the WebView's online event)
// bypasses the TTL; the quiet gate still applies (a forced read with the
// gate closed fires nothing — that is the gate's whole point).
// Concurrent callers share one flight.
func (s *Server) termuxStateCached(gateOpen, force bool) termuxStateSnapshot {
	s.termuxStateMu.Lock()
	if !force && time.Since(s.termuxState.at) < termuxStateTTL {
		snap := s.termuxState
		s.termuxStateMu.Unlock()
		return snap
	}
	if s.termuxStateFlight != nil {
		flight := s.termuxStateFlight
		s.termuxStateMu.Unlock()
		<-flight
		s.termuxStateMu.Lock()
		snap := s.termuxState
		s.termuxStateMu.Unlock()
		return snap
	}
	if !gateOpen {
		// THE QUIET GATE: serve the stale snapshot (possibly zero), fire
		// nothing — the ledger can only exist post-bootstrap anyway.
		snap := s.termuxState
		s.termuxStateMu.Unlock()
		return snap
	}
	flight := make(chan struct{})
	s.termuxStateFlight = flight
	s.termuxStateMu.Unlock()

	snap := s.readTermuxState()

	s.termuxStateMu.Lock()
	s.termuxState = snap
	s.termuxStateFlight = nil
	close(flight)
	s.termuxStateMu.Unlock()
	return snap
}

// readTermuxState performs one state-read round-trip (outside the mutex,
// on its own deadline — a canceled poll must not poison the shared fill).
func (s *Server) readTermuxState() termuxStateSnapshot {
	ctx, cancel := context.WithTimeout(context.Background(), termuxStateDeadline)
	defer cancel()
	res, err := s.termux.Run(ctx, termuxStateCmd, "", 0)
	if err != nil || res == nil {
		return termuxStateSnapshot{at: time.Now()} // state nil = unknown
	}
	if !strings.Contains(res.Stdout, termuxStateMarker) {
		// the bridge answered but the command never ran (the probe's law)
		return termuxStateSnapshot{at: time.Now()}
	}
	if res.Stdout == termuxStateMarker || strings.TrimSpace(strings.TrimPrefix(res.Stdout, termuxStateMarker)) == "" {
		// marker + empty body: the ledger file is not there — the honest
		// old-script absence (NOT unknown)
		return termuxStateSnapshot{at: time.Now(), state: map[string]string{}, absent: true}
	}
	st := parseTermuxState(res.Stdout)
	if st == nil {
		return termuxStateSnapshot{at: time.Now()}
	}
	return termuxStateSnapshot{at: time.Now(), state: st}
}

// termuxStateInvalidate drops the cached snapshot (a resume just moved —
// the next status poll must re-read, not serve the stale pending).
func (s *Server) termuxStateInvalidate() {
	s.termuxStateMu.Lock()
	s.termuxState = termuxStateSnapshot{}
	s.termuxStateMu.Unlock()
}

// termuxResumeStatus is the honest snapshot of the executor's state.
type termuxResumeStatus struct {
	running bool
	lastAt  int64
	lastOK  bool
	lastErr string
}

// termuxResumeTry starts ONE resume attempt (single-flight) and answers
// immediately. The caller (the POST route or the status auto-attempt) never
// blocks on the run itself. Returns (started, alreadyRunning).
func (s *Server) termuxResumeTry() (bool, bool) {
	s.termuxResumeMu.Lock()
	if s.termuxResumeRunning {
		s.termuxResumeMu.Unlock()
		return false, true
	}
	s.termuxResumeRunning = true
	s.termuxResumeMu.Unlock()

	go s.termuxResumeRun()
	return true, false
}

// termuxResumeRun is the executor body: compose the resume command (the
// fresh checkin URL when the bridge hands one out — regex-validated, the
// PWA's CHECKIN_URL_RE twin), run it through the bridge with a 12-minute
// budget, record the honest outcome, invalidate the state cache so the
// next poll re-reads the ledger the resume just rewrote.
func (s *Server) termuxResumeRun() {
	defer func() {
		s.termuxResumeMu.Lock()
		s.termuxResumeRunning = false
		s.termuxResumeMu.Unlock()
		s.termuxStateInvalidate()
	}()

	// the fresh checkin URL (one cheap /status round-trip; the Kotlin side
	// holds the token — an old bridge answers empty and resume.sh runs
	// without the bell, the ledger stays the truth)
	checkin := ""
	stCtx, stCancel := context.WithTimeout(context.Background(), 5*time.Second)
	if st, err := s.termux.Status(stCtx); err == nil && st != nil {
		checkin = st.CheckinURL
	}
	stCancel()

	cmd := `bash "$HOME/.doomalay-setup/resume.sh"`
	if checkin != "" && termuxCheckinRE.MatchString(checkin) {
		cmd += " --checkin " + checkin
	}

	ctx, cancel := context.WithTimeout(context.Background(), termuxResumeDeadline)
	defer cancel()
	res, err := s.termux.Run(ctx, cmd, "", 0)

	s.termuxResumeMu.Lock()
	s.termuxResumeLastAt = time.Now().Unix()
	if err != nil {
		s.termuxResumeLastOK = false
		s.termuxResumeLastError = err.Error()
	} else if res == nil {
		s.termuxResumeLastOK = false
		s.termuxResumeLastError = "the bridge returned no result"
	} else if res.ExitCode != 0 {
		// resume.sh exits 0 for "still offline" (the honest no-op) — a
		// non-zero exit is a REAL failure worth naming
		s.termuxResumeLastOK = false
		s.termuxResumeLastError = "resume.sh exited " + strconv.Itoa(res.ExitCode)
	} else {
		s.termuxResumeLastOK = true
		s.termuxResumeLastError = ""
	}
	s.termuxResumeMu.Unlock()
}

// termuxResumeSnapshot reads the executor's honest state under the lock.
func (s *Server) termuxResumeSnapshot() termuxResumeStatus {
	s.termuxResumeMu.Lock()
	defer s.termuxResumeMu.Unlock()
	return termuxResumeStatus{
		running: s.termuxResumeRunning,
		lastAt:  s.termuxResumeLastAt,
		lastOK:  s.termuxResumeLastOK,
		lastErr: s.termuxResumeLastError,
	}
}

// termuxMaybeAutoResume is the throttled auto-attempt hook (called from
// handleTermuxStatus AFTER the snapshot lands): pending + throttle ok →
// fire. forced=true (a ?refresh=1 fetch) rides the shorter 60s window —
// the user's explicit moment. Never blocks: the attempt itself is a
// goroutine spawn.
func (s *Server) termuxMaybeAutoResume(pending bool, forced bool) {
	if !pending || s.termux == nil {
		return
	}
	window := termuxResumeAutoEvery
	if forced {
		window = termuxResumeForcedEvery
	}
	now := time.Now()
	s.termuxResumeMu.Lock()
	at := time.Unix(s.termuxResumeAutoAt, 0)
	running := s.termuxResumeRunning
	if running || now.Sub(at) < window {
		s.termuxResumeMu.Unlock()
		return
	}
	s.termuxResumeAutoAt = now.Unix()
	s.termuxResumeMu.Unlock()
	s.termuxResumeTry()
}

// handleTermuxResume is POST /api/termux/resume — the finish button (and
// any future caller). Honest shapes: the pending ledger must be KNOWN
// (a state read forces through regardless of the quiet gate — an explicit
// user action, the same law as the probe's ?refresh=1); nothing pending →
// 400 with the reason; else the executor starts and 200 answers
// {ok, started, already_running}. The run's LIVE progress rides the next
// status polls (resume_running / resume_last_*), never this response.
func (s *Server) handleTermuxResume(w http.ResponseWriter, r *http.Request) {
	if s.termux == nil {
		writeError(w, http.StatusBadRequest, "termux bridge not configured on this engine")
		return
	}
	// the explicit user action forces the state read through the TTL (and
	// through the quiet gate — same law as the probe's ?refresh=1)
	snap := s.termuxStateCached(true, true)
	pending := snap.state != nil && snap.state["pkgs"] == "pending"
	if !pending {
		if snap.absent {
			writeError(w, http.StatusBadRequest, "nothing pending — this device's setup has no pending ledger (the setup predates the finisher, or it completed)")
			return
		}
		writeError(w, http.StatusBadRequest, "nothing pending — the setup ledger is complete (or the bridge cannot read it right now)")
		return
	}
	started, already := s.termuxResumeTry()
	writeJSON(w, 200, map[string]any{
		"ok":              true,
		"started":         started,
		"already_running": already,
	})
}
