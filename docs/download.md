# 下载页实现

## 一、链路

```
前端「安装」按钮
  → WebBridge.installVersion(id)
    → DownloadService.installVersion(id)
      → HMCLGameRepository.getDependency(DownloadProviders.getDownloadProvider())
      → dependencyManager.newGameBuilder(instanceId)
      → builder.component(GAME, id) → builder.buildAsync()
        → executor（HMCL 原生的 Task 链，多源候选 + sha1 校验 + 重试）
  ← TaskListener.onRunning 推阶段名
  ← onDone 后 repository.setSelectedInstance(...) 并推「安装完成」
```

**没有重写任何下载逻辑。** 多源候选（官方 / BMCLAPI）、sha1 校验、失败重试、
资源索引、库文件去重全在 `HMCLCore` 里，重写一遍只会引入新的边界 bug。

## 二、实测（本机跑完一次完整安装）

```
[download] -      | 正在获取版本清单…            （1 秒）
[download] 1.21.5 | 准备安装 1.21.5…
[download] 1.21.5 | 读取版本信息
[download] 1.21.5 | 解析版本依赖
[download] 1.21.5 | 下载游戏本体
[download] 1.21.5 | 下载依赖库
[download] 1.21.5 | 获取资源索引
[download] 1.21.5 | 下载游戏资源
[download] 1.21.5 | 安装完成 | done
```

产物核对：

| 项 | 结果 |
|---|---|
| `versions/1.21.5/1.21.5.jar` | 28,984,409 B |
| `versions/1.21.5/1.21.5.json` | 126,873 B，113 个 libraries，assetIndex `24` |
| `assets/` | 418 MB |
| `libraries/` | 69 MB |
| 装完是否自动选中 | 是（`setSelectedInstance` 已生效，页面收到 `onInstallFinished`） |

## 三、阶段名为什么要翻译

`TaskListener.onRunning` 给的是任务自己的 `getName()`，里面混着三种东西：

- 类名：`GameLibrariesTask`（能看，但英文）
- 裸 URL：`https://bmclapi2.bangbang93.com/v1/objects/xxx/client.jar`
- 内部标识：`org.jackhuang.hmcl.download.DefaultGameBuilder$$Lambda/0x...@7292b5ee`

直接推给界面就是一堆乱码似的字符串。处理方式是「白名单翻译 + 过滤」：

```java
if (raw.startsWith("http") || raw.contains("$") || raw.contains("@")
        || raw.contains("(") || raw.endsWith(".json") || raw.endsWith(".jar")) return null; // 丢弃
switch (raw) { case "GameLibrariesTask": return "下载依赖库"; ... }
```

丢弃时**保留上一条可读文案**，界面不会忽然空掉。

## 四、边界处理

| 情况 | 行为 |
|---|---|
| 本地已有同名实例 | 清单里那行直接显示「已安装」且按钮禁用；后端再拦一次（`findInstance` 非空就直接返回，不抛异常） |
| 清单还没拉完就点安装 | 提示「版本清单还没加载完，稍后重试」（正常 UI 下点不到，因为行还没渲染） |
| 同时点两个安装 | 前端 `dlInstalling` 只允许一个；仓库草稿是排他的，并发会直接失败 |
| 安装失败 | Toast 显示具体异常，进度条收起，按钮恢复可点 |
| 装完 | 就地改「已安装」+ 刷新页面状态 + 切到新实例 |

## 五、验收参数

```bash
# 打开下载页并截图（版本清单会真的从 Mojang 拉）
-Dhmcl.web.page=download -Dhmcl.web.size=1366x768 -Dhmcl.web.shot=out.png

# 注入脚本，验证需要点击才走到的路径（本轮就是这么跑通完整安装的）
-Dhmcl.web.js="setTimeout(function(){window.nativeBridge.installVersion('1.21.5')},5000)"
```

`-Dhmcl.web.*` 这组覆盖现在与截图解耦（`applyOverrides()` 在截图分支之前统一执行），
所以不带 `-Dhmcl.web.shot` 也能用它们做交互验证。

## 六、加载器（本轮已接）

### 入口

点版本行的「安装」不再直接开装，而是弹一个选项窗：

```
安装 26.3
[ 原版 ][ Fabric ][ Quilt ][ Forge ][ NeoForge ]
  ↓ 选任一加载器
  列出该游戏版本可用的加载器版本（默认选最新）
[ 取消 ][ 安装 ]
```

### 后端

```java
// 列表：统一入口，provider 内部按类型走不同数据源
provider.getVersionsAsync(type, GameVersionNumber.asGameVersion(gameVersion), false)

// 安装：同一个 builder，挂两个组件
builder.component(GameComponentType.GAME, gameVersion);
builder.component(loaderRemoteVersion);
if (repository.shouldIsolateNewInstance(true)) builder.enableIsolation();
```

关键点：

1. **版本对象要留在内存里**。前端只传得回一个版本号字符串，安装阶段必须拿到
   `ComponentRemoteVersion` 本体，否则得再拉一次清单。缓存 key 是 `patchId@游戏版本`。
2. **实例名 `<游戏版本>-<patchId>-<加载器版本>`**，例如 `1.21.5-fabric-0.20.1`，
   与原版并存、不覆盖。
3. 加载器列表 `provider` 有的分支返回全量，必须再按 `getGameVersion()` 过滤一次。

### 实测（Fabric）

```
[download] 1.21.5-fabric-0.20.1 | 读取版本信息
[download] 1.21.5-fabric-0.20.1 | 下载游戏本体
[download] 1.21.5-fabric-0.20.1 | 获取资源索引
[download] 1.21.5-fabric-0.20.1 | 下载游戏资源
[download] 1.21.5-fabric-0.20.1 | 安装 Fabric
[download] 1.21.5-fabric-0.20.1 | 下载依赖库      （Fabric 那批库）
[download] 1.21.5-fabric-0.20.1 | 安装完成 | done
```

产物核对：`1.21.5-fabric-0.20.1.json` 128,930 B / 121 个 libraries，
其中 `net.fabricmc:fabric-loader:0.20.1`、`net.fabricmc:intermediary:1.21.5`、
`mainClass = net.fabricmc.loader.impl.launch.knot.KnotClient` —— 是可直接启动的实例。

### 阶段名的第二种坑

同一个任务有两种名字：类名 `GameLibrariesTask`，和 `setName` 过的裸名 `FabricInstall`。
只映射一种的话界面会一半中文一半英文。现在两套都覆盖。

## 七、下一步

- 整合包：`ModpackInstallWizardProvider` 那条链路，涉及 zip 解析与依赖下载
- 真实进度百分比：`Task` 没有统一进度源，需要按 `TaskExecutor` 的 stage 数与已完成数估算，
  或者接入 `TaskListener` 之外的文件级进度
- 实例体积：现在卡片上的「184 B」只统计实例目录，不含共享的 assets / libraries，
  数字小得让人误解，需要改成「实例 + 共享」或者标注口径
