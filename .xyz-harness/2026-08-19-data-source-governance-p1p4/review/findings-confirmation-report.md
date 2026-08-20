# data-source-governance gate 发现问题对抗式审查确认报告

> 审查对象：`gate/p1p2-gate-report.md` §三（问题 1/3-7）+ `gate/p3-gate-report.md` §四（问题 1-3，本报告编号 7/8/9）+ W24 taste-lint 三 minor（编号 10）。
> 审查方式：读码 + pi 0.84.1 binary strings 提取 + gate 期间一手日志（`~/.xyz-agent-dev/logs/runtime-2026-08-19.log`、pi tee JSONL）取证。未起 dev app、无模型调用、无生产代码改动、无 git 写操作。
> restore/fork tmp 附着管线本体（p1p2 问题 2）按任务边界不在范围（用户在修）。

## 结论总表

| # | gate 发现 | 判定 | 一句话根因 |
|---|---|---|---|
| 1 | [高] 断连 turn「已工作」重连后不复位 | **部分成立** | 断连（非 runtime 崩溃）无 streaming 复位兜底 + turn 级工作指示误用 session 级活跃信号（与 #8 同根因）；gate 归因「广播未补齐」不准确 |
| 2 | [中] error turn 流状态卡死 + 抑制后续渲染 | **部分成立** | error 收口分支代码正确；「抑制渲染」无独立代码机制，系 restore-tmp 附着 + 断连 + UI↔pi 活跃态脱节复合（gate 已判作废） |
| 3 | [中] 重连初始化批次 pre-auth 被丢弃 | **成立** | renderer `ws-client.send()` 只查 readyState=OPEN 不查 auth 完成；TCP open→auth.result 窗口（实测 92ms 起）内任何 send 真实送出即被 runtime 设计性静默丢弃 |
| 4 | [低] cwd 死路径非活跃改名静默失败 | **成立（根因链修正）** | pi 0.84.1 `switchSession` 硬断言 `assertSessionCwdExists`；xyz `withEphemeralPi` 对 header cwd 死路径无降级（注释声明由调用方处理，但 renameSession 调用方未处理） |
| 5 | [低] runtime 半开连接计数堆积 | **成立（影响有限）** | offline 阻断 renderer 侧 close 帧送达 → 半开连接留在池；45s heartbeat 超时自愈已存在，主要是日志 total 语义误导 |
| 6 | [低] 活跃态 Enter 直发与 Composer 注释不符 | **不成立** | Composer 代码与注释一致（活跃 Enter→steer）；gate 观察的直发是 UI isActive=false 而 pi busy 的活跃态脱节表现（#1/#2 族衍生），非 Composer 路由 bug |
| 7 | [中] `!` bash live 输出丢失（protocol error 占位） | **成立（归因修正）** | gate 归因「shape guard 期望差异」不对——guard 期望的 shape 与 pi 实际 response 完全一致；真根因是 pi 0.84.1 新增 `bash_execution_update` 流事件复用同一 RPC id，runtime `handleMessage` 仅凭 id 就把首条 delta 事件误 resolve 为 bash response |
| 8 | [中] turn-meta 工时 live 期不复位（无断连也复现） | **成立** | `isWorkingTurn = sessionActive && isLastTurn` 用 session 级活跃信号驱动 turn 级显示；subagent「running-resumable」设计（轮终回 running）与 UI「working=后台在跑」语义冲突 → 完成注入后末位 turn 永久「工作中」 |
| 9 | [中] 重开后 session 名回退文件名 | **不成立（UI 元素误读）** | 顶部「01a019c7.jsonl」是 PanelHeader 恒显的复制路径 chip（设计内元素）；session 实名（auto-rename）已正确落原 JSONL line 4 |
| 10 | W24 taste-lint 三 minor | **三条全部成立** | a) stale 检查位于提前 return 之后；b) detachedMethodRef 文案缺登记表路径；c) paramOwnerFn 按形参名做 key 多函数覆盖 |

---

## 1. [高] 断连 turn「已工作」重连后不复位 — 部分成立

### 1.1 isStreaming → UI 派生链（登记表 #11 现状核实）

两级显示信号（`packages/ui/src/features/chat/Turn.vue:157-162`）：

```ts
const isStreaming = computed(() => props.turn.isStreaming)          // turn 级：计时器/spinner
const sessionActive = computed(() => props.isSessionActive ?? ...)  // session 级
const isWorkingTurn = computed(() => sessionActive.value && (props.isLastTurn ?? false))  // label「工作中/已工作」
```

- `turn.isStreaming` 派生自 `packages/core/src/domain/chat/message-turns.ts:169-177` `computeIsStreaming`：末位 turn 最后一条 assistant `status === 'streaming'`（或 subagent 虚拟 session 的 forceWorking）。
- `chat.isGenerating(sid)` 不变式（`packages/core/src/domain/chat/store.ts:213-227`）：`∃ assistant 消息 status==='streaming'`，与上同源。
- `sessionActive` 来自 `useSessionActive`（`packages/renderer/src/composables/panel/useSessionActive.ts:21-28`）：`derivedStatus ∈ {streaming, waiting, working, pending, compacting, retrying}`，其中 **working = hasBackgroundWork（subagent/workflow record 处于 running）**（`packages/core/src/domain/chat/derive-status.ts:113` + `packages/renderer/src/composables/features/chat/useBackgroundWork.ts:25-27` + `packages/renderer/src/stores/subagent.ts:108-110`）。
- 计时器停止只看 `isStreaming`（`packages/ui/src/features/chat/composables/useTurnElapsed.ts:137-148`）；label 与展开态看 `isWorkingTurn`。

### 1.2 确凿缺陷一：网络断连无 streaming 复位兜底

`finalizeAllStreaming`（复位 streaming 状态的唯一断连级出口，`packages/core/src/domain/chat/store.ts:502-509`）只被 `handleRuntimeUnavailable` 调用（`packages/renderer/src/composables/effects/useMessageEffects.ts:79-82`），而后者只挂在 **IPC runtime-restarting / runtime-failed**（`packages/core/src/transport/use-connection.ts:252-267`）。

**纯网络断连（ws onclose → 指数退避重连）不经过任何复位路径**——`ws-client.ts:199-205` onclose 只 `scheduleReconnect`；use-connection 的 stateWatch 断连侧只做 `pending.rejectAll`（`use-connection.ts:219-229`）。

复位唯一依赖：重连成功后 `resubscribeAll()`（`use-connection.ts:226-228`）→ `subscribeSession(sid, fromSeq)` → runtime MessageBus ring（容量 1000，`packages/runtime/src/services/message-bus/message-bus.ts:33,62-66`）回放断连窗口内的 `message.complete`（stream 类入 ring）。gate v4 证实该回放链内容级成功（「断连窗口内完成的 followUp 回复在重连后完整出现」），故 gate 报告归因「丢失的 message_end/turn_end 广播未在重连后补齐」**不准确**——补齐机制存在且工作。

但该依赖链任何一环失败（subscribe RPC 被 pre-auth drop（#3 同族）、lastSeenSeq 基线漂移、ring 溢出、pi error turn 事件序异常）时，streaming 态最长挂到 **streaming timer 10min**（`store.ts:65` DEFAULT_STREAMING_TIMEOUT_MS）或 pendingSend timer 30s（`store.ts:163`）。v4 断连 30s + 观察窗口 5s 内若回放延迟/部分失败即呈现残留。无独立兜底是结构性缺口。

### 1.3 确凿缺陷二：turn 级工作指示误用 session 级信号（与 #8 同根因）

`isWorkingTurn` 用 `sessionActive` 驱动——session 内任何 background work（subagent record running）都会让**末位 turn** 显示「工作中」。断连场景叠加：断连期间 subagent/队列状态不清理（`clearIndependentTransient` 同样只在崩溃路径调用），`retryStates/queueStates` 残留使 derivedStatus 停在 retrying/streaming 态 → sessionActive 卡 true。

### 1.4 修复方向与改动面

1. **断连即复位**（长期方案）：stateWatch 断连侧（`use-connection.ts:219-225`）对候选 session 调 `finalizeAllStreaming('disconnect')`——需与「重连后 ring 回放重建终态」的时序对齐（disconnect 收口为 error 态，回放 complete 幂等覆盖为 complete）。改动面：`packages/core/src/transport/use-connection.ts`（+port 注入）+ `packages/renderer/src/composables/useConnection.ts` + 测试。
2. **turn 工作指示改用 turn 级信号**：`isWorkingTurn` 的 spinner/label 语义拆分（见 #8）。改动面：`packages/ui/src/features/chat/Turn.vue`、`TurnMeta.vue`。

---

## 2. [中] 模型 error turn 的 UI 流状态卡死并抑制后续渲染 — 部分成立

### 2.1 error 收口分支代码正确（一手证据）

18dc 的 pi tee（`~/.xyz-agent-dev/logs/pi-2026-08-19-019ffd0c-18dc-*.jsonl` line 44-47）证实 pi error turn 事件序完整：`message_start{stopReason:error, content:[]}` → `message_end` → `turn_end` → `agent_end`。

runtime 翻译链完备：`handleAgentEnd`（`packages/runtime/src/infra/pi/event-adapter.ts:234-296`）取 `lastMsg.stopReason`（=error）→ 广播 `message.complete{stopReason:'error'}`；renderer `message.complete` handler（`packages/core/src/domain/chat/effects/registry.ts:170-210`）把 streaming assistant 收口为 `status:'error'` 并 `finalizeSession(sid,'error')`。**stopReason=error 的状态机分支不存在卡死路径**。

### 2.2 「抑制后续渲染」无独立确定机制

v1/v2 现场是 restore-tmp 附着 session（18dc）+ 断连 + mimo-v2-pro error 三因素复合，gate 自己已判「作废重跑」。「store 17 条但 UI 只显示占位」与下述确定事实相容而不需要新机制：
- 「占位」形态 = TurnMeta `isPendingPlaceholder`（`packages/ui/src/features/chat/TurnMeta.vue:89-91`，sessionActive 且末位 turn 空 assistants 时渲染「思考中」）——sessionActive 卡 true（#1.3）时占位持续；
- pi busy 而 UI 已收口（isActive=false）时用户 Enter 直发 `message.send` 被 pi 拒（gate 问题 7 的直发现象，见本报告 #6）→ 后续消息反复报错不进流。

**判定**：error turn 单独不产生卡死；卡死表象归 #1 的两个确凿缺陷 + restore-tmp 附着（用户领域）。修复随 #1；不需要针对 stopReason=error 的新分支。

---

## 3. [中] 重连初始化批次 pre-auth 被 runtime 丢弃 — 成立

### 3.1 根因链

**runtime 侧（设计意图）**：`packages/runtime/src/transport/connection-manager.ts:168-172` `handleUnauthedMessage` 对非 auth 消息**静默丢弃**（spec §3.3 D4 明示）。

**renderer 侧（缺陷）**：`packages/core/src/transport/ws-client.ts:237-243`

```ts
export function send(msg: ClientMessage): boolean {
  if (ws?.readyState === WS_READY_STATE.OPEN) {
    ws.send(JSON.stringify(msg))
    return true
  }
  return false
}
```

**只检查 readyState，不检查本代 auth 是否完成**。WS 握手完成即 readyState=OPEN，而 ws-client 的 connected 态要等 `auth.result ok`（`ws-client.ts:150-163,176-191`）。auth 窗口实测：冷启动 connected→authenticated 间隔 92ms（runtime log 10:32:37.373→.465）；重连风暴期事件循环繁忙时窗口更长。窗口内任何 `transport.send` 真实送出 → runtime drop → `pending` promise 只能等 65s sweep 超时（`request.ts` 的 fast-reject 只覆盖 sent=false，不覆盖「sent=true 但被对端丢弃」）。

### 3.2 一手证据（runtime-2026-08-19.log）

- `client connected` 66 次 vs `client authenticated` **10 次** vs `dropping pre-auth message` **443 条**（`auth failed`/`auth timeout` 均为 0）。
- drop 批次（plugin.mountPoints.sync / project.load / model.list / presence.list / config.getGlobalSkills / config.sessions / preset.list / preset.getDefault）在每次 `client connected` 后**毫秒级**到达，说明消息确实经该未 auth 连接发出（CDP offline 模拟对 loopback 握手放行、随后杀连接，产生大量「TCP+upgrade 成功但 renderer 侧 error」的僵尸 OPEN 窗口）。
- 后果与 gate 观察一致：`config.sessions` 被丢 → 侧栏列表空；页面 reload（冷启动走 auth 后 initApp）恢复。

未完成项（如实声明）：在 pre-auth 窗口内发出该批次的**具体触发组件**未定位到（AppShell v-if=connected 挂载、mountPointsSync/onConnected 的 watch 均只在 auth 后触发；批次呈周期性随重连 attempt 出现，疑似某常驻调用链在断连 rejectAll 后的重试路径）。修复不依赖此定位。

### 3.3 修复方向与改动面

长期方案：ws-client `send()` 增加本代 `authed` 检查（未 auth 时返回 false 走 request.ts 既有 fast-reject），或 transport 层对非 connected 态的 RPC 排队至 auth 完成 flush。改动面：`packages/core/src/transport/ws-client.ts`（authed 状态需暴露为发送门槛，约 10 行）+ `packages/core/src/transport/__tests__/ws-client.invariants.test.ts`；可选 runtime 侧把 pre-auth drop 改为带 id 的 error reply（`sendError`）让 pending 快速失败。

---

## 4. [低] cwd 死路径非活跃改名静默失败 — 成立（根因链修正）

### 4.1 根因链（三方代码事实）

1. **pi 0.84.1 硬断言**（binary strings 提取，`AgentSessionRuntime.switchSession`）：
   ```js
   const sessionManager = SessionManager.open(sessionPath, undefined, options?.cwdOverride);
   assertSessionCwdExists(sessionManager, this.cwd);
   ```
   session header 的 cwd 不存在 → switchSession 抛错（success:false）。RPC `case "switch_session"` 不透传 cwdOverride，runtime 无法经 RPC 绕过断言。
2. **xyz 侧无降级**：`packages/runtime/src/infra/pi/process-manager.ts:272-290` `withEphemeralPi` 的 spawnCwd 取 sessions 目录（dirname(sessionFile)），**对目标 session 自身 header 的死路径 cwd 无任何处理**——注释自认「目标 session 自身的 cwd 死路径场景由调用方处理（restore tmp 管线），与本入口无关」。
3. **调用方未处理**：`packages/runtime/src/services/session/session-lifecycle.ts:357-369` renameSession 非活跃分支直接 `withEphemeralPi(target.filePath, ...)` 传**原文件**——没有 restore 管线的 `applyHeaderCwdFallback` tmp 首行变换（该变换只存在于 restoreSession，session-lifecycle.ts:510 附近）。另外 `if (target)` 无 else：`findScannedSession` 未命中时**静默 return**（无 throw/无日志）。

错误传播本身存在（pi 报错 → RPC reject → withEphemeralPi rethrow → 上层），gate「现场 2s 后未捕获到 toast」自认未定论；「静默」的确定成分是 `if (target)` 缺 else 分支与改名不生效无反馈。

### 4.2 修复方向与改动面

renameSession 非活跃分支对死路径 cwd 复用 restore 的 header fallback（构造 tmp + applyHeaderCwdFallback 后再 withEphemeralPi），或抽出共享 helper；`if (target)` 补 else throw。改动面：`packages/runtime/src/services/session/session-lifecycle.ts`（renameSession + 复用 session-file-utils 的 header 变换）+ runtime 测试。注意与用户在修的 tmp 管线的边界：只新增 rename 自己的降级路径，不动 restore 管线本体。

---

## 5. [低] runtime 半开连接计数堆积 — 成立（影响有限）

代码事实（`packages/runtime/src/transport/connection-manager.ts`）：

- gate 场景：CDP close() 后 offline 阻断 close 帧送达 runtime → 旧 authed 连接留在 `clients` 池（半开）。恢复后新连接 auth 入池 → `client connected (total: 2)`（:120 计数含未 auth 新连接 + 半开旧连接，语义误导）。
- **自愈已存在**：heartbeat 超时 45s（:30 `HEARTBEAT_TIMEOUT_MS`，:220-227 收不到消息即 close）——半开连接不再发 ping，45s 内被清理；期间 broadcast 对它的 send 有 readyState 检查 + ES4 try/catch（message-bus.ts:362-373）。
- 443 条 pre-auth drop 所在的「connected 未 authed」连接（#3）由 10s authTimer（:127-130）兜底关闭。

判定：成立但为观察级——功能无实害（gate 亦确认 pong 正常），值得做的是日志语义修正（connected 日志区分 authed/unauthed，total 只计 authed）。改动面：`connection-manager.ts:120` 单行 + 测试。

---

## 6. [低] 活跃态 Enter 实际直发与 Composer 注释不符 — 不成立

代码事实（`packages/renderer/src/components/panel/Composer.vue:340-368`）：

```ts
if (e.altKey) { ... } else if (isActive.value) { onSteer() } else { onSend() }
```

注释（:8）「活跃态 ⏎ 追加 steer」与代码**一致**。`isActive` = `chatStore.isActive(sessionId)`（:188-190）= `isGenerating ∨ pendingSend`。

gate v1 观察「turn 进行中 Enter 走 message.send 直发并触发 pi error」的机制：**UI isActive=false（error turn 已被 message.complete 收口）而 pi 侧 turn 仍 busy**——UI↔pi 活跃态脱节（#1/#2 族的衍生表现），Enter 按「非活跃」路由直发，pi 报 busy 错。这是活跃态同步问题，不是 Composer 路由 bug；**不建议改 Composer**。修复随 #1（活跃态对齐）。若要防御可加：send 前置 get_state 校验（成本高，不推荐）。

---

## 7. [中] `!` bash live 实时输出丢失 — 成立（归因修正：不是 shape guard 的差异）

### 7.1 一手证据链

- **pi tee**（`pi-2026-08-19-1ec94fcc-*.jsonl` line 143-144，11:28:17 时段活跃 pi 进程）：
  ```
  line 143: {"type":"bash_execution_update","id":"rpc_15_1787138897511","delta":"/Users/zhushanwen/Stock\n"}
  line 144: {"id":"rpc_15_1787138897511","type":"response","command":"bash","success":true,"data":{"output":"/Users/zhushanwen/Stock\n","exitCode":0,"cancelled":false,"truncated":false}}
  ```
- **runtime log**（119287-119288 行）：`send: type=bash`（11:28:17.511）→ 9ms 后 `bash: malformed PiBashResult ... data=`（空）。id `rpc_15_1787138897511` 的时间戳与 send 时刻吻合，同一 RPC。
- **pi 0.84.1 binary strings**：`executeBash` 的 onChunk 回调 `this._emit({ type: "bash_execution_update", id: options?.id, delta })`；rpc-mode `case "bash"` 把 RPC id 作为 `id: id2` 传入 `session.executeBash(...)`。**pi 0.80.3（本地 clone）无此行为**——`bash_execution_update` 是 0.80.3→0.84.1 之间引入的流式 bash 输出事件，**复用发起 RPC 的 id**。

### 7.2 根因

`packages/runtime/src/infra/pi/rpc-client.ts:328-334` `handleMessage` **仅凭 `msg.id ∈ pending` 就 resolve**，不校验 `msg.type === 'response'`：

```ts
if (msg.id && this.pending.has(msg.id)) {
  const entry = this.pending.get(msg.id)!
  clearTimeout(entry.timer); this.pending.delete(id); entry.resolve(msg)
}
```

时序：runtime 发 bash（pending 挂 id）→ pi 流式输出首条 delta（带同 id）→ **`bash_execution_update` 被误认为 bash 的 response** resolve（其 `success` undefined ≠ false 通过校验；`data` undefined 经 `data??payload` 归一仍 undefined）→ `rpc-client.ts:564-568` shape guard 判 `'output' in data` 失败 → fallback `[protocol error: malformed bash response from pi]` → 真正的 response（line 144）到达时 pending 已删，落入 event listeners 无效广播 → **真实 output 丢弃**。

guard（`e5c9e33e2` 引入）本身无罪——它期望的 shape（`data.output`）与 pi 实际 response 完全一致；gate 报告「找出 guard 期望的 shape 与实际 shape 的差异」的归因方向不成立。与「重开后 entry 路径正确」吻合：pi 侧 `recordBashResult` 落 JSONL 的 bashExecution entry 不经 RPC response。

影响面收敛验证：pi 0.84.1 binary 中带 RPC id 的流事件仅 `bash_execution_update` 一个（`_emit({type:..., id:...})` 唯一命中），当前受害者只有 bash RPC；但任何有输出的 `!` 命令必中（首条 delta 先于 response）。

### 7.3 修复方向与改动面

`handleMessage` 的 resolve 判定加 `msg.type === 'response'`（或 `command` 匹配）守卫，`bash_execution_update` 归入 event listener 路径。改动面：`packages/runtime/src/infra/pi/rpc-client.ts`（handleMessage 3-5 行）+ `packages/runtime/src/infra/pi/__tests__/rpc-client.test.ts`（补 bash_execution_update 用例）。可选增强：event-adapter 适配 `bash_execution_update` 实现 live bash 流式显示（见相邻发现 #1/#2）。

---

## 8. [中] turn-meta 工时 live 期不复位（无断连也复现）— 成立

### 8.1 根因链（设计冲突）

1. 显示层：末位 turn 的「工作中」label / 禁用态 / trace 展开由 `isWorkingTurn = sessionActive && isLastTurn` 驱动（`packages/ui/src/features/chat/Turn.vue:162`），`sessionActive` 含 **working 态**（`useSessionActive.ts:21-28` SESSION_ACTIVE_STATUSES）。
2. working 态来源：`hasBackgroundWork` → `subagentStore.hasRunning(sid)` = records 中存在 `status === 'running'`（`subagent.ts:108-110`）。
3. **running-resumable 设计**（`extensions/subagent-workflow/src/execution/finalize-record.ts:229-233`，v4 B-1）：subagent 完成注入后**轮终故意回写 `record.status = "running"`**（可冷路径 resume；closed 只在显式关闭/parent-shutdown）——p3 gate §2.3 自己记录了这个「设计内差异」。
4. 冲突：UI 的 working 语义是「后台任务仍在跑」，running-resumable 的 running 语义是「保持可恢复」——**live 期 hasRunning 恒 true → derivedStatus 恒 working → isSessionActive 恒 true → 完成注入后末位 turn 永久「工作中 Ns」**（计时器已停因 turn.isStreaming=false，但 label/disabled/trace 展开卡工作态）。重开后 record 为 closed（parent-shutdown）→ working 消失 → 显示「已工作12s」，与 gate 观察完全吻合。

gate p3 把 §2.3「设计内差异」与 §4.1 问题分别记录而未关联——两者是同一枚硬币：**这是两个设计的语义冲突（全局规则 4：冲突要表面化）**，不是单纯的实现 bug。

### 8.2 修复方向与改动面

三选一（需产品裁决，标记待讨论）：
- a) finalize-record 引入第三态（如 `resumable-idle`）不参与 hasRunning——改动面 `extensions/subagent-workflow/src/execution/finalize-record.ts` + 共享类型 + 前端 hasRunning 判定；
- b) `hasRunning` 排除「完成注入后的轮终 running」（按 record.round/idleSince 判定）——改动面 `packages/renderer/src/stores/subagent.ts`；
- c) turn 工作指示改用 turn 级 `isStreaming`（label 与 spinner 同源）——改动面 `packages/ui/src/features/chat/Turn.vue`/`TurnMeta.vue`，同时缓解 #1 的显示残留。
建议 c + b 组合（不动 extension 状态机语义）。

---

## 9. [中] 重开后 session 名回退文件名 — 不成立（UI 元素误读）

判定依据：

1. **「顶部 01a019c7.jsonl」是设计内恒显元素**：`packages/renderer/src/components/panel/PanelHeader.vue:107-121`，`data-testid="panel-session-file"` 的复制路径 chip（「session JSONL 文件名（id 前 8 位 + .jsonl）：点击复制磁盘真实绝对路径」），与 label 状态无关，重开前后**恒在**。PanelHeader 明确「不显会话名」（:71-73 注释，breadcrumb 只显目录+分支）。
2. **session 实名正确落盘**：01a019c7 原 JSONL（`2026-08-19T11-27-50-291Z_01a019c7-*.jsonl`）**line 4** 有 `{"type":"session_info",...,"name":"请先简单介绍一下你自…"}`（create 阶段 pi 直接写原文件；tee line 10 `session_info_changed` 佐证）。扫描 label 链（`session-scanner.ts:73` `s.name ?? basename(s.cwd)`）有 name 可读，兜底也是 cwd 目录名（"Stock"）而非文件名。renderer 侧栏无任何 `.jsonl` 文件名 fallback（grep 零命中）。
3. p3 是冷启动重开（auth 后 initApp 拉 config.sessions），不经 pre-auth 窗口；P1P2 报告问题 4 的「名回退 019ffd0c.jsonl」同为此 chip 在侧栏列表空（pre-auth drop）场景下的误读。

若 gate 后续拿到「侧栏 SessionItem label 显示文件名」的截图证据则需重判；就现有两份报告的描述（均「顶部」）判定不成立。**真问题只有 #3 的侧栏列表空**。

---

## 10. W24 taste-lint 三 minor — 三条全部成立

文件：`taste-lint/rules/no-non-owner-store-mutation.mjs`。

- **a) stalePermittedEntry 在提前 return 之后 — 成立**：`Program:exit`（:280-282）先 `if (factoryBindings.size === 0) return`，stale 检查在 :286-304。不 import store 工厂的文件（绝大多数被检文件）不跑登记表失真检查——保护面随 import 边缩水。修复：stale 块上移到 factoryBindings 判定前（`loadRegistryEntries` 有模块级缓存、`parse-registry.mjs:35-42`，全程只读一次，无性能顾虑）。改动面：单文件块移动 ~20 行 + 测试。
- **b) detachedMethodRef 文案不含登记表路径 — 成立**：:106-109 文案只说「登记表补例外」，其余 4 条 message（:94-105,110-113）均给全路径 `docs/architecture/data-source-registry.md` 与 PERMITTED_FILES 双向核对指引。违反错误信息可操作性一致性。修复：补路径字符串，1 行。
- **c) paramOwnerFn 同名形参多函数 last-write-wins — 成立**：:313-320 以**形参名**（如 `store`）为 Map key，同文件多个函数有同名形参时后写覆盖；candidates 裁决（:334-340）`stack.includes(paramOwnerFn.get(obj.name))` 随之漏报（或嵌套调用下偶发误报）。docstring :26 已声明「同名函数作用域混淆等间接形态不追踪」的宽松精度，但该声明覆盖 fnDecls 同名，paramOwnerFn 的 key 冲突是裁决数据结构缺陷而非检测精度取舍。修复：key 改 `${fnName}:${paramName}`（或 Map<fnName, Map<param,...>>），裁决按栈内函数逐层匹配，~10 行。

修复面合计：单文件（规则本体）+ `taste-lint/rules/__tests__`（若有）补三条用例。

---

## 相邻新发现问题（同链路顺带发现，未在 gate 报告中）

1. **[中] pi 0.84.1 `bash_execution_update` 事件 runtime 全仓零处理**：`grep bash_execution` 在 `packages/` 零命中（仅 binary/tee 中存在）；event-adapter `translate()` 对联合外类型走 default「warn + return []」（event-adapter.ts:59,133）。pi 新版新增的 live bash 流式输出能力被整体丢弃——与 #7 是同一枚硬币的两面（#7 修 resolve 守卫后，该事件会正确流入 event listener，但无翻译消费）。修复位：`packages/runtime/src/infra/pi/pi-protocol.ts`（PiEvent 联合补型）+ `event-adapter.ts`（translate 分支 → `message.bashDelta` 之类广播）+ 前端 bash 气泡流式渲染（可选增强）。
2. **[中] `handleMessage` 的 resolve 守卫缺失是通用缺陷而非 bash 特例**：任何「带 RPC id 的非 response 消息先于 response 到达」都会误 resolve（#7 根因本体）。pi 后续版本若给其他长 RPC（get_entries/compact）加流式进度事件，会以同样方式破坏对应 RPC。修复即 #7.3 的 type 守卫，一次修复全类免疫。
3. **[低] pre-auth 窗口发出的 RPC 无 fast-fail**：`request.ts:50-60` 只对 `sent=false`（ws 非 OPEN）立即 reject；pre-auth 窗口 `sent=true` 但被 runtime 丢弃的请求挂满 65s sweep 超时（pending.ts 共享 sweep），期间调用方 in-flight 标记拦截用户操作。随 #3 修复（send 返回 false）自然消除。
4. **[低] 断连侧 `queueStates/retryStates/compacting` 瞬态无清理**：`clearIndependentTransient`（streaming-state-machine.ts:115-128）注释自述「断连兜底：这些态在断连后无事件驱动清理」，但它只经 `resetTransientStates` 被 `finalizeAllStreaming` 调——即同样只在 IPC 崩溃路径生效，网络断连后 queue/retry 指示残留至事件或 30s/超时兜底（#1 缺陷一的组成部分，单列以免修复时遗漏）。
5. **[观察] useTurnElapsed 的 onComplete（trace 收起）依赖 sessionActive true→false 跳变**（useTurnElapsed.ts:150-162）：working 态卡 true（#8）时完成 turn 的 trace 展开也不自动收起——#8 修复的连带受益点，无需单独改。

## 未完成项

- #3 中「pre-auth 窗口内发出初始化批次的 renderer 具体触发组件」未定位（证据与候选分析见 §3.2；不影响修复方向成立性）。
- #1 中 v4/v5「已工作残留」在 ring 回放成功前提下的精确复现路径未闭合（两个确凿缺陷已足以解释现象族；行为复现需起 dev app，超出本次诊断手段边界）。
