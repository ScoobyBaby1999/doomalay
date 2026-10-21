package server

// models_v1553_test.go — v1.55.3 THE LIVING CATALOG pins, the server half:
// /api/models ALWAYS answers the engine's own Go catalog (the brain proxy
// is dead — the brain's static model lists never reach the PWA again), and
// the hf provider — brain-only for its whole life — now rides the ENGINE
// catalog (its provider card + group render on every device).

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

// TestV1553_ModelsAlwaysGoCatalog — the brain never proxies /api/models:
// even with a brain configured on the server, the answer is the engine's
// own CatalogV2 shape (providers/groups/logical/syncStatus), and the hf
// card is present (the engine catalog's own provider now).
func TestV1553_ModelsAlwaysGoCatalog(t *testing.T) {
	s := newTermuxTestServer(t, "")
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/models", nil)
	s.handleModels(rec, req)
	if rec.Code != 200 {
		t.Fatalf("/api/models: %d", rec.Code)
	}
	var cat struct {
		Providers map[string]json.RawMessage `json:"providers"`
		Groups    []struct {
			Name string `json:"name"`
		} `json:"groups"`
		SyncStatus []struct {
			Provider string `json:"provider"`
		} `json:"syncStatus"`
		Logical  []json.RawMessage `json:"logical"`
		Partial  bool             `json:"partial"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &cat); err != nil {
		t.Fatalf("decode: %v", err)
	}
	// THE HF LAW: the provider card exists in the engine catalog
	if _, ok := cat.Providers["hf"]; !ok {
		t.Fatalf("hf must ride the ENGINE catalog (the brain-only gap is dead)")
	}
	// the full CatalogV2 shape rides (groups + logical + syncStatus)
	if len(cat.Groups) == 0 || len(cat.SyncStatus) == 0 {
		t.Fatalf("the Go catalog shape must answer: %d groups %d status", len(cat.Groups), len(cat.SyncStatus))
	}
	hasHF := false
	for _, g := range cat.Groups {
		if g.Name == "hf" {
			hasHF = true
		}
	}
	if !hasHF {
		t.Fatalf("the hf group must render in the provider view")
	}
}

// TestV1553_NoBrainModelsField — the brain-proxy era used to hand the
// brain's own (static) catalog through; the Go catalog never carries brain
// sections. This is the death certificate: nothing in the response is
// labeled brain data.
func TestV1553_NoBrainModelsField(t *testing.T) {
	s := newTermuxTestServer(t, "")
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/models", nil)
	s.handleModels(rec, req)
	if rec.Code != 200 {
		t.Fatalf("/api/models: %d", rec.Code)
	}
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(rec.Body.Bytes(), &raw); err != nil {
		t.Fatalf("decode: %v", err)
	}
	for k := range raw {
		if k == "brain" || k == "brain_models" {
			t.Fatalf("the brain proxy is dead — no brain section may ride /api/models (found %q)", k)
		}
	}
}
