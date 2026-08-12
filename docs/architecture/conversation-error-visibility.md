# 对话流失败可见性与进行态信噪比：error=danger 接入本体 + thinking 可收起

> **一句话结论**：把 v6 §5.6B 已裁决的「统一 error=danger」从 TurnRail 一处扩展到对话流本体（session error 消息 danger 化、failed tool danger header + 默认展开错误输出），thinking working 态从「强制展开禁收」改为「默认展开可收起」，TurnMeta working 态文案「思考中」归正为「工作中」——失败一眼可辨、进行态信噪比可控，已完成态的两级折叠骨架不动。

## §1 背景目标

- **S（情境）**：xyz-agent 的用户是后端/系统方向开发者，每天 6 小时以上监控长任务（一个 turn 跑 12 分钟、26 段思考 + 26 个工具调用是日常）。设计体系已裁决「统一 error=danger」（v6 spec §5.6B，推翻早期 warn 取舍）并在 TurnRail 落地（failed turn 图标常驻 `text-danger`，`TurnRail.vue:64-81`）；design tokens 的 danger 通道完整（`--danger:#bf6b6b`、`--danger-soft:12% 软底`）。
- **C（冲突）**：但对话流本体的失败表达**失声**——session 级 error 消息渲染为普通正文（无图标、无 danger 色）；failed tool 默认收起且 header 仅中性灰；全对话流里失败可发现性只剩 TurnRail 一处红标，且只覆盖 tool 失败（session error 连 rail 都不标）。同时 streaming 态（用户最常盯的场景）thinking **强制全文展开且禁止收起**，长推理模型下过程淹没正文。
- **Q（问题）**：怎么让失败在对话流里一眼可辨、进行态信噪比交给用户控制，而不破坏已完成态的折叠骨架与纯灰视觉体系？
- **A（答案）**：danger 通道接入对话流本体三处（error 消息 / failed tool header / failed 默认展开）+ thinking working 态允许手动收起 + TurnMeta working 文案归正。本文展开这个答案。

### 系统是什么

对话流（`packages/ui/src/features/chat/` + `packages/renderer/src/components/panel/MessageStream.vue`）按 turn 渲染：user 气泡 + assistant trace（thinking/tool/text 块）+ 正文。折叠策略两级：**turn 级**（非活跃 session 整 trace 折叠为 TurnMeta 一行）、**块级**（trace 内 thinking/tool 默认收起一行，点击展开）。本设计只动块级视觉与三处文案/交互，不动 turn 级折叠。

### 设计目标（从使用者体验倒推）

1. **G1 失败一眼可辨**：滚动对话流时，tool 失败与 session 错误不需要点击、不需要看 rail，在流内即可被 danger 色直接定位。
2. **G2 进行态信噪比可控**：streaming 中用户可以收起 thinking 块（默认仍展开，保留「agent 活着」的感知），收起权在用户。
3. **G3 已完成态骨架不动**：非活跃 turn 折叠、块级默认收起、TurnMeta 聚合计数——现状良好的部分零变化。
4. **G4 视觉体系一致**：只用 tokens 已有的 danger/warn 通道；不引入 side-stripe 彩色边条（绝对禁令）、不引入饱和色、与 rail 的 danger 语义一致（同一种红，同一个含义）。

### Scope

- **当前层 → 下一层**：对话流失败/进行态 UI 行为规格 → 组件级实现拆分（§5）。
- **In-scope**：`Block.vue`（tool failed 视觉 + thinking 收起交互）、session error 消息渲染分支、`TurnMeta.vue` 文案 + i18n。
- **Out-of-scope**：runtime 层 error 产生与广播逻辑；derivedStatus 9 态；toast 通知体系；QueueBubble/排队 UI（steer 解耦文档范围）；UserBubble。

## §2 现状与问题分析

**现状是：设计层早已裁决 error=danger 并在 rail 落地，但对话流本体——用户视线 95% 时间停留的地方——失败表达仍是灰的；而用户最常盯的 streaming 态，恰好是折叠策略唯一失效的场景。**

### 2.1 使用者视角的现状（真实例子）

**场景甲：失败找不着。** 一个 12 分钟的长任务 turn（思考 ×26 · 工具 ×26），其中第 18 个工具调用失败了。用户滚屏回看：26 个工具块全是同样的中性灰单行 header（`bash · ssh carbon "..."`），失败的那个混在里面没有任何颜色差异；错误输出（stderr）默认收起着，要逐块点击才能看到。session 级错误（如模型流中断后 `markSessionError` 插入的错误消息，`core/domain/chat/store.ts:437-450`）渲染为普通正文文本，滚过时与 assistant 正常输出无法区分。唯一的失败线索在右侧 TurnRail 一个 12px 图标上——且仅当失败来自 tool 时才有。

**场景乙：streaming 被过程淹没。** 用户配置 thinking level「最高」，发了一个复杂任务。streaming 进行中，每段 thinking **全文展开且无法收起**（`Block.vue:255-259`，`if (props.working) return` 禁 toggle），26 段长推理全文刷屏，assistant 正文和工具调用被淹没；TurnMeta 行显示「思考中 12m 46s」sticky 贴顶——但 12m46s 里大部分时间在跑工具，不在「思考」。

### 2.2 根因分析

**根因：折叠与状态色策略是按「消息类型」设计的（thinking/tool 怎么折、什么色），没有按「会话生命周期 × 用户注意力」设计（进行中最该盯什么、失败后怎么找到）。**

- **失败失声**：`Block.vue:311-317 toolStatusClass` 的 failed/unfinished 同为 `text-neutral-mid`；`Block.vue:383-386` 注释明确「failed 不再强制展开」；session error 消息无专用分支，走普通 text 渲染。`--danger` 通道在设计体系里存在、在 rail 里已用，只是**没接到对话流本体**——这是 §5.6B 裁决的执行遗漏，不是设计缺失。
- **进行态失控**：working 态强制展开 thinking 的意图可理解（streaming 时让用户看到 agent 在推理，感知「活着」），但「禁止收起」（`Block.vue:255-259` 提前 return）把善意变成了强制——长推理模型（用户实配「最高」档）下这是重灾区。
- **文案错配**：`TurnMeta.vue:29` `sessionActive ? t('panel.message.thinking') : t('panel.message.worked')`——working 态复用了「思考中」文案，其后的 elapsed 是 **turn 已进行时长**，不是思考时长。

## §3 解决方案

**终态：失败的工具调用在流内是红色 header 且默认展开错误输出；session 错误消息带 danger 图标与配色；streaming 中 thinking 可收起（默认展开）；TurnMeta working 态显示「工作中 12m 46s」。**

### 3.1 终态（使用者视角）

**场景甲（失败后回看，G1）**：

```
[12 分钟 turn 完成，含 1 个失败 tool]
  → 滚屏时：失败工具块的 header 图标与工具名为 danger 红（与 rail 同一种红），
    且该块默认展开——错误输出（stderr/错误详情）直接可见，无需点击
  → session 级错误消息：AlertCircle 图标（text-danger）+ 正文 text-danger，扫过即辨
  → 其余 25 个成功工具块保持中性灰单行收起（G3 不动）
```

**场景乙（streaming 长推理，G2）**：

```
[thinking level「最高」任务 streaming]
  → thinking 块默认全文展开（「活着」感知保留）
  → 用户点击某段 thinking 的 toggle → 该段收起为一行预览；后续新 thinking 块仍默认展开
  → TurnMeta：「工作中 3m 12s」（文案归正；sticky 行为不变）
```

**失败路径**：thinking 收起/展开是纯本地交互，无失败面；error 视觉分支渲染异常时降级为现状（普通正文），不阻断对话流。

### 3.2 多方案对比

| 方案 | 长期架构合理性 | 短期实现成本 | 风险 | 裁决 |
|---|---|---|---|---|
| **A. danger 全套接入（推荐）** | ✅ §5.6B 裁决执行到位：error=danger 在 rail/对话流同一语义；折叠策略补上「生命周期 × 注意力」维度（failed 默认展开 = 失败优先可见） | 小：Block.vue 两个分支 + TurnMeta i18n + error 消息分支，全部在 ui 包内 | failed 默认展开改变 streaming 滚动测量（探针 P-failed-expand）；「failed 红 + 成功灰」使红出现频率成为新的噪音源——接受：失败本应显眼 | ✅ |
| B. 仅图标不加色（error/failed 加 danger 图标，文字保持中性） | ◐ 可发现性提升有限：12px 灰红图标在 26 块灰行里仍需逐行扫；与 rail 的「danger 常驻色」语义不一致（同体系两种标准） | 更小：只加图标 | 长期：失败仍然不够显眼，问题半解决 | ❌ |
| C. 顶部 banner / toast 强化 | ❌ 违反项目规则「错误作为 assistant 消息插入对话流，不用顶部 banner」；banner 是瞬时的，回看场景（场景甲）无解 | 中：新增通知通道 | 与对话流消息双表达（与 steer 虚线框同构的错误） | ❌ |

**推荐 A 的理由**：失败可见性的设计裁决（§5.6B error=danger）早已做出，rail 已执行，对话流本体是唯一漏网处——本设计是执行已裁决方向，不是引入新方向。方案 B 留下「同体系两种失败标准」的不一致；方案 C 与项目既定错误哲学冲突。

**若用方案 B（§2.1 场景甲会怎样）**：失败工具块 header 多了一个 12px 红色小图标，但工具名仍是灰的、错误输出仍收起着。用户在 26 个灰行里扫红点的难度只比现状略低——失败的「一眼可辨」仍未达成。

### 3.3 关键设计

#### 3.3.1 failed tool：danger header + 默认展开（`Block.vue`）

- **视觉**：`toolStatusClass`（:311-317）的 failed 分支 → `text-danger`（图标 + toolName + argPath 同行）；running 保持 accent，done 保持中性，**unfinished 保持中性**——unfinished 是 abort/中断语义（用户主动停或会话结束），不是失败，不标红（避免 abort 后被满屏红惊吓）。
- **行为**：`toolCollapsed` 初始值按状态分化——failed 时初始 `false`（默认展开，错误输出直接可见），其余保持 `true`。展开内容区沿用现有结构（bash=命令+输出共框；其余=meta 条+输出），错误文本用 `text-danger`。
- **依据**：PRODUCT.md「状态即信任」（每种状态有独特且一致的视觉表达）+ §5.6B（error=danger 统一）。

#### 3.3.2 session error 消息：danger 化（Block text 分支）

`markSessionError` 追加的 `status:'error'` assistant 消息（`store.ts:437-450`）当前走普通 text 渲染。改：Block.vue text 分支对 `status==='error'` 的消息渲染为 AlertCircle 图标（`text-danger`，size 与正文行高匹配）+ 正文 `text-danger`。不用 `danger-soft` 整行底色——error 消息可能多行，整行软底在长文本上显脏；图标+文字色足够辨识度，且与「错误插入对话流」的现有形态一致。

#### 3.3.3 thinking working 态：默认展开，允许收起（`Block.vue:254-259`）

- `collapsed` 初始值按 working 分化：working 态初值 `false`（**保持现状「streaming 中 thinking 默认展开」的感知**——现状的强制展开由 :255-259 的覆盖逻辑实现，删除后必须用初值保住默认行为）；非 working 态保持 `props.collapsed ?? true` 不变。
- 删除禁 toggle 的提前 return，允许用户手动收起/展开。收起状态为块级本地 ref（不引入跨块/跨 session 记忆——准则 8 减法：用户收起是一段一段的即时动作，持久记忆是过度设计）。
- 新 thinking 块仍默认展开：收起前一块不影响后一块（每块独立 ref），「最新推理始终可见」的感知保留。

#### 3.3.4 TurnMeta 文案归正（`TurnMeta.vue` + i18n）

- working 态：`panel.message.thinking`（「思考中」）→ 新增 key `panel.message.working`（「工作中」），zh/en 同步。elapsed 保留（「工作中 12m 46s」语义正确：turn 已进行时长）。
- **`isPendingPlaceholder` 占位态保持「思考中」**：空窗期（user 已发、assistant 未到）的语义确实是「agent 在想/在启动」，「思考中」正确，不动（`TurnMeta.vue:79-85` 的占位分支）。
- 完成态「已工作」不动。

#### 3.3.5 运行时断言探针清单（准则 7）

| ID | 验证的行为 | 探针 | 状态 |
|---|---|---|---|
| P-failed-expand | failed tool 默认展开不破坏 streaming 滚动跟随（展开高度变化触发 virtua 重测量后仍正确贴底/回读位置） | dev app 构造 streaming 中 tool 失败，观察跟底行为与「回到底部」浮层无异常 | ⛔ 实施期 M1 |
| P-thinking-toggle | working 态收起某段 thinking 后，后续新 thinking 块仍默认展开；收起块在 turn 完成后保持收起 | dev app thinking「最高」档任务实测 | ⛔ 实施期 M3 |
| P-error-branch | `status:'error'` 消息走 danger 分支后，普通 assistant 文本（status complete/streaming）零影响 | dev app 正常任务对话流正文渲染无变化 | ⛔ 实施期 M2 |
| P-i18n-keys | 新增 `panel.message.working` 在 zh/en 语言文件同步存在 | 直接读两个语言文件确认 | ⛔ 实施期 M4 |

## §4 验收

**改动规模：小-中（ui 包内三个组件分支 + i18n）。验收用真实 dev app + 真实 pi 任务，非单测非 mock。**

### 场景 1：tool 失败一眼定位（回溯 G1）

- **上下文**：dev app 真实任务，让 agent 执行一个会失败的 bash（如访问不存在的主机）
- **步骤**：任务完成后滚动对话流回看
- **通过标准**：失败工具块 header 红色 + 默认展开错误输出，滚动中不停顿即可定位；成功工具块保持灰色收起；rail 红标与流内红色同色同义（G4）

### 场景 2：session 错误可见（回溯 G1）

- **步骤**：构造 session 级错误（如任务中 abort 后触发的错误消息/模型流错误）
- **通过标准**：error 消息带 danger 图标 + 红色正文，与正常 assistant 正文一眼区分；无 banner、无 toast 双表达

### 场景 3：thinking 可收起（回溯 G2）

- **上下文**：thinking level「最高」的真实长推理任务
- **步骤**：streaming 中收起第一段 thinking → 观察后续 thinking 块 → 任务完成
- **通过标准**：收起生效（一行预览）；后续新块默认展开；完成后已收起块保持收起；TurnMeta 显示「工作中 Xs」

### 场景 4：已完成态骨架零变化（回溯 G3）

- **步骤**：打开一个已完成的历史 session（非活跃）
- **通过标准**：turn 级折叠（TurnMeta 一行聚合）、块级默认收起、聚合计数与改动前一致；failed 块除外（红色+展开是本设计的预期变化）

## §5 下一层拆分

### 实施路径

| 步骤 | 交付 | 独立验证 |
|---|---|---|
| M1 failed tool 视觉+默认展开 | `Block.vue` toolStatusClass failed→text-danger + toolCollapsed 状态分化初始值 | 场景 1 + P-failed-expand |
| M2 session error 视觉 | `Block.vue` text 分支 status==='error' → AlertCircle+text-danger | 场景 2 + P-error-branch |
| M3 thinking 可收起 | 删禁 toggle return；确认 working 传入 collapsed 默认值 | 场景 3 + P-thinking-toggle |
| M4 TurnMeta 文案 | 新增 `panel.message.working` key（zh/en）+ working 态引用切换 | 场景 3 顺带 + P-i18n-keys |

拆分理由：四处改动互相独立（四个组件分支），各自可单独验收与回滚；M1 价值最高（失败定位是用户痛点核心）先行。

### 文件改动地图

| 文件 | 改动 |
|---|---|
| `packages/ui/src/features/chat/Block.vue` | toolStatusClass failed 分支；toolCollapsed 初始值状态分化；删 working 禁 toggle；text 分支 error 视觉 |
| `packages/ui/src/features/chat/TurnMeta.vue` | working 态文案 key 切换（thinking → working） |
| i18n 语言文件（zh/en） | 新增 `panel.message.working`（「工作中」/「Working」） |
| 测试 | Block 的 failed 展开/收起用例；error 分支渲染用例；TurnMeta 文案断言更新 |

### 待验证检查点

1. **failed 默认展开与非活跃折叠的交互**：非活跃 session 的 turn 整 trace 不渲染（`Turn.vue:128-130` showTrace），failed 默认展开只在 trace 展开时生效——确认两者不冲突（预期：turn 级折叠优先，展开 turn 后 failed 块已展开）。
2. **unfinished 边界**：streaming 被 abort 时 running 中的 tool 会转 unfinished——确认其保持中性（不红）在多 abort 场景下不产生「 abort 后满屏灰块疑似失败」的歧义；若用户反馈分不清，后续再评估 unfinished 是否用 warn 金区分（本设计不预埋）。
