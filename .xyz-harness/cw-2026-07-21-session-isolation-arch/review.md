# Review · session-isolation-arch

## 审查范围

reviewer subagent 审查 W1-W6 的 7 个实现 commit + 2 个测试修复 commit。主 agent 对 reviewer 报告做二次评估。

## 评估结论

核心实现（Map 分区、cleanup 注册/反注册、响应式契约、ADR-0036 一致性）**正确，无 critical bug**。reviewer 确认以下预期问题均不存在：
- cleanup 注册表跨实例误删 ✓
- W3 handleArrowDown 时序 bug（已用 newIndex 局部变量）✓
- reactive 容器契约（W2/W3/W4 init 均返回 reactive）✓
- version bump 覆盖（cleanup 是唯一删 Map 路径）✓
- W5 triggerSessionCleanups 接入点（deleteSession 唯一编排点）✓

## 已修（m1 + m2）

派 worker 修复中（commit 待补）：
- **m1 SideDrawer Map reassign 冗余**：Vue 3 reactive Map 有 collection handlers，`.set()`/`.delete()` 本身触发追踪，reassign 多余。主 agent 写脚本验证（triggerCount 1→2→3）。删除 reassign + 修正错误注释
- **m2 测试 registry 清理 hook**：导出 `__clearSessionCleanupRegistryForTest()`，各测试 beforeEach 调用，防 cleanup 注册跨用例残留

## 不修（known risk，进 retrospect）

### M1 切 sid 的 WS 消息写入竞态

**文件**：useExtensionUI.ts:60-67 / SideDrawer.vue:218-245

**问题**：WS handler 内 `queueState.update` / `drawerState.update` 读 `sid.value` 实时值决定写入分区。但 session 切换的退订是异步的（`watch(sessionId)` 默认 `flush:pre`）。存在窗口：`sid.value=B`（同步）→ watch 回调入队（异步）→ A 的 WS 消息到达 → handler 调 update 读 `sid.value===B` → 写入 B 分区。偶发的跨 session 数据污染。

**为什么不修**：
1. **重构前就存在**：watch 清理派的 queue.value 是单例，切 sid 后旧消息直接污染。本次重构把"确定性触发"变成"极小窗口竞态"，没引入新 bug
2. **触发概率极低**：需要 split/切 sid 的同一 tick 内恰好有 WS 消息到达
3. **修复是架构性改动**：需扩展 useSessionScopedState 加 `updateFor(sid, updater)` 显式分区方法 + 改 3 个 composable 的 handler 捕获订阅时 sid + 改测试 mock 语义。按 plan_review 纪律（架构性改动留 review 后），不在本次范围
4. **ADR-0036 核心目标已达成**：消除了确定性 bug（切 sid 不清 queue）、统一范式、防复发

**修复方向**（留给后续 topic）：handler 闭包捕获订阅时 sid，调 `updateFor(capturedSid, ...)` 写对应分区，从结构上消除竞态。

### M2 SideDrawer 测试假绿

**文件**：SideDrawer.test.ts:42-55

**问题**：测试注释声称"真实 events.off 同步退订"，但真实 useSessionEvents 的退订通过 `watch flush:pre`（异步）触发。测试 mock 用 `sidRef.value === sid` 匹配，掩盖了 M1 竞态。

**为什么不修**：与 M1 同根。M1 修复（handler 捕获 sid）后，测试 mock 需对应改为按注册时 sid 快照匹配。两者捆绑修复，一并留后续 topic。

**当前缓解**：SideDrawer.test.ts 的文件头注释 + emitTo 注释已说明 mock 语义。测试仍验证了"分区隔离"的核心契约（切回恢复 ×3 + 路由 ×1 + 正向 ×1），只是没覆盖 flush:pre 时序竞态。

## issues 清单

| id | severity | ref | description | 处理 |
|----|----------|-----|-------------|------|
| SR1 | should-fix | SideDrawer.vue:374/380/388 | m1 Map reassign 冗余 + 错误注释 | 修（worker 进行中） |
| SR2 | should-fix | useSessionScopedState.ts + 5 测试文件 | m2 registry 跨测试无法清理 | 修（worker 进行中） |
| SR3 | major | useExtensionUI.ts:60-67 / SideDrawer.vue:218-245 | M1 切 sid WS 消息写入竞态 | 不修，known risk 进 retrospect |
| SR4 | major | SideDrawer.test.ts:42-55 | M2 测试假绿掩盖 M1 | 不修，与 M1 捆绑留后续 |

## 审查结论

实现方向正确，核心 bug 已消除，范式统一达成，防复发机制（工厂 + 测试 + ADR + AGENTS.md）到位。2 个 should-fix 修复中，2 个 major 作为 known risk 记录（重构前已存在 + 修复属架构性改动）。可进 test 阶段。
