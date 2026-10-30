import io

p = 'DownloadService.java'
s = io.open(p, encoding='utf-8').read()

old_block = '''                TaskExecutor executor = buildTask.executor();
                executor.addTaskListener(new TaskListener() {
                    @Override
                    public void onRunning(Task<?> task) {
                        final String stage = humanStage(task.getName()) == null ? "" : humanStage(task.getName());
                        if (!stage.isEmpty()) {
                            pushStage(taskId, stage, false, null);
                        }
                        // 子任务自己的进度。HMCL 的 Task.updateProgress 内部已经限流到
                        // 每秒一次，这里直接透传不会打爆 SSE。
                        // 拿不到量化进度时 percent 保持 -1，前端显示不确定动画。
                        try {
                            task.progressProperty().addListener((obs, oldValue, newValue) -> {
                                double p = newValue.doubleValue();
                                if (p >= 0 && p <= 1) {
                                    pushStage(taskId, stage, false, null, p, "install");
                                }
                            });
                        } catch (Exception ignored) {
                            // 进度属性挂不上不影响安装本身
                        }
                    }
                });

                buildTask.onDone().register(event -> Platform.runLater(() -> {
                    if (event.isFailed()) {
                        // TaskEvent 只带 failed 标记，真正的异常在 executor 上
                        Exception cause = executor.getException();
                        pushStage(taskId, "安装失败：" + (cause != null ? cause : "未知错误"),
                                false, String.valueOf(cause));
                        return;
                    }
                    // 装完切成当前实例，首页立刻能看到
                    try {
                        repository.setSelectedInstance(repository.getInstance(instanceId));
                    } catch (Exception e) {
                        LOG.warning("Failed to select the new instance", e);
                    }
                    pushStage(taskId, "安装完成", true, null);
                    // 实例列表变了，让页面重新拉一次状态
                    push.accept("window.__hmcl && window.__hmcl.onInstallFinished("
                            + JsonUtils.GSON.toJson(taskId) + ")");
                }));

                executor.start();'''

new_block = '''                runWithProgress(buildTask, taskId, () -> {
                    // 装完切成当前实例，首页立刻能看到
                    try {
                        repository.setSelectedInstance(repository.getInstance(instanceId));
                    } catch (Exception e) {
                        LOG.warning("Failed to select the new instance", e);
                    }
                });'''

assert old_block in s, 'startBuild block not found'
s = s.replace(old_block, new_block)

marker = '    /// 把内部任务名翻译成人话。'
helper = '''    /// 跑任务并把它接到进度通道上。原版安装、加载器安装、装进现有实例共用这一段。
    private void runWithProgress(Task<?> task, String taskId, @Nullable Runnable onSuccess) {
        TaskExecutor executor = task.executor();
        executor.addTaskListener(new TaskListener() {
            @Override
            public void onRunning(Task<?> sub) {
                final String stage = humanStage(sub.getName());
                if (!stage.isEmpty()) {
                    pushStage(taskId, stage, false, null);
                }
                // 子任务自己的进度。HMCL 的 Task.updateProgress 内部已经限流到每秒一次，
                // 这里直接透传不会打爆 SSE。拿不到量化进度时 percent 保持 -1。
                try {
                    sub.progressProperty().addListener((obs, oldValue, newValue) -> {
                        double p = newValue.doubleValue();
                        if (p >= 0 && p <= 1) {
                            pushStage(taskId, stage, false, null, p, "install");
                        }
                    });
                } catch (Exception ignored) {
                    // 进度属性挂不上不影响安装本身
                }
            }
        });

        task.onDone().register(event -> Platform.runLater(() -> {
            if (event.isFailed()) {
                // TaskEvent 只带 failed 标记，真正的异常在 executor 上
                Exception cause = executor.getException();
                pushStage(taskId, "安装失败：" + (cause != null ? cause : "未知错误"),
                        false, String.valueOf(cause));
                return;
            }
            if (onSuccess != null) {
                onSuccess.run();
            }
            pushStage(taskId, "安装完成", true, null);
            // 实例列表变了，让页面重新拉一次状态
            push.accept("window.__hmcl && window.__hmcl.onInstallFinished("
                    + JsonUtils.GSON.toJson(taskId) + ")");
        }));

        executor.start();
    }

    /// 把加载器装进一个**已有**实例（对应 HMCL 的「安装到现有实例」）。
    ///
    /// 走 `updateInstanceAsync`：先取实例当前 manifest，叠加组件后提交。
    /// 中途失败不会动原实例——草稿只在成功时 commit。
    void installLoaderTo(String instanceId, String gameVersion, String loaderType, String loaderVersion) {
        if (instanceId == null || instanceId.isBlank()
                || loaderType == null || loaderVersion == null) {
            return;
        }

        List<ComponentRemoteVersion> cached = loaderVersions.get(loaderType + "@" + gameVersion);
        ComponentRemoteVersion target = null;
        if (cached != null) {
            for (ComponentRemoteVersion version : cached) {
                if (loaderVersion.equals(version.getSelfVersion())) {
                    target = version;
                    break;
                }
            }
        }
        if (target == null) {
            pushStage(instanceId, "列表里没有 " + loaderType + " " + loaderVersion, false, "unknown loader version");
            return;
        }

        var repository = GameDirectoryManager.getSelectedRepository();
        GameInstanceID id;
        try {
            id = new GameInstanceID(instanceId);
        } catch (Exception e) {
            pushStage(instanceId, "实例 id 不合法：" + instanceId, false, String.valueOf(e));
            return;
        }
        if (repository.findInstance(id) == null) {
            pushStage(instanceId, "找不到实例 " + instanceId, false, "instance not found");
            return;
        }

        pushStage(instanceId, "准备给 " + instanceId + " 装 " + loaderType + " " + loaderVersion + "…", false, null);

        try {
            var dependency = repository.getDependency(DownloadProviders.getDownloadProvider());
            ComponentRemoteVersion loader = target;
            Task<?> task = dependency.updateInstanceAsync(id, instance ->
                    Task.supplyAsync(instance::getResolvedManifest)
                            .thenComposeAsync(manifest ->
                                    dependency.installComponentRemoteAsync(instance, manifest, loader)));

            runWithProgress(task, instanceId, () -> {
                try {
                    repository.setSelectedInstance(repository.getInstance(id));
                } catch (Exception e) {
                    LOG.warning("Failed to select the updated instance", e);
                }
            });
        } catch (Exception e) {
            LOG.warning("Failed to install loader into " + instanceId, e);
            pushStage(instanceId, "安装失败：" + e.getMessage(), false, String.valueOf(e));
        }
    }

    /// 把内部任务名翻译成人话。'''

assert marker in s, 'marker not found'
s = s.replace(marker, helper, 1)

io.open(p, 'w', encoding='utf-8').write(s)
print('patched')
