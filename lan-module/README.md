# MCLab 联机模块

HopeStar-MCLab 的外部联机组件。基于 EasyTier 做 P2P 组网，把两个家宽背后的机器放进同一个虚拟网段，让 MC 像连局域网一样连上。

模块独立运行，以本地 HTTP 服务的形式暴露能力，内置 Web 控制台。

## 快速开始

### 1. 启动

双击 `run.cmd`（自动请求管理员权限），或命令行：

```
lan-module.exe
```

浏览器会自动打开 `http://127.0.0.1:38999`。

以管理员身份运行才能创建虚拟网卡。普通权限下仍可使用「免虚拟网卡」方案，只是不能进局域网自动发现。

### 2. 组网

房主（开服的人）：

1. 点「随机生成」拿到房间号，或自己填一个
2. 填「房间口令」（可选，双方要一致）
3. 选方案，默认「智能直连」
4. 点「创建房间（我开服）」
5. 在 MC 里开服，`server.properties` 里 `server-ip` 留空

朋友：

1. 填同一个房间号与口令
2. 选同一个方案
3. 点「加入房间」
4. MC 多人游戏里添加服务器，地址填界面显示的 `MC 地址`

房主自己的 MC 也可以直接连 `10.126.126.1:25565`。

### 3. 确认连接方式

「连接状态」里每个对等节点后面会标 **直连** 或 **中继**。

- 直连：延迟等于物理链路，玩起来和本地没差别
- 中继：数据经过引导节点转发，延迟取决于节点位置

点「网络诊断」可以看本机 NAT 类型，判断打洞前景。

## 联机方案

不同网络环境需要不同的穿透策略。方案之间可以随时切换，重连生效。

| 方案 | 适用场景 | 说明 |
|---|---|---|
| 智能直连 | 默认 | UDP 打洞优先，失败自动降级中继 |
| 强制直连 | 双方 NAT 友好 | 打洞失败就直接连不上，但延迟最低 |
| 强制中继 | 打洞必败 | 全部走节点转发，稳定但慢 |
| UDP 打洞 | 常见家宽 | 开销最小 |
| TCP 打洞 | 运营商限制 UDP | 用 TCP 建连与打洞 |
| QUIC | 跨境高丢包 | 自带拥塞控制 |
| WebSocket | 只能过 HTTP 代理 | 封装成 WS |
| WSS | 严格网络 | WS over TLS |
| FakeTCP | UDP 被 QoS | 伪造 TCP 握手，穿透力最强 |
| IPv6 优先 | 双方有公网 v6 | 电信联通常见，直连延迟最低 |
| 高丢包优化 | 移动网络 | KCP 代理 + zstd 压缩 |
| 极低延迟 | 同城联机 | 关闭额外代理层 |
| 同局域网 | 同一路由器下 | 直接指定对端内网地址 |
| 免虚拟网卡 | 无管理员权限 | 端口转发，MC 连 127.0.0.1:25565 |

## 引导节点

节点只负责帮双方互相发现，打洞成功时数据不经过它。

默认使用 EasyTier 官方公共节点 `public.easytier.cn:11010`，免维护但高峰期可能拥塞。

### 自建节点

`deploy/install-relay.sh` 把下载、安装、systemd 注册、防火墙放行包成一条命令，适用于 CentOS / Rocky / Alma / Ubuntu / Debian，宝塔面板直接用。

```bash
# 私有中继：只为自己这一个网络转发
curl -fsSL https://your-host/install-relay.sh | bash -s -- \
  --mode private --network mclab-abc --secret 你的密钥

# 只帮打洞、不转发数据，带宽占用极低
curl -fsSL https://your-host/install-relay.sh | bash -s -- --mode punch-only
```

四种模式：`private`（只服务指定网络）、`whitelist`（服务匹配白名单的网络）、`public`（所有网络，需配限速）、`punch-only`（只协助打洞）。

加 `--dry-run` 可以只看生成的 systemd 配置，不做任何改动。完整参数与排查手册见 [deploy/README.md](deploy/README.md)。

节点部署完，在界面「引导节点」里添加 `公网IP:11010` 即可。

节点位置决定中继质量。国内互连建议用香港或国内节点，美国节点延迟 150ms 以上，做中继不可用。

## 目录结构

```
lan-module/
├── lan-module.exe          主程序
├── run.cmd                 启动脚本（请求管理员权限）
├── build.cmd               重新构建
├── bin/
│   ├── easytier-core.exe   组网核心
│   ├── easytier-cli.exe    状态查询
│   ├── wintun.dll          虚拟网卡驱动
│   ├── Packet.dll          FakeTCP 抓包依赖
│   └── WinDivert64.sys
├── deploy/
│   ├── install-relay.sh    Linux 中继节点一键部署
│   └── README.md           部署说明与排查手册
├── data/
│   ├── config.json         配置与节点列表
│   └── logs/               EasyTier 运行日志
└── web/                    前端源码（已内嵌进 exe）
```

## HTTP API

启动器可以直接调用接口，不必打开浏览器。所有写请求必须带 `X-MCLab: 1` 请求头（防跨站调用）。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/ping` | 健康检查 |
| GET | `/api/status` | 当前组网状态 |
| POST | `/api/join` | 加入房间 |
| POST | `/api/leave` | 断开 |
| GET | `/api/peers` | 对等节点列表 |
| GET | `/api/config` | 读配置 |
| PATCH | `/api/config` | 改配置 |
| GET | `/api/profiles` | 方案列表 |
| GET | `/api/nodes` | 引导节点列表 |
| POST | `/api/nodes` | 添加节点 |
| DELETE | `/api/nodes/{id}` | 删除节点 |
| POST | `/api/nodes/{id}/toggle` | 启用/停用 |
| POST | `/api/nodes/test` | 测试节点可达性 |
| GET | `/api/room/new` | 生成房间号 |
| POST | `/api/room/preview` | 预览房间派生结果 |
| GET | `/api/diagnostics` | NAT 类型诊断 |
| GET | `/api/logs` | 运行日志 |
| GET | `/api/events` | SSE 状态流 |

### 加入房间

```http
POST /api/join
Content-Type: application/json
X-MCLab: 1

{
  "room": "123456",
  "password": "",
  "host": true,
  "profile": "auto"
}
```

`host: true` 表示本机开服，占用虚拟网段第一个地址。客户端填 `false`，按主机名散列分配固定 IP。

响应：

```json
{
  "state": "starting",
  "room": "123456",
  "network": "mclab-arznj2727eoa",
  "is_host": true,
  "self_ip": "10.126.126.1",
  "host_ip": "10.126.126.1",
  "mc_address": "10.126.126.1:25565",
  "lan_discover": true
}
```

状态机：`idle → starting → running`，异常时 `failed` 并带 `error` 字段。

### 启动器集成要点

1. 以子进程方式启动 `lan-module.exe --silent --open=false`
2. 轮询 `/api/ping` 直到返回 200，拿到端口
3. 调用 `/api/join`，从响应里取 `mc_address`
4. 把 `mc_address` 拼进 MC 启动参数，或用 `--server` 直接连
5. 退出时调 `/api/leave`，再结束进程

端口被占用时模块会自动向后寻找（39000-39099），实际端口从 `/api/ping` 的返回或进程输出里取。

## 房间号原理

房间号不经过服务器，由客户端的密钥派生函数确定性地算出 EasyTier 的 `network-name` 和 `network-secret`：

```
network = "mclab-" + base32(sha256("mclab-lan/room-name/v1|" + room))[:12]
secret  = hex(sha256("mclab-lan/room-secret/v1|" + room + "|" + password + "|" + pad))[:32]
```

双方输入相同房间号和口令，必然得到相同网络参数。不同房间号不会串线。口令留空时仅凭房间号识别，此时知道房间号的人都能进。

## 已知限制

**对称 NAT 打洞不稳定。** 移动宽带和企业网络常见，此时会降级到中继。方案里没有能保证直连的选项，这是物理限制。

**中继带宽受节点限制。** 3Mbps 的节点做中继只能撑 4-5 人，人数上去会卡。

**无 TUN 模式不支持局域网自动发现。** MC 的「对局域网开放」靠 UDP 广播，只有 TUN 模式配合 `--enable-udp-broadcast-relay` 才能转发。

**同一台机器跑多个实例会争抢 11010 端口。** 目前不支持多实例，切换房间时会先断开旧实例。

## 构建

```
build.cmd
```

需要 Go 1.21+。产物为单文件 `lan-module.exe`，前端通过 `embed` 打进二进制。

## 许可

与 HopeStar-MCLab 一致，GPL-3.0。
