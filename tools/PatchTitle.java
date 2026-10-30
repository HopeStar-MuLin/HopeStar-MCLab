import org.objectweb.asm.ClassReader;
import org.objectweb.asm.ClassVisitor;
import org.objectweb.asm.ClassWriter;
import org.objectweb.asm.MethodVisitor;
import org.objectweb.asm.Opcodes;

import java.io.*;
import java.nio.file.*;
import java.util.zip.*;

/**
 * 把 TitleScreen 里那行版本文字里的启动器名换掉。
 *
 * <p>1.21.1 的 TitleScreen 逻辑是：
 * {@code "Minecraft " + 版本 + ("release".equals(versionType) ? "" : "/" + versionType) + I18n("menu.modded")}
 * 而 versionType 在我们的环境里恒为 "HMCL"（传什么都不变，实测见 tools/direct-launch.py）。
 *
 * <p>这里把两处字符串常量换掉：
 * <ul>
 *   <li>{@code "release"} → {@code "HMCL"}：让 equals 成立，跳过 "/HMCL" 那段</li>
 *   <li>{@code "menu.modded"} → {@code " HopeStar-MCLab"}：I18n 查不到 key 时返回 key 本身</li>
 * </ul>
 * 结果是 {@code "Minecraft 1.21.1 HopeStar-MCLab"}。
 *
 * <p>用法：{@code java PatchTitle <client.jar> [品牌名]}
 */
public final class PatchTitle implements Opcodes {

    public static void main(String[] args) throws Exception {
        Path jar = Paths.get(args[0]);
        String brand = args.length > 1 ? args[1] : " HopeStar-MCLab";
        String matchType = args.length > 2 ? args[2] : "HMCL";

        byte[] original;
        try (ZipFile zip = new ZipFile(jar.toFile())) {
            ZipEntry entry = zip.getEntry("fof.class");
            if (entry == null) {
                System.err.println("fof.class not found — 这不是 1.21.1 的混淆客户端 jar");
                System.exit(2);
                return;
            }
            try (InputStream in = zip.getInputStream(entry)) {
                original = in.readAllBytes();
            }
        }

        ClassReader reader = new ClassReader(original);
        ClassWriter writer = new ClassWriter(reader, 0);
        final boolean[] hit = new boolean[2];

        reader.accept(new ClassVisitor(ASM9, writer) {
            @Override
            public MethodVisitor visitMethod(int access, String name, String desc,
                                             String sig, String[] exceptions) {
                MethodVisitor mv = super.visitMethod(access, name, desc, sig, exceptions);
                return new MethodVisitor(ASM9, mv) {
                    @Override
                    public void visitLdcInsn(Object value) {
                        if ("release".equals(value)) {
                            hit[0] = true;
                            super.visitLdcInsn(matchType);
                            return;
                        }
                        if ("menu.modded".equals(value)) {
                            hit[1] = true;
                            super.visitLdcInsn(brand);
                            return;
                        }
                        super.visitLdcInsn(value);
                    }
                };
            }
        }, 0);

        System.out.println("patched release->" + matchType + ": " + hit[0]
                + ", menu.modded->" + brand + ": " + hit[1]);
        if (!hit[0] && !hit[1]) {
            System.err.println("没找到目标常量，jar 结构可能不匹配");
            System.exit(3);
        }

        byte[] patched = writer.toByteArray();
        replaceEntry(jar, "fof.class", patched);
        System.out.println("written: " + jar + " (" + patched.length + " bytes)");
    }

    /** 原地替换 jar 里的一个 entry：复制其余条目，写临时文件后原子替换。 */
    private static void replaceEntry(Path jar, String target, byte[] data) throws IOException {
        Path tmp = jar.resolveSibling(jar.getFileName() + ".tmp");
        try (ZipFile src = new ZipFile(jar.toFile());
             ZipOutputStream out = new ZipOutputStream(Files.newOutputStream(tmp))) {
            java.util.Enumeration<? extends ZipEntry> it = src.entries();
            while (it.hasMoreElements()) {
                ZipEntry e = it.nextElement();
                if (e.getName().equals(target)) {
                    continue;
                }
                ZipEntry copy = new ZipEntry(e.getName());
                copy.setTime(e.getTime());
                out.putNextEntry(copy);
                try (InputStream in = src.getInputStream(e)) {
                    in.transferTo(out);
                }
                out.closeEntry();
            }
            ZipEntry fresh = new ZipEntry(target);
            out.putNextEntry(fresh);
            out.write(data);
            out.closeEntry();
        }
        Files.move(tmp, jar, StandardCopyOption.REPLACE_EXISTING);
    }
}
