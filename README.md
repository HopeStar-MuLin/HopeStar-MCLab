<div align="center">
  <img src="logo.gif" width="88" alt="HopeStar-MCLab">
  <h1>HopeStar-MCLab</h1>
  <p><b>选个版本，点启动。剩下的它来。</b><br>
  Windows 10 / 11 · 解压即用 · 免费开源</p>
</div>

---

下载、解压、双击，三步进游戏。
装模组、换皮肤、找整合包，都在一个窗口里点完 —— 不用记路径，不用改配置文件，不用自己装 Java。

## 先看看长什么样

### 首页 · 打开就能开游戏

![首页](assets/screenshots/home.jpg)

最近在玩的版本摆最上面，点「启动游戏」直接进。
想换版本，下面卡片点一下就切过去。

### 版本管理 · 一个版本一个格子

![实例管理](assets/screenshots/instances.jpg)

每个格子叫一个「实例」，就是一个游戏版本加上它自己的模组、存档和设置。
装新版本不会把老存档弄乱，不想要的单独删掉就行。
点「管理」进去，能看到这个版本装了什么模组、有哪些存档和截图。

### 下载 · 游戏、模组、整合包，一个页面找齐

![游戏下载](assets/screenshots/download.jpg)

- **游戏本体**：正式版、快照、远古版，一百多个版本随便挑
- **模组加载器**：Forge、Fabric、NeoForge、Quilt、Cleanroom、OptiFine，一键装好，装之前先告诉你这个版本支持不支持
- **整合包**：搜到就能直接装成一个新版本，不用自己解压
- **模组、资源包、光影、地图**：按你当前的版本筛好，点一下就进对应文件夹

### 皮肤 · 能转能看的 3D 小人

![皮肤](assets/screenshots/skins.jpg)

### 披风 · 连鞘翅一起

![披风](assets/screenshots/capes.jpg)

左边的小人可以用鼠标拖着转、滚轮缩放。右边挑皮肤和披风。
支持宽体 / 纤体、站立 / 行走动作，还能给小人套上头盔、胸甲、护腿、靴子看搭配。
挑好点「应用到账号」。

## 它能做什么

| 想要 | 这里有 |
|---|---|
| 装游戏 | 1.7.10 到最新正式版，正式版 / 快照 / 远古版都能装 |
| 装模组 | Forge、Fabric、NeoForge、Quilt、Cleanroom、OptiFine 一键装 |
| 找整合包 | 内置搜索，选中直接装成一个新版本 |
| 换皮肤 | 宽体 / 纤体、披风、鞘翅、盔甲预览，左边实时 3D |
| 装光影 | 光影和资源包按版本筛好，点一下装进对应文件夹 |
| 登录 | 离线登录、外置登录（LittleSkin 之类的皮肤站） |
| 下载慢 | 下载源可以切到国内镜像 |

> 微软正版登录还在等 Mojang 审核，这一版先灰着；用离线或外置登录不影响正常玩。

## 下载和安装

1. 到 [Releases](https://github.com/HopeStar-MuLin/HopeStar-MCLab/releases) 下最新的 `HopeStar-MCLab-*.zip`
2. 解压到任意文件夹 —— 别放 `C:\Program Files`，那里要管理员权限
3. 双击 `HopeStar-MCLab.exe`

第一次打开如果弹出「Windows 已保护你的电脑」，点 **更多信息 → 仍要运行**。
压缩包还没做数字签名，不是文件有问题。

## 你可能想问

**要自己装 Java 吗？**
不用，压缩包里带了。

**存档在哪？删了启动器会丢吗？**
存档在解压目录的 `.minecraft\saves` 里。整个文件夹拷走就能换电脑接着玩，删启动器不会动存档。

**能和朋友联机吗？**
这一版还没有联机大厅，进别人服务器还是在游戏里加 IP。

**游戏崩了怎么办？**
实例的「管理」页里有个「崩溃分析」，会告诉你是哪个模组的问题、缺了什么前置。

**怎么更新？**
设置 → 关于 → 检查更新。下完点「重启并安装」，存档和模组都不动。

**支持正版账号吗？**
支持，但微软登录正在申请 Mojang 授权，通过之前先置灰。离线登录、外置登录照常可用。

## 关于

免费、开源，基于 [HMCL](https://github.com/HMCL-dev/HMCL) 改的，同样以 GPL-3.0 发布。
完整许可见 [LICENSE](LICENSE)，改了哪些见 [NOTICE](NOTICE)。
名字和图标不能拿去冒充官方发布。

### 致谢

感谢这些项目让这个启动器成为可能（启动器里「设置 → 关于 → 致谢」有完整名单，地址可点）：

| 项目 | 作者 | 用在哪 |
|---|---|---|
| [HMCL](https://github.com/HMCL-dev/HMCL) | huangyuhui 及贡献者 | 核心：版本解析、下载、启动、账号 |
| [Tauri](https://github.com/tauri-apps/tauri) / WebView2 | Tauri Contributors / Microsoft | 界面外壳 |
| [skinview3d](https://github.com/bs-community/skinview3d) / [three.js](https://github.com/mrdoob/three.js) | Blessing Skin 社区 / mrdoob 及贡献者 | 3D 皮肤预览 |
| [Modrinth](https://github.com/modrinth/code) / CurseForge | Modrinth 团队 / Overwolf | 模组、整合包、光影数据 |
| [BMCLAPI](https://github.com/bangbang93/BMCLAPI) | bangbang93 | 国内下载镜像 |
| [authlib-injector](https://github.com/yushijinhun/authlib-injector) | yushijinhun | 外置登录 |
| Fabric / Quilt / Forge / NeoForge / Cleanroom / OptiFine | 各自团队 | 模组加载器 |

皮肤、盔甲与物品贴图取自 Minecraft 客户端，版权归 **Mojang Studios**。
Minecraft 是 Mojang Studios 的商标，本项目与 Mojang Studios 无隶属关系。
