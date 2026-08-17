# 对抗式审查报告：conversation-error-visibility.md

**审查对象**：`docs/architecture/conversation-error-visibility.md`（commit 78c558a53）
**总判定：需修订**（6 must-fix / 5 suggestion）

---

## Summary

6 must-fix, 5 suggestions。方案方向（失败可见性 + 信噪比）有真实问题支撑，但核心前提有一处与 v6 SSOT 规范直接冲突（M1）、一处与渲染代码事实不符（M4），核心机制（初始值分化）在主要场景不生效且破坏已完成态骨架（M2/M3），error 消息 danger 化存在未分析的误染边界（M5），验收场景 2 构造路径不成立（M6）。修订后可成立。

## 三问结论

### 1. 目标问题是否明确？是否为真正的问题？

- **error 消息无视觉区分：真实。** `markSessionError`（`packages/core/src/domain/chat/store.ts:440-452`）追加 `status:'error'` assistant 消息 → `expandAssistantBlocks`（`packages/core/src/domain/chat/message-turns.ts:178-180`）落为 `kind:'text'` 块 → `Block.vue` text 分支只按 `streaming` 切换 `text-neutral-mid`/`text-neutral-fg`，无图标无 danger（`Block.vue:47-49`）。与正常正文零区分，属实。
- **failed tool 默认收起 + 中性灰：真实。** `toolCollapsed = ref(true)`（`Block.vue:359`），`toolStatusClass` failed/unfinished 同为 `text-neutral-mid`（`Block.vue:290-296`）。属实。
- **streaming 信噪比「全文刷屏」：前提错误。** 见 M4。

### 2. 方案是否真实可靠、架构合理？

- error=danger 适用范围有未分析的边界（M5：message 级 status 判断会把正常正文整段染红）。
- thinking「默认展开可收起」不会加剧 streaming 滚动重排（working 态内容封顶 60 字，见 M4），但初始值机制会破坏已完成态骨架（M3），且行为随 virtua 挂载/卸载漂移（S4）。
- **初值陷阱的修正不是真修正，是把问题换了个地方**：`toolCollapsed`/`thinkingCollapsed` 都是 mount 时快照，状态转变（running→error、working→false）不触发重估（M2/M3，同一类 bug 的两处实例）。

### 3. 关键事实是否正确？

- v6 §5.6B 引用错位且与 SSOT 全场景条款冲突（M1）。
- 文档自称的运行时断言（P-failed-expand）观察项不含「failed 块确实展开」的功能断言，机制失效时探针会假通过（S4）。
- 全部行号引用漂移（S1）。

---

## Findings

| 优先级 | 位置 | 维度 | 描述 | 修复方向 |
|--------|------|------|------|----------|
| MUST_FIX | §1 S / §2.2 / §3.2 方案 A | P0-11 关键事实 | **§5.6B 裁决引用错位，方案与 v6 SSOT 直接冲突**。§5.6B 的裁决范围是「非列表主行 7px 圆点」（`v6-master-spec.md:437`：GitPanel 行级状态等，error=`--danger`），不覆盖对话流 tool block header。而同节「通用（全场景）」条款对对话流工具失败的裁决方向**相反**：`v6-master-spec.md:444`「工具失败（exit≠0）：图标统一 `--neutral-ico`，行尾加 mono `exit N` 中性标签」；§6.1 Block·tool 状态矩阵也只提「exit≠0 加 mono 标签」，无 danger（`v6-master-spec.md:527` 附近）。当前 `Block.vue:290-296` 的中性实现与规范条款一致，并非「执行遗漏」——文档是在提出**新裁决**却声称「执行已裁决方向」，且未触及 spec 要求的 exit-N 标签（现状与方案均缺失） | 重构为依据：要么按「新裁决 + spec 修订」框架写（改 v6-master-spec 全场景条款/§6.1，补 D 级裁决条目，同步 exit-N 标签去留），要么论证全场景条款不适用于对话流（难：条款自名「全场景」）。不得以「§5.6B 执行遗漏」为理由 |
| MUST_FIX | §3.3.1 / P-failed-expand / §4 场景 1 | P0-10/P0-12 机制不自洽 | **初始值分化不响应状态转变：live streaming 中失败的工具不会默认展开（G1 主场景失效）**。Block 以 `${assistant.id}-${blk.kind}-${bIdx}` 为 key（`Turn.vue:39`），status running→error 转变不触发 remount；`toolCollapsed = ref(true)`（`Block.vue:359`）在 mount 时快照，无任何 watch `props.tool.status` 的逻辑。文档自身场景甲（12 分钟任务第 18 个工具失败）是 streaming 中失败——块在 running 态挂载，初始值=true，失败后保持收起。默认展开只在「历史 session 重开」（块以终态挂载）时生效 | 改为转变触发：watch running→error 一次性展开，或 `expanded = userToggled ? userVal : isFailed` 派生式；P-failed-expand 探针必须加「failed 块无点击已展开」断言（现观察项只有滚动行为） |
| MUST_FIX | §3.3.3 / G3 / §4 场景 3、4 | P0-12 副作用 | **thinking 初始值分化破坏「已完成态块级默认收起」，与 G3 声明矛盾**。现行为：working 强制展开 → turn 完成后 `thinkingExpanded = working \|\| !collapsed` 自动回落为收起（`Block.vue:227-228`）。按方案改后，streaming 期间挂载的块 collapsed=false 被冻结，turn 完成后**保持展开**，且内容从 60 字预览切换为全文 MarkdownRenderer（`Block.vue:43-44`）产生一次高度突变。G3「块级默认收起零变化」、场景 4「与改动前一致」均不成立。且该行为随 virtua 卸载/重挂载漂移（滚远重挂后 working=false → 重新初始化为收起） | 二选一并写明：watch working→false 时把「默认展开、用户未手动收起」的块回落收起；或显式承认完成态骨架变化、改写 G3 与场景 3/4 通过标准。禁止声明与机制两张皮 |
| MUST_FIX | §1 C / §2.1 场景乙 / §2.2 / §3.1 | P0-11 关键事实 | **「streaming 中 thinking 全文展开刷屏」与代码不符：working 态只渲染 60 字截断预览**。`Block.vue:43-44`：`<MarkdownRenderer v-if="!working">` 全文 vs `<span v-else>{{ previewText }}</span>`；`PREVIEW_LIMIT=60` 硬截断（`Block.vue:236-240`）。26 段 thinking 在 streaming 中是 26 条 ≤60 字预览行，不是全文。「全文刷屏淹没正文」的问题陈述、以及任务攻击面「展开态 thinking 内容持续增长滚动/重排」在现状下都不成立（内容增长 60 字后封顶）。「禁止收起」属实，方案结论（可收起）仍可用，但问题陈述与风险分析必须按真实机制重写 | 修正场景乙叙事（「每段 thinking 的预览行无法收起，长任务下累积为噪音」），删除「全文」表述；信噪比论证改基于 26×1-2 行预览的真实量级 |
| MUST_FIX | §3.3.2 / §4 场景 2 | P0-12 副作用 / P0-10 边界 | **error 消息 danger 化按 message 级 status 判断会误染正常正文**。`markSessionError` 有两条路径：无 streaming 实体时追加纯 error 消息（`store.ts:450`）；**有 streaming assistant 时**走 `finalizeSession('error', errorText)` → `finalizeMessages` 把 errorText **追加进已有 content**（`streaming-state-machine.ts:166-169`：`content ? \`${content}\n\n${errorText}\` : errorText`），整条消息 status='error'。后者是常见形态（`markSessionError` 的实际触发源是 `session.exited`，pi 崩溃时 assistant 大概率正在流式输出，`useMessageEffects.ts:35-42`）。text 块 ref 是整条 `msg.content`（`message-turns.ts:164`），按方案整段染红 = 崩溃前产出的全部正常正文变红。场景 2 通过标准「与正常 assistant 正文一眼区分」在此形态下恰好反向成立 | 区分两种形态：纯 error 消息（无 contentBlocks/无先存 content）才整条 danger 化；追加形态应渲染独立的 error 行/块（如分离尾部 errorText），不动正常正文。补边界验收场景 |
| MUST_FIX | §4 场景 2 | P0-14 验收可执行性 | **场景 2 的错误构造路径不成立：abort 不产生 error 消息**。FinalizeReason 映射：`aborted → message:complete`（`store-types.ts:30`），abort 后无 `status:'error'` 消息可渲染。真实触发源是 session.exited（pi 进程崩溃）/ error envelope / restore 失败 / timeout / disconnect / restart（`store-types.ts:29-35`） | 改为真实可构造路径（如 dev 中 kill pi 子进程触发 session.exited，或断连兜底），并写明构造步骤 |
| SUGGESTION | 全文行号引用 | P0-11 一致性 | 行号引用全面漂移：禁 toggle 实际 `Block.vue:229-232`（文档称 255-259）、toolStatusClass 实际 290-296（称 311-317）、「failed 不再强制展开」注释实际 357-359（称 383-386）、thinking 逻辑实际 227-228（称 254-259）；`TurnMeta.vue` isPendingPlaceholder 实际 85-87（称 79-85）；`Turn.vue` showTrace 实际 131（称 128-130） | 重核后更新，或删行号改符号名锚点（`toolStatusClass`/`toggleThinking` 等更抗漂移） |
| SUGGESTION | §3.3.3 / §3.3.1 | P1 引用准确性 | 「准则 8 减法」误引：§3.5.8 是「静态 demo 的展示级边界」，减法原则是 §3.5.4（准则 4）。PRODUCT.md「状态即信任」（PRODUCT.md:97）原文针对 SubAgent 状态，作为对话流依据属延伸引用，需注明 | 改引 §3.5.4；PRODUCT.md 引用加「精神延伸」限定 |
| SUGGESTION | §3.3.2 / §3.3.1 | P1 spec 一致性 | v6 §5.11 错误反馈先例图标是 TriangleAlert（`v6-master-spec.md:486`），文档选 AlertCircle 未说明理由；全场景条款的 exit-N 中性标签（现状缺失）与 M1 的 spec 修订应一并处理 | 对齐 TriangleAlert 或写明偏离理由；spec 修订时同步 exit-N 标签去留 |
| SUGGESTION | §3.3.5 / §3.3.3 | P0-14 探针可测性 / P0-12 交互遗漏 | P-failed-expand 观察项「跟底行为/回到底部浮层无异常」不含功能断言，机制失效时假通过（M2 修复时同步）。另：折叠态是块级本地 ref（§3.3.3 决定），而 MessageStream 用 virtua `Virtualizer`（`MessageStream.vue:35-46`，仅 `keep-mounted=pinnedIndexes`）——历史 session 中用户手动收起 failed 块后滚离视口，重挂载时初始值逻辑会把它**重新展开**，收起意图丢失；「不引入记忆」的减法决定未考虑此交互 | 探针补断言；文档至少写明 virtua 重挂载下「用户收起态不持久」为已知取舍，或评估把折叠态提升到 ThinkingBlock/ToolCall 模型层 |
| SUGGESTION | §3.2 方案 A 风险列 | P1 自洽性 | 风险声明「failed 默认展开改变 streaming 滚动测量」与所写机制不自洽：初始值机制在 streaming 中不触发任何展开（M2），风险只在改成转变触发后成立。大量展开 failed 块的内存/渲染代价由 virtua 视口挂载天然限制（仅可见项挂载），可在文档补一句澄清以回应成本疑虑 | 与 M2 修复方向同步修订风险行；补 virtua 视口挂载的成本澄清 |

---

## 证据附录（关键摘录）

**M1 — v6 SSOT 条款原文**（`docs/page-design/v6-master-spec.md`）：
```
:437  B. 非列表主行（GitPanel 行级状态等）—— 7px 圆点
       `7px; border-radius: 999px` + 语义色：...error=`--danger`
:444  通用（全场景）：
       - 工具失败（exit≠0）：图标统一 `--neutral-ico`，行尾加 mono `exit N` 中性标签
:542  > failed 节点色阶待统一：§5.6B 规定 error=`--danger`，但 demo TurnRail.vue ... 实施时应按 §5.6B 改为 --danger
```
（:542 仅针对 TurnRail 节点；对话流 tool block 的裁决是 :444 的中性条款。）

**M2/M3 — mount 快照机制**（`packages/ui/src/features/chat/Block.vue`）：
```ts
:227  const thinkingCollapsed = ref(props.collapsed ?? true)
:228  const thinkingExpanded = computed(() => props.working || !thinkingCollapsed.value)
:231    if (props.working) return        // toggleThinking
:359  const toolCollapsed = ref(true)
```
`Turn.vue:39`：`:key="`${assistant.id}-${blk.kind}-${bIdx}`"`（状态转变不 remount）；`Turn.vue:50`：`:working="sessionActive"`。

**M4 — working 态只渲染预览**（`packages/ui/src/features/chat/Block.vue`）：
```html
:43  <MarkdownRenderer v-if="!working" :content="content ?? ''" ... />
:44  <span v-else class="whitespace-pre-wrap">{{ previewText }}</span>
:236 const PREVIEW_LIMIT = 60
:237 const previewText = computed(() => { ... c.length <= PREVIEW_LIMIT ? c : `${c.slice(0, PREVIEW_LIMIT)}…` })
```

**M5 — 错误文本追加形态**（`packages/core/src/domain/chat/streaming-state-machine.ts:166-169`）：
```ts
const finalContent = errorText && m.role === 'assistant'
  ? (m.content ? `${m.content}\n\n${errorText}` : errorText)
  : m.content
return { ...m, status: finalStatus, content: finalContent, toolCalls }
```

**M6 — abort 不产生 error 消息**（`packages/core/src/domain/chat/store-types.ts:29-35`）：
```
normal → message:complete；aborted → message:complete（toolCall:end_not_received）；
timeout/disconnect/restart → message:error
```
`markSessionError` 真实触发源：`useMessageEffects.ts:35-42`（session.exited → `markSessionError(sessionId, payload.reason)`）。

**已核实属实的文档断言**（供主 agent 修订时保留）：error 消息无视觉区分（`Block.vue:47-49` + `message-turns.ts:178-180`）；failed/unfinished 同为 neutral-mid（`Block.vue:290-296`）；tool 默认收起含 streaming 态（`Block.vue:359`）；rail failed 图标 text-danger 且仅覆盖 tool 失败（`TurnRail.vue:216` `agentIconClass` + `hasFailedTool`）；danger tokens 存在（`design-tokens.md:58/65`）；`panel.message.working` 尚不存在（`panel.ts:44-45` 仅 thinking/worked）；virtua 虚拟滚动 + 估高测量属实（`MessageStream.vue:35-46`）。
