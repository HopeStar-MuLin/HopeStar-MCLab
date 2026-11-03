package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"time"

	"mclab-lan/internal/config"
	"mclab-lan/internal/et"
	"mclab-lan/internal/profile"
	"mclab-lan/internal/room"
)

func (s *Server) handleStatus(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, s.mgr.Status())
}

type joinReq struct {
	Room     string `json:"room"`
	Password string `json:"password"`
	// Host 为 true 表示本机开服，占用虚拟网段第一个地址。
	Host bool `json:"host"`
	// Profile 留空时使用配置中的默认方案。
	Profile string `json:"profile,omitempty"`
	// ManualPeer 仅「同局域网」方案使用，形如 192.168.1.10:11010。
	ManualPeer string `json:"manual_peer,omitempty"`
}

func (s *Server) handleJoin(w http.ResponseWriter, r *http.Request) {
	var req joinReq
	if err := decode(r, &req); err != nil {
		writeErr(w, http.StatusBadRequest, "请求格式错误: "+err.Error())
		return
	}

	rm, err := room.Derive(req.Room, req.Password)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}

	cfg := s.cfg.Snapshot()
	profileID := req.Profile
	if profileID == "" {
		profileID = cfg.Profile
	}
	if err := profile.Validate(profileID); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	p := profile.Get(profileID)

	if p.ID == "lan" && req.ManualPeer == "" {
		writeErr(w, http.StatusBadRequest, "同局域网方案需要填写对端内网地址")
		return
	}
	if req.ManualPeer != "" {
		if err := validateAddr(req.ManualPeer); err != nil {
			writeErr(w, http.StatusBadRequest, "对端地址无效: "+err.Error())
			return
		}
	}

	hostname, err := os.Hostname()
	if err != nil || hostname == "" {
		hostname = "mclab-pc"
	}
	addr, err := room.Allocate(cfg.VirtualCIDR, rm.ID, hostname, req.Host)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}

	// 切换房间时先结束旧实例，避免两个进程争抢 11010 端口与 RPC 门户。
	if st := s.mgr.Status(); st.State != et.StateIdle {
		_ = s.mgr.Stop()
	}

	_ = s.cfg.Update(func(c *config.Config) error {
		c.LastRoom = req.Room
		c.Profile = profileID
		return nil
	})

	spec := et.Spec{
		Room:       rm,
		IsHost:     req.Host,
		SelfIP:     addr.Self,
		HostIP:     addr.Host,
		Peers:      s.cfg.EnabledNodes(),
		ManualPeer: req.ManualPeer,
		Profile:    p,
		Opts:       cfg.Options,
		Instance:   "mclab-lan",
		Hostname:   hostname,
		BinDir:     s.bin,
		LogDir:     filepath.Join(s.data, "logs"),
	}

	if err := s.mgr.Start(spec); err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}

	// RPC 门户通常在 1-2 秒内就绪，留 20 秒余量应对冷启动与杀软扫描。
	go s.waitReady(20 * time.Second)

	writeJSON(w, http.StatusOK, s.mgr.Status())
}

// waitReady 轮询 easytier-cli，一旦能读到自身节点就把状态推进到 running。
func (s *Server) waitReady(timeout time.Duration) {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		st := s.mgr.Status()
		if st.State != et.StateStart {
			return
		}
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		_, err := s.mgr.Peers(ctx)
		cancel()
		if err == nil {
			s.mgr.MarkRunning()
			return
		}
		time.Sleep(400 * time.Millisecond)
	}
}

func (s *Server) handleLeave(w http.ResponseWriter, _ *http.Request) {
	if err := s.mgr.Stop(); err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, s.mgr.Status())
}

func (s *Server) handlePeers(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
	defer cancel()

	peers, err := s.mgr.Peers(ctx)
	if err != nil {
		writeJSON(w, http.StatusOK, map[string]any{"peers": []et.Peer{}, "error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"peers": peers})
}

// diagnostics 汇总本地环境的联机前景判断。
type diagnostics struct {
	NATType   string `json:"nat_type"`
	TCPType   string `json:"tcp_nat_type"`
	PublicIP  string `json:"public_ip"`
	StableMap bool   `json:"stable_mapping"`
	Admin     bool   `json:"admin"`
	Wintun    bool   `json:"wintun"`
	Hint      string `json:"hint"`
	Running   bool   `json:"running"`
}

func (s *Server) handleDiagnostics(w http.ResponseWriter, r *http.Request) {
	st := s.mgr.Status()
	out := diagnostics{
		Running: st.State == et.StateRunning || st.State == et.StateStart,
		Admin:   isAdmin(),
	}
	if _, err := os.Stat(filepath.Join(s.bin, "wintun.dll")); err == nil {
		out.Wintun = true
	}

	if out.Running {
		ctx, cancel := context.WithTimeout(r.Context(), 8*time.Second)
		node, err := s.mgr.Node(ctx)
		cancel()
		if err == nil {
			out.NATType = et.NATTypeName(node.STUN.UDPNatType)
			out.TCPType = et.NATTypeName(node.STUN.TCPNatType)
			if len(node.STUN.PublicIP) > 0 {
				out.PublicIP = node.STUN.PublicIP[0]
			}
			out.StableMap = node.STUN.Stable()
		}
	}
	out.Hint = natHint(out.NATType, out.StableMap)
	writeJSON(w, http.StatusOK, out)
}

// natHint 把 NAT 类型翻译成对打洞前景的判断，供界面直接展示。
// stable 表示两次 STUN 拿到同一端口，是对称型 NAT 的反面证据。
func natHint(t string, stable bool) string {
	switch t {
	case "", "Unknown":
		if stable {
			return "端口映射稳定，打洞前景良好"
		}
		return "先建立一次组网，才能探测 NAT 类型"
	case "OpenInternet", "NoPat":
		return "公网直连，无需打洞"
	case "FullCone":
		return "全锥型 NAT，打洞成功率接近 100%"
	case "Restricted":
		return "受限锥型 NAT，打洞成功率高"
	case "PortRestricted":
		if stable {
			return "端口受限锥型且映射稳定，双方同时发包即可直连"
		}
		return "端口受限锥型，打洞通常可行，失败时走中继"
	case "Symmetric", "SymmetricEasy":
		return "对称型 NAT，依赖端口预测，失败时走中继"
	case "SymmetricHard":
		return "严格对称型 NAT，打洞基本不可行，建议准备中继节点"
	default:
		return "NAT 类型: " + t
	}
}

func (s *Server) handleLogs(w http.ResponseWriter, r *http.Request) {
	lines := s.mgr.Logs()
	if tail := r.URL.Query().Get("tail"); tail != "" {
		if n := atoiOr(tail, 0); n > 0 && n < len(lines) {
			lines = lines[len(lines)-n:]
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"lines": lines})
}

// handleEvents 以 SSE 推送状态，界面据此刷新，避免轮询。
func (s *Server) handleEvents(w http.ResponseWriter, r *http.Request) {
	fl, ok := w.(http.Flusher)
	if !ok {
		writeErr(w, http.StatusInternalServerError, "不支持流式响应")
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")

	send := func() bool {
		payload, err := json.Marshal(s.mgr.Status())
		if err != nil {
			return false
		}
		if _, err := fmt.Fprintf(w, "event: status\ndata: %s\n\n", payload); err != nil {
			return false
		}
		fl.Flush()
		return true
	}

	if !send() {
		return
	}
	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case <-ticker.C:
			if !send() {
				return
			}
		}
	}
}

// natHint 把 NAT 类型翻译成对打洞前景的判断，供界面直接展示。