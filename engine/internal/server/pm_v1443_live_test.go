//go:build pmlive

// v1.44.3 THE WIRE — the LIVE phase gate (real key, real deployment;
// CI never runs this). The engine's OWN turn pipeline speaks PM natively:
//
//	PM_KEY=<key> go test -tags pmlive ./internal/server/ -run TestLivePMNativeTurn -v
//
// llm.Chat (provider privatemodeai) dispatches into runNativeToolsTurn →
// scanSSECollect → doPostSSE → the PM wire (this server's REAL adapter
// over the REAL pmstate manager: TOFU pin → pinned-CA exchange →
// OAE-encrypted request → decrypted SSE → the STANDARD chunk parser) —
// the same machinery every PM turn will ride after v1.44.4 flips the
// web layer. Asserts: content deltas stream, reasoning arrives as
// thinking events (the glm reasoner), usage is honest, the turn
// terminates idle, and the pin landed.
package server

import (
	"context"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/ScoobyBaby1999/doomalay/engine/internal/llm"
	"github.com/ScoobyBaby1999/doomalay/engine/internal/pmstate"
	"github.com/ScoobyBaby1999/doomalay/engine/internal/secrets"
)

func TestLivePMNativeTurn(t *testing.T) {
	key := os.Getenv("PM_KEY")
	if key == "" {
		t.Skip("PM_KEY not set — the live rig needs a real PrivateMode key")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()

	vault, err := secrets.New(t.TempDir())
	if err != nil {
		t.Fatalf("vault: %v", err)
	}
	if err := vault.Set(pmstate.KeyEnvVar, "privatemodeai", key, ""); err != nil {
		t.Fatalf("set key: %v", err)
	}
	s := &Server{vault: vault, pm: pmstate.NewManager(vault)}
	llm.SetPMTransport(pmTransportAdapter{s.pm})
	defer llm.SetPMTransport(nil)

	if st := s.pm.Status(); st.Pinned {
		t.Fatalf("fresh vault must start unpinned: %+v", st)
	}

	req := llm.ChatRequest{
		Provider:  "privatemodeai",
		Model:     "glm-5.3-flash",
		APIKey:    key,
		BaseURL:   "https://api.privatemode.ai",
		SessionID: "pm-wire-live-test",
		Effort:    "med",
		Messages: []llm.Message{
			{Role: "user", Content: "Reply with exactly: NATIVE WIRE OK"},
		},
	}
	ch, _ := llm.Chat(ctx, req)

	var content, thinking int
	joined := ""
	var sawUsage bool
	var sawErr bool
	for c := range ch {
		switch c.Type {
		case "assistant_delta":
			content++
			joined += c.Text
		case "thinking":
			thinking++
		case "status":
			if c.State == "idle" && c.Usage != nil {
				sawUsage = c.Usage.TotalTokens > 0
			}
			if c.State == "error" {
				sawErr = true
				t.Logf("terminal error state: %s", c.Message)
			}
		case "error":
			sawErr = true
			t.Logf("error chunk: %s", c.Message)
		}
	}
	if sawErr {
		t.Fatalf("the native PM turn errored")
	}
	if content < 1 {
		t.Fatalf("no content deltas streamed — the wire did not carry the turn")
	}
	if !strings.Contains(strings.ToUpper(joined), "NATIVE WIRE OK") {
		t.Fatalf("the reply missed the marker: %q", joined)
	}
	if !sawUsage {
		t.Fatalf("the turn must terminate with honest usage (the FSM verdict)")
	}
	t.Logf("native PM turn through llm.Chat: %d content deltas, %d thinking events, reply %.80q — the STANDARD pipeline carried the encrypted wire", content, thinking, joined)

	st := s.pm.Status()
	if !st.Pinned || st.SecretExpiresIn <= 0 {
		t.Fatalf("the turn must have pinned engine-side: %+v", st)
	}
	t.Logf("pin state after the turn: pinned=%v verified=%v secret_expires_in=%ds (TOFU here — the UI oracle upgrades it at the app's next connect)", st.Pinned, st.Verified, st.SecretExpiresIn)
}
