// Package pmstate owns the engine's PrivateMode PIN: the persisted mesh
// CA + active manifest + cached secret that let the engine speak PM's
// E2E-encryption protocol natively across restarts without re-attesting
// on every boot. v1.44.2 THE PIN (PLAN-V144-THE-NATIVE-PM.md §2, phase
// v1.44.2).
//
// THE TRUST CONTRACT (mirrors pm/PROVENANCE.md): the engine may never
// compile the attestation verifier (contrast/sdk is BSL-1.1), so the
// pin is TOFU — trust-on-first-use — and the one-shot WASM oracle (the
// app's vendored npm privatemode-ai SDK, an MIT artifact embedding
// Edgeless's own verifier, run at provider connect) upgrades the pin to
// verified=true. An unverified pin is surfaced honestly everywhere
// (GET /api/pm/state → the connect UI's pill); it is NEVER silently
// upgraded. On exchange failure with a stale pin the manager compares
// the pinned CA against a fresh attest fetch: a different CA is the
// honest ErrPMDeploymentChanged — never an automatic re-pin.
//
// The pin + cached secret live in the secrets vault's reserved internal
// state namespace (__STATE__PM_PIN), AES-256-GCM encrypted at rest
// exactly like every provider key, invisible to the HTTP keys API and
// to AsEnv.
package pmstate

import (
	"bytes"
	"context"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"sync"
	"time"

	"github.com/ScoobyBaby1999/doomalay/engine/internal/netx"
	"github.com/ScoobyBaby1999/doomalay/engine/internal/pm/attest"
	"github.com/ScoobyBaby1999/doomalay/engine/internal/pm/auth"
	"github.com/ScoobyBaby1999/doomalay/engine/internal/pm/privatemode"
	"github.com/ScoobyBaby1999/doomalay/engine/internal/pm/secretmanager"
	"github.com/ScoobyBaby1999/doomalay/engine/internal/secrets"
)

const (
	// VaultName is the vault internal-state key the pin persists under.
	VaultName = "PM_PIN"

	// KeyEnvVar is the vault key the PM provider authenticates with.
	KeyEnvVar = "PRIVATEMODEAI_API_KEY"

	// APIBaseURL is the Privatemode API gateway (the vendored client's
	// default). Overridable in tests.
	APIBaseURL = "https://api.privatemode.ai"

	// renewFloor is how long before expiry a cached secret is renewed
	// (the vendored secretmanager itself keeps a 15-minute buffer on
	// freshly exchanged secrets; the floor covers imported ones).
	renewFloor = 2 * time.Minute
)

// ErrNoKey is the honest no-key verdict: connect the provider first.
var ErrNoKey = errors.New("no PrivateMode API key saved — connect the provider first")

// ErrPMDeploymentChanged is the honest stale-pin verdict: the
// deployment's mesh CA no longer matches the pin. NEVER auto-repinned —
// the user re-verifies (open the app and run a PrivateMode chat, or
// press Re-verify in the provider card).
var ErrPMDeploymentChanged = errors.New("PM deployment changed — re-verify (open the app and run a PrivateMode chat, or press Re-verify)")

// State is the pinned PM trust state, persisted as one JSON blob in the
// vault's internal-state namespace (encrypted at rest like every key).
type State struct {
	// MeshCAPEM is the pinned mesh CA certificate (PEM).
	MeshCAPEM string `json:"mesh_ca_pem"`
	// ManifestB64 is the deployment's ACTIVE manifest (the attest doc's
	// manifests[0]) at pin time, base64.
	ManifestB64 string `json:"manifest_b64"`
	// Verified is true ONLY when the WASM oracle verified the
	// attestation in the pin window (POST /api/pm/bootstrap).
	Verified bool `json:"verified"`
	// The cached HPKE secret (the persisted form of the official SDK's
	// in-memory secret; reused across restarts, renewed on expiry).
	SecretID      string `json:"secret_id,omitempty"`
	SecretDataB64 string `json:"secret_data_b64,omitempty"`
	SecretExpUnix int64  `json:"secret_exp_unix,omitempty"`
	// PinnedAtUnix is when the pin was written.
	PinnedAtUnix int64 `json:"pinned_at_unix"`
}

// Status is the honest surface for GET /api/pm/state (the connect UI's
// pin pill). Never secret material.
type Status struct {
	KeyPresent      bool  `json:"key_present"`
	Pinned          bool  `json:"pinned"`
	Verified        bool  `json:"verified"`
	SecretExpiresIn int64 `json:"secret_expires_in"` // seconds; <=0 = none/expired
	PinnedAtUnix    int64 `json:"pinned_at_unix"`
}

// OracleResult is the one-shot WASM oracle's report
// (POST /api/pm/bootstrap). The oracle ran the full Contrast
// attestation verification (verify()) + secret exchange
// (refreshSecret()) in the WebView; the engine pins its OWN fresh
// attest fetch, marked verified only when the oracle succeeded.
type OracleResult struct {
	Verified      bool   `json:"verified"`
	ManifestB64   string `json:"manifest,omitempty"` // the CDN manifest bytes the oracle verified against (informational)
	SecretID      string `json:"secret_id,omitempty"`
	SecretDataB64 string `json:"secret_data,omitempty"` // the exported secret, base64
	SecretExpUnix int64  `json:"exp_unix,omitempty"`
}

// Manager owns the pin + the per-key PM client. The vendored
// privatemode.Client is not thread-safe, so the manager guards every
// access behind its mutex and holds at most one live client per API
// key (rebuilt on key rotation or pin change).
type Manager struct {
	mu         sync.Mutex
	vault      *secrets.Vault
	state      *State // nil = no pin yet
	client     *privatemode.Client
	clientKey  string
	log        *slog.Logger
	apiBase    string       // tests override; APIBaseURL in production
	httpClient *http.Client // tests inject the fake-server client; netx.Transport() in production (v1.45.1)
}

// NewManager loads (or starts without) the persisted pin.
func NewManager(vault *secrets.Vault) *Manager {
	m := &Manager{
		vault:   vault,
		log:     slog.New(slog.DiscardHandler),
		apiBase: rigAPIBase(),
		// v1.45.1 THE ANDROID WIRE (PLAN-V145 §1): the manager's client
		// dials through netx — the engine's outbound law ("the Android
		// DNS fix applies everywhere. Every engine client that talks to
		// the outside world should use this"). The vendored
		// httputil.NewClient() (Go's default dialer + a 5s HTTP/2
		// health-check ping) left PM as the ONE engine client that died
		// on Android — no /etc/resolv.conf means Go's pure resolver is
		// unreliable there, so PM's dials failed on real devices while
		// every netx-dialing provider worked (the user's live report:
		// "network unreachable… even tho I was connected to the
		// internet"). The 5s ReadIdleTimeout ping also killed mid-request
		// connections on lossy mobile links the engine's own transports
		// (no health pings) ride through. netx.Transport() fixes both.
		httpClient: &http.Client{Transport: netx.Transport()},
	}
	m.state = m.loadState()
	return m
}

// rigAPIBase is the rig/diagnostic knob for the PM gateway base URL
// (DOOMALAY_PM_API_BASE) — same family as DOOMALAY_NET_LADDER_WAITS: the
// red-team rigs point the engine at a dead/local endpoint to exercise the
// net-pause ladder + the honest error surfaces without touching the real
// deployment. Empty (the production default) = APIBaseURL.
func rigAPIBase() string {
	if v := os.Getenv("DOOMALAY_PM_API_BASE"); v != "" {
		return v
	}
	return APIBaseURL
}

// WithLogger wires the manager's logger (the server passes its own).
func (m *Manager) WithLogger(log *slog.Logger) *Manager {
	if log != nil {
		m.log = log
	}
	return m
}

func (m *Manager) loadState() *State {
	if m.vault == nil {
		return nil
	}
	blob, ok, err := m.vault.GetInternalState(VaultName)
	if err != nil {
		m.log.Warn("PM pin load failed", "error", err)
		return nil
	}
	if !ok {
		return nil
	}
	var st State
	if json.Unmarshal([]byte(blob), &st) != nil || st.MeshCAPEM == "" {
		m.log.Warn("PM pin blob unusable — starting unpinned")
		return nil
	}
	return &st
}

func (m *Manager) persistLocked() error {
	if m.state == nil {
		return nil
	}
	blob, err := json.Marshal(m.state)
	if err != nil {
		return err
	}
	return m.vault.SetInternalState(VaultName, string(blob))
}

// Status reports the pin state (never secret material).
func (m *Manager) Status() Status {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.statusLocked()
}

func (m *Manager) statusLocked() Status {
	st := Status{KeyPresent: m.keyPresentLocked()}
	if m.state != nil {
		st.Pinned = true
		st.Verified = m.state.Verified
		st.PinnedAtUnix = m.state.PinnedAtUnix
		if m.state.SecretExpUnix > 0 {
			st.SecretExpiresIn = m.state.SecretExpUnix - time.Now().Unix()
		}
	}
	return st
}

func (m *Manager) keyPresentLocked() bool {
	if m.vault == nil {
		return false
	}
	_, _, err := m.vault.Get(KeyEnvVar)
	return err == nil
}

// secret returns the cached secret as the vendored type, when present
// and still valid.
func (s *State) secret() (secretmanager.Secret, bool) {
	if s == nil || s.SecretID == "" || s.SecretDataB64 == "" || s.SecretExpUnix <= 0 {
		return secretmanager.Secret{}, false
	}
	data, err := base64.StdEncoding.DecodeString(s.SecretDataB64)
	if err != nil || len(data) == 0 {
		return secretmanager.Secret{}, false
	}
	exp := time.Unix(s.SecretExpUnix, 0)
	if !time.Now().Before(exp) {
		return secretmanager.Secret{}, false
	}
	return secretmanager.Secret{ID: s.SecretID, Data: data, ExpirationDate: exp}, true
}

// Client returns the per-key PM client, pinned to the stored mesh CA.
//
// First contact with no pin (the headless path): TOFU — the engine
// fetches the attest doc itself, pins it as verified=false, and the
// status surface says so honestly. Secret renewal rides the pinned CA;
// on exchange failure the manager runs the drift check and never
// silently re-pins.
func (m *Manager) Client(ctx context.Context) (*privatemode.Client, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.clientLocked(ctx)
}

func (m *Manager) clientLocked(ctx context.Context) (*privatemode.Client, error) {
	if m.vault == nil {
		return nil, errors.New("vault not initialized")
	}
	key, _, err := m.vault.Get(KeyEnvVar)
	if err != nil {
		return nil, ErrNoKey
	}

	if m.state == nil {
		// TOFU first contact (headless): fetch the deployment's attest
		// doc, pin mesh CA + active manifest, persist, and let the
		// status surface show the honest "unverified first contact".
		cert, mf0, err := m.fetchDoc(ctx, key)
		if err != nil {
			return nil, fmt.Errorf("pm first contact (TOFU attest fetch): %w", err)
		}
		m.state = &State{
			MeshCAPEM:    string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: cert.Raw})),
			ManifestB64:  base64.StdEncoding.EncodeToString(mf0),
			Verified:     false,
			PinnedAtUnix: time.Now().Unix(),
		}
		if err := m.persistLocked(); err != nil {
			m.log.Warn("PM pin persist failed", "error", err)
		}
		m.log.Info("PM pinned (TOFU — unverified first contact; the WASM oracle upgrades it at the app's next PM connect)")
	}

	if m.client == nil || m.clientKey != key {
		// Key rotation: the cached secret was exchanged under the OLD
		// credential — drop it (the mesh CA pin survives; it is not
		// key-bound) so the rebuilt client exchanges fresh under the
		// new key. Never serve a secret the new key didn't mint.
		if m.client != nil && m.clientKey != key {
			m.state.SecretID = ""
			m.state.SecretDataB64 = ""
			m.state.SecretExpUnix = 0
			if err := m.persistLocked(); err != nil {
				m.log.Warn("PM secret clear on rotation persist failed", "error", err)
			}
		}
		c := privatemode.New(auth.APIKey(key)).WithAPIBaseURL(m.apiBase).WithLogger(m.log).WithHTTPClient(m.httpClient)
		if err := c.InitializeWithPinnedCA(ctx, []byte(m.state.MeshCAPEM)); err != nil {
			return nil, fmt.Errorf("pm init with pinned CA: %w", err)
		}
		c.SetCredential(auth.APIKey(key))
		if sec, ok := m.state.secret(); ok {
			if err := c.ImportSecret(sec); err != nil {
				m.log.Warn("PM cached secret import failed; exchanging fresh", "error", err)
			}
		}
		m.client = c
		m.clientKey = key
	}

	// Renewal: exchange a fresh secret against the pinned CA when the
	// cached one is gone or within the expiry floor.
	if sec, err := m.client.ExportSecret(); err == nil && time.Now().Before(sec.ExpirationDate.Add(-renewFloor)) {
		return m.client, nil
	}
	if err := m.client.UpdateSecret(ctx); err != nil {
		return nil, m.driftCheckLocked(ctx, key, err)
	}
	if sec, err := m.client.ExportSecret(); err == nil {
		m.state.SecretID = sec.ID
		m.state.SecretDataB64 = base64.StdEncoding.EncodeToString(sec.Data)
		m.state.SecretExpUnix = sec.ExpirationDate.Unix()
		if err := m.persistLocked(); err != nil {
			m.log.Warn("PM secret persist failed", "error", err)
		}
	}
	return m.client, nil
}

// driftCheckLocked is the honest stale-pin verdict on exchange
// failure: fetch the deployment's CURRENT attest doc and compare mesh
// CAs. A different CA = the deployment changed under the pin →
// ErrPMDeploymentChanged (never a silent re-pin). The same CA = the
// failure was transient → the original error surfaces (the turn
// ladder's net-pause path owns retries).
func (m *Manager) driftCheckLocked(ctx context.Context, key string, cause error) error {
	cert, _, err := m.fetchDoc(ctx, key)
	if err != nil {
		m.log.Warn("PM drift probe failed; surfacing the original exchange error", "error", err)
		return cause
	}
	pinnedBlock, _ := pem.Decode([]byte(m.state.MeshCAPEM))
	if pinnedBlock == nil || !bytes.Equal(pinnedBlock.Bytes, cert.Raw) {
		m.log.Warn("PM DEPLOYMENT CHANGED: the pinned mesh CA no longer matches the deployment — refusing to silently re-pin",
			"pinned_subject", cert.Subject.String())
		return fmt.Errorf("%w: the PrivateMode deployment's mesh CA changed since the pin", ErrPMDeploymentChanged)
	}
	return cause
}

// Bootstrap pins the engine's OWN fresh attest fetch, upgraded to
// verified=true only when the one-shot WASM oracle reported its
// verify() success from the same window. The oracle's exported secret
// seeds the pin when its shape is valid (the engine exchanges its own
// the moment it is stale). Key rotation is honored: the pin never
// carries key material, and the client rebuilds per key.
func (m *Manager) Bootstrap(ctx context.Context, res OracleResult) (Status, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.vault == nil {
		return Status{}, errors.New("vault not initialized")
	}
	key, _, err := m.vault.Get(KeyEnvVar)
	if err != nil {
		return Status{}, ErrNoKey
	}
	cert, mf0, err := m.fetchDoc(ctx, key)
	if err != nil {
		return Status{}, fmt.Errorf("pm attest fetch: %w", err)
	}
	st := &State{
		MeshCAPEM:    string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: cert.Raw})),
		ManifestB64:  base64.StdEncoding.EncodeToString(mf0),
		Verified:     res.Verified,
		PinnedAtUnix: time.Now().Unix(),
	}
	// The oracle's manifest is the CDN manifest it verified against; a
	// drift vs the ACTIVE manifest means a stale CDN cache — warn, pin
	// the ACTIVE one, never fail (PLAN-V144 §5 default 4).
	if res.ManifestB64 != "" && res.ManifestB64 != st.ManifestB64 {
		m.log.Warn("PM oracle manifest differs from the active manifest (stale CDN cache?) — pinning the ACTIVE manifest")
	}
	// Seed the secret when the oracle handed a valid one over.
	if data, derr := base64.StdEncoding.DecodeString(res.SecretDataB64); derr == nil && res.SecretID != "" && len(data) > 0 && res.SecretExpUnix > time.Now().Unix() {
		st.SecretID = res.SecretID
		st.SecretDataB64 = res.SecretDataB64
		st.SecretExpUnix = res.SecretExpUnix
	}
	m.state = st
	m.client = nil // rebuild against the new pin
	m.clientKey = ""
	if err := m.persistLocked(); err != nil {
		return Status{}, fmt.Errorf("pm pin persist: %w", err)
	}
	m.log.Info("PM pinned", "verified", st.Verified, "oracle_secret", st.SecretID != "")
	return m.statusLocked(), nil
}

// Reverify clears the pin (the honest reset): the UI's next PM action
// re-runs the WASM oracle (fresh verify) which re-pins via Bootstrap;
// a headless engine re-pins TOFU on its next PM turn.
func (m *Manager) Reverify() error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.vault == nil {
		return errors.New("vault not initialized")
	}
	if err := m.vault.DeleteInternalState(VaultName); err != nil {
		return err
	}
	m.state = nil
	m.client = nil
	m.clientKey = ""
	m.log.Info("PM pin cleared — re-verify pending (oracle at next app connect, or TOFU on the next headless turn)")
	return nil
}

// DropSecret clears the cached secret and drops the live client (the
// "no secret for ID" recovery — the wire retries exactly once after a
// server-side secret revocation; the next Client() rebuilds and
// exchanges fresh against the pinned CA). The pin itself survives.
func (m *Manager) DropSecret() {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.state != nil {
		m.state.SecretID = ""
		m.state.SecretDataB64 = ""
		m.state.SecretExpUnix = 0
		if err := m.persistLocked(); err != nil {
			m.log.Warn("PM secret clear persist failed", "error", err)
		}
	}
	m.client = nil
	m.clientKey = ""
	m.log.Info("PM cached secret dropped — fresh exchange on the next turn")
}

// fetchDoc fetches the deployment's attest doc (mesh CA + active
// manifest) — the TOFU getter performs NO attestation verification
// (see the trust contract).
func (m *Manager) fetchDoc(ctx context.Context, key string) (*x509.Certificate, []byte, error) {
	u, err := url.Parse(m.apiBase)
	if err != nil {
		return nil, nil, err
	}
	getter := attest.NewGetter(m.httpClient, u.Host)
	return getter.GetAttestedDoc(ctx, auth.APIKey(key))
}
