// Package et 封装 easytier-core 的进程生命周期与 easytier-cli 的状态读取。
package et

import (
	"strconv"

	"mclab-lan/internal/config"
	"mclab-lan/internal/profile"
	"mclab-lan/internal/room"
)

// Spec 描述一次组网启动所需的全部信息。
type Spec struct {
	Room     room.Room
	IsHost   bool
	SelfIP   string
	HostIP   string
	// Peers 是用于发现对等节点的入口地址，来自配置里的节点列表。
	Peers []string
	// ManualPeer 用于「同局域网」方案，直接指定对端 IP:端口。
	ManualPeer string
	Profile    profile.Profile
	Opts       config.Options
	Instance   string
	Hostname   string
	BinDir     string
	LogDir     string
}

// BuildArgs 组装 easytier-core 的完整命令行参数。
// 顺序固定，便于日志排查与配置比对。
func BuildArgs(s Spec) []string {
	args := []string{
		"--network-name", s.Room.Network,
		"--network-secret", s.Room.Secret,
		"--hostname", s.Hostname,
		"--instance-name", s.Instance,
		"--rpc-portal", strconv.Itoa(s.Opts.RPCPortal),
		"--file-log-dir", s.LogDir,
		"--file-log-level", orDefault(s.Opts.LogLevel, "info"),
		"--console-log-level", "info",
	}

	// 虚拟网卡：非 no-tun 方案才分配 IP。
	if s.Profile.NeedTUN {
		args = append(args, "--ipv4", s.SelfIP)
		args = append(args, "--listeners", "tcp://0.0.0.0:11010", "udp://0.0.0.0:11010")
	} else {
		args = append(args, "--no-tun", "true")
		// 无 TUN 时仍需监听，否则无法被其他节点连上。
		args = append(args, "--listeners", "tcp://0.0.0.0:11010", "udp://0.0.0.0:11010")
	}

	// 节点入口：每个地址单独一个 -p，避免 clap 多值解析歧义。
	if s.ManualPeer != "" {
		args = append(args, "-p", s.ManualPeer)
	}
	for _, p := range s.Peers {
		if p == "" {
			continue
		}
		args = append(args, "-p", p)
	}

	// 方案参数。
	args = append(args, profile.Expand(s.Profile, s.HostIP)...)

	// 全局调优。
	if s.Profile.NeedTUN && s.Opts.EnableUDPBroadcastRelay {
		// 让 MC 的「对局域网开放」广播能穿过隧道，只在 Windows 有效。
		args = append(args, "--enable-udp-broadcast-relay", "true")
	}
	if s.Opts.EnableKCPProxy && !hasArg(args, "--enable-kcp-proxy") {
		args = append(args, "--enable-kcp-proxy", "true")
	}
	if s.Opts.EnableQUICProxy && !hasArg(args, "--enable-quic-proxy") {
		args = append(args, "--enable-quic-proxy", "true")
	}
	if s.Opts.LatencyFirst && !hasArg(args, "--latency-first") {
		args = append(args, "--latency-first", "true")
	}
	if s.Opts.Compression != "" && s.Opts.Compression != "none" && !hasArg(args, "--compression") {
		args = append(args, "--compression", s.Opts.Compression)
	}
	if s.Opts.MTU > 0 {
		args = append(args, "--mtu", strconv.Itoa(s.Opts.MTU))
	}
	if s.Opts.Encryption != "" && !hasArg(args, "--encryption-algorithm") {
		args = append(args, "--encryption-algorithm", s.Opts.Encryption)
	}

	// 对称 NAT 的生日攻击打洞默认开启，显式关闭禁用开关以防历史配置残留。
	// 该能力依赖双方同时尝试，任一侧关闭都会退化到纯中继。
	args = append(args, "--disable-sym-hole-punching", "false")

	return args
}

// hasArg 检查某个开关是否已被方案参数显式设置，避免重复追加导致后者覆盖前者。
func hasArg(args []string, flag string) bool {
	for _, a := range args {
		if a == flag {
			return true
		}
	}
	return false
}

func orDefault(v, def string) string {
	if v == "" {
		return def
	}
	return v
}
