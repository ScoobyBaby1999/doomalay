package server

// ocbridgeapi_v1492_test.go — v1.49.2 THE OPEN HANDSHAKE pins: the honest
// state ladder of GET /api/opencode/bridge + the install route's immediate
// rungs + the in-flight turn terminal, all against the established
// termuxStubBridge contract (the full chain — a REAL exec'ing bridge — is
// the phase-3 rig's job).

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/ScoobyBaby1999/doomalay/engine/internal/ocserve"
	"github.com/ScoobyBaby1999/doomalay/engine/internal/secrets"
)

func v1492BridgeGET(s *Server) map[string]any {
	t := &testing.T{}
	_ = t
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/opencode/bridge", nil)
	s.handleOcBridgeStatus(rec, req)
	if rec.Code != 200 {
		return map[string]any{"_code": rec.Code}
	}
	var out map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		return map[string]any{"_decode": err.Error()}
	}
	return out
}

func v1492SetKey(t *testing.T, s *Server, key string) {
	t.Helper()
	if err := s.vault.Set("OPENCODE_ZEN_API_KEY", "opencode", key, ""); err != nil {
		t.Fatalf("vault set: %v", err)
	}
}

// TestV1492LadderDesktop — the exec spawner answers the desktop state (the
// override dominates; the env law is the same one ocserve pins).
func TestV1492LadderDesktop(t *testing.T) {
	t.Setenv("DOOMALAY_OPENCODE_SPAWNER", "exec")

	st := newTermuxStubBridge(t, true, true)
	s := newTermuxTestServer(t, st.srv.URL)
	v1492SetKey(t, s, "oc_sk_x")
	out := v1492BridgeGET(s)
	if out["state"] != "desktop" {
		t.Fatalf("desktop state: %v", out)
	}
	if out["client_version"] == nil || out["desktop_version"] == nil || out["size_hint"] == nil {
		t.Fatalf("the version pins must ride: %v", out)
	}
}

// TestV1492LadderWalledAndGates — the termux spawner's honest rungs in
// order: no key → walled; no bridge → unconfigured; !installed →
// termux_missing; !permission → not_bootstrapped.
func TestV1492LadderWalledAndGates(t *testing.T) {
	t.Setenv("DOOMALAY_OPENCODE_SPAWNER", "termux")
	s := newTermuxTestServer(t, "http://127.0.0.1:1/badtoken") // unreachable
	// no key yet → walled
	out := v1492BridgeGET(s)
	if out["state"] != "walled" {
		t.Fatalf("walled rung: %v", out)
	}
	if out["key_present"] != false {
		t.Fatalf("key_present must be honest: %v", out)
	}
	v1492SetKey(t, s, "oc_sk_x")
	// the bridge is unreachable from this test → unconfigured (honest)
	out = v1492BridgeGET(s)
	if out["state"] != "unconfigured" {
		t.Fatalf("unconfigured rung: %v", out)
	}
	// a live stub, termux missing → termux_missing
	st := newTermuxStubBridge(t, false, false)
	s2 := newTermuxTestServer(t, st.srv.URL)
	v1492SetKey(t, s2, "oc_sk_x")
	out = v1492BridgeGET(s2)
	if out["state"] != "termux_missing" {
		t.Fatalf("termux_missing rung: %v", out)
	}
	// installed but not bootstrapped → not_bootstrapped
	st2 := newTermuxStubBridge(t, true, false)
	s3 := newTermuxTestServer(t, st2.srv.URL)
	v1492SetKey(t, s3, "oc_sk_x")
	out = v1492BridgeGET(s3)
	if out["state"] != "not_bootstrapped" {
		t.Fatalf("not_bootstrapped rung: %v", out)
	}
}

// TestV1492LadderReadyAndInstalling — the gates pass → ready; the
// single-flight flag flips it to installing with the honest detail.
func TestV1492LadderReadyAndInstalling(t *testing.T) {
	t.Setenv("DOOMALAY_OPENCODE_SPAWNER", "termux")
	st := newTermuxStubBridge(t, true, true)
	s := newTermuxTestServer(t, st.srv.URL)
	v1492SetKey(t, s, "oc_sk_x")
	out := v1492BridgeGET(s)
	if out["state"] != "ready" {
		t.Fatalf("ready rung: %v", out)
	}
	if out["available"] != false {
		t.Fatalf("ready is not available: %v", out)
	}
	s.ocBridgeSetRunning(true)
	out = v1492BridgeGET(s)
	if out["state"] != "installing" {
		t.Fatalf("installing rung: %v", out)
	}
	s.ocBridgeSetRunning(false)
}

// TestV1492LadderUp — a healthy manager answers up + the port (the
// reuse/now-peek never starts anything).
func TestV1492LadderUp(t *testing.T) {
	t.Setenv("DOOMALAY_OPENCODE_SPAWNER", "termux")
	// a fake serve on the loopback
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(200)
	}))
	defer srv.Close()
	base := strings.TrimPrefix(srv.URL, "http://") // 127.0.0.1:port
	m := ocserve.New(t.TempDir(), "k", func(string, ...any) {})
	m.SetBaseURL(srv.URL)
	s := newTermuxTestServer(t, "http://127.0.0.1:1/bad")
	v1492SetKey(t, s, "oc_sk_x")
	s.ocServeMu.Lock()
	s.ocServe = m
	s.ocServeMu.Unlock()
	out := v1492BridgeGET(s)
	if out["state"] != "up" {
		t.Fatalf("up rung: %v", out)
	}
	if out["available"] != true {
		t.Fatalf("up must be available: %v", out)
	}
	if p, _ := out["port"].(float64); int(p) != m.Port() {
		t.Fatalf("the port must ride: %v (manager %d)", out, m.Port())
	}
	_ = base
}

// TestV1492InstallRungs — the install route's immediate honest answers: a
// closed gate answers its ladder state; the in-flight flag answers
// installing; an already-up bridge answers up; the desktop answers desktop.
func TestV1492InstallRungs(t *testing.T) {
	t.Setenv("DOOMALAY_OPENCODE_SPAWNER", "termux")
	// closed gate: no key
	s := newTermuxTestServer(t, "http://127.0.0.1:1/bad")
	rec := httptest.NewRecorder()
	s.handleOcBridgeInstall(rec, httptest.NewRequest(http.MethodPost, "/api/opencode/bridge/install", nil))
	var out map[string]any
	json.Unmarshal(rec.Body.Bytes(), &out)
	if out["ok"] != false || out["state"] != "walled" {
		t.Fatalf("install on a closed gate must answer ok:false + the rung: %v", out)
	}
	// closed gate: termux missing
	v1492SetKey(t, s, "oc_sk_x")
	st := newTermuxStubBridge(t, false, false)
	s2 := newTermuxTestServer(t, st.srv.URL)
	v1492SetKey(t, s2, "oc_sk_x")
	rec = httptest.NewRecorder()
	s2.handleOcBridgeInstall(rec, httptest.NewRequest(http.MethodPost, "/api/opencode/bridge/install", nil))
	out = map[string]any{}
	json.Unmarshal(rec.Body.Bytes(), &out)
	if out["ok"] != false || out["state"] != "termux_missing" {
		t.Fatalf("install on termux_missing: %v", out)
	}
	// in-flight: answers installing, never a second install
	st3 := newTermuxStubBridge(t, true, true)
	s3 := newTermuxTestServer(t, st3.srv.URL)
	v1492SetKey(t, s3, "oc_sk_x")
	s3.ocBridgeSetRunning(true)
	rec = httptest.NewRecorder()
	s3.handleOcBridgeInstall(rec, httptest.NewRequest(http.MethodPost, "/api/opencode/bridge/install", nil))
	out = map[string]any{}
	json.Unmarshal(rec.Body.Bytes(), &out)
	if out["ok"] != true || out["state"] != "installing" {
		t.Fatalf("install while installing: %v", out)
	}
	s3.ocBridgeSetRunning(false)
	// already up: no install needed
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(200) }))
	defer srv.Close()
	m := ocserve.New(t.TempDir(), "k", func(string, ...any) {})
	m.SetBaseURL(srv.URL)
	s3.ocServeMu.Lock()
	s3.ocServe = m
	s3.ocServeMu.Unlock()
	rec = httptest.NewRecorder()
	s3.handleOcBridgeInstall(rec, httptest.NewRequest(http.MethodPost, "/api/opencode/bridge/install", nil))
	out = map[string]any{}
	json.Unmarshal(rec.Body.Bytes(), &out)
	if out["ok"] != true || out["state"] != "up" {
		t.Fatalf("install while up: %v", out)
	}
}

// TestV1492TurnTerminalWhileInstalling — runOcServeTurn answers the honest
// in-progress terminal (never blocks, never silently degrades to the 403).
func TestV1492TurnTerminalWhileInstalling(t *testing.T) {
	t.Setenv("DOOMALAY_OPENCODE_SPAWNER", "termux")
	st := newTermuxStubBridge(t, true, true)
	s := newTermuxTestServer(t, st.srv.URL)
	v1492SetKey(t, s, "oc_sk_x")
	s.ocBridgeSetRunning(true)
	terminal := false
	handled := s.runOcServeTurn(context.Background(), nil, "sess-v1492", nil, "hi", &terminal)
	if !handled || !terminal {
		t.Fatalf("the in-progress turn must be handled + terminal (handled=%v terminal=%v)", handled, terminal)
	}
}

// TestV1492NoKeyLeakInLadder — the status route NEVER echoes the key.
func TestV1492NoKeyLeakInLadder(t *testing.T) {
	t.Setenv("DOOMALAY_OPENCODE_SPAWNER", "termux")
	s := newTermuxTestServer(t, "http://127.0.0.1:1/bad")
	v1492SetKey(t, s, "oc_sk_secret_v1492")
	out := v1492BridgeGET(s)
	raw, _ := json.Marshal(out)
	if strings.Contains(string(raw), "oc_sk_secret_v1492") {
		t.Fatalf("THE KEY LEAKED through the ladder: %s", raw)
	}
}

var _ = secrets.New // keep the import honest if the pins evolve
var _ = time.Second
