# workflow 扩展适配说明 — 对接契约

> 本文档描述 pi-subagent-workflow 扩展（feat-ask-user-gui 分支）与 xyz-agent GUI 的 workflow 功能对接。
>
> **背景**：xyz-agent 左侧边栏新增 Flows tab，可视化展示 workflow run 列表、phase/agent call 详情、agent call 对话流。列表数据和对话流通过 xyz-agent runtime 直读 JSONL 实现，**不依赖扩展**。操作按钮（pause/resume/abort）经扩展 slash command 执行。
>
> **现状（2026-07-13 调研确认）**：扩展侧的 RPC 适配**已全部实现**。本文档作为对接契约存档，供后续维护参考。

## 1. 扩展侧已实现的能力（无需额外开发）

### 1.1 workflow run 数据持久化

| 数据 | 位置 | 写入时机 |
|------|------|---------|
| workflow 状态快照 | `<sessionDir>/workflow-state/<runId>.jsonl` | 每次 phase 变化（RunStore.save，rewrite mode） |
| 主 session 指针 | 主 session JSONL 的 `workflow-state-link` custom entry | 每次 RunStore.save（pi.appendEntry） |
| 完成通知 | `workflow-result` custom message（pi.sendMessage） | run 到达 done 终态（notifyDone） |

**关键**：xyz-agent runtime 直读这些文件，不经扩展 API。扩展只需保证持续写入。

### 1.2 `/workflows` slash command 的 RPC 分支

**已实现**（commit `2003e64a1`）。源码：`extensions/subagent-workflow/src/interface/commands.ts:62-103`。

```typescript
api.registerCommand("workflows", {
  handler: async (args: string, ctx) => {
    if (ctx.mode === "rpc") {
      const parsed = parseWorkflowRpcCommand(args);
      switch (parsed.action) {
        case "pause":  await pauseRun(parsed.runId, deps); break;
        case "resume": await resumeRun(parsed.runId, deps); break;
        case "abort":  await abortRun(parsed.runId, deps); break;
        // ... missing-id / noop 分支
      }
      return;
    }
    // TUI 模式：打开交互面板（原逻辑不变）
  },
});
```

### 1.3 `workflow-result` 完成通知

**已实现**（commit `ee338e079` + `notifyDone` 函数）。源码：`extensions/subagent-workflow/src/interface/helpers.ts:60-136`。

workflow run 到达 done 终态时，扩展经 `pi.sendMessage` 注入结果消息：

```typescript
pi.sendMessage(
  {
    customType: "workflow-result",
    content: "Workflow 'name' done: status (reason)\n...",
    display: true,
    details: {
      runId: "wf-...",
      name: "script-name",
      status: "done",
      reason: "completed" | "failed" | "aborted" | "budget_limited" | "time_limited",
      traceLength: 7,
      __gui__?: { v: 1, component: { type: "list-tree", props: {...} } },  // RPC 模式附加
    },
  },
  { triggerTurn: true, deliverAs: "steer" },
);
```

xyz-agent runtime 的 event-adapter 已透传此消息为 `message.customStart` WS 帧。xyz-agent event-interpreter 需新增 handler 消费它（见本文档 §3）。

### 1.4 subagent text_delta streaming（参照，workflow 无此通道）

subagent 扩展通过 `ctx.ui.setWidget('subagent-stream-<id>')` 推送执行期逐字流。**workflow 路径没有此通道**——workflow run 在独立 worker 线程执行，状态变化只走 RunStore.save 持久化，不外推执行期进度。

xyz-agent 如需 workflow 执行期 phase 级实时进度，只能 fs.watch workflow-state 目录（方案 C），或接受「发起 + 结束」两个时刻的推送覆盖（方案 B，本文档推荐）。

---

## 2. xyz-agent 侧的调用方式

### 2.1 操作按钮（pause/resume/abort）

扩展 RPC 分支已就绪，xyz-agent runtime 通过 `client.prompt()` 触发：

```typescript
// 暂停 workflow
await client.prompt(`/workflows pause ${runId}`);

// 恢复 workflow
await client.prompt(`/workflows resume ${runId}`);

// 终止 workflow
await client.prompt(`/workflows abort ${runId}`);
```

**不经 LLM**。pi 的 `session.prompt()` 检测到 `/` 开头会调 `_tryExecuteExtensionCommand`，匹配到扩展注册的 command 就执行 handler 并 return（不走 agent loop / LLM）。操作是即时的，不消耗 token。

**操作反馈链路**：
```
xyz-agent 前端点 Pause 按钮
  → runtime: client.prompt("/workflows pause wf-xxx")
  → pi: session.prompt() → _tryExecuteExtensionCommand("workflows", "pause wf-xxx")
  → 扩展 handler: ctx.mode === "rpc" → parseWorkflowRpcCommand → pauseRun(runId, deps)
  → RunStore 状态变 paused → 写 workflow-state/<runId>.jsonl（status:paused）
  → 扩展 handler 返回 ctx.ui.notify("Workflow wf-xxx: paused")
  → xyz-agent 前端下次拉取（或收到推送）看到 paused 态
```

### 2.2 列表数据 + 对话流（不经扩展）

| 数据 | 获取方式 | 扩展参与 |
|------|---------|---------|
| workflow 列表 | xyz-agent runtime 读主 session JSONL 的 `workflow-state-link` entry → 读 path 指向的 state 文件 | 不参与 |
| phase / agent call 列表 | 同上（state 文件含 `state.trace[]`） | 不参与 |
| agent call 对话流 | xyz-agent runtime 按 `trace[].sessionId` 找 session JSONL → 读消息历史 | 不参与 |
| 重启后恢复 | JSONL 文件持久化，runtime 重扫 | 不参与 |

---

## 3. xyz-agent 侧需新增的 event-interpreter handler

### 3.1 捕获 `workflow-result` customStart（结束时刻推送）

当前 event-interpreter 只处理 `subagent-bg-notify`，需新增 `workflow-result` 分支：

```typescript
private handleWorkflowResult(msg: ServerMessage): void {
  const payload = msg.payload as { customType?: string; details?: Record<string, unknown> } | undefined
  if (payload?.customType !== 'workflow-result') return
  const details = payload.details
  if (!details) return

  const runId = typeof details.runId === 'string' ? details.runId : null
  if (!runId) return

  // 推送增量信号（runId + status + reason），前端收到后触发 RPC 拉取完整数据
  this.broadcastWorkflowUpdate({
    runId,
    status: 'done',
    reason: typeof details.reason === 'string' ? details.reason : undefined,
  })
}
```

### 3.2 捕获 workflow toolCall（发起时刻推送）

workflow tool 的 `action=run` toolCall 返回 `details:{action:'run', runId, status:'running', name, slug}`。event-interpreter 在 tool-call-end 捕获：

```typescript
private handleWorkflowToolEnd(toolCallId: string, details: Record<string, unknown> | undefined): void {
  if (!details) return
  if (details.action !== 'run' || details.status !== 'running') return
  const runId = typeof details.runId === 'string' ? details.runId : null
  if (!runId) return

  this.broadcastWorkflowUpdate({
    runId,
    status: 'running',
    // 发起时刻无完整数据，前端收到后调 loadWorkflows RPC 拿 agentCalls
  })
}
```

### 3.3 广播 session.workflows

```typescript
private broadcastWorkflowUpdate(update: { runId: string; status: string; reason?: string }): void {
  this.opts.send({
    type: 'session.workflows' as ServerMessageType,
    payload: {
      sessionId: this.sessionId,
      update,  // 增量信号，非全量列表
    },
  })
}
```

前端收到 `session.workflows` 后触发 `loadWorkflows` RPC 拉取完整列表（含 agentCalls）。

**设计决策**：推送增量信号而非全量数据。理由：
- 发起时刻 runtime 没有 agentCalls（workflow 刚启动，worker 还没产出 trace）
- 全量数据需 runtime 读 workflow-state JSONL，增加复杂度
- 增量信号 + RPC 拉取复用现有 loadWorkflows 链路，零新增 IO 逻辑

---

## 4. 扩展侧可选的增强（非阻塞，优先级低）

以下能力扩展**当前未实现**，xyz-agent 可降级处理。如未来扩展侧有精力，可按优先级实现：

### 4.1 workflow 执行期 phase 级推送（低优先级）

**现状**：workflow run 的 phase 进度（如 "Dev phase 2/4 完成"）只持久化到 workflow-state JSONL，不外推。xyz-agent 只能在用户切 tab 时 RPC 拉取。

**可选增强**：扩展在 `RunStore.save` 后经 `pi.sendMessage` 或 `ctx.ui.setWidget` 推送 phase 进度。但这涉及 worker → 主线程的通信改造，复杂度较高。

**xyz-agent 降级方案**：用户切 Flows tab 时 RPC 拉取，或接受「发起 + 结束」两个时刻的自动刷新。中间进度需手动切 tab。

### 4.2 workflow-result 携带完整 agentCalls（低优先级）

**现状**：`workflow-result` 的 details 只含 `runId/name/status/reason/traceLength`，不含 agentCalls 详情。xyz-agent 收到推送后需额外 RPC 拉取。

**可选增强**：notifyDone 时把 `trace.toArray()` 的展示子集（agent/phase/status/sessionId/tokens/duration）塞进 details。

**xyz-agent 降级方案**：收到推送后调 loadWorkflows RPC。多一次 RPC 往返，但数据完整。

---

## 5. 对接契约总结

| 能力 | 扩展侧 | xyz-agent 侧 | 状态 |
|------|--------|-------------|------|
| workflow-state JSONL 持久化 | RunStore.save | 直读 | ✅ 扩展已实现 |
| workflow-state-link 指针 | pi.appendEntry | 直读主 session JSONL | ✅ 扩展已实现 |
| `/workflows pause/resume/abort` RPC | ctx.mode==='rpc' 分支 | client.prompt | ✅ 扩展已实现 |
| `workflow-result` 完成通知 | pi.sendMessage | event-interpreter 消费 | ✅ 扩展已实现 / ⏳ xyz-agent 待实现 |
| workflow 发起时刻推送 | tool details:{action:'run'} | event-interpreter 捕获 | ✅ 扩展已实现 / ⏳ xyz-agent 待实现 |
| 列表/详情/对话流数据 | 不参与 | runtime 直读 JSONL | ⏳ xyz-agent 待实现 |
| 执行期 phase 级推送 | 未实现 | 降级：RPC 拉取 | ❌ 可选增强 |

**结论**：扩展侧无需额外开发。xyz-agent 侧需实现 runtime 数据链 + 前端视图 + event-interpreter 两个 handler。

---

## 6. 验证方法

### 6.1 扩展 RPC 分支验证（已就绪）

```bash
# 启动一个 workflow run，记下 runId
# 在 xyz-agent runtime 层调：
client.prompt("/workflows pause <runId>")
# 预期：handler 走 RPC 分支，调 pauseRun，返回 notify（不打开 TUI）
# workflow-state JSONL 中 status 变为 "paused"
```

### 6.2 workflow-result 推送验证

```bash
# 启动一个 workflow run，等其完成
# 抓 pi RPC stdout，应看到 customType:"workflow-result" 的 sendMessage
# xyz-agent event-adapter 应透传为 message.customStart WS 帧
```

### 6.3 xyz-agent 集成验证

1. 启动 xyz-agent，发起一个 workflow run
2. 在 Flows tab 看到该 run（running 态）
3. 点 Pause 按钮 → run 状态变 paused
4. 点 Resume 按钮 → run 状态变 running
5. run 完成后 → 状态自动变 done（经 workflow-result 推送，不需手动刷新）
6. 点 run 卡片 → 进入 phase/agent call 详情
7. 点 agent call → 主 Panel 显示该 agent call 的对话流

---

## 7. 注意事项

1. **`ctx.hasUI` 不能用于区分 RPC 和 TUI**。两个模式 `hasUI` 都为 true。必须用 `ctx.mode === "rpc"`。（扩展已正确实现）

2. **slash command 不经 LLM**。pi 检测 `/` 开头直接执行 command handler，不消耗 token。pause/resume/abort 是即时的。

3. **workflow-state-link 可能重复**。RunStore.save 每次 phase 变化都 appendEntry，同一 runId 在主 session JSONL 里有多条 workflow-state-link。xyz-agent extractor 需按 runId 去重，保留最新 path。

4. **旧格式 workflow-state 文件无版本号**。`v !== "wf-run-v1"` 的快照应跳过（D-5 不向后兼容设计）。实测最老的文件（2026-06-04）无版本号。

5. **agent call JSONL 定位**。trace 节点只含 sessionId（pi session ID），不含文件路径。pi session 文件命名 `<ISO>_<sessionId>.jsonl`，可用文件名 glob 定位（`find ... -name "*_<sessionId>.jsonl"`），比 scanPiSessions 全扫快。
