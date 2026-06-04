# D1 健壮性审查报告

**分支**: `feat-integration-pi-extension` (main...HEAD)  
**审查范围**: `resources/` + `src-electron/resources/`  
**变更摘要**: 52 文件，+11 行，-10929 行。主要是将 `src-electron/resources/pi/agent/extensions/` 下的 7 个扩展（goal/hooks/subagent/todo/usage-tracker/workflow + shared/logger）删除（已迁移至外部 repo `xyz-pi-extensions`）。`resources/` 下的 3 个运行时插件有少量改动。

---

## 问题列表

### MUST_FIX

#### M1. Bridge 事件处理中 `throw e` 可能导致扩展宿主崩溃

- **文件**: `resources/pi/agent/extensions/bridge/index.ts`  
- **行号**: ~62, ~71 (diff 中 `+throw e` 两处)
- **描述**: 在 `api.on(evt, ...)` 事件回调和 `api.on('extension_ui_response', ...)` 回调中，catch 块里 `console.error` 之后又 `throw e`。Pi 扩展的事件回调中未捕获的异常会传播到事件总线，可能导致整个扩展崩溃或进程中止。原代码是 `catch (e) { console.error(...) }` 不抛出，这是有意为之——事件转发失败不应中断扩展。  
- **修复方向**: 移除两处 `throw e`。事件转发的失败应静默降级（log 即可），不应级联到宿主。若确实需要通知上层，考虑 `api.emit('error', ...)` 等安全通道。

#### M2. Statusline 插件中 `throw err` 可能导致 Worker Thread 崩溃

- **文件**: `resources/plugins/statusline/index.ts`  
- **行号**: ~70 (diff 中 `+throw err`)
- **描述**: `hooks.onPiEvent` 回调中 catch 块加了 `throw err`。此插件运行在 Worker Thread（`plugin-bootstrap.ts`）中，未捕获异常会导致 Worker 直接退出，后续所有 hook 调用全部丢失。statusline 是被动监听型插件，更新失败不应终止整个插件。  
- **修复方向**: 移除 `throw err`。如需上报错误，使用 `context.api.ui.updateStatusBarItem('error', ...)` 或仅 log。

### LOW

#### L1. Bridge 同步循环缺少异常后恢复机制

- **文件**: `resources/pi/agent/extensions/bridge/index.ts`  
- **行号**: ~28-45 (setInterval 回调)
- **描述**: 改进后的 catch 块做了 `console.debug` + `return`，比原来的静默吞掉好。但 `return` 只是跳过本次迭代，syncAttempts 已递增。如果 bridge 目标（如 xyz-agent runtime）长时间不可用，30 次重试后 `clearInterval(syncInterval)` 会永久停止同步，且没有任何状态通知。用户无法知道 bridge 已放弃同步。  
- **修复方向**: 30 次耗尽时 `console.error('[bridge] Sync failed after 30 attempts, giving up')` 或通过某种机制通知上层。当前不修不会 crash，但影响可观测性。

#### L2. Bridge 全局变量无隔离

- **文件**: `resources/pi/agent/extensions/bridge/index.ts`  
- **行号**: 1-4
- **描述**: `bridgeState`, `syncAttempts` 是模块级全局变量。如果 Pi 支持多 session 或扩展被 activate/deactivate 循环调用，这些变量不会重置。`activate` 开头有 `bridgeState = 'Disconnected'` 但没有重置 `syncAttempts`。  
- **修复方向**: 在 `activate()` 开头加 `syncAttempts = 0`，并在函数入口 `clearInterval` 之前可能遗留的 interval（或用闭包追踪）。

#### L3. Goal tool executeGoalAction 错误路径的持久化时序

- **文件**: `resources/plugins/goal/src/goal-tool.ts`  
- **行号**: ~175 (catch 块中 `await store.set(GOAL_STATE_KEY, state)`)
- **描述**: 错误时持久化部分修改的状态是一个好的防御策略。但 `state` 可能已被 action handler 部分修改（如 `handleUpdateTasks` 中先做校验循环，再执行更新循环——校验失败时 tasks 未变，但若在后续循环中途 throw，部分 tasks 已更新）。此时持久化的 `state` 处于不一致的中间态。  
- **修复方向**: 考虑在 executeGoalAction 入口处深拷贝 state，仅在成功时写回。或确保每个 handler 要么全部成功要么不修改（当前 update_tasks 的校验+执行两阶段模式基本满足，但其他 handler 如 add_sub_todos 直接 mutate 后可能 throw）。

#### L4. src-electron/resources/ 删除后的引用完整性

- **文件**: `src-electron/resources/` (整个目录)
- **描述**: 所有 pi 扩展（goal/hooks/subagent/todo/usage-tracker/workflow + shared/logger）从此目录删除。需确认：(1) Electron 打包流程不再引用 `src-electron/resources/pi/`；(2) `electron-builder.yml` 的 `extraResources` 配置已更新或移除；(3) runtime-manager.ts 的路径解析不再指向此目录。若打包配置仍引用此路径，产物中将缺失 pi 扩展。  
- **修复方向**: 检查 `src-electron/electron-builder.yml` 中 `extraResources` 段落，确认 `resources/pi` 相关路径已更新。检查 `scripts/preflight-check.sh` 和 `scripts/validate-runtime-bundle.sh`。

### INFO

#### I1. Goal tool JSON_INDENT 常量提取（纯风格改进）

- **文件**: `resources/plugins/goal/src/goal-tool.ts`  
- **行号**: diff `+const JSON_INDENT = 2`
- **描述**: 将魔法数字 `2` 提取为命名常量。纯粹的代码风格改进，无功能影响。

#### I2. 已删除的 pi 扩展代码整体健壮性评价

以下对删除的 7 个扩展（位于 `src-electron/resources/pi/agent/extensions/`）的整体健壮性做评价，供迁移后参考：

| 扩展 | 健壮性评级 | 主要风险点 |
|------|-----------|-----------|
| **goal** | 良好 | goalId snapshot 防重入、deserializeState 向后兼容、防抖保护（零 token 不发 continuation）均有覆盖。`persistGoalState` 中时间累计逻辑在 `timeStartedAt > 0` 条件下才累加，终态/暂停时不计入。|
| **hooks** | 良好 | session_shutdown 清理 timer，简洁无隐患。|
| **subagent** | 良好 | sessionStates Map 按 sessionId 隔离，session_shutdown 清理 timer/memoryFiles/jobs。`cleanupJobLocal` 有 pid > 0 守卫防止 `process.kill(0)`。`mapWithConcurrencyLimit` 用 `Promise.allSettled` 避免丢失结果。memory session 文件在首次调用时 `copyFileSync` 可能因磁盘满失败但无 try-catch。|
| **todo** | 良好 | reconstructState 有向后兼容（`migrateTodo` 处理旧 `done` 字段），entry GC 从后向前删除避免索引偏移。模块级 `todos`/`nextId` 在多 session 场景下共享——但 pi 单进程单 session 可接受。|
| **usage-tracker** | 一般 | (1) `dailySummary` 是闭包级变量，注释已承认"多 session 并行时后写覆盖先写"；(2) `incrementAndPersist` 每次调用做 read-modify-write，高并发下有竞态风险（但 Pi 单进程可接受）；(3) `updateToolStats`/`updateSkillTrigger` 同样是同步 read-modify-write，无锁。|
| **workflow** | 一般 | (1) `notifiedRunIds` 是模块级 Set，不同 session 的完成通知共享去重——可能导致 session A 的通知被 session B 的通知 ID 遮蔽（极低概率）；(2) `scheduleTimeBudgetCheck` 用 setTimeout + unref，但在 resume 时重新调度，可能导致多个 timer 同时存在（旧 timer 未 clear）；(3) `handleScriptError` 的 retry 中 setTimeout 回调里直接使用 `instance` 闭包引用，如果期间 orchestrator 被回收可能操作已 dead 的 instance；(4) Worker 线程中 `callCache` 通过 `workerData` 传递，Map 在结构化克隆中变为普通对象，worker-script.ts 中有恢复逻辑但依赖 `Object.entries` 转换，嵌套 Map 会丢失。|
| **shared/logger** | 良好 | appendFileSync 同步写入但 catch 静默。多进程写同一日志文件可能有截断，但 pi 单进程场景可接受。|

---

## 总结

| 优先级 | 数量 | 关键问题 |
|--------|------|---------|
| MUST_FIX | 2 | Bridge + Statusline 中新增的 `throw e/err` 可能导致扩展/Worker 崩溃 |
| LOW | 4 | Bridge 同步放弃无通知、全局变量未隔离、Goal 部分修改持久化、打包引用完整性 |
| INFO | 2 | 风格改进 + 已删除代码健壮性评价 |

**最紧急修复**: 移除 `bridge/index.ts` 和 `statusline/index.ts` 中新增的 `throw` 语句。这些 throw 在事件回调中会级联崩溃，原代码的静默降级策略是正确的。
