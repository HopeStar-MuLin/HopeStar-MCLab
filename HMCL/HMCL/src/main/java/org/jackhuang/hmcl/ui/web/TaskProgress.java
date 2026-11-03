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
import javafx.application.Platform;
import org.jackhuang.hmcl.task.Task;
import org.jackhuang.hmcl.task.TaskExecutor;
import org.jackhuang.hmcl.task.TaskListener;
import org.jackhuang.hmcl.util.gson.JsonUtils;

import java.util.concurrent.atomic.AtomicReference;
import java.util.function.Consumer;

import static org.jackhuang.hmcl.util.logging.Logger.LOG;

/// 任务进度的唯一出口。
///
/// <p>前端右上角那条「下载任务」列表只认 `onInstallStage` 这一种事件，
/// 但发事件的地方有五六个（装模组、装整合包、补文件、导出、装 Java…）。
/// 以前每个服务各抄一份 `attachProgress` + `pushStage`，改一次字段要改五六处；
/// 这里收成一份，谁要推进度就持有它。
final class TaskProgress {

    private final Consumer<String> push;

    TaskProgress(Consumer<String> push) {
        this.push = push;
    }

    /// 把任务的子任务进度、失败原因接到这条通道上。
    ///
    /// @return 一个会被填充为「第一个失败原因」的容器；任务结束后用它给用户一句人话
    AtomicReference<Throwable> attach(Task<?> task, String taskId) {
        AtomicReference<Throwable> lastError = new AtomicReference<>();
        TaskExecutor executor = task.executor();
        executor.addTaskListener(new TaskListener() {
            @Override
            public void onFailed(Task<?> sub, Throwable throwable) {
                lastError.compareAndSet(null, throwable);
            }

            @Override
            public void onRunning(Task<?> sub) {
                String stage = shorten(sub.getName());
                if (!stage.isEmpty()) {
                    stage(taskId, stage, false, null, -1);
                }
                try {
                    sub.progressProperty().addListener((obs, oldValue, newValue) -> {
                        double p = newValue.doubleValue();
                        if (p >= 0 && p <= 1) {
                            stage(taskId, stage, false, null, p);
                        }
                    });
                } catch (Exception ignored) {
                    // 挂不上进度不影响任务本身
                }
            }
        });
        return lastError;
    }

    /// 启动任务并把结果收尾（失败报错、成功回调、最后推 done）。
    void run(Task<?> task, String taskId, Runnable onSuccess) {
        AtomicReference<Throwable> lastError = attach(task, taskId);

        task.onDone().register(event -> Platform.runLater(() -> {
            if (event.isFailed()) {
                Throwable cause = lastError.get();
                stage(taskId, "失败：" + (cause != null ? cause : "未知错误"),
                        true, String.valueOf(cause), -1);
                return;
            }
            if (onSuccess != null) {
                try {
                    onSuccess.run();
                } catch (Exception e) {
                    // 任务本身成功但产物不对（镜像返回 200 + 错误页），不能算完成
                    stage(taskId, "失败：" + e.getMessage(), true, String.valueOf(e), -1);
                    return;
                }
            }
            stage(taskId, "完成", true, null, 1);
        }));

        task.executor().start();
    }

    /// 推一条进度。`done = true` 表示这条任务结束（前端会把它从列表里摘掉）。
    void stage(String id, String text, boolean done, String error, double percent) {
        JsonObject json = new JsonObject();
        json.addProperty("id", id);
        json.addProperty("stage", text);
        json.addProperty("done", done);
        json.addProperty("error", error);
        json.addProperty("kind", "install");
        json.addProperty("percent", percent);
        LOG.info("[task] " + (id == null ? "-" : id) + " | " + text
                + (done ? " | done" : "") + (error == null ? "" : " | " + error));
        Platform.runLater(() -> push.accept("window.__hmcl && window.__hmcl.onInstallStage("
                + JsonUtils.GSON.toJson(JsonUtils.GSON.toJson(json)) + ")"));
    }

    /// 失败任务的 name 常常是整段堆栈，推给前端前只留第一行再限长。
    static String shorten(String raw) {
        if (raw == null) {
            return "";
        }
        String text = raw.strip();
        int newline = text.indexOf('\n');
        if (newline > 0) {
            text = text.substring(0, newline).strip();
        }
        return text.length() > 160 ? text.substring(0, 160) + "…" : text;
    }
}
