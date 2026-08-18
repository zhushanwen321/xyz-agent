# subagent/workflow 侧边栏状态同步架构重构设计

> **一句话结论**：把侧边栏 subagent/workflow 状态收敛为「磁盘单一真相源 + 无状态信号转发 + 事件驱动对账」——runtime 删除平行内存真相源，subagent 链路对齐 workflow 已有的「信号 → RPC 重拉」模式；extractor 四级投影（bg-notify entry / sidecar / pid 存活 / 子进程 JSONL 收尾）修正 running 语义错位，孤儿与崩溃不再显示 running；秒级轻量信号让 UI 收敛与 60s LLM 通知窗口解耦；workflow kill-9 恢复补落盘。

<!-- 层声明：本次设计当前层 = 跨层架构方案（协议 + 机制），下一层 = 可实现的接口/数据模型/单元拆分。不跨 2 层：不写具体函数实现。 -->

## 开篇（SCQA）

- **S（情境）**：xyz-agent 桌面工作台中，主 session 可通过 `subagent` / `workflow` 工具启动后台任务，左侧边栏 Agents / Flows tab 实时展示其列表与状态（running / done / failed…）。
- **C（冲突）**：状态经常不更新——subagent 明明结束了侧栏仍显示 running；打开有历史的 session 再启动新 subagent 时历史条目会消失；workflow 进程被强杀后侧栏永久卡 running。
- **Q（问题）**：如何让侧边栏状态与 subagent/workflow 的真实状态**最终一致**，而不是依赖 best-effort 通知碰运气？
- **A（答案）**：磁盘（主 session JSONL + workflow state 文件）作为唯一真相源；runtime 从「持有并广播全集状态」降级为「无状态转发增量信号」；renderer 收到信号后 RPC 重拉磁盘；三个事件驱动对账点兜住所有信号丢失/推迟场景。

---

## 1. 背景：被设计的系统是什么

**本章结论：本设计覆盖「subagent/workflow 状态从产生到侧边栏渲染」的三层链路，不涉及任务执行本身。**

xyz-agent 是 Electron + Vue 3 的 AI Agent 桌面工作台。用户在一个 session（由 pi 进程驱动）里让主 agent 干活，主 agent 可以调用两类工具把工作分出去：

- **subagent**：由 `@zhushanwen/pi-subagent-workflow` 扩展注册的后台子 agent（独立 CLI 子进程），适合并行派发调研/编码子任务；
- **workflow**：同一扩展提供的多步骤编排（脚本 + agent call），一个 run 内含多个 agent call。

侧边栏的 Agents / Flows tab 展示当前 session 的 subagent / workflow 列表与状态，用户据此判断后台任务进展（是否还在跑、有没有失败、能不能看结果）。

状态链路横跨三层：

1. **Extension 层**（`extensions/subagent-workflow/`，跑在 pi 进程内）：启动子进程、跟踪生命周期，在关键时刻经 `pi.sendMessage` 注入结构化通知（custom_message）；
2. **Runtime 层**（`packages/runtime/`，Node 子进程）：适配 pi 事件流，翻译成 WS 帧推给渲染进程；
3. **Renderer 层**（`packages/renderer/`，Vue）：Pinia store 持有列表分区，侧边栏响应式渲染。

本文所有行号基于分支 `fix-subagent-workflow-sidebar-sync`（commit e2ba11be0）。

## 2. 设计目标

**本章结论：改造后使用者看到的状态永远在有界时间内收敛到真实状态，且两条链路一种心智模型。**

1. **终态收敛**：subagent/workflow 结束后，侧边栏在秒级显示终态（终态转换时轻量信号 + sidecar 投影，见决策 4）；信号丢失时由对账点保证有界收敛（≤60s 通知窗口 + 一个 turn）；pi 崩溃（kill -9）场景在 session 重开时收敛（重开前无人消费状态，不构成卡死）（回溯症状：终止不更新、kill -9 永久 running）。
2. **列表不回退**：任意时刻侧边栏列表是磁盘真相的全集——打开有历史的 session 后再启动新任务，历史条目不消失（回溯症状：列表回退/消失）。
3. **恢复一致**：runtime 重启、renderer 重连、pi 进程崩溃后，侧边栏状态与磁盘一致（回溯症状：kill-9 后永久 running）。
4. **架构一致性**：subagent 与 workflow 两条状态链路同构（「信号 → RPC 重拉磁盘」一种模式），消除平行真相源。

**In-scope**：runtime 状态广播协议重构（subagent 全集广播 → 增量信号）；renderer 重拉触发与对账机制；extension 两处落盘缺口修复（workflow kill-9 恢复落盘 + 恢复后补信号）。
**Out-of-scope**：通知合并的 60s 滑动窗口本身（扩展的性能/token 取舍，见决策 4）；subagent 级联关闭后「running 可续聊」的产品语义（见决策 5）；侧边栏 UI；MessageBus 传输机制本身。

---

## 3. 现状：使用者眼里是什么样的

**本章结论：现状是「两个平行真相源 + best-effort 信号」，五类已核实的失败模式都源于此。**

### 3.1 现状的真实样子

使用者视角的日常：在 session 里让主 agent「并行派两个 subagent 调研」，侧栏 Agents tab 出现两条 running；等它们结束，期望变成 done/failed。实际经常看到：第一条结束后一直 running；或重开这个 session 再派一个新 subagent 时，侧栏只剩新的一条，历史全没了。

背后的两条平行数据路径：

**路径一（实时推送，runtime 内存为源）**：

```
pi 事件流                          runtime EventInterpreter                renderer
tool_execution_start(args) ──→ 缓存 startParam（内存 Map）
tool_execution_end(result.details) ──→ 内存建 running 记录 ──→ broadcastSubagents()
custom_message(subagent-bg-notify) ──→ 更新内存记录（要求已存在！）
                                        │
                                        ▼
                              MessageBus.publish(sid, {type:'session.subagents',
                                subagents: 内存全集})   ← state 类：写快照 + 推订阅者
                                        │
                                        ▼
                              routeInbound → applyRecords(sid, 全集)   ← 全量替换
```

关键代码（全集广播与全量替换）：

```ts
// packages/runtime/src/services/session/event-interpreter.ts:628-636
private broadcastSubagents(): void {
  this.opts.send({
    type: 'session.subagents' as ServerMessageType,
    payload: {
      sessionId: this.sessionId,
      subagents: Array.from(this.subagentRecords.values()),  // 内存全集
    },
  })
}
```

```ts
// packages/renderer/src/stores/subagent.ts:117-119
function applyRecords(sessionId: string, list: SubagentRecord[]): void {
  recordsBySession.value = new Map(recordsBySession.value).set(sessionId, list)  // 全量替换
}
```

```ts
// packages/runtime/src/services/session/event-interpreter.ts:603
if (!existing) continue   // bg-notify 只更新内存已有记录，否则静默丢弃
```

`subagentRecords` 初始化为空且**不从磁盘回放**（`session-service.ts:1117` 调 `adapterFactory`，EventInterpreter 在组合根 `packages/runtime/src/index.ts:224` 构造，构造点无任何 JSONL 回放）。

**路径二（RPC 拉取，磁盘为源）**：切 session / 切 tab 时 `getSubagents` / `getWorkflows` RPC → `subagent-extractor.ts` / `workflow-extractor.ts` 现读磁盘（主 session JSONL 合并 toolCall/toolResult/bg-notify entry；workflow 另经 `workflow-state-link` 指针读 state 文件快照）。无缓存（`session-service.ts:685-690`）。

**路径三（workflow 实时信号，已是「信号 + 重拉」）**：workflow tool-call-end(action=run) 与 workflow-result custom_message → 广播 `session.workflowUpdate` 增量信号 → renderer `triggerWorkflowReload` → RPC 重拉（`workflow.ts:176-191`，running 信号带 500ms 重试）。**workflow 链路没有 runtime 内存态**——这正是 subagent 链路缺失的形态。

### 3.2 怎么出错（五类已核实失败模式）

| # | 失败模式 | 触发条件 | 后果 |
|---|---------|---------|------|
| F1 | 内存全集覆盖磁盘全集 | 打开有历史的 session（RPC 首拉已显示历史）→ 启动新 subagent → 广播只含内存记录 | 历史 subagent 从侧栏消失 |
| F2 | bg-notify 内存 miss 被丢弃 | session 重开后内存为空、或该 subagent 启动记录未建成；bg-notify 到达时 `if (!existing) continue` | 终态永不广播，侧栏永久 running |
| F3 | 通知根本不发 | subagent 级联关闭（/new、/fork、session_shutdown 的 `disposeAllRecords`）只清内存不发通知；workflow `terminateRunningRuns`（lifecycle.ts:304-306）落盘但不通知 | 停留在旧状态直到用户切走再切回 |
| F4 | 磁盘状态本身错误 | workflow kill-9/crash 恢复（index.ts:466-475）只改内存无 `store.save` → state 文件永远写 running | RPC 拉到的也是 running，永久卡死 |
| F5 | 通知推迟 ≥60s | 并发 ≥2 个 background subagent 时，notifier.ts:126-156 滑动窗口每来一条完成通知就重置 60s 计时器 | 用户感知「明明完成了还 running」 |

### 3.3 根因

**两条平行真相源（runtime 内存 vs 磁盘）互相覆盖，且没有对账机制兜底 best-effort 信号。** 推送信号（bg-notify / workflow-result）在设计上就是会推迟、会丢的（合并窗口、级联关闭、崩溃），但现状把「信号到达」当成状态更新的**唯一**来源——信号丢 = 状态永久停在旧值。F1-F5 全部是这两个根因的不同投影。

## 4. 根因 + 物理数据流

**本章结论：磁盘已是完备的真相源（关键事实 A1/A2），缺的是「让所有消费都走磁盘 + 丢信号后能收敛」的机制。**

> **真相源（SSOT）** = 状态的唯一权威存储，其他副本都从它派生。本设计中 = 主 session JSONL（subagent 的 toolCall/toolResult/bg-notify entry）+ workflow state 文件。
> **增量信号** = 不携带状态数据、只表示「磁盘变了，去拉」的轻量通知。上面 §3.1 路径三的 `session.workflowUpdate` 就是。
> **对账（reconcile）** = 不依赖信号、在确定性时机主动重拉磁盘，使副本收敛到真相源的动作。

### 4.1 支撑方案的关键事实（附探针）

| # | 断言 | 探针 | 状态 |
|---|------|------|------|
| A1 | pi 的 session entry 写入是**同步落盘**（`appendFileSync`） | `pi-coding-agent dist/core/session-manager.js:739-752`（`_appendEntry` → `_persist` → `appendFileSync`） | ✅ 已核 |
| A2 | bg-notify 事件到达 runtime 时，对应 entry **可能尚未落盘**（窄竞态窗口）——bg-notify 恒带 `triggerTurn:true`，走 `_runAgentPrompt`/steer 分支；实际持久化在 `_handleAgentEvent`（`message_end{role:'custom'}` 处理中），**emit 先于 appendFileSync**（同一同步调用栈，但 runtime 信号源自 `message_start`，早于落盘点） | `dist/core/agent-session.js:1068-1097`（分支结构）、`:369-374`（emit→persist 顺序）；`packages/runtime/src/infra/pi/event-adapter.ts:520-534`（信号源自 message_start） | ✅ 已核（v2 修正：v1 曾误引非 triggerTurn 的 else 分支） |
| A3 | bg-notify 发送带 `triggerTurn:true, deliverAs:'steer'`——通知到达必然驱动主 agent 一个 turn（空闲则立即开 turn；streaming 则 steer 注入后 turn 结束），turn 结束即 `message.complete`，且此时 entry 必已落盘（A1 同步写 + turn 边界） | `extensions/subagent-workflow/src/execution/notifier.ts:223-234` | ✅ 已核 |
| A4 | `getSubagents`/`getWorkflows` RPC 无缓存、每次现读磁盘 | `session-service.ts:685-690` | ✅ 已核 |
| A5 | `tool_execution_end` 事件到达 runtime 时，对应 toolResult entry 已在 JSONL | 实施期门：pi CLI 跑 subagent start，事件到达时立即读 JSONL 验证 | ⛏ 实施期验证 |
| A6 | 大 session JSONL 全读耗时可接受（对账频率下） | 实施期门：拿 ≥10MB 真实 session 实测 extractor 耗时 | ⛏ 实施期验证 |
| A7 | 全局安装的 pi dist（0.84.0）与 runtime 捆绑版本（0.84.1）行为一致 | 实施期门：对捆绑版本重跑 A1/A2 探针 | ⛏ 实施期验证 |
| A8 | 不带 `triggerTurn` 的 `pi.sendMessage` 只落盘 + 发 `message_start`/`message_end` 事件，不触发 LLM turn | 实施期门：pi CLI 实测注入后无自发 turn（决策 6.2 依赖） | ⛏ 实施期验证 |
| A9 | subagent 终态转换时 `.finalized`/`.cancelled` sidecar **同步写盘，早于 bg-notify 入 60s 窗口**——窗口期内磁盘已有终态，只是主 JSONL 无 entry | `subagent-service.ts:1533-1543`（`runAndFinalize`（内含 finalizeRecord→writeFinalized）→ `.then` → `notifyComplete`）；`finalized-marker.ts`（空文件，存在性即信号） | ✅ 已核 |
| A10 | 「秒级轻量信号」可用：候选 a = 扩展在终态转换时发无 turn 轻量事件；候选 b = runtime 挂 subagent stream 终止帧（`subagent.stream_delta` lines:undefined）转发信号（零扩展改动；依赖 session_start 注入 streamSink） | 实施期门：M0 用 pi CLI 实测两个候选的事件到达时序与副作用（a 需验证不进 LLM 上下文的通道；b 需验证 streamSink 在 RPC 模式恒注入） | ⛏ 实施期验证（决策 4 依赖） |

A1+A2+A3 合起来是本设计的地基：**「信号 → RPC 重拉」的立即拉取可能读到写前快照（A2 竞态窗口 = 同步调用栈内的 emit→append 间隔，叠加跨进程 RPC 往返后实际极窄，但机制上无保证）；确定性收敛由 A3 保证——终态通知必然驱动一个 turn，turn 结束（`message.complete` 对账点）时磁盘必已含终态 entry（A1 同步写在 turn 边界之前完成）**。即：立即拉是「通常新鲜」，对账拉是「保证新鲜」。这消除了传统「拉模式」的最大风险，代价是终态收敛上界从「一个 RPC 往返」变为「通知 + 一个 turn 完成」。

### 4.2 现状物理数据流（磁盘 → 用户眼前）

```
[subagent 终态] extension notifier（内存合并窗口 ≤60s）
    │ pi.sendMessage(custom_message, {triggerTurn:true, deliverAs:'steer'})
    │   → _handleAgentEvent: 先 emit 事件、后 appendFileSync 写主 session JSONL（A1/A2）
    │                                                 ← 真相源在这里更新（信号早于落盘一个窄窗口）
    ├──────────────────────────────────────────────┐
    ▼ 事件流分支                                     ▼ （RPC 拉取分支，仅在切 session/切 tab 时走）
pi stdout JSONL → runtime EventInterpreter          renderer → WS RPC getSubagents
    │ 内存 Map 查 existing（miss 即丢，F2）              → subagent-extractor 读同一 JSONL
    │ 广播内存全集（覆盖磁盘拉取结果，F1）                 → applyRecords 全量替换
    ▼                                                 ▼
MessageBus.publish → ws → renderer applyRecords   侧边栏 Agents tab 渲染
```

同一份真相（JSONL entry），两条消费路径强弱不等、互相覆盖，且左边那条在信号缺失时无人兜底。

---

## 5. 终态：使用者眼里将是什么样的

**本章结论：侧边栏状态永远等于磁盘真相的投影，信号丢失最多延迟收敛、不会错误收敛。**

### 5.1 成功路径（真实场景时间线）

场景：用户在 session S 并行派 subagent A、B 调研（同一 session 的 workflow 场景同构，不再重复）。

```
T+0s   主 agent 调 subagent start(A) → tool-call-end
       runtime 广播 session.subagentsChanged{kind:'started'}   （增量信号，无数据）
       renderer → RPC getSubagents(S) → extractor 读 JSONL → 侧栏出现 A(running)
T+5s   subagent B 同上 → 侧栏 A、B 均 running
T+40s  A 完成 → notifier 入队（B 还在跑，60s 窗口未到期，暂不发）
T+40s  A 完成 → 终态转换：`.finalized` sidecar 同步落盘（A9，早于通知窗口）
       └ 轻量信号（A10 候选 a/b）→ runtime 广播 session.subagentsChanged{kind:'terminal'}
           renderer → RPC getSubagents → extractor 投影（sidecar → done/failed）
                                                         ← 秒级收敛（决策 4）
T+70s  B 完成 → 窗口内全部完成 → flush bg-notify(batch: A done, B done)（面向 LLM，60s 窗口职责）
       ├ runtime 广播 session.subagentsChanged{kind:'notify'} → 重拉（幂等，状态已是终态）
       └ bg-notify triggerTurn 驱动主 agent 新 turn → turn 结束
           message.complete → 对账点：renderer 再拉一次（此时磁盘必已含终态，A1/A3）
                                                              ← 信号丢失时的有界收敛兜底
```

打开有历史的 session 再派新 subagent：切到 session 时 RPC 首拉（历史全集入 store）→ 新 subagent 启动信号 → 再拉（extractor 返回 历史 + 新增 全集）→ applyRecords 全量替换替换的是**同一真相源**的两次快照 → 列表只增不减。

### 5.2 失败路径（带恢复指引）

| 失败 | 表现 | 恢复 |
|------|------|------|
| 信号 WS 帧丢失 | 该次不刷新 | 下一个对账点（bg-notify 必触发 turn → `message.complete` 对账；或切 session/切 tab 首拉）自动收敛，无需用户动作 |
| `getSubagents` RPC 失败 | 侧栏显示错误态 + 保留旧数据（现状 M1 语义，`subagent.ts:146-149`） | 👉 侧栏错误态提供重试按钮（现状已有）；下一个对账点自动重试 |
| pi 进程 kill -9（workflow 运行中） | workflow state 文件停留 running | 👉 session 重开时 extension 恢复路径落盘 done/failed（决策 6.1）+ 恢复后补发无 turn 通知（决策 6.2）→ 侧栏显示 failed；若通知又丢，session focus 首拉兜底 |
| pi 进程 kill -9（subagent 运行中） | 主 session JSONL 无终态 entry（父扩展死，bg-notify 是唯一终态写入通路）；`.finalized` 亦由父侧写、无人补 | 👉 extractor 投影（决策 5）：子进程活着 → running（真在跑）；子进程已死 → 读子进程 JSONL 末行 → done/crashed。session 重开后 focus 首拉即显示正确状态，无扩展依赖、无通知依赖 |
| runtime 重启 / renderer 重连 | 订阅与快照全空 | 👉 重连成功后对全部已知 session 重拉一次（决策 3 对账点） |

---

## 6. 关键决策与权衡

**本章结论：6 个决策，核心是把 subagent 链路改造成 workflow 已验证的「信号 + 重拉」形态，并补齐对账与两处落盘。**

### 6.1 决策 1：subagent 状态链路采用「无状态信号 + RPC 重拉」（方案对比）

| 方案 | 长期架构合理性 | 短期实现成本 | 风险 | 裁决 |
|------|--------------|-------------|------|------|
| **B. 无状态信号 + RPC 重拉**（subagent 对齐 workflow 模式）：runtime 删 `subagentRecords`/`pendingStartParams`/全集广播，两类事件只广播增量信号；renderer 信号 → `loadSubagents` | 高：单一真相源（extractor 是唯一状态构建器）；与 workflow 链路同构（一种心智模型）；净删 runtime 状态与广播逻辑 | 中：协议类型变更 + renderer 触发逻辑 + interpreter 改造 + 重连恢复 | notify 信号立即重拉存在 A2 窄竞态（可能读到写前快照，显示旧态数秒）——确定性收敛由 `message.complete` 对账保证，不加额外重试；A5 未验证前，start 信号立即重拉可能拿不到记录（toolResult entry 时序）→ 用 500ms 重试兜住（同 workflow `RUNNING_RETRY_MS` 先例） | ✅ 选 |
| D. runtime 内存回放 + 广播前磁盘合并（原始设想）：初始化从 JSONL 回放内存态，每次广播前与 extractor 结果合并 | 中：内存仍是平行真相源，「内存新 vs 磁盘新」仲裁成为永久复杂度；每次广播一次磁盘全读 | 中高：回放 + 合并仲裁 + 广播去抖都要新写 | 仲裁逻辑本身是新 bug 面（本 bug 的教训正是「合并语义写错」）；性能随广播频率线性读盘 | ❌ |
| C. 增量 upsert 协议：广播单条 record 增量，renderer upsert 合并，孤儿增量触发重拉 | 中高：少一次 RPC | 中高：协议 + renderer 仲裁逻辑 | 「RPC 全量替换 vs 迟到增量」乱序覆盖需 per-id 时间戳仲裁——为省一次本地 RPC 引入分布式合并问题，不值 | ❌ |
| A. 补丁集（不动架构）：bg-notify 内存 miss 时触发重拉、广播前临时合并、处理 `pending:unregister` | 低：两个真相源原样保留，F1-F3 的复发面原样保留 | 低 | 每个补丁各自挡一个投影，根因（平行真相源）还在 | ❌（仅作对照） |

**被否若用**：方案 D 下，§5.1 的历史场景仍依赖「广播前合并」执行正确——任何一次合并 bug（如内存 stale 覆盖磁盘终态）都会复现 F1/F2，且难以测试；方案 B 下该场景**结构上不可能**出错（renderer 只有一个数据来源）。方案 A 下 F1-F5 逐个打补丁，每个新通知场景（扩展未来新增状态类型）都要重新审视补丁覆盖面。

### 6.2 决策 2：信号协议——新增 `session.subagentsChanged`（transient），废弃 `session.subagents` 全集推送

- 新类型走 transient（不分配 seq、不入 ring、不写快照，三分类语义见 `message-bus.ts:7-9` 模块头与 `:218-223` publish 分流）：信号是「去拉」的指令，丢了由对账兜底，不需要回放。
- 原 `session.subagents`（state 类，写快照）删除。stateSnapshot 对它的恢复职责由「重连后重拉」接管（决策 3）。
- `session.workflowUpdate` 协议不变（现状已是信号语义）。
- 兼容性：runtime 与 renderer 同应用同发布，无跨版本兼容问题；extension 侧改动（决策 6）独立 npm 发布，新 extension 对老 runtime 是正向增强（补发的 workflow-result 走既有处理路径）。

### 6.3 决策 3：对账点选择——事件驱动三点，不加轮询

| 对账点 | 触发 | 兜住什么 |
|--------|------|---------|
| `message.complete` | 主 session 每个 turn 结束（bg-notify 的 triggerTurn 保证终态通知后必有 turn，A3） | 一切窗口内信号丢失/推迟的最终收敛（含 F5 的 60s 窗口尾部） |
| `session.exited` / session 失焦后再聚焦 | pi 进程退出、用户切走再切回 | F3（terminateRunningRuns 不通知——落盘已正确，缺的是刷新）、kill-9 后重开 session |
| renderer 重连成功 | runtime 重启 / WS 断线恢复 | 快照/订阅全空场景的全量恢复 |

**为什么不轮询**：对账点已覆盖全部已知丢失路径的确定性收敛时机；轮询引入常驻负载且掩盖新丢失路径（丢失应该修信号，而不是靠轮询擦屁股）。`message.complete` 对账对同一 sid 做短窗口去抖（如 1s 内合并为一次拉取），避免 steer turn 频繁时的读放大。

### 6.4 决策 4：UI 收敛与 LLM 通知解耦——秒级信号走轻量通道，60s 窗口回归纯 LLM 职责

bg-notify 的 60s 滑动窗口（`notifier.ts:126-156`，还有 background 在跑时每来一条完成通知重置计时器）是按「LLM 上下文注入」优化的合并策略——一条通知双职责（UI 刷新触发 + LLM 注入），窗口不该约束 UI。事实 A9 表明终态转换时磁盘已有终态（sidecar 先于窗口写入），缺的只是「出口」：

- **秒级信号**：subagent 终态转换时刻发一条轻量信号（候选 a/b 见探针 A10），runtime 转发 `session.subagentsChanged{kind:'terminal'}` → renderer RPC 重拉；
- **extractor 读 sidecar**（决策 5 投影的一部分）：重拉时主 JSONL 尚无 bg-notify entry（还在窗口里），终态来自 `.finalized`/`.cancelled` sidecar 投影；
- bg-notify（60s 窗口、steer 注入、面向 LLM）原样保留，只服务主 agent 编排。

窗口本身不动（token 取舍属扩展）；UI 收敛上界从「窗口 + 一个 turn」降到「终态转换 + 一个 RPC 往返」。若 A10 两个候选都不可用，退化为 v2 形态（窗口 + 对账有界收敛），正确性不变、只有实时性回退。

### 6.5 决策 5：running 语义错位用投影层解决——扩展生命周期状态 ≠ UI 执行状态

**错位事实**（v2 曾豁免，v3 修正）：扩展的 `record.status` 是会话生命周期状态——`running` = 「record 未 closed」，内部三种子状态（真在跑：活进程+非 timer-armed；chatMode 轮完成等续聊：isIdle；one-shot 完成可 resume：isResumable，进程已死），谓词是执行状态的真相但未暴露。重建矩阵分支 4（`record-store.ts:822-826`：无 sidecar / `.alive` 但 pid 死 / 软超时）落点 running——这些记录**进程必然不存在，不可能在 streaming**，UI 显示 running 是误导。扩展把「可续聊」编码进 running 只是实现耦合（`isResumable` 谓词读 `status==='running'`，subagent-service.ts:582），不是产品语义。

**方案：xyz-agent 侧投影，扩展内部语义不动**（改扩展 status 落点会断续聊判定链，爆炸半径在扩展内）。**投影目标枚举对齐 dev-0.9.2 的 session 状态抽象**（`DerivedStatus` 9 态，`packages/core/src/domain/chat/derive-status.ts`；语义 SSOT：streaming=文本流式、waiting=等输入阻塞、stopped=用户停、error=错、working=后台任务在跑）——subagent 是「子 session」，状态语义应与主 session 同一哲学，UI 视觉复用同一套 `STATUS_ICON`/`DOT_CLASS` 语言。对齐后的 `SubagentStatus`（UI 投影层）6 态：`streaming` / `waiting` / `done` / `cancelled` / `stopped` / `error`（现有 `running`/`closed`/`crashed`/`failed` 在投影层退役：running 拆分为 streaming+waiting，closed/crashed/failed 归并入 done/stopped/error，细分经 closedReason/error 字段保留）。

extractor 对每条 subagent 记录按执行事实投影：

| 磁盘事实（按优先级） | UI 投影 |
|---------------------|---------|
| 主 JSONL 有 bg-notify 终态 entry | 该 entry 状态（含 result/error/agent 等元数据，最权威；closed→done/error、cancelled→cancelled） |
| `.cancelled` sidecar 存在 | cancelled（用户中止，对齐 stopped 族语义） |
| `.finalized` sidecar 存在 | 读子进程 session JSONL 末行：正常收尾 → done；截断/异常 → error |
| `.alive` + pid 活 + 未超 1h 软超时（`ALIVE_SOFT_TIMEOUT_MS`，防 pid 复用，与扩展矩阵分支 3 同规则） | streaming（进程真在跑）或 waiting（chatMode 轮完成等续聊）——区分依赖轻量信号携带 idle 位（A10 候选 a 的 payload）；**无轻量信号时回落 streaming**（进程活着的事实优先于 idle 细分） |
| 其余（无标记 / pid 死 / 超时——孤儿与崩溃） | 读子进程 session JSONL 末行：正常收尾 → done；截断/异常 → error（不再 running） |

「可续聊」在 UI 是 Resume 动作入口（是否可续 = sessionFile 存在性），不占用 status 字段。**waiting 态的数据源依赖**：`.alive` sidecar 只有 pid/startedAt，无 idle 位——等续聊（waiting）与真在跑（streaming）的实时区分依赖 A10 候选 a 的轻量信号携带 idle 位；候选不可用时等续聊显示 streaming（「进程活着」是事实下界，比显示 running 大杂烩仍是一步改进），waiting 态作为 A10a 落地后的增量。

**对 `hasBackgroundWork` 的连带语义**（dev-0.9.2 `useBackgroundWork.ts:25-27`）：投影后 `hasRunning` 改判「streaming ∨ waiting」——chatMode 等续聊的 subagent 任务未完成（等主 agent/用户续），session 级 working 态应继续点亮；streaming/waiting 在 session 层都聚合为 working，两层各自表达粒度。

此投影同时**替代 v2 决策 6.3**（subagent 崩溃重建补终态）：不需要改扩展重建矩阵、不需要补通知——重开 session 时 focus 首拉，extractor 从 sidecar + pid 探测直接投影终态。扩展改动面缩小到 workflow 域（决策 6.1/6.2）+ 可能的轻量事件（A10 候选 a）。

### 6.6 决策 6：extension 补落盘/通知缺口（workflow 域 + 可能的轻量事件）

**6.1 workflow kill-9 恢复落盘**：`index.ts:466-475` 的恢复循环把 running 转成 done/failed 后补 `store.save(run)`——磁盘真相源成立的前提（否则 F4 无解：RPC 拉到的永远是 running）。

**6.2 workflow 恢复通知用无 turn 注入（不复用 notifyDone）**：恢复路径转终态后需要让 sidebar 刷新，但**不能复用 `notifyDone`**——它以 `{triggerTurn:true, deliverAs:'steer'}` 发送（`helpers.ts:271-279`），而恢复发生在 `session_start`、agent 空闲，复用会导致「用户只是重开 session，agent 就自发跑一轮 LLM turn」（token 消耗 + 未请求的自主行为）。改用不带 `triggerTurn` 的 `pi.sendMessage({customType:'workflow-result', ...})`：走 append + `message_start` 事件分支，正好满足 sidebar 收敛所需的两个条件（entry 落盘 + runtime 事件），且不唤醒 agent（行为依赖探针 A8 验证）。正常完成路径的 `notifyDone`（带 turn，主 agent 需要被唤醒继续编排）不变。

**6.3 subagent 域（v3 收窄）**：崩溃/孤儿场景的终态不再依赖扩展补写——由决策 5 的 extractor 投影直接解决（sidecar + pid 探测 → crashed）。扩展侧 subagent 域唯一可能的改动是 A10 候选 a（终态转换时发轻量信号，含 idle 位扩展），属增强非必需。

### 6.7 决策 7：性能边界——接受每 turn 一次磁盘全读，超阈值再加缓存

对账新增读负载：每 `message.complete` 对该 sid 做 1 次 subagents + 1 次 workflows 拉取（去抖后）。extractor 现状 `readFileSync` 全文件解析（同步阻塞 runtime 主线程）。A6 未验证前**不预先**加缓存/异步化（减法原则）；实施期实测超阈值（如单次 >100ms）再补「mtime+size 未变跳过解析」缓存。

---

## 7. 实现机制（把终态落到代码层）

**本章结论：三层各自改动——runtime 净删状态、renderer 换触发器、extension 补落盘；协议新增一个 transient 信号类型。**

### 7.1 协议（`packages/shared/src/protocol.ts`）

```ts
// 新增（transient 信号，payload 无需快照语义）
'session.subagentsChanged': {
  payload: { sessionId: string; kind: 'started' | 'notify' | 'terminal' }
}
// 删除：'session.subagents'（全集 state 推送）
// 不变：'session.workflowUpdate'
```

删除 `session.subagents` 的连带改动（缺一则编译断或语义残留）：
- `protocol.ts:1271` 的 RPC reply `session.getSubagents` **复用** `ServerMessageMap['session.subagents']` 形状——reply 形状需与 push 类型解耦（独立定义）后才能删 push 类型；
- `message-bus.ts:131-137` `STATE_TYPE_KEY_MAP` 的 `'session.subagents': 'subagents'` 条目；
- `packages/core/src/coordination/route-inbound.ts:173-219`（`ROUTE_TABLE`）与 `:90-96`（`InboundEffects.onSubagents`）；
- renderer `useMessageEffects.handleSubagents`（`packages/renderer/src/composables/effects/useMessageEffects.ts:55-58`）。

`SubagentStatus` 枚举变更连带（决策 5 对齐 DerivedStatus）：`packages/shared` 类型定义（running/closed/crashed/failed → streaming/waiting/done/cancelled/stopped/error）+ extractor 投影产出 + sidebar `SubagentList`/drawer `SubagentTab` 消费 + `useBackgroundWork.hasRunning` 判定（→ streaming∨waiting）+ 视觉映射对齐 `sessionStatus.ts` 的 `STATUS_ICON`（同一状态语言）。

新类型必须**显式**加入 `TOPIC_TABLE`（transient）——未入表 fallback 是 'stream'（`message-bus.ts:109-115`），违背信号语义。

### 7.2 Runtime（`event-interpreter.ts` + `message-bus.ts` + `subagent-extractor.ts`）

- 删：`subagentRecords` / `pendingStartParams` / `broadcastSubagents` / `handleSubagentBgNotify` 的内存更新逻辑。
- 改：`handleSubagentEnd` → 广播 `session.subagentsChanged{kind:'started'}`；bg-notify 处理 → 广播 `session.subagentsChanged{kind:'notify'}`；轻量信号（A10 验证后）→ `{kind:'terminal'}`（三者均为无状态转发，不再持有/查询任何记录）。
- `TOPIC_TABLE` 增加新类型（transient）。
- **extractor 投影**（决策 5 表格的实现点）：`subagent-extractor.ts` 对「主 JSONL 无终态 entry 的记录」按 `.cancelled`/`.finalized`/`.alive`+pid/子进程 JSONL 末行四级投影；sidecar 路径由 sessionFile 推导（sessionFile 为 null 的记录经既有 `findSubagentSessionFile` 时间戳匹配兜底，匹配不到时保守投影 crashed）。workflow 侧广播逻辑不变（已是信号）。

### 7.3 Core + Renderer

- **core**（`packages/core/src/coordination/route-inbound.ts`）：`session.subagents` 条目替换为 `session.subagentsChanged` → `effects.onSubagentsChanged(sid, kind)`；`InboundEffects` 接口同步。
- **renderer**：`useMessageEffects` 实现新回调 → `subagentStore.triggerSubagentReload(sid, kind)`：立即 `loadSubagents`；`kind==='started'` 且结果为空时 500ms 重试一次（对齐 workflow `RUNNING_RETRY_MS` 模式，兜 A5）；`kind==='notify'` 不重试（A2 竞态的确定性收敛由 `message.complete` 对账保证，见 §4.1）。
- 对账点三处接线（决策 3）：`handleMessageComplete` 追加去抖重拉；`handleSessionExited` + focus 变化首拉（现状已有）；重连成功后遍历 `sessionStore.list` 全量重拉。
- store 层 `applyRecords` 全量替换语义**不变**（替换的目标永远是同一真相源的最新快照，正确性由「单一来源」保证，而非合并逻辑）。

### 7.4 Extension（`extensions/subagent-workflow/src/`）

- workflow kill-9 恢复循环补 `await store.save(run)`（决策 6.1，`index.ts:466-475`）。
- workflow 恢复通知改无 turn 注入（决策 6.2，`index.ts` 恢复路径）。
- （可选，A10 候选 a 时）终态转换点发轻量状态事件（含 idle 位，供决策 5 的 streaming/waiting 区分）。
- ~~subagent 重建矩阵分支 4 转终态 + 补发无 turn bg-notify~~（v2 残留，已被 v3/v4 决策 6.3 取代——extractor 投影解决，扩展 subagent 域不再必改）。

---

## 8. 验收（真实场景，非单测非 mock）

**本章结论：改动规模为大（跨层协议变更 + 行为变更），用 6 个真实场景验证，全部回溯 §2 目标。**

### 8.1 改动规模

大——协议类型变更、runtime/renderer/extension 三层行为变更。多场景验收。

### 8.2 验收场景

前置：`pnpm dev` 起真实应用（真实 pi 子进程、真实 WS、真实磁盘），准备一个有多条 subagent/workflow 历史的真实 session（JSONL ≥ 数十 entry）。观测手段：runtime 日志与 extension 日志（路径从 `getDataDir()` / `getPiAgentDir()` 动态推导，dev 下在 `~/.xyz-agent/` 数据目录的 `logs/` 下，禁止写死绝对路径）。

| 场景 | 回溯目标 | 真实流程/数据/路径 | 通过标准 |
|------|---------|-------------------|---------|
| 1. 并发终态收敛 | 目标 1 | session 里让主 agent 并行启动 2 个 subagent（如「并行调研 A、B 两个问题」），等首个完成 | 首个完成的 subagent 在秒级变为终态（轻量信号 + sidecar 投影，决策 4）；信号丢失时最迟 60s 窗口 + 一个 turn 内收敛（对账兜底）。日志可见 bg-notify、`session.subagentsChanged` 信号与 getSubagents RPC |
| 2. 列表不回退 | 目标 2 | 打开有 ≥3 条历史 subagent 的旧 session → 再启动 1 个新 subagent | 侧栏显示 历史 3 条 + 新 1 条；无条目消失 |
| 3. workflow 正常完成 | 目标 1 | 跑一个最小 workflow（单 agent call）至完成 | Flows tab 状态 running → done，无需手动刷新 |
| 4. workflow kill -9 恢复 | 目标 1/3 | workflow running 中 `kill -9` pi 进程 → 重开该 session | Flows tab 显示 failed（非 running）；`workflow-state/<runId>.jsonl` 末行含 done/failed；**重开后主 agent 无自发 LLM turn**（决策 6.2 副作用断言，日志无未经用户输入的 agent_start） |
| 5. runtime 重启恢复（重连重拉） | 目标 3 | subagent 运行中**只杀 runtime 子进程**（保持 Electron/renderer 存活，runtime 崩溃自动重启机制接管）→ 等待 renderer 重连 | 侧栏列表与磁盘 JSONL 一致；无空列表、无幻影记录——重连全量重拉对**存活的 store** 生效（不是靠重开应用的首拉） |
| 6. 链路同构回归 | 目标 4 | code review 层面：grep 确认 runtime 不再持有 `subagentRecords`；subagent 与 workflow 的触发路径调用同一 `trigger*Reload` 模式 | 无平行真相源残留；两条链路代码形态对称 |
| 7. subagent kill -9 恢复 | 目标 1/3 | subagent running 中 `kill -9` pi 进程 → 等子进程自然结束 → 重开该 session | 该 subagent 显示 done 或 crashed（投影依据子进程 JSONL 末行收尾状态，决策 5），**不是 running**；无需扩展补写终态 |
| 8. 信号丢失 → 对账收敛 | 目标 1 | subagent 终态通知窗口内，断开 renderer↔runtime WS（或场景 5 的 runtime 重启窗口）保持 renderer 存活，让 `session.subagentsChanged` 帧丢失 | 侧栏在下一个对账点（turn 结束 / 重连）有界收敛到终态——证明收敛不依赖信号送达 |

> 单测（vitest，interpreter 信号广播 / routeInbound 触发 / store 重试逻辑）作为回归辅助，不计入验收。

## 9. 实施

**本章结论：分 4 个阶段，每个阶段独立可验证、可回滚。**

| 阶段 | 内容 | 交付终态的什么 |
|------|------|---------------|
| M0 | 探针 A5/A7/A8/A10 验证（toolResult entry 时序、pi 版本核对、无 turn 注入行为、秒级轻量信号候选选型） | 消解方案 B 的未验证前提，确定秒级信号形态（A10 候选 a/b 二选一或退化为窗口 + 对账）与 started 信号重试参数 |
| M1 | 协议 + renderer/core 侧（新信号 handler、triggerSubagentReload、三对账点、重连重拉）；runtime 暂同时广播新旧（全集 + 信号） | renderer 双保险就位（此时已可单靠对账点收敛）。**过渡症状**：M1→M2 之间 runtime 全集广播仍在，F1（内存全集覆盖磁盘历史）仍会短暂出现，属已知过渡窗口而非回归，M2 消除 |
| M2 | runtime 无状态化（删内存态与全集广播）+ extractor 投影（决策 5 四级投影表） | 单一真相源成立，F1 结构性消除；running 语义错位与 subagent 崩溃场景同时解决（投影不依赖扩展版本） |
| M3 | extension 修复（workflow kill-9 save、无 turn 恢复通知；轻量信号若选 A10 候选 a 则加发）+ 独立 npm 发布 | workflow 磁盘真相源完备（F4 消除）；秒级信号补强（若走候选 a） |

## 10. 下一层拆分

| 单元 | 说明 | justification（为什么这么拆） |
|------|------|------------------------------|
| U1 协议与 core/renderer 触发 | protocol 类型（含 RPC reply 形状解耦）、routeInbound、triggerSubagentReload（含 started 空结果重试） | 与 runtime 改动解耦：renderer 先就位，M1 期间靠对账点已可收敛（每单元可独立验收） |
| U2 renderer 对账点 | message.complete 去抖重拉、session.exited 重拉、重连全量重拉 | 对账是最终一致的兜底机制，独立于信号路径，可用「杀 runtime 子进程」方式独立验收（场景 5/8） |
| U3 runtime 无状态化 + extractor 投影 | interpreter 删内存态、广播改信号、TOPIC_TABLE；extractor 四级投影（sidecar/pid/子进程 JSONL 末行） | 净删代码为主 + 投影是纯函数易测；投影不依赖扩展版本（M2 即消除 running 错位与崩溃卡死，不必等 M3） |
| U4 extension 修复 | workflow kill-9 save、无 turn 恢复通知；轻量信号（若 A10 选候选 a） | 独立 npm 发布管线，与 app 内改动解耦；对老 runtime 正向兼容（多出的 custom_message 走既有忽略/处理路径） |

## 11. 待验证检查点

| # | 检查点 | 验证方式 | 不成立时的退路 |
|---|--------|---------|---------------|
| A5 | tool_execution_end 到达时 toolResult entry 已在 JSONL | pi CLI 起真实 subagent start，runtime 收到事件瞬间读 JSONL | started 信号 500ms 重试已兜住；重试仍空则把重试次数提为 2（间隔 500ms） |
| A6 | 大 JSONL 全读耗时可接受 | ≥10MB 真实 session 实测 extractor 耗时 | 加「mtime+size 未变跳过解析」缓存（决策 7 预留） |
| A7 | 全局 dist（0.84.0）与 runtime 捆绑 pi（0.84.1）行为一致 | 对捆绑版本重跑 A1/A2 探针 | 按捆绑版实测结果修正 A2 竞态描述与重试参数 |
| A8 | 无 turn 注入不触发 LLM turn（决策 6.2/6.3 依赖） | pi CLI 实测 `sendMessage`（无 triggerTurn）注入后无 agent_start | 改用 `display` 通道或轮询 state 文件的替代通知形态 |
| 边界 | extractor「读取失败」与「真空集」语义合并（`readFileSync` 失败与无记录都返回 `[]`，`subagent-extractor.ts:107-110`）——信号触发的重拉可能用空数组瞬时覆盖非空历史列表 | 下一层设计 RPC 层 error/empty 区分（reply 带 error 字段），或 store 对「prior 非空且新结果为空」做守卫（不覆盖 + 记日志） | 记录为已知边界：错误语义只在 M1 期间风险最高（全集广播覆盖面大），M2 后影响面缩小为单次拉取窗口 |

---

## 附录：变更历史

- v1：初稿（基于 2026-08-18 全链路分析 + 三项事实查证：pi 同步落盘、bg-notify triggerTurn、级联关闭不落盘）。
- v2：按对抗式审查（4 must-fix / 5 suggestion，报告见 `subagent-workflow-sidebar-sync-design-review.md`）修订：A2 探针改锚真实路径并降级为「立即拉通常新鲜、对账拉保证新鲜」；决策 6 从两处扩为三处（workflow kill-9 落盘、恢复通知去 turn 副作用、subagent 崩溃重建补终态）；目标 1 措辞收窄（pi 崩溃场景 = 重开后有界收敛）；验收补场景 7（subagent kill -9）与场景 8（信号丢失→对账收敛）、场景 5 改为只杀 runtime 子进程；补协议删除连带清单、M1 过渡症状、extractor 空/错误语义边界。
- v3：按 owner 对 running 语义与 60s 窗口的质询修订：决策 4 重写（UI 收敛与 LLM 通知解耦——秒级轻量信号 + sidecar 投影，60s 窗口回归纯 LLM 职责，探针 A9/A10）；决策 5 重写（running = 扩展生命周期状态 ≠ 执行状态，加 extractor 四级投影表，孤儿/崩溃投影 done/crashed 不再 running，替代 v2 的扩展重建矩阵改动）；决策 6.3 收窄为 extractor 投影（扩展 subagent 域不再必改）；目标 1 收敛上界从「窗口+turn」提升为「秒级」。
- v4：投影目标枚举对齐 dev-0.9.2 的 session 状态抽象（`DerivedStatus` 9 态语义 SSOT，`derive-status.ts`）：`SubagentStatus` 重定义为 streaming/waiting/done/cancelled/stopped/error 6 态（running 拆分 streaming+waiting，closed/crashed/failed 归并）；waiting 态数据源标注依赖 A10 候选 a 的 idle 位（无轻量信号时回落 streaming）；补 `hasBackgroundWork` 连带语义（streaming∨waiting → session working 态）与枚举变更连带清单。
