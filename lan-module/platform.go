package main

import "runtime"

func isWindowsHost() bool { return runtime.GOOS == "windows" }
func isDarwin() bool      { return runtime.GOOS == "darwin" }
