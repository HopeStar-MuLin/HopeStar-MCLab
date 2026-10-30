import io

p = r'E:\MCLab\HMCL\HMCL\src\main\java\org\jackhuang\hmcl\ui\web\DownloadService.java'
s = io.open(p, encoding='utf-8').read()

# installVersion 支持自定义实例名
old = '''    /// 安装原版。
    void installVersion(String versionId) {
        if (versionId == null || versionId.isBlank()) {
            return;
        }
        if (findGameVersion(versionId) == null) {
            pushStage(versionId, "版本清单里没有 " + versionId, false, "unknown version");
            return;
        }
        startBuild(new GameInstanceID(versionId), versionId, versionId,
                builder -> builder.component(GameComponentType.GAME, versionId));
    }'''
new = '''    /// 安装原版。
    void installVersion(String versionId) {
        installVersion(versionId, null);
    }

    /// 安装原版，实例名可自定义（留空则用版本号）。
    void installVersion(String versionId, @Nullable String instanceName) {
        if (versionId == null || versionId.isBlank()) {
            return;
        }
        if (findGameVersion(versionId) == null) {
            pushStage(versionId, "版本清单里没有 " + versionId, false, "unknown version");
            return;
        }
        String name = (instanceName == null || instanceName.isBlank()) ? versionId : instanceName.trim();
        startBuild(new GameInstanceID(name), name, versionId,
                builder -> builder.component(GameComponentType.GAME, versionId));
    }'''
assert old in s, 'installVersion not found'
s = s.replace(old, new)

# installLoader 支持自定义实例名
old2 = '''    void installLoader(String gameVersion, String loaderType, String loaderVersion) {
        if (gameVersion == null || loaderType == null || loaderVersion == null) {
            return;
        }'''
new2 = '''    void installLoader(String gameVersion, String loaderType, String loaderVersion) {
        installLoader(gameVersion, loaderType, loaderVersion, null);
    }

    /// 安装「游戏 + 加载器」，实例名可自定义（留空则按 `<游戏版本>-<加载器>-<版本>` 生成）。
    void installLoader(String gameVersion, String loaderType, String loaderVersion,
                       @Nullable String instanceName) {
        if (gameVersion == null || loaderType == null || loaderVersion == null) {
            return;
        }'''
assert old2 in s, 'installLoader head not found'
s = s.replace(old2, new2)

old3 = '''        String instanceName = gameVersion + "-" + loaderType + "-" + loaderVersion;
        GameInstanceID instanceId = new GameInstanceID(instanceName);
        ComponentRemoteVersion loader = target;

        startBuild(instanceId, instanceName, gameVersion + " + " + loaderType + " " + loaderVersion, builder -> {'''
new3 = '''        String name = (instanceName == null || instanceName.isBlank())
                ? gameVersion + "-" + loaderType + "-" + loaderVersion
                : instanceName.trim();
        GameInstanceID instanceId = new GameInstanceID(name);
        ComponentRemoteVersion loader = target;

        startBuild(instanceId, name, gameVersion + " + " + loaderType + " " + loaderVersion, builder -> {'''
assert old3 in s, 'instanceName block not found'
s = s.replace(old3, new3)

io.open(p, 'w', encoding='utf-8').write(s)

# ---------- WebBridge ----------
p2 = r'E:\MCLab\HMCL\HMCL\src\main\java\org\jackhuang\hmcl\ui\web\WebBridge.java'
s2 = io.open(p2, encoding='utf-8').read()

old4 = '''    public void installVersion(String versionId) {
        download.installVersion(versionId);
    }'''
new4 = '''    public void installVersion(String versionId) {
        download.installVersion(versionId);
    }

    /// 带自定义实例名的安装（安装弹窗里的「游戏实例名称」输入框）
    public void installVersionNamed(String versionId, String instanceName) {
        download.installVersion(versionId, instanceName);
    }'''
assert old4 in s2, 'bridge installVersion not found'
s2 = s2.replace(old4, new4)

old5 = '''    public void installLoader(String gameVersion, String loaderType, String loaderVersion) {
        download.installLoader(gameVersion, loaderType, loaderVersion);
    }'''
new5 = '''    public void installLoader(String gameVersion, String loaderType, String loaderVersion) {
        download.installLoader(gameVersion, loaderType, loaderVersion);
    }

    public void installLoaderNamed(String gameVersion, String loaderType, String loaderVersion, String instanceName) {
        download.installLoader(gameVersion, loaderType, loaderVersion, instanceName);
    }'''
assert old5 in s2, 'bridge installLoader not found'
s2 = s2.replace(old5, new5)

io.open(p2, 'w', encoding='utf-8').write(s2)
print('java patched')
