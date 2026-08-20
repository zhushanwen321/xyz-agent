# 对话流遗留项收尾（conversation-turn-attribution-closure）

> **一句话结论**：主设计（conversation-turn-attribution）W1-W6 实施后遗留 6 项——真机验收未跑、2 项登记例外（bash abort 分歧 / compaction 窄差异）经本轮探针证实可低成本消灭、D1b steer 插话降级的持久化通路已探明（pi extension `message_end` replace + `appendEntry`，mapper 先例直接复用）、2 项技术债；本设计逐项裁决方案，使登记例外清单从 4 项收敛到 1 项（stream_warn liveOnly——物理事实不可消除）、live≡reload 等价域扩大到 abort/compaction/steer 样式，并把 V1-V6 真机验收排进执行序列闭合设计 DoD。

## §1 背景目标

**SCQA**：

- **S（情境）**：主设计九个 commit（a28fb6238…f9956d113）已落地：分组边界规则集 v2、bash/user/custom/compaction 全类型 live entry 化、load-more 锚定切分、trigger turn 渲染。四包测试全绿，登记表 #7 记录终态 + 4 项例外。
- **C（冲突）**：① 设计 §4 的 V1-V6 真机验收**一个都没跑**（上轮只完成了单测级验证）——设计的 DoD 未闭环；② 4 项登记例外中 2 项（bash abort 分歧、compaction 窄差异）经本轮 0.84.1 dist 探针证实**修复成本远低于当初评估**（各约一个 if 的改动），维持登记是欠账而非必要取舍；③ D1b（steer 插话视觉降级）当初因「pi entry 无标记」deferred，本轮探针发现了可行的持久化通路，deferred 理由不再成立。
- **Q（问题）**：主设计的完成度停在「代码合入 + 单测绿」，距离「验收过 + 无已知可消除的 live≠reload 差异」还差一步。
- **A（答案）**：本设计对 6 项遗留逐个裁决（修 / 不修 / 怎么修），给出收尾 wave 拆分与真机验收执行计划。

**与主设计的关系**：本设计是主设计的收尾层，不改变其任何已落地决策（边界规则集 / entry 化 / 锚定切分全部继承）。读者需先了解主设计 §2.2 的消息链路（event-adapter → registry → applyEntryFrame reducer → message-turns 分组）。

### 遗留问题清单（全部来源可追溯）

| # | 遗留项 | 来源 | 本设计裁决 |
|---|--------|------|-----------|
| L1 | V1-V6 真机验收未执行 | 主设计 §4（DoR 门槛承诺） | F5 执行（§5） |
| L2 | bash abort 分歧：live 无消息 / 文件有 cancelled entry | 登记表 #7 例外① | **修**（D2） |
| L3 | compaction summary-less 窄差异：live 无 / reload 有 fallback 行 | 登记表 #7 例外④ | **修**（D3） |
| L4 | D1b steer 插话视觉降级 deferred | 主设计 §3.3 D1b | **修**（D1，通路已探明） |
| L5 | executingBash 模块级 Map 未接 session 删除 cleanup | bash-effects.ts:40-43 自认迁移欠账 | **修**（D4） |
| L6 | 代码注释引用已废弃的「规则 7.5」编号（12+ 处） | AGENTS 编号演进遗留 | **修**（D5） |

不修项（显式排除）：stream_warn liveOnly（例外②）——pi 对健康警告不写任何 entry，live 消失是物理事实，`liveOnly` 标记已是终态；executingBash ephemeral 形态本身（例外③）——设计形态非缺陷，D4 只修其生命周期挂接。

**设计目标**：

| # | 目标 | 使用者可见行为 |
|---|------|--------------|
| G1 | steer 插话视觉降级且重开一致 | streaming 中插话：气泡呈轻量插话样式（非完整提问气泡）；关闭重开该 session，**同样**呈插话样式——样式经 pi 文件持久化推导，两侧构造性一致 |
| G2 | abort 后重开不再多出记录 | streaming 中 `!` bash 后 abort：live 出现 cancelled 记录（与 pi 落盘一致）；重开分组与内容一致，不再「重开后突然多一条」 |
| G3 | compaction 无摘要时两侧一致 | summary 缺失的 compaction：live 与重开都出现「上下文已压缩」fallback 行（现状 live 无、重开有） |
| G4 | 收尾不引入新的多源真相 | steer 标记的持久化走 pi 文件（custom entry），不在 xyz 侧新增第二份持久化；每项改动过登记表演进规约 |
| G5 | 主设计验收闭环 | V1-V6 + 本设计新增场景在 dev app / 本地 pi CLI 真机跑过并记录 |

**In-scope**：L1-L6 的方案与拆分；等价性测试族更新（E3 改判 / E4 补用例 / 新增 E5）。
**Out-of-scope**：pi 侧任何行为（[MANDATORY] 不修改 pi 源码——所有 pi 侧动作都经其合法 extension API）；steer 的分组语义反转（归入上一 turn——主设计 D1 已定案「开新 turn」，本设计只降视觉重量，见 D1 决策）；thinking 档波动 / bash 流式渲染（governance 线 deferred，非本线遗留）。

## §2 现状与问题分析

（本章全部 pi 侧断言对 node_modules 实装 0.84.1 dist 实测，行号即锚点。）

### 2.1 L2：bash abort 分歧的精确机制

现状帧序（streaming 中 `!` bash 后用户点 abort）：

```
xyz runtime                              pi 进程
─────────                              ────────
sendBash: await client.bash(...)
  myToken = activeSession.bashRunToken
                                       bash 执行中；abort_bash RPC 到达
                                       → bash-executor catch signal.aborted
                                         → return {cancelled:true, output:部分输出, …}
                                         → executeBash 返回（不 throw）
                                       → recordBashResult 照跑
                                         → appendMessage(bashExecution cancelled) 落盘 ✅
abortBash: await client.abortBash()
  finally: 旋转 bashRunToken（≠ myToken）
  广播合成帧 bashResult{command:'', cancelled:true}   ← 哨兵帧
sendBash await 正常 resolve（cancelled result 全量数据）
  :339 guard myToken !== bashRunToken → 「skip duplicate terminal」
  → 真实 cancelled 数据被丢弃 ❌                      ← 丢弃点
```

- pi 侧事实：`core/bash-executor.js:86-109`——abort 时 catch `signal.aborted` 分支 **return cancelled 结果而非 throw**；`recordBashResult` 对 cancelled 无分支照常落盘（主设计探针已锚定）。故 xyz 的 `await client.bash()` 在 abort 后**正常 resolve**，catch 路径（dispatcher :371）只在 transport 断 / pi 死时触发——主路径是 :339 的正常分支。
- xyz 丢弃的理由是「防双终态」：abortBash 已广播一条合成 cancelled 终态。但 W1 之后两条帧职责已正交——合成帧（`command:''`）被 bash-effects.ts:124-127 识别为哨兵，**只清 executingBash 态、不产 entry**；真实帧产 entry。两帧都到达时各自幂等，双终态担忧不成立。**guard 旋转机制本身保留**（catch 分支诊断 + 防旧 sendBash 误写新 bash 的 token 复位仍需要它），只解除正常分支对发布的一声「skip」。

用户所见问题（G2 反面现状）：abort 后 live 干净（无 bash 记录），重开 session 后**突然多出一条 cancelled bash 记录**，且位置在级联末——「重开前后不一致」的机制 4 残余形态。

### 2.2 L3：compaction 窄差异

- `event-interpreter.ts` `handleCompactionEnd`：`if (r.summary)` 真值门——summary 缺失的**成功** compaction 不发 `message.compactionSummary` 帧 → live 无消息。
- pi 侧事实：手动（agent-session.js:1414 → :1432）与 auto（:1654 → :1670）两路都**无条件** `appendCompaction(summary, …)` 落盘；summary 来源是 LLM 结果或 extension 提供（`compactResult.summary` / `extensionCompaction.summary`），缺失形态为 `undefined`（字段缺失，非空串）。
- replay 侧：`apply-entry.ts:543-551` compaction case 的 `summary ?? '上下文已压缩'` fallback 已就绪；live 侧 registry handler（registry.ts:503-530）也已按 `summary !== undefined` 条件展开构造 entry——**全链路只差 interpreter 那一个真值门**。修复 = 删门（帧照发、summary 字段缺省），两侧同走 reducer fallback，差异消灭。
- 空串陷阱已排除：若 LLM 异常返回 `''`，live 帧与 pi 落盘 entry 同为 `''`（`'' ?? fallback` 两侧都不触发），仍然一致——修复方案对 undefined/空串两种缺失形态都不引入新差异。

### 2.3 L4：steer 无标记的事实链与通路突破

主设计探针④结论：pi session 文件的 steer user entry 与普通 user entry 无区分（`_queueSteer` 纯文本入队，drain 后与普通 prompt 同路径 appendMessage）。本轮补充探针把「能不能自建标记」的事实面摸清：

| # | 事实 | 0.84.1 锚点 | 对方案的含义 |
|---|------|------------|-------------|
| F-1 | pi RPC 面无 appendEntry 类方法（全集 prompt…get_commands，:298-545） | modes/rpc/rpc-mode.js | runtime 不能直接写 custom entry |
| F-2 | pi extension API 有 `pi.appendEntry(customType, data)`，写后 emit `entry_appended` | agent-session.js bindCore appendEntry 段（:1863-1870） | **extension 是合法写入通路**，且 xyz 侧 event-adapter 已在消费 entry_appended（:837-852，W18） |
| F-3 | steer RPC **不触发 input hook**（input 只在 prompt 主路径发射） | agent-session.js:812-824（prompt 内）；:986-994（steer 直接 expand+queue，无 emit） | mapper 现有的「input hook 剥标记」模式对 steer 不可用——标记会留在文本里 |
| F-4 | `message_end` hook 的返回值可整体替换 finalized message，replace 原地写回 agent state，注释明确「never enters agent state or session history」（指未替换版本） | `core/extensions/types.d.ts:801-804`（MessageEndEventResult 接口）+ agent-session.js:486-497（`_replaceMessageInPlace` 实现与注释） | **剥除点可挂 message_end replace——注意这是对 pi extension API 的新用法**（mapper 的 message_end 仅置标志位不做 replace，见 §2.3 末先例边界），风险由 §3.5 ⛔1 探针门把守 |
| F-5 | message_end(user) 在落盘**之前**触发（替换影响落盘内容） | mapper 现网注释（xyz-client-msg-id-mapper.js:64-65「此时 getLeafId() 还指向上一条 entry（user message 尚未落盘）」）+ F-4 替换语义自洽 | 标记可不进文件文本、不进 LLM 上下文 |
| F-6 | extension 事件面无 queue_update（pi.on 全集 33 个事件，types.d.ts:867-899） | — | extension 无法靠队列事件感知 steer——**信使必须由 runtime 经 steer 文本捎带** |
| F-7 | steer 入队做 skill/模板展开，文本级转换，HTML 注释原样保留 | agent-session.js:986-991 | 内联标记在 pi 内部管道中存活到 message_end |
| F-8 | steer drain 经 agent-core `steeringQueue.drain()` → `runPromptMessages` → `runAgentLoop`——与 prompt **完全相同的 finalize 链**，`message_end` 对 steer user 消息必触发 | pi-agent-core/dist/agent.js:243-247 | F-4 的剥除点对 steer 路径成立（drain 不是旁路 append，走主链） |

既有基础设施与先例边界（r1 审查澄清）：`xyz-client-msg-id-mapper.js`（仓库根目录单文件 extension，spawn 时 `--extension` 加载）提供的是**三段可复用先例**——标记捎带形态（HTML 注释）、pending → 三重安全网 flush → `pi.appendEntry("xyz.client-msg-id", …)` 的持久化链（mapper.js:79-102）、以及 hook 吞错降级策略；apply-entry.ts:604-606 另有「纯数据 custom entry 不进对话流」的消费先例（`CLIENT_MSG_ID_TYPE` 跳过 + :90 clientUuidMap 累积）。**不可复用的差异点**：mapper 的标记剥除发生在 input hook（mapper.js:48-62），而 steer 不触发 input hook（F-3）——D1 的剥除必须改用 `message_end` replace（F-4），这是对 pi extension API 的**新用法**（mapper 的 message_end 仅置标志位，从未做过 replace），成熟度低于先例部分，风险由 §3.5 ⛔1 实施期门把守。

**结论**：F-2/F-4/F-5/F-7 组合出一条零 LLM 污染、零文件文本污染、单一持久化真相的通路——runtime 在 steer 文本尾部捎带 mode 标记（信使），extension 在 message_end(user) 处剥除并 `pi.appendEntry("xyz.user-mode", …)` 持久化（真相），live（entry_appended 帧）与 reload（entry 顺序）两侧同一 reducer 消费。D1b 的 deferred 理由（「需先过探针④确认 pi entry 可识别注入来源，或由 runtime 写 mode 标记 custom entry」——主设计原文）中后者已可实施。

### 2.4 L5：executingBash 的 cleanup 缺口

`bash-effects.ts:58` `executingBashMap` 是模块级 Map（taste 豁免 W24-EX-B，登记草稿）。文件头注释（:40-43）自认「W2 落地后可随 store 分区槽统一迁移」——W2 已落地，欠账未清。实际缺口不止风格：ADR-0049 的 cleanup 编排（`useSidebar.deleteSession` 统一清理 session 分区状态）**够不到模块级 Map**——删除 session 后若存在未完成 bash，该槽永久残留（量级：一条 `{command, startedAt}` 对象，泄漏极小但违反「cleanup 统一编排」纪律，且豁免登记是草稿状态）。

### 2.5 L6：编号漂移

AGENTS.md 的「对话流状态实时可见」规则现为关键规则 #9，但 12+ 处代码注释与测试名仍引用旧编号「规则 7.5」（apply-entry.ts:388、session-history.ts:7/:92、entry-tree-builder.ts:15、use-session.ts:51、session-entry-mapper.ts:6 及 4 个测试文件）。语义指向一致，纯编号漂移——按 AGENTS 纪律（注释解释为什么且准确）应清理。

### 2.6 L1：验收欠账

主设计 §4 定义了 V1-V6 七个真机场景 + final gate（V1/V2/V4 打包链复跑），实施记录 §6 只完成了 V7（等价性测试）——**V1-V6 全部未执行**。设计的验收承诺（「实施完成后在真实场景验证」）未兑现，本设计将其排入 F5 并扩充新场景。

### 2.7 根因归纳

三项「当年登记、如今可修」的共同根因：**W1-W6 落地后，live 侧的基础设施（entry 化 reducer / entry_appended 接线 / 哨兵帧语义）比当初评估时更强**——abort 分歧的丢弃逻辑写于「bash 直插数组」时代（防双终态针对的是两条都产消息的帧），W1 后帧职责正交化使丢弃失去保护对象；compaction 的真值门写于「直插消息」时代（防 undefined 直插崩溃），W6 entry 化后 registry/reducer 已能安全消费缺省。**登记例外应随基础设施演进复审**——本设计即该复审。

## §3 解决方案

### 3.1 终态（使用者视角）

**成功路径**：

1. （G1）agent streaming 中用户插话（steer）：插话以轻量样式呈现（小号 / 缩进 / 插话标识，非完整提问气泡），agent 围绕插话的后续响应归入该组。关闭重开：**同样的轻量样式**——样式由 pi 文件内的 mode 标记推导，重开不回退为普通气泡。
2. （G2）streaming 中 `!` 跑命令后点 abort：对话流出现一条 cancelled bash 记录（turn 内 notice，含已产生的部分输出），重开位置与内容一致——不再「重开后多出一条」。
3. （G3）compaction 完成但无摘要（罕见）：live 与重开都出现「上下文已压缩」行。
4. 删除 session：其 ephemeral 执行态随分区清理，无残留。

**失败路径与恢复**：

- steer 标记链路任何一环失败（extension hook 抛错 / entry_appended 帧丢失）：**降级为现状**——插话显示为普通 user 气泡（主设计 D1 语义本就成立），分组与等价性不受影响。恢复 = 无需动作（下一条 steer 重新走链路）。mapper 先例同款兜底（hook 吞错 + 降级），不新增用户可见错误。
- pi 文件里 custom entry 存在但 live 侧 entry_appended 帧丢失：重开后标记恢复（文件是 ground truth）——live 期间样式为普通气泡，重开后为插话样式。可接受的短暂降级（与 W21 已裁决的「live 帧丢失类」同族，非结构性分叉）。
- abort 场景 transport 抛错（pi 死 / 连接断）：维持现状哨兵语义（只清态不产 entry）——例外收窄登记（触发条件从「任何 abort」收窄为「abort 且 transport 抛错」）。

### 3.2 方案对比

**L4 steer 插话降级（主对比，四案）**：

| 方案 | 长期架构合理性 | 短期实现成本 | 风险 | 裁决 |
|------|--------------|-------------|------|------|
| **甲 信使标记 + custom entry 持久化 + 两侧 reducer 前向修正 + 渲染变体**（本设计） | mode 真相进 pi 文件（单一持久化真相）；live/reload 走同一 applyEntry case（等价性构造性成立）；复用 mapper 全套先例（appendEntry / 剥除 / 降级）；**分组规则零改动** | 中（extension 单文件扩展 + runtime 注入一行 + adapter/registry/apply-entry 各一小段 + 渲染变体） | message_end replace 对落盘的影响需实测门（§3.5 ⛔1）；用户手打同形标记会被误剥（尾部精确形态，极边缘，登记接受） | ✅ |
| 乙 live-only 样式标记（不持久化） | 标记为 live 瞬态（executingBash 同族）——但样式重开即回退，**重开前后样式跳变正是本线要消灭的问题形态**，G1 直接不达成 | 低 | 用户可感知的不一致被制度化 | ❌ |
| 丙 xyz sidecar 文件记 mode | 第二份持久化真相（pi 文件 + sidecar），且 steer 消息无 clientUuid 映射（F-3：mapper 的 input hook 对 steer 无效）——sidecar 条目与 pi entry 的对齐机制要从零建 | 高 | 多源红线违规 + 对齐脆弱 | ❌ |
| 丁 维持 deferred | 遗留不闭环，D1b 永悬 | 零 | 无 | ❌（探针已解除阻塞，无理由再悬） |

**L4 分组语义（甲案内子决策）**：主设计 D1b 原文设想「steer 视觉降级为 turn 内插话」（归入上一 turn）。本设计裁决为**保留 turn 边界、只降气泡视觉重量**（`turn.user` 结构不变，消息带 steer 派生标记 → MessageBubble 渲染轻量变体）：① 主设计 D1 已定案 steer 开新 turn 是两侧可一致推导的最大公约数，归入上一 turn 要给「user 是 turn 锚」的核心规则开例外，规则表复杂化；② steer 后无 assistant 跟随时插话悬空（归属不明）；③ W4 的 trigger 渲染机制解决的是「无 user 文本的起点」，而 steer 有真实用户文本要呈现，气泡变体比起点行更贴合。**与 D1b 原文的差异显式声明**：降级的载体从「分组归并」演进为「渲染变体」，达成同一产品目标（插话不占完整提问的视觉重量）而分组语义零改动。

**L2 / L3（简对比，二维评估）**：

| 项 | 方案 | 长期架构合理性 | 短期实现成本 | 风险 | 裁决 |
|---|------|--------------|-------------|------|------|
| L2 | 解除正常分支丢弃（发布真实 cancelled 数据） | 消灭登记例外①，live 侧数据源收敛为「pi RPC 返回原样转发」 | 一步改动（guard 分支改发布）+ E3 改判 | 帧职责正交已论证（§2.1），双终态不成立 | ✅ 解除 |
| L2 | 维持登记 | 例外留存，认知负担永续 | 零 | 无 | ❌ 无收益 |
| L3 | 删真值门（帧照发、summary 缺省透传） | 消灭登记例外④，两侧 fallback 已就绪（§2.2） | 一个 if 删除 + E4 用例 | 空串陷阱已排除（两侧同值同 fallback） | ✅ 删 |
| L3 | 维持登记 | 例外留存 | 零 | 无 | ❌ 无收益 |

catch 分支裁决（L2 边界）：维持哨兵（无真实数据可发布，合成会制造与文件部分输出的内容级差异——比「无消息」更糟）。

### 3.3 关键决策

**D1：steer 插话标记走「信使 + custom entry」链（选择）**——影响 G1、G4。

链路五段：

1. **注入（runtime）**：`steerMessage`（message-dispatcher.ts:484-487）发送前在文本尾部捎带 `<!--xyz:mode:steer-->`（followUp 同通路捎带 `follow-up`，渲染变体首期只消费 steer）。经 F-7 展开存活。
2. **剥除 + 持久化（pi extension）**：扩展 `xyz-client-msg-id-mapper.js`（同文件新增逻辑——**复用其 flush/appendEntry/降级三段先例，但剥除点是新机制**，先例边界见 §2.3 末）：`message_end` hook 检测 user message 尾部 mode 标记 → 返回 `{ message: 剥除标记后的消息 }`（F-4/F-5：落盘与 LLM 上下文均无标记；**注意 mapper 现网的 message_end 只置标志位不做 replace，本步是对 pi replace 能力的首次使用，⛔1 不过则整段重议**）→ 置 pending 标记，在既有三重安全网（message_start / turn_end / agent_end）flush 时 `pi.appendEntry("xyz.user-mode", { userEntryId: getLeafId(), mode })`。custom entry 在文件中紧随 user entry（flush 时序保证，mapper 同款）。
3. **live 接线（adapter → registry → store）**：event-adapter `handleEntryAppended`（:837-852）customType 白名单加 `xyz.user-mode` → 产出中间事件 → interpreter 转发为 `message.userMode` WS 帧（payload：mode）→ registry handler 构造**同形 custom entry**（customType `xyz.user-mode`，无 id——位置派生）→ `applyEntryFrame`。与 replay 走同一 applyEntry case（等价性构造性成立，W21 既有模式）。
4. **reducer 消费（apply-entry）**：`custom_message` case 加 `xyz.user-mode` 分支（照 `CLIENT_MSG_ID_TYPE` :604-606 先例）：**不产消息**；对 state 内**最后一条 user 消息**打 `steer: true` 派生标记（前向修正）。定位用「最后一条 user」而非 userEntryId 精确匹配——live 侧消息无 piEntryId（无 id 帧构造，W21 已裁决），前向修正在两侧同构（live：custom 帧紧随 user 帧到达；reload：custom entry 紧随 user entry 消费）。竞态无害论证：custom entry 无论落在 assistant 前后，修正目标（最后一条 user）不变且幂等。shared `Message` 增加 `steer?: boolean` 派生字段（单写方 = applyEntry 该分支）。
5. **渲染变体（ui/renderer）**：Turn 内 user 气泡按 `steer` 标记渲染轻量变体（样式实施期对齐 v3 tokens：小号字 / 缩进 / 「插话」i18n 标识；具体形态 F3 实施时定，验收只锁定「与普通提问气泡视觉可区分 + 重开一致」）。

乐观路径（drainN → appendUser）：live 侧 drain 时刻已知 mode（registry :604 `drainN(sid, 'steer', N)`）——appendUser 签名加可选 mode 参数，overlay 消息直接带标记（提前到 drain 时刻呈现，不等 entry_appended 帧）；真实 message_end(user) 帧到达后 reducer 侧由段 4 补标记，两时序收敛同一结果。**overlay 与 reducer 的标记写方仍各一**（appendUser overlay 点 / applyEntry 分支）——与 W2 后修定的 appendUser overlay-only 契约一致（reducer 的 user 投影只来自帧，标记只来自 custom entry 分支；overlay 只影响渲染 ref）。

误剥防御登记：用户手打精确同形尾部标记（`<!--xyz:mode:steer-->` 且后无内容）会被剥除并打标记——接受（与 mapper 对 `<!--xyz:msg:…-->` 的既有风险同族，概率可忽略，登记注释）。

**D2：解除 abort 正常分支的丢弃（选择）**——影响 G2。

dispatcher `sendBash` :339-341 的 guard 命中分支从「warn + skip」改为「发布真实 cancelled 结果」（走既有双分支：streaming 压 pendingBashResults 等 settled flush——位置与 pi 落盘一致；空闲立即发布）。token 旋转机制保留（catch 分支 :371 诊断、finally :399 复位逻辑不变）。abortBash 合成哨兵帧（:466-481）职责不变（只清 executingBash）。E3 等价性测试从「abort 例外锁定（差异恰为 cancelled entry）」改判为「abort 等价（cancelled entry 两侧 deep-equal）」+ 新增「transport 抛错场景例外锁定」用例（该场景维持哨兵不产 entry，登记收窄例外）。

**D3：compaction 恒发帧（选择）**——影响 G3。

interpreter `handleCompactionEnd` 删除 `if (r.summary)` 真值门——帧照发，`summary` 字段缺省透传。registry（`summary !== undefined` 条件展开）与 reducer（`?? '上下文已压缩'`）零改动即两侧一致。E4 补 summary-less 用例（live 帧 entry ≡ replay entry，两侧同 fallback 文案）。

**D4：executingBash 迁入 chat store 分区（选择）**——影响 G4（架构一致性）。

`executingBashMap` 从 bash-effects.ts 模块级 Map 迁入 `store.ts` per-session Map 分区（与 messages / hydrateAnchors 同区），bash-effects 三个写方（bashStart 置 / bashResult 清 / markBashError 兜底清）改调 store 方法；`getExecutingBash` 由 store 暴露（渲染层读方签名不变）。收益：session 删除时随 useSidebar.deleteSession 统一 cleanup 编排清理（消灭豁免草稿），ADR-0049 checklist 全项合规。注意：ctx（effect-types）需补 store 访问或 bash-effects 直接 import store 单例——实施期按 core 域既有依赖方向定（倾向后者：bash-effects 已 import mutations / apply-entry 同层模块）。

**D5：注释编号清理（选择）**——影响可维护性。

12+ 处「规则 7.5」引用批量更新为「AGENTS.md 关键规则 9」（含 4 个测试用例名）；同时清理 bash-effects.ts:40-43 的迁移欠账注释（D4 落地后改写为落定描述）。纯注释/命名改动，无行为变更，随 F4 一并提交。

**D6：验收执行计划（选择）**——影响 G5。

V1-V6 继承主设计场景原样执行（不因实现已合入而缩减）；新增 V8/V9/V10（§4）；final gate 保持「V1/V2/V4 + V9 打包链 dev app 复跑」。执行顺序：F1-F3 合入 → F5 真机全量一轮（避免实现期反复搭环境）。

### 3.4 目标物理数据流

**steer 标记全链路（D1）**：

```
[Live]
renderer steer 输入 → useChat pushPending(mode:'steer') → runtime steerMessage
  文本尾部捎带 <!--xyz:mode:steer--> ──RPC steer──▶ pi
    pi: expand（标记存活 F-7）→ _queueSteer → drain → appendMessage(user 含标记)
    extension message_end(user): 检测标记 → replace 剥除（落盘/LLM 均无标记 F-4/F-5）
      → pending → 下一个 hook flush: pi.appendEntry("xyz.user-mode",{userEntryId,mode})
      → pi emit entry_appended
    xyz: event-adapter(白名单+xyz.user-mode) → interpreter → message.userMode 帧
      → registry: 构造同形 custom entry → applyEntryFrame
      → apply-entry custom_message 分支: 不产消息 + 前向修正最后一条 user 打 steer 标记
  并行（乐观）: queue_update(drain) → drainN('steer') → appendUser(mode) overlay 已带标记
[渲染]   turn.user 气泡 steer 标记 → 轻量插话变体
[Reload] 文件 entries: … user entry(无标记) → custom entry(xyz.user-mode) → assistant …
  → replayEntries → 同一 applyEntry 分支 → 同一前向修正 → 同一标记 → 同一变体
                                                        ← live≡reload（含样式）构造性成立
```

**abort 帧序（D2，修复后）**：

```
abortBash: 旋转 token + 广播哨兵帧(command:'') ──▶ bash-effects: 只清 executingBash
sendBash await resolve(cancelled result 全量)
  guard 命中 → 发布真实帧（streaming: 压 pendingBashResults → settled flush；空闲: 立即）
  ──▶ bash-effects: cancelled entry 化 → turn 内 notice        ← 与 pi 落盘同位同值
```

### 3.5 探针清单

**✅ 已测（本轮，0.84.1 dist + xyz 现网代码）**：§2.1 帧序与丢弃点；§2.2 真值门与两侧 fallback 就绪度；§2.3 事实表 F-1…F-7；§2.4 cleanup 缺口；空串陷阱排除。

**⛔ 实施期门（探针不过则对应决策重议，禁止带病实施）**：

1. **D1-F5 实测**：本地 pi CLI 按 AGENTS 扩展实测纪律跑一条带标记 steer → 检查 session 文件 user entry 文本已剥除 + `xyz.user-mode` custom entry 已写入 + LLM 请求体无标记。若 message_end replace 实际不影响落盘（时序与推断不符），D1 降级重议（信使改走 entry 内暂存 + accept 剥除失败形态，或回到乙/丙案）。
2. **D1-live 帧序实测**：dev app steer 一次 → 确认 `message.userMode` 帧在真实 message_end(user) 帧之后、后续 assistant 帧之前到达（前向修正定位正确性依赖）。乱序则 registry 侧加一个 entry 暂存重放（同 turn 内对齐后补标记）。
3. **D2 实测**：本地 pi CLI streaming 中 bash + abort → 确认 RPC resolve 的 result 含 cancelled:true 与部分 output（dispatcher 发布数据完整性）。

### 3.6 与既有治理/规范的一致性自查（多源红线）

| 本设计新增物 | 权威源 | 唯一写方 | 是否缓存/影子 | 合规依据 |
|---|---|---|---|---|
| `xyz.user-mode` custom entry | 「该 user 消息以 steer/follow-up 模式投递」这一事实（runtime 发起时唯一知晓点） | pi extension 单点（mapper 扩展，经 pi 合法 appendEntry API） | 否（pi 文件内的第一手持久化，非派生缓存） | 不修改 pi 源码（extension 合法通路）；单一持久化真相（无 sidecar） |
| `Message.steer` 派生字段 | custom entry（读方纯派生） | applyEntry `xyz.user-mode` 分支（reducer 单点）+ appendUser overlay 点（乐观，W2 overlay-only 契约同族） | 否（投影，重放可再推导） | 治理原则 3「投影一次」；对照 `liveOnly` 单写方先例 |
| abort 真实帧发布 | pi recordBashResult 落盘数据（RPC 返回原样转发） | dispatcher sendBash 单点 | 否 | 与 W1 双分支同通路，无新状态 |
| compaction 恒发帧 | pi appendCompaction 落盘数据 | interpreter 单点 | 否 | 同上 |
| executingBash 分区迁移 | bashStart/bashResult 帧 | store 分区（三写方成对契约不变） | 否（瞬态） | ADR-0049 Map 分区 + 统一 cleanup 编排 |

登记表 #7 例外清单演进：例外①（bash abort 分歧）删除；例外④（compaction 窄差异）删除；新增收窄例外「abort 且 transport 抛错时 live 无 cancelled entry（哨兵语义保留）」；例外②③不变。`@data-owner` 注解随 F3/F4 更新。规则 9 双通路核查：steer 标记实时链路（entry_appended → userMode 帧 → reducer）与持久化链路（文件 custom entry → replayEntries → 同一 reducer 分支）**读同一 entry 形态、同一前向修正规则**，无单侧独有规则。

## §4 验收（真实场景，非单测非 mock）

继承主设计 V1-V6（场景、步骤、通过标准原样有效，此处不重复——见主设计 §4 表）。本设计新增：

| # | 场景 | 步骤 | 通过标准 | 回溯 |
|---|------|------|---------|------|
| V8 | abort 后重开一致 | dev app：agent streaming 中 `!` 跑长命令（如 `sleep 30`）→ 数秒后点 abort → run 结束 → 关闭重开该 session | live 与重开都有一条 cancelled bash 记录（含部分输出），位置同在 turn 内 notice 位；重开不再「多出」记录；console 无新增 warn | G2 |
| V9 | steer 插话样式 + 重开一致 | dev app：agent streaming 中 steer 一句插话 → 等 run 结束 → 关闭重开 | 实时：插话气泡为轻量变体（与普通提问可区分）；重开：**同样**轻量变体（不回退为普通气泡）；插话后的 assistant 响应归该组；session 文件中 user entry 无标记文本、存在 `xyz.user-mode` custom entry | G1、G4 |
| V10 | compaction 无摘要一致 | **混合验收形态**：summary 缺失依赖 LLM 异常返回，真实环境无法稳定构造，故核心断言用单测级注入（compaction_end 事件 summary 缺省）承载，真机部分跑正常 /compact 作不回归基线。步骤：① 注入用例（E4 断言 live 与 replay 同产「上下文已压缩」fallback 行）② 真机跑一次 /compact | 注入用例：两侧同 fallback 行、deep-equal；真机：正常摘要行两侧一致（既有行为不回归） | G3 |
| V11 | 全量回归 + 等价性 | 四包全量 + E3 改判（abort 等价 / transport 例外锁定）+ E4 summary-less 用例 + 新增 E5（steer 标记两侧等价：live 帧 entry ≡ replay entry，含前向修正与分组输出 deep-equal） | 全绿；登记表 #7 例外清单与实现一致（4→1+收窄） | G4、主设计 G6 |

Final gate：V1 / V2 / V4 / V9 在打包链 dev app 端到端复跑一次（builtin 扩展生效形态，含 mapper extension 的打包加载）。

## §5 下一层拆分（收尾 wave，领地与依赖）

| wave | 内容 | 领地 | 依赖 | justification |
|------|------|------|------|---------------|
| F1 | bash abort 分歧消灭（dispatcher guard 分支改发布 + E3 改判与例外锁定用例 + 探针 ③） | runtime dispatcher + core 等价性测试 | 无 | 独立最小闭环；例外①即除 |
| F2 | compaction 恒发帧（interpreter 删门 + E4 用例） | runtime interpreter + core 测试 | 无 | 独立最小闭环；例外④即除 |
| F3 | steer 标记链路（mapper extension 扩展 + dispatcher 注入 + adapter/interpreter 帧 + registry entry + apply-entry 分支与 `Message.steer` + appendUser mode 参数 + 气泡变体 + E5 + 探针 ①②） | 根目录 extension 单文件 + runtime adapter/interpreter/dispatcher + core + ui/renderer | 无（与 F1/F2 文件不相交；registry/apply-entry 与 F1/F2 的测试文件不重叠） | L4 主体；改动横跨四层故独立成 wave，探针门内置 |
| F4 | 技术债 + 文档（executingBash 迁 store 分区 + 编号清理 + 登记表 #7 例外清单演进 + AGENTS/主设计实施记录回填） | core store/bash-effects + 全仓注释 + 文档 | F1-F3（登记表要记录它们的落定） | 纯收敛层；例外清单 4→1+收窄的登记动作 |
| F5 | 真机验收执行（V1-V6 + V8-V10 + final gate，按 D6 顺序） | 无代码（发现问题回投对应 wave） | F1-F4 全部合入 | 设计 DoD 闭环；主设计欠账 L1 兑现 |

**文件改动地图**：改写 `message-dispatcher.ts`（guard 分支、steerMessage 注入）、`event-interpreter.ts`（删真值门、userMode 帧转发）、`event-adapter.ts`（handleEntryAppended 白名单）、`effects/registry.ts`（userMode handler、compactionSummary 注释更新、drainN appendUser mode 透传）、`apply-entry.ts`（xyz.user-mode 分支）、`store.ts`（appendUser mode 参数、executingBash 分区）、`bash-effects.ts`（三写方改调 store）、`xyz-client-msg-id-mapper.js`（mode 标记剥除 + appendEntry）；扩展 `shared/message.ts`（`steer` 字段）、Turn/MessageBubble 变体渲染 + i18n。新增无文件（mapper 扩展在既有单文件内）。

**并行协调**：F1/F2/F3 领地不相交可三路并行（唯一共享点 `message-dispatcher.ts` 被 F1（sendBash guard）与 F3（steerMessage 注入）触碰——两处相距 150 行、语义独立，F3 先行或串行该文件即避让；启动前 `git log` 复核并行 session 在途改动）。F4 串行收尾，F5 最后。

**待验证检查点**：§3.5 三项实施期门；F3 气泡变体的具体样式形态（v3 tokens 对齐，实施期定案）；appendUser mode 参数对 useChat clientUuid 映射链的影响复核（签名可选参数，既有调用点零改动）。
