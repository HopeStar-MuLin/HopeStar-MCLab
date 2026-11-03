//go:build !windows

package et

import (
	"os/exec"
	"syscall"
)

func applySysProc(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
}

func isWindows() bool { return false }
