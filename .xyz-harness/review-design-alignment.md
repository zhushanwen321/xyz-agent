# 设计文档一致性对抗式审查报告

> **审查范围**：`git diff main...HEAD`（75 文件，+10839/-303 行）对照 `extensions/subagent-workflow/docs/design/v3-unified-lifecycle-model.md`
> **审查日期**：2026-08-13
> **审查方法**：逐 SP 对照设计要求 → 代码实现，检查遗漏/偏差/scope creep

---

## 一致性评分：82%

实现整体架构忠实度高——三层模型分离、L1 状态机重构、EPIPE 兜底、跨重启恢复、before_agent_start 注入、one-shot upgrade、资源策略配置化、turn-limiter reset 均正确实现。主要偏差集中在：ClosedReason 枚举层级标签错误（L2 vs L3）、fork/new 级联关闭未接线、bg-notify-render 状态守卫遗漏 idle。

---

## 逐 SP 对照审查

### SP-1: L1/L2 状态机重构

#### [DEVIATION-01] L1 状态机保留了 idle 和 cancelled
- **SP 编号**：SP-1
- **设计要求**：§3.3 L1 定义「L1 只有 active/closed 两态」，idle/done/failed/crashed 全部删除
- **实际实现**：`ExecutionStatus = "running" | "idle" | "cancelled" | "closed"` — 四态
- **偏差描述**：设计原文要求 L1 = active + closed（带 reason），实现保留了 idle 和 cancelled 作为独立 L1 状态
- **设计文档自身修正**：§3.3 L1 的「实现修订 2026-08-13」**显式承认并合理化了此偏离**——idle 承担「轮次完成、进程已回收、等待续聊」语义，cancelled 作为独立终态。功能等价性已论证
- **严重度**：**INFO**（设计已修订，实现合理）

#### [DEVIATION-02] ClosedReason 枚举层级标签错误（L2 vs L3）
- **SP 编号**：SP-1
- **设计要求**：§3.3 L1 明确标注 `ClosedReason` 是「**L2 关闭原因子枚举**」（"closed = 统一终态...具体关闭原因由 ClosedReason 子枚举表达"）；§2.3 R1 将「record 逻辑态 vs 进程物理态」纠缠归为 L1/L2 不分，本方案要用 L2 解耦
- **实际实现**：`ClosedReason = 'parent-shutdown' | 'parent-fork' | 'parent-new' | 'user-close' | 'cancelled' | 'gc'` — 这些值是 **L3（归属与恢复）** 的关注点（父事件触发的关闭原因），不是 L2（进程物理态：exit/kill/EOF/OOM）
- **偏差描述**：设计说 ClosedReason 是 L2（进程物理死因），但枚举值实际描述 L3（父子联动触发原因）。真正的 L2 死因应该是 `exit | kill | eof | timeout | crash` 之类的值。当前实现把 L2/L3 合并进了同一个字段，语义层级混乱
- **严重度**：**SUGGESTION**（不影响功能正确性，但与三层模型的分层理念不一致；若未来需要按进程物理死因做策略（如 timeout 需特殊处理），需拆分）

#### [DEVIATION-03] ClosedReason 枚举不完整
- **SP 编号**：SP-1
- **设计要求**：§3.3 L1 state diagram + §3.1 场景定义的 closed.reason 包含：`completed / error / cancelled / timeout / parent_closed / fork_cascade / new_cascade / idle_expired / manual`（9 种）
- **实际实现**：6 种：`parent-shutdown / parent-fork / parent-new / user-close / cancelled / gc`
- **偏差描述**：
  - `completed` → 合并进 `user-close`（成功完成）— 合理
  - `error` / `timeout` / `idle_expired` → 合并进 `gc`（通用完成/失败）— 丢失粒度
  - `parent_closed` → `parent-shutdown` — 命名不同但语义一致
  - `fork_cascade` / `new_cascade` → `parent-fork` / `parent-new` — 命名不同但语义一致
  - `manual` → 合并进 `user-close` — 合理
  - **缺失**：`timeout`（idle timer 超时回收）和 `idle_expired`（30天 TTL 过期）的区分被 `gc` 吞掉，未来若需按关闭原因做差异化策略（如 timeout 不应计入失败统计），需扩展
- **严重度**：**SUGGESTION**（`gc` 作为兜底合理，但监控/统计场景可能需要更细粒度）

#### [DEVIATION-04] EPIPE 兜底实现完整且正确
- **SP 编号**：SP-1（D12）
- **设计要求**：热路径 stdin 写捕获 EPIPE → 进程按 dead 处理 → 自动冷路径 resume + 重放原消息；连续 2 次失败才报错
- **实际实现**：
  - `writeStdinLine`：try/catch 捕获 `EPIPE` 和 `ERR_STREAM_DESTROYED`（后者是同一类管道断开错误的 Node.js 新 error code，合理扩展）
  - `deliverMessage` 热路径：catch EPIPE → 清理 spawnedChildren → 递增计数 → ≥2 次 throw → 冷路径 resumeRound
  - 计数器 `epipeConsecutiveFailures` 用 Map<recordId, count> 管理，成功写入时清零
- **偏差描述**：实现覆盖了设计要求的所有路径。额外捕获 `ERR_STREAM_DESTROYED` 是合理增强（同根因）
- **严重度**：**INFO**（正确实现）

#### [DEVIATION-05] activation 互斥 = 双保险（idle CAS + acquireActivateLock）
- **SP 编号**：SP-1（D3）
- **设计要求**：§3.3 D3 要求 `acquireActivateLock` 替代 idle 守卫 CAS 作为唯一互斥机制
- **实际实现**：保留了 idle→running CAS（`record.status !== "idle"` 守卫在 `resumeRound`），同时锁已接入冷路径 `deliverMessage`。设计的「实现修订 2026-08-13」显式承认双保险策略
- **偏差描述**：设计自身修订为「双保险」，与实现一致
- **严重度**：**INFO**（设计已修订）

#### [DEVIATION-06] pendingMessages 消费确认制（MF-5）— 设计外增量
- **SP 编号**：SP-1
- **设计要求**：设计未在 SP-1 中定义 pendingMessages 消费确认制（这是 V2 设计决策 6 的内容）
- **实际实现**：完整实现了 `PendingMessage` 类型 + `deliverToRunning` 入队 + `message_start(user)` FIFO shift 清除 + `doFinalizeRoundToIdle` redeliverPending 补投
- **偏差描述**：实现超出了 SP-1 的明确范围，但属于 V2 设计决策 6 的配套实现。非 scope creep（是必要的配套机制）
- **严重度**：**INFO**（合理增量）

---

### SP-2: 跨重启恢复

#### [DEVIATION-07] reconstructAll 兜底分支正确映射为 idle
- **SP 编号**：SP-2
- **设计要求**：分支 4 兜底（无 marker、pid 死）→ **idle**（不再 crashed），idle record 经 resumeRound 冷路径可恢复
- **实际实现**：`record-store.ts` 分支 4 → `markReconstructedStatus(rec, "idle")`，endedAt 保持 undefined
- **偏差描述**：完全匹配设计
- **严重度**：**INFO**（正确实现）

#### [DEVIATION-08] getRecordForAction 跨重启恢复逻辑正确
- **SP 编号**：SP-2
- **设计要求**：内存未命中时从磁盘 collectRecords 重建 idle record → register 进内存供续操作
- **实际实现**：`getRecordForAction` 在 `!record` 时调 `store.collectRecords(1000, "all").find(r => r.id === id && r.status === "idle")` → `createRecord` → 设 `chatMode: true` + `status: "idle"` → `store.register`
- **偏差描述**：完全匹配设计
- **严重度**：**INFO**（正确实现）

#### [DEVIATION-09] reconstructFromFile 未透传 chatMode
- **SP 编号**：SP-2
- **设计要求**：ReconstructedRecord 接口定义了 `chatMode?: boolean`（来自 identity entry）
- **实际实现**：`reconstructFromFile` 的 return 对象未包含 `chatMode`——identity 数据有 `chatMode` 字段，但返回时未展开。`recordToSubagent` 的 `SubagentRecord` 也没有 `chatMode` 字段
- **偏差描述**：`getRecordForAction` 的磁盘重建路径硬编码 `chatMode: true`（因为只有 chatMode record 会是 idle），所以功能不受影响。但 `reconstructFromFile` 不返回 `chatMode` 意味着 list 场景无法区分 chatMode 和非 chatMode 的 idle record（如果有未来场景需要的话）
- **严重度**：**INFO**（当前功能不受影响，`getRecordForAction` 兜底）

---

### SP-3: before_agent_start 状态注入

#### [DEVIATION-10] before_agent_start hook 实现完整
- **SP 编号**：SP-3
- **设计要求**：注册 before_agent_start hook → 有活跃 subagent 时注入 customType:"subagent-status" 快照 → 无活跃时不注入 → 最多 10 条截断 → 级联关闭告知（D6 注入条件扩展）
- **实际实现**：
  - `pi.on("before_agent_start", ...)` 在 `index.ts` 正确注册
  - `formatSubagentStatusSnapshot` 格式化活跃 record 列表
  - `MAX_STATUS_INJECTION = 10` 成本控制
  - `recentlyCascaded` 检查 + 注入后清空
  - 注入条件 = `activeRecords.length > 0 || cascaded.length > 0`（符合 D5 扩展条件）
  - 返回 `{ message: { customType: "subagent-status", content, display: true } }`
- **偏差描述**：实现完整覆盖设计要求
- **严重度**：**INFO**（正确实现）

#### [DEVIATION-11] display 字段硬编码为 true
- **SP 编号**：SP-3
- **设计要求**：§3.1 场景 D 描述注入消息为「display 可选」
- **实际实现**：`display: true` 硬编码
- **偏差描述**：设计说「display 可选」暗示应可配置，但实现固定为 true。对于「告知主 agent 有哪些活跃 subagent」的场景，display=true 是合理默认（让消息出现在对话流中）
- **严重度**：**SUGGESTION**（当前行为合理，未来可能需要静默注入场景）

---

### SP-4: 父子联动矩阵落地

#### [DEVIATION-12] onParentFork / onParentNew 未接线（CRITICAL）
- **SP 编号**：SP-4
- **设计要求**：§3.4 D6「pi 的 /fork /new 路径触发 session_shutdown→dispose」→ 本决策增量是 dispose 时主动写 closed{reason} + 告知消息机制
- **实际实现**：
  - `SubagentService.onParentFork()` 和 `onParentNew()` 方法已定义
  - `disposeAllRecords(reason)` 级联关闭逻辑已实现
  - `recentlyCascaded` 收集 + 60s 超时清理已实现
  - **但这两个方法未在任何入口点调用**——`index.ts` 的 `session_shutdown` hook 和 `session_start` hook 均未调用 `onParentFork()` / `onParentNew()`
  - grep 确认：仅在 subagent-service.ts 定义 + parent-child-matrix.test.ts 测试中使用
- **偏差描述**：级联关闭的**机制已实现**但**接线缺失**。设计预期 fork/new 时主动关闭旧 subagent 并写 closed{reason:"parent-fork"}，但实际 fork/new 时旧 record 仍走旧路径（子进程 EOF 自杀 → reconstructAll 兜底 → idle），不会收到 reason 标记
- **严重度**：**MUST_FIX**（SP-4 核心功能未激活。一期后中间态设计文档已定义此场景为「可接受的退化」（§5.1.1），但二期需要接线。若当前是一期交付，此为已知 gap；若期望完整 SP-4，需接线）

#### [DEVIATION-13] dispose 路径的 worktree 清理
- **SP 编号**：SP-4（D10）
- **设计要求**：record 进入 closed 时触发 worktree cleanup，覆盖 dispose 与 fork/new 级联关闭路径
- **实际实现**：`disposeAllRecords` 方法内对 `record.worktreeHandle` 调用 `worktreeManager.cleanup`
- **偏差描述**：实现正确，但因 `onParentFork`/`onParentNew` 未接线，只有 `dispose("parent-shutdown")` 路径会走到 worktree 清理
- **严重度**：**INFO**（机制正确，受 DEVIATION-12 接线问题影响）

---

### SP-5: one-shot upgrade

#### [DEVIATION-14] upgrade 使用 Object.assign 绕过 readonly
- **SP 编号**：SP-5
- **设计要求**：§3.3 L1「SP-5 实施时删除该守卫并替换为 upgrade 逻辑——删除动作本身即为 SP-5 的显式边界声明」
- **实际实现**：`subagent-actions.ts` messageHandler 中：
  ```ts
  if (!record.chatMode && (record.status === "running" || record.status === "idle")) {
    Object.assign(record, { chatMode: true });
  }
  ```
- **偏差描述**：`chatMode` 在 `ExecutionRecord` 接口中定义为 `readonly chatMode?: boolean`。使用 `Object.assign` 绕过 readonly 约束实现 upgrade 语义。这在运行时正确，但 TypeScript 类型系统无法验证此赋值的安全性。设计的「编译期 fence」概念在此被绕过——`Object.assign` 不会产生编译期保护
- **严重度**：**SUGGESTION**（功能正确，但类型安全性降低。可考虑将 chatMode 改为非 readonly，或提供 upgrade 方法）

#### [DEVIATION-15] upgrade 归档时机未调整
- **SP 编号**：SP-5
- **设计要求**：§3.3 L1 边界契约「SP-5 落地时才放开：one-shot 完成 → 不立即归档（保持 active）+ message 触发 upgrade」
- **实际实现**：`runAndFinalize` 的 one-shot 完成路径仍保留 `if (!record.chatMode) { ... finalizeRecord ... }` 分支——one-shot 完成仍立即归档。upgrade 只在 message 时发生（对已归档的 record，getRecordForAction 会 throw not found）
- **偏差描述**：设计要求 SP-5 时删除编译期 fence（`!record.chatMode` 守卫），让 one-shot 完成后不立即归档。实现保留了守卫。这意味着 one-shot 完成后无法 message 续聊（record 已归档），upgrade 路径实际上不可达（归档的 record 被 getRecordForAction 的 not found 拦截）
- **严重度**：**MUST_FIX**（SP-5 的核心目标——one-shot 完成后续聊——在当前实现中不可达。one-shot 完成仍走 archive 路径，message 到已归档 record 会 throw。需要删除 `!record.chatMode` 守卫，让 one-shot 完成保持 active 状态）

#### [DEVIATION-16] chatMode=true 后崩溃的 identity 持久化
- **SP 编号**：SP-5
- **设计要求**：§5.1 SP-5 探针「upgrade 置 chatMode 后、子进程重写 identity 前主进程崩溃 → 重启后磁盘 identity 仍 false、upgrade 状态丢失」
- **实际实现**：`Object.assign(record, { chatMode: true })` 只修改内存 record。子进程 session_start 的 identity entry 写入发生在 spawn 时（不是 upgrade 时）。如果 upgrade 后、下次 spawn 前进程崩溃，磁盘 identity 仍为 chatMode=false
- **偏差描述**：设计已识别此竞态并建议「记录内存态，重启后凭 lastResult 重放或接受丢失」。实现**未做任何持久化补偿**——接受丢失。这意味着升级后的 chatMode 状态在崩溃后不可恢复
- **严重度**：**INFO**（设计已识别并接受此风险，实现选择接受丢失是合理的——下次 message 会再次 upgrade）

---

### SP-6: 资源策略配置化

#### [DEVIATION-17] idleTimeoutMs 透传链完整
- **SP 编号**：SP-6
- **设计要求**：timeoutMs 从 start 参数透传 + env 默认覆盖 + 默认 5min
- **实际实现**：
  - `ExecuteOptions.idleTimeoutMs` → `createRecord` → `record.idleTimeoutMs`
  - `session-runner.ts` agent_settled handler 调 `armIdleTimer(record.id, ..., record.idleTimeoutMs)`
  - `lifecycle-manager.ts` 优先级：参数 > env PI_SUBAGENT_IDLE_TIMEOUT_MS > 默认 300000ms
- **偏差描述**：完整覆盖设计的三级优先级
- **严重度**：**INFO**（正确实现）

#### [DEVIATION-18] idleTimeoutMs 未持久化到 manifest
- **SP 编号**：SP-6
- **设计要求**：record.idleTimeoutMs 应在跨重启后仍有效
- **实际实现**：`ManifestRecord` 接口未包含 `idleTimeoutMs` 字段，manifest 写入时不持久化
- **偏差描述**：跨重启后 record 重建时 `idleTimeoutMs` 为 undefined，下次 armIdleTimer 会使用 env/默认值而非原始参数值。对大部分场景（使用默认 5min）无影响，但自定义 timeout 的 record 跨重启后会回退到默认值
- **严重度**：**SUGGESTION**（低频场景，自定义 timeout 用户可能不期望回退）

#### [DEVIATION-19] conversation 场景描述完整
- **SP 编号**：SP-6
- **设计要求**：conversation 场景化 description（正反清单）
- **实际实现**：`subagent-tool.ts` 的 conversation 参数 description 包含：
  - ✅ 适用场景：multi-round collaboration、follow-up expected
  - ❌ 不适用场景：one-shot tasks
  - 成本提示 + idleTimeoutMs 说明
- **偏差描述**：覆盖了设计要求的正反清单
- **严重度**：**INFO**（正确实现）

---

### SP-7: 孤儿收割增强（deferred）

- **设计要求**：deferred，spawn 改 detach 时激活
- **实际实现**：未实现（符合 deferred 预期）
- **严重度**：**INFO**（按设计 deferred）

---

### SP-8: 嵌套可见性修复

- **设计要求**：承接 recursive-subagent-visibility.md 独立设计
- **实际实现**：未在本次 diff 中（独立子方案，预期外）
- **严重度**：**INFO**（设计明确独立）

---

### SP-9: turn-limiter chatMode 语义

#### [DEVIATION-20] turn-limiter reset 实现正确
- **SP 编号**：SP-9
- **设计要求**：chatMode 下 maxTurns 按「每轮 reset」，graceTurns 同
- **实际实现**：
  - `TurnLimiter.reset()` 方法清除 steered/aborted 标志
  - `session-runner.ts` agent_settled handler 调 `limiter.reset()` + `record.turnCount = 0`
- **偏差描述**：完全匹配设计
- **严重度**：**INFO**（正确实现）

---

## 跨 SP / 架构级偏差

#### [DEVIATION-21] bg-notify-render 未接受 idle 状态（BUG）
- **SP 编号**：跨 SP-1/SP-3
- **设计要求**：notifier 应正确发送 idle 通知（对话模式轮次完成）
- **实际实现**：
  - `notifier.ts` 的 `BgNotifyRecord.status` 包含 `"idle"` — 正确
  - `bg-notify-render.ts` 的 `extractBgNotifyRecord` 守卫：`status !== "closed" && status !== "cancelled"` — **不接受 "idle"**
  - 结果：对话模式轮次完成的通知被 `bg-notify-render` 静默丢弃（返回 undefined），CLI/TUI 不显示 idle 通知
- **严重度**：**MUST_FIX**（对话模式轮次完成的通知在 CLI/TUI 渲染层被丢弃。用户看不到 subagent 完成了一轮的反馈）

#### [DEVIATION-22] process 级 shutdown hook 实现正确
- **SP 编号**：SP-1（D12 防线 i）
- **设计要求**：process.on("SIGTERM"/SIGINT"/beforeExit") 兜底 killAllSpawnedChildren
- **实际实现**：`index.ts` 注册三个 process 事件 + `reapSpawnedChildrenOnShutdown` + 幂等 guard
- **偏差描述**：正确实现设计的防线 i
- **严重度**：**INFO**（正确实现）

#### [DEVIATION-23] spawnedChildren 从 Set 升级为 Map
- **SP 编号**：SP-1
- **设计要求**：（隐式）busy 投递需要按 recordId 定位活进程
- **实际实现**：`spawnedChildren = new Map<string, ChildProcess>()`（key=record.id）+ `getChildByRecord(recordId)` 查询入口
- **偏差描述**：必要重构，支撑 deliverToRunning 热路径
- **严重度**：**INFO**（正确实现）

#### [DEVIATION-24] ExternalState 四态映射 + SubagentListItem 扩展
- **SP 编号**：SP-1
- **设计要求**：（隐式）对外状态语义需要与内部 L1 状态解耦
- **实际实现**：
  - `ExternalState = "active" | "waiting" | "ended" | "error"`
  - `mapExternalState()` 映射：running→active, idle→waiting, cancelled→ended, closed→ended
  - `SubagentListItem` 新增 `state: ExternalState` 字段
- **偏差描述**：设计的「决策 10 细则 3」要求。实现正确
- **严重度**：**INFO**（正确实现）

---

## 偏差汇总表

| # | SP | 偏差 | 严重度 |
|---|---|---|---|
| 01 | SP-1 | L1 保留 idle/cancelled（设计已修订承认） | INFO |
| 02 | SP-1 | ClosedReason 值是 L3 而非 L2（层级标签错误） | SUGGESTION |
| 03 | SP-1 | ClosedReason 枚举不完整（timeout/idle_expired 被 gc 吞） | SUGGESTION |
| 04 | SP-1 | EPIPE 兜底正确实现 | INFO |
| 05 | SP-1 | activation 互斥双保险（设计已修订） | INFO |
| 06 | SP-1 | pendingMessages 消费确认制（合理增量） | INFO |
| 07 | SP-2 | reconstructAll 兜底→idle 正确 | INFO |
| 08 | SP-2 | getRecordForAction 跨重启恢复正确 | INFO |
| 09 | SP-2 | reconstructFromFile 未透传 chatMode | INFO |
| 10 | SP-3 | before_agent_start hook 完整实现 | INFO |
| 11 | SP-3 | display 硬编码 true（设计说可选） | SUGGESTION |
| 12 | **SP-4** | **onParentFork/onParentNew 未接线** | **MUST_FIX** |
| 13 | SP-4 | dispose 路径 worktree 清理正确 | INFO |
| 14 | SP-5 | upgrade 用 Object.assign 绕 readonly | SUGGESTION |
| 15 | **SP-5** | **归档时机守卫未删除（upgrade 不可达）** | **MUST_FIX** |
| 16 | SP-5 | upgrade 后崩溃 identity 丢失（接受） | INFO |
| 17 | SP-6 | idleTimeoutMs 透传完整 | INFO |
| 18 | SP-6 | idleTimeoutMs 未持久化 manifest | SUGGESTION |
| 19 | SP-6 | conversation 场景描述完整 | INFO |
| 20 | SP-9 | turn-limiter reset 正确实现 | INFO |
| 21 | **跨 SP** | **bg-notify-render 未接受 idle 状态** | **MUST_FIX** |
| 22 | SP-1 | process shutdown hook 正确 | INFO |
| 23 | SP-1 | spawnedChildren Map 升级正确 | INFO |
| 24 | SP-1 | ExternalState 四态映射正确 | INFO |

---

## MUST_FIX 清单（3 项）

1. **DEVIATION-12：onParentFork/onParentNew 未接线**
   - `SubagentService.onParentFork()` 和 `onParentNew()` 已实现但未在 `index.ts` 的 session_shutdown / session_start hook 中调用
   - 修复：在 pi session tree event（fork）或相关 hook 中调用 `service.onParentFork()`
   - 一期后中间态已定义此为「可接受退化」，但二期必须接线

2. **DEVIATION-15：one-shot 完成归档守卫未删除**
   - `runAndFinalize` 中 `if (!record.chatMode)` 守卫仍然存在，one-shot 完成后立即归档
   - SP-5 的核心目标（one-shot 完成后 message 续聊）因归档而不可达
   - 修复：删除 `!record.chatMode` 守卫，让 one-shot 完成保持 active 状态（SP-5 边界契约）

3. **DEVIATION-21：bg-notify-render 不接受 idle 状态**
   - `extractBgNotifyRecord` 守卫只允许 `closed` 和 `cancelled`，reject `idle`
   - 对话模式轮次完成的通知在 CLI/TUI 渲染层被静默丢弃
   - 修复：`bg-notify-render.ts` 的 status 守卫增加 `"idle"` 以及对应的渲染逻辑

---

## SUGGESTION 清单（5 项）

1. **DEVIATION-02**：ClosedReason 层级标签——考虑拆分 L2（进程物理死因）和 L3（父子联动触发原因）
2. **DEVIATION-03**：ClosedReason 枚举——考虑增加 `timeout` / `idle_expired` 用于监控统计
3. **DEVIATION-11**：display 字段——考虑支持可配置（静默注入场景）
4. **DEVIATION-14**：chatMode upgrade——考虑将 chatMode 改为非 readonly 或提供 upgrade 方法
5. **DEVIATION-18**：idleTimeoutMs 持久化——考虑写入 manifest 供跨重启恢复

---

## 结论

实现对设计文档的整体忠实度为 **82%**。核心架构（三层模型分离、L1 状态机、EPIPE 兜底、跨重启恢复、before_agent_start 注入、资源策略配置化、turn-limiter reset）均正确实现。3 项 MUST_FIX 偏差中，2 项是 SP-4/SP-5 的接线/守卫删除问题（二期工作），1 项是渲染层状态守卫遗漏（bg-notify-render）。SUGGESTION 级偏差主要集中在 ClosedReason 的层级语义和枚举完整性，不影响功能正确性。
