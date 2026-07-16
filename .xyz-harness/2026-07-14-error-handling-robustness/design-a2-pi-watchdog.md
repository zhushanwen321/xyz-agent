# A2. pi 卡死 turn 级 watchdog 设计

> 对应 Wave W6 / MUST FIX #10。最复杂的架构项之一。

## 1. 背景与问题

handoff 2026-07-04 P1「pi 静默卡死」事故至今未根治。`event-adapter.ts:689-701` 注释明确写道：

> 情况 A：pi 子进程静默卡死（无任何事件）→ 需 runtime 加 watchdog

**现状**：pi 子进程 0% CPU、不退出、不发任何事件。runtime 的 `isGenerating` 永久 true。前端 streaming 超时恒为 24h（IPC TODO 未接），用户只能手动 abort（而 abort 本身也要等 60s RPC 超时）。

**根因**：RPC 超时只覆盖"请求/响应"（prompt 的 60s 是等 pi acknowledge），不覆盖"ack 之后事件流静默"的空窗期。从 pi → runtime → supervisor → 前端四层都没有活性检测。

**已做对的部分**（保留不动）：
- pi stdout JSONL 落盘（`rpc-client.ts:193`）—— 诊断证据已就位
- abort 成功/失败都有兜底广播（`message-dispatcher.ts:162-187`）—— watchdog 触发后复用此路径

## 2. 设计目标

| 目标 | 说明 |
|------|------|
| 检测 pi 生成中静默卡死 | prompt acknowledge 后，N 秒内无任何 pi 事件 → 判定卡死 |
| 自动恢复 | 卡死后自动触发 abort + 广播终态，复用现有 abort 路径 |
| 低误报 | 正常长思考/长工具执行不被误判（阈值分级） |
| per-session 隔离 | 一个 session 的 watchdog 不影响其他 session |

## 3. 核心决策

### 3.1 watchdog 挂在哪一层？

**选项**：EventAdapter 层 / EventInterpreter 层 / message-dispatcher 层

**决策：EventInterpreter 层**

理由（来自代码事实）：
- EventInterpreter 是 **per-session 且持有可变态**（currentMessageId/statusBaseline/writeContents），与 session 1:1
- 它能感知每个 pi 事件（经 `handle(ev)` 的 switch），是"事件是否到达"的天然观察点
- isGenerating 由 `sendPrompt` 置 true（`message-dispatcher.ts:101`）、由 `handleTurnEndSideEffects` 置 false（agent_end 链路）——watchdog 需要在"true 期间无事件"时触发

**不选 message-dispatcher 的原因**：它是命令编排层，不是事件观察点。事件经 EventInterpreter 消费后才到 dispatcher 的副作用回调，放在 dispatcher 层无法感知"事件是否到达"。

### 3.2 阈值设计（最难点）

pi 的 turn 事件序列（来自事实）：
```
agent_start → [turn: turn_start → message_start → message_update* → tool_execution_start → tool_execution_update? → tool_execution_end → turn_end]* → agent_end
```

**难点**：工具执行期间（`tool_execution_start` → `tool_execution_end`）可能长时间无 `text_delta`；`tool_execution_update` 是可选的，不一定有。Claude Opus 长思考可能 60-90s 无 `text_delta`。

**决策：两级阈值 + 活动事件重置**

| 级别 | 阈值 | 动作 |
|------|------|------|
| WARN | 120s 无活动事件 | `console.warn` + 广播 `message.stream_error{kind:'silent'}`（前端可显示"长时间无响应"提示，不阻塞） |
| ABORT | 300s 无活动事件 | 自动触发 abort + 广播 `message.error`（终态） |

**"活动事件"定义**（任何一条都重置计时器）：
- `message_update`（text_delta / thinking_*）
- `tool_execution_start` / `tool_execution_update` / `tool_execution_end`
- `auto_retry_start` / `auto_retry_end`

**不计为活动的事件**：`agent_start` / `turn_start` / `message_start` / `message_end`（pi 内部记账）/ `turn_end`（单 turn 结束但 agent 可能继续，到达时 watchdog 本就该重启计时）。

**阈值可配**：环境变量 `XYZ_PI_SILENT_ABORT_MS`（默认 300000）/ `XYZ_PI_SILENT_WARN_MS`（默认 120000），dev 可调。注意需加到 ENV_WHITELIST（`XYZ_` 前缀已自动通过）。

### 3.3 watchdog timer 生命周期

```
sendPrompt 成功（isGenerating=true）
  → startWatchdog(sessionId)              // 启动
活动事件到达
  → resetWatchdog(sessionId)              // 重置计时器
agent_end 到达 / isGenerating=false
  → clearWatchdog(sessionId)              // 清除
WARN 阈值到达
  → console.warn + 广播 stream_error      // 不清除，继续等 ABORT
ABORT 阈值到达
  → triggerAbort(sessionId)               // 调现有 abort 路径
  → clearWatchdog(sessionId)              // 清除（abort 会广播终态）
session 销毁
  → clearWatchdog(sessionId)              // 清除（防泄漏）
```

### 3.4 与现有 abort 路径的集成

watchdog 触发的 abort **直接复用 `message-dispatcher.abort`** 的完整路径：
- `client.abort()` 成功 → 广播 `message.complete{stopReason:'aborted'}`
- `client.abort()` 失败 → 广播 `message.error`（已有兜底）
- 两者都重置 `isGenerating = false`

**新增**：watchdog 触发 abort 时，广播的 error 消息需区分"用户主动 abort"和"watchdog 自动 abort"，前端可显示不同提示（如"pi 长时间无响应，已自动中断"）。

### 3.5 与前端 streaming 超时的协同

前端 `chat.ts` 的 streaming 超时当前恒 24h（`readStreamingTimeoutMs` 是 TODO 桩）。

**决策**：前端超时降到合理值作为**第二道防线**（如 10min），与 runtime watchdog（5min）形成两层保护。前端超时只做 UI 兜底（标记 streaming 失败 + 提示用户），不触发 runtime abort（runtime watchdog 已处理）。

**暂不接 IPC 读 `XYZ_STREAMING_TIMEOUT_MS`**——前端硬编码 10min 即可，避免增加 IPC 复杂度。若未来需用户可配再接。

## 4. 数据结构

EventInterpreter 新增 watchdog 状态：

```typescript
// event-interpreter.ts 内新增字段
private watchdogTimer: ReturnType<typeof setTimeout> | null = null
private watchdogWarned = false

// 构造注入的回调（由组合根 index.ts 提供）
constructor(
  private sessionId: string,
  private opts: {
    // ... 现有 opts
    onSilentAbort?: (sessionId: string) => void  // 新增：watchdog 触发时调
  },
)
```

## 5. 改动范围

| 文件 | 改动 | 类型 |
|------|------|------|
| `event-interpreter.ts` | 新增 watchdog timer 管理（start/reset/clear）+ 活动事件检测点 | 核心 |
| `event-interpreter.ts` | `handle()` 的 `message`/`tool-call-start`/`tool-call-end`/`turn-start` 分支加 `resetWatchdog()` | 核心 |
| `event-interpreter.ts` | `handleTurnEnd`（agent_end）加 `clearWatchdog()` | 核心 |
| `index.ts` | `createAdapter` 闭包注入 `onSilentAbort` 回调，指向 `sessionService.abortSession` | 组合根 |
| `message-dispatcher.ts` | abort 路径新增 `reason: 'watchdog'` 参数（区分主动/自动） | 小改 |
| `chat.ts`（前端） | `DEFAULT_STREAMING_TIMEOUT_MS` 从 24h 降到 10min | 小改 |

## 6. 测试策略

| 场景 | 方法 |
|------|------|
| 正常 turn 不误报 | mock pi 事件流（每 30s 一个 text_delta），断言 watchdog 不触发 |
| 工具执行长时间不误报 | mock tool_execution_start 后 100s 发 tool_execution_end，断言不触发 |
| 静默卡死检测 | mock prompt 成功后不发任何事件，`vi.useFakeTimers` + `advanceTimersByTime(300000)`，断言 abort 被调用 + 广播 error |
| WARN 级别 | mock 120s 无事件，断言 stream_error 广播但 abort 未调用 |
| session 销毁清理 | mock session 销毁，断言 watchdog timer 被 clear（无泄漏） |
| agent_end 正常清除 | mock 正常 agent_end，断言 watchdog timer 被 clear |

测试框架：vitest（`npx vitest run`），fake timers 模拟超时。

## 7. 风险与取舍

| 风险 | 缓解 |
|------|------|
| 阈值误报打断正常长任务 | 两级阈值（WARN 先提示）+ 阈值可配 + ABORT 300s 是保守值 |
| 阈值太松导致卡死体验差 | supervisor 存活探针（A6）作为外层补充 |
| watchdog 自身 bug 导致误 abort | WARN 级别先上线观察一段时间，ABORT 阈值可临时调到极大值禁用 |
| 多 turn 的 agent 循环 | turn_end 不清 watchdog（agent 可能继续），只有 agent_end 清 |

## 8. 待决策（需用户确认）

| # | 决策点 | 推荐方案 | 备选 |
|---|--------|---------|------|
| 1 | ABORT 阈值 | 300s（5min，保守） | 180s（3min，激进）/ 用户可配 |
| 2 | WARN 阈值 | 120s（2min） | 不做 WARN，单级直接 ABORT |
| 3 | 前端 streaming 超时 | 降到 10min | 保持 24h / 接 IPC 可配 |
