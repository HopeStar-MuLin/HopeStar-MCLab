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
import org.jackhuang.hmcl.auth.yggdrasil.GameProfile;
import org.jackhuang.hmcl.auth.OperationCancelledException;
import org.jackhuang.hmcl.auth.Account;
import org.jackhuang.hmcl.auth.CharacterSelector;
import org.jackhuang.hmcl.auth.NoSelectedCharacterException;
import org.jackhuang.hmcl.auth.authlibinjector.AuthlibInjectorServer;
import org.jackhuang.hmcl.setting.Accounts;
import org.jackhuang.hmcl.setting.SettingsManager;
import org.jackhuang.hmcl.task.Schedulers;
import org.jackhuang.hmcl.task.Task;
import org.jackhuang.hmcl.util.gson.JsonUtils;
import org.jetbrains.annotations.NotNullByDefault;
import org.jetbrains.annotations.Nullable;

import java.util.List;
import java.util.Objects;

import static org.jackhuang.hmcl.util.logging.Logger.LOG;

/// 账号：离线 / 微软 / 外置认证（authlib-injector）三条登录路径，外加改名单删。
///
/// <p>登录全部自绘，不走 HMCL 的 `Controllers.dialog`——壳模式下没有 JavaFX 窗口，
/// 那些弹窗根本不会出现，点了「登录」什么都不发生，用户只会以为坏了。所以进度一律
/// 用 [BridgeHost#execute] 推给页面（`onLogin` / `onLoginStage`），结果也推。
///
/// <p>微软登录是异步的，`microsoftLoginSeq` 用来丢弃过期回调：用户连点两次登录时，
/// 第一次的回调不能把第二次的界面状态覆盖掉。
@NotNullByDefault
public final class AccountApi {

    private final BridgeHost host;

    /// 换账号时把上一个账号的外观草稿丢掉，否则会把 A 的皮肤带进 B
    private final Runnable onAccountSwitched;

    AccountApi(BridgeHost host, Runnable onAccountSwitched) {
        this.host = host;
        this.onAccountSwitched = onAccountSwitched;
    }


    /// 三条登录路径全部在壳里自绘。
    ///
    /// 为什么不继续用 `Controllers.dialog(new XxxPane())`：壳模式没有 JavaFX 窗口，
    /// 那些弹窗根本不会出现——点了「登录」什么都不会发生，用户只会以为坏了。

    /// 离线登录：只填用户名，不做任何验证。
    public void loginOffline(String username) {
        if (username == null || username.isBlank()) {
            pushLogin("offline", false, "请填写用户名");
            return;
        }
        String name = username.trim();

        Task.runAsync(() -> {
            try {
                Account account = Accounts.FACTORY_OFFLINE.create(
                        new AutoCharacterSelector(), name, "", null, null);
                completeLogin(account);
                pushLogin("offline", true, name);
            } catch (Throwable e) {
                LOG.warning("Offline login failed", e);
                pushLogin("offline", false, localize(e));
            }
        }).start();
    }

    /// 微软正版登录：走设备码（DEVICE）流程。
    ///
    /// 另一条 AUTHORIZATION_CODE 流程要起一个本机回调服务、还要弹浏览器窗口，
    /// 壳里做不了；设备码只要能显示一串码和网址就行，正好适合自绘 UI。
    /// 这个构建能不能用微软正版登录（有没有内置 client_id）。
    ///
    /// <p>发行版在 Mojang 审核通过前不发 client_id，前端据此把入口置灰，
    /// 免得用户点了才看到一句失败提示。
    public boolean isMicrosoftAuthAvailable() {
        String id = Accounts.OAUTH_CALLBACK.getClientId();
        return id != null && !id.isEmpty();
    }

    public void loginMicrosoft() {
        // 快照构建没有内置 OAuth client_id（HMCL 在打包时才注入），
        // 没有它微软那头的设备码请求会直接 400。先在这里拦住，给一句人话，
        // 别把 AADSTS900144 这种原始报错甩给用户。
        if (Accounts.OAUTH_CALLBACK.getClientId() == null
                || Accounts.OAUTH_CALLBACK.getClientId().isEmpty()) {
            pushLogin("microsoft", false,
                    "本版暂未开放微软正版登录，请使用离线登录或外置认证登录");
            return;
        }

        hookMicrosoftDeviceCode();
        // 上一次的轮询线程先踢一脚：用户可能没关弹窗就又点了一次，
        // 那个线程还在 sleep 里等着。它的结果会因为没有序号而被丢弃，
        // 但没必要让它白占一个线程跑满 15 分钟。
        Thread previous = microsoftLoginThread;
        if (previous != null && previous != Thread.currentThread()) {
            previous.interrupt();
        }
        // 标记是单向的，这里必须清掉；否则新的一次登录会在第一个 250ms 分片里就自己终止
        Accounts.OAUTH_CALLBACK.resetCancel();
        final int seq = ++microsoftLoginSeq;
        pushLoginStage("microsoft", "正在申请登录代码…");

        Task.supplyAsync(() -> {
            // 记住跑轮询的线程：用户点取消时 interrupt 它，让它立刻从 sleep 里醒来。
            // 光靠标志位最多要等一个分片（250ms）才生效，而 sleep 被中断是立即的。
            microsoftLoginThread = Thread.currentThread();
            // 走 HMCL 现成的工厂：内部会触发 OAUTH_CALLBACK.onGrantDeviceCode
            return Accounts.FACTORY_MICROSOFT.create(null, null, null, null,
                    org.jackhuang.hmcl.auth.OAuth.GrantFlow.DEVICE);
        }).whenComplete(Schedulers.javafx(), (account, exception) -> {
            // 序号对不上说明这次登录已经被取消、或者用户又重新发起了另一次。
            // 无论结果是成功还是失败都丢掉：界面上早就没有它对应的弹窗了。
            if (seq != microsoftLoginSeq) {
                LOG.info("Microsoft login result ignored (cancelled or superseded)");
                // 被 interrupt 打断的任务会把中断标志留在池化线程上，
                // 不清掉的话下一个复用这个线程的任务会一上来就抛 InterruptedException
                Thread.interrupted();
                return;
            }
            if (exception != null) {
                // 用户自己点的取消：不是故障，别弹红字。
                // 前端在点取消时已经把弹窗收掉了，这里再推一条「登录失败」只会让人以为出错了。
                if (isCancellation(exception)) {
                    LOG.info("Microsoft login cancelled by user");
                    return;
                }
                LOG.warning("Microsoft login failed", exception);
                pushLogin("microsoft", false, localize(exception));
                return;
            }
            try {
                completeLogin((Account) account);
                pushLogin("microsoft", true, account.getProfileName());
            } catch (Exception e) {
                pushLogin("microsoft", false, String.valueOf(e));
            }
        }).start();
    }


    /// 每次登录分配一个序号。取消或重新发起后，旧的那次跑完时序号对不上，
    /// 结果直接丢弃——否则被取消的登录只要在浏览器里授权成功，账号照样会冒出来。
    private volatile int microsoftLoginSeq = 0;

    /// 正在跑设备码轮询的线程，取消时用来 interrupt。
    private volatile Thread microsoftLoginThread = null;

    /// 用户主动取消微软登录。
    ///
    /// 两件事一起做：置标志（让下一片 sleep 退出）+ interrupt（让当前这一片立刻退出）。
    /// 只置标志的话，取消动作要等最多一个分片才生效；只 interrupt 的话，
    /// 如果线程正好卡在 HTTP 请求里，中断不一定会被理会，标志能兜住。
    public void cancelMicrosoftLogin() {
        Accounts.OAUTH_CALLBACK.cancel();
        // 序号 +1 把这次登录「作废」，之后再回来的结果都不会被采纳
        ++microsoftLoginSeq;
        Thread t = microsoftLoginThread;
        if (t != null) {
            t.interrupt();
        }
        LOG.info("Microsoft login cancelled by user");
    }

    /// 判断异常链里是不是「用户取消」。
    private static boolean isCancellation(Throwable throwable) {
        Throwable t = throwable;
        // 上限 8 层：正常异常链不会更深，加个上限是防止某个实现把 cause 指回自己
        for (int i = 0; t != null && i < 8; i++) {
            if (t instanceof OperationCancelledException) {
                return true;
            }
            Throwable cause = t.getCause();
            if (cause == t) {
                break;
            }
            t = cause;
        }
        return false;
    }

    /// 设备码流程的「用户码 / 验证地址」只有注册了监听才拿得到。
    ///
    /// HMCL 是在 `MicrosoftAccountLoginPane` 里注册的，壳模式根本不会创建那个面板，
    /// 于是 `grantDeviceCode` 事件没有订阅者：前端永远停在「正在申请登录代码…」，
    /// 后台却已经进到 15 分钟的轮询里——看起来就是「点了没反应、整个卡住」。
    ///
    /// EventManager 只支持注册、没有反注册，所以这里用一个实例标记保证只装一次。
    private boolean microsoftHookInstalled = false;

    private void hookMicrosoftDeviceCode() {
        if (microsoftHookInstalled) {
            return;
        }
        microsoftHookInstalled = true;
        Accounts.OAUTH_CALLBACK.onGrantDeviceCode.register(event -> {
            JsonObject json = new JsonObject();
            json.addProperty("flow", "microsoft");
            json.addProperty("code", event.getUserCode());
            json.addProperty("url", event.getVerificationUri());
            host.execute("window.__hmcl && window.__hmcl.onMicrosoftCode("
                    + JsonUtils.GSON.toJson(json.toString()) + ")");
        });
        Accounts.OAUTH_CALLBACK.onLoginCompletedDeviceCode.register(event ->
                pushLoginStage("microsoft", "已授权，正在获取角色信息…"));
    }

    /// 外置认证（authlib-injector / 皮肤站）登录。
    public void loginAuthlib(String serverUrl, String username, String password) {
        if (serverUrl == null || serverUrl.isBlank()) {
            pushLogin("authlib", false, "请先选择一个皮肤站");
            return;
        }
        if (username == null || username.isBlank() || password == null || password.isEmpty()) {
            pushLogin("authlib", false, "请填写邮箱/用户名和密码");
            return;
        }

        AuthlibInjectorServer server = findAuthlibServer(serverUrl);
        if (server == null) {
            pushLogin("authlib", false, "皮肤站不存在，请先在列表里添加：" + serverUrl);
            return;
        }

        pushLoginStage("authlib", "正在向 " + server.getName() + " 验证…");

        String user = username.trim();
        Task.runAsync(() -> {
            try {
                Account account = Accounts.FACTORY_AUTHLIB_INJECTOR.create(
                        new AutoCharacterSelector(), user, password, null, server);
                completeLogin(account);
                pushLogin("authlib", true, account.getProfileName());
            } catch (Throwable e) {
                LOG.warning("Authlib login failed", e);
                pushLogin("authlib", false, localize(e));
            }
        }).start();
    }

    /// 按 URL 在已添加的皮肤站里找（忽略结尾斜杠的差异）。
    @Nullable
    private static AuthlibInjectorServer findAuthlibServer(String url) {
        String target = url.trim();
        while (target.endsWith("/")) {
            target = target.substring(0, target.length() - 1);
        }
        try {
            for (AuthlibInjectorServer server : SettingsManager.getAuthlibInjectorServers()) {
                String current = server.getUrl();
                while (current.endsWith("/")) {
                    current = current.substring(0, current.length() - 1);
                }
                if (current.equalsIgnoreCase(target)) {
                    return server;
                }
            }
        } catch (Exception e) {
            LOG.warning("Failed to look up authlib server", e);
        }
        return null;
    }

    /// 把异常翻成能给人看的一句话（带账号相关的本地化文案）。
    private static String localize(Throwable t) {
        if (t instanceof Exception e) {
            try {
                return Accounts.localizeErrorMessage(e);
            } catch (Exception ignored) {
                // 落到下面
            }
        }
        return t.getMessage() != null ? t.getMessage() : t.getClass().getSimpleName();
    }

    /// 探一个 URL，返回「是否成功 / 字节数 / 耗时 / 头部片段」。
    ///
    /// 用来判断哪些站点的接口在当前网络下能直接访问。
    /// 拿不到状态码（HMCL 的 HttpRequest 对非 2xx 直接抛异常），
    /// 所以失败时把异常消息一并带出来，里面含 HTTP 码。
    public String probeUrl(String url) {
        long t0 = System.currentTimeMillis();
        try {
            String body = org.jackhuang.hmcl.util.io.HttpRequest.GET(url)
                    .header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
                    .header("Accept-Language", "zh-CN,zh;q=0.9,en;q=0.8")
                    .getString();
            String head = body.length() > 160 ? body.substring(0, 160) : body;
            return "OK | " + body.length() + "B | " + (System.currentTimeMillis() - t0) + "ms | "
                    + head.replaceAll("[\r\n]+", " ");
        } catch (Exception e) {
            return "ERR | " + (System.currentTimeMillis() - t0) + "ms | "
                    + e.getClass().getSimpleName() + ": " + e.getMessage();
        }
    }

    /// 前端打开外置认证弹窗时调一次，把列表推回去
    public void requestAuthlibServers() {
        pushAuthlibServers(true, null);
    }

    /// 当前可选的皮肤站列表。LittleSkin 由 HMCL 的 AuthlibInjectorServerList 内置。
    public String authlibServers() {
        JsonArray array = new JsonArray();
        try {
            for (AuthlibInjectorServer server : SettingsManager.getAuthlibInjectorServers()) {
                JsonObject o = new JsonObject();
                o.addProperty("url", server.getUrl());
                o.addProperty("name", server.getName());
                o.addProperty("host", server.getDisplayHostUrl());
                o.addProperty("nonEmailLogin", server.isNonEmailLogin());
                o.addProperty("builtin", server.getUrl().startsWith(
                        org.jackhuang.hmcl.setting.AuthlibInjectorServerList.LITTLE_SKIN_URL));
                array.add(o);
            }
        } catch (Exception e) {
            LOG.warning("Failed to list authlib servers", e);
        }
        return JsonUtils.GSON.toJson(array);
    }

    /// 添加自定义皮肤站。
    ///
    /// 只让用户填 API 根地址——名字和是否支持非邮箱登录都是从
    /// `<url>/authlib-injector` 那串元数据里读出来的，手填容易和实际对不上。
    /// `locateServer` 是同步网络请求，必须在后台线程跑。
    public void addAuthlibServer(String url) {
        if (url == null || url.isBlank()) {
            pushAuthlibServers(false, "请填写皮肤站 API 地址");
            return;
        }
        String target = url.trim();
        Task.runAsync(() -> {
            try {
                AuthlibInjectorServer server = AuthlibInjectorServer.locateServer(target);
                // 同地址不重复加
                for (AuthlibInjectorServer existing : SettingsManager.getAuthlibInjectorServers()) {
                    if (existing.getUrl().equalsIgnoreCase(server.getUrl())) {
                        pushAuthlibServers(true, null);
                        return;
                    }
                }
                if (SettingsManager.isAuthlibInjectorServersReadOnly()) {
                    SettingsManager.forceOverwriteAuthlibInjectorServers();
                }
                SettingsManager.getAuthlibInjectorServers().add(server);
                pushAuthlibServers(true, null);
            } catch (Throwable e) {
                LOG.warning("Failed to add authlib server " + target, e);
                pushAuthlibServers(false, "连不上这个皮肤站，确认地址是 yggdrasil API 根路径");
            }
        }).start();
    }

    /// 移除自定义皮肤站（内置的 LittleSkin 不给删）。
    public void removeAuthlibServer(String url) {
        if (url == null || url.isBlank()) {
            return;
        }
        try {
            if (SettingsManager.isAuthlibInjectorServersReadOnly()) {
                SettingsManager.forceOverwriteAuthlibInjectorServers();
            }
            SettingsManager.getAuthlibInjectorServers().removeIf(
                    s -> s.getUrl().equalsIgnoreCase(url));
        } catch (Exception e) {
            LOG.warning("Failed to remove authlib server " + url, e);
        }
        pushAuthlibServers(true, null);
    }

    /// 账号加入列表 + 选中 + 推状态。三条登录路径共用。
    private void completeLogin(Account account) {
        Platform.runLater(() -> {
            try {
                if (!Accounts.getAccounts().contains(account)) {
                    Accounts.getAccounts().add(account);
                }
                Accounts.setSelectedAccount(account);
                host.pushState();
            } catch (Exception e) {
                LOG.warning("Failed to register account", e);
            }
        });
    }

    private void pushLogin(String flow, boolean ok, String message) {
        JsonObject json = new JsonObject();
        json.addProperty("flow", flow);
        json.addProperty("ok", ok);
        json.addProperty("message", message == null ? "" : message);
        host.execute("window.__hmcl && window.__hmcl.onLoginResult("
                + JsonUtils.GSON.toJson(json.toString()) + ")");
    }

    private void pushLoginStage(String flow, String stage) {
        JsonObject json = new JsonObject();
        json.addProperty("flow", flow);
        json.addProperty("stage", stage);
        host.execute("window.__hmcl && window.__hmcl.onLoginStage("
                + JsonUtils.GSON.toJson(json.toString()) + ")");
    }

    private void pushAuthlibServers(boolean ok, @Nullable String error) {
        JsonObject json = new JsonObject();
        json.addProperty("ok", ok);
        json.addProperty("error", error);
        json.addProperty("servers", authlibServers());
        host.execute("window.__hmcl && window.__hmcl.onAuthlibServers("
                + JsonUtils.GSON.toJson(json.toString()) + ")");
    }

    /// 角色选择器：外置认证账号可能有多个角色。
    ///
    /// HMCL 会弹窗让用户选；壳里为了不把登录流程切成两段，先自动取第一个。
    /// 只有一个角色的情况是绝大多数，多角色的少数派可以在启动器外改。
    private static final class AutoCharacterSelector implements CharacterSelector {
        @Override
        public GameProfile select(org.jackhuang.hmcl.auth.yggdrasil.YggdrasilService service,
                                  List<GameProfile> profiles) throws NoSelectedCharacterException {
            if (profiles == null || profiles.isEmpty()) {
                throw new NoSelectedCharacterException();
            }
            if (profiles.size() > 1) {
                LOG.info("Account has " + profiles.size() + " characters, using the first: "
                        + profiles.get(0).getName());
            }
            return profiles.get(0);
        }
    }

    public void selectAccount(String uuid) {
        for (Account account : Accounts.getAccounts()) {
            if (account.getAccountID().toString().equals(uuid)) {
                // 换了账号，上一个账号的草稿必须丢掉，否则会把 A 的选择带进 B
                onAccountSwitched.run();
                Accounts.setSelectedAccount(account);
                host.pushState();
                return;
            }
        }
    }

    /// 离线账号改名。
    ///
    /// 离线账号的 UUID 是「OfflinePlayer:<名字>」算出来的，改名字等于换一个人，
    /// 所以这里不是原地改字段，而是「建新的 + 替换旧的」。名字非法时直接拒绝，
    /// 校验规则同 HMCL（`^[A-Za-z0-9_]+$`，≤16 字符）。
    public void renameAccount(String uuid, String newName) {
        String name = newName == null ? "" : newName.trim();
        if (!isValidProfileName(name)) {
            host.toast("用户名只能用英文字母、数字和下划线，且不超过 16 个字符");
            return;
        }
        Account target = null;
        for (Account account : Accounts.getAccounts()) {
            if (account.getAccountID().toString().equals(uuid)) {
                target = account;
                break;
            }
        }
        if (target == null) {
            return;
        }
        if (!(target instanceof org.jackhuang.hmcl.auth.offline.OfflineAccount)) {
            host.toast("只有离线账号支持改名");
            return;
        }
        if (WebBridge.displayName(target).equals(name)) {
            return;
        }

        Account old = target;
        boolean wasSelected = Objects.equals(Accounts.getSelectedAccount(), old);
        Task.runAsync(() -> {
            try {
                Account renamed = Accounts.FACTORY_OFFLINE.create(
                        new AutoCharacterSelector(), name, "", null, null);
                // 外观状态是按 accountID 存的，改名前先把它挪到新 id 上，
                // 否则用户会发现「改个名字皮肤没了」
                AppearanceStore.getInstance().moveState(old.getAccountID().toString(),
                        renamed.getAccountID().toString());

                int index = Accounts.getAccounts().indexOf(old);
                Accounts.getAccounts().remove(old);
                if (index >= 0 && index <= Accounts.getAccounts().size()) {
                    Accounts.getAccounts().add(index, renamed);
                } else {
                    Accounts.getAccounts().add(renamed);
                }
                if (wasSelected) {
                    Accounts.setSelectedAccount(renamed);
                }
                host.pushState();
                host.toast("已改名为 " + name);
            } catch (Throwable e) {
                LOG.warning("Failed to rename account", e);
                host.toast("改名失败：" + localize(e));
            }
        }).start();
    }

    /// 复制文本到系统剪贴板。
    ///
    /// 不用前端的 navigator.clipboard：WebView2 里 tauri.localhost 属于非安全上下文，
    /// 剪贴板写权限要看权限策略，实测时好时坏。走 Java 侧一次就稳。
    public void copyText(String text) {
        if (text == null || text.isBlank()) {
            return;
        }
        try {
            org.jackhuang.hmcl.ui.FXUtils.copyText(text, "已复制到剪贴板");
        } catch (Exception e) {
            LOG.warning("Failed to copy text", e);
        }
    }

    /// 用户名合法性：和 HMCL 的离线登录校验一致（CreateAccountPane.USERNAME_CHECKER_PATTERN）
    private static boolean isValidProfileName(String name) {
        return name != null && !name.isEmpty() && name.length() <= 16
                && name.matches("^[A-Za-z0-9_]+$");
    }

    public void removeAccount(String uuid) {
        Account target = null;
        for (Account account : Accounts.getAccounts()) {
            if (account.getAccountID().toString().equals(uuid)) {
                target = account;
                break;
            }
        }
        if (target == null) {
            return;
        }
        Account account = target;
        if (Accounts.canRemoveAccount(account)) {
            Accounts.getAccounts().remove(account);
            host.pushState();
        } else {
            Accounts.getAccounts().remove(account);
            host.pushState();
        }
    }

}
