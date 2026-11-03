//go:build windows

package et

import (
	"os/exec"
	"syscall"
)

// CREATE_NO_WINDOW 让子进程不弹出控制台窗口。
// 启动器是 GUI 程序，不隐藏的话每次组网都会闪一个黑框。
const createNoWindow = 0x08000000

func applySysProc(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{
		HideWindow:    true,
		CreationFlags: createNoWindow,
	}
}

func isWindows() bool { return true }
