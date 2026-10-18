// chat_v1400_test.go — v1.40.0 THE UNBROKEN STREAM pins (llm half).
// v1.39.3 THE PATIENT ENGINE: a network outage is not a turn verdict —
// the ladder never gives up, the suspended mode heartbeats, the wake
// interrupts the wait, and the double-render guard survives intact.
package llm

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"
)

// withNetClocks swaps the ladder's clocks for the test (the ENV knobs are
// the rig-subprocess path; in-process tests swap the vars directly).
func withNetClocks(t *testing.T, waits []time.Duration, base, cap, hb time.Duration) {
	t.Helper()
	oldW, oldB, oldC, oldH := netPauseWaits, netSuspendBase, netSuspendCap, netHeartbeatEvery
	netPauseWaits, netSuspendBase, netSuspendCap, netHeartbeatEvery = waits, base, cap, hb
	t.Cleanup(func() {
		netPauseWaits, netSuspendBase, netSuspendCap, netHeartbeatEvery = oldW, oldB, oldC, oldH
	})
}

// transientErr — the class isTransientNetErr recognizes (refused).
func transientErr() error { return errors.New("dial tcp 127.0.0.1:1: connect: connection refused") }

func TestV1400_NetWakeBroadcast(t *testing.T) {
	ch1 := netWakeChan()
	ch2 := netWakeChan()
	if ch1 != ch2 {
		t.Fatal("netWakeChan must be stable between wakes")
	}
	var wg sync.WaitGroup
	woke := make(chan string, 2)
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-netWakeChan()
			woke <- "waiter"
		}()
	}
	time.Sleep(20 * time.Millisecond) // let the waiters arm
	WakeNet()
	for i := 0; i < 2; i++ {
		select {
		case <-woke:
		case <-time.After(2 * time.Second):
			t.Fatal("both suspended waiters must wake on WakeNet")
		}
	}
	wg.Wait()
	// the old channel is closed; a fresh one is armed
	select {
	case <-ch1:
	default:
		t.Fatal("the pre-wake channel must be closed (the broadcast)")
	}
	if netWakeChan() == ch1 {
		t.Fatal("a fresh wake channel must be armed after the broadcast")
	}
	// an unwoken WakeNet is a no-op (no panic, no waiters)
	WakeNet()
}

func TestV1400_SuspensionSurvivesOutage(t *testing.T) {
	withNetClocks(t, []time.Duration{5 * time.Millisecond}, 10*time.Millisecond, 20*time.Millisecond, 5*time.Millisecond)
	ch := make(chan ChatChunk, 64)
	failures := 0
	// fail past the fixed rungs + two suspended attempts, then the network
	// comes back — the OLD ladder would have terminalized at the rungs' end.
	err := netPauseLadder(context.Background(), ch, "stub", func() (bool, error) {
		failures++
		if failures <= 3 {
			return false, transientErr()
		}
		return false, nil
	})
	if err != nil {
		t.Fatalf("the patient ladder must survive the outage: %v", err)
	}
	close(ch) // the ladder never closes ch (the turn runner owns it) — the test does
	// the transcript story: the ENTER notice before the wait, the REGAINED
	// notice after the resume — both persisted-class chunks
	var notices []string
	var progress int
	for c := range ch {
		if c.Type == "notice" {
			notices = append(notices, c.Text)
		}
		if c.Type == "progress" {
			progress++
		}
	}
	if len(notices) != 2 {
		t.Fatalf("suspension must persist exactly the enter + regained notices, got %d: %v", len(notices), notices)
	}
	if !strings.Contains(notices[0], "connection to") || !strings.Contains(notices[0], "keeps retrying") {
		t.Fatalf("the enter notice must name the provider + the hold: %q", notices[0])
	}
	if !strings.Contains(notices[1], "network regained after") {
		t.Fatalf("the regained notice must close the story: %q", notices[1])
	}
	// the heartbeat fired while suspended (the live UI + pulse refresh)
	if progress == 0 {
		t.Fatal("the suspended wait must heartbeat (progress chunks)")
	}
}

func TestV1400_SuspensionNeverGivesUp(t *testing.T) {
	withNetClocks(t, []time.Duration{5 * time.Millisecond}, 10*time.Millisecond, 15*time.Millisecond, 5*time.Millisecond)
	ch := make(chan ChatChunk, 256)
	ctx, cancel := context.WithCancel(context.Background())
	attempts := 0
	done := make(chan error, 1)
	go func() {
		done <- netPauseLadder(ctx, ch, "stub", func() (bool, error) {
			attempts++
			return false, transientErr()
		})
	}()
	// let it blow PAST the old give-up point (rungs + several suspended
	// waits) — nothing ends the turn
	deadline := time.Now().Add(400 * time.Millisecond)
	for attempts < 6 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if attempts < 6 {
		t.Fatalf("the suspension must keep retrying past the old ~110s give-up; attempts=%d", attempts)
	}
	select {
	case e := <-done:
		t.Fatalf("the turn ended before Stop: %v", e)
	default:
	}
	// THE USER'S STOP is the only exit
	cancel()
	select {
	case e := <-done:
		if !errors.Is(e, context.Canceled) {
			t.Fatalf("Stop must end the suspension with ctx.Err, got %v", e)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Stop must end the suspension")
	}
}

func TestV1400_WakeInterruptsTheWait(t *testing.T) {
	// a LONG suspended cap — only the wake can exit the wait quickly
	withNetClocks(t, []time.Duration{2 * time.Millisecond}, 40*time.Millisecond, 60*time.Second, 200*time.Millisecond)
	ch := make(chan ChatChunk, 64)
	fails := 0
	start := time.Now()
	done := make(chan error, 1)
	go func() {
		done <- netPauseLadder(context.Background(), ch, "stub", func() (bool, error) {
			fails++
			if fails == 1 {
				return false, transientErr()
			}
			return false, nil
		})
	}()
	// wait for the suspension to arm (past the fixed rung)
	for fails == 0 && time.Since(start) < 2*time.Second {
		time.Sleep(5 * time.Millisecond)
	}
	time.Sleep(30 * time.Millisecond) // inside the first suspended wait
	WakeNet()
	select {
	case e := <-done:
		if e != nil {
			t.Fatalf("post-wake retry must succeed: %v", e)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("the wake must interrupt the suspended wait")
	}
	if elapsed := time.Since(start); elapsed > 2*time.Second {
		t.Fatalf("the wake must exit the wait fast, took %v", elapsed)
	}
}

func TestV1400_DoubleRenderGuardSurvives(t *testing.T) {
	withNetClocks(t, []time.Duration{5 * time.Millisecond}, 10*time.Millisecond, 20*time.Millisecond, 5*time.Millisecond)
	ch := make(chan ChatChunk, 64)
	calls := 0
	_ = errors.New("cut mid-stream after visible content")
	// with a REAL transient error + emitted=true the round is never retried
	calls = 0
	err := netPauseLadder(context.Background(), ch, "stub", func() (bool, error) {
		calls++
		return true, transientErr()
	})
	if calls != 1 {
		t.Fatalf("a round that streamed visible content must NEVER be retried (double-render law), calls=%d", calls)
	}
	if err == nil || err.Error() != transientErr().Error() {
		t.Fatalf("the emitted-failure must pass through honestly, got %v", err)
	}
	close(ch)
	// and no suspension notices were persisted for the emitted class
	for c := range ch {
		if c.Type == "notice" {
			t.Fatalf("an emitted failure must not enter the suspension (no pause notices), got %q", c.Text)
		}
	}
}

func TestV1400_NonTransientExitsFastNoSuspension(t *testing.T) {
	withNetClocks(t, []time.Duration{2 * time.Millisecond}, 5*time.Millisecond, 10*time.Millisecond, 2*time.Millisecond)
	// An unknown provider fails at request-build with a NON-transient error
	// (unsupported protocol scheme) — the ladder must pass it through
	// IMMEDIATELY: no retries, no suspension, no pause notices. Auth and
	// protocol failures stay terminal exactly as before (retrying is
	// pointless — the honest busy paths stand).
	req := ChatRequest{Model: "m", Provider: "stub", Messages: []Message{{Role: "user", Content: "hi"}}}
	ch := make(chan ChatChunk, 16)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	_, _, err := netLadderStream(ctx, req, ch, nil)
	if err == nil {
		t.Fatal("the dead provider must fail honestly")
	}
	if isTransientNetErr(err) {
		t.Fatalf("request-build failures are the non-transient class, got %v", err)
	}
	close(ch)
	for c := range ch {
		if c.Type == "notice" {
			t.Fatalf("a non-transient failure must never enter the suspension, got notice %q", c.Text)
		}
	}
}

func TestV1400_EnvKnobParsing(t *testing.T) {
	t.Setenv("DOOMALAY_NET_LADDER_WAITS", " 5, 10 ,20 ")
	w := envDurs("DOOMALAY_NET_LADDER_WAITS", nil)
	if len(w) != 3 || w[0] != 5*time.Millisecond || w[1] != 10*time.Millisecond || w[2] != 20*time.Millisecond {
		t.Fatalf("envDurs must parse the rig's comma list, got %v", w)
	}
	t.Setenv("DOOMALAY_NET_SUSPEND_BASE_MS", "7")
	if d := envDur("DOOMALAY_NET_SUSPEND_BASE_MS", time.Second); d != 7*time.Millisecond {
		t.Fatalf("envDur must parse ms, got %v", d)
	}
	for _, bad := range []string{"", "abc", "-5", "0"} {
		t.Setenv("DOOMALAY_NET_SUSPEND_BASE_MS", bad)
		if d := envDur("DOOMALAY_NET_SUSPEND_BASE_MS", time.Second); d != time.Second {
			t.Fatalf("envDur must keep the default on %q, got %v", bad, d)
		}
	}
	_ = os.Getenv("DOOMALAY_NET_LADDER_WAITS")
}

func TestV1400_DurHuman(t *testing.T) {
	cases := map[time.Duration]string{
		0:                "0s",
		47 * time.Second: "47s",
		3 * time.Minute:  "3m00s",
		62 * time.Second: "1m02s",
	}
	for d, want := range cases {
		if got := durHuman(d); got != want {
			t.Fatalf("durHuman(%v) = %q, want %q", d, got, want)
		}
	}
	_ = fmt.Sprint("")
}

// TestV1400_SeamWrap_TheCutClassMarker (v1.39.6 THE SEAMLESS CUT): a
// mid-stream connection death of a stream that ALREADY streamed visible
// content must come back carrying the emittedCutError marker (the class
// the seam owns) + the accumulated partial (the seam's context) — while
// the partial's deltas stay on the record (the on-screen half).
func TestV1400_SeamWrap_TheCutClassMarker(t *testing.T) {
	withNetClocks(t, []time.Duration{2 * time.Millisecond}, 5*time.Millisecond, 10*time.Millisecond, 2*time.Millisecond)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(200)
		fl := w.(http.Flusher)
		_, _ = w.Write([]byte(`data: {"choices":[{"delta":{"content":"partial answer "}}]}` + "\n\n"))
		fl.Flush()
		time.Sleep(20 * time.Millisecond) // let the delta land client-side
		// THE CUT: the connection dies mid-stream — no [DONE], no
		// finish_reason. ErrAbortHandler aborts the TCP stream server-side
		// (the mobile-VPN/NAT-rebind shape).
		panic(http.ErrAbortHandler)
	}))
	defer srv.Close()

	ch := make(chan ChatChunk, 64)
	req := ChatRequest{
		Model: "m", Provider: "openrouter", BaseURL: srv.URL,
		Messages: []Message{{Role: "user", Content: "write a long answer"}},
	}
	_, streamed, err := netLadderStream(context.Background(), req, ch, nil)
	var cut *emittedCutError
	if !errors.As(err, &cut) {
		t.Fatalf("a mid-stream cut of emitted content must carry the seam marker, got %v", err)
	}
	if !isTransientNetErr(err) {
		t.Fatalf("the cut class must stay transient-class, got %v", err)
	}
	if streamed != "partial answer " {
		t.Fatalf("the tap must accumulate the partial for the seam's context, got %q", streamed)
	}
	close(ch)
	var text strings.Builder
	for c := range ch {
		if c.Type == "assistant_delta" {
			text.WriteString(c.Text)
		}
	}
	if text.String() != "partial answer " {
		t.Fatalf("the partial's deltas must stay on the record, got %q", text.String())
	}
}
