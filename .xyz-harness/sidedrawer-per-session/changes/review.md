# Code Review — sidedrawer-per-session

**日期**: 2026-07-23
**审查 commits**: cd5ed495 (W1) + 8b4817c2 (W2)
**审查方法**: 主 agent 自审（实现者视角 + 禁读重建反查 spec FR/AC）

## Standards 组（代码符合规范）

### 维度检查

| 维度 | 结论 |
|------|------|
| type-safety | ✅ 无 any，DrawerControlState 接口显式，computed 类型推断正确。vue-tsc 通过 |
| error-handling | ✅ consumePendingOpen 幂等（pendingOpen 不存在时 return），无异常吞咽。debug 日志的 catch 有注释说明降级策略 |
| edge-case | ✅ focusedSessionId=null 时操作 no-op（useSessionScopedState null 分区语义），不泄漏。pendingOpen 查询用 `?? false` 兜底 |
| test-coverage | ✅ 9 测试覆盖 9 AC，含异常路径（U1 跨session干扰/U5 清理/U6 不被重开/U7 幂等），非全 happy path |
| plan-completeness | ✅ W1/W2 changes 全落地，W3 测试与 W1 同 commit（extraCommitReuse warning，合理） |

### Fowler 12 smell baseline

无命中。useSideDrawer 接口表面积小（open/close/toggle/setTab/toggleDock + 3 computed + 2 ref），实现集中（per-session 分区逻辑藏在 useSessionScopedState）。无 Mysterious Name / Middle Man / Speculative Generality。

### 仓库标准

- ESLint `--max-warnings=0` 通过（W2 commit 顺带修复了既有 debug 日志 magic number）
- vue-tsc 通过
- 遵循 ADR-0036 Map 分区派范式（useSessionScopedState），未引入 watch 清理派反模式

## Spec 组（忠实实现 spec）

### 三看（对照 FR/AC）

| spec | 实现位置 | 结论 |
|------|---------|------|
| FR-1 控制态 per-session 分区 | useSideDrawer.ts: controlState useSessionScopedState(focusedSessionId) | ✅ 忠实 |
| FR-2 事件 sid 守卫 | chat-message-effects.ts: openTasksDrawerOnFirstData sid===focusedSessionId 判断 | ✅ 忠实 |
| FR-3 pendingOpen 切回消费（挂 selectSession） | useSidebar.ts: selectSession 内 consumePendingOpen(id) | ✅ 忠实，挂在 context 拉取后（兜底区），非独立 watch |
| FR-4 tasks docked 收进分区 | useSideDrawer.ts: openInternal/setTab mutate cur.docked（当前分区） | ✅ 忠实 |
| FR-5 调用方 API 透明 | useSideDrawer() 签名不变，10+ 调用方零改动（验证：side-drawer/panel-container 测试 pass） | ✅ 忠实 |
| FR-6 selectedCommandName 不分区 | useSideDrawer.ts: 保留模块级单例 ref | ✅ 忠实 |
| FR-7 session 销毁清理 | registerSessionCleanup(pendingOpen) + useSessionScopedState 自动注册 controlState；deleteSession→triggerSessionCleanups 触发 | ✅ 忠实 |
| FR-8 resetSideDrawer 测试隔离 | _clearAllForTest 钩子清 controlState + pendingOpenMap.clear() | ✅ 忠实 |
| FR-9 手动 open 清 pendingOpen | useSideDrawer.ts: open() 内 clearPendingOpenForSid(sid) | ✅ 忠实 |
| FR-10 双 panel standby 无独立状态 | 分区键 focusedSessionId，drawer 单实例跟 active panel | ✅ 忠实 |

### scope creep 检查

- panelStore.focusedSessionId computed 是新增的共享派生（W1）——这不是 scope creep，是 FR-1/FR-5 的必要基础设施（useSideDrawer 需读 focusedSessionId 又不能依赖 useSidebar 实例防循环依赖）。useSidebar 原有的 focusedSessionId 保留未动（向后兼容）。
- `_clearAllForTest` 钩子加到通用 useSessionScopedState——测试基础设施，非功能 scope。

### 实现错误检查

无。AC-1~AC-9 均有对应测试且 pass（U1-U9 全绿）。

## 总结

- **Standards 组**：0 个发现（type-safety/error-handling/edge-case/test-coverage/plan-completeness 全过，无 Fowler smell 命中，仓库标准全过）
- **Spec 组**：0 个发现（FR-1~FR-10 全部忠实实现，AC-1~AC-9 全有测试覆盖且 pass，无 scope creep，无实现错误）

**审查通过，进 test。**
