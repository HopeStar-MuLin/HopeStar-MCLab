package api

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"mclab-lan/internal/config"
	"mclab-lan/internal/profile"
	"mclab-lan/internal/room"
)

// configView 是对外暴露的配置视图，屏蔽内部字段。
type configView struct {
	Profile     string         `json:"profile"`
	VirtualCIDR string         `json:"virtual_cidr"`
	LastRoom    string         `json:"last_room"`
	Options     config.Options `json:"options"`
}

func (s *Server) handleGetConfig(w http.ResponseWriter, _ *http.Request) {
	c := s.cfg.Snapshot()
	writeJSON(w, http.StatusOK, configView{
		Profile:     c.Profile,
		VirtualCIDR: c.VirtualCIDR,
		LastRoom:    c.LastRoom,
		Options:     c.Options,
	})
}

type patchConfigReq struct {
	Profile     *string         `json:"profile,omitempty"`
	LastRoom    *string         `json:"last_room,omitempty"`
	VirtualCIDR *string         `json:"virtual_cidr,omitempty"`
	Options     *config.Options `json:"options,omitempty"`
}

func (s *Server) handlePatchConfig(w http.ResponseWriter, r *http.Request) {
	var req patchConfigReq
	if err := decode(r, &req); err != nil {
		writeErr(w, http.StatusBadRequest, "请求格式错误: "+err.Error())
		return
	}
	if req.Profile != nil {
		if err := profile.Validate(*req.Profile); err != nil {
			writeErr(w, http.StatusBadRequest, err.Error())
			return
		}
	}
	if req.VirtualCIDR != nil {
		if _, _, err := net.ParseCIDR(*req.VirtualCIDR); err != nil {
			writeErr(w, http.StatusBadRequest, "虚拟网段格式无效")
			return
		}
	}

	err := s.cfg.Update(func(c *config.Config) error {
		if req.Profile != nil {
			c.Profile = *req.Profile
		}
		if req.LastRoom != nil {
			c.LastRoom = *req.LastRoom
		}
		if req.VirtualCIDR != nil {
			c.VirtualCIDR = *req.VirtualCIDR
		}
		if req.Options != nil {
			c.Options = *req.Options
		}
		return nil
	})
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	s.handleGetConfig(w, r)
}

func (s *Server) handleProfiles(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, profile.List())
}

// nodeInfo 描述运行环境的能力，决定界面是否提示「以管理员身份运行」。
type nodeInfo struct {
	Admin        bool   `json:"admin"`
	Wintun       bool   `json:"wintun"`
	EasyTierVer  string `json:"easytier_version"`
	Platform     string `json:"platform"`
	BinDir       string `json:"bin_dir"`
	VirtualCIDR  string `json:"virtual_cidr"`
	VirtualHost  string `json:"virtual_host"`
}

func (s *Server) handleNodeInfo(w http.ResponseWriter, _ *http.Request) {
	c := s.cfg.Snapshot()
	addr, _ := room.Allocate(c.VirtualCIDR, "preview", "preview", true)

	wintun := false
	if _, err := os.Stat(filepath.Join(s.bin, "wintun.dll")); err == nil {
		wintun = true
	}

	writeJSON(w, http.StatusOK, nodeInfo{
		Admin:       isAdmin(),
		Wintun:      wintun,
		EasyTierVer: s.easytierVersion(),
		Platform:    platformName(),
		BinDir:      s.bin,
		VirtualCIDR: c.VirtualCIDR,
		VirtualHost: addr.Host,
	})
}

func (s *Server) easytierVersion() string {
	bin := filepath.Join(s.bin, exeSuffix("easytier-core"))
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, bin, "--version").Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}

// --- 节点管理 ---

func (s *Server) handleListNodes(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, s.cfg.Snapshot().Nodes)
}

type addNodeReq struct {
	Name string `json:"name"`
	Addr string `json:"addr"`
	Note string `json:"note"`
}

func (s *Server) handleAddNode(w http.ResponseWriter, r *http.Request) {
	var req addNodeReq
	if err := decode(r, &req); err != nil {
		writeErr(w, http.StatusBadRequest, "请求格式错误: "+err.Error())
		return
	}
	req.Addr = strings.TrimSpace(req.Addr)
	req.Name = strings.TrimSpace(req.Name)
	if req.Name == "" {
		req.Name = req.Addr
	}
	if err := validateAddr(req.Addr); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}

	id := fmt.Sprintf("n%d", time.Now().UnixNano())
	err := s.cfg.Update(func(c *config.Config) error {
		for _, n := range c.Nodes {
			if strings.EqualFold(n.Addr, req.Addr) {
				return fmt.Errorf("节点 %s 已存在", req.Addr)
			}
		}
		c.Nodes = append(c.Nodes, config.Node{
			ID: id, Name: req.Name, Addr: req.Addr, Enabled: true, Note: req.Note,
		})
		return nil
	})
	if err != nil {
		writeErr(w, http.StatusConflict, err.Error())
		return
	}
	s.handleListNodes(w, r)
}

func (s *Server) handleDeleteNode(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if id == config.BuiltinNodeID {
		writeErr(w, http.StatusBadRequest, "官方节点不可删除，可将其停用")
		return
	}
	err := s.cfg.Update(func(c *config.Config) error {
		out := c.Nodes[:0]
		for _, n := range c.Nodes {
			if n.ID != id {
				out = append(out, n)
			}
		}
		c.Nodes = out
		return nil
	})
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	s.handleListNodes(w, r)
}

func (s *Server) handleToggleNode(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	err := s.cfg.Update(func(c *config.Config) error {
		for i := range c.Nodes {
			if c.Nodes[i].ID == id {
				c.Nodes[i].Enabled = !c.Nodes[i].Enabled
				return nil
			}
		}
		return fmt.Errorf("节点不存在")
	})
	if err != nil {
		writeErr(w, http.StatusNotFound, err.Error())
		return
	}
	s.handleListNodes(w, r)
}

type testNodeReq struct {
	Addr string `json:"addr"`
}

// handleTestNode 做一次 TCP 拨号，只用于判断节点是否可达，
// 不代表 EasyTier 一定能通过它转发（那取决于 UDP 与密钥）。
func (s *Server) handleTestNode(w http.ResponseWriter, r *http.Request) {
	var req testNodeReq
	if err := decode(r, &req); err != nil {
		writeErr(w, http.StatusBadRequest, "请求格式错误")
		return
	}
	if err := validateAddr(req.Addr); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}

	start := time.Now()
	conn, err := net.DialTimeout("tcp", req.Addr, 4*time.Second)
	elapsed := time.Since(start).Milliseconds()
	if err != nil {
		writeJSON(w, http.StatusOK, map[string]any{
			"ok": false, "latency_ms": elapsed, "error": err.Error(),
		})
		return
	}
	_ = conn.Close()
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "latency_ms": elapsed})
}

// --- 房间 ---

func (s *Server) handleNewRoom(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"room": room.Generate()})
}

type previewReq struct {
	Room     string `json:"room"`
	Password string `json:"password"`
}

// handlePreviewRoom 展示房间派生出的网络标识，便于用户确认双方填的是同一个房间。
func (s *Server) handlePreviewRoom(w http.ResponseWriter, r *http.Request) {
	var req previewReq
	if err := decode(r, &req); err != nil {
		writeErr(w, http.StatusBadRequest, "请求格式错误")
		return
	}
	rm, err := room.Derive(req.Room, req.Password)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{
		"room":    rm.ID,
		"network": rm.Network,
	})
}

func validateAddr(addr string) error {
	if addr == "" {
		return fmt.Errorf("地址不能为空")
	}
	host, port, err := net.SplitHostPort(addr)
	if err != nil {
		return fmt.Errorf("地址需为 host:port 格式，例如 1.2.3.4:11010")
	}
	if host == "" {
		return fmt.Errorf("地址缺少主机部分")
	}
	if port != "11010" && port != "" {
		// EasyTier 默认监听 11010，其他端口也允许，仅做范围检查。
		if n := atoiOr(port, -1); n < 1 || n > 65535 {
			return fmt.Errorf("端口无效")
		}
	}
	return nil
}

func exeSuffix(base string) string {
	if runtime.GOOS == "windows" {
		return base + ".exe"
	}
	return base
}

func platformName() string {
	return runtime.GOOS
}
