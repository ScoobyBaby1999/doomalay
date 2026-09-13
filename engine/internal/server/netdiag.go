package server

import (
	"net/http"

	"github.com/ScoobyBaby1999/doomalay/engine/internal/netx"
)

// netdiag.go — GET /api/netdiag
//
// v0.14: the on-device egress check. The APK engine is a pure-Go binary
// without /etc/resolv.conf, so plain net.Lookup* fails on Android; netx
// falls back to DNS-over-HTTPS (bootstrap IPs, no DNS needed). This
// endpoint reports which path egress currently takes, plus a live provider
// reachability probe, so "models won't sync" can be diagnosed in one call
// instead of guessing.

// handleNetDiag reports resolver health + one live provider probe.
func (s *Server) handleNetDiag(w http.ResponseWriter, r *http.Request) {
	out := map[string]any{
		"netdiag": netx.Diag(),
	}
	writeJSON(w, 200, out)
}
