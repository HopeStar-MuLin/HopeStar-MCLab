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
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.jackhuang.hmcl.game.GameInstanceID;
import org.jackhuang.hmcl.game.HMCLGameInstance;
import org.jackhuang.hmcl.setting.GameDirectoryManager;
import org.jackhuang.hmcl.util.gson.JsonUtils;

import java.nio.charset.StandardCharsets;
import java.nio.file.DirectoryStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.time.Instant;
import java.util.*;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.zip.ZipEntry;
import java.util.zip.ZipFile;

import static org.jackhuang.hmcl.util.logging.Logger.LOG;

/// 读游戏崩溃现场，翻成人话，并给出可执行的处理动作。
///
/// <p>三个层次：
/// <list>
///   <item>为什么崩 —— 规则表把几十种常见崩法归类，给出结论和建议；</item>
///   <item>谁的锅 —— 从崩溃报告 / 日志里多路取证据（Suspected Mods、Mixin 失败、
///         堆栈里的 jar 引用、包名前缀、缺前置报错），给每个模组打分；</item>
///   <item>怎么办 —— 一键禁用可疑模组（改名 `.disabled`，可原样恢复）、
///         跳到下载页找兼容版本。</item>
/// </list>
///
/// <p>数据来源按优先级：`crash-reports/` 里最新一份报告 → `logs/latest.log`。
/// 很多加载期崩溃（缺前置、Java 版本不对）根本不会生成崩溃报告，只看
/// crash-reports 会漏掉一大半。
final class CrashService {

    private CrashService() {
    }

    /// 24 小时：崩溃前不久装进来的模组，在没有其它线索时也算嫌疑对象。
    private static final long RECENT_WINDOW_MS = 24L * 3600 * 1000;
    /// 日志只读尾部，几 MB 的 latest.log 全读进来没意义还占内存。
    private static final int MAX_LOG_BYTES = 1024 * 1024;

    // ==================== 规则表 ====================

    /// 一条判定规则：文本里出现 `keywords` 任一（且 `alsoAny` 为空或也命中任一）就成立。
    private record Rule(String[] keywords, String[] alsoAny, String title, String detail, String[] hints) {
        Rule(String[] keywords, String title, String detail, String[] hints) {
            this(keywords, null, title, detail, hints);
        }
    }

    /// 规则按「越具体越靠前」排，第一个命中的说话。
    /// `the game crashed whilst` 这种 Forge 每份报告都有的套话必须放最后，
    /// 否则它会把所有具体原因盖掉。
    private static final List<Rule> RULES = List.of(
            new Rule(
                    new String[]{"outofmemoryerror", "java heap space", "insufficient memory", "gc overhead limit exceeded"},
                    "内存不够",
                    "游戏在申请内存时耗尽了 JVM 堆。整合包越大越容易碰到，和电脑总内存关系不大，取决于给游戏分配了多少。",
                    new String[]{
                            "到「实例 → 设置 → 最大内存」把分配值调大（建议 4096 MB 以上，大型整合包 6144–8192 MB）",
                            "同时关掉其它吃内存的程序；32 位 Java 最多只能用 1–1.5 GB，确认用的是 64 位",
                            "分配超过物理内存反而会频繁换页，别超过机器可用内存的 60%"
                    }),
            new Rule(
                    new String[]{"unsupportedclassversionerror", "unsupported class file major version", "has been compiled by a more recent version"},
                    "Java 版本太低",
                    "某个模组或游戏本体是用更高版本的 Java 编译的，当前 Java 跑不了它的字节码。",
                    new String[]{
                            "1.17+ 需要 Java 17 及以上，1.20.5+ 推荐 Java 21，1.21+ 部分模组要求 Java 21",
                            "到「设置 → Java」换一个更高版本，再回到实例设置里指定它",
                            "崩溃报告里的 `class file version 65` 对应 Java 21、`61` 对应 Java 17"
                    }),
            new Rule(
                    new String[]{"missing or unsupported mandatory dependencies", "requires any version of", "requires version",
                            "which is missing", "hard_dep_no_candidate", "hard_dep", "missing dependencies", "mod requires"},
                    "缺少前置模组 / 前置版本不符",
                    "有模组声明了必须存在的前置，但 mods 目录里没有（或版本区间不满足）。",
                    new String[]{
                            "打开「实例 → 模组」页顶部的依赖检查，会列出缺哪个、被谁需要，可以直接一键安装",
                            "装上前置后重启游戏；注意前置本身也可能还有前置",
                            "别只看模组名：Fabric API、Architectury、Cloth Config 这些也是模组，删了照样崩"
                    }),
            new Rule(
                    new String[]{"incompatible mod set", "mod resolution encountered an error", "modresolutionexception", "incompatible mods found"},
                    "模组之间互相不兼容",
                    "加载器在解析依赖关系时发现无法同时满足的版本要求（常见于两个模组都要某个前置的不同版本）。",
                    new String[]{
                            "崩溃信息里会点名两个模组和它们各自要求的版本区间，按那个区间取舍",
                            "把相关模组一起更新到同一时期发布的版本，跨版本混装最容易出这种事",
                            "到「实例 → 模组」页做一次依赖检查，缺的会直接列出来"
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
                    new String[]{"optifine", "optifabric"},
                    new String[]{"sodium", "iris", "embeddium", "oculus", "rubidium"},
                    "OptiFine 和优化模组打架",
                    "OptiFine 会改写大量渲染代码，和 Sodium / Iris 这类优化模组互斥。",
                    new String[]{
                            "二选一：要么留 OptiFine，要么删掉它换 Sodium + Iris（后者性能更好，也是现在的主流）",
                            "OptiFine 的替代品：Sodium（渲染）、Iris（光影）、Indium（FRAPI 兼容）、CIT Resewn（自定义材质）",
                            "别试图用 OptiFabric 缝合，1.20 之后基本不可用"
                    }),
            new Rule(
                    new String[]{"mixin apply failed", "mixinapplyerror", "mixin transformation of", "mixintransformererror", "mixin apply for mod"},
                    "Mixin 注入失败",
                    "某个模组想改写游戏代码但注入点对不上，通常是模组版本和游戏/加载器版本不匹配。",
                    new String[]{
                            "确认这个模组支持当前的游戏版本与加载器版本",
                            "把报错里提到的模组单独停用，逐个排查",
                            "同类功能的两个模组（如两个优化模组）同时改一处代码也会这样"
                    }),
            new Rule(
                    new String[]{"does not implement interface vertexbufferwriter", "vertexbufferwriter", "does not implement interface"},
                    "渲染接口不兼容（Sodium 系）",
                    "某个模组自己实现了顶点缓冲，但没有实现 Sodium / Embeddium 要求的接口，游戏渲染到它时直接抛异常。",
                    new String[]{
                            "崩溃堆栈里第一个非游戏本体的模组就是不兼容的一方（常见于有自定义渲染的科技/装饰模组）",
                            "把它更新到支持当前 Sodium 版本的版本；没有新版就暂时禁用",
                            "Sodium 0.6 起收紧了第三方渲染接口，配套模组版本太老就会踩到"
                    }),
            new Rule(
                    new String[]{"description: rendering", "rendering overlay", "rendering particle", "rendering block entity", "rendering entity"},
                    "渲染阶段崩溃",
                    "游戏在画某个东西的时候崩了。堆栈里第一个不属于游戏本体的模组就是嫌疑对象。",
                    new String[]{
                            "看「可疑模组」里排第一的那个，先禁用它验证",
                            "如果只在特定方块/实体附近崩，多半是那个模组的渲染代码有问题",
                            "更新显卡驱动也可能有用（少数是驱动 bug 被模组触发）"
                    }),
            new Rule(
                    new String[]{"unrecognized vm option", "could not create the java virtual machine", "error: could not create the java vm"},
                    "JVM 参数不被接受",
                    "启动参数里有当前 Java 不认识的选项（常见于抄了别人高版本的参数）。",
                    new String[]{
                            "到「实例 → 设置 → JVM 参数」清空自定义参数再试",
                            "`-XX:+UseZGC`、`-XX:+UseShenandoahGC` 这类参数要看 Java 版本和发行版",
                            "内存参数写成 `-Xmx4G` 就够了，别同时写 `-Xms` 大于 `-Xmx`"
                    }),
            new Rule(
                    new String[]{"exception_access_violation", "a fatal error has been detected", "sigsegv", "0xc0000005", "exit code -1073741819"},
                    "JVM 层面的原生崩溃（不是普通异常）",
                    "Java 虚拟机自己在 native 代码里挂了，通常是显卡驱动、模组里的本地库、或者内存/硬件问题。这类崩溃不会给出 Java 堆栈。",
                    new String[]{
                            "先更新显卡驱动；NVIDIA 用户在控制面板里把 javaw.exe 指定为「高性能显卡」",
                            "崩溃日志里如果有 `Problematic frame`，那一行就是出问题的本地库（常见是 lwjgl、OpenAL、显卡驱动）",
                            "关掉超频/内存 XMP 再试；少数情况是内存条不稳",
                            "如果只在装某个模组后出现，先禁用那个模组"
                    }),
            new Rule(
                    new String[]{"glfw error", "pixel format not accelerated", "failed to create window", "opengl", "wgpu"},
                    "显卡/驱动问题",
                    "创建 OpenGL 上下文失败。笔记本双显卡、远程桌面、老驱动都可能触发。",
                    new String[]{
                            "更新显卡驱动；NVIDIA 用户在控制面板里把 javaw.exe 指定为「高性能显卡」",
                            "远程桌面/虚拟机里通常无法开 3D，改用本机运行",
                            "实在不行在实例设置里加 JVM 参数 `-Dorg.lwjgl.opengl.Display.allowSoftwareOpenGL=true`（很卡，仅应急）"
                    }),
            new Rule(
                    new String[]{"accessdeniedexception", "permission denied", "being used by another process"},
                    "文件被占用或无权限",
                    "游戏要写的文件正被别的程序占着，或当前用户没有写权限。",
                    new String[]{
                            "确认没有第二个启动器/游戏实例在跑",
                            "杀毒软件可能锁住了 jar，把游戏目录加入白名单",
                            "把启动器装在用户目录下，避免 Program Files 的权限问题"
                    }),
            new Rule(
                    new String[]{"formatterexception", "json parse", "com.google.gson", "malformed", "failed to parse"},
                    "配置文件/资源包格式错误",
                    "某个 JSON 读取失败，常见于手动改过配置、或资源包/模组包里的 json 损坏。",
                    new String[]{
                            "崩溃信息里通常会给出具体文件路径，打开检查那一行的括号与逗号",
                            "改过配置的话，删掉配置文件让游戏重新生成"
                    }),
            new Rule(
                    new String[]{"corrupted chunk", "region file", "failed to read level", "level.dat"},
                    "存档数据损坏",
                    "世界存档里有区块读不出来，多半是异常退出、磁盘写满、或模组改坏了数据。",
                    new String[]{
                            "先备份整个 saves 目录再动手",
                            "用启动器自带的存档备份恢复上一个时间点",
                            "只在这个存档崩的话，基本可以确定是存档问题而不是模组"
                    }),
            new Rule(
                    new String[]{"address already in use", "failed to bind to port"},
                    "端口被占用",
                    "游戏要监听的端口被别的程序占了（多见于开服/联机）。",
                    new String[]{
                            "关掉占用端口的程序，或在设置里换一个端口",
                            "`netstat -ano | findstr 25565` 能看到是谁占着"
                    }),
            new Rule(
                    new String[]{"java.lang.nosuchmethoderror", "java.lang.noclassdeffounderror", "java.lang.classnotfoundexception", "java.lang.nosuchfielderror"},
                    "类或方法找不到（多为版本不匹配）",
                    "代码在运行时要找一个类/方法，但当前加载的 jar 里没有。整合包里最常见的原因是某个模组的前置版本对不上。",
                    new String[]{
                            "看堆栈里第一条 `at` 后面的包名，基本就是出问题的模组",
                            "把该模组和它的前置一起更新到同一批发布的版本",
                            "少数情况是整合包自带的库被手动删过，用「检查游戏完整性」补回来"
                    }),
            new Rule(
                    new String[]{"exceptionininitializererror"},
                    "模组初始化时崩了",
                    "某个类的静态初始化块抛了异常。堆栈里 `Caused by` 后面那一层才是真正的原因（常见是缺前置、配置写坏、或者模组自己的 bug）。",
                    new String[]{
                            "往下翻到最后一个 `Caused by`，那里才是根因",
                            "按堆栈里的包名找到对应模组，先禁用它",
                            "删掉 config 目录里这个模组的配置文件，让游戏重新生成一份"
                    }),
            new Rule(
                    new String[]{"the game crashed whilst", "exception ticking world", "ticking entity", "ticking block entity", "exception in server tick loop"},
                    "游戏内逻辑崩溃",
                    "某个实体/方块实体在每 tick 更新时抛了异常，通常是某个模组对特定方块或生物处理不当。",
                    new String[]{
                            "看崩溃描述里提到的维度与坐标，回档或避开那块区域",
                            "用二分法停用可疑模组确认",
                            "如果只在特定存档出现，多半是存档里的数据被模组改坏了"
                    })
    );

    // ==================== 入口 ====================

    /// 分析最近一次崩溃。没有崩溃现场时返回 `found=false`。
    static String analyze(String instanceId) {
        JsonObject root = new JsonObject();
        try {
            HMCLGameInstance instance = instanceOf(instanceId);
            if (instance == null) {
                root.addProperty("ok", false);
                root.addProperty("error", "找不到这个实例");
                return JsonUtils.GSON.toJson(root);
            }

            Source source = findSource(instance);
            if (source == null) {
                root.addProperty("ok", true);
                root.addProperty("found", false);
                JsonObject q = quarantineJson(instance);
                if (q != null) {
                    root.add("quarantine", q);
                }
                return JsonUtils.GSON.toJson(root);
            }

            String text = source.text();
            String lower = text.toLowerCase(Locale.ROOT);

            root.addProperty("ok", true);
            root.addProperty("found", true);
            root.addProperty("source", source.report() ? "report" : "log");
            root.addProperty("file", source.path().getFileName().toString());
            root.addProperty("path", source.path().toString());
            root.addProperty("time", source.time());
            try {
                root.addProperty("size", Files.size(source.path()));
            } catch (Throwable ignored) {
                root.addProperty("size", 0);
            }

            String description = firstMatch(text, "(?m)^Description:\\s*(.+)$");
            String exception = firstMatch(text, "(?m)^\\s*(?:Caused by:\\s*)?([a-zA-Z_$][\\w.$]*(?:Exception|Error))(?::\\s*(.*))?$");
            root.addProperty("description", description == null ? "" : description.trim());
            root.addProperty("exception", exception == null ? "" : exception.trim());

            Rule hit = firstRule(lower);
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
                root.addProperty("detail", "崩溃现场里没有出现我们认识的模式。下面按证据列出了最可疑的模组，可以据此排查。");
                JsonArray hints = new JsonArray();
                hints.add("把这份报告里的 `Description` 和第一条异常发到模组作者的问题区，通常很快能定位");
                hints.add("先停用最近新装的模组试一次，这是最快的二分法");
                root.add("hints", hints);
            }

            // 模组索引：堆栈包名、jar 文件名、mod id 都要对到这里
            ModIndex index = indexOf(instance.getModsDirectory());
            List<Evidence> evidences = collectEvidence(index, text, source.time());
            List<Evidence> ranked = new ArrayList<>(evidences);
            ranked.sort((a, b) -> b.score != a.score ? b.score - a.score : b.hits - a.hits);

            JsonArray suspects = new JsonArray();
            int limit = 0;
            for (Evidence e : ranked) {
                if (limit++ >= 8) {
                    break;
                }
                suspects.add(evidenceJson(instance, e, index));
            }
            root.add("suspects", suspects);

            // 一条线索都没有：把崩溃前 24 小时内动过的模组列出来，这是最快的二分法起点
            JsonArray recent = new JsonArray();
            if (ranked.isEmpty()) {
                for (ModFile m : recentMods(index, source.time())) {
                    Evidence e = new Evidence(m);
                    e.score = 1;
                    e.reasons.add("崩溃前 " + humanAge(source.time() - m.modified) + "刚装进来");
                    recent.add(evidenceJson(instance, e, index));
                }
            }
            root.add("recent", recent);

            root.addProperty("totalMods", index.all.size());
            JsonArray enabledFiles = new JsonArray();
            for (ModFile m : index.all) {
                if (!m.disabled) {
                    enabledFiles.add(m.file);
                }
            }
            root.add("enabledFiles", enabledFiles);

            JsonObject quarantine = quarantineJson(instance);
            if (quarantine != null) {
                root.add("quarantine", quarantine);
            }

            root.addProperty("excerpt", source.report() ? excerptFromStart(text, 80) : excerptFromEnd(text, 120));
            return JsonUtils.GSON.toJson(root);
        } catch (Throwable e) {
            LOG.warning("Failed to analyze crash report of " + instanceId, e);
            root.addProperty("ok", false);
            root.addProperty("error", String.valueOf(e));
            return JsonUtils.GSON.toJson(root);
        }
    }

    /// 一键禁用：把选中的 jar 改成 `.disabled`，并记进恢复快照。
    ///
    /// <p>`filesJson` 传 `"*"` 表示禁用 mods 目录下全部 `.jar`。
    static String disableMods(String instanceId, String filesJson) {
        JsonObject root = new JsonObject();
        try {
            HMCLGameInstance instance = instanceOf(instanceId);
            if (instance == null) {
                root.addProperty("ok", false);
                root.addProperty("error", "找不到这个实例");
                return JsonUtils.GSON.toJson(root);
            }
            Path dir = instance.getModsDirectory();
            if (dir == null || !Files.isDirectory(dir)) {
                root.addProperty("ok", false);
                root.addProperty("error", "mods 目录不存在");
                return JsonUtils.GSON.toJson(root);
            }

            List<String> wanted = new ArrayList<>();
            if ("*".equals(filesJson == null ? "" : filesJson.trim())) {
                try (DirectoryStream<Path> stream = Files.newDirectoryStream(dir, "*.jar")) {
                    for (Path p : stream) {
                        wanted.add(p.getFileName().toString());
                    }
                }
            } else {
                wanted.addAll(parseFileList(filesJson));
            }

            JsonArray done = new JsonArray();
            JsonArray skipped = new JsonArray();
            List<String> record = new ArrayList<>();
            for (String raw : wanted) {
                String leaf;
                try {
                    leaf = Path.of(raw).getFileName().toString();
                } catch (Throwable e) {
                    // 文件名非法（Windows 保留字、控制字符）：跳过这一个，不影响整批
                    skipped.add(raw);
                    continue;
                }
                Path current = dir.resolve(leaf);
                if (!Files.isRegularFile(current)) {
                    skipped.add(leaf);
                    continue;
                }
                try {
                    Files.move(current, dir.resolve(leaf + ".disabled"), StandardCopyOption.REPLACE_EXISTING);
                    done.add(leaf);
                    record.add(leaf);
                } catch (Throwable e) {
                    LOG.warning("Failed to disable mod " + leaf, e);
                    skipped.add(leaf);
                }
            }
            appendQuarantine(instance, record);

            root.addProperty("ok", true);
            root.addProperty("disabled", done.size());
            root.add("files", done);
            root.add("skipped", skipped);
            root.add("quarantine", quarantineJson(instance));
            return JsonUtils.GSON.toJson(root);
        } catch (Throwable e) {
            LOG.warning("Failed to disable mods of " + instanceId, e);
            root.addProperty("ok", false);
            root.addProperty("error", String.valueOf(e));
            return JsonUtils.GSON.toJson(root);
        }
    }

    /// 把上一次「一键禁用」的记录原样恢复。
    static String restoreMods(String instanceId) {
        JsonObject root = new JsonObject();
        try {
            HMCLGameInstance instance = instanceOf(instanceId);
            if (instance == null) {
                root.addProperty("ok", false);
                root.addProperty("error", "找不到这个实例");
                return JsonUtils.GSON.toJson(root);
            }
            Path dir = instance.getModsDirectory();
            JsonObject snapshot = readQuarantine(instance);
            if (dir == null || snapshot == null) {
                root.addProperty("ok", true);
                root.addProperty("restored", 0);
                root.addProperty("missing", 0);
                return JsonUtils.GSON.toJson(root);
            }

            JsonArray restored = new JsonArray();
            JsonArray missing = new JsonArray();
            JsonElement files = snapshot.get("files");
            if (files != null && files.isJsonArray()) {
                for (JsonElement el : files.getAsJsonArray()) {
                    String leaf = el.getAsString();
                    Path disabled = dir.resolve(leaf + ".disabled");
                    if (!Files.isRegularFile(disabled)) {
                        missing.add(leaf);
                        continue;
                    }
                    try {
                        Files.move(disabled, dir.resolve(leaf), StandardCopyOption.REPLACE_EXISTING);
                        restored.add(leaf);
                    } catch (Throwable e) {
                        LOG.warning("Failed to restore mod " + leaf, e);
                        missing.add(leaf);
                    }
                }
            }
            // 全部恢复成功才清空快照；有恢复不了的，把剩下的留着下次再试，
            // 否则用户点一次「恢复」失败后就再也找不回那批文件了
            if (missing.isEmpty()) {
                Files.deleteIfExists(quarantinePath(instance));
            } else {
                JsonObject left = new JsonObject();
                left.addProperty("time", Instant.now().toEpochMilli());
                JsonArray arr = new JsonArray();
                for (JsonElement el : missing) {
                    arr.add(el.getAsString());
                }
                left.add("files", arr);
                Files.writeString(quarantinePath(instance), JsonUtils.GSON.toJson(left), StandardCharsets.UTF_8);
            }

            root.addProperty("ok", true);
            root.addProperty("restored", restored.size());
            root.addProperty("missing", missing.size());
            return JsonUtils.GSON.toJson(root);
        } catch (Throwable e) {
            LOG.warning("Failed to restore mods of " + instanceId, e);
            root.addProperty("ok", false);
            root.addProperty("error", String.valueOf(e));
            return JsonUtils.GSON.toJson(root);
        }
    }

    // ==================== 崩溃现场 ====================

    /// 一份可分析的现场：路径、正文、时间、是不是完整崩溃报告。
    private record Source(Path path, String text, long time, boolean report) {
    }

    private static Source findSource(HMCLGameInstance instance) {
        Path report = latestCrashReport(instance.getRunDirectory());
        if (report == null) {
            report = latestCrashReport(instance.getInstanceRoot());
        }
        String reportText = report == null ? "" : readText(report);
        long reportTime = report == null ? 0 : lastModified(report);

        // 崩溃报告比最新日志还旧，且那之后的日志没有崩溃痕迹：
        // 说明用户已经正常启动过了，旧报告不该继续弹「上次崩溃」。
        Path log = instance.getRunDirectory().resolve("logs").resolve("latest.log");
        if (!Files.isRegularFile(log)) {
            log = instance.getInstanceRoot().resolve("logs").resolve("latest.log");
        }
        String logText = null;
        long logTime = 0;
        if (Files.isRegularFile(log)) {
            logText = readTail(log, MAX_LOG_BYTES);
            logTime = lastModified(log);
        }
        boolean logAlive = logText != null && looksCrashed(logText);

        if (report != null && !reportText.isBlank()) {
            boolean stale = logTime > reportTime + 60_000L && !logAlive;
            if (!stale) {
                return new Source(report, reportText, reportTime, true);
            }
        }

        // 加载期崩溃（缺前置、Java 版本不对）不会生成 crash-report，只有日志
        if (logTime > 0 && logAlive) {
            return new Source(log, logText, logTime, false);
        }
        return null;
    }

    /// 日志里出现这些标记才算「这次崩了」。普通模组警告每天都有，
    /// 只看 `Exception` 会让每次正常退出都弹崩溃提示。
    private static boolean looksCrashed(String log) {
        String lower = log.toLowerCase(Locale.ROOT);
        return lower.contains("---- minecraft crash report ----")
                || lower.contains("a fatal error has been detected")
                || lower.contains("exception in thread \"main\"")
                || lower.contains("failed to start the game")
                || lower.contains("couldn't start game")
                || lower.contains("the game crashed whilst")
                || lower.contains("failed to launch")
                || lower.contains("unsupportedclassversionerror")
                || lower.contains("outofmemoryerror")
                // Fabric 加载期的依赖解析失败：只写日志，不生成 crash-report
                || lower.contains("mod resolution failed")
                || lower.contains("incompatible mods found")
                || lower.contains("mod resolution encountered an error")
                || lower.contains("formattedexception")
                || lower.contains("modresolutionexception");
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
                long t = lastModified(p);
                if (t > bestTime) {
                    bestTime = t;
                    best = p;
                }
            }
        } catch (Throwable e) {
            return null;
        }
        return best;
    }

    private static long lastModified(Path p) {
        try {
            return Files.getLastModifiedTime(p).toMillis();
        } catch (Throwable e) {
            return Instant.now().toEpochMilli();
        }
    }

    private static String readText(Path p) {
        try {
            byte[] bytes = Files.readAllBytes(p);
            // 崩溃报告最大见过 20MB+，只留前 2MB 就够判定
            int len = Math.min(bytes.length, 2 * 1024 * 1024);
            return decode(bytes, len);
        } catch (Throwable e) {
            return "";
        }
    }

    /// 中文 Windows 上游戏日志是按系统 ANSI（GBK）写的，用 UTF-8 读会得到
    /// 一屏乱码——崩溃报告本身是 UTF-8。先严格按 UTF-8 解，解不开再退 GBK。
    private static String decode(byte[] bytes, int len) {
        try {
            return StandardCharsets.UTF_8.newDecoder()
                    .onMalformedInput(java.nio.charset.CodingErrorAction.REPORT)
                    .onUnmappableCharacter(java.nio.charset.CodingErrorAction.REPORT)
                    .decode(java.nio.ByteBuffer.wrap(bytes, 0, len))
                    .toString();
        } catch (Throwable e) {
            try {
                return new String(bytes, 0, len, java.nio.charset.Charset.forName("GBK"));
            } catch (Throwable e2) {
                return new String(bytes, 0, len, StandardCharsets.UTF_8);
            }
        }
    }

    /// 从文件尾部读最多 `maxBytes`，并丢掉被截断的第一行。
    private static String readTail(Path p, int maxBytes) {
        try (var channel = java.nio.channels.FileChannel.open(p, java.nio.file.StandardOpenOption.READ)) {
            long size = channel.size();
            int len = (int) Math.min(size, maxBytes);
            var buf = java.nio.ByteBuffer.allocate(len);
            channel.position(size - len);
            while (buf.hasRemaining() && channel.read(buf) > 0) {
                // 继续读
            }
            buf.flip();
            String text = decode(buf.array(), len);
            int nl = text.indexOf('\n');
            return nl >= 0 ? text.substring(nl + 1) : text;
        } catch (Throwable e) {
            return "";
        }
    }

    private static String excerptFromStart(String text, int lines) {
        String[] all = text.split("\\R");
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < Math.min(lines, all.length); i++) {
            sb.append(all[i]).append('\n');
        }
        return sb.toString();
    }

    private static String excerptFromEnd(String text, int lines) {
        String[] all = text.split("\\R");
        int start = Math.max(0, all.length - lines);
        StringBuilder sb = new StringBuilder();
        for (int i = start; i < all.length; i++) {
            sb.append(all[i]).append('\n');
        }
        return sb.toString();
    }

    // ==================== 规则匹配 ====================

    private static Rule firstRule(String lower) {
        for (Rule rule : RULES) {
            if (!anyContains(lower, rule.keywords())) {
                continue;
            }
            if (rule.alsoAny() != null && !anyContains(lower, rule.alsoAny())) {
                continue;
            }
            return rule;
        }
        return null;
    }

    private static boolean anyContains(String haystack, String[] needles) {
        for (String n : needles) {
            if (haystack.contains(n)) {
                return true;
            }
        }
        return false;
    }

    /// 取第一个匹配的捕获组（没有捕获组就返回整段）。
    private static String firstMatch(String text, String regex) {
        try {
            Matcher m = Pattern.compile(regex).matcher(text);
            if (m.find()) {
                if (m.groupCount() >= 2 && m.group(2) != null && !m.group(2).isBlank()) {
                    return m.group(1) + ": " + m.group(2).trim();
                }
                return m.groupCount() >= 1 ? m.group(1) : m.group();
            }
        } catch (Throwable ignored) {
        }
        return null;
    }

    // ==================== 模组索引 ====================

    /// 一个 jar 的索引信息。`packages` 用来把堆栈里的包名对回具体模组。
    private static final class ModFile {
        final String file;
        final String id;
        final String name;
        final String version;
        final boolean disabled;
        final Set<String> packages;
        final long modified;

        ModFile(String file, String id, String name, String version, boolean disabled,
                Set<String> packages, long modified) {
            this.file = file;
            this.id = id == null ? "" : id;
            this.name = name == null ? "" : name;
            this.version = version == null ? "" : version;
            this.disabled = disabled;
            this.packages = packages;
            this.modified = modified;
        }

        String display() {
            if (!name.isBlank()) {
                return name;
            }
            return !id.isBlank() ? id : file;
        }
    }

    private static final class ModIndex {
        final List<ModFile> all = new ArrayList<>();
        final Map<String, ModFile> byId = new HashMap<>();
        final Map<String, ModFile> byFile = new HashMap<>();
        final Map<String, ModFile> byPrefix = new HashMap<>();

        void add(ModFile m) {
            all.add(m);
            if (!m.id.isBlank()) {
                byId.putIfAbsent(m.id.toLowerCase(Locale.ROOT), m);
            }
            byFile.put(m.file.toLowerCase(Locale.ROOT), m);
            for (String p : m.packages) {
                byPrefix.putIfAbsent(p, m);
            }
        }

        ModFile file(String name) {
            if (name == null) {
                return null;
            }
            ModFile exact = byFile.get(name.toLowerCase(Locale.ROOT));
            if (exact != null) {
                return exact;
            }
            String norm = normalize(name);
            for (ModFile m : all) {
                if (normalize(m.file).equals(norm)) {
                    return m;
                }
            }
            return null;
        }

        /// 用 mod id / 名字 / 文件名对上一个 token。
        ModFile token(String token) {
            if (token == null || token.isBlank()) {
                return null;
            }
            String lower = token.toLowerCase(Locale.ROOT);
            ModFile byIdHit = byId.get(lower);
            if (byIdHit != null) {
                return byIdHit;
            }
            String norm = normalize(token);
            if (norm.length() < 3) {
                return null;
            }
            for (ModFile m : all) {
                String fileNorm = normalize(m.file);
                // 只允许「文件名里含有 token」，不能反过来：
                // token "jar" 会命中任何 xxx.jar，曾经因此把全部证据算到一个模组头上
                if (fileNorm.equals(norm) || (norm.length() >= 4 && fileNorm.contains(norm))) {
                    return m;
                }
                if (!m.id.isBlank() && normalize(m.id).equals(norm)) {
                    return m;
                }
                if (!m.name.isBlank() && normalize(m.name).equals(norm)) {
                    return m;
                }
            }
            return null;
        }

        /// 包名按「顶级 4 段 → 3 段 → 2 段」逐级回退，取最长命中。
        ModFile pkg(String pkg) {
            if (pkg == null) {
                return null;
            }
            String[] parts = pkg.split("\\.");
            for (int n = Math.min(parts.length, 4); n >= 2; n--) {
                String key = String.join(".", Arrays.copyOfRange(parts, 0, n));
                ModFile m = byPrefix.get(key);
                if (m != null) {
                    return m;
                }
            }
            return null;
        }
    }

    private static String cachedDir;
    private static long cachedStamp;
    private static int cachedCount;
    private static ModIndex cachedIndex;

    /// 扫 mods 目录建索引。读每个 jar 的中央目录拿包名，有缓存：
    /// 目录 mtime 或文件数变了才重扫。
    private static synchronized ModIndex indexOf(Path modsDir) {
        if (modsDir == null || !Files.isDirectory(modsDir)) {
            return new ModIndex();
        }
        List<Path> jars = new ArrayList<>();
        long stamp = lastModified(modsDir);
        try (DirectoryStream<Path> stream = Files.newDirectoryStream(modsDir)) {
            for (Path p : stream) {
                String name = p.getFileName().toString();
                if (Files.isRegularFile(p) && (name.endsWith(".jar") || name.endsWith(".jar.disabled"))) {
                    jars.add(p);
                }
            }
        } catch (Throwable e) {
            return new ModIndex();
        }
        if (cachedIndex != null && modsDir.toString().equals(cachedDir)
                && stamp == cachedStamp && jars.size() == cachedCount) {
            return cachedIndex;
        }

        ModIndex index = new ModIndex();
        for (Path jar : jars) {
            String file = jar.getFileName().toString();
            boolean disabled = file.endsWith(".disabled");
            String plain = disabled ? file.substring(0, file.length() - ".disabled".length()) : file;
            ModScanService.ModMeta meta = ModScanService.readMeta(jar);
            Set<String> packages = readPackages(jar);
            index.add(new ModFile(
                    plain,
                    meta == null ? "" : meta.id(),
                    meta == null ? "" : meta.name(),
                    meta == null ? "" : meta.version(),
                    disabled,
                    packages,
                    lastModified(jar)));
        }
        cachedDir = modsDir.toString();
        cachedStamp = stamp;
        cachedCount = jars.size();
        cachedIndex = index;
        return index;
    }

    /// 读 jar 里的包名前缀，用来把堆栈行对回模组。
    ///
    /// <p>前缀取「最多 4 段」：`net.caffeinemc.mods.sodium` 和
    /// `net.caffeinemc.mods.lithium` 是同作者的两个模组，只取 3 段会撞在一起。
    /// 按 class 数量排序后只留前 200 个，避免把 shaded 进来的第三方库
    /// 当成这个模组自己的包。
    private static Set<String> readPackages(Path jar) {
        Map<String, Integer> counts = new HashMap<>();
        try (ZipFile zip = new ZipFile(jar.toFile())) {
            Enumeration<? extends ZipEntry> entries = zip.entries();
            int seen = 0;
            while (entries.hasMoreElements() && seen < 20000) {
                String name = entries.nextElement().getName();
                seen++;
                if (!name.endsWith(".class") || name.startsWith("META-INF/")) {
                    continue;
                }
                int slash = name.lastIndexOf('/');
                if (slash <= 0) {
                    continue;
                }
                String[] parts = name.substring(0, slash).replace('/', '.').split("\\.");
                if (parts.length < 2) {
                    continue;
                }
                int depth = Math.min(4, parts.length);
                StringBuilder sb = new StringBuilder(parts[0]);
                for (int i = 1; i < depth; i++) {
                    sb.append('.').append(parts[i]);
                }
                counts.merge(sb.toString(), 1, Integer::sum);
            }
        } catch (Throwable ignored) {
            // 读不出来的 jar 不影响别的模组判定
        }
        List<Map.Entry<String, Integer>> sorted = new ArrayList<>(counts.entrySet());
        sorted.sort((a, b) -> b.getValue() - a.getValue());
        Set<String> set = new HashSet<>();
        for (int i = 0; i < Math.min(sorted.size(), 200); i++) {
            set.add(sorted.get(i).getKey());
        }
        return set;
    }

    private static String normalize(String s) {
        if (s == null) {
            return "";
        }
        StringBuilder sb = new StringBuilder(s.length());
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (c >= 'A' && c <= 'Z') {
                c += 32;
            }
            if ((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9')) {
                sb.append(c);
            }
        }
        return sb.toString();
    }

    // ==================== 证据收集 ====================

    private static final class Evidence {
        final ModFile mod;
        int score;
        int hits;
        /// 这个模组缺哪个前置（能解出来时非空）
        String missingDep = "";
        final List<String> reasons = new ArrayList<>();
        /// 已经记过分的证据类别，避免重复累加
        final Set<String> tags = new HashSet<>();

        Evidence(ModFile mod) {
            this.mod = mod;
        }

        void add(int score, String reason) {
            this.score += score;
            if (reason != null && !reasons.contains(reason)) {
                reasons.add(reason);
            }
        }

        /// 同一类证据只算一次分。
        ///
        /// 堆栈里一个模组可能出现几十次（每帧一次 jar 引用），累加的话
        /// 分数会飞到几百，置信度就失去意义了。
        void addOnce(String tag, int score, String reason) {
            if (tags.add(tag)) {
                add(score, reason);
            }
        }
    }

    private static List<Evidence> collectEvidence(ModIndex index, String text, long crashTime) {
        Map<String, Evidence> map = new LinkedHashMap<>();

        // 1) 崩溃报告自己点名的 Suspected Mods —— 最强证据
        for (String token : parseSuspected(text)) {
            ModFile m = index.token(token);
            // 允许已禁用的模组：崩溃发生在它还被启用的时候，重算后要能显示「已禁用」
            if (m != null) {
                evidence(map, m).addOnce("suspected", 9, "崩溃报告把它列为可疑模组");
            }
        }

        // 2) Mixin 失败信息里带的 mod id
        for (String token : parseMixinMods(text)) {
            ModFile m = index.token(token);
            // 允许已禁用的模组：崩溃发生在它还被启用的时候，重算后要能显示「已禁用」
            if (m != null) {
                evidence(map, m).addOnce("mixin", 6, "Mixin 注入失败指向它");
            }
        }

        // 3) 堆栈行里直接引用的 jar 文件名（~[sodium.jar:?]）
        for (String jar : parseMentionedJars(text)) {
            ModFile m = index.file(jar);
            if (m == null) {
                // 报告里的文件名可能是另一个加载器的版本（sodium-neoforge-…），
                // 用文件名里的 mod id 段再试一次。先去掉 .jar 后缀，
                // 否则 "jar" 会被当成一个段，命中任何文件。
                String base = jar.endsWith(".jar") ? jar.substring(0, jar.length() - 4) : jar;
                for (String seg : base.split("[-+_.]")) {
                    if (seg.length() >= 4) {
                        m = index.token(seg);
                        if (m != null) {
                            break;
                        }
                    }
                }
            }
            // 允许已禁用的模组：崩溃发生在它还被启用的时候，重算后要能显示「已禁用」
            if (m != null) {
                evidence(map, m).addOnce("jar", 5, "堆栈里直接引用了这个 jar");
            }
        }

        // 3.5) NeoForge 的堆栈会直接标出帧来自哪个模组：
        //      at TRANSFORMER/sodium@0.6.0/net.caffeinemc.mods.sodium...
        for (Map.Entry<String, Integer> e : transformerMods(text).entrySet()) {
            ModFile m = index.token(e.getKey());
            if (m != null) {
                int n = e.getValue();
                evidence(map, m).addOnce("transformer", 6, "堆栈里有 " + n + " 帧标注来自这个模组");
            }
        }

        // 4) 堆栈包名。同一个模组的多个包先合并，再按总次数给一次分。
        //    游戏本体和常见库已经在 stackPackages 里排除。
        Map<ModFile, Integer> pkgHits = new LinkedHashMap<>();
        Map<ModFile, String> pkgSample = new HashMap<>();
        for (Map.Entry<String, Integer> e : stackPackages(text).entrySet()) {
            ModFile m = index.pkg(e.getKey());
            if (m == null) {
                continue;
            }
            pkgHits.merge(m, e.getValue(), Integer::sum);
            pkgSample.putIfAbsent(m, e.getKey());
        }
        for (Map.Entry<ModFile, Integer> e : pkgHits.entrySet()) {
            int n = e.getValue();
            Evidence ev = evidence(map, e.getKey());
            ev.hits += n;
            ev.addOnce("stack", n >= 8 ? 4 : n >= 3 ? 3 : 2,
                    "堆栈里出现 " + n + " 次（" + pkgSample.get(e.getKey()) + "）");
        }

        // 5) 依赖报错点名的缺失前置：责任在「需要它的那个模组」身上
        for (Map.Entry<String, String> e : missingDepsByMod(text).entrySet()) {
            ModFile m = index.token(e.getKey());
            // 允许已禁用的模组：崩溃发生在它还被启用的时候，重算后要能显示「已禁用」
            if (m != null) {
                Evidence ev = evidence(map, m);
                ev.missingDep = e.getValue();
                ev.addOnce("missing", 7, "它需要的前置「" + e.getValue() + "」没装或版本不符");
            }
        }

        List<Evidence> list = new ArrayList<>(map.values());
        for (Evidence e : list) {
            if (e.score == 0) {
                e.score = 1;
            }
            // 报告时间之后才装进来的模组不可能参与这次崩溃
            if (e.mod.modified > crashTime + 5 * 60 * 1000L) {
                e.score = Math.max(1, e.score - 6);
                e.reasons.add("注意：它在崩溃之后才被改动过");
            }
        }
        return list;
    }

    private static Evidence evidence(Map<String, Evidence> map, ModFile m) {
        return map.computeIfAbsent(m.file, k -> new Evidence(m));
    }

    /// `Suspected Mods: xxx, yyy` / `Suspected Mod: xxx`
    private static List<String> parseSuspected(String text) {
        List<String> out = new ArrayList<>();
        Matcher m = Pattern.compile("(?im)^\\s*Suspected Mods?:\\s*(.+)$").matcher(text);
        while (m.find()) {
            String value = m.group(1).trim();
            if (value.isEmpty() || value.equalsIgnoreCase("NONE") || value.equalsIgnoreCase("none")) {
                continue;
            }
            for (String part : value.split("[,;]")) {
                String token = part.trim().replaceAll("\\(.*?\\)", "").trim();
                if (!token.isEmpty()) {
                    out.add(token);
                }
            }
        }
        return out;
    }

    /// `Mixin apply for mod <id> failed` / `Mixin apply failed ... from mod <id>`
    ///
    /// <p>不能写成「一行里出现 from mod 就算」：NeoForge 的堆栈每行都带
    /// `pl:mixin:APP:xxx.mixins.json:... from mod sodium`，那是「已应用的 mixin」，
    /// 不是失败原因，按它算分会让半个整合包都变成嫌疑对象。
    private static List<String> parseMixinMods(String text) {
        List<String> out = new ArrayList<>();
        Matcher m = Pattern.compile("(?i)mixin apply (?:for )?mod ([\\w.-]+)").matcher(text);
        while (m.find()) {
            out.add(m.group(1));
        }
        Matcher m2 = Pattern.compile(
                        "(?i)mixin (?:apply failed|transformation of)[^\\n]{0,160}?from mod ([\\w.-]+)")
                .matcher(text);
        while (m2.find()) {
            out.add(m2.group(1));
        }
        return out;
    }

    /// 崩溃堆栈里 `~[xxx.jar:?]` / `~[xxx.jar%23512!/:?]` 的引用。
    private static List<String> parseMentionedJars(String text) {
        List<String> out = new ArrayList<>();
        Matcher m = Pattern.compile("\\[([^\\[\\]\\s]+?\\.jar)").matcher(text);
        while (m.find()) {
            String raw = m.group(1);
            int slash = Math.max(raw.lastIndexOf('/'), raw.lastIndexOf('\\'));
            out.add(slash >= 0 ? raw.substring(slash + 1) : raw);
        }
        return out;
    }

    /// NeoForge 堆栈里的 `at TRANSFORMER/<modid>@<version>/<包名>`，按 modid 计数。
    private static Map<String, Integer> transformerMods(String text) {
        Map<String, Integer> out = new LinkedHashMap<>();
        Matcher m = Pattern.compile("at\\s+TRANSFORMER/([\\w.-]+)@[^/\\s]*/").matcher(text);
        while (m.find()) {
            out.merge(m.group(1).toLowerCase(Locale.ROOT), 1, Integer::sum);
        }
        return out;
    }

    /// 从堆栈行里抽包名，按出现次数排序。游戏本体和框架库不算。
    private static Map<String, Integer> stackPackages(String text) {
        Map<String, Integer> counts = new LinkedHashMap<>();
        Matcher m = Pattern.compile("at\\s+([a-z][\\w]*(?:\\.[a-z][\\w]*){1,3})\\.").matcher(text);
        while (m.find()) {
            String pkg = m.group(1).toLowerCase(Locale.ROOT);
            if (isFrameworkPackage(pkg)) {
                continue;
            }
            counts.merge(pkg, 1, Integer::sum);
        }
        return counts;
    }

    private static boolean isFrameworkPackage(String pkg) {
        return pkg.startsWith("java.") || pkg.startsWith("javax.")
                || pkg.startsWith("jdk.") || pkg.startsWith("sun.")
                || pkg.startsWith("net.minecraft") || pkg.startsWith("com.mojang")
                || pkg.startsWith("org.lwjgl") || pkg.startsWith("com.google")
                || pkg.startsWith("org.apache") || pkg.startsWith("org.spongepowered")
                || pkg.startsWith("org.objectweb") || pkg.startsWith("net.fabricmc")
                || pkg.startsWith("net.minecraftforge") || pkg.startsWith("cpw.mods")
                || pkg.startsWith("net.neoforged") || pkg.startsWith("org.jetbrains")
                || pkg.startsWith("kotlin.") || pkg.startsWith("org.slf4j")
                || pkg.startsWith("com.electronwill") || pkg.startsWith("it.unimi");
    }

    /// 从依赖报错里还原「谁缺了什么」。
    ///
    /// <p>两种真实格式：
    /// <pre>
    /// Immediate reason: [HARD_DEP_NO_CANDIDATE iris 1.8.14 {depends sodium @ [0.8.x]}, ...]
    /// Mod 'Iris' (iris) 1.8.14 requires version 0.8.x or later of sodium, which is missing!
    /// </pre>
    /// 前一种是英文、不受游戏语言影响，优先用它。
    private static Map<String, String> missingDepsByMod(String text) {
        Map<String, String> out = new LinkedHashMap<>();
        Matcher m = Pattern.compile("(?i)HARD_DEP_NO_CANDIDATE (\\w[\\w.-]*)[^\\n]*?depends ([\\w.-]+)")
                .matcher(text);
        while (m.find()) {
            out.putIfAbsent(m.group(1), m.group(2));
        }
        Matcher m2 = Pattern.compile(
                        "(?i)Mod '([^']+)' \\(([\\w.-]+)\\)[^\\n]*?requires (?:any version of|version [^\\s,]+ of) ([\\w.-]+)")
                .matcher(text);
        while (m2.find()) {
            out.putIfAbsent(m2.group(2), m2.group(3));
        }
        return out;
    }

    private static List<ModFile> recentMods(ModIndex index, long crashTime) {
        List<ModFile> list = new ArrayList<>();
        for (ModFile m : index.all) {
            if (m.disabled) {
                continue;
            }
            long age = crashTime - m.modified;
            if (age >= -5 * 60 * 1000L && age <= RECENT_WINDOW_MS) {
                list.add(m);
            }
        }
        list.sort((a, b) -> Long.compare(b.modified, a.modified));
        return list.size() > 5 ? list.subList(0, 5) : list;
    }

    private static String humanAge(long ms) {
        if (ms < 60_000L) {
            return "不到一分钟";
        }
        long minutes = ms / 60_000L;
        if (minutes < 60) {
            return minutes + " 分钟前";
        }
        long hours = minutes / 60;
        if (hours < 24) {
            return hours + " 小时前";
        }
        return (hours / 24) + " 天前";
    }

    private static JsonObject evidenceJson(HMCLGameInstance instance, Evidence e, ModIndex index) {
        JsonObject o = new JsonObject();
        o.addProperty("file", e.mod.file);
        o.addProperty("id", e.mod.id);
        o.addProperty("name", e.mod.display());
        o.addProperty("version", e.mod.version);
        o.addProperty("disabled", e.mod.disabled);
        o.addProperty("hits", e.hits);
        o.addProperty("score", e.score);
        o.addProperty("confidence", e.score >= 8 ? "high" : e.score >= 4 ? "medium" : "low");

        JsonArray reasons = new JsonArray();
        e.reasons.forEach(reasons::add);
        o.add("evidence", reasons);
        o.addProperty("advice", adviceFor(instance, e));

        // 这个 jar 跟当前实例的加载器对不对得上
        Path modsDir = instance.getModsDirectory();
        String modLoader = modsDir == null ? null : ModScanService.detectLoader(
                modsDir.resolve(e.mod.disabled ? e.mod.file + ".disabled" : e.mod.file));
        String instLoader = instanceLoader(instance);
        if (modLoader != null && ModScanService.loaderConflict(modLoader, instLoader)) {
            o.addProperty("loader", modLoader);
            o.addProperty("loaderConflict", true);
        }
        return o;
    }

    private static String adviceFor(HMCLGameInstance instance, Evidence e) {
        ModFile mod = e.mod;
        if (mod.disabled) {
            return "它现在已经是禁用状态，不会再被加载。";
        }
        if (!e.missingDep.isBlank()) {
            return "它声明的前置「" + e.missingDep + "」没装或版本不符。"
                    + "先到「依赖检查」里把前置装上；暂时不想装就禁用这个模组，等前置到位再启用。";
        }
        Path modsDir = instance.getModsDirectory();
        String modLoader = modsDir == null ? null : ModScanService.detectLoader(modsDir.resolve(mod.file));
        String instLoader = instanceLoader(instance);
        if (modLoader != null && ModScanService.loaderConflict(modLoader, instLoader)) {
            return "这个 jar 是 " + modLoader + " 版的，当前实例是 " + instLoader
                    + "，装上也不会加载。换对应加载器的版本。";
        }
        if (e.score >= 8) {
            return "证据很直接：先禁用它重启。如果还崩，说明问题在别处，可以再启用回来。";
        }
        if (e.score >= 4) {
            return "禁用后重启验证一次；不崩就基本可以确定是它。";
        }
        return "它只是「最近动过」，不一定是元凶。排查时优先从它开始试。";
    }

    private static String instanceLoader(HMCLGameInstance instance) {
        try {
            String id = instance.getId().toString();
            String lower = id.toLowerCase(Locale.ROOT);
            if (lower.contains("neoforge")) {
                return "neoforge";
            }
            if (lower.contains("fabric")) {
                return "fabric";
            }
            if (lower.contains("quilt")) {
                return "quilt";
            }
            if (lower.contains("forge")) {
                return "forge";
            }
        } catch (Throwable ignored) {
        }
        return "";
    }

    // ==================== 恢复快照 ====================

    private static Path quarantinePath(HMCLGameInstance instance) {
        return instance.getRunDirectory().resolve(".hmcl").resolve("crash-quarantine.json");
    }

    private static JsonObject readQuarantine(HMCLGameInstance instance) {
        Path p = quarantinePath(instance);
        if (!Files.isRegularFile(p)) {
            return null;
        }
        try {
            return JsonParser.parseString(Files.readString(p, StandardCharsets.UTF_8)).getAsJsonObject();
        } catch (Throwable e) {
            return null;
        }
    }

    private static JsonObject quarantineJson(HMCLGameInstance instance) {
        JsonObject snapshot = readQuarantine(instance);
        if (snapshot == null) {
            return null;
        }
        JsonObject o = new JsonObject();
        JsonElement files = snapshot.get("files");
        o.addProperty("count", files != null && files.isJsonArray() ? files.getAsJsonArray().size() : 0);
        JsonElement time = snapshot.get("time");
        o.addProperty("time", time == null ? 0 : time.getAsLong());
        return o;
    }

    private static void appendQuarantine(HMCLGameInstance instance, List<String> files) {
        if (files.isEmpty()) {
            return;
        }
        try {
            JsonObject snapshot = readQuarantine(instance);
            LinkedHashSet<String> all = new LinkedHashSet<>();
            if (snapshot != null) {
                JsonElement old = snapshot.get("files");
                if (old != null && old.isJsonArray()) {
                    for (JsonElement el : old.getAsJsonArray()) {
                        all.add(el.getAsString());
                    }
                }
            }
            all.addAll(files);

            JsonObject root = new JsonObject();
            root.addProperty("time", Instant.now().toEpochMilli());
            JsonArray arr = new JsonArray();
            all.forEach(arr::add);
            root.add("files", arr);

            Path p = quarantinePath(instance);
            Files.createDirectories(p.getParent());
            Files.writeString(p, JsonUtils.GSON.toJson(root), StandardCharsets.UTF_8);
        } catch (Throwable e) {
            LOG.warning("Failed to write crash quarantine", e);
        }
    }

    // ==================== 杂项 ====================

    private static HMCLGameInstance instanceOf(String instanceId) {
        try {
            return GameDirectoryManager.getSelectedRepository()
                    .getInstance(new GameInstanceID(instanceId));
        } catch (Throwable e) {
            return null;
        }
    }

    private static List<String> parseFileList(String json) {
        List<String> out = new ArrayList<>();
        if (json == null || json.isBlank()) {
            return out;
        }
        try {
            JsonElement el = JsonParser.parseString(json);
            if (el.isJsonArray()) {
                for (JsonElement item : el.getAsJsonArray()) {
                    if (item.isJsonPrimitive()) {
                        out.add(item.getAsString());
                    }
                }
                return out;
            }
        } catch (Throwable ignored) {
        }
        // 兼容逗号分隔，方便手工调用
        for (String part : json.split(",")) {
            if (!part.isBlank()) {
                out.add(part.trim());
            }
        }
        return out;
    }
}
