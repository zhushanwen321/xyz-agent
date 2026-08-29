# PanelView 派生收敛与 NewTaskFlow 生命周期绑定——panel 输入面终态架构

> 一句话结论：对话面板的输入面（composer / ask-user / landing）改由一个**纯函数从事实派生**（`derivePanelView`），新建流程状态的生命周期**绑定其承接视图（Landing）**、终态转移固定在**交接点**——三处改动让「输入面错误消失」这类 bug 在结构上不可表达。

## §1 背景目标

**SCQA**：用户在已有会话中稳定对话（S）；turn 结束瞬间 composer 消失、下次 turn 开始又出现，触发条件不明（C）；为什么一个「新建任务」流程的全局状态能左右已有会话的输入面？（Q）——因为输入面显隐是四个异构状态源的手工组合，其中一个源（flow 单例）存在无主残留路径（A：终态架构从所有权与可表达性上根除）。

**系统是什么**：xyz-agent 是 Electron 桌面 AI agent 工作台。对话界面（Panel）自上而下为消息流 + 输入面；输入面有三种形态：常规输入（Composer）、ask-user 阻塞应答（AskUserOverlay，互斥替换 Composer）、新建任务落地页卡片（Landing 内嵌 composer）。新建任务走 NewTaskFlow 状态机（core 包模块级单例，10 态：idle/landing/六个 overlay/completed/cancelled），当前为单 panel 形态（panel store `panels` 恒 1 元素）。

**设计目标**（使用者体验倒推）：

- **G1 输入面稳定**：会话中任何时刻 composer 可见可用；turn 状态翻转（streaming→complete）、compacting 等运行态不改变输入面的**存在性**。
- **G2 流程状态不越权**：新建任务流程（landing 及其 overlay）只影响「无会话承接时」的渲染，永不影响已有会话的任何渲染决策。
- **G3 决策可穷举**：输入面选择逻辑收敛为单一纯函数，全输入组合有机器守卫（组合表测试），非法组合（如有消息且 landing）在输入设计上不可表达。

**In scope**：`Panel.vue` 渲染分支收敛为 `derivePanelView` 派生；NewTaskFlow 生命周期三出口闭合（交接点终态 / 视图卸载守卫 / 既有切换守卫）；`submitFirstMessage` 交接原子化。

**Out of scope**：split 多 panel 重启（当前单 panel，预留讨论见 §3.3 D6）；flow 状态机 10 态内部重构；ask-user 交互本身；MessageStream 内部。

## §2 现状与问题分析

### 2.1 使用者视角的现状

正常路径（无 bug）：⌘N → Landing 卡片（内嵌 composer）→ 输入首发消息 → 会话创建、消息流入、Landing 消失、Panel 底部出现常驻 Composer → 对话往复，composer 始终在。

失败路径（本次用户报告）：对话若干轮后，某一轮 assistant 输出完最后一段 text + 变更集（turn 完成）→ **composer 消失**，页面底部直接是消息流 → 下轮对话开始 composer 又出现。触发条件对使用者不可见。

### 2.2 失败模式时间线（根因链）

输入面显隐的现行判据（[Panel.vue:192-197](../../packages/renderer/src/components/panel/Panel.vue#L192)）：

```ts
showPanelComposer =
  (!!sessionId && !isLandingView && !isSessionDead)  // isLandingView = !sessionId || flow.state==='landing'
  || isSessionActive    // = 有 streaming 消息 ∨ pendingSend（turn 进行中为 true）
  || isCompacting
```

`flow.state` 是 core 模块级单例（[flow-state.ts:103](../../packages/core/src/domain/new-task-search/flow-state.ts#L103)）。当它卡在 `landing` 时：turn 进行中 `isSessionActive=true` 兜底显示 composer（用户无感）；**turn 结束瞬间**（最后一条 assistant 消息离开 `streaming`）三项全 false → Composer 卸载——与症状逐点吻合。

`landing` 残留的已知路径：

| # | 路径 | 现状 |
|---|------|------|
| 1 | 会话中点新建，旧 sessionId 残留 | **已修**：`startFlow` 清空 activeId（[flow.ts:162-166](../../packages/core/src/domain/new-task-search/flow.ts#L162) 注释记载了同款症状「页面不跳转、只 composer 消失」——同症状家族第二次出现） |
| 2 | 首发提交中 `chat.send` 失败 | **现行代码不可达**（审查核实）：`useChat.send` 内部 catch 全部错误只 toast 不 throw（[useChat.ts:432-443](../../packages/core/src/domain/chat/useChat.ts#L432) W2 策略），`transition('completed')` 总会执行。残留的理论缝隙：send 的 `appendUser`/`ensureStreamSubscription` 在 try **外**（[useChat.ts:429-430](../../packages/core/src/domain/chat/useChat.ts#L429)，本地操作，抛错概率极低但此时 activeId 已设）；以及历史版本行为（症状在 2026-08 被用户实际观察到，真实触发路径无法从现行代码确证） |
| 3 | split 双 panel：panel A 停留 landing，panel B 切换守卫不触发 | **预留风险**（当前单 panel，不构成现行触发） |

**诊断不确定性声明**：症状真实（用户可复现观察），但「state 卡 landing」的确切触发路径在现行代码中无法唯一确证。这本身正是 §2.4 根因 3 的实证——判据组合无守卫时，任何未知的 state×session 组合都能变成用户可见症状，每次都依赖事后考古，且考古结论随代码演进失效（路径 1 修复后路径 2 的缝隙已近乎关闭，症状仍被观察到）。**终态设计因此不以「堵死某条具体路径」为目标，而以「无论 state 因何残留，输入面判据结构免疫」为目标**。

另有防御守卫：`selectSession` 切换时 `flow.isActive → cancelFlow`（[useSidebar.ts:163](../../packages/renderer/src/composables/features/sidebar/useSidebar.ts#L163)）——只覆盖「切换」动作，是枚举堵漏。

### 2.3 物理数据流（现状）

```
用户动作                      状态存储                         渲染判据组合                    屏幕
─────────                    ────────                         ────────────                    ────
⌘N / 首发提交 ──────►  flow.state（core 全局单例）──┐
turn 进行/结束 ─────►  chat store（isGenerating）──┼──► Panel.vue computed 手工组合 ──► Composer 挂载/卸载
ask-user 请求 ──────►  extensionUIStore ──────────┤    （4 个异构源、3 个时态敏感项）
进程退出 ──────────►  session store（dead）───────┘
```

问题：判据组合发生在组件 computed 里，无组合穷举测试；`flow.state` 的生命周期没有绑定任何视图——landing 态在 Landing 页不渲染时（被 `messageCount>0` 的 MessageStream 分支压制）成为**无主孤儿**，仅剩 composer 判据还在读它。

### 2.4 根因归纳

1. **状态粒度错配**：应用级单例被用于 per-panel 决策。
2. **状态与承接者脱钩**：状态机假设「landing 态 = Landing 页在承接」，但 Landing 渲染被消息数压制，状态成了无主态；无终结机制。
3. **组合无守卫**：显隐判据是异构状态的现场调和，组合空间（sessionId 有无 × 消息有无 × flow 态 × turn 态 × dead × ask-user × trace）没有任何穷举保障——每次 bug 来自一个未被考虑的格子。

## §3 解决方案

### 3.1 终态（使用者视角）

**场景 A：flow 状态残留下的结构免疫（终态核心保证）**——无论 `flow.state` 因何卡在 landing（历史路径、未来代码演化、未知缝隙），只要 panel 绑定了 session（`sessionId` 非空），输入面就是 conversation（composer 常驻），landing 判据读不到它——**「state 残留 × 输入面消失」的组合在派生规则上不可表达**。send 失败的现行行为（WS 断连时 toast 提示、无错误消息入流，[useChat.ts:432-443](../../packages/core/src/domain/chat/useChat.ts#L432)）不变；用户在 composer 重发即可。

**场景 B：稳定对话**——多轮长对话，每轮 turn 结束（text + 变更集出现）composer 不消失、不闪动；compacting 期间 composer 保持（内部禁用态，现行行为）。

**场景 C：新建后放弃**——⌘N → Landing 出现 → 不发消息，点侧栏旧会话 → Landing 消失、旧会话对话流 + composer 正常（现行已有守卫，终态保留为三出口之一）。

**场景 D：ask-user 阻塞**——extension 发起 ask-user：AskUserOverlay 互斥替换 composer（现行行为不变）；应答后 composer 回来。

**恢复指引**（终态下 state 残留不再产生用户可见症状；若实施期发现「残留 × 症状」组合，说明派生被绕过）：任意切换 session 一次即可触发既有 cancelFlow 守卫清理残留态。

### 3.2 方案对比

| 维度 | 方案 A：视图拥有的流程态 + PanelView 纯函数派生（推荐） | 方案 B：flow per-attempt 实例化（改 C-NT-6 Q2=A 裁决） | 方案 C：最小止血（transition 上移 + 判据加 messageCount） |
|------|------|------|------|
| 长期架构合理性 | 三根因全除：单例保留但 landing 的产生与终结都由 Landing 视图垄断（挂载→startFlow、卸载→cancel、交接→completed），无主态不可达；显隐收敛为可穷举纯函数，对未知残留路径结构免疫 | 同等彻底，且结构性消灭全局单例；但「未来 split 隔离」的额外收益当前不可兑现（单 panel） | 只在判据上加防御条件压住症状；根因 1/3 原样保留，下一个未知格子出现时同症状再发 |
| 短期实现成本 | 中：1 个纯函数 + 全组合测试 + Panel.vue 分支重写 + Landing 卸载守卫 + flow 交接点移动；消费方 API 面不变 | 大：Workspace/Landing/Composer/composer-shell/useSidebarNew/useSidebar 及全部测试改持实例句柄 | 小：两处一行级改动 |
| 风险 | 低：flow 公开 API（startFlow/submitFirstMessage/cancelFlow/isActive/…）全部保留，行为变化仅「终态时机提前」与「显隐判据收敛」，均有组合测试与真实场景验收兜底 | 高：触面广，改造期行为漂移难审；且 C-NT-6 注释裁决理由（「全局流程状态非 per-session」）在 A 下依然成立，改判证据不足 | 低，但 bug 家族继续 |

**推荐 A**。若用 B：未知残留路径同样被结构免疫（实例 dispose），但成本触面与收益不成比；若用 C：§2.1 失败路径的症状被防御条件压住而根因全在——flow 语义仍可处于「session 已交接而 state 停留 landing」的矛盾态，下一个未知格子（如 split 重启后）复现同症状。

### 3.3 关键决策与权衡

**D1：`PanelView` discriminated union + `derivePanelView` 纯函数，放 `core/domain/session/panel-view.ts`。**
输入全原始值（`sessionId: string | null`、`hasMessages: boolean`、`isSessionDead`、`isTraceView`、`hasAskUserRequest`、`isFlowActive`），零跨域 import，天然可穷举。被否：放 renderer composable（失去 core 单测归属与复用面）；放 ui 包（依赖倒挂，ui 不该知道 flow 概念）。视图模型：

```ts
type PanelView =
  | { kind: 'dead'; sessionId: string }
  | { kind: 'trace'; sessionId: string }                                  // 现行 isTraceView 分支保留
  | { kind: 'conversation'; sessionId: string; input: 'ask-user' | 'composer' }
  | { kind: 'landing' }                                                   // 无 session 且 flow 活跃
  | { kind: 'empty'; sessionId: string | null }                           // 绑定空会话（composer 供直输）/ 无 session
```

派生规则（全组合表进单测）：**前置约束 `dead`/`trace` 仅在 `sessionId` 非空时成立**；优先级 dead > trace > conversation（`sessionId` 非空即成立——有消息走 MessageStream、无消息走空对话态，输入面均为 composer/ask-user）> landing（`!sessionId && isFlowActive`）> empty。**注意 conversation 与 landing 判据互斥于 `sessionId` 有无**——「有消息且 landing」在输入组合上不可表达（landing 只在 `!sessionId` 时成立），根因 3 由此根除。该规则依赖既有不变量「startFlow 进入 landing 时清空 activeId」（[flow.ts:162-166](../../packages/core/src/domain/new-task-search/flow.ts#L162)，`isFlowActive ⟹ sessionId=null`）——landing 分支的 `!sessionId` 条件与该不变量构成双保险：即便未来不变量被破坏，派生也只会落到 empty/conversation 而非错误地藏 composer。

**D2：`isSessionActive` / `isCompacting` 从输入面存在性判据中移除。**
现行它们是 landing 残留的兜底；终态下 landing 不可残留，兜底删除后任何新泄漏**立即显形**（composer 消失）而非被掩盖。composer 内部的禁用/进度态（compacting 期间）不受影响——那是 input 的**模态**，不是存在性。被否：保留兜底（掩盖未来回归，违背 G3 显形原则）。**行为变化声明**：dead + streaming 残留组合（进程死亡、turn.end 未到达、`isSessionActive` 恒 true，[store.ts:283-284](../../packages/core/src/domain/chat/store.ts#L283)）从现行「显示 composer」变为「dead 占位视图无 composer」——与 W6 语义（dead 不应答）对齐，属修正而非回归。

**D3：交接原子化——`transition('completed')` 上移到 `pushChat` 之后、`chat.send` 之前**（[flow.ts:308-326](../../packages/core/src/domain/new-task-search/flow.ts#L308) 序列内）。论证是**时序正确性 + 防御加固**而非堵现行路径（send 现行吞错，见 §2.2 诊断声明）：交接（setActiveSession + loadPanel + pushChat）完成即 flow 职责终结，这是「流程状态机只守自己不变量」的正确语义；`send` 成败属于 session 的错误通道（toast，现行行为），flow 终态不应依赖它——send 链路未来任何演化（如恢复 throw、新增前置抛错点）都不再影响 flow 终态。探针：单测强制 `ports.chat.send` reject，断言 `flow.state==='completed'`（✅ 已纳入 V1；现行代码该用例也过，价值在锁定语义防回归）。

**D4：Landing 视图卸载守卫——`onUnmounted(() => { if (flow.isActive.value) flow.cancelFlow() })`。**
Landing 是 landing/overlay 态的唯一承接视图（startFlow 由其挂载逻辑触发已是现状，[Landing.vue:90-91](../../packages/renderer/src/components/new-task/Landing.vue#L90)），卸载即终结，封死「视图消失、状态漂留」的未知路径（§2.2 声明的不可确证残留由本出口兜底）。守卫限定 `isActive`（landing/overlay 态）：正常首发（completed）与切换（cancelled）路径下卸载时已非活跃态，守卫 noop，不产生非法转换（ACTIVE 态 → cancelled 均在 ALLOWED 表内）。被否：仅依赖 D3（`setThinkingLevel` 等交接前中间步骤抛错仍可卡 landing——D4 是出口兜底层）。

**D5：`Panel.vue` 模板重写为 `switch(panelView.kind)` 渲染。** composer-band 判据收敛为：**ask-user 渲染 ⟺ `kind==='conversation' && input==='ask-user'`**（dead 态被优先级吞掉，保留 W6「dead 不渲染 ask-user」语义，[Panel.vue:201-203](../../packages/renderer/src/components/panel/Panel.vue#L201)）；**Composer 渲染 ⟺ `kind==='conversation' || (kind==='empty' && sessionId !== null)`**（绑定空会话的 composer 直输是现行行为）。WidgetArea 挂载条件映射为 `kind ∈ {trace, conversation, empty-with-session}`（等价现行 `sessionId && !isSessionDead`，[Panel.vue:72](../../packages/renderer/src/components/panel/Panel.vue#L72)）。

**D6：`Workspace.vue` 的 `flow.isActive` 消费与单 panel 现实保持不动。** split 重启时，PanelView 输入本就 per-panel（sessionId per panel），landing 属于「无 session」的 panel 级状态，届时把 `isFlowActive` 换成该 panel 的派生即可，无需现在预付 per-attempt 实例化（呼应 §3.2 否 B）。

**D7：删除唯一会话后的空态承接——`deleteSession` / `deleteFolder` 的全部空态出口统一编排 `startFlow()`。**
现状：删空后 `navigation.push({ view: 'chat' })` + `activeId=null`，现行 `isLandingView=!sessionId` 恒 true → Landing 渲染 → `onMounted` 自动 `startFlow`（[Landing.vue:89-95](../../packages/renderer/src/components/new-task/Landing.vue#L89)），用户得到「删除即新建页」体验。终态下 landing 需 `isFlowActive`（此时 flow=idle）→ 若不处理则落入无输入面死态 empty。空态出口共 **4 处**：deleteSession 与 deleteFolder 各自的「删空分支」+ 各自的「selectSession(next) 网络抖动失败的 S4 兜底分支」（[useSidebar.ts](../../packages/renderer/src/composables/features/sidebar/useSidebar.ts)；注意文件内 `navigation.push({ view: 'chat' })` 共 5 处，第 5 处属 `newSession` 延迟 create 分支——该处 flow 已是 landing **不需编排**，且无参 `startFlow()` 的 `pendingCwd=null` 会清掉 newSession 刚回灌的 fallback cwd，helper 以删除路径的功能定义为准、命名避免泛化）。方案：提取「空态承接」helper（push chat 空态 + `startFlow()`），4 处统一调用——把现行「Landing 挂载隐式触发」的依赖显式化为编排层职责（Landing 的 onMounted 自动 startFlow 保留为挂载兜底；双入口幂等经审查核实无风险：startFlow 体内全同步无 await，createInFlight 守卫在 landing guard 语义下不可误吞，重复调用时已 landing 态只刷新 cwd）。

## §4 验收（真实场景，实施后在 dev app 验证）

| # | 场景 | 步骤 | 通过标准 | 回溯目标 |
|---|------|------|----------|----------|
| V1 | flow 状态残留结构免疫（终态核心保证） | ① ⌘N 进入 Landing（flow=landing）；② Vue devtools 直改 panel store / session store，把 panel 绑定的 sessionId 改回一个有消息的旧会话（等价复现「路径 1 修复前」的真实残留态：flow=landing 且 panel 绑定会话，零新增代码）；③ 观察面板与一个 turn 的结束 | 全程 composer 可见不消失；panelView 恒 conversation（landing 判据读不到非空 sessionId）；对照改造前此状态会令 turn 结束后 composer 消失 | G2（结构免疫实证） |
| V1' | 首发失败行为（createSession 失败路径） | ① ⌘N 进 Landing，断开 runtime WS（session.create 走同一 WS，先于 send 失败）；② 输入首发消息发送；③ 重连 WS；④ 重发 | 失败时 toast 报错 + Landing 停留且内嵌 composer 可用（session 未建、无死态）；重连重发成功后 Landing → 对话流、composer 常驻、flow.state 到达 completed。「send reject → state=completed」语义由 T2 单测覆盖，本场景不重复 | G1（首发失败的真实行为验收） |
| V2 | 稳定对话输入面恒定 | 选一个已有会话连续对话 ≥3 轮（含带变更集的轮） | 每轮 turn 结束（text+变更集出现）composer 不消失、不闪动；compacting 提示期间 composer 保持禁用态可见 | G1 |
| V3 | 新建放弃切换 | ⌘N → 不输入 → 点侧栏另一会话 | Landing 消失，目标会话对话流 + composer 正常；再 ⌘N → 点侧栏切回原会话 → composer 正常 | G2 |
| V3' | 删除唯一会话承接（D7） | 侧栏仅剩一个会话时删除它 | 列表空 → Landing 渲染（新建页），composer 卡片可用；与改造前「删除即新建页」体验一致 | G1（无死态空态） |
| V4 | ask-user 互斥不变 | 在会话中触发一个 ask-user（装 ask-user extension 的模型对话） | AskUserOverlay 替换 composer；应答后 composer 恢复；dead session 下不渲染 overlay；行为与改造前一致 | G1（无回归） |
| V5 | 穷举组合守卫（附加，不替代 V1-V4） | `cd packages/core && npx vitest run src/domain/session/__tests__/panel-view.test.ts` | derivePanelView 全输入组合表测试通过；含回归用例「`{sessionId:'s1', hasMessages:true, isFlowActive:true}` → conversation（landing 不可表达）」与「dead 优先级吞掉 ask-user」 | G3 |

## §5 下一层拆分

| # | 单元 | 内容 | justification（为什么独立） | 验收挂钩 |
|---|------|------|------------------------------|----------|
| T1 | `core/domain/session/panel-view.ts` + `__tests__/panel-view.test.ts` | PanelView 类型 + derivePanelView 纯函数 + 全组合表测试（含回归用例） | 纯函数零依赖，先行落地即锁定契约，T3 消费 | V5 |
| T2 | `core/domain/new-task-search/flow.ts` | `transition('completed')` 上移到 pushChat 后；`flow.test.ts` 增「send reject 后 state=completed」用例 | 与渲染层解耦的独立行为变更，可单独审查 | V1' |
| T3 | `renderer Panel.vue` | 模板 switch(panelView) 重写 + composer-band 判据简化（删 isSessionActive/isCompacting 兜底）+ renderer 侧输入收集 composable | 渲染层单点消费 T1 契约 | V1/V2/V4 |
| T4 | `renderer Landing.vue` + `useSidebar.ts` | Landing onUnmounted 卸载守卫；deleteSession/deleteFolder 全部 4 处空态出口统一 helper 编排 startFlow（D7） | 兜底出口与空态承接同属「flow 生命周期边界」，可一并回归 | V3/V3' |
| T5 | 全量验证 + 文档 | renderer/core 受影响测试全跑 + lint + `docs/design/.review.md` 归档审查报告 + constraints.json 登记 | 收尾 | 全部 |

**文件改动地图**：`packages/core/src/domain/session/panel-view.ts`（新）、`packages/core/src/domain/session/__tests__/panel-view.test.ts`（新）、`packages/core/src/domain/new-task-search/flow.ts`、`packages/core/src/domain/new-task-search/__tests__/flow.test.ts`、`packages/renderer/src/components/panel/Panel.vue`、`packages/renderer/src/components/new-task/Landing.vue`、`packages/renderer/src/composables/features/sidebar/useSidebar.ts`（D7）、`packages/renderer/src/__tests__/`（Panel 相关测试更新）、`docs/constraints.json`（新约束登记 + `node scripts/render-constraints.mjs` 重新生成 md）。

**待验证检查点**（实施期确认，不猜）：① T3 重写后 `Landing` 渲染条件与现行 `!isSessionActive && isLandingView` 的语义差异——恢复空 session（有 sid 无消息、flow idle）现行走 empty 分支，终态同样 empty（`isFlowActive=false`），需实测确认无行为漂移；② D4 卸载守卫与 Landing 在 overlay 态卸载（如 dir-dialog 打开中切换 session）的时序——`selectSession` 守卫先执行（cancelled），卸载守卫后执行时 `isActive=false` noop，理论安全但需实测。组合表需标注的边界组合：「turn 活跃 + 无消息」（sessionId 非空）终态归 conversation 空白，现行归 else 兜底文案——无功能损害，属吸收现行 `!isSessionActive` 守卫的预期变化。

**约束登记**：本设计新增架构约束「panel 输入面显隐只许经 derivePanelView 派生，禁止组件内直接组合 flow/chat/session 状态」（登记 `docs/constraints.json`，enforcement=review；改 json 后跑 `node scripts/render-constraints.mjs` 重新生成 md）。
