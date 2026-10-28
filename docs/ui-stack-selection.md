# 启动器 UI 技术选型（基于 HMCL 改造）

结论先说：**在「保留 HMCL core」这个前提下，唯一低成本的 WebView 路线是 JavaFX 自带的 WebView。**
它的实际能力比传闻好得多——本机实测 WebKit 625.1（≈ Safari 18.4 内核），CSS Grid / `backdrop-filter` /
`:has()` / `color-mix()` 全部支持，唯一缺口是 WebGL。要更强就上 JCEF，要发布级体积就上 Tauri + core 服务化。

下面是数据、对比和落地路径。

---

## 一、先看 PCL2 / PCL2 CE 到底用了什么

| 项目 | 语言 / UI 框架 | 许可证 | 平台 |
|---|---|---|---|
| PCL2（Plain Craft Launcher 2） | C# + WPF + XAML | LGPL-3.0 | 仅 Windows，需 .NET Framework 4.8 |
| PCL2 CE（社区版） | C# + .NET 8/10 + WPF + XAML | 主目录自定义许可，其余 Apache-2.0 | Windows 完整支持，macOS/Linux 仅交叉编译 |

也就是说 PCL2 那一套"现代感"来自 XAML + 自有控件库，不是 WebView。想照抄它的观感，不需要抄技术栈——
它的视觉特征（大圆角卡片、左侧导航、渐变主色、信息密度高）用 CSS 完全能复刻，本仓库的
`webui-shell` 原型就是一版参考。

**和 PCL2 的差异（你要求的"不完全一样"）**：

- 技术栈不同：C#/WPF → Java + Web（跨平台，跟着 HMCL 走 Windows/macOS/Linux）
- 布局不同：PCL2 是左侧窄导航 + 顶部标签页；原型用左侧完整侧栏 + 单页路由
- 信息层级不同：PCL2 把版本列表做成主表格；原型把"当前实例"提升成 Hero 区，列表降为卡片网格
- 主题系统不同：PCL2 用 XAML 资源字典；原型用 CSS 变量，明暗两套、可运行时热切

---

## 二、实测：JavaFX WebView 到底够不够现代

跑 `webui-shell` 的 `--smoke` 模式，拿到的真实数据（Windows 10/11 + JDK 21.0.12.1 + JavaFX 21.0.13）：

```
UA: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/625.1
    (KHTML, like Gecko) JavaFX/21 Version/18.4 Safari/625.1

CSS Grid        ✅      flex gap        ✅      CSS 变量        ✅
backdrop-filter ✅      aspect-ratio    ✅      color-mix()     ✅
position:sticky ✅      :has()          ✅      WebGL           ❌
devicePixelRatio 2（HiDPI 正常）
```

关键点：

1. **WebKit 625.1 是 2026 年 10 月 OpenJFX CPU 才带上的版本**（21.0.13 / 25.0.5 / 27.0.1 都是这个）。
   HMCL 现在用的 21.0.8 还停在 615.1，升级 LTS 小版本就能吃到内核更新。
2. 网上说"JavaFX WebView 是版本黑洞、不支持 CSS Grid"的文章，讲的是 JavaFX 8 时代。2026 年不成立。
3. **真正的缺口只有 WebGL**。启动器 UI 不需要 WebGL；如果要做粒子/星空背景，用 canvas2d 或 CSS 动画。
4. 渲染是软件路径，性能瓶颈在"大面积模糊 + 高频重绘"。约束自己：动画只用 `transform` / `opacity`，
   模糊层面积控制在 200×200 以内，页面切换用淡入而不是滑动整屏。

截图见 `webui-shell/shot-light.png`、`shot-dark.png`。

---

## 三、候选方案对比（体积是本机实测的 jar 大小）

| 方案 | 渲染内核 | 增量体积 | 进程模型 | 与 HMCL core 集成成本 | 前端生态 | 主要风险 |
|---|---|---|---|---|---|---|
| **JavaFX WebView** | WebKit 625.1 | **+35.9 MB**（`javafx-web-21.0.13-win.jar` 实测 37,603,369 B，另需 `javafx-media` 1.1 MB） | 同进程 | **低**：`JSObject` 直接互调，无 IPC | 全量 npm | 无 WebGL；软渲染；IME 需实测 |
| JCEF / jcefmaven | Chromium 152 | 引导 jar 仅 30 KB，首次运行下载原生包，解压后 100 MB 量级 | 独立渲染进程 | 中：AWT 组件，要 `SwingNode`/`JFXPanel` 嵌套 | 全量 npm，可开 devtools | 分发体积、native 解压、与 JavaFX 焦点/输入法打架 |
| Tauri 2 + core 服务化 | 系统 WebView2（Chromium） | 安装包 3–10 MB + JRE（jlink 约 60 MB） | 双进程 | **高**：HMCL core 要脱 JavaFX、改成 JSON-RPC 服务 | 全量 npm | 重构量大，`Schedulers.javafx()` 等处的 UI 耦合要拆 |
| Electron | Chromium 150 | 85–250 MB | 双进程 | 高（同 Tauri） | 全量 npm，最成熟 | 太重，和"轻量"冲突 |
| Avalonia + .NET 重写 | Skia 自绘 | 与 HMCL 无关 | — | 等于另起项目 | .NET 生态 | 丢掉 HMCL 全部积累 |

补充：JCEF 的 `jcef-natives-windows-amd64` Maven 制品只有 689 字节——它是引导层，真正的
Chromium 二进制在首次运行时从 GitHub Release 下载并解压。这一点在"离线可用 / 首启体验"上要计入成本。

---

## 四、推荐方案

### 主推：JavaFX WebView + Web 前端

理由排序：

1. **零新增运行时**。javafx-web 是 JavaFX 官方模块，HMCL 本来就在运行时下载 JavaFX
   （`SelfDependencyPatcher` + `assets/openjfx-dependencies.json`），加一个模块就完事。
2. **桥接最简单**。`engine.executeScript` + `window.setMember("nativeBridge", obj)`，同步调用，
   没有 IPC、没有端口、没有进程生命周期管理。
3. **前端生态无损**。Vue/React/Svelte 随便选，组件库随便用。
4. **可回退**。WebView 页面和现有 JavaFX 页面可以共存，一个 `-Dhmcl.ui.web=true` 开关切换，
   逐页替换，替换失败的页面还能退回旧实现。

### 备选：JCEF

只在以下情况选它：需要 devtools 调试、需要 WebGL/Canvas 高性能、需要 100% 一致的 Chromium 渲染。
代价是分发体积从 ~100 MB 涨到 ~200 MB，且 AWT/JavaFX 焦点与中文输入法的问题是长期维护负担。

### 长期：Tauri + core 服务化

如果目标是"发布一个 70 MB 以内、启动 300 ms 的启动器"，这是终局形态。但前提是把 HMCL core 从
JavaFX 里剥出来——`HMCLCore` 目前大量使用 `javafx.beans` 的 `ObjectBinding`/`ObservableList`，
`Schedulers.javafx()` 也散布在各处。这个改造是月级别的，不适合"先跑起来看看效果"。

---

## 五、前端技术栈选型

WebView 里跑什么，决定了开发速度。

| 组合 | 组件数量 | 体积（gzip 后） | 适合 |
|---|---|---|---|
| **Vue 3 + Naive UI** | 90+ | ~120 KB | 推荐。TS 完整、主题系统好、中文文档、按需引入、无全局样式污染 |
| React + shadcn/ui + Tailwind | 组件源码复制，可按需改 | ~90 KB | 要极致定制、能接受自己拼装 |
| Svelte 5 + Skeleton | 60+ | ~60 KB | 体积敏感，团队熟 Svelte |
| 原生 Web Components + 手写 CSS | 自己写 | ~20 KB | 只做 10 个页面以内，不想背框架 |

启动器需要的组件类型很固定：侧栏导航、卡片网格、表格、对话框、进度条、Toast、下拉框、开关、
文件选择按钮、皮肤预览容器。Naive UI 全部覆盖，且暗色主题是内置的。

原型用的是**零依赖手写 CSS/JS**（约 700 行），目的是证明"不引框架也能做出这个观感"，
真项目建议换 Naive UI 省时间。

---

## 六、在 HMCL 里怎么落地

### 6.1 加 javafx-web 依赖

三处改动，缺一不可：

1. `buildSrc/src/main/java/org/jackhuang/hmcl/gradle/javafx/JavaFXUtils.java`
   ```java
   public static final String[] MODULES = {"base", "graphics", "controls", "web", "media"};
   ```
   （`javafx.web` 依赖 `javafx.media`，不加会在启动时报 `Module javafx.media not found`——
   这个坑我在原型里踩过。）

2. `HMCL/src/main/resources/assets/openjfx-dependencies.json`
   给每个平台 / 每个版本档补上 `javafx.web`、`javafx.media` 两条，带 `sha1`。
   文件由 `generateOpenJFXDependencies` 任务生成，但它要访问 `repo1.maven.org` 拉 sha1，
   国内网络容易失败；实测可直接从镜像取 `.sha1` 文件手工补。

3. `HMCL/build.gradle.kts` 的 `--add-modules` 列表加上 `javafx.web`、`javafx.media`。

### 6.2 目录与类结构

```
HMCL/src/main/java/org/jackhuang/hmcl/ui/web/
  WebUIPane.java        // 持有 WebView，负责加载、桥注入、异常兜底
  WebBridge.java        // 暴露给 JS 的方法集合
  WebStateCodec.java    // Account / Profile → JSON DTO
  WebEventPump.java     // Java 侧状态变化 → JS 事件
HMCL/src/main/resources/assets/web/
  index.html
  assets/app.[hash].js
  assets/app.[hash].css
```

### 6.3 桥接协议

原则：**JS 只做展示，所有状态变更走 Java**。

```java
// Java → JS（同步返回 JSON 字符串）
String state();                       // 账号、实例列表、设置、主题
String instanceDetail(String id);     // 某个实例的详情
void   launch(String id);             // 启动
void   openFolder(String id);         // 打开目录
void   selectInstance(String id);
void   setTheme(String mode);

// Java → JS（事件推送，JS 侧 window.__hmcl.onEvent(type, payloadJson)）
//   "profile-changed" / "download-progress" / "launch-log" / "account-changed"
```

**不要**让 JS 直接调网络（下载、认证）。HMCL 的下载器有镜像、重试、断点续传、并发控制，
在 JS 里重写一遍等于把最复杂的部分推倒重来。

### 6.4 i18n 与主题

- i18n：启动时把 `I18N_<locale>.properties` 序列化成 `window.__i18n = {...}`，前端 `t(key)` 取值。
  不要在 JS 里再维护一份文案。
- 主题：HMCL 的 `Themes` 提供 MonetFX 调色板（`-monet-primary` 等）。桥里把当前调色板导成
  CSS 变量注入 `:root`，前端样式全部引用变量，就能跟着 HMCL 的主题包走。

### 6.5 分阶段迁移

| 阶段 | 内容 | 产出 |
|---|---|---|
| P0 | 外壳 + 主页（实例卡、启动按钮、账号区） | 能启动游戏，其余页面还是旧 JavaFX |
| P1 | 实例页（列表、详情、模组管理入口） | 日常使用可只走 Web |
| P2 | 下载页（版本 / 加载器 / 整合包） | 复用现有 `DownloadProvider`，UI 重画 |
| P3 | 账号页 + 设置页 | 衣柜（上轮做的）接进来 |
| P4 | 删旧页面 | 移除 `ui/main/*Page.java` 里被替换的部分 |

每个阶段都能单独发布，`RootPage` 里按开关决定加载哪套页面。

---

## 七、风险清单（都是实打实的，不是理论风险）

| 风险 | 影响 | 对策 |
|---|---|---|
| **中文输入法** | 账号密码、搜索框在 WebView 里 IME 候选框可能不跟随光标 | 必须尽早实测；不行的话这两处输入框用 JavaFX 原生控件叠在 WebView 上 |
| **无 WebGL** | 不能做 3D 皮肤实时旋转（衣柜那个需求） | 皮肤预览继续用 JavaFX `SkinCanvas`，用 `JFXPanel`/截图流嵌进页面；或前端只做静态图 |
| 软渲染性能 | 大面积模糊 + 高频动画掉帧 | 限制模糊面积、动画只做 transform/opacity、列表虚拟滚动 |
| 文件拖放 | HTML5 DnD 在 WebView 里拿不到 `File` 对象 | 拖放走 Java 侧 `setOnDragOver`，拿到路径后通过桥回传 |
| 剪贴板 | `navigator.clipboard` 在 file:// 下受限 | 走桥：`copyText(String)` / `String readClipboard()` |
| 调试 | 没有 devtools | ① Chrome 直接打开同一份 HTML 调样式 ② console 转发到 Java 日志 ③ `--smoke` 自检进 CI |
| 首屏白屏 | 加载本地 HTML 有短暂空窗 | 关键 CSS 内联、`<body>` 里放骨架屏、JS 加载完再淡入 |

---

## 八、原型怎么跑

见 `webui-shell/README.md`。三条命令：

```bash
cd webui-shell
./build.sh                     # javac，不依赖 gradle
./run.sh                       # 打开窗口
./run.sh --smoke --shot=out.png # 无头验收：打印能力自检 + 截图 + 退出
```

原型证明了三件事：WebView 能承载现代布局、Java 桥同步调用够用、无边框窗口的拖动/缩放可行
（`dragStart/dragMove` + 右下角 `resizeStart/resizeMove`）。
