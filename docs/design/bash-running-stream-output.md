# bash 工具 running 态流式输出可见性修复

> **一句话结论**：pi bash 工具 running 态的流式 stdout 在 event-adapter 被整段丢弃，导致前端 running 态点击展开 bash 块后内容区恒空白（且 header 命令摘要被隐藏，形成「假展开」）——本设计把 partialResult 的文本归一进既有 `ToolCall.output/outputRaw` 字段（update 帧尾窗截断 ≤8KB 防 WS ring 帧放大），让展开区、尾行视口复用既有渲染链路自然工作。

## 开篇（SCQA）

- **S（情境）**：xyz-agent 对话流中，pi agent 的每次工具调用渲染为 Block 块——默认 1 行收起（工具名 + 参数摘要 + 状态），点击展开看详情。bash 是高频工具，长命令（构建/测试）执行期间用户需要观察运行进度。
- **C（冲突）**：bash running 态点击展开后内容区完全空白，唯一可见变化是 header 第一行的命令摘要消失——用户感知为「点了展开，但什么都没有」。对照 pi CLI 自身 TUI（running 态实时显示 bash 输出尾行），xyz-agent 的对话流在 running 态是「盲」的。
- **Q（问题）**：为什么 running 态的 bash 流式输出到不了前端？修复的最小侵入路径是什么？
- **A（答案）**：根因是三层叠加——① event-adapter 对 `tool_execution_update` 的 object 形态 partialResult 只提取 `.details`，bash 流式 stdout（在 `.content[].text`）被丢弃；② Block.vue 展开区渲染条件 `displayContent || guiComponent` 在 running 态恒 false；③ header 命令摘要在展开时被 `invisible` 隐藏（设计意图是避免与展开容器内的完整命令重复，但展开区没渲染）。修复：adapter 归一 partialResult 文本（尾窗截断）→ payload 增补 `output/outputRaw` → registry 写入 ToolCall 既有字段 → Block.vue 三处小改。

## 1. 背景：被设计的系统是什么

**xyz-agent 是 Electron 桌面 AI agent 工作台，对话流（chat stream）是用户观察 agent 工作过程的主界面。** 链路分四层：

1. **pi**（外部依赖 `@earendil-works/pi-coding-agent@0.84.4`，不修改）：agent 运行时。工具执行期间通过 `tool_execution_update` 事件推送进度（partialResult），pi 内置 bash 工具以 100ms 节流推送输出快照。
2. **runtime 适配层**（`packages/runtime/src/infra/pi/event-adapter.ts`）：pi 事件的**唯一**适配点，把 pi 事件翻译为内部 WS 消息（如 `message.tool_call_update`）。
3. **core 状态层**（`packages/core/src/domain/chat/effects/registry.ts`）：消费 WS 消息，更新 per-session 消息 store（`ToolCall` 实体）。
4. **renderer 展示层**（`packages/ui/src/features/chat/Block.vue`）：把 `ToolCall` 渲染为可折叠的 trace 块。

本文聚焦这四层之间的 bash 流式输出数据流。约束：**不修改 pi 源码**（MANDATORY，AGENTS.md），pi 的行为以 node_modules 实装版为准。

## 2. 设计目标

**改造后使用者能做到什么：**

1. **running 态可观察**：bash 长命令执行中，点击展开块能看到命令 + 实时增长的输出（对齐 pi CLI TUI 行为）；收起态 header 尾行视口滚动显示最新输出行。
2. **无空白假展开**：任何状态下（running 无输出命令、completed 空输出命令）点击展开都不会出现「header 摘要消失 + 内容区空白」的组合。
3. **既有语义零回归**：extension GUI 流式组件（`__gui__`）、subagent 进度、mock 流、live ≡ reload 等价性、WS ring 重连恢复全部不受影响，新增内存代价有界且显式判定。

**In-scope**：event-adapter `handleToolExecutionUpdate`、core registry `message.tool_call_update`、Block.vue 渲染条件与尾行取数、三层各自的测试。
**Out-of-scope**：pi 源码、composer bash（`BashOutputBlock.vue`，走独立 bashExecution 通道且无此 bug）、`ToolCall` 持久化格式（running 是 transient 态，不落盘）、message-bus ring 策略重构（本设计仅在 adapter 侧做帧瘦身，不动 topic 语义）、其他工具的流式 UI 增强收益（本设计顺带让它们受益但不专门设计）。

## 3. 现状：使用者眼里是什么样的

### 3.1 现状的真实样子

bash 长命令（如跑测试）执行中，对话流里的块长这样（收起态，1 行）：

```
⟳ bash · pnpm run test          ← header：loader + 工具名 + 命令摘要（argPath）
```

点击 header 后，实际发生的是：

```
⟳ bash                          ← 命令摘要变 invisible（Block.vue :class="{ invisible: toolExpanded && isBashTool }"）
                                  ← 下方没有任何内容渲染（展开区 v-if 不满足）
```

即：**第一行剩余内容消失，但没有任何展开内容出现**。这正是用户报告的「点击似乎可以展开，因为 block 第一行没有了后续内容，但是展开的内容看不到」。

### 3.2 怎么出错（失败模式）

| # | 失败模式 | 触发条件 |
|---|---|---|
| A | running 态点击展开 → header 摘要消失 + 展开区空白 | 任何 bash 命令 running 中（本 bug 主场景） |
| B | 收起态 header 尾行视口（设计上应滚动显示最新输出行）从不出现 | running 态 + bash 有流式输出——`toolTailLines` 取 `outputRaw`，恒 undefined |
| C | completed 态空输出命令（如 `cd /tmp`）点击展开 → 同样空白 | `displayContent === ''` 且无 guiComponent，v-if 不满足；header 摘要却已 invisible（同款条件不含内容检查） |

失败模式 A/B 的共同上游是同一个数据缺失；C 是渲染层独立的边界遗漏（被 A 掩盖，A 修复后会显形）。

### 3.3 根因

三层叠加，因果链从上游到下游：

**根因 1（数据层，核心）——event-adapter 丢弃 bash 流式 stdout。**

pi 0.84.4 实装版 bash 工具（`node_modules/@earendil-works/pi-coding-agent/dist/core/tools/bash.js`）running 态以 100ms 节流（`BASH_UPDATE_THROTTLE_MS = 100`）推送输出快照，partialResult 形态为规范的 AgentToolResult：

```js
onUpdate({
  content: [{ type: "text", text: snapshot.content || "" }],  // ← 流式 stdout 在这里
  details: { truncation: ..., fullOutputPath: ... },
})
```

而 event-adapter（`packages/runtime/src/infra/pi/event-adapter.ts:960`）的翻译只保留了 `.details`：

```ts
const detail: string | Record<string, unknown> | undefined =
  partialResult != null && typeof partialResult === 'object'
    ? ((partialResult as Record<string, unknown>).details as ...) ?? (partialResult as ...)
    : (partialResult as string | undefined)
```

bash 的 partialResult 是 object 且**有** `.details` → 命中第一分支 → `detail = { truncation, fullOutputPath }`。**`content[].text`（流式 stdout）没有任何字段承载，在适配层被整段丢弃。**

**根因 2（状态层）——registry 只写 `tool.detail`。**

core registry（`packages/core/src/domain/chat/effects/registry.ts:668`）的 `message.tool_call_update` handler 只把 detail 写进 ToolCall；`tool.output`/`tool.outputRaw` 要等 `tool_call_end` 才写入。所以 running 态前端实体的 output 恒 undefined。

**根因 3（渲染层）——展开区渲染条件在 running 态恒 false + header invisible 无内容检查。**

Block.vue 展开内容区：

```html
<div v-if="toolExpanded && (displayContent || guiComponent)" ...>
```

- `displayContent = result.value || (isFailed ? tool.error : '')`（`result = computed(() => props.tool?.output)`，Block.vue:315-317）→ running 态恒 `''`（根因 2）
- `guiComponent` 要求 detail 含 `__gui__` → bash 的 detail 是 `{truncation, fullOutputPath}` → undefined

→ 展开区整个不渲染。同时 header 摘要 `:class="{ invisible: toolExpanded && isBashTool }"` **不含内容存在性检查**——设计意图是「展开后命令在下方容器里完整显示，header 摘要隐藏避免重复」，但展开区没渲染时命令无处显示，形成假展开。

## 4. 根因 + 物理数据流

> **partialResult** = pi 工具执行期间 `tool_execution_update` 事件携带的部分结果，pi 声明为 any，运行时形态不定。**AgentToolResult 规范形态** = `{ content: ContentBlock[], details?: object }`（pi bash 快照即此形态）；**string 形态** = 自定义 extension 直接推字符串；**其他对象形态** = 无 content 数组的普通对象。就是上面 §3.3 里 bash 发的那个 `{ content: [...], details: {...} }`。
>
> 当前 partialResult 的真实生产者盘点（全仓核实）：① pi bash 工具——content 数组形态，唯一活跃生产者；② subagent 工具（`extensions/universal/subagent-workflow/src/interface/subagent-tool.ts:43`）——**签名**声明为 `AgentToolResult<SubagentToolResult>`（同为 content 数组形态），但其 onUpdate 生产路径已删（`packages/subagent-core/src/execution/subagent-service.ts:2260-2264` 注释明示「三调用点恒 onUpdate: undefined、仅测试触达」，git 历史可恢复）；③ string/其他对象形态——当前无生产者，为防御性兼容保留。

### 修复前的物理数据流（bash running 态）

```
pi bash 工具 (100ms 节流)
  └─ tool_execution_update
       partialResult = { content: [{type:'text', text:"...输出..."}],
                         details: { truncation, fullOutputPath } }
         │
         ▼
event-adapter.handleToolExecutionUpdate          [丢失点]
  object → 取 .details 覆盖整个对象
  detail = { truncation, fullOutputPath }        ← content 文本被丢弃 ✗
         │
         ▼  WS: message.tool_call_update { toolCallId, detail }
core registry 'message.tool_call_update'
  c.detail = { truncation, fullOutputPath }      ← output 恒 undefined ✗
         │
         ▼
Block.vue
  displayContent = result(=tool.output) → ''     ✗ 展开区 v-if false → 不渲染
  guiComponent = extractGui(detail)   → undefined ✗（无 __gui__）
  toolTailLines raw = outputRaw       → undefined ✗ 尾行视口死
  header 摘要 invisible               → 用户看到「假展开」✗
```

### 修复后的物理数据流

```
pi bash 工具 (100ms 节流)
  └─ partialResult（同上，pi 侧零改动）
         │
         ▼
event-adapter.handleToolExecutionUpdate          [改造点 U1]
  content 数组形态 → normalizePiToolResult(partialResult)
     → 原文尾窗截断 ≤8KB → output( stripAnsi ), outputRaw( 含 ANSI 时 )
  payload = { toolCallId,
              detail: details ?? 整个对象,        ← 既有语义不变（GUI 提取源）
              output, outputRaw }                ← 新增（仅 content 数组形态时，≤8KB 尾窗）
         │
         ▼  WS: message.tool_call_update（stream 类，入 ring——帧经 U1 瘦身后有界，见 D4）
core registry 'message.tool_call_update'        [改造点 U2]
  c.detail  = ...（写入行为与现状逐字一致：无条件覆盖）
  c.output  = output    ← running 态首次有值（条件写入，字段缺省不触碰）
  c.outputRaw = outputRaw
         │
         ▼
Block.vue                                        [改造点 U3]
  展开区渲染序：AnsiText(outputRaw，v-if 有 ANSI)
              → parsedJsonOutput（pre，JSON 归一，running 期 parse 失败回退 null）
              → displayContent span（纯文本兜底）  ← running 态首次可达
  toolTailLines raw = outputRaw ?? output → 尾行视口滚动
  v-if 加入 isBashTool               → bash 展开容器恒渲染（含命令块），空输出/无输出不再假展开
```

**WS 契约安全性**：`message.tool_call_update` 不在 `packages/shared/src/protocol.ts` 的 `ServerMessageMapBase` 精确清单内（协议.ts:780 仅登记 type 名），payload 走 `Record<string, unknown>` 占位桶（协议.ts:1695-1696）——payload 增补字段对类型系统零破坏，message-bus / ws-client / event-bus 全链路无字段白名单（payload 整体透传）。mock 生产端（`packages/core/src/transport/mock/run-send-stream-branches.ts:86`）只发 `detail`，新字段缺省 → registry 条件写入不触发，向后兼容。

**WS ring 代价（stream 类消息入可回放 ring）**：`message.tool_call_update` 是 stream 类（`message-bus.ts` TOPIC_TABLE，分配 seq + 入 ring，`DEFAULT_RING_CAPACITY = 1000` 帧不看字节）——update 帧带 output 后单帧从几十字节膨胀，若不治理，ring 满载 = 1000 帧 ×（output 50KB + outputRaw 50KB）≈ 100MB 常驻，且长命令会冲刷主对话流可回放帧制造重连 gap。本设计在 **U1（adapter 生产端）对 update 帧原文做 ≤8KB 尾窗截断**（换行锚优先、无换行硬切 + ANSI 残片推进 + 码点边界回退），帧内双字段（output + outputRaw，同源派生）最坏 ≈16KB/帧，ring 满载 ≤16MB（量化与显式判定见 D4）。

**live ≡ reload**：running 是 transient 态，pi session 文件只落盘 `toolResult` entry（end 时刻），running 期间的 output 不持久化——重开 session 由文件重放重建，与 live 终态一致，等价性链路（`apply-entry-equivalence`）零接触。

## 5. 终态：使用者眼里将是什么样的

### 5.1 成功路径

bash 跑一个渐进输出的长命令（用户在聊天框让 agent 执行 `for i in 1..5; do echo step-$i; sleep 2; done`）：

```
⟳ bash · for i in 1..5; do echo step-$i…     ← 收起态：header 尾行视口滚动显示 "step-2"
```

用户点击展开：

```
⟳ bash                                        ← header 摘要隐藏（命令已在下方显示，不重复）
  ┌──────────────────────────────────────┐
  │ for i in 1..5; do echo step-$i; …    │  ← 命令块（bg-bg-input 凹槽，既有样式）
  ├──────────────────────────────────────┤
  │ step-1                               │
  │ step-2                               │  ← 流式输出实时增长（2s 一行；输出超 8KB 后
  │ step-3                               │     显示为尾窗预览，完整输出以结束结果为准）
  └──────────────────────────────────────┘
```

命令结束后：loader → exit 标签（0 绿 / N 金），输出定格为完整快照（受既有 end 侧截断约束），展开态保持。展开容器内 meta 条 running 期保持为空（行数项被 bash 既有过滤规则结构性排除、耗时项需 endTime——见 §7 回归面表 useToolMeta 行），不出现中途行数统计。

### 5.2 失败路径（带恢复指引）

- **running 无输出命令**（`sleep 20`）点击展开：命令块可见，输出区为空——用户能确认「命令在跑、只是还没输出」，不再是空白假展开。
- **流式更新中断**（WS 断连/进程崩溃）：running 块走既有 end_not_received/completed 收口路径，展开区保留最后一次快照；重连 gap 走既有「全量重拉 + 幂等 dispatch」恢复（`session-message-handler.ts:559-589`），replay 收敛到最后一帧；恢复指引 = 重开 session（既有行为，本设计不新增故障路径）。

## 6. 关键决策与权衡

**本章结论：4 个决策，共同把「数据丢弃 → 空白假展开」改为「复用既有字段与渲染链路的全通修复」，且新增内存代价有界、显式判定。**

### 6.1 D1：流式输出载体 = 复用 `ToolCall.output/outputRaw`（选定）

- **采用**：event-adapter 对 **content 数组形态**（AgentToolResult 规范形态）的 partialResult 调 `normalizePiToolResult` 归一，payload 增补 `output/outputRaw` 字段；registry 条件写入 ToolCall 既有字段。展开区 `AnsiText`/尾行视口/`displayContent` 全链路**零新增分支**自然工作。
- **被否**：
  - *新增 `ToolCall.streamOutput` 字段*——语义「纯净」但 Block.vue 的 `displayContent`/`toolTailLines`/`copyContent`/`useToolMeta` 四处消费点都要加 running 分支，且 `tool_call_end` 到达时要合并 `streamOutput → output`，两个字段寿命不一致（streamOutput 存活于 running、output 存活于终态）是结构性漂移面。
  - *把文本塞进 `detail`*——detail 是 GUI 提取语义载体（running 态 `__gui__` 组件从 `tool.detail` 提取，Block.vue:431-437），bash 自己的 detail 已被 `{truncation, fullOutputPath}`（及首帧的整个 partialResult 对象）占用；混入文本会污染 GUI 提取路径。首帧形态实证：pi bash 初始帧为 `onUpdate({ content: [], details: undefined })`（`bash.js` 的 `if (onUpdate)` 分支，bash.js:280）——整对象进 detail 时 content 为空数组、不携带文本、体积可忽略；后续帧恒发 details 对象，`?? ` 不落穿，detail 通道不承载文本（经 r2 影响面审源码证伪「detail 绕过截断」攻击）。
  - *renderer 绕过 runtime 直连 pi 事件*——违反「pi 适配层唯一适配点」架构约束（AGENTS.md 关键规则 5），直接否。
- **证据**：`normalizePiToolResult` 已存在且被 end 路径复用（`runtime/normalize-tool-result.ts:36`，content 数组 → stripAnsi 文本 + outputRaw ANSI 分离 + details/images 提取）；`message.tool_call_update` payload 走占位桶（`shared/protocol.ts:1695`）加字段零类型破坏；pi bash partialResult 形态经实装版核实（`pi/dist/core/tools/bash.js:243-290`）。
- **效果**：§5.1 流式输出实时增长 + §2 目标 1 成立；不修 pi、不加新字段、渲染链路零分支。

**判别式（防污染关键）**：仅当 `partialResult` 是 object 且 `Array.isArray(partialResult.content)`（AgentToolResult 规范形态）才归一产出 output/outputRaw；string 与其他对象形态不产出 output（detail 语义原样）。这是**防御性判别式**：当前唯一活跃的 content 形态生产者是 pi bash；string/其他对象形态今天没有生产者，判别式防的是未来非规范形态生产者把非文本 payload 误当输出（避免任意对象被 `JSON.stringify` 变成 output）。已知的事实约束一并登记：subagent 工具的 onUpdate **签名**恰为 content 形态（`subagent-tool.ts:43`）但生产路径已删（`subagent-service.ts:2260` 死路径注释）——若未来复活，会命中判别式产出 output，处置见 §9.3 检查点与 §7 回归面表。

### 6.2 D2：bash 展开容器恒渲染（v-if 加入 `isBashTool`）（选定）

- **采用**：Block.vue 展开区条件改为 `toolExpanded && (displayContent || guiComponent || isBashTool)`——bash 块展开时恒渲染容器（命令块 + 输出区，输出区无内容时不渲染文本）。
- **被否**：*仅修 running 态*（`|| (isRunning && isBashTool)`)——遗漏失败模式 C（completed 空输出命令如 `cd /tmp` 展开同样空白，header 摘要却已隐藏）。恒渲染让两类边界同构消失，且「命令块」本来就是展开容器的第一行，bash 展开必显命令是更符合直觉的语义。
- **证据**：失败模式 C 复现路径——`displayContent === ''` 时 v-if false，而 `invisible` 条件（`toolExpanded && isBashTool`）不含内容检查。
- **效果**：§5.2 失败路径成立 + §2 目标 2 成立；同时让 header invisible 恒安全（命令必在下方显示）。

### 6.3 D3：尾行视口取数 `outputRaw ?? output`（bash 分支）（选定）

- **采用**：`toolTailLines` 的 bash raw 源改为 `outputRaw ?? displayContent`（stripAnsi 后取尾），修复失败模式 B——设计上存在的 running 态尾行滚动从首次实现起就因取数源恒 undefined 而从未工作。
- **被否**：*维持现状*——尾行视口是 2026-08 抖动修复（useTailScroll 状态机）专门为 tool 块建的能力，thinking 块的同款机制工作正常，唯独 tool 块因数据缺失死置；修 D1 后顺手接通，零额外成本。
- **证据**：Block.vue `toolTailLines`：`const raw = isBashTool.value ? outputRaw.value : displayContent.value`——bash 取 outputRaw，running 态恒 undefined。
- **效果**：§5.1 收起态尾行滚动成立。

### 6.4 D4：update 帧尾窗截断 ≤8KB——WS ring 放大有界化（选定）

- **采用**：U1（adapter 生产端）对 update 帧归一后的原文做**尾部保留截断**，规格两分支无例外：
  - **换行锚分支**：原文超 8KB 且截断点之后存在换行 → 从「截断点后首个换行」起保留尾窗（避免半行）；
  - **硬切回退分支**：截断点之后无换行（单行超长：minified JSON / base64 块 / 无换行响应）→ 三步管线：① 在截断点硬切；② **ANSI 残片推进**——若截断点落在 ESC 序列内（向前最近的 `\x1b` 到截断点之间无 CSI 终止字节 `0x40-0x7E`；**实施修正：排除紧随 ESC 的 CSI 引导字节 `[`（0x5B，落在终止区间但语义为引导）——否则任何 CSI 序列都被立即判「已终止」，中段检测永不可达**），尾窗起点推进到该残缺序列的 CSI 终止字节之后（自截断点向后扫描至首个 `0x40-0x7E` 字节 +1 即起点——比「推到下一 `\x1b`」丢弃更少且实现更简；判定仅对 CSI 序列充分，OSC/DCS 等非 CSI 转义的 payload 可含 `0x40-0x7E` 字节致截点误判「不在序列内」或扫描提前结束，残余字面渲染登记接受，见显式判定）；③ **码点边界回退**——起点落在低代理 `0xDC00-0xDFFF`（其高代理对在窗外被劈）则后移一位丢弃孤儿码元（不劈开代理对/多字节字符；最后执行，保证推进后的起点同样安全）。**〔实施修正：原表述「起点落在高代理则前移」方向有误——起点在高代理时其对 (start, start+1) 本就完整，被劈的是起点为低代理的场景〕**
  两分支共同保证不变式「**截断后原文 ≤ 8KB，无例外**」；output（stripAnsi）与 outputRaw 从同一截断后原文派生（不变式条件化表述：**当 outputRaw 存在时** `output === stripAnsi(outputRaw)`——outputRaw 仅含 ANSI 时存在，见 normalize-tool-result.ts:19-20）；end 帧不截断（走既有 entry 持久化与 end 侧截断）。
- **代价四要素（显式判定：接受）**：
  - **量级**：单字段 ≤8KB、双字段帧（output + outputRaw 同源各 ≤8KB，ANSI 场景双份同存）最坏 ≈16KB → ring 满载 = 1000 帧 × ≤16KB ≈ **≤16MB**/活跃流式 session（纯无 ANSI 输出 ≈8MB；不截断则 1000 × ≈100KB ≈ 100MB）；ring 为 per-session（`message-bus.ts:33/202`），>5 并发流式 session 聚合 ≈ ≤80MB；重连 gap 时 subscribe snapshot 把 ring 内帧整体重放，单条 WS 消息最坏同量级（≤16MB，典型远小于此——多数 bash 输出快照 < 8KB，帧恒小）。
  - **恢复路径**：已存在——重连 gap（`fromSeq < ring 最旧 seq`）→ 全量重拉 + 幂等 dispatch（`session-message-handler.ts:559-589`）；update 帧 replace 语义，重放收敛到最后一帧，无需新增恢复机制。
  - **重审条件**：出现 >5 个并发长输出 bash session 常态化（聚合 ring ≈ ≤80MB 量级）、或用户报告重连/回放卡顿 → 重审 ring 策略（候选：update 帧 output 进一步降 cap、评估 topic 降级）。
  - **显式判定**：接受 ≤16MB 有界代价（双字段推导见量级），换 GUI detail 帧的重连回放语义不动；另登记三项已接受代价——① running 期输出超 8KB 后展开区静默切换尾窗、无「上文已截断」视觉标记（量级：仅 running 期展开态可见；恢复路径：end 全量快照 + pi 自身快照截断时内嵌的省略标记；**重审触发：用户报告 running 期误以为输出丢失**；不为 transient 态加标记是减法裁决，避免跨三层新增 truncated 标记字段）；② 硬切分支 ANSI 残片残余——残缺序列无终止字节可扫、以及 OSC/DCS 等非 CSI 转义 payload 含 `0x40-0x7E` 致截点误判「不在序列内」的残段，均按字面渲染（判定仅对 CSI 充分；四条件交集：无换行 + 含 ANSI + 截断点在序列内 + 后续无终止，概率极低；transient + end 全量恢复）；③ 码点边界不防 grapheme cluster 劈开（ZWJ emoji/组合字符字形可能异常——视觉级非数据损坏，100ms 后续帧自愈，不上 Intl.Segmenter）。另登记两层截断语义边界：update 帧 8KB 尾窗（transient 预览）与 pi 快照 50KB 截断（含 truncation 元数据，经 detail.fullOutputPath 提供完整输出恢复通道）独立生效，end 帧语义不受尾窗影响。
- **被否**：
  - *topic 降级 transient / state（不入 ring，对齐 `session.subagentEntriesAppended` 先例，message-bus.ts:64-66）*——改的是**全体** tool_call_update 帧的重放语义：GUI 流式组件断连重连后丢失最后 detail 状态、mock 回放受影响；为 bash 一个生产者动全局路由表，爆炸半径大于收益。
  - *adapter 内 per-call 合并节流（降帧率）*——adapter 现为无状态纯翻译层，per-call 定时器引入状态化 + 生命周期（abort/清理）复杂度，且不解决单帧体积；截断已把两个维度同时压住。
  - *ring 侧截断（改 message-bus）*——ring 是通用基础设施，按 topic 加字段级裁剪逻辑属于特化泄漏；生产端（adapter）截断是单点且离数据最近。
- **证据**：TOPIC_TABLE `message.tool_call_update: 'stream'` 入 ring（message-bus.ts:78）；`DEFAULT_RING_CAPACITY = 1000`；pi 快照上界 `DEFAULT_MAX_LINES = 2000` / `DEFAULT_MAX_BYTES = 50KB`（`pi/dist/core/tools/truncate.js:10-11`）；项目对高频帧冲刷 ring 的既有认知（message-bus.ts:64-66 注释）。
- **效果**：§2 目标 3「新增内存代价有界且显式判定」成立；U1 截断不改变 §5.1 体验（8KB ≈ 200 行尾窗，展开区本就限高滚动）。

### 6.5 方案对比总表

| 方案 | 长期架构合理性 | 短期实现成本 | 风险 | 裁决 |
|---|---|---|---|---|
| **A：adapter 归一（尾窗截断）→ payload 增补 → 复用 output/outputRaw（D1-D4）** | 高——流式与终态共用一套字段一套渲染链路，语义「output = 工具产出文本」单调 | 低——3 处小改 + 3 层测试 | WS payload 增字段（占位桶，兼容）；ring 放大经 D4 压至 ≤16MB 有界；非规范形态误入由判别式消除 | ✅ |
| B：新增 streamOutput 字段 + 渲染层分支消费 | 中——字段双轨（running/终态寿命不一致）长期是漂移面 | 中——4+ 消费点分支 + end 合并逻辑 | 字段交接边界（end 覆盖、失败回退）易漏 | ❌ |
| C：文本进 detail | 低——detail 语义（GUI 提取源）被污染 | 低 | `extractGui`/BlockSubagent 消费点全部要防御文本字段 | ❌ |
| D：renderer 直连 pi 事件 | 不成立——违反适配层唯一性约束 | — | — | ❌ |

**被否若用**：方案 B 会让 §5.1 的例子在 end 时刻经历一次「streamOutput 销毁 → output 接管」的字段交接，交接边界（end content 缺失、isError、乱序）每一处都是新增的失败模式；方案 C 会让 GUI 组件提取（`extractGui(tool.detail)`）和 BlockSubagent 的 detail 消费都要先剥离 bash 文本字段。

## 7. 实现机制

**三层各一处改造点，数据流方向不变（pi → adapter → core → renderer）。**

### U1 runtime：`handleToolExecutionUpdate`（`packages/runtime/src/infra/pi/event-adapter.ts:960`）

```ts
function handleToolExecutionUpdate(event: PiToolExecutionUpdateEvent, sid: string): PiTranslatedEvent[] {
  const partialResult = event.partialResult
  // 既有 detail 语义原样保留（string / details ?? 整个对象）
  const detail = ... // 现逻辑不动
  // [新增] AgentToolResult 规范形态（content 数组）→ 归一流式文本；其余形态不产出 output
  // [新增] 归一后的原文做 ≤8KB 尾窗截断（D4），output/outputRaw 同源派生
  const normalized =
    partialResult != null && typeof partialResult === 'object' && Array.isArray((partialResult as Record<string, unknown>).content)
      ? normalizeWithTailCap(partialResult, STREAM_OUTPUT_CAP_BYTES)
      : undefined
  return [{
    kind: 'message',
    message: {
      type: 'message.tool_call_update',
      payload: {
        sessionId: sid, toolCallId: event.toolCallId, detail,
        ...(normalized && normalized.output !== undefined && { output: normalized.output }),
        ...(normalized?.outputRaw !== undefined && { outputRaw: normalized.outputRaw }),
      },
    },
  }]
}
```

要点：
- `normalizeWithTailCap` = 既有 `normalizePiToolResult` 的文本抽取 + U1 内新增的尾窗截断，规格按 D4：换行锚分支（截断点后首个换行起保留）/ 硬切回退分支三步管线（硬切 → ANSI 残片推进 → 码点边界回退）——「截断后原文 ≤ 8KB」无例外；截断发生在 stripAnsi 之前的原文上，output/outputRaw 同源派生（不变式：当 outputRaw 存在时 `output === stripAnsi(outputRaw)`，由构造保证）；content 空数组返回 `output: ''`（显式空串也下发——registry 写入空串，语义「已知无输出」）。单测必须覆盖无换行硬切分支（含代理对边界、截断点落在 CSI 序列中段两个用例）。
- images 字段 running 态不消费（pi bash 不流式图片，减法）。
- 截断常量 `STREAM_OUTPUT_CAP_BYTES = 8 * 1024` 与 D4 量化绑定，实施时以具名常量落位。

### U2 core：`message.tool_call_update`（`packages/core/src/domain/chat/effects/registry.ts:668`）

```ts
const detail = readDetail(payload, 'detail')
const output = readString(payload, 'output')        // readers.ts 既有 reader
const outputRaw = readString(payload, 'outputRaw')
// map 内——detail 写入行为与现状逐字一致（无条件 spread，缺 detail 帧清空旧值，现状语义不变）：
// output/outputRaw 为新增字段，条件写入（缺省不触碰），与 end 路径的 `...(x !== undefined && { x })` 风格一致：
c.id === callId
  ? { ...c, detail, ...(output !== undefined && { output }), ...(outputRaw !== undefined && { outputRaw }) }
  : c
```

`readString` 对非字符串返回 undefined——mock/异常帧的畸形 payload 天然降级为「不写」。ID 锚定（`findToolCallOwner`）、sealed guard（`updateStreamingAssistant`）不动。

### U3 renderer：Block.vue（`packages/ui/src/features/chat/Block.vue`）

1. 展开区 v-if：`v-if="toolExpanded && (displayContent || guiComponent || isBashTool)"`；bash 容器内输出文本区补内容守卫（`displayContent || outputRaw || parsedJsonOutput` 均空时不渲染输出 div，只剩命令块）。
2. `toolTailLines` bash raw 源：`outputRaw.value ?? displayContent.value`。
3. header `invisible` 条件不动（D2 保证 bash 展开恒有命令块显示，invisible 恒安全）。

### 回归面核对（改动不触碰 / 已声明的行为面）

| 面 | 核对结论 |
|---|---|
| subagent 进度（BlockSubagent） | 生产端 onUpdate 已删、恒 undefined（`subagent-service.ts:2260` 注释明示死路径）——今天 subagent 块 running 态**没有** tool_call_update 帧，本改动对它零影响。事实约束：`subagent-tool.ts:43` 的 onUpdate **签名**为 `AgentToolResult<SubagentToolResult>`（content 形态）——若未来复活会命中判别式、running 态 output 被写入中间快照文本；届时 `BlockSubagent.vue:108` 的 `JSON.parse(props.tool.output)` 在 running 早期 parse 失败本就是 no-op 预期分支（点击安全性不受影响），但 output 语义需专项复查（§9.3 检查点） |
| GUI 流式组件（`__gui__`） | details 照旧进 payload.detail → registry 无条件写 c.detail（与现状一致）→ `guiComponent` 流式 fallback（Block.vue:431-437，running-only 门控）原样 |
| useToolMeta（行数/字符数/耗时） | 消费 `tool.output`（`useToolMeta.ts:48-55`）：running 态 output 出现后 `metaItems` 会含「N 行」项，**但** ① bash 的行数项被 `filteredMetaItems` 结构性过滤（`text.endsWith('行')`，bash 恒过滤）② meta 条只渲染在展开容器内且 bash meta 条用 filteredMetaItems ③ 耗时项需 endTime（running 期不存在）→ **running 态展开区 meta 条仍为空，用户可见面无变化**；completed 态行为与现状一致（output 为最终值）。本行为已按 S1 观察点验收 |
| mock 流 | 只发 string detail → output 字段缺省 → registry 条件写入不触发；`readString` 畸形降级 |
| end 路径 / applyEntry / 等价性测试 | end 覆盖逻辑、reducer、持久化链路零改动（§4 live ≡ reload）；running 期截断不影响 end 全量快照 |
| WS ring / 重连 | update 帧经 U1 尾窗截断后 ring 放大有界（D4 四要素）；gap 全量重拉路径不变 |
| composer bash（BashOutputBlock） | 独立 bashExecution 通道，不经过 tool_call_update |
| copyContent（Block.vue:344-349） | running 态 bash 复制内容从「仅命令」变为「命令 + 尾窗输出」（≤8KB）——顺带收益，符合复制语义直觉，不单独验收 |

## 8. 验收（真实场景，非单测非 mock）

### 8.1 改动规模

**中**——跨 runtime/core/ui 三层的数据流修复 + 渲染条件变更（行为变更）。需要多场景真实验收，但每场景验证成本低（dev app 手动操作 + 观察）。

### 8.2 验收场景

| # | 场景 | 回溯目标 | 真实流程 | 通过标准 |
|---|---|---|---|---|
| S1 | running 态流式输出可见 | 目标 1 | `pnpm dev` 起真实 session，让 agent 执行 `for i in 1 2 3 4 5; do echo step-$i; sleep 2; done`；running 中点击块展开 | 展开区显示命令块 + 输出行随时间从 step-1 增长到 step-5（约 10s 内至少新增 3 行）；收起态 header 尾行滚动显示最新 step 行；展开容器内 meta 条 running 期保持为空（无行数/耗时项，既有过滤行为不变） |
| S2 | 无输出命令无假展开 | 目标 2 | 让 agent 执行 `sleep 20`，running 中点击展开 | 命令块可见、无输出区（或空输出区），header 摘要消失但下方命令块在——不再出现全空白 |
| S3 | 终态正确 + live ≡ reload | 目标 1/3 | S1 命令结束后观察；然后关闭 session 重开 | 展开区输出定格完整（非 8KB 尾窗）、exit 标签正确（0 绿）；重开后对话流与关闭前一致（输出/状态/展开折叠态默认收起） |
| S4 | 既有流式语义回归 | 目标 3 | ① `VITE_MOCK=true` 跑 mock 流（detail 字符串进度 + GUI 卡片）② 真实 session 派 subagent 观察进度块 | ① GUI 卡片渲染正常、无多余 JSON 文本混入、进度文本不进 output（判别式负面验证）② subagent 块进度滚动正常——均与修复前一致 |
| S5 | 高频大输出 + 重连恢复 | 目标 3（成本有界 + 零回归）+ 目标 1 | 两个命令分别覆盖截断两分支：① `yes xyz-agent-stream-check \| head -c 2000000`（**换行锚分支**——yes 每行带换行）② `cat /dev/zero \| tr '\0' 'a' \| head -c 2000000`（**硬切回退分支**——无换行单行 2MB）；各 running 中保持展开观察 5s；期间断开重连 renderer（重载窗口）观察恢复 | 观察项（全部可证伪）：① 界面不卡顿、不白屏 ② 展开区输出被截为尾窗（≤8KB 量级，非全量 2MB；命令 ② 尾窗无半字符/乱码——码点边界回退生效）③ end 后展开区为完整快照（受既有 end 截断约束，含截断语义）④ 重连后 gap 恢复、流式继续、最终态一致；内存有界性由 D4 源码证据与 ring 量化背书，不作为手测项 |

单测职责（代码符合设计假设，非验收替代）：adapter 三形态分发 + 尾窗截断两分支（换行锚 / 无换行硬切含代理对边界与 CSI 中段残片推进）+ 不变式（**当 outputRaw 存在时** `output === stripAnsi(outputRaw)`，截断后原文 ≤ cap 无例外）、registry 条件写入与 end 覆盖、Block.vue 展开条件与尾行取数——分属三层既有测试文件扩展。

## 9. 实施

### 9.1 迁移路径

| 阶段 | 内容 | 交付终态的什么 |
|---|---|---|
| M0 | U1 adapter + 单测（三形态分发 + 尾窗截断） | 数据不丢且帧有界 |
| M1 | U2 registry + 单测（条件写入 / detail 现状语义保持 / end 覆盖） | 状态可达前端 |
| M2 | U3 Block.vue + 组件测试（展开条件 / 尾行） | 用户可见终态 |
| M3 | §8.2 真实验收 S1-S5 + lint/typecheck/相关包测试全绿 | 验收通过 |

各阶段独立可验证；M0/M1 先合入对用户无可见影响（渲染层不消费），M2 是行为变更点。

### 9.2 下一层拆分

| 单元 | 说明 | justification |
|---|---|---|
| U1 | event-adapter `handleToolExecutionUpdate` 归一 + 尾窗截断（换行锚 / 硬切回退两分支）+ payload 增补；`event-adapter-delta.test.ts` 或新建 `event-adapter-tool-update.test.ts` 覆盖三形态 + 两分支截断（代理对边界、CSI 中段） | 单一生产端改动点，独立可测（输入 partialResult → 断言 payload），D4 截断离数据最近 |
| U2 | registry `message.tool_call_update` 读写器 + 条件写入（detail 保持现状无条件语义）；`effects.test.ts` 扩展 | 状态层单点；与 U1 以 WS payload 契约解耦，可 mock payload 独立测 |
| U3 | Block.vue v-if / 尾行取数 / 输出区内容守卫；`Block.test.ts` 扩展（running 展开渲染命令块 + 流式输出、空输出无假展开） | 纯展示层；以 ToolCall fixture 独立测，不依赖 U1/U2 |
| U4 | §8.2 真实验收（S1-S5 手动场景 + dev app） | 真实集成验证不可 mock 替代，独立于单测执行 |

**文件改动地图**：

| 文件 | 改动 |
|---|---|
| `packages/runtime/src/infra/pi/event-adapter.ts` | `handleToolExecutionUpdate` 归一 + 截断 + payload 增补（U1） |
| `packages/runtime/src/infra/pi/__tests__/event-adapter-*.test.ts` | U1 测试（新建或扩展 delta 测试） |
| `packages/core/src/domain/chat/effects/registry.ts` | `message.tool_call_update` 增 output/outputRaw 读写与条件写入（U2） |
| `packages/core/src/domain/chat/__tests__/effects.test.ts` | U2 测试扩展 |
| `packages/ui/src/features/chat/Block.vue` | v-if / toolTailLines / 输出区内容守卫（U3） |
| `packages/ui/src/features/chat/__tests__/Block.test.ts` | U3 测试扩展 |

### 9.3 待验证检查点

- **AnsiText 高频重渲染成本**：2MB 级输入 @100ms 节流下 ansi_up 解析开销（S5 实测；若卡顿，备选方案 = 渲染层对 outputRaw 做 200ms 内合并节流，属 U3 局部加固，不改设计）。
- **subagent onUpdate 复活复查项**：`subagent-tool.ts:43` 签名为 content 形态、生产路径已删（`subagent-service.ts:2260`）——若未来恢复 onUpdate 投影，将命中判别式使 running 态 output 被中间快照文本占据；届时需专项复查 BlockSubagent 的 output 消费（`JSON.parse` 提取 subagentId）与 output 语义冲突（本检查点登记为复审触发器，不阻塞本次实施）。
- **pi 其他内置工具是否也流式**（grep/find 等）：按 pi 实装版仅 bash 有 onUpdate 快照；若实施时发现其他工具也发 content 形态 partialResult，判别式自动覆盖，无额外工作。

## 附录：变更历史与被否谱系

- v1：初版——根因三层分析（adapter 丢弃 / registry 不写 / 渲染恒 false + invisible）、方案 A-D 对比、四决策、S1-S5 验收、U1-U4 拆分。
- v2：对抗式审查第 1 轮修复（主审 0 must-fix / 4 suggestion + 影响面审 2 must-fix / 4 suggestion，全部当轮修复）：
  - **[MF1→D4 重写]** 补 WS ring 帧放大量化与显式判定（原 D4 只覆盖 pi 单帧上界，漏 ring × 1000 帧保留维度）——新增 update 帧尾窗截断 ≤8KB（U1），代价四要素落 D4；被否谱系新增：topic 降级 transient（击穿反例：改全体 tool_call_update 重放语义，GUI detail 断连恢复丢失）、adapter per-call 合并节流（击穿反例：无状态翻译层被状态化 + 生命周期复杂度）、ring 侧截断（击穿反例：通用基础设施特化泄漏）。
  - **[MF2→§4/§6.1/§7/§9.3]** 修正 subagent 进度的事实断言：原「扁平 progress 对象无 content 数组」与源码矛盾——实情是生产死路径（`subagent-service.ts:2260`）+ 签名恰为 content 形态（`subagent-tool.ts:43`）；判别式改为防御性表述（当前无 string/扁平形态生产者），§9.3 登记复活复查项，回归面表如实重写（含 BlockSubagent `JSON.parse(output)` 死路径安全性）。
  - **[S→U2]** detail 写入保持现状无条件 spread（原 U2 代码悄然改条件写入与 §4「不变」矛盾）——采纳「真正不变」选项。
  - **[S→§7 回归面表 + S1]** useToolMeta 行为按源码如实登记：行数项被 bash `filteredMetaItems` 结构性过滤、耗时项需 endTime → running 态展开区 meta 条仍为空，可见面无变化；S1 增加该观察点。
  - **[S→§3.3/§4]** `displayContent` 引用改逐字（`result.value`，result = computed(() => props.tool?.output)）。
  - **[S→S5]** 通过标准聚焦可观察项（不卡顿/不白屏/尾窗/完整快照/重连恢复），内存有界性由 D4 源码证据背书，不作为手测项；S5 并入断连重连 gap 恢复步骤（P0-21 邻居不变量）。
  - **[S→§4 后图]** Block.vue 渲染序改真实三段回退（AnsiText → parsedJsonOutput → displayContent span）。
  - **[S→§6.1/回归面表]** 首帧形态实证补录：pi bash 初始帧 `onUpdate({content:[], details:undefined})`（bash.js:280），detail=整对象时 content 空数组不携带文本、体积可忽略——封死「detail 绕过截断」攻击面（r2 影响面审源码证伪）。
- v3：对抗式审查第 2 轮修复（主审 1 must-fix / 2 suggestion + 影响面审 2 must-fix / 2 suggestion，全部当轮修复）：
  - **[MF→D4/U1]** 尾窗截断无换行分支显式定义：换行锚 / 硬切回退（码点边界，不劈代理对）两分支，不变式「截断后原文 ≤8KB」无例外；S5 拆双命令分别验收两分支（`yes` 系换行分支——r2 主审称 yes 无换行系事实错误，影响面审已纠正；无换行用 `tr '\0' 'a'` 构造）；单测补无换行 + 代理对边界用例。
  - **[MF→D4/§4/§6.5]** ring 量级修正 2×：双字段帧（output+outputRaw 同源各 ≤8KB）最坏 ≈16KB/帧 → ring 满载 ≤16MB（原 ≤8MB 低估）；不截断基准同步修正为 ≈100MB；重连 snapshot 同步 ≤16MB；显式判定按修正后量级重述。
  - **[S]** 截断不变式条件化（「当 outputRaw 存在时」，outputRaw 仅含 ANSI 时存在）；**[S]** running 期尾窗无截断视觉标记登记为已接受 UX 代价（减法裁决，理由入 D4）；**[S]** S5 回溯标号纠正（成本有界属目标 3）；**[S]** §6.1 补首帧形态实证防重复攻击。
- v4：对抗式审查第 3 轮修复（主审 0 must-fix / 3 suggestion + 影响面审 1 must-fix / 2 suggestion，全部当轮修复）：
  - **[MF→D4/U1]** 硬切分支升级三步管线：硬切 → ANSI 残片推进（截断点落 ESC 序列内时起点推至后续首个 `\x1b`，残段丢弃）→ 码点边界回退；无后续 ESC 的残余登记为已接受代价（四条件交集）；单测补 CSI 中段用例；§8 S5 命令 ② 观察项同步。
  - **[S]** grapheme cluster 劈开（ZWJ/组合字符字形异常）登记接受（视觉级、100ms 自愈、不上 Segmenter）；**[S]** UX 代价登记补重审触发条件（用户报告误以为输出丢失）；**[S]** per-session ring 聚合数字显式化（>5 并发 ≈ ≤80MB 入重审条件）；**[S]** 两层截断语义边界登记（8KB 尾窗 vs pi 50KB 快照 + fullOutputPath 恢复通道）；**[INFO]** §9.2 U1 测试描述点名两分支。
- v4.2：实施期 U1 偏差回写（合理不一致 → 设计措辞同步，C-proc-10）：D4 硬切分支 ② 排除 CSI 引导字节 `[`（0x5B 落在终止区间但语义为引导，按字面则中段检测永不可达——4 轮审查均未发现的规格 bug）；③ 码点回退方向修正（起点落低代理被劈、非高代理）。
- v4.1：r4 终审双份 0 must-fix（设计就绪），3 条 INFO 级 suggestion 同批落位：§4 ring 段概括句点名 ANSI 残片推进；ANSI 推进目标改「扫到 CSI 终止字节 +1」（丢弃更少、实现更简）+ 判定仅对 CSI 充分的 OSC/DCS 误判声明入已接受代价 ②。审查收敛轨迹：r1（0+2 MF / 4+4 SG）→ r2（1+2 / 2+2）→ r3（0+3 / 1+2）→ r4（0+1 / 0+2，全 INFO）。
