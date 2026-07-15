# Code Review: sidebar-views-polish

## 审查范围

Commits:
- ca9200de feat(W1): shared/protocol 加 session.subagentAction RPC 类型
- f77119d1 feat(W2): runtime session-service + handler 加 subagentAction
- 22e69fbc feat(W3+W4+W5): sidebar 4 视图优化

文件:
- packages/shared/src/protocol.ts（W1 新增 RPC 类型）
- packages/runtime/src/interfaces.ts + session-service.ts + session-message-handler.ts（W2 runtime 层）
- packages/renderer/src/api/domains/session.ts + mock/index.ts（W3 API + mock）
- packages/renderer/src/stores/subagent.ts（W3 cancelSubagent action）
- packages/renderer/src/components/sidebar/SubagentList.vue（W3 cancel + slug + ScrollArea）
- packages/renderer/src/components/sidebar/WorkflowList.vue（W4 abort 两段式 + 常驻按钮 + ScrollArea）
- packages/renderer/src/components/sidebar/WorkflowDetail.vue（W4 abort 两段式 + pending hint + ScrollArea）
- packages/renderer/src/components/sidebar/SegmentedTab.vue（W5 badge 精确化）
- packages/renderer/src/components/sidebar/Sidebar.vue（W3/W5 接线 + composable 提取）
- packages/renderer/src/composables/features/useSidebarSubagentActions.ts（重构提取）
- packages/renderer/src/i18n/locales/{zh-CN,en-US}/sidebar.ts（文案）

## 审查结论

### 类型安全 ✅
- protocol.ts 对称复制 workflowAction 链路，action 类型精确为 'cancel'（非宽泛 string）
- cancelSubagent 的 prevStatus 回滚用 `record.status`（SubagentStatus），类型安全
- 无 any

### 错误处理 ✅
- cancelSubagent 乐观更新 + 失败回滚完整（try-catch 恢复 prevStatus + rethrow）
- message-handler subagentAction 失败时由 server.ts 外层 catch 转 sendError（与 workflowAction 一致）
- Sidebar onCancelSubagent catch + toast（与 onSelectSubagent 对称）

### 边界条件 ✅
- cancelSubagent record 不存在时 find 返回 undefined，if(record) 保护
- SubagentList slug 空串兜底 agent 名（`record.slug || record.agent`）
- WorkflowList abortingId 匹配精确到 runId（多个 running workflow 不会串）

### 测试覆盖 ✅
- cancel 两段式：首次不 emit + 确认态 + 二次 emit（覆盖交互状态机）
- cancelSubagent 失败回滚（异常路径，非 happy path）
- workflowAction/subagentAction 转发 prompt（零覆盖补齐）
- message-handler 成功 reply + 失败抛出（对称校验）

### Plan 完成度 ✅
- W1: protocol 3 处类型（ClientMessageType + ClientMessageMap + ServerMessageType + ServerMessageMap）全部落地
- W2: interfaces + service 实现 + handler case + handles 白名单全部落地
- W3: API + store + 组件 cancel + slug + ScrollArea + 空态教学 + i18n 全部落地
- W4: WorkflowList/Detail abort 两段式 + 常驻 + pending + ScrollArea + i18n 全部落地
- W5: SegmentedTab runningCount props + Sidebar computed 全部落地

## 已知问题（非本次引入）

1. subagent.test.ts 的 loadSubagents 失败清空测试（L104-112）与 store 实现（失败不清空 records）不一致——认知外 commit 改了 store 没改测试。不在本次范围
2. git 历史异常：认知外 commit 245e22b0 混入了部分 W2 实现。需后续清理 git 历史

## 评分

| 维度 | 评分 |
|------|------|
| 类型安全 | A |
| 错误处理 | A |
| 边界条件 | A- |
| 测试覆盖 | B+（subagent.test.ts 有 2 个预存失败非本次引入） |
| Plan 完成度 | A |
