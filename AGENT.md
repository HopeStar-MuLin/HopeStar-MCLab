# AGENT.md — 本仓库的工作约束

> 这份文件是**硬约束**，后续每次会话动代码前先读一遍。
> 与用户当次指令冲突时以用户指令为准；其余情况默认按这里执行。
> 约束本身要改时，直接改这份文件，并在 commit message 里说明原因。

---

## 1. 项目定位

**HopeStar-MCLab** 是一个 Minecraft 启动器，技术上它是 [HMCL](https://github.com/HMCL-dev/HMCL) 的**修改版**
（fork），不是从零写的项目。上游代码在 `HMCL/` 目录里，几乎保留了原样结构。

- 上游基线：`HMCL 3.17.0-SNAPSHOT`（`HMCL/gradle.properties` 里的版本号）
- 许可：**GPL-3.0**（根目录 `LICENSE`），修改声明见 `NOTICE`
- 名字与图标：HopeStar-MCLab + 自有图标（`assets/brand/icon-source.png`），**不得**以上游名义发布

界面有两种模式，共用同一套前端资源：

| 模式 | 入口 | 说明 |
|---|---|---|
| JavaFX | `HMCL/` 原样启动 | 上游界面，保留以便对照与兜底 |
| WebView | `shell/`（Tauri + WebView2） | 本项目的主线界面，所有新功能只在这里做 |

---

## 2. 工作基线：改动应该落在哪

| 你要改的东西 | 位置 | 备注 |
|---|---|---|
| 前端页面 / 样式 / 交互 | `HMCL/HMCL/src/main/resources/assets/web/` | **唯一源**。`app.js` / `app.css` / `index.html` |
| 前端用到的图片 | `.../assets/web/img/` | 由 `shell/web/` 镜像同步 |
| WebView 与 Java 的桥接、业务服务 | `HMCL/HMCL/src/main/java/org/jackhuang/hmcl/ui/web/` | `WebBridge` 暴露方法给 JS 调 |
| 桌面外壳（窗口、单例、sidecar） | `shell/src-tauri/src/` | Rust |
| 构建 / 打包 / 图标脚本 | `tools/` | 见第 3 节 |
| 上游核心逻辑（下载器、认证、版本解析） | `HMCL/HMCLCore/` | 尽量不改；必须改时在 commit 里说明原因 |

**禁止手改 `shell/web/`**：它是 `node scripts/sync-web.js` 从 `HMCL/.../assets/web/` 复制出来的镜像，
下次同步就被覆盖。改完源文件后跑一次同步即可（见下）。

`docs/` 只在本地留档（截图含账号名、皮肤、本机路径），**不入库、不发布**。

---

## 3. 构建、运行、打包

```bash
# 环境（把 JDK / Gradle 缓存固定在 env/ 下；CI 上没有 env/ 会自动退回系统环境）
source env/env.sh

# 编译启动器 → dist/HopeStar-MCLab.jar
./build.sh

# 前端改完后同步到 Tauri 工程（再编壳才生效）
cd shell && node scripts/sync-web.js

# 编译桌面壳 → shell/src-tauri/target/debug/hmcl-shell.exe
# 发布用：cargo build --release（无 CDP、体积 4.8MB）
export CARGO_HOME="$PWD/../../env/cargo" RUSTUP_HOME="$PWD/../../env/rustup"
cd shell/src-tauri && cargo build --offline

# 打发行包 → dist/HopeStar-MCLab-YYYY-MM-DD.zip
# 目录结构：HopeStar-MCLab/{HopeStar-MCLab.exe, runtime/, data/{HopeStar-MCLab.jar, javafx/}, README.txt}
# 发布版用 release 构建的壳（4.8MB，CDP 关闭）：
#   cp shell/src-tauri/target/release/hmcl-shell.exe dist-package/release/hmcl-shell.exe
python tools/pack-debug.py

# 换图标：从 assets/brand/icon-source.png 生成全套尺寸（含 exe 内嵌 ico）
python tools/make-icons.py

# 签名（有证书才签；没配证书自动跳过，发布用 --require-sign 强校验）
#   SIGN_THUMBPRINT=<指纹>  或  SIGN_PFX=xx.pfx SIGN_PFX_PASS=***
python tools/pack-debug.py --sign
```

签名细节见 `docs/signing.md`；换自己的微软登录 client id 见 `docs/microsoft-login.md`。

### 检查更新与热更新

- **清单**：仓库根的 `update.json`（`version` / `notes` / `jar` / `jarSize`）。
  客户端读 `https://cdn.jsdelivr.net/gh/<repo>@latest/update.json` —— `@latest` 自动指向
  最新 tag，所以发版只需打 tag，URL 不用改。
- **载荷**：`update/HopeStar-MCLab.jar`，只替换 `data/` 下的核心（13MB，在 jsDelivr
  单文件 20MB 上限内）。
- **为什么不用 api.github.com**：国内网络实测连不上（curl 返回 000），jsDelivr 能直连；
  GitHub API 只作兜底。
- **应用**：写一个 `apply-update.ps1`，等本进程退出后覆盖 jar 再 `Start-Process` 重启。
  运行中的 jar / exe 是锁着的，绕不过这一步。
- **发版**：`python tools/release.py 318 --notes "..."` —— 用 `BUILD_NUMBER=318` 构建，
  写 update.json、提交、打 tag。jar 内版本必须等于 update.json 的 version
  （脚本会校验），否则用户更新完还会看到「有新版本」。


**验证方式**（debug 构建才开 CDP 端口）：

```bash
# 启动 dist-package/release/hmcl-shell.exe 之后
node tools/cdp-eval.js "document.title"          # 查 DOM / 跑断言
node tools/cdp-shot.js out.png                   # 页面截图
java tools/Shot.java screen.png                  # 全屏截图（看任务栏图标）
```

改了图标之后必须验证 exe 内嵌资源真的换了（`cargo build` 不会因为换 ico 自动重编资源）：

```bash
python -c "import pefile;pe=pefile.PE(r'shell/src-tauri/target/debug/hmcl-shell.exe');print([l.data.struct.Size for e in pe.DIRECTORY_ENTRY_RESOURCE.entries if e.id==3 for n in e.directory.entries for l in n.directory.entries])"
```

---

### 发行包构成（对齐 HMCL 官方发行版的布局）

```
HopeStar-MCLab/
├── HopeStar-MCLab.exe       壳（release，4.8MB，无调试端口）
├── runtime/                 jlink 精简运行时（47MB，只含实际用到的 JDK 模块）
├── .minecraft/              游戏目录（首次装游戏时生成，相对 CWD 解析）
├── data/                    启动器数据根，整个目录可以拷走
│   ├── HopeStar-MCLab.jar    Java 核心（gradle shadowJar 产物改的名）
│   ├── javafx/               JavaFX 21 模块（--module-path 指过去）
│   └── config/ logs/ state/ cache/ appearance/ …   运行时生成
└── README.txt
```

`data/` 是启动器数据根：`-Dhmcl.dir`、`HMCL_USER_HOME` 都指它，JVM 的 CWD 是它
的上一级（所以 `.minecraft` 落在根目录，和 HMCL 便携版一致）。早期版本把配置
放在 exe 同级 `.hmcl/`，`sidecar::migrate_legacy` 会在首次启动时搬进 `data/`
（只在 `data/config` 不存在且 `.hmcl/config` 存在时动手，不覆盖 zip 里的 jar/javafx）。

`runtime/` 由 jlink 生成，**不要直接替换成完整 JDK**（体积从 47MB 涨到 63MB）：

```bash
MODS="java.base,java.desktop,java.logging,java.management,java.naming,java.net.http,java.prefs,java.scripting,java.sql,java.xml,jdk.attach,jdk.crypto.ec,jdk.httpserver,jdk.jsobject,jdk.management,jdk.unsupported,jdk.zipfs,java.instrument,jdk.xml.dom"
jlink --add-modules "$MODS" --strip-debug --no-header-files --no-man-pages       --compress=zip-6 --output dist-package/release/runtime
rm -f dist-package/release/runtime/bin/api-ms-win-*.dll   # Win10+ 自带 UCRT，省 1MB
```

`jdk.xml.dom` 是 javafx.web 的硬依赖，漏了会 `FindException`；`javafx.media` 被
javafx.web 依赖，也不能删。

---

### 复用上游能力时的注意事项

1. **整合包安装**（`AddonService.installModpackArchive`）区分两种来源：
   远程下载到临时目录的包装完要删；用户在「导入整合包」里选的文件**一个字节都不能动**
   （`installLocalFile(..., deleteSource)`）。这条踩过：早期两条路都删，把用户文件删了。
2. **mod 依赖检查**（`ModScanService`）读 jar 元数据：`fabric.mod.json` /
   `META-INF/{neoforge.,}mods.toml` / `mcmod.info`。`BUILTIN` 集合里是「游戏/加载器自带、
   不需要在 mods 里找」的 id，加新条目时注意 `Set.of` 不能有重复元素（重复会抛
   `IllegalArgumentException`，整个类初始化失败，表现为 `NoClassDefFoundError`）。
3. **崩溃分析**（`CrashService`）规则表按「具体 → 笼统」排序，第一条命中即停；
   崩溃报告可能在 `runDirectory` 也可能在 `instanceRoot`（隔离/非隔离实例不同），两处都要找。
4. **改客户端 jar 必须删签名**（`TitleBrand`）：原版 `versions/<id>/<id>.jar` 是 Mojang
   签过名的，只改里面的 class 而不删 `META-INF/*.SF|*.RSA`，JVM 加载时抛
   `SecurityException: SHA-384 digest error`，游戏直接起不来（1.21.1 原版实测；Fabric 那种
   本地重新生成的未签名 jar 不会）。`TitleBrand.replaceEntries(..., stripSignature)` 会顺手删，
   已经打过补丁的旧 jar 靠「常量池里有品牌串 + 还有签名块」判定，启动时自动补删。
5. **皮肤预览的盔甲层**（`shell/web/vendor/skinview3d.bundle.js`）是本地打过补丁的构建，
   不是 npm 上那个包：上游 3.4.2 没有盔甲。源码在 `tools/skinview3d-armor/src`
   （从官方 sourcemap 里还原的 4 个 .ts + 我们加的盔甲代码），改完要重新出包：

   ```bash
   cd tools/skinview3d-armor && npm i        # three@0.156 / skinview-utils / esbuild
   node build.mjs                            # → dist/skinview3d.bundle.js
   cp dist/skinview3d.bundle.js ../../HMCL/HMCL/src/main/resources/assets/web/vendor/
   cd ../../shell && node scripts/sync-web.js
   ```

   贴图**内置**在 `assets/web/img/armor/`（15 张，18 KB，取自 1.21.1 客户端），
   只认这一个版本，不做版本判断：`SkinObject.armorArmHeight` 固定 5，也就是
   1.20.5 之后那套「手臂护甲只到上臂、小臂露皮肤」的模型。要改回 1.20.4 及更早的
   整条手臂（4x12x4），把 `loadArmors(..., { armHeight: 12 })` 传进去即可。

   四个槽（`helmet` / `chest` / `legs` / `boots`）各有独立材质，
   `setArmorTexture(slot, tex)` 换图，所以能混搭。`chest` 同时管两只袖子，
   `legs` 管腰带和两条腿。默认全都不穿，也不记忆上次的选择。

   界面是四个圆角方块（`#ap-armor-row .armor-cell`），空着时是虚线框 +「空」字
   （和「无账号头像」同一套视觉），点开 `#armor-picker` 浮层按图标选 —— 是贴着
   格子弹的小面板，不是遮住整页的对话框（换一件甲只是想看一眼效果，弹大窗反而
   看不见 3D 预览）。物品图标内置在 `assets/web/img/item/`，从 1.21.1 的
   `textures/item/*.png` 抽的：六个材质 × 四个部位 + 海龟壳。金在游戏里叫
   `golden_*`、护腿叫 `*_leggings`，映射写在 `ARMOR_MATERIALS[].item` 和
   `ARMOR_ITEM_SUFFIX` 里，加新材质只改这两处。

   皮革要单独处理：`leather_<部位>.png` 是**灰度**的（游戏里靠 `ItemColors`
   染成染料色），直接显示是一张白图。而且它还有一张 `_overlay.png`，
   得先染色再叠 overlay —— 只染不叠的话皮革帽会显示成两片竖条（缺了帽顶那层）。
   染色版存成 `leather_<部位>_dyed.png`，`ARMOR_MATERIALS` 里给皮革标
   `dye: true` 就会走这几个文件。

   **铜**是 1.21.9 才加的材质，1.21.1 的客户端里没有 —— 这六张直接从 1.21.9 的
   client jar 里取（1.21.2 起装备贴图改名到了 `entity/equipment/` 下）：

   | 我们的文件 | jar 里的路径 |
   |---|---|
   | `img/armor/copper_layer_1.png` | `textures/entity/equipment/humanoid/copper.png` |
   | `img/armor/copper_layer_2.png` | `textures/entity/equipment/humanoid_leggings/copper.png` |
   | `img/item/copper_<部位>.png` | `textures/item/copper_<部位>.png` |

   名字虽然换了，**内容还是老格式**：两张都是 64x32，alpha 逐行和 1.21.1 的
   `iron_layer_1/2.png` 完全一致，可以直接当 layer_1 / layer_2 用。
   顺带核对过：1.21.9 和 1.21.1 的 iron / diamond / netherite / leather / chainmail
   贴图和物品图标**逐字节相同**，所以这套图在最新版下也是对的。

   拉某个版本的客户端（bmclapi 比官方快，官方地址同效）：

   ```bash
   curl -L https://bmclapi2.bangbang93.com/version/1.21.9/client -o client.jar
   # 官方：https://piston-data.mojang.com/v1/objects/<sha1>/client.jar
   ```

   加新材质要同时给 `img/armor/<id>_layer_1.png`、`_layer_2.png`
   和 `img/item/<id>_<部位>.png` 三套。

   四条容易踩的：① 头盔/胸甲/靴子外扩 1px、护腿 0.5px，**UV 仍按未膨胀的盒子切**，
   这点和原版一致，改膨胀量要同步改 UV 参数；② 袖子盒子的深度比胸甲多 0.2，
   否则两者前后表面共面会闪；③ 取景（`frameViewer`）不把盔甲算进包围盒，
   改成固定补 1 格余量，否则穿脱时尺寸会跳；④ 皮革是灰度底 + 染料色乘算 +
   `_overlay` 叠层，canvas 合成顺序必须是 画底 → multiply → destination-in 裁 alpha
   → source-over 叠 overlay，顺序错了透明区会多出一圈实色。

### 披风 / 鞘翅

外观页的「披风 | 鞘翅」是照皮肤站（`blessing-skin-server` 的 `Viewer.tsx`）做的：
皮肤站切的是 `playerObject.backEquipment`（`cape` / `elytra`），**两者共用披风贴图**，
所以切过去会得到一对「披风图案的翅膀」。我们多走一步 —— 内置了游戏自己的
`elytra.png`，切鞘翅时用 `viewer.loadElytra(img)` 单独换贴图，和游戏内一致。
判断顺序是**披风优先**：`capeHasElytraArt()` 量披风贴图上 x 28..46 / y 0..22
这块（64x32 基准）的不透明覆盖率，≥10% 就认为这件披风自带鞘翅图案，用它渲；
否则才用内置的灰紫鞘翅。

三个数都是调出来的，别随手改：
* **检测区不能取 22..46** —— 披风本体的右边缘会溢进来，普通披风也会被判成自带鞘翅；
  取 24..46 又太低（翅膀只占 15%），和噪声分不开。
* **阈值 10%** —— 实测「披风+鞘翅」合并图在这块是 20.4%，普通披风是个位数像素。
* 早期版本测的是 (22,0) 起 10x20，而翅膀实际画在 x 31..45，**整个落在框外**，
  于是带鞘翅的正版披风一直被当成「没有鞘翅」（实测 Migration 披风 49%）。

另外 `mirrorElytra()` 会把有图案的那一面复制到另一面：原版 `elytra.png` 只画背面
（UV 的 x 36..46），正面（x 24..34）整片透明 —— 游戏里玩家只看背面，预览能随便转，
转过去就是一张透明空壳，看起来像「里面被掏空」。翅膀是轴对称的，镜像看不出区别，
披风本体只用 x 0..22，碰不到。

**翅膀的几何体必须和 UV 参数同尺寸**：`BoxGeometry(10, 20, 2)` 配
`setCapeUVs(box, 22, 0, 10, 20, 2)`，和原版 `ElytraModel` 的
`addBox(-10, 0, 0, 10, 20, 2)` 一致。之前是 12x22x4 却按 10x20x2 切 UV，
每个面拿到的纹理区域和面的实际宽高不成比例 —— 侧面（4 厚）用的是 2 厚那条、
顶底（12x4）用的是 10x2 那块，图案整个拉歪，看起来像「建模和贴图分家了」。

`mirrorElytra` 还会把正面的边缘像素铺到侧面（x 22..24 / 34..36）和顶底
（y 0..2）：这几圈在原版贴图里是空的，不补的话从侧面看就是一条透明边，
等于看穿两层皮。逐行取色铺过去，颜色跟着上下渐变走，看着才是块实心板。

注意 `loadCape()` 每次都会把 `backEquipment` 重置成 `cape`、把 `elytra.map` 指回
披风纹理，所以 `syncViewer` 里 loadCape 之后必须再调一次 `applyBackEquipment()`。

### 动作切换（站立 / 行走）

外观页的「站立 | 行走」直接换 `viewer.animation`。**站立不是「没有动画」**：
游戏里站着的时候手臂会随呼吸轻微摆动，用 `IdleAnimation`（手臂绕 z 轴 ±0.03 弧度，
顺带让披风轻飘）—— 把它设成 `null` 人就僵住了，这个观感差别很明显。
行走用 `WalkingAnimation`，`speed = 0.7`。

从行走切回站立时**要先 `playerObject.resetJoints()` 再挂 IdleAnimation**：
`IdleAnimation` 只管手臂和披风，不管腿，腿会停在迈步的中间姿势。

### 图标

四套资源，换品牌时要一起换：

| 用途 | 文件 |
|---|---|
| exe / 任务栏 / 开始菜单 | `shell/src-tauri/icons/icon.ico`（16–256 七档）+ 同目录各尺寸 PNG |
| 窗口内左上角 | `shell/web/img/logo.gif`（动态）+ `logo.png`（兜底） |
| JavaFX 窗口图标 | `HMCL/HMCL/src/main/resources/assets/img/icon*.png` |
| GitHub README | 仓库根目录 `logo.gif` |

源图是 160×160 的像素风，生成脚本按「放大用 NEAREST、缩小用 LANCZOS」处理
（整数倍放大不会糊，缩小时用 NEAREST 会掉细节）。GIF 原始 1650 帧 / 7 MB，
按每 30 帧抽一张压到 55 帧 / 96×96 才 200 KB —— 直接放进来的话每次刷新页面
都要多下载 7 MB。

GIF 存透明有个坑：`Image.convert('P')` 会丢掉 alpha，导出的图透明区变成黑块。
要给调色板留一个索引当透明色，`save(..., transparency=255, disposal=2)`。

### 前端资源改了但界面没变？

`tauri.conf.json` 的 `frontendDist` 指向 `../web`，前端是**编进 exe** 的，
改完必须重编壳。`build.rs` 里用 `watch_dir()` 递归把 `../web` 下每个文件都
声明成 `cargo:rerun-if-changed` —— **只写目录是不够的**：cargo 对目录只看
mtime，而改一个已有文件的内容不会更新目录的 mtime，于是 `cargo build` 会说
「没变化」直接跳过，跑起来还是旧界面（这个坑踩过两次，排查一轮要重启一次）。


---

## 4. 硬约束（不可协商）

1. **许可证必须是 GPL-3.0**。新增文件默认 GPL-3.0；不引入与 GPL 不兼容的依赖；
   分发二进制必须能拿到对应源码（本仓库即可）。
2. **凭据绝不入库**。API Key、OAuth client id、token、Cookie 一律不许出现在源码、注释、
   测试数据、日志、截图、commit message 里。
3. **发布版与开源版的凭据是两套**（见第 5 节），不要把本地发行构建用的那份带进公共仓库。
4. **不推 `docs/`**，不推构建产物（`dist/*.jar`、`dist/*.zip`、`dist-package/`），
   不推运行态（`.hmcl*`、`.cache/`、`env/jdk`、`env/gradle-home`、`env/cargo`、`env/rustup`、
   `shell/src-tauri/target`）。
5. **不以上游名义发布**。UI 里残留的上游 logo、名称要逐步替换；
   对外一律称 HopeStar-MCLab，并说明是 HMCL 的非官方修改版。
6. **前端只有一份源**，即 `HMCL/.../assets/web/`。任何绕过同步直接改 `shell/web/` 的改动都算错。

---

## 5. 凭据与脱敏

### 两套凭据，用途不同

| 场景 | 凭据来源 | 能否公开 |
|---|---|---|
| 本地发行构建（自己用 / 内部分发） | `.cache/keys.env`，由 `tools/official_keys.py` 从官方 jar 提取 | **不能** |
| 开源构建（别人 clone 后自己编） | 构建者自备：CurseForge 控制台申请 Key、Azure 注册应用拿 client id | 是（他们自己的） |

`tools/build.sh` 的加载顺序是「`official_keys.py` 重写 `keys.env` → source 它 → source
`.cache/keys.local.env`」。要用自己的 client id（过了 Mojang 审核之后）就写后者，
别往 `keys.env` 里追加——它每次构建都会被覆盖。

`.cache/keys.env` 与 `.cache/keys.local.env` 都被 `.gitignore` 忽略，`env/env.sh` 里只保留
**读取逻辑**，不含任何值。

**Azure 应用侧的两个必做项**（少一个，设备码流程就报错）：

- `signInAudience` = `PersonalMicrosoftAccount`（Minecraft 只认个人账户）
- `isFallbackPublicClient` = `true`（对应「允许公共客户端流」）

第二条门户界面上**不一定显示**——2026-10 实测本项目这个应用，平台配了、账户类型也对，
「身份验证」页最底部就是没有「高级设置」这一块。**直接去「清单」改这个字段**，保存即生效。
症状：`AADSTS70002: The provided client is not supported for this feature. The client
application must be marked as 'mobile.'`。
改完用 `python tools/check-azure-app.py <client_id>` 验证，返回 `user_code` 就是通了。
详细步骤见 `docs/microsoft-login.md`（本地，未入库）。
没有这个文件时构建照常，只是正版登录与 CurseForge 源不可用——这是刻意的降级，不要为了"能跑"把值写死回去。

### 提交前自查

```bash
# 1) 真实凭据值是否出现在工作区（用 .cache 里的真值做比对，不打印值本身）
python - <<'PY'
import pathlib, subprocess
vals = [l.split('=',1)[1].strip() for l in pathlib.Path('.cache/keys.env').read_text().splitlines() if '=' in l]
files = subprocess.run(['git','ls-files'],capture_output=True,text=True).stdout.split()
for f in files:
    try: t = pathlib.Path(f).read_text(encoding='utf-8', errors='ignore')
    except Exception: continue
    for v in vals:
        if v and v in t: print('HIT', f)
PY

# 2) 通用特征
git grep -nIE '\$2a\$10\$|client_secret|ghp_|github_pat_|-----BEGIN' -- . ':!*.md'
```

### 万一泄漏了

1. 立刻轮换该凭据（CurseForge 控制台 / Azure 门户重置）；
2. 用 `git filter-repo --path <文件> --invert-paths` 从历史里清除，强推；
3. 记录到本文件第 10 节，避免下次重犯。

---

## 6. 推送到 GitHub

### 原则

- **本地仓库保留完整历史**（含 docs、调试脚本），这是私有工作区，照常 commit。
- **公共仓库只放本体源码**，且是**单次提交**的快照，不继承本地历史——
  否则 `docs/` 里的截图、早期的调试脚本会跟着进公开历史，删都删不干净。

### 用脚本推（唯一推荐姿势）

```bash
# 1) 先在 GitHub 网页建一个**空仓库**（不要勾 README / .gitignore / LICENSE）

# 2) 只导出 + 体检，不推送（先看清单对不对）
bash tools/publish.sh

# 3) 确认无误后推送
bash tools/publish.sh --remote git@github.com:<账号>/<仓库>.git --tag v3.17.0
```

脚本做三件事：按白名单 `tar` 导出 → 脱敏扫描（真实凭据值 / 通用特征 / 本机绝对路径 /
不该出现的目录）→ `git init` + 单次提交 + 强推。

### 推什么、不推什么

| 推 | 不推 |
|---|---|
| `HMCL/`（上游 fork 源码 + 新增 `ui/web`、`assets/web`） | `docs/`（截图 + 设计稿，含个人信息） |
| `shell/`（Tauri 源码，不含 `web/`、`target/`） | `dist/`、`dist-package/`（构建产物） |
| `env/env.sh`、`env/env.cmd`、`env/setup-env.sh` | `env/jdk/`、`env/gradle-home/`、`env/cargo/`、`env/rustup/`、`env/fetch-deps.sh`（旧原型用） |
| `tools/make-icons.py`、`pack-debug.py`、`official_keys.py`、`publish.sh` | 其它 `tools/*.py`、`tools/cdp-*.js`（本机调试用） |
| `build.sh`、`run.cmd`、`README.md`、`LICENSE`、`NOTICE`、`AGENT.md`、`.gitignore` | `.cache/`、`.hmcl*`、`*.log`、`*.zip`、`*.jar`（构建产物） |
| `assets/brand/icon-source.png`（`make-icons.py` 的源图） | `webui-shell/`（早期原型，已在主线淘汰） |

白名单写在 `tools/publish.sh` 的 `INCLUDE_*` 数组里；要加文件改那里，不要靠"记得别 add"。

### 日常同步的例外情况

如果只是改了个错别字想马上同步，也不要 `git push` 本地历史，仍然走 `publish.sh`。
它的输出是"当前工作区快照"，本地历史再乱都不影响。

---

## 7. 发布 Release

```bash
# 产物在本地构建
./build.sh && python tools/pack-debug.py

# 上传（gh CLI，tag 对应源码 GitHub 会自动打包，满足 GPL 源码提供要求）
gh release create v3.17.0 \
    dist/HopeStar-MCLab.jar dist/HopeStar-MCLab-*.zip \
    --title "HopeStar-MCLab 3.17.0" \
    --notes "变更见 commit 记录；本版为 HMCL 的非官方修改版，GPL-3.0。"
```

Release 说明里必须写清：非官方修改版、对应源码位置（本仓库 tag）、许可证。

---

## 8. 代码与提交风格

- 注释写**为什么**，不写"这里做了什么"；边界情况（HMCL 的坑、WebView2 的限制）必须留注释。
- **UI 文案只写名字**：选项、提示条、表头、按钮不要带解释性括号（「新实例一律隔离」而不是
  「新实例一律隔离（每个版本独立 mods / saves）」）。需要解释就放 `placeholder`、`.sub`
  副标题或帮助页，别塞进标签里。
- 中文注释、中文 UI 文案；标识符英文。
- commit 前缀：`feat(scope):` / `fix(scope):` / `perf(scope):` / `chore:` / `docs:`；
  一个 commit 只做一件事，能独立回滚。
- 改前端后必须跑 `node scripts/sync-web.js`，否则 Tauri 壳看到的还是旧页面。

---

## 9. 会话交接

- 每次会话结束：**本地** commit（不需要推送），commit message 写清动机与验证方式。
- 本文件只在**约束变化**时改（白名单、构建方式、发布流程），不要往里堆进度流水账。
- 新增的"待办"写在第 10 节，做完就删。

---

## 10. 当前待办

- [x] JavaFX / 壳的图标与标题已全部换成自有品牌（2026-10-30）：`assets/img/icon*.png`
      全套由 `tools/make-icons.py` 生成，窗口标题的 `launcher.title*` 三个 key 在
      全部语言文件里都改成了 `HopeStar-MCLab`（文件头的 GPL 版权注释不动）。
- [x] `identifier` 已改为 `cn.mclab.hopestar`（2026-10-30 稳定性检查时改的；
      当前 exe 是便携模式、数据跟 exe 走，改它不影响已有 .hmcl 目录）。
- [ ] 版本号仍是 `3.17.SNAPSHOT`（`HMCL/config/project.properties` 的 `versionRoot=3.17`）。
      首次公开发布建议给一个确定号，并同步 `tauri.conf.json` 的 `version`。
- [ ] 没有 CI。建议 `windows-latest` + `actions/setup-java@v4`（JDK 21）+ `./gradlew :HMCL:shadowJar`，
      Tauri 那一步只在打 tag 时跑。
- [ ] `shell/` 尚未纳入版本库（本地仍是未跟踪状态），入库前确认 `shell/web`、`target` 已被忽略。
