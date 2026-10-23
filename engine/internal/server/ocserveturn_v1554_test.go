package server

// ocserveturn_v1554_test.go — v1.55.4 THE LIVE EFFORT pins, the serve side:
// THE VARIANT LAW — the chat's effort knob reaches the 2.x serve through
// the model's OWN variant ladder (fetched LIVE from the healthy serve's
// /api/model catalogue — never a static table): a matching variant rides
// SelectModel as the "#variant" suffix (the docs' own grammar); no match
// or no effort → the base model.

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/ScoobyBaby1999/doomalay/engine/internal/ocserve"
	"github.com/ScoobyBaby1999/doomalay/engine/internal/store"
)

// newFakeServeServer mounts the fake serve (the shared harness pattern).
func newFakeServeServer(fake *fakeServe) *httptest.Server {
	return httptest.NewServer(http.HandlerFunc(fake.handler))
}

const v1554ServeCatalog = `{"data":[
 {"id":"minimax-m3.1-flash-free","modelID":"minimax-m3.1-flash-free","providerID":"opencode","status":"active",
  "limit":{"context":200000,"input":160000,"output":32000},
  "cost":[{"input":0,"output":0,"cache":{"read":0,"write":0}}],
  "variants":[{"id":"low","settings":{"reasoningEffort":"low"}},{"id":"medium","settings":{"reasoningEffort":"medium"}},{"id":"high","settings":{"reasoningEffort":"high"}},{"id":"xhigh","settings":{"reasoningEffort":"xhigh"}},{"id":"max","settings":{"reasoningEffort":"max"}}]},
 {"id":"big-pickle","modelID":"big-pickle","providerID":"opencode","status":"active",
  "limit":{"context":200000,"output":32000},"cost":[{"input":0,"output":0}],"variants":[]},
 {"id":"gone-model","modelID":"gone-model","providerID":"opencode","status":"deprecated","cost":[{"input":0,"output":0}]}
]}`

// TestV1554VariantLaw — the effort knob → the serve's OWN variant suffix.
func TestV1554VariantLaw(t *testing.T) {
	t.Setenv("DOOMALAY_OPENCODE_SERVE_PASSWORD", "rig-pw")
	fake := &fakeServe{sse: cleanTurnFrames("ses_v1554"), modelCatalog: v1554ServeCatalog}
	srv := newFakeServeServer(fake)
	defer srv.Close()
	m := ocserve.New("", "key", nil)
	m.SetBaseURL(srv.URL)

	// the catalogue speaks through LiveCatalog: deprecated dropped, limits live
	cat := m.LiveCatalog()
	if len(cat) != 2 {
		t.Fatalf("LiveCatalog must drop the deprecated model: %d", len(cat))
	}
	if cat[0].ModelID != "minimax-m3.1-flash-free" || len(cat[0].Variants) != 5 {
		t.Fatalf("the variants must ride: %+v", cat[0])
	}

	s := &Server{}
	s.ocServeSessions = map[string]string{"chat1": "ses_v1554"}

	// the drain (the pump emits onto the channel; the turn owns no reader)
	events := make(chan map[string]any, 64)
	go func() {
		for range events {
		}
	}()

	// (1) an effort WITH a matching variant → the #suffix rides SelectModel
	sess := &store.Session{ID: "chat1", Model: "opencode/minimax-m3.1-flash-free", Effort: "xhigh"}
	if err := s.ocServeStreamTurn(context.Background(), m, "chat1", sess, "hi", events); err != nil {
		t.Fatalf("turn: %v", err)
	}
	fake.mu.Lock()
	bodies := append([]map[string]any(nil), fake.modelBodies...)
	fake.modelBodies = nil
	fake.mu.Unlock()
	if len(bodies) != 1 {
		t.Fatalf("expected one SelectModel call, got %d", len(bodies))
	}
	model := bodies[0]["model"].(map[string]any)
	if model["id"] != "minimax-m3.1-flash-free#xhigh" || model["providerID"] != "opencode" {
		t.Fatalf("THE VARIANT LAW: the matching variant must ride as the #suffix, got %v", model)
	}

	// (2) no effort → the bare model id
	sess = &store.Session{ID: "chat1", Model: "opencode/minimax-m3.1-flash-free", Effort: ""}
	if err := s.ocServeStreamTurn(context.Background(), m, "chat1", sess, "hi", events); err != nil {
		t.Fatalf("turn2: %v", err)
	}
	fake.mu.Lock()
	bodies = append([]map[string]any(nil), fake.modelBodies...)
	fake.modelBodies = nil
	fake.mu.Unlock()
	if len(bodies) != 1 || bodies[0]["model"].(map[string]any)["id"] != "minimax-m3.1-flash-free" {
		t.Fatalf("no effort → the bare id, got %v", bodies)
	}

	// (3) an effort with NO matching variant (a variant-less model) → the base model
	sess = &store.Session{ID: "chat1", Model: "opencode/big-pickle", Effort: "high"}
	if err := s.ocServeStreamTurn(context.Background(), m, "chat1", sess, "hi", events); err != nil {
		t.Fatalf("turn3: %v", err)
	}
	fake.mu.Lock()
	bodies = append([]map[string]any(nil), fake.modelBodies...)
	fake.modelBodies = nil // reset for the med/off sentinel turns
	fake.mu.Unlock()
	if len(bodies) != 1 || bodies[0]["model"].(map[string]any)["id"] != "big-pickle" {
		t.Fatalf("no matching variant → the base model, got %v", bodies)
	}

	// (4) the 'med' + 'off' sentinels send nothing (the default ladder)
	for _, eff := range []string{"med", "off"} {
		sess = &store.Session{ID: "chat1", Model: "opencode/minimax-m3.1-flash-free", Effort: eff}
		if err := s.ocServeStreamTurn(context.Background(), m, "chat1", sess, "hi", events); err != nil {
			t.Fatalf("turn4(%s): %v", eff, err)
		}
	}
	fake.mu.Lock()
	bodies = append([]map[string]any(nil), fake.modelBodies...)
	fake.mu.Unlock()
	for _, b := range bodies {
		if id := b["model"].(map[string]any)["id"].(string); id != "minimax-m3.1-flash-free" {
			t.Fatalf("the %q sentinel must not pick a variant, got %q", "med/off", id)
		}
	}
}
