package server

// termuxapi.go — v1.17.2 THE BRIDGE: the engine-side Termux surface
// (PLAN-V117 §v1.17.2).
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
	"net/http"
	"runtime"
	"strings"
	"time"

	"github.com/ScoobyBaby1999/doomalay/engine/internal/termuxbridge"
)

// termuxProbeCache is the cached probe outcome (guarded by termuxMu).
// A probe with a transport error is cached too — a dead bridge answering
// every poll with a fresh 20s timeout would starve the setup UI.
type termuxProbeCache struct {
	at     time.Time               // when the probe finished (zero = never probed)
	result *termuxbridge.RunResult // nil when the probe errored
	err    error                   // typed client error (refused/timeout/403/…)
}

// The probe costs a real RUN_COMMAND round-trip through Termux (~1-15s);
// the setup overlay polls every few seconds — cache it.
const termuxProbeTTL = 30 * time.Second

// termuxProbeDeadline bounds one probe round-trip (the bridge itself times
// out at 15s; +5s slack for the HTTP hop).
const termuxProbeDeadline = 20 * time.Second

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

	// Probe half — cached (TTL 30s); ?refresh=1 forces a re-probe.
	pr, prErr := s.termuxProbeCached(r.URL.Query().Get("refresh") == "1")

	var installed, permission bool
	var versionCode int64
	var versionName string
	if st != nil {
		installed = st.Installed
		versionCode = st.VersionCode
		versionName = st.VersionName
		permission = st.Permission
	}
	bridgeOK := prErr == nil
	var storageOK, propsOK bool
	if pr != nil {
		storageOK = pr.StorageOK
		propsOK = pr.PropsOK
	}
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

	writeJSON(w, 200, map[string]any{
		"available":    true,
		"android":      runtime.GOOS == "android", // runtime check — same binary every platform
		"installed":    installed,
		"version_code": versionCode,
		"version_name": versionName,
		"permission":   permission,
		"bridge_ok":    bridgeOK,
		"storage_ok":   storageOK,
		"props_ok":     propsOK,
		"ready":        bridgeOK && storageOK && installed && permission,
		"last_error":   lastError,
		"checked_at":   time.Now().Unix(),
	})
}

// termuxProbeCached returns the cached probe (TTL termuxProbeTTL), probing
// on miss; force=true ignores the cache. Concurrent callers SHARE one
// in-flight probe (the waiters join its result) — the setup overlay can
// poll while a probe runs without queueing a second RUN_COMMAND, and the
// mutex is never held across the (up to 20s) network call.
func (s *Server) termuxProbeCached(force bool) (*termuxbridge.RunResult, error) {
	s.termuxMu.Lock()
	if !force && time.Since(s.termuxCache.at) < termuxProbeTTL {
		r, err := s.termuxCache.result, s.termuxCache.err
		s.termuxMu.Unlock()
		return r, err
	}
	if s.termuxFlight != nil {
		// Join the in-flight probe; its result is fresh by construction.
		flight := s.termuxFlight
		s.termuxMu.Unlock()
		<-flight
		s.termuxMu.Lock()
		r, err := s.termuxCache.result, s.termuxCache.err
		s.termuxMu.Unlock()
		return r, err
	}
	flight := make(chan struct{})
	s.termuxFlight = flight
	s.termuxMu.Unlock()

	// The probe runs OUTSIDE the mutex, on its own deadline (not the poller's
	// request context — a canceled poll must not poison the shared cache fill).
	ctx, cancel := context.WithTimeout(context.Background(), termuxProbeDeadline)
	r, err := s.termux.Probe(ctx)
	cancel()

	s.termuxMu.Lock()
	s.termuxCache = termuxProbeCache{at: time.Now(), result: r, err: err}
	s.termuxFlight = nil
	close(flight)
	s.termuxMu.Unlock()
	return r, err
}

// handleTermuxAct is POST /api/termux/act — body {"what": "open_termux" |
// "open_fdroid" | "open_permission_settings"}. Passthrough to the bridge's
// /act route (the intents fire on the APK side).
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
	case "open_termux", "open_fdroid", "open_permission_settings":
		// ok — one of the three legal actions
	default:
		writeError(w, http.StatusBadRequest, "unknown what (expected open_termux | open_fdroid | open_permission_settings)")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
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
