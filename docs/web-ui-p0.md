# Web UI P0：首页 + 账号

`-Dhmcl.ui.web=true` 时用 WebView 页面替换 HMCL 原主页，其余能力（窗口装饰、对话框、Toast、
主题、下载、启动器逻辑）仍走 HMCL 原实现。下载页目前是占位。

## 一、改了哪些文件

| 文件 | 作用 |
|---|---|
| `HMCL/src/main/java/org/jackhuang/hmcl/ui/web/WebUIPage.java` | 承载 WebView，加载页面、注入桥、推送状态、截图验收 |
| `HMCL/src/main/java/org/jackhuang/hmcl/ui/web/WebBridge.java` | 全部 Java ↔ JS 方法：状态、实例、图标、账号、动态 |
| `HMCL/src/main/resources/assets/web/index.html` | 页面结构：侧栏 / 首页 / 账号页 / 实例页 / 下载占位 / 设置 |
| `.../assets/web/app.css` | 明暗两套 CSS 变量 + 卡片 / 网格 / 表格 / 弹窗样式 |
| `.../assets/web/app.js` | 渲染、路由、图标裁剪器、桥调用 |
| `HMCL/src/main/java/org/jackhuang/hmcl/ui/Controllers.java:297` | 启动时按开关导航到 WebUIPage |
| `buildSrc/.../JavaFXUtils.java:41` | `MODULES` 加 `web`、`media` |
| `HMCL/src/main/resources/assets/openjfx-dependencies.json` | 补齐 12 平台 × 2 版本的 `javafx-web` / `javafx-media` 条目（含 sha1） |

## 二、数据是怎么取的（全是 HMCL 现有 API，没有造轮子）

| 需求 | 实现 |
|---|---|
| 实例列表 | `GameDirectoryManager.getSelectedRepository().getDisplayInstances()` |
| 当前实例 | `GameDirectoryManager.getSelectedInstance()` / `setSelectedInstance()` |
| 实例名 | `instance.getId().toString()`（HMCL 3.17 里实例名就是目录 ID） |
| 游戏版本 | `instance.getVersion().toString()`；探测失败（缺 jar）时回退 `manifest.id()` |
| 加载器 + 版本 | 遍历 `GameComponentType.MOD_LOADERS`，`instance.getComponentVersion(type)`，用 `ModLoaderType.displayName()` 取显示名 |
| Java 版本 | `instance.getResolvedManifest().javaVersion().majorVersion()` |
| 占用大小 | 后台 `Files.walk(instanceRoot)` 累加，算完推送一次（不进主线程） |
| 最后启动 | `logs/latest.log` 的 mtime，缺失时退化为实例目录 mtime |
| 实例图标 | `instance.getIconImage()`，转 base64 PNG 给前端 |
| 账号渠道 | `Accounts.getLocalizedLoginTypeName(Accounts.getAccountFactory(account))`；外置认证优先显示 `AuthlibInjectorAccount.getServer().getName()`（LittleSkin 等） |
| 头像 | `TexturesLoader.skinBinding(account)` 拿皮肤，裁 `(8,8)` 8×8 脸，叠帽子层，放大到 64×64 转 base64 |
| 启动 | `Instances.launch(instance)` |
| 打开目录 | `Instances.openFolder(instance)` |
| 登录 | `CreateAccountPane(FACTORY_OFFLINE)` / `MicrosoftAccountLoginPane` / `AddAuthlibInjectorServerPane` |

## 三、图标：内置 / 自定义 / 整合包

- **内置**：`GameInstanceIconType` 全部 15 个（DEFAULT、GRASS、CHEST、CHICKEN、COMMAND、OPTIFINE、
  CRAFT_TABLE、FABRIC、FORGE、NEO_FORGE、QUILT、FURNACE、APRIL_FOOLS、CLEANROOM、LEGACY_FABRIC），
  由 Java 侧 `getIcon()` 转 base64 传给前端做九宫格。
- **自定义 + 1:1 裁剪**：前端弹窗里选图（`bridge.pickImage()` 返回原图 data URL）→ canvas 裁剪器
  （拖动平移、滚轮缩放、固定正方形取景框）→ 导出 256×256 PNG → `bridge.setIconData()` →
  `instance.setIconFile()` 写成实例目录下的 `icon.png`。
- **整合包图标**：不用额外做。HMCL 在安装整合包时已经把图标复制成实例根目录的 `icon.<ext>`
  （CurseForge / Modrinth 下远程 `iconUrl`，MultiMC 下读 `instance.cfg` 的 `iconKey`），
  所以 `getIconFile()` / `getIconImage()` 天然能拿到整合包图标。

## 四、首页

- Hero：当前实例（图标、名称、加载器徽章、整合包徽章、版本·加载器版本、Java、大小、上次启动）+ 启动 / 打开目录
- 实例网格：**最多 5 个**，点击即 `setSelectedInstance` 切换，右上角 ✎ 打开图标选择器
- 动态：Mojang 官方更新日志（见下）

## 五、"动态"到底是什么

之前截图里那 4 条是**写死的假数据**（原型 `Bridge.getState()` 里的硬编码 JSON）。这次换成了真实来源：

`GET https://launchercontent.mojang.com/v2/javaPatchNotes.json`

这是**官方启动器自己用的内容接口**，无需鉴权。返回 `entries[]`，每项有 `title`、`shortText`、
`date`、`image.url`，`contentPath` 还能拼出详情页链接。后端在 `WebBridge.fetchPatchNotes()` 里取前 8 条，
前端渲染前 4 条（缩略图 + 标题 + 摘要 + 日期）。失败时显示"动态加载失败：<原因>"，不影响其它功能。

## 六、验证情况

| 项 | 结果 |
|---|---|
| `:HMCL:compileJava` / `shadowJar` | 通过 |
| 启动并切到 Web UI | 通过（日志 `Web UI enabled, switching main page to WebView`） |
| 真实实例列表（3 个演示实例） | 通过，版本 / 加载器 / 大小 / 时间都正确，见 `docs/shot-home.png` |
| 内置图标 | 通过（Forge 砖块、Fabric 羊毛、NeoForge 熔炉图标自动匹配） |
| 动态接口 | 通过，`docs/shot-home.png` 里是真实 Mojang 内容与缩略图 |
| 账号页 | 通过（`docs/shot-accounts.png`），三种登录入口在 |
| 登录后皮肤头像 | **未验证**：演示环境 accounts.json 为空，没有可登录账号 |
| 自定义图标裁剪 → 写盘 | **未验证**：需要鼠标交互，截图模式点不到 |
| 启动游戏 | 未验证（演示实例没有真实 jar） |

## 七、怎么跑

```bash
cd /e/MCLab
source env/env.sh

# 正常启动（首次会下载 javafx-web ~37MB）
java -Dhmcl.ui.web=true -jar dist/HMCL.jar

# 已有 JavaFX 时用模块路径，启动更快
java --module-path webui-shell/lib --add-modules javafx.controls,javafx.web,javafx.media \
     -Dhmcl.ui.web=true -jar dist/HMCL.jar

# 无头验收截图
java ... -Dhmcl.ui.web=true -Dhmcl.web.page=accounts -Dhmcl.web.shot=out.png -jar dist/HMCL.jar
```

## 八、下一步

1. 下载页：版本清单 / 加载器 / 整合包（照搬 `DownloadPage` 的 provider 逻辑，只换 UI）
2. 实例页：重命名、复制、删除、导出、模组列表
3. 登录后头像与衣柜联动（`SkinLibrary` + `WardrobePane` 换成 Web 实现）
4. 实例名支持自定义别名（HMCL 目前只有目录 ID，需要加 `alias` 字段到 `GameSettings.Instance`）
