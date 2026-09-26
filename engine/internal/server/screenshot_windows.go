//go:build windows

package server

import "os/exec"

// cmdSetupKillGroup — windows has no process groups / kill(2); the
// direct CommandContext kill is the best effort (and windows chromium
// self-exits when the parent's pipes close). See screenshot_unix.go for
// the full rationale.
func cmdSetupKillGroup(cmd *exec.Cmd) {}
