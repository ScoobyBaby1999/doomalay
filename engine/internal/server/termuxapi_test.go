package server

// termuxapi_test.go — v1.17.2 THE BRIDGE: /api/termux/status aggregation
// (the honest-state ladder, the cached probe, ?refresh=1) + /api/termux/act
// passthrough — against a stub of the Kotlin TermuxBridgeServer contract.
// v1.20.1 THE QUIET GATE: the checkin passthrough + the suppression matrix
// (the auto-probe fires ONLY on props-on / checkin-arrived / first-look —
// otherwise the stale cache serves past TTL with zero new RUN_COMMANDs).

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/ScoobyBaby1999/doomalay/engine/internal/config"
	"github.com/ScoobyBaby1999/doomalay/engine/internal/store"
)

func newTermuxTestServer(t *testing.T, bridgeURL string) *Server {
	t.Helper()
	dir := t.TempDir()
	db, err := store.Open(dir)
	if err != nil {
		t.Fatalf("store: %v", err)
	}
	if err := db.Migrate(); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	cfg := &config.Config{DataDir: dir, TermuxBridge: bridgeURL}
	return New(cfg, db, nil)
}

// newTermuxStubBridge serves the bridge's four routes. The probe result is
// configurable (installed / permission / probe stdout markers) and every
// /probe hit is counted — the cache + refresh tests pin on that counter.
// v1.20.1: the status half carries the checkin ladder (settable), the
// probe's props marker is flippable (drives the suppression matrix), and
// oldBridge=true serves the PRE-v1.20.1 /status shape (no checkin fields
// at all — the defensive-decode pin).
type termuxStub struct {
	srv         *httptest.Server
	probeHits   atomic.Int32
	statusMu    sync.Mutex
	installed   bool
	permission  bool
	propsOK     bool // the probe's props marker (false → props_missing stdout)
	oldBridge   bool
	checkinURL  string
	bootstrapD  bool
	checkinAt   int64
	checkinSto  bool
	checkinPro  bool
}

func newTermuxStubBridge(t *testing.T, installed, permission bool) *termuxStub {
	t.Helper()
	st := &termuxStub{installed: installed, permission: permission, propsOK: true}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /status", func(w http.ResponseWriter, r *http.Request) {
		st.statusMu.Lock()
		inst, perm := st.installed, st.permission
		oldB := st.oldBridge
		curl, done, at, cs, cp := st.checkinURL, st.bootstrapD, st.checkinAt, st.checkinSto, st.checkinPro
		st.statusMu.Unlock()
		out := map[string]any{
			"installed":    inst,
			"version_code": 1002,
			"version_name": "0.118.3",
			"permission":   perm,
		}
		if oldB {
			// the pre-v1.20.1 Kotlin bridge — no checkin fields at all
			writeStubBridgeJSON(w, out)
			return
		}
		out["checkin_url"] = curl
		out["bootstrap_done"] = done
		out["checkin_at"] = at
		out["checkin_storage"] = cs
		out["checkin_props"] = cp
		writeStubBridgeJSON(w, out)
	})
	mux.HandleFunc("POST /probe", func(w http.ResponseWriter, r *http.Request) {
		st.probeHits.Add(1)
		st.statusMu.Lock()
		props := st.propsOK
		st.statusMu.Unlock()
		stdout := "__doomalay_probe__\nstorage_ok\nprops_ok\n"
		if !props {
			stdout = "__doomalay_probe__\nstorage_ok\nprops_missing\n"
		}
		writeStubBridgeJSON(w, map[string]any{
			"ok":         true,
			"storage_ok": true,
			"props_ok":   props,
			"stdout":     stdout,
			"stderr":     "",
			"exit_code":  0,
			"err":        0,
			"errmsg":     nil,
			"timeout":    false,
		})
	})
	mux.HandleFunc("POST /run", func(w http.ResponseWriter, r *http.Request) {
		writeStubBridgeJSON(w, map[string]any{
			"ok": true, "stdout": "", "stderr": "", "exit_code": 0,
			"err": 0, "errmsg": nil, "timeout": false,
		})
	})
	mux.HandleFunc("POST /act", func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		if body["what"] == "open_termux" || body["what"] == "open_fdroid" || body["what"] == "open_permission_settings" {
			writeStubBridgeJSON(w, map[string]any{"ok": true})
			return
		}
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte(`{"error":"unknown what"}`))
	})
	st.srv = httptest.NewServer(mux)
	t.Cleanup(st.srv.Close)
	return st
}

func writeStubBridgeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}

func termuxStatus(t *testing.T, s *Server, query string) (int, map[string]any) {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, "/api/termux/status"+query, nil)
	rec := httptest.NewRecorder()
	s.mux.ServeHTTP(rec, req)
	var out map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("status response not JSON (%d): %s", rec.Code, rec.Body.String())
	}
	return rec.Code, out
}

// No bridge configured (every desktop build) → honest {available:false}.
func TestV1172_TermuxStatus_NoBridge(t *testing.T) {
	s := newTermuxTestServer(t, "")
	code, out := termuxStatus(t, s, "")
	if code != 200 {
		t.Fatalf("status code %d: %v", code, out)
	}
	if out["available"] != false {
		t.Fatalf("no-bridge must answer available:false, got %v", out)
	}
	if _, has := out["ready"]; has {
		t.Fatalf("no-bridge response should carry no ladder fields: %v", out)
	}
}

// The full ladder: bridge live, Termux installed, permission granted,
// probe round-trip + markers → ready:true.
func TestV1172_TermuxStatus_FullLadderReady(t *testing.T) {
	st := newTermuxStubBridge(t, true, true)
	s := newTermuxTestServer(t, st.srv.URL)
	code, out := termuxStatus(t, s, "")
	if code != 200 {
		t.Fatalf("status code %d: %v", code, out)
	}
	if out["available"] != true {
		t.Fatalf("available should be true: %v", out)
	}
	if out["installed"] != true || out["permission"] != true {
		t.Fatalf("installed/permission should be true: %v", out)
	}
	if out["version_code"].(float64) != 1002 {
		t.Fatalf("version_code should round-trip: %v", out)
	}
	if out["version_name"] != "0.118.3" {
		t.Fatalf("version_name should round-trip: %v", out)
	}
	if out["bridge_ok"] != true {
		t.Fatalf("bridge_ok should be true (probe delivered): %v", out)
	}
	if out["storage_ok"] != true || out["props_ok"] != true {
		t.Fatalf("storage_ok/props_ok should be true (markers): %v", out)
	}
	if out["ready"] != true {
		t.Fatalf("ready should be true (the whole ladder): %v", out)
	}
	if out["last_error"] != "" {
		t.Fatalf("last_error should be empty: %v", out)
	}
	if _, ok := out["checked_at"].(float64); !ok {
		t.Fatalf("checked_at should be a unix timestamp: %v", out)
	}
}

// ready needs the WHOLE ladder: installed + permission false (the user's
// two manual steps) → bridge_ok + storage_ok still true, ready:false.
func TestV1172_TermuxStatus_NotInstalled_NotReady(t *testing.T) {
	st := newTermuxStubBridge(t, false, false)
	s := newTermuxTestServer(t, st.srv.URL)
	code, out := termuxStatus(t, s, "")
	if code != 200 {
		t.Fatalf("status code %d: %v", code, out)
	}
	if out["bridge_ok"] != true || out["storage_ok"] != true {
		t.Fatalf("bridge_ok/storage_ok should still be true: %v", out)
	}
	if out["ready"] != false {
		t.Fatalf("ready needs installed+permission too: %v", out)
	}
}

// The cache: two polls → ONE probe round-trip; ?refresh=1 → a second.
func TestV1172_TermuxStatus_CachedProbe_RefreshForces(t *testing.T) {
	st := newTermuxStubBridge(t, true, true)
	s := newTermuxTestServer(t, st.srv.URL)

	if _, out := termuxStatus(t, s, ""); out["bridge_ok"] != true {
		t.Fatalf("first poll should be bridge_ok: %v", out)
	}
	if _, out := termuxStatus(t, s, ""); out["bridge_ok"] != true {
		t.Fatalf("second poll should be bridge_ok: %v", out)
	}
	if got := st.probeHits.Load(); got != 1 {
		t.Fatalf("TTL window: expected 1 probe, got %d", got)
	}

	if _, out := termuxStatus(t, s, "?refresh=1"); out["bridge_ok"] != true {
		t.Fatalf("refresh poll should be bridge_ok: %v", out)
	}
	if got := st.probeHits.Load(); got != 2 {
		t.Fatalf("?refresh=1 should re-probe: expected 2 probes, got %d", got)
	}
}

// A dead bridge (connection refused) is a STATUS, never a 500: HTTP 200,
// available:true, bridge_ok:false, ready:false, last_error carrying the
// typed reason.
func TestV1172_TermuxStatus_DeadBridge_HonestState(t *testing.T) {
	// A deliberately dead URL: bind, note, close.
	dead := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	deadURL := dead.URL
	dead.Close()

	s := newTermuxTestServer(t, deadURL)
	code, out := termuxStatus(t, s, "")
	if code != 200 {
		t.Fatalf("Termux-side problems must never 5xx — got %d: %v", code, out)
	}
	if out["available"] != true {
		t.Fatalf("the engine IS bridge-configured: %v", out)
	}
	if out["bridge_ok"] != false {
		t.Fatalf("dead bridge → bridge_ok:false: %v", out)
	}
	if out["ready"] != false {
		t.Fatalf("dead bridge → ready:false: %v", out)
	}
	if last, _ := out["last_error"].(string); last == "" {
		t.Fatalf("last_error must carry the typed reason: %v", out)
	}
}

// A wrong-token bridge (403 on every route) — also a status, never a 500.
func TestV1172_TermuxStatus_WrongToken_HonestState(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusForbidden)
		_, _ = w.Write([]byte(`{"error":"forbidden"}`))
	}))
	defer ts.Close()

	s := newTermuxTestServer(t, ts.URL)
	code, out := termuxStatus(t, s, "")
	if code != 200 {
		t.Fatalf("403 from the bridge is a status: got %d: %v", code, out)
	}
	if out["bridge_ok"] != false || out["ready"] != false {
		t.Fatalf("wrong token → bridge_ok/ready false: %v", out)
	}
}

// The act passthrough: the three legal whats succeed, everything else
// answers an honest 400; a dead bridge answers an honest 502.
func TestV1172_TermuxAct(t *testing.T) {
	st := newTermuxStubBridge(t, true, true)
	s := newTermuxTestServer(t, st.srv.URL)

	for _, what := range []string{"open_termux", "open_fdroid", "open_permission_settings"} {
		code, out := termuxAct(t, s, fmt.Sprintf(`{"what":%q}`, what))
		if code != 200 || out["ok"] != true {
			t.Fatalf("act %s: code %d out %v", what, code, out)
		}
	}

	if code, out := termuxAct(t, s, `{"what":"open_zip"}`); code != 400 {
		t.Fatalf("unknown what must 400: %d %v", code, out)
	}
	if code, out := termuxAct(t, s, `not-json`); code != 400 {
		t.Fatalf("bad body must 400: %d %v", code, out)
	}
	if code, out := termuxAct(t, s, ``); code != 400 {
		t.Fatalf("empty body must 400: %d %v", code, out)
	}
}

// No bridge → act refuses honestly (the desktop story).
func TestV1172_TermuxAct_NoBridge_Refuses(t *testing.T) {
	s := newTermuxTestServer(t, "")
	code, out := termuxAct(t, s, `{"what":"open_termux"}`)
	if code != 400 {
		t.Fatalf("no-bridge act should refuse: %d %v", code, out)
	}
}

// Dead bridge → act fails honestly with 502 (the intent genuinely did not
// fire — this is an ACTION, so a real error, not a status field).
func TestV1172_TermuxAct_DeadBridge_Honest502(t *testing.T) {
	dead := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	deadURL := dead.URL
	dead.Close()

	s := newTermuxTestServer(t, deadURL)
	code, out := termuxAct(t, s, `{"what":"open_termux"}`)
	if code != 502 {
		t.Fatalf("dead bridge act should 502: %d %v", code, out)
	}
	if out["ok"] != false {
		t.Fatalf("ok must be false: %v", out)
	}
}

// Concurrent polls during a slow probe share ONE in-flight round-trip (the
// waiters join the flight instead of queueing a second RUN_COMMAND).
func TestV1172_TermuxStatus_ConcurrentPollsShareOneProbe(t *testing.T) {
	release := make(chan struct{})
	var hits atomic.Int32
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/status":
			writeStubBridgeJSON(w, map[string]any{
				"installed": true, "version_code": 1002,
				"version_name": "0.118.3", "permission": true,
			})
		case "/probe":
			hits.Add(1)
			<-release // hold the first probe until all pollers are waiting
			writeStubBridgeJSON(w, map[string]any{
				"ok": true, "storage_ok": true, "props_ok": true,
				"stdout": "__doomalay_probe__\nstorage_ok\nprops_ok\n",
				"stderr": "", "exit_code": 0, "err": 0, "errmsg": nil, "timeout": false,
			})
		}
	}))
	defer ts.Close()

	s := newTermuxTestServer(t, ts.URL)
	var wg sync.WaitGroup
	results := make([]map[string]any, 5)
	for i := 0; i < 5; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			req := httptest.NewRequest(http.MethodGet, "/api/termux/status", nil)
			rec := httptest.NewRecorder()
			s.mux.ServeHTTP(rec, req)
			var out map[string]any
			_ = json.Unmarshal(rec.Body.Bytes(), &out)
			results[i] = out
		}(i)
	}
	// Let the pollers pile up on the in-flight probe, then release it.
	time.Sleep(150 * time.Millisecond)
	close(release)
	wg.Wait()

	if hits.Load() != 1 {
		t.Fatalf("concurrent polls should share ONE probe, got %d", hits.Load())
	}
	for i, out := range results {
		if out == nil || out["bridge_ok"] != true || out["ready"] != true {
			t.Fatalf("poller %d should see the shared probe result: %v", i, out)
		}
	}
}

func termuxAct(t *testing.T, s *Server, body string) (int, map[string]any) {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/api/termux/act", bytes.NewReader([]byte(body)))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	s.mux.ServeHTTP(rec, req)
	var out map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	return rec.Code, out
}

// v1.20.1 — the checkin passthrough: the bridge's /status fields ride the
// engine status JSON whole (bootstrap_done, the URL, the script's own two
// step outcomes, the timestamp).
func TestV1201_TermuxStatus_CheckinPassthrough(t *testing.T) {
	st := newTermuxStubBridge(t, true, true)
	st.statusMu.Lock()
	st.checkinURL = "http://127.0.0.1:8081/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/checkin"
	st.bootstrapD = true
	st.checkinAt = 1717000000
	st.checkinSto = true
	st.checkinPro = false
	st.statusMu.Unlock()
	s := newTermuxTestServer(t, st.srv.URL)
	code, out := termuxStatus(t, s, "")
	if code != 200 {
		t.Fatalf("status code %d: %v", code, out)
	}
	if out["checkin_url"] != "http://127.0.0.1:8081/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/checkin" {
		t.Fatalf("checkin_url should round-trip: %v", out)
	}
	if out["bootstrap_done"] != true {
		t.Fatalf("bootstrap_done should round-trip: %v", out)
	}
	if out["checkin_at"].(float64) != 1717000000 {
		t.Fatalf("checkin_at should round-trip: %v", out)
	}
	if out["checkin_storage"] != true || out["checkin_props"] != false {
		t.Fatalf("checkin_storage/props should round-trip: %v", out)
	}
	if out["probe_suppressed"] != false {
		t.Fatalf("a live probe is not suppressed: %v", out)
	}
}

// v1.20.1 — an OLD bridge (pre-quiet-gate Kotlin, no checkin fields at all)
// decodes defensively: empty URL, false flags, zero timestamp — the honest
// old-flow state, never an error, never a 500.
func TestV1201_TermuxStatus_OldBridge_Defaults(t *testing.T) {
	st := newTermuxStubBridge(t, true, true)
	st.statusMu.Lock()
	st.oldBridge = true
	st.statusMu.Unlock()
	s := newTermuxTestServer(t, st.srv.URL)
	code, out := termuxStatus(t, s, "")
	if code != 200 {
		t.Fatalf("old-bridge status must stay HTTP 200: %d", code)
	}
	if out["available"] != true || out["bridge_ok"] != true {
		t.Fatalf("the ladder itself must keep working: %v", out)
	}
	if out["checkin_url"] != "" || out["bootstrap_done"] != false ||
		out["checkin_storage"] != false || out["checkin_props"] != false {
		t.Fatalf("missing checkin fields decode to the honest zero state: %v", out)
	}
	if out["probe_suppressed"] != false {
		t.Fatalf("no suppression before the gate has ever held: %v", out)
	}
}

// TestV1201_TermuxStatus_QuietGateSuppression — THE suppression matrix: the
// auto-probe (TTL-expiry miss) fires ONLY on (a) a props-on cache, (b) the
// bootstrap checkin, (c) the first look; otherwise the STALE cache serves
// past TTL with ZERO new RUN_COMMANDs (each probe while allow-external-apps
// is unset forces a Termux notification — the user's spam report) and the
// honest paused line. ?refresh=1 always forces.
func TestV1201_TermuxStatus_QuietGateSuppression(t *testing.T) {
	st := newTermuxStubBridge(t, true, true)
	st.statusMu.Lock()
	st.propsOK = false // props honestly OFF — the spam scenario
	st.statusMu.Unlock()
	s := newTermuxTestServer(t, st.srv.URL)

	// (c) first look: cache never filled → one probe (the honest learn)
	if _, out := termuxStatus(t, s, ""); out["bridge_ok"] != true || out["props_ok"] != false {
		t.Fatalf("first look: bridge_ok/props_ok: %v", out)
	}
	if got := st.probeHits.Load(); got != 1 {
		t.Fatalf("first look should probe exactly once, got %d", got)
	}

	// expire the TTL without sleeping 30s (the cache is ours to age)
	expire := func() {
		s.termuxMu.Lock()
		s.termuxCache.at = time.Now().Add(-termuxProbeTTL - time.Second)
		s.termuxMu.Unlock()
	}

	// (1) props off + no checkin + cache filled → SUPPRESSED (no probe)
	expire()
	_, out := termuxStatus(t, s, "")
	if got := st.probeHits.Load(); got != 1 {
		t.Fatalf("quiet gate: no second probe after TTL, got %d", got)
	}
	if out["probe_suppressed"] != true {
		t.Fatalf("probe_suppressed must be true while gated: %v", out)
	}
	if last, _ := out["last_error"].(string); !strings.Contains(last, "probe paused") {
		t.Fatalf("the quiet gate must be a visible state (last_error): %q", last)
	}
	if out["bridge_ok"] != true || out["props_ok"] != false {
		t.Fatalf("the stale answer still serves whole (never silence): %v", out)
	}

	// (2) ?refresh=1 → probes (an explicit user action — one honest
	// notification, never a loop)
	if _, out = termuxStatus(t, s, "?refresh=1"); out["probe_suppressed"] != false {
		t.Fatalf("a forced probe clears the flag: %v", out)
	}
	if got := st.probeHits.Load(); got != 2 {
		t.Fatalf("?refresh=1 should force one probe, got %d", got)
	}

	// (3) bootstrap_done (the checkin landed) → the auto-probe resumes
	st.statusMu.Lock()
	st.checkinURL = "http://127.0.0.1:8081/cccccccc-dddd-eeee-ffff-000000000000/checkin"
	st.bootstrapD = true
	st.checkinAt = 1717000001
	st.checkinSto = true
	st.checkinPro = true
	st.statusMu.Unlock()
	expire()
	_, out = termuxStatus(t, s, "")
	if got := st.probeHits.Load(); got != 3 {
		t.Fatalf("bootstrap_done should reopen the auto-probe, got %d", got)
	}
	if out["probe_suppressed"] != false || out["bootstrap_done"] != true {
		t.Fatalf("the checkin reopens the gate + passes through: %v", out)
	}

	// (4) props_ok cached (the script honestly set them) → auto-probe on TTL
	st.statusMu.Lock()
	st.bootstrapD = false // isolate the props-on path from (3)
	st.propsOK = true
	st.statusMu.Unlock()
	if _, out = termuxStatus(t, s, "?refresh=1"); out["props_ok"] != true {
		t.Fatalf("fill the cache with props on: %v", out)
	}
	expire()
	termuxStatus(t, s, "")
	if got := st.probeHits.Load(); got != 5 {
		t.Fatalf("props-on cache should auto-probe on TTL expiry, got %d", got)
	}
}
