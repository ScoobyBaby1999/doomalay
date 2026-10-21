package server

// ocbridgeapi.go — v1.49.2 THE OPEN HANDSHAKE (PLAN-V149 §2): the app's
// surface onto the pocket bridge. GET /api/opencode/bridge answers the
// HONEST STATE LADDER (every Termux-side problem is a STATUS FIELD, never
// a 500 — the termuxapi.go law); POST /api/opencode/bridge/install drives
// the engine-led install idempotently (single-flight; a background ctx —
// the jailed exec's own 30-min budget rides under it; the turn path never
// blocks on an in-flight install — runOcServeTurn answers the honest
// "install in progress" terminal instead).
//
// THE STATE LADDER (the providers.js card renders on it):
//
//      desktop          — the exec spawner: the bridge self-manages (v1.48.5)
//      walled           — no OpenCode key in the vault (nothing can run)
//      unconfigured     — the Termux bridge URL is not configured on this
//                         engine build (DOOMALAY_TERMUX_BRIDGE unset)
//      termux_missing   — gate 1: Termux isn't installed
//      not_bootstrapped — gate 2: the one-line setup hasn't run in Termux
//      installing       — the engine-led install is in flight right now
//      install_failed   — the last install failed (last_error says why)
//      up               — a serve answers; the free models work (port rides)
//      ready            — the gates pass; one tap starts the bridge

import (
        "context"
        "log"
        "net/http"
        "strings"
        "sync"
        "time"

        "github.com/ScoobyBaby1999/doomalay/engine/internal/ocserve"
)

// ocBridgeSnapshot is the install's live truth (single-flight state).
type ocBridgeSnapshot struct {
        mu      sync.Mutex
        running bool
        lastErr string
        // v1.55.1: which install attempt we're on (the failed→retry pill
        // shows it; incremented on every REAL start).
        attempt int
}

func (s *Server) ocBridgeSetRunning(on bool) {
        s.ocBridge.mu.Lock()
        s.ocBridge.running = on
        s.ocBridge.mu.Unlock()
}

// ocBridgeStartAttempt arms a fresh install: bumps the attempt counter
// and clears the last error (the pill ladder renders the attempt).
func (s *Server) ocBridgeStartAttempt() {
        s.ocBridge.mu.Lock()
        s.ocBridge.running = true
        s.ocBridge.lastErr = ""
        s.ocBridge.attempt++
        s.ocBridge.mu.Unlock()
}

func (s *Server) ocBridgeSetError(err string) {
        s.ocBridge.mu.Lock()
        s.ocBridge.lastErr = err
        s.ocBridge.mu.Unlock()
}

func (s *Server) ocBridgeState() (running bool, lastErr string) {
        s.ocBridge.mu.Lock()
        defer s.ocBridge.mu.Unlock()
        return s.ocBridge.running, s.ocBridge.lastErr
}

func (s *Server) ocBridgeAttemptNow() int {
        s.ocBridge.mu.Lock()
        defer s.ocBridge.mu.Unlock()
        return s.ocBridge.attempt
}

// ocBridgeKeyPresent: the vault carries the OpenCode key (never leaks it).
func (s *Server) ocBridgeKeyPresent() bool {
        if s.vault == nil {
                return false
        }
        return strings.TrimSpace(s.vault.AsEnv()["OPENCODE_ZEN_API_KEY"]) != ""
}

// ocBridgeLadder walks the gates in order — the shared half of both
// routes. It answers the ladder state + the human detail; ok=false means a
// gate is closed.
func (s *Server) ocBridgeLadder() (state, detail string, termuxInstalled, termuxReady bool) {
        if !s.ocBridgeKeyPresent() {
                return "walled", "Add your OpenCode key first — the free models need it", false, false
        }
        if s.termux == nil {
                return "unconfigured", "This engine build has no Termux bridge configured (DOOMALAY_TERMUX_BRIDGE)", false, false
        }
        st, err := s.termux.Status(context.Background())
        if err != nil || st == nil {
                return "unconfigured", "The Termux bridge is not answering right now — open Termux once and retry", false, false
        }
        if !st.Installed {
                return "termux_missing", "Install Termux from F-Droid first (the button below opens the page), then run the one-line setup", false, false
        }
        if !st.Permission {
                return "not_bootstrapped", "Termux is installed but the Doomalay setup line hasn't run in it yet — copy the line below, paste it in Termux once, come back", true, false
        }
        return "ready", "", true, true
}

// handleOcBridgeStatus is GET /api/opencode/bridge — the honest ladder.
//
// v1.55.1 THE HONEST LADDER: the route NEVER blocks on an install (the
// manager peek is a microsecond pointer read — THE NO-LONG-HOLD LAW), and
// while an install runs it answers the LIVE progress (stage + bytes +
// percent + attempt) so the provider pill pings the download for real.
func (s *Server) handleOcBridgeStatus(w http.ResponseWriter, r *http.Request) {
        clientVersion, sizeHint := ocserve.AndroidClientInfo()
        out := map[string]any{
                "client_version":  clientVersion,
                "desktop_version": ocserve.Version,
                "size_hint":       sizeHint,
                "key_present":     s.ocBridgeKeyPresent(),
                "port":            0,
                // v1.55.1: the live progress fields (always present — the pill
                // renders shape-stable; stage "" = no install knowledge yet)
                "stage":           "",
                "progress_bytes":  int64(0),
                "progress_total":  int64(0),
                "progress_percent": 0,
                "attempt":         s.ocBridgeAttemptNow(),
        }
        if !ocserve.SpawnerIsTermux() {
                out["state"] = "desktop"
                out["available"] = s.ocServeBridgeAvailable()
                out["detail"] = "Desktop engine: the free models run automatically through the built-in OpenCode bridge when a free model is picked"
                out["termux_installed"] = false
                out["termux_ready"] = false
                writeJSON(w, 200, out)
                return
        }
        state, detail, tInstalled, tReady := s.ocBridgeLadder()
        running, lastErr := s.ocBridgeState()
        // THE ORDER LAW: a HEALTHY serve is the most decisive truth (a
        // transient bridge-status hiccup must never mask a live serve — the
        // serve IS the bridge), an in-flight install comes next (with its
        // LIVE progress), then the gates, then the failure/ready tail.
        m := s.ocServeManagerNow()
        switch {
        case m != nil && m.Healthy():
                state = "up"
                detail = "The pocket bridge is live — the free OpenCode models work"
                out["port"] = m.Port()
        case running:
                state = "installing"
                detail = "Installing the native OpenCode client through Termux (one-time " + sizeHint + " download)…"
                if m != nil {
                        pr := m.Progress()
                        out["stage"] = pr.Stage
                        out["progress_bytes"] = pr.Bytes
                        out["progress_total"] = pr.Total
                        if pr.Total > 0 && pr.Bytes > 0 {
                                pct := int(100 * pr.Bytes / pr.Total)
                                if pct > 99 {
                                        pct = 99 // never claim done before the marker lands
                                }
                                if pct < 1 {
                                        pct = 1
                                }
                                out["progress_percent"] = pct
                        }
                }
        case state == "walled" || state == "unconfigured" || state == "termux_missing" || state == "not_bootstrapped":
                // a gate is closed — the ladder state IS the answer
        case lastErr != "":
                state = "install_failed"
                detail = "The last install attempt failed"
        default:
                state = "ready"
                detail = "One tap installs the native OpenCode client through Termux (one-time " + sizeHint + " download) and starts it"
        }
        out["state"] = state
        out["available"] = state == "up"
        out["detail"] = detail
        out["last_error"] = lastErr
        out["termux_installed"] = tInstalled
        out["termux_ready"] = tReady
        writeJSON(w, 200, out)
}

// ocServeManagerNow is the non-blocking manager peek (the status route
// never STARTS anything — the lazy law stays with the turn path + the
// explicit install).
func (s *Server) ocServeManagerNow() *ocserve.Manager {
        s.ocServeMu.Lock()
        defer s.ocServeMu.Unlock()
        return s.ocServe
}

// handleOcBridgeInstall is POST /api/opencode/bridge/install — the ONE-TAP
// gate: idempotent, single-flight, engine-led. The response is honest at
// every rung (a closed gate answers its ladder state, never a 500).
func (s *Server) handleOcBridgeInstall(w http.ResponseWriter, r *http.Request) {
        if !ocserve.SpawnerIsTermux() {
                writeJSON(w, 200, map[string]any{"ok": false, "state": "desktop",
                        "detail": "The desktop engine needs no install — the bridge self-manages on the first free-model turn"})
                return
        }
        state, detail, _, _ := s.ocBridgeLadder()
        if state != "ready" {
                writeJSON(w, 200, map[string]any{"ok": false, "state": state, "detail": detail})
                return
        }
        if running, _ := s.ocBridgeState(); running {
                writeJSON(w, 200, map[string]any{"ok": true, "state": "installing",
                        "detail": "An install is already in flight"})
                return
        }
        // an ALREADY-LIVE serve needs no install (the reuse law)
        if m := s.ocServeManagerNow(); m != nil && m.Healthy() {
                writeJSON(w, 200, map[string]any{"ok": true, "state": "up", "port": m.Port(),
                        "detail": "The pocket bridge is already live"})
                return
        }
        s.ocBridgeSetError("")
        s.ocBridgeStartAttempt() // v1.55.1: attempt++ + running=true (the pill ladder)
        go func() {
                defer s.ocBridgeSetRunning(false)
                // the detached ctx (the install's own law): the jailed exec's
                // per-command budgets ride under a 20-minute roof — a mobile
                // download + unzip + boot fits honestly inside it
                ctx, cancel := context.WithTimeout(context.Background(), 20*time.Minute)
                defer cancel()
                m := s.ocServeManager(ctx)
                if m == nil {
                        s.ocBridgeSetError("the bridge could not start (no data dir or key) — see the engine log")
                        log.Printf("ocserve: install: manager unavailable")
                        return
                }
                if !m.Healthy() {
                        s.ocBridgeSetError("the serve did not come up — see the engine log")
                        return
                }
                log.Printf("ocserve: install: the pocket bridge is live on port %d", m.Port())
        }()
        writeJSON(w, 200, map[string]any{"ok": true, "state": "installing",
                "detail": "Installing the native OpenCode client through Termux — the card updates as it goes"})
}
