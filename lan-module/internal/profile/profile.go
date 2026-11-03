// Package profile 定义面向玩家的「联机方案」预设。
// 每个方案对应一组 easytier-core 参数，覆盖从强制直连到强制中继、
// 从 UDP 到 FakeTCP 的各种网络环境组合。
package profile

import (
	"fmt"
	"sort"
	"strings"
)

// Group 用于界面分组。
const (
	GroupRecommended = "推荐"
	GroupProtocol    = "传输协议"
	GroupNetwork     = "网络环境"
	GroupSpecial     = "特殊模式"
)

// Profile 是一个可选的联机方案。
type Profile struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	Group  string `json:"group"`
	Desc   string `json:"desc"`
	Advise string `json:"advise"`
	// NeedTUN 为 false 表示该方案不创建虚拟网卡。
	NeedTUN bool `json:"need_tun"`
	// Args 是追加到 easytier-core 命令行的参数。
	// 占位符 {host} 会被替换为房主虚拟 IP。
	Args []string `json:"-"`
}

var all = []Profile{
	{
		ID:     "auto",
		Name:   "智能直连",
		Group:  GroupRecommended,
		Desc:   "优先 UDP 打洞，失败自动降级中继",
		Advise: "默认选项，覆盖绝大多数家宽场景",
		NeedTUN: true,
		Args: []string{
			"--default-protocol", "udp",
			"--latency-first", "true",
		},
	},
	{
		ID:     "p2p",
		Name:   "强制直连",
		Group:  GroupRecommended,
		Desc:   "只在打洞成功时通信，不接受中继",
		Advise: "双方 NAT 友好时延迟最低；打洞失败会直接连不上",
		NeedTUN: true,
		Args: []string{
			"--p2p-only", "true",
			"--latency-first", "true",
			"--need-p2p", "true",
		},
	},
	{
		ID:     "relay",
		Name:   "强制中继",
		Group:  GroupRecommended,
		Desc:   "完全禁用 P2P，所有流量走节点转发",
		Advise: "对称 NAT、企业防火墙等打洞必败的场景下仍能连通",
		NeedTUN: true,
		Args: []string{
			"--disable-p2p", "true",
		},
	},
	{
		ID:     "udp",
		Name:   "UDP 打洞",
		Group:  GroupProtocol,
		Desc:   "仅用 UDP 建立连接与打洞",
		Advise: "最常见的家宽环境，开销最小",
		NeedTUN: true,
		Args: []string{
			"--default-protocol", "udp",
			"--disable-tcp-hole-punching", "true",
		},
	},
	{
		ID:     "tcp",
		Name:   "TCP 打洞",
		Group:  GroupProtocol,
		Desc:   "用 TCP 建连与打洞，关闭 UDP 打洞",
		Advise: "运营商限制 UDP 时使用，例如部分校园网",
		NeedTUN: true,
		Args: []string{
			"--default-protocol", "tcp",
			"--disable-udp-hole-punching", "true",
		},
	},
	{
		ID:     "quic",
		Name:   "QUIC",
		Group:  GroupProtocol,
		Desc:   "基于 QUIC 的传输，自带拥塞控制与多路复用",
		Advise: "跨境高丢包链路，比裸 UDP 更稳",
		NeedTUN: true,
		Args: []string{
			"--default-protocol", "quic",
			"--enable-quic-proxy", "true",
		},
	},
	{
		ID:     "ws",
		Name:   "WebSocket",
		Group:  GroupProtocol,
		Desc:   "把隧道流量封装成 WebSocket",
		Advise: "只能通过 HTTP 代理出网的环境",
		NeedTUN: true,
		Args: []string{
			"--default-protocol", "ws",
		},
	},
	{
		ID:     "wss",
		Name:   "WSS",
		Group:  GroupProtocol,
		Desc:   "WebSocket over TLS",
		Advise: "需要绕过深度包检测的严格网络",
		NeedTUN: true,
		Args: []string{
			"--default-protocol", "wss",
		},
	},
	{
		ID:     "faketcp",
		Name:   "FakeTCP",
		Group:  GroupProtocol,
		Desc:   "用原始套接字伪造 TCP 握手，实际走 UDP 载荷",
		Advise: "UDP 被 QoS 限速或封锁时穿透力最强，需要管理员权限",
		NeedTUN: true,
		Args: []string{
			"--default-protocol", "faketcp",
		},
	},
	{
		ID:     "ipv6",
		Name:   "IPv6 优先",
		Group:  GroupNetwork,
		Desc:   "显式启用 IPv6，双方都有公网 v6 时直连",
		Advise: "电信联通家宽常见 /64 前缀，直连延迟最低且免中继",
		NeedTUN: true,
		Args: []string{
			"--disable-ipv6", "false",
			"--default-protocol", "udp",
		},
	},
	{
		ID:     "lossy",
		Name:   "高丢包优化",
		Group:  GroupNetwork,
		Desc:   "KCP 代理 + zstd 压缩，专治丢包和带宽抖动",
		Advise: "移动网络、跨境链路丢包 2% 以上时明显改善",
		NeedTUN: true,
		Args: []string{
			"--enable-kcp-proxy", "true",
			"--compression", "zstd",
		},
	},
	{
		ID:     "lowlatency",
		Name:   "极低延迟",
		Group:  GroupNetwork,
		Desc:   "延迟优先选路，关闭额外代理层",
		Advise: "同城或同省联机，追求最低操作延迟",
		NeedTUN: true,
		Args: []string{
			"--latency-first", "true",
			"--enable-kcp-proxy", "false",
			"--compression", "none",
		},
	},
	{
		ID:     "lan",
		Name:   "同局域网",
		Group:  GroupNetwork,
		Desc:   "双方在同一内网，直接指定对端地址",
		Advise: "同一个路由器下的设备，无需打洞与中继",
		NeedTUN: true,
		Args:   nil, // 由 args.go 根据手动地址生成
	},
	{
		ID:     "notun",
		Name:   "免虚拟网卡",
		Group:  GroupSpecial,
		Desc:   "不创建 TUN 设备，用端口转发把 25565 映射过去",
		Advise: "不想安装网卡驱动或没有管理员权限时使用，MC 连 127.0.0.1:25565",
		// --no-tun 由 args.go 根据 NeedTUN 统一注入，此处只保留端口转发规则。
		NeedTUN: false,
		Args: []string{
			"--port-forward", "tcp://127.0.0.1:25565/{host}:25565",
		},
	},
}

// Get 按 ID 查找方案，找不到时回落到 auto。
func Get(id string) Profile {
	for _, p := range all {
		if p.ID == id {
			return p
		}
	}
	return all[0]
}

// List 返回全部方案，按分组顺序排列。
func List() []Profile {
	out := make([]Profile, len(all))
	copy(out, all)
	order := map[string]int{GroupRecommended: 0, GroupProtocol: 1, GroupNetwork: 2, GroupSpecial: 3}
	sort.SliceStable(out, func(i, j int) bool {
		return order[out[i].Group] < order[out[j].Group]
	})
	return out
}

// Expand 展开参数占位符。host 为房主虚拟 IP。
func Expand(p Profile, host string) []string {
	out := make([]string, 0, len(p.Args))
	for _, a := range p.Args {
		out = append(out, strings.ReplaceAll(a, "{host}", host))
	}
	return out
}

// Validate 检查方案 ID 是否合法。
func Validate(id string) error {
	for _, p := range all {
		if p.ID == id {
			return nil
		}
	}
	return fmt.Errorf("未知的联机方案: %s", id)
}
