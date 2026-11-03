package et

import (
	"bufio"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// State 表示组网进程的宏观状态。
type State string

const (
	StateIdle    State = "idle"
	StateStart   State = "starting"
	StateRunning State = "running"
	StateStop    State = "stopping"
	StateFailed  State = "failed"
)

// Status 是暴露给界面与启动器的运行时快照。
type Status struct {
	State     State  `json:"state"`
	Room      string `json:"room"`
	Network   string `json:"network"`
	IsHost    bool   `json:"is_host"`
	SelfIP    string `json:"self_ip"`
	HostIP    string `json:"host_ip"`
	Profile   string `json:"profile"`
	PID       int    `json:"pid"`
	StartedAt int64  `json:"started_at"`
	UptimeSec int64  `json:"uptime_sec"`
	// MCAddress 是玩家应填入客户端的目标地址。
	MCAddress string `json:"mc_address"`
	// LocalMCPort 在免虚拟网卡方案下监听本地端口，MC 连 127.0.0.1。
	LocalMCPort int    `json:"local_mc_port"`
	Error       string `json:"error,omitempty"`
	LanDiscover bool   `json:"lan_discover"`
}

// Manager 负责 easytier-core 的启停与日志采集。
type Manager struct {
	mu       sync.RWMutex
	cmd      *exec.Cmd
	spec     Spec
	status   Status
	logs     *Ring
	done     chan struct{}
	waiting  bool
	stopping bool
	fatalErr string
}

// NewManager 创建管理器。logLines 为环形日志保留行数。
func NewManager(logLines int) *Manager {
	return &Manager{
		status: Status{State: StateIdle},
		logs:   NewRing(logLines),
	}
}

// ErrAlreadyRunning 表示已有实例在运行。
var ErrAlreadyRunning = errors.New("组网已在运行中，请先断开")

// Start 启动组网进程。
func (m *Manager) Start(s Spec) error {
	m.mu.Lock()
	if m.status.State == StateRunning || m.status.State == StateStart {
		m.mu.Unlock()
		return ErrAlreadyRunning
	}

	core := filepath.Join(s.BinDir, exeName("easytier-core"))
	if _, err := os.Stat(core); err != nil {
		m.mu.Unlock()
		return fmt.Errorf("找不到 easytier-core: %s", core)
	}
	if err := os.MkdirAll(s.LogDir, 0o755); err != nil {
		m.mu.Unlock()
		return fmt.Errorf("创建日志目录失败: %w", err)
	}

	args := BuildArgs(s)
	m.logs.Add(fmt.Sprintf("[%s] $ easytier-core %s", stamp(), strings.Join(args, " ")))

	cmd := exec.Command(core, args...)
	cmd.Dir = s.BinDir
	applySysProc(cmd)

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		m.mu.Unlock()
		return err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		m.mu.Unlock()
		return err
	}

	m.status = Status{
		State:       StateStart,
		Room:        s.Room.ID,
		Network:     s.Room.Network,
		IsHost:      s.IsHost,
		SelfIP:      s.SelfIP,
		HostIP:      s.HostIP,
		Profile:     s.Profile.ID,
		StartedAt:   time.Now().Unix(),
		MCAddress:   fmt.Sprintf("%s:25565", s.HostIP),
		LanDiscover: s.Opts.EnableUDPBroadcastRelay && s.Profile.NeedTUN,
	}
	if !s.Profile.NeedTUN {
		m.status.MCAddress = "127.0.0.1:25565"
		m.status.LocalMCPort = 25565
	}

	m.spec = s
	m.cmd = cmd
	m.done = make(chan struct{})
	m.waiting = true
	m.stopping = false
	m.fatalErr = ""

	if err := cmd.Start(); err != nil {
		m.status.State = StateFailed
		m.status.Error = err.Error()
		m.waiting = false
		m.mu.Unlock()
		return fmt.Errorf("启动 easytier-core 失败: %w", err)
	}
	m.status.PID = cmd.Process.Pid
	m.mu.Unlock()

	go m.pump(stdout)
	go m.pump(stderr)
	go m.reap(cmd)
	return nil
}

// pump 按行采集子进程输出，带方向标记与时间戳。
func (m *Manager) pump(r io.Reader) {
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for sc.Scan() {
		line := sc.Text()
		m.logs.Add(fmt.Sprintf("[%s] %s", stamp(), line))
		m.inspect(line)
	}
}

// inspect 识别那些「进程还活着但本次组网注定失败」的错误。
// 典型场景是普通权限下创建虚拟网卡被系统拒绝，
// 此时若不主动终止，进程会一直重试，界面停在"正在连接"。
func (m *Manager) inspect(line string) {
	switch {
	case strings.Contains(line, "virtual_nic: An error occurred"):
		m.failFast("创建虚拟网卡失败，需以管理员身份重新启动")
	case strings.Contains(line, "network_secret") && strings.Contains(line, "mismatch"):
		m.failFast("房间口令与对端不一致")
	}
}

// failFast 记录致命错误并结束进程。这里不能调用 Stop，
// 因为 Stop 需要重新获取已在 inspect 路径上持有的锁。
func (m *Manager) failFast(msg string) {
	m.mu.Lock()
	if m.fatalErr != "" || !m.waiting {
		m.mu.Unlock()
		return
	}
	m.fatalErr = msg
	var proc *os.Process
	if m.cmd != nil {
		proc = m.cmd.Process
	}
	m.mu.Unlock()

	if proc != nil {
		_ = proc.Kill()
	}
}

// reap 等待进程退出并更新状态。这里是唯一把状态从 running 改回 idle 的地方。
func (m *Manager) reap(cmd *exec.Cmd) {
	err := cmd.Wait()

	m.mu.Lock()
	defer m.mu.Unlock()

	if !m.waiting {
		return
	}
	m.waiting = false
	m.cmd = nil
	close(m.done)

	switch {
	case m.stopping:
		// 用户主动断开，退出码非零是预期行为，不应标记为失败。
		m.status.State = StateIdle
		m.status.Error = ""
		m.logs.Add(fmt.Sprintf("[%s] 已断开", stamp()))
	case m.fatalErr != "":
		m.status.State = StateFailed
		m.status.Error = m.fatalErr
		m.logs.Add(fmt.Sprintf("[%s] 已终止: %s", stamp(), m.fatalErr))
	case err != nil:
		m.status.State = StateFailed
		m.status.Error = err.Error()
		m.logs.Add(fmt.Sprintf("[%s] 进程退出: %v", stamp(), err))
	default:
		m.status.State = StateIdle
		m.status.Error = ""
		m.logs.Add(fmt.Sprintf("[%s] 进程已退出", stamp()))
	}
	m.status.PID = 0
	m.status.MCAddress = ""
	m.status.LocalMCPort = 0
}

// Stop 终止组网进程。超时后强制结束，避免界面卡住。
func (m *Manager) Stop() error {
	m.mu.Lock()
	cmd := m.cmd
	done := m.done
	if cmd == nil || cmd.Process == nil {
		m.status.State = StateIdle
		m.mu.Unlock()
		return nil
	}
	m.status.State = StateStop
	m.stopping = true
	m.mu.Unlock()

	_ = cmd.Process.Kill()

	select {
	case <-done:
	case <-time.After(5 * time.Second):
		return errors.New("终止 easytier-core 超时")
	}
	return nil
}

// Status 返回当前状态副本，并实时计算运行时长。
func (m *Manager) Status() Status {
	m.mu.RLock()
	defer m.mu.RUnlock()
	out := m.status
	if out.StartedAt > 0 && (out.State == StateRunning || out.State == StateStart) {
		out.UptimeSec = time.Now().Unix() - out.StartedAt
	}
	return out
}

// Spec 返回最近一次启动使用的配置，供 CLI 查询使用。
func (m *Manager) Spec() Spec {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.spec
}

// Logs 返回最近的日志行。
func (m *Manager) Logs() []string { return m.logs.Snapshot() }

// MarkRunning 由健康检查调用：CLI 能查到自身节点即视为真正就绪。
func (m *Manager) MarkRunning() {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.status.State == StateStart {
		m.status.State = StateRunning
	}
}

func stamp() string { return time.Now().Format("15:04:05") }

func exeName(base string) string {
	if isWindows() {
		return base + ".exe"
	}
	return base
}

// Ring 是固定容量的环形日志缓冲，超出后覆盖最旧的行。
type Ring struct {
	mu    sync.Mutex
	buf   []string
	size  int
	pos   int
	count int
}

// NewRing 创建环形缓冲。
func NewRing(size int) *Ring {
	if size <= 0 {
		size = 2000
	}
	return &Ring{buf: make([]string, size), size: size}
}

// Add 追加一行日志。
func (r *Ring) Add(line string) {
	r.mu.Lock()
	r.buf[r.pos] = line
	r.pos = (r.pos + 1) % r.size
	if r.count < r.size {
		r.count++
	}
	r.mu.Unlock()
}

// Snapshot 按时间正序返回全部日志。
func (r *Ring) Snapshot() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]string, 0, r.count)
	start := (r.pos - r.count + r.size) % r.size
	for i := 0; i < r.count; i++ {
		out = append(out, r.buf[(start+i)%r.size])
	}
	return out
}
