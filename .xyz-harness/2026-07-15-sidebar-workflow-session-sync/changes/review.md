# Code Review — sidebar-workflow-session-sync

> 修复侧边栏 subagent/workflow 列表不跟随 session 切换更新，及 workflow viewing 状态模型缺陷导致 Panel 误进子代理态/选中 agent call 后侧边栏跳回列表。

## 审查范围
- base: `e60633c4`
- commits: `00331121`(W1 workflow store 状态拆分) `39a0b97d`(W2 主动拉取兜底)
- 6 files changed, +273 -46

## 验证手段
- 逐 commit 读 diff（`git show`）
- 测试执行：workflow-viewing-isolation 4 passed、workflow.test 13 passed、select-session-pull 2 passed
- 确认 subagent.test.ts 2 个失败为 pre-existing（base 上同样失败，非本次回归）
- 读 Panel.vue onSubagentBack 确认 workflowStore.isViewing 语义变更后的正确性

---

## 发现的问题

| # | 维度 | 问题 | 严重度 | 位置 |
|----|------|------|--------|------|
| F1 | 边界条件 | **selectSession 的 subagent/workflow 拉取与 sync composable 的 watch 可能重复请求**。`useSubagentListSync`/`useWorkflowListSync` 的 `watch(focusedSessionId, {immediate:true})` 在切 session 时已经 `clearSubagents + loadSubagents(sid)`，selectSession 末尾又 `void loadSubagents(id)`。两次 loadSubagents 并发——虽然 store 内 `isLoading` 标志和 records 覆盖能容忍竞态（后到的覆盖先到的），但仍是多余的 RPC 开销。同理 loadWorkflows。 | nit | useSidebar.ts:253-255 |
| F2 | 测试覆盖 | **W2 的 submitFirstMessage 主动拉取无单测覆盖**。test.json U5/U6 只覆盖了 selectSession 路径。submitFirstMessage 是新建 session 的核心载入点，`useFileTree().loadTree(newSid)` + `loadSubagents(newSid)` + `loadWorkflows(newSid)` 三行无测试锁定。若未来重构移除会导致回归无网。 | should-fix | useNewTaskFlow.ts:211-217；缺 submitFirstMessage 测试 |
| F3 | 测试覆盖 | **subagent/workflow store 不按 sessionId 分桶的残留窗口无测试**。`clearSubagents()`/`clearWorkflows()` 在 sync composable 的异步 watch 里调用，与 selectSession 的同步主动拉取之间存在窗口（旧 session 数据未被 clear 就被新数据覆盖）。当前靠 records 整体覆盖掩盖了问题，但 split panel 场景下两 panel 共享同一 records ref 可能串台。本次未做分桶改动（scope 外），但应记录为已知风险。 | nit | stores/subagent.ts:56、stores/workflow.ts:50（records 单 ref 不分桶） |

### 维度小结
- **业务逻辑正确性**：W1 状态拆分是核心修复，两个正交维度（侧边栏视图2 × Panel overlay）独立后行为正确。selectWorkflow 不触发 overlay（问题2修复）、selectAgentCall 不覆盖 detailRunId（问题3修复）、backFromAgentCall 保留 detailRunId（问题3返回路径修复）。Panel.vue onSubagentBack 的 `workflowStore.isViewing` 语义变更后行为正确（只认 agent-call overlay）。W2 的主动拉取兜底对齐 commands/context 模式，根因（broadcast 早于订阅）被覆盖。
- **类型安全**：删除了 PanelViewing 联合类型，改为两个独立 `Map<string, string>`，类型更简单。无 any。
- **边界条件**：Map 的 set/delete 用 `new Map(old)` 不可变更新，Vue 响应式正确。clearWorkflows 清两个 Map。无遗漏。
- **代码规范**：注释密度高，HISTORICAL 注释把拆分原因和旧 bug 讲透。fire-and-forget 模式与现有 commands/context/fileTree 兜底一致。

---

## plan 覆盖核对

### W1（workflow viewing 状态拆分）
| changes 条目 | 状态 | 说明 |
|---|---|---|
| panelViewingMap 拆为 detailRunIdMap + agentCallMap | ✅ | workflow.ts:60-71 |
| isViewing() 只读 agentCallMap | ✅ | workflow.ts:79-82 |
| getViewingRunId 改读 detailRunIdMap | ✅ | workflow.ts:85-87 |
| getViewingAgentCallId 改读 agentCallMap | ✅ | workflow.ts:90-92 |
| selectWorkflow 改写 detailRunIdMap | ✅ | workflow.ts:172-176 |
| selectAgentCall 改写 agentCallMap | ✅ | workflow.ts:188-192 |
| backToWorkflowList 清 detailRunIdMap | ✅ | workflow.ts:202-206 |
| backFromAgentCall 清 agentCallMap | ✅ | workflow.ts:209-213 |
| clearWorkflows 清两个 Map | ✅ | workflow.ts:168-172 |
| Panel.vue isViewingSubagent 不变 | ✅ | workflowStore.isViewing 语义已修正 |
| Panel.vue onSubagentBack 不变 | ✅ | 已验证语义正确 |

### W2（主动拉取兜底）
| changes 条目 | 状态 | 说明 |
|---|---|---|
| selectSession 补 loadSubagents + loadWorkflows | ✅ | useSidebar.ts:253-255 |
| submitFirstMessage 补 loadTree + loadSubagents + loadWorkflows | ✅ | useNewTaskFlow.ts:211-217 |

---

## 结论
- **must_fix：0 个**
- **should_fix：1 个**（F2：submitFirstMessage 主动拉取缺测试）
- **nit：2 个**（F1 重复请求、F3 分桶残留窗口）

**整体评价**：W1 状态拆分是精准的架构修复——用两个正交字段替代单个联合类型 Map，从根因上消除问题2+3。W2 的主动拉取对齐了项目既有的 commands/context 兜底模式，覆盖了「选中已有 session」和「新建 session」两条路径。核心逻辑正确、测试覆盖 W1 充分（4 个隔离测试 + 13 个回归测试全绿）。

**建议**：F2 建议本轮补 submitFirstMessage 测试（防止回归）；F1/F3 可作为已知风险在 retrospect 记录。
