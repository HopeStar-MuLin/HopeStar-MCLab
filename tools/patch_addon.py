import io

p = r'E:\MCLab\HMCL\HMCL\src\main\java\org\jackhuang\hmcl\ui\web\DownloadService.java'
s = io.open(p, encoding='utf-8').read()

# 1) installLoader 增加 addon 重载
old = '''    /// 安装「游戏 + 加载器」，实例名可自定义（留空则按 `<游戏版本>-<加载器>-<版本>` 生成）。
    void installLoader(String gameVersion, String loaderType, String loaderVersion,
                       @Nullable String instanceName) {'''
new = '''    /// 安装「游戏 + 加载器」，实例名可自定义。
    void installLoader(String gameVersion, String loaderType, String loaderVersion,
                       @Nullable String instanceName) {
        installLoader(gameVersion, loaderType, loaderVersion, instanceName, null);
    }

    /// 安装「游戏 + 加载器（+ 附加组件）」。
    ///
    /// `addonType` 是 fabric-api / quilt-api 这类**附属**组件：它们自己不是加载器
    /// （`GameComponentType.isModLoader()` 为 false），必须跟主加载器一起装。
    /// 走的时候先异步查一下它在这个游戏版本下的最新版本，再和主加载器一起塞进 builder。
    void installLoader(String gameVersion, String loaderType, String loaderVersion,
                       @Nullable String instanceName, @Nullable String addonType) {
        if (addonType == null || addonType.isBlank()) {
            doInstallLoader(gameVersion, loaderType, loaderVersion, instanceName, null);
            return;
        }

        GameComponentType addon = GameComponentType.fromPatchId(addonType);
        if (addon == null) {
            doInstallLoader(gameVersion, loaderType, loaderVersion, instanceName, null);
            return;
        }

        GameVersionNumber target;
        try {
            target = GameVersionNumber.asGameVersion(gameVersion);
        } catch (Exception e) {
            doInstallLoader(gameVersion, loaderType, loaderVersion, instanceName, null);
            return;
        }

        pushStage(instanceName == null ? gameVersion : instanceName,
                "正在查询 " + addonType + " 版本…", false, null);

        DownloadProviders.getDownloadProvider()
                .getVersionsAsync(addon, target, false)
                .thenAcceptAsync(list -> {
                    ComponentRemoteVersion picked = null;
                    for (ComponentRemoteVersion v : list) {
                        if (target.equals(v.getGameVersion())) {
                            picked = v;
                            break;
                        }
                    }
                    doInstallLoader(gameVersion, loaderType, loaderVersion, instanceName, picked);
                })
                .whenComplete(exception -> {
                    if (exception != null) {
                        LOG.warning("Failed to resolve addon " + addonType, exception);
                        doInstallLoader(gameVersion, loaderType, loaderVersion, instanceName, null);
                    }
                })
                .start();
    }

    private void doInstallLoader(String gameVersion, String loaderType, String loaderVersion,
                                 @Nullable String instanceName, @Nullable ComponentRemoteVersion addon) {'''
assert old in s, 'installLoader signature not found'
s = s.replace(old, new)

# 2) builder 里挂上 addon
old2 = '''        startBuild(instanceId, name, gameVersion + " + " + loaderType + " " + loaderVersion, builder -> {
            builder.component(GameComponentType.GAME, gameVersion);
            builder.component(loader);'''
new2 = '''        String label = gameVersion + " + " + loaderType + " " + loaderVersion;
        if (addon != null) {
            label += " + " + addon.getComponentType().getPatchId();
        }

        startBuild(instanceId, name, label, builder -> {
            builder.component(GameComponentType.GAME, gameVersion);
            builder.component(loader);
            if (addon != null) {
                builder.component(addon);
            }'''
assert old2 in s, 'builder block not found'
s = s.replace(old2, new2)

# 3) 原 startBuild 调用里的 name 变量引用检查（前面已经用 name 了）
io.open(p, 'w', encoding='utf-8').write(s)
print('service patched')

# ---------- WebBridge ----------
p2 = r'E:\MCLab\HMCL\HMCL\src\main\java\org\jackhuang\hmcl\ui\web\WebBridge.java'
s2 = io.open(p2, encoding='utf-8').read()
old3 = '''    public void installLoaderNamed(String gameVersion, String loaderType, String loaderVersion, String instanceName) {
        download.installLoader(gameVersion, loaderType, loaderVersion, instanceName);
    }'''
new3 = '''    public void installLoaderNamed(String gameVersion, String loaderType, String loaderVersion, String instanceName) {
        download.installLoader(gameVersion, loaderType, loaderVersion, instanceName);
    }

    /// 带附加组件（fabric-api / quilt-api）的安装
    public void installLoaderWithAddon(String gameVersion, String loaderType, String loaderVersion,
                                       String instanceName, String addonType) {
        download.installLoader(gameVersion, loaderType, loaderVersion, instanceName, addonType);
    }'''
assert old3 in s2, 'bridge installLoaderNamed not found'
s2 = s2.replace(old3, new3)
io.open(p2, 'w', encoding='utf-8').write(s2)
print('bridge patched')
