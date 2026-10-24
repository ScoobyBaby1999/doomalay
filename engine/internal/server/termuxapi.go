package server

// termuxapi.go — v1.17.2 THE BRIDGE: the engine-side Termux surface
// (PLAN-V117 §v1.17.2). v1.20.1 THE QUIET GATE (PLAN-V120 §v1.20.1): the
// checkin passthrough + the probe-suppression law live here too.
//
// GET /api/termux/status aggregates two things from the APK's Kotlin
// TermuxBridgeServer (the loopback server EngineService hosts at
// http://127.0.0.1:<port>/<token>):
//
//   - /status (fresh every call — a PackageManager lookup, sub-millisecond)
//   - /probe  (the RUN_COMMAND round-trip — CACHED, TTL 30s, ?refresh=1
//     forces a re-probe)
//
// THE HONESTY LAW: every Termux-side problem (not installed, permission
// missing, bridge dead, Termux timed out, wrong token) is a STATUS FIELD,
// never a 500. bridge_ok means "the probe round-trip delivered a result";
// ready = bridge_ok && storage_ok && installed && permission. Only OUR side
// failing (a marshal error) can 5xx.
//
// POST /api/termux/act is the v1.17.3 setup overlay's action surface: the
// open_termux / open_fdroid / open_permission_settings intents fire through
// the bridge on the APK side.

import (
	"context"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"runtime"
	"strings"
	"time"

	"github.com/ScoobyBaby1999/doomalay/engine/internal/llm"
	"github.com/ScoobyBaby1999/doomalay/engine/internal/termuxbridge"
)

// netWakeListener (v1.39.4 THE NET WAKE): the bridge long-poll loop — the
// push channel that carries Android's own connectivity truth into the
// engine's retry machinery. The Kotlin side (EngineService) registers a
// ConnectivityManager.NetworkCallback; onAvailable (a VALIDATED network)
// bumps the bridge's net seq; this loop's /netwait long-poll releases the
// moment that happens; a seq bump becomes llm.WakeNet() and every
// suspended retry waiter (v1.39.3 THE PATIENT ENGINE) retries within ~1s
// of the network's return — fixed timers are the backstop, never the
// trigger (the connectivity law).
//
// The loop is process-lifetime and self-healing: a bridge hiccup
// (restart window, token rotation) is logged quietly and re-polled after
// a short backoff — the wake signal is best-effort speed, the jittered
// rungs underneath are the correctness guarantee. Runs on
// context.Background() (the detachment law: never a request's ctx).
func (s *Server) netWakeListener() {
	ctx := context.Background()
	var since int64
	for {
		seq, timedOut, err := s.termux.NetWait(ctx, since, 30000)
		if err != nil {
			// Bridge down/mid-restart — the v1.17.2 honesty law applies to
			// this loop too: quiet log, short backoff, keep polling.
			time.Sleep(3 * time.Second)
			continue
		}
		if !timedOut && seq > since {
			// A wake. (A plain timeout with seq==since is the honest
			// "nothing happened" — no wake, no log spam.)
			log.Printf("NET WAKE: bridge net seq %d (was %d) — connectivity regained, waking suspended retry waiters", seq, since)
			llm.WakeNet()
		}
		since = seq
	}
}

// termuxProbeCache is the cached probe outcome (guarded by termuxMu).
// A probe with a transport error is cached too — a dead bridge answering
// every poll with a fresh 20s timeout would starve the setup UI.
// v1.20.1: suppressed marks THE QUIET GATE holding — the last TTL-expiry
// auto-probe was answered from the STALE cache (no RUN_COMMAND fired);
// a real probe (auto or forced) resets it.
type termuxProbeCache struct {
	at         time.Time               // when the probe finished (zero = never probed)
	result     *termuxbridge.RunResult // nil when the probe errored
	err        error                   // typed client error (refused/timeout/403/…)
	suppressed bool                    // v1.20.1: the last auto-probe was quiet-gated away
}

// The probe costs a real RUN_COMMAND round-trip through Termux (~1-15s);
// the setup overlay polls every few seconds — cache it.
const termuxProbeTTL = 30 * time.Second

// termuxProbeDeadline bounds one probe round-trip (the bridge itself times
// out at 15s; +5s slack for the HTTP hop).
const termuxProbeDeadline = 20 * time.Second

// termuxProbePausedNote is the honest quiet-gate line: the stale answer is
// served ON PURPOSE — termux-app forces a notification for EVERY
// RUN_COMMAND while allow-external-apps is unset, so the auto-probe stays
// paused until the bootstrap's checkin lands (or an explicit ?refresh=1).
const termuxProbePausedNote = "probe paused — waiting for the Termux bootstrap (step 2) to avoid Termux spam notifications"

// handleTermuxStatus is GET /api/termux/status.
func (s *Server) handleTermuxStatus(w http.ResponseWriter, r *http.Request) {
	if s.termux == nil {
		// Honest: this engine was not configured with a bridge — every
		// desktop build (the capability is APK-only by plan) and any APK run
		// where the loopback server failed to start.
		writeJSON(w, 200, map[string]any{"available": false})
		return
	}

	// Status half — fresh every call (cheap on the Kotlin side).
	stCtx, stCancel := context.WithTimeout(r.Context(), 5*time.Second)
	st, stErr := s.termux.Status(stCtx)
	stCancel()

	// v1.23.1 THE LINK: every status poll warms the F-Droid resolver in
	// the background (one flight, 6h cache) — the setup page's Get-Termux
	// tap answers the CURRENT stable link instantly. Never blocks the
	// status answer; never errors.
	s.warmFdroidURL()

	// THE v1.20.1 QUIET GATE: the auto-probe may fire ONLY when the state
	// makes it safe — see termuxCanAutoProbe. ?refresh=1 (an explicit user
	// action: a tap, a check-now, the verify stage) always bypasses it.
	bootstrapDone := st != nil && st.BootstrapDone
	canAutoProbe := s.termuxCanAutoProbe(bootstrapDone)

	// Probe half — cached (TTL 30s); ?refresh=1 forces a re-probe.
	pr, prErr, suppressed := s.termuxProbeCached(r.URL.Query().Get("refresh") == "1", canAutoProbe)

	var installed, permission bool
	var versionCode int64
	var versionName string
	var apiInstalled bool
	if st != nil {
		installed = st.Installed
		versionCode = st.VersionCode
		versionName = st.VersionName
		permission = st.Permission
		apiInstalled = st.APIInstalled
	}
	bridgeOK := prErr == nil
	var storageOK, propsOK bool
	if pr != nil {
		storageOK = pr.StorageOK
		propsOK = pr.PropsOK
	}
	// v1.20.1: the checkin passthrough (an old bridge that never reports
	// them stays empty/false — the honest old-flow state).
	var checkinURL string
	var checkinAt int64
	var checkinStorage, checkinProps bool
	if st != nil {
		checkinURL = st.CheckinURL
		checkinAt = st.CheckinAt
		checkinStorage = st.CheckinStorage
		checkinProps = st.CheckinProps
	}
	// v1.35.2 THE QUIET FINISHER: the ledger state read rides the SAME
	// quiet gate as the auto-probe (bootstrapDone || propsOK) — zero
	// RUN_COMMANDs pre-bootstrap. The pending ledger then arms the
	// throttled auto-attempt (a FORCED fetch rides the short window —
	// the user's explicit moment: a check-now tap, the WebView's online
	// event). The status answer itself never blocks on any of this.
	gateOpen := bootstrapDone || (pr != nil && pr.PropsOK)
	forcedFetch := r.URL.Query().Get("refresh") == "1"
	snap := s.termuxStateCached(gateOpen, forcedFetch)
	pkgsState := ""
	pkgsPending := false
	if snap.state != nil {
		pkgsState = snap.state["pkgs"]
		pkgsPending = pkgsState == "pending"
	}
	resume := s.termuxResumeSnapshot()
	s.termuxMaybeAutoResume(pkgsPending, forcedFetch)

	var lastError string
	if stErr != nil || prErr != nil {
		var parts []string
		if stErr != nil {
			parts = append(parts, "status: "+stErr.Error())
		}
		if prErr != nil {
			parts = append(parts, "probe: "+prErr.Error())
		}
		lastError = strings.Join(parts, "; ")
	}
	if suppressed {
		// the quiet gate is a VISIBLE state, never silence — say so
		if lastError == "" {
			lastError = termuxProbePausedNote
		} else {
			lastError = strings.Join([]string{lastError, termuxProbePausedNote}, "; ")
		}
	}

	// v1.74.7 THE PHOENIX HEART (additive — the old PWA ignores these): the
	// health gauge + the revive ladder's honest record ride the status answer
	// so any surface can see the auto-revive state without polling anything.
	ph := s.termuxPhoenixSnapshot()

	writeJSON(w, 200, map[string]any{
		"available":       true,
		"android":         runtime.GOOS == "android", // runtime check — same binary every platform
		"installed":       installed,
		"api_installed":   apiInstalled, // v1.28.3: the Termux:API companion app (the device-commands unlock)
		"version_code":    versionCode,
		"version_name":    versionName,
		"permission":      permission,
		"bridge_ok":       bridgeOK,
		"storage_ok":      storageOK,
		"props_ok":        propsOK,
		"ready":           bridgeOK && storageOK && installed && permission,
		"checkin_url":     checkinURL,
		"bootstrap_done":  bootstrapDone,
		"checkin_at":      checkinAt,
		"checkin_storage": checkinStorage,
		"checkin_props":   checkinProps,
		// v1.35.2 THE QUIET FINISHER (additive — the old PWA ignores
		// these; an old script's device answers the honest empty state)
		"pkgs_state":        pkgsState,
		"pkgs_pending":      pkgsPending,
		"resume_running":    resume.running,
		"resume_last_at":    resume.lastAt,
		"resume_last_ok":    resume.lastOK,
		"resume_last_error": resume.lastErr,
		"probe_suppressed":  suppressed,
		"last_error":        lastError,
		"checked_at":        time.Now().Unix(),
		// v1.74.7 THE PHOENIX HEART: the gauge + the ladder's record
		"phoenix_consecutive_failures": ph.Consecutive,
		"phoenix_last_ok_at":           ph.LastOKAt,
		"phoenix_revive_running":       ph.ReviveRunning,
		"phoenix_revive_attempts":      ph.ReviveAttempts,
		"phoenix_revive_last_at":       ph.ReviveLastAt,
		"phoenix_revive_last_ok":       ph.ReviveLastOK,
		"phoenix_revive_last_error":    ph.ReviveLastErr,
	})
}

// termuxCanAutoProbe decides THE QUIET GATE for the auto-probe (a
// TTL-expiry miss, not a forced one): it may fire ONLY when
//
//	(a) the cached probe honestly says props are ON (keep verifying as
//	    before — those probes never trigger the notification path),
//	(b) the bootstrap checkin arrived (bootstrapDone: the script just set
//	    the props — a probe is safe), or
//	(c) the cache has NEVER been filled (one first look to learn the
//	    state honestly).
//
// Otherwise the stale cache serves past TTL: termux-app FORCES a
// notification for every RUN_COMMAND while allow-external-apps is unset
// (RunCommandService's own design), so a 30s-TTL probe loop while the
// user reads the bootstrap is one notification per 30 seconds of spam —
// exactly the user's report. bootstrapDone comes from the FRESH /status
// half; the cache bits are read under the lock.
func (s *Server) termuxCanAutoProbe(bootstrapDone bool) bool {
	if bootstrapDone {
		return true
	}
	s.termuxMu.Lock()
	defer s.termuxMu.Unlock()
	if s.termuxCache.at.IsZero() {
		return true // never filled — the first look is honest, not spam
	}
	return s.termuxCache.result != nil && s.termuxCache.result.PropsOK
}

// termuxProbeCached returns the cached probe (TTL termuxProbeTTL), probing
// on miss; force=true ignores the cache. v1.20.1 THE QUIET GATE: on a
// TTL-expiry miss with canAutoProbe=false the STALE cache is served (no
// RUN_COMMAND fires — see termuxCanAutoProbe) and the suppressed flag is
// set; a real probe (forced or allowed) clears it. Concurrent callers
// SHARE one in-flight probe (the waiters join its result) — the setup
// overlay can poll while a probe runs without queueing a second
// RUN_COMMAND, and the mutex is never held across the (up to 20s) network
// call.
func (s *Server) termuxProbeCached(force, canAutoProbe bool) (*termuxbridge.RunResult, error, bool) {
	s.termuxMu.Lock()
	if !force && time.Since(s.termuxCache.at) < termuxProbeTTL {
		r, err, sup := s.termuxCache.result, s.termuxCache.err, s.termuxCache.suppressed
		s.termuxMu.Unlock()
		return r, err, sup
	}
	if s.termuxFlight != nil {
		// Join the in-flight probe; its result is fresh by construction
		// (joining costs zero extra RUN_COMMANDs — the quiet gate only ever
		// gates FIRING one).
		flight := s.termuxFlight
		s.termuxMu.Unlock()
		<-flight
		s.termuxMu.Lock()
		r, err, sup := s.termuxCache.result, s.termuxCache.err, s.termuxCache.suppressed
		s.termuxMu.Unlock()
		return r, err, sup
	}
	if !force && !canAutoProbe {
		// THE QUIET GATE: the TTL expired but the state is honestly
		// known-not-props (or the bridge is dead) and no checkin has arrived
		// — serve the stale answer, fire nothing, say so.
		s.termuxCache.suppressed = true
		r, err := s.termuxCache.result, s.termuxCache.err
		s.termuxMu.Unlock()
		return r, err, true
	}
	flight := make(chan struct{})
	s.termuxFlight = flight
	s.termuxMu.Unlock()

	// The probe runs OUTSIDE the mutex, on its own deadline (not the poller's
	// request context — a canceled poll must not poison the shared cache fill).
	ctx, cancel := context.WithTimeout(context.Background(), termuxProbeDeadline)
	r, err := s.termux.Probe(ctx)
	cancel()

	// v1.74.7 THE PHOENIX HEART: the probe outcome feeds the health gauge —
	// a delivered probe (markers or not) is Termux EXECUTING our script (alive);
	// a probe timeout is the bridge answering while Termux never executed (the
	// dead-shell signature). A transport error is the APK bridge's own story —
	// the gauge must not count it.
	if err == nil && r != nil {
		if r.Timeout {
			s.termuxPhoenixObserveFail()
		} else if r.Ok {
			s.termuxPhoenixObserveOK()
		}
	}

	s.termuxMu.Lock()
	s.termuxCache = termuxProbeCache{at: time.Now(), result: r, err: err}
	s.termuxFlight = nil
	close(flight)
	s.termuxMu.Unlock()
	return r, err, false
}

// handleTermuxAct is POST /api/termux/act — body {"what": "open_termux" |
// "open_fdroid" | "open_permission_settings"}. Passthrough to the bridge's
// /act route (the intents fire on the APK side). v1.23.1 THE LINK: the
// open_fdroid action resolves the CURRENT stable F-Droid APK URL dynamically
// (F-Droid's own suggestedVersionCode — no more frozen links) and rides it
// in the act body; the Kotlin side opens it only under the f-droid.org
// allowlist, else its frozen fallback. A failed resolve answers the frozen
// link — the tap never breaks.
func (s *Server) handleTermuxAct(w http.ResponseWriter, r *http.Request) {
	if s.termux == nil {
		writeError(w, http.StatusBadRequest, "termux bridge not configured on this engine")
		return
	}
	var body struct {
		What string `json:"what"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 8192)).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON body: "+err.Error())
		return
	}
	switch body.What {
	case "open_termux", "open_fdroid", "open_permission_settings", "revive_termux":
		// ok — one of the four legal actions (v1.74.7: revive_termux — the
		// phoenix ladder's Kotlin hand; a manual PWA tap may fire it too)
	default:
		writeError(w, http.StatusBadRequest, "unknown what (expected open_termux | open_fdroid | open_permission_settings | revive_termux)")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	if body.What == "open_fdroid" {
		// v1.23.1: resolve fresh-ish (cached ≤6h) and forward — the bridge
		// is authoritative for the actual intent; a resolution failure rides
		// as an empty url and the Kotlin fallback answers.
		url := s.fdroidTermuxLink(ctx)
		res, err := s.termux.ActWithURL(ctx, body.What, url)
		if err != nil {
			// Honest action-failure report (bridge dead / timeout / 403): the
			// intent genuinely did not fire — the PWA surfaces the error.
			writeJSON(w, http.StatusBadGateway, map[string]any{
				"ok":    false,
				"error": err.Error(),
			})
			return
		}
		writeJSON(w, 200, map[string]any{"ok": res != nil && res.Ok})
		return
	}
	res, err := s.termux.Act(ctx, body.What)
	if err != nil {
		// Honest action-failure report (bridge dead / timeout / 403): the
		// intent genuinely did not fire — the PWA surfaces the error.
		writeJSON(w, http.StatusBadGateway, map[string]any{
			"ok":    false,
			"error": err.Error(),
		})
		return
	}
	writeJSON(w, 200, map[string]any{"ok": res != nil && res.Ok})
}
