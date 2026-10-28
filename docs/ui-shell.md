# Web UI 骨架与分辨率自适应

> 参考对象：`E:\项目（乐色）\QQ-Bot\desktop`（HopeStar-Desktop，Tauri + 原生 JS）。
> 只借「怎么让同一份页面在任意窗口尺寸下都不塌」的骨架，视觉仍用自己的。

## 一、参考项目实际怎么做的（读源码得到的结论，不是猜）

它的「分辨率自调整」是三层，缺一层都会出问题：

### 1. 窗口层（Rust，`desktop/tauri/src/main.rs`）

```rust
fn fit_to_screen(app, design_w, design_h) -> (f64, f64) {
    const MARGIN: f64 = 0.92;
    let mon = app.primary_monitor()?;
    let sf  = mon.scale_factor();
    // 🔴 用 work_area 而不是 size —— size 含任务栏
    let avail_w = mon.work_area().size.width  as f64 / sf;
    let avail_h = mon.work_area().size.height as f64 / sf;
    (design_w.min(avail_w * MARGIN), design_h.min(avail_h * MARGIN))
}
```

三条结论：

1. **必须用「工作区」而不是整屏**。它原来的 0.96 系数在 1920×1080@125% 上算出来 829，
   而工作区只有 816 —— 直接顶到任务栏底下 13px。
2. **最小尺寸要单独算**，不能共用 0.92 折减。共用的话 960×640 会变成 883×589，
   用户能把窗口拖到比设计最小值还小，布局就塌了。
3. 拿不到显示器信息时要**往小里估**（×0.92），宁可让用户拖大。

### 2. 骨架层（CSS）

```
.desktop   竖向：自绘标题栏 36px + .desk-body
.desk-body 横向：.rail（58px 图标条 ⇄ 188px 展开）+ .content
.content   竖向：.page-head（固定）+ .page-body（唯一滚动容器）
```

关键在最后一行：**页面里只有一处滚动**。多一层内滚动，矮窗口必然出现
「内层滚完外层滚」，表现就是内容看着被裁掉了。

### 3. 内容层（CSS 断点）

```css
.host-grid { grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); }
.ov-cols   { /* 宽屏：左卡 + 右 330px 栏 */ }
@media (max-width: 1100px) { .ov-cols { flex-direction: column } .ov-side { width: 100% } }
@media (max-width:  640px) { .ov-bots { grid-template-columns: 1fr } }
```

断点只有两级，但方向明确：**先让右栏落到底部，再让卡片变单列**。

## 二、移植到本项目的东西

| 层 | 本项目的做法 | 与原项目的差别 |
|---|---|---|
| 窗口 | `WebUIPage.fitWindowToScreen(stage)`：`Screen.getVisualBounds()`（JavaFX 已排除任务栏）× 0.92，最小尺寸 × 0.98 单独算，居中 | JavaFX 屏幕坐标本身就是逻辑像素，**不需要**再除 scale factor |
| 骨架 | 标题栏 38px + `.desk-body`（rail 64 ⇄ 196）+ `.page-head` + `.page-body` | 标题栏保留本项目的圆角窗控，不用 Windows 那种贴边方块 |
| 侧栏 | 图标条 ⇄ 展开，状态存 `localStorage['mclab.rail.open']`；窗口 < 900px 强制收起 | 原项目靠手动锁定，这里让窄窗口自动收起 |
| 选中态 | 胶囊底色（`--accent-soft`） | 去掉了它的「左侧竖条」——那是它的视觉签名 |
| 断点 | 1180 / 1000 / 760 宽度 + 720 高度 | 多一级 760，用来砍表格的 Java 列 |

## 三、三条硬规矩（写进 `app.css` 头部注释）

1. **页面里不许有第二个滚动容器**。`page-body` 是唯一滚动体。
2. **宽度和高度分开治理**：宽度靠 `auto-fit` 网格 + 断点折栏；高度只在
   `@media (max-height: 720px)` 里压缩纵向节奏。两者混用会导致
   「窄但高」和「宽但矮」两种窗口都调不好。
3. **页面标题放页头，不放标题栏**。标题栏只负责窗口身份（logo）和窗口操作。

## 四、踩到的坑

| 现象 | 原因 | 修法 |
|---|---|---|
| 实例卡片被拉成两列超宽、第三个掉到下一行 | `repeat(auto-fit, minmax(240px, 380px))` —— 上界给了绝对值，auto-fit 按上界算列数 | 改 `minmax(250px, 1fr)` + 容器 `max-width: 1140px` |
| 窄窗口外观页出现「预览 + 一排控件 + 右下大片空白」 | 控件是 `.ap-left` 的直接子元素，flex 换行后被拆散 | 加 `.ap-side` 包裹层，窄屏时整块排在预览右侧 |
| 点 logo 会把窗口拽歪 | 拖拽监听在整条标题栏上 | 只有 `.tb-drag` 区域内才 `dragStart` |
| 切页后页面停在半截 | 复用同一滚动容器 | 切页时 `page-body.scrollTop = 0` |

## 五、验收方式

```bash
# 三种窗口尺寸 × 两个页面，全部无人值守出图
-Dhmcl.web.size=1366x768     # 1366×768 笔记本
-Dhmcl.web.size=880x620      # 最小尺寸附近，验证窄屏折栏
-Dhmcl.web.size=1600x900     # 宽屏，验证卡片不被拉伸
-Dhmcl.web.page=home|appearance|accounts|instances
-Dhmcl.web.rail=open|closed  # 侧栏展开/收起态
-Dhmcl.web.shot=out.png
```

截图：`docs/shell-home-1366x768.png`、`shell-appearance-1024x680.png`、
`shell-appearance-880x620.png`、`shell-rail-closed.png`、`shell-accounts.png`。

## 六、下一步（动画）

当前的过渡只有两处：`.page.on` 的 `pageIn`（8px 上浮 + 淡入）、
卡片 hover 的上浮与阴影。曲线统一 `cubic-bezier(.22,1,.36,1)`，
只动 `transform` / `opacity`，不动 `width/height/top/left`
（后者每帧触发布局重排，是 WebView 里掉帧的主因）。
