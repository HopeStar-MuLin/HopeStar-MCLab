package et

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// Peer 是 easytier-cli peer 解析后的结果，字段已做归一化。
type Peer struct {
	IP        string  `json:"ip"`
	Hostname  string  `json:"hostname"`
	Cost      string  `json:"cost"` // p2p 或 relay
	LatencyMS float64 `json:"latency_ms"`
	LossRate  float64 `json:"loss_rate"`
	RXBytes   int64   `json:"rx_bytes"`
	TXBytes   int64   `json:"tx_bytes"`
	Proto     string  `json:"proto"`
	NATType   string  `json:"nat_type"`
	Version   string  `json:"version"`
}

// Direct 表示这条连接是否点对点直连。
func (p Peer) Direct() bool { return strings.EqualFold(p.Cost, "p2p") }

// Peers 读取当前对等节点列表。进程未运行时返回空列表而非错误，
// 界面按「无数据」处理即可。
func (m *Manager) Peers(ctx context.Context) ([]Peer, error) {
	raw, err := m.runCLI(ctx, "peer")
	if err != nil {
		return nil, err
	}
	var rows []map[string]any
	if err := json.Unmarshal(extractJSON(raw, '['), &rows); err != nil {
		return nil, fmt.Errorf("解析 peer 输出失败: %w", err)
	}

	out := make([]Peer, 0, len(rows))
	for _, r := range rows {
		out = append(out, Peer{
			IP:        pickStr(r, "ipv4", "ip", "virtual_ip"),
			Hostname:  pickStr(r, "hostname", "host_name", "name"),
			Cost:      normalCost(pickStr(r, "cost", "route_cost", "path")),
			LatencyMS: pickFloat(r, "lat_ms", "latency_ms", "latency", "rtt"),
			LossRate:  pickLoss(r),
			RXBytes:   pickInt(r, "rx_bytes", "rx", "recv_bytes"),
			TXBytes:   pickInt(r, "tx_bytes", "tx", "send_bytes"),
			Proto:     pickStr(r, "tunnel_proto", "proto", "protocol"),
			NATType:   pickStr(r, "nat_type", "nat"),
			Version:   pickStr(r, "version"),
		})
	}
	return out, nil
}

// STUNResult 是对公网映射的探测结果，用于判断 NAT 类型和打洞前景。
type STUNResult struct {
	NATType  string `json:"nat_type"`
	PublicIP string `json:"public_ip"`
	Raw      string `json:"raw,omitempty"`
}

// STUN 调用 easytier-cli stun 做一次 NAT 类型探测。
func (m *Manager) STUN(ctx context.Context) (STUNResult, error) {
	raw, err := m.runCLI(ctx, "stun")
	if err != nil {
		return STUNResult{}, err
	}
	var r struct {
		NATType  string `json:"nat_type"`
		PublicIP string `json:"public_ip"`
	}
	if err := json.Unmarshal(extractJSON(raw, '{'), &r); err == nil && r.NATType != "" {
		return STUNResult{NATType: r.NATType, PublicIP: r.PublicIP}, nil
	}
	// 旧版本可能只输出纯文本，退化成原文透传。
	return STUNResult{Raw: strings.TrimSpace(string(raw))}, nil
}

// runCLI 执行 easytier-cli 并返回标准输出。
func (m *Manager) runCLI(ctx context.Context, args ...string) ([]byte, error) {
	bin := filepath.Join(m.Spec().BinDir, exeName("easytier-cli"))
	port := m.Spec().Opts.RPCPortal
	if port == 0 {
		port = 15888
	}

	full := append([]string{"-p", fmt.Sprintf("127.0.0.1:%d", port), "-o", "json"}, args...)
	ctx, cancel := context.WithTimeout(ctx, 4*time.Second)
	defer cancel()

	cmd := exec.CommandContext(ctx, bin, full...)
	applySysProc(cmd)

	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		msg := strings.TrimSpace(stderr.String())
		if msg == "" {
			msg = err.Error()
		}
		return nil, fmt.Errorf("easytier-cli %s 失败: %s", strings.Join(args, " "), msg)
	}
	return stdout.Bytes(), nil
}

// extractJSON 跳过 CLI 可能打印的前置日志，定位到 JSON 起始位置。
func extractJSON(raw []byte, open byte) []byte {
	i := bytes.IndexByte(raw, open)
	if i < 0 {
		return raw
	}
	return raw[i:]
}

func normalCost(s string) string {
	s = strings.ToLower(s)
	switch {
	case s == "local":
		return "local"
	case strings.Contains(s, "p2p"), strings.Contains(s, "direct"):
		return "p2p"
	case s == "", s == "-":
		return ""
	default:
		return "relay"
	}
}

func pickStr(m map[string]any, keys ...string) string {
	for _, k := range keys {
		if v, ok := m[k]; ok {
			switch t := v.(type) {
			case string:
				if t != "" {
					return t
				}
			case float64:
				return strconv.FormatFloat(t, 'f', -1, 64)
			}
		}
	}
	return ""
}

func pickFloat(m map[string]any, keys ...string) float64 {
	for _, k := range keys {
		v, ok := m[k]
		if !ok {
			continue
		}
		switch t := v.(type) {
		case float64:
			return t
		case string:
			if f, err := strconv.ParseFloat(strings.TrimSuffix(t, "ms"), 64); err == nil {
				return f
			}
		}
	}
	return 0
}

func pickInt(m map[string]any, keys ...string) int64 {
	for _, k := range keys {
		v, ok := m[k]
		if !ok {
			continue
		}
		switch t := v.(type) {
		case float64:
			return int64(t)
		case string:
			if n, err := strconv.ParseInt(t, 10, 64); err == nil {
				return n
			}
		}
	}
	return 0
}

// pickLoss 兼容 0.01 与 "1%" 两种表示。
func pickLoss(m map[string]any) float64 {
	v := pickFloat(m, "loss_rate", "loss", "packet_loss")
	if v > 0 && v < 1 {
		return v * 100
	}
	return v
}

// NATTypeName 把 EasyTier 的枚举值翻译成可读名称。
// 枚举顺序取自 easytier 的 NatType 定义，数值越大穿透越难。
func NATTypeName(v int) string {
	names := map[int]string{
		0: "Unknown",
		1: "OpenInternet",
		2: "NoPat",
		3: "FullCone",
		4: "Restricted",
		5: "PortRestricted",
		6: "Symmetric",
		7: "SymmetricEasy",
		8: "SymmetricHard",
	}
	if n, ok := names[v]; ok {
		return n
	}
	return "Unknown"
}

// NATInfo 是本机的公网映射信息。
type NATInfo struct {
	UDPNatType int      `json:"udp_nat_type"`
	TCPNatType int      `json:"tcp_nat_type"`
	PublicIP   []string `json:"public_ip"`
	MinPort    int      `json:"min_port"`
	MaxPort    int      `json:"max_port"`
}

// Stable 表示两次探测拿到同一个端口，说明 NAT 映射稳定，
// 这是锥型 NAT 的典型特征，打洞成功率显著高于对称型。
func (n NATInfo) Stable() bool { return n.MinPort > 0 && n.MinPort == n.MaxPort }

// NodeStatus 对应 easytier-cli node 的输出。
type NodeStatus struct {
	PeerID    uint64   `json:"peer_id"`
	IPv4      string   `json:"ipv4_addr"`
	Hostname  string   `json:"hostname"`
	STUN      NATInfo  `json:"stun_info"`
	Listeners []string `json:"listeners"`
	Version   string   `json:"version"`
}

// Node 读取本节点的运行信息，包含 NAT 类型与公网地址。
func (m *Manager) Node(ctx context.Context) (NodeStatus, error) {
	raw, err := m.runCLI(ctx, "node")
	if err != nil {
		return NodeStatus{}, err
	}
	var out NodeStatus
	if err := json.Unmarshal(extractJSON(raw, '{'), &out); err != nil {
		return NodeStatus{}, fmt.Errorf("解析 node 输出失败: %w", err)
	}
	return out, nil
}
