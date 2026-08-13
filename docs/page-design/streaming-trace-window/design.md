# Message Stream 长程任务 Trace 滚动收编设计

> **一句话结论**：把 streaming 期间的 trace 从「全量展开的过程墙」改为按时间衰减的三层收编——历史 turn 骨架化、当前 turn 内已完成块滚动收编、块数滚动窗口——让工作 turn 的视觉体积恒定在约一屏（O(1)），与 149 个还是 1490 个过程块无关；窗口无框无背景无独立 chrome，用户感知不到窗口存在，只看到对话流里一条安静的计数行。

- S（情境）：太极的对话流把一个回合（turn）的 thinking / tool / text 块渲染为 trace，working 态实时展开，完成后自动收编成「meta 行 + 最终正文」骨架。这是用户监控 AI Agent 工作的主界面。
- C（冲突）：模型越来越偏向长程任务，单个 turn 可达 149 次思考 + 145 次工具调用；现行折叠绑定在「session 是否活跃」上，导致整个会话历史在每个 run 期间全程展开，streaming 视图体积随块数线性膨胀（实测一个 run 的过程块可达 ~300 行 ≈ 10 屏）。
- Q（问题）：如何让「扫一眼监控」在长程任务下仍然可行——活着吗、在干嘛、跑偏没——且不牺牲随时下钻的可查证性？
- A（答案）：按「监控价值随块完成度衰减」重排 trace 渲染。本文展开这个答案。

**层声明**：当前层 = 技术方案设计（渲染行为 + 交互语义 + 数据流）；下一层 = 实现计划（任务拆分 + 代码改动）。本文不写到函数签名级实现细节。

---

## 1. 背景目标

### 1.1 系统是什么

太极（xyz-agent）是 AI Agent 桌面工作台，主界面是每个 session 的对话流（message-stream）。渲染链路三段：

- **MessageStream**（`packages/renderer/src/components/panel/MessageStream.vue`）：读 chat store 的扁平消息列表，用 `toRenderItems` 分成一个个 **turn**（一个 user 消息 + 其后所有 assistant 消息），交给 virtua 虚拟列表渲染。
- **Turn**（`packages/ui/src/features/chat/Turn.vue`）：一个回合的编排器。结构 = UserBubble（用户气泡）+ TurnMeta（回合元信息行：状态文案 / 耗时 / thinking 与 tool 计数徽章 / 折叠 chevron）+ **trace**（该回合 assistant 产出的有序块列表）+ TurnSummary（hover 操作栏）。
- **Block**（`packages/ui/src/features/chat/Block.vue`）：trace 内单个块。三种：**thinking**（模型推理，图标 + 预览行 + 可展开全文）、**tool**（工具调用，默认 1 行 header：工具名 + 参数摘要 + 状态色，点击展开输出详情）、**text**（正文，inline 渲染）。

**术语锚定**（本文后续反复使用）：

- **trace**：turn 内 thinking/tool/text 块的渲染区域。就是 §1.1 例子里 Turn 组件中 `<div class="trace">` 那段。
- **工作 turn**：当前正在进行中的最后一个 turn（streaming / ask-user 等待 / dispatching 占位都属此类）。
- **收编（compact）**：把已完成的过程块从渲染流中移除、只留一条计数入口的行为。不是删除数据，数据仍在 store，随时可展开回看。
- **骨架（skeleton）**：turn 完成后的收起形态 = TurnMeta 行（已工作 Xs + 计数徽章）+ 最终一条正文。

### 1.2 设计目标（从使用者体验倒推）

用户画像：开发者对 Agent 下达复杂任务后**周期性扫一眼**监控，而非逐 token 跟读。一次扫视要回答三个问题：活着吗、在干嘛、跑偏没。

- **G1 监控信噪比恒定**：streaming 期间工作 turn 的视觉体积有界（目标 ≤ 约一屏半），与过程块总数无关。149 块和 1490 块占屏相同。
- **G2 当前活动在场**：进行中的 thinking / tool / 流式正文始终可见，且能看到刚发生的最近几步（发现跑偏所需的全部上下文）。
- **G3 可查证性零损失**：任何被收编的内容一键展开回全量日志；失败信号永不被埋。
- **G4 无感窗口**：滚动窗口不带边框、背景、分隔线等任何独立 chrome，与对话流融为一体。用户感知不到「窗口」这个机制的存在，只看到流里有一条安静的计数行。
- **G5 完成态与历史呈现不变**：turn 完成后的骨架形态、重开 session 的历史渲染，与现状完全一致。

**In scope**：工作 turn 的 trace 渲染规则、折叠作用域修正、收编行组件、相关 i18n 文案。
**Out of scope**：MarkdownRenderer / tool 块 1 行 header 等单块内部形态（已正确，不动）；完成态骨架；任何新设置项（窗口宽度等参数走常量，不做用户配置）；subagent 面板、Overview 等其他视图。

---

## 2. 现状与问题分析

**结论：当前折叠机制绑定错了作用域（绑在 session 活跃度而非 turn 完成度），且不存在块数维度的压缩机制——两者叠加，streaming 体积 = 历史 turn 数 × 每 turn 块数，双乘数爆炸。**

### 2.1 现状渲染规则（取自真实代码）

折叠/展开的总开关在 `Turn.vue`：

```ts
// packages/ui/src/features/chat/Turn.vue
const showTrace = computed(() => sessionActive.value || isExpanded(turnStableId(props.turn)))
```

`sessionActive` 是 session 级信号（`useSessionActive.ts`）：derivedStatus 处于 `streaming / waiting / working / pending / compacting / retrying` 任一态即为 true。它**对所有 turn 一视同仁**——只要 session 在跑，每个 turn 的 trace 都展开。

块级默认态（`Block.vue`）：

- thinking：working 时挂载即展开，但内容区只渲染 60 字符 live 预览（`previewText`，`PREVIEW_LIMIT = 60`）；working→false 且用户未手动操作时自动收起。
- tool：任何状态都默认 1 行 header 收起（含 running），failed 终态挂载时默认展开。**这个形态是正确的，本设计不动。**
- text：streaming 期间全部 inline 渲染（含被工具打断的过渡碎片）；完成态只保留最后一条。

自动收编的触发时机在 `useTurnElapsed.ts`：`onComplete` 回调（即 `collapse(turnKey)`）在 `sessionActive true→false` 时触发——即**整个 run 结束才收编**，run 期间无任何收编。

### 2.2 真实规模数据

对本机一个真实 session JSONL（cw dev 类型任务，52 条 assistant 消息）统计块构成：

| 块类型 | 数量 | 总字符 |
|---|---|---|
| thinking | 52 | 10,294 |
| tool call | 64 | — |
| text（含过渡碎片） | 8 | 1,395 |

用户报告的典型长程任务规模：**单 turn 149 次 thinking + 145 次 tool call**。即使全部块都收成 1 行（约 30px/行），300 行 ≈ 9,000px ≈ 8~10 屏。

### 2.3 失败模式（真实、可复现）

- **F1 历史 turn 重展开**：turn 完成后虽已收编成骨架，但用户发出下一条消息 → `sessionActive` 翻真 → 所有历史 turn 的 `showTrace` 重新为 true → 历史 trace 全程重展开，直到整个 run 结束才再收编。多轮会话里每发一条消息，过程墙就回来一次。
- **F2 run 期间只增不收**：收编唯一触发点是 run 结束。10 分钟的长任务意味着 10 分钟内过程块单调累积，信息密度持续恶化。
- **F3 块数 O(n) 无压缩**：即使块级全部收成 1 行（现状 thinking 预览行 + tool header 已接近），行数本身随模型步数线性增长，长程任务下仍是多屏。

### 2.4 根因

监控价值随块完成度衰减——已完成的第 37 个 tool call 在第 145 个正在跑时监控价值为零（只需保留可查证性）。但现行渲染把所有块平等对待：折叠看「session 活不活」（粗粒度、与单块完成度无关），不看「这个块完成没、这个 turn 完成没」。缺失的两层机制正是 §1.2 的目标来源：turn 级折叠作用域 + 块数维度压缩。

### 2.5 物理数据流

```
pi 子进程（JSONL session 文件 / RPC 事件流）
  → runtime：event-adapter / message-converter 转成 Message[]
  → renderer chat store：messages: Map<sessionId, Message[]>
  → MessageStream：toRenderItems(messages) → RenderItem[]（turn 分组）
  → Turn.vue：expandAssistantBlocks(assistant) → OrderedBlock[]（单条 assistant 内按 contentBlocks 真实时序解出 thinking/tool/text）
  → Block.vue：逐块渲染（本设计的改动点：Turn 层在「OrderedBlock[] → 渲染」之间加窗口收编）
```

数据层（store / converter / pi 协议）零改动；本设计是纯渲染层重排，天然满足「重开 session 呈现不变」（G5）——文件与 RPC 两条读取路径的产物都不经过窗口。

---

## 3. 解决方案

### 3.1 终态（使用者视角）

**核心形态：工作 turn 的 trace = 收编行 + 滚动窗口（最近若干块）+ 流式正文。除此之外无任何新视觉元素。**

一个 149 次思考 + 145 次工具的长 run 进行中，用户看到的：

```
[Loader2] 工作中 2m41s  [brain ×149] [fx ×145]    ← TurnMeta：live 计数徽章（现有元素，天然 live）
▸ 前面还有 287 步过程 · 展开                       ← 收编行：无框无底，安静的一行文字
  [lightbulb] THINKING · 我先检查现有测试覆盖…     ← 窗口内：已完成的 thinking（1 行预览，现有形态）
  read  · packages/core/src/foo.ts                ← 窗口内：已完成 tool（1 行 header，现有形态）
  edit  · packages/core/src/bar.ts
  [双环 loader] bash · pnpm vitest run            ← 进行中 tool（accent loader，现有形态）
  正在把聚合逻辑下沉到 domain 层，接下来补回归测试|   ← 流式正文（主角，全文渲染，光标）
```

恒定的占屏 = 1（meta）+ 1（收编行）+ 约 8（窗口）+ 正文流。149 块与 1490 块视觉体积相同（G1）。数字只长在徽章和收编行里。

**交互样例**：

1. **下钻（G3）**：点击收编行 → 全部 295 步过程按现有块形态展开（用户接管，自动收编暂停）；收编行原地变为 `▾ 已展开全部 295 步 · 恢复精简`，点击回到窗口形态。
2. **失败信号（G3）**：窗口外某 tool 失败 → 该块豁免收编，始终以 1 行 danger header 留在流里（streaming 中失败的工具本来就不展开详情，只占 1 行）。失败轨迹恰是「跑偏没」的核心信号，且真实 run 中失败稀少（实测样本为 0），豁免不破坏体积有界。
3. **run 结束**：turn 完成 → 现有完成骨架原样接管（TurnMeta + 最终正文），收编行与窗口消失（G5）。
4. **多轮会话**：发新消息 → 上一 turn 保持骨架，不再重展开（修掉 F1）。
5. **ask-user 等待**：等待期间当前 turn trace 保持展开、窗口冻结（无新块进入，天然稳定），用户看着上下文做决策。
6. **历史 turn 回看**：点击已完成 turn 的 TurnMeta → 全量展开（现有手动展开语义不变；窗口只作用于工作 turn，回看就是全量）。

### 3.2 方案对比

| 方案 | 长期架构合理性 | 短期实现成本 | 风险 | 裁决 |
|---|---|---|---|---|
| **A. 时间衰减三层收编**（历史 turn 骨架化 + 当前 turn 窗口化 + 收编行） | 高：单一原则（价值随时间衰减）贯穿，纯渲染层重排不动数据层；窗口原语未来可承载更聪明的分组策略 | 中：core 加一个纯函数 + Turn.vue 渲染逻辑 + 一个新行组件 + i18n | 窗口滑动的滚动稳定性（有探针 P2 门禁）；takeover 状态管理简单（本地 ref） | **推荐** |
| B. 语义分段折叠（以过渡 text 为锚，每段折成「叙述行 + 计数」） | 中：分段语义依赖模型行为（是否产生中间叙述、叙述节奏），不同模型表现漂移 | 高：分段状态机 + 段级折叠 UI | 实测样本 52 块仅 8 段 text——无叙述的 run 退化为单段 300 行，等于没做 | 不选：依赖不确定的模型行为 |
| C. 全局密度开关（跟随/监视双模态） | 低：两套渲染路径并存，长期维护双倍；用户要管理模式 | 中高：模式状态 + 两套渲染 | 用户选错模式就回到 10 屏；模式切换本身是认知负担 | 不选：把系统该做的收编决策推给用户 |

若用 B，§3.1 的例子会变成：287 步被分成 3 段（模型恰好产了 3 句叙述），最长一段仍有 100+ 行——收编失效。若用 C，§3.1 的例子变成：用户发现内容太长 → 想起有开关 → 切到监视 → 下次想看细节又切回来——决策疲劳常驻。

### 3.3 关键决策与权衡

- **D1 折叠作用域降到 turn 级**：`showTrace = isWorkingTurn || isExpanded(turnKey)`，`isWorkingTurn = sessionActive && 本 turn 是最后一个 turn`。被否：维持 session 级（F1 的根源）。证据：§2.1 代码 + F1 复现链。`isLastTurn` 由 MessageStream 传入（`lastRenderTurn` 已存在，零新状态）。
- **D2 窗口统一管理所有块类型**：text 过渡碎片也进窗口。被否：text 豁免。证据：完成态语义本来就只保留最后一条 text（`lastTextBlockKey`），streaming 与完成态规则一致反而简单；进行中的 text 永远在窗口尾部，天然可见。
- **D3 收编行只有「展开全部 / 恢复精简」一个动作**：不支持收编区内单块定点展开。被否：单块 pin 机制。证据：准则「减法优先」——pin 机制引入新的状态面和边界 case，而「展开全部再找到那块」的成本只有一次点击；对齐 Claude Code verbose 开关的全或无语义。
- **D4 failed tool 豁免收编**：失败块始终以 1 行 danger header 在场，不进收编计数。被否：一视同仁收编。证据：失败轨迹是「跑偏没」判断的核心信号；失败在真实 run 中稀少（§2.2 样本为 0），不破坏 G1 体积有界。豁免只决定「渲不渲染」，块内部形态沿用现有语义，不改 Block.vue。
- **D5 窗口零 chrome（G4 的实现约束）**：收编行 = 一行 `text-neutral-dim` 文字 + chevron 图标，样式对齐现有 tool header 安静行（hover 微亮）；禁止边框、背景块、分隔线、渐变遮罩。被否：fade 遮罩/卡片化——任何窗口可见物都违反「融为一体」。
- **D6 takeover 状态用 Turn.vue 本地 ref**：不进 expansion store。被否：store 化。证据：窗口只作用于工作 turn，而工作 turn 被 virtua `keepMounted` 钉住不卸载（streaming pin 既有机制），本地状态生命周期足够；store 化要为 per-turn key 开新分区，收益为零。（探针 P1 门：实测钉住行为。）
- **D7 窗口宽度 W = 8 个块，常量**：不做用户设置。被否：设置项。证据：设置项把收编决策推给用户（同 C 的错）；8 约为「当前活动 + 刚发生的几步」的最小完整上下文，实施后经真实使用微调。
- **D8 进行中 thinking 维持 60 字符 live 预览现状**：本设计不把 working 态 thinking 内容改为全文流。被否：趁机改全文。证据：超出 scope；60 字符预览恰好就是用户要的「loading 感」的最小形态，改动留待独立评估。
- **D9 等待态窗口冻结**：ask-user / compacting 等 sessionActive 但无新块的态，窗口不滑动（无新块进入，by construction 稳定），takeover 状态保持。

---

## 4. 验收（真实场景，非单测非 mock）

改动规模：中等行为变更（渲染规则重排 + 一个小组件）。在 dev app（`pnpm dev`）用真实模型跑真实任务验证，禁止 mock 消息流。每个场景回溯 §1.2 目标。

- **V1（G1/G2/G4，主场景）**：在本仓让 agent 执行一个预期 >50 次工具调用的真实任务（如「把 packages/runtime 某模块的重试逻辑重构为指数退避并补回归测试」）。streaming 全程观察：任意时刻工作 turn 占屏 ≤ 约一屏半；收编行计数随进度增长；进行中的 tool loader / thinking 预览 / 流式正文始终在场；收编行无框无底，截图与相邻块对比无视觉割裂。
- **V2（G1，F1 回归）**：同一会话任务完成后发第二轮消息 → 第一轮 turn 全程保持骨架（meta + 最终正文），trace 不重展开。
- **V3（G3）**：V1 run 进行中点击收编行 → 全部过程块按现有形态展开；再点「恢复精简」→ 回到窗口形态且收编行计数正确；run 结束后完成骨架与现状一致。
- **V4（G3，失败豁免）**：让 agent 读一个不存在的文件（制造 tool failed）→ 失败块滑出窗口后仍以 1 行 danger header 可见，收编行计数不含它。
- **V5（G5，持久化链路）**：关闭该 session 再重开（离线 JSONL 路径）→ 历史呈现与改动前一致：完成骨架 + 最终正文，无收编行、无窗口残留。
- **V6（G2，ask-user）**：触发一次 ask-user 等待 → 等待期间当前 turn trace 保持展开、窗口冻结不滑动，回答后正常推进。
- **通过标准**：V1~V6 全部通过。单元测试（core 纯函数 + Turn 组件）仅作回归辅助，不计入验收。

## 5. 下一层拆分

| # | 单元 | 内容 | justification | 独立验收 |
|---|---|---|---|---|
| 1 | core 纯函数 | `packages/core/src/domain/chat/` 新增 trace-window 纯函数：跨 assistant 拍平 OrderedBlock[]、计算窗口切片、收编计数、failed 豁免过滤 | 窗口规则是纯逻辑，落 core 符合「core = chat 域 SSOT 纯函数」的绞杀模式，可脱离 Vue 单测 | 纯函数单测（窗口边界 / failed 豁免 / 空块列表 / 单 assistant 与多 assistant 混合） |
| 2 | 折叠作用域修正 | Turn.vue `showTrace` 改 turn 级；MessageStream.vue 传 `is-last-turn`（`lastRenderTurn` 现成） | F1 是独立 bug 级行为，单独交付立即可感 | V2 场景 |
| 3 | 窗口渲染 + 收编行 | Turn.vue 接入窗口切片；新增 `TraceCompactorRow.vue`（收编/恢复精简双态行组件，零 chrome）；takeover 本地 ref；i18n 文案（`packages/renderer/src/i18n/locales/{zh-CN,en-US}/panel.ts`） | 收编行独立组件避免 Turn.vue template 超 400 行规范上限（现 83 行，有裕量但双态行 + 计数文案值得独立） | V1 / V3 / V4 |
| 4 | 边界与回归 | ask-user / dispatching 占位 / compacting / subagent 虚拟 session（forceWorking 路径）适配确认；MessageStream.wire 测试与 ui 包 Turn 相关测试更新 | 边界态分散，集中一个单元防漏 | V5 / V6 + 回归测试 |

**文件改动地图**：新增 `packages/core/src/domain/chat/trace-window.ts`（或并入 message-turns.ts）、`packages/ui/src/features/chat/TraceCompactorRow.vue`；修改 `Turn.vue`、`MessageStream.vue`、两个 locale 的 `panel.ts`；不动 `Block.vue`、不动 chat store / converter / runtime。

**待验证检查点**（设计期无法确定，实施期定）：W=8 的实际手感（V1 后微调常量）；窗口滑动瞬间的高度变化在 virtua RO 下的平滑度（探针 P2 若发现跳变，再评估是否给收编行加 min-height 补偿——届时实测驱动，不预设机制）。

---

## 探针清单（运行时行为断言）

| ID | 断言 | 探针 | 状态 |
|---|---|---|---|
| P1 | 工作 turn 被 virtua keepMounted 钉住不卸载，takeover 本地 ref 不因滚动出视口丢失 | streaming 中点开「展开全部」→ 上滚使该 turn 出视口 → 滚回，断言仍处于展开接管态 | ⛔ 单元 3 交付前实测 |
| P2 | 窗口滑动（新块进、旧块收编）时 virtua RO 重测高度，follow 滚动无肉眼可见跳变 | V1 场景中贴底观察窗口滑动瞬间；如有跳变记录复现参数 | ⛔ 单元 3 交付前实测 |
| P3 | streaming 期间工作 turn 的 DOM 节点数有界（O(W)，不随块总数增长） | V1 场景 devtools 对 trace 容器做元素计数，对比 run 开始与 100+ 块时 | ⛔ V1 验收时实测 |
| P4 | 窗口不作用于非工作 turn：完成态、重开 session、手动展开历史 turn 的渲染与现状一致 | V5 场景 + 手动展开任一历史 turn 对比改动前截图 | ⛔ V5 验收时实测 |
