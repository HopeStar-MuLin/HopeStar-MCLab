/*
 * HopeStar-MCLab
 *
 * 启动前检查：把「装上了但起不来」的情况在拉起进程之前拦下来。
 */
package org.jackhuang.hmcl.ui.web;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.jackhuang.hmcl.game.GameComponentType;
import org.jackhuang.hmcl.game.GameInstanceManifest;
import org.jackhuang.hmcl.game.GameJavaVersion;
import org.jackhuang.hmcl.game.HMCLGameInstance;
import org.jackhuang.hmcl.java.JavaRuntime;
import org.jackhuang.hmcl.setting.GameSettings;
import org.jetbrains.annotations.NotNullByDefault;

import java.nio.file.Files;
import java.nio.file.Path;

import static org.jackhuang.hmcl.util.DataSizeUnit.MEGABYTES;
import static org.jackhuang.hmcl.util.logging.Logger.LOG;
import static org.jackhuang.hmcl.util.platform.SystemInfo.getTotalMemorySize;

/// 启动前的资源检查。
///
/// <p>只回答一个问题：**现在点启动，会不会白等一场**。能从磁盘和设置里一眼定性的才查，
/// 不做修复、不做网络请求 —— 慢的东西放在这里会让「启动」按钮变得黏手。
///
/// <p>结果分两档：
/// - `blocking`：几乎必然起不来（缺客户端 jar、没有可用 Java、Java 版本低于要求），
///   前端默认按钮是「取消」；
/// - `warnings`：起得来但大概率出事（内存过小、缺前置、重复模组、jar 读不出来），
///   前端默认按钮是「仍然启动」。
///
/// <p>判定要保守：宁可漏报也不要误拦。误拦一次，用户下次就会条件反射地点「仍然启动」，
/// 那这套检查等于没有。
@NotNullByDefault
final class LaunchCheckService {

    /// 一条检查结果。
    ///
    /// `id` 给前端做去重和埋点用；`title` 是一行话；`detail` 说清「会怎样」和「去哪儿修」。
    ///
    /// **文案里不要拼数字**：用 `{0}` / `{1}` 占位，值放 `params` 一起下发。
    /// 拼死的句子在语言包里查不到，英文 / 繁体界面就只能掉回中文。
    private record Item(String id, String title, String detail, String... params) {
    }

    /// 跑一遍检查。**会读磁盘、会扫 mods 目录**，不要在 FX 线程上调。
    static JsonObject check(HMCLGameInstance instance) {
        JsonArray blocking = new JsonArray();
        JsonArray warnings = new JsonArray();

        checkGameJar(instance, blocking);
        checkJava(instance, blocking, warnings);
        checkMemory(instance, warnings);
        checkMods(instance, warnings);

        JsonObject root = new JsonObject();
        root.addProperty("ok", true);
        root.addProperty("instanceId", instance.getId().toString());
        root.addProperty("clean", blocking.isEmpty() && warnings.isEmpty());
        root.add("blocking", blocking);
        root.add("warnings", warnings);
        return root;
    }

    /// 客户端 jar 没了，启动一定失败，而且报错在日志深处（`ClassNotFoundException` 之类）。
    private static void checkGameJar(HMCLGameInstance instance, JsonArray blocking) {
        try {
            Path jar = instance.getInstanceJarFile();
            if (jar == null || !Files.isRegularFile(jar)) {
                blocking.add(item("game-jar", "缺少客户端 jar",
                        "版本目录中没有主程序文件，游戏无法启动。打开「管理 → 检查游戏完整性」，"
                                + "点「修复缺失文件」补回。"));
            }
        } catch (Throwable e) {
            LOG.warning("Launch check: cannot read game jar", e);
        }
    }

    /// Java 版本：拿「实际会被用到的那一个」去比对 manifest 的要求。
    ///
    /// <p>关键是不要猜：`GameSettings.Effective.getJava()` 走的就是启动时同一套选择逻辑
    /// （自动 / 指定版本号 / 手动指定），所以这里判出来的和真启动时用的是同一个。
    private static void checkJava(HMCLGameInstance instance, JsonArray blocking, JsonArray warnings) {
        int need = 8;
        GameInstanceManifest manifest;
        try {
            manifest = instance.getResolvedManifest();
            GameJavaVersion required = manifest.javaVersion();
            if (required != null) {
                need = required.majorVersion();
            }
        } catch (Throwable e) {
            LOG.warning("Launch check: cannot read required Java version", e);
            return;
        }

        JavaRuntime java;
        try {
            GameSettings.Effective effective = instance.getEffectiveSettings();
            java = effective.getJava(instance.getVersion(), manifest);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return;
        } catch (Throwable e) {
            LOG.warning("Launch check: cannot resolve Java runtime", e);
            return;
        }

        if (java == null) {
            blocking.add(item("java-missing", "未找到可用的 Java",
                    "该版本需要 Java {0}，本机未检测到，游戏无法启动。"
                            + "到「设置 → Java」点「下载 Java」安装，或在「Java 路径」里指定已装的版本。",
                    String.valueOf(need)));
            return;
        }

        int actual = java.getParsedVersion();
        if (actual < need) {
            blocking.add(item("java-old", "Java 版本过低",
                    "需要 Java {0}，当前为 {1}，游戏会在启动阶段退出。到「设置 → Java」换成 {0}。",
                    String.valueOf(need), java.getVersion()));
        } else if (actual - need > 1 && hasModLoader(instance)) {
            // 原版用高版本 Java 一般没事；带 mixin 的加载器跨太多大版本会炸在注入阶段。
            warnings.add(item("java-new", "Java 版本过高",
                    "该实例要求 Java {0}，当前为 {1}，可能导致加载器报错。到「设置 → Java」换回 {0}。",
                    String.valueOf(need), java.getVersion()));
        }
    }

    /// 内存：只查「手动指定」的情况。自动分配交给 HMCL 自己算，它比我们清楚。
    private static void checkMemory(HMCLGameInstance instance, JsonArray warnings) {
        try {
            GameSettings.Effective effective = instance.getEffectiveSettings();
            if (Boolean.TRUE.equals(effective.getInheritable(GameSettings::autoMemoryProperty))) {
                return;
            }
            Integer max = effective.getInheritable(GameSettings::maxMemoryProperty);
            if (max == null || max <= 0) {
                return;
            }

            if (max < 512) {
                warnings.add(item("mem-low", "内存分配过低",
                        "当前分配 {0} MB，可能导致游戏崩溃。"
                                + "到「设置 → 游戏」把「最大内存」调到 2048 MB 以上。",
                        String.valueOf(max)));
                return;
            }

            long totalMb = (long) MEGABYTES.convertFromBytes(getTotalMemorySize());
            if (totalMb > 0 && max > totalMb * 95 / 100) {
                // 给个能直接填的数：物理内存的 3/4，向下取整到 512 的倍数
                long suggest = Math.max(1024, (totalMb * 3 / 4) / 512 * 512);
                warnings.add(item("mem-high", "内存分配超过物理内存",
                        "当前分配 {0} MB，本机物理内存 {1} MB，可能导致启动失败。"
                                + "到「设置 → 游戏」把「最大内存」调到 {2} MB 以下。",
                        String.valueOf(max), String.valueOf(totalMb), String.valueOf(suggest)));
            }
        } catch (Throwable e) {
            LOG.warning("Launch check: cannot read memory settings", e);
        }
    }

    /// 模组层：缺前置、重复、jar 读不出来。
    ///
    /// <p>复用 `ModScanService.scan()`，它已经会读 `fabric.mod.json` / `mods.toml` /
    /// `mcmod.info` 并算好差集。这里只负责把结果翻译成人话，不重复解析 jar。
    private static void checkMods(HMCLGameInstance instance, JsonArray warnings) {
        JsonObject scan;
        try {
            String raw = ModScanService.scan(instance.getId().toString());
            scan = JsonParser.parseString(raw).getAsJsonObject();
        } catch (Throwable e) {
            // 扫描失败不该拦住启动：它的目的只是提前提醒
            LOG.warning("Launch check: mod scan failed", e);
            return;
        }
        if (!scan.has("ok") || !scan.get("ok").getAsBoolean()) {
            return;
        }

        JsonArray missing = scan.getAsJsonArray("missing");
        if (missing != null && !missing.isEmpty()) {
            StringBuilder names = new StringBuilder();
            for (int i = 0; i < Math.min(3, missing.size()); i++) {
                if (i > 0) {
                    names.append("、");
                }
                JsonObject item = missing.get(i).getAsJsonObject();
                names.append(item.has("needs") ? item.get("needs").getAsString() : "?");
            }
            if (missing.size() > 3) {
                names.append(" 等");
            }
            warnings.add(item("mod-missing", "{0} 个模组缺少前置",
                    "缺少：{1}，缺了会让游戏异常。到实例的「内容」里补上前置。",
                    String.valueOf(missing.size()), names.toString()));
        }

        JsonArray duplicates = scan.getAsJsonArray("duplicates");
        if (duplicates != null && !duplicates.isEmpty()) {
            warnings.add(item("mod-duplicate", "{0} 组重复模组",
                    "同一模组存在多个 jar，可能导致版本冲突。到实例的「内容」里删掉多余的那份。",
                    String.valueOf(duplicates.size())));
        }

        JsonArray unreadable = scan.getAsJsonArray("unreadable");
        if (unreadable != null && !unreadable.isEmpty()) {
            warnings.add(item("mod-unreadable", "{0} 个 jar 无法读取",
                    "文件读不出来，通常是下载不完整。到实例的「内容」里删掉后重新下载。",
                    String.valueOf(unreadable.size())));
        }
    }

    private static boolean hasModLoader(HMCLGameInstance instance) {
        try {
            for (GameComponentType type : GameComponentType.MOD_LOADERS) {
                if (instance.getComponentVersion(type) != null) {
                    return true;
                }
            }
        } catch (Throwable ignored) {
            // 读不出来就当没有，走更宽松的判定
        }
        return false;
    }

    private static JsonObject item(String id, String title, String detail, String... params) {
        JsonObject o = new JsonObject();
        o.addProperty("id", id);
        o.addProperty("title", title);
        o.addProperty("detail", detail);
        if (params != null && params.length > 0) {
            JsonArray values = new JsonArray();
            for (String value : params) {
                values.add(value);
            }
            o.add("params", values);
        }
        return o;
    }

    private LaunchCheckService() {
    }
}
