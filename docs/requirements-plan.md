# 新需求实现方案

对应 `启动器要求清单.txt`（2026-10-28 12:57）。逐条给做法、改动点、风险、量级。
代码位置以 `E:\MCLab\HMCL` 为准。

---

## 0. 总体判断

| 需求 | 关键难点 | 量级 | 建议顺序 |
|---|---|---|---|
| 1 全功能复刻 + 模组点击禁用 | HMCL 页面/弹窗多（40+），UI 全重写 | **最大**（数周） | 第三，按页分批 |
| 2 账号与外观（含鞘翅） | 鞘翅模型要自己写；正版/外置三种权限模型 | 中（1–1.5 周） | 第二 |
| 3 只内置 LittleSkin | 已满足，几乎零改动 | 极小 | 立即 |
| 4 aria2 下载 | 要换掉 HMCL 传输层 + 分发 aria2c | 中高（3–5 天） | 第四 |
| 5 整页前端 + 去窗口状态条 | 标题栏在 Decorator 里，对话框依赖它 | 中（2–3 天） | **第一**（后面都依赖） |
| 6 性能 | 要定位到底是哪一层卡 | 中（持续） | 贯穿 |

**先做 5，是因为它决定后面所有页面的空间**：现在的 WebView 页面被 HMCL 自绘标题栏压着，页面顶部多一条 52px 的横条，做全屏布局和拖拽都别扭。

---

## 1. 全功能复刻 + 模组点击禁用

### 1.1 页面清单（按 HMCL 现有 UI 对应）

| HMCL 页面 | 我们的页面 | 说明 |
|---|---|---|
| RootPage / MainPage | `/home` | 已完成 |
| GameListPage / GameItem | `/instances` | 实例列表 |
| GameInstancePage | `/instances/:id` | 实例详情 |
| ModListPage | `/instances/:id/mods` | 模组管理 |
| ResourcePackListPage / DataPackListPage | `/instances/:id/packs` | 资源包 / 数据包 |
| SchematicsPage / ScreenshotsPage | `/instances/:id/files` | 投影 / 截图 |
| WorldInfoPage | `/instances/:id/worlds` | 存档 |
| GameSettingsPage | `/instances/:id/settings` | 实例设置（Java、内存、窗口、JVM 参数） |
| DownloadPage / DownloadListPage | `/download` | 版本 / 加载器 / 整合包 / 模组 / 光影 |
| InstallerListPage | `/download/loaders` | Forge / NeoForge / Fabric / Quilt / OptiFine |
| AccountListPage + CreateAccountPane | `/accounts` | 已完成主体 |
| LauncherSettingsPage | `/settings` | 启动器设置 |
| JavaManagementPage / JavaDownloadDialog | `/settings/java` | Java 管理 |
| PersonalizationPage | `/settings/theme` | 主题 / 背景 |
| CrashReportAnalyzer | 弹窗 | 崩溃分析报告 |
| UpdateChecker | 顶部提示条 | 更新提示 |

这么多页不可能一次做完，"100% 复刻"我建议按使用频率分三批：

- **P1（日常 90%）**：实例详情、模组管理、实例设置、下载（版本+加载器）、启动器设置
- **P2（常用）**：整合包、资源包、存档、Java 管理、崩溃分析
- **P3（长尾）**：截图、投影、数据包、主题、导出、日志、多实例目录

### 1.2 模组点击禁用（需求明确点名）

HMCL 的禁用机制是**改文件后缀**，不是配置位：

- `ModManager.disableMod(Path)`：`xxx.jar` → `xxx.jar.disabled`
- `ModManager.enableMod(Path)`：反过来
- 判断：`ModManager.isDisabled(Path)`（`ModManager.java:379-400`）

所以交互直接映射：

```java
// 点整行
if (ModManager.isDisabled(file)) ModManager.enableMod(file); else ModManager.disableMod(file);
refreshList();
```

UI 侧：禁用项加 `class="disabled"`，用一层灰色遮罩 + 角标"已禁用"，点击遮罩等同于点击行。不引入勾选框。
注意：`ModListPage.java:744` 里的 `JFXCheckBox` 是旧页面，我们新页面不用它，但旧页面保留期间会行为不一致——等 P1 页面替换后再删旧页。

### 1.3 其他"复刻"要注意的点

- 模组依赖关系（Fabric 的 `depends`）、重复模组检测、版本兼容性警告，都有现成分析器（`addon/mod` 包），只做展示。
- 下载列表的"已安装/可更新"标记依赖 `RemoteAddon` 缓存，不要自己算。
- 崩溃分析 `CrashReportAnalyzer` 是纯逻辑，直接调用，输出到弹窗。

---

## 2. 账号与外观管理

### 2.1 三种账号的权限模型（需求原文拆解）

| 账号类型 | 皮肤 | 披风 |
|---|---|---|
| 离线 | 本地导入/编辑/删除，宽体+纤体，存启动器目录 | 本地导入/编辑/删除，渲染含鞘翅形态 |
| 微软 | **本地保存**，点"应用"才上传 | 只能选服务器上已有的，选择后 `PUT capes/active` |
| 外置认证 | 只读预览（从服务器拉） | 只读预览，引导去平台改 |

正版披风这条上一轮已经做完：`MicrosoftAccount.getCapes()` + `setActiveCape()`（对应 `PUT/DELETE /minecraft/profile/capes/active`）。这轮只是把它接到新的外观页。

### 2.2 存储设计

```
%HMCL_HOME%/appearance/
  <accountID>/
    state.json          {"skin":"<id>","cape":"<id>","model":"slim|wide","capeMode":"cape|elytra"}
  skin-library/
    index.json          （已有）
    <sha1>.png
  cape-library/
    index.json
    <sha1>.png
```

- 皮肤/披风文件都按内容哈希存，去重；账号目录只存引用。
- 需求里"防止文件丢失导致数据错误"：读文件失败时回退默认皮肤 + 提示，不抛异常到 UI。
- "重选覆盖不备份"：`setIconData` 已有的写法可以直接复用——写临时文件再原子替换，不做 `.bak`。

### 2.3 外观页布局

左右两栏，符合需求原文：

```
┌──────────────────────────┬──────────────────────────┐
│  左：SkinCanvas 实时渲染   │ 右：标签 [皮肤][披风]      │
│  320×420，可拖拽旋转      │   网格：已导入的文件       │
│  右下角：披风 / 鞘翅 切换  │   右键：编辑 / 重选 / 删除  │
│                          │   底部：导入文件           │
│  下方：模型 宽体 / 纤体    │                          │
└──────────────────────────┴──────────────────────────┘
```

- 右键菜单项：应用、重命名、重选文件（弹"是否覆盖当前皮肤？否→取消，是→直接覆盖不备份"）、删除。
- 模型切换：`NormalizedSkin.isSlim()` 自动判定 + 手动覆盖，存 `state.json`。

### 2.4 鞘翅渲染（本轮唯一需要新写几何的地方）

现状：`SkinCanvas` 只有 `capeCube`（10×16 的平板），没有翅膀。HMCL 的 CSL 兼容层里虽然解析了 `elytra` 字段（`Skin.java:235`），但**没有渲染**。

做法：

1. 新增 `ElytraGroup`：左右各一片，几何用两个带弯曲的 `MeshView`（每片 4×2 段，向外张开约 30°，末端下垂），贴在背后。
2. UV：Minecraft 的鞘翅纹理布局与披风同为 64×32（`0,0` 起 10×16 是正面），所以**同一张披风纹理可以直接采样**；如果用户导入的是独立 elytra 纹理（64×32），走同一条路径。
3. 显隐：`capeMode = "cape"` 时显示 `capeGroup`，`"elytra"` 时显示 `elytraGroup`，两者互斥。
4. 右下角切换按钮 → `canvas.setCapeMode(mode)`，立即重绘。
5. 导入披风时的双预览：模态框里并排两个小 `SkinCanvas`（披风态 / 鞘翅态），复用同一个纹理。

工作量：几何 + UV 调参约 200 行，调外观是最花时间的部分（翅膀角度、厚度、是否双层）。

### 2.5 保留项

- 复制 UUID：`FXUtils.copyText(account.getProfileID().toString())`，已有。
- 自定义 UUID：`CreateAccountPane` 高级选项里已有（`txtUUID` + `UUIDValidator`，`CreateAccountPane.java:492-511`），新页面照搬字段即可。
- 账号名限制：不要自己写正则，复用 HMCL 的校验器（离线名长度/字符集限制），保证行为一致。

---

## 3. 只内置 LittleSkin

> **状态：已满足**，无需改动。

**已经满足**：`AuthlibInjectorServerList.java:66-67` 在初始化时只自动加 `https://littleskin.cn/api/yggdrasil/` 一个。
UI 上把"添加服务器"做成二级入口（先显示 LittleSkin 卡片 + 一个"添加其他服务器"按钮），不需要改后端。

---

## 4. aria2 下载

### 4.1 现状

HMCL 的下载是一个任务图：每个文件一个 `FileDownloadTask`（支持候选 URL、sha1 校验、HTTP 缓存复用、进度回调）。
`FileDownloadTask` 的传输层是 `HttpURLConnection` 单连接流式下载。

### 4.2 方案

不要重写下载任务图，只换传输层：

```
下载任务图（不变） → FileDownloadTask.execute()
                        ↓ 新分支
                   Aria2Engine.submit(urls, target, checksum)
                        ↓
                   aria2c --enable-rpc，JSON-RPC: aria2.addUri
                        ↓
                   onDownloadComplete → 校验 sha1 → 落到目标路径
```

- **常驻一个 aria2c 进程**（`--enable-rpc --rpc-listen-port=随机 --rpc-secret=<随机>`），启动器退出时 kill。
- 批量提交：HMCL 的版本安装一次会下发几百到上千个文件，逐个 RPC 太碎，按 200 个一批 `addUri`，配合 `--max-concurrent-downloads=16`。
- 参数：`--split=16 --max-connection-per-server=16 --min-split-size=1M --file-allocation=none --continue=true`。
- 校验：aria2 只负责搬字节，sha1 校验仍由 HMCL 侧做（`FileDownloadTask.IntegrityCheck`），失败则标记该任务重试。
- 候选 URL：aria2 的 `addUri` 支持多 URI 数组（我们传 `DownloadCandidates` 的列表），天然兼容 BMCLAPI 镜像回退。
- 离线/aria2 不存在时：**自动回落到原 `HttpURLConnection` 实现**，不让启动器变砖。

### 4.3 分发与许可

- Windows 随包带 `aria2c.exe`（约 5 MB），Linux/macOS 优先用系统 `aria2c`，没有就提示安装或回落。
- aria2 是 GPL-2.0-or-later，与本仓库 GPL-3.0 兼容；需要在 `THIRD-PARTY-NOTICES` 里注明。

### 4.4 风险

- aria2 对**签名 URL**（Mojang 资源带 `?t=` 签名）没问题，但**不能改写 URL**，镜像替换要在提交前完成。
- 大量小文件（assets 的 3000+ 个）用 aria2 反而可能不如 HMCL 的并发池，需要按文件大小分流：`>1MB` 走 aria2，小文件走原实现。
- 进度聚合：aria2 的 `tellStatus` 轮询（500ms）汇总到 HMCL 的总进度条，不要每个文件一个回调。

---

## 5. 整页前端 + 去掉窗口状态条

> **状态：已实现（2026-10-28）**。`Decorator.setTitleBarVisible(false)` + 页面自绘 38px 顶栏，
> 拖拽 / 双击最大化 / 四边四角缩放全走 `WebBridge`。截图见 `docs/shot-home.png`。

### 5.1 现状

`Decorator` → `MainWindowPane` 里 `frame.setTop(titleBar)`（`MainWindowPane.java:127`），标题栏包含导航、刷新、最小化/最大化/关闭。
对话框挂在 `Decorator.getDialogContainer()` 上，`Controllers.dialog()` 依赖它。

### 5.2 做法（保留 Decorator，只拆标题栏）

1. `Decorator` 增加 `setTitleBarVisible(boolean)`，内部 `mainWindowPane.setTitleBarVisible(v)` → `frame.setTop(v ? titleBar : null)`。
2. Web 模式下调用 `setTitleBarVisible(false)`；同时 `decorator.setCustomWindowShadow(...)` 保持阴影。
3. Web 页面顶部自绘 40px 标题栏（logo / 页面名 / 最小化 / 最大化 / 关闭），拖拽走已有的 `bridge.dragStart/dragMove`，双击最大化走 `toggleMaximize`。
4. 边缘缩放：目前只有右下角把手（`resizeStart/resizeMove`）。补四边 + 四角（8 个热区），或在 Web 模式恢复 `stage.setResizable(false)` + 固定尺寸。建议补热区，体验更像原生。
5. 最大化状态下的拖拽恢复：`dragMove` 里判断 `stage.isMaximized()`，先 `setMaximized(false)` 再按比例还原窗口位置。

风险：`Decorator` 的 `capableDraggingWindow(titleBar)` 注册的拖拽处理器会随 `setTop(null)` 失效，Web 侧需要自己处理（已实现）。
另外，HMCL 的"贴边分屏"是 `stage.setMaximized` 之外的系统行为，自绘标题栏后可能丢失，需要在 `stage` 上保留 `StageStyle.DECORATED` 之外的 `stage.setResizable(true)` + `Screen` 计算补回。

---

## 6. 性能

### 6.1 先定位，不要瞎猜

HMCL 卡的原因通常是四类，先加测量再改：

| 症状 | 真实原因 | 验证方法 |
|---|---|---|
| 整页滚动卡 | JavaFX 场景图节点过多（模组列表几百行没虚拟化） | `-Dprism.showdirty=true` 看重绘区域 |
| 启动/切页卡 1–2 秒 | 同步 IO：Java 扫描、实例大小、图标解码 | 打点日志 |
| 持续掉帧 | 无 GPU 加速，走软件渲染 | `FXUtils.GRAPHICS_PIPELINE` 日志（HMCL 已打印） |
| 内存涨 | 图标/皮肤 Image 缓存不释放 | JFR / `jcmd GC.heap_info` |

### 6.2 换成 WebView 后的针对性优化

1. **JavaFX 层**：确保 `prism.order=d3d`（Windows），否则窗口本身就在软件合成。
2. **WebView 层**：不用 `backdrop-filter` 大面积模糊（实测支持但代价高），阴影改成 1px 边框 + 小范围 `box-shadow`；页面切换只做 opacity/transform。
3. **列表虚拟化**：模组/下载列表超过 200 项时只渲染可视区（自己写一个 30 行的 windowing）。
4. **图片**：头像/图标 base64 一次性下发后放 `Map` 缓存；列表滚动不重新解码。
5. **状态推送**：现在 `push()` 每次全量 JSON，实例多时会重复序列化图标 base64。改成增量：`onInstances(json)` / `onAccount(json)` / `onSizes(json)` 分开推。
6. **后台任务**：大小统计、图标解码用单线程池 + 300ms 合并；不要每个实例一个 Task。
7. **JVM 参数**：启动器不需要大堆和并发 GC，`-Xmx512m -XX:+UseSerialGC -XX:TieredStopAtLevel=1`（最后一项会牺牲峰值性能，先测再定）。
8. **启动阶段**：首屏只取前 5 个实例的完整信息，其余懒加载（滚到再取）。

### 6.3 可验证指标

加 `-Dhmcl.web.perf=true`，输出：
- 首帧耗时（WebView `SUCCEEDED` → 首次 `onState` 渲染完成）
- 每次状态推送的序列化耗时 + 字节数
- 切页耗时
- 常驻内存（`Runtime.totalMemory - freeMemory`）

目标：首屏 < 800ms，切页 < 120ms，常驻 < 350MB。

---

## 7. 需要你拍板的三件事

1. **"100% 复刻"的范围**：我按 P1/P2/P3 分批，先做 P1（实例详情、模组、实例设置、下载版本+加载器、启动器设置）。如果要求一次性全上，工期会翻倍且中间态不可用。
2. **aria2 分发形态**：随包带 `aria2c.exe`（安装包 +5MB，开箱可用），还是检测系统 aria2（包小，但 Windows 用户大多没有）。
3. **鞘翅**：用披风纹理模拟（同一张图，两套几何），还是要支持独立的 `elytra.png`（64×32）单独导入？后者要多一个文件槽位和一套 UV。

---

## 8. 建议的落地顺序

1. **第 1 步（2–3 天）**：拆标题栏 + Web 自绘顶栏 + 边缘缩放 + 性能埋点。做完之后页面才是"整页"的。
2. **第 2 步（1–1.5 周）**：外观页（皮肤/披风/鞘翅 + 三种账号权限）。这块独立性强，做完能立刻用。
3. **第 3 步（分批）**：实例详情 → 模组管理（点击禁用）→ 实例设置 → 下载页。
4. **第 4 步（3–5 天）**：aria2 传输层 + 分流 + 回落。
5. **第 5 步**：长尾页面 + 性能收敛。

每步都用 `-Dhmcl.web.shot` 出截图 + `--smoke` 自检，提交前跑一遍编译，保证随时可回滚。
