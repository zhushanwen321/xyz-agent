# 对话流 Block 渲染顺序重构

> **一句话结论**：对话流里每个 block（text/thinking/toolCall）的显示位置应由 `contentBlocks` 数组的稳定顺序决定，而不是由"是否末位 assistant"这个会随 streaming 翻转的派生量决定；本次取消"末位 filter"，让 text 始终可见（不进折叠区）、thinking/toolCall 受折叠控制，从结构上消除 block 跳变，同时不破坏"回答常驻、执行细节可折叠"的现有契约。

## 开篇（SCQA）

- **S（情境）**：xyz-agent 对话流把一条 AI 回答渲染成若干 block（文字 / thinking / 工具调用），按回合（turn）分组展示。
- **C（冲突）**：streaming 时 block 会在屏幕上突然跳位——先出现的文字块，会在工具块出现后瞬间被挪到别处，或工具块突然跳到文字上方。
- **Q（问题）**：怎么让每个 block 一旦出现就待在它该在的位置，整个 streaming 过程零跳变，且不破坏"回答常驻可见、执行细节可折叠"的现有契约？
- **A（答案）**：block 的渲染位置只认 `contentBlocks` 数组顺序这一个稳定来源；text 作为"回答内容"始终可见（不随 trace 折叠），thinking/toolCall 作为"执行细节"受折叠控制；砍掉所有"按末位推断位置"的派生逻辑。本文展开这个答案。

---

> **层性质声明**（准则 10）：本次设计的**当前层 = 渲染架构方案**，**下一层 = 组件接口 + 代码改动清单**。不跨到"逐函数实现"层。
>
> **层敏感准则**（准则 5/6/7）：本次涉及 streaming 数据流与运行时渲染行为，三条全部 P0 适用。

---

## 1. 背景：对话流渲染管线是什么

**对话流渲染管线负责把 pi（AI 后端）吐出的事件流变成屏幕上可见的 block 序列。** 一个使用者在 panel 里看到的一轮 AI 回答，背后经历：pi 推送事件 → runtime 转译 → 前端 store 累积 → 组件渲染。

涉及的核心数据结构（`packages/shared/src/message.ts`）：

```ts
export interface Message {
  role: 'user' | 'assistant' | 'system'
  content: string | Segment[]          // 文本内容（assistant 是字符串）
  status: 'streaming' | 'complete' | 'error'
  toolCalls?: ToolCall[]               // 工具调用
  thinking?: ThinkingBlock[]           // 思考块
  contentBlocks?: ContentBlock[]       // 有序内容块，记录到达顺序 ← 设计上的 SSOT
}

export interface ContentBlock {
  type: 'thinking' | 'toolCall' | 'text'
  refId: string   // thinking/toolCall 指向对应数组元素 id；text 恒为 'text'
}
```

> **术语：turn（回合）**。一轮对话 = 一个 user 提问 + 其后连续的 AI 回答。`toRenderItems()`（`packages/core/src/domain/chat/message-turns.ts`）把扁平 `Message[]` 按 user 切分成 `MessageTurn`，一个 turn 的 `assistants` 数组可能含**多条** assistant message（原因见 §3.3）。

> **术语：block（内容块）**。一条 assistant message 内部，按产出顺序的原子展示单元：text / thinking / toolCall。`contentBlocks` 数组记录它们的顺序，`expandAssistantBlocks()`（`message-turns.ts:158`）据此解成 `OrderedBlock[]` 渲染列表。

> **术语：trace 折叠 / showTrace**。`Turn.vue` 把"执行细节"（thinking/toolCall）放在一个可折叠的 trace 区，由 `showTrace = sessionActive || isExpanded(turn.index)` 控制显隐。对话进行中（`sessionActive`）或手动展开时显示，完成后默认折叠。这是现有契约：**回答文字常驻可见，执行细节可折叠**。

本次设计聚焦：**一条 assistant message 内部 block 的渲染位置决策**，以及 text 与 trace 折叠的正确关系。

---

## 2. 设计目标

**改造后，使用者在对话流里：**

1. **block 零跳变**：任何 block 一旦出现，在它所属 message 的整个生命周期里位置不变（streaming 中、完成后、重连后都不变）。
2. **顺序符合直觉**：block 按真实产出顺序自上而下排列（先说的在前，后调的工具在后），与"读对话"的自然阅读顺序一致。
3. **重连前后一致**：streaming 中途断线重连、或关闭重开 session，看到的 block 顺序与文字可见性与不断线时完全相同。
4. **不破坏现有契约**：回答文字始终可见（不论 trace 折叠与否）；执行细节（thinking/toolCall）保持可折叠。

**In-scope**：
- `Turn.vue` 的 block 渲染顺序决策（"末位 filter"）与 text 的可见性边界
- `TurnSummary.vue` 的职责收窄（去内容化）
- streaming 光标的归位
- `Message.content` 在渲染层的角色澄清

**Out-of-scope**（显式声明不做，防 scope creep）：
- 不改 pi 事件协议（`event-adapter.ts` 的 noop 策略保留，见 §6.5）
- 不合并"一个 turn 多条 assistant message"（§6 决策 D，留作后续评估）
- 不改 `contentBlocks` 的数据结构本身（它已经是正确的 SSOT，问题在消费端）
- 不改 compact / fork / handoff 逻辑（它们读 `Message.content`，本次保留该字段与数据角色）

---

## 3. 现状：使用者眼里是什么样的

### 3.1 现状的真实样子

使用者向 AI 发一句"读一下 a.ts 然后告诉我内容"。AI 的典型回答是"先说话、再调工具、再总结"。**当前渲染会把这一轮拆成两条 assistant message**（a1 = 说话 + 工具调用，a2 = 总结），它们属于同一个 turn：

```
┌─ turn ─────────────────────────────────────┐
│ [user] 读一下 a.ts 然后告诉我内容            │
│                                              │
│ ┌─ TurnMeta（回合头，始终可见）──────────┐  │
│ │                                          │  │
│ │ ┌─ trace 区（v-if="showTrace"，折叠/展开）┐│
│ │ │ <a1 的 block 在这里>                  │ │ │
│ │ │ <a2 的 block 在这里>                  │ │ │
│ │ └──────────────────────────────────────┘ │ │
│ │                                          │ │
│ │ ┌─ TurnSummary（始终可见）──────────────┐ │ │
│ │ │ <最后一条 assistant 的文字> + 操作栏   │ │ │
│ │ └──────────────────────────────────────┘ │ │
│ └──────────────────────────────────────────┘ │
└──────────────────────────────────────────────┘
```

决定 block 去向的核心代码（`packages/ui/src/features/chat/Turn.vue`，main 与 feat 一致）：

```js
// Turn.vue:129 — showTrace 控制整个 trace 区显隐
const showTrace = computed(() => sessionActive.value || isExpanded(props.turn.index))

// Turn.vue:167-171 — 末位 filter：末位 assistant 的 text 被挪出 trace
const traceBlocksByAssistant = computed(() => {
  return props.turn.assistants.map((a, i) => {
    const blocks = expandAssistantBlocks(a)
    return i === lastAssistantIdx.value
      ? blocks.filter((b) => b.kind !== 'text')  // ← 末位 text 被挪走
      : blocks                                    // ← 非末位 text 留在 trace（受 showTrace 控制）
  })
})
```

```js
// TurnSummary.vue:122-128 — 始终渲染最后一条 assistant 的文字
const summaryText = computed(() => {
  const last = props.turn.assistants[props.turn.assistants.length - 1]
  if (!last?.content) return ''
  const text = normalizeContent(last.content)
  return text.trim() ? text : ''
})
// 根节点 <div v-if="summaryText"> 包裹了文字 + 操作栏（TurnSummary.vue:7）
```

> **术语：末位 filter**。就是上面 `.filter((b) => b.kind !== 'text')` 这一行——把"最后一条 assistant"的 text 块从 trace 区剔除，改由底部的 TurnSummary 渲染。设计意图是"末位的文字是最终回答，放底部 summary 常驻；非末位的文字是过程性说明，折叠进 trace"。

### 3.2 怎么出错：block 跳变的根因时刻

**失败模式 A（主症）：新 message_start 到达，末位翻转，text 在 trace↔summary 间跳变。**

按时间展开"说话 → 调工具 → 总结"的 streaming 过程：

| 时刻 | pi 事件 | turn.assistants | a1 是末位? | trace 区 | TurnSummary | 使用者看到 |
|---|---|---|---|---|---|---|
| T1 | a1 流文字 "我先读文件" | `[a1]` | 是 | `[]`（a1 text 被 filter） | "我先读文件" | 底部出现文字 |
| T2 | a1 收到工具块 | `[a1]` | 是 | `[工具]`（text 仍被 filter） | "我先读文件" | 工具在 trace、文字在底部 |
| T3 | `message_start(a2)` 到达 | `[a1,a2]` | **否** | `[a1 文字, 工具]` + `[]` | a2 文字 | **a1 的文字瞬间从底部跳进 trace，落到工具上方** |

T2→T3 的瞬间，a1 的文字块从 TurnSummary（底部）跳进 trace（上方），与工具块的相对位置突变——这就是使用者感知的"block 突然跳位 / 顺序错乱"。

**失败模式 B：重连后顺序与 streaming 中不一致。** streaming 时 `contentBlocks` 按"前端事件到达顺序"填充；若某条路径走 `expandAssistantBlocks` 的 fallback 分支（`contentBlocks` 为空时，顺序固定为 `[text, thinking, tool]`，`message-turns.ts:178`），与 streaming 累积顺序可能不同。常见场景一致，但边界态（异常 / 手工数据 / 部分填充）会错位。

> **失败模式 C（filter 的派生症状，非独立病灶）**：block 的 v-for key 含数组下标 `bIdx`（`Turn.vue:39` `` `${assistant.id}-${blk.kind}-${bIdx}` ``）。末位翻转时 text 被重新插回数组首部，推高后续 `bIdx`，Vue 视为新元素重建 DOM，视觉跳动加剧。**根因仍是 filter**：`contentBlocks` 三个填充点（registry.ts / message-converter.ts / streaming-state-machine.ts，见 §7.1）全部 append 到尾部、从不前插，若没有 filter 把 text 抽走再插回，`bIdx` 本就稳定。移除 filter 即同时消除此症状，无需独立修复（见 §6.4）。

### 3.3 为什么一个 turn 会有多条 assistant message

这是 pi 的事件模型决定的，不是前端选择：

- pi 一个 agent 循环 = N 个 turn。每个 turn 若含工具调用，pi 会先 emit 当前 turn 的内容，执行工具，再开下一个 turn。
- pi 在每个 assistant turn 开始时 emit `message_start`。
- `event-adapter.ts` 把 assistant 的 `message_start` 转成前端 `message.message_start`，前端 store 的 handler（`registry.ts:116`）**每次都新建一条 streaming assistant message**。
- pi 的 `message_end` 在 `event-adapter.ts:652` 是 `NULL_EVENTS`（不转发），所以每条 assistant message 保持 streaming，直到整个 agent 循环结束的 `agent_end` → `message.complete` 一次性收口。

**结论**：一次"说话 → 调工具 → 总结"必然产生 ≥2 条 assistant message 并存于同一 turn。这是失败模式 A 的触发前提。

> 旁证：`registry.ts` 的 `message_start` / `message.complete` handler 里埋了 `[DEBUG finalize] 场景A诊断` 日志（main 与 feat 都有），注释明确写"复现『同一回合中间闪烁已完成』"——开发者已知此场景存在闪烁，正在排查。本设计与该排查同源。

---

## 4. 根因 + 物理数据流

### 4.1 根因

**两个病灶共同导致 block 跳变（v1 曾列三个，审查核实 C 是 A 的派生症状，已降级）：**

**病灶 1（主因）：block 的显示位置依赖"兄弟元素是否存在"，而非自身稳定属性。** "末位 filter" 用 `i === lastAssistantIdx` 决定 text 去哪，而 `lastAssistantIdx` 随 `message_start` 翻转。一个 block 的位置不应因另一个 message 的出现而突变——这违反 UI 元素位置契约。

**病灶 2：同一份文字的双重表示 + 视图靠 filter 协调。** `Message.content`（字符串）和 `contentBlocks`（结构化数组）是同一份文字的两种表示。summary 渲染读 `content`、trace 渲染读 `contentBlocks`，靠"末位 filter"避免重复。数据冗余 + 视图协调 hack，filter 一旦失效（末位翻转）就重复或跳变。

> **contentBlocks 本身不是病灶**：它的字段注释（`message.ts:231`）明说"记录到达顺序"，本就是为顺序渲染设计的正确 SSOT。问题在消费端 `Turn.vue` 没有直接信任它，反而叠加了"末位推断"这层不可靠逻辑。

### 4.2 物理数据流图（pi 事件 → 屏幕像素）

```
pi SSE 事件流
  │
  │  message_update{text_delta}        ──┐
  │  tool_execution_start              ──┤  (注：pi 的 content block 级事件
  │  message_start{assistant}          ──┤   text_start/toolcall_start 在
  │                                       │   event-adapter.ts:106 全是 noop)
  ▼                                       │
event-adapter.ts (runtime)                │
  │ 转译成前端 message.* 事件             │
  ▼                                       │
chat store contentBlocks (SSOT)           │
  │ 按"前端事件到达顺序"append 到尾部 ◄────┘
  │ (三个填充点均 append-only、均带 text 幂等守卫)
  ▼
expandAssistantBlocks() (message-turns.ts:158)  ← 信任 contentBlocks 原序解出 OrderedBlock[]
  │
  ▼
Turn.vue traceBlocksByAssistant  ← ★病灶 1：叠加"末位 filter"，破坏稳定顺序
  │
  ├──→ trace 区 (v-if="showTrace")：thinking + toolCall（末位 text 被剔除）
  └──→ TurnSummary (始终可见)：最后一条 assistant.content + streaming 光标
```

**关键论断**：从 `contentBlocks` 到 `expandAssistantBlocks` 这一段，顺序是**稳定且正确**的（✅ 已读代码确认，见 §7.4 探针 P-stable）。跳变 solely 发生在 `Turn.vue` 的"末位 filter"这一步——它把稳定的输入变成了不稳定的输出。

---

## 5. 终态：使用者眼里将是什么样的

### 5.1 成功路径（block 零跳变 + 回答始终可见）

**核心设计：重新明确 text 与 trace 折叠的关系——text 是"回答内容"始终可见，thinking/toolCall 是"执行细节"受折叠控制。** 这兑现了 §1 末尾的现有契约（回答常驻、执行细节可折叠），而不是破坏它。

同样的"读 a.ts 然后总结"场景，改造后。先看 **trace 展开态**（对话进行中 / 手动展开）：

```
T1: a1 流文字 "我先读文件"
    [始终可见区] a1: 文字"我先读文件"█        ← 文字就地出现，带 streaming 光标
T2: a1 收到工具块
    [始终可见区] a1: 文字"我先读文件"
    [折叠区]     a1: 工具(read)                ← 工具追加在文字下方，文字不动
T3: message_start(a2) 到达
    [始终可见区] a1: 文字"我先读文件"
    [折叠区]     a1: 工具(read)
    [始终可见区] a2: 文字"内容是..."█          ← a2 在 a1 下方继续，a1 文字没动
```

**全程没有任何 block 改变位置。** 文字一直在它出现的地方，工具一直在文字下方，a2 的总结在 a1 下方。block 的位置 = 它在 `contentBlocks` 里的位置，从出现到终态不变。

再看 **trace 折叠态**（对话完成后 / 重开历史 session）：

```
[始终可见区] a1: 文字"我先读文件"
[始终可见区] a2: 文字"内容是..."
（thinking/toolCall 隐藏，文字完整保留）
[操作栏] 复制 / 复制MD / fork / handoff
```

**折叠只隐藏执行细节，回答文字完整可见。** 重开历史 session 的每一轮回答都不会丢失文字。

> **与现状的关键区别**：现状把"末位 text"放 TurnSummary 常驻、"非末位 text"放折叠 trace（折叠后非末位文字也消失）。改造后**所有 text 都常驻**，不受折叠影响——这比现状更完整地兑现了"回答常驻"契约（现状折叠后只剩末位文字，中间过程性文字丢失）。

### 5.2 失败路径（带恢复指引）

**F1：某条 assistant message 的 `contentBlocks` 异常缺失（手工数据 / 旧版本持久化）。**
`expandAssistantBlocks` 走 fallback（`message-turns.ts:178`，固定顺序 `[text, thinking, tool]`），block 仍能渲染，只是顺序可能与流式时不一致。
👉 恢复：该消息下次流式产出或重新加载会重建 `contentBlocks`；持久化路径（`message-converter.ts`）已保证历史消息也填 `contentBlocks`，此场景仅限异常数据。

**F2：markdown 跨块断裂？**
👉 **由幂等守卫保证不会发生**：单条 message 最多 1 个 text 块（`ContentBlock.text.refId` 恒为 `'text'`，三个填充点——`registry.ts:263` / `message-converter.ts:100` / `streaming-state-machine.ts:56`——均有 `.some(b=>b.type==='text')` 幂等守卫）。**注意这是 by guard（守卫保证），非 by construction（类型结构保证）**：`ContentBlock[]` 类型本身允许多个 text 条目，单 text 靠三个填充点的守卫维持。若未来新增第四个填充点漏了守卫，会出现多 text 块 → `expandAssistantBlocks:163` 对每个 text 条目都 push 一次完整 `msg.content` → 文字重复。新增 contentBlocks 填充点必须带同款 text 守卫（见 §7.1）。

---

## 6. 关键决策与权衡

### 6.1 决策一：text 块的渲染位置与可见性（主决策）

| 方案 | 长期架构合理性 | 短期实现成本 | 风险 | 裁决 |
|---|---|---|---|---|
| **A. text 始终可见的就地渲染** | ✅ 位置只认 `contentBlocks` 顺序，by construction 稳定；消除病灶 1/2；text 不进折叠区，不破坏"回答常驻"契约 | 低：去掉 filter + 调整 v-if 让 text 不受 showTrace 控制 + 光标归位 | 极低（见 §7.3 副作用） | **✅ 选** |
| B. text 进折叠区（v1 方案） | ❌ turn 完成后 showTrace=false → **所有回答文字消失**（致命回归） | 低 | **致命**：重开历史 session / turn 折叠后文字不可见 | ❌（审查否决） |
| C. filter 条件改为 message 级稳定态 | ❌ 仍依赖派生判断，只是把翻转点挪到 status 变化 | 低 | 中：streaming→complete 仍翻转一次；治标 | ❌ |
| D. 前端合并多 assistant 为单 message | ✅ 彻底消除"末位"概念 | 高：改数据模型，影响 compact/fork/retry/虚拟列表 | 高：大范围回归 | ❌（留作 A 落地后评估） |

**被否若用**：
- 用 B（v1 原方案）：§5.1 折叠态会变成"所有文字消失，只剩 turn 头"——这是把"block 跳变"换成"回答消失"的致命回归，比原问题严重得多。
- 用 C：§5.1 的 T2→T3 不再跳，但每条 assistant 从 streaming→complete 时仍会跳一次（filter 条件翻转），使用者仍能看到一次跳变。
- 用 D：能根治但代价是重写 message 数据模型的消费方，scope 失控；且 A 落地后"多 assistant"是否仍是问题需重新评估。

**推荐 A 的理由**（准则 8 减法优先）：A 是**减法**（砍掉 filter 这层不可靠逻辑 + 把 text 移出折叠区），不是加新机制。砍掉后正确性 by construction——`contentBlocks` 本就是为顺序渲染设计的 SSOT，直接信任它即可。A 同时比现状更完整地兑现"回答常驻"契约（现状折叠后只剩末位文字）。

### 6.2 决策二：TurnSummary 的职责

| 方案 | 长期合理性 | 短期成本 | 风险 | 裁决 |
|---|---|---|---|---|
| **A. 去内容化，只留操作栏** | ✅ 消除"content/contentBlocks 双重渲染"（病灶 2），单一数据源 | 低 | 低（操作栏门控需调整，见下） | **✅ 选** |
| B. 完全删除 TurnSummary | 视觉上失去 turn 底部的操作锚点 | 中（操作按钮要重新挂载） | 中 | ❌ |

**操作栏门控调整**（审查 MF4 指出的副作用）：现状 `TurnSummary` 根节点 `v-if="summaryText"`（`TurnSummary.vue:7`）隐式门控了操作栏——纯工具 turn（无 text）整块不渲染，连操作栏都没有。去内容化后 `summaryText` 不再存在，根节点 `v-if` 改为 `v-if="lastAssistant"`（只要有 assistant 就显示操作栏）。**这是预期行为变更**：纯工具 turn 将新出现操作栏（其 `lastAssistant` 仍可复制/fork/handoff），属合理改善而非回归。

### 6.3 决策三：streaming 光标的位置与显隐

现状：光标在 `TurnSummary.vue:13`（末位文字末尾），`v-if="isStreaming"`。改造后末位文字进始终可见区，光标需跟随，且显隐条件必须与"工具运行时不应显示文字光标"一致。

**光标位置**：

| 方案 | 长期合理性 | 短期成本 | 风险 | 裁决 |
|---|---|---|---|---|
| **A. turn 内容区末尾独立 `streaming-tail` 元素** | ✅ 一个元素跟在所有 block 后，不受 block 增删影响；`Block.vue:46` 注释本就声称此设计但从未落地 | 低 | 低 | **✅ 选** |
| B. 塞进 Block.vue 的 text 分支 | 语义化但要判断"是否最后一个 streaming block" | 中 | 中（判断逻辑是派生状态） | ❌ |

**光标显隐条件**（审查 MF6 指出，单一 `v-if="isStreaming"` 不够）：

`turn.isStreaming`（`message-turns.ts:104`）在整个 agent 循环结束前恒为 true，**包括工具运行期间**。若光标只看 `isStreaming`，工具运行时会出现"工具 loader + 文字光标"并存。正确条件：

```
showStreamingCursor = isStreaming && 最后一个可见 block 是 text（而非 running tool）
```

实现：Turn.vue computed，取 `expandAssistantBlocks(lastStreamingAssistant)` 最后一项的 kind；若为 `tool` 且该 tool 状态为 `running`，则不显示光标（tool 自带 loader）。此条件**稳定**——基于 contentBlocks 末项，不随 `message_start` 翻转。

> **现状澄清（准则 7）**：`Block.vue:46` 注释声称"streaming 光标已移到 Turn.vue trace 末尾独立元素"，但实测 `Turn.vue` 无此元素，光标实际在 `TurnSummary.vue:13`（✅ 探针 P-cursor 已 grep 确认）。该注释是过时注释——本决策 A 是把注释声称的设计**真正落地**（审查 S5 指出：这不是新设计，而是兑现一个写进代码注释却从未实现的设计契约）。

### 6.4 不做：独立的 key 稳定化（审查 MF2/MF3 否决）

v1 曾把"v-for key 稳定化"列为独立改动（M1）。审查核实：
1. v1 提议的 key 用了 `OrderedBlock` 上不存在的字段 `refId`（实际类型只有 `kind` + `ref`，`message-turns.ts:144`）——要么无效要么 tsc 报错。
2. contentBlocks 三个填充点全部 append-only、不前插，移除 filter 后已存在 block 的 `bIdx` 永不变，key 本就稳定。

**结论**：失败模式 C 是 filter 的派生症状，移除 filter（决策一 A）即消除，无需独立修复。本次不改 v-for key（保持原样即可）。

### 6.5 不改 event-adapter 的 content block 级 noop 策略

pi 的 `text_start/toolcall_start` 等事件在 `event-adapter.ts:106` 是 noop。有人可能想"让前端感知 pi 的 content block 逻辑 index 来排序"——但没必要：当前 `contentBlocks` 按"前端事件到达顺序"填充，而到达顺序 = pi content array 顺序（工具执行必在 LLM 输出完整 tool_use 之后，文字必在工具之前到达）。两者在常见场景一致（✅ 探针 P-order）。改 noop 策略会牵动 runtime 协议层，scope 远超本次问题，且无收益。

---

## 7. 实现机制（把终态落到代码层）

### 7.1 数据层（基本不变）

- `Message.contentBlocks`：保持现状，仍是顺序 SSOT。**三个填充点**均 append-only + 带 text 幂等守卫：
  - `registry.ts:263`（主流式 text_delta）
  - `message-converter.ts:100`（持久化/重连路径）
  - `streaming-state-machine.ts:56`（subagent 虚拟 session streaming）
  - **新增第四个填充点必须带同款 text 守卫**（F2 防护）。
- `Message.content`：**数据角色不变**——它仍是 text block 的内容来源（`expandAssistantBlocks:163` `if (msg.content) result.push({kind:'text', ref: normalizeContent(msg.content)})`）。本次只改变其**渲染位置**（summary → turn 内容区），不改其数据角色。**streaming 期间必须继续填充 content**，否则 text block 会被 `if (msg.content)` 守卫丢弃（审查 MF5）。
- `expandAssistantBlocks()`：**不动**。它已经正确地信任 `contentBlocks` 顺序。

### 7.2 渲染层改动清单

| 文件 | 改动 | 产出终态的什么 |
|---|---|---|
| `packages/ui/src/features/chat/Turn.vue` | ① `traceBlocksByAssistant` 去掉 `.filter(b => b.kind !== 'text')`；② 把 trace 区的 `v-if="showTrace"` 从外层 div 下沉到**单个 Block 级**——text 块始终渲染，thinking/toolCall 块受 `showTrace` 控制（`v-if="blk.kind === 'text' || showTrace"`）；③ 末尾加 `streaming-tail` 光标元素，显隐条件见 §6.3 | §5.1 的"block 零跳变 + text 始终可见"+ 光标归位 |
| `packages/ui/src/features/chat/TurnSummary.vue` | ① 删除 `<MarkdownRenderer>` 与 streaming 光标；② 根节点 `v-if` 从 `summaryText` 改为 `lastAssistant`；③ 保留操作栏（复制/fork/handoff） | §6.2 单一数据源 + 操作栏门控修正 |
| `packages/ui/src/features/chat/Block.vue` | text 分支无功能改动；清理过时的 `streaming` prop 注释与"光标已移走"注释（兑现设计契约，审查 S5） | 消除过时注释造成的认知噪音 |
| v-for key | **不改**（§6.4 已论证移除 filter 后 key 本就稳定） | — |

**Turn.vue 渲染结构调整示意**（决策一 A 的落地）：

```vue
<!-- turn 内容区：所有 block 按时序，text 始终可见，thinking/tool 受 showTrace 控制 -->
<template v-for="(assistant, aIdx) in turn.assistants" :key="assistant.id">
  <template v-for="(blk, bIdx) in traceBlocksByAssistant[aIdx]" :key="`${assistant.id}-${blk.kind}-${bIdx}`">
    <Block
      v-if="blk.kind === 'text' || showTrace"
      :type="blk.kind" ...
    />
  </template>
</template>
<!-- streaming 光标（显隐条件见 §6.3） -->
<span v-if="showStreamingCursor" class="streaming-cursor ..." />
```

### 7.3 副作用与边界分析

| 关注点 | 影响 | 结论 |
|---|---|---|
| **折叠态文字可见性**（审查 MF1 核心） | text 不进折叠区 | **解决**：折叠只隐藏 thinking/toolCall，所有 text 始终可见（比现状更完整） |
| Markdown 跨块断裂 | 多 text 块各自渲染 | **不会**：单 message 最多 1 个 text 块（三处幂等守卫，F2） |
| MarkdownRenderer 实例数 | 末位 text 从 summary 挪到内容区 | **不变**：仍 1 次渲染 |
| 视觉重心（底部回答） | text 不再固定 TurnSummary | **不变**：最后一条 assistant 的 text 仍是 turn 最后内容，重心天然在底部 |
| **操作栏门控**（审查 MF4） | 根 `v-if` 从 `summaryText` 改 `lastAssistant` | **预期行为变更**：纯工具 turn 新出现操作栏（合理改善） |
| virtua 虚拟列表高度 | block 不再跳进跳出 | **更友好**：高度更稳定 |
| streaming 光标与工具 loader 共存（审查 MF6） | 光标显隐加"最后块非 running tool"条件 | **解决**：工具运行时光标隐藏，工具自带 loader |
| 历史消息（重连/重开） | `message-converter.ts` 已填 `contentBlocks` | **一致**：就地渲染顺序与历史路径一致；text 始终可见 |
| compact/fork/handoff | 读 `Message.content` | **不影响**：content 数据角色不变 |
| content 填充（审查 MF5） | content 仍是 text block 来源 | **必须继续填充**：否则 text block 被守卫丢弃 |
| 既有测试 | `chat-chunk-content-blocks.test.ts` 验 contentBlocks 填充 | **不影响**：数据层未动；`Turn.vue` 渲染测试需更新断言 |

### 7.4 运行时行为断言与探针

| ID | 验证的行为 | 探针 | 状态 |
|---|---|---|---|
| P-single-text | 单 message 最多 1 个 text 块（三处守卫） | grep registry.ts:263 / message-converter.ts:100 / streaming-state-machine.ts:56 的 text push 均有 `.some(b=>b.type==='text')` 守卫 | ✅ 已确认（by guard） |
| P-stable | `expandAssistantBlocks` 输出顺序 = `contentBlocks` 顺序（无重排） | 读 message-turns.ts:158-176，遍历 contentBlocks 原序 push | ✅ 已确认 |
| P-order | 前端事件到达顺序 = pi content array 顺序 | 工具执行（`tool_execution_start`）必在 LLM 输出完整 tool_use 之后；文字 delta 在工具之前 | ✅ 已确认（常见场景） |
| P-cursor | streaming 光标现状在 TurnSummary 而非 Turn.vue | grep `streaming-cursor` 仅命中 TurnSummary.vue:13；Turn.vue 无 `streaming-tail` | ✅ 已确认 |
| P-append-only | contentBlocks 三处填充点均 append、不前插 | 读三个填充点均为 `[...prev, newBlock]` 尾追加 | ✅ 已确认（支撑 §6.4 key 稳定结论） |
| P-no-jump | 改造后 T2→T3 block 零跳变 | 实施后跑 §8 场景 1 录屏，逐帧对比 block 位置 | ⛔ 实施期 |
| P-fold-visible | 折叠态/重开后 text 始终可见 | 实施后跑 §8 场景 3/4，折叠 turn 确认文字不丢失 | ⛔ 实施期 |

---

## 8. 验收（真实场景，非单测非 mock）

### 8.1 改动规模

**中等**：行为变更（block 渲染位置 + text 可见性边界）+ 数据消费边界澄清，涉及 3 个组件。按准则 11，需多个真实场景验收。

### 8.2 验收场景

| 场景 | 回溯 §2 目标 | 真实流程 / 数据 / 路径 | 通过标准 |
|---|---|---|---|
| **1. 说话→调工具→总结（主症回归）** | 目标 1 + 2 | 真实 pi session（`xiaomi-token-plan-cn/mimo-v2.5-pro`，禁用 kimi）：发"读 src/index.ts 然后总结"。全程录屏，逐帧看 block 位置。重点看工具块出现瞬间、第二条 assistant 出现瞬间 | 全程无 block 改变位置；文字始终在工具上方，工具始终在文字下方 |
| **2. 多工具连续调用** | 目标 1 + 2 | 真实 session：发"读 a.ts 和 b.ts"。产生 a1(文字+工具1) → a2(文字+工具2) → a3(总结) | 工具块按调用顺序自上而下稳定排列，文字穿插其间位置不变 |
| **3. 折叠态与重开文字可见性（审查 MF1 回归）** | 目标 3 + 4 | 场景 1 完成后①手动折叠 turn ②关闭 session 重开 ③断线重连 | 三种情况下所有 text 块均完整可见，不丢失任何回答文字；thinking/toolCall 在折叠态隐藏、展开态可见 |
| **4. thinking + 文字混合** | 目标 1 + 2 + 4 | 真实 session 用支持 thinking 的模型，发需推理的问题。产生 [thinking, 文字]，完成后折叠 turn | thinking 与文字按产出顺序排列；折叠后文字可见、thinking 隐藏；thinking 展开/折叠不引起文字跳位 |
| **5. streaming 光标显隐正确** | 目标 1（含光标） | 场景 1 streaming 中看光标 | 文字流式时光标在文字末尾；工具运行时光标隐藏（工具自带 loader），不出现"光标+loader"并存 |
| **6. 操作栏功能与门控** | Out-of-scope 边界守护 | 场景 1 完成后点操作栏的复制/复制MD/fork/handoff；另测一个纯工具 turn（无文字）是否出现操作栏 | 四个操作正常工作；纯工具 turn 出现操作栏（预期行为变更，§6.2） |

> 单元测试（`chat-chunk-content-blocks.test.ts` 等）仅作回归辅助，不计入验收。验收回答的是"真实对话里 block 还跳不跳、文字丢不丢"，不是"代码逻辑对不对"。
>
> 依赖说明：pi 是真实运行（RPC mode + 真实模型），无需 mock。测试模型用 `xiaomi-token-plan-cn/mimo-v2.5-pro`。

---

## 9. 实施

### 9.1 迁移路径

| 阶段 | 内容 | 交付终态的什么 |
|---|---|---|
| **M0** | `Turn.vue`：去末位 filter + v-if 下沉到 Block 级（text 始终可见）+ `streaming-tail` 光标（含 §6.3 显隐条件）；`TurnSummary.vue`：去内容化 + 根 `v-if` 改 `lastAssistant` | §5.1 主路径（block 零跳变 + 文字始终可见）+ 光标归位 |
| **M1** | 清理 `Block.vue` 过时注释；更新 `Turn.vue` 渲染相关测试断言；跑 §8 全部验收场景 | 验收通过 |

纯前端改动，无数据迁移（`contentBlocks` / `content` 数据层不变）。改动可逆（git revert 即恢复）。

> **说明**：v1 曾有 M1"key 稳定化"独立阶段，审查 MF2/MF3 否决后删除（§6.4）。本次 M0/M1 两阶段足够。

### 9.2 回填 main

本设计与 main 共享同一套病灶（§3.1 代码一致）。**注意**：本次审查在 feat worktree 内进行，main 分支代码未独立打开核实，"逐字相同"基于设计者此前的 main/feat 对比（审查 S3）。**建议本设计在 feat 验收通过后，作为独立改动回填 main**——main 同样存在 block 跳变（开发者已埋 `[DEBUG finalize]` 日志在追）。**回填前必须在 main 实跑 §8 场景 1 录屏确证**（升级为 Must-do，非可选）。

---

## 10. 下一层拆分

| 单元 | 说明 | justification（为什么这么拆） |
|---|---|---|
| unit-1：Turn.vue 渲染决策 | 去 filter + v-if 下沉 + streaming-tail 光标 | 主症根因所在，独立可验收（§8 场景 1/2/5） |
| unit-2：TurnSummary 去内容化 | 删 MarkdownRenderer + 光标，根 `v-if` 改 `lastAssistant`，留操作栏 | 与 unit-1 强耦合（光标与末位文字迁移需同步），但职责清晰可独立 review |
| unit-3：注释清理 + 测试更新 | 清 Block.vue 过时注释；更新 Turn.vue 渲染断言 | 独立小改进，降低 unit-1/2 认知噪音 |
| unit-4：验收 | 跑 §8 全部场景 | 验收是 DoR 门槛（准则 11），单独成单元确保不被挤掉 |

unit-1 和 unit-2 建议同一 PR（光标与文字迁移需同步）。

---

## 11. 待验证检查点

1. **光标显隐的"最后块判断"边界**：当最后一块是已完成（非 running）的 tool 时，光标是否显示？倾向"不显示"（已完成 tool 无 loader，但此时若有新 text 在流，新 text 会成为最后块）。⛔ 实施期场景 5 顺带验证。
2. **pi content array 是否可能单 message 内多 text part**：当前前端按"单 text 块"设计，靠三处守卫维持。若 pi 实际发多 text part，守卫会拦住、content 仍合并为单块——但需实测确认 pi 不会绕过守卫。⛔ 实施期场景 2/4 顺带验证。
3. **回填 main 的时机与确证**：取决于 main 实跑 §8 场景 1 的录屏结果（§9.2 Must-do）。

---

## 附录：变更历史

- v1：初稿。确立"取消末位 filter + 就地渲染 + TurnSummary 去内容化"方向。
- v2：经 tech-design-review 对抗式审查（7 Must-fix + 5 Suggestion），修正致命漏洞：① text 移出 `showTrace` 折叠区、始终可见（MF1，否则 turn 折叠/重开后文字消失）；② 删除无效的 key 稳定化阶段、失败模式 C 降级为 filter 派生症状（MF2/MF3）；③ 操作栏门控条件明确化（MF4）；④ 澄清 content 仍是 text block 来源、数据角色不变（MF5）；⑤ 光标显隐补"最后块非 running tool"条件（MF6）；⑥ "结构不可能多 text"降级为"守卫保证"、纳入第三填充点（MF7/S2）；⑦ 核准代码引用与行号（S1/S4）、补充设计契约来源（S5）。
