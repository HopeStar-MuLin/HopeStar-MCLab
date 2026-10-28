# MCLab — Minecraft 启动器改造工作区

基于 [HMCL](https://github.com/HMCL-dev/HMCL)（GPL-3.0）的本地改造工作区：衣柜（皮肤库 + 披风切换）、
WebView UI 原型、以及自编译打包链路。所有代码、依赖、编译产物都在本目录内，不依赖 C 盘环境。

## 目录

```
MCLab/
├── HMCL/                  HMCL 源码 fork（gradle 多模块）
│   ├── HMCL/              启动器主模块（UI + 业务）
│   ├── HMCLCore/          核心：版本解析、下载、认证、启动
│   ├── HMCLBoot/          启动引导
│   └── buildSrc/          gradle 构建逻辑（含 JavaFX 依赖注册）
├── webui-shell/           WebView UI 原型（独立，javac 直编）
├── tools/                 打包 / 签名 / 关键字注入脚本（Python）
├── docs/                  设计文档、选型报告、改造笔记
├── dist/                  构建产物（jar / zip / exe，不入 git）
├── env/
│   ├── jdk/               便携 JDK 21.0.12.1（不入 git）
│   ├── gradle-home/       GRADLE_USER_HOME，含依赖缓存与 wrapper 发行包（不入 git）
│   ├── env.sh             环境变量（bash）
│   ├── env.cmd            环境变量（cmd）
│   ├── setup-env.sh       从系统复制 JDK / Gradle 缓存
│   └── fetch-deps.sh      重新下载 webui-shell 的 JavaFX jar
├── build.sh               一键构建启动器
└── run.cmd                运行 dist/HMCL.jar
```

## 环境

不需要在系统里装 Java，也不需要配 `JAVA_HOME`。每次开终端先 source 一下：

```bash
cd /e/MCLab
source env/env.sh          # bash / git bash
# 或 cmd:
#   call env\env.cmd
```

`env.sh` 会把 `JAVA_HOME` 指到 `env/jdk`，`GRADLE_USER_HOME` 指到 `env/gradle-home`，
并把 Maven 镜像固定成阿里云。**不 source 也能构建**，但会退回 C 盘的用户环境。

## 常用命令

| 目的 | 命令 |
|---|---|
| 编译启动器 | `./build.sh` |
| 清理后重编 | `./build.sh --clean` |
| 运行 | `java -jar dist/HMCL.jar` 或 `run.cmd` |
| 打包 exe | `python tools/pack_exe.py` |
| WebView 原型 | `cd webui-shell && ./build.sh && ./run.sh` |
| 原型无头验收 | `cd webui-shell && ./run.sh --smoke --shot=out.png` |
| 重建环境 | `./env/setup-env.sh /c/path/to/jdk-21` |

离线构建是默认行为（`--offline`）。新增依赖时需要先联网拉一次：

```bash
source env/env.sh && cd HMCL && ./gradlew :HMCL:shadowJar -x test --console=plain
```

## Git

本地仓库，无远程。二进制（JDK、Gradle 缓存、JavaFX jar、jar/zip 产物）都被 `.gitignore` 排除，
仓库里只有源码、脚本和文档。

```bash
git status
git add -A
git commit -m "feat: xxx"
git log --oneline --graph
```

回滚某个文件：`git checkout -- path/to/file`。
看某次改动：`git show <hash> --stat`。

## 已完成 / 进行中

| 项 | 状态 | 说明 |
|---|---|---|
| 衣柜（皮肤本地库 + 上传、披风拉取与切换、3D 预览） | 已实现 | `docs/wardrobe-and-ui.md` |
| 自编译 + exe 打包 | 已实现 | `docs/HMCL-fork-notes.md` |
| UI 技术选型（WebView 路线） | 已定方案 | `docs/ui-stack-selection.md` |
| WebView 原型 | 可运行 | `webui-shell/`，明暗两套主题 |
| P0：WebView 接进 HMCL（`-Dhmcl.ui.web=true`） | 未开始 | 下一步 |

## 许可

`HMCL/` 目录是 GPL-3.0 衍生作品，分发时必须保持 GPL-3.0 并提供源码。
`webui-shell/` 和 `docs/` 是本项目自写内容。
