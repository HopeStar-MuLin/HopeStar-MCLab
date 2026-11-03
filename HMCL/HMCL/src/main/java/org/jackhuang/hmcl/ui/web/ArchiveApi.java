/*
 * Hello Minecraft! Launcher
 * Copyright (C) 2026  huangyuhui <huanghongxun2008@126.com> and contributors
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
import com.google.gson.JsonObject;
import javafx.application.Platform;
import javafx.stage.DirectoryChooser;
import javafx.stage.FileChooser;
import javafx.stage.Stage;
import org.jackhuang.hmcl.ui.Controllers;
import org.jackhuang.hmcl.util.gson.JsonUtils;
import org.jetbrains.annotations.NotNullByDefault;

import java.io.File;
import java.nio.file.Path;

import static org.jackhuang.hmcl.util.logging.Logger.LOG;

/// 实例的导出与导入：ZIP / 整合包 / 存档 / 拖进来的文件 / 上传落盘。
///
/// <p>业务在 `ExportService` 与 `ArchiveImportService` 里，这里只做参数搬运与 JSON 组装。
/// 单独成类是因为它和其它内容接口没有共享状态：全是「给个路径、跑一个任务、推进度」，
/// 失败也各自 toast，不牵扯实例列表和搜索缓存。
@NotNullByDefault
public final class ArchiveApi {

    private final BridgeHost host;
    private final BridgeServices services;

    ArchiveApi(BridgeHost host, BridgeServices services) {
        this.host = host;
        this.services = services;
    }

    // ==================== 导出 ====================

    /// 弹保存文件对话框，返回绝对路径；取消返回空串。
    ///
    /// <p>走 JavaFX 的 FileChooser 而不是让用户自己输路径：导出是低频操作，
    /// 原生对话框能记住上次目录，也省得手打盘符。
    public String chooseSavePath(String defaultName, String extension) {
        FileChooser chooser = new FileChooser();
        chooser.setTitle("导出到");
        String ext = extension == null || extension.isBlank() ? "zip" : extension;
        chooser.setInitialFileName(defaultName == null || defaultName.isBlank()
                ? "export." + ext : defaultName);
        chooser.getExtensionFilters().add(
                new FileChooser.ExtensionFilter(ext.toUpperCase(java.util.Locale.ROOT) + " 文件", "*." + ext));
        // 挂到主窗口上：不挂 owner 的对话框在部分 Windows 主题下会跑到窗口后面
        Stage owner = null;
        try {
            owner = Controllers.getStage();
        } catch (Throwable ignored) {
            // 还没有主窗口（理论上有，兜一下）
        }
        java.io.File file = chooser.showSaveDialog(owner);
        return file == null ? "" : file.getAbsolutePath();
    }

    /// 把实例目录打成 zip（跳过 logs / crash-reports / backups / 缓存）。
    public void exportInstanceZip(String instanceId, String targetPath) {
        if (targetPath == null || targetPath.isBlank()) {
            return;
        }
        services.exports.exportInstance(instanceId, Path.of(targetPath));
    }

    /// 把单个存档打成 zip，压缩包里带一层存档目录名。
    public void exportWorldZip(String instanceId, String worldName, String targetPath) {
        if (targetPath == null || targetPath.isBlank()) {
            return;
        }
        services.exports.exportWorld(instanceId, worldName, Path.of(targetPath));
    }

    /// 导出整合包。format: `mrpack` / `mcbbs` / `server`。
    public void exportModpack(String instanceId, String format, String targetPath,
                              String name, String version, String author, String description) {
        if (targetPath == null || targetPath.isBlank()) {
            return;
        }
        services.exports.exportModpack(instanceId, format, Path.of(targetPath),
                name, version, author, description);
    }

    // ==================== 导入 ====================

    /// 弹打开文件对话框，返回选中的压缩包路径；取消返回空串。
    public String chooseImportArchive() {
        FileChooser chooser = new FileChooser();
        chooser.setTitle("导入压缩包");
        chooser.getExtensionFilters().addAll(
                new FileChooser.ExtensionFilter("压缩包 (*.zip, *.mrpack)", "*.zip", "*.mrpack"),
                new FileChooser.ExtensionFilter("所有文件", "*.*"));
        Stage owner = null;
        try {
            owner = Controllers.getStage();
        } catch (Throwable ignored) {
            // 没有主窗口时也能弹，只是可能落到窗口后面
        }
        java.io.File file = chooser.showOpenDialog(owner);
        return file == null ? "" : file.getAbsolutePath();
    }

    /// 预检压缩包：识别类型、检查能不能导入。
    ///
    /// <p>只读条目列表和几个小 json，同步返回。用户点「导入」之前要看到
    /// 「这是什么、会装到哪、有什么风险」，这一步就是为了那个确认弹窗。
    public String inspectArchive(String path) {
        if (path == null || path.isBlank()) {
            return "{}";
        }
        try {
            return ArchiveImportService.probe(Path.of(path)).toString();
        } catch (Throwable e) {
            LOG.warning("Failed to inspect archive " + path, e);
            JsonObject out = new JsonObject();
            out.addProperty("ok", false);
            out.addProperty("kind", "unknown");
            JsonArray errors = new JsonArray();
            errors.add("识别失败：" + (e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage()));
            out.add("errors", errors);
            return out.toString();
        }
    }

    /// 执行导入。结果通过 `onArchiveImported` 推回前端。
    ///
    /// <p>整合包不在这里解压：它有自己的一套安装任务链（下载模组、装加载器、
    /// 写实例配置），交给 {@link AddonService#installDroppedModpack} 更稳妥。
    public String importArchive(String path, String instanceId) {
        if (path == null || path.isBlank()) {
            return "";
        }
        Path file = Path.of(path);
        String target = instanceId == null || instanceId.isBlank() ? null : instanceId;

        org.jackhuang.hmcl.task.Task.runAsync(() -> {
            JsonObject result;
            try {
                JsonObject probe = ArchiveImportService.probe(file);
                String kind = probe.has("kind") ? probe.get("kind").getAsString() : "unknown";
                if ("modpack".equals(kind)) {
                    services.addons.installDroppedModpack(file, target);
                    result = new JsonObject();
                    result.addProperty("ok", true);
                    result.addProperty("kind", "modpack");
                    result.addProperty("delegated", true);
                    result.addProperty("name", probe.has("name") ? probe.get("name").getAsString() : "");
                    result.addProperty("file", file.getFileName().toString());
                    result.add("warnings", probe.has("warnings") ? probe.get("warnings") : new JsonArray());
                    result.add("errors", new JsonArray());
                } else {
                    result = services.archiveImports.importArchive(file, probe, target);
                }
            } catch (Throwable e) {
                LOG.warning("Failed to import archive " + file, e);
                result = new JsonObject();
                result.addProperty("ok", false);
                result.addProperty("kind", "unknown");
                result.addProperty("file", file.getFileName() == null ? "" : file.getFileName().toString());
                JsonArray errors = new JsonArray();
                errors.add(e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage());
                result.add("errors", errors);
                result.add("warnings", new JsonArray());
            }

            // 导入了实例就得让前端重新读一遍列表
            final JsonObject finalResult = result;
            try {
                Platform.runLater(() -> {
                    host.pushState();
                    host.execute("window.__hmcl && window.__hmcl.onArchiveImported("
                            + JsonUtils.GSON.toJson(JsonUtils.GSON.toJson(finalResult)) + ")");
                });
            } catch (Throwable e) {
                LOG.warning("Failed to push import result", e);
            }
        }).start();

        // 前端用返回值判断「请求是否真的发出去了」：空串表示参数不对，
        // 真正的导入结果稍后走 onArchiveImported，不在这里等。
        return "started";
    }

    /// 弹目录选择框，返回选中路径；取消返回空串。
    /// 没选实例时下载要让用户自己挑位置，这个就是那个「浏览…」按钮。
    public String chooseDirectory(String title) {
        DirectoryChooser chooser = new DirectoryChooser();
        chooser.setTitle(title == null || title.isBlank() ? "选择保存位置" : title);
        Path chosen = Controllers.showDialog(chooser);
        return chosen == null ? "" : chosen.toAbsolutePath().toString();
    }

    /// 在线整合包安装
    public void installModpackRemote(String slug, String versionId, String iconUrl, String instanceName) {
        services.addons.installModpackRemote(slug, versionId, iconUrl, instanceName);
    }

    /// 手动检查一个实例的整合包更新，结果通过 `onModpackUpdates` 推回去。
    /// 跳过缓存，并且带上 `manual` 标记让前端弹提示。
    public void modpackUpdateRefresh(String instanceId) {
        services.addons.refreshModpackUpdate(instanceId);
    }

    /// 所有带来源记录的实例的更新状态，实例页打开时一次拿全。
    /// 异步推送 —— 这里要打平台接口，同步做会把界面卡住。
    public void modpackUpdateList(String force) {
        services.addons.checkAllModpackUpdates("true".equalsIgnoreCase(force));
    }

    /// 下载并应用整合包更新。进度走右上角任务列表。
    public void modpackUpdateApply(String instanceId) {
        services.addons.updateModpack(instanceId);
    }


    /// 本地文件导入（/api/upload 把它落到临时目录之后调这里）。
    /// kind: modpack / world / resourcepack / shader
    public void importLocal(String kind, String path, String instanceId, String instanceName) {
        if (path == null || path.isBlank()) {
            return;
        }
        java.nio.file.Path file = java.nio.file.Path.of(path);

        // 主题的图标和背景图也走同一条上传通道，但不进 mods 目录
        if ("theme-icon".equals(kind)) {
            String json = InstanceThemeService.applyIcon(instanceId, file);
            toastThemeResult(json, "图标已更新");
            host.pushState();
            return;
        }
        if ("theme-bg".equals(kind)) {
            String json = InstanceThemeService.applyBackground(instanceId, file);
            toastThemeResult(json, "背景图已更新");
            return;
        }
        if ("theme-launcher-icon".equals(kind)) {
            String json = InstanceThemeService.applyLauncherIcon(instanceId, file);
            toastThemeResult(json, "启动器图标已更新");
            return;
        }

        // 上传路径：path 指向 HTTP 服务落的临时文件，装完必须删
        services.addons.installLocalFile(kind, file,
                instanceId == null || instanceId.isBlank() ? null : instanceId,
                instanceName == null || instanceName.isBlank() ? null : instanceName, true);
    }

    private void toastThemeResult(String json, String okMessage) {
        try {
            JsonObject o = JsonUtils.GSON.fromJson(json, JsonObject.class);
            if (o != null && o.has("ok") && o.get("ok").getAsBoolean()) {
                host.toast(okMessage);
            } else {
                host.toast("失败：" + (o != null && o.has("error") ? o.get("error").getAsString() : "未知错误"));
            }
        } catch (Throwable e) {
            host.toast("操作失败：" + e.getMessage());
        }
    }

    /// 拖拽进来的路径先认一下是什么。
    ///
    /// <p>前端拿到的是绝对路径（Tauri 的原生拖放事件给的），但「这是模组还是资源包」
    /// 要看压缩包内部结构，只能在后端判断。
    public String classifyDrop(String path) {
        try {
            return JsonUtils.GSON.toJson(DropService.classify(java.nio.file.Path.of(path)));
        } catch (Exception e) {
            JsonObject o = new JsonObject();
            o.addProperty("kind", "unknown");
            o.addProperty("detail", "路径无效：" + e.getMessage());
            return JsonUtils.GSON.toJson(o);
        }
    }

    /// 拖拽安装。instanceId 为空时用首页选中的实例。
    /// 一次拖进来多个文件：逐个认类型、分发到对应安装通道，最后推一条汇总。
    ///
    /// <p>认类型要读 zip 里的元数据（`manifest.json` / `fabric.mod.json`），
    /// 十几个文件叠在一起会卡住 FX 线程，所以整段丢后台，结果走 `onDropResult`。
    public void dropImport(String pathsJson, String instanceId) {
        if (pathsJson == null || pathsJson.isBlank()) {
            return;
        }
        String targetInstance = instanceId == null || instanceId.isBlank() ? null : instanceId;
        org.jackhuang.hmcl.task.Task.runAsync(() -> {
            JsonObject result = new JsonObject();
            JsonObject imported = new JsonObject();
            JsonArray skipped = new JsonArray();
            int total = 0;
            try {
                JsonArray paths = JsonUtils.GSON.fromJson(pathsJson, JsonArray.class);
                for (var element : paths) {
                    total++;
                    String raw = element.getAsString();
                    JsonObject item = new JsonObject();
                    item.addProperty("file", java.nio.file.Path.of(raw).getFileName().toString());
                    try {
                        java.nio.file.Path path = java.nio.file.Path.of(raw);
                        JsonObject classified = DropService.classify(path);
                        String kind = classified.has("kind") ? classified.get("kind").getAsString() : "unknown";
                        // schematic 是蓝图，进不了实例；unknown 是认不出来 —— 都列出来别静默丢
                        if ("unknown".equals(kind) || "schematic".equals(kind)) {
                            item.addProperty("reason", classified.has("detail")
                                    ? classified.get("detail").getAsString() : "不认识的格式");
                            skipped.add(item);
                            continue;
                        }
                        // 实例包 / 数据包 / 一堆 jar 走导入服务：那里有解压、重名处理、
                        // 逐文件校验，和菜单里的「导入 ZIP」是同一条路
                        if ("instance".equals(kind) || "datapack".equals(kind)
                                || "mod_bundle".equals(kind)) {
                            JsonObject outcome = services.archiveImports.importArchive(
                                    path, ArchiveImportService.probe(path), targetInstance);
                            if (outcome.has("ok") && outcome.get("ok").getAsBoolean()) {
                                imported.addProperty(kind,
                                        imported.has(kind) ? imported.get(kind).getAsInt() + 1 : 1);
                            } else {
                                String reason = "导入失败";
                                if (outcome.has("errors") && !outcome.getAsJsonArray("errors").isEmpty()) {
                                    reason = outcome.getAsJsonArray("errors").get(0).getAsString();
                                }
                                item.addProperty("reason", reason);
                                skipped.add(item);
                            }
                            continue;
                        }
                        services.addons.installDropped(kind, path, targetInstance);
                        imported.addProperty(kind,
                                imported.has(kind) ? imported.get(kind).getAsInt() + 1 : 1);
                    } catch (Throwable e) {
                        item.addProperty("reason", e.getMessage() == null ? "导入失败" : e.getMessage());
                        skipped.add(item);
                    }
                }
                result.addProperty("ok", true);
            } catch (Throwable e) {
                result.addProperty("ok", false);
                result.addProperty("error", e.getMessage() == null ? String.valueOf(e) : e.getMessage());
            }
            result.addProperty("total", total);
            result.add("imported", imported);
            result.add("skipped", skipped);
            // 原版实例拖了模组：文件落进去了但不会生效，得当面说清楚，
            // 否则用户下次启动才发现「为什么模组没反应」。
            if (imported.has("mod") && imported.get("mod").getAsInt() > 0
                    && !services.addons.hasModLoader(targetInstance)) {
                result.addProperty("warning",
                        "这个实例是原版，模组不会生效 —— 先到「加载器」里装 Fabric 或 Forge");
            }
            String text = JsonUtils.GSON.toJson(result);
            Platform.runLater(() -> host.execute("window.__hmcl && window.__hmcl.onDropResult("
                    + JsonUtils.GSON.toJson(text) + ")"));
        }).start();
    }

    public void importDropped(String kind, String path, String instanceId) {
        try {
            services.addons.installDropped(kind, java.nio.file.Path.of(path),
                    instanceId == null || instanceId.isBlank() ? null : instanceId);
        } catch (Exception e) {
            LOG.warning("Failed to import dropped file " + path, e);
            host.toast("导入失败：" + e.getMessage());
        }
    }

    /// 拖进来的是整合包：先匹配平台项目再装，匹配不到也照常装。
    public void importDroppedModpack(String path, String instanceId) {
        try {
            services.addons.installDroppedModpack(java.nio.file.Path.of(path),
                    instanceId == null || instanceId.isBlank() ? null : instanceId);
        } catch (Exception e) {
            LOG.warning("Failed to import dropped modpack " + path, e);
            host.toast("导入失败：" + e.getMessage());
        }
    }

}
