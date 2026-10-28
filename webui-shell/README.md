# WebView 外壳原型

用来验证「HMCL core 保留 + 前端换 Web 技术栈」这条路到底行不行。跑起来是个能拖 windows、
能切页面、能切主题的启动器外壳，数据是桥里写死的 mock。

## 结构

```
webui-shell/
  lib/                         JavaFX 21.0.13 (base/graphics/controls/web/media, win)
  src/main/java/webshell/
    WebShell.java              窗口 + WebView + JS 桥 + 冒烟/截图模式
  src/main/resources/ui/
    index.html                 页面结构（侧栏 / 标题栏 / 四个页面）
    app.css                    主题变量 + 卡片/网格/表格样式，明暗两套
    app.js                     渲染、路由、拖窗、缩放、能力自检
  build.sh                     编译
  run.sh                       运行
  shot-light.png / shot-dark.png   实测截图
```

## 跑

```bash
export JAVA_HOME="/c/Program Files/Java/jdk-21.0.12.1"
./build.sh
./run.sh
```

无人值守验收（会打印自检结果然后退出，不留在前台）：

```bash
./run.sh --smoke --shot=shot.png
./run.sh --smoke --theme=dark --shot=shot-dark.png
```

## 实测结果（本机 Java 21.0.12.1 + JavaFX 21.0.13）

UA：`Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/625.1 (KHTML, like Gecko) JavaFX/21 Version/18.4 Safari/625.1`

| 能力 | 结果 |
|---|---|
| CSS Grid | 支持 |
| flex `gap` | 支持 |
| CSS 自定义属性 | 支持 |
| `backdrop-filter` | 支持 |
| `aspect-ratio` | 支持 |
| `color-mix()` | 支持 |
| `position: sticky` | 支持 |
| `:has()` | 支持 |
| WebGL | **不支持** |
| devicePixelRatio | 2（HiDPI 正常） |

结论：WebKit 625.1 相当于 Safari 18.4 的内核水平，现代 CSS 基本不缺。唯一硬缺口是 WebGL
——启动器 UI 用不到，真要粒子效果用 canvas2d 或 CSS。

## 换成真数据要改哪里

`WebShell.Bridge.getState()` 返回的 JSON 就是前后端契约。接到 HMCL core：

```java
// 现在
return "{...mock...}";

// 替换成
Map<String, Object> state = new LinkedHashMap<>();
state.put("user", Accounts.getSelectedAccount());          // 走一遍 getProfileName/头像
state.put("versions", profileManager.getProfiles().values()); // 转成 DTO
state.put("selectedInstance", Profiles.getSelectedProfile());
return JsonUtils.GSON.toJson(state);
```

`launch(String id)` 换成调用 `LauncherHelper.launch(...)`；`minimize/close` 换成对
`Controllers.getStage()` 操作。

## 调试方式

JavaFX WebView 没有开箱 devtools。实际做法：

1. **直接用 Chrome 打开 `src/main/resources/ui/index.html`** —— 没有桥时 `app.js` 会走兜底分支渲染空状态，样式和布局完全一致。CSS/JS 在这里调，调完再进 JavaFX 验证。
2. 页面里的 `console` 通过 `call('log', ...)` 转发到 Java 标准输出。
3. `--smoke` 模式把 `window.__diagnostics` 打到 stdout，适合放进 CI 做回归。
