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
