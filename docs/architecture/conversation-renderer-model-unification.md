# 对话流 renderer 模型归一：判别单点化 + 队列子域 + 状态派生归位

> **一句话结论**：「这条消息是什么」的判别从四层各嗅一次收敛为「入口判别一次、下游查表」——`RenderItem.kind` 扩展为全集（turn/systemNotice/bgNotify/bashExecution/gui），MessageStream 退化为 kind→组件纯查表；`display` 可见性判别前置到 effect 写入时；queue 三处分裂收进 `core/domain/chat/queue.ts` 子域；`deriveStatus` 纯函数下 core；turn key 改稳定 id。四包链与 effect 注册表大方向不动，这是归位不是重做。

## §1 背景目标

- **S（情境）**：对话流 renderer 已完成四包重构（ADR-0058：shared ◄ core headless ◄ dom-core ◄ ui ◄ renderer），core 是真 headless 数据层（store 598 行、mutation 集中、effects 注册表），block 渲染已裁决「contentBlocks 顺序 SSOT、禁止末位派生判断」。
- **C（冲突）**：但消息级模型仍停留在「上帝接口 + 每层重嗅」：`Message` 是 20+ 可选字段的单一接口（`shared/message.ts:223-292`），「这条消息是什么」由四个层各自用可选字段重新判别；「排队」状态三处并存；`deriveStatus` 9 态纯函数错放在 renderer；turn key 用 index 导致加载更多后展开态错位。
- **Q（问题）**：怎么把消息判别、队列、状态派生收敛到各自单一权威，而不推翻已落地的四包链与 effect 注册表？
- **A（答案）**：判别归一（RenderItem.kind 全集 + display 前置）+ 队列子域 + deriveStatus 下 core + turn 稳定 key，分步推进，渲染层归一先行（不动存储），存储层 tagged union 留给历史链路统一 converter（`conversation-history-unified-converter.md`）落地后再评估。本文展开这个答案。

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

1. **G1 判别单点**：「这条消息是什么、该不该显示、用什么组件渲染」在数据入口判别一次，下游（分组/过滤/组件分发）只读判别结果，不再嗅可选字段。新增消息类型时改动点可知、可数。
2. **G2 队列一个概念**：「等待中的用户输入」对外只有一个 QueueState——不管来源是 steer/followUp 还是 compact 期间暂存；可取消性是项的属性，不是组件的差异。
3. **G3 派生归位**：纯数据派生逻辑（deriveStatus）在 core headless，可单测、可被 mobile-renderer 复用。
4. **G4 渲染稳定**：加载更多（prepend）后 turn 展开态不错位、virtua 不全量重挂载。

### Scope

- **当前层 → 下一层**：对话流 renderer 模型归位设计 → 模块级实现拆分（§5）。
- **In-scope**：`message-turns.ts`（RenderItem.kind 全集 + display 前置）、`MessageStream.vue`（查表化）、新建 `core/domain/chat/queue.ts`、`sessionStatus.ts` 迁 core、turn 稳定 key、死代码清理（ProgressZone / `message.status` no-op / `sendMode:'send'`）。
- **依赖**：G2（queue 子域）依赖 steer 解耦（`steer-followup-conversation-decoupling.md`）已实施——pending 消息删除后队列才只剩两处可统一。G1 不依赖 steer。
- **Out-of-scope**：存储层 `Message` tagged union 化（等待统一 converter 供料，§3.2 方案 B 论证）；runtime 侧链路（converter 文档范围）；ui 包组件视觉（error 可见性文档范围）；旧 renderer 层 P6 物理删除（已有独立计划）。

## §2 现状与问题分析

**现状是：一条 bg-notify 消息从事件到屏幕，「它是什么」被判别四次；「排队」有三套数据；最该 headless 的纯函数放在了最不该在的层；加载更多一次，展开状态全乱。**

### 2.1 四次判别：bg-notify 的旅程（真实例子）

一条 background subagent 完成通知（pi customType=`subagent-bg-notify`）从事件到屏幕：

1. **registry 判别**（`effects/registry.ts:428` `message.customStart` handler）：按 customType 决定存成 `role:'system' + customType + bgNotify + details + display`；
2. **分组层判别**（`message-turns.ts:51-54` `filterDisplayableMessages`）：`HIDDEN_NOTIFY_CUSTOM_TYPES` 黑名单（`subagent-bg-notify`/`workflow-result`）+ `display===false` 决定**渲染时**藏起来（store 里留着）；
3. **渲染分发判别**（`MessageStream.vue:48-67`）：五分支按 `msg.bgNotify`/`msg.bashExecution`/`details.__gui__`/role 嗅探选组件（BgNotifyCard/BashOutputBlock/GuiComponentRenderer/SystemNotice/Turn）；
4. **组件内判别**（`BgNotifyCard.vue` 按 `bgNotify` 字段结构决定单条/批量形态）。

每层的判别依据都是同一堆可选字段（`customType?/bgNotify?/bashExecution?/details?/display?`），但判别规则各自书写。新增一种 customType 消息时，要在 registry（怎么存）、黑名单（藏不藏）、MessageStream（用谁渲染）三处同步——漏任何一处就是静默错误（渲染错组件或直接消失）。这与已裁决的 contentBlocks「顺序 SSOT、禁止末位派生」精神直接相悖：块级判别已前置（`expandAssistantBlocks` 按 contentIndex），**消息级判别还停留在每层重嗅**。

### 2.2 队列三处分裂

| 排队机制 | 数据结构 | UI | 可取消 |
|---|---|---|---|
| pending 消息（steer 解耦将删） | messages 内（store.ts:257） | UserBubble 虚线框 | 否 |
| pi 队列快照 | `queueStates`（store.ts:87） | QueueBubble | 否（pi 无 clear_queue RPC） |
| compact 暂存 | `compactQueue`（useChat.ts:199-208，模块级 Map） | CompactQueueBadge | 是 |

steer 解耦落地后剩②③：同一「排队等投递」语义，两个数据结构、两个组件、两种能力。用户在 streaming 期间（②生效）与 compact 期间（③生效）看到的排队 UI 行为不一致。

### 2.3 派生错位与 key 不稳

- **deriveStatus 错位**：`renderer/src/composables/logic/sessionStatus.ts:142` 的 `deriveStatus`（9 态优先级链）是纯数据派生——输入全部来自 core chat store（messages/retryStates/isGenerating/isCompacting），零 DOM 依赖，却放在 renderer 包。core 包的「真 headless」目标（ADR-0058）漏了这块最该 headless 的纯函数；mobile-renderer 复用时只能抄。
- **turn key 用 index**：`MessageStream.vue` 的 turn key 为 `t-${turn.index}`，展开态 store（`stores/turn-expansion.ts`）也按 index 记录。load-more prepend 历史后所有 turn.index 偏移 → key 全变 → virtua 视为新列表全量重挂载 + 展开态按旧 index 错配到新 turn 上。

### 2.4 死代码（随本设计清理）

`ProgressZone.vue`（state 恒 null 的死 stub，自隐藏占位）；`message.status` effect（`registry.ts:460` no-op）；`sendMode:'send'`（全仓无写入点，仅类型声明）；`ChatView.vue`（ui 包冒烟壳）与 `MessageStream.vue` 两份「什么进对话流」编排并存——后者随 G1 查表化收敛编排逻辑，ChatView 删除与否随旧层 P6 计划。

## §3 解决方案

**终态：RenderItem.kind 全集驱动 MessageStream 纯查表渲染；`display` 可见性在 registry 写入时定死，分组层只读不判；queue.ts 一个子域对外暴露统一 QueueState；deriveStatus 在 core 被 renderer/mobile 共用；加载更多后展开态原地不动。**

### 3.1 终态（使用者与维护者视角）

**维护者场景：新增一种 customType 消息（如未来的 `goal-update`）**：

```
现状：改 registry（存法）+ HIDDEN_NOTIFY_CUSTOM_TYPES（藏法）+ MessageStream（渲染组件）三处，漏一处静默错
终态：registry 写入时定 kind + display 一次；toRenderItems 按 kind 直通；MessageStream 查表加一行组件映射——改动点 2 处且编译期可查（kind 联合类型未处理时 TS 报错）
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
| **A. 渲染判别归一先行（推荐）** | ✅ 判别单点（入口 kind/display 一次）；存储层不动，风险隔离；与 contentBlocks 哲学一致；为存储层 tagged union 铺路（kind 就是未来的 tag） | 中：message-turns 扩展 + MessageStream 查表 + registry 写入点补 kind/display + 派生/key/队列三个独立小项 | kind 与现有可选字段双写过渡期的同步（靠 TS 联合 + 单测约束）；queue 子域依赖 steer 先落地 | ✅ |
| B. 存储层 tagged union 一步到位（Message 改判别联合，converter/effect 全部改） | ✅ 最彻底（by construction 不可能嗅错） | 大：shared Message 接口拆分 + runtime converter + registry 全部 handler + ui 全部消费方，跨 4 包 | 高：一次大爆炸式改动；且 runtime 的 entry→Message converter 正在另一文档统一中，两条改动线在同一批文件上叠加，冲突面大 | ❌（A 完成后另行评估） |
| C. 维持现状，只修 turn key | ❌ 判别四处分裂、队列分裂、派生错位全部保留 | 最小 | 新增消息类型继续三处同步的静默错误面 | ❌ |

**推荐 A 的理由**：渲染层归一拿到判别单点的全部维护收益，却不碰存储层这个最大风险面；kind 字段先行落地后，未来做存储层 tagged union（方案 B）时只是「把 kind 从冗余字段升格为判别标签」的自然升格——两步走比一步到位每一步都可回滚。queue 子域挂依赖（steer 先落地）是刻意的：pending 消息未删时统一队列会把将死的数据结构也卷进来。

**若用方案 B（§2.1 的例子会怎样）**：四处判别确实消灭了，但同一批文件（converter/registry/Message 类型）上有两条改动线（统一 converter 文档的 mapper 重构 + 本设计的联合拆分）交织，review 与回滚都失去原子性；且 runtime 侧 `Message` 的生产端尚未统一，前端先把类型拆了，等于在移动的靶上开工。

### 3.3 关键设计

#### 3.3.1 RenderItem.kind 全集 + MessageStream 查表化

`message-turns.ts` 的 `RenderItem`（现 `{kind:'turn'} | {kind:'system'}`）扩展为：

```ts
type RenderItem =
  | { kind: 'turn'; turn: MessageTurn }
  | { kind: 'systemNotice'; msg: Message }        // compaction/branchSummary/stream_warn 一行通知
  | { kind: 'bgNotify'; msg: Message }            // BgNotifyCard（bgNotify 字段存在）
  | { kind: 'bashExecution'; msg: Message }       // BashOutputBlock
  | { kind: 'gui'; msg: Message }                 // details.__gui__ → GuiComponentRenderer
```

判别规则（**从 MessageStream.vue:48-67 五分支整体上移**，规则不重新发明）：bgNotify→bgNotify；bashExecution→bashExecution；details.__gui__→gui；role==='system' 其余→systemNotice；user/assistant→turn 分组。`toRenderItems` 输出全集后，`MessageStream` 退化为 `kind → 组件` 纯查表（一个 switch/map，无嗅探逻辑）；`ChatView.vue` 的双编排随之失去存在理由（随旧层 P6 删）。

#### 3.3.2 display 可见性前置

`filterDisplayableMessages` 的 `HIDDEN_NOTIFY_CUSTOM_TYPES` 黑名单（`message-turns.ts:51`）从分组层移除：customType 消息的 `display` 在 **registry customStart handler 写入时**定死（`subagent-bg-notify`/`workflow-result` → `display:false`——现状这两个恰是被藏后又由 BgNotifyCard 特殊消费，统一为 `display:false` + kind:'bgNotify' 直通 BgNotifyCard，不再「先藏再找」）；分组/渲染层只读 `display` 字段，不再按 customType 判别。store 消息保留不变（藏的是渲染不是数据，语义与现状一致）。

#### 3.3.3 queue 子域（`core/domain/chat/queue.ts`，steer 落地后）

```ts
interface QueueItem {
  text: string
  sendMode: 'steer' | 'follow-up' | 'compact-pending'
  cancellable: boolean          // pi 快照项=false（无 clear_queue RPC），compact 暂存项=true
  segments?: Segment[]          // compact 暂存项携带（重发用）
}
// 对外统一只读视图：QueueState = QueueItem[]
```

内部合并两个现存来源：`queueStates`（pi queue_update 快照）+ `compactQueue`（compact 期间前端暂存）。QueueBubble 与 CompactQueueBadge 改为消费同一 QueueState（视觉可合并为一个组件，或保留两个壳但数据源唯一）；取消动作仅对 `cancellable:true` 项可用，不可取消项 hover 明示「等待 agent 投递，暂不可取消」。ADR-0049 分区：queue 状态同样 `Map<sid, QueueItem[]>`，disposeSession 清理挂同一编排。

#### 3.3.4 deriveStatus 下 core

`sessionStatus.ts` 的 `deriveStatus` + `DerivedStatus` 类型 + `DOT_CLASS/STATUS_ICON` 之外的全部纯逻辑迁至 `core/domain/session/`（或 `core/domain/chat/status.ts`）；renderer 侧保留 re-export 与视觉映射（DOT_CLASS 等 CSS 类属展示层）过渡，消费方 import 路径不变。零行为变化——纯搬迁 + 单测随行。

#### 3.3.5 turn 稳定 key

`toRenderItems` 给每个 turn 计算稳定 key：`user?.id ?? assistants[0]?.id`（user 消息的 `u-<uuid>` 由 appendUser 生成）。历史消息与系统消息的 id 是否唯一稳定未逐一核实，由探针 P-id-stable 兜底：若存在无稳定 id 的消息形态，则在 prepend 合并层（mutations.ts）为该消息生成 session 内单调 key 并随消息存储——不推倒 key 方案，只补齐 id 缺口。MessageStream 的 key 与 turn-expansion store 的展开态记录同换。prepend 后旧 turn key 不变，展开态/滚动/DOM 原地保留。

#### 3.3.6 死代码清理

删 `ProgressZone.vue`（state 恒 null）、`registry.ts:460` 的 `message.status` no-op handler（保留事件接收但不注册空 handler——注释标明 pi status 事件语义未用）、`sendMode:'send'` 类型成员（无写入点）。每项独立小 commit。

#### 3.3.7 运行时断言探针清单（准则 7）

| ID | 验证的行为 | 探针 | 状态 |
|---|---|---|---|
| P-id-stable | 所有消息（实时 appendUser/converter 历史/系统消息）都有稳定唯一 id，prepend 合并不产生重复 key | prepend 加载更多后断言 turn key 序列只增不改（旧 key 全保留） | ⛔ 实施期 M5 |
| P-kind-cover | 扩展后的 RenderItem.kind 对现存全部消息形态穷尽（无 fallback 到错误分支） | 真实 session 全量 renderItems 断言 kind 分布与现状五分支一一对应 | ⛔ 实施期 M1 |
| P-display-same | display 前置后渲染可见性与现状逐条一致（黑名单消息仍不可见于流内、BgNotifyCard 仍可见） | 含 bg-notify/workflow-result 的真实 session 渲染对比 | ⛔ 实施期 M2 |
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
- **通过标准**：逐类消息的组件选择、可见性、顺序与改动前一致；BgNotifyCard 仍正常展示

### 场景 3：队列统一视图（回溯 G2，steer 落地后）

- **步骤**：① streaming 期间发 2 条 steer → 队列 UI 显示 2 条（不可取消，hover 有说明）；② compact 期间发 1 条 → 同一队列 UI 显示（可取消），取消后消失
- **通过标准**：两场景同一 UI 同一数据源；能力差异由项属性表达

### 场景 4：派生状态零变化（回溯 G3）

- **步骤**：覆盖 9 态的真实操作矩阵（idle/pending/streaming/waiting/working/compacting/retrying/error/stopped），核对 sidebar 状态点与 header 状态
- **通过标准**：各状态显示与改动前逐一相同

### 场景 5：分屏隔离不回归（回溯 G1/G2 边界）

- **步骤**：分屏两个 panel 各开不同 session，一边 streaming 发 steer，另一边 compact 发消息
- **通过标准**：两边队列/渲染互不串台（ADR-0049 分区语义不变）

## §5 下一层拆分

### 实施路径

| 步骤 | 交付 | 独立验证 |
|---|---|---|
| M1 RenderItem.kind 全集 + MessageStream 查表 | message-turns.ts 扩展 + MessageStream 查表化 | 场景 2 + P-kind-cover |
| M2 display 前置 | registry customStart 写 display + 删分组层黑名单 | 场景 2 + P-display-same |
| M3 deriveStatus 下 core | 纯函数搬迁 + renderer re-export + 单测 | 场景 4 + P-derive-parity |
| M4 queue 子域（**依赖 steer 解耦已落地**） | queue.ts + QueueBubble/CompactQueueBadge 数据源统一 | 场景 3 + P-queue-merge |
| M5 turn 稳定 key | toRenderItems key 生成 + MessageStream/turn-expansion 切换 | 场景 1 + P-id-stable |
| M6 死代码清理 | §3.3.6 三项，独立小 commit | grep 零命中 |

拆分理由：M1/M2 是判别归一主线（kind 先行、display 随后，渲染等价性各自可验）；M3/M5 是独立小项（纯搬迁/纯替换，与主线无耦合可并行）；M4 挂 steer 依赖单独排；M6 放最后防干扰。

### 文件改动地图

| 文件 | 改动 |
|---|---|
| `packages/core/src/domain/chat/message-turns.ts` | RenderItem.kind 全集 + turn 稳定 key 生成；删 HIDDEN_NOTIFY_CUSTOM_TYPES |
| `packages/core/src/domain/chat/effects/registry.ts` | customStart handler 写 display/kind 依据；删 message.status no-op |
| `packages/core/src/domain/chat/queue.ts` | **新建**（M4）：QueueItem/QueueState + 两来源合并 |
| `packages/core/src/domain/session/`（或 chat/status.ts） | deriveStatus + DerivedStatus 迁入 |
| `packages/renderer/src/composables/logic/sessionStatus.ts` | 改 re-export + 视觉映射（DOT_CLASS/STATUS_ICON 保留） |
| `packages/renderer/src/components/panel/MessageStream.vue` | 五分支嗅探 → kind 查表；turn key 切换 |
| `packages/renderer/src/components/panel/{QueueBubble,CompactQueueBadge}.vue` | 数据源换 queue.ts（M4） |
| `packages/renderer/src/components/panel/ProgressZone.vue` | 删除 |
| `packages/renderer/src/stores/turn-expansion.ts` | 展开态 key 随 M5 切换 |
| `packages/shared/src/message.ts` | `sendMode:'send'` 成员删除 |
| 测试 | message-turns/queue/deriveStatus 单测；MessageStream 渲染等价用例 |

### 待验证检查点

1. **kind 与可选字段的过渡同步**：M1 落地后 kind 是「写入时算好存的冗余字段」还是「toRenderItems 每次现算」——倾向后者（现算，单一判定点在 toRenderItems，无存储迁移；探针 P-kind-cover 兜底），实施时确认性能（每 prepend 全量重算可接受，LRU 8 session 上限护航）。
2. **queue.ts 与 steer pendingBuffer 的边界**：pendingBuffer（steer 设计，存 segments 供 drain 时 appendUser）是「待投递暂存」，queue.ts 是「对外展示的队列视图」——两者数据源部分重叠（pi 快照只有 text），实施时裁决 pendingBuffer 是否并入 queue.ts（倾向：pendingBuffer 属 drain 恢复机制留在 store，queue.ts 只读视图聚合，不强行合并）。
3. **mobile-renderer 复用 deriveStatus 的 import 形态**：迁 core 后 mobile-renderer 直接 import core/domain，确认无 DOM 传递依赖混入。
