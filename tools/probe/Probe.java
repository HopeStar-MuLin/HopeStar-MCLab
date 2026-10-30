import java.io.PrintWriter;
import java.lang.instrument.Instrumentation;
import java.lang.reflect.Field;
import java.nio.file.Paths;

/**
 * 挂到游戏进程里，把 Minecraft 实例上所有 String 字段打出来。
 * 输出写到文件（javaw 没有控制台）。
 *
 * 用法：java -jar probe-agent.jar <pid>
 */
public final class Probe {

    public static void agentmain(String args, Instrumentation inst) {
        String[] parts = args.split("\\|");
        String outPath = parts[0];
        String override = parts.length > 1 ? parts[1] : null;
        try (PrintWriter out = new PrintWriter(Paths.get(outPath).toFile(), "UTF-8")) {
            out.println("loaded classes: " + inst.getAllLoadedClasses().length);

            // 游戏进程**实际收到**的命令行，和 jcmd 读到的做对比
            out.println("cmdline: " + ProcessHandle.current().info().commandLine().orElse("?"));
            ProcessHandle.current().info().arguments().ifPresent(a -> {
                for (int i = 0; i < a.length; i++) {
                    if (a[i].contains("versionType") || a[i].contains("MCLab") || a[i].contains("launcher.brand")) {
                        out.println("  arg[" + i + "] = " + a[i]);
                    }
                }
            });

            for (Class<?> c : inst.getAllLoadedClasses()) {
                String n = c.getName();
                boolean isMc = n.equals("net.minecraft.class_310")
                        || n.equals("fgo")
                        || n.endsWith(".Minecraft");
                if (!isMc) {
                    continue;
                }
                out.println("=== " + n + " ===");

                Object instance = null;
                for (Field f : c.getDeclaredFields()) {
                    if (!java.lang.reflect.Modifier.isStatic(f.getModifiers())) {
                        continue;
                    }
                    if (f.getType() == c) {
                        try {
                            f.setAccessible(true);
                            instance = f.get(null);
                        } catch (Throwable ignored) {
                        }
                    }
                }
                out.println("instance: " + (instance != null));

                // 顺手把版本类型字段改掉，验证它是不是主菜单读的那一个
                if (override != null) {
                    try {
                        Field vt = c.getDeclaredField("field_1720");
                        vt.setAccessible(true);
                        vt.set(instance, override);
                        out.println("OVERRIDE field_1720 -> " + override);
                    } catch (Throwable e) {
                        out.println("override failed: " + e);
                    }
                }

                for (Field f : c.getDeclaredFields()) {
                    if (f.getType() != String.class) {
                        continue;
                    }
                    try {
                        f.setAccessible(true);
                        Object v = java.lang.reflect.Modifier.isStatic(f.getModifiers())
                                ? f.get(null)
                                : (instance != null ? f.get(instance) : null);
                        if (v != null) {
                            out.println("  " + f.getName() + " = " + v);
                        }
                    } catch (Throwable e) {
                        out.println("  " + f.getName() + " ! " + e.getClass().getSimpleName());
                    }
                }
            }
            out.flush();
        } catch (Throwable e) {
            // 失败就算了
        }
    }
}
