---
reviewer: independent-needs
role: 需求完整性路（对齐/补齐认知帧）
date: 2026-07-08
upstream: requirements.md (verdict: pass)
---

# 需求完整性审查 — fix-state-tearing

## Verdict: APPROVED

需求核心完整：目标树（G1/G2/G3 + 子目标 G1.1/G1.2）清晰、5 个用例的主/替代/异常流程齐备、4 张 AC 表可追溯到目标、数据流图无断点、约束/不做边界明确、决策引用 decisions.md（D-001~D-007 均 confirmed，未当 gap 重报）。发现的 gap 均为**补齐性**（覆盖缺口 / 文档不一致），不阻塞进入 mid-detail-plan，但建议进入 detail 前补齐以下 2 项 K 类以避免实现返工。

**无 must_fix**：未发现目标悬空 AC、Actor 缺失、跨系统依赖错描、或推翻已确认决策的新证据。

## must_fix

无。

## should_fix

### 1. [K] UC-4 异常源 4 项 vs AC 仅 3 条 —— "WS 断连"无对应 AC
- **事实**：UC-4 Actor 标注「runtime 崩溃 / WS 断连 / 超时 / abort」四类异常源，但 AC 仅 AC-4.1(重启)/AC-4.2(超时)/AC-4.3(abort) 三条。
- **源码验证**：`useConnection.ts:133-142` 只监听 `onRuntimeRestarting` + `onRuntimeFailed`，二者都调 `resetActive()`（将改为 `finalizeSession`）。**无独立 "WS 断连" 事件**——WS 断连在当前实现里归入 runtime 重启/失败路径。
- **影响**：「WS 断连」是独立收口路径（如网络抖动但 runtime 存活）还是归并到 AC-4.1，决定了 finalizeSession 的 `disconnect` reason 是否需要独立触发条件。system-arch §5 Reason 字段已列 `disconnect` 独立 reason，与 requirements AC 缺口矛盾。
- **建议**：补 AC-4.4（WS 断连 → finalizeSession('disconnect')），或在 UC-4 显式声明「WS 断连归并到 runtime 重启路径」并同步 system-arch §5 去掉 `disconnect` reason。需澄清，非 agent 自决。

### 2. [K] pendingSend 来源 —— requirements §3 与 system-arch §4 描述不一致
- **事实**：
  - requirements §3 数据清单：`pendingSend | 来源 = useChat.send/steer`
  - system-arch §4：`pendingSend = ack→message_start 空窗期`（仅 send，接管 dispatchingSessionId）
- **源码验证**：`chat.ts` 现有两套互不相干的数据——`dispatchingSessionId`（send 空窗，line 61）与 `appendPending/removePending`（steer/followUp 队列气泡，line 153/214）。system-arch §4 降级决策明确 pendingSend 接管 dispatchingSessionId，**未声明**同时接管 steer 队列气泡。
- **影响**：若 pendingSend 合并两者，isActive 与 finalizeSession 清理需区分条目类型（send pending 在 message_start 删；steer pending 在 queue_update 删）；若不合并，requirements §3「来源=send/steer」表述误导。直接影响 system-arch §4 模型不变式与 §9 泳道图清理逻辑。
- **建议**：requirements §3 对齐 system-arch §4 —— pendingSend 仅声明为 send 空窗来源；steer 队列气泡保留 appendPending 独立描述。或反向：若设计意图是合并，system-arch §4 需扩 pendingSend 条目类型。二选一需澄清。

### 3. [D-可逆] 超时默认值 5min→24h 是对外可观测行为变更，requirements 未标 BC
- **事实**：`chat.ts:71` `STREAMING_TIMEOUT_MS = 300_000`（5min）。requirements §7 写「默认 24h（D-003）」。用户可观测差异：原 5min 无 message.complete 时 force-reset（弹错误）；新 24h 实质不触发。
- **上游对照**：system-arch §12 BC-3 已标此行为变更（`[CONFLICT]`），requirements §7/§8 未标 BC，文档层级不一致。
- **建议**：requirements §8「不做」上方补一行 BC 表（或 §7 约束内标注），与 system-arch BC-3 对齐，避免 mid-detail-plan NFR 漏标回归基线。agent 可自决补齐。

## nit

### 1. shared/protocol.ts 未在 §6 系统间关联列出
§4 F3 已提「send.rejected 独立通道」，但 §6「系统间功能关联」只列 pi 子进程 / runtime↔renderer 两行，未把 shared 层 WS 契约扩展作为独立关联行。system-arch §7 已把 protocol.ts 列为改动模块。文档完整性可补，非功能遗漏。

### 2. AC-3.2 reason 表述混合 toolCall status 与 message reason
AC-3.2「实体收口为 error/end_not_received」—— `error` 是 Message.status，`end_not_received` 是 ToolCall.status（system-arch §5）同时也是 Message reason。AC 把实体 status 与收口 reason 混排，略有歧义。建议拆为「message→error(reason=timeout)；关联 toolCall→end_not_received」。

### 3. G3 成功标准合并了两个不同层的现象
G3 成功标准「不被静默丢弃或误报错误」合并了：前端 `useChat.send` 在 isActive 时 `return`（静默丢弃，`useChat.ts:117`）与 runtime `message-dispatcher.ts:97` prompt 失败广播 message.error（误报错误）。两者消费方/修复点不同（前端路由 vs runtime 通道分离），分述更精确。非阻塞性。
