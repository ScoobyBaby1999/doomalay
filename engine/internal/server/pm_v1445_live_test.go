//go:build pmlive

// v1.44.5 THE BRAIN — the LIVE phase gate (real key, real deployment;
// CI never runs this):
//
//	PM_KEY=<key> go test -tags pmlive ./internal/server/ -run TestLivePMLocalBridge -v
//
// The brain's new PM path end-to-end: POST the plain OpenAI wire to the
// engine's local bridge with the vault's key → the pinned client
// encrypts upstream → the decrypted SSE streams back reframed → the
// brain's litellm consumes exactly this shape.
package server

import (
	"bufio"
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/ScoobyBaby1999/doomalay/engine/internal/pmstate"
	"github.com/ScoobyBaby1999/doomalay/engine/internal/secrets"
)

func TestLivePMLocalBridge(t *testing.T) {
	key := os.Getenv("PM_KEY")
	if key == "" {
		t.Skip("PM_KEY not set — the live rig needs a real PrivateMode key")
	}
	vault, err := secrets.New(t.TempDir())
	if err != nil {
		t.Fatalf("vault: %v", err)
	}
	if err := vault.Set(pmstate.KeyEnvVar, "privatemodeai", key, ""); err != nil {
		t.Fatalf("set key: %v", err)
	}
	s := &Server{vault: vault, pm: pmstate.NewManager(vault)}

	// 1. The wrong key refuses at the gate (api-key-fallback=never).
	gate := httptest.NewRequest(http.MethodPost, "/api/pm/local/v1/chat/completions",
		bytes.NewBufferString(`{"model":"glm-5.3-flash","messages":[{"role":"user","content":"x"}]}`))
	gate.Header.Set("Authorization", "Bearer not-the-key")
	rec := httptest.NewRecorder()
	s.handlePMLocalChat(rec, gate)
	if rec.Code != 401 {
		t.Fatalf("wrong key must 401, got %d", rec.Code)
	}

	// 2. A streamed turn through the bridge: SSE frames + [DONE].
	body := `{"model":"glm-5.3-flash","stream":true,"messages":[{"role":"user","content":"Reply with exactly: BRIDGE OK"}],"max_tokens":512}`
	req := httptest.NewRequest(http.MethodPost, "/api/pm/local/v1/chat/completions", bytes.NewBufferString(body))
	req.Header.Set("Authorization", "Bearer "+key)
	rec = httptest.NewRecorder()
	s.handlePMLocalChat(rec, req)
	if rec.Code != 200 {
		t.Fatalf("bridge turn: %d %s", rec.Code, rec.Body.String())
	}
	if ct := rec.Header().Get("Content-Type"); !strings.Contains(ct, "text/event-stream") {
		t.Fatalf("stream content type: %q", ct)
	}
	sc := bufio.NewScanner(rec.Body)
	sc.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	frames, done, joined := 0, false, ""
	for sc.Scan() {
		line := sc.Text()
		if !strings.HasPrefix(line, "data: ") {
			continue
		}
		frames++
		payload := strings.TrimPrefix(line, "data: ")
		if payload == "[DONE]" {
			done = true
			break
		}
		var chunk struct {
			Choices []struct {
				Delta struct {
					Content string `json:"content"`
				} `json:"delta"`
			} `json:"choices"`
		}
		if json.Unmarshal([]byte(payload), &chunk) == nil && len(chunk.Choices) > 0 {
			joined += chunk.Choices[0].Delta.Content
		}
	}
	if frames < 3 || !done {
		t.Fatalf("expected a real SSE stream ending in [DONE]: %d frames, done=%v", frames, done)
	}
	if !strings.Contains(strings.ToUpper(joined), "BRIDGE OK") {
		t.Fatalf("the streamed reply missed the marker: %q", joined)
	}
	t.Logf("local bridge turn: %d SSE frames + [DONE], reply %.40q — the brain's wire, end-to-end", frames, joined)

	// 3. A non-streamed turn answers the plain OpenAI JSON.
	body2 := `{"model":"glm-5.3-flash","stream":false,"messages":[{"role":"user","content":"Reply with exactly: SYNC BRIDGE OK"}],"max_tokens":512}`
	req2 := httptest.NewRequest(http.MethodPost, "/api/pm/local/v1/chat/completions", bytes.NewBufferString(body2))
	req2.Header.Set("Authorization", "Bearer "+key)
	rec2 := httptest.NewRecorder()
	s.handlePMLocalChat(rec2, req2)
	if rec2.Code != 200 {
		t.Fatalf("sync turn: %d %s", rec2.Code, rec2.Body.String())
	}
	var sync struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
	}
	if err := json.Unmarshal(rec2.Body.Bytes(), &sync); err != nil || len(sync.Choices) == 0 {
		t.Fatalf("sync shape: %v %s", err, rec2.Body.String())
	}
	if !strings.Contains(strings.ToUpper(sync.Choices[0].Message.Content), "SYNC BRIDGE OK") {
		t.Fatalf("sync reply: %q", sync.Choices[0].Message.Content)
	}
	t.Logf("local bridge sync turn: %.40q", sync.Choices[0].Message.Content)

	_ = io.Discard // keep io imported for future rig extensions
	_ = time.Now
}
