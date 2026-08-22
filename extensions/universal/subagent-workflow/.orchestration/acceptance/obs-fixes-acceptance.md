# obs-fixes 验收标准

> **builder 与 verifier 禁止修改本文档**（防篡改基线，commit 后以 git diff 为锚）。
>
> unit：obs-fixes — one-shot feature gate 遗留观察项 2 项根除（ledger 观察项节：S7 残留瞬时污染 + rebuild 路径可观察性）。
> 基线：本文档 commit hash（派发时填入）。

## 目标

1. **OB2（S7 残留）**：消除 rebuild 竞态窗口中旧代际 `finalizeCall` 的 `trace.update` 对重跑新节点的瞬时污染。现状：`discardInFlightCalls` 只清 Map/trace 条目，旧 `executeAgentCall` promise 链醒来后 `finalizeCall`（execute-agent-call.ts:82-95）无条件 `trace.update(call.id, …)`——若重跑已 append 同 stepIndex 新节点则命中新节点，TUI/中间快照短暂可见错误终态（终态由重跑完成时覆盖，gate 判定可接受残留，本 unit 根除）。
2. **OB3（可观察性）**：`rebuildRuntime`（error-recovery.ts:178-224）函数体现状 0 处 `deps.log` 调用，崩溃自愈只能靠行为证据诊断。补关键节点 debug 日志。

## 交付物（文件级，精确清单）

| 文件 | 变更 |
|---|---|
| `extensions/subagent-workflow/src/orchestration/execute-agent-call.ts` | OB2：`executeAgentCall` 尾参新增 `isOrphaned?: () => boolean`；`finalizeCall` 内 `trace.update` 前守卫；递归重试点透传 |
| `extensions/subagent-workflow/src/orchestration/error-recovery.ts` | OB2：`dispatchAgentCall` 的 `executeAgentCall(...)` 调用处注入 `() => isOrphanedCall(run, msg.callId, call)`。OB3：`rebuildRuntime` 补 4 个日志点；`discardInFlightCalls` 返回丢弃 callId 列表 |
| `extensions/subagent-workflow/src/orchestration/__tests__/execute-agent-call.test.ts` | OB2 新增守卫行为测试 |
| `extensions/subagent-workflow/src/orchestration/__tests__/error-recovery-handlers.test.ts` | OB2 新增「重跑新节点不被污染」集成级测试；OB3 新增日志点断言 |

仅允许新建/修改上述 4 文件。

## 接口契约（签名锁定）

### OB2

```ts
// execute-agent-call.ts
export async function executeAgentCall(
  call: AgentCall, runner: AgentRunner, budget: Budget, signal: AbortSignal,
  trace: Trace, onEvent?: (event: AgentEvent) => void, stream?: SubagentStream,
  isOrphaned?: () => boolean,   // ← 新增尾参，可选，默认恒 false
): Promise<void>
```

- `finalizeCall`（内部函数）接收谓词（参数或闭包均可，实现自选）：`isOrphaned?.() === true` 时**跳过 `trace.update`**；`call.markDone(result)` 与 sessionId/sessionFile 同步保留（markDone 在孤儿实例上无害——error-recovery.ts 注释既定结论；且 dispatch 层 catch 路径依赖 `call.status` 语义）。跳过时**不引入 logger**（本文件无日志通道，纯函数层；dispatch 层 `.then` 守卫的 `orphan agent call completion dropped` 日志已覆盖同一事件可观察性）。
- 递归重试点（现状 :176 `await executeAgentCall(call, …)`）必须透传 `isOrphaned`。
- `dispatchAgentCall`（error-recovery.ts）仅改 `executeAgentCall(call, deps.runner, run.state.budget, signal, run.state.trace, onEvent, stream)` 一行（约 :388），追加第 8 参 `() => isOrphanedCall(run, msg.callId, call)`。`resolveAgentOpts` 失败同步路径不经 `executeAgentCall`，零改动。

**行为场景表（验收锚点）**：

| # | 场景 | `run.state.calls.get(callId)` | 守卫 | `trace.update` | 与现状对比 |
|---|---|---|---|---|---|
| S1 | 正常执行（无 rebuild） | `=== call` | false | 执行 | 逐字节一致（零行为变化） |
| S2 | discard 后、重跑 dispatch 尚未 set 新实例 | `undefined` | true | 跳过 | 等价（现状此窗口节点已删，update 本为 no-op——trace.ts 防御） |
| S3 | discard 后、重跑 dispatch 已 set 新实例（同 callId 新 `AgentCall`） | `!== call` | true | 跳过 | **本 unit 目标**：消除新节点瞬时污染 |

正确性论证锚（写入代码注释）：运行期 calls Map 写点仅 `discardInFlightCalls` 的 delete 与 `dispatchAgentCall` 的 set 两族（error-recovery.ts `isOrphanedCall` 文档注释既定），故实例不等 ⟺ 本 finalize 属于被丢弃/被替换的旧代际——与 dispatch 层 `.then`/`.catch` 守卫（S7-second 修复，8353f6b60）同一判定语义，本守卫只是把它前移到 `trace.update` 之前。

### OB3

`rebuildRuntime` 补 4 个日志点，风格对齐本文件既有 `deps.log?.("debug", "workflow:error-recovery", "<message>", { runId: run.runId, … })`：

| # | 位置 | message（建议值） | payload 必含 |
|---|---|---|---|
| L1 | 函数入口 | `runtime rebuild start` | `runId`、`budgetTimeMs`（数值或 undefined） |
| L2 | timeBudgetTimer 重排成功分支 | `time budget rescheduled` | `runId`、`budgetTimeMs` |
| L3 | discard 之后 | `in-flight calls discarded` | `runId`、`callIds`（数组）、`count` |
| L4 | `replaceRuntime` 之后（函数末尾） | `runtime rebuild complete` | `runId` |

- `discardInFlightCalls` 签名 `void → number[]`（返回丢弃的 callId 数组，升序），唯一调用点即 `rebuildRuntime`。
- 不改变任何控制流/异常语义；无 budgetTimeMs 时 L2 不打（该分支本就跳过重排）。

## 单测验收（逐条可查）

**OB2**（execute-agent-call.test.ts 追加 describe `isOrphaned 守卫`）：

- U1 谓词 `() => true` + 终态成功路径 → `trace.update` 未被调用（spy 断言 0 次），`call.status === "done"`、`call.result` 已设置（markDone 保留）
- U2 谓词 true + stale-context 失败路径 → 同上（覆盖第 2 个 finalize 调用点）
- U3 谓词 true + 信号 abort 路径 → 同上（覆盖第 3 个调用点）
- U4 谓词 undefined（不传）→ `trace.update` 恰被调用 1 次（现状回归锁定）
- U5 递归重试透传：可重试失败 → 谓词 true → 重试后终态 `trace.update` 仍 0 次（证明谓词穿透递归层）

**OB2**（error-recovery-handlers.test.ts 追加，集成级）：

- U6 S3 场景重放：dispatch call → `rebuildRuntime`（discard 移除在飞 call）→ 再次 dispatch 同 callId（新实例 + 新 trace 节点 running）→ 令旧 runner 的 pending promise resolve 旧结果 → 断言新 trace 节点仍为 running（status/result 未被旧 finalize 污染），且旧 call 实例 status === "done"。红性锚点：去掉 OB2 守卫本测试必须红（verifier 红性验证执行项）。

**OB3**（error-recovery-handlers.test.ts 追加 describe）：

- U7 `rebuildRuntime` 后 `deps.log` spy 按序收到 L1/L4（含 runId）；带 budgetTimeMs + scheduleTimeBudget 注入时含 L2
- U8 含 2 个在飞 call 的 run 经 rebuild → L3 payload `callIds` 升序等于被弃 callId、`count === 2`；`discardInFlightCalls` 返回值与日志一致
- 既有 `rebuildRuntime`/S7 回归用例全绿（8353f6b60 引入的 4 个孤儿守卫用例不得回归）

## 通过命令（自验 + verifier 实跑）

```bash
cd /Users/zhushanwen/Code/xyz-agent-workspace/feat-subagent-continuous-chat
pnpm extensions:typecheck        # exit 0
pnpm extensions:lint             # exit 0，零新增告警
cd extensions/subagent-workflow && npx vitest run   # 全绿（现状基线 2187 passed / 0 failed，b843a5f49 后无已知豁免）
```

## 禁改清单（违反 = FAIL）

- 验收文档本体（本文件）
- `error-recovery.ts` 中 `isOrphanedCall` 定义及其 `.then`/`.catch` 两个 dispatch 守卫块（已验收 S7 修复区，8353f6b60）——只允许在 `executeAgentCall` 调用行追加参数
- `dispatchAgentCall` 的 `resolveAgentOpts` 失败同步路径（约 :337-357）
- `execute-agent-call.ts` 的重试/退避/预算决策逻辑（只加守卫与参数，不改任何分支条件）
- slice5 已实施区（wave1/wave2 全部文件：config-loader / worker-script-builder / schema-jsonify / skill-discovery / workflow-script / launcher / WorkflowsView / format / helpers / resource-discovery / list-component / subagent-service #22 删除面）
- 性能勿动清单：record-store stat 戳缓存 / onUpdate 节流排除 text_delta（已删，不得复活）/ notifier 滑动窗口 / injector session 缓存 / turn.text += delta / ajv.compile 不缓存 / stderr 64KB 截断 / save 签名与 11 调用点 / workflow-state-link 写入时机
- 任何 git 写操作（add/commit/push 由主 agent 统一执行）

## status: pending
