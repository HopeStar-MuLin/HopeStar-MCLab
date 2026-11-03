/*
 * Hello Minecraft! Launcher
 * Copyright (C) 2020  huangyuhui <huanghongxun2008@126.com> and contributors
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
package org.jackhuang.hmcl.download.optifine;

import org.jackhuang.hmcl.download.*;
import org.jackhuang.hmcl.download.game.GameDownloadTask;
import org.jackhuang.hmcl.game.GameComponentType;
import org.jackhuang.hmcl.game.GameInstanceManifest;
import org.jackhuang.hmcl.game.GameInstancePatch;
import org.jackhuang.hmcl.task.GetTask;
import org.jackhuang.hmcl.task.Task;
import org.jackhuang.hmcl.util.StringUtils;
import org.jackhuang.hmcl.util.gson.JsonSerializable;
import org.jackhuang.hmcl.util.gson.JsonUtils;
import org.jackhuang.hmcl.util.versioning.GameVersionNumber;
import org.jetbrains.annotations.NotNullByDefault;
import org.jetbrains.annotations.Nullable;

import java.nio.file.Path;
import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.ZoneId;
import java.util.*;

import static org.jackhuang.hmcl.util.gson.JsonUtils.listTypeOf;

@NotNullByDefault
public final class OptiFineRemoteVersion extends ComponentRemoteVersion {

    private static String toLookupVersion(String version) {
        return switch (version) {
            case "1.8" -> "1.8.0";
            case "1.9" -> "1.9.0";
            default -> version;
        };
    }

    private static String fromLookupVersion(String version) {
        return switch (version) {
            case "1.8.0" -> "1.8";
            case "1.9.0" -> "1.9";
            default -> version;
        };
    }

    /// BMCLAPI 的 OptiFine 列表里带 `date`（`yyyy-MM-dd`，个别镜像会带时分秒）。
    ///
    /// <p>这是版本发布时间，版本选择窗要显示它。上游原来把这个字段读进来又丢掉，
    /// 所以 OptiFine 的列表里永远只有版本号。解析失败就返回 null —— 那是镜像格式
    /// 变了，不该因此让整个列表加载失败。
    private static @Nullable Instant parseReleaseDate(@Nullable String text) {
        if (text == null || text.isBlank()) {
            return null;
        }
        String value = text.trim();
        try {
            if (value.length() <= 10) {
                return LocalDate.parse(value).atStartOfDay(ZoneId.systemDefault()).toInstant();
            }
            return LocalDateTime.parse(value.replace(' ', 'T'))
                    .atZone(ZoneId.systemDefault()).toInstant();
        } catch (Exception e) {
            return null;
        }
    }

    public static Task<ComponentRemoteVersionList<OptiFineRemoteVersion>> fetchBMCLAsync(DownloadProvider downloadProvider, String bmclRoot, GameVersionNumber gameVersion) {
        @JsonSerializable
        record OptiFineVersion(String dl, String ver,
                               String date, String type,
                               @Nullable String patch, String mirror,
                               String mcversion) {
        }

        return new GetTask(DownloadCandidates.of(bmclRoot + "/optifine/" + toLookupVersion(gameVersion.toNormalizedString()))).thenApplyAsync(result -> {
            var root = JsonUtils.fromNonNullJson(result, listTypeOf(OptiFineVersion.class));

            var versions = new TreeSet<OptiFineRemoteVersion>();
            Set<String> duplicates = new HashSet<>();
            for (OptiFineVersion element : root) {
                String version = element.type() + "_" + element.patch();
                String mirror = bmclRoot + "/optifine/" + toLookupVersion(element.mcversion()) + "/" + element.type() + "/" + element.patch();
                if (!duplicates.add(mirror))
                    continue;

                boolean isPre = element.patch() != null && (element.patch().startsWith("pre") || element.patch().startsWith("alpha"));

                if (StringUtils.isBlank(element.mcversion()))
                    continue;

                versions.add(new OptiFineRemoteVersion(gameVersion, version, List.of(mirror), isPre,
                        parseReleaseDate(element.date())));
            }

            return ComponentRemoteVersionList.of(GameComponentType.OPTIFINE, versions);
        });

    }

    private final String fullVersion;

    public OptiFineRemoteVersion(GameVersionNumber gameVersion, String selfVersion, List<String> urls,
                                 boolean snapshot) {
        this(gameVersion, selfVersion, urls, snapshot, null);
    }

    public OptiFineRemoteVersion(GameVersionNumber gameVersion, String selfVersion, List<String> urls,
                                 boolean snapshot, @Nullable Instant releaseDate) {
        super(GameComponentType.OPTIFINE, gameVersion, selfVersion, releaseDate,
                snapshot ? Type.SNAPSHOT : Type.RELEASE, urls);
        this.fullVersion = getGameVersion() + "_" + getSelfVersion();
    }

    @Override
    public String getFullVersion() {
        return fullVersion;
    }

    @Override
    public Task<GameInstancePatch> getInstallTask(DefaultDependencyManager dependencyManager, GameInstanceManifest
            baseManifest, Path modsDirectory) {
        return new GameDownloadTask(dependencyManager, baseManifest)
                .thenComposeAsync(minecraftJar -> new OptiFineInstallTask(
                        dependencyManager,
                        baseManifest,
                        this,
                        minecraftJar));
    }
}
