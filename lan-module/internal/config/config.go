// Package config 负责模块配置的加载、校验与原子持久化。
// 配置文件是启动器与联机模块之间的唯一持久状态，格式变更必须保持向后兼容。
package config

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// BuiltinNodeID 是官方公共节点的固定标识，用户不可删除。
const BuiltinNodeID = "official"

// BuiltinNodeAddr 是 EasyTier 官方公共节点。
const BuiltinNodeAddr = "public.easytier.cn:11010"

// Node 描述一个可用于发现对等节点的入口。
type Node struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Addr    string `json:"addr"`
	Builtin bool   `json:"builtin"`
	Enabled bool   `json:"enabled"`
	// Note 给用户看的备注，例如自建节点的机房位置。
	Note string `json:"note,omitempty"`
}

// Options 是传给 easytier-core 的全局调优项。
// 这里只暴露对 MC 联机有实际影响的开关，其余保持 EasyTier 默认值。
type Options struct {
	// EnableUDPBroadcastRelay 仅 Windows 生效，把物理网卡的 UDP 广播转发进虚拟网络，
	// 让 MC 的「对局域网开放」可以被自动发现。需要管理员权限。
	EnableUDPBroadcastRelay bool `json:"enable_udp_broadcast_relay"`
	// EnableKCPProxy 在丢包链路上用 KCP 代理 TCP 流，对跨境/移动网络改善明显。
	EnableKCPProxy bool `json:"enable_kcp_proxy"`
	// EnableQUICProxy 与 KCP 二选一或并存，QUIC 在部分线路上表现更好。
	EnableQUICProxy bool `json:"enable_quic_proxy"`
	// LatencyFirst 让路由选择按延迟而非跳数，P2P 与中继混合时更优。
	LatencyFirst bool `json:"latency_first"`
	// Compression 取 none 或 zstd。
	Compression string `json:"compression"`
	// MTU 为 0 时使用 EasyTier 默认值（加密 1360）。
	MTU int `json:"mtu"`
	// Encryption 取 aes-gcm / aes-256-gcm / chacha20。
	Encryption string `json:"encryption"`
	// RPCPortal 是 easytier-cli 连接本实例的端口。
	RPCPortal int `json:"rpc_portal"`
	// LogLevel 控制写入文件的日志级别，debug/info/warn/error。
	LogLevel string `json:"log_level"`
}

// Config 是模块的根配置。
type Config struct {
	Version int    `json:"version"`
	Nodes   []Node `json:"nodes"`
	// Profile 是上次使用的联机方案 ID。
	Profile string `json:"profile"`
	// VirtualCIDR 决定虚拟网段，默认 10.126.126.0/24。
	VirtualCIDR string `json:"virtual_cidr"`
	// LastRoom 记录上次输入的房间号，方便复用。
	LastRoom string  `json:"last_room"`
	Options  Options `json:"options"`
}

// Store 提供并发安全的配置读写。
type Store struct {
	mu   sync.RWMutex
	path string
	cfg  Config
}

// Default 返回初始配置。首次启动时写入磁盘。
func Default() Config {
	return Config{
		Version:     1,
		Profile:     "auto",
		VirtualCIDR: "10.126.126.0/24",
		Nodes: []Node{
			{
				ID:      BuiltinNodeID,
				Name:    "EasyTier 官方节点",
				Addr:    BuiltinNodeAddr,
				Builtin: true,
				Enabled: true,
				Note:    "官方公共节点，免维护但高峰期可能拥塞",
			},
		},
		Options: Options{
			EnableUDPBroadcastRelay: true,
			EnableKCPProxy:          true,
			EnableQUICProxy:         false,
			LatencyFirst:            true,
			Compression:             "none",
			MTU:                     0,
			Encryption:              "aes-gcm",
			RPCPortal:               15888,
			LogLevel:                "info",
		},
	}
}

// Open 加载配置文件；不存在时创建默认配置。
func Open(path string) (*Store, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return nil, fmt.Errorf("创建配置目录失败: %w", err)
	}

	s := &Store{path: path, cfg: Default()}

	raw, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		if err := s.persist(); err != nil {
			return nil, err
		}
		return s, nil
	}
	if err != nil {
		return nil, fmt.Errorf("读取配置失败: %w", err)
	}
	if err := json.Unmarshal(raw, &s.cfg); err != nil {
		// 配置损坏时不让整个模块起不来：备份原文件后回落到默认值。
		_ = os.Rename(path, path+".corrupt-"+time.Now().Format("20060102-150405"))
		s.cfg = Default()
		if err := s.persist(); err != nil {
			return nil, err
		}
	}
	s.normalize()
	return s, nil
}

// normalize 补齐历史配置里缺失的字段。
func (s *Store) normalize() {
	if s.cfg.Version == 0 {
		s.cfg.Version = 1
	}
	if s.cfg.VirtualCIDR == "" {
		s.cfg.VirtualCIDR = "10.126.126.0/24"
	}
	if s.cfg.Profile == "" {
		s.cfg.Profile = "auto"
	}
	if s.cfg.Options.Encryption == "" {
		s.cfg.Options.Encryption = "aes-gcm"
	}
	if s.cfg.Options.Compression == "" {
		s.cfg.Options.Compression = "none"
	}
	if s.cfg.Options.RPCPortal == 0 {
		s.cfg.Options.RPCPortal = 15888
	}
	if s.cfg.Options.LogLevel == "" {
		s.cfg.Options.LogLevel = "info"
	}

	// 官方节点必须存在且不可删除，否则用户误删后会失去默认引导节点。
	hasBuiltin := false
	for _, n := range s.cfg.Nodes {
		if n.ID == BuiltinNodeID {
			hasBuiltin = true
			break
		}
	}
	if !hasBuiltin {
		d := Default()
		s.cfg.Nodes = append([]Node{d.Nodes[0]}, s.cfg.Nodes...)
	}
}

// Snapshot 返回配置副本，调用方可安全修改。
func (s *Store) Snapshot() Config {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := s.cfg
	out.Nodes = append([]Node(nil), s.cfg.Nodes...)
	return out
}

// Update 在写锁内应用变更函数并落盘。
func (s *Store) Update(fn func(*Config) error) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := fn(&s.cfg); err != nil {
		return err
	}
	s.normalize()
	return s.persist()
}

// persist 用临时文件 + rename 保证写入原子性，避免断电留下半截 JSON。
func (s *Store) persist() error {
	raw, err := json.MarshalIndent(s.cfg, "", "  ")
	if err != nil {
		return err
	}
	tmp := s.path + ".tmp"
	if err := os.WriteFile(tmp, raw, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, s.path)
}

// EnabledNodes 返回当前启用的节点地址列表，保持配置顺序。
func (s *Store) EnabledNodes() []string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]string, 0, len(s.cfg.Nodes))
	for _, n := range s.cfg.Nodes {
		if n.Enabled && n.Addr != "" {
			out = append(out, n.Addr)
		}
	}
	return out
}
