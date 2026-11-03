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

import com.google.gson.JsonObject;
import org.jackhuang.hmcl.util.gson.JsonUtils;
import org.jetbrains.annotations.NotNullByDefault;
import org.jetbrains.annotations.Nullable;

import java.nio.file.Files;
import java.nio.file.Path;

import static org.jackhuang.hmcl.util.logging.Logger.LOG;

/// 启动器自身更新（设置 → 关于）。
///
/// <p>从 [WebBridge] 拆出来的第一块：只需要「往页面推 JS」和「弹个提示」，
/// 不碰实例、账号、皮肤那些共享状态，是最适合先搬的。
@NotNullByDefault
public final class LauncherUpdateApi {

    private final BridgeHost host;

    LauncherUpdateApi(BridgeHost host) {
        this.host = host;
    }

    // ==================== 启动器自身更新 ====================

    /// 已经下载好、等着替换的更新包。
    private volatile Path launcherUpdateArchive;

    /// 当前版本号（设置页「关于」显示用）。
    public String launcherVersion() {
        return UpdateService.currentVersion();
    }

    /// 查 GitHub Releases 上的最新版本，结果通过 onLauncherUpdate 推回前端。
    public void checkLauncherUpdate() {
        Thread worker = new Thread(() -> {
            try {
                pushLauncherUpdate(UpdateService.checkLatest(), null);
            } catch (Throwable e) {
                LOG.warning("检查更新失败", e);
                pushLauncherUpdate(null, e.getMessage() == null ? e.toString() : e.getMessage());
            }
        }, "launcher-update-check");
        worker.setDaemon(true);
        worker.start();
    }

    /// 下载更新包。进度通过 onLauncherUpdateProgress 推回，0–100。
    public void downloadLauncherUpdate(String url, long size) {
        Thread worker = new Thread(() -> {
            try {
                Path dir = org.jackhuang.hmcl.Metadata.HMCL_LOCAL_HOME.resolve("update");
                Files.createDirectories(dir);
                // 后缀要跟内容一致：applyUpdate 按 .jar 走热更新（只换 jar）、按 .zip 走整包解压
                String suffix = url != null && url.toLowerCase().contains(".jar") ? ".jar" : ".zip";
                Path target = dir.resolve("update-" + System.currentTimeMillis() + suffix);
                UpdateService.download(url, target, size, percent -> pushLauncherUpdateProgress((int) percent));
                launcherUpdateArchive = target;
                pushLauncherUpdateProgress(100);
                pushLauncherUpdateReady(target.toString());
            } catch (Throwable e) {
                LOG.warning("下载更新包失败", e);
                pushLauncherUpdate(null, "下载失败：" + (e.getMessage() == null ? e.toString() : e.getMessage()));
            }
        }, "launcher-update-download");
        worker.setDaemon(true);
        worker.start();
    }

    /// 装更新：写一个延迟脚本，退出后由它解压覆盖并重新启动。
    public void applyLauncherUpdate() {
        Path archive = launcherUpdateArchive;
        if (archive == null || !Files.isRegularFile(archive)) {
            host.toast("还没有下载好更新包");
            return;
        }
        // 安装目录就是 exe 所在目录；壳启动 Java 时把工作目录设成了那里
        Path installDir = Path.of(System.getProperty("user.dir"));
        try {
            UpdateService.applyUpdate(archive, installDir);
        } catch (Throwable e) {
            LOG.warning("启动更新脚本失败", e);
            host.toast("更新失败：" + (e.getMessage() == null ? e.toString() : e.getMessage()));
            return;
        }
        host.toast("正在退出，马上重启完成更新");
        Thread exit = new Thread(() -> {
            try {
                Thread.sleep(900);
            } catch (InterruptedException ignored) {
            }
            System.exit(0);
        }, "launcher-update-exit");
        exit.setDaemon(false);
        exit.start();
    }

    private void pushLauncherUpdate(@Nullable JsonObject data, @Nullable String error) {
        JsonObject root = new JsonObject();
        root.addProperty("ok", error == null);
        if (error != null) {
            root.addProperty("error", error);
        }
        if (data != null) {
            root.add("data", data);
        }
        host.execute("window.__hmcl && window.__hmcl.onLauncherUpdate("
                + JsonUtils.GSON.toJson(JsonUtils.GSON.toJson(root)) + ")");
    }

    private void pushLauncherUpdateProgress(int percent) {
        host.execute("window.__hmcl && window.__hmcl.onLauncherUpdateProgress(" + percent + ")");
    }

    private void pushLauncherUpdateReady(String path) {
        host.execute("window.__hmcl && window.__hmcl.onLauncherUpdateReady("
                + JsonUtils.GSON.toJson(path) + ")");
    }

    /// 当前界面语言。壳拼页面 URL 时带上它，前端才知道加载哪个语言包。
    ///
    /// 设置里选「跟随系统」时 name 是 `default`，这时候要把系统实际的语言标签
    /// 报上去，不然前端拿到 "default" 找不到语言包，只能回退中文。
    public String webLanguage() {
        try {
            org.jackhuang.hmcl.util.i18n.SupportedLocale locale =
                    org.jackhuang.hmcl.setting.SettingsManager.settings().languageProperty().get();
            String name = locale.getName();
            if (name != null && !name.isBlank() && !"default".equals(name)) {
                return name;
            }
            return java.util.Locale.getDefault().toLanguageTag();
        } catch (Exception e) {
            LOG.warning("Failed to read interface language", e);
            return "zh-Hans";
        }
    }
}
