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

import java.util.concurrent.Callable;

import static org.jackhuang.hmcl.util.logging.Logger.LOG;

/// 同步网络请求的重试。
///
/// <p>只在**抛异常**时重试：超时、连接重置、5xx 这类是暂时性的，隔几百毫秒
/// 再来一次往往就好了。成功的空结果不重试 —— 「这个项目没有这个版本」是事实，
/// 重试三次只是让用户多等三倍时间，还会把「确实没有」和「连不上」搅在一起。
///
/// <p>异步路径（{@link DownloadService} 那套 Task）用的是另一套基于
/// `PauseTransition` 的重试，因为那边必须回到 FX 线程才能续跑。两者行为一致：
/// 轮数固定、间隔递增、最后一轮失败才把异常交出去。
@NotNullByDefault
final class NetRetry {

    private NetRetry() {
    }

    /// 默认三轮。第一轮失败后等 400ms，第二轮后等 900ms。
    static final int DEFAULT_ATTEMPTS = 3;

    /// 跑一个可能失败的网络请求，失败重试。
    ///
    /// @param what   日志里的名字，出问题时能看出重试的是哪一趟
    /// @param action 真正干活的那段
    static <T> T call(String what, Callable<T> action) throws Exception {
        return call(what, DEFAULT_ATTEMPTS, action);
    }

    static <T> T call(String what, int attempts, Callable<T> action) throws Exception {
        Exception last = null;
        for (int round = 1; round <= Math.max(1, attempts); round++) {
            try {
                return action.call();
            } catch (Exception e) {
                last = e;
                if (round >= attempts) {
                    break;
                }
                LOG.info("[retry] " + what + " 第 " + round + " 次失败，重试：" + e);
                try {
                    Thread.sleep(400L * round);
                } catch (InterruptedException interrupted) {
                    Thread.currentThread().interrupt();
                    throw interrupted;
                }
            }
        }
        throw last == null ? new IllegalStateException(what + " 没有执行") : last;
    }
}
