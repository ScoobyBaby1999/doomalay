// v1.44.2 THE PIN — the offline battery. The fake PM rig serves the
// attest doc over TLS (the vendored client hardcodes https://) with a
// SWAPPABLE mesh CA and a failing /secret endpoint, which is exactly
// enough to prove every manager law offline:
//
//   - the vault internal-state namespace is invisible + persistent
//   - TOFU first contact pins BEFORE any exchange can succeed
//   - the oracle's verified=true + secret seed upgrades the pin and
//     SKIPS the exchange (the imported secret is used as-is)
//   - a changed mesh CA on exchange failure = ErrPMDeploymentChanged
//     (never a silent re-pin)
//   - the SAME CA on exchange failure = the original error passes
//     through (transient; the turn ladder owns retries)
//   - reverify clears the pin, honestly
//
// The LIVE gate (real key, real deployment) is pm_v1442_live_test.go
// under the pmlive tag.
package pmstate

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"math/big"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/ScoobyBaby1999/doomalay/engine/internal/netx"
	"github.com/ScoobyBaby1999/doomalay/engine/internal/secrets"
)

// fakePM is a minimal Privatemode coordinator: the attest endpoint
// serves a doc wrapping the CURRENT (swappable) self-signed mesh CA;
// the secret endpoint fails honestly (the offline rig never completes
// an HPKE exchange — that's the live test's job).
type fakePM struct {
	srv       *httptest.Server
	mu        sync.Mutex
	certPEM   []byte
	manifest  []byte
	secretHit int
}

func newFakePM(t *testing.T) *fakePM {
	t.Helper()
	f := &fakePM{manifest: []byte(`{"version":"fake-manifest-1"}`)}
	f.swapCert(t)
	f.srv = httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/privatemode/v1/attest" {
			f.mu.Lock()
			pemBytes, mf := f.certPEM, f.manifest
			f.mu.Unlock()
			doc, err := json.Marshal(map[string]any{
				"version":          "v1.25.0",
				"attestation_type": "snp",
				"manifests":        []string{base64.StdEncoding.EncodeToString(mf)},
				"mesh_ca":          base64.StdEncoding.EncodeToString(pemBytes),
			})
			if err != nil {
				t.Fatalf("marshal doc: %v", err)
			}
			_ = json.NewEncoder(w).Encode(map[string]string{
				"AttestationDoc": base64.StdEncoding.EncodeToString(doc),
			})
			return
		}
		if r.URL.Path == "/privatemode/v1/secret" {
			f.mu.Lock()
			f.secretHit++
			f.mu.Unlock()
			w.WriteHeader(http.StatusBadGateway)
			return
		}
		w.WriteHeader(http.StatusNotFound)
	}))
	t.Cleanup(f.srv.Close)
	return f
}

// swapCert rotates the deployment's mesh CA (the drift scenario).
func (f *fakePM) swapCert(t *testing.T) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatalf("generate key: %v", err)
	}
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(time.Now().UnixNano()),
		Subject:      pkix.Name{CommonName: "fake-mesh-ca"},
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().Add(24 * time.Hour),
		KeyUsage:     x509.KeyUsageCertSign | x509.KeyUsageDigitalSignature,
		IsCA:         true,
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		t.Fatalf("create cert: %v", err)
	}
	f.mu.Lock()
	f.certPEM = pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
	f.mu.Unlock()
}

// manager builds a manager wired to the fake deployment + a temp vault.
func manager(t *testing.T, f *fakePM) (*Manager, *secrets.Vault) {
	t.Helper()
	vault, err := secrets.New(t.TempDir())
	if err != nil {
		t.Fatalf("vault: %v", err)
	}
	m := NewManager(vault)
	m.apiBase = f.srv.URL
	m.httpClient = f.srv.Client()
	return m, vault
}

func setPMKey(t *testing.T, vault *secrets.Vault) {
	t.Helper()
	if err := vault.Set(KeyEnvVar, "privatemodeai", "test-key-"+base64.RawStdEncoding.EncodeToString([]byte(time.Now().String())), ""); err != nil {
		t.Fatalf("set pm key: %v", err)
	}
}

// ── the vault internal-state namespace ─────────────────────────────

func TestVaultInternalState_RoundtripAndInvisibility(t *testing.T) {
	dir := t.TempDir()
	vault, err := secrets.New(dir)
	if err != nil {
		t.Fatalf("vault: %v", err)
	}
	if err := vault.SetInternalState(VaultName, `{"mesh_ca_pem":"x"}`); err != nil {
		t.Fatalf("set: %v", err)
	}
	blob, ok, err := vault.GetInternalState(VaultName)
	if err != nil || !ok || blob != `{"mesh_ca_pem":"x"}` {
		t.Fatalf("get: %q ok=%v err=%v", blob, ok, err)
	}
	// The keys surface never sees internal state.
	if err := vault.Set("OPENROUTER_API_KEY", "openrouter", "sk-x", ""); err != nil {
		t.Fatalf("set key: %v", err)
	}
	for _, k := range vault.List() {
		if strings.HasPrefix(k.EnvVar, "__STATE__") {
			t.Fatalf("internal state leaked into List(): %+v", k)
		}
	}
	if env := vault.AsEnv(); len(env) != 1 || env["OPENROUTER_API_KEY"] != "sk-x" {
		t.Fatalf("AsEnv leaked or lost keys: %v", env)
	}
	// Persistence across a reopen (engine restart).
	vault2, err := secrets.New(dir)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	blob2, ok2, err2 := vault2.GetInternalState(VaultName)
	if err2 != nil || !ok2 || blob2 != `{"mesh_ca_pem":"x"}` {
		t.Fatalf("reopen get: %q ok=%v err=%v", blob2, ok2, err2)
	}
	// Delete + idempotent delete (reverify relies on absent ≠ error).
	if err := vault.DeleteInternalState(VaultName); err != nil {
		t.Fatalf("delete: %v", err)
	}
	if err := vault.DeleteInternalState(VaultName); err != nil {
		t.Fatalf("idempotent delete: %v", err)
	}
	// Name validation: the namespace can't be escaped.
	if err := vault.SetInternalState("../evil", "x"); err == nil {
		t.Fatalf("evil name accepted")
	}
}

// ── the cached-secret validity matrix ──────────────────────────────

func TestStateSecretValidity(t *testing.T) {
	now := time.Now()
	valid := &State{SecretID: "s", SecretDataB64: base64.StdEncoding.EncodeToString(make([]byte, 32)), SecretExpUnix: now.Add(time.Hour).Unix()}
	if _, ok := valid.secret(); !ok {
		t.Fatalf("valid secret rejected")
	}
	expired := &State{SecretID: "s", SecretDataB64: base64.StdEncoding.EncodeToString(make([]byte, 32)), SecretExpUnix: now.Add(-time.Minute).Unix()}
	if _, ok := expired.secret(); ok {
		t.Fatalf("expired secret accepted")
	}
	badB64 := &State{SecretID: "s", SecretDataB64: "!!!not-base64!!!", SecretExpUnix: now.Add(time.Hour).Unix()}
	if _, ok := badB64.secret(); ok {
		t.Fatalf("bad base64 accepted")
	}
	noID := &State{SecretDataB64: base64.StdEncoding.EncodeToString(make([]byte, 32)), SecretExpUnix: now.Add(time.Hour).Unix()}
	if _, ok := noID.secret(); ok {
		t.Fatalf("id-less secret accepted")
	}
	if _, ok := (*State)(nil).secret(); ok {
		t.Fatalf("nil state accepted")
	}
}

// ── TOFU first contact: the pin lands even when the exchange fails ──

func TestTOFUPin_PinsBeforeExchangeSuccess(t *testing.T) {
	f := newFakePM(t)
	m, vault := manager(t, f)
	setPMKey(t, vault)

	st := m.Status()
	if st.KeyPresent != true || st.Pinned {
		t.Fatalf("fresh status: %+v", st)
	}
	// Client(): the attest fetch succeeds (pin), the exchange 500s.
	c, err := m.Client(context.Background())
	if err == nil {
		t.Fatalf("expected the offline exchange to fail, got client %v", c)
	}
	if errors.Is(err, ErrPMDeploymentChanged) {
		t.Fatalf("drift convicted on FIRST contact (no pin existed to drift from): %v", err)
	}
	if errors.Is(err, ErrNoKey) {
		t.Fatalf("key present but reported missing: %v", err)
	}
	// THE LAW: the pin landed (TOFU), honestly unverified.
	st = m.Status()
	if !st.Pinned || st.Verified {
		t.Fatalf("TOFU pin must be pinned+unverified: %+v", st)
	}
	if f.secretHit == 0 {
		t.Fatalf("the exchange was never attempted")
	}
	// The pin persisted: a fresh manager (engine restart) reloads it.
	m2 := NewManager(vault)
	m2.apiBase = f.srv.URL
	m2.httpClient = f.srv.Client()
	st2 := m2.Status()
	if !st2.Pinned || st2.Verified || !st2.KeyPresent {
		t.Fatalf("reloaded pin: %+v", st2)
	}
}

// ── the oracle upgrade: verified + secret seed skips the exchange ──

func TestBootstrapOracleUpgrade(t *testing.T) {
	f := newFakePM(t)
	m, vault := manager(t, f)
	setPMKey(t, vault)

	secretData := make([]byte, 32)
	if _, err := rand.Read(secretData); err != nil {
		t.Fatalf("rand: %v", err)
	}
	res := OracleResult{
		Verified:      true,
		ManifestB64:   base64.StdEncoding.EncodeToString(f.manifest),
		SecretID:      "oracle-secret",
		SecretDataB64: base64.StdEncoding.EncodeToString(secretData),
		SecretExpUnix: time.Now().Add(30 * time.Minute).Unix(),
	}
	st, err := m.Bootstrap(context.Background(), res)
	if err != nil {
		t.Fatalf("bootstrap: %v", err)
	}
	if !st.Pinned || !st.Verified {
		t.Fatalf("bootstrap status: %+v", st)
	}
	// The oracle's secret makes Client() succeed OFFLINE (no exchange).
	hits := f.secretHit
	c, err := m.Client(context.Background())
	if err != nil || c == nil {
		t.Fatalf("client with seeded secret: %v", err)
	}
	if f.secretHit != hits {
		t.Fatalf("exchange ran anyway (%d → %d) — the seeded secret must be used as-is", hits, f.secretHit)
	}
	// A bogus secret seed is ignored, never fatal.
	st, err = m.Bootstrap(context.Background(), OracleResult{Verified: true, SecretID: "x", SecretDataB64: "!!not-b64!!", SecretExpUnix: time.Now().Add(time.Hour).Unix()})
	if err != nil || !st.Verified {
		t.Fatalf("bootstrap with bogus seed must pin without the seed: %+v err=%v", st, err)
	}
	// Bootstrap without a key is the honest 400-path verdict.
	m2, vault2 := manager(t, f)
	if _, err := m2.Bootstrap(context.Background(), OracleResult{Verified: true}); !errors.Is(err, ErrNoKey) {
		t.Fatalf("bootstrap without key: %v", err)
	}
	_ = vault2
}

// ── drift: changed CA convicts; same CA passes the cause through ───

func TestDrift_ChangedCA_Convicts(t *testing.T) {
	f := newFakePM(t)
	m, vault := manager(t, f)
	setPMKey(t, vault)

	// Pin cert A via the oracle (no secret seed → the next Client() must
	// exchange, which fails offline → the drift check fires).
	if _, err := m.Bootstrap(context.Background(), OracleResult{Verified: true}); err != nil {
		t.Fatalf("bootstrap: %v", err)
	}
	f.swapCert(t) // the deployment rotated its mesh CA

	_, err := m.Client(context.Background())
	if !errors.Is(err, ErrPMDeploymentChanged) {
		t.Fatalf("stale pin must convict with ErrPMDeploymentChanged, got: %v", err)
	}
	// And the conviction is stable (the pin is NOT re-pinned by probing).
	if _, err := m.Client(context.Background()); !errors.Is(err, ErrPMDeploymentChanged) {
		t.Fatalf("second attempt after conviction: %v", err)
	}
}

func TestDrift_SameCA_PassesCauseThrough(t *testing.T) {
	f := newFakePM(t)
	m, vault := manager(t, f)
	setPMKey(t, vault)

	if _, err := m.Bootstrap(context.Background(), OracleResult{Verified: true}); err != nil {
		t.Fatalf("bootstrap: %v", err)
	}
	// Same cert still served: the exchange failure is TRANSIENT — the
	// original error surfaces, never the drift verdict.
	_, err := m.Client(context.Background())
	if err == nil {
		t.Fatalf("offline exchange cannot succeed")
	}
	if errors.Is(err, ErrPMDeploymentChanged) {
		t.Fatalf("same CA convicted as drift: %v", err)
	}
}

// ── reverify: the honest reset ─────────────────────────────────────

func TestReverifyClearsPin(t *testing.T) {
	f := newFakePM(t)
	m, vault := manager(t, f)
	setPMKey(t, vault)

	if _, err := m.Bootstrap(context.Background(), OracleResult{Verified: true}); err != nil {
		t.Fatalf("bootstrap: %v", err)
	}
	if err := m.Reverify(); err != nil {
		t.Fatalf("reverify: %v", err)
	}
	st := m.Status()
	if st.Pinned || st.Verified {
		t.Fatalf("reverify must clear the pin: %+v", st)
	}
	if _, ok, _ := vault.GetInternalState(VaultName); ok {
		t.Fatalf("pin blob survived reverify")
	}
	// Idempotent on the already-unpinned state.
	if err := m.Reverify(); err != nil {
		t.Fatalf("reverify twice: %v", err)
	}
}

// ── key rotation: the pin survives, the client rebuilds ────────────

func TestKeyRotation_RebuildsClient(t *testing.T) {
	f := newFakePM(t)
	m, vault := manager(t, f)
	setPMKey(t, vault)
	seed := OracleResult{Verified: true, SecretID: "s", SecretDataB64: base64.StdEncoding.EncodeToString(make([]byte, 32)), SecretExpUnix: time.Now().Add(30 * time.Minute).Unix()}
	if _, err := m.Bootstrap(context.Background(), seed); err != nil {
		t.Fatalf("bootstrap: %v", err)
	}
	if _, err := m.Client(context.Background()); err != nil {
		t.Fatalf("client with key1: %v", err)
	}
	// Rotate the API key: the old client must not be reused.
	setPMKey(t, vault)
	if m.clientKey == "" {
		t.Fatalf("no client key tracked")
	}
	// (The rebuilt client's exchange fails offline — expected; the pin
	// itself survives because it carries no key material.)
	if _, err := m.Client(context.Background()); err == nil {
		t.Fatalf("rotated key must rebuild + re-exchange (fails offline)")
	}
	if st := m.Status(); !st.Pinned || !st.Verified {
		t.Fatalf("pin must survive key rotation: %+v", st)
	}
}

// ── the vault-file guard: pins never appear in the plaintext scan ──

func TestPinEncryptedAtRest(t *testing.T) {
	f := newFakePM(t)
	dir := t.TempDir()
	vault, err := secrets.New(dir)
	if err != nil {
		t.Fatalf("vault: %v", err)
	}
	m := NewManager(vault)
	m.apiBase = f.srv.URL
	m.httpClient = f.srv.Client()
	setPMKey(t, vault)
	secretData := []byte("SUPERSECRET-PIN-MATERIAL-32-BYTES!!")
	if _, err := m.Bootstrap(context.Background(), OracleResult{
		Verified:      true,
		SecretID:      "secret-scan",
		SecretDataB64: base64.StdEncoding.EncodeToString(secretData),
		SecretExpUnix: time.Now().Add(time.Hour).Unix(),
	}); err != nil {
		t.Fatalf("bootstrap: %v", err)
	}
	raw, err := os.ReadFile(filepath.Join(dir, "secrets.json"))
	if err != nil {
		t.Fatalf("read keystore: %v", err)
	}
	if strings.Contains(string(raw), "SUPERSECRET-PIN-MATERIAL") {
		t.Fatalf("secret material landed on disk in the clear")
	}
	if !strings.Contains(string(raw), "__STATE__PM_PIN") {
		t.Fatalf("the pin entry vanished from the keystore — persistence broken")
	}
}

// TestManagerDialsViaNetx — v1.45.1 THE ANDROID WIRE: the manager's
// production client MUST dial through netx.DialContext (the engine's
// outbound law — the Android DNS fix). The vendored httputil.NewClient
// (Go's default dialer) left PM dead on Android while every netx-dialing
// provider worked — the user's live "network unreachable" report.
func TestManagerDialsViaNetx(t *testing.T) {
	vault, err := secrets.New(t.TempDir())
	if err != nil {
		t.Fatalf("vault: %v", err)
	}
	m := NewManager(vault)
	tr, ok := m.httpClient.Transport.(*http.Transport)
	if !ok {
		t.Fatalf("manager transport = %T — want *http.Transport (netx)", m.httpClient.Transport)
	}
	// netx.Transport() installs its own DialContext — the same function
	// pointer the engine's shared outbound transport uses.
	if tr.DialContext == nil || reflect.ValueOf(tr.DialContext).Pointer() != reflect.ValueOf(netx.DialContext).Pointer() {
		t.Fatalf("manager DialContext is not netx.DialContext — PM would die on Android (no /etc/resolv.conf)")
	}
	// v1.45.1: no 5s HTTP/2 health-check ping — the vendored transport's
	// ReadIdleTimeout killed mid-request connections on lossy mobile links;
	// the engine's own transports carry no health pings.
	if tr.HTTP2 != nil && tr.HTTP2.SendPingTimeout != 0 {
		t.Fatalf("HTTP2.SendPingTimeout = %v — want 0 (no health-check ping; the engine's transports ride without one)", tr.HTTP2.SendPingTimeout)
	}
}
