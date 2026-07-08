---
role: redteam
frame: 必要性与比例性（反过度设计）
verdict: APPROVED
isolation: 与主 agent / 对齐组隔离
---

# 红队审查报告 — fix-state-tearing mid-plan

> 审查帧：站在「这个设计过度/不合理」的反方立场，对每个决策跑 deletion test（删掉它会怎样？最小可行版本是什么？）。
> 纪律：D-001/D-002/D-003 是 ask_user 拍板，质疑标 [REVISIT of D-00X]；D-005~D-007 agent-opinionated 可自由质询。

## Verdict

**APPROVED**

核心设计（派生模型 + finalizeSession + send.rejected + B 策略）经得起 deletion test，没有「删掉就塌」的过度设计。5 个功能点（F1-F5）一一对应 G1/G2/G3 三个目标，无多余功能；5 个模块改动各自绑定明确功能点，无 scope 蔓延。

但发现 **3 个降级建议**（非阻塞）和 **1 个论证自相矛盾**（D-003），定稿组可自行判断是否采纳。无「必须修改」项。

---

## 过度设计发现

### O-1: [REVISIT of D-003] 超时 24h 与「timer 保留」自相矛盾 — 论证瑕疵，默认值待商榷

**对象**：D-003（超时可配置默认 24h）+ 架构 §10 D-3 + requirements §7

**deletion test**：
- requirements §7 原文：「默认 24h（实质禁用时间兑底，**卡死检测靠 runtime 重启/WS 断连事件**）」
- 如果卡死检测**真的**靠 runtime 重启/WS 断连 → timer 是冗余的 → 删掉
- 如果 timer **不是**冗余（防 pi 静默卡死：进程不退出、WS 不断、就是不动）→ 24h 太长，用户要等 24h 才看到 UI 反馈

设计同时主张「timer 必要（防静默卡死）」和「24h 合理（=实质禁用）」——**两者逻辑互斥**。

**关键证据**：runtime 重启和 WS 断连**检测不到** pi 静默卡死（pi 进程活着、WS 连着、只是不 emit 事件）。这种场景下只有 timer 能触发 finalizeSession。所以 timer 机制**确实必要**（删不掉）。但一旦承认 timer 必要，24h 默认值就不合理——静默卡死时用户要等 24h。

**建议降级方案**：
- 保留 timer 机制（必要）
- 默认值改为积极值（如 30min-2h，覆盖 glm-5.2 慢模型的长任务上限 + 余量），而非 24h
- 或：明确文档化「24h = 放弃时间兜底，静默卡死场景靠用户手动点停止按钮」，承认这是 UX 妥协而非「兜底」

**质疑力度**：中。机制必要（deletion test 通过），但默认值与论证逻辑冲突。属 ask_user 决策，走二次确认。

---

### O-2: pendingSend 改名 + ref→Set 类型升级是「搭便车改造」，可降级

**对象**：架构 §1「搭便车改造目标」pendingSend 取代 dispatchingSessionId + 架构 §4 降级决策

**deletion test**：保留 `dispatchingSessionId`（ref<string|null>）名字和类型，只做两件事：
1. 在 finalizeSession 里加一行 `dispatchingSessionId.value = null`（补清理）
2. 语义不变（空窗期预期态）

会怎样？——功能完全等价。当前 `isActive()`（chat.ts:338）已经合并 isStreaming + dispatchingSessionId，改名不影响调用方。

**改名（dispatchingSessionId → pendingSend）的收益**：语义更清晰（"待发送" vs "派发中"）。代价：diff 面积增大，回归风险增加。

**ref→Set 升级的收益**：支持多 panel 并发流式。但 requirements §8 明确「不做多 panel 并发流式（G-023 DEFERRED）」。当前 Set 的多值能力**用不上**。

**建议降级方案**：
- 最小版：保留 `dispatchingSessionId` ref<string|null>，只补 finalizeSession 清理
- 中间版：改名为 pendingSend（语义清晰），但保持 ref<string|null>（不为 DEFERRED 的多 panel 提前建模）
- 当前设计版：改名 + Set 化（为未来铺路）

**质疑力度**：弱。Set 与 ref 实现差异微乎其微（add/delete/has vs ===null），且多 panel 是明确路线。但严格按「最小改动」原则，当前设计是 3 个选项里改动最大的。不强制降级。

---

### O-3: D-006（send.rejected）论证理由瑕疵 — 决策合理但「bug 根因」论断站不住

**对象**：D-006 + 架构 §10 D-2（send.rejected 新增类型 vs message.error+reason 复用）

**deletion test**：不新增 send.rejected，在 message.error payload 加 `kind: 'rejection' | 'stream_error'` 字段，renderer 根据 kind 决定副作用。会怎样？

**关键论证审查**：D-006 原文「message.error 的副作用（进对话流 + 翻流式态）与操作拒绝语义正交，复用必污染（**本次 bug 根因**）」。

这个论断的「本次 bug 根因」**部分错误**：
- 本次 bug 根因是**命令式 flag 模型**（isStreaming 手动维护，streamingTimer 只翻 flag 不收口实体）——见 requirements §G1.1
- 派生模型（F1）实施后，isGenerating 从 messages 派生，message.error 即使被广播，只要不把 message 实体推到终态，isGenerating 就**不会**变 false → 撕裂副作用**自然消失**
- 即：派生模型本身就能消除 message.error 的撕裂，send.rejected **不是**防撕裂的必要条件

**但 send.rejected 仍然合理**，真正理由是：
- **UX 语义分离**：「操作被拒绝」（busy 时发送）不该在对话流里冒红色错误气泡（那是「流终止错误」的位置）；用户期望的是轻量反馈（QueueBubble 已有 / 不进对话流）
- **类型建模正确性**：两类事件（流终止 vs 操作拒绝）的消费者、副作用、UX 反馈完全不同，独立类型是教科书式做法
- **证据**：message.error 当前已被 5 处复用（message-dispatcher.ts: hook 拦截 / hook 异常 / prompt 失败 / abort 失败 + session-service.ts:114 session 退出），污染**已经存在**，send.rejected 是止损

**建议**：修正 D-006 / D-2 的论证理由，从「本次 bug 根因」（错误）改为「UX 语义分离 + 阻止 message.error 继续污染」（正确）。决策本身不改。

**质疑力度**：弱。决策正确，只是论证链条有瑕疵。不阻塞定稿，但建议修正以免误导后续 issue 拆分。

---

## deletion test 通过的决策（不过度，记录备查）

| 决策 | deletion test 结论 |
|------|-------------------|
| **D-002 派生模型（F1）** | 删掉 → 回到命令式 flag，每新增一条事件路径就要记得「既翻 flag 又收口实体」，bug 复发是结构性必然。派生模型**物理消除**不一致可能，是根因修复非过度设计 |
| **F2 finalizeSession** | `resetActive()`（chat.ts:313-322）**已存在**，是 runtime 崩溃/重启/WS 断连的统一收口。finalizeSession 是它的自然演进（补「收口实体」），不是新概念。4 条路径已有 3 条走 resetActive，只差超时这条（streamingTimer 当前只翻 flag） |
| **D-001 B 策略** [REVISIT] | A 策略（disabled）对短任务合理，但 G2 明确要支持长任务（>5min），长任务期间 disabled 让用户无法补充上下文，与 G2 矛盾。B 策略是 G2 的配套。键盘 Enter 已走 steer（Composer.vue:314），鼠标 disabled 是**不一致**（本身是 UX bug）。质疑力度弱，与 G2 一致 |
| **D-004 QueueBubble 复用** | 恰恰是**反过度设计**（不加新 UI，复用已有 QueueBubble.vue）。deletion test：不碰队列 UI = scope 收敛。无质疑 |
| **D-007 timer 假收口→收口实体** | 当前 streamingTimer 行为（只翻 flag 不收口）本身就是 bug（撕裂根因之一）。改为收口实体是 bug 修复，非行为变更。删不掉 |

---

## 必须修改

**无。**

核心设计经得起 deletion test，3 个降级建议均为非阻塞（论证瑕疵 / 默认值商榷 / 搭便车 scope），定稿组可自行判断是否采纳。建议优先处理 O-1（D-003 论证自相矛盾）和 O-3（D-006 论证理由修正），O-2 可忽略。

---

## 红队立场声明

本次审查未发现严重的过度设计。核心原因：设计的 5 个功能点严格绑定 3 个业务目标（G1/G2/G3），每个模块改动都有对应功能点，没有「为了好看而加」的抽象层或扩展点。派生模型是真正的根因修复（把「维护一致性」的复杂度消除，而非用更多机制去保证一致性），方向正确。

唯一的结构性风险是 D-003 的超时策略：如果定稿组认可「24h = 放弃时间兜底」，应在 requirements §7 明确写「静默卡死场景靠用户手动停止，不靠 timer」，并接受「pi 静默卡死时 UI 可能永久卡在思考态直到用户干预」这个 UX 后果。如果不接受，默认值需改小。两者必选其一，不能既要又要。
