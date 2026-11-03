//go:build !windows

package api

import "os"

func isAdmin() bool { return os.Geteuid() == 0 }
