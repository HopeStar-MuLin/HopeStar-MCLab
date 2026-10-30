<p align="center">
  <img src="logo.gif" width="120" height="120" alt="HopeStar-MCLab">
</p>

<h1 align="center">HopeStar-MCLab</h1>

Minecraft 启动器。基于 [HMCL](https://github.com/HMCL-dev/HMCL) 修改而来，**非官方修改版**。

界面有两条路线，共用同一套前端资源：

- **WebView（主线）**：Tauri + WebView2 外壳（`shell/`），承载 `assets/web/` 下的页面；
- **JavaFX（兜底）**：上游界面原样保留（`HMCL/`），用于对照与排障。

## 许可

**GPL-3.0**，见 [LICENSE](LICENSE)。

本项目是 HMCL 的修改版而非原版，按 GPL-3.0 第 5 条在 [NOTICE](NOTICE) 中声明了修改内容与上游版权。
新增部分（`shell/`、`HMCL/HMCL/src/main/java/org/jackhuang/hmcl/ui/web/`、`assets/web/`、`tools/`）
同样以 GPL-3.0 发布，不另设协议。分发二进制时请一并提供对应源码，并保留 `LICENSE`、`NOTICE`
与上游版权声明。名称与图标不在许可证授权范围内，请勿以上游名义发布。

## 目录

```
.
├── HMCL/                  HMCL 源码 fork（gradle 多模块）
│   ├── HMCL/              启动器主模块（UI + 业务），新增的 ui/web 与 assets/web 在这里
│   ├── HMCLCore/          核心：版本解析、下载、认证、启动
│   ├── HMCLBoot/          启动引导
│   └── buildSrc/          gradle 构建逻辑（含 JavaFX 依赖注册）
├── shell/                 Tauri + WebView2 外壳
│   ├── src-tauri/         Rust 侧：窗口、单例、Java 核心的 sidecar 管理
│   ├── scripts/sync-web.js 把 HMCL 的 assets/web 同步成 shell/web（镜像，勿手改）
│   ├── web/               前端镜像（构建时生成，不入库）
│   └── package.json       tauri CLI 脚本
├── tools/                 构建辅助脚本（Python）
│   ├── make-icons.py      从 启动器图标.png 生成全套图标（含 exe 内嵌 ico）
│   ├── pack-debug.py      打 Release 用的 zip（exe / runtime + data/{jar, javafx}）
│   ├── official_keys.py   从官方 jar 提取运行时凭据，写入 .cache/keys.env（不入库）
│   └── publish.sh         导出本体源码并推送 GitHub（白名单 + 脱敏扫描）
├── env/                   构建环境脚本
│   ├── env.sh / env.cmd   固定 JAVA_HOME / GRADLE_USER_HOME / Maven 镜像
│   └── setup-env.sh       从系统复制 JDK 与 Gradle 缓存（仅本机）
├── build.sh               一键构建启动器 → dist/HopeStar-MCLab.jar
└── run.cmd                运行 dist/HopeStar-MCLab.jar
```

> 前端源码只有一份：`HMCL/HMCL/src/main/resources/assets/web/`。`shell/web/` 是同步产物，
> 改页面请改前者，然后 `cd shell && node scripts/sync-web.js`。

## 构建

需要 JDK 21。仓库不自带 JDK，`env/env.sh` 会优先用 `env/jdk`（若存在），否则沿用系统 `JAVA_HOME`。

```bash
source env/env.sh
./build.sh                              # → dist/HopeStar-MCLab.jar
java -jar dist/HopeStar-MCLab.jar       # JavaFX 模式
java -Dhmcl.ui.web=true -jar dist/HopeStar-MCLab.jar   # WebView 页面（JavaFX 承载）
```

### 桌面壳（Tauri）

需要 Rust 工具链与 WebView2（Win11 自带，Win10 需自行安装）。

```bash
cd shell
node scripts/sync-web.js       # 同步前端镜像，必做
npx tauri dev                  # 开发
```

### 打包 Release 附件

```bash
./build.sh
cd shell && node scripts/sync-web.js && cd src-tauri && cargo build --release && cd ../..
python tools/pack-debug.py     # → dist/HMCL-shell-debug-<日期>.zip
```

## 发布

公共仓库只收本体源码：**不含** `docs/`、构建产物、运行态目录与任何凭据。
推送走白名单脚本，而不是 `git push` 本地历史：

```bash
bash tools/publish.sh          # 先导出 + 脱敏体检，看清单
bash tools/publish.sh --remote git@github.com:<账号>/<仓库>.git --tag v3.17.0
```

完整规则见 [AGENT.md](AGENT.md)（推送白名单、凭据策略、Release 流程）。

## 运行时凭据

微软登录的 OAuth client id 与 CurseForge API key **不在仓库里**。需要时自己准备：

```bash
python tools/official_keys.py --jar .cache/HMCL-official.jar --out .cache/keys.env
source env/env.sh
```

没有它们也能正常编译运行，只是正版登录与 CurseForge 内容源不可用。
对外分发请使用自己申请的凭据（CurseForge 控制台 / Azure 应用注册）。

## 功能

| 项 | 状态 | 说明 |
|---|---|---|
| 实例管理、版本安装（原版 / Forge / NeoForge / Fabric / Quilt / Cleanroom / OptiFine） | 已实现 | 加载器版本按游戏版本前置校验，不支持的直接置灰 |
| Cleanroom 支持 | 已实现 | 1.12.2 专用，安装后自动放入 Fugue 与 Scalar Legacy 兼容补丁 |
| 衣柜（皮肤库、披风切换、3D 预览） | 已实现 | 本地库 + 在线库，皮肤站可自定义 |
| 模组 / 资源包 / 光影 / 世界 / 整合包 | 已实现 | Modrinth 为主，世界走 CurseForge |
| WebView 界面 | 主线 | Tauri 外壳承载，暗色 / 亮色两套主题 |

## 致谢

这个启动器站在别人的肩膀上。下面按用途分组，排名不分先后；同名的项目都在各自仓库里
由下面列出的作者与贡献者维护，本仓库只做集成。

### 上游

| 项目 | 作者 / 维护者 | 地址 |
|---|---|---|
| HMCL — Hello Minecraft! Launcher | huangyuhui（huanghongxun）及贡献者 | https://github.com/HMCL-dev/HMCL |

整个核心（版本解析、下载器、认证、整合包安装、JavaFX UI）来自 HMCL，按 GPL-3.0 使用。

### 外壳与界面

| 项目 | 作者 / 维护者 | 地址 |
|---|---|---|
| Tauri | Tauri Contributors | https://github.com/tauri-apps/tauri |
| WebView2 | Microsoft | https://learn.microsoft.com/microsoft-edge/webview2/ |
| JavaFX（OpenJFX） | OpenJDK 社区 | https://github.com/openjdk/jfx |
| three.js | Ricardo Cabello（mrdoob）及贡献者 | https://github.com/mrdoob/three.js |
| skinview3d | Blessing Skin 社区 | https://github.com/bs-community/skinview3d |
| esbuild | Evan Wallace | https://github.com/evanw/esbuild |

### 运行时

| 项目 | 作者 / 维护者 | 地址 |
|---|---|---|
| Oracle JDK 21（jlink 裁剪成 `runtime/`） | Oracle Corporation | https://www.oracle.com/java/technologies/downloads/ |

### 数据与下载源

| 项目 / 服务 | 作者 / 维护者 | 地址 |
|---|---|---|
| Mojang 版本清单与资源 | Mojang Studios | https://launchermeta.mojang.com/mc/game/version_manifest_v2.json |
| BMCLAPI（国内镜像） | bangbang93 | https://github.com/bangbang93/BMCLAPI |
| Modrinth | Modrinth 团队 | https://github.com/modrinth/code |
| CurseForge | Overwolf | https://docs.curseforge.com/ |
| authlib-injector | yushijinhun | https://github.com/yushijinhun/authlib-injector |
| Blessing Skin | Blessing Skin 社区 | https://github.com/bs-community/blessing-skin-server |
| LittleSkin | LittleSkin 团队 | https://littleskin.cn |

### 游戏与加载器

| 项目 | 作者 / 维护者 | 地址 |
|---|---|---|
| Minecraft | Mojang Studios | https://www.minecraft.net |
| Fabric | FabricMC | https://github.com/FabricMC/fabric |
| Quilt | QuiltMC | https://github.com/QuiltMC/quilt-loader |
| Forge | MinecraftForge | https://github.com/MinecraftForge/MinecraftForge |
| NeoForge | NeoForged | https://github.com/neoforged/NeoForge |
| Cleanroom | CleanroomMC | https://github.com/CleanroomMC/Cleanroom |
| OptiFine | sp614x | https://optifine.net |
| Fugue · Scalar Legacy | CleanroomMC | https://modrinth.com/mod/fugue |

### 素材

皮肤、盔甲与物品贴图取自 Minecraft 1.21.1 与 1.21.9 客户端，版权归 Mojang Studios 所有，
仅用于界面预览；启动器图标与界面视觉为本仓库自制。

### 关于许可

除上述第三方组件各自的许可证外，本仓库源码与上游保持一致，以 **GPL-3.0** 发布
（见 [LICENSE](LICENSE)）。分发二进制时请一并提供对应源码并保留 [NOTICE](NOTICE) 中的
上游版权声明。
