# Agent Call Streaming — xyz-agent 侧改造

> 配套文档：[agent-call-streaming-extension.md](./agent-call-streaming-extension.md)（pi-subagent-workflow 扩展侧改造）
>
> 前置：本文假设扩展侧已完成改造（workflow agent call 也创建 SubagentStream，widgetKey = `subagent-stream-<runId>-<stepIndex>`）。

## 目标

让 workflow 内的 agent call 在 Panel overlay 中实时逐字 streaming，与 subagent overlay 行为一致。

用户要求：「底层一套逻辑」——复用 subagent 的 streaming 消费链路，不新建独立通道。

## 现状（本次已修复的 Part 2）

agent call 对话流的**静态历史**已可显示（`getAgentCallHistory` 扫描 `subagents/<encodedCwd>/sessions/` 目录）。但**执行期间**无逐字 streaming。

## 复用的现有链路

```
扩展 SubagentStream.onDelta
  → ctx.ui.setWidget("subagent-stream-<recordId>")
  → RPC stdout
  → runtime event-adapter.ts（匹配 subagent-stream- 前缀 → kind:'subagent-stream'）
  → event-interpreter.ts（→ subagent.stream_delta WS 帧）
  → 前端 subscribeStream → chat.applySubagentStreamDelta(virtualId, lines)
```

**runtime 侧无需改动**：event-adapter.ts:288 的 `subagent-stream-` 前缀匹配是通用的，event-interpreter.ts:173 的 `subagent-stream` → `subagent.stream_delta` 翻译也通用。只要扩展推的 widgetKey 以 `subagent-stream-` 开头，整条链路自动生效。

## 需要改的文件（前端 4 个）

### 1. `packages/renderer/src/stores/workflow.ts`

#### 1a. 新增 streaming 资源管理

对齐 subagent store 的 `panelStreamUnsub` 模式：

```ts
// 非响应式资源表（参照 subagent.ts panelStreamUnsub 模式）
const panelStreamUnsub = new Map<string, () => void>()
```

#### 1b. selectAgentCall 签名扩展

当前签名（Part 2 后）：
```ts
async function selectAgentCall(
  panelId: string,
  mainSessionId: string,
  agentCallSessionId: string,
  setMessages: SetMessagesFn,
): Promise<void>
```

扩展后（对齐 subagent.selectSubagent）：
```ts
async function selectAgentCall(
  panelId: string,
  mainSessionId: string,
  agentCallSessionId: string,
  runId: string,                    // 新增：widget recordId 组成
  stepIndex: number,                // 新增：widget recordId 组成
  chatApplyDelta: ApplyDeltaFn,     // 新增：streaming delta 注入
  chatFinalizeStream: FinalizeStreamFn, // 新增：streaming 终态收口
  setMessages: SetMessagesFn,
): Promise<void>
```

内部逻辑：
1. `fetchAndInject`（拉静态历史，已完成）
2. 判断 agent call 是否 running（从 records 找 trace 节点 status）
3. running 则 `subscribeStream(panelId, mainSessionId, recordId, virtualId, ...)`

#### 1c. subscribeStream（复用 subagent 模式）

```ts
function subscribeStream(
  pid: string,
  mainSessionId: string,
  recordId: string,          // = `${runId}-${stepIndex}`
  virtualId: string,
  chatApplyDelta: ApplyDeltaFn,
  chatFinalizeStream: FinalizeStreamFn,
  setMessages: SetMessagesFn,
): void {
  stopStream(pid)
  const unsub = events.on(mainSessionId, (msg) => {
    if (msg.type !== 'subagent.stream_delta') return
    const payload = msg.payload as { recordId?: string; lines?: string[] | undefined }
    if (payload.recordId !== recordId) return  // 按 runId-stepIndex 匹配

    if (payload.lines === undefined) {
      // 终态：停 streaming + 收口 + 拉完整历史覆盖
      stopStream(pid)
      chatFinalizeStream(virtualId)
      void fetchAndInject(mainSessionId, /* agentCallSessionId */, setMessages)
      return
    }
    chatApplyDelta(virtualId, payload.lines)
  })
  panelStreamUnsub.set(pid, unsub)
}
```

recordId 格式：`${runId}-${stepIndex}`，与扩展侧 widgetKey `subagent-stream-<runId>-<stepIndex>` 对齐。

#### 1d. 新增 stopStream / clearWorkflows 补清理

```ts
function stopStream(targetPanelId?: string): void {
  if (!targetPanelId) return
  const unsub = panelStreamUnsub.get(targetPanelId)
  if (unsub) { unsub(); panelStreamUnsub.delete(targetPanelId) }
}

function clearWorkflows(): void {
  for (const pid of panelStreamUnsub.keys()) stopStream(pid)
  records.value = []
  panelViewingMap.value = new Map()
}
```

#### 1e. backFromAgentCall 补 stopStream

```ts
function backFromAgentCall(panelId: string): void {
  stopStream(panelId)
  setViewing(panelId, null)
}
```

### 2. `packages/renderer/src/components/sidebar/Sidebar.vue`

`onSelectAgentCall` 对齐 `onSelectSubagent`，传 runId + stepIndex + 3 个回调。

当前（Part 2 后）：
```ts
async function onSelectAgentCall(agentCallSessionId: string): Promise<void> {
  // ...
  await workflowStore.selectAgentCall(
    panelStore.activePanelId, activePanel.sessionId, agentCallSessionId,
    (virtualId, msgs) => chat.setMessages(virtualId, msgs),
  )
}
```

改为：
```ts
async function onSelectAgentCall(payload: {
  agentCallSessionId: string
  runId: string
  stepIndex: number
}): Promise<void> {
  const activePanel = panelStore.panels.find((p) => p.id === panelStore.activePanelId)
  if (!activePanel?.sessionId) return
  const chat = useChatStore()
  await workflowStore.selectAgentCall(
    panelStore.activePanelId,
    activePanel.sessionId,
    payload.agentCallSessionId,
    payload.runId,
    payload.stepIndex,
    (virtualId, lines) => chat.applySubagentStreamDelta(virtualId, lines),
    (virtualId) => chat.finalizeSubagentStream(virtualId),
    (virtualId, msgs) => chat.setMessages(virtualId, msgs),
  )
}
```

### 3. `packages/renderer/src/components/sidebar/WorkflowDetail.vue`

emit `select-agent-call` 时带上 runId + stepIndex。

当前：
```vue
@click="emit('select-agent-call', agentCall.sessionId)"
```

改为：
```vue
@click="emit('select-agent-call', {
  agentCallSessionId: agentCall.sessionId,
  runId: workflow.runId,
  stepIndex: agentCall.id,
})"
```

emit 类型定义同步更新。

### 4. `packages/renderer/src/components/panel/Panel.vue`

`onUnmounted` 补 workflow overlay 的 stopStream 调用（防止泄漏）。

当前：
```ts
onUnmounted(() => {
  subagentStore.stopStream(props.panelId)
})
```

改为：
```ts
onUnmounted(() => {
  subagentStore.stopStream(props.panelId)
  workflowStore.stopStream(props.panelId)
})
```

workflow store 需 export `stopStream`。

## 回调类型复用

`ApplyDeltaFn` / `FinalizeStreamFn` / `SetMessagesFn` 类型已定义在 subagent store。workflow store 直接 import 或在 workflow store 内重复定义（与 subagent 一致，保持 store 独立性）。

推荐：从 `@/stores/subagent` import 这三个类型（类型 import 不违反 store 铁律——不建立响应式依赖）。

## 验证清单

1. `cd packages/renderer && npx vue-tsc --noEmit`
2. `cd packages/renderer && npx vitest run src/__tests__/stores/workflow.test.ts`
3. 手动 dev：运行一个 workflow → 点 agent call node → Panel 显示该 agent 的实时逐字输出
4. streaming 终态后用权威历史覆盖（fetchAndInject）
5. 返回主会话/切 panel 时 stopStream 清理（无泄漏）
