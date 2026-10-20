package llm

// chat_v1452_test.go — v1.45.2 THE HONEST NET (PLAN-V145 §2): the two
// outage SHAPES get opposite honesty.
//
//   · PROVIDER-SCOPED (another provider succeeded recently — positive
//     evidence the network path works): the texts NEVER blame "the
//     network" (the user's live report: PM dead on their device while
//     Nvidia/OpenRouter streamed, and the pill kept saying "network
//     unreachable"), and the hold is BOUNDED — after
//     DOOMALAY_PROVIDER_HOLD_MS the turn ends with the honest
//     provider-down verdict and the session lock releases.
//   · DEVICE-OFFLINE (no such evidence): byte-for-byte the v1.39.3
//     patient engine — infinite suspension, wake channel, "network"
//     texts (pinned by the v1400 battery, untouched).
//
// Plus the counter fix: the hiccup status tells the real quick-rung total
// (the old text hardcoded "/2" and the compressed rig exposed "retry 5/2"
// live).

import (
	"context"
	"strings"
	"sync"
	"testing"
	"time"
)

// withHealthWindow swaps the provider-health window + the bounded hold
// total for a test (hermetic: resets the health table on both ends).
func withHealthWindow(t *testing.T, window, hold time.Duration) {
	t.Helper()
	oldW, oldH := providerHealthWindow, netProviderHoldTotal
	providerHealthWindow, netProviderHoldTotal = window, hold
	resetProviderHealth()
	t.Cleanup(func() {
		providerHealthWindow, netProviderHoldTotal = oldW, oldH
		resetProviderHealth()
	})
}

// collectV1452 gathers every chunk after the test closes ch. range (not
// select/default): a select on a CLOSED channel receives zero values
// instantly forever — the first draft's drain OOM-killed the test binary.
func collectV1452(ch chan ChatChunk) []ChatChunk {
	var out []ChatChunk
	for c := range ch {
		out = append(out, c)
	}
	return out
}

func TestV1452_AnyOtherProviderHealthy(t *testing.T) {
	withHealthWindow(t, time.Hour, time.Minute)
	if anyOtherProviderHealthy("nvidia") {
		t.Fatal("a fresh engine has no success evidence — the safe default must be the patient engine")
	}
	RecordProviderSuccess("nvidia")
	if anyOtherProviderHealthy("nvidia") {
		t.Fatal("the provider's OWN success is not evidence for ITSELF (the mode asks about OTHER providers)")
	}
	if !anyOtherProviderHealthy("privatemodeai") {
		t.Fatal("Nvidia just succeeded — PM failing is provider-scoped, not a network outage")
	}
	// a 429 cooldown on the healthy provider says nothing about the network
	// (rate limit ≠ reachability) — the recent success stands as evidence.
	RecordProviderFailure("nvidia", "429", "rate limited")
	if !anyOtherProviderHealthy("privatemodeai") {
		t.Fatal("a 429 cooldown must NOT erase the network evidence — rate limit is not reachability")
	}
	// a STALE success (outside the window) is no evidence at all.
	withHealthWindow(t, time.Nanosecond, time.Minute)
	if anyOtherProviderHealthy("privatemodeai") {
		t.Fatal("a success older than the health window is not evidence")
	}
}

func TestV1452_SuccessSurvivesActiveCooldown(t *testing.T) {
	withHealthWindow(t, time.Hour, time.Minute)
	RecordProviderFailure("nvidia", "429", "rate limited") // active ~24s cooldown
	RecordProviderSuccess("nvidia")                        // a success must NOT erase it…
	if r := ProviderCooldownRemaining("nvidia"); r <= 0 {
		t.Fatal("the socreate race guard broke: a success erased an ACTIVE 429 cooldown")
	}
	// …but the success TIME still lands (the v1.45.2 law)
	if !anyOtherProviderHealthy("stub") {
		t.Fatal("the success timestamp must land even under an active cooldown — it is network evidence")
	}
}

func TestV1452_ProviderScopedTextsNeverBlameNetwork(t *testing.T) {
	withHealthWindow(t, time.Hour, 50*time.Millisecond)
	withNetClocks(t, []time.Duration{2 * time.Millisecond, 3 * time.Millisecond}, 5*time.Millisecond, 10*time.Millisecond, 5*time.Millisecond)
	RecordProviderSuccess("openrouter") // the user's exact shape: OpenRouter works, PM is dead

	ch := make(chan ChatChunk, 256)
	attempts := 0
	var mu sync.Mutex
	err := netPauseLadder(context.Background(), ch, "privatemodeai", func() (bool, error) {
		mu.Lock()
		attempts++
		mu.Unlock()
		return false, transientErr()
	})
	if err == nil {
		t.Fatal("the bounded hold must end with the honest verdict")
	}
	close(ch)
	if !strings.Contains(err.Error(), "PrivateMode is unreachable right now") ||
		!strings.Contains(err.Error(), "your connection is fine") {
		t.Fatalf("the terminal must be the honest provider-down verdict, got: %v", err)
	}
	if strings.Contains(strings.ToLower(err.Error()), "network") {
		t.Fatalf("the provider-scoped terminal must NEVER blame the network: %v", err)
	}
	var sawNetwork, sawProviderText bool
	for _, c := range collectV1452(ch) {
		blob := c.Text + " " + c.Message
		lblob := strings.ToLower(blob)
		if strings.Contains(lblob, "network") {
			sawNetwork = true
		}
		if strings.Contains(blob, "PrivateMode") {
			sawProviderText = true
		}
	}
	if sawNetwork {
		t.Fatal("the provider-scoped ladder must never emit 'network' texts (the user's connection is fine)")
	}
	if !sawProviderText {
		t.Fatal("the texts must name the provider")
	}
	if attempts < 2 {
		t.Fatal("the hold must actually retry (a verdict without attempts is a fabrication)")
	}
}

func TestV1452_BoundedHoldRecoversMidHold(t *testing.T) {
	withHealthWindow(t, time.Hour, 40*time.Millisecond)
	withNetClocks(t, []time.Duration{2 * time.Millisecond}, 5*time.Millisecond, 10*time.Millisecond, 5*time.Millisecond)
	RecordProviderSuccess("nvidia")

	ch := make(chan ChatChunk, 256)
	// the provider comes back MID-HOLD — fail the initial call, the
	// rung retry, and the hold's first attempt, then recover: the turn
	// CONTINUES (never a fabricated terminal while the provider still
	// has a chance within the hold budget).
	fails := 0
	err := netPauseLadder(context.Background(), ch, "privatemodeai", func() (bool, error) {
		if fails < 3 {
			fails++
			return false, transientErr()
		}
		return false, nil
	})
	close(ch)
	if err != nil {
		t.Fatalf("a mid-hold recovery must continue the turn: %v", err)
	}
	var notices []string
	for _, c := range collectV1452(ch) {
		if c.Type == "notice" {
			notices = append(notices, c.Text)
		}
	}
	if len(notices) == 0 || !strings.Contains(notices[len(notices)-1], "PrivateMode is back") {
		t.Fatalf("the recovery must persist the 'is back' notice, got %v", notices)
	}
}

func TestV1452_DeviceOfflineLawUntouched(t *testing.T) {
	// NO success seeded — the fresh-engine default. The ladder must enter
	// the INFINITE suspension exactly as v1.39.3 pinned it (the v1400
	// battery owns the rest of the law; this pins the mode selection).
	withHealthWindow(t, time.Hour, 10*time.Millisecond)
	withNetClocks(t, []time.Duration{2 * time.Millisecond}, 5*time.Millisecond, 10*time.Millisecond, 5*time.Millisecond)

	ch := make(chan ChatChunk, 256)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		done <- netPauseLadder(ctx, ch, "privatemodeai", func() (bool, error) {
			return false, transientErr()
		})
	}()
	// the bounded hold would have terminalized in 10ms; give the
	// suspension 80ms — if the turn is STILL running, the patient engine
	// held (no bounded exit without success evidence).
	select {
	case err := <-done:
		t.Fatalf("device-offline must stay in the INFINITE suspension (the bounded hold is provider-scoped only): %v", err)
	case <-time.After(80 * time.Millisecond):
	}
	cancel()
	<-done
	close(ch)
	sawNetworkText := false
	for _, c := range collectV1452(ch) {
		if strings.Contains(strings.ToLower(c.Text+" "+c.Message), "network") {
			sawNetworkText = true
		}
	}
	if !sawNetworkText {
		t.Fatal("the device-offline texts keep the honest 'network' language")
	}
}

func TestV1452_HiccupCounterTellsTheTruth(t *testing.T) {
	// the compressed rig waits exposed the hardcoded "/2" live ("retry
	// 5/2"); the counter must report the REAL quick-rung total. Seeded
	// health → the bounded hold terminalizes so the ladder RETURNS.
	withHealthWindow(t, time.Hour, 5*time.Millisecond)
	withNetClocks(t, []time.Duration{2 * time.Millisecond, 3 * time.Millisecond, 4 * time.Millisecond, 5 * time.Millisecond, 6 * time.Millisecond},
		5*time.Millisecond, 10*time.Millisecond, 5*time.Millisecond)
	RecordProviderSuccess("other")

	ch := make(chan ChatChunk, 256)
	err := netPauseLadder(context.Background(), ch, "stub", func() (bool, error) {
		return false, transientErr()
	})
	close(ch)
	if err == nil {
		t.Fatal("the bounded hold must terminalize the doomed provider")
	}
	var statuses []string
	for _, c := range collectV1452(ch) {
		if c.Type == "status" && c.State == "running" {
			statuses = append(statuses, c.Message)
		}
	}
	// ALL five compressed rungs are < 15s → ALL five are quick hiccups:
	// "retry 5/5" is the honest last count (the old text said "5/2").
	if len(statuses) == 0 || !strings.HasSuffix(statuses[len(statuses)-1], "5/5") {
		t.Fatalf("the hiccup counter must tell the real total, got %v", statuses)
	}
	for _, s := range statuses {
		if !strings.Contains(s, "/5") {
			t.Fatalf("every hiccup must carry the real total: %v", statuses)
		}
	}
}
