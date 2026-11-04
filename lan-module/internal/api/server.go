// Package api 提供本地 HTTP 接口与内置 Web 控制台。
// 启动器通过同一组接口驱动联机模块，Web 界面只是这些接口的一个消费者。
package api

import (
	"encoding/json"
	"io/fs"
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"mclab-lan/internal/config"
	"mclab-lan/internal/et"
)

// Server 持有接口所需的依赖。
type Server struct {
	cfg  *config.Store
	mgr  *et.Manager
	web  fs.FS
	mu   sync.Mutex
	bin  string
	data string
}

// New 创建服务。webFS 为前端静态资源根目录，startedAt 用于计算运行时长。
func New(cfg *config.Store, mgr *et.Manager, webFS fs.FS, binDir, dataDir string) *Server {
	return &Server{cfg: cfg, mgr: mgr, web: webFS, bin: binDir, data: dataDir}
}

// Handler 注册全部路由。
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()

	mux.HandleFunc("GET /api/ping", s.handlePing)
	mux.HandleFunc("GET /api/config", s.handleGetConfig)
	mux.HandleFunc("PATCH /api/config", s.handlePatchConfig)

	mux.HandleFunc("GET /api/profiles", s.handleProfiles)
	mux.HandleFunc("GET /api/nodeinfo", s.handleNodeInfo)

	mux.HandleFunc("GET /api/nodes", s.handleListNodes)
	mux.HandleFunc("POST /api/nodes", s.handleAddNode)
	mux.HandleFunc("DELETE /api/nodes/{id}", s.handleDeleteNode)
	mux.HandleFunc("POST /api/nodes/{id}/toggle", s.handleToggleNode)
	mux.HandleFunc("POST /api/nodes/test", s.handleTestNode)

	mux.HandleFunc("GET /api/room/new", s.handleNewRoom)
	mux.HandleFunc("POST /api/room/preview", s.handlePreviewRoom)

	mux.HandleFunc("GET /api/status", s.handleStatus)
	mux.HandleFunc("POST /api/join", s.handleJoin)
	mux.HandleFunc("POST /api/leave", s.handleLeave)
	mux.HandleFunc("GET /api/peers", s.handlePeers)
	mux.HandleFunc("GET /api/diagnostics", s.handleDiagnostics)
	mux.HandleFunc("GET /api/logs", s.handleLogs)
	mux.HandleFunc("GET /api/events", s.handleEvents)

	// 静态资源兜底，未命中的路径交给前端路由。
	mux.HandleFunc("GET /", s.handleStatic)

	return s.guard(mux)
}

// guard 只接受本机来源，并要求自定义请求头。
// 浏览器跨站请求无法伪造 X-MCLab 头（会触发预检且预检被拒绝），
// 因此这一层能挡住恶意网页对本地服务的调用。
func (s *Server) guard(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		host, _, err := net.SplitHostPort(r.RemoteAddr)
		if err != nil || (host != "127.0.0.1" && host != "::1") {
			http.Error(w, "仅允许本机访问", http.StatusForbidden)
			return
		}
		if strings.HasPrefix(r.URL.Path, "/api/") && r.Method != http.MethodGet {
			if r.Header.Get("X-MCLab") == "" {
				http.Error(w, "缺少请求标识", http.StatusForbidden)
				return
			}
		}
		w.Header().Set("Cache-Control", "no-store")
		next.ServeHTTP(w, r)
	})
}

func (s *Server) handleStatic(w http.ResponseWriter, r *http.Request) {
	name := strings.TrimPrefix(r.URL.Path, "/")
	if name == "" {
		name = "index.html"
	}
	data, err := fs.ReadFile(s.web, name)
	if err != nil {
		// 单页应用：未知路径回落到 index.html。
		data, err = fs.ReadFile(s.web, "index.html")
		if err != nil {
			http.NotFound(w, r)
			return
		}
		name = "index.html"
	}
	w.Header().Set("Content-Type", contentType(name))
	_, _ = w.Write(data)
}

func contentType(name string) string {
	switch {
	case strings.HasSuffix(name, ".html"):
		return "text/html; charset=utf-8"
	case strings.HasSuffix(name, ".js"):
		return "application/javascript; charset=utf-8"
	case strings.HasSuffix(name, ".css"):
		return "text/css; charset=utf-8"
	case strings.HasSuffix(name, ".svg"):
		return "image/svg+xml"
	case strings.HasSuffix(name, ".png"):
		return "image/png"
	case strings.HasSuffix(name, ".json"):
		return "application/json; charset=utf-8"
	default:
		return "application/octet-stream"
	}
}

// --- 通用响应 ---

type apiError struct {
	Error string `json:"error"`
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, code int, msg string) {
	writeJSON(w, code, apiError{Error: msg})
}

func decode(r *http.Request, v any) error {
	dec := json.NewDecoder(http.MaxBytesReader(nil, r.Body, 1<<20))
	dec.DisallowUnknownFields()
	return dec.Decode(v)
}

func (s *Server) handlePing(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":      true,
		"service": "mclab-lan",
		"version": Version,
		"time":    time.Now().Unix(),
	})
}

// Version 由构建时注入。
var Version = "dev"

func atoiOr(s string, def int) int {
	if n, err := strconv.Atoi(s); err == nil {
		return n
	}
	return def
}
