# workflow 视图设计 Spec — Flows tab + agent call 对话流

> 状态：设计中（2026-07-13）
> 上游 spec：[subagent-panel/spec.md §5 Flows Tab](./spec.md)（Phase 3）
> 扩展对接契约：[workflow-extension-adaptation.md](./workflow-extension-adaptation.md)
> 参照实现：subagent（stores/subagent.ts + useSubagentListSync.ts + SubagentList.vue）

## 0. 背景与数据链

subagent-panel/spec.md §5 定义了 Flows tab 的完整设计（视图 1 列表 + 视图 2 phase 详情 + agent call Panel 切换）。本文档是 Phase 3 的实现 spec，聚焦数据链打通和组件落地。

### 0.1 数据链全景

```
主 agent 调 workflow tool (action=run, name, slug)
  ↓
扩展 launcher.runWorkflow → worker 线程执行
  ↓
  ├─ RunStore.save 每次 phase 变化 → <sessionDir>/workflow-state/<runId>.jsonl (rewrite mode)
  └─ pi.appendEntry('workflow-state-link', {runId, path}) → 主 session JSONL

worker 完成
  ↓
notifyDone → pi.sendMessage({customType:'workflow-result', details:{runId,name,status,reason,traceLength,__gui__}})
  → pi RPC stdout → event-adapter → message.customStart WS 帧

agent call 执行
  ↓
session-runner spawn pi 子进程 → session JSONL 落 ~/.pi/agent/sessions/<encodedAgentCallCwd>/<ISO>_<sessionId>.jsonl
trace[].sessionId = pi session ID (uuidv7)
```

### 0.2 与 subagent 的对比

| 项 | subagent（已实现） | workflow（本文档） |
|---|---|---|
| 主 session JSONL entry | `subagent` toolCall + `subagent-bg-notify` custom | `workflow-state-link` custom（data.path 指向 state 文件） |
| 状态文件位置 | `~/.pi/agent/subagents/<encodedCwd>/sessions/*.jsonl` | `<sessionDir>/workflow-state/<runId>.jsonl`（path 在 link entry 里） |
| 状态文件格式 | pi 标准 session JSONL（多行） | 单行 RunSnapshot（`v:"wf-run-v1"`，rewrite mode） |
| 对话流 JSONL | sessionFile 字段直接给路径 | trace[].sessionId（uuidv7），按 sessionId 全局查找 |
| 提取器 | `extractSubagentsFromSessionFile`（扫描 toolCall） | `extractWorkflowsFromSessionFile`（扫描 workflow-state-link） |
| 终态推送 | `subagent-bg-notify` customStart | `workflow-result` customStart |
| 执行期 streaming | `subagent-stream` setWidget（逐字流） | 无（worker 线程隔离） |

### 0.3 扩展侧已实现（无需额外开发）

调研确认（2026-07-13）：pi-subagent-workflow feat-ask-user-gui 分支已实现：
- `workflow-state-link` 持久化 + RunStore.save
- `workflow-result` 完成通知（pi.sendMessage）
- `/workflows pause|resume|abort` RPC 分支（ctx.mode==='rpc'）

详见 [workflow-extension-adaptation.md](./workflow-extension-adaptation.md)。

---

## 1. 数据模型（shared/workflow.ts）

映射 RunSnapshot 的展示子集。不透出 scriptSource（可达 30KB+）、trace live 对象等内部字段。

```typescript
export type WorkflowRunStatus = 'running' | 'paused' | 'done'
export type WorkflowDoneReason = 'completed' | 'failed' | 'aborted' | 'budget_limited' | 'time_limited'

/** workflow 内的单个 agent call（从 state.trace[] 映射） */
export interface WorkflowAgentCall {
  /** call 序号（trace.stepIndex） */
  id: number
  /** agent 名称（trace.agent，如 "dev-W1" / "reviewer"） */
  agent: string
  /** phase 分组名（trace.phase，如 "Dev-w0(W1)"） */
  phase?: string
  /** call 状态（trace.status） */
  status: 'pending' | 'running' | 'completed' | 'failed'
  /** 执行所用 model（trace.model） */
  model?: string
  /** pi session ID（trace.sessionId，定位对话流 JSONL） */
  sessionId?: string
  /** 启动时间 ISO（trace.startedAt） */
  startedAt?: string
  /** 完成时间 ISO（trace.completedAt） */
  completedAt?: string
  /** 执行耗时 ms（trace.result.durationMs） */
  durationMs?: number
  /** 输入 token（trace.result.usage.input） */
  inputTokens?: number
  /** 输出 token（trace.result.usage.output） */
  outputTokens?: number
  /** 对话轮数（trace.result.usage.turns） */
  turns?: number
  /** failed 状态的错误文本（trace.error 或 trace.result.error） */
  error?: string
}

/** 单条 workflow run 记录（列表项 + 详情数据） */
export interface WorkflowRunRecord {
  /** run 唯一标识（RunSnapshot.runId，如 "wf-1783679279983-hlpc46"） */
  runId: string
  /** 脚本名（spec.scriptName） */
  scriptName: string
  /** run 级短标签（spec.slug，≤20 字符，区分并发 run） */
  slug?: string
  /** 人类可读描述（spec.description） */
  description?: string
  /** 当前状态（state.status） */
  status: WorkflowRunStatus
  /** 终态原因（state.reason，done 时必有） */
  reason?: WorkflowDoneReason
  /** 启动时间 ISO（meta.startedAt） */
  startedAt: string
  /** 完成时间 ISO（meta.completedAt，done 时有值） */
  completedAt?: string
  /** 暂停时间 ISO（meta.pausedAt，paused 时有值） */
  pausedAt?: string
  /** 已消耗 token（state.budget.usedTokens） */
  usedTokens?: number
  /** agent call 总数（state.budget.totalCallCount） */
  totalCallCount?: number
  /** agent call 列表（从 state.trace[] 映射） */
  agentCalls: WorkflowAgentCall[]
  /** workflow-state JSONL 绝对路径（workflow-state-link.data.path） */
  stateFilePath: string
}
```

### 字段映射表（RunSnapshot → WorkflowRunRecord）

| WorkflowRunRecord 字段 | RunSnapshot 来源 | 备注 |
|---|---|---|
| runId | `runId` | 直接取 |
| scriptName | `spec.scriptName` | 直接取 |
| slug | `spec.slug` | 可选，旧 run 缺失 |
| description | `spec.description` | 可选 |
| status | `state.status` | 'running'\|'paused'\|'done' |
| reason | `state.reason` | done 时必有 |
| startedAt | `meta.startedAt` | ISO 字符串 |
| completedAt | `meta.completedAt` | done 时有值 |
| pausedAt | `meta.pausedAt` | paused 时有值 |
| usedTokens | `state.budget.usedTokens` | 数字 |
| totalCallCount | `state.budget.totalCallCount` | 数字 |
| agentCalls | `state.trace[]` 逐项映射 | 见下表 |
| stateFilePath | `workflow-state-link.data.path` | 绝对路径 |

### agentCalls 字段映射（trace → WorkflowAgentCall）

| WorkflowAgentCall 字段 | trace 来源 | 备注 |
|---|---|---|
| id | `stepIndex` | 数字 |
| agent | `agent` | 直接取 |
| phase | `phase` | 可选 |
| status | `status` | 'pending'\|'running'\|'completed'\|'failed' |
| model | `model` | 'default' 表示用 pi 默认 |
| sessionId | `sessionId` 或 `result.sessionId` | 两者一致，取顶层即可 |
| startedAt | `startedAt` | ISO |
| completedAt | `completedAt` | ISO |
| durationMs | `result.durationMs` | 数字 |
| inputTokens | `result.usage.input` | 数字 |
| outputTokens | `result.usage.output` | 数字 |
| turns | `result.usage.turns` | 数字 |
| error | `error` 或 `result.error` | 顶层 error 优先 |

---

## 2. runtime 侧

### 2.1 workflow-extractor.ts（新建）

**位置**：`packages/runtime/src/services/session/workflow-extractor.ts`

**数据链**（与 subagent-extractor 同构）：

```
读主 session JSONL
  → parseJsonl → filter custom_message customType:'workflow-state-link'
  → 去重 by runId（保留最新 path，同 runId 有多条 link entry）
  → 逐个读 data.path 指向的 workflow-state JSONL
    → 取最后一行（rewrite mode = 最新快照）
    → JSON.parse → 版本守卫（v !== 'wf-run-v1' 跳过，D-5）
    → 映射 RunSnapshot → WorkflowRunRecord
  → 返回 WorkflowRunRecord[]
```

**函数签名**：

```typescript
export function extractWorkflowsFromSessionFile(filePath: string): WorkflowRunRecord[]
```

**错误处理**：
- 主 session 文件不存在 → 返回 `[]`
- workflow-state 文件不存在或解析失败 → 跳过该 run（不影响其他 run）
- 版本不匹配（`v !== 'wf-run-v1'`）→ 跳过（D-5 不向后兼容）

### 2.2 SessionService 新增方法

**位置**：`packages/runtime/src/services/session/session-service.ts`

```typescript
async getWorkflows(sessionId: string): Promise<WorkflowRunRecord[]> {
  // 同 getSubagents 模式：scanSessions 找主 session filePath → extractWorkflowsFromSessionFile
  const target = this.sessionStore.scanSessions().find((s) => s.id === sessionId)
  if (!target) return []
  return extractWorkflowsFromSessionFile(target.filePath)
}

async getAgentCallHistory(sessionId: string, agentCallSessionId: string): Promise<Message[]> {
  // agentCallSessionId 是 trace[].sessionId（pi session ID，uuidv7）
  // 复用 getHistoryFromFile(agentCallSessionId, sessionStore)
  // scanPiSessions 按 header.id 匹配，agent call JSONL 文件名含 sessionId
  return getHistoryFromFile(agentCallSessionId, this.sessionStore)
}
```

**性能优化**（可选，非阻塞）：scanPiSessions 全扫 3564 文件 × parseSessionHeader 较慢。pi session 文件命名 `<ISO>_<sessionId>.jsonl`，可用 `find <sessionsDir> -name "*_<sessionId>.jsonl"` O(1) 定位。如果 getAgentCallHistory 响应慢，加一个 `findSessionFileBySessionId(sessionId)` 辅助函数替代 scanSessions.find。

### 2.3 RPC 路由

**位置**：`packages/runtime/src/transport/session-message-handler.ts`

```typescript
case 'session.getWorkflows': {
  const workflows = await this.ctx.sessionService.getWorkflows(msg.payload.sessionId)
  return this.ctx.reply(ws, msg.id, 'session.workflows', { sessionId: msg.payload.sessionId, workflows })
}
case 'session.getAgentCallHistory': {
  const messages = await this.ctx.sessionService.getAgentCallHistory(
    msg.payload.sessionId, msg.payload.agentCallSessionId,
  )
  return this.ctx.reply(ws, msg.id, 'session.agentCallHistory', {
    sessionId: msg.payload.sessionId, agentCallSessionId: msg.payload.agentCallSessionId, messages,
  })
}
```

**位置**：`packages/runtime/src/transport/session-message-handler.ts` 的 allowedMethods 数组加 `'session.getWorkflows'`、`'session.getAgentCallHistory'`。

### 2.4 event-interpreter 实时推送（阶段 3）

**位置**：`packages/runtime/src/services/session/event-interpreter.ts`

新增 workflow 内存态 + 两个 handler：

```typescript
// 新增字段（参照 subagentRecords 模式）
private workflowUpdates: Map<string, { runId: string; status: string; reason?: string }> = new Map()

// message handler 内新增 workflow-result 分支（参照 handleSubagentBgNotify）
private handleWorkflowResult(msg: ServerMessage): void {
  const payload = msg.payload as { customType?: string; details?: Record<string, unknown> } | undefined
  if (payload?.customType !== 'workflow-result') return
  const details = payload.details
  if (!details) return
  const runId = typeof details.runId === 'string' ? details.runId : null
  if (!runId) return
  // 广播增量信号，前端收到后触发 RPC 拉取完整数据
  this.broadcastWorkflowUpdate({ runId, status: 'done', reason: typeof details.reason === 'string' ? details.reason : undefined })
}

// tool-call-end handler 内新增 workflow tool 捕获（参照 handleSubagentEnd）
private handleWorkflowToolEnd(details: Record<string, unknown> | undefined): void {
  if (!details) return
  if (details.action !== 'run' || details.status !== 'running') return
  const runId = typeof details.runId === 'string' ? details.runId : null
  if (!runId) return
  this.broadcastWorkflowUpdate({ runId, status: 'running' })
}

private broadcastWorkflowUpdate(update: { runId: string; status: string; reason?: string }): void {
  this.opts.send({
    type: 'session.workflows' as ServerMessageType,
    payload: { sessionId: this.sessionId, update },
  })
}
```

**设计决策**：推送增量信号（`{runId, status, reason}`）而非全量列表。理由：
- 发起时刻 runtime 没有 agentCalls（workflow 刚启动）
- 前端收到推送后调 loadWorkflows RPC 拉取完整数据，复用现有链路
- 零新增 IO 逻辑在 event-interpreter 内

**注意**：tool-call-end 的 workflow 捕获需判断 `toolName === 'workflow'`，同 subagent 判断 `toolName === 'subagent'`。在 `handleToolCallEnd` 内加分支。

---

## 3. renderer 侧

### 3.1 stores/workflow.ts（新建，镜像 subagent store）

**位置**：`packages/renderer/src/stores/workflow.ts`

```typescript
defineStore('workflow', () => {
  // ── state ──
  const records = ref<WorkflowRunRecord[]>([])
  /** per-panel viewing：视图 2（runId）或 Panel overlay（agentCallSessionId） */
  const panelViewingMap = ref<Map<string, { runId: string } | { agentCallSessionId: string } | null>>(new Map())

  // ── getters ──
  function workflowCount(): number { return records.value.length }
  function isViewing(panelId: string): boolean { return panelViewingMap.value.get(panelId) != null }
  function getViewingRunId(panelId: string): string | null {
    const v = panelViewingMap.value.get(panelId)
    return v && 'runId' in v ? v.runId : null
  }
  function getViewingAgentCallId(panelId: string): string | null {
    const v = panelViewingMap.value.get(panelId)
    return v && 'agentCallSessionId' in v ? v.agentCallSessionId : null
  }
  function currentWorkflow(panelId: string): WorkflowRunRecord | null {
    const rid = getViewingRunId(panelId)
    return rid ? records.value.find((w) => w.runId === rid) ?? null : null
  }

  // ── actions ──
  async function loadWorkflows(sessionId: string): Promise<void> { /* 同 loadSubagents 模式 */ }
  function subscribeWorkflowPush(sessionId: string): () => void {
    // 订阅 session.workflows 推送，收到后触发 loadWorkflows
    return events.on(sessionId, (msg) => {
      if (msg.type !== 'session.workflows') return
      // 增量信号 → 重新拉取完整列表
      void loadWorkflows(currentFocusedSessionId)
    })
  }
  function clearWorkflows(): void { /* 同 clearSubagents */ }
  function selectWorkflow(panelId: string, runId: string): void {
    // 进入视图 2（sidebar 内详情）
    setViewing(panelId, { runId })
  }
  async function selectAgentCall(
    panelId: string, mainSessionId: string, agentCallSessionId: string,
    setMessages: SetMessagesFn,
  ): Promise<void> {
    // 进入 Panel overlay（agent call 对话流）
    const virtualId = agentCallVirtualId(agentCallSessionId)
    setViewing(panelId, { agentCallSessionId })
    const history = await sessionApi.getAgentCallHistory(mainSessionId, agentCallSessionId)
    setMessages(virtualId, history)
  }
  function backToWorkflowList(panelId: string): void {
    // 视图 2 → 视图 1
    setViewing(panelId, null)
  }
  function backToMain(panelId: string): void {
    // Panel overlay → 返回主会话
    setViewing(panelId, null)
  }
})
```

**虚拟 session ID**（agent call 对话流）：

```typescript
const AGENTCALL_PREFIX = 'agentcall:'
export function agentCallVirtualId(sessionId: string): string { return `${AGENTCALL_PREFIX}${sessionId}` }
export function isAgentCallVirtualId(sessionId: string): boolean { return sessionId.startsWith(AGENTCALL_PREFIX) }
export function extractAgentCallSessionId(virtualId: string): string { return virtualId.slice(AGENTCALL_PREFIX.length) }
```

**遵守 store 铁律**：store 内不 import panel/chat store。selectAgentCall 的 setMessages 由调用方（Sidebar.vue）注入。

### 3.2 useWorkflowListSync.ts（新建，镜像 useSubagentListSync）

**位置**：`packages/renderer/src/composables/features/useWorkflowListSync.ts`

```typescript
export function useWorkflowListSync(): void {
  const panel = usePanelStore()
  const sidebar = useSidebarStore()
  const workflowStore = useWorkflowStore()

  const focusedSessionId = computed<string | null>(
    () => panel.panels.find((p) => p.id === panel.activePanelId)?.sessionId ?? null,
  )

  let unsubPush: (() => void) | null = null

  watch(() => focusedSessionId.value, (sid) => {
    workflowStore.clearWorkflows()
    if (unsubPush) { unsubPush(); unsubPush = null }
    if (sid) {
      unsubPush = workflowStore.subscribeWorkflowPush(sid)
      void workflowStore.loadWorkflows(sid)
    }
  }, { immediate: true })

  watch(() => [sidebar.activeTab, focusedSessionId.value] as const, ([tab, sid]) => {
    if (tab === 'workflows' && sid) void workflowStore.loadWorkflows(sid)
  })
}
```

Sidebar.vue `onMounted` 加 `useWorkflowListSync()`。

### 3.3 组件

#### WorkflowList.vue（视图 1）

**位置**：`packages/renderer/src/components/sidebar/WorkflowList.vue`

渲染 workflow 卡片列表。参照 SubagentList.vue 结构。

```
┌────────────────────────────────────────────┐
│ [spinner] execute-full-workflow  deploy-flow  [Pause][Abort]│
│            ▓▓▓▓▓▓▓▓░░░░░  66% · 3/5 agents  │
│            1m20s · 44k tok                   │
├────────────────────────────────────────────┤
│ [✓] execute-full-workflow  migrate-users    │
│     7 agents · 44k tok · 1h21m              │
└────────────────────────────────────────────┘
```

| 区域 | 内容 | 数据源 |
|------|------|------|
| 状态指示 | spinner（running）/ 黄点（paused）/ 绿点（done-completed）/ 红点（done-failed/aborted） | status + reason |
| 名称 | scriptName + slug | scriptName, slug |
| 操作按钮 | Pause+Abort（running）/ Resume+Abort（paused）| status |
| 进度条 | agentCalls completed/total 比例 | agentCalls filter completed / agentCalls.length |
| 摘要 | elapsed · tokens | startedAt → now, usedTokens |

交互：
- 点击卡片 → `selectWorkflow(panelId, runId)` → 进入视图 2
- Pause/Resume/Abort → 调 `client.prompt("/workflows <action> <runId>")`（经 runtime RPC）

#### WorkflowDetail.vue（视图 2）

**位置**：`packages/renderer/src/components/sidebar/WorkflowDetail.vue`

渲染 phase 分组 + agent call 列表。参照 subagent-panel/spec.md §5.2。

```
← 返回  execute-full-workflow                [Pause][Abort]

● Dev-w0(W1)              1 agent · 8m
  [✓] dev-W1  default     219k in · 11k out · 52 turns · 8m

● Dev-w1(W2,W3)           2 agents · 14m
  [✓] dev-W2  default     132k in · 12k out · 44 turns · 7m
  [✓] dev-W3  default     ...

○ Test+Review             pending
```

| 区域 | 内容 | 数据源 |
|------|------|------|
| 返回按钮 | ← 返回 + scriptName + 操作按钮 | — |
| phase header | phase dot + 名称 + agent 数/耗时 | agentCalls 按 phase 分组 |
| phase dot | completed=绿 / running=蓝 / pending=灰 | 该 phase 内 agentCalls 状态聚合 |
| agent call | agent 名 + model + tokens/turns/duration + 状态 | WorkflowAgentCall |

交互：
- ← 返回 → `backToWorkflowList(panelId)` → 回视图 1
- 点击 agent call → `selectAgentCall(panelId, mainSessionId, sessionId)` → Panel 切换

phase 分组逻辑：按 `agentCall.phase` 字段 group by，同 phase 的 agent calls 列在一起。phase 状态 = 该组内所有 agent calls 都 completed 则 phase=completed，有 running 则 phase=running，否则 pending。

#### Sidebar.vue 改动

```vue
<!-- :workflow-count="0" 改为 -->
:workflow-count="workflowStore.workflowCount()"

<!-- workflows template 改为 -->
<template v-else-if="sidebar.activeTab === 'workflows'">
  <WorkflowDetail
    v-if="workflowStore.getViewingRunId(panelStore.activePanelId)"
    :workflow="workflowStore.currentWorkflow(panelStore.activePanelId)"
    @back="onWorkflowBack"
    @select-agent-call="onSelectAgentCall"
  />
  <WorkflowList
    v-else
    :workflows="workflowStore.records"
    @select="onSelectWorkflow"
    @action="onWorkflowAction"
  />
</template>
```

#### Panel.vue / MessageStream.vue 改动

加 `isAgentCallVirtualId` 判断（同 `isSubagentVirtualId` 模式）。agent call overlay 的 PanelHeader 显示「← 返回主会话」+ agent 名 + phase 信息。

### 3.4 api/domains/session.ts 新增

```typescript
export async function getWorkflows(sessionId: string): Promise<WorkflowRunRecord[]> {
  const reply = await request<{ workflows: WorkflowRunRecord[] }>('session.getWorkflows', { sessionId })
  return reply.workflows
}

export async function getAgentCallHistory(sessionId: string, agentCallSessionId: string): Promise<Message[]> {
  const reply = await request<{ messages: Message[] }>('session.getAgentCallHistory', { sessionId, agentCallSessionId })
  return reply.messages
}
```

---

## 4. 实施分阶段

### 阶段 1：数据链打通（runtime 只读）

**文件**：
- 新建 `packages/shared/src/workflow.ts`（类型定义）
- 新建 `packages/runtime/src/services/session/workflow-extractor.ts`
- 改 `packages/runtime/src/services/session/session-service.ts`（getWorkflows / getAgentCallHistory）
- 改 `packages/runtime/src/transport/session-message-handler.ts`（RPC 路由 + allowedMethods）

**验证**：
- `getWorkflows` 对真实 workflow-state 文件返回正确的 WorkflowRunRecord[]
- `getAgentCallHistory` 按 sessionId 找到 agent call JSONL 并返回 Message[]
- 单测：mock workflow-state 文件，验证 extractor 映射 + 版本守卫 + 去重

### 阶段 2：前端只读视图（renderer）

**文件**：
- 新建 `packages/renderer/src/stores/workflow.ts`
- 新建 `packages/renderer/src/composables/features/useWorkflowListSync.ts`
- 新建 `packages/renderer/src/components/sidebar/WorkflowList.vue`
- 新建 `packages/renderer/src/components/sidebar/WorkflowDetail.vue`
- 改 `packages/renderer/src/components/sidebar/Sidebar.vue`（workflow template + count + onMounted sync）
- 改 `packages/renderer/src/components/panel/Panel.vue` + `MessageStream.vue`（agentcall overlay）
- 改 `packages/renderer/src/api/domains/session.ts`（getWorkflows / getAgentCallHistory）

**验证**：
- mount Sidebar，切到 Flows tab，断言 WorkflowList 渲染（首屏冒烟）
- 点击 workflow 卡片进 WorkflowDetail
- 点击 agent call 切 Panel 显示对话流
- count 响应式跟随 records.length

### 阶段 3：实时推送（event-interpreter）

**文件**：
- 改 `packages/runtime/src/services/session/event-interpreter.ts`（workflow-result + workflow toolCall 捕获 + 广播）
- 改 `packages/renderer/src/stores/workflow.ts`（subscribeWorkflowPush）
- 改 `packages/renderer/src/composables/features/useWorkflowListSync.ts`（订阅推送）

**验证**：
- 发起 workflow 后列表自动出现（不需手动切 tab）
- workflow 结束后状态自动更新（workflow-result 推送）

### 阶段 4：操作按钮（pause/resume/abort）

**扩展侧**：已实现（无需开发）。

**xyz-agent 侧**：
- runtime 新增 RPC `session.workflowAction(action, runId)` → 调 `client.prompt("/workflows <action> <runId>")`
- 前端 WorkflowList / WorkflowDetail 加 Pause/Resume/Abort 按钮

**验证**：
- 点 Pause → workflow 状态变 paused
- 点 Abort → 状态变 done/aborted

---

## 5. 提交策略

4 个 commit（各阶段独立）：

1. `feat(workflow): add workflow extractor + getWorkflows/getAgentCallHistory RPC`
2. `feat(workflow): add WorkflowList + WorkflowDetail + Panel agent call overlay`
3. `feat(workflow): realtime push via event-interpreter (workflow-result + toolCall capture)`
4. `feat(workflow): add pause/resume/abort buttons`

---

## 6. 风险评估（调研后）

| 风险 | 状态 | 说明 |
|---|---|---|
| RunSnapshot 格式映射 | ✅ 已排除 | wf-run-v1 版本守卫稳定，3 个样本 trace 结构完全一致（10 key）。旧文件无版本号被跳过。 |
| agent call JSONL 定位 | ✅ 已排除 | worktree 清理不影响 JSONL（在 sessions 目录不在 worktree）。文件名 `<ISO>_<sessionId>.jsonl` 可 glob 定位。 |
| 跨仓库扩展适配 | ✅ 已排除 | RPC 分支已全部实现（subagents cancel + workflows pause/resume/abort）。xyz-agent 只需调 client.prompt。 |
| scanPiSessions 性能 | ⚠️ 既有问题 | 3564 文件全扫，每次 getWorkflows/getAgentCallHistory 调一次。非 workflow 引入的新问题。可选优化：文件名 glob 替代全扫。 |

---

## 7. 不在本次范围

- **workflow 执行期 phase 级实时推送**：worker 线程隔离，需扩展侧改造。本次接受「发起 + 结束」两个时刻的推送覆盖，中间进度需手动切 tab。
- **workflow-script tool 支持**：spec §5 只覆盖 workflow tool（action=run），workflow-script tool 是另一入口，数据链相同，可后续增量。
- **嵌套 workflow（executeNestedWorkflow）**：parentWorkflowChain 字段存在但本次不展示嵌套层级。
