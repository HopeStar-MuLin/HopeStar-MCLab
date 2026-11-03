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

import org.jetbrains.annotations.NotNullByDefault;
import org.jetbrains.annotations.Nullable;

import java.lang.reflect.Method;
import java.lang.reflect.Modifier;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/// JS -> Java 的方法表。
///
/// <p>原先 [WebHttpServer] 只反射 [WebBridge] 一个对象，于是所有桥接方法都必须长在
/// 那一个类里（5700+ 行）。这里改成「可以登记多个对象」，新功能写一个独立的 `*Api` 类
/// 再登记进来即可，不必往 WebBridge 里再塞几百行。
///
/// <p>只收 public、非 static、非 Object 自带、参数类型在 [#isSupported] 白名单内的方法。
/// 重名时保留先登记的那个，并把冲突记进 [#conflicts]。
///
/// <p>为什么不再直接抛异常：原来是「启动即失败」，开发期很容易发现问题——但代价太大。
/// 新增一个方法和已有的重名，`WebHttpServer.setBridge` 抛出去之后 HTTP 服务整个起不来，
/// 用户看到的是「界面在，什么都点不动」（版本清单永远停在「正在拉取」）。现在改成
/// 保留先登记的、跳过后来的，只坏掉冲突的那一个接口。启动日志里带 `CONFLICT` 前缀，
/// 自检也会读它。
@NotNullByDefault
final class ApiRegistry {

    /// 一条可调用的接口：方法 + 它所属的桥对象。
    record Endpoint(Object target, Method method) {
    }

    private final Map<String, Endpoint> endpoints = new LinkedHashMap<>();

    /// 重名冲突：`方法名 <- A 与 B（保留 A）`。启动时打日志用。
    private final List<String> conflicts = new ArrayList<>();

    /// 登记一个桥对象的全部公开方法。重名的跳过（先登记的留下）。
    void register(Object target) {
        for (Method m : target.getClass().getMethods()) {
            if (Modifier.isStatic(m.getModifiers())) continue;
            if (m.isSynthetic() || m.isBridge()) continue;
            if (m.getDeclaringClass() == Object.class) continue;
            // 上限 12。`addonSearch` 有 9 个参数（type/gameVersion/query/page/
            // sort/loader/category/reqId/source），卡在 8 的时候整个方法没进表，
            // 前端每次搜索都 404 —— 表现就是「切到 CurseForge 一条结果都没有」。
            if (m.getParameterCount() > 12) continue;

            boolean supported = true;
            for (Class<?> type : m.getParameterTypes()) {
                if (!isSupported(type)) {
                    supported = false;
                    break;
                }
            }
            if (!supported) continue;

            Endpoint existing = endpoints.get(m.getName());
            if (existing != null && !existing.method().equals(m)) {
                conflicts.add(m.getName() + " <- " + existing.target().getClass().getSimpleName()
                        + " 与 " + target.getClass().getSimpleName() + "（保留前者）");
                continue;
            }
            endpoints.put(m.getName(), new Endpoint(target, m));
        }
    }

    /// 注册期间的冲突清单，空表示没有。
    List<String> conflicts() {
        return List.copyOf(conflicts);
    }

    /// 按名字找一条接口，没有就返回 `null`。
    @Nullable
    Endpoint find(String name) {
        return endpoints.get(name);
    }

    /// 已登记的接口数量（启动时打日志用）。
    int size() {
        return endpoints.size();
    }

    /// 已登记的方法名快照，顺序即登记顺序。
    Set<String> names() {
        return Set.copyOf(endpoints.keySet());
    }

    /// HTTP 参数只支持能无损从 JSON 标量转过来的类型。
    static boolean isSupported(Class<?> type) {
        return type == String.class
                || type == int.class || type == Integer.class
                || type == long.class || type == Long.class
                || type == double.class || type == Double.class
                || type == float.class || type == Float.class
                || type == boolean.class || type == Boolean.class;
    }
}
