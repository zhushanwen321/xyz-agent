# 02 — P1 渲染层：turn 派生增量 + markdown 后缀增量渲染（子文档）

> **一句话结论**：长对话流式卡顿的**第二根因**（根因 2「渲染无增量」）由两项决策修复——**D-4** 把 `toRenderItems` 从「每 token 全量重建所有 `MessageTurn`」改为「以成员消息对象身份为复用键的增量派生 + Block 级 `v-memo`」；**D-5** 把 markdown 从「每帧全文 `markdown-it` 重渲染」改为「前缀缓存到稳定边界 + 每帧只渲染 tail 段 + 未闭合 fence 占位」——前者消除 turn 层的无效 patch，后者消除 10KB=18.1ms 的全文渲染，共同把流式渲染成本收敛到「只有变化的部分进入渲染」。

- **S（情境）**：P0（子文档 07，D-1）已把消息容器改为 `Map<sessionId, shallowRef<Message[]>>`，commit 只替换当前 session 的数组引用、不跨 session 失效。但每个 token 仍会让 `renderItems` computed 重算，`toRenderItems` 仍会 `new` 出所有 `MessageTurn` 对象，视口内每个 `Turn` 仍会被 patch，末位 turn 的 `MarkdownRenderer` 仍会对全文 `markdown-it` 重渲染。F5 实测：10KB 文档全文渲染 18.1ms，已超 60fps 帧预算（16.6ms）——即便 P0 收敛了失效扇出，渲染本身仍是硬约束。
- **C（冲突）**：两个决策的天然张力——① turn 复用需要「成员消息身份未变」这一精确判定，它依赖 D-1 的不可变消息身份（F10 说明 UI 态有限，memo 键可控，但「复用键」的正确性取决于「消息没有原地变异」）；② markdown 增量需要「从哪切」这个从未定义过的「稳定结构边界」判定，而纯文本 hash 缓存（A2 方案）键太脆、turn 归一化进 store（B 方案）会引入第二份状态破坏 G5。两者都不能走「修症状」路线。
- **Q（问题）**：如何在「结构上正确（G5）」的前提下，让流式渲染每帧只做「变化部分」的工作，且不破坏现有 virtua 结构（已合理，不重设计）与 stable-key（已正确，不重设计）？
- **A（答案）**：D-4 选「对象身份增量缓存」（复用上次 turn，派生字段在成员变化时重算），D-5 选「后缀增量渲染」（前缀缓存到稳定边界 + tail 渲染 + fence 占位），接口先行，阈值（静默时长 T、长度切点）诚实标注待验证。

---

## §1 背景与目标

**本节的结论：本层是「渲染协议技术方案」——固定「可实现的接口/组件契约/代码任务」这一层产物；它依赖 P0（D-1）的不可变消息身份，但 D-4/D-5 的接口设计本身不依赖 P0 是否已完成——实施顺序上 D-4/D-5 应在 01 之后落地。**

### 1.1 本层在总体中的位置

父文档 00 的依赖图已定：

```
00 总纲（11 份子文档）
├─ 07 状态层（D-1/D-2/D-3）──→ 08/09 的前置（不可变身份、失效收敛）
├─ 08 渲染层（D-4/D-5）─────→ 依赖 07 的不可变性；与 09 独立
└─ ...
```

本子文档 08 承载 D-4 与 D-5，是失败模式 A（长对话流式卡顿，G1 的反面）的**第二根因**（根因 2「渲染无增量」）的归属。第一根因（根因 1「响应式失效扇出」）由 07 处理，本层假设它已完成但**不依赖其完成状态来定义接口语义**（见 1.2）。

### 1.2 依赖声明（P0 的不可变身份）

D-4 的复用键是「turn 成员消息的**对象身份**」（reference 相等，非内容相等）。这个判定的正确性依赖一条前提：

> **一条消息对象一旦被提交进数组，其身份在之后永远不变；内容变化通过「替换数组引用 + 替换该消息对象本身」表达，而不是原地 mutate 消息对象。**

这正是 D-1 的语义后果：`Map<sid, shallowRef<Message[]>>` 下，「同一逻辑消息的更新」=「新消息对象替换旧元素」。若消息被原地 mutate（旧实现里 `content` 字符串拼接发生在哪里、是否原地改对象），「成员引用未变」就无法代表「成员内容未变」，复用会读到陈旧派生字段。

- **文档层面写死这条依赖**（父文档 00 §3.3 已声明「02 依赖 01 的不可变性」），并在 01 的验收里包含「消息对象身份不可变」这一不变量（作为 02 的前置 gate）。
- **接口层面不依赖 P0 是否完成**：D-4 的缓存函数签名只需「输入是 `Message[]`，输出是 `RenderItem[]`，缓存键是逐成员的消息引用」——这在 P0 完成前后都能实现，只是 P0 未完成时复用命中率会随「消息是否原地变异」而不可预期。因此 D-4/D-5 的实施方案（§3.3 的签名草案）**可以先行设计、先行写代码，但验收必须等 01 的不变量成立**（§4 验收场景注明）。

### 1.3 设计目标（从使用者体验倒推）

| 编号 | 目标（谁、什么上下文、达成什么） | 对应决策 |
|---|---|---|
| G1 | 开发者在 200+ 消息长 session 看流式回复，token 密集段不掉帧、不随对话增长变卡 | D-4 + D-5 |
| G5 | 修复是结构正确的：无与消息数组重复的 drift 状态、无脆弱缓存键、不修症状 | D-4（否 B/否 A2）+ D-5（否 A/否 C） |

（G2/G3/G4 归 03/04，本层不涉及。）

### 1.4 In / Out of Scope

- **In**：`packages/core/src/domain/chat/message-turns.ts` 的 `toRenderItems` 增量化；`packages/ui` 的 `Turn.vue`/`Block.vue` 加 `v-memo`；`packages/ui` 的 `MarkdownRenderer.vue` 与 `packages/renderer` 的 `markdown.ts` 增量渲染协议 + 稳定边界判定。
- **Out**：virtua 结构重设计（父文档已裁定「已合理，不重设计」）；`renderKey`/`turnStableId` 重设计（已正确）；消息容器范式（归 01）；任何功能/样式变更。

---

## §2 现状与问题分析

**本节的结论：长对话流式卡顿的第二根因是「渲染无增量」——`toRenderItems` 每 token 重建所有 turn、末位 turn 每帧全文 markdown 渲染（F5：10KB=18.1ms）；三个「理论成本」中高亮（F4）与字符串拼接（F2）已证伪，真实成本是 parse + HTML 构建 + v-html 替换。**

### 2.1 真实代码片段（现状）

**（a）turn 每 token 全量重建** —— `message-turns.ts:93-148`：

```ts
export function toRenderItems(messages: Message[], forceWorking = false): RenderItem[] {
  const items: RenderItem[] = []
  let turnSeq = 0
  let current: MessageTurn | null = null
  for (const msg of messages) {
    if (msg.role === 'user') {
      turnSeq += 1
      current = { index: turnSeq, user: msg, assistants: [], isStreaming: false, hasFoldable: false }
      items.push({ kind: 'turn', turn: current })
    } else if (msg.role === 'assistant') {
      /* 无 current 则自启；否则 */
      current.assistants.push(msg)
    } else if (msg.role === 'system') {
      current = null
      items.push(/* systemNotice | bashExecution */)
    }
  }
  const turnItems = items.filter(/* kind === 'turn' */)
  turnItems.forEach(({ turn }, i) => {
    const last = turn.assistants[turn.assistants.length - 1]
    const isLast = i === turnItems.length - 1
    turn.isStreaming = isLast && (forceWorking || last?.status === 'streaming')   // :141
    turn.hasFoldable = turn.assistants.some(/* thinking/toolCalls 非空 */)        // :142-144
  })
  return items
}
```

**问题**：每个 token（约 70ms 一次，F13）都把**整个消息列表**重扫一遍、`new` 出所有 `MessageTurn` 对象。所有 turn 对象的引用都变了 → 即使历史 turn 的成员消息一个都没变，`Turn` 组件拿到的 `props.turn` 引用仍是全新对象 → virtua 视口内每个 `Turn` 都被 patch。

**（b）renderItems computed 每 token 重算** —— `MessageStream.vue:207-209`：

```ts
const renderItems = computed(() =>
  toRenderItems(filterDisplayableMessages(currentMessages.value), forceWorking.value),
)
```

`currentMessages`（:190）是 `chat.messages.get(sessionId)`，每 token 替换数组引用 → `currentMessages` 失效 → `renderItems` 重算 → `toRenderItems` 全量重建。这是 turn 层的失效载体。

**（c）末位 turn 的 markdown 每帧全文重渲染** —— `MarkdownRenderer.vue:217-223` + `markdown.ts:487-492`：

```ts
// MarkdownRenderer.vue —— content 变化（流式增量）→ rAF 节流渲染
watch(() => props.content, (text) => { scheduleRender(text) }, { immediate: true })
// scheduleRender → rAF 尾调 flushRender → doRender(pendingContent)
// doRender → deps.renderMarkdown(text)  ← 全文重渲染

// markdown.ts
export async function renderMarkdown(content: string, env?: MarkdownEnv): Promise<string> {
  const md = await getMarkdown()
  return md.render(content, env ?? {}).trimEnd()   // :491 全文 md.render
}
```

rAF trailing 节流（:80-82）已经把「一帧内多次 content 变化」合并成单次，但它**不解决单次全文 `md.render` 的成本**：10KB 文档一次全文渲染 18.1ms，本身已超 16.6ms 帧预算。

**（d）mermaid 每帧整图重渲** —— `MermaidRenderer.vue:206`：

```ts
watch(() => props.source, () => doRender())   // 流式增量每帧整图重渲
```

mermaid fence 在 `markdown.ts:142` 的 fence 规则里被输出为占位 `<div class="md-mermaid" data-source=...>`，`renderMarkdownSegments`（:511）再把占位切成 `mermaid` 段，`MarkdownRenderer` 用 `MermaidRenderer` 组件渲染。流式期间 source 每个 token 变一次 → 每帧 `renderMermaid` 整图重渲（mermaid 首次加载 ~3MB，且每帧重新 parse 图定义）。

### 2.2 失败模式（使用者视角）

**失败模式 A（第二根因）：长对话流式卡顿。**

开发者在 200+ 消息 session 里让 AI 写一段 50KB 带代码块的回答。每 token（≈70ms）触发：

```
token → store commit（替换数组引用）
  → renderItems computed 重算 → toRenderItems 全量重建所有 MessageTurn（O(N) 对象分配）
  → virtua diff → 视口内 ~5-10 个 Turn 全部 patch（历史 turn 成员根本没变，却全被重 patch）
  → 末位 turn 的 MarkdownRenderer（rAF 节流后）全文 markdown-it 渲染 → v-html 整段替换
      └─ F5：10KB=18.1ms / 50KB=71ms / 200KB=253ms 每帧
```

对话越长（消息越多），`toRenderItems` 的 O(N) 重建与视口 patch 越重；回答越长（文档越大），markdown 全文渲染越重。两者叠加 = 「越用越卡」。

### 2.3 根因

| # | 根因 | 证据 | 处置 |
|---|---|---|---|
| 根因 2a | **turn 派生无对象身份复用**：`toRenderItems` 每 token `new` 全部 turn，历史 turn 成员未变却引用全变 → 全视口无效 patch | `message-turns.ts:93-148` | D-4 |
| 根因 2b | **markdown 全文重渲染**：每帧 `md.render(全文)`，parse + HTML 构建 + v-html 替换三合一，10KB 已超帧预算 | F5 + `markdown.ts:491` | D-5 |

**已证伪的成本（明确不做复杂优化）**：

| 假设 | 实测 | 结论 |
|---|---|---|
| F4 未闭合代码块每帧重高亮是热成本 | 200 行代码块 shiki 高亮仅 0.1ms/次 | 高亮不是成本，别在「跳过 shiki」上做文章；fence 占位的目的不是省高亮，是省 parse 边界 |
| F2 O(n²) 字符串拼接是热成本 | 100KB/1000 token 拼接 0.1ms（V8 cons-string） | 拼接不是成本，别在拼接上做文章 |

### 2.4 物理数据流图

```
pi 进程 token
  → runtime WS message.text_delta
  → core transport JSON.parse
  → D-1（P0）：commit 替换 session 数组引用（Map 恒等，浅层）
  → currentMessages computed（MessageStream.vue:190）
  → renderItems computed（:207）→ toRenderItems（message-turns.ts:93）
       [现状] new 所有 MessageTurn → virtua diff → 视口内全部 Turn patch
       [D-4]  身份复用：仅成员变化的 turn 重建，其余复用上次对象 → 兄弟 Turn 跳过 patch
  → 末位 Turn patch
       → Turn.vue flatBlocks（:168）→ computeTraceWindow（:170，含 sort）
       → visibleBlocks（:184）→ v-for Block
            [D-4] Block 级 v-memo 键 = [块身份, 内容/状态]（折叠态由 Block 内部驱动）→ 未变块跳过 patch
       → MarkdownRenderer.watch(content)（:217）→ rAF 节流 → doRender
            [现状] renderMarkdown(全文) → md.render(全文) → segments → v-html 替换
            [D-5]  findStableBoundary(全文) → 前缀段缓存（引用恒等）+ renderMarkdownSegments(tail) → 渲染树 = 前缀段 + tail 段
       → MermaidRenderer.watch(source)（:206）→ renderMermaid(整图)
            [现状] 每帧整图重渲
            [D-5]  未闭合 mermaid fence 流式期占位，静默 ≥T ms / complete 后完整渲染
```

---

## §3 解决方案

**本节的结论：D-4 用「成员消息对象身份」做 turn 复用键（被否方案：纯文本 hash 太脆、turn 归一化进 store 有 drift），Block 级补 `v-memo`；D-5 用「稳定结构边界 + tail 渲染 + fence 占位」（被否方案：仅 fence 占位不够、流式增量 parser 复杂度收益比差）。接口先行，阈值诚实标注待验证。**

### 3.1 终态（使用者视角）

**成功路径：长代码块流式回答的渲染过程。**

开发者让 AI 生成一个带代码块的 50KB 回答。每 token 到达时：

1. **历史 turn 完全不动**：前面 199 个 turn 的成员消息引用都没变，`toRenderItemsIncremental` 直接复用它们上次的 `MessageTurn` 对象 → virtua diff 判定「turn 对象引用相同」→ 兄弟 Turn 不 patch。视口内唯一受影响的只有末位 turn。（**边界说明**：「完全不动」仅在纯流式追加下成立；load-more 前插会使 turn 位置平移 → 同位置匹配失配 → 该次全量重建。这是一次性突发，不属每 token 热路径。）
2. **末位 turn 里绝大多数 block 也不动**：已完成的 thinking/tool/text 块的身份字段（thinking id / tool id）与状态（running→complete 那次才变）未变，`v-memo` 键命中 → 这些 Block 跳过 patch；只有正在增长的那个 text block 与它的 MarkdownRenderer 继续更新。
3. **markdown 只渲染尾巴**：MarkdownRenderer 找到「最后一个稳定结构边界」，边界之前的前缀 HTML 已缓存，每帧只 `markdown-it` 渲染边界之后的 tail 段（通常是几十到几百字节），v-html = 缓存前缀 + tail HTML。代码块的 fence 若未闭合，流式期间渲染为占位（一个简洁的「语言名 + 转圈」行），token 静默 ≥T ms 或消息 complete 后，才一次性完整渲染并高亮。
4. **mermaid 不整图重渲**：未闭合的 mermaid fence 同样占位，闭合且静默后一次渲染成 SVG。

结果：每 token 的渲染成本从「O(历史消息) 重建 + O(全文) markdown」降到「O(tail) + 末位单元」，token 密集段不再掉帧，对话长度不敏感（G1）；且整个过程没有任何第二份状态或脆弱缓存键（G5）。

**失败路径：稳定边界判定失败 → 降级全量渲染（带恢复语义）。**

若 `findStableBoundary` 无法在 O(长度) 内确定边界（例如一条超大的单行、无任何换行可以作为「行首」锚点），MarkdownRenderer**降级为全量渲染**——即回到当前行为，一次性 `md.render(全文)`。这**不是错误**，而是「放弃增量、退回已知正确」的兜底：

- **语义正确性不受影响**：全量渲染始终产生正确输出，降级只损失性能、不损失正确性（G5 的「结构正确」不因降级而破坏）。
- **可恢复**：降级只在「某次边界判定失败」时发生，下一次 content 变化重新尝试判定边界；一旦文档再次出现可判定的稳定边界（例如单行内容之后补了换行），自动回到增量路径。
- **可观测**：降级经探针（§5 探针 P6）记账，实施期可据此 tuning 阈值与边界规则。

### 3.2 决策的多方案对比

#### D-4：turn 派生层

| 方案 | 长期架构合理性 | 短期实现成本 | 风险 | 结论 |
|---|---|---|---|---|
| **A）对象身份增量缓存（选定）** | 高：复用键 = 成员消息引用，直接消费 D-1 的不可变性，无第二份状态；派生字段（isStreaming/hasFoldable）在成员变化时重算，语义与现状一致 | 中：改造 `toRenderItems` 为带缓存版；`Turn` 加 `v-memo` | 中：依赖「消息身份不可变」不变量（已由 D-1 保证并写为 gate）；缓存需随 session/sessionId 隔离与清理 | ✅ **推荐** |
| **A2）纯文本 hash 缓存（被否）** | 低：键 = 消息内容 hash，键脆（内容变一点点 hash 变，历史 turn 失配），且 hash 有碰撞/计算成本 | 中 | 高：hash 键不表达「是否真的该重算派生字段」，误导性耦合 | ❌ |
| **B）turn 实体归一化进 store（被否）** | 低：与消息数组重复的第二份状态，两者需同步，drift 风险直接违反 G5 | 高：新增 store 实体、同步逻辑、生命周期 | 高：两份状态漂移，正是根因 1 反模式的重演 | ❌ |

**「若用 A2/b 会怎样」**：A2 的 hash 键在流式期间必然每 token 失效（末位消息 content 每 token 变 → hash 每 token 变），而历史 turn 的 hash 虽稳定但「hash 计算 + 逐 byte 比较」本身又是一笔 O(总字节) 成本，还把「是否重算派生字段」耦合到了一个脆弱的文本指纹上——一旦某处对消息做了等价但不逐字节相同的改写（如 trim、normalize），hash 失配导致无谓重建。B 归一化则是在 store 里养出第二份「turn 数组」，与 `toRenderItems` 的派生输出并存，任何一处漏同步就出现「store 里的 turn 展开态 vs 组件里渲染的 turn 不同」的漂移，回到父文档 G5 明令禁止的结构。

#### D-5：markdown 流式渲染

| 方案 | 长期架构合理性 | 短期实现成本 | 风险 | 结论 |
|---|---|---|---|---|
| **A）后缀增量渲染（选定）** | 高：前缀缓存到稳定边界，每帧只渲染 tail；F5 证明必须增量，此方案直接命中「parse + HTML 构建 + v-html」这一真实成本 | 中：实现稳定边界判定 + 前缀缓存 + fence/mermaid 占位 | 中：边界判定规则的正确性需单测矩阵覆盖（§5）；降级兜底保证正确性下界 | ✅ **推荐** |
| **A'）仅未闭合 fence 占位（被否）** | 低：F4 已证伪「高亮是成本」，占位只挡高亮挡不住全文 parse（F5 的 18ms 主体是 parse+HTML 构建） | 低 | 高：成本大头（全文 parse）仍在，收效甚微 | ❌ |
| **C）流式增量 parser（被否）** | 低：手写增量 markdown parser（维护 token 状态机），复杂度爆炸、收益比差（markdown-it 已成熟） | 极高 | 高：边界 case 无穷，正确性难保证，违反 G5 | ❌ |

**「若用 A'/c 会怎样」**：A' 只把「未闭合 fence 之后的 token」挡在 shiki 之外，但 markdown-it 仍要对全文 parse（F5 的 10KB=18.1ms 主体是 parse + HTML 构建 + v-html，F4 证实高亮只占 0.1ms）——省了 0.1ms，留着 18ms，等于没优化。C 则要维护一个与 markdown-it 平行的增量 parser，每支持一种 markdown 结构（表格、嵌套列表、blockquote）都要手写边界判定，且任何一处边界判定错误就产出坏 HTML——复杂度/收益比极差，且违反「结构正确而非修补」。

### 3.3 关键决策与权衡（接口先行）

#### 3.3.1 D-4 的接口草案：turn 增量缓存层

**函数签名**（落在 `message-turns.ts`，保持纯函数、零 Vue 依赖的现有归属）：

```ts
// 增量派生（带缓存）版 toRenderItems。缓存按 session 隔离（外部传 cache 句柄，
// 由调用方经 useSessionScopedState 分区持有，见失效条件 3）。
export function toRenderItemsIncremental(
  sourceMessages: Message[],            // 源消息数组（per-sid 分区数组，D-1 下 commit 才替换引用、恒等稳定）
  filter: (msgs: Message[]) => Message[],  // 现状 filterDisplayableMessages（每调用产出新数组）
  forceWorking: boolean,
  cache: TurnRenderCache | undefined,  // 可复用缓存；undefined 时退化为全量（等价现状 toRenderItems）
): RenderItem[]
```

**缓存键结构**：

```ts
// 缓存语义：turn 的复用键 = 该 turn「成员消息的对象引用序列」。
// 成员 = user 消息 + 其后所有 assistant 消息（system 消息是 turn 边界，不参与）。
// 判定：某 turn 的 [user, ...assistants] 的引用与上次逐一对齐（顺序 + 引用相等），
//       则复用上次的 MessageTurn 对象；否则重建该 turn 并重算 isStreaming/hasFoldable。
interface TurnRenderCache {
  // 快路径键 = 源数组引用（NOT filter 产物）：filterDisplayableMessages 每调用产出新数组，
  // 若键在 filter 结果上，快路径恒 miss、变死代码。源数组在 D-1 下 commit 才替换引用——
  // 「源引用未变」= 本 sid 无新 commit（本次重算由 forceWorking/env 等其他依赖触发）。
  lastSourceRef: Message[] | null
  // 每个 turn 的成员引用签名（浅数组，元素是消息对象引用）
  turnSignatures: Message[][]
  // 与 turnSignatures 一一对应：上次产出的 MessageTurn
  turnObjects: MessageTurn[]
  // 上次整体产出（快路径直接复用）
  cachedItems: RenderItem[]
}
```

**复用判定（核心逻辑伪代码，快路径已按审查修正）**：

```
function toRenderItemsIncremental(sourceMessages, filter, forceWorking, cache):
  if cache == null:                          # 无缓存 → 全量（等价现状）
    return toRenderItems(filter(sourceMessages), forceWorking)

  if cache.lastSourceRef === sourceMessages:  # 源数组引用未变 → 本 sid 无新 commit
    # 快路径：全部 turn 复用，但末位 turn 的 isStreaming 必须按当前 forceWorking 重算——
    # SubagentTab 的 forceWorking（subagentStore.isRunning 翻转）在源数组不变时触发本函数，
    # 不重算则「思考中/working」UI 陈旧（初稿直接 return cachedItems 是错的，已修正）。
    # 产出 = 复用全部历史 turn 对象 + 末位 isStreaming 变化时**替换末位 turn 对象**（不可变，不原地改）。
    return withLastTurnDerived(cache.cachedItems, forceWorking)

  # 源数组引用变了 → 有新的 commit：先 filter（新数组），再重扫，只重建「成员引用变化」的 turn
  filtered = filter(sourceMessages)
  新 items = []
  遍历 filtered 分组出「turn 边界」（与 toRenderItems 相同的 user/assistant/system 分类）
  对每个 turn t：
    sig_t = [t.user, ...t.assistants] 的引用序列
    if cache 里存在同位置且 signature 相同的 turnObject:
      items.push({ kind:'turn', turn: cache.turnObjects[j] })   # 复用对象
    else:
      newTurn = buildTurn(t)   # 新建（等价现状 toRenderItems 的 new）
      items.push({ kind:'turn', turn: newTurn })
  # 末位 turn 的派生字段（isStreaming/hasFoldable）无论如何重算：
  末位 turn.isStreaming = forceWorking || 末位 assistant.status==='streaming'
  末位 turn.hasFoldable = 末位 turn 的成员是否含 thinking/toolCalls（成员变化时重算）
  更新 cache（lastSourceRef = sourceMessages）并 return items
```

**失效条件（缓存何时失效/清理）**：

1. **成员引用变化** → 该 turn 重建（上面已处理）。
2. **turn 边界变化**（插入/删除 user/system 消息，如 load-more、streaming 追加 assistant）→ 受影响位置之后的 turn 序号平移，但其**成员引用签名仍可按内容对齐**；为简化，缓存采用「位置 + 签名」双匹配：同位置签名相同即复用，位置变化但签名在新位置出现也可复用（可选优化，首版可只做同位置匹配，位置平移的 turn 重算成本是 O(转向量)，可接受）。
3. **session 切换/销毁** → 缓存必须随 session 隔离与清理。归属决策（审查修正——初稿放 `MessageStream.vue` 组件实例 ref，**生命周期前提错误**）：`Panel.vue:43` / `SubagentTab.vue:73` 的 `<MessageStream :session-id>` **无 `:key`**——Vue 切 sessionId 时不销毁组件实例、只更新 prop，组件实例 ref 会跨 session 残留上一会话的 Message 引用、且无任何清理钩子。这正是 AGENTS.md 规则 7 / ADR-0049 明令禁止的「实例级状态 + 无清理」反模式（恰是 ADR-0049 用 `useSessionScopedState` 工厂消灭的脆弱形态）。定案：**缓存经 `useSessionScopedState` 工厂管理**——`Map<sid, shallowRef<TurnRenderCache | null>>` 分区，工厂在 setup 时自动注册 cleanup（`triggerSessionCleanups`），`useSidebar.deleteSession` 时自动释放分区；组件内只读当前 sid 分区。它是纯派生缓存（可从消息数组无损重建），不需要跨组件共享，但**必须**走 ADR-0049 的分区/清理范式而非组件实例生命周期。这同时满足 G5：缓存可随时丢弃重建，无 drift 风险。

**`v-memo` 键的具体清单**（`Turn.vue` trace 区 `v-for` Block 的包装，或每个 Block 根节点）：

`v-memo` 键 = **[块身份字段, 内容/状态字段]**（审查修正：**不含 Block 本地折叠 ref**——v-memo 的 deps 数组在**父组件（Turn.vue）渲染作用域**求值，无法引用 Block 组件内部的私有 ref（`thinkingCollapsed`/`userToggledThinking`/`toolCollapsed` 均为 Block 内 `ref()`，Block.vue:228/231/399），「折叠态入键」结构上不可实现，照初稿字面实现必然在编译/求值层失败）：

| 块类型 | 身份字段（结构稳定） | 内容/状态字段（变化才重渲） |
|---|---|---|
| text | `flatIndex`（turn 内时序稳定序） | `content` 引用（`normalizeContent(msg.content)` 结果）、`status`（streaming/complete/error） |
| thinking | `thinking.id` | `working`（running→complete）、`status` |
| tool | `tool.id` | `tool.status`（running→complete/error，F8 终态）、`working` |

> **折叠态为什么不需要入键（审查修正，初稿误解了 v-memo 语义）**：v-memo 只 gate「父级 patch 传播到该子树」，不 gate 子组件**自身**的响应式更新。Block 组件实例被 `:key="fb.flatIndex"`（Turn.vue:59）保活，`thinkingCollapsed`/`toolCollapsed` 是 Block 自己的响应式 ref——用户点击折叠时 **Block 自身**的依赖触发其独立重渲染，与父级 v-memo 无关，折叠/展开视觉正常更新。展开态（`showTrace` → `visibleBlocks` 长度变化）是父级结构变化，自然触发 v-for 重渲染，也不进单个 block 的 memo 键。若实施中实测折叠不更新，排查方向是 Block 内部 ref 的响应式链路，而非「把本地 ref 塞进键」（那在结构上不可能）。

#### 3.3.2 D-5 的接口草案：markdown 增量渲染协议

**协议接口（`markdown.ts` 新增，`MarkdownRenderer.vue` 消费）**：

```ts
// 增量渲染结果：前缀段（已稳定、引用恒等缓存复用）+ tail 段（本次新渲染）。
// 协议是 MarkdownSegment[]（text/mermaid 交替，与现状 renderMarkdownSegments 同构），
// 不是裸 HTML 字符串对——初稿 {prefixHtml, tailHtml} 字符串拼接会把组件架构降级：
// ① tail 内闭合的 mermaid fence 经 md.render 产出 <div class="md-mermaid"> 占位 HTML，
//    直塞 v-html 无法成为持有 svg/status/renderSeq 内部态的 <MermaidRenderer> 组件；
// ② 前缀按「HTML 字符串」跨帧缓存后，前缀里已挂载的 MermaidRenderer 不再被重建 → 前缀 mermaid 图渲染停止。
// 段结构下 mermaid 保持组件形态，前缀段按引用恒等复用 + 稳定 key 保活实例。
export interface IncrementalRenderResult {
  prefixSegments: MarkdownSegment[]   // 稳定边界之前的段（含已闭合 mermaid 段；由调用方按引用恒等缓存，本函数不返回新前缀）
  tailSegments: MarkdownSegment[]     // 稳定边界之后的段（本帧 renderMarkdownSegments(tailText) 产出）
  stableBoundary: number              // 稳定边界的字符 offset（诊断用）
  mode: 'incremental' | 'fallback-full'   // 是否走了降级
}

export function renderIncremental(
  content: string,
  env?: MarkdownEnv,
): Promise<IncrementalRenderResult>
```

**实现骨架**：

```ts
export async function renderIncremental(content, env) {
  const boundary = findStableBoundary(content)   // §3.3.3 的规则
  if (boundary == null) {
    // 降级：全量渲染（等价现状 renderMarkdownSegments）
    return { prefixSegments: [], tailSegments: await renderMarkdownSegments(content, env),
             stableBoundary: 0, mode: 'fallback-full' }
  }
  const prefixText = content.slice(0, boundary)
  const tailText   = content.slice(boundary)
  const tailSegments = await renderMarkdownSegments(tailText, env)
  // 前缀段由调用方缓存（上一帧的 prefix 段引用），本函数不持有、不重建：
  // 边界前移时，调用方对新增前缀部分（上一帧 tail 中已稳定的部分）渲染并入前缀缓存。
  return { prefixSegments: [], tailSegments, stableBoundary: boundary, mode: 'incremental' }
}
```

**调用方（MarkdownRenderer.vue）的缓存与渲染语义**：

- **渲染树 = `[...prefixSegments(缓存), ...tailSegments(每帧)]`**，segment 首次产出时分配单调递增 `segId`（跨帧稳定），`v-for :key="seg.segId"`——前缀段的引用与 segId 稳定 → text 段的 v-html DOM 子树不触碰，**mermaid 段的 `<MermaidRenderer>` 组件实例跨帧保活**（内部 svg/status/renderSeq 态不重建、前缀 mermaid 图持续成图）。
- 边界 offset 单调不后退保证前缀缓存有效：若某帧边界比上一帧**后退**（防御性检测），该帧降级全量并重建缓存（见 §3.3.3「闭合单调性」）。
- **env 变化 → 前缀缓存失效重建**：`env.filePaths`/`localFiles` 引用变化（文件搜索加载完成）时，前缀中未链接化的路径需要重新链接化（现状 `markdown.ts:44` 注释的「首渲染空集 → 加载后响应式重渲染」语义），前缀缓存必须随 env 签名失效——env 签名 = `filePaths`/`localFiles` 的引用恒等；签名变化则该帧全量重渲染并重建前缀缓存。
- fence/mermaid 占位：`findStableBoundary`/渲染时检测「tail 以未闭合 code/mermaid fence 开头」（fence 开头 ``` 无配对闭合 ```），流式期把该 fence 渲染为占位 **text 段**（「语言名 + 转圈」行，不含 shiki/mermaid 调用）；token 静默 ≥T ms **或** message 进入 complete（`status` 非 streaming）时转为完整渲染（闭合 fence 正常走 shiki/mermaid 组件）。未闭合 fence 恒整体位于 tail（边界规则保证 prefix 全闭合）。T 为待验证阈值（§5）。

#### 3.3.3 稳定边界判定规则（草案 + 降级兜底）

**定义**：「最后稳定结构边界」= 从文档末尾向前找，最近的满足以下**全部条件**的字符位置：

1. **行首锚点**：处于某行的行首（即该位置要么是文档起始，要么前一个字符是 `\n`）——不在行内（不在某个块级结构的中段）。
2. **前段全闭合（含段落闭合）**：该位置之前的**所有** markdown 块级结构（fence、列表项、blockquote、表格行、缩进代码、setext/标题）在该位置处均处于**闭合状态**。**且段落必须闭合**：markdown-it 的 `<p>` 只在空行/块级边界闭合——边界前必须是空行（`\n\n`）或已闭合块级结构的后缘，否则 prefix 以悬空 `<p>` 结尾，`prefix + tail` 拼接后段落错并。
3. **后段 = 单一独立开放块**（审查修正：初稿「后段无开放结构」与最热 streaming 场景自相矛盾——增长中的普通段落/未闭合 fence/未闭合 mermaid 恰是 §5.3 矩阵 row1/3/4 的常态输入，若按字面「tail 不含未闭合结构」判定，这三个主导场景的 `findStableBoundary` 恒返回 null → 每帧全量渲染，D-5 对最热场景失效且多了边界扫描开销）：tail 从干净的块级边界开始，**允许含一个持续增长的未闭合结构**（增长中的普通段落 / 未闭合 fence / 未闭合 mermaid / 增长中的列表项或 blockquote）——该开放块不依赖前缀上下文即可独立解析。**不允许**的形态是「续行」：tail 以缩进续行开头（依赖前缀的代码块/列表缩进）、以表格分隔行 `|---|---|` 开头、是前缀列表项/blockquote 的续行而非新块——这些形态下 tail 独立渲染与全文渲染不一致，继续向前找边界或降级。
4. **拼接等价判据（正确性的唯一定义）**：`renderMarkdownSegments(prefixText + tailText)` 与 `renderMarkdownSegments(prefixText) + renderMarkdownSegments(tailText)` 在段层级等价（text 段 HTML 逐段一致、mermaid 段 source 一致）。**一切边界规则实现与测试都以该判据为准**——不满足判据的边界候选一律作废（§5.3 矩阵每行断言此判据，R5 验收做端到端 DOM 等价）。

**判定伪代码（草案）**：

```
function findStableBoundary(content): number | null:
  n = content.length
  # 从后向前找最近的「行首 + 前缀全闭合（含段落闭合）+ tail 独立开放块」点
  for i from n down to 1:                 # 逐字符回扫，O(n)
    if content[i-1] == '\n':              # i 是行首
      prefix = content[0..i]
      if isAllClosed(prefix):             # 前缀块级结构全闭合 + 段落闭合（边界前为空行或闭合块后缘）
        if tailStartsIndependentBlock(content[i..]):   # tail = 单一独立开放块（允许一个未闭合结构，拒绝续行形态）
          if 拼接等价(prefix, content[i..]):            # 判据 4：md(prefix+tail) == md(prefix)+md(tail)
            return i
  # 兜底：无任何行首满足 → 尝试文档起始
  if content 开头即干净块级边界的退化情况: return 0
  return null                             # 无法 O(n) 内确定 → 降级

function isAllClosed(prefix): boolean:
  # 维护一个块级状态栈：扫描 prefix，fence 开/闭配对、列表缩进栈、
  # blockquote 前缀、表格行连续、缩进代码(4 空格)块是否闭合
  # 全部配对闭合 且 prefix 以段落边界（空行/闭合块后缘）结尾 → true

function tailStartsIndependentBlock(tail): boolean:
  # tail 的首个非空行是否是「独立的块级起始」：非缩进续行、非表格分隔行、
  # 非列表/blockquote 续行；tail 内部允许一个未闭合结构持续增长
  # 极端情况：tail 是超大单行（无 \n）→ 判定不干净 → 触发降级
```

**O(长度) 约束与降级**：单次 `findStableBoundary` 的 `isAllClosed(prefix)` 需对 prefix 做一次线性扫描，最坏 O(n)；若因「超大单行」（几十 KB 无换行）导致无法在 O(n) 内找到行首锚点，或 tail 无法干净解析，**降级为全量渲染**（`mode: 'fallback-full'`）。

**闭合单调性（前缀缓存不后退的依据）**：markdown 的块级结构一旦闭合（fence 关闭、列表项结束），在当前流式 apppending 模型下**不会重新打开**——新增 token 只追加、不改写已闭合的历史前缀。因此「稳定边界」随流式推进**单调不后退**（边界只可能前移，不可能后移），前缀 HTML 可安全缓存复用。若实现中观察到边界后退（防御性检测），视为异常，该帧降级全量并重建缓存。

**待验证阈值（诚实标注，不编造）**：

- **静默阈值 T**（fence/mermaid 占位转完整渲染的静默时长）：无真实用户数据，实施期用真实流式场景 tuning。经验起点可暂设 200ms、300ms 做 A/B，但**不写死为结论**。
- **文档长度切点**（多少长度以下直接全量、以上才走增量）：F5 给出 10KB=18.1ms，切点应在「增量开销 < 全量开销」处；候选值如 4KB / 8KB，实施期用真实 50KB/200KB 回复实测确定。
- 两者在 §5 待验证检查点明确列出。

---

## §4 验收（真实场景，非单测）

**本节的结论：4 个真实验收场景回溯 G1/G5，用 `pnpm dev` 真实 Electron 应用 + 真实仓库 + 真实/mock 流验证；每个场景验收「变化部分才重渲」的因果链，不只看「看起来不卡」。**

> 验证环境与父文档 00 §4 一致：`pnpm dev`（renderer 9222），真实仓库（本仓），真实 pi 会话优先、mock 流兜底（标注缺口）。

| # | 场景 | 步骤 | 通过标准 | 回溯目标 |
|---|---|---|---|---|
| R1 | **真实 50KB 带代码块回复流式 60fps** | ① 在真实 200+ 消息 session 让 AI 生成 50KB 带代码块/mermaid 的回复；② devtools Performance 录 token 密集段；③ 观察 Performance 里 `toRenderItems` 调用堆（D-4）与 `md.render` 入参长度（D-5） | 流式帧率 ≥55fps；无 >100ms 长任务来自 markdown 渲染链；`md.render` 每帧入参长度 = tail 段（数十~数百字节），非全文；历史 turn 未出现在 patch 火焰 | G1 |
| R2 | **折叠/展开 thinking 与工具块，状态不冻结** | ① 让 AI 生成含多个 thinking（多步）+ tool 调用（含 running→complete）的回复；② 流式中点击展开/收起某 thinking、某 tool；③ 流式结束回看历史 turn，再次展开/收起 | 展开/收起即时生效（Block 内部响应式驱动，v-memo 不 gate 子组件内部更新）；running→complete 时块状态头正确翻转（不 remount 丢态）；历史 turn 回看展开态正确（store 展开态 + 本地折叠态都不串台） | G1 + G5 |
| R3 | **200KB 文档打开不卡（全量/降级路径）** | ① 打开一条含 200KB 文本的历史回复（或让 AI 生成 200KB）；② 观察首帧渲染时间；③ 若触发降级，观察降级后内容完整无缺 | 首帧可见内容 <250ms；F5 基线 253ms（200KB 全量）在增量路径下显著下降；降级路径下内容 100% 完整（正确性不减） | G1 + G5 |
| R5 | **增量渲染正确性等价（DOM 级）** | 同一条 50KB 回复流式结束后：① 记录增量路径的最终 DOM；② 强制关闭增量（降级全量）重新渲染同一消息，对比两 DOM | 两 DOM 在关键标记（fence/列表/表格/mermaid 占位→图/路径链接）上逐点一致；前缀中的 mermaid 成图；「增量路径拼接 == 全文渲染」在真实 DOM 层成立 | G5 |
| R4 | **mermaid 流式不整图重渲 + 前缀保活** | ① 让 AI 生成一个 mermaid 图（```mermaid ...），流式期间观察；② 图闭合且静默后成图；③ 继续流式一段文本（前缀含该 mermaid）；④ 主题切换一次 | 流式期间 mermaid 块显示占位（不每帧调 `renderMermaid`，探针 P5 计数 ≈ 0）；闭合静默 ≥T ms 或 complete 后渲染一次成图；**前缀中的 mermaid 在后续帧持续成图（MermaidRenderer 实例跨帧保活，不被重建）**；主题切换重渲一次（保留现有行为） | G1 |

**验证缺口**：R1/R2/R4 若无真实模型，用 mock 流（70ms/chunk）可覆盖渲染路径但无法压真实 token 速率上限——优先真实 pi；R3 的 200KB 回复可用历史会话文件离线加载模拟（`getHistoryFromFile` 路径）。

---

## §5 下一层拆分

**本节的结论：下一层 = 可实现的代码任务（接口已定，§3.3）+ 边界判定单测矩阵；实施顺序 D-4 先（依赖少）→ D-5 后（复用 D-4 的稳定引用，且有阈值 tuning 后置）。**

### 5.1 单元拆分（代码任务）

| 任务 | 内容 | 文件 | justification |
|---|---|---|---|
| U1 | 实现 `toRenderItemsIncremental`（含 `TurnRenderCache`），保持 `toRenderItems` 全量版作为 `cache=undefined` 退化路径 | `packages/core/src/domain/chat/message-turns.ts` | 纯函数、零 Vue 依赖，可独立单测，复用键正确性是 D-4 根基 |
| U2 | `MessageStream.vue` 引入 per-session 分区缓存（`useSessionScopedState` 工厂：`Map<sid, shallowRef<TurnRenderCache \| null>>` + 自动 cleanup），`renderItems` 改调增量版（传源数组 + filter） | `packages/renderer/src/components/panel/MessageStream.vue` | ADR-0049 分区/清理范式——`<MessageStream>` 无 `:key`、实例不随 session 销毁，实例级缓存会跨 session 残留；快路径键 = 源数组引用（filter 产物每调用新数组，键其上快路径恒 miss） |
| U3 | `Turn.vue` trace 区 `v-for` 包 `v-memo`，键 = [块身份, 内容/状态]（**不含 Block 本地折叠 ref**，§3.3.1 清单） | `packages/ui/src/features/chat/Turn.vue` | 折叠态由 Block 内部响应式驱动（实例被 `:key` 保活）；本地 ref 在父作用域不可求值，「折叠态入键」结构上不可实现 |
| U4 | 实现 `findStableBoundary` + `renderIncremental` + fence/mermaid 未闭合占位 | `packages/renderer/src/composables/logic/markdown.ts` | D-5 核心，边界规则正确性靠 U6 单测矩阵 |
| U5 | `MarkdownRenderer.vue` 改增量渲染 + 前缀缓存 + 静默/complete 转完整渲染 | `packages/ui/src/features/chat/MarkdownRenderer.vue` | 消费 U4 协议，前缀缓存单调复用 |
| U6 | 稳定边界判定单测矩阵（§5.3） | `packages/core` 或 `packages/renderer` 测试 | 边界规则的回归防线 |

### 5.2 文件改动地图

```
packages/core/src/domain/chat/message-turns.ts      + toRenderItemsIncremental + TurnRenderCache（U1）
packages/renderer/src/components/panel/MessageStream.vue  renderItems 改增量 + per-instance 缓存（U2）
packages/ui/src/features/chat/Turn.vue              trace v-for 包 v-memo（U3）
packages/ui/src/features/chat/MarkdownRenderer.vue  增量渲染 + 前缀缓存 + fence 占位（U5）
packages/renderer/src/composables/logic/markdown.ts  findStableBoundary + renderIncremental + fence/mermaid 占位（U4）
（单测文件随 U1/U4 就近新建，如 message-turns.incremental.test.ts / markdown-incremental.test.ts）
```

> 不触碰：`virtua` 结构、`renderKey`/`turnStableId`（父文档裁定已正确）、`MermaidRenderer.vue` 的成图逻辑（只加「未闭合 source 暂不重渲」的守卫，不改其渲染内核）。

### 5.3 高价值单测：稳定边界判定矩阵

边界判定是 D-5 正确性的唯一风险点，用**输入→期望边界**矩阵覆盖（每行一个 markdown 结构形态）：

| 结构形态 | 输入（tail 部分示意） | 期望稳定边界 |
|---|---|---|
| 已完成段落 + 进行中段落 | `...\n\n已闭合段落。\n\n` + 进行中的半句话 | 进行中段落之前的 `\n` 行首 |
| 已闭合 fence + 进行中段落 | ```` ```ts\ncode\n```\n` + 进行中文本 | 闭合 ``` 之后的 `\n` |
| 未闭合 fence（占位触发） | `...\n```ts\n  part of code`（无闭合 ```） | fence 开头 ``` 之前（fence 整体进占位） |
| 未闭合 mermaid fence | `...\n```mermaid\ngraph LR` | 同上，mermaid 整体进占位 |
| 已完成列表 + 进行中列表项 | `- a\n- b\n` + `- 进行中半句` | **列表起始前**（`- a` 之前）——整个开放列表作为 tail 的单一独立开放块：在 `- b` 后切分会把一个列表拆成两个 `<ul>`，违反拼接等价判据 |
| 已完成 blockquote + 进行中正文 | `> q\n` + `进行中正文` | blockquote 闭合后 |
| 表格行不完整（无管道闭合） | `| a | b |` + 进行中续行 | 表格起始前 |
| **超大单行（降级）** | 几十 KB 无 `\n` 的单行 | `null`（降级 full） |
| 空文档 / 仅空白 | `` / `   ` | `0`（或降级，首版从简） |

**断言强规则**：每行断言「边界 offset 处前缀的块级结构全闭合**（含段落闭合：边界前为空行或闭合块后缘）**」+「**拼接等价判据：`renderMarkdownSegments(prefix+tail)` 与 `renderMarkdownSegments(prefix) + renderMarkdownSegments(tail)` 段级等价**」；降级行断言 `mode === 'fallback-full'` 且输出等同全量渲染结果。矩阵 row1/3/4（增长中段落/未闭合 fence/未闭合 mermaid）按 §3.3.3 条件 3 修订语义成立：tail 是「单一独立开放块」，边界落在开放块之前的行首。

### 5.4 待验证检查点（诚实标注，不编造）

1. **静默阈值 T**：fence/mermaid 从占位转完整渲染的静默时长。无真实数据，实施期用真实流式实测（候选 200ms/300ms A/B）。
2. **文档长度切点**：多少长度以下直接全量、以上才增量。以 F5（10KB=18.1ms）为锚，候选 4KB/8KB，实施期用 50KB/200KB 真实回复实测「增量开销 < 全量开销」的交叉点。
3. **边界单调性假设**：§3.3.3 的「闭合单调性」在真实 pi 流式（可能的重写/修正行为）下是否恒成立——用真实 pi 会话验证，若偶发边界后退，验证降级路径覆盖且不缺氧。

### 5.5 运行时断言探针（✅/⛔，实施期挂在 dev 环境，生产裁剪）

| # | 探针 | 断言（✅ 通过 / ⛔ 失败） | 归属 |
|---|---|---|---|
| P1 | `toRenderItemsIncremental` 复用率 | ✅ 历史 turn 复用率 = 100%（除位置平移）；⛔ 某 token 出现全量 turn 重建 | D-4 |
| P2 | 消息身份不可变 | ✅ 同一消息 id 的对象引用在生命周期内不变；⛔ 检测到原地 mutate（预埋 `Object.freeze`/断言） | D-4 依赖 |
| P3 | `md.render` 每帧入参长度 | ✅ 每帧入参 = tail 段（远小于全文）；⛔ 出现全文入参且非降级 | D-5 |
| P4 | 前缀缓存单调性 | ✅ 稳定边界 offset 单调不减；⛔ 边界后退 | D-5 |
| P5 | mermaid/未闭合 fence 重渲计数 | ✅ 流式期 `renderMermaid`/shiki 调用 ≈0（占位）；⛔ 流式期整图/整块重渲 | D-5 |
| P6 | 降级次数 | ✅ 降级仅发生在「超大单行/无行首锚点」等预期形态；⛔ 高频降级（>X次/回复，X 待定） | D-5 |

---

## 附录：与父文档的一致性核对

- 术语沿用：turn、token、失效扇出、Map 分区派（父 00 §1.1 术语表）；F10 的「turn UI 态三类」直接映射到 §3.3.1 的 v-memo 键清单。
- 决策编号：D-4/D-5 与父 00 §3.1 决策矩阵完全一致；被否方案（A2/B/A'/C）与父文档拍板一致。
- 依赖：08 依赖 07 的不可变身份（父 00 §3.4 阶段 3 已声明），文档 §1.2 写明、接口不依赖完成状态。
- 目标：G1/G5 逐场景回溯（§4 表格）。
