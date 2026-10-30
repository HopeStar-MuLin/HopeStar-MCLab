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
import org.jackhuang.hmcl.game.GameInstanceID;
import org.jackhuang.hmcl.game.HMCLGameInstance;
import org.jackhuang.hmcl.setting.GameDirectoryManager;
import org.jackhuang.hmcl.util.gson.JsonUtils;

import java.nio.charset.StandardCharsets;
import java.nio.file.DirectoryStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.util.*;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import static org.jackhuang.hmcl.util.logging.Logger.LOG;

/// 读游戏崩溃报告，翻成人话。
///
/// <p>原版崩溃报告动辄上千行，用户真正需要的信息只有三条：为什么崩、
/// 大概率是谁的锅、下一步做什么。这里按关键字把常见的几十种崩法归类，
/// 再把堆栈里反复出现的包名对回 mods 目录里的 jar。
///
/// <p>只读不写：不修、不改、不动实例。
final class CrashService {

    private CrashService() {
    }

    /// 一条判定规则：文本里出现任一关键词就命中。
    private record Rule(String[] keywords, String title, String detail, String[] hints) {
    }

    /// 规则表按「越具体越靠前」排。第一个命中的说话，避免
    /// `NoClassDefFoundError` 这种万能异常把所有具体原因都盖掉。
    private static final List<Rule> RULES = List.of(
            new Rule(
                    new String[]{"outofmemoryerror", "java heap space", "insufficient memory"},
                    "内存不够",
                    "游戏在申请内存时耗尽了 JVM 堆。整合包越大越容易碰到，和电脑总内存关系不大，取决于给游戏分配了多少。",
                    new String[]{
                            "到「实例 → 设置 → 最大内存」把分配值调大（建议 4096 MB 以上，大型整合包 6144–8192 MB）",
                            "同时关掉其它吃内存的程序；32 位 Java 最多只能用 1–1.5 GB，确认用的是 64 位",
                            "分配超过物理内存反而会频繁换页，别超过机器可用内存的 60%"
                    }),
            new Rule(
                    new String[]{"unsupportedclassversionerror", "has been compiled by a more recent version"},
                    "Java 版本太低",
                    "某个模组或游戏本体是用更高版本的 Java 编译的，当前 Java 跑不了它的字节码。",
                    new String[]{
                            "1.17+ 需要 Java 17 及以上，1.20.5+ 推荐 Java 21",
                            "到「设置 → Java」换一个更高版本，再回到实例设置里指定它"
                    }),
            new Rule(
                    new String[]{"missing or unsupported mandatory dependencies", "missing dependencies", "mod requires"},
                    "缺少前置模组",
                    "有模组声明了必须存在的前置，但 mods 目录里没有（或版本区间不满足）。",
                    new String[]{
                            "打开「实例 → 模组」页顶部的依赖检查，会列出缺哪个、被谁需要",
                            "装上前置后重启游戏；注意前置本身也可能还有前置"
                    }),
            new Rule(
                    new String[]{"duplicate mods", "found duplicate", "duplicatemod"},
                    "同一个模组装了多份",
                    "mods 目录里存在两个 id 相同的 jar（常见于更新时旧文件没删）。",
                    new String[]{
                            "到「实例 → 模组」页看依赖检查里的「重复安装」，删掉旧的那个",
                            "文件名带 (1)、(2) 后缀的基本都是重复下载"
                    }),
            new Rule(
                    new String[]{"mixin apply failed", "mixinapplyerror", "mixin transformation", "mixintransformererror"},
                    "Mixin 注入失败",
                    "某个模组想改写游戏代码但注入点对不上，通常是模组版本和游戏/加载器版本不匹配。",
                    new String[]{
                            "确认这个模组支持当前的游戏版本与加载器版本",
                            "把报错里提到的模组单独停用，逐个排查",
                            "同类功能的两个模组（如两个优化模组）同时改一处代码也会这样"
                    }),
            new Rule(
                    new String[]{"java.lang.nosuchmethoderror", "java.lang.noclassdeffounderror", "java.lang.classnotfoundexception"},
                    "类或方法找不到（多为版本不匹配）",
                    "代码在运行时要找一个类/方法，但当前加载的 jar 里没有。整合包里最常见的原因是某个模组的前置版本对不上。",
                    new String[]{
                            "看堆栈里第一条 `at` 后面的包名，基本就是出问题的模组",
                            "把该模组和它的前置一起更新到同一批发布的版本",
                            "少数情况是整合包自带的库被手动删过，用「检查游戏完整性」补回来"
                    }),
            new Rule(
                    new String[]{"glfw error", "pixel format not accelerated", "failed to create window", "opengl"},
                    "显卡/驱动问题",
                    "创建 OpenGL 上下文失败。笔记本双显卡、远程桌面、老驱动都可能触发。",
                    new String[]{
                            "更新显卡驱动；NVIDIA 用户在控制面板里把 javaw.exe 指定为「高性能显卡」",
                            "远程桌面/虚拟机里通常无法开 3D，改用本机运行",
                            "实在不行在实例设置里加 JVM 参数 `-Dorg.lwjgl.opengl.Display.allowSoftwareOpenGL=true`（很卡，仅应急）"
                    }),
            new Rule(
                    new String[]{"the game crashed whilst", "exception ticking world", "ticking entity", "ticking block entity"},
                    "游戏内逻辑崩溃",
                    "某个实体/方块实体在每 tick 更新时抛了异常，通常是某个模组对特定方块或生物处理不当。",
                    new String[]{
                            "看崩溃描述里提到的维度与坐标，回档或避开那块区域",
                            "用二分法停用可疑模组确认",
                            "如果只在特定存档出现，多半是存档里的数据被模组改坏了"
                    }),
            new Rule(
                    new String[]{"formatterexception", "json parse", "com.google.gson", "malformed"},
                    "配置文件/资源包格式错误",
                    "某个 JSON 读取失败，常见于手动改过配置、或资源包/模组包里的 json 损坏。",
                    new String[]{
                            "崩溃信息里通常会给出具体文件路径，打开检查那一行的括号与逗号",
                            "改过配置的话，删掉配置文件让游戏重新生成"
                    }),
            new Rule(
                    new String[]{"accessdeniedexception", "permission denied", "being used by another process"},
                    "文件被占用或无权限",
                    "游戏要写的文件正被别的程序占着，或当前用户没有写权限。",
                    new String[]{
                            "确认没有第二个启动器/游戏实例在跑",
                            "杀毒软件可能锁住了 jar，把游戏目录加入白名单",
                            "把启动器装在用户目录下，避免 Program Files 的权限问题"
                    })
    );

    /// 分析最近一次崩溃。没有崩溃报告时返回 `found=false`。
    static String analyze(String instanceId) {
        JsonObject root = new JsonObject();
        try {
            HMCLGameInstance instance = GameDirectoryManager.getSelectedRepository()
                    .getInstance(new GameInstanceID(instanceId));

            // 崩溃报告跟着「运行目录」走，但隔离/非隔离实例上这两个 dir 不一定一致：
            // 都看一眼，取更新时间最新的一份。
            Path report = latestCrashReport(instance.getRunDirectory());
            if (report == null) {
                report = latestCrashReport(instance.getInstanceRoot());
            }
            if (report == null) {
                root.addProperty("ok", true);
                root.addProperty("found", false);
                return JsonUtils.GSON.toJson(root);
            }

            String text = readText(report);
            String lower = text.toLowerCase(Locale.ROOT);

            root.addProperty("ok", true);
            root.addProperty("found", true);
            root.addProperty("file", report.getFileName().toString());
            try {
                root.addProperty("time", Files.getLastModifiedTime(report).toInstant().toEpochMilli());
            } catch (Throwable ignored) {
                root.addProperty("time", Instant.now().toEpochMilli());
            }
            root.addProperty("size", Files.size(report));

            // 崩溃描述：原版报告里 "Description: ..." 那一行信息量最大
            String description = firstMatch(text, "(?m)^Description:\\s*(.+)$");
            String exception = firstMatch(text, "(?m)^([a-zA-Z_$][\\w.$]*(?:Exception|Error)):\\s*(.*)$");

            root.addProperty("description", description == null ? "" : description.trim());
            root.addProperty("exception", exception == null ? "" : exception.trim());

            // 命中第一条规则就够：规则表已经是「具体 → 笼统」的顺序
            Rule hit = null;
            for (Rule rule : RULES) {
                for (String keyword : rule.keywords()) {
                    if (lower.contains(keyword)) {
                        hit = rule;
                        break;
                    }
                }
                if (hit != null) {
                    break;
                }
            }

            if (hit != null) {
                root.addProperty("title", hit.title());
                root.addProperty("detail", hit.detail());
                JsonArray hints = new JsonArray();
                for (String h : hit.hints()) {
                    hints.add(h);
                }
                root.add("hints", hints);
            } else {
                root.addProperty("title", "没能归类到已知原因");
                root.addProperty("detail", "崩溃报告里没有出现我们认识的模式。下面是原始信息，可以据此进一步排查。");
                JsonArray hints = new JsonArray();
                hints.add("把这份报告里的 `Description` 和第一条异常发到模组作者的问题区，通常很快能定位");
                hints.add("先停用最近新装的模组试一次，这是最快的二分法");
                root.add("hints", hints);
            }

            // 可疑模组：堆栈里出现次数最多的顶层包名，且能在 mods 目录里找到
            root.add("suspects", suspects(instance, text));
            // 报告前 60 行给前端做「原文」折叠区，够看出是什么崩的
            root.addProperty("excerpt", excerpt(text, 60));

            return JsonUtils.GSON.toJson(root);
        } catch (Throwable e) {
            LOG.warning("Failed to analyze crash report of " + instanceId, e);
            root.addProperty("ok", false);
            root.addProperty("error", String.valueOf(e));
            return JsonUtils.GSON.toJson(root);
        }
    }

    private static Path latestCrashReport(Path base) {
        if (base == null) {
            return null;
        }
        Path dir = base.resolve("crash-reports");
        if (!Files.isDirectory(dir)) {
            return null;
        }
        Path best = null;
        long bestTime = -1;
        try (DirectoryStream<Path> stream = Files.newDirectoryStream(dir, "*.txt")) {
            for (Path p : stream) {
                try {
                    long t = Files.getLastModifiedTime(p).toMillis();
                    if (t > bestTime) {
                        bestTime = t;
                        best = p;
                    }
                } catch (Throwable ignored) {
                }
            }
        } catch (Throwable e) {
            return null;
        }
        return best;
    }

    private static String readText(Path p) {
        try {
            byte[] bytes = Files.readAllBytes(p);
            // 崩溃报告最大见过 20MB+，只留前 2MB 就够判定
            int len = Math.min(bytes.length, 2 * 1024 * 1024);
            return new String(bytes, 0, len, StandardCharsets.UTF_8);
        } catch (Throwable e) {
            return "";
        }
    }

    /// 取第一个匹配的捕获组（没有捕获组就返回整段）。
    private static String firstMatch(String text, String regex) {
        try {
            Matcher m = Pattern.compile(regex).matcher(text);
            if (m.find()) {
                return m.groupCount() >= 1 ? m.group(1) : m.group();
            }
        } catch (Throwable ignored) {
        }
        return null;
    }

    /// 从堆栈行里抽包名，按出现次数排序，再和 mods 里的文件名做模糊匹配。
    ///
    /// <p>不追求精确：模组的 modid 和它的包名经常不一样（`jei` / `mezz.jei`），
    /// 所以两边都做归一化（去掉点、下划线、连字符）后再互相包含判断。
    private static JsonArray suspects(HMCLGameInstance instance, String text) {
        JsonArray result = new JsonArray();
        try {
            Map<String, Integer> counts = new LinkedHashMap<>();
            Matcher m = Pattern.compile("at\\s+([a-z][\\w]*(?:\\.[a-z][\\w]*){1,3})\\.").matcher(text);
            while (m.find()) {
                String pkg = m.group(1).toLowerCase(Locale.ROOT);
                // 游戏本体和常见库不算「可疑模组」
                if (pkg.startsWith("java.") || pkg.startsWith("javax.")
                        || pkg.startsWith("jdk.") || pkg.startsWith("sun.")
                        || pkg.startsWith("net.minecraft") || pkg.startsWith("com.mojang")
                        || pkg.startsWith("org.lwjgl") || pkg.startsWith("com.google")
                        || pkg.startsWith("org.apache") || pkg.startsWith("org.spongepowered")
                        || pkg.startsWith("org.objectweb") || pkg.startsWith("net.fabricmc")
                        || pkg.startsWith("net.minecraftforge") || pkg.startsWith("cpw.mods")) {
                    continue;
                }
                counts.merge(pkg, 1, Integer::sum);
            }
            if (counts.isEmpty()) {
                return result;
            }

            List<Path> jars = new ArrayList<>();
            Path modsDir = instance.getModsDirectory();
            if (Files.isDirectory(modsDir)) {
                try (DirectoryStream<Path> stream = Files.newDirectoryStream(modsDir, "*.jar")) {
                    for (Path p : stream) {
                        jars.add(p);
                    }
                }
            }

            counts.entrySet().stream()
                    .sorted((a, b) -> b.getValue() - a.getValue())
                    .limit(6)
                    .forEach(e -> {
                        String pkg = e.getKey();
                        String normalizedPkg = pkg.replace(".", "");
                        String matched = null;
                        for (Path jar : jars) {
                            // 去掉扩展名、分隔符和版本号：testmod-a-1.0.jar -> testmoda，
                            // 这样才可能和包名 me.someauthor.testmoda 对上
                            String name = jar.getFileName().toString().toLowerCase(Locale.ROOT)
                                    .replace(".jar", "")
                                    .replaceAll("[0-9._ -]", "");
                            if (name.length() < 3) {
                                continue;
                            }
                            if (name.contains(normalizedPkg) || normalizedPkg.contains(name)) {
                                matched = jar.getFileName().toString();
                                break;
                            }
                        }
                        // 没有对应 jar 也报出来：可能是被删掉的库
                        JsonObject o = new JsonObject();
                        o.addProperty("package", pkg);
                        o.addProperty("hits", e.getValue());
                        o.addProperty("file", matched == null ? "" : matched);
                        result.add(o);
                    });
        } catch (Throwable e) {
            LOG.warning("Failed to pick crash suspects", e);
        }
        return result;
    }

    private static String excerpt(String text, int lines) {
        String[] all = text.split("\\R");
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < Math.min(lines, all.length); i++) {
            sb.append(all[i]).append('\n');
        }
        return sb.toString();
    }
}
