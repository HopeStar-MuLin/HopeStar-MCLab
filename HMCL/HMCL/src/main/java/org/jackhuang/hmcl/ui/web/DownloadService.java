/*
 * Hello Minecraft! Launcher
 * Copyright (C) 2026 huangyuhui <huanghongxun2008@126.com> and contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */
package org.jackhuang.hmcl.ui.web;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import javafx.application.Platform;
import org.jackhuang.hmcl.download.ComponentRemoteVersion;
import org.jackhuang.hmcl.download.DownloadProvider;
import org.jackhuang.hmcl.util.versioning.GameVersionNumber;
import org.jackhuang.hmcl.setting.DownloadProviders;
import org.jackhuang.hmcl.download.game.GameRemoteVersion;
import org.jackhuang.hmcl.game.GameComponentType;
import org.jackhuang.hmcl.game.GameInstanceID;
import org.jackhuang.hmcl.game.HMCLGameBuilder;
import org.jackhuang.hmcl.setting.GameDirectoryManager;
import org.jackhuang.hmcl.task.Schedulers;
import org.jackhuang.hmcl.task.Task;
import org.jackhuang.hmcl.task.TaskExecutor;
import org.jackhuang.hmcl.task.TaskListener;
import org.jackhuang.hmcl.util.gson.JsonUtils;

import java.util.ArrayList;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.List;
import java.util.function.Consumer;

import org.jetbrains.annotations.Nullable;

import static org.jackhuang.hmcl.util.logging.Logger.LOG;

/// 下载页的数据与安装入口。
///
/// <p>只做三件事：拉版本清单、把清单转成前端能吃的 JSON、调用 HMCL 原有的
/// {@link HMCLGameBuilder} 装版本。**不重写下载逻辑**——多源候选、sha1 校验、
/// 失败重试、资源索引都在 `HMCLCore` 里，重写一遍只会引入新的边界 bug。
///
/// <p>前端契约（都在 `window.__hmcl` 上）：
/// <ul>
///   <li>`onVersions(json)`：版本清单，`{id, type, date, installed}` 数组</li>
///   <li>`onInstallStage(json)`：安装进度，`{id, stage, done, error}`</li>
/// </ul>
final class DownloadService {

    /// 推 JS 到页面的回调（由 {@link WebBridge} 提供，带异常兜底）
    private final Consumer<String> push;

    /// 上次拉到的清单。为空表示还没拉过，或被主动清掉。
    private volatile List<GameRemoteVersion> versions;

    DownloadService(Consumer<String> push) {
        this.push = push;
    }

    // ==================== 版本清单 ====================

    /// 请求版本清单。已缓存时直接推给前端，避免每次进下载页都打一次网络。
    void requestVersions(boolean force) {
        List<GameRemoteVersion> cached = versions;
        if (!force && cached != null) {
            pushVersions(cached);
            return;
        }

        pushStage(null, "正在获取版本清单…", false, null);

        GameRemoteVersion.fetchAsync(DownloadProviders.getDownloadProvider())
                .thenAcceptAsync(list -> {
                    List<GameRemoteVersion> all = new ArrayList<>();
                    // ComponentRemoteVersionList 就是 AbstractList，直接迭代
                    for (ComponentRemoteVersion version : list) {
                        if (version instanceof GameRemoteVersion game) {
                            all.add(game);
                        }
                    }
                    all.sort((a, b) -> b.getReleaseDate().compareTo(a.getReleaseDate()));
                    versions = all;
                    pushVersions(all);
                    // kind=versions：这只是把清单拉的进度条收掉，
                    // 不是安装完成，前端不应该弹「安装完成」的 toast
                    pushStage(null, "", true, null, -1, "versions", -1, -1);
                })
                .whenComplete(exception -> {
                    if (exception != null) {
                        LOG.warning("Failed to fetch version list", exception);
                        pushStage(null, "获取版本清单失败：" + exception, false, exception.toString());
                    }
                })
                .start();
    }

    private void pushVersions(List<GameRemoteVersion> list) {
        // 本地已有同名实例就标成「已安装」，避免用户重复点安装再撞同名冲突
        var repository = GameDirectoryManager.getSelectedRepository();

        JsonArray array = new JsonArray();
        for (GameRemoteVersion version : list) {
            JsonObject item = new JsonObject();
            String id = version.getGameVersion().toString();
            boolean installed = false;
            try {
                installed = repository.findInstance(new GameInstanceID(id)) != null;
            } catch (Exception ignored) {
                // 版本号不是合法实例 id（极少见）时按未安装处理
            }
            item.addProperty("installed", installed);
            item.addProperty("id", id);
            // release / snapshot / old-beta / old-alpha，前端按前缀分组
            item.addProperty("type", version.getType().getId());
            item.addProperty("date", version.getReleaseDate() != null
                    ? version.getReleaseDate().toEpochMilli() : 0L);
            array.add(item);
        }

        JsonObject root = new JsonObject();
        root.add("versions", array);
        String json = JsonUtils.GSON.toJson(root);
        Platform.runLater(() -> push.accept("window.__hmcl && window.__hmcl.onVersions("
                + JsonUtils.GSON.toJson(json) + ")"));
    }

    // ==================== 加载器 ====================

    /// 加载器版本缓存，key 是 `patchId@游戏版本`。
    ///
    /// <p>同时存下 {@link ComponentRemoteVersion} 对象本身——安装时要用它，
    /// 而前端只传得回一个版本号字符串。只存字符串的话安装阶段还得再拉一次清单。
    private final Map<String, List<ComponentRemoteVersion>> loaderVersions = new ConcurrentHashMap<>();

    /// 请求某个游戏版本下的加载器版本列表。type 取 fabric / quilt / forge / neoforge。
    void requestLoaderVersions(String gameVersion, String loaderType) {
        GameComponentType type = GameComponentType.fromPatchId(loaderType);
        if (type == null || !type.isModLoader()) {
            pushLoaderVersions(gameVersion, loaderType, List.of(), "未知的加载器类型");
            return;
        }

        GameVersionNumber target;
        try {
            target = GameVersionNumber.asGameVersion(gameVersion);
        } catch (Exception e) {
            pushLoaderVersions(gameVersion, loaderType, List.of(), "版本号无法解析");
            return;
        }

        DownloadProviders.getDownloadProvider()
                .getVersionsAsync(type, target, false)
                .thenAcceptAsync(rawList -> {
                    List<ComponentRemoteVersion> result = new ArrayList<>();
                    for (ComponentRemoteVersion version : rawList) {
                        // provider 有的分支会返回全量，这里再按游戏版本过滤一次
                        if (target.equals(version.getGameVersion())) {
                            result.add(version);
                        }
                    }
                    loaderVersions.put(loaderType + "@" + gameVersion, result);
                    pushLoaderVersions(gameVersion, loaderType, result, null);
                })
                .whenComplete(exception -> {
                    if (exception != null) {
                        LOG.warning("Failed to fetch " + loaderType + " versions", exception);
                        pushLoaderVersions(gameVersion, loaderType, List.of(), String.valueOf(exception));
                    }
                })
                .start();
    }

    // ==================== 加载器可用性 ====================

    /// 安装器卡片里会出现的加载器（patch id）。
    ///
    /// <p>前端的卡片不是「有哪个类型就画哪张」：Fabric 在 1.12.2 上一个版本都没有，
    /// 但卡片照样画出来、点开还要拉一次清单才说「没有可用版本」——那一趟纯属白等。
    /// 所以打开安装弹窗时先把这几个类型的可用性问清楚，别让用户点进去。
    private static final List<String> INSTALLER_TYPES =
            List.of("forge", "cleanroom", "neoforge", "optifine", "fabric", "quilt");

    /// `patchId@游戏版本` → ok / unsupported / unavailable / unknown。
    /// ok 和 unsupported 是清单里的事实，永久有效；unknown 是网络问题，
    /// 只保留 60 秒，免得每开一次弹窗就去撞一次超时。
    private final Map<String, String> installerSupport = new ConcurrentHashMap<>();
    private final Map<String, Long> installerSupportAt = new ConcurrentHashMap<>();

    /// 各加载器「最早支持到哪个游戏版本」。这是历史事实，不会变，
    /// 用它先把一批明显装不上的组合挡掉——不然 NeoForge 这种清单在国内经常超时，
    /// 超时就只能退回「能不能装不知道」，又变成用户白点一次。
    private static final Map<String, String> LOADER_FLOOR = Map.of(
            "fabric", "1.14",
            "quilt", "1.14.4",
            "neoforge", "1.20.1");

    private boolean supportFresh(String key) {
        String state = installerSupport.get(key);
        if (state == null) {
            return false;
        }
        if (!"unknown".equals(state)) {
            return true;
        }
        Long at = installerSupportAt.get(key);
        return at != null && System.currentTimeMillis() - at < 60_000L;
    }

    /// 查这些加载器在某个游戏版本下有没有可安装的版本。
    ///
    /// <p>判断依据就是 HMCL 自己的清单：`getVersionsAsync(type, 版本, false)`
    /// 返回空 = 这个加载器没有这个游戏版本。Fabric / Quilt 的 meta 里根本没有
    /// 1.12.2，NeoForge 从 1.20.1 才有，都是这一步自然得出的结论，
    /// 不需要在前端维护一张「XX 支持到哪一版」的手写表。
    void requestInstallerSupport(String gameVersion) {
        if (gameVersion == null || gameVersion.isBlank()) {
            return;
        }
        GameVersionNumber target;
        try {
            target = GameVersionNumber.asGameVersion(gameVersion);
        } catch (Exception e) {
            LOG.warning("Cannot parse game version " + gameVersion, e);
            return;
        }

        DownloadProvider provider = DownloadProviders.getDownloadProvider();
        for (String patchId : INSTALLER_TYPES) {
            GameComponentType type = GameComponentType.fromPatchId(patchId);
            if (type == null) {
                continue;
            }
            String key = patchId + "@" + gameVersion;
            if (supportFresh(key)) {
                pushInstallerSupport(gameVersion, patchId, installerSupport.get(key), -1);
                continue;
            }

            // OptiFine 没有「版本清单」这个概念：这套 DownloadProvider 的
            // `case OPTIFINE` 直接抛 UnsupportedOperationException。
            // 不给它发请求，省得每次开弹窗都在日志里留一条异常。
            if (type == GameComponentType.OPTIFINE) {
                pushInstallerSupport(gameVersion, patchId, "unavailable", -1);
                continue;
            }

            // 下限是历史事实：1.12.2 上永远不会有 Fabric / Quilt / NeoForge。
            // 先按它挡掉，不用等网络——这正是用户抱怨的那一类白等。
            String floor = LOADER_FLOOR.get(patchId);
            if (floor != null) {
                try {
                    if (target.compareTo(GameVersionNumber.asGameVersion(floor)) < 0) {
                        installerSupport.put(key, "unsupported");
                        pushInstallerSupport(gameVersion, patchId, "unsupported", 0);
                        continue;
                    }
                } catch (Exception ignored) {
                    // 版本号比不出来就老老实实去查清单
                }
            }

            provider.getVersionsAsync(type, target, false)
                    .thenAcceptAsync(rawList -> {
                        // 和 requestLoaderVersions 一样：provider 有分支会返回全量，
                        // 必须按游戏版本再筛一遍，否则 NeoForge 在 1.12.2 上也会「有版本」
                        int count = 0;
                        for (ComponentRemoteVersion version : rawList) {
                            if (target.equals(version.getGameVersion())) {
                                count++;
                                break;
                            }
                        }
                        String state = count > 0 ? "ok" : "unsupported";
                        installerSupport.put(key, state);
                        installerSupportAt.remove(key);
                        pushInstallerSupport(gameVersion, patchId, state, count);
                    })
                    .whenComplete(exception -> {
                        if (exception == null) {
                            return;
                        }
                        // 网络问题不能等同于「不支持」：把卡片藏掉会让人以为这个加载器没了。
                        // 推 unknown，前端按「能装」处理，真点了再由版本弹窗报具体错误。
                        LOG.info("[support] " + key + " unknown: " + exception);
                        installerSupport.put(key, "unknown");
                        installerSupportAt.put(key, System.currentTimeMillis());
                        pushInstallerSupport(gameVersion, patchId, "unknown", -1);
                    })
                    .start();
        }
    }

    private void pushInstallerSupport(String gameVersion, String type, String state, int count) {
        JsonObject json = new JsonObject();
        json.addProperty("game", gameVersion);
        json.addProperty("type", type);
        json.addProperty("state", state);
        json.addProperty("count", count);
        String text = JsonUtils.GSON.toJson(json);
        Platform.runLater(() -> push.accept("window.__hmcl && window.__hmcl.onInstallerSupport("
                + JsonUtils.GSON.toJson(text) + ")"));
    }

    private void pushLoaderVersions(String gameVersion, String loaderType,
                                    List<ComponentRemoteVersion> list, String error) {
        JsonArray array = new JsonArray();
        for (ComponentRemoteVersion version : list) {
            array.add(version.getSelfVersion());
        }
        JsonObject json = new JsonObject();
        json.addProperty("game", gameVersion);
        json.addProperty("type", loaderType);
        json.addProperty("error", error);
        json.add("versions", array);

        String text = JsonUtils.GSON.toJson(json);
        Platform.runLater(() -> push.accept("window.__hmcl && window.__hmcl.onLoaderVersions("
                + JsonUtils.GSON.toJson(text) + ")"));
    }

    // ==================== 安装 ====================

    /// 安装原版。
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
                builder -> builder.component(GameComponentType.GAME, versionId), false, null, null);
    }

    /// 安装「游戏 + 加载器」。实例名按 `<游戏版本>-<patchId>-<加载器版本>` 生成，
    /// 与原版并存，不覆盖已有实例。
    void installLoader(String gameVersion, String loaderType, String loaderVersion) {
        installLoader(gameVersion, loaderType, loaderVersion, null);
    }

    /// 安装「游戏 + 加载器」，实例名可自定义。
    void installLoader(String gameVersion, String loaderType, String loaderVersion,
                       @Nullable String instanceName) {
        installLoader(gameVersion, loaderType, loaderVersion, instanceName, null);
    }

    /// 安装「游戏 + 加载器（+ 附属组件）」。
    ///
    /// @param addonsSpec 附属组件及其版本，形如 `fabricapi@0.92.2,fugue@0.25.5,scalar@1.0.1`。
    ///                   只写 id 不写版本表示装最新；空串表示不装附属。
    ///
    /// <p>附属分两类：`fabricapi` / `quiltapi` 是 HMCL 的组件，和主加载器一起塞进 builder；
    /// `fugue` / `scalar` 是 Cleanroom 要求手动放进 mods 的两个补丁，装完由
    /// {@link CleanroomCompat} 下载。
    void installLoader(String gameVersion, String loaderType, String loaderVersion,
                       @Nullable String instanceName, @Nullable String addonsSpec) {
        Map<String, String> addons = parseAddons(addonsSpec);
        String componentAddon = addons.containsKey("fabricapi") ? "fabricapi"
                : addons.containsKey("quiltapi") ? "quiltapi" : null;
        String wantedComponentVersion = componentAddon == null ? null : addons.get(componentAddon);
        String fugueVersion = addons.get("fugue");
        String scalarVersion = addons.get("scalar");

        if (componentAddon == null) {
            doInstallLoader(gameVersion, loaderType, loaderVersion, instanceName, null,
                    fugueVersion, scalarVersion);
            return;
        }

        GameComponentType addon = componentTypeOf(componentAddon);
        GameVersionNumber target;
        try {
            target = GameVersionNumber.asGameVersion(gameVersion);
        } catch (Exception e) {
            doInstallLoader(gameVersion, loaderType, loaderVersion, instanceName, null,
                    fugueVersion, scalarVersion);
            return;
        }
        if (addon == null) {
            doInstallLoader(gameVersion, loaderType, loaderVersion, instanceName, null,
                    fugueVersion, scalarVersion);
            return;
        }

        pushStage(instanceName == null ? gameVersion : instanceName,
                "正在查询 " + componentAddon + " 版本…", false, null);

        final String wanted = wantedComponentVersion;
        DownloadProviders.getDownloadProvider()
                .getVersionsAsync(addon, target, false)
                .thenAcceptAsync(list -> {
                    ComponentRemoteVersion picked = pickComponent(list, target, wanted);
                    doInstallLoader(gameVersion, loaderType, loaderVersion, instanceName, picked,
                            fugueVersion, scalarVersion);
                })
                .whenComplete(exception -> {
                    if (exception != null) {
                        LOG.warning("Failed to resolve addon " + componentAddon, exception);
                        doInstallLoader(gameVersion, loaderType, loaderVersion, instanceName, null,
                                fugueVersion, scalarVersion);
                    }
                })
                .start();
    }

    /// 附属组件 id → {@link GameComponentType}。
    ///
    /// <p>前端的卡片 id 是 `fabricapi` / `quiltapi`，而 patchId 是 `fabric-api` / `quilt-api`
    /// （上游用连字符）。直接喂 `fromPatchId` 会返回 null——以前 Fabric API 的卡片
    /// 点了没反应、装完 mods 里也没有，就是这个原因。
    private static @Nullable GameComponentType componentTypeOf(String addonId) {
        return switch (addonId) {
            case "fabricapi", "fabric-api" -> GameComponentType.FABRIC_API;
            case "quiltapi", "quilt-api" -> GameComponentType.QUILT_API;
            default -> GameComponentType.fromPatchId(addonId);
        };
    }

    /// 在组件清单里挑一个：用户指定了版本就按版本匹配，否则取这个游戏版本下的最新一条。
    private static @Nullable ComponentRemoteVersion pickComponent(List<? extends ComponentRemoteVersion> list,
                                                                  GameVersionNumber target,
                                                                  @Nullable String wantedVersion) {
        if (list == null) {
            return null;
        }
        ComponentRemoteVersion first = null;
        for (ComponentRemoteVersion version : list) {
            if (!target.equals(version.getGameVersion())) {
                continue;
            }
            if (first == null) {
                first = version;
            }
            if (wantedVersion != null && !wantedVersion.isBlank()
                    && wantedVersion.equals(version.getSelfVersion())) {
                return version;
            }
        }
        if (wantedVersion != null && !wantedVersion.isBlank() && first != null) {
            LOG.warning("Addon version " + wantedVersion + " not found, fall back to " + first.getSelfVersion());
        }
        return first;
    }

    /// 解析 `fabricapi@0.92.2,fugue` 这种附属描述串。
    private static Map<String, String> parseAddons(@Nullable String spec) {
        Map<String, String> map = new java.util.LinkedHashMap<>();
        if (spec == null || spec.isBlank()) {
            return map;
        }
        for (String part : spec.split(",")) {
            String item = part.trim();
            if (item.isEmpty()) {
                continue;
            }
            int at = item.indexOf('@');
            if (at > 0) {
                map.put(item.substring(0, at).trim(), item.substring(at + 1).trim());
            } else {
                map.put(item, "");
            }
        }
        return map;
    }

    /// 列出一个附属组件在当前游戏版本下能装的版本。
    ///
    /// <p>Fabric API / QSL 走 HMCL 的组件清单；Fugue / Scalar 只有 Modrinth 与
    /// CurseForge 上的发布页，走 {@link CleanroomCompat} 自己那套查询。
    void requestAddonVersions(String addonId, String gameVersion) {
        JsonObject root = new JsonObject();
        root.addProperty("type", addonId);
        root.addProperty("game", gameVersion);

        if ("fugue".equals(addonId) || "scalar".equals(addonId)) {
            // Cleanroom 的两个补丁只认 1.12.2
            pushAddonVersions(root, CleanroomCompat.listVersions(addonId));
            return;
        }

        GameComponentType type = componentTypeOf(addonId);
        GameVersionNumber target;
        try {
            target = GameVersionNumber.asGameVersion(gameVersion);
        } catch (Exception e) {
            root.addProperty("error", "游戏版本不合法：" + gameVersion);
            pushAddonVersions(root, null);
            return;
        }
        if (type == null) {
            root.addProperty("error", "未知的附属组件：" + addonId);
            pushAddonVersions(root, null);
            return;
        }

        DownloadProviders.getDownloadProvider()
                .getVersionsAsync(type, target, false)
                .thenAcceptAsync(list -> {
                    JsonArray versions = new JsonArray();
                    if (list != null) {
                        LOG.info("[addon] " + addonId + " for " + gameVersion + ": " + list.size() + " candidate(s)");
                        for (ComponentRemoteVersion version : list) {
                            LOG.info("[addon]   " + version.getSelfVersion() + " / game=" + version.getGameVersion());
                            // 组件清单有时会把别的游戏版本也带回来，必须按目标版本再筛一遍
                            if (!target.equals(version.getGameVersion())) {
                                continue;
                            }
                            JsonObject item = new JsonObject();
                            item.addProperty("version", version.getSelfVersion());
                            item.addProperty("file", version.getSelfVersion());
                            versions.add(item);
                        }
                        if (versions.isEmpty()) {
                            // 一个都没筛出来说明这个类型的 gameVersion 字段跟我们对不上，
                            // 退回「全部列出」——Modrinth 那边已经按 game_versions 过滤过了
                            for (ComponentRemoteVersion version : list) {
                                JsonObject item = new JsonObject();
                                item.addProperty("version", version.getSelfVersion());
                                item.addProperty("file", version.getSelfVersion());
                                versions.add(item);
                            }
                        }
                    }
                    root.addProperty("count", versions.size());
                    root.add("versions", versions);
                    pushAddonVersions(root, null);
                })
                .whenComplete(exception -> {
                    if (exception != null) {
                        LOG.warning("Failed to list addon versions of " + addonId, exception);
                        root.addProperty("error", String.valueOf(exception));
                        root.add("versions", new JsonArray());
                        pushAddonVersions(root, null);
                    }
                })
                .start();
    }

    /// CleanroomCompat 返回的是它自己的 JSON 字符串，这里摊平进统一结构。
    private void pushAddonVersions(JsonObject root, @Nullable String cleanroomJson) {
        if (cleanroomJson != null) {
            try {
                JsonObject inner = com.google.gson.JsonParser.parseString(cleanroomJson).getAsJsonObject();
                if (inner.has("error")) {
                    root.addProperty("error", inner.get("error").getAsString());
                }
                JsonElement versions = inner.get("versions");
                root.add("versions", versions != null ? versions : new JsonArray());
            } catch (Throwable e) {
                root.addProperty("error", String.valueOf(e));
                root.add("versions", new JsonArray());
            }
        }
        String text = JsonUtils.GSON.toJson(root);
        Platform.runLater(() -> push.accept("window.__hmcl && window.__hmcl.onAddonVersions("
                + JsonUtils.GSON.toJson(text) + ")"));
    }

    private void doInstallLoader(String gameVersion, String loaderType, String loaderVersion,
                                 @Nullable String instanceName, @Nullable ComponentRemoteVersion addon,
                                 @Nullable String fugueVersion, @Nullable String scalarVersion) {
        if (gameVersion == null || loaderType == null || loaderVersion == null) {
            return;
        }

        List<ComponentRemoteVersion> cached = loaderVersions.get(loaderType + "@" + gameVersion);
        if (cached == null || cached.isEmpty()) {
            pushStage(gameVersion, "加载器列表还没加载完，稍后重试", false, "no loader list");
            return;
        }

        ComponentRemoteVersion target = null;
        for (ComponentRemoteVersion version : cached) {
            if (loaderVersion.equals(version.getSelfVersion())) {
                target = version;
                break;
            }
        }
        if (target == null) {
            pushStage(gameVersion, "列表里没有这个加载器版本", false, "unknown loader version");
            return;
        }

        String name = (instanceName == null || instanceName.isBlank())
                ? gameVersion + "-" + loaderType + "-" + loaderVersion
                : instanceName.trim();
        GameInstanceID instanceId = new GameInstanceID(name);
        ComponentRemoteVersion loader = target;

        String label = gameVersion + " + " + loaderType + " " + loaderVersion;
        if (addon != null) {
            label += " + " + addon.getComponentType().getPatchId();
        }

        startBuild(instanceId, name, label, builder -> {
            builder.component(GameComponentType.GAME, gameVersion);
            builder.component(loader);
            if (addon != null) {
                builder.component(addon);
            }
            // 带加载器的实例通常要装模组，按 HMCL 的设置决定是否开隔离
            if (GameDirectoryManager.getSelectedRepository().shouldIsolateNewInstance(true)) {
                builder.enableIsolation();
            }
        }, isCleanroomType(loaderType), fugueVersion, scalarVersion);
    }

    private @Nullable GameRemoteVersion findGameVersion(String versionId) {
        List<GameRemoteVersion> cached = versions;
        if (cached == null) {
            return null;
        }
        for (GameRemoteVersion version : cached) {
            if (version.getGameVersion().toString().equals(versionId)) {
                return version;
            }
        }
        return null;
    }

    /// 创建实例并跑安装任务。原版与加载器共用这一段，
    /// 差别只在 `configure` 里挂了几个组件。
    ///
    /// @param cleanroom 是不是在装 Cleanroom。是的话装完自动往 mods 里放
    ///                  Fugue / Scalar Legacy——官方安装说明要求的两个补丁模组，
    ///                  缺了它们 Forge 模组的兼容性无从谈起（见 {@link CleanroomCompat}）。
    private void startBuild(GameInstanceID instanceId, String taskId, String label,
                            Consumer<HMCLGameBuilder> configure, boolean cleanroom,
                            @Nullable String fugueVersion, @Nullable String scalarVersion) {
        var repository = GameDirectoryManager.getSelectedRepository();
        if (repository.findInstance(instanceId) != null) {
            pushStage(taskId, instanceId + " 已经装过了", false, "instance exists");
            return;
        }

        // 任务列表标题：游戏版本 / 加载器名。这里没有「文件名」可显示，
        // 用户看到的是「1.19.1」或「Forge 47.2.0」更直接。
        pushTitle(taskId, label);
        pushStage(taskId, "准备安装 " + label + "…", false, null);

        try {
            var dependencyManager = repository.getDependency(DownloadProviders.getDownloadProvider());

            // try-with-resources 关闭的是「构建器」而不是任务：buildAsync() 已把
            // 仓库草稿的所有权转移给任务，这里关掉是安全且必须的（否则草稿一直占着）。
            try (HMCLGameBuilder builder = dependencyManager.newGameBuilder(instanceId)) {
                configure.accept(builder);
                Task<?> buildTask = builder.buildAsync();
                if (cleanroom) {
                    // 挂在构建任务后面而不是写在 onSuccess 里：进度条要等这两个
                    // jar 下完才算完成，否则会出现「条 100% 了还在传文件」
                    buildTask = buildTask.thenRunAsync("CleanroomCompat", Schedulers.defaultScheduler(),
                            () -> CleanroomCompat.install(instanceId, fugueVersion, scalarVersion,
                                    text -> pushStage(taskId, text, false, null)));
                }

                runWithProgress(buildTask, taskId, () -> {
                    // 装完切成当前实例，首页立刻能看到
                    try {
                        repository.setSelectedInstance(repository.getInstance(instanceId));
                    } catch (Exception e) {
                        LOG.warning("Failed to select the new instance", e);
                    }
                });
            }
        } catch (Exception e) {
            LOG.warning("Failed to build " + instanceId, e);
            pushStage(taskId, "安装失败：" + e.getMessage(), false, String.valueOf(e));
        }
    }

    /// 跑任务并把它接到进度通道上。原版安装、加载器安装、装进现有实例共用这一段。
    ///
    /// <p>进度不再直接透传子任务的 `progressProperty`：
    /// 那玩意儿在 `Task.doSubTask` 里被 bind 到「当前那个子任务」上，装一个版本要下
    /// 几百个文件，于是父任务的百分比是 0 → 100 → 0 → 100 地抽搐。
    /// 现在统一交给 {@link InstallProgress} 聚合成一条单调的进度，
    /// 大批量拉取（依赖库 / 资源）的进度用「已完成文件数 / 文件总数」表示。
    /// 正在跑的任务：任务 id → executor。取消就靠它。
    private final Map<String, TaskExecutor> runningTasks = new ConcurrentHashMap<>();

    /// 取消一个下载/安装任务。
    ///
    /// <p>之前任务一旦开始就只能等它跑完，失败的任务还得点 ✕ 手动移掉——
    /// 用户要的是「下到一半不想要了，点一下停掉」。
    void cancelTask(String taskId) {
        if (taskId == null) {
            return;
        }
        TaskExecutor executor = runningTasks.get(taskId);
        if (executor == null) {
            return;
        }
        LOG.info("[download] cancel " + taskId);
        executor.cancel();
    }

    private void runWithProgress(Task<?> task, String taskId, @Nullable Runnable onSuccess) {
        TaskExecutor executor = task.executor();
        runningTasks.put(taskId, executor);
        InstallProgress meter = new InstallProgress((stage, percent, filesDone, filesTotal) ->
                pushStage(taskId, stage, false, null, percent, "install", filesDone, filesTotal));

        executor.addTaskListener(new TaskListener() {
            @Override
            public void onRunning(Task<?> sub) {
                meter.onRunning(sub);
            }

            @Override
            public void onFinished(Task<?> sub) {
                meter.onFinished(sub);
            }

            @Override
            public void onPropertiesUpdate(Task<?> sub) {
                meter.onProperties(sub);
            }
        });

        // 每秒推一次心跳：大文件下载期间没有任何任务事件，只靠事件驱动的话
        // 界面上就是「卡住不动」。定时器随任务结束一起停。
        java.util.concurrent.ScheduledExecutorService beat =
                java.util.concurrent.Executors.newSingleThreadScheduledExecutor(runnable -> {
                    Thread thread = new Thread(runnable, "install-progress-tick");
                    thread.setDaemon(true);
                    return thread;
                });
        java.util.concurrent.ScheduledFuture<?> ticker = beat.scheduleAtFixedRate(
                meter::tick, 1, 1, java.util.concurrent.TimeUnit.SECONDS);

        task.onDone().register(event -> {
            ticker.cancel(false);
            beat.shutdownNow();
            runningTasks.remove(taskId);
            Platform.runLater(() -> {
                if (executor.isCancelled()) {
                    pushStage(taskId, "已取消", true, "cancelled");
                    return;
                }
                if (event.isFailed()) {
                    // TaskEvent 只带 failed 标记，真正的异常在 executor 上
                    Exception cause = executor.getException();
                    pushStage(taskId, "安装失败：" + (cause != null ? cause : "未知错误"),
                            false, String.valueOf(cause));
                    return;
                }
                meter.finish();
                if (onSuccess != null) {
                    onSuccess.run();
                }
                pushStage(taskId, "安装完成", true, null);
                // 实例列表变了，让页面重新拉一次状态
                push.accept("window.__hmcl && window.__hmcl.onInstallFinished("
                        + JsonUtils.GSON.toJson(taskId) + ")");
            });
        });

        executor.start();
    }

    /// 把加载器装进一个**已有**实例（对应 HMCL 的「安装到现有实例」）。
    ///
    /// 走 `updateInstanceAsync`：先取实例当前 manifest，叠加组件后提交。
    /// 中途失败不会动原实例——草稿只在成功时 commit。
    void installLoaderTo(String instanceId, String gameVersion, String loaderType, String loaderVersion) {
        if (instanceId == null || instanceId.isBlank()
                || loaderType == null || loaderVersion == null) {
            return;
        }

        List<ComponentRemoteVersion> cached = loaderVersions.get(loaderType + "@" + gameVersion);
        ComponentRemoteVersion target = null;
        if (cached != null) {
            for (ComponentRemoteVersion version : cached) {
                if (loaderVersion.equals(version.getSelfVersion())) {
                    target = version;
                    break;
                }
            }
        }
        if (target == null) {
            pushStage(instanceId, "列表里没有 " + loaderType + " " + loaderVersion, false, "unknown loader version");
            return;
        }

        var repository = GameDirectoryManager.getSelectedRepository();
        GameInstanceID id;
        try {
            id = new GameInstanceID(instanceId);
        } catch (Exception e) {
            pushStage(instanceId, "实例 id 不合法：" + instanceId, false, String.valueOf(e));
            return;
        }
        if (repository.findInstance(id) == null) {
            pushStage(instanceId, "找不到实例 " + instanceId, false, "instance not found");
            return;
        }

        pushStage(instanceId, "准备给 " + instanceId + " 装 " + loaderType + " " + loaderVersion + "…", false, null);

        try {
            var dependency = repository.getDependency(DownloadProviders.getDownloadProvider());
            ComponentRemoteVersion loader = target;
            Task<?> task = dependency.updateInstanceAsync(id, instance ->
                    Task.supplyAsync(instance::getResolvedManifest)
                            .thenComposeAsync(manifest ->
                                    dependency.installComponentRemoteAsync(instance, manifest, loader)));
            if (isCleanroomType(loaderType)) {
                // 往已有实例里补装 Cleanroom 时，同样把两个补丁模组补齐
                task = task.thenRunAsync("CleanroomCompat", Schedulers.defaultScheduler(),
                        () -> CleanroomCompat.install(id, null, null,
                                text -> pushStage(instanceId, text, false, null)));
            }

            runWithProgress(task, instanceId, () -> {
                try {
                    repository.setSelectedInstance(repository.getInstance(id));
                } catch (Exception e) {
                    LOG.warning("Failed to select the updated instance", e);
                }
            });
        } catch (Exception e) {
            LOG.warning("Failed to install loader into " + instanceId, e);
            pushStage(instanceId, "安装失败：" + e.getMessage(), false, String.valueOf(e));
        }
    }

    /// patch id 是不是 Cleanroom。前端传的是 `cleanroom`，这里再兜一层大小写。
    private static boolean isCleanroomType(@Nullable String loaderType) {
        return loaderType != null && "cleanroom".equalsIgnoreCase(loaderType.trim());
    }

    /// 任务名到「人话」的翻译已经挪进 {@link InstallProgress#phaseOf}：
    /// 那里顺带要把同一批任务归到同一个阶段上算权重，分两处维护必然会漂移。
    /// 任务标题（版本名 / 加载器名）。前端拿去当列表里那一行的大标题。
    private void pushTitle(String taskId, String title) {
        if (taskId == null || title == null || title.isBlank()) {
            return;
        }
        JsonObject json = new JsonObject();
        json.addProperty("id", taskId);
        json.addProperty("title", title);
        String text = JsonUtils.GSON.toJson(json);
        Platform.runLater(() -> push.accept("window.__hmcl && window.__hmcl.onInstallTitle("
                + JsonUtils.GSON.toJson(text) + ")"));
    }

    private void pushStage(String id, String stage, boolean done, String error) {
        pushStage(id, stage, done, error, -1, "install", -1, -1);
    }

    /// 拉版本清单结束时也会推一条 stage，但它不是「安装完成」。
    /// 前端靠 kind 区分，否则点一下刷新就会弹「安装完成，已切换到新实例」。
    private void pushStage(String id, String stage, boolean done, String error, double percent, String kind,
                           int filesDone, int filesTotal) {
        JsonObject json = new JsonObject();
        json.addProperty("id", id);
        json.addProperty("stage", stage);
        json.addProperty("done", done);
        json.addProperty("error", error);
        json.addProperty("kind", kind);
        // -1 表示这一步没有可量化的进度（前端显示不确定动画）
        json.addProperty("percent", percent);
        // 大批量拉取时的文件计数：-1 表示这一段没有总数（不是 0 个文件）
        json.addProperty("filesDone", filesDone);
        json.addProperty("filesTotal", filesTotal);
        // 打到 Java 日志：安装链路的问题大多只能在时间线上看出来
        LOG.info("[download] " + (id == null ? "-" : id) + " | " + stage
                + (percent >= 0 ? " | " + Math.round(percent * 100) + "%" : "")
                + (filesTotal > 0 ? " | " + filesDone + "/" + filesTotal + " files" : "")
                + (done ? " | done" : "") + (error != null ? " | " + error : ""));
        String text = JsonUtils.GSON.toJson(json);
        Platform.runLater(() -> push.accept("window.__hmcl && window.__hmcl.onInstallStage("
                + JsonUtils.GSON.toJson(text) + ")"));
    }
}
