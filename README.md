<div align="center">
  <img src="logo.gif" width="88" alt="HopeStar-MCLab">
  <h1>HopeStar-MCLab</h1>
  <p><b>选个版本，点启动。剩下的它来。</b><br>
  Windows 10 / 11 · 解压即用 · 完整开源</p>
</div>

---

下载、解压、双击，三步进游戏。
装模组、换皮肤、找整合包，都在一个窗口里点完 —— 不用记路径，不用改配置文件，不用自己装 Java。

## 先看看长什么样

### 首页 · 启动时最先看见的页面

![首页](assets/screenshots/home.jpg)

优先展示上次启动的版本，点击启动游戏即可进入
点击下方卡片切换启动实例，快捷、方便
展示当前来自MoJang的最新动态，点击快速查看

### 实例管理 · 可视化管理所有实例

![实例管理](assets/screenshots/instances.jpg)

展示当前安装的所有游戏实例，点击进入管理
已支持所有常用功能，点开即可为实例设置单独配置

### 下载 · 游戏、模组、整合包，一个页面找齐

![游戏下载](assets/screenshots/download.jpg)

- **游戏本体**：完整支持Minecraft可拉取到的所有游戏版本
- **模组加载器**：Forge、Fabric、NeoForge、Quilt、Cleanroom、OptiFine，一键装好
- **整合包**：点击下载，无需手动解压即可使用启动器进行启动游戏！
- **模组、资源包、光影、地图**：自动筛选版本，支持Modrinth与CurseForge搜索下载

### 皮肤 · 能转能看的 3D 建模

![皮肤](assets/screenshots/skins.jpg)

### 披风 · 连鞘翅一起

![披风](assets/screenshots/capes.jpg)

为皮肤添加实时可预览的 3D 建模
无需进入游戏即可查看当前皮肤效果
支持皮肤、鞘翅切换，可查看当前皮肤对于装备的效果

## 它能做什么

| 想要 | 这里有 |
|---|---|
| 装游戏 | 1.0 到最新正式版，正式版 / 快照 / 远古版都能装 |
| 装模组 | Forge、Fabric、NeoForge、Quilt、Cleanroom、OptiFine 一键装 |
| 找整合包 | 内置搜索，选中直接装成一个新版本 |
| 换皮肤 | 宽体 / 纤体、披风、鞘翅、盔甲预览，左边实时 3D |
| 装光影 | 光影和资源包按版本筛好，点一下装进对应文件夹 |
| 登录 | 离线登录、外置登录（LittleSkin 之类的皮肤站） |
| 下载慢 | 下载源可以切到国内镜像 |
| 非常听劝的开发者 | 高强度冲浪，有利于玩家的功能都会尽快加上~ |

> 暂未支持正版登录（Sorry啦，审核太慢了，如果通过了会尽快更新正版登录的😭）

## 下载和安装

1. 到 [Releases](https://github.com/HopeStar-MuLin/HopeStar-MCLab/releases) 下最新的 `HopeStar-MCLab-*.zip`
2. 解压到任意文件夹 —— 别放 `C:\Program Files`，那里要管理员权限
3. 双击 `HopeStar-MCLab.exe`

第一次打开如果弹出「Windows 已保护你的电脑」，点 **更多信息 → 仍要运行**。
压缩包还没做数字签名，不是文件有问题。

## 关于

免费、开源，基于 [HMCL](https://github.com/HMCL-dev/HMCL) 作为分支发展，同样以 GPL-3.0 发布。
完整许可见 [LICENSE](LICENSE)，改了哪些见 [NOTICE](NOTICE)。

### 致谢

感谢以下项目让这个启动器成为可能，向开源社区的伟大前辈致敬：

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
