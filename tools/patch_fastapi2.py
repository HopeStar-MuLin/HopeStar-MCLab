import io

p = 'E:/MCLab/HMCL/HMCL/src/main/java/org/jackhuang/hmcl/ui/web/AddonService.java'
s = io.open(p, encoding='utf-8').read()

# ---------------------------------------------------------- install 用单版本端点

old = """        Task.runAsync(() -> {
            try {
                DownloadProvider provider = DownloadProviders.getDownloadProvider();
                RemoteAddonRepository repo = RemoteAddon.Source.MODRINTH.getRepository();

                RemoteAddon.Version version = pickVersion(repo, provider, slug, versionId);

                Path dir = targetDirectory(addonType, instanceId);
                Files.createDirectories(dir);

                String fileName = safeFileName(version.file().filename(), taskId);
                Path target = dir.resolve(fileName);
                pushStage(taskId, "下载 " + fileName + " → " + dir.getFileName(), false, null, -1);

                FileDownloadTask download = buildDownload(provider, version, target);"""

new = """        Task.runAsync(() -> {
            try {
                DownloadProvider provider = DownloadProviders.getDownloadProvider();

                // 已经知道具体版本了，直接查 /v2/version/{id}（一个对象，几十 KB），
                // 不用再拉整个项目的版本列表
                AddonVersion version = fetchVersionById(slug, versionId);

                Path dir = targetDirectory(addonType, instanceId);
                Files.createDirectories(dir);

                String fileName = safeFileName(version.filename(), taskId);
                Path target = dir.resolve(fileName);
                pushStage(taskId, "下载 " + fileName + " → " + dir.getFileName(), false, null, -1);

                FileDownloadTask download = buildDownload(provider, version.fileUrl(), target);"""

assert old in s
s = s.replace(old, new, 1)

# ---------------------------------------------------------- 删掉 pickVersion，加 fetchVersionById

start = s.index('    /// 取版本。`versionId` 为空时取发布日期最新的那个——')
end = s.index('    /// 构造下载任务。**不做哈希校验**')
s = s[:start] + """    /// 按版本 id 取单个版本。`versionId` 为空时退化成「拉最新一个」。
    private static AddonVersion fetchVersionById(String slug, @Nullable String versionId) throws IOException {
        if (versionId == null || versionId.isBlank()) {
            List<AddonVersion> all = fetchVersions(slug, null, null);
            if (all.isEmpty()) {
                throw new IOException("这个项目没有可下载的版本");
            }
            return all.get(0);
        }

        JsonObject v = HttpRequest.GET(API + "/version/" + enc(versionId)).getJson(JsonObject.class);
        String fileUrl = null;
        String filename = null;
        if (v.has("files") && v.get("files").isJsonArray()) {
            JsonArray files = v.getAsJsonArray("files");
            if (files.size() > 0 && files.get(0).isJsonObject()) {
                JsonObject file = files.get(0).getAsJsonObject();
                fileUrl = optString(file, "url");
                filename = optString(file, "filename");
            }
        }
        if (fileUrl == null || fileUrl.isBlank()) {
            throw new IOException("这个版本没有可下载的文件");
        }
        return new AddonVersion(
                optString(v, "id"),
                optString(v, "name"),
                optString(v, "version_number"),
                optString(v, "version_type"),
                optString(v, "date_published"),
                fileUrl,
                filename);
    }

""" + s[end:]

# ---------------------------------------------------------- buildDownload 收 URL

old_bd = """    private static FileDownloadTask buildDownload(DownloadProvider provider, RemoteAddon.Version version, Path target) {
        return new FileDownloadTask(provider.getDownloadCandidates(version.file().url()), target);
    }"""

new_bd = """    private static FileDownloadTask buildDownload(DownloadProvider provider, String url, Path target) {
        return new FileDownloadTask(provider.getDownloadCandidates(url), target);
    }"""

assert old_bd in s
s = s.replace(old_bd, new_bd, 1)

# ---------------------------------------------------------- 整合包也走单版本端点

old_mp = """                DownloadProvider provider = DownloadProviders.getDownloadProvider();
                RemoteAddonRepository repo = RemoteAddon.Source.MODRINTH.getRepository();

                RemoteAddon.Version version = pickVersion(repo, provider, slug, versionId);

                temp = Files.createTempFile("hmcl-modpack-", ".zip");
                pushStage(taskId, "正在下载整合包…", false, null, -1);

                FileDownloadTask download = buildDownload(provider, version, temp);"""

new_mp = """                DownloadProvider provider = DownloadProviders.getDownloadProvider();

                AddonVersion version = fetchVersionById(slug, versionId);

                temp = Files.createTempFile("hmcl-modpack-", ".zip");
                pushStage(taskId, "正在下载整合包 " + version.number() + "…", false, null, -1);

                FileDownloadTask download = buildDownload(provider, version.fileUrl(), temp);"""

assert old_mp in s
s = s.replace(old_mp, new_mp, 1)

# ---------------------------------------------------------- optString 工具

anchor = """    private static String sortIndex(@Nullable String sort) {"""
helper = """    private static String optString(JsonObject object, String key) {
        if (object == null || !object.has(key) || object.get(key).isJsonNull()) {
            return "";
        }
        try {
            return object.get(key).getAsString();
        } catch (Exception e) {
            return "";
        }
    }

    private static String sortIndex(@Nullable String sort) {"""

assert anchor in s
s = s.replace(anchor, helper, 1)

# ---------------------------------------------------------- import

s = s.replace("import com.google.gson.JsonArray;",
              "import com.google.gson.JsonArray;\nimport com.google.gson.JsonElement;", 1)
s = s.replace("import org.jackhuang.hmcl.util.gson.JsonUtils;",
              "import org.jackhuang.hmcl.util.gson.JsonUtils;\nimport org.jackhuang.hmcl.util.io.HttpRequest;", 1)
s = s.replace("import java.io.IOException;",
              "import java.io.IOException;\nimport java.net.URLEncoder;\nimport java.nio.charset.StandardCharsets;", 1)

io.open(p, 'w', encoding='utf-8').write(s)
print('part 2 ok')
