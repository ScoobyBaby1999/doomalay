//go:build pmlive

// v1.44.1 THE VENDOR — the live protocol parity rig (PROVENANCE.md's
// spike, permanent). CI never runs this (it needs a real key); the
// phase battery and any red-team pass runs:
//
//	PM_KEY=<key> go test -tags pmlive ./internal/pm/ -run TestLive -v
//
// It reproduces the 2026-10-19 spike that proved the whole chain with
// zero WASM: TOFU attest pin → ML-KEM-768+X25519 HPKE exchange →
// AES-GCM(OAE) encrypted chat → decrypted SSE stream.
package pm_test

import (
	"context"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/ScoobyBaby1999/doomalay/engine/internal/pm/auth"
	"github.com/ScoobyBaby1999/doomalay/engine/internal/pm/privatemode"
)

func TestLiveFullTurn(t *testing.T) {
	key := os.Getenv("PM_KEY")
	if key == "" {
		t.Skip("PM_KEY not set — the live rig needs a real PrivateMode key")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()

	c := privatemode.New(auth.APIKey(key)).WithAPIBaseURL("https://api.privatemode.ai")

	if err := c.Initialize(ctx, nil); err != nil {
		t.Fatalf("Initialize (TOFU attest → mesh CA): %v", err)
	}
	if err := c.UpdateSecret(ctx); err != nil {
		t.Fatalf("UpdateSecret (ML-KEM HPKE exchange): %v", err)
	}
	s, err := c.ExportSecret()
	if err != nil {
		t.Fatalf("ExportSecret: %v", err)
	}
	if len(s.Data) != 32 || !time.Now().Before(s.ExpirationDate) {
		t.Fatalf("secret shape: %d bytes, exp %v", len(s.Data), s.ExpirationDate)
	}
	t.Logf("secret ok: id=%s… 32 bytes, expires %s", s.ID[:12], s.ExpirationDate.Format(time.Kitchen))

	models, err := c.ListModels(ctx)
	if err != nil {
		t.Fatalf("ListModels: %v", err)
	}
	if !strings.Contains(string(models), `"id"`) {
		t.Fatalf("models listing unexpected: %.120s", models)
	}

	stream, err := c.StreamChatCompletions(ctx, []byte(
		`{"model":"glm-5.3","stream":true,"messages":[{"role":"user","content":"Reply with exactly: NATIVE PM OK"}]}`))
	if err != nil {
		t.Fatalf("StreamChatCompletions: %v", err)
	}
	defer stream.Close()
	chunks, joined := 0, ""
	for {
		chunk, err := stream.Next()
		if err != nil {
			break
		}
		chunks++
		joined += string(chunk)
	}
	if chunks < 3 {
		t.Fatalf("expected a real streamed reply, got %d chunks", chunks)
	}
	if !strings.Contains(joined, `"model"`) {
		t.Fatalf("stream payload unexpected: %.160s", joined)
	}
	t.Logf("streamed %d decrypted chunks — full native PM turn from pure Go", chunks)
}
