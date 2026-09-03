# composer 模型档位记忆（per-model thinking level memory）

> 一句话结论：在 composer 增加一张 `"provider/modelId" → 最后使用的 UI 档位` 偏好表（renderer KVStorage 持久化），用户显式切换模型时优先恢复记忆档位，无记忆或档位不可用时回落现有对齐逻辑；恢复只挂在用户显式切模型上（armed 六防线门禁），session 切换行为保持不变；landing 新任务的自动初值改为记忆档位优先（无记忆保持最高档，有意的行为变更）。

- 层性质声明：本文档是**技术方案设计**（下一层产物 = 可实现的接口/数据模型/代码任务），§3 按最严格档写（数据模型 / 错误规格 / 物理数据流 / 运行时断言）。
- 状态：待对抗式审查。

---

## §1 背景目标

**用户在 composer 上为每个模型调好的 thinking level 记不住——切走再切回，档位被通用规则重置，必须手动重调。本设计让「切回某模型 = 回到我上次用它时的档位」。**

**SCQA**：

- **S（情境）**：xyz-agent 的 composer 工具条上，用户可为当前 session 选择模型和 thinking level（思考档位）。不同模型能力不同，用户会为不同模型搭配不同档位（如 GLM-5.3 配 max、GLM-5.3-Flash 配 high）。
- **C（冲突）**：现状切模型后档位按通用规则对齐（同体系映射 / 跨体系重置最高档，见 §2），这是一条**纯能力推导规则**——它不知道用户为每个模型用的是什么档位。用户的工作流是「在模型间来回切」，每切一次就要重调一次档位。
- **Q（问题）**：如何记住用户为每个模型最后使用的档位，并在切回该模型时自动恢复？
- **A（答案）**：renderer 本地持久化一张模型→档位偏好表；在现有的模型切换对齐逻辑里前置一个「记忆查询」，命中且可用则恢复，否则走现有规则。改动集中在 core 的 composer 域，runtime 与协议零改动。

**系统是什么**（给不熟悉本仓的读者）：composer 是聊天面板底部的输入区，其工具条上有两个 popover——模型选择（ModelSelectPopover）和思考档位（ThinkingLevelPopover）。选模型/档位经 core 域 composable 编排，通过 WebSocket RPC 落到 runtime → pi，以**回执生效值**写回前端 store（pi 可能钳制档位，显示值恒为真值）。档位有两层概念：

- **UI key**（`ThinkingLevel` 枚举：`off/minimal/low/medium/high/xhigh/max`，popover 上显示的档位名）
- **runtime value**（经模型的 `thinkingLevelMap` 映射后发给 pi 的字符串，如选 max 档实际发 `xhigh`）

展示是 key，传递是 value，两回事——记忆表存 **UI key**（理由见 D2）。

**设计目标**（从使用者体验倒推）：

- **G1 记得住**：在模型 M 上把档位调到 L 后，无论中途切过多少模型，切回 M 时档位自动是 L。
- **G2 跨重启**：重启 app 后 G1 依然成立。
- **G3 不误伤**：记忆恢复只在「我显式切换模型」时发生；切换 session 焦点、打开历史 session 不得因记忆表改写档位；记忆档位在新模型不可用时行为与现状一致（回落通用规则），不出错。

**In scope**：

- composer 三种态（已建 session / landing 未建态 / staging 暂存态）的档位记忆与恢复
- renderer 本地持久化（跨重启）
- 记忆档位不可用时的回落规则

**Out of scope**：

- runtime / shared 协议任何改动（本设计纯 renderer + core）
- 「最后使用的模型」记忆（需求只涉及档位；该能力 runtime 已覆盖——composer 切模型经 `model.switch` 广播 `config.defaults`，且 defaultModel/defaultProvider 的持久化由 pi 侧完成，重启后 landing 默认模型即最后切换的模型，见 §2.2 关键事实 ⑤）
- **session 切换时跨体系档位重置的既有行为**（关联发现：现状从 A 体系模型的 session 切到 B 体系模型的 session 时，sync watch 也会触发并把新前台 session 档位重置到最高可用档——疑似既有边界问题。本设计不改变它，但 armed 门禁（D3）保证记忆恢复不叠加进这条路径。是否修它另行决策）
- 档位记忆的管理 UI（查看/清除入口）
- per-project 维度的记忆（全局一份数据库，理由见 D6）

---

## §2 现状与问题分析

**现状结论：模型切换后的档位由一条「无状态的能力推导规则」决定，用户的档位偏好没有任何持久层，切走即丢。**

### 2.1 使用者视角的现状

用户在 composer 上（已建 session 态）：

1. 点模型 chip → ModelSelectPopover → 选 GLM-5.3；点档位 chip → ThinkingLevelPopover → 选「最高」（max）。
2. 切到 GLM-5.3-Flash：档位 chip 自动变成按规则对齐的值——若 flash 与 GLM-5.3 同体系（可用档集合相同）则映射保持 max；跨体系则跳到 flash 的最高可用档。
3. 用户手动调成 high，用了一段时间。
4. 切回 GLM-5.3：档位再次被规则对齐（**不是**用户上次给 GLM-5.3 设的 max）。用户必须手动重调。

每切一次重调一次——模型来回切换是高频动作，这是持续摩擦。

### 2.2 现有链路（取自代码）

> 注：本文档引用的源码行号均为基线 commit 9de8deb6a 时点，当前 HEAD 行号可能漂移，以符号名为准（引用的符号均仍存在，无悬空标识符）。

模型切换与档位对齐的完整链路（文件均为真实路径）：

```
用户点 ModelSelectPopover 选模型
  → onModelSelect（packages/core/src/domain/composer/model-thinking.ts:160）
      三分支：staging 活跃 → 只写快照 / landing（无 session）→ 记 pendingModel / 已建态 ↓
  → useModel().switchModel（packages/renderer/src/composables/features/model/useModel.ts:48）
  → WS RPC model.switch → runtime → pi
  ← 回执 provider/modelId（生效值，pi 可能静默换模）
  ← sessionStore.applySnapshot(sessionId, { modelId })
  → currentModelId（computed）变化
  → useThinkingLevelSync 的 watch 触发
     （packages/core/src/domain/composer/thinking-level-sync.ts:76-124，
      观察源 = [当前模型 thinkingLevelMap, 当前模型 supportedLevels]）
  → 对齐决策：
      体系相同（isSameThinkingScheme，可用档集合一致）→ 当前档位 key 经新模型 map 换算
      体系不同 → 重置到新模型最高可用档（highestAvailableLevel）
  → onReset(value) → onThinkingSelect → setThinkingLevel RPC → pi
  ← 回执 level（pi 钳制后的生效值，U6：回执写 store，显示恒为真值）
  ← sessionStore.applySnapshot(sessionId, { thinkingLevel })
  → ThinkingLevelPopover 高亮更新
```

关键事实（实施依据，已逐条读源码核实）：

- **档位在链路中统一是 runtime value**：ThinkingLevelPopover 选择时 `emit('select', resolveThinkingValue(opt.level, props.levelMap))`（ThinkingLevelPopover.vue:118），传的是 map 映射后的 value；`sessionStore.thinkingLevel`、landing 的 `localThinkingLevel`、staging 的 `stagingThinking` 存的都是 value。要得到 UI key 需经 `resolveThinkingKey(value, map)` 反查（thinking-levels.ts:125）。
- **可用档唯一权威 = `supportedLevels`**：runtime 能力注册表按 pi 同源计算下发（`ProviderInfo.models[].supportedLevels`），本地不做任何 pi 语义推算（U6 约束，thinking-levels.ts:73 的 `normalizeSupportedLevels` 只做归一）。任何「某档位可用吗」的判定必须查它。
- **RPC 失败不写 store**（U6）：switchModel / setThinkingLevel 失败时显示保持旧真值。
- **对齐规则无记忆**：sync watch 的决策输入只有「切换前后两个模型的 map + supportedLevels」，没有任何用户历史。
- **composer 切模型会更新全局默认模型**：runtime `model.switch` 编排尾部广播 `config.defaults`（source: 'model-switch'），defaultModel/defaultProvider 的持久化由 pi 侧 setModel 完成（packages/runtime/src/services/model-service.ts:93-110）——重启后 landing 态的 fallback 默认模型 = 最后一次切换到的模型。本设计必须与该事实共存：landing 挂载时 sync watch 的「无档位」分支会自动设最高可用档（thinking-level-sync.ts:85-89），若无豁免，该自动值会污染记忆表（对策见 D2）。
- **持久化先例**：renderer UI 偏好已有 KV 范式——SystemSettings 经 `getPlatform().storage`（KVStorage：`get/set/remove` 异步接口，platform/port.ts:12；renderer 注入 LocalStorageAdapter）持久化，key `xyz-agent:system-settings`，损坏数据回退默认值（settings-store.ts:96 `setSystem` + system-storage.ts）。

### 2.3 根因

**档位对齐规则是纯能力推导，缺少「用户偏好」这个输入维度。** 规则本身没错（新模型不一定支持旧档位，必须有对齐逻辑），缺的是一层优先于规则的偏好查询：先问「这个模型用户上次用的是什么」，问不到再走能力推导。根因不是规则写错，是偏好数据不存在。

### 2.4 物理数据流（现状）

```
┌─ renderer ──────────────────────────────────────────────┐
│ ThinkingLevelPopover ← 高亮 ← currentThinkingLevel       │
│                              ↑ applySnapshot(回执值)      │
│ useModel.setThinkingLevel ──RPC──┐                       │
│ useThinkingLevelSync watch ──────┘ 决策输入：map+supported │
│                                     （无用户历史）         │
└──────────────────────────────────┼──────────────────────┘
                                   ↓ WebSocket
                          runtime → pi（真值唯一来源）
                                   
  「模型 → 档位」关联：仅存在于 sessionStore 的运行时状态里，
  无任何磁盘持久化；app 重启或切走模型即丢失。
```

---

## §3 解决方案

**终态一句话：记录 = 档位生效时把 `modelId → UI key` 写入内存 Map + localStorage 写穿；恢复 = 显式切模型时（且仅此时）在现有对齐逻辑前查表，命中且可用则按新模型 map 换算恢复，否则回落现有逻辑。**

### 3.1 终态（使用者视角）

**成功路径**（对应 G1/G2）：

> 用户：在 GLM-5.3 上选档位「最高」（max）。
> 系统：（无感）记忆表写入 `…/GLM-5.3 → max`。
> 用户：切到 GLM-5.3-Flash，手动调档位为「高」（high）。
> 系统：（无感）记忆表追加 `…/GLM-5.3-Flash → high`。
> 用户：切回 GLM-5.3。
> 系统：档位 chip 自动显示「最高」，无需手动调。后端生效档位同步恢复。
> 用户：第二天重启 app，切到 GLM-5.3-Flash。
> 系统：档位自动是「高」。
> 用户：之后再新建任务（landing 页，默认模型 GLM-5.3），不碰档位直接发送。
> 系统：新 session 的档位就是记忆值「最高」——landing 自动初值改为记忆档位（无记忆时保持现状最高可用档），**有意的行为变更**，见 D2。

**边界路径**（对应 G3，每条带用户可见行为）：

> 场景 B1：切到一个**没记忆**的模型（首次使用）。
> 系统：走现有对齐规则（同体系映射 / 跨体系最高档），与现状完全一致。
>
> 场景 B2：记忆档位在新模型**不可用**（如能力注册表变化后 max 不再支持）。
> 系统：回落现有对齐规则，不报错、不发 pi 不支持的档位。
>
> 场景 B3：**切换 session 焦点**（panel 换绑另一个 session）。
> 系统：不做记忆恢复，session 各自档位保持原值，行为与现状一致。
>
> 场景 B4：切模型 RPC 失败。
> 系统：显示保持旧真值（现状 U6 语义），无记忆写入、无恢复。
>
> 场景 B5：staging（fork/handoff 暂存）态切模型。
> 系统：记忆恢复写入暂存快照，不影响源 session；staging 快照不入记忆表（D2 门禁条件 a）；新 session 建立后档位真实生效，照常入记忆表。

失败恢复指引：记忆表数据异常不影响任何主流程——localStorage 里 `xyz-agent:model-thinking-memory` 键损坏时自动按空表启动；用户想清除记忆，DevTools 执行 `localStorage.removeItem('xyz-agent:model-thinking-memory')` 后刷新即可（无管理 UI 前的兜底，见 §4 A6）。

### 3.2 方案对比

**决策一：存储位置**（「模型→档位」表放哪）

| 方案 | 长期架构合理性 | 短期实现成本 | 风险 | 裁决 |
|---|---|---|---|---|
| A. renderer KVStorage（SystemSettings 范式） | 好：UI 偏好归 UI 层，core 域内聚，已有同构先例可循 | 低：一个 storage 模块（~60 行）+ 惰性加载 | localStorage 随 app 实例，不跨设备同步——UI 偏好可接受 | ✅ 采用 |
| B. runtime settings.json + RPC | 过重：runtime 不消费此数据，为 composer UI 偏好扩协议（shared 类型 + handler + configService + 广播）引入长期维护面 | 高：跨 4 个包 | 协议扩散：未来调整表结构要动协议版本 | ❌ |
| C. 纯内存 Map | 差：重启即丢，G2 直接不成立 | 最低 | 目标达不成 | ❌ |

若用 B：本设计的所有改动都要在 shared/runtime/renderer 三层穿一遍协议，而消费方永远只有 composer 一个——§3.1 的所有场景行为不变，但 §1 的「runtime 与协议零改动」优势消失。

**决策二：恢复机制的落点**（在哪里发恢复 RPC）

| 方案 | 长期架构合理性 | 短期实现成本 | 风险 | 裁决 |
|---|---|---|---|---|
| A. 现有 sync watch 内前置记忆查询（单一写入者） | 好：档位对齐保持单一权威点，三态（已建/landing/staging）经同一条 onReset 通路自动覆盖 | 中低：armed 生命周期防线（D3 六规则）+ 记录 watch + D2 双条件门禁，全部收敛在 core 两个文件内 | watch 逻辑复杂度 +1（armed 防线控制，被击穿序列与消灭对应关系见 D3 被否谱系） | ✅ 采用 |
| B. onModelSelect 里另发 setThinkingLevel RPC（双写入者） | 差：switchModel RPC 与记忆恢复 RPC 两个异步写入竞争同一 session 档位，最终态取决于到达顺序 | 中：还要处理与 sync watch 自动对齐的竞争（它仍会在模型变化时触发） | 竞态：对齐逻辑可能覆盖恢复值或反之，顺序不可控 | ❌ |

若用 B：切模型瞬间可能发出两条档位 RPC（对齐一条、恢复一条），pi 端最终档位取决于到达顺序——§3.1 成功路径会随机变成「恢复后又跳走」。

### 3.3 关键决策与权衡

**D1：记忆表存 UI key，不存 runtime value（选定）**
- **采用**：记录时由当前模型的 map 把 value 反查为 UI key（`resolveThinkingKey`），恢复时按**新模型**的 map 把 key 换算为 value（`resolveThinkingValue`）再走 onReset。
- **被否**：直接存 value。value 与模型绑定（GLM-5.3 的 max 档发 `xhigh`，另一模型 max 档可能发 `max`），存 value 跨模型恢复时语义漂移——用户上次选的是 popover 上的「最高」档，恢复的应是新模型的「最高」档，而不是旧模型那个强度的字符串。
- **证据**：key 域恰好就是 `normalizeSupportedLevels` / `highestAvailableLevel` / `isSameThinkingScheme` 的工作域（thinking-levels.ts），可用性校验无需换算；反查/换算函数均已存在且被 popover 使用（ThinkingLevelPopover.vue:96,118）。
- **效果**：G1 的「回到上次用的档位」在语义上是档位名（max/high），不是实现值。

**D2：记录「用户 authored 的已建态生效档位」+ landing 自动初值 memory-aware（选定）**

记录门禁 = 两个条件同时满足才写入记忆表：

- **条件 a（态轴）**：已建 session 态且非 staging 快照——`sessionId 非空 && stagingModel === null`。landing 档位是悬空值不入表；staging 快照是「试选值」（用户在 fork/handoff 暂存态操作，取消退出时不该入表），其生效时点（fork/handoff 新 session 建立）必然进入已建态、由门禁通过后补上。
- **条件 b（来源语义）**：值最终生效于已建 session 即记录，不区分是否用户手动——含用户手动选档、切模型自动对齐、session 加载既有状态。记录时带一行可用性校验（key ∈ 该模型可用集）拦截体系外脏值（见错误规格 E5）。

**landing 自动初值 memory-aware（有意的行为变更）**：landing 挂载时 sync watch「无档位」分支现状自动设最高可用档（thinking-level-sync.ts:85-89），该自动值经首发无条件透传（send.ts:179 透传 `localThinkingLevel` → flow.ts:269,276-277 apply 给新 session）会以「用户从未选择」的身份进入已建态——纯态轴门禁挡不住它（判别轴错位：门禁轴是「态」，污染轴是「值是否用户 authored」）。故 landing 态的自动初值改为 memory-aware：**未 authored 的 local 档位跟随模型变化重设为 `可用(lookup(当前模型)) ?? 最高可用档`**（E3/D5 可用性校验延伸到跟随路径——能力注册表变化致记忆键失效时回落最高档而非显示不可用档；含 defaultModel 晚到的 `'' → 真实模型` 路径——不能依赖 sync `!current` 分支重跑：该分支要求 current 为 undefined，挂载 immediate 触发时已被 `''` 模型消费过一次，defaultModel 到达后 current 已 defined、走「首触发」分支，包装层无介入点）。实现：model-thinking 层设 `localAuthored` 标志（onThinkingSelect 的**用户显式入口**置位；sync onReset 通路指向内部对齐函数、不置位）+ landing 跟随 watch（`sessionId 为空 && !localAuthored` → 重设 local，**`{ immediate: true }` 且模型变化触发**——immediate 覆盖 defaultModel **早到**路径（挂载时模型已就绪且后续不变，非 immediate 则永不触发、auto 值透传覆写 memory），变化触发覆盖**晚到**路径，两路径缺一即间歇性缺陷）。**仅 landing 态生效**——已建但无档位的 session 初值行为保持现状（最高可用档），记忆表绝不主动触碰已建 session（G3）。

- **被否 ①**：只记用户手动选择（初版）——需来源标注，且自动对齐场景「同一路径两次结果不同」，不可预期。
- **被否 ②**：任何态都记录（初版）——landing 挂载自动值确定性污染（§2.2 事实 ⑤ 放大：重启后默认模型即最后切换的模型）。
- **被否 ③**：仅「sessionId 非空」单轴门禁（第 1 轮修复版）——轴错位，击穿反例：landing 自动初值经「新建任务不碰档位直接发送」的默认流程透传进新 session → 已建态记录 watch 触发 → memory 被 auto 值覆写，污染只是从挂载时点换到首发时点，且触发频率更高；同轮发现 staging 态 sessionId 为源 session 非空 id（model-thinking.ts:160-173 staging 分支只写快照、不动 sessionId），单轴门禁对 staging 全程敞开，与 B5/§3.4 图声称矛盾。
- **被否 ④**：保留 auto-init 现状 + 「landing pending 透传值」打标跳过——flow → 记录 watch 的跨模块 authored 标记链路脆弱（「首个快照」判定易碎），且保留「新任务默认最高档」与用户记忆档位的体验割裂；memory-aware 方案同时消灭污染源并让新任务默认档贴合习惯，且实现（authored 标志 + 跟随 watch）收敛在 model-thinking 单文件内，与被否 ④ 的跨模块打标不同构。
- **被否 ⑤**：「memory-aware 初值挂 onReset 包装层，信号 = `localThinkingLevel === undefined`」（第 2 轮初版）——被 defaultModel 晚到路径击穿：挂载 immediate watch 在 defaultModel 到达前消费 `!current` 分支（currentModelId=''、memory[''] miss）→ local 被填 'high'；defaultModel=M 到达后 watch 重触发时 current 已 defined，走「首触发」分支而非 `!current`（'high' 可用时连 onReset 都不调）→ 包装层无介入点 → 自动值经首发透传覆写 memory[M]，MF-A 污染在晚到路径原样复发，且早到/晚到均为活路径（间歇性）。修复 = authored 标志 + landing 跟随 watch（见采用项）。
- **证据**：sync `!current` 分支要求 current 为 undefined（thinking-level-sync.ts:85）+ 首触发分支（:92-99）、send.ts:179 + flow.ts:269,276-277（landing 透传链）、model-thinking.ts:160-173（staging 不动 sessionId）——污染链条每步有源码依据，非运行时未知行为，故升格为设计期决策而非实施期观察项。
- **效果**：G1 延伸到新任务默认档位；G3 完整（staging 取消值、已建 session 初值均不被记忆触碰）；「新建任务不碰档位直接发送」默认流程不再污染记忆表。

**D3：恢复只在用户显式切模型时发生——armed 门禁，生命周期六防线（选定）**
- **采用**：`onModelSelect` 三个分支（staging / landing / 已建）各设一次性标志 `armed = { modelId: 目标复合串, at: 时间戳, callId: 本次调用唯一 id }`。**例外（一致性审查 R1 收编，impl-plan 偏差 #11）**：landing / staging 分支 re-select 同模型跳过 armed 设立——两分支无 RPC、无规则 5「成功清」兜底，按字面实现会留下悬留 token（5s 内 providers 刷新经规则 2 匹配分支覆写用户 authored 值），从源头消灭悬留窗口。消费点在 sync watch 回调**顶部**（先于所有既有分支分发，含「无档位」与「首触发」分支），规则（规则 4/5 及 in-flight 均以 callId 归属校验为前提——并发快速连切时后一次调用覆盖 armed，先回包的调用只允许操作**自己设立**的 token，禁止误清后来者的）：
  1. **过期清**：`now - at > 5s` 且 in-flight 计数为零（in-flight 按 callId 引用计数，per-call 置位/撤销——并发下先回包调用不得提前关闭仍在途调用的豁免窗；5s 为兜底保险丝，正常链路由规则 4/5/6 先行清理）→ 清 armed，走既有分支；
  2. **匹配即消费（含幂等跳过）**：`currentModelId === armed.modelId` → 记忆命中且可用，且换算后 value ≠ 当前档位，则 `onReset(记忆值)` 后直接 return（跳过既有分支，防双重 onReset）；value 相同（幂等）或未命中或不可用，则清 armed，继续走既有分支（回落规则，与既有分支的「value 未变不 RPC」行为对齐）；
  3. **不匹配则保留**：模型尚未到达目标（RPC 在途 / providers 刷新等无关触发）→ 不动 armed，等待匹配触发；
  4. **失败清**：已建态 `onModelSelect` 对 `switchModel` 做 try/catch，RPC 失败立即清除**自己 callId** 的 armed（arm 后被后续调用覆盖时不清除，所有权已转移）；
  5. **成功清**：已建态 `switchModel` 成功返回后，**自己 callId** 的 armed 若仍未被消费则直接清除。微任务次序依据：`applySnapshot` 在 `switchModel` 内同步执行，watch flush 微任务于 applySnapshot 时刻入队，`await` 续段（本规则）晚于 flush——watch 回调总是先跑。故本规则只对「回调未能消费」的路径生效：pi 静默换模（请求 Y 生效 Z，回调以 armed={Y} 判不匹配、既有对齐已处理 Z）与 re-select 同模型（watch 未触发——**仅已建态**经此兜底：landing/staging 分支 re-select 在设立时即跳过，见采用项例外，不存在待清 token）——两者清除后不再残留 armed，杜绝陈旧 token 被后续无关触发延迟消费（chip 突跳伪恢复）；静默换模场景的档位由既有对齐分支负责（语义：恢复只发生在「请求模型 = 生效模型」的常规切换，不迟到恢复）；
  6. **换绑清**：watch `sessionIdRef`，panel 换绑 session 瞬间清 armed（无论 callId 归属——换绑即作废全部未消费意图）——切模型意图绑定发起时的 session，换绑即作废。

  session 切换不设 armed → 走既有逻辑，行为与现状一致。
- **被否 ①**：sync watch 里无条件查记忆——击穿反例：session B1（模型 Y + high）与 B2（模型 Y + low）并存，memory[Y]=high；用户从模型 X 的 session 换绑到 B2 → currentModelId X→Y 触发 watch → 无条件恢复把 B2 的 low 改写成 high（非用户切模型，却改写 session 状态）。
- **被否 ②**：「watch 触发时无论命中与否都清除」的早期消费规则——被三条事件序列击穿：(a) RPC 失败致 armed 残留（旧 E4 语义），用户随后换绑到恰好同模型的 session → 匹配误恢复，被否 ① 的反例经残留绕过门禁；(b) 快速连切 Y→Z，RPC-Y 回包触发「不匹配 → 清除」把 armed=Z 误清 → Z 的恢复静默丢失；(b') 单次切换在途时 runtime 推 `config.providers` 广播刷新 providers 数组（composer-shell.ts:165-180 直读 `settingsStore.providers.value`），watch 观察源引用变化触发无关回调 → armed 被清除 → 恢复丢失；(c) 消费点若放在「model-change 分支」内部，providers 未加载时的「首触发」分支不经过它 → armed 悬空。序列与防线的对应：序列 (a) 由规则 4 消灭；(b)(b') 由规则 3 消灭——**第 4 轮终检回归补注**：规则 5「成功清」引入后，(b) 的重叠窗口内先回包调用的成功清会误清后来者的 token，故 (b) 的消灭依赖规则 4/5 的 callId 归属校验（只清自己设立的 token）；(c) 由消费点位置（分支分发之前）消灭——重演验证通过。第 2 轮复审发现四规则的两条有界残留暴露面，第 3 轮复审进一步击穿其初版修复（成功校正）并定稿：(i) pi 静默换模致 `armed={请求值}` 永不匹配、5s 窗口内换绑到恰为请求模型的 session 误恢复，初版「校正为生效值」又被微任务次序击穿（校正晚于 watch flush，重新武装陈旧 token → 延迟伪恢复）→ 定稿为规则 5「成功清」；(ii) >5s 慢 RPC 回包被规则 1 过期清误杀 → 定稿为规则 1 的 in-flight 豁免（finally 清标志晚于 flush，回包触发的消费在豁免窗内）；re-select 同模型 armed 悬空 → 规则 5 兜住（清除，不再依赖规则 6——规则 6 只覆盖 rebind；R1 修订：此兜底仅已建态需要，landing/staging 分支 re-select 直接跳过设立——见 D3 采用项例外）。
- **证据**：currentModelId 派生自 `sessionState(sessionId).modelId`（model-thinking.ts:110-125）——session 换绑与显式切模型在 watch 眼里是同一信号，必须以 armed 区分意图来源。两条时序基线可分析判定，无需探针：① armed 同步赋值必然先于 watch 回调（Vue 默认 flush:'pre'，watch 回调异步于当前同步任务）；② watch flush 微任务先于 `await` 续段执行（flush 于 applySnapshot 同步时刻入队，续段后入队——规则 5「成功清」的正确性依据）。需探针的是六防线在具体事件序列下的行为（见 §3.3 探针表）。
- **效果**：G3「不误伤」成立（B3 场景行为与现状一致）；恢复不被无关触发或残留吞掉（G1 完整）。

**D4：恢复消费置于 sync watch 回调顶部，保持单一写入者（选定）**
- **采用**：armed 匹配且记忆命中时，在 watch 回调顶部直接 `onReset(记忆档位经新 map 换算的 value)` 并 return——与现有对齐走同一条 onReset → onThinkingSelect 通路；消费先于所有既有分支（「无档位」/「首触发」/「体系判定」），命中时被跳过的分支本次不执行。
- **被否**：见 §3.2 决策二方案 B（双写入者竞态）。
- **证据**：onReset 通路三态统一——已建态发 RPC、landing 态写 `localThinkingLevel`（首发后 apply）、staging 态写快照（model-thinking.ts:176-189），恢复逻辑零额外分支覆盖三态。
- **效果**：§3.1 成功路径 + B5 场景成立；无 RPC 竞争。

**D5：记忆档位不可用 → 回落现有逻辑（选定）**
- **采用**：命中记忆后先校验 key ∈ `normalizeSupportedLevels(新模型 supportedLevels)`，不过则走现有同体系/跨体系规则。
- **被否**：直接发记忆值。可能向 pi 发出它不支持的档位（依赖 pi 钳制兜底 = 把错误交给下游）。
- **证据**：supportedLevels 是可用档唯一权威（U6，§2.2），现有逻辑同样以它为准。
- **效果**：B2 场景行为可预期。

**D6：记忆全局一份，不 per-project / per-session（选定）**
- **采用**：key = `"provider/modelId"` 复合串（与 `SessionSummary.modelId` 同格式），全局单例 Map，多 composer 实例（split panel）共享。
- **被否**：per-project 维度。用户需求未表达项目维度；引入后 key 空间膨胀且「同一模型在不同项目用不同档位」场景罕见。
- **证据**：模型偏好本质是「模型 × 用户习惯」，与项目无关；key 用复合串已排除同名模型跨 provider 歧义。
- **效果**：实现最小；未来若需要 per-project，key 加前缀即可扩展（当前不做，准则 8 减法）。

**运行时行为断言与探针**：

| 断言 | 探针 | 降级路径 |
|---|---|---|
| armed 六防线能区分「显式切模型」与「session 换绑」，且不被无关触发/残留/静默换模击穿 | ⛔ 实施期门：U5 单测覆盖序列族——D3 被否 ② 的 (a)(b)(b') 三序列 + 跨模型换绑基线 + 静默换模（断言既有对齐处理 Z 且**无延迟伪恢复**：armed 清除后无关触发不再消费）+ 慢 RPC（in-flight 豁免下正常消费）+ re-select 同模型（已建态：armed 设立后被规则 5 成功清、无残留；landing/staging：设立即跳过——D3 采用项例外，UF1a/UF1b 锁定）+ 换绑清 + 并发连切 callId 归属（序列 (b) 重叠窗口：第二调用的 armed 存活至自己的回包、第一调用的成功清/失败清不误清）（共 9 断言点），断言 armed 的设立/保留/消费/清除 | 探针失败说明消费规则与 Vue watch 触发时序不匹配，退回 D4 被否谱系重设计恢复落点 |
| landing memory-aware：未 authored 的 local 跟随模型变化重设（**immediate 触发覆盖 defaultModel 早到路径** + 变化触发覆盖晚到路径 `'' → M`，双路径均 memory 命中）；用户显式选择（authored）后不再跟随；已建态不受影响 | ⛔ 实施期门：U5 单测断言跟随 watch 三行为 + D2 反例序列（landing auto 值经首发透传后 memory 不被覆写，**早到/晚到双路径**）+ 幂等往返断言（含非单射 map 归一不动点边界） | 跟随机制不可靠时退回 D2 被否 ④（authored 打标方案）重设计 |
| 记忆恢复后 pi 回执钳制（如记忆 max、pi 实际降为 high）时，记忆表最终收敛为钳制值 | ⛔ 实施期门：U5 单测以回执值驱动记录 watch 断言 | 钳制值本身是「最后生效」语义（D2），无需降级；探针仅验证收敛方向 |
| transient 窗口（模型已变、档位未对齐）的记录不产生错误持久状态 | ✅ 已验证机制成立：记录可用性校验拦体系外值（U6 权威 supportedLevels）；体系重叠拦不住的窗口值，对齐完成后被同一 watch 的后写覆盖；对齐 RPC 失败时残留值 = 失败时刻显示态，忠实于 D2 语义（详见错误规格 E5） | — |

### 3.4 数据模型与终态数据流

**存储**：

- localStorage key：`xyz-agent:model-thinking-memory`（对齐 `xyz-agent:system-settings` 命名）
- 值：`Record<string, string>`，key = `"provider/modelId"` 复合串，value = `ThinkingLevel` UI 枚举值；损坏/非法条目按缺省处理（不抛错不吞错，对齐 system-storage 的 ES2 范式）
- 内存形态：core 模块级 reactive `Map` + 惰性异步预载（首次消费方创建时 fire-and-forget 加载；加载完成前 lookup 返回 undefined，即「无记忆」，自然回落现有规则）

**终态数据流**：

```
┌─ 记录（用户 authored 的已建态生效档位）──────────────────────┐
│ sessionStore.applySnapshot(thinkingLevel)                     │
│   → 记录 watch [currentModelId, currentThinkingLevel]         │
│   → 门禁（D2 双条件）：                                        │
│       条件 a：sessionId 非空 且 stagingModel === null         │
│              （landing 悬空值 / staging 试选值不入表）        │
│       条件 b：已建态生效值（来源不区分，含自动对齐）          │
│   → resolveThinkingKey(value, 当前模型 map) → UI key           │
│   → 校验 key ∈ 该模型 normalizeSupportedLevels                │
│   → memory.set(modelId, key) ──写穿──→ localStorage           │
└──────────────────────────────────────────────────────────────┘
┌─ 恢复（前置查询，仅显式切模型）──────────────────────────────┐
│ onModelSelect → armed = { modelId: 目标复合串, at, callId }   │
│   （landing/staging re-select 同模型跳过设立，见 D3 采用项例外）│
│   已建态：switchModel 失败 → catch 清自己 callId 的 armed     │
│            （规则 4）；成功 → 自己 callId 的 armed 仍未消费   │
│            则直接清（规则 5「成功清」，watch flush 先于       │
│            await 续段——时序依据 D3 证据②；兜住静默换模/     │
│            re-select 伪恢复）                                 │
│            in-flight 按 callId 引用计数：发起置位、finally    │
│            撤销自己份额（规则 1 过期判定的豁免窗，E10）       │
│ watch sessionIdRef 换绑 → 清 armed（规则 6，不分归属）        │
│ currentModelId 变化 → sync watch 回调顶部（先于所有分支）：    │
│   ① armed 过期(>5s 且 in-flight 计数为零) → 清，走既有分支    │
│      （规则 1）                                               │
│   ② currentModelId === armed.modelId →                        │
│        命中且可用且 value≠当前 → onReset(记忆值) → return     │
│        幂等 / 未命中 / 不可用 → 清 armed → 走既有分支（规则 2）│
│   ③ 不匹配（RPC 在途 / providers 刷新）→ 保留 armed（规则 3） │
│   → onReset → onThinkingSelect →（三态各自通路）              │
└──────────────────────────────────────────────────────────────┘
```

**错误规格表**（每条配恢复行为）：

| # | 边界/错误 | 处理 | 用户可见行为 |
|---|---|---|---|
| E1 | KV 读失败 / JSON 损坏 | 空表启动（对齐 system-storage ES2：catch 回退，不抛不吞） | 无记忆，全部回落现有规则 |
| E2 | KV 写失败 | console.warn，内存表继续生效（写穿失败不回滚内存） | 本次运行内记忆可用，重启后丢；无其他影响 |
| E3 | 记忆档位不在新模型可用集 | 回落现有体系规则（D5） | 与现状一致 |
| E4 | 切模型 RPC 失败 | store 不写（U6 现状）；armed 由 onModelSelect 的 catch 立即清除（D3 规则 4） | 显示保持旧真值；无 armed 残留，后续 session 换绑不受影响 |
| E5 | transient 窗口记录（模型已变、档位尚未对齐，且新旧模型体系重叠时可用性校验拦不住） | 对齐完成后的记录覆盖（同一 watch 后写胜出）；对齐 RPC 失败时残留值 = 失败时刻的显示态（store 未写、旧值持续显示），忠实于 D2「最后生效」语义 | 无正确性影响：残留值与用户当时看到的显示一致，用户下次调档即更新。注：「再次使用即自我纠正」不成立（恢复 → 显示 → 再记录同值，自我复制），该说法已废弃 |
| E6 | KV 中非法档位值（非 `ThinkingLevel` 枚举） | `isThinkingLevel` 校验，丢弃该条 | 无感知 |
| E7 | 惰性加载完成前（lookup 返回 undefined）：① 切模型；② 跟随 watch 的初值/重设时点（landing memory-aware 查询落在 KV 加载前，此后加载完成不再触发重设） | ① 走现有规则；② memory 加载完成回调补一次「仍 !authored && landing → 重设」（消灭窗口，成本一行） | ① 仅 app 启动后首几百毫秒内的切换无记忆；② 若无补写回调，用户在毫秒级窗口内不碰档位直接发送才会以 auto 值覆写 memory——已有加载回调兜底，不发生 |
| E8 | 恢复值被 pi 钳制 | 回执生效值写 store（U6 现状）→ 记录 watch 把记忆更新为钳制值 | popover 显示真值；下次恢复钳制值（「最后生效」语义，D2） |
| E9 | pi pattern 静默换模（请求 Y 实际生效 Z，事故 A 形态） | watch 回调先以 armed={Y} 判不匹配（规则 3 保留），既有对齐分支处理 Z 的档位；规则 5「成功清」随后清除未消费的 armed——无陈旧 token 残留 | Z 得到既有规则的档位（不迟到恢复）；不会出现后续无关触发导致的延迟伪恢复（chip 突跳） |
| E10 | 慢 RPC（>5s）成功回包 | 回包触发的 watch 消费在规则 1 的 in-flight 豁免窗内（finally 清标志晚于 flush 微任务——时序依据见 D3 证据②）→ 正常匹配消费 | 恢复正常执行，仅延迟；弱网下 G1 不降级 |

---

## §4 验收

**验收方式：`pnpm dev` 起真实 app（真实 runtime + pi），browser-automation skill 连 `http://localhost:9222` 在真实 composer 上操作并断言 popover 显示；单测（U5）只作为实施期门禁，不作为验收。** 每个场景标注回溯的 §1 目标。

**A1 基础记忆恢复（G1）**

- 场景：同一 provider 下两个模型（如 `builtin:bigmodel-coding-plan/GLM-5.3` 与 `GLM-5.3-Flash`，以实施环境实际可用模型为准）。
- 步骤：① 新建 session，模型选 GLM-5.3，档位手动调到「最高」；② 切到 GLM-5.3-Flash，档位调到「中」（**刻意避开默认五档 auto-init 值 high**——期望值若与自动初值碰撞，污染/失效会被巧合通过掩盖）；③ 切回 GLM-5.3；④ 切到 GLM-5.3-Flash。
- 通过标准：③ 档位 chip 显示「最高」；④ 显示「中」；**后端真值双断言**——两次切换后从 runtime 侧确认 thinkingLevel 生效值与 UI 一致（`XYZ_AGENT_DEBUG=1` 查 `~/.xyz-agent/logs/` 下 pi-*.jsonl 的 setThinkingLevel 帧值，或 WS 抓 state_changed 帧的 thinkingLevel 字段）；向 pi 发消息正常响应。

**A2 跨重启持久（G2）**

- 步骤：接 A1 状态（memory 中 GLM-5.3=最高、GLM-5.3-Flash=中），完全退出并重启 `pnpm dev`，然后验证两条操作路径**均应通过**：(a) landing 内**先切到 GLM-5.3 再切回 GLM-5.3-Flash**再发送首条消息（重启后 defaultModel=最后切换的 Flash，landing 已在 Flash 上——直接「切到 Flash」是同模型 re-select，armed 链路全程不参与，测不出恢复；先切走再切回让 armed 消费真实参与）；(b) 直接发送建 session（默认模型 Flash + memory-aware 初值「中」）后再显式切模型到 GLM-5.3 再切回 Flash。
- 通过标准：两条路径下最终档位均为「中」（≠ auto-init 默认 high，污染可检测）；路径 (a) 中切回 Flash 后档位 chip 即显示「中」；`localStorage['xyz-agent:model-thinking-memory']` 中有对应条目。

**A3 负面：session 切换不触发恢复（G3）**

- 场景构造要点：切换的两个 session 必须**模型不同且同体系**（跨模型换绑才触发 sync watch——同模型双 session 的 map/supported 不变，watch 根本不触发，测不出守护目标；同体系约束是因为跨体系换绑本身会触发既有对齐重置（§1 Out of scope 既有行为），会使「S2 档位保持原值」因与本设计无关的原因失败）；且记忆表中目标模型的记忆值 ≠ 前台 session 的实际档位。
- 步骤：① 建 session S1（模型 X + 档位 low）；② 建 session S2（模型 Y + 档位 high）；③ 建 session S3，用模型 Y + 档位「中」（使 memory[Y] = 中）；④ 焦点从 S1 切到 S2（侧边栏点击），来回数次。
- 通过标准：每次切换后 S2 档位保持「高」，不被记忆值「中」改写（若无 armed 门禁，此序列会把 S2 改成「中」，可检测）；S1 档位保持「低」。

**A4 不可用回落（G3）**

- 步骤：① DevTools 人工改写 localStorage 记忆条目为某模型不支持的高档位（如 `{"<modelId>": "max"}`，模型 supportedLevels 不含 max）；② **刷新页面**——记忆表惰性预载入内存 Map，不刷新则内存旧值遮蔽改动（对齐 A6 的刷新范式）；③ 切到该模型。
- 通过标准：不报错、不发非法档位 RPC，档位行为与现有对齐规则一致（同体系映射/跨体系最高档）。

**A5 三态覆盖（G1 × in-scope 三态）**

- 步骤：① landing 态（新任务页）切模型到有记忆的模型 → 发送首条消息 → 检查新 session 档位；② 对活跃 session 进入 fork/handoff 暂存态 → 切模型 → 观察 chip → 发送 → 检查新 session 档位。
- 通过标准：landing 首发后新 session 档位 = 记忆值；staging 发送产生的新 session 档位 = 暂存态记忆恢复值；源 session 档位不受影响。

**A6 记忆清除兜底（G3 的可恢复性）**

- 步骤：DevTools 执行 `localStorage.removeItem('xyz-agent:model-thinking-memory')` 后刷新，重复 A1 ①②。
- 通过标准：行为回到「无记忆」基线（切模型走现有规则），无残留异常。

---

## §5 下一层拆分

**实施路径：U1→U2→U3→U4 为依赖序（每步可独立跑单测），U5 全程伴随；完成后统一走 §4 验收。**

| 单元 | 内容 | 文件 | justification |
|---|---|---|---|
| U1 记忆存储模块 | reactive Map + 惰性加载 + record/lookup API + KV 写穿 + E1/E6 防护；KVStorage经 `getPlatform().storage` | 新增 `packages/core/src/domain/composer/model-thinking-memory.ts` | 独立纯模块，可先行单测（KV round-trip / 损坏回退 / 非法值丢弃）；放 composer 域因唯一消费方是 composer 行为，机制上仅依赖 platform/port（core 内合法依赖） |
| U2 sync 扩展 | `ThinkingLevelSyncDeps` 增 `getRememberedLevel(modelId)`；watch 回调顶部 armed 消费（过期/匹配幂等/保留 + 分支跳过，D3 规则 1-3）+ 记忆查询（D5） | `packages/core/src/domain/composer/thinking-level-sync.ts` | 恢复逻辑的唯一落点（单一写入者）；deps 注入保持 core 零 store 依赖（W3 迁移约束延续） |
| U3 model-thinking 扩展 | `onModelSelect` 三分支设 armed（含 callId；landing/staging re-select 同模型跳过设立——D3 采用项例外；已建态 RPC 失败清 + 成功清均按 callId 归属校验，规则 4/5；in-flight 按 callId 引用计数，规则 1）；watch `sessionIdRef` 换绑清（规则 6）；landing memory-aware：`localAuthored` 标志（用户显式入口置位，onReset 指向内部对齐函数）+ 跟随 watch（immediate + 变化触发，D2）；记录 watch（D2 双条件门禁 + 可用性校验）；对外暴露不变 | `packages/core/src/domain/composer/model-thinking.ts` | armed 的意图源头与生命周期防线集中在显式切换动作处，与恢复消费点分离；对外 API 零变化，composer-shell 接线面最小 |
| U4 壳层接线（已由 U3 域内收编） | 实施演化：sync 四个新 deps 与 loadOnce/onLoaded 触发全部在 U3 的 model-thinking 内部闭合（同域 import u1 模块），`ModelThinkingDeps` 对外签名零变化，composer-shell 零改动——本单元退化为验证性验收（renderer typecheck + 测试回归） | `packages/renderer/src/composables/panel/composer-shell.ts`（零改动） | 壳层是 core deps 的唯一组装点（ADR-0028 分层），接线不外溢壳层是更内聚的演化；实施记录见 impl-plan 偏差 #10 |
| U5 测试 | U1 模块单测；U2/U3 行为单测（armed 9 断言点序列族含 callId 并发归属、landing memory-aware 跟随三行为 + 污染反例含 defaultModel 早到/晚到双路径 + 幂等往返含非单射边界、记忆命中/回落、三态 onReset 路由、D2 双条件门禁、钳制收敛）——实施期门（§3.3 探针）；框架 vitest、子包目录运行 | `model-thinking.test.ts` 扩展 + 新增 `model-thinking-memory.test.ts` | 现有测试文件就近扩展，覆盖 §3.3 前三条探针断言 |

**待验证检查点**（设计阶段无法确定，实施期核实）：

1. armed 六防线在具体事件序列下的实际行为（探针表第一行的 8 序列族 U5 单测）——两条时序基线（armed 赋值先于 watch 回调；flush 先于 await 续段）已由 Vue flush:'pre' + 微任务入队次序分析判定成立（D3 证据①②），探针火力对准序列行为而非时序本身
2. 实施环境的真实模型对 supportedLevels 是否同体系（决定 A1 中「切 flash 时无记忆首切」的落点表现，不影响断言本身）
3. **defaultModel 早到/晚到双路径的 landing 初值**（设计变更条目，非观察项）：两条到达顺序均为活路径（AppShell 渲染与 initial-state 推送相对次序不保证），D2 的 authored 标志 + 跟随 watch（immediate + 变化触发）是为此设计——U5 必须覆盖「早到 + memory 命中」（挂载时模型已就绪，immediate 跟随重设）与「晚到 + memory 命中」（挂载 `''` 消费 `!current` 分支 → M 到达 → 跟随 watch 重设 memory[M]）**两条序列**，缺一即间歇性污染不可检测

**关联既有行为登记**（本设计不修，防止实施期误判归因）：

- session 换绑跨体系时 sync watch 的档位重置为既有行为（§1 Out of scope）；armed 门禁保证本设计的记忆恢复不叠加到该路径，A3 场景同时守护这一点。
- **退出暂存态（exitStagingMode）**：staging 模型 ≠ 源 session 模型时退出，currentModelId 回切源模型 → sync watch 以「staging 模型的 map」为 oldMap 触发 model-change 分支，可能对源 session 发出多余 onReset RPC（既有潜在行为，非本设计引入）。本设计在该路径不设 armed（退出暂存不是切模型）→ 记忆恢复不叠加；记录 watch 会在回切后记录（源模型, 源档位）——源 session 真值，无污染。实施期若观察到该路径行为异常，归因既有逻辑，勿误判为本设计引入。
