# subagent drawer 打开空白修复设计（task 气泡 + 思考中指示 + 空 reload 擦除）

> **一句话结论**：drawer 打开时若 subagent 虚拟分区为空，用 SubagentRecord.task 兜底注入用户气泡（不覆盖已到内容），并让 ActivityStrip 思考行响应 subagent 真在跑信号——三处小改动，全部在 renderer，runtime/协议零变化。

## 开篇（SCQA）

- **S（情境）**：xyz-agent 的 subagent 在侧边栏可见后，点击 item 会在 drawer 打开只读对话流（SubagentTab 复用主 MessageStream 渲染树），实时增量经 E-4 entry 帧（routeInbound）与 stream_delta 订阅双路到达。
- **C（冲突）**：subagent 刚派发后打开 drawer 是纯空白——没有用户气泡、没有思考中指示，要等子进程冷启动 + 首个 entry/token 到达（数十秒至分钟级）才有内容；重开 drawer 还会擦除已到达的内容。
- **Q（问题）**：如何让 drawer 在「record 已可见、实时数据未到」的窗口期内立即展示有意义的初始态，且不破坏既有双路数据通路？
- **A（答案）**：renderer 三点修——① fetch 空历史时用 `record.task` 种入用户气泡（分区非空则不动）；② 空 reload 不再无条件擦分区；③ ActivityStrip 思考行增加 subagent forceWorking 驱动条件。

## 1. 背景：被设计的系统是什么

**xyz-agent 的 subagent drawer 是主对话流的并排只读视图**。主 agent 派发 subagent（pi-subagent-workflow 扩展 spawn 独立子进程）后，侧边栏 Agents tab 出现卡片（来自主 session JSONL 的 SubagentRecord 投影）。点击卡片 → drawer 打开 SubagentTab → 按三段式虚拟 id（`subagent:<mainSid>:<subId>`）从 chatStore 的 messages Map 读取分区渲染，复用主对话流的 Turn/Block/thinking/markdown 全套渲染树（D3 硬约束）。

数据到达分两路（既有架构，本设计不改）：

- **reload 腿**：drawer 打开时 `fetchAndInject` → RPC `session.getSubagentHistory` → runtime 直读 subagent JSONL → `setMessages` 整体替换分区。
- **实时腿**：①E-4 relay tee 把子进程 entry 转 `session.subagentEntriesAppended` 帧，经 routeInbound → `applySubagentEntries`（reducer 状态 + 基线投影，**帧先于 drawer 打开到达也写分区**）；②drawer 打开后 `subscribeStream` 订阅 `subagent.stream_delta`（打字机增量，替换式——每帧携带 buffer 全文，非纯 append）。

> **术语约定**（内部决策编号出处）：E-4 = subagent-realtime-channel 设计的 entry 帧兜底链；U4 A8 = 非 pi 引擎 outcome 客户端投影决策；u6a/D7 = ActivityStrip 收编三处进行中指示的展示统一改造；W16 = 自描述 subagent-record entry 格式 v1。**基线投影** = `applySubagentEntries` 内「用 reducer 状态（entryStates.messages）整体替换消息分区」的投影步骤——定稿数据是权威，替换语义是后续共存分析（§6.4）的前提。

本设计聚焦「record 已在侧边栏可见、两路数据尚未到达/部分到达」的窗口期 UX。

## 2. 设计目标

**改造后：用户点击刚派发的 subagent，drawer 立即呈现「任务是什么 + 正在执行」的初始态。**

1. **即时任务气泡**：drawer 打开时分区的历史为空 → 立即显示 task 文本的用户气泡（来自侧边栏已在的 SubagentRecord，零额外 RPC）。
2. **思考中指示**：task 气泡下方显示「思考中…」活动行（复用主会话 D7 统一形态），子进程产出到达后自然过渡为真实内容。
3. **不倒退**：重开 drawer、切走切回、实时帧先到的场景，已投影内容不被擦除、不出现重复气泡。

**In-scope**：renderer 侧 `useSubagentTabData` / subagent store `fetchAndInject` / `MessageStream`→`ActivityStrip` prop 通路 + 测试。
**Out-of-scope**：runtime `getSubagentHistory` 协议与读取链（不改，长期收敛方向见 §6.7）；sessionFile 补全时机（轮终写 entry，属扩展侧 v4 设计，不动）；非 pi 引擎既有 coarse 提示与 outcome 兜底**机制**不变——task 气泡与思考行**同适用于非 pi**（多窗口路径真实参与，见 §5.1 变体）；非 pi 终态不回填缺口（`docs/todo/subagent-nonpi-terminal-reload.md` 2026-08-25 已独立登记，本设计放大其陈旧占位表现，见 §5.1 变体末互链）；core ①级空视图降级缺陷的修复（范围外，§11 ⛔3，follow-up 已落账 `docs/todo/subagent-core-native-empty-view-degrade.md`）；agentcall 两段式空历史无兜底（同症状不同源的既有缺口，§11 ⛔4 登记）；主会话 ActivityStrip/occupancy 语义（不动）。

## 3. 现状：使用者眼里是什么样的

### 3.1 现状的真实样子

subagent 派发后（侧边栏卡片已显示「reviewer · fix-login」running 态），点击卡片，drawer 打开：

```
┌─ drawer ──────────────────────┐
│ 🤖 reviewer · fix-login  [pi] │  ← 标题栏正常
│                               │
│         （完全空白）            │  ← 无气泡、无指示
│                               │
│ 🔒 只读                        │  ← 底条正常
└───────────────────────────────┘
```

数十秒后（子进程产出到达）内容才渐现。若产出已到达后再关开 drawer，`setMessages(vid, [])` 会先擦掉已有内容，闪空白后等下一帧重投影。

### 3.2 怎么出错（三个真实失败模式）

- **A 首开空白**：派发瞬间 register entry 无 sessionFile（`subagent-service.ts` execute() 同步返回时子进程未 spawn），轮终才有带 sessionFile 的 entry——整个第一轮 runtime 读历史必然 `[]`；分区无任何消息 → MessageStream 空数组 → 无 turn 可渲染。
- **B 无思考指示**：forceWorking 已正确为 true（isStreamingSubagent 窄口径），turn.isStreaming 也被驱动为 true，但空 turn 不渲染 TurnMeta（u6a：`v-if assistants.length > 0`）；「思考中」已统一迁 ActivityStrip，其条件是 `sessionPhase().turn === 'dispatching'`——虚拟 session 永远收不到 occupancy 帧，恒 idle → 活动行永不出现。
- **C 重开擦除**：`fetchAndInject` 拿到 `[]` 仍无条件 `setMessages(vid, [])`，把 E-4 帧先到时已投影的内容清空（reducer entryStates 未清，下一帧自愈，但窗口内闪空白）。

### 3.3 根因

**drawer 的初始态完全依赖数据到达，没有任何「record 已知信息」参与的本地兜底**——而 `record.task`（任务全文）此刻就在 subagentStore 分区里，drawer 链路却无消费点；「真在跑」信号（forceWorking）已算出但 ActivityStrip 不认。

## 4. 物理数据流（修复前后）

```
SubagentRecord（subagentStore 分区，sidebar 与 drawer 共享）
  ├─ record.task ──────────────┐
  ├─ record.status/result/resumable ──┐
  │                            │       │
  │   [修复①②] useSubagentTabData.loadSubagentData
  │   history = fetchAndInject()         │
  │     ├─ 非空 → setMessages(真实历史)   │   （不变）
  │     └─ 空 → 非 pi 且 outcome 有值且分区空 → outcome 投影（不变，判定先行）
  │              └─ 其余且分区空 → 种入 task 气泡 ①
  │                 └─ 分区非空 → 不动（保留 E-4 内容/outcome 已投影）②
  │                                      │
  │   [修复③] MessageStream              │
  │     forceWorking = isStreamingSubagent() ──┘
  │     subagentThinking = forceWorking && 末位 turn 无 assistant
  │        └→ ActivityStrip thinking 行「思考中…」③
  │
  └─ 实时腿（不变）：E-4 entry 帧 → applySubagentEntries（基线投影整体替换分区，
     task 兜底气泡被真实数据确定性取代——期望行为）；stream_delta → push/续写
     streaming assistant（追加在 task 气泡后——期望行为）
```

> **forceWorking** = `isStreamingSubagent(mainSid, subId)`：`status==='running' && result===undefined && resumable!==true` 的窄口径（轮终 running-resumable 与孤儿兜底不算）。就是 §3.1 例子里那个「卡片转圈」的同一判据，drawer 已在消费，本设计只是让 ActivityStrip 也消费。

## 5. 终态：使用者眼里将是什么样的

### 5.1 成功路径

派发 subagent 后立即点击卡片：

```
┌─ drawer ──────────────────────┐
│ 🤖 reviewer · fix-login  [pi] │
│                               │
│ ┌─────────────────────────┐   │
│ │ 帮我 review 登录模块的…   │   │  ← task 用户气泡（秒开）
│ └─────────────────────────┘   │
│    ──⟳ 思考中…──              │  ← 活动行（D7 统一形态）
│                               │
│ 🔒 只读                        │
└───────────────────────────────┘
```

子进程首批 entry 到达 → 基线投影整体替换分区 → 真实对话流（含子进程真实 user 消息）取代兜底气泡，思考行随「末位 turn 出现 assistant」消失，TurnMeta「工作中」行接管。stream_delta 先到 → streaming assistant 追加在 task 气泡后（首帧替换式写入该实体，后续帧全文替换其内容），同样自然。

**非 pi 引擎变体**（zcode 等）：非 pi 的 drawer 初始态与 pi 同机制修复（seed + 思考行真实参与），但数据到达路径分三个窗口（R2 终审裁定 + 主 agent 源码核正）：
- **窗口 A（register → create 应答）**：record 尚无 engineHandle → runtime ③级 outcome-only 投影 → `[task 气泡, (no outcome recorded) 占位 assistant]`（③级永不返回空，session-view-service.ts:431）→ 分区非空、末位有 assistant → 思考行不触发，TurnMeta「工作中」行接管（forceWorking 驱动）。
- **窗口 B（create 应答 → 首个 assistant content 持久化）**：engineHandle 运行中回填落盘（subagent-service.ts:2156 + record-store.ts:557）→ ①级 native reader 返回 defined-but-empty 视图（collectTurns 排除 user 消息）→ `turnsToMessages([])` 投影为 **[task 气泡]**（task 非空时恒非空，session-view-service.ts:362-369 先 push record.task）→ runtime 数据先行 setMessages、seed 不触发，但**末位无 assistant → 思考行触发**。
- **⚠️ 窗口形态过时修正（2026-09-09，nonpi-visibility-followups 落地，commit b329d4149）**：上两行为 v6 时点快照。followups 修复后：①**窗口 B** ①级 defined-empty 视图降②③级（其设计 D3）→ 读取返回 `[task, 占位 assistant]`，与窗口 A 形态对齐；②两窗口占位 assistant 均被思考行判据排除（其设计 D6：`useSubagentThinking` 判「末位全部为占位 = 无实质产出」）→ **窗口 A/B 思考行均触发**（与 TurnMeta「工作中」并存）。Gate B 实测：app-server 常驻形态下窗口 B 窄于 UI 反应时延（1s 采样 7/7 次派发均直接读到真实 mid-run 内容，占位形态不可见），两修正在真机近乎不可观测，属结构性正确。权威描述：`docs/design/subagent-nonpi-visibility-followups.md` §3.1/§3.3 D3/D6。
- **窗口 C（首个 assistant content 持久化后）**：①级返回真实内容，正常渐现。
- 另有跨引擎窗口：runtime 磁盘扫描滞后（`!target`/`!record` 返回 []，session-records.ts:298/306）而 renderer record 已由 state topic 供给 → **seed 真实触发**（对任意引擎）。

结论：非 pi 运行中 drawer 无空白窗口（task 气泡由 runtime ①③级投影或 renderer seed 三者之一供给；思考行在窗口 B 与磁盘滞后窗口触发，窗口 A 由 TurnMeta「工作中」接管）。修复前非 pi 窗口 B 同样存在「仅 task 一条、无思考行指示」的欠佳初态，本设计思考行对其是**真实改进**而非纯防御。已知遗留（范围外，§11 ⛔3 登记）：①级 defined-empty 视图不降级②③级，使③级「详情页至少有 task/结果」意图在窗口 B 退化为仅 task——缺陷本体在 subagent-core，其他③级消费方同受影响。

**终态不回填（相邻既有缺口，本设计放大其表现，v6 对抗式总审补记）**：非 pi 无实时腿，drawer 对话流仅在打开/重开时拉取——任务终态后**已打开的** drawer 不自动回填结果（缺口本体 2026-08-25 登记于 `docs/todo/subagent-nonpi-terminal-reload.md`，修复草案 = record status 跨越 watch 终态 reload，与本设计机制零冲突）。本设计**放大**了该缺口的表现：窗口 A 的 `(no outcome recorded)` 占位 assistant 在任务完成后仍停留，而此刻 outcome 已存在——陈旧占位比空白更误导，该 todo 的排期紧迫性因此上升。两处追踪物经本节交叉互链，任一侧落地时须同步另一侧状态。**【已修复 2026-09-09】**：缺口随 nonpi-visibility-followups 落地（SubagentTab status watch，其设计 D2，commit b329d4149），Gate B S1/S4/S5 真机验证终态自动回填；本段陈旧占位放大表现随之消除。

### 5.2 失败路径（带恢复指引）

- **历史 RPC 失败**：维持现状 loadError 错误态 + 重试按钮（本设计不改错误链路）。👉 用户点「重试」重新拉取。
- **task 为空的 record**（理论边界：start 必带 task）：无气泡可种，但思考行仍随 forceWorking 显示（分区空 + 真在跑 → 末位 turn 判定空 → 思考行条件成立）——如实呈现「有任务在跑但内容未知」，不造假装数据。👉 无恢复动作需要。
- **兜底气泡残留疑虑**：不可能残留——基线投影（真实数据整体替换）与 reload 非空历史（setMessages 替换）两条权威路径都确定性清除兜底；子进程崩溃前零产出的极端场景，气泡保留恰好呈现「派发过什么任务」，cancelled/closed 后 forceWorking=false 思考行自动消失。
- **非 pi 终态后内容陈旧（已知遗留，非本设计引入但本设计放大）**：无实时腿引擎在任务终态后，已打开 drawer 不自动重拉；窗口 A 场景的占位 assistant 会继续显示与实际不符的 `(no outcome recorded)`。👉 切走切回或重开 drawer 即刷新；根修（status watch 终态自动 reload）归 `docs/todo/subagent-nonpi-terminal-reload.md` 排期。**【已修复 2026-09-09】**：根修随 nonpi-visibility-followups 落地（commit b329d4149），终态自动回填已真机验证。

## 6. 关键决策与权衡

### 6.1 兜底注入放 renderer 数据编排层，不放 runtime

- **采用**：`useSubagentTabData.loadSubagentData` 在 fetch 空历史后种 task 气泡。record.task 就在 renderer store 分区，零 RPC、drawer 打开即得；且「虚拟分区本地兜底」与既有非 pi outcome 投影（U4 A8，同为 renderer 客户端兜底）模式一致。
- **被否**：runtime `getSubagentHistory` 合成 outcome-only 消息——task 是 toolCall 参数投影，runtime 侧合成需跨进程传 task 语义、与后续真实历史拼接防重复，改动面在协议层，收益不比客户端兜底多。
- **证据**：非 pi 引擎 outcome 兜底先例（useSubagentTabData.ts U4 A8 注释「客户端 outcome 投影顶上，详情页不白屏」）。
- **效果**：目标 1 秒开成立。

### 6.2 空历史不擦分区（fetchAndInject 空结果跳过 setMessages）

- **采用**：`fetchAndInject` 返回拉取的 history，空数组时**不调** setMessages；分区是否种兜底由编排层依据「分区当前是否为空」决定。
- **被否**：维持无条件 setMessages + 后续重投影自愈——E-4 内容闪空是用户可感知的倒退（§3.2 失败模式 C），且「重投影自愈」依赖下一帧到达时机，不可控。
- **证据**：store.ts `setMessages` 注释「直接覆盖…不受 hydrated 守卫」（无守卫可依赖，只能调用侧自律）；E-4 handleSubagentEntries 注释「帧先于 drawer 打开到达时也写分区」。
- **效果**：目标 3「不倒退」成立。非空历史照旧整体替换（保持「定稿是权威」语义，也天然清除兜底气泡防重复）。

### 6.3 思考行走 ActivityStrip 扩展条件，不动 TurnMeta/occupancy

- **采用**：MessageStream 把 `subagentThinking = forceWorking && 末位 turn 无 assistant` 作为 prop 传给 ActivityStrip；活动行条件扩为 `turn==='dispatching' || subagentThinking`。
- **被否**：①给虚拟 session 写 occupancy（turn='dispatching'）——occupancy 是 runtime 帧驱动的单一权威（OCC 语义），renderer 伪造写点破坏 SSOT 且 occupancy 还有发送路由消费方；②恢复 TurnMeta 空 turn 渲染——u6a 刚把思考指示收编进 ActivityStrip（D7 统一），开倒车。
- **证据**：ActivityStrip 组件头注「收编三处分散的进行中指示…thinking：turn=dispatching → 思考中」；TurnMeta 注释「空 turn 不再渲染 TurnMeta（v-if 收窄）…思考中指示迁 ActivityStrip」。
- **效果**：目标 2 成立，与主会话思考行同款视觉同款数据通道级别（组件级 prop，不碰 occupancy）。

| 方案 | 长期架构合理性 | 短期实现成本 | 风险 | 裁决 |
|---|---|---|---|---|
| ActivityStrip 加 prop（选） | 高——顺 D7 收编方向 | 3 处小改（core 0 行） | 低（主会话恒 false 零影响） | ✅ |
| 虚拟 session 写 occupancy | 低——伪造权威写点 | 中 | 发送路由误消费 | ❌ |
| TurnMeta 空 turn 恢复渲染 | 低——逆 u6a 收编 | 中 | 与 D7 设计冲突 | ❌ |

**被否若用**：occupancy 方案会让主会话发送位四态的判定表多出「虚拟 session 伪 dispatching」需专门排除的特例——§5.1 的样子一样，但代价是跨域语义污染。

### 6.4 兜底气泡的共存语义：依赖既有替换路径，不加去重机制

- **采用**：兜底气泡不设特殊 id/标记，被真实数据替换即消失（基线投影整体替换 / reload 非空 setMessages 替换）。
- **被否**：给兜底气泡加幂等标记、让 applySubagentEntries 投影时识别跳过——审查曾提示「投影整体替换会清掉兜底」是风险，方向反了：清掉恰恰是**期望终态**（真实 user 消息与 task 文本语义相同，替换无视觉跳变），加标记反而引入投影层特例。
- **证据**：streaming-state-machine `applySubagentStreamDelta` 无 streaming 实体时 push 新实体（追加在气泡后，视觉正确）；`finalizeSubagentStream` 无 streaming 实体时幂等 no-op（源码已核）；子进程首轮真实 user 消息 = task 文本（extension 用 task 作为子进程 prompt）。
- **效果**：目标 3 无重复气泡成立，且 §5.1→真实数据的过渡零额外机制。

### 6.5 等价性不变量声明（live≡reload）

- **采用**：task 兑底气泡是**仅存于 live 内存的展示层占位**，与既有非 pi outcome 投影同类（同为 live-only 客户端兑底）——不引入新的不变量豁免类。
- **证据**：规则 9 的 live≡reload 由 `apply-entry-equivalence` 守卫，其覆盖范围是 applyEntry reducer 的主会话路径（含 steer 乐观气泡 E5 组），subagent 虚拟分区本就不在其覆盖内（影响面审已核）；兑底气泡不喂 reducer、不落盘，reload 腿（重开后拉真实历史）天然不包含它——「live 多一个占位、reload 直接是真实数据」与 steer 乐观气泡被真实 user entry 取代同构，属既有先例覆盖的展示层瞬时态。
- **效果**：目标 3 不与规则 9 冲突；测试矩阵（T2）将「reload 后无兑底残留」钉为断言。

### 6.6 思考行残留风险声明

- **采用**：思考行消失依赖 record 更新（session.subagents 推送）驱动 forceWorking 翻 false；该帧是 state topic（入 STATE_TYPE_KEY_MAP last-value 快照，重连/切回经 stateSnapshot 回放恢复）——丢失面与侧边栏卡片 spinner 同源同级（同一 record 数据源的同一窄口径判据），既有架构已接受该残余风险，本设计不新增兜底。
- **证据**：runtime STATE_TYPE_KEY_MAP 含 subagents（影响面审已核）；SubagentList `isStreaming` 与 `isStreamingSubagent` 同判据（running && result undefined && resumable !== true，均无引擎过滤）。

### 6.7 「详情页至少有 task」不变量的归层与收敛方向（v6 对抗式总审增补）

- **现状声明**：「已知 record 的详情页至少有 task 气泡」当前由**四层兜底涌现**——runtime ①级 task 前置投影 / runtime ③级 outcome-only / renderer outcome 投影（U4 A8）/ 本设计 renderer seed。优先级靠「判定顺序写死 + 分区空守卫 + 测试钉死」维持，是约定不是结构性保证；每个新消费方（摘要卡已在 ⛔3 上中招）都须自行重排一遍兜底。
- **收敛方向（本期不实施，登记 follow-up）**：runtime 读链对已知 record **永不返回空**——③级合成推广到 pi `!sessionFile` 窗口 + ①级空视图判空降级（即 ⛔3 修复）。协议层单点 own 该不变量后，renderer 两层客户端兜底（outcome 投影 / task seed）自然死代码化（守卫恒假、无迁移成本）。**【进展 2026-09-09】**：①级判空降级半已落地（nonpi-visibility-followups D3，commit b329d4149）——非 pi 链已知 record 永不返回空壳；pi `!sessionFile` 半未做，且 renderer 兜底死代码化尚未发生（两兜底仍在防御磁盘扫描滞后窗口等真实可达场景，见 §5.1 变体），收敛完成前不删。
- **论据更正（总审查出，如实登记）**：§6.1 否决 runtime 合成的「需跨进程传 task 语义」论据站不住——runtime 自 extract record、`record.task` 本就在手，且 ①③级已经在合成带 task 的投影。本期选 renderer 侧是**战术取舍**（改动面小、热修节奏、零协议风险），不是架构上更优；在此更正叙事，防止后续维护者把战术理由误读为架构定论。
- **效果**：本设计三处机制不变；收敛落地路径与 ⛔3 同一 core 读取链主题，追踪物合一（`docs/todo/subagent-core-native-empty-view-degrade.md`）。

## 7. 实现机制

三处改动（全部 renderer，core/runtime/shared 零改动）：

1. **`packages/renderer/src/stores/subagent.ts` — fetchAndInject**：签名改为返回 `Promise<Message[]>`（拉到的历史）；`history.length > 0` 才 `setMessages`。调用方仅 drawer 编排层一处，签名扩展向后兼容。
2. **`packages/renderer/src/composables/panel/useSubagentTabData.ts` — loadSubagentData**：接收 fetchAndInject 返回值。空历史时的**判定顺序即优先级**（顺序写死，禁止颠倒）：
   ① **outcome 兑底判定先行**（守卫：非 pi && `getMessages(vid)` 为空 && `result/error` 有值）→ setMessages(outcome 投影)，命中后分区非空；
   ② **task 种入判定随后**（守卫：`getMessages(vid)` 为空 && `record.task` 非空）→ setMessages(vid, [task 气泡])（id `task-u-<subagentId>`，role user，status complete，timestamp `record.startedAt ?? Date.now()`），①已命中或 E-4 已投影时分区非空 → 自然跳过。
   即：非 pi + outcome 有值 → 仅 outcome 投影（其自带 task user 气泡 + result/error assistant 消息，既有多屏形态不变，seed 不参与）；其余空分区场景 → task 气泡种入。既有 outcome 分支代码零改动，seed 插在其后并复用同一分区空守卫。
3. **`packages/renderer/src/components/panel/MessageStream.vue` + `message-stream/ActivityStrip.vue`**：MessageStream 计算 `subagentThinking`（`forceWorking && (无 turn || 末位 turn.assistants.length === 0)`）传 prop；ActivityStrip 新增可选 prop，thinking 行条件扩为 `(!compacting && !executingBash && (turn === 'dispatching' || subagentThinking))`。i18n 复用现有 `panel.message.dispatching`（zh「思考中…」/ en「Thinking…」），零文案新增。

## 8. 验收（真实场景，非单测非 mock）

### 8.1 改动规模

中——行为变更（drawer 初始态从空白变有内容 + 重开不擦除），涉及数据编排与展示组件，需多场景真实验证；单测覆盖兜底判定矩阵（见 §10）。

### 8.2 验收场景

| 场景 | 回溯目标 | 真实流程 | 通过标准 |
|---|---|---|---|
| S1 首开即时初始态 | 目标 1+2 | `pnpm dev` 起 app，发一个必派 subagent 的 prompt（如「派一个 subagent 数一下 src 下文件数」），侧边栏卡片出现后**立即**点击 | drawer 秒开即显 task 用户气泡 + 「思考中…」活动行；等待后真实对话流替换兜底，无重复气泡、无双 user |
| S2 重开不擦除 | 目标 3 | S1 中子进程已产出可见内容后，切走 drawer tab 再切回（或关 drawer 重开） | 内容持续在屏，无闪空白；最终与主对话流/等待真实数据一致 |
| S3 轮终后打开 | 目标 1+3 | 等 subagent 第一轮完成（卡片转圈停）后点击 | 显示真实历史（sessionFile 已落盘），无兜底气泡残留，无思考行（forceWorking=false 或轮终排除） |
| S4 主会话零回归 | 目标 3 | 主对话流正常使用（发送/流式/压缩/bash），观察活动条 | 主会话 ActivityStrip 行为与改前完全一致（subagentThinking 恒 false） |
| S5 非 pi（zcode）running 打开 | 目标 1+2+3（非 pi 多窗口） | 引擎设置切 zcode 后派发 subagent，**窗口 B 内**（卡片出现后立即）点击卡片 | drawer 秒开即有 task 气泡 + **进行中指示（「思考中…」活动行或 TurnMeta「工作中」行，随数据到达窗口而定，R2 终审补记修正）** + coarse 提示——**行为导向判据：无论数据来自 runtime ①③级投影还是 renderer seed，三要素同屏即通过**；窗口 C 后重开显示真实内容；zcode 有 result 的异常空历史场景（③级失效模拟）客户端 outcome 投影不变（task+result 同屏） |

## 9. 实施

### 9.1 迁移路径

| 阶段 | 内容 | 交付终态的什么 |
|---|---|---|
| M1 | fetchAndInject 返回值 + 空不擦 + task 种入 | 目标 1+3（S1 气泡 / S2 不擦除 / S3 无残留） |
| M2 | subagentThinking prop + ActivityStrip 条件 | 目标 2（S1 思考行 / S4 零回归） |
| M3 | 测试 + lint/typecheck + 提交 | 全部场景可回归 |

单 commit 粒度即可（改动面小、一个行为主题）。

## 10. 下一层拆分（测试矩阵）

| 单元 | 说明 | justification |
|---|---|---|
| T1 fetchAndInject 空结果 | 空 → 不调 setMessages、返回 []；非空 → 调用并返回 | 修 C 的根；调用侧判定依赖返回值契约 |
| T2 loadSubagentData 种入判定矩阵 | 空 history × 分区空/非空 × task 空/非空 × pi/非 pi × outcome 有/无 组合矩阵（5 组钉死组合 + 2 补充；未测格的退化行为由分区空守卫蕴含）；**显式钉死**：非 pi + task 非空 + outcome 有值 → 仅 outcome 投影（task 在投影内）无 seed；非 pi + 无 outcome → seed（**可达场景**：runtime 磁盘扫描滞后窗口，见 §5.1 变体）；pi + task 非空 → seed（**主场景**）；分区非空（E-4 先到/runtime 已投影）→ 不种不擦；reload 后无兑底残留 | 兜底是矩阵语义，单点测会漏；outcome × seed 优先级是审查命中的回归点，必须组合钉死；非 pi seed 为可达真实场景（R2 终审裁定） |
| T3 subagentThinking 判定 | forceWorking 翻转 × 末位 turn assistant 有/无 × 非 virtual id 恒 false；非 pi 窗口 B（末位仅 task user 消息）→ true；非 pi 窗口 A/C（末位有 assistant）→ false **【2026-09-09 判据扩展，nonpi-visibility-followups D6】**：「有 assistant」收窄为「有非占位 assistant」——末位 assistant 全为占位（content === SUBAGENT_OUTCOME_PLACEHOLDER，仅 result/error 双缺时出现）→ 仍 true；非占位 content → false。代码断言见 MessageStream-subagent-force-working.test.ts 占位反例用例（T3 既有用例末位均为真实内容，D6 下不翻转保持绿） | 思考行条件含派生逻辑，防末位 turn 判定回归；非 pi 多窗口行为显式钉死 |
| T4 ActivityStrip 行渲染 | prop 变化驱动行出现/消失（DOM 断言 testid） | 用户可见行为断言（三视角之黑盒） |
| T5 现有测试适配性修订 + 全绿 | 预期翻转清单：`subagent-tab.test.ts`「pi 空历史 → 0 turn」翻转为 1 turn（seed 生效）；「非 pi 空结果 + result → outcome 投影 task+result 同屏」**应保持绿**（outcome 分支先行不受影响），若红则修正测试前提而非产品代码。修订后相关套件全绿 | 字面「全绿」不可达成（行为变更必然翻转旧断言），如实登记预期翻转清单防静默改产品代码迁就旧测试 |

## 11. 待验证检查点

- ⛔ 实施期验证：真实双 user 场景（兜底气泡 vs 子进程真实首条 user 消息）过渡是否视觉平滑（S1 等待观察）。**降级路径**：对比幅度超预期（明显跳变不适）→ 登记 follow-up 不阻塞交付（兜底气泡短暂展示属可接受初态，跳变限于单气泡位置）。
- ⛔ 实施期验证：`record.task` 含超长文本时的渲染（气泡无 maxHeight 的话是否需要截断）——超范围则登记 follow-up，不在本设计处理。
- ⛔3 范围外缺陷登记（R2 终审 SUGGESTION 采纳）：core 读取链①级 defined-empty 视图不降级②③级（session-view-service.ts:496 `native !== undefined` 即返回、无内容检查），使③级「详情页至少有 task/结果」意图在非 pi mid-run 窗口 B 退化为仅 task——缺陷本体在 subagent-core，其他③级消费方（摘要卡数据源）同受影响。证据链：collectTurns 排除 user 消息（engines/zcode/reader.ts:289，user 不进 turns 注释 :293）+ buildView 零 turn 不抛错 + 编排层无判空。修复方向：①级返回前判空降级②③级。follow-up 已落账 `docs/todo/subagent-core-native-empty-view-degrade.md`（v6 对抗式总审查出原「实施期登记」未产生任何可追踪物，补登落账），独立于本设计排期。**【已修复 2026-09-09】**：随 nonpi-visibility-followups 落地（其设计 D3，commit b329d4149），①级 defined-empty 降②③级 + Gate B S6/S7 真机验证非空壳；③级合成推广到 pi `!sessionFile` 窗口（本节收敛方向剩余半）仍未做，追踪物见该 todo §4。
- ⛔4 相邻表面登记（v6 对抗式总审）：agentcall 两段式（workflow tab agent call 入口）空历史无任何兜底——与本设计同症状（drawer 纯空白）不同源（快照只读、无 record 实时腿、无 renderer seed），影响面审 INFO-1 登记为既有缺口，归 workflow/agentcall 主题独立排期，本设计不处理。

## 附录：变更历史

- v1：初版——三决策（renderer 兜底 / 空不擦 / ActivityStrip prop）+ 共存语义依赖既有替换路径。基于已对抗式审查的根因分析（/tmp/subagent-drawer-blank-analysis.md，0 must-fix）。
- v2：审查修复轮 1（主审 1MF+3S / 影响面审 2MF+3S 全修）——①outcome × seed 优先级写死为「判定顺序即优先级」（outcome 先行，seed 复用分区空守卫自然跳过）；②非 pi 引擎面显式声明（三重指示叠加为预期形态 + §5.1 变体 + S5 验收场景 + T3 非 pi 断言 + Out-of-scope 措辞修正）；③新增 §6.5 live≡reload 等价性声明；④§5.2 task 空时思考行仍显示（原「维持空白」与修复③矛盾）；⑤§1 stream_delta 改「替换式」措辞 + 术语表补出处；⑥T5 改「预期翻转清单 + 修订后全绿」；⑦⛔1 补降级路径。
- v3：R2 复审期主 agent 源码核实补强——①core `readSubagentHistoryMessages` ③级 outcome-only「永不返回空数组」（session-view-service.ts:431）⇒ 非 pi runtime 历史恒非空，seed/思考行对非 pi 实际不参与：§5.1 非pi变体重写（三重叠加不会发生，runtime ③级即时给出 task+占位）、S5/T2/T3 同步修正、非 pi 组合标防御性；②新增 §6.6 思考行残留风险声明（state topic last-value 快照回放，与侧边栏 spinner 同源同级）。R2 两个攻击点（非 pi 叠加/残留）由事实核实消解。【后被 R2 终审反例击穿，v4 纠正】
- v4：R2 终审修复（主审 1MF+1S 全修，路线 a 零代码改动）——主审反例击穿 v3 三段论中段：①级 zcode native reader 对零 assistant 内容返回 defined-empty 视图不降级③级（session-view-service.ts:496 无判空），且 engineHandle 运行中回填落盘（subagent-service.ts:2156），mid-run 窗口恰与本设计目标窗口重合；主 agent 复核修正一处细节：`turnsToMessages` 对零 turn 视图先 push record.task（:362-369）→ runtime 返回 [task 气泡] 而非 []（impact 审判断言正确）——§5.1 重写为三窗口模型（A ③级占位 / B ①级 [task] / C 真实内容 + 磁盘扫描滞后窗口 seed 真实触发）；§2 Out-of-scope 消除自相矛盾；S5 改行为导向判据；T2/T3 非 pi 标注改「可达/多窗口钉死」；§11 新增 ⛔3 core ①级空视图降级缺陷登记（主审 SUGGESTION 采纳）。机制层零改动（守卫式顺序对分支可达性不敏感，主审裁决②放行）。
- v5：终审补记 SUGGESTION 修复（0 MF 后唯一遗留，一字之改）——S5 判据中间要素从「思考行」放宽为「进行中指示（思考行或 TurnMeta 工作中行）」，消除窗口 A 冷启动假阴性；终审对 v4 的 [task] 修正与三窗口模型、五处改写、无 v3 残留全部确认。**设计就绪（两份终审均 0 must-fix）**。
- v6：交付后独立对抗式总审修复轮（三问：用户问题是否真解 / 隐藏问题 / 长期架构；裁决：机制层成立、用户问题真解，发现 3 个追踪层缺口 + 1 笔架构债）——①§5.1/§5.2 新增非 pi 终态不回填放大声明（窗口 A 占位 assistant 终态后陈旧显示，比空白更误导），与 `docs/todo/subagent-nonpi-terminal-reload.md`（2026-08-25 已登记、HEAD 仍未实现）交叉互链并声明其排期紧迫性上升；②§11 ⛔3 follow-up 落账 `docs/todo/subagent-core-native-empty-view-degrade.md`（总审查出原「实施期登记」未产生可追踪物）；③§2 Out-of-scope 补 agentcall 空历史无兜底登记 + §11 新增 ⛔4；④新增 §6.7「详情页至少有 task」不变量归层声明与 runtime 收敛方向，并如实更正 §6.1 被否方案的论据（战术取舍非架构定论）。**机制层零改动**（renderer 三处改动与判定顺序不变）。
