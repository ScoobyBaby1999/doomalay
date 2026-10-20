//go:build pmlive

// v1.44.2 THE PIN — the LIVE phase gate (real key, real deployment;
// CI never runs this). Reproduces the full pin lifecycle that ships:
//
//	PM_KEY=<key> go test -tags pmlive ./internal/pm/ -run TestLivePin -v
//
//	TOFU first contact (headless) → pin lands unverified → a real
//	exchange + a real streamed turn → the ORACLE upgrade (verified=true
//	+ the exported secret seeds the pin) → Client() serves the turn
//	from the imported secret with NO re-exchange → reverify clears.
package pm_test

import (
	"context"
	"encoding/base64"
	"os"
	"testing"
	"time"

	"github.com/ScoobyBaby1999/doomalay/engine/internal/pm/privatemode"
	"github.com/ScoobyBaby1999/doomalay/engine/internal/pmstate"
	"github.com/ScoobyBaby1999/doomalay/engine/internal/secrets"
)

func TestLivePinLifecycle(t *testing.T) {
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
	m := pmstate.NewManager(vault)

	// 1. Fresh state: unpinned.
	if st := m.Status(); st.Pinned || !st.KeyPresent {
		t.Fatalf("fresh status: %+v", st)
	}

	// 2. TOFU first contact, headless: the pin lands (unverified) and a
	// real exchange rides the pinned CA; a real turn streams.
	c, err := m.Client(ctx)
	if err != nil {
		t.Fatalf("TOFU client: %v", err)
	}
	st := m.Status()
	if !st.Pinned || st.Verified {
		t.Fatalf("TOFU pin must be pinned+unverified: %+v", st)
	}
	if st.SecretExpiresIn <= 0 {
		t.Fatalf("the exchanged secret must be cached: %+v", st)
	}
	sec, err := c.ExportSecret()
	if err != nil || len(sec.Data) != 32 {
		t.Fatalf("secret after TOFU: %v (len=%d)", err, len(sec.Data))
	}
	turn := func(c *privatemode.Client) int {
		stream, err := c.StreamChatCompletions(ctx, []byte(
			`{"model":"glm-5.3-flash","stream":true,"messages":[{"role":"user","content":"Reply with exactly: PIN OK"}],"max_tokens":512}`))
		if err != nil {
			t.Fatalf("stream: %v", err)
		}
		defer stream.Close()
		chunks := 0
		for {
			if _, err := stream.Next(); err != nil {
				break
			}
			chunks++
		}
		if chunks < 3 {
			t.Fatalf("expected a real streamed reply, got %d chunks", chunks)
		}
		return chunks
	}
	t.Logf("TOFU turn: %d decrypted chunks (pinned CA, unverified pin)", turn(c))

	// 3. The ORACLE upgrade with a BOGUS secret seed first — a bad seed
	// is ignored, never fatal; the pin lands verified either way.
	if st, err := m.Bootstrap(ctx, pmstate.OracleResult{Verified: true, SecretID: "bogus", SecretDataB64: "!!not-b64!!"}); err != nil || !st.Verified {
		t.Fatalf("bootstrap with bogus seed: %+v err=%v", st, err)
	}

	// 4. The honest oracle report: verified=true + the exported secret.
	st, err = m.Bootstrap(ctx, pmstate.OracleResult{
		Verified:      true,
		SecretID:      sec.ID,
		SecretDataB64: base64.StdEncoding.EncodeToString(sec.Data),
		SecretExpUnix: sec.ExpirationDate.Unix(),
	})
	if err != nil {
		t.Fatalf("oracle bootstrap: %v", err)
	}
	if !st.Pinned || !st.Verified {
		t.Fatalf("oracle-upgraded status: %+v", st)
	}

	// 5. The upgraded client serves the turn from the IMPORTED secret —
	// no re-exchange (the secret ID must be the oracle's, not a fresh
	// one), and the turn still streams.
	c2, err := m.Client(ctx)
	if err != nil {
		t.Fatalf("client after oracle upgrade: %v", err)
	}
	sec2, err := c2.ExportSecret()
	if err != nil {
		t.Fatalf("export after upgrade: %v", err)
	}
	if sec2.ID != sec.ID {
		t.Fatalf("the imported (oracle) secret must be served as-is: got %s want %s", sec2.ID, sec.ID)
	}
	t.Logf("oracle-upgraded turn: %d decrypted chunks (imported secret %s…, no re-exchange)", turn(c2), sec.ID[:8])

	// 6. Reverify clears the pin (the honest reset).
	if err := m.Reverify(); err != nil {
		t.Fatalf("reverify: %v", err)
	}
	if st := m.Status(); st.Pinned || st.Verified {
		t.Fatalf("reverify must clear the pin: %+v", st)
	}
}
