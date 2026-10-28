# HMCL 自编译版（下载功能完整）

## 先说结论

**不用改。上游已经把限制自己撤了。**

时间线（GitHub 提交记录可查）：

| 日期 | 提交 | 内容 |
|---|---|---|
| 2026-10-20 | `583e004` PR #7017 | 按 IP + 时区判断，对中国大陆禁用版本下载页、模组/整合包下载页 |
| 2026-10-22 | `5c90299` PR #7038 | `移除下载页面提示`，把这两个页面的拦截代码删干净 |

拉下来的 `main`（今天）里，`VersionsPage.java` / `DownloadListPage.java` 已经没有任何地域判断。
所以我直接编译了一份能用的，放在 `dist/HMCL.jar`。

## 已经实测过的（不是猜的）

| 检查项 | 结果 |
|---|---|
| 下载页 class 里的限制符号 | 无（`isIsChinaMainlandNetwork` / `IS_CHINA_MAINLAND` 均不存在） |
| CN 镜像加速逻辑 | 保留，大陆用户仍优先走 BMCLAPI |
| Mojang 版本清单 | 通，920 个版本，最新正式版 26.3 |
| BMCLAPI 镜像 | 通，920 个版本 |
| Modrinth API | 通（模组 / 整合包 / 光影，免 key） |
| CurseForge API | 通，模组总数 10000+（key 已注入，见下） |
| 微软正版登录 | client id 已注入（`6a3728d6-…`，来自官方包） |
| 启动 | 实测启动成功，日志 `*** HMCL 3.17.SNAPSHOT ***` |
| exe 启动 | 实测 `HMCL.exe` 起来，`Java Home` 指向包内 `runtime`，无 JavaFX 下载 |

`dist/HMCL.jar` 现在具备：游戏本体下载（含快照/远古版）、Forge / NeoForge / Fabric / Quilt / LiteLoader / OptiFine 一键装、Modrinth + CurseForge 模组下载、整合包导入与安装、正版 / 离线登录。

## 怎么跑

**方式一：exe（推荐，给别人也是这个）**

解压 `dist\HMCL-3.17.0-win-x64.zip`，双击 `HMCL.exe`。不用装 Java，运行时打在包里。

**方式二：jar**

```bat
run.cmd
```
或者
```bat
java -jar dist\HMCL.jar
```

需要 JDK 17+。本机用的是 `C:\Program Files\Java\jdk-21.0.12.1`。

## 分发包怎么来的

```bat
python tools\pack_exe.py
```

做三件事：

1. `jlink` 裁一个 61 MiB 的运行时（java.base/desktop/logging/net.http/xml/management、jdk.attach、jdk.unsupported、jdk.crypto.ec、jdk.localedata、jdk.zipfs 等）
2. 把 `HMCL.jar` + 三个 JavaFX jar（base/graphics/controls 21.0.8-win）放进 `app\`，`jpackage --type app-image` 生成 `dist\HMCL\`（含 `HMCL.exe`）
3. 压成 `dist\HMCL-*.zip`

产物：

| 文件 | 大小 | 说明 |
|---|---|---|
| `dist\HMCL\HMCL.exe` | 466 KiB | 启动器壳，真正的 JVM 在 `runtime\` |
| `dist\HMCL\runtime\` | 61 MiB | 裁剪后的 JDK 21 |
| `dist\HMCL\app\` | 20 MiB | HMCL.jar + JavaFX |
| `dist\HMCL-3.17.0-win-x64.zip` | 64 MiB | 解压 81 MiB |

JavaFX 直接进 classpath 后，`SelfDependencyPatcher` 检测到 `javafx.application.Application` 就跳过下载 —— 实测日志里已经没有 `Missing JavaFX dependencies` 那行，断网也能开。

便携行为：`.hmcl\`（配置）和 `.minecraft\`（游戏）默认生成在 `HMCL.exe` 同目录，整个文件夹拷走即可。**别放 `C:\Program Files\`**，那里写不进去。

## 怎么重新编译

```bat
tools\build.cmd
```

流程：找 JDK → 设阿里云 Maven 镜像 → 去地域限制（幂等，没有就跳过）→ 注入官方凭据 → `gradlew :HMCL:shadowJar` → 产物落 `dist\HMCL.jar` → 跑 `verify.py` 自检。

Git Bash 用 `tools/build.sh`。

单独跑：

```bat
python tools\unrestrict.py --root .\HMCL --check      :: 只看有没有限制代码
python tools\unrestrict.py --root .\HMCL --apply      :: 有就改掉，自动留 .bak
python tools\verify.py --jar dist\HMCL.jar            :: 产物 + 下载源自检
```

## 两个凭据从哪来（重要）

自编译版本的 `assets/hmcl.properties` 里这两项默认是空的，表现为：

- `hmcl.microsoft.auth.id` 空 → **只能离线登录**，正版账号登不上
- `hmcl.curseforge.apikey` 空 → 搜不到 CurseForge 内容，只剩 Modrinth

官方 CI 编译时用 Jenkins 凭据注入。我从官方发行包里读出来用：

```bat
python tools\fetch_official.py                        :: 下官方包到 .cache\
python tools\official_keys.py --jar .cache\HMCL-official.jar --out .cache\keys.env
```

`build.cmd` / `build.sh` 检测到 `.cache/HMCL-official.jar` 会自动做这一步。
`.cache/keys.env` 里是明文 key，别往仓库里提交、别外发。

## 如果上游以后又收紧

`tools/unrestrict.py` 已经覆盖了 #7017 那种写法（`if (RegionUtils.isIsChinaMainlandNetwork()) { 提示 + setDisable(true) }`），重编前会自动拍平成 `if (false)`，只动 `ui/download/` 和 `ui/instances/`，不碰 `HMCLDownloadProvider` 的镜像选择逻辑 —— 那个删了反而会变慢。

上游换招（比如换成编译期常量开关）脚本会报 `有标记但没匹配到判断式`，到时按提示手工改。改动点集中在两处：版本下载页、模组/整合包下载页。

## 已知限制

1. **自动更新不可用**：包没有官方签名，日志会打 `Signature is missing / Self verification failed`，这是更新检查器在验签，不影响使用和下载，只是不会自动升级。
2. **exe 未签名**：第一次运行 Windows SmartScreen 会拦，点「更多信息 → 仍要运行」。要彻底消掉得买代码签名证书。**别把 exe 名字改成 `HMCL-3.16.x.exe` 之类的官方名发出去**，容易和官方包混淆。
3. **凭据是官方的**：CurseForge key 属于 HMCL 项目，所有分发包里都有；如果被限流，自己注册一个 Azure 应用（拿 client id）和 CurseForge key，重编时用 `MICROSOFT_AUTH_ID` / `CURSEFORGE_API_KEY` 环境变量覆盖。
4. **GPLv3 附加条款**：自己用随便改。**分发**改过的版本必须改名或改版本号以区别原版，且不得移除版权声明（`HMCL/build.gradle.kts` 里 `hmcl.version` / 名字可改）。
5. 构建环境坑：`JAVA_HOME` 指向 `Common Files\Oracle\Java` 会直接失败，要指到 `jdk-21.x` 根目录；Gradle 发行包从 `services.gradle.org` 拉很慢，国内建议先用镜像下好塞进 `~/.gradle/wrapper/dists/`。

## 目录

```
HMCL/                          源码（main 分支浅克隆快照）
dist/
  HMCL.jar                     fat jar，java -jar 直接跑
  HMCL/                        便携目录：HMCL.exe + runtime + app
  HMCL-3.17.0-win-x64.zip      分发包，64 MiB
run.cmd                        用系统 JDK 启动
tools/
  build.cmd / build.sh         一键构建 jar
  pack_exe.py                  打 exe 便携目录 + zip
  unrestrict.py                去掉下载页地域限制（幂等）
  verify.py                    产物 + 下载源自检
  official_keys.py             从官方包提取 client id / CurseForge key
  fetch_official.py            下官方包
docs/upstream-7017.diff        上游那次的完整补丁，留着对照
.cache/                        官方包 + keys（含明文凭据）
build/                         jlink 运行时 / app 目录 / 图标（中间产物）
```
