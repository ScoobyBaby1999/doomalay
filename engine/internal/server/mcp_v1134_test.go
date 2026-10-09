package server

// mcp_v1134_test.go — v1.13.4 THE CHAIN: the /mcp endpoint serves
// EXTERNAL consumers (stateless streamable HTTP — the same JSON-RPC
// tools/list + tools/call the engine itself speaks), and session-scoped
// tools honestly refuse without a session turn.

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/ScoobyBaby1999/doomalay/engine/internal/config"
	"github.com/ScoobyBaby1999/doomalay/engine/internal/store"
)

func newMCPTestServer(t *testing.T) *Server {
	t.Helper()
	dir := t.TempDir()
	db, err := store.Open(dir)
	if err != nil {
		t.Fatalf("store: %v", err)
	}
	if err := db.Migrate(); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	cfg := &config.Config{DataDir: dir}
	return New(cfg, db, nil)
}

func mcpPost(t *testing.T, s *Server, body map[string]any) (int, map[string]any) {
	t.Helper()
	raw, _ := json.Marshal(body)
	req := httptest.NewRequest(http.MethodPost, "/mcp", bytes.NewReader(raw))
	req.Header.Set("Content-Type", "application/json")
	req.Host = "127.0.0.1" // the DNS-rebinding guard wants a local Host
	rec := httptest.NewRecorder()
	s.mux.ServeHTTP(rec, req)
	var out map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	return rec.Code, out
}

func TestV1134_MCPExternpointListsTools(t *testing.T) {
	s := newMCPTestServer(t)

	// tools/list over stateless streamable HTTP
	code, out := mcpPost(t, s, map[string]any{
		"jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": map[string]any{},
	})
	if code != 200 {
		t.Fatalf("tools/list status %d: %v", code, out)
	}
	// JSON-RPC result shape: either {result:{tools:[…]}} or {error:…}
	if e, ok := out["error"].(map[string]any); ok {
		t.Fatalf("tools/list error: %v", e)
	}
	res, _ := out["result"].(map[string]any)
	if res == nil {
		t.Fatalf("tools/list missing result: %v", out)
	}
	tools, _ := res["tools"].([]any)
	if len(tools) != 29 {
		t.Fatalf("want the 29-tool registry served externally (28 + the v1.20.3 termux hand), got %d", len(tools))
	}
}

func TestV1134_MCPEndpointCallsTool(t *testing.T) {
	s := newMCPTestServer(t)

	// a local tool executes for an external caller (no session needed)
	code, out := mcpPost(t, s, map[string]any{
		"jsonrpc": "2.0", "id": 2, "method": "tools/call",
		"params": map[string]any{"name": "calculator", "arguments": map[string]any{"expr": "6*7"}},
	})
	if code != 200 {
		t.Fatalf("tools/call status %d: %v", code, out)
	}
	res, _ := out["result"].(map[string]any)
	if res == nil {
		t.Fatalf("tools/call missing result: %v", out)
	}
	var text string
	for _, c := range res["content"].([]any) {
		if tc, ok := c.(map[string]any); ok {
			text += tc["text"].(string)
		}
	}
	if text != "42" {
		t.Fatalf("calculator through /mcp should say 42, got %q", text)
	}
}

func TestV1134_MCPEndpointSessionToolsRefuseHonestly(t *testing.T) {
	s := newMCPTestServer(t)

	// a session-scoped tool (workspace) refuses honestly for an
	// external caller with no session turn — never a panic, never a 500
	code, out := mcpPost(t, s, map[string]any{
		"jsonrpc": "2.0", "id": 3, "method": "tools/call",
		"params": map[string]any{"name": "workspace", "arguments": map[string]any{"action": "list"}},
	})
	if code != 200 {
		t.Fatalf("tools/call status %d: %v", code, out)
	}
	res, _ := out["result"].(map[string]any)
	if res == nil {
		t.Fatalf("missing result: %v", out)
	}
	var text string
	for _, c := range res["content"].([]any) {
		if tc, ok := c.(map[string]any); ok {
			text += tc["text"].(string)
		}
	}
	if res["isError"] != true || text == "" {
		t.Fatalf("session-scoped tool must refuse with an honest tool error, got %q (isError=%v)", text, res["isError"])
	}
}

func TestV1135_MCPSessionHeaderArmsSessionTools(t *testing.T) {
	s := newMCPTestServer(t)
	// create a session via the API, then call a session tool with the header
	req := httptest.NewRequest(http.MethodPost, "/api/sessions", strings.NewReader(
		`{"title":"mcp","model":"m","provider":"p"}`))
	rec := httptest.NewRecorder()
	s.mux.ServeHTTP(rec, req)
	if rec.Code != 201 && rec.Code != 200 {
		t.Fatalf("create session: %d %s", rec.Code, rec.Body.String())
	}
	var sess map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &sess)
	sid, _ := sess["ID"].(string)
	if sid == "" {
		t.Fatalf("no session id: %v", sess)
	}

	raw, _ := json.Marshal(map[string]any{
		"jsonrpc": "2.0", "id": 4, "method": "tools/call",
		"params": map[string]any{"name": "skills", "arguments": map[string]any{"action": "list"}},
	})
	hreq := httptest.NewRequest(http.MethodPost, "/mcp", bytes.NewReader(raw))
	hreq.Header.Set("Content-Type", "application/json")
	hreq.Header.Set("X-Doomalay-Session", sid)
	hreq.Host = "127.0.0.1"
	hrec := httptest.NewRecorder()
	s.mux.ServeHTTP(hrec, hreq)
	if hrec.Code != 200 {
		t.Fatalf("session tools/call status %d: %s", hrec.Code, hrec.Body.String())
	}
	var out map[string]any
	_ = json.Unmarshal(hrec.Body.Bytes(), &out)
	res, _ := out["result"].(map[string]any)
	if res == nil {
		t.Fatalf("missing result: %v", out)
	}
	var text string
	for _, c := range res["content"].([]any) {
		if tc, ok := c.(map[string]any); ok {
			text += tc["text"].(string)
		}
	}
	// the session turn ran the REAL skills runner (no skills installed →
	// the honest empty-library observation, NOT the "not armed" refusal)
	if res["isError"] == true || strings.Contains(text, "not armed") {
		t.Fatalf("session-bound call should RUN the tool, got %q", text)
	}
	if text == "" {
		t.Fatalf("expected a real observation, got empty")
	}
}
