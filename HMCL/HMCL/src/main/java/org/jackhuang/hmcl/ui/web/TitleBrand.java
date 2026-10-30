/*
 * HopeStar-MCLab
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

package org.jackhuang.hmcl.ui.web;

import static org.jackhuang.hmcl.util.logging.Logger.LOG;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.Enumeration;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.zip.ZipEntry;
import java.util.zip.ZipFile;
import java.util.zip.ZipOutputStream;

/**
 * 把主菜单左下角那行 {@code Minecraft 1.21.1/HMCL（已修改）} 改成只留版本号。
 *
 * <p>1.14+ 的 TitleScreen 是这么拼的：
 * <pre>{@code
 * "Minecraft " + getGameVersion().getName()
 *   + ("release".equalsIgnoreCase(getVersionType()) ? "" : "/" + getVersionType())
 *   + I18n.get("menu.modded")
 * }</pre>
 *
 * <p>中间那段启动器名从启动参数里改不动：把 {@code --versionType} 换成
 * {@code ZZZTEST-1234} / {@code release} / 整个删掉，再换回官方原版 jar，
 * 游戏里都是一个样。{@code tools/probe} 直接读游戏内存里
 * {@code Minecraft.versionType}，得到的值也跟命令行不一致。
 *
 * <p>所以只能改客户端：把 TitleScreen 常量池里两个字符串换成我们要的。
 * <ul>
 *   <li>{@code "release"} → {@code "HMCL"}：让 equals 成立，跳过 {@code "/HMCL"}</li>
 *   <li>{@code "menu.modded"} → {@link #BRAND}：I18n 查不到 key 时原样返回</li>
 * </ul>
 *
 * <p>做法是直接改 class 文件的常量池，不走 ASM —— 1.21 的字符串是
 * {@code StringConcatFactory} 的 recipe 参数，不在 {@code ldc} 指令里，
 * {@code visitLdcInsn} 根本拦不到。常量池里改 UTF8 只影响这一个条目，
 * 条目数不变，后面的字节整体平移即可（class 文件里没有绝对偏移）。
 *
 * <p>定位方式也不写死类名 —— 混淆名每个版本都不一样。这里扫 jar 根目录下
 * 所有短名 class，谁的常量池里同时有 {@code "menu.modded"} 和 {@code "release"}
 * 就是 TitleScreen。
 */
public final class TitleBrand {

    private TitleBrand() {
    }

    /// 拼在版本号后面的文字。
    ///
    /// <p>空串 = 纯净模式：主菜单只显示 {@code Minecraft 1.21.1}，不出现任何启动器名字
    /// （PCL 那套做法）。想显示自己的品牌就改成 {@code " " + Metadata.NAME}。
    private static final String BRAND = "";

    /// 客户端里 getVersionType() 的固定值（实测，与启动参数无关）。
    /// 拿它去骗过 {@code "release".equalsIgnoreCase(...)} 那一跳。
    private static final String TYPE_TO_MATCH = "HMCL";

    private static final Set<String> CHECKED = ConcurrentHashMap.newKeySet();

    /// 启动前调用。失败只记日志，绝不影响启动。
    public static void patchQuietly(Path jar) {
        if (jar == null || !Files.isRegularFile(jar)) {
            return;
        }
        final String key;
        try {
            key = jar.toAbsolutePath() + "|" + Files.size(jar) + "|" + Files.getLastModifiedTime(jar).toMillis();
        } catch (IOException e) {
            return;
        }
        if (!CHECKED.add(key)) {
            return;
        }
        try {
            int n = patch(jar);
            if (n > 0) {
                LOG.info("[brand] patched " + n + " class(es) in " + jar.getFileName());
            }
        } catch (Throwable e) {
            LOG.warning("[brand] cannot patch " + jar, e);
        }
    }

    /// @return 真的改动了几处（0 表示这个 jar 不需要/不能改）
    public static int patch(Path jar) throws IOException {
        Map<String, byte[]> replaced = new LinkedHashMap<>();
        boolean branded = false;
        boolean signed = false;

        try (ZipFile zip = new ZipFile(jar.toFile())) {
            Enumeration<? extends ZipEntry> entries = zip.entries();
            while (entries.hasMoreElements()) {
                ZipEntry entry = entries.nextElement();
                String name = entry.getName();
                if (isSignatureEntry(name)) {
                    signed = true;
                    continue;
                }
                // 混淆后的 TitleScreen 一定在根目录、类名很短（fof、fod、efg…）
                if (!name.endsWith(".class") || name.indexOf('/') >= 0 || name.length() > 12) {
                    continue;
                }
                try {
                    byte[] data;
                    try (InputStream in = zip.getInputStream(entry)) {
                        data = in.readAllBytes();
                    }
                    // 已经打过补丁的 jar：常量池里能读到 TYPE_TO_MATCH，用它判断要不要补救签名
                    if (!branded && new String(data, StandardCharsets.ISO_8859_1).contains(TYPE_TO_MATCH)) {
                        branded = true;
                    }
                    byte[] out = tryPatch(data);
                    if (out != null) {
                        replaced.put(name, out);
                    }
                } catch (Throwable e) {
                    // 单个 entry 读不出来就算了，不能因为一个坏条目放弃整个 jar
                    LOG.warning("[brand] skip entry " + name + ": " + e);
                }
            }
        }

        // 改过 class 就必须把签名块一起删掉：原版客户端 jar 是 Mojang 签过名的，
        // 改了里面的 class 而签名还在，JVM 加载时对不上摘要就抛
        // `SecurityException: SHA-384 digest error`，游戏直接起不来（1.21.1 实测）。
        // 删掉 META-INF/*.SF|*.RSA|*.DSA = 变成未签名 jar，JVM 不再校验，类照常加载。
        // 已经打过补丁的老 jar（上次只改了 class、签名还在）也在这里补救一次。
        boolean stripSignature = signed && (!replaced.isEmpty() || branded);
        if (replaced.isEmpty() && !stripSignature) {
            return 0;
        }
        replaceEntries(jar, replaced, stripSignature);
        if (stripSignature) {
            LOG.info("[brand] dropped jar signature in " + jar.getFileName());
        }
        return replaced.size();
    }

    /// @return 改好的字节；不需要改就返回 null
    private static byte[] tryPatch(byte[] original) {
        if (original.length < 10 || original[0] != (byte) 0xCA || original[1] != (byte) 0xFE) {
            return null;
        }
        String text = new String(original, StandardCharsets.ISO_8859_1);
        if (!text.contains("menu.modded") || !text.contains("release")) {
            // 不是 TitleScreen，或者之前已经打过补丁
            return null;
        }

        Map<String, String> repl = new LinkedHashMap<>();
        repl.put("release", TYPE_TO_MATCH);
        repl.put("menu.modded", BRAND);
        return rewriteConstantPool(original, repl);
    }

    /// 改常量池里的 UTF8 字符串。
    ///
    /// <p>常量池条目数不变，只换某个 UTF8 的内容 —— 后面的字节整体平移即可，
    /// class 文件内部全是相对引用，不需要重算任何偏移。
    private static byte[] rewriteConstantPool(byte[] d, Map<String, String> repl) {
        int count = ((d[8] & 0xFF) << 8) | (d[9] & 0xFF);
        int p = 10;
        int hits = 0;

        ByteArrayOutputStream out = new ByteArrayOutputStream(d.length);
        out.write(d, 0, 10);

        for (int idx = 1; idx < count; idx++) {
            int tag = d[p] & 0xFF;
            int size = entrySize(d, p, tag);
            if (size < 0) {
                return null;   // 解析不了就别乱改
            }
            if (tag == 1) {
                int len = ((d[p + 1] & 0xFF) << 8) | (d[p + 2] & 0xFF);
                String value = new String(d, p + 3, len, StandardCharsets.UTF_8);
                String target = repl.get(value);
                if (target != null) {
                    byte[] nb = target.getBytes(StandardCharsets.UTF_8);
                    out.write(1);
                    out.write((nb.length >> 8) & 0xFF);
                    out.write(nb.length & 0xFF);
                    out.write(nb, 0, nb.length);
                    hits++;
                    p += size;
                    continue;
                }
            }
            out.write(d, p, size);
            p += size;
            if (tag == 5 || tag == 6) {
                idx++;   // long/double 占两个槽位
            }
        }

        if (hits == 0) {
            return null;
        }
        out.write(d, p, d.length - p);
        return out.toByteArray();
    }

    private static int entrySize(byte[] d, int p, int tag) {
        switch (tag) {
            case 1: {
                int len = ((d[p + 1] & 0xFF) << 8) | (d[p + 2] & 0xFF);
                return 3 + len;
            }
            case 3:
            case 4:
                return 5;
            case 5:
            case 6:
                return 9;
            case 7:
            case 8:
            case 16:
            case 19:
            case 20:
                return 3;
            case 9:
            case 10:
            case 11:
            case 12:
            case 17:
            case 18:
                return 5;
            case 15:
                return 4;
            default:
                return -1;
        }
    }

    /// 签名块文件（`META-INF/MOJANGCS.SF`、`.RSA` 之类）。
    ///
    /// <p>只认 `META-INF/` 根下的：子目录里的同名文件跟签名无关。
    private static boolean isSignatureEntry(String name) {
        String upper = name.toUpperCase(Locale.ROOT);
        if (!upper.startsWith("META-INF/")) {
            return false;
        }
        String rest = upper.substring("META-INF/".length());
        if (rest.indexOf('/') >= 0) {
            return false;
        }
        return rest.endsWith(".SF") || rest.endsWith(".RSA") || rest.endsWith(".DSA")
                || rest.endsWith(".EC") || rest.startsWith("SIG-");
    }

    /// 原地替换 jar 里的若干 entry。先写临时文件再原子替换，中途失败不会留下半个 jar。
    ///
    /// @param stripSignature 是否顺手删掉签名块（改过 class 时必须）
    private static void replaceEntries(Path jar, Map<String, byte[]> data, boolean stripSignature) throws IOException {
        Path tmp = jar.resolveSibling(jar.getFileName() + ".brand-tmp");
        try (ZipFile src = new ZipFile(jar.toFile());
             ZipOutputStream out = new ZipOutputStream(Files.newOutputStream(tmp))) {
            Enumeration<? extends ZipEntry> entries = src.entries();
            while (entries.hasMoreElements()) {
                ZipEntry entry = entries.nextElement();
                if (data.containsKey(entry.getName())
                        || (stripSignature && isSignatureEntry(entry.getName()))) {
                    continue;
                }
                ZipEntry copy = new ZipEntry(entry.getName());
                copy.setTime(entry.getTime());
                out.putNextEntry(copy);
                try (InputStream in = src.getInputStream(entry)) {
                    in.transferTo(out);
                }
                out.closeEntry();
            }
            for (Map.Entry<String, byte[]> e : data.entrySet()) {
                out.putNextEntry(new ZipEntry(e.getKey()));
                out.write(e.getValue());
                out.closeEntry();
            }
        }
        Files.move(tmp, jar, StandardCopyOption.REPLACE_EXISTING);
    }
}
