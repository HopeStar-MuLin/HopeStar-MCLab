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

import javafx.application.Platform;
import javafx.beans.value.ObservableValue;
import javafx.scene.image.Image;
import javafx.scene.image.PixelReader;
import javafx.scene.image.WritableImage;
import org.jackhuang.hmcl.auth.Account;
import org.jackhuang.hmcl.game.TexturesLoader;
import org.jetbrains.annotations.NotNullByDefault;
import org.jetbrains.annotations.Nullable;

import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.function.Supplier;

import static org.jackhuang.hmcl.util.logging.Logger.LOG;

/// 头像：账号卡、账号列表里的那张小脸。
///
/// <p>优先用「外观」页里选中的那张皮肤——用户在衣柜里换了皮肤，左下角账号卡
/// 和账号列表的头像要跟着变，否则一身新皮配一张旧脸。没选（或读不到）才回退到
/// 账号自带的纹理，再不行去磁盘缓存里翻，最后才异步拉网络。
@NotNullByDefault
final class AvatarApi {

    private final BridgeHost host;
    private final AppearanceStore appearance = AppearanceStore.getInstance();

    /// 当前选中账号的 id（外观状态按账号存）
    private final Supplier<String> selectedAccountId;
    /// 当前账号刚拉到的皮肤原图，给「没在外观页选过」的账号兜底
    private final Supplier<Image> currentSkin;

    /// 各账号的头像缓存（accountID -> 皮肤原图）。
    /// 账号列表里每个账号都要一张，不能只缓存当前选中的那个。
    private final Map<String, Image> heads = new ConcurrentHashMap<>();
    private final Set<String> loading = ConcurrentHashMap.newKeySet();
    /// 头像绑定也要持有，否则异步结果回不来
    private final Map<String, ObservableValue<TexturesLoader.LoadedTexture>> bindings = new ConcurrentHashMap<>();

    AvatarApi(BridgeHost host, Supplier<String> selectedAccountId, Supplier<Image> currentSkin) {
        this.host = host;
        this.selectedAccountId = selectedAccountId;
        this.currentSkin = currentSkin;
    }

    /// 头像。优先用「外观」页里选中的那张皮肤——用户在衣柜里换了皮肤，
    /// 左下角账号卡和账号列表的头像要跟着变，否则一身新皮配一张旧脸。
    /// 没选（或读不到）才回退到账号自带的纹理。
    /// 没有账号时的头像：内置的 Steve 皮肤。
    ///
    /// 以前这里返回 null，前端退回一个紫色渐变色块——未登录时账号页和左下角
    /// 各挂着一块突兀的紫色方块。现在统一用 Steve 的头，视觉上就是「一个默认皮肤」。
    String defaultAvatarDataUrl() {
        try {
            return ImageCodec.toDataUrl(headImage(TexturesLoader.getDefaultSkinImage()), 64);
        } catch (Exception e) {
            LOG.warning("Failed to render default avatar", e);
            return null;
        }
    }

    String avatarDataUrl(Account account) {
        // 必须按「这个账号自己」的外观状态取，不能用当前选中的账号——
        // 否则账号列表里所有头像都会变成当前账号的皮肤（切一次账号串一次）。
        String id = account.getAccountID().toString();
        Image fromAppearance = appearanceSkin(id);
        if (fromAppearance != null) {
            return ImageCodec.toDataUrl(headImage(fromAppearance), 64);
        }

        // 当前账号的纹理绑定已经挂着了，直接用它的结果
        String selectedId = selectedAccountId.get();
        if (id.equals(selectedId) && currentSkin.get() != null) {
            return ImageCodec.toDataUrl(headImage(currentSkin.get()), 64);
        }

        Image cached = heads.get(id);
        if (cached == null) {
            // 内存没有就看磁盘。这一步是同步的，但只是读一张 64×64 的 PNG，
            // 换来的是「首帧就是真实头像」——不然列表里会先闪一下兜底皮肤。
            AccountTextureCache.Cached disk = AccountTextureCache.getInstance().load(id);
            if (disk != null && disk.skin() != null) {
                cached = disk.skin();
                heads.put(id, cached);
            }
        }
        if (cached != null) {
            return ImageCodec.toDataUrl(headImage(cached), 64);
        }

        // 磁盘也没有，才去拉网络。以前这里每次调用都新建一个绑定、取一次 getValue()：
        // 拿到的是「还没加载完」的兜底皮肤，而且每渲染一次界面就重下一遍纹理。
        loadAccountHead(account);
        return null;
    }

    /// 异步加载某个账号的头像纹理，到货后存缓存并重推一次界面。
    private void loadAccountHead(Account account) {
        String id = account.getAccountID().toString();
        if (!loading.add(id)) {
            return; // 已经在拉了
        }
        try {
            ObservableValue<TexturesLoader.LoadedTexture> binding = TexturesLoader.skinBinding(account);
            TexturesLoader.LoadedTexture immediate = binding.getValue();
            if (immediate != null && immediate.image() != null) {
                heads.put(id, immediate.image());
                loading.remove(id);
                return;
            }
            binding.addListener((obs, before, after) -> {
                loading.remove(id);
                if (after == null || after.image() == null) {
                    return;
                }
                heads.put(id, after.image());
                // 顺手补进磁盘缓存：下次启动这个账号的头像就不用等网络了
                AccountTextureCache.getInstance().storeSkin(
                        id, after.image(), "slim".equals(after.metadata().get("model")));
                Platform.runLater(host::pushState);
            });
            // 绑定不放字段会被 GC，异步加载结果就回不来了
            bindings.put(id, binding);
        } catch (Exception e) {
            loading.remove(id);
            LOG.warning("Failed to load account head for " + id, e);
        }
    }

    /// 账号当前选中的外观皮肤（没有就返回 null）
    private @Nullable Image appearanceSkin(String accountId) {
        try {
            String id = appearance.stateOf(accountId).getSkin();
            if (id == null || id.isBlank()) {
                return null;
            }
            for (AppearanceStore.Asset asset : appearance.list(AppearanceStore.Kind.SKIN)) {
                if (id.equals(asset.getId())) {
                    return appearance.image(AppearanceStore.Kind.SKIN, asset);
                }
            }
        } catch (Exception e) {
            LOG.warning("Failed to read appearance skin", e);
        }
        return null;
    }

    /// 从 64×64 皮肤里截 8×8 的脸部（含帽子层叠加）
    private static Image headImage(Image skin) {
        int unit = Math.max(1, (int) skin.getWidth() / 64);
        int size = 8 * unit;
        WritableImage out = new WritableImage(size, size);
        PixelReader reader = skin.getPixelReader();
        if (reader == null) {
            return out;
        }
        for (int y = 0; y < size; y++) {
            for (int x = 0; x < size; x++) {
                int face = reader.getArgb(8 * unit + x, 8 * unit + y);
                int hat = unit * 40 + 8 <= skin.getWidth()
                        ? reader.getArgb(40 * unit + x, 8 * unit + y)
                        : 0;
                int alpha = (hat >>> 24) & 0xFF;
                out.getPixelWriter().setArgb(x, y, alpha > 0 ? hat : face);
            }
        }
        return out;
    }

}
