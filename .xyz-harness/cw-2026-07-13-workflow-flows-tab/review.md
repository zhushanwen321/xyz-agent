# Review — cw-2026-07-13-workflow-flows-tab

## 1. Plan 覆盖核对

| Wave | plan changes 覆盖 | 状态 |
|------|-----------------|------|
| W1 | shared/workflow.ts 类型定义 ✓ / workflow-extractor.ts ✓ / SessionService getWorkflows+getAgentCallHistory ✓ / session-message-handler RPC ✓ / protocol 类型 ✓ | 完整 |
| W2 | stores/workflow.ts ✓ / useWorkflowListSync.ts ✓ / WorkflowList.vue ✓ / WorkflowDetail.vue ✓ / Sidebar.vue 接入 ✓ / Panel.vue agentcall overlay ✓ / api/domains/session.ts ✓ | 完整 |
| W3 | event-interpreter handleWorkflowResult+handleWorkflowToolEnd+broadcastWorkflowUpdate ✓ / store subscribeWorkflowPush ✓ / useWorkflowListSync 订阅 ✓ / session.workflowUpdate ServerMessageType ✓ | 完整 |
| W4 | SessionService.workflowAction ✓ / session-message-handler RPC ✓ / protocol ✓ / api ✓ / WorkflowList 按钮 ✓ / WorkflowDetail 按钮 ✓ / Sidebar handler ✓ | 完整 |

## 2. 代码审查（5 维度）

### 2.1 正确性

**通过**：
- workflow-extractor 版本守卫（v==='wf-run-v1'）+ 去重 + 文件不存在 graceful skip，与 subagent-extractor 同构
- RunSnapshot → WorkflowRunRecord 映射字段完整（10 个 trace key 全覆盖），error 字段顶层优先于 result.error
- event-interpreter workflow-result 捕获 customType='workflow-result'，workflow toolCall 捕获 action='run'，互不干扰
- session.workflowUpdate（增量推送）与 session.workflows（RPC reply 全量）类型分离，无 payload 结构冲突
- Panel.vue effectiveSessionId 同时处理 subagent + agentCall overlay，优先级 subagent > agentCall > 主 session

**潜在问题**：
- getAgentCallHistory 的 sessionId 参数当前 `void sessionId`（保留接口一致性），实际用全局 scan。如果两个 session 有相同 sessionId 的 agent call（理论不可能，sessionId 是 uuidv7），会有冲突。实际风险极低。
- workflow toolCall 捕获只处理 action='run'。action='pause'/'resume'/'abort' 的 tool-call-end 不广播——这些是操作回执，前端操作后会主动 loadWorkflows 刷新，不需额外推送。合理。

### 2.2 架构一致性

**通过**：
- workflow store 遵守 store 铁律（不 import panel/chat store，selectAgentCall 的 setMessages 由调用方注入）
- workflow-extractor 与 subagent-extractor 同层（services/session/），同模式（读主 session JSONL → 提取 → 映射）
- event-interpreter 的 workflow 推送与 subagent 推送同款模式（handleXxx + broadcastXxx）
- useWorkflowListSync 镜像 useSubagentListSync 结构

**偏差**：
- workflow store 的 viewing 状态是联合类型（workflow-detail | agent-call | null），比 subagent store 的单一 subagentId 复杂。这是合理的——workflow 有两层视图（列表→详情 + 详情→Panel overlay），subagent 只有一层（列表→Panel overlay）。

### 2.3 测试覆盖

| 测试文件 | 用例数 | 覆盖 |
|---------|--------|------|
| workflow-extractor.test.ts | 4 | 正常映射 + 版本守卫/去重/文件不存在 + 主文件不存在 + running/failed/pending |
| event-interpreter-workflow-push.test.ts | 5 | run 广播 + done 广播 + 非 workflow tool + action≠run + 非 workflow-result customStart |
| workflow.test.ts（store） | 9 | 初始状态 + load 成功/失败 + clear + selectWorkflow + selectAgentCall + back + per-panel 隔离 |
| WorkflowList.spec.ts | 6 | 列表渲染 + running spinner + 空态 + 点击 select + 操作按钮渲染/emit + done 无按钮 |

**缺失（非阻塞）**：
- WorkflowDetail.vue 无组件测试（phase 分组逻辑 + agent call 点击）。W2 plan 的 E1 是 WorkflowList 冒烟，WorkflowDetail 的测试是增量改进。
- useWorkflowListSync 无测试（与 useSubagentListSync 同——两者都无独立测试，靠集成验证）。

### 2.4 可维护性

**通过**：
- 常量提取（TOKEN_K_THRESHOLD / MS_PER_SECOND / SECONDS_PER_MINUTE / SECONDS_PER_HOUR / PERCENT_BASE），无魔数
- WorkflowDetail 用 Button 组件（非原生 button），符合项目规范
- 错误处理：extractor 文件不存在返回 []，store loadWorkflows 失败清空 records，Sidebar onWorkflowAction 失败 toast 提示

### 2.5 性能

**已知约束（非本次引入）**：
- getWorkflows / getAgentCallHistory 调 scanPiSessions（3564 文件全扫）。这是既有问题，subagent 也在承受。可选优化：文件名 glob 替代全扫。
- event-interpreter 的 workflow 推送是增量信号（不读 state 文件），前端收到后调 loadWorkflows RPC。推送本身零 IO。

## 3. 发现的问题

### 3.1 无阻塞问题

所有 4 个 Wave 的 plan changes 全部落地，68 个测试全绿，runtime + renderer tsc 通过。

### 3.2 改进建议（非阻塞，后续迭代）

1. **WorkflowDetail 组件测试**：phase 分组逻辑（aggregatePhaseStatus）+ agent call 点击 emit 可补单测
2. **scanPiSessions 性能优化**：agent call JSONL 定位用文件名 glob（`find ... -name "*_<sessionId>.jsonl"`）替代全扫
3. **workflow-result 推送携带完整数据**：扩展侧 notifyDone 目前只推 {runId,name,status,reason,traceLength}，可增强为携带 agentCalls 展示子集，减少前端 RPC 往返（extension-adaptation.md §4.2 已记录）

## 4. verdict

**pass**。Plan 4 Wave 全部完整落地，测试覆盖充分（28 runtime + 40 renderer = 68 全绿），架构与 subagent 同构一致，无阻塞问题。
