// Package termuxbridge is the engine-side client for the APK's Termux
// bridge — the loopback HTTP server EngineService hosts (TermuxBridgeServer
// in Kotlin, bound to 127.0.0.1:8081..8090, token in the URL path).
//
// The four-route token-authed contract:
//
//	GET  /status  → {"installed":bool,"version_code":int64,"version_name":str|null,"permission":bool}
//	POST /probe   → {"ok":bool,"storage_ok":…,"props_ok":…,"stdout":…,"stderr":…,"exit_code":…,"err":…,"errmsg":…,"timeout":bool}
//	POST /run     → same result shape (the generic jailed exec)
//	POST /act     → {"what":"open_termux"|"open_fdroid"|"open_permission_settings"} → {"ok":bool}
//
// The base URL carries the token (http://127.0.0.1:<port>/<token>); the
// same-UID loopback + unguessable token is the auth. Every method takes a
// context (the caller bounds each call — a run can legitimately take 180s)
// and returns TYPED errors for the transport ladder so the server can
// surface them as STATUS fields, never panics or silent failures.
//
// Pure stdlib — the engine stays CGO-free (GOOS=android arm64 safe).
package termuxbridge

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"time"
)

// Typed errors: the /api/termux/status aggregation maps these onto honest
// status fields (bridge_ok:false + last_error), never 500s.
var (
	// ErrBridgeUnreachable: connection refused / DNS / bad URL — the Kotlin
	// loopback server is dead or the URL is wrong.
	ErrBridgeUnreachable = errors.New("termux bridge unreachable")
	// ErrBridgeTimeout: the round-trip exceeded its context deadline.
	ErrBridgeTimeout = errors.New("termux bridge timed out")
	// ErrTokenRejected: the bridge answered 403 (token mismatch).
	ErrTokenRejected = errors.New("termux bridge rejected the token (403)")
	// ErrUnknownRoute: the bridge answered 404 (route or method mismatch).
	ErrUnknownRoute = errors.New("termux bridge route not found (404)")
	// ErrBadResponse: HTTP 200 but the body is not the contract JSON.
	ErrBadResponse = errors.New("termux bridge malformed response")
)

// Client talks to the Kotlin TermuxBridgeServer.
type Client struct {
	BaseURL string
	HTTP    *http.Client
}

// clientHardCap is the belt under forgetful callers: the run route is
// legitimately slow (180s hard cap bridge-side), so there is no per-call
// default timeout — every call is bounded by its context, with this final
// client cap underneath.
const clientHardCap = 185 * time.Second

// NewClient builds a client for a bridge base URL
// (http://127.0.0.1:<port>/<token>).
func NewClient(baseURL string) *Client {
	return &Client{BaseURL: baseURL, HTTP: &http.Client{Timeout: clientHardCap}}
}

// Status is the /status shape — the Kotlin PackageManager lookups (fresh
// on every call; sub-millisecond, no caching needed). The v1.20.1 checkin
// fields are additive: an older Kotlin bridge that predates THE QUIET GATE
// simply does not send them, and they decode to their zero values (empty
// URL, false flags, 0 timestamp) — the honest old-flow state, never an
// error.
type Status struct {
	Installed      bool   `json:"installed"`
	VersionCode    int64  `json:"version_code"`
	VersionName    string `json:"version_name"`
	Permission     bool   `json:"permission"`
	CheckinURL     string `json:"checkin_url"`
	BootstrapDone  bool   `json:"bootstrap_done"`
	CheckinAt      int64  `json:"checkin_at"`
	CheckinStorage bool   `json:"checkin_storage"`
	CheckinProps   bool   `json:"checkin_props"`
}

// RunResult is the /probe + /run result shape. StorageOK/PropsOK are the
// probe markers — parsed from the response JSON AND re-derived from the
// stdout markers on the client side (the markers are the ground truth).
type RunResult struct {
	Ok        bool   `json:"ok"`
	Stdout    string `json:"stdout"`
	Stderr    string `json:"stderr"`
	ExitCode  int    `json:"exit_code"`
	Err       int    `json:"err"`
	Errmsg    string `json:"errmsg"`
	Timeout   bool   `json:"timeout"`
	StorageOK bool   `json:"storage_ok"`
	PropsOK   bool   `json:"props_ok"`
}

// ActResult is the /act response.
type ActResult struct {
	Ok bool `json:"ok"`
}

// Status fetches the Termux installed/version/permission ladder.
func (c *Client) Status(ctx context.Context) (*Status, error) {
	var out Status
	if err := c.do(ctx, http.MethodGet, "/status", nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// Probe runs the one-shot verification command (the marker script) and
// returns its result with the stdout markers parsed.
func (c *Client) Probe(ctx context.Context) (*RunResult, error) {
	var out RunResult
	if err := c.do(ctx, http.MethodPost, "/probe", map[string]any{}, &out); err != nil {
		return nil, err
	}
	parseProbeMarkers(&out)
	return &out, nil
}

// Run executes command in the jailed Termux environment. timeoutMS <= 0
// lets the bridge default (60s); the bridge hard-caps at 180s. workdir ""
// defaults to the Termux home on the bridge side.
func (c *Client) Run(ctx context.Context, command, workdir string, timeoutMS int) (*RunResult, error) {
	body := map[string]any{"command": command}
	if workdir != "" {
		body["workdir"] = workdir
	}
	if timeoutMS > 0 {
		body["timeout_ms"] = timeoutMS
	}
	var out RunResult
	if err := c.do(ctx, http.MethodPost, "/run", body, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// Act fires one of the open-* intents on the APK side (open_termux,
// open_fdroid, open_permission_settings).
func (c *Client) Act(ctx context.Context, what string) (*ActResult, error) {
	var out ActResult
	if err := c.do(ctx, http.MethodPost, "/act", map[string]any{"what": what}, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// parseProbeMarkers derives StorageOK/PropsOK from the probe script's
// stdout markers — the ground truth (the JSON fields are re-derived from
// them on the client side so a lying/older bridge cannot fake a ready
// state):
//
//	echo __doomalay_probe__;
//	test -d "$HOME/storage/shared" && echo storage_ok || echo storage_missing;
//	grep -q "^allow-external-apps" … && echo props_ok || echo props_missing
//
// No marker → the script never ran → both false (honest), whatever the
// JSON fields claim.
func parseProbeMarkers(r *RunResult) {
	r.StorageOK = false
	r.PropsOK = false
	if strings.Contains(r.Stdout, "__doomalay_probe__") {
		r.StorageOK = strings.Contains(r.Stdout, "storage_ok")
		r.PropsOK = strings.Contains(r.Stdout, "props_ok")
	}
}

// do performs one JSON round-trip and maps failures onto the typed errors.
func (c *Client) do(ctx context.Context, method, path string, body any, out any) error {
	var rd io.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			return fmt.Errorf("termuxbridge: encode request: %w", err)
		}
		rd = bytes.NewReader(raw)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.BaseURL+path, rd)
	if err != nil {
		return fmt.Errorf("%w: %v", ErrBridgeUnreachable, err)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return classifyTransport(err)
	}
	defer resp.Body.Close()
	switch resp.StatusCode {
	case http.StatusOK:
		if err := json.NewDecoder(io.LimitReader(resp.Body, 512*1024)).Decode(out); err != nil {
			return fmt.Errorf("%w: %v", ErrBadResponse, err)
		}
		return nil
	case http.StatusForbidden:
		return ErrTokenRejected
	case http.StatusNotFound:
		return ErrUnknownRoute
	default:
		return fmt.Errorf("termux bridge: HTTP %d", resp.StatusCode)
	}
}

// classifyTransport maps transport-level failures onto the typed errors
// (timeout → ErrBridgeTimeout; everything else reachable-wise →
// ErrBridgeUnreachable, message preserved for last_error honesty).
// Caller-side cancellation passes through untouched.
func classifyTransport(err error) error {
	if errors.Is(err, context.Canceled) {
		return err
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return ErrBridgeTimeout
	}
	var ne net.Error
	if errors.As(err, &ne) && ne.Timeout() {
		return ErrBridgeTimeout
	}
	return fmt.Errorf("%w: %v", ErrBridgeUnreachable, err)
}
