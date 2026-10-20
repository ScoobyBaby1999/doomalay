package server

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/ScoobyBaby1999/doomalay/engine/internal/pmstate"
	"github.com/ScoobyBaby1999/doomalay/engine/internal/secrets"
)

// v1.44.2 THE PIN — the endpoint battery. The handlers are exercised
// directly (the full mux/Server construction is covered by the wider
// server suite); these pin the honest-surface contract:
//
//   - state: the fresh vault answers {key_present:false, pinned:false}
//   - bootstrap without a key → 400 (ErrNoKey), never a silent pin
//   - bootstrap with malformed JSON → 400
//   - reverify → {ok:true, pinned:false}, idempotent
//   - no vault → 500, honestly

func newPMServer(t *testing.T) (*Server, *secrets.Vault) {
	t.Helper()
	vault, err := secrets.New(t.TempDir())
	if err != nil {
		t.Fatalf("vault: %v", err)
	}
	return &Server{vault: vault, pm: pmstate.NewManager(vault)}, vault
}

func TestV1442_PMState_FreshVault(t *testing.T) {
	s, _ := newPMServer(t)
	rec := httptest.NewRecorder()
	s.handlePMState(rec, httptest.NewRequest(http.MethodGet, "/api/pm/state", nil))
	if rec.Code != 200 {
		t.Fatalf("status %d: %s", rec.Code, rec.Body.String())
	}
	var st pmstate.Status
	if err := json.Unmarshal(rec.Body.Bytes(), &st); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if st.KeyPresent || st.Pinned || st.Verified {
		t.Fatalf("fresh vault must be unpinned + keyless: %+v", st)
	}
}

func TestV1442_PMBootstrap_NoKeyIs400(t *testing.T) {
	s, _ := newPMServer(t)
	rec := httptest.NewRecorder()
	body := bytes.NewBufferString(`{"verified":true}`)
	s.handlePMBootstrap(rec, httptest.NewRequest(http.MethodPost, "/api/pm/bootstrap", body))
	if rec.Code != 400 {
		t.Fatalf("no-key bootstrap must 400, got %d: %s", rec.Code, rec.Body.String())
	}
	if !bytes.Contains(rec.Body.Bytes(), []byte("connect the provider")) {
		t.Fatalf("the no-key verdict must be the honest user-facing text: %s", rec.Body.String())
	}
}

func TestV1442_PMBootstrap_MalformedJSONIs400(t *testing.T) {
	s, _ := newPMServer(t)
	rec := httptest.NewRecorder()
	s.handlePMBootstrap(rec, httptest.NewRequest(http.MethodPost, "/api/pm/bootstrap", bytes.NewBufferString(`{nope`)))
	if rec.Code != 400 {
		t.Fatalf("malformed bootstrap must 400, got %d", rec.Code)
	}
}

func TestV1442_PMReverify_ClearsAndIdempotent(t *testing.T) {
	s, _ := newPMServer(t)
	rec := httptest.NewRecorder()
	s.handlePMReverify(rec, httptest.NewRequest(http.MethodPost, "/api/pm/reverify", nil))
	if rec.Code != 200 {
		t.Fatalf("reverify: %d %s", rec.Code, rec.Body.String())
	}
	var out struct {
		OK     bool `json:"ok"`
		Pinned bool `json:"pinned"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil || !out.OK || out.Pinned {
		t.Fatalf("reverify verdict: %+v err=%v", out, err)
	}
	// Idempotent second call.
	rec2 := httptest.NewRecorder()
	s.handlePMReverify(rec2, httptest.NewRequest(http.MethodPost, "/api/pm/reverify", nil))
	if rec2.Code != 200 {
		t.Fatalf("second reverify: %d", rec2.Code)
	}
}

func TestV1442_NoVaultIs500(t *testing.T) {
	s := &Server{} // vault nil, pm nil — the honest degraded surface
	for name, fn := range map[string]func(http.ResponseWriter, *http.Request){
		"state":     s.handlePMState,
		"bootstrap": s.handlePMBootstrap,
		"reverify":  s.handlePMReverify,
	} {
		rec := httptest.NewRecorder()
		fn(rec, httptest.NewRequest(http.MethodGet, "/api/pm/"+name, nil))
		if rec.Code != 500 {
			t.Fatalf("%s without vault must 500, got %d", name, rec.Code)
		}
	}
}
