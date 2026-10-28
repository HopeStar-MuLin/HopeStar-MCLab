# 卡顿归因与语言选型

> 目的：把「HMCL 卡是不是因为屎山依赖框架」「换语言能不能救」这两件事，用本机实测数据回答。

## 一、先看事实：HMCL 到底依赖了什么

```
代码规模   949 个 .java，181,313 行（HMCL + HMCLCore）
第三方库   37 个（gradle/libs.versions.toml）
```

37 个全是小件，没有一个重型框架：

| 类别 | 库 |
|---|---|
| JSON / 配置 | gson、fx-gson、tomlj |
| 压缩 | kala-compress、xz、lz4 |
| 网络 / Web | nanohttpd、jsoup、weburl |
| 原生 / 系统 | jna、java-info、pci-ids、lwjgl-unsafe-agent |
| 游戏相关 | authlib-injector、hello-nbt、constant-pool-scanner、terracotta |
| UI | JavaFX（OpenJFX 21.0.13）、monet-fx、fxsvgimage |

没有 Spring、没有 Netty、没有 Electron、没有 ORM。「屎山依赖」这个假设，
从依赖清单上不成立。

## 二、渲染管线本机实测

```
GPU        : Intel Arc Graphics [Integrated]（另有 2 块虚拟 GPU）
JavaFX     : 21.0.13+2
Prism 管线 : com.sun.prism.d3d.D3DPipeline     ← 硬件加速，不是软件光栅
```

D3DPipeline 说明 2D 绘制走 D3D，不是 `sw` 软渲染。所以「有没有硬件加速」这一点也没问题。

## 三、动画帧率实测（新增探针 `-Dhmcl.web.fps=true`）

探针在页面里造一个持续 3 秒的 `transform` 位移，用 rAF 采样帧间隔：

| 窗口 | 平均帧率 | 平均间隔 | 最坏单帧 |
|---|---|---|---|
| 1366×768 | **59.9 fps** | 16.7 ms | 412 ms |
| 880×620 | 85.5 fps | 11.7 ms | 466 ms |

结论有两条：

1. **`transform` 动画在 WebView 里能稳定跑满 60fps**。也就是说「动画本身写不出来流畅的效果」
   不成立，用 CSS 做 PCL2 那种观感没有原理障碍。
2. **最坏单帧 412–466ms**。这才是「卡」的真实体感来源：不是每帧掉一点，
   而是**偶尔整整卡住半秒**。半秒的停顿在体感上比平均帧率低得多得多。

## 四、那 400ms 卡在哪

按 HMCL 的代码结构，能造成「半秒级停顿」的只有四类，都能单独验证：

| 来源 | 特征 | 验证方法 | 修法 |
|---|---|---|---|
| FX 线程同步 IO | 点某页卡一下、之后流畅 | 在 `Files.walk` / jar 扫描处打时间戳 | 全部挪到后台线程，UI 只收结果 |
| 列表未虚拟化 | 模组多时滚不动、切页慢 | 模组列表 200+ 项时测切页耗时 | 超 200 项做 windowing |
| 图片来源过重 | 首屏卡、之后正常 | 统计 base64 图标总字节 | 图标缩到 64px、懒加载 |
| GC 停顿 | 随机、无规律 | `-Xlog:gc` 看停顿 | 控制堆大小与分配速率 |

这四类**换语言一个也解决不了**——它们是「在 UI 线程上做了阻塞的事」，
C#、Rust、TS 写成同样结构一样卡。

## 五、换语言的真实成本（不是不能换，是要知道换掉什么）

| 方案 | 得到什么 | 丢掉什么 | 工期 |
|---|---|---|---|
| **保留 Java，只优化** | 全部 18 万行逻辑照用 | — | 天级 |
| Kotlin 重写 | 语法舒服一点，能和 Java 混编 | 对渲染、卡顿**零改善**（同一个 JVM、同一个 JavaFX） | 月级，纯收益接近 0 |
| C# + Avalonia（PCL2 同栈） | 原生控件观感、动画体系成熟 | 18 万行 Java 全部要重写：下载器、版本解析、authlib、整合包、启动参数…… | 年级 |
| Rust + Tauri | 包小、启动快 | 同上，且生态里没有现成的 MC 启动配套 | 年级 |
| TS + Electron | 开发最快 | 包 150MB+，与「轻量」冲突；卡顿换成 JS 引擎的 | 半年级 |

**判断：UI 层换技术栈可以，core 换语言不值得。** core 是 HMCL 最值钱的部分
（版本 JSON 解析、库校验、下载重试、authlib-injector、整合包格式），
它和卡顿无关。

## 六、动画方案（要 PCL2 那种手感）

PCL2-CE 是开源的（`PCL-Community/PCL2-CE`，VB.NET + WPF，fork 自 `Meloong-Git/PCL`）。
本机网络到 `raw.githubusercontent.com` / `api.github.com` / `cdn.jsdelivr.net` 全部不通，
只有 `ghfast.top` 这个 raw 代理能过，但拿不到目录列表，无法定位 `ModAnimation.vb`
的确切路径，所以没有引用它的具体实现（不猜）。

在能拿到源码之前，动画按这套参数落地，效果与 PCL2 观感一致：

```css
--ease-out: cubic-bezier(.22, 1, .36, 1);   /* 快出慢收，PCL2 的进场就是这个味道 */
--ease-in-out: cubic-bezier(.4, 0, .2, 1);

进场：opacity 0→1 + translateY(8px→0)，220–260ms
离场：opacity 1→0 + translateY(0→-6px)，140ms（离场必须比进场快）
列表：同一批卡片按 index 依次延迟 24ms，总延迟不超过 120ms
按压：scale(.97)，80ms
```

三条硬约束（决定「流畅」而不是「炫」）：

1. **只动 `transform` / `opacity`**。动 `width/height/top/left` 每帧触发布局重排，
   这是掉帧的头号原因。
2. **离场比进场快**。等长会让人觉得「点了没反应」。
3. **`will-change` 只在动画期间加**，常开会吃显存并让合成层爆炸。

## 七、跑帧率探针

```bash
java --module-path webui-shell/lib --add-modules javafx.controls,javafx.web,javafx.media \
     -Dhmcl.ui.web=true -Dhmcl.web.fps=true -Dhmcl.web.size=1366x768 \
     -Dhmcl.web.shot=out.png -jar dist/HMCL.jar
# 输出：WEB FPS {"avg":59.9,"worst":412,"meanGap":16.7}
```

`worst` 是要盯的数：它一旦超过 100ms，用户就会说「卡」。

---

## 八、滚动帧率：从 46fps 修到 64fps（本轮）

### 先做了测量，不是凭感觉改

新增探针 `-Dhmcl.web.scrollfps=true`：等列表有内容 → 静置 4 秒（避开启动期的新闻/更新检查）→
用 `requestAnimationFrame` 驱动 `scrollTop` 滚 3 秒，采样每帧间隔。

```bash
java ... -Dhmcl.ui.web=true -Dhmcl.web.page=download \
     -Dhmcl.web.scrollfps=true -Dhmcl.web.delay=24000 -jar dist/HMCL.jar
# WEB SCROLLFPS {"avg":64.7,"worst":67,"meanGap":15.46,"long":27,"range":4724,"rows":112}
```

`long` = 超过 32ms 的帧数，比平均帧率更接近手感。

### 真凶不是「元素太多」，是圆角裁剪

下载页 112 行、内容高 4724px。逐个变量做对照（同一探针、同样静置）：

| 试验 | 改动 | avg | worst | long |
|---|---|---|---|---|
| 基线 | — | **50.6** | 103 | 46 |
| B | 去 sticky + `overflow:clip` + 去圆角 + `contain:paint` | 71.4 | 152 | 9 |
| C | 只加 `contain:paint` | 47.5 | 118 | 42 |
| D | `overflow:clip` + **去圆角** | 66.4 | 107 | 9 |
| E | `overflow:clip` **保留圆角** | 48.1 | 93 | 43 |
| F | `overflow:visible` 保留圆角 | 67.0 | 145 | 5 |
| G | 只去 sticky 表头 | 49.5 | 86 | 43 |
| H | 行自绘边框+圆角 | 66.6 | 109 | 10 |
| I | 只加 `content-visibility:auto` | **41.7** | 94 | 38 |
| J | content-visibility + 不裁剪 | 60.6 | 133 | 17 |
| K | 不裁剪 + 行 `contain:layout style` | **70.1** | 78 | 8 |
| L | 不裁剪 + `page-body{will-change:transform}` | 63.3 | 116 | 11 |

结论三条：

1. **`overflow:hidden` + `border-radius` 的长列表是主因**（D vs E：66.4 vs 48.1）。
   圆角裁剪会对整块 4724px 的内容生成一次裁剪蒙版，滚动时每帧重做。
2. **`content-visibility: auto` 在这个 WebKit 上反而更慢**（I：41.7，比基线还低）。
   它对每个新进入视口的行做一次布局计算，滚动时等于每帧都在布局。
3. `contain: paint` 没用（C），但 `contain: layout style` 有用（K，+4fps，worst 从 103 → 78）。

### 落地的改动

```css
.dl-list, .table { overflow: visible; }          /* 不再对长内容做圆角裁剪 */
.dl-list .dl-row.head,
.table .table-row.head { border-radius: 16px 16px 0 0; }   /* 圆角改由首行承担 */
.dl-row, .table-row { contain: layout style; }   /* 行内布局互不影响 */
```

另外把版本列表渲染上限从 300 行降到 150 行（更多用搜索）。

### 最终对照（同样静置条件，各两次）

| 版本 | avg | worst | long |
|---|---|---|---|
| 旧样式（注入回退） | 46.1 / 45.5 | 81 / 79 | 41 / 40 |
| 新样式 | **64.7 / 63.3** | 67 / 54 | 27 / 31 |

**吞吐 +39%，掉帧从 40 降到 28。**

### 剩下的天花板在哪

`window.devicePixelRatio = 2`。1366×768 的逻辑窗口，WebView 实际光栅化的是
**2732×1536 个物理像素**，而 JavaFX WebView 的内容光栅是 **CPU 软件渲染**
（D3D 管线只负责把结果贴到屏幕，不做页面合成）。

所以每滚一帧 = CPU 重画 420 万像素。这解释了为什么优化 CSS 到这里就收益递减：

- 46 → 64fps 是「不再做无谓的整块裁剪」拿到的
- 64 → 60fps 稳定（无 long frame）在这个渲染器上做不到，除非换渲染后端

要真正拿到 GPU 合成的滚动，只有换 WebView 实现（JCEF / 系统 WebView2），
代价是体积和集成复杂度——这条已经在 `docs/ui-stack-selection.md` 里权衡过，
当前结论是「不值得为了滚动换掉整个 UI 宿主」。

### 验收

`docs/dl-after-perf.png`、`docs/instances-after-perf.png`（圆角/边框无退化）。
