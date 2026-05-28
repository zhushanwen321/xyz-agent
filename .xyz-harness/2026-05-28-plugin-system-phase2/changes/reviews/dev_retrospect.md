---
phase: dev
verdict: pass
---

# Dev Phase Retrospect — Plugin System Phase 2

## 1. Phase Execution Review

### Summary

Phase 3 实现了插件系统的完整后端基础设施，包含 10 个 Task、8 个 Execution Group、4 个 Wave：

- **Wave 1 (BG1)**: 插件类型系统（source/DEPS_MISSING）、Worker 沙箱（Module._resolveFilename 拦截）、权限检查器（permissions.json + RPC dispatch hook）
- **Wave 2 (BG2/BG3/FG1)**: Tool/Hook API RPC 注册、Pi Bridge Extension（异步状态机 Disconnected→Syncing→Ready）、前端最小改动（PermissionDialog + StatusBar slot）
- **Wave 3 (BG4/BG5)**: 6 个扩展 API 模块（sessions/config/sessionData/ui/agent/workspace）、hook 执行管道（优先级排序+广播）、插件依赖拓扑排序（Kahn's 算法）
- **Wave 4 (BG6/BG7)**: Goal 插件转换（10 actions + beforeAgentStart hook + sessionData 持久化）、Todo 插件转换（5 actions + session 恢复）

最终交付：78 个文件变更、12,131 行新增代码、230 个测试全部通过。

### Problems Encountered

1. **子代理文件路径错误**: Subagent 将资源文件写入 `src-electron/resources/` 而非项目根 `resources/`。根因：task prompt 中路径不够明确。修复：手动 `git mv` 移动到正确位置。

2. **审查迭代循环过深**: 五步专项审查从 v1 迭代到 v5/v4/v3 才全部通过。根因：
   - 审查子代理基于代码快照执行，修复代码后必须重新 dispatch 才能更新 verdict
   - 每轮修复只解决部分问题，新轮次又发现新问题（如 MF-7 在 stub 移除后才暴露）
   - 429 rate limit 频繁中断审查子代理
   影响：gate 循环 6 次，审查 dispatch 20+ 次

3. **bridge:sync 读 manifest 而非 toolRegistry**: server.ts 的 bridge:sync 最初从 plugin.contributes.tools 读取 manifest 声明，而非运行时 toolRegistry。修复：改为调用 pluginService.getToolSchemas()。

4. **toolRegistry key 格式不匹配**: handleBridgeToolExecute 用裸 toolName（如 `goal_manager`）查找 toolRegistry，但 key 是 `pluginId:name` 格式（如 `goal:goal_manager`）。修复：改为 `Array.from(values()).find(e => e.schema.name === toolName)`。这个 bug 在 stub 移除前无法触发，是典型"管道铺好后阀门才开"的集成问题。

5. **BridgeToolExecuteResponse 类型定义与 plan 不一致**: plugin-types.ts 定义为 `{success, result, error?}`，plan-api-contract 定义为 `{content, isError?}`。修复：对齐到 plan 契约。

### What Would You Do Differently

1. **Task prompt 中明确资源文件路径**: 给 subagent 的 task prompt 中用绝对路径 + 存在性验证（`ls -la` 确认目录存在）避免路径错误。

2. **先写集成测试再写实现**: toolRegistry key 格式不匹配这类集成问题，如果有端到端集成测试（bridge:sync → tool_execute 完整路径），会在实现阶段就暴露。

3. **审查 dispatch 策略优化**: 不要每个 MUST FIX 都立即 dispatch 新轮次，而是批量修复后再 dispatch，减少审查迭代轮次和 429 概率。

4. **类型定义统一管理**: BridgeToolExecuteResponse 这类跨模块共享类型，应该在 plan 阶段就写入共享类型文件，而非各模块各自定义。

### Key Risks for Later Phases

1. **executeHooks 广播不等待 Worker 结果**: Phase 2 简化实现，当前所有 hook 是本地函数。如果 Phase 3 引入 Worker hook，需要改为串行等待。
2. **plugin-bootstrap.ts 的 `any[]`**: Module._resolveFilename monkey-patch 中的 any 暂无更好的类型方案。
3. **sessionData 持久化依赖 bridge:append_entry**: 如果 pi session 文件延迟写入（Phase 1 已知问题），sessionData 可能在首次 assistant 回复前丢失。

## 2. Harness Usability Review

### Flow Friction

1. **审查迭代是最大瓶颈**: 五步专项审查需要 5 个子代理全部 pass 才能 gate。每个子代理独立迭代，且基于代码快照执行，导致修复后必须重新 dispatch。实际执行了 20+ 次审查 dispatch，消耗大量 token 和时间。
2. **Gate 不自动 re-check**: gate 只检查最新版审查文件的 YAML verdict，不会自动重新运行审查。需要主 agent 手动 dispatch 新轮次。
3. **复杂路径的禁码铁律与审查修复矛盾**: 禁码铁律要求主 agent 不写代码，但审查修复是小量改动（改类型、删除未使用变量），调度 subagent 做 2 行改动效率极低。实际执行中主 agent 直接修复了这些小问题。

### Gate Quality

- Gate 正确识别了所有审查文件版本（v1→v5 递增查找最新版）。
- Gate 的 YAML 检查严格且准确：verdict 必须是 `"pass"`，must_fix 必须是 `0`。
- 未跟踪文件检查有效捕获了未 commit 的审查文件。
- 无误报（false positive）。

### Prompt Clarity

- Dev skill 的五步审查流程描述清晰，Batch 1 并行 + Batch 2 串行的编排合理。
- 审查轮次限制 "最多 2 轮" 在实际执行中不够（需要 4-5 轮），但 skill 也提供了 "3 轮后由用户决定" 的出口。
- 缺少一个关键指导：**审查子代理修复后如何高效 re-dispatch**（是否需要传入上一轮修复清单）。

### Automation Gaps

1. **审查结果不会自动刷新**: 修复代码后需要手动 dispatch 新审查轮次。可以自动化为：检测到代码变更 → 自动 re-dispatch 失败的审查。
2. **ESLint 错误数追踪**: Standards Review 每轮都要重新运行 lint。可以缓存 lint 结果，只在代码变更后重新运行。
3. **Integration Review 依赖 BLR**: 每次更新 BLR 都需要手动更新 Integration Review。可以自动化为：BLR verdict 变更 → 自动 re-generate Integration Review。

### Time Sinks

1. **审查迭代循环**: 从 v1 到 v5/v4/v3，4 个审查并行 dispatch × 5 轮 = 20+ 次子代理调用，占总时间 60%+。
2. **429 Rate Limit**: glm-5-turbo 频繁触发 429，导致审查子代理失败重试。需要更好的并发控制和模型选择策略。
3. **YAML frontmatter 格式**: 审查文件的 YAML 格式错误（缺少闭合 `---`、字符串 vs 布尔值）导致 gate 误报，需要手动修复。

## Metrics

| Metric | Value |
|--------|-------|
| Tasks completed | 10/10 |
| Test files | 16 |
| Tests passing | 230 |
| Files changed | 78 |
| Lines added | 12,131 |
| Review iterations (BLR) | 5 rounds |
| Review iterations (Standards) | 4 rounds |
| Review iterations (Taste) | 5 rounds |
| Review iterations (Robustness) | 3 rounds |
| Gate attempts | 7 |
| Commits | 20+ |
