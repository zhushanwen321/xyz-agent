# 对话流 renderer 模型归一：判别单点化 + 队列子域 + 状态派生归位

> **一句话结论**：现状「这条消息是什么」在生产链路被嗅 3 次（外加一处因黑名单前置过滤而不可达的死分支），判别规则分散且靠 customType 黑名单兜底——收敛为：`RenderItem.kind` 由 `toRenderItems` 单函数现算（全集 turn/systemNotice/bashExecution/gui），MessageStream 退化为 kind→组件纯查表；`display` 可见性前置到 registry customStart 写入时；queue 三处分裂收进 `core/domain/chat/queue.ts` 子域；`deriveStatus` 纯函数下 core；MessageStream slot vnode 加稳定 key 让 prepend 后展开态不错位。死分支（BgNotifyCard）随归一删除。四包链与 effect 注册表大方向不动，这是归位不是重做。

## §1 背景目标

- **S（情境）**：对话流 renderer 已完成四包重构（ADR-0058：shared ◄ core headless ◄ dom-core ◄ ui ◄ renderer），core 是真 headless 数据层（store 598 行、mutation 集中、effects 注册表），block 渲染已裁决「contentBlocks 顺序 SSOT、禁止末位派生判断」。
- **C（冲突）**：但消息级模型仍停留在「上帝接口 + 多处重嗅」：`Message` 是 16 个可选字段的单一接口（`shared/message.ts:223-291`），「这条消息是什么」由生产链路的多个环节各自用可选字段重新判别（registry 透传 display、filterDisplayableMessages 的 customType 黑名单、MessageStream system 分支嗅探），且其中一处分支（`MessageStream.vue:55` BgNotifyCard）因黑名单在 `toRenderItems` 之前已移除该消息、根本不可达，已成死代码；「排队」状态三处并存；`deriveStatus` 9 态纯函数错放在 renderer；turn key 用 index 导致加载更多后展开态错位。
- **Q（问题）**：怎么把消息判别、队列、状态派生收敛到各自单一权威，而不推翻已落地的四包链与 effect 注册表？
- **A（答案）**：判别归一（RenderItem.kind 全集 + display 前置）+ 队列子域 + deriveStatus 下 core + MessageStream 稳定 key，分步推进，渲染层归一先行（不动存储），存储层 tagged union 留给历史链路统一 converter（`conversation-history-unified-converter.md`）落地后再评估。本文展开这个答案。

### 系统是什么

对话流 renderer 数据链（现状已在新四包上）：

```
WS 事件 → core/domain/chat/effects/registry.ts（事件→store mutation）
       → store.messages: Map<sid, Message[]>（shared Message 上帝接口）
       → message-turns.ts（toRenderItems 分组 + filterDisplayableMessages 过滤）
       → MessageStream.vue（5 分支组件分发，virtua 虚拟滚动）
       → Turn.vue / Block 族渲染
```

### 设计目标（从维护者与使用者双向倒推）

1. **G1 判别单点**：「这条消息是什么、该不该显示、用什么组件渲染」收敛到两个单点：kind 由 `toRenderItems` 单函数现算、display 在 registry customStart 写入时前置；下游（组件分发）只读 kind 查表，不再嗅可选字段。新增消息类型时改动点可知、可数。
2. **G2 队列一个概念**：「等待中的用户输入」对外只有一个 QueueState——不管来源是 steer/followUp 还是 compact 期间暂存；可取消性是项的属性，不是组件的差异。
3. **G3 派生归位**：纯数据派生逻辑（deriveStatus）在 core headless，可单测、可被 mobile-renderer 复用。
4. **G4 渲染稳定**：加载更多（prepend）后 turn 展开态不错位、virtua 不全量重挂载。

### Scope

- **当前层 → 下一层**：对话流 renderer 模型归位设计 → 模块级实现拆分（§5）。
- **In-scope**：`message-turns.ts`（RenderItem.kind 全集 + display 前置 + 删 customType 黑名单）、`MessageStream.vue`（查表化）、`registry.ts` customStart 写 display、新建 `core/domain/chat/queue.ts`、`sessionStatus.ts` 迁 core、MessageStream 稳定 key、死代码清理（ProgressZone / `message.status` no-op / `sendMode:'send'` / **BgNotifyCard.vue + MessageStream.vue:55 死分支**）。
- **依赖**：G2（queue 子域）依赖 steer 解耦（`steer-followup-conversation-decoupling.md`）**落地实施**——该文档目前仅是设计（commit `ef40adeed` 标题即「docs: add ... design」），全仓 grep 无 `pendingBuffer`，pending 虚线气泡机制（`store.ts:257` appendPending + core `useChat.ts:383/413` 实时调用）完整存活。pending 消息删除后队列才只剩两处可统一。G1 不依赖 steer。
- **Out-of-scope**：存储层 `Message` tagged union 化（等待统一 converter 供料，§3.2 方案 B 论证）；runtime 侧链路（converter 文档范围）；ui 包组件视觉（error 可见性文档范围）；旧 renderer 层 P6 物理删除（已有独立计划）。

## §2 现状与问题分析

**现状是：一条 bg-notify 消息从事件到屏幕，「它是什么」在生产链路被嗅 2-3 次（外加一处不可达死分支）；「排队」有三套数据；最该 headless 的纯函数放在了最不该在的层；加载更多一次，展开状态全乱。**

### 2.1 多处重嗅 + 一处死分支：bg-notify 的旅程（真实例子）

一条 background subagent 完成通知（pi customType=`subagent-bg-notify`）从事件到屏幕，在生产链路被嗅 3 次（外加一处不可达死分支）：

1. **registry 透传 + 解析**（`effects/registry.ts:425` `message.customStart` handler）：透传 payload 的 `display`（不主动覆写，仅 `payload['display']===true/false ? :undefined` 三态保留），按 customType 解析 `bgNotify`（仅 `subagent-bg-notify` 走 `parseBgNotifyDetails`）。消息以 `role:'system' + customType + bgNotify + details + display` 存入 store；
2. **过滤层黑名单**（`message-turns.ts:75-83` `filterDisplayableMessages`）：`HIDDEN_NOTIFY_CUSTOM_TYPES` 黑名单（`subagent-bg-notify`/`workflow-result`）**无条件**过滤（不看 display 字段），另叠加 `display===false` 过滤。subagent-bg-notify 命中黑名单 → **在 `toRenderItems` 之前即被移除**，永不进 renderItems。`message-turns.test.ts:44` 注释明示设计意图「用户选择不展示通知，即使 display:true 也过滤」；
3. **渲染分发嗅探**（`MessageStream.vue:48-69` system 分支）：按 `item.message.bgNotify`/`bashExecution`/`extractGuiComponent(details)`/role 嗅探选组件（BgNotifyCard/BashOutputBlock/GuiComponentRenderer/SystemNotice）。**但 bg-notify 已在第 2 步被移除，BgNotifyCard 分支（`MessageStream.vue:55`）不可达 = 死代码**（自 edc3a45ba「hide notify」起）；BashOutputBlock 分支（bashExecution，customType 不在黑名单）、GuiComponentRenderer 分支（details.__gui__，E5 协议通用通路）则真实命中；
4. ~~组件内判别~~（BgNotifyCard.vue 按 bgNotify 结构定单条/批量）：死代码，不计入。

问题定性是**维护性**不是性能：每渲染重算 kind 的开销在 LRU 8 session 上限下可忽略，真正的代价是判别规则分散 + 靠 customType 黑名单兜底——新增一种 customType 消息时，要在 registry（怎么存）、黑名单（藏不藏）、MessageStream（用谁渲染）三处同步，漏任何一处就是静默错误（渲染错组件或直接消失，且如 BgNotifyCard 般悄无声息地变成死分支而不报错）。这与已裁决的 contentBlocks「顺序 SSOT、禁止末位派生」精神直接相悖：块级判别已前置（`expandAssistantBlocks` 按 contentIndex），**消息级判别还停留在多处重嗅 + 黑名单兜底**。

### 2.2 队列三处分裂

| 排队机制 | 数据结构 | UI | 可取消 |
|---|---|---|---|
| pending 消息（steer 解耦将删） | messages 内（store.ts:257） | UserBubble 虚线框 | 否 |
| pi 队列快照 | `queueStates`（store.ts:87） | QueueBubble | 否（pi 无 clear_queue RPC） |
| compact 暂存 | `compactQueue`（`composables/panel/useCompactQueue.ts`，模块级单例 + `useSessionScopedState` 分区） | CompactQueueBadge | 是 |

steer 解耦落地后剩②③：同一「排队等投递」语义，两个数据结构、两个组件、两种能力。用户在 streaming 期间（②生效）与 compact 期间（③生效）看到的排队 UI 行为不一致。

### 2.3 派生错位与 key 不稳

- **deriveStatus 错位**：`renderer/src/composables/logic/sessionStatus.ts:142` 的 `deriveStatus`（9 态优先级链）是纯数据派生——输入全部来自 core chat store（messages/retryStates/isGenerating/isCompacting），零 DOM 依赖，却放在 renderer 包。core 包的「真 headless」目标（ADR-0058）漏了这块最该 headless 的纯函数；mobile-renderer 复用时只能抄。
- **turn key 隐式 index**：`MessageStream.vue` 的 `<Virtualizer>` slot **无显式 `:key`**（`<template #default="{ item, index }">` 内的 Turn/SystemNotice 等 vnode 未绑 :key），virtua 按 index 隐式 fallback key（`node_modules/virtua/lib/vue/index.cjs`：`k=(e,t)=>e[0].key ?? "_"+t`）；core 的 `renderKey` 函数（`message-turns.ts:44-46`）定义了 `t-${turn.index}`，但使用者是 ui 包冒烟壳 `ChatView.vue`，MessageStream 并未消费它。展开态 store（`stores/turn-expansion.ts`）按 `Map<number, boolean>`（turnIdx → expanded）记录。load-more prepend 历史后所有 turn.index 偏移 → virta 视为新列表全量重挂载 + 展开态按旧 index 错配到新 turn 上。

### 2.4 死代码（随本设计清理）

`ProgressZone.vue`（state 恒 null 的死 stub，自隐藏占位）；`message.status` effect（`registry.ts:460` no-op）；`sendMode:'send'`（全仓无写入点，仅类型声明）；`ChatView.vue`（ui 包冒烟壳）与 `MessageStream.vue` 两份「什么进对话流」编排并存——后者随 G1 查表化收敛编排逻辑，ChatView 删除与否随旧层 P6 计划。

## §3 解决方案

**终态：RenderItem.kind 全集驱动 MessageStream 纯查表渲染；`display` 可见性在 registry customStart 写入时前置，过滤层只读 display 单字段（不再按 customType 黑名单判别）；queue.ts 一个子域对外暴露统一 QueueState；deriveStatus 在 core 被 renderer/mobile 共用；MessageStream slot vnode 加稳定 key，prepend 后展开态原地不动。**

### 3.1 终态（使用者与维护者视角）

**维护者场景：新增一种 customType 消息（如未来的 `goal-update`）**：

```
现状：改 registry（存法）+ HIDDEN_NOTIFY_CUSTOM_TYPES（藏法）+ MessageStream（渲染组件）三处，漏一处静默错（且如 BgNotifyCard 般悄无声息变成死分支）
终态：kind 由 toRenderItems 现算（从同一堆可选字段，单一判定函数，不落 store）；display 由 registry customStart 写入时前置；MessageStream 按 kind 查表加一行组件映射——改动点收敛为 registry 写 display（仅当需隐藏）+ MessageStream 加映射（仅当需新组件），2 处且无「先藏再找」的等价性陷阱（注意：TS 不提供编译期穷尽性保证——新 customType 无专属组件时静默落 systemNotice 分支，靠 M1 的 kind 一致性单测兜底）
```

**使用者场景：加载更多历史（G4）**：

```
现状：点「加载更多」→ 全部 turn 闪烁重挂载，已展开的 trace 折叠/错位到别的 turn
终态：prepend 后已有 turn 的 key 不变 → 展开态、滚动位置、DOM 全部原地保留，只有顶部新增历史 turn
```

**使用者场景：compact 期间发消息（G2，steer 落地后）**：

```
现状：QueueBubble（streaming 时）与 CompactQueueBadge（compact 时）是两个组件两种能力
终态：同一队列 UI，每条项带来源标记（steer/followUp/compact 暂存）与可取消性（不可取消项明示原因）
```

### 3.2 多方案对比

| 方案 | 长期架构合理性 | 短期实现成本 | 风险 | 裁决 |
|---|---|---|---|---|
| **A. 渲染判别归一先行（推荐）** | ✅ 判别收敛到 toRenderItems 单函数（kind 现算）+ display 前置；存储层不动，风险隔离；与 contentBlocks 哲学一致；为存储层 tagged union 铺路（kind 就是未来的 tag） | 中：message-turns 扩展 + MessageStream 查表 + registry 写 display + 派生/key/队列三个独立小项 | kind 现算与可选字段的同步（靠 M1 kind 一致性单测约束，TS 联合不提供编译期穷尽）；queue 子域依赖 steer 先落地 | ✅ |
| B. 存储层 tagged union 一步到位（Message 改判别联合，converter/effect 全部改） | ✅ 最彻底（by construction 不可能嗅错） | 大：shared Message 接口拆分 + runtime converter + registry 全部 handler + ui 全部消费方，跨 4 包 | 高：一次大爆炸式改动；且 runtime 的 entry→Message converter 正在另一文档统一中，两条改动线在同一批文件上叠加，冲突面大 | ❌（A 完成后另行评估） |
| C. 维持现状，只修 MessageStream key | ❌ 判别多处分裂（含死分支）、队列分裂、派生错位全部保留 | 最小 | 新增消息类型继续三处同步的静默错误面（且死分支悄无声息积累） | ❌ |

**推荐 A 的理由**：渲染层归一拿到判别收敛的全部维护收益，却不碰存储层这个最大风险面；kind 现算落地后，未来做存储层 tagged union（方案 B）时只是「把 toRenderItems 的现算判别升格为存储层判别标签」的自然升格——两步走比一步到位每一步都可回滚。queue 子域挂依赖（steer 先落地）是刻意的：pending 消息未删时统一队列会把将死的数据结构也卷进来。

**若用方案 B（§2.1 的例子会怎样）**：多处判别确实消灭了，但同一批文件（converter/registry/Message 类型）上有两条改动线（统一 converter 文档的 mapper 重构 + 本设计的联合拆分）交织，review 与回滚都失去原子性；且 runtime 侧 `Message` 的生产端尚未统一，前端先把类型拆了，等于在移动的靶上开工。

### 3.3 关键设计

#### 3.3.1 RenderItem.kind 全集（现算派生，不落 store）+ MessageStream 查表化

`message-turns.ts` 的 `RenderItem`（现 `{kind:'turn'} | {kind:'system'}`，字段名 `message`）扩展为：

```ts
type RenderItem =
  | { kind: 'turn'; turn: MessageTurn }
  | { kind: 'systemNotice'; message: Message }   // compaction/branchSummary/stream_warn 一行通知
  | { kind: 'bashExecution'; message: Message }  // BashOutputBlock（system + bashExecution 字段）
  | { kind: 'gui'; message: Message }            // details.__gui__ → GuiComponentRenderer（E5 通用通路）
```

判别规则（**从 MessageStream.vue:48-69 的 system 分支整体上移**，规则不重新发明）：bashExecution→bashExecution；`extractGuiComponent(details)` 命中→gui；role==='system' 其余→systemNotice；user/assistant→turn 分组。**kind 是 `toRenderItems` 每渲染从同一堆可选字段现算的派生值，不落 store**——无存储迁移，单一判定函数；M1 加一致性单测防未来加 Message 字段忘更新判别（§5）。

**为什么没有 `bgNotify` kind**：bgNotify 类消息（subagent-bg-notify/workflow-result）由 registry customStart 写 `display:false`（§3.3.2），在 `filterDisplayableMessages` 阶段即被移除，根本不进 renderItems——没有「先藏再找」的等价性陷阱，也就不需要专属 kind。`toRenderItems` 输出全集后，`MessageStream` 退化为 `kind → 组件` 纯查表（turn→Turn / systemNotice→SystemNotice / bashExecution→BashOutputBlock / gui→GuiComponentRenderer，一个 switch/map，无嗅探逻辑）；`ChatView.vue` 的双编排随之失去存在理由（随旧层 P6 删）。

#### 3.3.2 display 可见性前置（选项 A：维持「不显示」，删死代码）

「完成通知（subagent-bg-notify/workflow-result）对用户是噪声，结果由 agent 后续 turn 体现」是现状语义（`message-turns.test.ts:44` 设计意图），本设计**维持此语义不变**，但把实现从「customType 黑名单兜底」收敛为「display 字段单一判别」：

1. **删黑名单**：移除 `message-turns.ts` 的 `HIDDEN_NOTIFY_CUSTOM_TYPES`（51-58）与 test:44 的 customType 黑名单用例。`filterDisplayableMessages` 只保留 `display === false` 单一判别——display 字段已存在（`shared/message.ts:266`），这是**改写入策略非新增字段**；
2. **display 由 registry 按 customType 业务逻辑写入**：customStart handler（`registry.ts:425`）对 `subagent-bg-notify`/`workflow-result` 这两个**完成通知语义**的 customType 强制写 `display:false`（覆盖 payload 透传——pi 侧 notifier 声明的 display:true 是「未细化」的默认值，前端按消息语义覆写）。**注意与 ADR-0048 的区别**：ADR-0048 拒绝的是「按 extension 名硬编码过滤」，此处覆写依据是 `customType`（消息语义属性，即「这条消息是完成通知」），不是 extension 包名——同一 extension 的不同 customType 可有不同 display 策略。这是在 customType 维度细化 display，不是在 extension 维度硬编码；
3. **删 BgNotifyCard 死代码**：`MessageStream.vue:55` 的 `<BgNotifyCard>` 分支（自 edc3a45ba 起因黑名单前置过滤不可达）+ `packages/ui/src/features/chat/BgNotifyCard.vue` 组件 + 其测试一并删除。可见性从「黑名单 + display 双重」收敛为「display 单一」——这才是判别单点。

**删黑名单后各 customType 去向**（均不孤儿，各有侧信道或被语义过滤）：

| customType | 删黑名单后 | 结果体现通路 |
|---|---|---|
| `subagent-bg-notify` | registry 写 display:false → filter 移除 | 主 agent 被 triggerTurn 唤醒续跑，结果在新 turn 体现（pi-subagent-workflow notifier 发起，见 AGENTS.md 规则 17）|
| `workflow-result` | registry 写 display:false → filter 移除 | event-interpreter 广播 `session.workflows` → 侧栏 workflow 面板（`runtime/test/event-interpreter-workflow-push.test.ts` U2 验证）|
| 其他 customType（goal-context 等） | payload 透传 display（现状 display:false 的 context 消息仍被过滤） | — |
| 带 details.__gui__ 的可见 customType | display!==false → 进 renderItems → kind:'gui' | GuiComponentRenderer（E5 通用通路，删黑名单后对该通路完全生效）|

**闪现不会发生**：display 在 customStart handler 内随 Message 对象一次性写入（`commitMessages` 一次 commit），Vue 响应式批处理保证一次 commit → 一次渲染，不存在「先以 display:undefined 渲染一帧再被改 false」的中间态。

**已知限制（违反规则 7.5，标注待统一）**：display 前置只作用于**实时链路**（registry customStart handler）。历史链路（RPC 路径 `message-converter.ts` + 文件路径 `entry-tree-builder→convertPiHistory`）透传 pi JSONL 持久化的 display——pi 不认识前端写的 display:false（它持久化的是 extension 声明的 display）。重开 session 时可见性可能由持久化值决定而非实时覆写值，导致实时/重开可见性分叉。本设计暂不修历史链路，标注为已知限制，待统一 converter（`conversation-history-unified-converter.md`）落地后由 converter 负责 display 归一（§5 联动项）。

#### 3.3.3 queue 子域（`core/domain/chat/queue.ts`，**依赖 steer 解耦落地实施——当前仅设计、未实现**）

> steer 解耦（`steer-followup-conversation-decoupling.md`）目前是设计文档（零实现，`pendingBuffer` 不存在，pending 虚线气泡机制完整存活）。queue 子域 M4 排在 steer 落地实施之后——pending 消息删除前，强行统一会把将死的数据结构也卷进来。

```ts
interface QueueItem {
  text: string
  sendMode: 'steer' | 'follow-up' | 'compact-pending'
  cancellable: boolean          // pi 快照项=false（无 clear_queue RPC），compact 暂存项=true
  segments?: Segment[]          // compact 暂存项携带（重发用）
}
// 对外统一只读视图：QueueState = QueueItem[]
```

内部合并两个现存来源：`queueStates`（pi queue_update 快照，`store.ts:87`）+ `compactQueue`（compact 期间前端暂存，`composables/panel/useCompactQueue.ts` 模块级单例 + `useSessionScopedState` 分区）。QueueBubble 与 CompactQueueBadge 改为消费同一 QueueState（视觉可合并为一个组件，或保留两个壳但数据源唯一）；取消动作仅对 `cancellable:true` 项可用，不可取消项 hover 明示「等待 agent 投递，暂不可取消」。ADR-0049 分区：queue 状态同样 `Map<sid, QueueItem[]>`，disposeSession 清理挂同一编排。

**flush/取消动作归属（动作不在 core 域）**：`queue.ts` 是纯状态容器（QueueItem[] + 增删），flush/取消的**编排**（调 chatApi.send/steer 发送、取消 compact 暂存项）留在 renderer shell 层——core 域文件不可 import renderer api（`useCompactQueue.flush` 内调 chatApi.send/steer，见 `useCompactQueue.ts` 头注释）。即 queue.ts 暴露状态 + 纯 reducer（add/remove/clear），shell 层读状态后编排发送动作。检查点 2 已裁决 pendingBuffer 边界，此处补裁决动作归属。

#### 3.3.4 deriveStatus 下 core

`sessionStatus.ts` 的 `deriveStatus` + `DerivedStatus` 类型 + `DOT_CLASS/STATUS_ICON` 之外的全部纯逻辑迁至 `core/domain/session/`（或 `core/domain/chat/status.ts`）；renderer 侧保留 re-export 与视觉映射（DOT_CLASS 等 CSS 类属展示层）过渡，消费方 import 路径不变。零行为变化——纯搬迁 + 单测随行。

**消费方清单（M3 落地时 grep 核对 re-export 覆盖）**：迁移前 grep 全仓 `deriveStatus`/`DerivedStatus`，确认 renderer re-export 覆盖全部现有 import 点。已核实消费方：`deriveStatus` 函数（`composables/features/chat/useSessionDerivations.ts:25` 调用 + 测试）；`DerivedStatus` 类型（`renderer/types.ts:16` 定义 re-export 源 + `SessionList.vue`/`SessionItem.vue`/`PanelHeader.vue`/`SessionCard.vue`/`useSessionActive.ts:18`/`useSessionDerivations.ts:26` import）。迁移后 `renderer/types.ts` 与 `composables/logic/sessionStatus.ts` 都需 re-export core 的新路径，保证上述 import 路径零改动。

#### 3.3.5 turn 稳定 key

`toRenderItems` 给每个 turn 计算稳定 key：`user?.id ?? assistants[0]?.id`（user 消息的 `u-<uuid>` 由 appendUser 生成）。历史消息与系统消息的 id 是否唯一稳定未逐一核实，由探针 P-id-stable 兜底：若存在无稳定 id 的消息形态，则在 prepend 合并层（mutations.ts）为该消息生成 session 内单调 key 并随消息存储——不推倒 key 方案，只补齐 id 缺口。

**M5 实现要点**：现状 MessageStream 的 `<Virtualizer>` slot vnode 无显式 `:key`（virtua 按 index 隐式 fallback，见 §2.3）。M5 在 slot 内的 Turn/SystemNotice 等 vnode 上加 `:key="renderKey(item)"`（virtua 尊重子 vnode 的 key，覆盖 index fallback）；`turn-expansion.ts` 的展开态记录从 `Map<number, boolean>`（turnIdx）改为 `Map<string, boolean>`（稳定 key）。两处同换。prepend 后旧 turn key 不变，展开态/滚动/DOM 原地保留。

#### 3.3.6 死代码清理

删：`ProgressZone.vue`（state 恒 null）、`registry.ts:460` 的 `message.status` no-op handler（保留事件接收但不注册空 handler——注释标明 pi status 事件语义未用）、`sendMode:'send'` 类型成员（`shared/message.ts:249` 无写入点）、`BgNotifyCard.vue`（`packages/ui/src/features/chat/`）+ `MessageStream.vue:55` 死分支 + `HIDDEN_NOTIFY_CUSTOM_TYPES` 黑名单（§3.3.2 第 3 步）。每项独立小 commit。

#### 3.3.7 运行时断言探针清单（准则 7）

| ID | 验证的行为 | 探针 | 状态 |
|---|---|---|---|
| P-id-stable | 所有消息（实时 appendUser/converter 历史/系统消息）都有稳定唯一 id，prepend 合并不产生重复 key | prepend 加载更多后断言 turn key 序列只增不改（旧 key 全保留） | ⛔ 实施期 M5 |
| P-kind-cover | 扩展后的 RenderItem.kind（turn/systemNotice/bashExecution/gui）对现存全部消息形态穷尽（无 fallback 到错误分支） | 真实 session 全量 renderItems 断言 kind 分布与现状 live 分支一一对应（BgNotifyCard 死分支不计，已删） | ⛔ 实施期 M1 |
| P-display-same | display 前置后渲染可见性与现状逐条一致（subagent-bg-notify/workflow-result 仍不可见于流内——改由 registry display:false 过滤，语义不变；BgNotifyCard 死代码已删不再渲染） | 含 bg-notify/workflow-result 的真实 session 渲染对比（确认流内不出现，结果经侧信道/续跑体现） | ⛔ 实施期 M2 |
| P-queue-merge | queue.ts 统一视图在 streaming/compact 两场景项数与现状两组件各自计数一致 | dev app 两场景对比 | ⛔ 实施期 M4 |
| P-derive-parity | deriveStatus 迁 core 后 9 态输出与搬迁前逐状态一致 | 单测全状态矩阵 + dev app sidebar/header 状态点视觉核对 | ⛔ 实施期 M3 |

## §4 验收

**改动规模：中（core/renderer 数据流重构，无视觉变更为主）。验收用真实 dev app，非单测非 mock；单测作回归辅助。**

### 场景 1：加载更多不错位（回溯 G4）

- **上下文**：dev app 打开一个 >20 turn 的长 session，展开中部某个 turn 的 trace，滚动到中部
- **步骤**：点顶部「加载更多」注入更早历史
- **通过标准**：已展开 turn 保持展开且内容不变；滚动位置稳定（virtua shift 补偿）；无全列表闪烁重挂载

### 场景 2：消息渲染全等价（回溯 G1）

- **上下文**：同一真实 session（含 bg-notify/bash/compaction 记录/branch 摘要/tool 各形态）
- **步骤**：改动前后渲染对比（截图或 DOM 快照 diff）
- **通过标准**：逐类消息的组件选择、可见性、顺序与改动前一致；完成通知（bg-notify/workflow-result）流内仍不显示（display:false 过滤，结果经主 agent 续跑/侧栏面板体现——与删黑名单前等价），bash/compaction/branch 摘要/tool 各形态渲染不变

### 场景 3：队列统一视图（回溯 G2，steer 落地后）

- **步骤**：① streaming 期间发 2 条 steer → 队列 UI 显示 2 条（不可取消，hover 有说明）；② compact 期间发 1 条 → 同一队列 UI 显示（可取消），取消后消失
- **通过标准**：两场景同一 UI 同一数据源；能力差异由项属性表达

### 场景 4：派生状态零变化（回溯 G3）

- **步骤**：覆盖 9 态的真实操作矩阵（idle/pending/streaming/waiting/working/compacting/retrying/error/stopped），核对 sidebar 状态点与 header 状态
- **通过标准**：各状态显示与改动前逐一相同（分工：idle/pending/streaming/working/compacting 在 dev app 手工视觉核对；retrying/error/stopped 触发成本高且不稳定，由 P-derive-parity 单测全 9 态矩阵兜底，dev app 只做抽样核对）

### 场景 5：分屏隔离不回归（回溯 G1/G2 边界）

- **步骤**：分屏两个 panel 各开不同 session，一边 streaming 发 steer，另一边 compact 发消息
- **通过标准**：两边队列/渲染互不串台（ADR-0049 分区语义不变）

## §5 下一层拆分

### 实施路径

| 步骤 | 交付 | 独立验证 |
|---|---|---|
| M1 RenderItem.kind 全集（现算）+ MessageStream 查表 | message-turns.ts 扩展 kind 全集（turn/systemNotice/bashExecution/gui）+ MessageStream 查表化 + kind 一致性单测 | 场景 2 + P-kind-cover |
| M2 display 前置 + 删死代码 | registry customStart 对完成通知 customType 写 display:false（按消息语义非 extension 名，避开 ADR-0048）+ 删黑名单 + 删 BgNotifyCard 死分支/组件 | 场景 2 + P-display-same |
| M3 deriveStatus 下 core | 纯函数搬迁 + renderer re-export（覆盖全部 import 点）+ 单测 | 场景 4 + P-derive-parity |
| M4 queue 子域（**依赖 steer 解耦落地实施——当前仅设计**） | queue.ts 纯状态 + shell 层 flush 编排 + QueueBubble/CompactQueueBadge 数据源统一 | 场景 3 + P-queue-merge |
| M5 MessageStream 稳定 key | toRenderItems key 生成 + slot vnode 加 :key + turn-expansion Map<number>→Map<string> | 场景 1 + P-id-stable |
| M6 死代码清理 | §3.3.6（含 BgNotifyCard）+ §3.3.2 第 3 步，独立小 commit | grep 零命中 |

拆分理由：M1/M2 是判别归一主线（kind 先行、display 随后，渲染等价性各自可验）；M3/M5 是独立小项（纯搬迁/纯替换，与主线无耦合可并行）；M4 挂 steer 依赖单独排；M6 放最后防干扰。

### 文件改动地图

| 文件 | 改动 |
|---|---|
| `packages/core/src/domain/chat/message-turns.ts` | RenderItem.kind 全集（turn/systemNotice/bashExecution/gui）+ `renderKey` 已存在（:44，M5 让 MessageStream 消费）；删 HIDDEN_NOTIFY_CUSTOM_TYPES + filter 改 display 单一判别 |
| `packages/core/src/domain/chat/effects/registry.ts` | customStart 对完成通知 customType（subagent-bg-notify/workflow-result）写 display:false；删 message.status no-op |
| `packages/core/src/domain/chat/queue.ts` | **新建**（M4）：QueueItem/QueueState 纯状态 + 两来源合并（flush 编排留 renderer shell） |
| `packages/core/src/domain/session/`（或 chat/status.ts） | deriveStatus + DerivedStatus 迁入 |
| `packages/renderer/src/composables/logic/sessionStatus.ts` | 改 re-export（覆盖 deriveStatus + DerivedStatus 全 import 点）+ 视觉映射（DOT_CLASS/STATUS_ICON 保留） |
| `packages/renderer/src/components/panel/MessageStream.vue` | system 分支嗅探 → kind 查表（4 分支）；slot vnode 加 :key；删 BgNotifyCard 分支（:55） |
| `packages/renderer/src/components/panel/{QueueBubble,CompactQueueBadge}.vue` | 数据源换 queue.ts（M4） |
| `packages/ui/src/features/chat/BgNotifyCard.vue` | 删除（死代码，随 §3.3.2 M2） |
| `packages/renderer/src/components/panel/ProgressZone.vue` | 删除 |
| `packages/renderer/src/stores/turn-expansion.ts` | 展开态 Map<number> → Map<稳定key>（随 M5） |
| `packages/shared/src/message.ts` | `sendMode:'send'` 成员删除 |
| 测试 | message-turns（kind 一致性）/queue/deriveStatus 单测；MessageStream 渲染等价用例 |

### 待验证检查点

1. **kind 现算（已裁定，不落 store）**：kind 是 `toRenderItems` 每渲染从同一堆可选字段现算的派生值，不落 store（无存储迁移、单一判定函数）。每 prepend 全量重算开销在 LRU 8 session 上限下可忽略。M1 加 **kind 一致性单测**：构造含各 Message 可选字段（bgNotify/bashExecution/details.__gui__/display 等）的消息，断言 `toRenderItems` 输出的 kind 与现状 MessageStream 分支选择一一对应，防未来加 Message 字段忘更新判别。
2. **queue.ts 与 steer pendingBuffer 的边界**（steer 未实现，本条待 steer 落地后裁决）：pendingBuffer（steer **设计文档**，存 segments 供 drain 时 appendUser——当前零实现）是「待投递暂存」，queue.ts 是「对外展示的队列视图」——两者数据源部分重叠（pi 快照只有 text），待 steer 实施时裁决 pendingBuffer 是否并入 queue.ts（倾向：pendingBuffer 属 drain 恢复机制留在 store，queue.ts 只读视图聚合，不强行合并）。
3. **mobile-renderer 复用 deriveStatus 的 import 形态**：迁 core 后 mobile-renderer 直接 import core/domain，确认无 DOM 传递依赖混入。
4. **display 历史链路可见性分叉（已知限制，待 converter 统一）**：M2 的 display:false 前置只作用于实时链路（registry customStart）。历史链路（`message-converter.ts` RPC 路径 + `entry-tree-builder` 文件路径）透传 pi 持久化的 display，重开 session 时可见性可能与实时不一致（违反规则 7.5）。本设计暂不修——待统一 converter（`conversation-history-unified-converter.md`）落地后，由 converter 负责 display 归一（完成通知 customType 在 converter 侧也写 display:false）。落地前 M2 验收（P-display-same）只覆盖实时链路，重开场景标为已知差异。
