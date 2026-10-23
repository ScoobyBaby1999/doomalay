package server

// usage_v1462_test.go — v1.46.2 THE REASONING LEDGER pins. The engine now
// parses the provider's completion_tokens_details.reasoning_tokens (live-
// convicted on PM's vllm-0.31 gateway: 53 of 56 completion tokens were
// reasoning for a one-word answer) and carries it through the live usage
// event → the persisted status usage → both aggregation endpoints. These
// pins hold: (a) the per-session endpoint sums the reasoning share per
// model + chat total, (b) the fleet endpoint sums per provider + model +
// grand, (c) old events WITHOUT the field parse to 0 (never invented).

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/ScoobyBaby1999/doomalay/engine/internal/store"
)

func newUsageTestServerV1462(t *testing.T) *Server {
	t.Helper()
	dir := t.TempDir()
	db, err := store.Open(dir)
	if err != nil {
		t.Fatalf("store: %v", err)
	}
	if err := db.Migrate(); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	return &Server{db: db}
}

// seedStatusUsage appends one status event carrying the v1.46.2 usage shape.
func seedStatusUsageV1462(t *testing.T, s *Server, sid string, in, out, total int, reasoning int64, oldShape bool) {
	t.Helper()
	if _, err := s.db.AppendEvent(sid, "user", "q", ""); err != nil {
		t.Fatalf("seed user: %v", err)
	}
	st := fmt.Sprintf(`{"state":"idle","usage":{"input_tokens":%d,"output_tokens":%d,"total_tokens":%d`, in, out, total)
	if !oldShape {
		st += fmt.Sprintf(`,"reasoning_tokens":%d`, reasoning)
	}
	st += `,"finish_reason":"stop","output_cut":false}}`
	if _, err := s.db.AppendEvent(sid, "status", st, ""); err != nil {
		t.Fatalf("seed status: %v", err)
	}
}

// TestV1462_SessionUsageReasoningLedger — the per-session endpoint sums the
// reasoning share into per-model rows + the chat total; old-shape events
// (pre-v1.46.2 sessions) report 0.
func TestV1462_SessionUsageReasoningLedger(t *testing.T) {
	s := newUsageTestServerV1462(t)
	sid := "sess-v1462"
	if err := s.db.CreateSession(&store.Session{ID: sid, Provider: "privatemodeai", Model: "glm-5.3"}); err != nil {
		t.Fatalf("create session: %v", err)
	}
	// Two PM turns: 53 + 40 reasoning tokens; one OLD-shape turn (0).
	seedStatusUsageV1462(t, s, sid, 24, 56, 80, 53, false)
	seedStatusUsageV1462(t, s, sid, 30, 50, 80, 40, false)
	seedStatusUsageV1462(t, s, sid, 10, 10, 20, 0, true) // pre-v1.46.2 event

	req := httptest.NewRequest(http.MethodGet, "/api/sessions/"+sid+"/usage", nil)
	req.SetPathValue("id", sid)
	rec := httptest.NewRecorder()
	s.handleSessionUsage(rec, req)
	if rec.Code != 200 {
		t.Fatalf("status: %d body: %s", rec.Code, rec.Body.String())
	}
	var resp struct {
		Totals struct {
			TokensIn        int64 `json:"tokensIn"`
			TokensOut       int64 `json:"tokensOut"`
			ReasoningTokens int64 `json:"reasoningTokens"`
		} `json:"totals"`
		Models []struct {
			Model           string `json:"model"`
			ReasoningTokens int64  `json:"reasoningTokens"`
		} `json:"models"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if resp.Totals.ReasoningTokens != 93 {
		t.Errorf("chat total reasoning = %d, want 93 (53+40; the old-shape event contributes 0)", resp.Totals.ReasoningTokens)
	}
	if len(resp.Models) != 1 || resp.Models[0].Model != "glm-5.3" || resp.Models[0].ReasoningTokens != 93 {
		t.Errorf("per-model rows: %+v — glm-5.3 must carry reasoningTokens=93", resp.Models)
	}
	if resp.Totals.TokensOut != 116 || resp.Totals.TokensIn != 64 {
		t.Errorf("in/out sums regressed: in=%d out=%d", resp.Totals.TokensIn, resp.Totals.TokensOut)
	}
}

// TestV1462_FleetUsageReasoningLedger — the global endpoint sums per
// provider + per model + the grand total.
func TestV1462_FleetUsageReasoningLedger(t *testing.T) {
	s := newUsageTestServerV1462(t)
	if err := s.db.CreateSession(&store.Session{ID: "s1", Provider: "privatemodeai", Model: "glm-5.3"}); err != nil {
		t.Fatalf("create s1: %v", err)
	}
	if err := s.db.CreateSession(&store.Session{ID: "s2", Provider: "privatemodeai", Model: "gpt-oss-120b"}); err != nil {
		t.Fatalf("create s2: %v", err)
	}
	seedStatusUsageV1462(t, s, "s1", 24, 56, 80, 53, false)
	seedStatusUsageV1462(t, s, "s2", 79, 30, 109, 28, false)

	req := httptest.NewRequest(http.MethodGet, "/api/usage", nil)
	rec := httptest.NewRecorder()
	s.handleUsageGlobal(rec, req)
	if rec.Code != 200 {
		t.Fatalf("status: %d body: %s", rec.Code, rec.Body.String())
	}
	var resp struct {
		Totals struct {
			ReasoningTokens int64 `json:"reasoningTokens"`
		} `json:"totals"`
		Providers map[string]struct {
			ReasoningTokens int64 `json:"reasoningTokens"`
		} `json:"providers"`
		Models map[string]struct {
			ReasoningTokens int64 `json:"reasoningTokens"`
		} `json:"models"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if resp.Totals.ReasoningTokens != 81 {
		t.Errorf("grand reasoning = %d, want 81 (53+28)", resp.Totals.ReasoningTokens)
	}
	if p, ok := resp.Providers["privatemodeai"]; !ok || p.ReasoningTokens != 81 {
		t.Errorf("provider row: %+v — privatemodeai must carry 81", resp.Providers)
	}
	if m, ok := resp.Models["glm-5.3"]; !ok || m.ReasoningTokens != 53 {
		t.Errorf("model row glm-5.3: %+v — must carry 53", resp.Models)
	}
	if !strings.Contains(rec.Body.String(), "reasoningTokens") {
		t.Errorf("the fleet response must surface reasoningTokens")
	}
}
