package termuxbridge

// client_test.go — v1.17.2 THE BRIDGE: the engine-side client against an
// httptest stub of the Kotlin TermuxBridgeServer contract (all four routes,
// happy paths, the typed-error transport ladder). Standard library only.

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"
)

// stubBridge serves the four-route contract. lastRun/lastAct capture the
// request bodies the client sent (method pins ride alongside).
type stubBridge struct {
	probeHits int
	runBodies []map[string]any
	actBodies []map[string]any
	mu        sync.Mutex
	srv       *httptest.Server
}

func newStubBridge(t *testing.T) *stubBridge {
	t.Helper()
	st := &stubBridge{}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /status", func(w http.ResponseWriter, r *http.Request) {
		writeStubJSON(w, map[string]any{
			"installed":    true,
			"version_code": 1002,
			"version_name": "0.118.3",
			"permission":   true,
		})
	})
	mux.HandleFunc("POST /probe", func(w http.ResponseWriter, r *http.Request) {
		st.mu.Lock()
		st.probeHits++
		st.mu.Unlock()
		writeStubJSON(w, map[string]any{
			"ok":         true,
			"storage_ok": false, // deliberately false in JSON — the client must parse from stdout
			"props_ok":   false,
			"stdout":     "__doomalay_probe__\nstorage_ok\nprops_ok\n",
			"stderr":     "",
			"exit_code":  0,
			"err":        0,
			"errmsg":     nil,
			"timeout":    false,
		})
	})
	mux.HandleFunc("POST /run", func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		st.mu.Lock()
		st.runBodies = append(st.runBodies, body)
		st.mu.Unlock()
		writeStubJSON(w, map[string]any{
			"ok":        true,
			"stdout":    "hello from termux\n",
			"stderr":    "",
			"exit_code": 0,
			"err":       0,
			"errmsg":    nil,
			"timeout":   false,
		})
	})
	mux.HandleFunc("POST /act", func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		st.mu.Lock()
		st.actBodies = append(st.actBodies, body)
		st.mu.Unlock()
		writeStubJSON(w, map[string]any{"ok": true})
	})
	st.srv = httptest.NewServer(mux)
	t.Cleanup(st.srv.Close)
	return st
}

func writeStubJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}

func TestStatus_HappyPath(t *testing.T) {
	st := newStubBridge(t)
	c := NewClient(st.srv.URL)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	s, err := c.Status(ctx)
	if err != nil {
		t.Fatalf("Status: %v", err)
	}
	if !s.Installed || s.VersionCode != 1002 || s.VersionName != "0.118.3" || !s.Permission {
		t.Fatalf("Status fields wrong: %+v", s)
	}
}

// v1.20.1 THE QUIET GATE: the /status checkin fields decode (a bridge that
// reports them) and — critically — a bridge that PREDATES them (no fields
// at all) still decodes to the honest zero state, never an error: an old
// APK bridge against a new engine is the old flow, not a failure.
func TestStatus_CheckinFields_DecodeDefensively(t *testing.T) {
	// the v1.20.1 bridge: checkin fields present
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		writeStubJSON(w, map[string]any{
			"installed": true, "version_code": 1002, "version_name": "0.118.3", "permission": true,
			"checkin_url":     "http://127.0.0.1:8081/01234567-89ab-cdef-0123-456789abcdef/checkin",
			"bootstrap_done":  true,
			"checkin_at":      1717000000,
			"checkin_storage": true,
			"checkin_props":   false,
		})
	}))
	defer ts.Close()
	c := NewClient(ts.URL)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	s, err := c.Status(ctx)
	if err != nil {
		t.Fatalf("Status: %v", err)
	}
	if s.CheckinURL != "http://127.0.0.1:8081/01234567-89ab-cdef-0123-456789abcdef/checkin" ||
		!s.BootstrapDone || s.CheckinAt != 1717000000 || !s.CheckinStorage || s.CheckinProps {
		t.Fatalf("checkin fields should decode: %+v", s)
	}

	// the pre-v1.20.1 bridge: no checkin fields at all
	old := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		writeStubJSON(w, map[string]any{
			"installed": true, "version_code": 1002, "version_name": "0.118.3", "permission": true,
		})
	}))
	defer old.Close()
	c2 := NewClient(old.URL)
	ctx2, cancel2 := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel2()
	s2, err := c2.Status(ctx2)
	if err != nil {
		t.Fatalf("an old bridge must decode, not error: %v", err)
	}
	if s2.CheckinURL != "" || s2.BootstrapDone || s2.CheckinAt != 0 || s2.CheckinStorage || s2.CheckinProps {
		t.Fatalf("missing checkin fields must decode to the zero state: %+v", s2)
	}
	if !s2.Installed || !s2.Permission {
		t.Fatalf("the base ladder still decodes: %+v", s2)
	}
}

// THE pin: the probe's StorageOK/PropsOK come from the STDOUT markers
// (ground truth), not just the JSON fields — here the JSON says false and
// the stdout says true; the client must land on true.
func TestProbe_MarkersParsedFromStdout(t *testing.T) {
	st := newStubBridge(t)
	c := NewClient(st.srv.URL)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	r, err := c.Probe(ctx)
	if err != nil {
		t.Fatalf("Probe: %v", err)
	}
	if !r.StorageOK {
		t.Fatalf("StorageOK should parse from stdout markers (stdout=%q)", r.Stdout)
	}
	if !r.PropsOK {
		t.Fatalf("PropsOK should parse from stdout markers (stdout=%q)", r.Stdout)
	}
	if !r.Ok || r.Timeout || r.ExitCode != 0 {
		t.Fatalf("probe result fields wrong: %+v", r)
	}
}

func TestProbe_MarkersMissing_BothFalse(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		writeStubJSON(w, map[string]any{
			"ok": false, "storage_ok": false, "props_ok": false,
			"stdout": "__doomalay_probe__\nstorage_missing\nprops_missing\n",
			"stderr": "", "exit_code": 0, "err": 0, "errmsg": nil, "timeout": false,
		})
	}))
	defer ts.Close()
	c := NewClient(ts.URL)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	r, err := c.Probe(ctx)
	if err != nil {
		t.Fatalf("Probe: %v", err)
	}
	if r.StorageOK || r.PropsOK {
		t.Fatalf("missing markers must leave both false: %+v", r)
	}
}

// No marker at all (timeout case) → both stay false even if the JSON lies.
func TestProbe_NoMarker_BothFalse(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		writeStubJSON(w, map[string]any{
			"ok": false, "storage_ok": true, "props_ok": true,
			"stdout": "", "stderr": "", "exit_code": -1, "err": 0,
			"errmsg": nil, "timeout": true,
		})
	}))
	defer ts.Close()
	c := NewClient(ts.URL)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	r, err := c.Probe(ctx)
	if err != nil {
		t.Fatalf("Probe: %v", err)
	}
	if r.StorageOK || r.PropsOK {
		t.Fatalf("no probe marker in stdout → both must stay false (JSON fields re-derived): %+v", r)
	}
}

func TestRun_SendsContractBody(t *testing.T) {
	st := newStubBridge(t)
	c := NewClient(st.srv.URL)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	r, err := c.Run(ctx, "echo hi", "/data/data/com.termux/files/home", 30000)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if r.Stdout != "hello from termux\n" || r.ExitCode != 0 || !r.Ok {
		t.Fatalf("Run result wrong: %+v", r)
	}
	st.mu.Lock()
	bodies := append([]map[string]any{}, st.runBodies...)
	st.mu.Unlock()
	if len(bodies) != 1 {
		t.Fatalf("expected 1 /run call, got %d", len(bodies))
	}
	b := bodies[0]
	if b["command"] != "echo hi" {
		t.Fatalf("command not sent verbatim: %v", b)
	}
	if b["workdir"] != "/data/data/com.termux/files/home" {
		t.Fatalf("workdir not sent: %v", b)
	}
	if v, ok := b["timeout_ms"].(float64); !ok || int(v) != 30000 {
		t.Fatalf("timeout_ms not sent: %v", b)
	}
}

func TestRun_OmitsEmptyOptionals(t *testing.T) {
	st := newStubBridge(t)
	c := NewClient(st.srv.URL)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if _, err := c.Run(ctx, "ls", "", 0); err != nil {
		t.Fatalf("Run: %v", err)
	}
	st.mu.Lock()
	b := st.runBodies[len(st.runBodies)-1]
	st.mu.Unlock()
	if _, present := b["workdir"]; present {
		t.Fatalf("empty workdir must be omitted: %v", b)
	}
	if _, present := b["timeout_ms"]; present {
		t.Fatalf("non-positive timeout_ms must be omitted (bridge default): %v", b)
	}
}

func TestAct_SendsWhat(t *testing.T) {
	st := newStubBridge(t)
	c := NewClient(st.srv.URL)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	res, err := c.Act(ctx, "open_termux")
	if err != nil {
		t.Fatalf("Act: %v", err)
	}
	if !res.Ok {
		t.Fatalf("Act result wrong: %+v", res)
	}
	st.mu.Lock()
	bodies := append([]map[string]any{}, st.actBodies...)
	st.mu.Unlock()
	if len(bodies) != 1 || bodies[0]["what"] != "open_termux" {
		t.Fatalf("act body wrong: %v", bodies)
	}
}

// The transport ladder: every bridge-side problem lands on a TYPED error
// the server can surface as a status field.
func TestErrors_TypedLadder(t *testing.T) {
	// A deliberately slow stub for the timeout case.
	slow := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(400 * time.Millisecond)
		writeStubJSON(w, map[string]any{})
	}))
	defer slow.Close()

	// A dead port for the refused case: bind a listener, note the port, close it.
	dead := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	deadURL := dead.URL
	dead.Close()

	tests := []struct {
		name    string
		baseURL string
		ctx     func() (context.Context, context.CancelFunc)
		want    error  // typed-sentinel check (errors.Is)
		wantMsg string // exact-message check for the plain-error case
	}{
		{
			name:    "403 token rejected",
			baseURL: serveStatus(t, http.StatusForbidden, `{"error":"forbidden"}`),
			ctx:     shortCtx,
			want:    ErrTokenRejected,
		},
		{
			name:    "404 unknown route",
			baseURL: serveStatus(t, http.StatusNotFound, `{"error":"not found"}`),
			ctx:     shortCtx,
			want:    ErrUnknownRoute,
		},
		{
			name:    "malformed JSON body",
			baseURL: serveStatus(t, http.StatusOK, `not-json{`),
			ctx:     shortCtx,
			want:    ErrBadResponse,
		},
		{
			name:    "non-200 non-403/404 status",
			baseURL: serveStatus(t, http.StatusInternalServerError, `{"error":"boom"}`),
			ctx:     shortCtx,
			wantMsg: "termux bridge: HTTP 500",
		},
		{
			name:    "timeout (slow bridge, short ctx)",
			baseURL: slow.URL,
			ctx: func() (context.Context, context.CancelFunc) {
				return context.WithTimeout(context.Background(), 60*time.Millisecond)
			},
			want: ErrBridgeTimeout,
		},
		{
			name:    "connection refused (dead port)",
			baseURL: deadURL,
			ctx:     shortCtx,
			want:    ErrBridgeUnreachable,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			c := NewClient(tt.baseURL)
			ctx, cancel := tt.ctx()
			defer cancel()
			_, err := c.Probe(ctx)
			if err == nil {
				t.Fatalf("Probe should fail, got nil (want %v / %q)", tt.want, tt.wantMsg)
			}
			if tt.wantMsg != "" {
				if err.Error() != tt.wantMsg {
					t.Fatalf("error = %q, want %q", err.Error(), tt.wantMsg)
				}
				return
			}
			if !errors.Is(err, tt.want) {
				t.Fatalf("error = %v, want %v", err, tt.want)
			}
		})
	}
}

// Status on a refused bridge → the same unreachable error class.
func TestStatus_DeadBridge_TypedUnreachable(t *testing.T) {
	dead := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	deadURL := dead.URL
	dead.Close()
	c := NewClient(deadURL)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	_, err := c.Status(ctx)
	if !errors.Is(err, ErrBridgeUnreachable) {
		t.Fatalf("Status dead bridge error = %v, want ErrBridgeUnreachable", err)
	}
}

func shortCtx() (context.Context, context.CancelFunc) {
	return context.WithTimeout(context.Background(), 2*time.Second)
}

// serveStatus spins a one-shot server answering every request with the
// given status + body (for the error-ladder cases).
func serveStatus(t *testing.T, status int, body string) string {
	t.Helper()
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_, _ = io.WriteString(w, body)
	}))
	t.Cleanup(ts.Close)
	return ts.URL
}
