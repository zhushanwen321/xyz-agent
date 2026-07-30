# Agent Call Streaming — pi-subagent-workflow 扩展侧改造

> 配套文档：[agent-call-streaming-xyz-agent.md](./agent-call-streaming-xyz-agent.md)（xyz-agent 侧改造）
>
> 扩展源码位置：`~/.xyz-agent-dev/pi/agent/extensions/subagent-workflow/`（dev）或 `~/.xyz-agent/pi/agent/extensions/subagent-workflow/`（prod）

## 目标

让 workflow 内的 agent call（executeAndAwait 路径）也创建 SubagentStream，使 text_delta 走 `subagent-stream-<recordId>` widget 通道，与 background subagent 走同一条 streaming 链路。

用户要求：「底层一套逻辑」——不新建独立通道，复用现有的 SubagentStream → setWidget → RPC stdout 链路。

## 现状

### 双通道互斥设计

`session-runner.ts` 的 `runSpawn` 是唯一执行入口，subagent background 和 workflow agent call 共用。分流点在 `agentEvent` 出口（session-runner.ts:481-489）：

```ts
const agentEvent = (event: AgentEvent): void => {
  updateFromEvent(record, event);
  if (event.type === "turn_end") limiter.onTurnEnd(record.turnCount);
  if (event.type === "text_delta") opts.stream?.onDelta(event.delta);  // 通道 A
  opts.onEvent?.(event);                                                 // 通道 B
};
```

两条路径的差异（`opts.stream` 和 `opts.onEvent` 谁有值）：

| 路径 | opts.stream | opts.onEvent | 调用链 |
|------|-------------|--------------|--------|
| **background subagent** | SubagentStream 有值 | undefined | `kickOffBackground`（subagent-service.ts:672）创建 stream |
| **workflow agent call** | undefined | 有值 | `executeAndAwait`（subagent-service.ts:441）不创建 stream |

### 为什么 workflow 没有 stream

`opts.stream` 在整个 `src/` 中只有**一个赋值点**：`subagent-service.ts:672`（kickOffBackground）。

workflow 路径的调用链每一层都没传 stream：

```
dispatchAgentCall (error-recovery.ts:297)
  → executeAgentCall (execute-agent-call.ts:130)     -- 无 stream 参数
    → runner.run (subprocess-agent-runner.ts:96)     -- 无 stream 参数
      → service.executeAndAwait (subagent-service.ts:473)  -- 无 stream 参数
        → runAndFinalize (subagent-service.ts:619)   -- 第 8 参 stream 缺省 undefined
          → runSpawn (session-runner.ts)             -- opts.stream = undefined
```

### 关键前提：stream 和 onEvent 已可共存

历史注释（subagent-service.ts:470）说双通道互斥的根因是 "onEvent 耦合 onUpdate"。但 `onUpdate` 现在已经在两条路径都被关掉了（executeAndAwait L475 和 kickOffBackground L405 都设 `onUpdate: undefined`）。所以 onEvent 和 stream **已经可以共存**——只是 executeAndAwait 没去构造 stream。

## 改造方案

### widgetKey 格式

```
subagent-stream-<runId>-<stepIndex>
```

- `runId`：workflow run ID（如 `wf-1783949493222-oq5rrs`）
- `stepIndex`：trace 节点的 stepIndex（= `msg.callId`，number）
- 前端从 WorkflowRunRecord.runId + WorkflowAgentCall.id 组合订阅

为什么不用 subagent 的 `bg-xxx` 格式：
- workflow 的 trace 节点用 stepIndex 索引（TUI/前端都按 stepIndex 定位）
- bg-xxx 是 session-runner 内部的 record.id，对 workflow 前端无意义
- `runId-stepIndex` 既唯一（跨 run 不冲突）又可被前端关联（trace 里有这两个值）

### 改动点（4 处透传 + 1 处创建）

#### 改动 1：error-recovery.ts — 创建 SubagentStream

`src/orchestration/error-recovery.ts:294-298`（dispatchAgentCall 内）

当前：
```ts
const onEvent = (event: AgentEvent): void => {
  updateFromEvent(liveRecord, event);
};
void runtime.gate
  .withSlot(() => executeAgentCall(call, deps.runner, run.state.budget, signal, run.state.trace, onEvent), signal)
```

改为：
```ts
const onEvent = (event: AgentEvent): void => {
  updateFromEvent(liveRecord, event);
};
// 创建 streaming sink：widgetKey = subagent-stream-<runId>-<stepIndex>
// 复用 service.streamSink（session_start hook 创建，两个域共享）
const stream = deps.service.streamSink
  ? new SubagentStream(`${run.runId}-${msg.callId}`, deps.service.streamSink)
  : undefined;

void runtime.gate
  .withSlot(async () => {
    try {
      await executeAgentCall(call, deps.runner, run.state.budget, signal, run.state.trace, onEvent, stream);
    } finally {
      stream?.dispose();  // 终态清 widget（与 kickOffBackground 一致）
    }
  }, signal)
```

**前置条件**：
- `deps` 需暴露 `service`（或直接暴露 `streamSink`）。检查 dispatchAgentCall 的 deps 类型定义。
- import `SubagentStream` from `../execution/stream-sink.ts`

#### 改动 2：execute-agent-call.ts — 签名加 stream

`src/orchestration/execute-agent-call.ts:120-130`

当前签名：
```ts
export async function executeAgentCall(
  call: AgentCall,
  runner: AgentRunner,
  budget: Budget,
  signal: AbortSignal,
  trace: Trace,
  onEvent?: (event: AgentEvent) => void,
): Promise<void> {
  call.markRunning();
  const result = await runner.run(call.opts, signal, onEvent);
```

改为：
```ts
export async function executeAgentCall(
  call: AgentCall,
  runner: AgentAgent,
  budget: Budget,
  signal: AbortSignal,
  trace: Trace,
  onEvent?: (event: AgentEvent) => void,
  stream?: SubagentStream,  // 新增
): Promise<void> {
  call.markRunning();
  const result = await runner.run(call.opts, signal, onEvent, stream);
```

注意：`finally { stream?.dispose() }` 放在调用方（error-recovery.ts），因为 executeAgentCall 有 retry 循环——retry 期间应复用同一个 stream（不每次 dispose）。实际上 dispose 应在 agent call **彻底结束**（不再 retry）后调用。所以 dispose 放 error-recovery 的 withSlot finally 是对的。

#### 改动 3：subprocess-agent-runner.ts — SAR.run 签名加 stream

`src/execution/subprocess-agent-runner.ts`

AgentRunner port 的 `run` 方法签名加 stream：

```ts
// ports.ts AgentRunner interface
export interface AgentRunner {
  run(opts: ExecuteOptions, signal: AbortSignal, onEvent?: (event: AgentEvent) => void, stream?: SubagentStream): Promise<WorkflowAgentResult>;
}
```

SAR 实现：
```ts
async run(opts: ExecuteOptions, signal: AbortSignal, onEvent?: (event: AgentEvent) => void, stream?: SubagentStream): Promise<WorkflowAgentResult> {
  // ... 透传 stream 给 service.executeAndAwait
  return this.subagentService.executeAndAwait(opts, signal, onEvent, stream);
}
```

#### 改动 4：subagent-service.ts — executeAndAwait 签名加 stream

`src/execution/subagent-service.ts:441`

当前签名：
```ts
async executeAndAwait(
  opts: ExecuteOptions,
  signal?: AbortSignal,
  onEvent?: (event: AgentEvent) => void,
): Promise<WorkflowAgentResult>
```

改为：
```ts
async executeAndAwait(
  opts: ExecuteOptions,
  signal?: AbortSignal,
  onEvent?: (event: AgentEvent) => void,
  stream?: SubagentStream,  // 新增
): Promise<WorkflowAgentResult> {
  // ...
  const result = await this.runAndFinalize(
    record, { ...opts, onUpdate: undefined }, ctx, identity,
    effectiveSignal, PRIORITY_BACKGROUND, onEvent, stream,  // 加 stream（第 8 参，当前 undefined）
  );
```

`runAndFinalize` 已有第 8 参 stream（subagent-service.ts:619-634），当前 background 路径传入、workflow 路径缺省 undefined。这里只需把 executeAndAwait 接收的 stream 透传进去。

### 无需改动的部分

- **session-runner.ts**：`opts.stream?.onDelta` 已是可选链，stream 有值就生效
- **stream-sink.ts**：SubagentStream 是通用的，widgetKey 由 constructor 参数决定
- **index.ts session_start**：`streamSink` adapter 已创建并存入 `service.streamSink`，两个域共享

### streamSink 可见性

检查 `SubagentService.streamSink` 字段是否对 error-recovery.ts 可见：

- `subagent-service.ts:175` 存 streamSink
- `error-recovery.ts` 的 `deps` 参数需要能访问 service 实例

如果 `deps` 不含 service，需要：
- 方案 A：deps 加 `service` 或 `streamSink` 字段
- 方案 B：在 dispatchAgentCall 的调用方（handleWorkerMessage）注入 streamSink

推荐方案 A：deps 加 `streamSink?: StreamSink`（可选，RPC 模式无 UI 时为 undefined）。

## RPC 模式兼容

xyz-agent 通过 RPC 调用扩展（`ctx.mode === 'rpc'`）。RPC 模式下 `ctx.ui.setWidget` 是否可用？

检查 `index.ts` session_start hook：
```ts
service.initSession({ pi, sessionId, streamSink: { setWidget: (key, lines) => ctx.ui.setWidget(key, lines) } })
```

`ctx.ui.setWidget` 在 RPC 模式下是否有效——这取决于 pi 的 extension_ui_request 通道在 RPC 模式下的行为。如果 RPC 模式不处理 ui_request，setWidget 是 no-op，streaming 无效（但不报错）。

**需验证**：xyz-agent runtime 的 event-adapter 是否捕获 RPC 模式下的 setWidget 事件。如果已捕获（subagent background streaming 在 xyz-agent 里能工作 → 已验证），workflow agent call 同样能工作。

## 验证步骤

1. 改完后在 xyz-agent 中运行一个 workflow（至少 2 个 agent call）
2. 点击 agent call node → Panel overlay 应显示逐字 streaming
3. agent call 结束后 streaming 停止，用权威历史覆盖
4. 多 agent call 并行时，每个 agent call 的 streaming 不串扰（widgetKey 含 stepIndex 区分）

## 风险

- **retry 期间 stream 复用**：executeAgentCall 有 retry 循环（attempts < MAX → 递归重试）。retry 不应 dispose stream（同一个 agent call 的 retry 共享 widget）。dispose 只在 withSlot 的 finally（agent call 彻底离开 slot）调用。改动 1 已按此设计。
- **parallel agent call 并发**：workflow 支持并行（ConcurrencyGate maxConcurrency=4）。多个 agent call 同时 streaming 时，各自有独立的 SubagentStream（widgetKey 不同），互不影响。
- **dispose 时序**：agent call 终态（completed/failed）后 dispose 清除 widget。前端收到 `lines: undefined` 后 finalize + 拉完整历史。
