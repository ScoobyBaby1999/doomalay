package server

import (
        "net/http"

        "github.com/ScoobyBaby1999/doomalay/engine/internal/buildinfo"
)

// handleCapabilities is GET /api/capabilities — advertises what this engine
// can do. The PWA's routing engine uses this to decide where to send work.
//
// Phase 1: chat only (no sandbox, no shell, no files yet — those land in Phase 2).
// The HF Demo reports canBuild:true once bubblewrap lands in Phase 3.
func (s *Server) handleCapabilities(w http.ResponseWriter, r *http.Request) {
        caps := map[string]any{
                "canChat":    true,
                "canBuild":   false, // Phase 2b: bubblewrap sandbox
                "canShell":   false, // Phase 2b: PTY
                "hasGPU":     false,
                "hasKVM":     false,
                "type":       s.cfg.Mode,
                "brainAlive": s.brain != nil && s.brain.Healthy(),
                "version":    buildinfo.Version,
                // v0.48 task 5: dev builds unlock the cloud-providers "use public
                // key" pill (shared test keys).
                "dev": buildinfo.Dev,
        }
        if s.cfg.Mode == "hf-demo" {
                caps["note"] = "Capable bubblewrap sandbox (Phase 3). No GPU/KVM. Sleeps after 48h."
        }
        writeJSON(w, 200, caps)
}
