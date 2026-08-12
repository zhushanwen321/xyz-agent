# 对话流失败可见性与进行态信噪比：error=danger 新裁决 + thinking 可收起

> **一句话结论**：把失败表达从「中性灰」升级为「danger 红」接入对话流本体三处（session error 消息 danger 化、failed tool danger header、failed 默认展开错误输出），thinking working 态从「强制展开禁收」改为「默认展开可收起 + 完成态回落」，TurnMeta working 态文案「思考中」归正为「工作中」——失败一眼可辨、进行态信噪比可控，已完成态的两级折叠骨架不动。
>
> **本设计与 v6 spec 的关系**：本设计**偏离** v6-master-spec `:444`「通用（全场景）：工具失败（exit≠0）→ 图标统一 `--neutral-ico`，行尾加 mono `exit N` 中性标签」这一已裁决条款。现状（failed tool 中性灰）与该条款**一致**，本设计是在提出**新裁决**——理由：失败优先可见 > 中性一致性。spec 联动修订见 §5。

## §1 背景目标

- **S（情境）**：xyz-agent 的用户是后端/系统方向开发者，每天 6 小时以上监控长任务（一个 turn 跑 12 分钟、26 段思考 + 26 个工具调用是日常）。设计体系在**状态指示器**层面裁决了「error=danger」（v6 spec `§5.6B:437` 的非列表主行 7px 圆点：GitPanel 行级状态等，error=`--danger`），并在 TurnRail turn 节点落地（failed turn 图标常驻 `text-danger`，TurnRail.vue）；design tokens 的 danger 通道完整（`--danger:#bf6b6b`、`--danger-soft:12% 软底`）。
- **C（冲突）**：但 spec 对**对话流本体的 tool 失败**另有一条「全场景中性」裁决（`v6-master-spec:444`：图标统一 `--neutral-ico`、行尾加 mono `exit N` 中性标签），且现状代码（`Block.vue` `toolStatusClass` 的 failed 分支 `text-neutral-mid`）与该条款一致。后果是：对话流本体的失败表达**失声**——session 级 error 消息渲染为普通正文（无图标、无 danger 色）；failed tool 默认收起且 header 仅中性灰；全对话流里失败可发现性只剩 TurnRail 一处红标，且只覆盖 tool 失败（session error 连 rail 都不标）。同时 streaming 态（用户最常盯的场景）thinking **强制展开禁收起**，每段 thinking 的预览行累积为噪音。
- **Q（问题）**：spec 的「中性一致」裁决与「失败优先可见」的用户诉求冲突时怎么取舍？怎么让失败在对话流里一眼可辨、进行态信噪比交给用户控制，而不破坏已完成态的折叠骨架？
- **A（答案）**：本设计裁决「失败优先可见 > 中性一致」，danger 通道接入对话流本体三处（error 消息 / failed tool header / failed 默认展开）+ thinking working 态允许手动收起（完成态回落）+ TurnMeta working 文案归正。代价：偏离 spec 全场景中性条款（需联动修订 spec，见 §5）。本文展开这个裁决。

### 系统是什么

对话流（`packages/ui/src/features/chat/` + `packages/renderer/src/components/panel/MessageStream.vue`）按 turn 渲染：user 气泡 + assistant trace（thinking/tool/text 块）+ 正文。折叠策略两级：**turn 级**（非活跃 session 整 trace 折叠为 TurnMeta 一行）、**块级**（trace 内 thinking/tool 默认收起一行，点击展开）。本设计只动块级视觉与三处文案/交互，不动 turn 级折叠。

### 设计目标（从使用者体验倒推）

1. **G1a 失败可辨**：滚动对话流时，tool 失败与 session 错误不需要点击、不需要看 rail，在流内即可被 danger 色 header 直接定位——streaming 进行中与回开态均达成（header 是 computed，响应 status 变化）。
2. **G1b 错误输出直达**：失败工具的错误输出（stderr/错误详情）无需点击即可见——回开态达成（终态挂载默认展开），**streaming 场景打折**（块在 running 态挂载固化为收起，失败后保持收起，见 §3.3.1 决策；turn 结束后重开/重挂按终态展开）。
2. **G2 进行态信噪比可控**：streaming 中用户可以收起 thinking 块（默认仍展开，保留「agent 活着」的感知），收起权在用户。
3. **G3 已完成态骨架不动**：非活跃 turn 折叠、块级默认收起、TurnMeta 聚合计数——现状良好的部分零变化。thinking 在 turn 完成后回落收起（恢复骨架），用户手动收起过的块保持收起。
4. **G4 视觉体系一致**：只用 tokens 已有的 danger/warn 通道；不引入 side-stripe 彩色边条（绝对禁令）、不引入饱和色、与 rail 的 danger 语义一致（同一种红，同一个含义）。

### Scope

- **当前层 → 下一层**：对话流失败/进行态 UI 行为规格 → 组件级实现拆分（§5）。
- **In-scope**：`Block.vue`（tool failed 视觉 + thinking 收起交互 + 完成态回落）、session error 消息渲染分支（含追加形态边界）、`TurnMeta.vue` 文案 + i18n。
- **Out-of-scope**：runtime 层 error 产生与广播逻辑；derivedStatus 9 态；toast 通知体系；QueueBubble/排队 UI；UserBubble。

## §2 现状与问题分析

**现状是：spec 在「对话流 tool 失败」上裁决了中性（与现状一致），但这个中性裁决在长任务场景下损害了失败可发现性；而用户最常盯的 streaming 态，恰好是折叠策略唯一失效的场景。本设计是提出偏离该中性裁决的新裁决，不是执行遗漏。**

### 2.1 使用者视角的现状（真实例子）

**场景甲：失败找不着。** 一个 12 分钟的长任务 turn（思考 ×26 · 工具 ×26），其中第 18 个工具调用失败了。用户滚屏回看：26 个工具块全是同样的中性灰单行 header（`bash · ssh carbon "..."`），失败的那个混在里面没有任何颜色差异；错误输出（stderr）默认收起着，要逐块点击才能看到。session 级错误（如模型流中断后 `markSessionError` 插入的错误消息，`core/domain/chat/store.ts` markSessionError）渲染为普通正文文本，滚过时与 assistant 正常输出无法区分。唯一的失败线索在右侧 TurnRail 一个 12px 图标上——且仅当失败来自 tool 时才有。

**场景乙：streaming 被过程噪音淹没。** 用户配置 thinking level「最高」，发了一个复杂任务。streaming 进行中，每段 thinking **预览行无法收起**（`Block.vue` thinking 分支：working 态 `toggleThinking` 提前 `return` 禁收起；working 态虽只渲染 `PREVIEW_LIMIT=60` 截断预览，不是全文），26 段 thinking 各占一行 ≤60 字预览，长任务下累积为噪音，assistant 正文和工具调用被挤；TurnMeta 行显示「思考中 12m 46s」sticky 贴顶——但 12m46s 里大部分时间在跑工具，不在「思考」。

### 2.2 根因分析

**根因：折叠与状态色策略是按「消息类型」设计的（thinking/tool 怎么折、什么色），没有按「会话生命周期 × 用户注意力」设计（进行中最该盯什么、失败后怎么找到）。**

- **失败失声**：`Block.vue` `toolStatusClass` 的 failed/unfinished 同为 `text-neutral-mid`；`toolCollapsed` 注释明确「failed 不再强制展开」（摘要行已含错误状态色）；session error 消息无专用分支，走普通 text 渲染。`--danger` 通道在设计体系里存在、在 rail 里已用（§5.6B:437 状态指示器层面），但 spec `:444` 全场景条款**明确要求对话流 tool 失败用中性**——所以现状不是「执行遗漏」，是「spec 规定如此」。本设计的论点是：spec 的中性裁决在失败可见性上是错的，失败优先可见应优先于中性一致。
- **进行态失控**：working 态强制展开 thinking 的意图可理解（streaming 时让用户看到 agent 在推理，感知「活着」），但「禁止收起」（`toggleThinking` 的 `if (props.working) return` 提前 return）把善意变成了强制——长推理模型（用户实配「最高」档）下 26 段预览行累积是重灾区。
- **文案错配**：`TurnMeta.vue` working 态复用了 `panel.message.thinking`（「思考中」）文案，其后的 elapsed 是 **turn 已进行时长**，不是思考时长。

## §3 解决方案

**终态：失败的工具调用在流内是红色 header，turn 结束后/历史重开时默认展开错误输出；session 错误消息带 danger 图标与配色；streaming 中 thinking 可收起（默认展开，完成态回落）；TurnMeta working 态显示「工作中 12m 46s」。**

### 3.1 终态（使用者视角）

**场景甲（失败后回看，G1）**：

```
[12 分钟 turn 完成，含 1 个失败 tool]
  → 滚屏时：失败工具块的 header 图标与工具名为 danger 红（与 rail 同一种红），
    且该块默认展开——错误输出（stderr/错误详情）直接可见，无需点击
  → session 级错误消息：AlertCircle 图标（text-danger）+ 正文 text-danger，扫过即辨
  → 其余 25 个成功工具块保持中性灰单行收起（G3 不动）

[streaming 进行中第 18 个工具失败]（G1 打折场景，诚实声明）
  → 失败工具块的 header 图标与工具名立即变红（header 是 computed，响应 status）
  → 错误输出仍收起（toolCollapsed 是 mount 快照，running→error 不触发重挂，见 §3.3.1）
  → turn 结束后该 session 重开/重挂时，失败块按终态默认展开
```

**场景乙（streaming 长推理，G2）**：

```
[thinking level「最高」任务 streaming]
  → thinking 块默认展开（「活着」感知保留，working 态 collapsed 初值 false）
  → 用户点击某段 thinking 的 toggle → 该段收起为一行预览；后续新 thinking 块仍默认展开
  → turn 完成后：未手动收起的块回落收起（恢复 G3 完成态骨架）；手动收起过的保持收起
  → TurnMeta：「工作中 3m 12s」（文案归正；sticky 行为不变）
```

**失败路径**：thinking 收起/展开是纯本地交互，无失败面；error 视觉分支渲染异常时降级为现状（普通正文），不阻断对话流。

### 3.2 多方案对比

| 方案 | 长期架构合理性 | 短期实现成本 | 风险 | 裁决 |
|---|---|---|---|---|
| **A. danger 全套接入（推荐）** | ◐ **偏离** v6 `:444` 全场景中性条款的新裁决（理由：失败优先可见 > 中性一致）；需同步修订 spec 全场景条款 + §6.1 Block·tool 矩阵 + 裁决 exit-N 标签去留（见 §5） | 小：Block.vue 分支 + TurnMeta i18n + error 消息分支，全部在 ui 包内 | streaming 中失败的工具只 header 红、错误输出收起（G1 打折，见 §3.3.1）；默认展开只在历史 session 重开/turn 终态挂载生效，**不破坏 streaming 跟底**（streaming 中失败不触发任何展开，无跳动） | ✅ |
| B. 仅图标不加色（error/failed 加 danger 图标，文字保持中性） | ◐ 与 `:444` 中性条款冲突较小但未消除：12px 灰红图标在 26 块灰行里仍需逐行扫 | 更小：只加图标 | 长期：失败仍然不够显眼，问题半解决 | ❌ |
| C. 顶部 banner / toast 强化 | ❌ 违反项目规则「错误作为 assistant 消息插入对话流，不用顶部 banner」；banner 是瞬时的，回看场景（场景甲）无解 | 中：新增通知通道 | 与对话流消息双表达 | ❌ |

**推荐 A 的理由**：失败可见性在长任务回看场景下是真实痛点（场景甲），spec `:444` 的「中性一致」裁决在失败这一高价值信号上是错的取舍——失败本应显眼，danger 通道在状态指示器层面已确立，对话流本体也应接入。方案 B 留下「图标红文字灰」的半吊子辨识度；方案 C 与项目既定错误哲学冲突。偏离 spec 的代价已识别（需联动修订 spec，见 §5）。

**若用方案 B（§2.1 场景甲会怎样）**：失败工具块 header 多了一个 12px 红色小图标，但工具名仍是灰的、错误输出仍收起着。用户在 26 个灰行里扫红点的难度只比现状略低——失败的「一眼可辨」仍未达成。

### 3.3 关键设计

#### 3.3.1 failed tool：danger header + 终态默认展开（`Block.vue`）

- **视觉**：`toolStatusClass` 的 failed 分支 → `text-danger`（图标 + toolName + argPath 同行）；running 保持 accent，done 保持中性，**unfinished 保持中性**——unfinished 是 abort/中断语义（用户主动停或会话结束），不是失败，不标红（避免 abort 后被满屏红惊吓）。
- **行为（含 streaming 场景的诚实声明）**：
  - `toolCollapsed` 是 **mount 时快照**（`const toolCollapsed = ref(true)`），Block 的 key 是 `${assistant.id}-${blk.kind}-${bIdx}`（`Turn.vue`），status running→error 转变**不触发 remount**——所以 streaming 中失败的工具，`toolCollapsed` 已在 running 态挂载时固化为 `true`，失败后**保持收起**。
  - **选项 A（采纳，低风险）**：接受 streaming 中失败的工具只 header 变红、错误输出仍收起。不加 `watch(props.tool.status)` 强制展开（那是 P0 级破坏 streaming 跟底的风险——streaming 中高度突变会让跟底/回到底部浮层行为异常）。
  - **终态默认展开**：`toolCollapsed` 初始值按状态分化——failed 时初始 `false`（默认展开，错误输出直接可见），其余保持 `true`。这只在「turn 结束后新挂载的 Block」「历史 session 重开（块以终态挂载）」两个场景生效——正是 G1 完整生效的两个场景。streaming 中失败的工具不在生效范围（它已在 running 态挂载），G1 在此场景打折，文档诚实声明（见 G1 / §3.3.5 P-failed-expand）。
  - 展开内容区沿用现有结构（bash=命令+输出共框；其余=meta 条+输出），错误文本用 `text-danger`。
- **依据**：本设计裁决「失败优先可见 > 中性一致」（偏离 spec `:444` 全场景中性条款）+ PRODUCT.md「状态即信任」（每种状态有独特且一致的视觉表达，精神延伸自 SubAgent 状态论述）。

#### 3.3.2 session error 消息：danger 化，区分两种形态（Block text 分支）

`markSessionError` 有两条路径，渲染处理必须区分：

| 形态 | 触发条件 | 内容特征 | 渲染处理 |
|---|---|---|---|
| **纯 error 消息** | 无 streaming 实体（`markSessionError` 追加全新消息） | msg 无先存 content，errorText 即全文 | 整条 danger 化：AlertCircle 图标（`text-danger`，size 与正文行高匹配）+ 正文 `text-danger` |
| **追加形态** | 有 streaming assistant 时 `markSessionError` → `finalizeSession('error', errorText)` → `streaming-state-machine.ts` 的 `finalizeMessages()`（当前行 169-170）**改为把 errorText 写入 `Message.error` 字段**（`packages/shared/src/message.ts:259`，注释明确「assistant turn：message.error 通道写入错误文本」用途对口），content 通道保持崩溃前正常正文不动（现状是 `${content}\n\n${errorText}` 拼接，实施时改为双通道），整条 msg.status='error' | msg.content 含崩溃前正常正文 + msg.error 含 errorText（分属两个字段） | **不动正常正文**：msg.content 按普通 assistant 正文渲染，msg.error 渲染为独立 error 行（AlertCircle + danger） |

**为什么必须区分（误染边界）**：追加形态下，msg.content 是崩溃前的正常正文，errorText 在独立的 msg.error 字段。若渲染层按 message 级 status 无差别把整条 content 染红，会把崩溃前产出的正常正文也染红——这与「失败一眼可辨」的初衷恰好反向（用户分不清哪段是错误、哪段是崩溃前正常输出）。双通道（content / error 分离）从数据层消除了「errorText 混在 content 里」的歧义，渲染层只需按字段分别处理。

- 纯 error 消息不用 `danger-soft` 整行底色（多行文本上显脏）；追加形态的独立 error 行同理。图标+文字色足够辨识度，且与「错误插入对话流」的现有形态一致。
- **实现要点（双通道，无需标记机制）**：追加形态的 errorText 写入现成的 `Message.error` 字段（`message.ts:259`），content 保持崩溃前正文不动——两者天然分属不同字段，无需额外标记机制区分。两个早期候选均已排除：**约定分隔符不可行**（现状分隔符就是 `\n\n`，而 assistant 正常多段正文也用 `\n\n`，渲染时无法可靠区分）；**新增 `appendedErrorText` 字段冗余**（违反「不加推测性功能」，现成 error 字段已满足）。实施改动：`streaming-state-machine.ts` 的 `finalizeMessages()` 不再拼接 content，改为写 error 字段（见 §5 文件改动地图）。

#### 3.3.3 thinking working 态：默认展开可收起 + 完成态回落（`Block.vue`）

三层机制（修复 MF2/MF3 的机制根因）：

1. **`thinkingExpanded` computed 去短路（决策根因修复）**：现状 `thinkingExpanded = computed(() => props.working || !thinkingCollapsed.value)` 的 `props.working ||` 短路使 working 态下收起 100% 失效（无论怎么 toggle collapsed，working || 始终为 true）。改为 `computed(() => !thinkingCollapsed.value)`——「working 默认展开」完全由 collapsed 初值（working 时 false）承担，不再由 computed 短路承担。
2. **`collapsed` 初值分化**：working 态初值 `false`（保持现状「streaming 中 thinking 默认展开」的感知——原强制展开由短路实现，去短路后必须用初值保住默认行为）；非 working 态保持 `props.collapsed ?? true` 不变。
3. **删禁 toggle 的提前 return**，允许用户手动收起/展开。引入 `userToggledThinking` flag 标记用户是否手动操作过（用于完成态回落判定）。
4. **新增 watch（完成态回落，修 G3）**：`working` 从 true→false 时，把「默认展开（collapsed===false）且用户未手动收起（!userToggledThinking）」的块**回落收起**，恢复 G3 已完成态骨架。用户手动收起过的块（userToggledThinking===true）保持用户意图不回滚。
   - **为什么必须回落**：streaming 期间挂载的 thinking 块 collapsed=false（working 默认展开），turn 完成后 working→false，若不回落则保持展开——破坏 G3「完成态骨架零变化」；且内容从 60 字预览（`previewText`）切换为全文 MarkdownRenderer 产生一次高度突变。回落消除这两者。
   - 收起状态为块级本地 ref（不引入跨块/跨 session 记忆——§3.5.4 减法原则：用户收起是一段一段的即时动作，持久记忆是过度设计）。
   - 新 thinking 块仍默认展开：收起前一块不影响后一块（每块独立 ref），「最新推理始终可见」的感知保留。

**virtua 重挂载取舍声明**：MessageStream 用 virtua `Virtualizer`（仅 `keep-mounted=pinnedIndexes`），历史 session 中用户手动折叠/展开某块后滚离视口、重挂载时按初值逻辑会重新初始化（failed→展开、thinking 非终态→收起）——**用户手动折叠/展开态在 virtua 卸载/重挂载下均不持久**（手动展开的非 failed thinking 块重挂载后回到默认收起）。这是「不引入记忆」减法决定的已知取舍；若用户反馈强烈，后续评估把折叠态提升到 ThinkingBlock/ToolCall 模型层（本设计不预埋）。

#### 3.3.4 TurnMeta 文案归正（`TurnMeta.vue` + i18n）

- working 态：`panel.message.thinking`（「思考中」）→ 新增 key `panel.message.working`（「工作中」），zh/en 同步。elapsed 保留（「工作中 12m 46s」语义正确：turn 已进行时长）。
- **`isPendingPlaceholder` 占位态保持「思考中」**：空窗期（user 已发、assistant 未到）的语义确实是「agent 在想/在启动」，「思考中」正确，不动（`TurnMeta.vue` 占位分支）。
- 完成态「已工作」不动。
- **图标选型说明**：v6 `§5.11`（`v6-master-spec.md:486`）错误反馈先例用 TriangleAlert（`.install-err` / `.inline-error` 内联反馈条，danger 色 + 常驻可重试）。本设计 error 图标选 AlertCircle（与对话流正文行高匹配的圆形更柔和，避免三角警告在多行 error 文本上的过度压迫感）——偏离先例，spec 联动修订时记录该偏离理由（见 §5）。

#### 3.3.5 运行时断言探针清单

| ID | 验证的行为 | 探针 | 状态 |
|---|---|---|---|
| P-failed-expand | **streaming 中失败的工具不自动展开、无跳动**（header 红、错误输出收起）；turn 结束后/历史重开时终态挂载的 failed 块默认展开 | dev app 构造 streaming 中 tool 失败（第 N 个工具失败），观察：(1) streaming 中失败瞬间无展开/跳动、header 变红；(2) 任务完成后重开 session，failed 块默认展开 | ⛔ 实施期 M1 |
| P-thinking-toggle | working 态收起某段 thinking 生效（一行预览）；后续新 thinking 块仍默认展开；turn 完成后未手动收起的块回落收起、手动收起过的保持收起 | dev app thinking「最高」档任务实测 | ⛔ 实施期 M3 |
| P-error-pure | 纯 error 消息（无先存 content）整条 danger 化；普通 assistant 文本（status complete/streaming）零影响 | dev app 正常任务对话流正文渲染无变化 + 构造纯 error 路径 | ⛔ 实施期 M2 |
| P-error-append | 追加形态：崩溃前正常正文（msg.content）保持原色，msg.error 的 errorText 渲染为独立 danger 行 | dev app streaming 中 kill pi 子进程触发 session.exited → markSessionError（追加形态） | ⛔ 实施期 M2 |
| P-i18n-keys | 新增 `panel.message.working` 在 zh/en 语言文件同步存在 | 直接读两个语言文件确认 | ⛔ 实施期 M4 |

## §4 验收

**改动规模：小-中（ui 包内组件分支 + i18n + error 分支形态判定）。验收用真实 dev app + 真实 pi 任务，非单测非 mock。**

### 场景 1：tool 失败一眼定位（回溯 G1）

- **上下文**：dev app 真实任务，让 agent 执行一个会失败的 bash（如访问不存在的主机）
- **步骤**：任务完成后滚动对话流回看；再构造 streaming 中失败的子场景
- **通过标准**：
  - 终态回看：失败工具块 header 红色 + 默认展开错误输出，滚动中不停顿即可定位；成功工具块保持灰色收起；rail 红标与流内红色同色同义（G4）
  - streaming 中失败：header 立即变红、错误输出收起、无展开跳动（P-failed-expand）

### 场景 2：session 错误可见（回溯 G1，含追加形态边界）

- **步骤**：构造 session 级错误——dev app 任务进行中 `kill` pi 子进程，触发 `session.exited` → `markSessionError`（追加形态，崩溃前有正常正文）；另构造纯 error 路径（无 streaming 实体时的 markSessionError）
- **通过标准**：
  - 纯 error：消息带 danger 图标 + 红色正文，与正常 assistant 正文一眼区分；无 banner、无 toast 双表达（P-error-pure）
  - 追加形态：**崩溃前正常正文（msg.content）保持原色，msg.error 的 errorText 渲染为独立 danger 行**，不误染正常正文（P-error-append）
- **说明**：abort 不产生 error 消息（`store-types.ts` reason 映射：`aborted → message:complete`），不可用作构造路径；真实 error 触发源是 `stream_error`/`error`/`timeout`/`disconnect`/`restart` → `message:error`，dev 中 kill pi 子进程触发 session.exited 是最易构造的真实路径。

### 场景 3：thinking 可收起 + 完成态回落（回溯 G2/G3）

- **上下文**：thinking level「最高」的真实长推理任务
- **步骤**：streaming 中收起第一段 thinking → 观察后续 thinking 块 → 任务完成
- **通过标准**：收起生效（一行预览）；后续新块默认展开；完成后未手动收起的块回落收起（恢复完成态骨架）、手动收起过的保持收起；TurnMeta 显示「工作中 Xs」（P-thinking-toggle）

### 场景 4：已完成态骨架零变化（回溯 G3）

- **步骤**：打开一个已完成的历史 session（非活跃）
- **通过标准**：turn 级折叠（TurnMeta 一行聚合）、块级默认收起、聚合计数与改动前一致；thinking 块默认收起（初值 `props.collapsed ?? true`，非 working）；failed 块除外（红色+终态展开是本设计的预期变化）

## §5 下一层拆分

### 实施路径

| 步骤 | 交付 | 独立验证 |
|---|---|---|
| M1 failed tool 视觉+终态默认展开 | `Block.vue` `toolStatusClass` failed→`text-danger` + `toolCollapsed` 状态分化初值 | 场景 1 + P-failed-expand |
| M2 session error 视觉（含形态判定） | `Block.vue` text 分支 status==='error' 形态判定：纯 error 整条 danger / 追加形态读 msg.error 渲染独立 danger 行（content 保持原色） | 场景 2 + P-error-pure + P-error-append |
| M3 thinking 可收起 + 完成态回落 | `thinkingExpanded` 去短路 + collapsed working 初值 false + 删禁 toggle + watch working→false 回落 | 场景 3 + P-thinking-toggle |
| M4 TurnMeta 文案 | 新增 `panel.message.working` key（zh/en）+ working 态引用切换 | 场景 3 顺带 + P-i18n-keys |

拆分理由：四处改动互相独立（四个组件分支），各自可单独验收与回滚；M1 价值最高（失败定位是用户痛点核心）先行。

### 文件改动地图

| 文件 | 改动 |
|---|---|
| `packages/ui/src/features/chat/Block.vue` | `toolStatusClass` failed 分支；`toolCollapsed` 终态初值分化；`thinkingExpanded` 去短路 + thinkingCollapsed working 初值 + watch 回落 + 删禁 toggle；text 分支 error 形态判定（纯/追加） |
| `packages/ui/src/features/chat/TurnMeta.vue` | working 态文案 key 切换（thinking → working） |
| i18n 语言文件（zh/en） | 新增 `panel.message.working`（「工作中」/「Working」） |
| `packages/core/src/domain/chat/streaming-state-machine.ts`（追加形态双通道） | `finalizeMessages()`（当前行 169-170）追加形态分支：errorText 写入 `Message.error` 字段（不再 `${content}\n\n${errorText}` 拼接 content）；content 通道保持崩溃前正文不动 |
| 测试 | Block 的 failed 终态展开/streaming 不展开用例；error 纯/追加两种形态渲染用例；thinking 回落用例；TurnMeta 文案断言更新 |

### spec 联动修订项（偏离全场景中性条款的代价）

本设计偏离 v6-master-spec `:444` 全场景中性条款，必须同步修订 spec，否则 spec 与实现长期不一致。

**过渡期裁决**：实施以本文档为准，spec `:444` 修订为独立后续项，不阻塞 M1-M4。

| 修订项 | 位置 | 内容 |
|---|---|---|
| 全场景 tool 失败条款 | `v6-master-spec:444`「通用（全场景）：工具失败（exit≠0）→ 图标统一 `--neutral-ico`...」 | 改为「对话流 tool block：failed → `text-danger` header + 终态默认展开（失败优先可见）」；保留 TurnRail 节点/其他场景的中性裁决不变 |
| §6.1 Block·tool 状态矩阵 | v6-master-spec §6.1 附近 | failed 态补 danger header + 默认展开描述（原仅提 exit≠0 加 mono 标签） |
| **exit-N 标签去留裁决** | 全场景条款原要求的「行尾 mono `exit N` 中性标签」 | 现状与方案均无 exit-N 标签实现。spec 修订时裁决：是否补 exit-N 标签（信息增益 vs 视觉噪音）。本设计倾向**不补**（danger header 已足够辨识，exit-N 中性标签与 danger header 语义重复） |
| §5.11 错误反馈图标选型 | v6-master-spec §5.11 | 记录本设计用 AlertCircle 偏离 TriangleAlert 先例的理由 |

### 待验证检查点

1. **failed 终态展开与非活跃折叠的交互**：非活跃 session 的 turn 整 trace 不渲染（`Turn.vue` showTrace），failed 终态展开只在 trace 展开时生效——确认两者不冲突（预期：turn 级折叠优先，展开 turn 后 failed 块已展开）。
2. **unfinished 边界**：streaming 被 abort 时 running 中的 tool 会转 unfinished——确认其保持中性（不红）在多 abort 场景下不产生「abort 后满屏灰块疑似失败」的歧义；若用户反馈分不清，后续再评估 unfinished 是否用 warn 区分（本设计不预埋）。
3. **追加形态 errorText 通道（设计前置验证）**：方案选定 errorText 写入现成的 `Message.error` 字段（`message.ts:259`），不再需要标记机制区分 content。**前置验证（M2 启动前必须确认）**：pi JSONL 往返（离线重开 session）是否保留 `Message.error`——验证路径：(1) 文件路径 `session-history.ts` getHistoryFromFile 解析 JSONL，pi 的 message entry 是否携带 error 字段；(2) RPC 路径 `message-converter.ts` convertPiHistory 是否映射 pi error 到 `Message.error`。**若不保留**：§7.5 重开态降级方案明确——error 消息在重开态降级为普通正文渲染（现状），不阻断对话流；实时态（streaming 中 markSessionError 内存写 error 字段）仍 danger 化。此降级为可接受代价（重开态低频、实时态是主路径），不留「实现层裁决」模糊。
