package server

// termuxphoenix.go — v1.74.7 THE PHOENIX HEART (PLAN-V175).
//
// The user's conviction (the boonboon transcript, hours in): "the app
// survived - continued, lost connection to termux, and I had to setup the
// termux command manually. This is unacceptable. If we can't have the
// command be a one time setup (truly one time) then we need a script to
// auto setup termux everytime it gets switched off. No user input needed
// at all."
//
// The observed death shape: Android killed Termux (the phantom process
// killer / an OEM battery pass / a reboot's stopped state) — the APK's
// loopback bridge stayed ALIVE (the app survived, chats continued), but
// every RUN_COMMAND timed out: even `echo test` at 5s never answered.
// The engine had no detection, no revival, no honesty — the model burned
// thirteen calls against a dead shell.
//
// This file is the engine-side half of the answer (the termuxresume.go
// pattern — additive, honest, single-flight):
//
//   - THE HEALTH GAUGE: every bridge outcome feeds it (the run choke
//     point + the probe cache fill observe). A delivered result resets
//     the gauge; a run TIMEOUT (the bridge answered, Termux never
//     executed — the transcript's exact signature) bumps it. A transport
//     error is NOT Termux death (that's the APK-side bridge down — the
//     engine's own watchdog owns that story) — the gauge only counts the
//     never-executed class.
//
//   - THE REVIVE LADDER (single-flight, throttled ≥90s): conviction =
//     2 consecutive run timeouts. Rung 1: a patient probe via /run with
//     a 30s budget + the heartbeat stamp — the startService itself
//     often revives a killed-not-stopped Termux (researched: a
//     foreground-service caller may start a killed app's service back).
//     Rung 2: the Kotlin revive_termux act (v1.74.8 THE PHOENIX HAND) —
//     a benign probe re-send + the Termux activity launch (legal from
//     background under the SYSTEM_ALERT_WINDOW grant; some OEMs allow it
//     regardless), then one more probe. Every rung lands in the honest
//     status fields — never silent magic.
//
//   - THE KEEPALIVE: a process-lifetime loop (netWakeListener's shape):
//     every ~15 min (jittered) — ONLY after Termux has answered at least
//     once (lastOK set: the quiet gate by construction — a delivered run
//     proves allow-external-apps is on, so the probe can never trigger
//     Termux's notification-spam path) — one cheap probe. Death is
//     caught within minutes instead of at the user's next command, and
//     the periodic RUN_COMMAND keeps the Termux service warm against the
//     OEM "unused app" passes.
//
//   - THE OBSERVATION TEACH: when the gauge convicts death, the TIMEOUT
//     observations grow the honest phoenix line — the model learns the
//     state ("the engine is auto-reviving Termux (attempt N); give it
//     ~30s") instead of burning calls against the dead shell.

import (
	"context"
	"log"
	"math/rand"
	"strings"
	"time"
)

// ── the gauge (the server struct fields live in server.go's termux block) ──

// termuxPhoenixState is the health gauge + the revive ladder's honest
// record. All fields guarded by termuxPhoenixMu.
type termuxPhoenixState struct {
	// the gauge
	consecutive int       // consecutive never-executed run outcomes
	lastOK      time.Time // the last delivered result (zero = never)
	lastFail    time.Time // the last never-executed outcome
	// the ladder
	running   bool      // a revive ladder is in flight (single-flight)
	attempts  int       // ladders started this process lifetime
	lastAt    time.Time // the last ladder's start (the throttle clock)
	lastOKL   bool      // the last ladder revived Termux
	lastError string    // the last ladder's honest failure reason
}

// termuxPhoenixConvictAt is the gauge's conviction threshold: 2
// consecutive never-executed outcomes (the transcript's signature was
// 13 — the model retried blind; one timeout may be a legitimate long
// command, two in a row is the dead shell).
const termuxPhoenixConvictAt = 2

// termuxPhoenixThrottle paces the ladder: never more than one ladder
// start per 90s (the transcript burned 13 timeouts in minutes — the
// throttle turns that into at most one honest attempt per window).
const termuxPhoenixThrottle = 90 * time.Second

// termuxPhoenixKeepaliveEvery is the keepalive cadence (±10% jitter per
// cycle) and termuxPhoenixKeepaliveFresh the window in which a prior OK
// keeps the keepalive armed. A Termux that has not answered in 2h is
// left alone (the user's own setup flow owns re-arming; the ladder
// still answers the moment a tool call times out twice).
const (
	termuxPhoenixKeepaliveEvery = 15 * time.Minute
	termuxPhoenixKeepaliveFresh = 2 * time.Hour
)

// The patient probe script (the Kotlin PROBE_SCRIPT's twin + the
// heartbeat stamp): the markers are the ground truth, the stamp feeds
// the diagnostic trail (~/.doomalay/alive — written by setup.sh's boot
// script too, v1.74.9).
const termuxPhoenixProbeScript = `echo __doomalay_probe__; mkdir -p "$HOME/.doomalay" 2>/dev/null; date +%s > "$HOME/.doomalay/alive" 2>/dev/null; test -d "$HOME/storage/shared" && echo storage_ok || echo storage_missing; grep -q "^allow-external-apps" "$HOME/.termux/termux.properties" 2>/dev/null && echo props_ok || echo props_missing`

// termuxPhoenixMarker — the probe's round-trip proof (the client's own
// probe law: no marker → the command never ran).
const termuxPhoenixMarker = "__doomalay_probe__"

// termuxPhoenixObserveOK records a delivered Termux result (any run
// that answered, any probe with markers): the gauge resets, the
// last-known-good clock stamps. Called from the run choke point and the
// probe cache fill — cheap (a few locked writes), never blocking.
func (s *Server) termuxPhoenixObserveOK() {
	s.termuxPhoenixMu.Lock()
	s.termuxPhoenix.consecutive = 0
	s.termuxPhoenix.lastOK = time.Now()
	s.termuxPhoenixMu.Unlock()
}

// termuxPhoenixObserveFail records a never-executed outcome (the bridge
// answered but Termux never ran the command — the timeout signature).
// The gauge bumps; at the conviction threshold the revive ladder fires
// (asynchronously — the caller never blocks on a revival).
func (s *Server) termuxPhoenixObserveFail() {
	s.termuxPhoenixMu.Lock()
	s.termuxPhoenix.consecutive++
	s.termuxPhoenix.lastFail = time.Now()
	convicted := s.termuxPhoenix.consecutive >= termuxPhoenixConvictAt
	s.termuxPhoenixMu.Unlock()
	// the ladder spawn guards its own nil bridge (the gauge is a pure
	// state machine — it counts even on a bridge-less server, which
	// never produces observations in production anyway)
	if convicted {
		go s.termuxPhoenixMaybeRevive()
	}
}

// termuxPhoenixMaybeRevive starts the ladder when the throttle allows
// (single-flight + ≥90s between ladders). The caller is always a
// goroutine — this never blocks a turn.
func (s *Server) termuxPhoenixMaybeRevive() {
	s.termuxPhoenixMu.Lock()
	now := time.Now()
	if s.termuxPhoenix.running || now.Sub(s.termuxPhoenix.lastAt) < termuxPhoenixThrottle {
		s.termuxPhoenixMu.Unlock()
		return
	}
	s.termuxPhoenix.running = true
	s.termuxPhoenix.attempts++
	s.termuxPhoenix.lastAt = now
	n := s.termuxPhoenix.attempts
	s.termuxPhoenixMu.Unlock()

	log.Printf("TERMUX PHOENIX: death convicted (%d never-executed runs) — revive ladder #%d starting", termuxPhoenixConvictAt, n)
	revived, why := s.termuxPhoenixLadder()

	s.termuxPhoenixMu.Lock()
	s.termuxPhoenix.running = false
	s.termuxPhoenix.lastOKL = revived
	s.termuxPhoenix.lastError = why
	if revived {
		// the revival is also a delivered result — the gauge resets so the
		// next honest timeout starts the count fresh
		s.termuxPhoenix.consecutive = 0
	}
	s.termuxPhoenixMu.Unlock()
	if revived {
		log.Printf("TERMUX PHOENIX: ladder #%d REVIVED Termux", n)
	} else {
		log.Printf("TERMUX PHOENIX: ladder #%d could not revive: %s", n, why)
	}
}

// termuxPhoenixLadder is the revival itself, synchronously run on the
// ladder's goroutine. Rung 1: the patient probe (30s — cold start is
// slow). Rung 2: the Kotlin revive act (probe re-send + activity
// launch) then one more probe. Returns (revived, honestWhy).
func (s *Server) termuxPhoenixLadder() (bool, string) {
	// a bridge-less engine (a desktop build) — the honest no-op verdict
	if s.termux == nil {
		return false, "this engine has no Termux bridge (a desktop build) — nothing to revive"
	}
	// RUNG 1 — the patient probe. The /run route's own budget rides the
	// body (30s: process cold start after a kill is 5-15s observed; the
	// bridge's /probe route cuts at 15s fixed, so the ladder rides /run).
	ran, bridgeDead := s.termuxPhoenixProbe(30 * time.Second)
	if ran {
		return true, ""
	}
	if bridgeDead {
		return false, "the APK's bridge itself is unreachable — the engine's own watchdog owns the restart; Termux revival is moot until the app returns"
	}

	// RUNG 2 — the Kotlin hand: a benign RUN_COMMAND re-send + the
	// Termux activity launch (v1.74.8). An old bridge that predates the
	// act answers 400 unknown-what — honestly reported, never fatal to
	// the ladder (the probe below still gets its chance; the launch was
	// the extra arm an old APK simply does not carry).
	actCtx, actCancel := context.WithTimeout(context.Background(), 35*time.Second)
	_, actErr := s.termux.Act(actCtx, "revive_termux")
	actCancel()
	if actErr != nil {
		log.Printf("TERMUX PHOENIX: the revive_termux act did not answer (%v) — the pre-v1.74.8 bridge law: probing directly", actErr)
	}

	// The activity launch (when it fired) needs a breath to take effect —
	// the stopped-state package must come up before a RUN_COMMAND can
	// execute.
	time.Sleep(3 * time.Second)
	ran, bridgeDead = s.termuxPhoenixProbe(25 * time.Second)
	if ran {
		return true, ""
	}
	if bridgeDead {
		return false, "the APK's bridge went unreachable mid-ladder — the engine's own watchdog owns the restart"
	}

	// The honest verdict: the common unstoppable cause is Android's
	// stopped state (force-stop / fresh boot) — the activity launch is
	// the only ladder out and it needs the overlay grant (or an OEM that
	// allows service-context launches); without it, the next app open
	// revives. Say exactly that.
	return false, "Termux did not answer the probe after the revive ladder — Android likely holds it in the stopped state (a force-stop or a fresh boot); the background activity launch needs the display-over-other-apps grant, or one manual Termux open"
}

// termuxPhoenixProbe runs ONE patient probe round-trip through /run
// (the body's timeout_ms carries the budget the fixed-15s /probe route
// cannot) and reports whether Termux truly executed it (the marker law).
// bridgeDead=true means the transport itself failed — NOT Termux's
// story (the APK-side bridge is down; the gauge must not count it).
func (s *Server) termuxPhoenixProbe(deadline time.Duration) (ran, bridgeDead bool) {
	ctx, cancel := context.WithTimeout(context.Background(), deadline+5*time.Second)
	defer cancel()
	res, err := s.termux.Run(ctx, termuxPhoenixProbeScript, "", int(deadline.Milliseconds()))
	if err != nil {
		return false, true // the transport itself failed — the APK bridge's own story
	}
	if res == nil {
		return false, true
	}
	if res.Timeout {
		return false, false // the bridge answered; Termux never executed
	}
	if strings.Contains(res.Stdout, termuxPhoenixMarker) {
		s.termuxPhoenixObserveOK() // the revival worked — the gauge learns
		return true, false
	}
	return false, false
}

// termuxPhoenixNoteLine is the OBSERVATION TEACH: the honest line the
// timeout observations carry while a ladder is in flight or freshly
// done. "" when there is nothing to teach (no conviction on record).
func (s *Server) termuxPhoenixNoteLine() string {
	s.termuxPhoenixMu.Lock()
	defer s.termuxPhoenixMu.Unlock()
	st := s.termuxPhoenix
	if st.consecutive < termuxPhoenixConvictAt && !st.running && st.lastAt.IsZero() {
		return ""
	}
	var sb strings.Builder
	sb.WriteString("\n[termux: the shell appears DEAD — ")
	if st.running {
		sb.WriteString("the engine's auto-revive ladder is RUNNING right now (attempt ")
		sb.WriteString(itoaPhoenix(st.attempts))
		sb.WriteString("); give it ~30s before the next command]")
		return sb.String()
	}
	if !st.lastAt.IsZero() && time.Since(st.lastAt) < 10*time.Minute {
		if st.lastOKL {
			sb.WriteString("the engine's auto-revive ladder #")
			sb.WriteString(itoaPhoenix(st.attempts))
			sb.WriteString(" BROUGHT IT BACK — Termux is alive again, retry now]")
			return sb.String()
		}
		sb.WriteString("revive ladder #")
		sb.WriteString(itoaPhoenix(st.attempts))
		sb.WriteString(" could not revive it (")
		sb.WriteString(st.lastError)
		sb.WriteString("); one manual Termux open fixes it, or grant display-over-other-apps so the engine can launch it alone]")
		return sb.String()
	}
	sb.WriteString("the engine auto-revives on the next timeout; retry once, and if it times out again wait ~90s for the ladder]")
	return sb.String()
}

// itoaPhoenix is the tiny local itoa (strconv stays out of this file's
// teach path — the note line is pure formatting).
func itoaPhoenix(n int) string {
	if n <= 0 {
		return "0"
	}
	var b [20]byte
	i := len(b)
	for n > 0 {
		i--
		b[i] = byte('0' + n%10)
		n /= 10
	}
	return string(b[i:])
}

// termuxPhoenixStatus is the honest snapshot for /api/termux/status
// (additive fields — an old PWA ignores them byte-identically).
type termuxPhoenixStatus struct {
	Consecutive    int    `json:"phoenix_consecutive_failures"`
	LastOKAt       int64  `json:"phoenix_last_ok_at"`
	ReviveRunning  bool   `json:"phoenix_revive_running"`
	ReviveAttempts int    `json:"phoenix_revive_attempts"`
	ReviveLastAt   int64  `json:"phoenix_revive_last_at"`
	ReviveLastOK   bool   `json:"phoenix_revive_last_ok"`
	ReviveLastErr  string `json:"phoenix_revive_last_error"`
}

// termuxPhoenixSnapshot reads the gauge under the lock.
func (s *Server) termuxPhoenixSnapshot() termuxPhoenixStatus {
	s.termuxPhoenixMu.Lock()
	defer s.termuxPhoenixMu.Unlock()
	st := s.termuxPhoenix
	var lastOKAt, lastAt int64
	if !st.lastOK.IsZero() {
		lastOKAt = st.lastOK.Unix()
	}
	if !st.lastAt.IsZero() {
		lastAt = st.lastAt.Unix()
	}
	return termuxPhoenixStatus{
		Consecutive:    st.consecutive,
		LastOKAt:       lastOKAt,
		ReviveRunning:  st.running,
		ReviveAttempts: st.attempts,
		ReviveLastAt:   lastAt,
		ReviveLastOK:   st.lastOKL,
		ReviveLastErr:  st.lastError,
	}
}

// termuxPhoenixKeepalive is the process-lifetime loop: every ~15 min
// (jittered), when Termux answered within the fresh window, one cheap
// probe. The probe feeds the gauge (death convicted within minutes) and
// the RUN_COMMAND itself keeps the Termux service warm against the OEM
// "unused app" passes. The quiet gate is CONSTRUCTIVE: the loop only
// fires after a delivered result has stamped lastOK (a delivered run
// proves allow-external-apps is on — Termux's notification-spam path is
// unreachable by construction). Runs on context.Background() (the
// detachment law), started next to netWakeListener in server.go.
func (s *Server) termuxPhoenixKeepalive() {
	for {
		// per-cycle jitter (±10%) — no thundering herd with the other loops
		d := termuxPhoenixKeepaliveEvery
		d += time.Duration(float64(d) * (0.2*rand.Float64() - 0.1))
		time.Sleep(d)

		if s.termux == nil {
			continue
		}
		s.termuxPhoenixMu.Lock()
		lastOK := s.termuxPhoenix.lastOK
		running := s.termuxPhoenix.running
		s.termuxPhoenixMu.Unlock()
		if running || lastOK.IsZero() || time.Since(lastOK) > termuxPhoenixKeepaliveFresh {
			// never probed OK (pre-bootstrap — the quiet gate), a ladder
			// already in flight, or Termux has been dark >2h (the user's
			// own flow owns that re-arm) — hold fire.
			continue
		}
		ran, bridgeDead := s.termuxPhoenixProbe(30 * time.Second)
		if ran {
			continue // warm + the gauge already stamped OK
		}
		if bridgeDead {
			continue // the APK bridge's own story — not a Termux death
		}
		// the probe timed out — ONE never-executed outcome feeds the gauge
		// (the ladder fires at two: the next tool call's timeout or the
		// next keepalive cycle finishes the conviction honestly)
		s.termuxPhoenixObserveFail()
	}
}
