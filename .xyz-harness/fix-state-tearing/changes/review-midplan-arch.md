---
reviewer: independent-arch
role: 架构合理性 + 边界路（对齐/补齐认知帧）
date: 2026-07-08
upstream: system-architecture.md (verdict: pass)
isolation: 与主 agent / redteam / reconstruct / needs 组隔离
---

# 架构合理性审查 — fix-state-tearing system-architecture.md

> 审查帧：模型完整性 / 状态正交性 / 分层纪律 / 依赖边界 / 变化轴 / 行为契约 / 反模式 AC。
> 纪律：D-001~D-007（decisions.md status=confirmed）不当 gap 重报；reconstruct/redteam/needs 已报项只佐证不重发，聚焦架构独有的新发现。

## Verdict

**CHANGES_REQUESTED**

主体方向（派生模型 + finalizeSession 统一收口 + pendingSend 接管空窗 + send.rejected 正交通道）与源码暴露的撕裂根因高度吻合，分层判断正确（三层足够、无伪 port），依赖注入模式无循环依赖。但有 **1 个 must_fix**（isGenerating 模型数学不自洽——per-session 签名缺失导致 isActive 公式无解）和 **5 个 should_fix**，其中 2 个会在 dev 阶段产生行为偏差（abort 终态映射变更未标 BC、finalizeSession 缺 sealed 不变式）。修订后可进入 mid-detail-plan。

---

## must_fix

### MF-1 [F] isGenerating 模型自相矛盾——per-session 签名缺失，isActive(sid) 公式数学无解

**对象**：§4 核心模型表 isGenerating 行 + isActive 行；§3 术语表

**事实（源码可证伪）**：
- §4 isGenerating：`≡ ∃ message.status=streaming（不含 pendingSend）`——**无 sid 参数**，读作全局单值
- §4 isActive：`≡ isGenerating ∨ pendingSend.has(sid)`——pendingSend 是 per-sid，isGenerating 无 sid
- 若 isGenerating 是全局单值：`isActive(sid) = (任意 session 有 streaming) ∨ pendingSend.has(sid)` → A 会话流式时，B 会话 `isActive(B)` 恒 true。这正是源码 `streamingSessionId` 注释（chat.ts:42-50）明确警告的跨 session 误伤：「不能用全局 isStreaming——否则 A 会话流式时切到空 session，空 session Landing 会被全局 isStreaming 误伤」。
- 若 isGenerating 是 per-sid：§4 模型表行未标 `isGenerating(sid): boolean`，isActive 公式应写 `isGenerating(sid) ∨ pendingSend.has(sid)`，当前缺 `(sid)`。

**架构判定**：§4 两行公式**数学不自洽**——一个无 sid 的量与一个 per-sid 的量做析取，结果语义未定义。这不是实现细节，是模型定义层的缺陷。无论 dev 阶段怎么实现都会二选一踩坑：全局 → 跨 session 误伤（重蹈源码已修过的 bug）；per-sid → 与文档公式不符。

**证伪**：
- 删（去掉 isGenerating，只用 isActive）：isActive 失去「纯派生态」语义，Composer 守卫直接调 isActive(sid) 内部仍需 scan——只是把命名内联，复杂度不塌缩也不增。但失去「生成态 vs 活跃态」的正交分解（停止按钮看 isActive，Panel 渲染守卫看 isGenerating），两个概念合并后调用方需自行判断，归位变差。不删。
- 翻（isGenerating 从 per-sid 翻全局）：翻全局即跨 session 误伤，源码已有前车之鉴。不可翻。

**建议**：§4 模型表 isGenerating 行改为 `isGenerating(sid): boolean ≡ ∃ m ∈ messages[sid], m.status='streaming'`；isActive 行改为 `isActive(sid) ≡ isGenerating(sid) ∨ pendingSend.has(sid)`。同步 §3 术语表。并在 §10 D-1 补一句「scan 范围限定 `messages.value.get(sid)`（per-session），避免跨 session 响应式失效扩散」。

> 注：reconstruct M3 从「签名缺失」角度报过同类问题。本条从**模型自洽性**（两行公式数学矛盾）角度强化——这是 must_fix 而非 should_fix，因为公式无解会导致任意实现都偏离文档。

---

## should_fix

### SF-1 [F] abort 终态映射：§5「abort→error」与现行「abort→complete」冲突，BC-2 行为等价断言不成立

**对象**：§5 状态流转 + §12 BC-2

**事实（源码可证伪）**：
- 现行 abort 收口路径：`message-dispatcher.abort()`（line 159-162）广播 `message.complete{stopReason:'aborted'}`；effects `message.complete` handler（chat-message-effects.ts）中 `isErrorStop = stopReason === 'error'`，`'aborted' !== 'error'` → `status: 'complete'`。**即现行 abort 消息终态是 `complete`。**
- §5 原文：「所有异常路径（超时/断连/abort）统一映射为 `streaming → error`（reason 区分）」——**abort 映射到 error**。
- §5 state diagram：`streaming --> complete: message.complete(agent_end)` / `streaming --> error: message.error / finalizeSession(reason)`——abort 走 finalizeSession→error 弧。
- §12 BC-2：「abort 改调 finalizeSession，但外部行为等价：isGenerating→false + 实体收口」——声称等价。

**矛盾**：§5 把 abort 映射 error，现行映射 complete。message.status 从 `complete`→`error` 是**用户可观测变更**（error 态可能有红框/error icon/重试入口等 UI 差异）。BC-2 声称「外部行为等价」**不成立**——除非 finalizeSession('abort') 显式产出 `complete` 而非 `error`。

**架构判定**：这是 refactor 模式下的**隐性行为变更**，必须二选一显式化：
- (a) finalizeSession 保留 abort→complete（与现行一致），§5 修正「abort 不属于异常→error 映射，保留 complete(reason=aborted)」；或
- (b) 确认 abort→error 是有意改进（aborted 消息本就不完整，标 error 更诚实），则 §12 新增 BC-6 显式标注此变更 + `[CONFLICT]`。

**建议**：不替作者决定（a/b 各有理），但必须消除 §5 与 BC-2 的矛盾。倾向 (a)：refactor 应保持现行 complete 语义，语义改进另开 ticket。

### SF-2 [F] finalizeSession 缺「sealed 不变式」——收口后晚到流式事件无防护

**对象**：§4 Message 不变式 + §5 状态流转 + §9 泳道图

**事实（源码可证伪）**：`message.text_delta` handler（chat-message-effects.ts）用 `findLastAssistantIndex` 定位消息后**不检查 status**，直接 `content + delta`。同理 `thinking_delta` / `tool_call_update`。

**场景**：finalizeSession('abort')→ 实体推 `error` → pi 未真正停止，晚到 `text_delta` → handler 向 `error` 消息追加文本 → **终态实体被突变，状态机被破坏**。§5 声称「终态不可逆」，但无执行层保证。

**架构判定**：§5 定义了不可逆性（约束），但未定义**执行机制**——finalizeSession 后该 session 的 streaming 事件（text_delta/thinking_*/tool_call_*）应被丢弃或幂等 no-op。这是状态机完整性的必要不变式，不是实现细节。当前源码无此防护（因为当前 finalizeSession 不存在，streamingTimer 只翻 flag 不碰实体，所以晚到事件追加到仍 streaming 的实体反而"一致"）。派生模型引入 finalizeSession 后，这个缺口才暴露。

**证伪（翻）**：finalizeSession 能反转吗？消息级不可逆（同一 message 不能 un-finalize）。但**晚到事件能间接"污染"终态实体**——这不是反转状态机，是绕过状态机。sealed 不变式堵的就是这个绕过。

**建议**：§4 Message 不变式补一行「finalizeSession 后，该 session 对后续 streaming 事件（text_delta/thinking_delta/tool_call_*）幂等丢弃（handler 检查 last assistant status≠streaming 则 return）」；或声明 runtime/event-interpreter 保证 finalize 后无事件（但 abort 与 agent_end 竞争使其不可保证）。前者更可靠。

### SF-3 [F] AC-4「already processing」检测机制未定义——边界契约空洞

**对象**：§8 系统间上下文边界 + §11 AC-4 + §7 message-dispatcher 模块

**事实（源码可证伪）**：
- 全代码库 `grep -rn "already processing" packages/` **零命中**。该错误来自 pi prompt RPC（agent 忙时调 prompt 的拒绝）。
- message-dispatcher `sendPrompt`（line 89-99）：`client.prompt()` 失败时广播 `message.error`。**当前无分类逻辑**区分「already processing（忙时发送）」vs「真实 prompt 错误（pi 内部异常）」。
- §7/§8/AC-4 预设 message-dispatcher 能把 already processing 路由到 send.rejected，但**未定义检测契约**：靠 pi 错误消息字符串匹配？靠 error code？靠先检查 `activeSession.isGenerating` 再发 prompt？

**架构判定**：这是一个**跨进程边界契约空洞**。send.rejected 的触发条件（pi 返回什么形状的错误时路由）是 §8 边界交互的核心契约，不能留到 dev 阶段猜。若靠字符串匹配 pi 的 error message，pi 升级改文案即断；若靠 runtime 侧 `activeSession.isGenerating` 预检（发 prompt 前先查忙），则 send.rejected 是 runtime 自产而非 pi 拒绝翻译——两种路径的契约归属完全不同。

**建议**：§8 补 send.rejected 触发契约。推荐 runtime 预检方案（message-dispatcher sendPrompt 入口检查 `activeSession.isGenerating`，忙则直接广播 send.rejected 不调 pi.prompt）——比靠 pi 错误字符串匹配更可靠，且不依赖 pi 协议细节。AC-4 的 grep 验收也要相应调整（验 send.rejected 广播 + 验无 message.error 广播在 already-processing 分支）。

### SF-4 [F] AC-3 路径清单不完整——「四条路径」漏 message.error / stream_error 事件驱动终态

**对象**：§11 AC-3

**事实（源码可证伪）**：effects 注册表有**三条**独立调 `setStreaming(false)` 的终态 handler：
1. `message.complete`（agent_end / abort 广播）
2. `message.error`（pi 流错误，chat-message-effects.ts message.error handler）
3. `message.stream_error`（pi `message_update{error}` 不发 agent_end 的场景，handler 注释 FR-5）

AC-3 原文：「finalizeSession 覆盖超时/断连/重启/abort **四条路径**」——只含异常源（timeout/disconnect/restart/abort），**漏了 message.error 和 message.stream_error 两条事件驱动终态**。这两条是 effects 层最高频的收口路径（每次 pi 报流错误都走），漏标的后果：effects 改造时这两个 handler 的 `setStreaming→finalizeSession` 迁移被遗漏，实体不收口 → isGenerating 派生仍 true。

**架构判定**：AC-3 是验收门，路径清单不全 = 验收放行漏路径。且 §5 Reason 字段列了 7 种 reason（normal/stream_error/timeout/disconnect/restart/abort/end_not_received），AC-3 只覆盖其中 4 种，文档内部不一致。

**建议**：AC-3 路径清单补 `message.error` / `message.stream_error`；同时补 useConnection 的 resetActive 调用迁移指引（reconstruct MM1 已报，佐证）。

### SF-5 [F] D-1 computed scan 论证不精确——流式期间失效频率被低估

**对象**：§10 D-1（对应 D-005，confirmed，不推翻决策只修论证）

**事实**：D-1 称「access 时才重算，非每事件全量遍历」+「典型 <1000 条 scan 微秒级」。

**实际**：流式期间 `text_delta` ~20 次/秒，每次 `messages.value.set(sid, next)` 触发 Map 响应式 → computed 失效 → 下次 access（Composer 渲染读 isActive）重算。即流式期间**每个 delta 都触发一次 scan**，非「access 才重算」的惰性优势场景。D-1 的措辞暗示 computed 有缓存红利，但流式恰恰是高频失效场景。

**架构判定**：D-005 决策**正确**（证伪「挪」：换增量 Set = 重新引入手动维护 = 原始 bug 类复发，复杂度归位失败）。但论证链条应修正为真实理由：scan O(n) 但 n<1000 且 `.some()` 短电路，重算频率=delta 频率（~20/s × 1000 = 2万次/s 仍微秒级），**核心收益是消除全部写路径维护 bug，O(n) 读是可接受的代价**。当前措辞「access 才重算」会误导 dev 以为有缓存红利而忽略 scan scope 设计。

**关联**：scan scope 必须是 per-session（`messages.value.get(sid)?.some(...)`），若误写全局 scan（遍历所有 session 所有 message），A session 的 text_delta 会让 B session 的 isGenerating computed 失效——与 MF-1 同源。

---

## nit

### N-1 BC-5「abort 复活 steer」标注准确——已交叉验证 pi 源码行为

任务要求验证 BC-5 标注准确性。**结论：准确**。

交叉验证 `docs/page-design/v3/research/pi-steer-followup-capability.md` §六：pi `session.abort()`（agent-session.ts:1413）只调 `agent.abort()`（abortController.abort()），**不调 clearQueue()**（agent-session.ts:1381）。abort 后 loop 命中 `stopReason==='aborted'` return，跳过 drain。残留 steer 在下次 `prompt → runLoop` 开头 `getSteeringMessages()` 被捡起注入。BC-5 描述的「旧 steer 静默复活」时序与 pi 源码完全吻合。

scope 决策（本 topic 不修，依赖 pi RPC clear_queue 扩展）合理——这超出「前端状态撕裂」边界，属 pi 协议层。但建议 mid-detail-plan NFR 显式标注此风险 + 用户规避路径（abort 后若要重发，先发一条空 steer 排空队列，或等待 clear_queue RPC）。

### N-2 分层纪律 + 依赖边界——通过

- §6「不新增 Port」判断正确：本次是 store 内部重构，deletion test 删边界塌缩为一块，无可替换性需求。event-interpreter 是已有 boundary 不动。无伪 port / 空壳层。
- 依赖方向：chat.ts → import `dispatchMessageEvent`（chat-message-effects.ts）；effects 接收 `MessageEffectContext`（store 注入 refs + 回调），无反向 import store。**无循环依赖**。重构后 `setStreaming` 回调更名为 `finalizeSession` 注入，同模式，不引入环。✓
- §7 五模块变化轴基本单一：chat.ts（生命周期）/ effects（事件映射）/ useChat（用户操作编排）/ message-dispatcher（RPC 错误分类）/ protocol.ts（类型契约）。唯一张力：useChat 同时承载 send 路由（B 策略）+ send.rejected 监听 + abort，偏重但可接受（编排层本就聚合用户操作）。

### N-3 §5 ToolCall reason→status 映射未定义

§5「ToolCall 收口原因同上（由所属 Message 的 reason 推导）」，但 ToolCall 的 `end_not_received` 是 **status**（§4 枚举）而非 reason。finalizeSession('timeout') 时 toolCall 收口为哪个 status？`error`？`end_not_received`？reason→status 映射表缺失。§4 不变式只说「必到终态」未说映射到哪个终态。实现时会猜。建议 §5 补 reason→toolCall.status 映射表（如：timeout→end_not_received，abort→end_not_received，stream_error→error）。

---

## 证伪三连汇总

| 边界 | 删 | 翻 | 挪 |
|------|----|----|----|
| 派生模型 isGenerating | ❌ 塌缩回命令式 flag，bug 类复发 | N/A（派生态无翻转语义） | ❌ 挪增量 Set = 重新手动维护 = 原始 bug。**D-005 正确** |
| finalizeSession | ❌ 散落到各 event handler，漏路径（现行 bug） | 消息级不可逆 ✓；但晚到事件可污染终态（SF-2） | ❌ 挪 composable 层会跨层突变 store 实体，归属错误 |
| pendingSend | ❌ 空窗期无表示，isActive 漏态 | 可清空可重加（非终态）✓ | ref↔Set 等价（redteam O-2），Set 为多 panel 铺路合理 |
| send.rejected | ❌ 回 message.error 复用 = 语义污染（D-006 正确） | N/A | N/A |

---

## 与已确认决策的对齐检查

| 决策 | 架构文档对齐 | 备注 |
|------|-------------|------|
| D-001 B 策略 | ✓ §7/§10 D-6 | D-6 鼠标按钮是新交互（reconstruct P1），scope 张力未消解但非架构合理性issue |
| D-002 L1+L2+L3 一次到位 | ✓ §1/§4 | |
| D-003 超时 24h | ✓ §10 D-3 | redteam O-1 报论证自相矛盾（机制必要 vs 24h=禁用），非架构重新裁 |
| D-004 QueueBubble 复用 | ✓ §10 D-5 | |
| D-005 computed scan | ✓ §10 D-1 | SF-5 修论证不修决策 |
| D-006 send.rejected | ✓ §10 D-2 | redteam O-3 报「bug 根因」论断瑕疵，决策本身对 |
| D-007 timer 假收口→收口 | ✓ §10 D-4/§12 BC-3 | |

无 [REVISIT of D-NNN]——未发现推翻已确认决策的新证据。

---

## 下游衔接影响

| 本报告条目 | 影响 mid-detail-plan 的点 |
|-----------|-------------------------|
| MF-1 | isGenerating(sid) 签名必须定，否则 issues 拆分时 store API 契约无基线 |
| SF-1 | abort 终态映射（complete/error）必须在 issues 方案对比中显式决策 |
| SF-2 | sealed 不变式必须进 NFR（鲁棒性）+ effects 改造 issue 的验收 |
| SF-3 | send.rejected 触发契约必须进 message-dispatcher issue 的接口设计 |
| SF-4 | AC-3 路径清单补全后才能作为 test case 的回归基线 |
