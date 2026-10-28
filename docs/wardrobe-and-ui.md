# 衣柜（皮肤库 + 披风）与 UI 改造笔记

## 一、这次改了什么

### 新增

| 文件 | 作用 |
|---|---|
| `HMCL/src/main/java/org/jackhuang/hmcl/ui/account/wardrobe/SkinLibrary.java` | 本地皮肤库：磁盘存储、索引、去重、应用（上传/写本地） |
| `HMCL/src/main/java/org/jackhuang/hmcl/ui/account/wardrobe/WardrobePane.java` | 衣柜面板：3D 预览 + 皮肤网格 + 披风网格 + 应用 |

### 修改

| 文件 | 改动 |
|---|---|
| `HMCLCore/.../auth/microsoft/MicrosoftService.java` | `MinecraftProfileResponseCape` 补字段（id/state/url/alias）；新增 `getProfile()`、`setActiveCape()` |
| `HMCLCore/.../auth/microsoft/MicrosoftAccount.java` | 新增 `getCapes()`、`setActiveCape(String)` |
| `HMCL/src/main/java/org/jackhuang/hmcl/game/TexturesLoader.java` | 新增 `capeBinding(Account)`、`loadRemoteTexture(String)` |
| `HMCL/.../ui/account/AccountListItem.java` | 正版/外置账号的皮肤入口改为打开衣柜（原来弹系统文件选择框） |
| `HMCL/src/main/resources/assets/css/root.css` | 追加 `.wardrobe-*` 样式（走 `-monet-*` 主题色，跟随主题包） |
| `assets/lang/I18N.properties`、`I18N_zh_Hans.properties` | 新增 9 个键 |

## 二、行为

### 皮肤

- 存储：`%USERPROFILE%\.hmcl\skin-library\`
  - `index.json`：`{version, entries[{id,name,model,addedAt,source}], applied{accountUUID: entryId}}`
  - `<id>.png`：原始文件字节，`id` = 内容 SHA-1 前 16 位（同图重复导入自动去重）
- 导入：文件选择框或**把 PNG 拖进预览区**；只用原图，不重编码
- 应用：
  - 正版账号 → `POST /minecraft/profile/skins`（multipart，`variant=slim|classic`）
  - HD 皮肤（>64px）→ 上传前最近邻降采样到 64×64（官方接口不接受 HD）
  - `64x32` 老格式原样上送
  - 离线账号 → 写 `OfflineAccount.setSkin(LOCAL_FILE, ...)`，保留原有披风路径

### 披风（正版）

之前判断"官方无披风接口"是错的，官方有：

| 操作 | 接口 |
|---|---|
| 列出拥有的披风 | `GET https://api.minecraftservices.com/minecraft/profile` → `capes[{id,state,url,alias}]` |
| 换披风 | `PUT /minecraft/profile/capes/active`，body `{"capeId":"<uuid>"}` |
| 不显示披风 | `DELETE /minecraft/profile/capes/active` |

`state=ACTIVE` 的那条就是当前穿戴的。切换成功后 `profileRepository.invalidate(profileID)`，让 sessionserver 纹理缓存失效。

### 渲染

完全复用现有 `SkinCanvas`：

```java
canvas.updateSkin(skinImage, isSlim, capeImage);   // 第三个参数之前一直是 null
```

- 披风方块 `SkinCube(10,16,1,...)` 与骨骼 `capeGroup` 本来就在 `SkinCanvas` 里，`updateSkin` 传非 null 即显示
- 选中皮肤网格 / 披风网格**只改预览**，不写服务器；点"应用"才提交
- 这就是"实时查看当前皮肤搭配"：同一帧里同时换皮肤贴图和披风贴图

## 三、现有 UI 盘点

### 框架层

| 模块 | 文件 | 复用点 |
|---|---|---|
| 页面骨架 | `ui/decorator/DecoratorAnimatedPage.java`、`DecoratorPage.java` | 自绘标题栏 + 左右分栏 + 动画切页 |
| 根路由 | `ui/main/RootPage.java` | 左侧导航栏 + 页面栈 |
| 导航项 | `ui/construct/AdvancedListBox.java`、`AdvancedListItem.java` | 侧边栏条目 |

### 通用控件（`ui/construct/`，37 个）

`LineButton`/`LineComponent`/`LineSelectButton`/`LineToggleButton`（设置项行）、`MultiFileItem`（多选一文件源）、`FileSelector`、`ImagePickerItem`、`OptionsList`、`TabControl`、`HintPane`、`SpinnerPane`、`MessageDialogPane`、`TaskListPane`、`ComponentList`。

做自己的 UI 时，这套控件是最省事的：`LineButton` 就是"标题 + 副标题 + 右侧控件"的标准行。

### 页面

| 页面 | 文件 | 备注 |
|---|---|---|
| 账号 | `ui/account/AccountListPage.java` + `AccountListItem(Skin).java` | 卡片列表，右侧操作按钮组 |
| 离线皮肤 | `ui/account/OfflineAccountSkinPane.java` | 已有 3D 预览 + 皮肤/披风本地文件选择，衣柜的布局参考它 |
| 微软登录 | `ui/account/MicrosoftAccountLoginPane.java` | OAuth 设备码 / 内嵌 WebView |
| 下载 | `ui/download/` | 版本、模组、整合包、光影、远程整合包 |
| 实例 | `ui/instances/` | 实例列表、实例设置、模组管理 |
| 个性化 | `ui/main/PersonalizationPage.java` | 主题色、明暗、背景、字体、主题包 |
| 主题包管理 | `ui/main/ThemePackManagementPage.java` | 安装/导出/删除主题包 |
| 皮肤渲染 | `ui/skin/SkinCanvas.java` + `SkinCube`/`SkinGroup`/`SkinAnimation`/`SkinHelper` | JavaFX 3D，可直接嵌到任何 Pane |

### 皮肤渲染能力（`SkinCanvas`）

- 支持 64×32 自动补成 64×64（`SkinHelper.x32Tox64`）、HD 放大、slim/wide 手臂宽度切换
- 披风方块 + 10° 倾斜 + 独立材质
- 内置动画：`SkinAniRunning`、`SkinAniWavingArms`；`enableRotation(0.5)` 鼠标拖拽旋转
- 结论：**不需要引入任何第三方 3D 皮肤库**

## 四、主题包能改到哪一步

HMCL 3.17 有主题包系统（`theme/ThemePackManifest.java`），zip 放到 `~/.hmcl/themes/`。

可配（`ThemeAppearance`）：

```json
{
  "color": {...},          // 种子色
  "brightness": "...",     // 明/暗
  "colorStyle": "...",     // MonetFX 配色风格
  "contrast": "...",
  "background": {...},     // 图片/渐变/网络图
  "titleBar": {"transparent": true},
  "windowTransparent": true
}
```

**不可配**：布局、控件结构、页面顺序。也就是说主题包只能换"皮"，换不了"骨头"。

要真正换一套 UI（侧边栏改成顶部标签、卡片改成表格、动效重做），只有两条路：

1. 改 JavaFX 代码（`ui/` 下逐页重写，`root.css` 重做）
2. 换前端技术栈重写外壳（HMCL 的 core 是 Java，外壳可以套 Compose / 甚至本地 HTTP + WebView）

## 五、MIT 许可这件事

事实：`HMCL/LICENSE` 是 **GPL-3.0** 全文，不是 MIT，也不是 LGPL。

GPL-3.0 的约束只发生在**分发**时：

| 场景 | 能不能标 MIT |
|---|---|
| 自己改、自己用、不发布 | 无所谓，GPL 义务未触发 |
| 发布改过的 HMCL（二进制或源码） | 不能。衍生作品必须 GPL-3.0，且提供完整源码 |
| 想以 MIT 发布 | 不能包含任何 HMCL 代码 |

如果目标是"一个能公开发布的 MIT 启动器"，可行路径只有重写：

- 外壳：自己写（JavaFX / Compose Desktop / Tauri + Web 前端）
- 核心：自己实现，或用许可证兼容的核心库（例如 `CmlLib.Core`、`minecraft-launcher-lib` —— 用之前逐个核对 LICENSE 文件与版本）
- 认证：Microsoft OAuth 设备码流程可以自己实现（公开协议，不涉及 HMCL 代码）
- 皮肤渲染：3D 模型搭法可以参考思路，代码要自己写

反过来，如果只是自用 + 小圈子内部分发（GPL 允许，只要给源码），那直接在这个 fork 上改是最快的，没有必要纠结 MIT。

## 六、编译与运行

```bash
export JAVA_HOME="/c/Program Files/Java/jdk-21.0.12.1"
export MAVEN_CENTRAL_REPO="https://maven.aliyun.com/repository/public"

cd HMCL
./gradlew :HMCL:shadowJar -x test --offline
# 产物: HMCL/HMCL/build/libs/HMCL-3.17.SNAPSHOT.jar
```

本次已构建并复制到 `dist/HMCL-wardrobe.jar`（11.7 MB）。

运行：

```bash
java -jar dist/HMCL-wardrobe.jar
```

验证状态：

- `:HMCL:compileJava` ✅
- `:HMCL:shadowJar` ✅
- GUI 启动 ❌ 未执行（本机已有 HMCL 实例在跑，避免配置目录锁冲突）
- 皮肤上传 / 披风切换 ❌ 未实测（需要真实正版账号点击）

## 七、下一步可做的

1. 衣柜入口再加一个：账号卡片上直接显示当前披风缩略图
2. 皮肤库支持导入 LittleSkin / CSL 的 URL（`Skin.Type` 已有枚举，缺 UI）
3. 披风列表加 alias 本地化（`Migrator` / `Vanilla` / `Mojang` 这类官方别名可映射成中文）
4. 衣柜里加"随机搭配"按钮（皮肤 × 披风随机组合预览）
