package server

// web_pixi_test.go — v0.85.4 THE PIXIJS WORLD LAYER vendor pin: the
// renderer-path Phase 3 (RESEARCH-V084 §2c) vendors pixi.js v8 (MIT) at
// web/vendor/pixi/pixi.min.js, lazy-injected by pixiworld.js only when
// the world layer activates. This test pins the drift guard: the file
// must exist in the EMBEDDED filesystem and stay a real bundle (>500KB
// — a truncated/empty vendor file would silently kill the layer with a
// script-load error instead of the honest fallback).

import (
	"io/fs"
	"strings"
	"testing"
)

func TestWebPixiVendorPinned(t *testing.T) {
	data, err := fs.ReadFile(webFS, "web/vendor/pixi/pixi.min.js")
	if err != nil {
		t.Fatalf("vendor pixi.min.js missing from the embedded web tree: %v", err)
	}
	if len(data) < 500_000 {
		t.Fatalf("vendor pixi.min.js looks truncated: %d bytes (< 500KB)", len(data))
	}
	// the bundle must expose the PIXI global (the pixiworld bootstrap
	// awaits it after the lazy <script> injection)
	if !strings.Contains(string(data), "PIXI") {
		t.Fatalf("vendor pixi.min.js does not look like the pixi.js bundle (no PIXI export)")
	}
}
