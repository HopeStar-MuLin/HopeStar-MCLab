//go:build windows

package api

import (
	"os/exec"
	"syscall"
)

// isAdmin 通过尝试执行需要管理员权限的命令来判定。
// 直接查令牌更精确，但这里只在诊断页调用一次，用命令成本更低。
func isAdmin() bool {
	cmd := exec.Command("net", "session")
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000}
	return cmd.Run() == nil
}
