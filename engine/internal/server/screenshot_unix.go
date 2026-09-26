//go:build !windows

package server

import (
        "os/exec"
        "syscall"
)

// cmdSetupKillGroup — v0.62.4: the screenshot render runs chromium in
// its OWN process group so a timeout/shutdown kill takes down the whole
// tree (zygotes, crash handlers). A bare process kill orphans them —
// observed live: a killed engine left a headless chrome burning CPU
// forever. Unix only; windows gets the direct CommandContext kill.
func cmdSetupKillGroup(cmd *exec.Cmd) {
        cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
        cmd.Cancel = func() error {
                if cmd.Process != nil {
                        _ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
                }
                return nil
        }
}
