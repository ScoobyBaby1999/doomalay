package brain

// fallback.go is the direct cloud LLM proxy used when the Python brain is
// unavailable (e.g. minimal Android Termux without python installed). It
// talks directly to OpenRouter/NVIDIA/OpenAI/etc. without the Strands agent
// layer — no local tools, no panel, but chat works.
//
// This is intentionally minimal: it exists so the app is functional even
// on a constrained device. The full brain (tools, panel, templates) needs
// Python. When the brain IS available, fallback.go is not used.
//
// Phase 1 stub: implemented in Phase 2 alongside the sandbox. For now,
// chat requires the brain (returned error if brain absent).

import (
	"fmt"
)

// FallbackChat returns an error in Phase 1 — the fallback is a Phase 2 deliverable.
func FallbackChat(provider, model, message, apiKey string) error {
	return fmt.Errorf("python brain not available; direct cloud proxy is a Phase 2 feature. Install python + brain/requirements.txt to enable chat.")
}
