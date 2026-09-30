package llm

// v0.80.1 THE NO-TIMER CONTRACT (user directive: "remove any timer that
// canceles an output or reply — models should be able to keep going as
// long as they like"). These tests pin the disarmed idle watchdog: a
// silent stream must LIVE until its natural end or the Stop button.

import (
	"io"
	"testing"
	"time"
)

func TestIdleWatchdogDisabled(t *testing.T) {
	// idleWaitFor must return 0 for every model — the kill is gone.
	for _, m := range []string{
		"nvidia/moonshotai/kimi-k3", "deepseek-ai/deepseek-v4.1-flash",
		"meta/llama-3.1-8b", "whatever/else",
	} {
		if d := idleWaitFor(m); d != 0 {
			t.Fatalf("idleWaitFor(%q) = %v, want 0 (kill disabled)", m, d)
		}
	}
}

func TestIdleReaderZeroTimeoutNeverArms(t *testing.T) {
	// A zero timeout must not arm the kill timer, and a silent-then-alive
	// stream must survive + deliver its bytes.
	pr, pw := io.Pipe()
	wd := newIdleTimeoutReader(pr, idleWaitFor("nvidia/moonshotai/kimi-k3"))
	if wd.timer != nil {
		t.Fatal("zero timeout must not arm the kill timer")
	}
	go func() {
		time.Sleep(60 * time.Millisecond) // silence — under the old 90s kill this
		// would be fine too, but under a WRONGLY-armed 0s timer the body
		// would close instantly and this read would fail.
		_, _ = pw.Write([]byte("data: {\"ok\":true}\n"))
	}()
	buf := make([]byte, 128)
	n, err := wd.Read(buf)
	if err != nil || n == 0 {
		t.Fatalf("read on silent-then-alive stream: n=%d err=%v", n, err)
	}
	if err := wd.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}
	_ = pw.Close()
}

func TestIdleReaderStillSupportsOptInKill(t *testing.T) {
	// A caller that passes a positive timeout still gets the old kill —
	// the machinery is intact, just disarmed for chat streams.
	pr, _ := io.Pipe()
	wd := newIdleTimeoutReader(pr, 30*time.Millisecond)
	if wd.timer == nil {
		t.Fatal("positive timeout must arm the kill timer")
	}
	buf := make([]byte, 128)
	start := time.Now()
	_, err := wd.Read(buf) // nothing ever written → must die via the watchdog
	if err == nil {
		t.Fatal("opt-in kill did not fire")
	}
	if time.Since(start) > 2*time.Second {
		t.Fatalf("kill fired too late: %v", time.Since(start))
	}
	_ = wd.Close()
}
