// mclab-lan 是 HopeStar-MCLab 的外部联机模块。
// 它以本地 HTTP 服务的形式暴露组网能力，内置 Web 控制台，
// 启动器既可以通过浏览器打开界面，也可以直接调用 /api/* 接口驱动。
package main

import (
	"embed"
	"flag"
	"fmt"
	"io/fs"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"mclab-lan/internal/api"
	"mclab-lan/internal/config"
	"mclab-lan/internal/et"
)

//go:embed all:web
var webFiles embed.FS

func main() {
	var (
		addrFlag  = flag.String("addr", "127.0.0.1:38999", "HTTP 服务监听地址")
		dataFlag  = flag.String("data", "", "数据目录，默认为可执行文件旁的 data")
		binFlag   = flag.String("bin", "", "EasyTier 二进制目录，默认为可执行文件旁的 bin")
		portFlag  = flag.Bool("pick-port", true, "端口被占用时自动向后寻找可用端口")
		openFlag  = flag.Bool("open", true, "启动后自动打开浏览器")
		silentFlg = flag.Bool("silent", false, "不输出启动横幅，供启动器以子进程方式调用")
	)
	flag.Parse()

	root := executableDir()
	dataDir := *dataFlag
	if dataDir == "" {
		dataDir = filepath.Join(root, "data")
	}
	binDir := *binFlag
	if binDir == "" {
		binDir = filepath.Join(root, "bin")
	}

	cfg, err := config.Open(filepath.Join(dataDir, "config.json"))
	if err != nil {
		log.Fatalf("加载配置失败: %v", err)
	}

	mgr := et.NewManager(4000)

	webRoot, err := fs.Sub(webFiles, "web")
	if err != nil {
		log.Fatalf("加载内置界面失败: %v", err)
	}

	api.Version = buildVersion
	srv := api.New(cfg, mgr, webRoot, binDir, dataDir)
	handler := srv.Handler()

	ln, actualAddr, err := listen(*addrFlag, *portFlag)
	if err != nil {
		log.Fatalf("监听失败: %v", err)
	}

	url := "http://" + actualAddr
	if !*silentFlg {
		fmt.Println("MCLab 联机模块")
		fmt.Println("  控制台:", url)
		fmt.Println("  数据目录:", dataDir)
		fmt.Println("  EasyTier:", binDir)
		fmt.Println("  按 Ctrl+C 退出")
	}

	// 退出时确保子进程被回收，避免留下占用 11010 端口的孤儿进程。
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)
	go func() {
		<-stop
		_ = mgr.Stop()
		os.Exit(0)
	}()

	if *openFlag && !*silentFlg {
		go openBrowser(url)
	}

	server := &http.Server{
		Handler:           handler,
		ReadHeaderTimeout: 10 * time.Second,
	}
	if err := server.Serve(ln); err != nil && err != http.ErrServerClosed {
		log.Fatalf("服务异常退出: %v", err)
	}
}

// listen 在端口被占用时向后探测，方便同时跑多个实例做联机测试。
func listen(addr string, autoPick bool) (net.Listener, string, error) {
	ln, err := net.Listen("tcp", addr)
	if err == nil {
		return ln, ln.Addr().String(), nil
	}
	if !autoPick {
		return nil, "", err
	}

	host, _, splitErr := net.SplitHostPort(addr)
	if splitErr != nil {
		return nil, "", err
	}
	for port := 39000; port < 39100; port++ {
		candidate := net.JoinHostPort(host, fmt.Sprint(port))
		if ln, e := net.Listen("tcp", candidate); e == nil {
			return ln, ln.Addr().String(), nil
		}
	}
	return nil, "", err
}

func executableDir() string {
	exe, err := os.Executable()
	if err != nil {
		wd, _ := os.Getwd()
		return wd
	}
	return filepath.Dir(exe)
}

func openBrowser(url string) {
	time.Sleep(300 * time.Millisecond)
	var cmd *exec.Cmd
	switch {
	case isWindowsHost():
		cmd = exec.Command("rundll32", "url.dll,FileProtocolHandler", url)
	case isDarwin():
		cmd = exec.Command("open", url)
	default:
		cmd = exec.Command("xdg-open", url)
	}
	_ = cmd.Start()
}

// buildVersion 可通过 -ldflags "-X main.buildVersion=..." 注入。
var buildVersion = "dev"
