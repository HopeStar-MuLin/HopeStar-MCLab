# 外观页（皮肤 / 披风 / 鞘翅）

状态：**数据链路与页面已完成，鞘翅的展示角度还在调。**

## 一、这次修掉的崩溃

第一次跑起来直接崩在启动阶段：

```
NullPointerException: Cannot invoke "java.nio.file.Path.getFileSystem()" because "path" is null
  at AppearanceStore.<init>(AppearanceStore.java:160)
```

原因：`AppearanceStore` 里 `INSTANCE` 的声明写在 `SKIN_DIR / CAPE_DIR / STATE_DIR` 之前。
Java 静态字段按**文本顺序**初始化，单例构造时这几个路径还是 null，`Files.createDirectories(null)` 直接 NPE，
外层被包成 `ExceptionInInitializerError`。

修法：把 `ROOT / SKIN_DIR / CAPE_DIR / STATE_DIR` 挪到 `INSTANCE` 之前，并加注释防止再犯。

顺带发现第二个问题：验收截图的 `savePng(webView.snapshot(...))` 只抓了 WebView 节点，
3D 预览是它的兄弟节点，所以截图里永远是空白——改成 `WebUIPage.this.snapshot(...)` 抓整页。

## 二、已实现

### 存储

```
%HMCL_HOME%/appearance/
  skins/<id>.png            皮肤原图（按内容 SHA-1 前 16 位命名，自动去重）
  capes/<id>.png            披风原图
  capes/<id>.elytra.png     可选：同一披风附带的独立鞘翅贴图
  skins.json / capes.json   索引（名称、模型、是否含鞘翅）
  state/<accountID>.json    该账号选中的皮肤、披风、模型、背饰形态
```

导入是「先写临时文件再原子替换」，重选同名文件不会留下半截文件、也不做备份（按需求）。
读坏了只影响那一张图，回退默认皮肤，不会让页面崩掉。

### 页面

左 320×420 实时 3D 预览 + 右侧「皮肤 / 披风」标签页：

- 左下：宽体 / 纤体切换、披风 / 鞘翅切换、应用到账号
- 右侧网格：已导入资源，右键重命名 / 删除；点击即切换预览
- 皮肤卡片显示「宽体 / 纤体」徽章；披风卡片显示「含鞘翅」徽章
- 正版账号：披风标签页改为服务器列表（`GET /minecraft/profile` 的 `capes[]`），选中只改预览，点应用才 `PUT capes/active`
- 外置认证：只读预览，底部提示去平台改，导入/应用按钮禁用

### 3D 预览

用的是覆盖层方案：`SkinCanvas` 作为 JavaFX 节点盖在 WebView 上方，
前端通过 `bridge.setPreviewRect(getBoundingClientRect())` 告诉 Java 摆哪里。
好处是不用把渲染结果转成图片传输，旋转拖拽是原生的 60fps。

`SkinCanvas` 新增：

```java
public enum CapeMode { CAPE, ELYTRA }
public void setCapeMode(CapeMode mode)
public void setYaw(double degree)                       // 观察角度
public void updateSkin(skin, slim, cape, elytraTexture) // 披风与鞘翅贴图可以不同
```

## 三、鞘翅规则（按你的要求实现）

1. 导入披风时**可以一次选两张图**：第一张披风，第二张鞘翅。第二张存在时 `hasElytra=true`，
   渲染鞘翅用第二张；不存在时 `elytraTexture = cape`，直接用披风图套上去。
2. 正版账号的披风没有独立鞘翅图（Mojang 不下发），所以走回退分支——用披风贴图渲染鞘翅，
   这正是原版游戏的表现。
3. 几何：左右各一片 4×6 网格的曲面，向外张开 22°，末端向前弯，UV 取披风图案区 `(1,1)-(11,17)`，
   左翼镜像。

## 四、验证情况

| 项 | 结果 |
|---|---|
| 编译 / shadowJar | 通过 |
| 启动不再崩溃 | 通过 |
| 外观页渲染 | 通过（`docs/shot-appearance.png`） |
| 皮肤库列表 / 选中预览 | 通过 |
| 3D 人物渲染 | 通过 |
| **鞘翅几何** | **通过（隔离测试）**：`docs/shot-elytra-test.png` 两片翅膀正常出图 |
| 鞘翅在整机预览里的位置/角度 | **未达标**：翅膀是近乎平行于背部的平面，正面/侧面视角下几乎看不到，需要调整张开角与观察角度 |
| 导入裁剪 / 右键菜单 / 应用上传 | 未验证（需要鼠标交互，截图模式点不到） |

隔离测试的复现方式：`webui-shell/src/main/java/webshell/SkinTest.java`，
只把 `ElytraModel` 放进一个最小 SubScene 渲染，排除父容器与相机干扰。

## 五、下一步

1. 调鞘翅视觉：把张开角从 22° 加到 35–40°，末端加一点向外翻；默认观察角改为背面 3/4
   （当前 `setYaw` 的角度映射还没标定，需要一组合成截图对照）。
2. 补「披风 / 鞘翅」双预览弹窗（导入时并排两个小预览）。
3. 正版账号的皮肤上传做实际验证（需要真实账号点一次应用）。
4. 之后再进下载页 + 内置 aria2（`aria2c.exe` 随包分发，默认 16 线程）。

---

## 六、追加：3D 预览从「覆盖层」改为「出图」（2026-10-28 下午）

覆盖层方案（把 JavaFX 画布盖在 WebView 上，按前端上报的矩形对位）在实践中反复出问题：

- 页面一旦滚动，画布和卡片就错位，人物浮在别的内容上；
- 宽度不够时 CSS 换行，卡片变窄，画布还是 320 宽，人物溢出卡片；
- 窗口高度不够时用媒体查询压矮卡片，画布不跟着变，头顶被裁掉。

这些都属于「两套坐标系靠约定对齐」的固有缺陷。改为：

1. 画布固定在场景里（放在 WebView **下面**，用户看不见），尺寸固定 320×420；
2. 每次状态变化后 `preview.snapshot()` 出 PNG → base64 → 通过 `window.__hmcl.onPreview(dataUrl)` 推给页面；
3. 页面里就是一个 `<img>`，`object-fit: contain`，位置/裁剪完全交给 CSS；
4. 拖动图片旋转 → `bridge.rotatePreview(dx)` → 重出图。

代价是拖动旋转从 60fps 降到「每次移动重出图」（几十毫秒一次，实测可接受）；
换来的是**任何窗口尺寸、滚动、换行都不会错位**。

## 七、本轮 UI 修的问题

| 问题 | 原因 | 修法 |
|---|---|---|
| 实例卡片挤在左边，右侧空一条 | 网格用 `auto-fill`，不回收空轨道 | 改 `auto-fit`，最小宽 200px |
| 皮肤卡片被拉到整行宽 | 同上（`1fr` 拉伸） | 固定 `112–132px` 轨道 + `justify-content:start` |
| 滚动条压住卡片右边 | WebKit 滚动条占宽 | 自定义 8px 细滚动条 |
| 窗口变窄时 Hero 按钮挤文字 | 单行 flex 挤压 | `flex-wrap: wrap` + `flex: 1 1 260px` |
| 标题过长顶到窗口按钮 | 标题没有省略 | `min-width:0` + `text-overflow: ellipsis` |
| 矮窗口下图标弹窗被截断 | 弹窗无高度约束 | `max-height: 90vh; overflow-y: auto` |
| 点弹窗边缘变成拖窗口 | 缩放热区 z-index 高于弹窗 | 弹窗 z-index 提到 50 |
| 切页后停在半截 | 内容区保留上次滚动位置 | 切页时 `scrollTop = 0` |
| 实例表格列互相压 | 列宽比例固定 | 改 `minmax()` + 固定列宽 |

## 八、验收截图（两种窗口尺寸）

`docs/ui-home-960x640.png`、`ui-home-1440x900.png`、`ui-appearance-960x640.png`、
`ui-appearance-1440x900.png`、`ui-accounts-960x640.png`、`ui-instances-960x640.png`。

验收方式：`-Dhmcl.web.size=960x640` 控制窗口尺寸，`-Dhmcl.web.page=home|appearance|accounts|instances`
控制落地页，`-Dhmcl.web.shot=<path>` 出图。
