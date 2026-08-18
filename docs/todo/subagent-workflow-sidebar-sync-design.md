# subagent/workflow 侧边栏状态同步架构重构设计

> **一句话结论**：把侧边栏 subagent/workflow 状态收敛为「磁盘单一真相源 + 无状态信号转发 + 事件驱动对账」——runtime 删除平行内存真相源，subagent 链路对齐 workflow 已有的「信号 → RPC 重拉」模式；extractor 六级投影（bg-notify 终态 entry / sidecar / `.alive`+pid / 轮次 entry / 子进程 JSONL 收尾 / start 早期保守态）修正 running 语义错位，孤儿与崩溃不再显示 running；秒级轻量信号让 UI 收敛与 60s LLM 通知窗口解耦；workflow kill-9 恢复补落盘。

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

1. **终态收敛**：subagent/workflow 结束后，侧边栏在秒级显示终态（终态/收尾时刻轻量信号 + 六级投影，见决策 4）；信号丢失时由对账点保证有界收敛（≤60s 通知窗口 + 一个 turn）；pi 崩溃（kill -9）场景在 session 重开时收敛（重开前无人消费状态，不构成卡死）（回溯症状：终止不更新、kill -9 永久 running）。
2. **列表不回退**：任意时刻侧边栏列表是磁盘真相的全集——打开有历史的 session 后再启动新任务，历史条目不消失（回溯症状：列表回退/消失）。
3. **恢复一致**：runtime 重启、renderer 重连、pi 进程崩溃后，侧边栏状态与磁盘一致（回溯症状：kill-9 后永久 running）。
4. **架构一致性**：subagent 与 workflow 两条状态链路在**机制层**同构（「信号 → RPC 重拉磁盘」+ 对账点一种模式），消除平行真相源。枚举层的统一（workflow 三态 vs subagent 新 6 态）不在本次范围——见 Out-of-scope。

**In-scope**：runtime 状态广播协议重构（subagent 全集广播 → 增量信号）；renderer 重拉触发与对账机制；extension 两处落盘缺口修复（workflow kill-9 恢复落盘 + 恢复后补信号）；SubagentStatus 枚举重定义与 extractor 六级投影。
**Out-of-scope**：通知合并的 60s 滑动窗口本身（扩展的性能/token 取舍，见决策 4）；workflow 状态枚举与视觉语言对齐——`WorkflowRunStatus` 三态与 `WorkflowDoneReason` 五值不动、WorkflowList 自有 statusDotClass 不迁移 STATUS_ICON（已知不一致：用户终止在 Flows tab 红、Agents tab 的 stopped 灰，属既有 UI 议题列后续项）；paused 死值退役（连带 Pause/Resume 按钮链路）；subagent 级联关闭的通知策略（结构上无解，见决策 5 映射表死行注）；侧边栏 UI；MessageBus 传输机制本身。

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

### 3.2 怎么出错（六类已核实失败模式）

| # | 失败模式 | 触发条件 | 后果 |
|---|---------|---------|------|
| F1 | 内存全集覆盖磁盘全集 | 打开有历史的 session（RPC 首拉已显示历史）→ 启动新 subagent → 广播只含内存记录 | 历史 subagent 从侧栏消失 |
| F2 | bg-notify 内存 miss 被丢弃 | session 重开后内存为空、或该 subagent 启动记录未建成；bg-notify 到达时 `if (!existing) continue` | 终态永不广播，侧栏永久 running |
| F3 | 通知根本不发 | subagent 级联关闭（/new、/fork、session_shutdown 的 `disposeAllRecords`）只清内存不发通知；workflow `terminateRunningRuns`（lifecycle.ts:304-306）落盘但不通知 | 停留在旧状态直到用户切走再切回 |
| F4 | 磁盘状态本身错误 | workflow kill-9/crash 恢复（index.ts:466-475）只改内存无 `store.save` → state 文件永远写 running | RPC 拉到的也是 running，永久卡死 |
| F5 | 通知推迟 ≥60s | 并发 ≥2 个 background subagent 时，notifier.ts:126-156 滑动窗口每来一条完成通知就重置 60s 计时器 | 用户感知「明明完成了还 running」 |
| F6 | running 语义错位 | 扩展的 running 是「会话生命周期未终结」（含真在跑 / chatMode 轮完成等续聊 / one-shot 完成可 resume / 重建兜底），谓词未暴露——UI 无法区分，一律显示「正在跑」 | 「等续聊」「已完成可 resume」显示 running 是误导（决策 5 立项动机，v5 起进入失败模式清单） |

### 3.3 根因

**两条平行真相源（runtime 内存 vs 磁盘）互相覆盖，且没有对账机制兜底 best-effort 信号。** 推送信号（bg-notify / workflow-result）在设计上就是会推迟、会丢的（合并窗口、级联关闭、崩溃），但现状把「信号到达」当成状态更新的**唯一**来源——信号丢 = 状态永久停在旧值。F1-F5 全部是这两个根因的不同投影；F6 是语义投影层缺失（决策 5 解决）。

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
| A9 | subagent 收尾双路径的磁盘时序（R3 修正）：**失败/cancel/用户 close**（`doFinalizeRecord`）→ `.finalized`/`.cancelled` sidecar 同步写盘、早于 bg-notify 入 60s 窗口；**one-shot 成功与 chatMode 轮次完成**（`doFinalizeRoundToIdle`，subagent-service.ts:1478-1508）→ **不写任何 sidecar 且删除 `.alive`**（finalize-record.ts:187-242），窗口期内磁盘信号 = `.alive` 消失 + pid 死 + 子进程 JSONL 收尾（投影级 6 兜住）+ 窗口 flush 后的 bg-notify entry | `subagent-service.ts:1533-1543`（runAndFinalize → .then → notifyComplete）；`finalize-record.ts:99-116`（record 路径写 sidecar）`:187-242`（roundToIdle 无 sidecar + removeAliveMarker） | ✅ 已核（v5 分路径修正：v3 曾误把 sidecar 覆盖到全部路径） |
| A10 | 「秒级轻量信号」可用：候选 a = 扩展发无 turn 轻量事件（**发起点集合 = 终态转换 + 轮次完成 idle 位翻转**，见决策 6.3）；候选 b = runtime 挂 subagent stream 终止帧转发信号（零扩展改动；**注意 chatMode 每轮完成也发终止帧——信号只代表「状态变了」不代表终态**，见 MF-4） | 实施期门：M0 用 pi CLI 实测两候选的事件到达时序、特异性（b 是否轮次误触发）与副作用 | ⛏ 实施期验证（决策 4 依赖） |

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
       renderer → RPC getSubagents(S) → extractor 读 JSONL → 侧栏出现 A(streaming)
T+5s   subagent B 同上 → 侧栏 A、B 均 streaming
T+40s  A 完成 → notifier 入队（B 还在跑，60s 窗口未到期，暂不发）
T+40s  A 完成 → 收尾路径分流（A9 双路径）：
       · 失败/cancel：`.finalized` sidecar 同步落盘（早于窗口）
       · 成功（最高频）：roundToIdle——删 `.alive`、无 sidecar，磁盘信号 = pid 死 + 子 JSONL 收尾
       └ 轻量信号（A10 候选 a/b）→ runtime 广播 session.subagentsChanged{kind:'terminal'}
           renderer → RPC getSubagents → extractor 六级投影（成功走级 6 子 JSONL 收尾 → done；
           失败走级 3 sidecar → error）                          ← 秒级收敛（决策 4）
           （候选 b 注：stream 终止帧早于 sidecar 落盘——finally 先于 finalizeRecord，
            但两级投影结果一致，收敛不受影响）
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
| pi 进程 kill -9（subagent 运行中） | 主 session JSONL 无终态 entry（父扩展死，bg-notify 是唯一终态写入通路）；成功路径本就无 sidecar（A9 路径 I），失败路径的 `.finalized` 亦由父侧写、无人补 | 👉 extractor 六级投影（决策 5）：子进程活着 → streaming（真在跑）；子进程已死 → 读子进程 JSONL 末行 → done/error（孤儿）或轮次 entry → waiting（Path B）。session 重开后 focus 首拉即显示正确状态，无扩展依赖、无通知依赖 |
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

- **秒级信号**：subagent 收尾时刻发一条轻量信号（候选 a/b 见探针 A10；候选 b 的终止帧对 chatMode 轮次完成也会发出——信号语义是「状态变了，去拉」而非「终态」，若选 b 则 kind 用幂等的 `changed` 或在翻译处过滤），runtime 转发 `session.subagentsChanged` → renderer RPC 重拉；
- **extractor 六级投影**（决策 5）：重拉时按 bg-notify entry / sidecar / `.alive`+pid / 轮次 entry / 子进程 JSONL 六级判定——成功路径（无 sidecar）靠级 6 子 JSONL 收尾、失败路径靠级 3 sidecar，两级都在窗口期内可用；
- bg-notify（60s 窗口、steer 注入、面向 LLM）原样保留，只服务主 agent 编排。

窗口本身不动（token 取舍属扩展）；UI 收敛上界从「窗口 + 一个 turn」降到「终态转换 + 一个 RPC 往返」。若 A10 两个候选都不可用，退化为 v2 形态（窗口 + 对账有界收敛），正确性不变、只有实时性回退。

### 6.5 决策 5：running 语义错位用投影层解决——扩展生命周期状态 ≠ UI 执行状态

**错位事实**（v2 曾豁免，v3 修正）：扩展的 `record.status` 是会话生命周期状态——`running` = 「record 未 closed」，内部三种子状态（真在跑：活进程+非 timer-armed；chatMode 轮完成等续聊：isIdle；one-shot 完成可 resume：isResumable，进程已死），谓词是执行状态的真相但未暴露。重建矩阵分支 4（`record-store.ts:822-826`：无 sidecar / `.alive` 但 pid 死 / 软超时）落点 running——这些记录**进程必然不存在，不可能在 streaming**，UI 显示 running 是误导。扩展把「可续聊」编码进 running 只是实现耦合（`isResumable` 谓词读 `status==='running'`，subagent-service.ts:582），不是产品语义。

**方案：xyz-agent 侧投影，扩展内部语义不动**（改扩展 status 落点会断续聊判定链，爆炸半径在扩展内）。**投影目标枚举对齐 dev-0.9.2 的 session 状态抽象**（`DerivedStatus` 9 态，`packages/core/src/domain/chat/derive-status.ts`；语义 SSOT：streaming=文本流式、waiting=等输入阻塞、stopped=用户停、error=错、working=后台任务在跑）——subagent 是「子 session」，状态语义应与主 session 同一哲学，UI 视觉复用同一套 `STATUS_ICON`/`DOT_CLASS` 语言。对齐后的 `SubagentStatus`（UI 投影层）6 态：`streaming` / `waiting` / `done` / `cancelled` / `stopped` / `error`（现有 `running`/`closed`/`crashed`/`failed` 在投影层退役：running 拆分为 streaming+waiting，closed/crashed/failed 归并入 done/stopped/error，细分经 closedReason/error 字段保留）。

**扩展收尾的双路径事实**（R3 核实，投影矩阵的地基）：终态收尾有两条路径——
- **路径 R（record 终结）**：失败/cancel/用户 close 走 `doFinalizeRecord`，写 `.finalized`/`.cancelled` sidecar（finalize-record.ts:99-116）；
- **路径 I（roundToIdle）**：one-shot **成功完成**与 chatMode 轮次完成走 `doFinalizeRoundToIdle`，**不写任何 sidecar、删除 `.alive` marker**（finalize-record.ts:187-242、subagent-service.ts:1478-1508）——即最高频的「成功」路径在窗口期内磁盘上没有任何 sidecar，其磁盘信号是 `.alive` 消失 + pid 死 + 子进程 JSONL 收尾，以及（窗口 flush 后）bg-notify entry（one-shot 成功的 notify status=closed；chatMode 轮次的 notify status=running 含 round 字段）。

extractor 六级投影（按序判定，先命中先停）：

| 级 | 磁盘事实 | UI 投影 | 说明 |
|----|---------|---------|------|
| 1 | 最后 bg-notify entry 为**终态**（status='closed' 或 legacy 终态值 done/failed/cancelled/completed/error/crashed） | 按 `(status, closedReason, error) → 6 态` 映射表（见下） | 最权威（含 result/agent 等元数据）；轮次 running entry **不是**终态，不入本级 |
| 2 | `.cancelled` sidecar 存在 | cancelled | 用户中止 |
| 3 | `.finalized` sidecar 存在 | 读子进程 JSONL 末行：正常收尾 → done；截断/异常 → error | chatMode close 的窗口期组合（轮次 running entry + `.finalized`）由本级接住——sidecar 优先于 entry 解析。已知瞬态：`.finalized` 是空文件不含 closedReason，窗口期内投影 done/error，flush 后终态 entry（closed+user-close）落盘 → 级 1 → stopped——用户可见「done → stopped」短暂变化（≤60s+turn），接受 |
| 4 | `.alive` + pid 活 + 未超 1h 软超时（`ALIVE_SOFT_TIMEOUT_MS`，防 pid 复用，与扩展矩阵分支 3 同规则） | streaming；waiting 依 idle 位（轻量事件 entry，A10a；无则 streaming） | Path A（chatMode 轮完成进程保活） |
| 5 | 最后 bg-notify entry 为 **running 轮次通知**（status='running'，含 round 字段） | waiting | chatMode 活跃会话（Path B：idle 超时进程已回收，`/`.alive 已删）——与孤儿同形，靠轮次 entry 区分。**冷路径窗口期缺口**：轮次 entry 与终态 entry 同样进 60s 窗口，窗口期内重拉（秒级信号触发）时轮次 entry 未落盘 → 落级 6 → 可能误报 done，flush 后对账修正回 waiting（「done → waiting」抖动 ≤60s+turn）——是否真实发生由 A10 探针实测，真实则级 6 加 startedAt 窗口宽限（start entry 时间距今 < 窗口期 + 1 turn 且无终态 entry → 保守 streaming） |
| 6 | 其余（孤儿与崩溃：无终态 entry、无 sidecar、无 `.alive`、无轮次 entry） | 读子进程 session JSONL 末行：正常收尾 → done；截断/异常 → error；**子 JSONL 不存在/不可读 → streaming**（start 早期保守——spawn 窗口内子文件未建，误报 error 会与 §5.1 T+0s 直接矛盾；孤儿至少跑过、文件必然存在） | 覆盖 one-shot 成功（roundToIdle 后窗口期内，无任何 sidecar/entry——靠子 JSONL 收尾判 done）、真孤儿、**级联关闭**（disposeAllRecords 不通知不写 sidecar，无任何磁盘终态信号——见下） |

**`(status, closedReason, error) → 6 态` 映射表**（closedReason 实测 6 值：`parent-shutdown | parent-fork | parent-new | user-close | cancelled | gc`，types.ts:62）：

| 输入 | 输出 | 依据 |
|------|------|------|
| closed + gc + error 空 | done | gc 是 done/failed/crashed 的合并态（record-store.ts:806），error 字段是成败判据 |
| closed + gc + error 非空 | error | 同上 |
| closed + cancelled | cancelled | 用户取消 |
| closed + user-close | stopped | 用户主动结束（对齐 DerivedStatus stopped=用户停）。含 closeAfterRound 兑现路径：one-shot busy 时 close 的请求在本轮成功完成后兑现——任务可能已成功，结果经 result 字段仍可见 |
| ~~closed + parent-shutdown / parent-fork / parent-new → stopped~~ | **（不可达死行）** | 级联关闭唯一路径 `disposeAllRecords`（subagent-service.ts:402-433）不 notify 不写 sidecar——主 JSONL 永远不会出现 parent-* 终态 entry；即使补 notify，`pi.sendMessage` 在 /new、/fork 语境下注入的是**切换后新 session** 的 JSONL，旧 session 拿不到——通路结构上无解。**级联关闭实际落级 6**（无任何磁盘终态信号 → 子 JSONL 末行 → done/error）；v5 曾把 parent-* 列为 stopped 数据源，v6 修正——stopped 的真实数据源 = user-close（上一行）。parent-* 三值仅在 normalize 兼容层保留（未来扩展若改变通知策略） |
| closed（无 closedReason）+ error 空/非空 | done / error | 兜底按 error；**可达且是 one-shot 成功最高频路径的实际载体**（roundToIdle 清除 closedReason 后 notify status=closed 无 reason） |
| legacy done/completed/success | done | normalizeSubagentStatus 现状兼容层保留 |
| legacy failed/error/crashed | error | 同上 |
| legacy cancelled/canceled | cancelled | 同上 |
| legacy active/pending | streaming | **仅 normalize 单值兼容层的防御性值**（bg-notify 从不发 active/pending——不是级 1 输入域，列入此表防实现者困惑） |

**sessionFile 解析优先级链**（级 2/3/4/6 的探测路径全部依赖它，现状 extractor 只解析 toolResult LLM content，而其中 sessionFile 恒为 null——真实值在同一 entry 的 `message.details`，扩展 MF-3 瘦身决策保留、pi `ToolResultMessage.details` 已持久化落盘）：
1. toolResult entry 的 `message.details.sessionFile`（start 时即有，**新增 extractor 解析点**——数据现成，这是六级投影地基的关键补强）；
2. bg-notify entry 的 `sessionFile`（**shared `BgNotifyRecord` 补 `sessionFile?` 字段 + 解析链**——扩展 chatMode 轮次通知实际透传了它，现状被类型层丢弃）；
3. listResponse item 的 sessionFile（现状已有）；
4. `findSubagentSessionFile` 时间戳兜底（**仅当 startedAt 存在才匹配**——无 startedAt 返回「最近文件」在并发启动时拿错文件，风险接受并降级为最后手段）。

判定逻辑落点：extractor 组合层新增投影函数（输入 status + closedReason + error + 上述磁盘事实）；`normalizeSubagentStatus` **接口裁决**：extractor 组合层在调用前按 `status === 'closed'` 分流（closed 走组合映射表），normalize 只处理非 closed 输入、返回类型保持 `SubagentStatus` 单一（不 widen）；其 default 分支兜底值从 closed 改为 **error**（对齐「未知值更可能是终态细分」的既有注释理由——closed 在新枚举已不存在）。

「可续聊」在 UI 是 Resume 动作入口（是否可续 = sessionFile 存在性），不占用 status 字段。**waiting 的数据源**：级 5 的轮次 entry（60s 窗口后可用）+ A10a 轻量事件的 idle 位（发起点集合 = 终态转换 **+ 轮次完成**，见决策 6.3——仅挂终态转换点则等续聊期间无 idle 位，waiting 不可达）；窗口期内 Path A 回落 streaming（级 4）。chatMode 多轮 session 的 A10a 事件落盘积累（每轮一条 entry）在 A10 探针评估。

**对 `hasBackgroundWork` 的连带语义**（dev-0.9.2 `useBackgroundWork.ts:25-27`，落点在 renderer `stores/subagent.ts` 的 `hasRunning` 实现）：投影后 `hasRunning` 改判「streaming ∨ waiting」——chatMode 等续聊（含 Path B）的 subagent 任务未完成，session 级 working 态应继续点亮；streaming/waiting 在 session 层都聚合为 working，两层各自表达粒度。

此投影同时**替代 v2 决策 6.3**（subagent 崩溃重建补终态）：不需要改扩展重建矩阵、不需要补通知——重开 session 时 focus 首拉，extractor 从 sidecar + pid 探测直接投影终态。扩展改动面缩小到 workflow 域（决策 6.1/6.2）+ 可能的轻量事件（A10 候选 a）。

### 6.6 决策 6：extension 补落盘/通知缺口（workflow 域 + 可能的轻量事件）

**6.1 workflow kill-9 恢复落盘**：`index.ts:466-475` 的恢复循环把 running 转成 done/failed 后补 `store.save(run)`——磁盘真相源成立的前提（否则 F4 无解：RPC 拉到的永远是 running）。

**6.2 workflow 恢复通知用无 turn 注入（不复用 notifyDone）**：恢复路径转终态后需要让 sidebar 刷新，但**不能复用 `notifyDone`**——它以 `{triggerTurn:true, deliverAs:'steer'}` 发送（`helpers.ts:271-279`），而恢复发生在 `session_start`、agent 空闲，复用会导致「用户只是重开 session，agent 就自发跑一轮 LLM turn」（token 消耗 + 未请求的自主行为）。改用不带 `triggerTurn` 的 `pi.sendMessage({customType:'workflow-result', ...})`：走 append + `message_start` 事件分支，正好满足 sidebar 收敛所需的两个条件（entry 落盘 + runtime 事件），且不唤醒 agent（行为依赖探针 A8 验证）。正常完成路径的 `notifyDone`（带 turn，主 agent 需要被唤醒继续编排）不变。

**6.3 subagent 域（v3 收窄）**：崩溃/孤儿场景的终态不再依赖扩展补写——由决策 5 的 extractor 投影直接解决（六级投影表）。扩展侧 subagent 域唯一可能的改动是 A10 候选 a（轻量状态事件），**发起点集合 = 终态转换 + 轮次完成（idle 位翻转）**——只挂终态转换点则 chatMode 等续聊期间无 idle 位 entry、waiting 在 A10a 落地后仍不可达；每轮一条 custom_message entry 的落盘积累与上下文代价在 A10 探针评估（不进上下文为前提）。

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
  // A10 裁决候选 b 时 kind 联合增 'changed'（幂等重拉语义，渲染端与 notify 同处理；
  // 若走翻译处过滤则目标值 = 'notify'）
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
- **extractor 六级投影**（决策 5 表格的实现点）：`subagent-extractor.ts` 对每条记录按 entry → sidecar → `.alive`+pid → 轮次 entry → 子进程 JSONL 六级判定；sidecar 路径由 sessionFile 推导（sessionFile 为 null 的记录经既有 `findSubagentSessionFile` 时间戳匹配兜底，匹配不到时保守投影 error）。workflow 侧广播逻辑不变（已是信号）。

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
| 1. 并发终态收敛 | 目标 1 | session 里让主 agent 并行启动 2 个 subagent（如「并行调研 A、B 两个问题」），等首个完成 | 首个完成的 subagent 在秒级变为终态（轻量信号 + 六级投影，决策 4）；信号丢失时最迟 60s 窗口 + 一个 turn 内收敛（对账兜底）。日志可见 bg-notify、`session.subagentsChanged` 信号与 getSubagents RPC |
| 2. 列表不回退 | 目标 2 | 打开有 ≥3 条历史 subagent 的旧 session → 再启动 1 个新 subagent | 侧栏显示 历史 3 条 + 新 1 条；无条目消失 |
| 3. workflow 正常完成 | 目标 1 | 跑一个最小 workflow（单 agent call）至完成 | Flows tab 状态 running → done，无需手动刷新 |
| 9. chatMode 等续聊语义 | 目标 1 + F6 | conversation:true 启动 subagent → 一轮完成 → 等续聊期间断言侧栏显示 waiting（或 A10 前 streaming），**不是 running**；session 状态点 working 点亮（hasRunning=streaming∨waiting 连带）；续聊一轮后再断言恢复 streaming |
| 4. workflow kill -9 恢复 | 目标 1/3 | workflow running 中 `kill -9` pi 进程 → 重开该 session | Flows tab 显示 failed（非 running）；`workflow-state/<runId>.jsonl` 末行含 done/failed；**重开后主 agent 无自发 LLM turn**（决策 6.2 副作用断言，日志无未经用户输入的 agent_start） |
| 5. runtime 重启恢复（重连重拉） | 目标 3 | subagent 运行中**只杀 runtime 子进程**（保持 Electron/renderer 存活，runtime 崩溃自动重启机制接管）→ 等待 renderer 重连 | 侧栏列表与磁盘 JSONL 一致；无空列表、无幻影记录——重连全量重拉对**存活的 store** 生效（不是靠重开应用的首拉） |
| 6. 链路同构回归 | 目标 4 | code review 层面：grep 确认 runtime 不再持有 `subagentRecords`；subagent 与 workflow 的触发路径调用同一 `trigger*Reload` 模式 | 无平行真相源残留；两条链路代码形态对称 |
| 7. subagent kill -9 恢复 | 目标 1/3 | subagent running 中 `kill -9` pi 进程 → 等子进程自然结束 → 重开该 session | 该 subagent 显示 done 或 error（投影依据子进程 JSONL 末行收尾状态，决策 5），**不是 running/streaming**；无需扩展补写终态 |
| 8. 信号丢失 → 对账收敛 | 目标 1 | subagent 终态通知窗口内，断开 renderer↔runtime WS（或场景 5 的 runtime 重启窗口）保持 renderer 存活，让 `session.subagentsChanged` 帧丢失 | 侧栏在下一个对账点（turn 结束 / 重连）有界收敛到终态——证明收敛不依赖信号送达 |

> 单测（vitest，interpreter 信号广播 / routeInbound 触发 / store 重试逻辑）作为回归辅助，不计入验收。

## 9. 实施

**本章结论：分 4 个阶段，每个阶段独立可验证、可回滚。**

| 阶段 | 内容 | 交付终态的什么 |
|------|------|---------------|
| M0 | 探针 A5/A7/A8/A10 验证（toolResult entry 时序、pi 版本核对、无 turn 注入行为、秒级轻量信号候选选型） | 消解方案 B 的未验证前提，确定秒级信号形态（A10 候选 a/b 二选一或退化为窗口 + 对账）与 started 信号重试参数 |
| M1 | 协议 + renderer/core 侧（新信号 handler、triggerSubagentReload、三对账点、重连重拉）；runtime 暂同时广播新旧（全集 + 信号） | renderer 双保险就位（此时已可单靠对账点收敛）。**过渡症状**：M1→M2 之间 runtime 全集广播仍在，F1（内存全集覆盖磁盘历史）仍会短暂出现，属已知过渡窗口而非回归，M2 消除 |
| M2 | runtime 无状态化（删内存态与全集广播）+ extractor 投影（决策 5 六级投影表） | 单一真相源成立，F1 结构性消除；running 语义错位与 subagent 崩溃场景同时解决（投影不依赖扩展版本） |
| M3 | extension 修复（workflow kill-9 save、无 turn 恢复通知；轻量信号若选 A10 候选 a 则加发）+ 独立 npm 发布 | workflow 磁盘真相源完备（F4 消除）；秒级信号补强（若走候选 a） |

## 10. 下一层拆分

| 单元 | 说明 | justification（为什么这么拆） |
|------|------|------------------------------|
| U1 协议与 core/renderer 触发 | protocol 类型（含 RPC reply 形状解耦）、routeInbound、triggerSubagentReload（含 started 空结果重试） | 与 runtime 改动解耦：renderer 先就位，M1 期间靠对账点已可收敛（每单元可独立验收） |
| U2 renderer 对账点 | message.complete 去抖重拉、session.exited 重拉、重连全量重拉 | 对账是最终一致的兜底机制，独立于信号路径，可用「杀 runtime 子进程」方式独立验收（场景 5/8） |
| U3 runtime 无状态化 + extractor 投影 | interpreter 删内存态、广播改信号、TOPIC_TABLE；extractor 六级投影（终态 entry/轮次 entry/sidecar/`.alive`+pid/子进程 JSONL 末行/start 早期保守态） | 净删代码为主 + 投影是纯函数易测；投影不依赖扩展版本（M2 即消除 running 错位与崩溃卡死，不必等 M3） |
| U4 extension 修复 | workflow kill-9 save、无 turn 恢复通知；轻量信号（若 A10 选候选 a） | 独立 npm 发布管线，与 app 内改动解耦；对老 runtime 正向兼容（多出的 custom_message 走既有忽略/处理路径） |

## 11. 待验证检查点

| # | 检查点 | 验证方式 | 不成立时的退路 |
|---|--------|---------|---------------|
| A5 | tool_execution_end 到达时 toolResult entry 已在 JSONL | pi CLI 起真实 subagent start，runtime 收到事件瞬间读 JSONL | started 信号 500ms 重试已兜住；重试仍空则把重试次数提为 2（间隔 500ms） |
| A6 | 大 JSONL 全读耗时可接受 | ≥10MB 真实 session 实测 extractor 耗时 | 加「mtime+size 未变跳过解析」缓存（决策 7 预留） |
| A7 | 全局 dist（0.84.0）与 runtime 捆绑 pi（0.84.1）行为一致 | 对捆绑版本重跑 A1/A2 探针 | 按捆绑版实测结果修正 A2 竞态描述与重试参数 |
| A8 | 无 turn 注入不触发 LLM turn（决策 6.2/6.3 依赖） | pi CLI 实测 `sendMessage`（无 triggerTurn）注入后无 agent_start | 改用 `display` 通道或轮询 state 文件的替代通知形态 |
| A10 | 秒级轻量信号可用性与特异性（决策 4 依赖；探针定义见 §4.1 表 A10 行） | M0 探针脚本：候选 a 发起点集合（终态 + 轮次）与不进上下文验证；候选 b 到达性 + **chatMode 轮次误触发特异性** | 退化为「窗口 + 对账」（决策 4 预留） |
| 边界 | extractor「读取失败」与「真空集」语义合并（`readFileSync` 失败与无记录都返回 `[]`，`subagent-extractor.ts:107-110`）——信号触发的重拉可能用空数组瞬时覆盖非空历史列表 | 下一层设计 RPC 层 error/empty 区分（reply 带 error 字段），或 store 对「prior 非空且新结果为空」做守卫（不覆盖 + 记日志） | 记录为已知边界：错误语义只在 M1 期间风险最高（全集广播覆盖面大），M2 后影响面缩小为单次拉取窗口 |

---

## 附录：变更历史

- v1：初稿（基于 2026-08-18 全链路分析 + 三项事实查证：pi 同步落盘、bg-notify triggerTurn、级联关闭不落盘）。
- v2：按对抗式审查（4 must-fix / 5 suggestion，报告见 `subagent-workflow-sidebar-sync-design-review.md`）修订：A2 探针改锚真实路径并降级为「立即拉通常新鲜、对账拉保证新鲜」；决策 6 从两处扩为三处（workflow kill-9 落盘、恢复通知去 turn 副作用、subagent 崩溃重建补终态）；目标 1 措辞收窄（pi 崩溃场景 = 重开后有界收敛）；验收补场景 7（subagent kill -9）与场景 8（信号丢失→对账收敛）、场景 5 改为只杀 runtime 子进程；补协议删除连带清单、M1 过渡症状、extractor 空/错误语义边界。
- v3：按 owner 对 running 语义与 60s 窗口的质询修订：决策 4 重写（UI 收敛与 LLM 通知解耦——秒级轻量信号 + sidecar 投影，60s 窗口回归纯 LLM 职责，探针 A9/A10）；决策 5 重写（running = 扩展生命周期状态 ≠ 执行状态，加 extractor 四级投影表，孤儿/崩溃投影 done/crashed 不再 running，替代 v2 的扩展重建矩阵改动）；决策 6.3 收窄为 extractor 投影（扩展 subagent 域不再必改）；目标 1 收敛上界从「窗口+turn」提升为「秒级」。
- v4：投影目标枚举对齐 dev-0.9.2 的 session 状态抽象（`DerivedStatus` 9 态语义 SSOT，`derive-status.ts`）：`SubagentStatus` 重定义为 streaming/waiting/done/cancelled/stopped/error 6 态（running 拆分 streaming+waiting，closed/crashed/failed 归并）；waiting 态数据源标注依赖 A10 候选 a 的 idle 位（无轻量信号时回落 streaming）；补 `hasBackgroundWork` 连带语义（streaming∨waiting → session working 态）与枚举变更连带清单。
- v5：按 R3 对抗审查（4 must-fix / 6 suggestion，报告 `-plan-review-r3.md`）修正「sidecar 中心」系统性偏差：A9 改分路径表述（`doFinalizeRecord` 写 sidecar 仅覆盖失败/cancel/close；one-shot 成功与 chatMode 轮次完成走 `doFinalizeRoundToIdle` 无 sidecar 且删 `.alive`——成功路径靠投影级 6 子 JSONL 收尾兜住）；决策 5 投影从四级重构为**六级**（补「轮次 running entry → waiting」级，解 chatMode Path B 与孤儿同形误报 done）；补 `(status, closedReason, error) → 6 态` 完整映射表（closedReason 实测 6 值、gc 按 error 判成败）；A10 候选 b 补轮次误触发特异性（信号语义降为「状态变了」）；A10a 发起点集合扩为终态 + 轮次完成（否则 waiting 断链）；清理 v4 旧枚举值残留（§5.2/§7.2/§8）；§11 补 A10 行。
- v6：按 R4 对抗审查（2 must-fix / 6 suggestion / 4 info，报告 `-plan-review-r4.md`）修正：① 映射表 parent-* 三行确认为**不可达死行**（`disposeAllRecords` 不通知、补通知也落错 session 文件——级联关闭实际落级 6 → done/error；stopped 真实数据源 = user-close，含 closeAfterRound 兑现路径注）；② **sessionFile 解析优先级链**补入（toolResult entry `message.details.sessionFile` 第一优先——现状 extractor 只读 LLM content 恒 null 是六级投影地基缺口；shared `BgNotifyRecord` 补 `sessionFile?`；`findSubagentSessionFile` 限 startedAt 存在才匹配）；级 6 细化「子 JSONL 不存在 → streaming（start 早期保守）」修正与 §5.1 T+0s 的矛盾；③ 级 5 补冷路径窗口期「done → waiting」抖动注 + A10 探针实测项；④ `normalizeSubagentStatus` 接口裁决（组合层先按 closed 分流，normalize 返回单一类型，default 兜底 closed→error）；⑤ 协议 kind 条件增 `'changed'`；⑥ workflow 枚举边界显式化（目标 4 限定机制层 + Out-of-scope 补 workflow 枚举/视觉/paused 退役三项后续）；⑦ 补 F6 失败模式（running 语义错位）与 §8 场景 9（chatMode 等续聊验收）；⑧ 清理 v5 漏同步残留 7 处（一句话结论/§5.1/§9/§10 四级→六级、running→streaming 等）。
