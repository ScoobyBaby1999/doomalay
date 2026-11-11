package brain

// bridge_v176_live_test.go — THE LIVE RIG (v1.76.0 redteam, PLAN-V176):
// drives ONE REAL provider turn through the hardened bridge against the
// REAL brain (brain/server.py, the real litellm stack, a real provider
// over the real internet — the poor-network path this wave hardens).
//
// Gated: skipped unless DOOMALAY_BRAIN_LIVE=<brain-url> AND the provider
// key are present — CI never needs keys, the redteam does.

import (
        "os"
        "strings"
        "testing"
        "time"
)

func TestV176Live_RealBrainRealProvider(t *testing.T) {
        live := os.Getenv("DOOMALAY_BRAIN_LIVE")
        if live == "" {
                t.Skip("live rig: DOOMALAY_BRAIN_LIVE=<brain url> + provider key required")
        }
        key := os.Getenv("NVIDIA_API_KEY")
        if key == "" {
                t.Skip("live rig: NVIDIA_API_KEY required")
        }
        model := os.Getenv("DOOMALAY_BRAIN_LIVE_MODEL")
        if model == "" {
                model = "nvidia/deepseek-ai/deepseek-v4.1-flash" // the live catalog pair
        }
        // Cold free-tier first tokens can crawl — give the sentinel a wide
        // window for the LIVE happy path (the watchdog itself is pinned by
        // the fault-injection battery).
        t.Setenv("DOOMALAY_BRAIN_STALL_KILL", "120")

        b := &Brain{url: live, healthy: true, env: map[string]string{"NVIDIA_API_KEY": key, "OPENROUTER_API_KEY": os.Getenv("OPENROUTER_API_KEY")}}
        // The engine's brainReq shape: provider named separately (the brain's
        // registry resolves on it — server.py:824).
        prov := "nvidia"
        if p := os.Getenv("DOOMALAY_BRAIN_LIVE_PROVIDER"); p != "" {
                prov = p
        }
        events, errs, err := b.Chat(t.Context(), map[string]any{
                "session_id": "v176-live-rig",
                "message":    "Reply with exactly one word: alive",
                "model":      model,
                "provider":   prov,
        })
        if err != nil {
                t.Fatalf("live Chat: %v", err)
        }

        var answer strings.Builder
        var types []string
        var sawIdle bool
        deadline := time.After(180 * time.Second)
        for events != nil || errs != nil {
                select {
                case ev, ok := <-events:
                        if !ok {
                                events = nil
                                continue
                        }
                        ty, _ := ev["type"].(string)
                        types = append(types, ty)
                        if ty == "status" {
                                if st, _ := ev["state"].(string); st == "idle" {
                                        sawIdle = true
                                }
                        }
                        if s, ok := ev["text"].(string); ok {
                                answer.WriteString(s)
                        }
                case e, ok := <-errs:
                        if !ok {
                                errs = nil
                                continue
                        }
                        t.Fatalf("live stream error: %v", e)
                case <-deadline:
                        t.Fatal("live turn exceeded 180s")
                }
        }
        t.Logf("live turn events: %v", types)
        t.Logf("live answer: %q", answer.String())
        if len(types) == 0 {
                t.Fatal("the live turn produced zero events")
        }
        if !sawIdle {
                t.Fatalf("the live turn never reached terminal status idle (events: %v)", types)
        }
        if !b.Healthy() {
                t.Fatal("a completed live turn must keep the brain flagged healthy")
        }
}
