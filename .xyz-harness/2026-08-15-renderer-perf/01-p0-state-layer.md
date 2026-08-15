# P0 状态层：容器范式 + per-session 派生 + token 合帧（子文档 01）

> **一句话结论**：把 `messages` 从「Map 恒等不稳定 + 全局 streaming computed + 逐 token 提交」改为「Map 恒等稳定 + 每 session 独立 ref + per-session 惰性 computed + microtask 合帧」，让每个 token 的失效范围从「全部 session」收敛到「当前 session 一个 ref」，且提交次数从「每 token 一次」降到「每 microtask 一次」——这是失败模式 A 的第一根因（根因 1）的唯一修法，也是子文档 02 的地基。

- **S（情境）**：xyz-agent 开发者看 AI 流式回复时，每个 token 都要走 `WS → core transport → chat store → 消息组件 → markdown` 全链路。这条链路的头部是 `packages/core` 的 chat 域状态层（`store.ts` 的 `messages` 可变状态 + 派生），本文档只改这一层。
- **C（冲突）**：`messages = shallowRef<Map<string, Message[]>>` 每次 commit 都整体替换 Map 身份（`mutations.ts` 的 `new Map` 全表拷贝），导致所有读 `messages.value` 的 computed 跨 session 失效；同时 `streamingSessionIds` 是全 Map 重扫的全局 computed，且每个 token 单独提交一次 `commitMessages`——无效写 + 无效算 + 无效失效。
- **Q（问题）**：如何让一个 token 只触发「目标 session 的状态」的重算，且不引入与消息数组重复的漂移状态、不修补症状？
- **A（答案）**：三件事（对应 D-1/D-3/D-2）：消息容器改为「Map 恒等稳定 + 每 session 一个 `ShallowRef<Message[]>`」；streaming 派生改为「per-session 惰性缓存 computed」；WS 回调层加 microtask 台帧批量。三件事在任何一次代码走读里是互相咬合的，无法真正独立成三份文档，故合并为本子文档。

---

## §1 背景与目标

**本层的结论：本文档是「技术方案设计」层——给出一份可实现的接口清单、数据模型与错误规格，其中 D-2 的批处理窗口边界有一处阈值必须在实施期用真实数据验证（诚实标注；父文档「诚实标注、不编造」原则）。**

### 1.1 层次定位（本层 vs 下一层）

父文档 §5 已定：子文档各是「技术方案设计」层。所谓**技术方案设计层**，指本文不落到「改哪一行」，而是落在「改完后的接口长什么样、数据模型怎么组织、边界条件怎么处理」，让实施者（下一个 agent）能**直接照写代码与测试**；落到具体行号、具体函数体的，是下一层「实现计划」。本文与父文档是「衍生关系」，不需要读者回头读父文档——凡引用父文档处均就地复述。

- **本层（本文）**：接口签名草案、数据模型结构、错误/恢复规格、多方案对比、验收场景、探针清单、下一层拆分地图。
- **下一层（实施计划 / 代码任务）**：`commitMessages` 新签名落地、`store.ts` 的 `messages` 声明与 `streamingSessionIds` 删除、`lru.ts` 的 `messagesValue` 适配、`useChat.ts` 的 coalescer 落点、5 个测试文件的适配策略、每个文件的具体 diff。

### 1.2 In / Out of Scope

- **In**：
  - `packages/core/src/domain/chat/mutations.ts`（`commitMessages` / `deleteMessages` 的容器模型）
  - `packages/core/src/domain/chat/store.ts`（`messages` 声明、`getMessages`/`isGenerating`/`streamingSessionIds` 删除、`setMessages`/`hydrate` 等写入方适配、`disposeSession`）
  - `packages/core/src/domain/chat/lru.ts`（`messagesValue` getter、`deleteMessageKey` 适配）
  - `packages/core/src/domain/chat/streaming-state-machine.ts`（`finalizeMessages`/`applySubagentStreamDelta`/`finalizeSubagentStream` 经 `commitMessages` 间接受影响，签名不变）
  - `packages/core/src/domain/chat/useChat.ts` 的 `ensureStreamSubscription`（D-2 台帧落点）
  - `packages/core/src/domain/chat/effects/registry.ts`（`text_delta`/`thinking_delta` 的 handler 走向与 flush 语义）
  - 2 个整-ref watcher：`packages/renderer/src/composables/features/file-tree/useFileChangeInvalidation.ts`、`features/search/useSearch.ts`（失效频率收敛，接口不变）
  - 5 个直接断言 `messages.value` 的测试文件（见 §5）
- **Out**：D-4/D-5（渲染层、子文档 02）、D-6/D-7/D-9（面板层、子文档 03）、D-8（构建、子文档 04）；pi 进程与 runtime 侧任何改动；功能需求变更；样式与视觉。

### 1.3 本层目标与 G 回溯

本层只回填 G1 与 G5（父文档已定 D-1/D-2/D-3 对应 G1/G5）：

| 目标 | 本文档如何服务它 |
|---|---|
| **G1**（200+ 消息长 session 流式不掉帧、不随对话增长变卡） | D-1 使 token 失效范围=单 session；D-3 使 `isGenerating` 只依赖本 session ref；D-2 使提交次数降一个数量级 |
| **G5**（结构上正确：不引入漂移状态、不靠脆弱缓存、不修补症状） | D-3 明确否决「显式计数器」；D-1 明确否决 `markRaw`/`triggerRef` 修补；D-2 明确否决 store 层批量 |

---

## §2 现状与问题分析

**本节的结论：热路径的真实根因有三——`commitMessages` 的 `new Map` 全表拷贝制造跨 session 失效、`streamingSessionIds` 全 Map 重扫制造无效重算、逐 token 提交制造无效写＋无效失效；其中「拷贝成本」已被 F1 证伪，所以 D-1 的收益是失效扇出收敛而非省拷贝。**

### 2.1 关键术语（首次定义，绑定例子）

读者会看到几个反复出现但未必有共识的词，先一次性定义（后文不再重复定义，直接用）：

- **失效扇出（invalidation fan-out）**：一次响应式写入触发的依赖重算范围。例：`commitMessages` 替换整个 Map → `messages.value` 的每个 `get()` 调用点（`streamingSessionIds`、`getMessages`、两个 watcher、13 个 `getMessages` 消费方）全部重新求值，哪怕它们只关心**另一个** session。这就是「跨 session 失效」——失败模式 A 的第一根因。
- **Map 恒等稳定**：Map 对象的引用只在「增删 session」时变化，同一 session 内消息更新时 Map 引用不变。例：A、B 两个 session 都在流式，A 收到 delta → 只有 A 的分区 ref 被替换，外层 Map 引用不动，因此读 Map 的代码不会因 A 的更新而重算。
- **惰性缓存 computed**：不参与总体渲染的派生值，在首次被访问时才计算并缓存，依赖变化时仅失效、不再主动计算。与「eager computed」相对——eager 是在定义时就被上游依赖图订阅，任何一个依赖抖动都触发重算，哪怕结果暂时无人读。
- **reactive proxy（深响应式代理）**：Vue `reactive()`/`ref()` 对对象递归建代理，每个字段的读写都可追踪。ADR-0039 用 `shallowRef` 的动机就是消除这条链路上万级深 proxy。
- **shallowRef 契约**：`shallowRef` 只对 `.value` 的**整体替换**是响应式的，`Map`/数组内部的 mutation 不触发。所以现状所有写入必须「取数组 → 造新数组 → 整体 set」的不可变写法。

### 2.2 现状数据流图（一个 token 从 WS 到 DOM）

下面是一条 `message.text_delta` token 的**完整旅程**，标注了三个根因的物理位置（`← R1/R2/R3`）：

```
[pi 进程] 产出 token
  └→ [runtime] WS 推 message.text_delta
      └→ [core transport] route-inbound 按 payload.sessionId 路由（无全量扇出，已优化）
          └→ [core useChat.ensureStreamSubscription] 会话级订阅回调 (core/domain/chat/useChat.ts:177)
              │   msg.type.startsWith('message.') → chat.applyMessageEvent(sid, msg)   ← R3 落点（逐条直推）
              └→ [store.applyMessageEvent → effects/registry.dispatchMessageEvent]
                  └→ 'message.text_delta' handler (registry.ts:248-264)
                      │   const prev = messages.value.get(sid) ?? []      // 读当前 sid 数组
                      │   const next = [...prev]                          // 全消息数组浅拷贝
                      │   next[idx] = { ...next[idx], content: content+delta, ... }
                      │   commitMessages(messages, sid, next)             // ← 进入 R1
                      └→ commitMessages (mutations.ts:23-29)
                          │   messages.value = new Map(messages.value).set(sid, next)   ← R1：new Map 全表拷贝
                          │        ↓ shallowRef 整体替换
                          ├→ [失效扇出 1] 所有读 messages.value 的 computed 重算：
                          │     ├─ streamingSessionIds (store.ts:178-189)  ← R2：全 Map 重扫 O(Σ消息)
                          │     ├─ isGenerating/isActive/isLruExempt → 依赖 streamingSessionIds
                          │     ├─ getMessages(sid) 的 13 个消费方
                          │     └─ watch([sidRef, chatStore.messages]) ×2:
                          │           useFileChangeInvalidation.ts:46（每 token 全量重扫 fileChanges）
                          │           useSearch.ts:78（每 token 重扫，但实际逐 sid 重建 watcher）
                          ├→ [失效扇出 2] currentMessages/renderItems → toRenderItems 全量重建（02 的事）
                          └→ [渲染] virtua diff → 视口内 Turn patch → markdown 重渲染（02 的事）
```

第 2.3 小节把这条图里 `R1/R2/R3` 三个根因对应到代码级证据。

### 2.3 现状代码事实（真实片段，不编造）

#### 2.3.1 R1：`commitMessages` 的 `new Map` 全表拷贝 → 跨 session 失效

`packages/core/src/domain/chat/mutations.ts:23-29` 是消息写入的唯一收敛点（文件头注释自述「收敛 messages 写入的不可变写法」）：

```ts
export function commitMessages(
  messages: MessagesRef,       // { value: Map<string, Message[]> }
  sessionId: string,
  next: Message[],
): void {
  messages.value = new Map(messages.value).set(sessionId, next)   // ← 全表拷贝
}
```

配合 `store.ts:83` 的声明：

```ts
const messages = shallowRef<Map<string, Message[]>>(new Map())
```

`shallowRef` 只对 `.value` 整体替换敏感，所以 `commitMessages` **必须** `new Map(...)` 才能触发响应式（`store.ts:80-82` 注释明确了这个约束）。后果是**每个 token**：① 拷贝整个 Map（所有 session 的 key→数组引用）；② 替换 `.value` → 外层 Map 身份变化 → 所有读 `messages.value` 的依赖失效，**包括只关心别的 session 的依赖**。

**为什么这是「无效」而非「贵」**：F1 实测证伪了拷贝成本本身——S=10/M=500 @25 commit/s 仅 0.1ms/秒。所以 R1 的**真实代价不是 `new Map` 的 CPU，而是它制造的失效扇出范围**。D-1 的收益定位必须写清楚：**收益＝失效扇出收敛，而非省拷贝**（父文档 §2.4 F1 行）。

#### 2.3.2 R2：`streamingSessionIds` 全局 computed 全 Map 重扫

`packages/core/src/domain/chat/store.ts:178-189`：

```ts
const streamingSessionIds = computed(() => {
  const ids = new Set<string>()
  for (const [sid, msgs] of messages.value) {
    for (const m of msgs) {
      if (m.role === 'assistant' && m.status === 'streaming') {
        ids.add(sid)
        break
      }
    }
  }
  return ids
})
```

`store.ts:196-198` 的 `isGenerating` 依赖它：

```ts
function isGenerating(sessionId: string): boolean {
  return streamingSessionIds.value.has(sessionId)
}
```

`messages` 的 `.value` 每换一次，这个 computed 就**无条件全 Map 重扫一遍所有 session 的所有消息**（`for (const [sid, msgs] of messages.value)`），哪怕变动的只是 A session 的最后一条 assistant 的 `content`（status 根本没变）。这就是 R2：**为回答「这个 sid 是否在 streaming」，去重算「所有 sid 是否在 streaming」**。F1 证伪后，这层 O(Σ消息) 重扫是纯浪费——status 只会在极少数点翻转（F8）。

#### 2.3.3 R3：逐 token 直推提交，无任何合帧

`packages/core/src/domain/chat/useChat.ts:177-192`（会话级订阅回调）是 WS 消息进入 store 的**唯一入口**（renderer 侧 `composables/features/chat/useChat.ts` 经 §2.3.4 确认只是薄包装）：

```ts
const unsub = deps.chatApi.streamSubscribe(sid, (msg) => {
  if (msg.type === 'send.rejected') { ...; return }
  if (msg.type.startsWith('message.')) {
    chat.applyMessageEvent(sid, msg)     // ← 每条 delta 立即 apply，无缓冲
    return
  }
  switch (msg.type) { ... }              // session.* 分支
})
```

`applyMessageEvent`（`store.ts:340-359`）→ `dispatchMessageEvent`（`registry.ts:575-584`）→ `'message.text_delta'` handler（`registry.ts:248-264`），链路上**没有任何地方缓冲**：pi 每推一个 delta（F13：mock 14/s，真实 pi 假设 10-80/s），就执行一次 `commitMessages` → 一次 `new Map` → 一次全量失效扇出。R3 的合帧目标是让「连续的同类型 delta」在一个 microtask 内只 commit 一次，终态消息（complete/error）则先 flush 再处理。

#### 2.3.4 WS handler 实际位置的确定（D-2 落点）

本文必须确认「WS handler 到底在哪、D-2 改哪」。结论（已 `read` 两个文件确认）：

- **真实逻辑在 core**：`packages/core/src/domain/chat/useChat.ts` 的 `ensureStreamSubscription`（第 177 行的 `streamSubscribe(sid, (msg) => {...})` 回调）是 `message.*` 消息分发到 store 的唯一真实 handler。
- **renderer 侧是 re-export**，无第二份逻辑：`packages/renderer/src/composables/features/chat/useChat.ts` 全文 115 行，只做三件事（文件头注释自述）：`useChat() = createUseChat(rendererDeps)`、`ensureStreamSubscription` 同名包装（注入 renderer deps 后调 core 版）、re-export `resetChatModuleState`。**没有任何真正的 WS 回调逻辑**。
- **因此 D-2 落点 = core `useChat.ts` 的 `ensureStreamSubscription` 回调**，renderer 侧零改动。

#### 2.3.5 两个整-ref watcher（失效频率收敛的直接受益者，接口不变）

`packages/renderer/src/composables/features/file-tree/useFileChangeInvalidation.ts:45-71`：

```ts
const unwatch = watch(
  [() => sessionIdRef.value, () => chatStore.messages],   // ← watch 整 messages ref
  () => {
    const sid = sessionIdRef.value
    if (!sid) { lastPaths = new Set(); return }
    const msgs = chatStore.getMessages(sid)               // 读当前 sid 数组
    const currentPaths = new Set<string>()
    for (const m of msgs) {
      if (m.role !== 'assistant') continue
      for (const fc of m.fileChanges ?? []) currentPaths.add(fc.filePath)
    }
    const changed = [...currentPaths].filter((p) => !lastPaths.has(p))
    if (changed.length > 0) onInvalidate(sid, changed)
    lastPaths = currentPaths
  },
  { deep: true, immediate: true },
)
```

`packages/renderer/src/composables/features/search/useSearch.ts:78-98` 里 `setupInvalidation`（`useFileSearch`）同样 watch 整 `chatStore.messages`，且每次 `activeSessionId` 变化 rebuild 该 watcher。两者目前**每个 token 都会重扫当前 session 的全部消息的 fileChanges**（见失败模式 E：`useFileChangeInvalidation` 每 token 全量重扫无产出的 stale 角标）。D-1 落地后，这两个 watcher 的失效信号从「整 .value 替换」收敛为「当前 sid 的分区 ref 替换」，且批量（D-2）后每 microtask 才触发一次。**注意：本子文档不改它们的逻辑（那是 D-9 的 overlay 刷新），只保证它们的失效频率降下来**。

### 2.4 失败模式与根因映射

本文对应的失败模式 A（G1 的反面）与 E（G2/G5 的反面的一部分），根因收敛到 §2.3 的 R1/R2/R3：

| 根因 | 代码位置 | 制造的问题 | 对应决策 |
|---|---|---|---|
| **R1** 无条件全 Map 拷贝 + `.value` 整体替换 | `mutations.ts:23-29` + `store.ts:83` | 跨 session 失效扇出 → 三层 computed 级联 | D-1 |
| **R2** 全局 streaming computed 全 Map 重扫 | `store.ts:178-189` + `196-198` | 状态未变也重算 O(Σ消息) | D-3 |
| **R3** 逐 token 直推提交无合帧 | `core/useChat.ts:177-192` | 提交次数 = token 数，R1/R2 被重复触发 | D-2 |

**为什么 F1 证伪后 R1 仍然成立**：F1 证明的是「拷贝的 CPU 是 0.1ms/秒，不值一提」；但 R1 的代价不在拷贝，而在**它触发的失效扇出**——`new Map` 替换 `.value` 是「失效」动作，不是「拷贝」动作。这两个动作在旧代码里被绑在一起（不换 Map 就换不了 `.value`，不换 `.value` 就不失效），D-1 要做的正是**把它们解绑**：让「换 `.value` 触发失效」的动作粒度降到「单个 session 的 ref」。

### 2.5 触发条件与现状边界（约束，方案必须满足）

从真实代码盘点出的硬约束（§3 方案必须一一对照）：

1. **写入点众多且分散**：`commitMessages` 被 `hydrate`/`setMessages`/`appendUser`/`markSessionError`/`appendSystemNotice`/`truncateFrom`/`prependHistoryMut`/`finalizeBashOnly`（store.ts）＋ `text_delta`/`message_start` 等（registry.ts）＋ `finalizeMessages`/`applySubagentStreamDelta`/`finalizeSubagentStream`（streaming-state-machine.ts）多处调用。接口必须让这些写入方改动最小。
2. **虚拟 session 动态建 key**（父文档「虚拟分区约束」）：`subagent.ts`/`workflow.ts` 用任意 string 虚拟 id（`subagent:...`/`agentcall:...`）写 messages（`applySubagentStreamDelta`，`streaming-state-machine.ts:48-71`）。Map 必须支持运行时任意 string 动态建 key，不能预设。
3. **整 Map 直接消费者 3 处**（F9）：`lru.ts`（`messagesValue` getter）、`streamingSessionIds`（将删除）、`streaming-state-machine.ts`（`collectFinalizeCandidates` 遍历 `messages.value.keys()`）。D-1 后前两者需适配，第三个遍历 key 的行为不变。
4. **`status:'streaming'` 写入点仅 3 处**（F8）：`message_start`（`registry.ts:146`，新建 streaming assistant）、`bash-effects.ts:55`（新建 streaming bash）、`registry.ts` thinking/tool 相关（但含 `status:'streaming'` 字面量的主要三处即这几处）＋ `finalizeMessages` 单点终态翻转。这决定了 R2 的重算 99% 是徒劳。
5. **D-010 sealed 幂等**（F8）：`text_delta` handler 开头 `if (!isLastAssistantStreaming(messages, sid)) return`（`registry.ts:251`）——finalize 后晚到 delta 被丢弃。D-2 的 flush 边界必须与此交互（见 §3.3.3）。
6. **`getMessages` 消费方 13 个接口不变**（F9）：`getMessages(sid)` 当前返回 `Message[]`（`store.ts:206-208`），D-1 后签名/返回类型不变，13 个消费方零改动。
7. **5 个测试文件直接断言 `messages.value`**（F9）：见 §5 适配策略。
8. **ADR-0039/0049 兼容**（F12）：ADR-0039 动机＝消除深 proxy；ADR-0049 要求 Map 分区派。D-1 是「更彻底的 Map 分区」——外层 Map 保持，每 session 值由「普通数组」升级为「shallowRef 数组」，代理深度不变（仍是浅）。

---

## §3 解决方案

**本节的结论：三项决策均是「结构上正确」而非「修补症状」——D-1 解绑「拷贝」与「失效」、D-3 把「全局派生」降为「单 session 惰性派生」、D-2 把「逐条提交」降为「批量提交」；每项都给出了被否方案的「若用了它会怎样」。**

### 3.1 终态（使用者视角 + 成功/失败路径）

实施完成后，一个开发者在「双 panel 各开一个 session，其中一个在流式」的场景下的体验与内部行为：

**成功路径（正常流式）**：
1. pi 连续推 `text_delta`，core `useChat` 的 coalescer 把它们按 sid 缓冲到 microtask；
2. microtask flush 时，每个 sid 只 commit 一次：`messages.value` 外层 Map 引用**不变**，只有该 sid 的分区 ref 被替换为新数组；
3. 只有依赖该 sid 分区 ref 的 `isGenerating(sid)`（惰性 computed）与 `getMessages(sid)` 的下游重算；
4. `streamingSessionIds` 已不存在（per-session computed 取代），不再有 O(Σ消息) 的全 Map 重扫；
5. A panel 的流式完全不影响 B panel 的 `isGenerating(B)`、B 的渲染、B 的 file-tree watcher。

**失败路径 A（延迟到达的 delta 在 finalize 之后）**：`finalizeMessages` 已被 `message.complete` 触发 → 最后一条 assistant 翻成终态。此时迟到 delta 到达，`text_delta` handler 的 `isLastAssistantStreaming` 守卫返回 false → 丢弃（D-010 sealed 原语义，D-2 不改变它，见 §3.3.3）。

**失败路径 B（虚拟 session 动态 key）**：`applySubagentStreamDelta(virtualId, lines)` 对一个此前不存在的 `virtualId` 写入 → `commitMessages` 见 Map 无此 key → **首次建 key**（替换外层 Map 加一个 key）。这是「增删 session」正当触发 Map 替换的唯一情形。恢复指引见 §3.3.3。

**失败路径 C（切 session 后迟到消息）**：会话级订阅退订是异步的（`watch` flush:pre），切走 session B 后，B 的迟到 delta 可能短暂仍到达。coalescer 按 `capturedSid`（订阅时闭包捕获）缓冲并 flush 到 B 的分区 ref——**只写 B 的分区**，不串 A、不污染新 session（结构上消除竞态，与 ADR-0049 §7.6 的 `updateFor` 同思路，但这里因为 Map 分区天然隔离，flush 目标 ref 由 sid 决定）。

**恢复指引（开发者可用操作）**：
- 若观察到某 session 消息「停在半截」：确认是否 `message.complete`/`error` 已到但 UI 未刷新——D-2 保证任何终态消息先 flush 缓冲再处理，所以终态**即时**可见，不依赖 microtask。
- 若观察到「消息串屏」（A 的 token 出现在 B）：这是本方案要消除的 bug，说明 flush 目标 sid 错了；排查 coalescer 的 buffer key 是否用 `capturedSid` 而非实时 `sid`。
- 若切 session 后历史「消失」：那是 LRU 驱逐，与本层无关（D-1 不改变 LRU 驱逐语义，只改 `messagesValue` 的读取形态）。

### 3.2 决策的多方案对比

#### 3.2.1 D-1 容器范式

| 方案 | 长期架构合理性 | 短期实现成本 | 风险 |
|---|---|---|---|
| **A（选定）`shallowRef<Map<string, ShallowRef<Message[]>>>`** | **高**：Map 层与 Message 层职责分明——Map 持「有哪些 session」（低频变化）、Message[] 持「某 session 的消息」（高频变化）；失效粒度=单 session ref；与 ADR-0039（浅代理）/0049（Map 分区）双重兼容 | **中**：改 `commitMessages`/`deleteMessages` 签名 + `store.ts` 声明 + `lru.ts` getter + `streaming-state-machine` 的 3 处写法 + 5 个测试适配 | **低**：契约是「每 sid 一个 ref」的机械映射，无新语义 |
| B `triggerRef` 修补：保持 Map mutation，commit 后手动 `triggerRef(messages)` | **低**：把「合法 mutation 不触发」的坑用 `triggerRef` 打补丁，失效粒度仍是整 Map（`triggerRef` 只会让依赖 `.value` 者重算，粒度没变） | **低**：只在 `commitMessages` 末尾补一行 | **中**：粒度没收敛，R1 的失效扇出原样保留；且所有 commit 点都要记得补 triggerRef，漏一处就是「更新了但不刷新」的静默 bug |
| C `reactive(Map)` + `markRaw` 元素 | **低**：`reactive(Map)` 重新逐条代理元素，除非每个 session 写时都 `markRaw`，否则违反 ADR-0039 动机（重新引入万级深 proxy） | **低**：改两行 | **高**：ADR-0039 明确「markRaw 每条 message 侵入每个写入点、极易漏」，此方案正是把 ADR-0039 已否掉的东西请回来 |
| D 归一化实体表（消息独立实体 + session→id 索引） | **低**：消息不是跨 session 共享实体（F12 父文档已判「消息非共享实体」），归一化是过度设计；引入第二份索引与消息数组重复状态，违反 G5 | **高**：重写整个 store + 所有消费方 | **高**：drift 风险（索引与数组两份状态），且与 ADR-0049 的「Map 分区」无直接关系 |

**推荐 A。被否方案「若用了它会怎样」**：
- 若用 B：省 20 行改动，但 `triggerRef` 仍是整 Map 失效——D-1 的「失效扇出收敛」目标**完全落空**，等于白做；且 `streamingSessionIds`（R2）仍在整 Map 重扫。
- 若用 C：违反 ADR-0039，长对话的内存/GC 问题（70-500MB 深 proxy）复现，G5 直接挂；且遗漏一处 `markRaw` 就是静默不刷新。
- 若用 D：为一个「非共享实体」造归一化表，工程成本数倍于 A，收益为零甚至为负（索引维护 + drift），违背父文档 §3.4「D-4 选择缓存而非归一化」的同款权衡。

#### 3.2.2 D-3 streaming 派生

| 方案 | 长期架构合理性 | 短期实现成本 | 风险 |
|---|---|---|---|
| **A（选定）per-session 惰性缓存 computed（`Map<sid, ComputedRef<boolean>>` 懒创建）** | **高**：`isGenerating(sid)` 只依赖本 session 的分区 ref，SSOT 仍是消息数组，零 drift；惰性——没被问到的 session 不算 | **中**：删 `streamingSessionIds` + 新增 lazily 创建的 computed Map + `isGenerating` 改查单 sid；缓存 Map 需 cleanup | **低**：computed 定义即 `messages.value.get(sid)` 上的派生，逻辑等价于原「是否含 streaming assistant」判定 |
| B 显式计数器（`streamingCount[sid]`，写入点加减） | **低**：计数器与消息数组是**两份状态**，任何一次漏加减即 drift；F8 已盘点 status 写入点仅 3+1 处，但「盘点通过」≠「永不再增」，未来新写入点忘同步就是隐蔽 bug | **低**：一个 `Map<string, number>` + 3 处 ++/-- | **高**：drift 风险正是 G5 要排除的；且 `finalizeMessages` 的「map 全消息翻终态」语义下，计数器要精确算出「翻了几个 streaming」极易错 |
| C 维持全局 computed | **低**：R2 原样保留，每 token 全 Map 重扫 O(Σ消息)，长 session 下正是卡顿放大器 | **零**：不改 | **高**：本层最大收益项放弃 |

**推荐 A。被否方案「若用了它会怎样」**：
- 若用 B：短期能少一次全 Map 重扫，但引入「counter 与数组谁说了算」的第二权威；`finalizeMessages` 里 `prev.map()` 翻终态时，计数器要同步遍历匹配，错一处在长对话里表现为「停止按钮卡住」或「按钮提前可用」，且极难用单测覆盖。这正是父文档 G5「不引入与消息数组重复的漂移风险状态」的明确反面。
- 若用 C：等于 D-3 不做，R2 的 O(Σ消息) 重扫继续在 200+ 消息 session 里每 token 跑一遍——G1 不达标。

#### 3.2.3 D-2 token coalescing

| 方案 | 长期架构合理性 | 短期实现成本 | 风险 |
|---|---|---|---|
| **A（选定）useChat 层 microtask 批量（同类型保序，终态即时 flush）** | **高**：store 保持「纯状态 + 动作」不担调度职责；coalescing 是「入站编排」问题，归 useChat（订阅编排层）最合适 | **中**：在 `ensureStreamSubscription` 回调加缓冲 Map + microtask flush；需处理「非 delta 先 flush」边界 | **低**：合帧逻辑集中一处，测试面只需加「coalescer」单测，不碰 store 测试 |
| B store 层批量（`commitMessages` 内缓冲） | **低**：store 从「无状态转换器」变成「含调度器」，职责越界；且 store 的所有 commit 入口（含 hydrate 等低频写）都要过缓冲，语义混乱 | **中**：改 store 多处 | **高**：测试面需适配「同步 commit 变异步 flush」，5 个测试文件 + 13 个消费方的「写入即读取」假设全部破坏 |
| C 仅渲染层节流（rAF） | **低**：渲染层合并**不减少** store 的 commit 次数与失效扇出——R1/R2 仍在每 token 触发，只是把「重渲染」拖到下一帧；根因 1 未动 | **低**：渲染层加 rAF 节流 | **中**：治标不治本，且与 02 的渲染改动叠加会引入「谁在节流」的重复调度 |

**推荐 A。被否方案「若用了它会怎样」**：
- 若用 B：测试面全面适配「提交异步化」——现有单测大量假设 `commitMessages` 同步生效后立即读 `messages.value`，改成异步后这些断言全挂，且会掩盖真实的「写入到底有没有生效」问题。父文档 D-2 已明确「store 层批量（测试面需适配）」为被否理由。
- 若用 C：渲染层省了 markdown 重渲染的次数（那是 02 的事），但 store 侧每个 token 的 `new Map` + 全量失效扇出原样保留，R1/R2 未收敛——「不够」（父文档 D-2 被否理由原文）。

### 3.3 关键决策与权衡（接口先行）

#### 3.3.1 接口签名草案（本层的核心交付）

> 下述签名是**草案**，供实施期直接落地；凡标注 `[待验证]` 的阈值是诚实标注的待查项，不编造结论。

**（1）`commitMessages` 新签名（`mutations.ts`）**：

```ts
// 现状（旧）
export function commitMessages(messages: MessagesRef, sessionId: string, next: Message[]): void

// 目标（新）——MessagesRef 结构类型升级
export type MessagesRef = { value: Map<string, ShallowRef<Message[]>> }

export function commitMessages(
  messages: MessagesRef,
  sessionId: string,
  next: Message[],
): void {
  const existing = messages.value.get(sessionId)
  if (existing) {
    // 已存在 sid：仅替换该 sid 的分区 ref，外层 Map 引用不变（恒等稳定）
    existing.value = next
  } else {
    // 首次建 key（含虚拟 session 动态 id）：替换外层 Map（增删 session 的唯一触发点）
    messages.value = new Map(messages.value).set(sessionId, shallowRef(next))
  }
}
```

**关键点**：
- 外层 Map **只在增删 session 时替换**（`else` 分支）；同 sid 更新走 `existing.value = next`，Map 身份不变。
- 读侧 `messages.value.get(sid)` 返回的是 `ShallowRef<Message[]>`，需 `.value` 取数组。**这就是 5 个测试文件 + `lru.ts` + `streaming-state-machine.ts` 要适配的核心**。
- 选 `ShallowRef<Message[]>` 而非 `ref<Message[]>`：数组内的 Message 对象依然不深代理（对齐 ADR-0039——浅到「外层 Map + 每 sid 数组」两层，Message 对象本身不代理）。用 `ref` 会深代理整条数组（数千 Message 深嵌套），违反 ADR-0039。

**（2）`deleteMessages` 新签名（`mutations.ts:40-44`）**：语义不变，类型升级到 `Map<string, ShallowRef<Message[]>>`，用 `delete` 替换外层 Map（这是「减 session」触发 Map 替换的合法情形）。

**（3）`getMessages` 签名不变（`store.ts:206-208`）**：

```ts
function getMessages(sessionId: string): Message[] {
  return messages.value.get(sessionId)?.value ?? []
}
```

返回类型仍是 `Message[]`，13 个消费方**零改动**（F9）。这是 D-1 最重要的兼容保证。

**（4）`isGenerating` 新签名（替代 `streamingSessionIds`）**：

```ts
// 删除 store.ts:178-189 的 streamingSessionIds
// 目标：惰性缓存的 per-session computed Map
const sessionStreamingFlags = new Map<string, ComputedRef<boolean>>()

function isGenerating(sessionId: string): boolean {
  let flag = sessionStreamingFlags.get(sessionId)
  if (!flag) {
    flag = computed(() => {
      const arr = messages.value.get(sessionId)?.value ?? []
      // 与旧 streamingSessionIds 的判定逐字等价（store.ts:182 的 B1 语义）：
      // 仅 assistant + status==='streaming'，不扫 bash（role:'system'）
      return arr.some((m) => m.role === 'assistant' && m.status === 'streaming')
    })
    sessionStreamingFlags.set(sessionId, flag)
  }
  return flag.value
}
```

- 依赖链从「整个 `messages.value`」收敛到「`messages.value.get(sid).value` 这个 ref」——A 更新只让 A 的 flag 失效，B 的 flag 不碰。
- **惰性**：没人问过的 session 不建 computed、不算。
- **cleanup**：`sessionStreamingFlags` 需在 `disposeSession(sid)` 时 `delete`（见 §3.3.3 生命周期），否则 LRU 驱逐后残留、Map 泄漏。

**（5）LRU 适配（`lru.ts`）**：`LruEvictDeps.messagesValue` 的类型从 `() => Map<string, unknown>` 改为读取**每个 sid 的 `.value`** 或改为 `() => Map<string, unknown>` 内的 `unknown` 为 `ShallowRef`。`makeLruEvictDeps`（`lru.ts:192-210`）里 `messagesValue: () => messages.value` 与 `deleteMessageKey`（调 `deleteMessages`）的适配是**机械**的：`evictIfNeeded` 里 `for (const sid of deps.messagesValue().keys())` 只遍历 key，不读 `.value`，所以遍历逻辑不变；仅「有该 key」的判定与删除路径受影响（`messages.value.has(sid)` 语义不变）。`isVirtualKey`/`isVirtualKeyOf` 不受影响。

**（6）`collectFinalizeCandidates` 不受影响（`streaming-state-machine.ts:101-109`）**：它 `new Set(messages.value.keys())` 只遍历 key，D-1 后 key 集合语义不变。

**（7）D-2 coalescer 接口（core `useChat.ts`）**：

```ts
// ensureStreamSubscription 回调内，替换 chat.applyMessageEvent(sid, msg) 的直推
interface DeltaBuffer {
  sid: string
  texts: string[]        // 同类型合并的 delta 片段（text 或 thinking）
  type: 'message.text_delta' | 'message.thinking_delta'
}

function createCoalescer(chat: ChatStoreInstance) {
  const pending = new Map<string, DeltaBuffer>()   // key = `${sid}:${type}`
  let scheduled = false

  function flush(sid?: string): void {
    for (const [key, buf] of pending) {
      if (sid !== undefined && buf.sid !== sid) continue  // 只 flush 目标 sid（终态消息场景）
      // 把 texts 合并成一次 commit（沿用 registry 的 content 拼接语义：content + texts.join('')）
      chat.applyMessageEvent(buf.sid, { type: buf.type, payload: { delta: buf.texts.join('') } })
      pending.delete(key)
    }
  }

  return {
    enqueue(msg: ServerMessage, sid: string): void {
      if (msg.type === 'message.text_delta' || msg.type === 'message.thinking_delta') {
        const key = `${sid}:${msg.type}`
        const buf = pending.get(key)
        if (buf) buf.texts.push(msg.payload.delta)
        else pending.set(key, { sid, type: msg.type, texts: [msg.payload.delta] })
        if (!scheduled) {
          scheduled = true
          queueMicrotask(() => { scheduled = false; flush() })
        }
      } else {
        // 任何非 delta（complete/error/toolCall 等）：先 flush 再处理，保序 + 终态即时
        flush(sid)
        chat.applyMessageEvent(sid, msg)
      }
    },
    flushAll() { flush() },   // 供 disposeSession / 会话收口前兜底
  }
}
```

> **保序语义**（D-2 核心）：delta 缓冲与「非 delta 消息」的关系是「先 flush（把前面所有 delta 落盘）再处理非 delta」，保证 complete/error 到达时，前面所有 delta 已一次性提交——渲染看到的中间态是「整段合并后的文本」，终态消息**绝不迟到**。同 sid 不同 type 的 delta（text 与 thinking）分 key 缓存，互不合并。

**[待验证] 合并窗口上限**：`queueMicrotask` 的合并窗口是「当前同步任务到 microtask checkpoint」，在高频 token（真实 pi 假设 80/s）下一个 microtask 能合并的数量取决于 WS 事件是否在一个任务里连续派发。父文档 §5 已把「真实 pi token 到达率」标为待查点——**若实测一个 microtask 合并窗口太窄（几乎每次只凑到 1 条），需在 flush 里加一个小的 rAF/协程级延迟上限**（如「microtask 立刻 flush 与下一帧之间择一」）。这是唯一一处需实施期验证的阈值，不影响方案选择（D-2 收益上界受影响，下限不变）。

#### 3.3.2 数据模型：`Map<string, ShallowRef<Message[]>>` 结构与生命周期

**结构**：

```
messages.value : Map<string, ShallowRef<Message[]>>
   ├─ sid="real-123"  → ShallowRef([userMsg, assistantMsg(streaming), ...])   ← 每 token 只换这个 ref 的 .value
   ├─ sid="real-456"  → ShallowRef([...])                                       ← A 更新时这个 ref 不动、Map 不动
   ├─ sid="subagent:real-123:xyz" → ShallowRef([...])                          ← 虚拟 id，动态建 key
   └─ sid="agentcall:xyz"          → ShallowRef([...])
```

**不变式（实施期守卫，探针见 §3.4）**：
1. 外层 Map 引用只在「增删 `sid` key」时替换；`sid` 已存在时，commit 只替换 `existing.value`。
2. 每个 `sid` 的分区 ref 一旦创建（首次 commit），其引用在「该 session 存活期间」稳定——下游 `getMessages(sid)` 拿到的是 `ref.value` 快照数组，数组引用只在 commit 时替换。
3. `isGenerating(sid)` 的惰性 computed 依赖 `messages.value.get(sid).value`，不依赖外层 Map 身份。

**生命周期**：
- **创建**：首次 `commitMessages(messages, sid, next)` 在 Map 无 `sid` 时 `new Map(...).set(sid, shallowRef(next))`（唯一建 key 点）。虚拟 session（`subagent:*`/`agentcall:*`）同样走这里，天然支持动态 string key（父文档「虚拟分区约束」满足）。
- **替换**：同 sid 后续 commit → `existing.value = next`。
- **删除**：`deleteMessages`（减 key）→ 替换外层 Map；`disposeSession`（`store.ts:529-568`）经 `mapRefs` 循环里的 `messages`（现为 `Map<string, ShallowRef>`，`next.delete(sessionId)` 后赋新 Map）删 key + **同时**删 `sessionStreamingFlags` 对应的惰性 computed 条目（新增，见下）。
- **LRU 驱逐**：`evictIfNeeded`/`evictSessionWithVirtual`（`lru.ts:112-171`）经 `deleteMessageKey`（`deleteMessages`）删 key + 同步删虚拟 key；`sessionStreamingFlags` 条目也需删（与 `disposeSession` 同点）。

> **必须新增的 cleanup 契约**：`sessionStreamingFlags` Map 与 `messages` Map 同生共死——`disposeSession` 和 LRU 驱逐路径都要 `sessionStreamingFlags.delete(sid)`（及虚拟 key）。这是 D-3 引入的唯一新增生命周期状态，实施期易漏，§3.4 探针覆盖。

#### 3.3.3 错误规格（flush 边界、sealed 交互、虚拟 key 失败恢复）

**（1）flush 边界（D-2 与终态的收敛）**：
- **规则**：任何非 `text_delta`/`thinking_delta` 的 `message.*` 消息，处理前必须先 flush 同 sid 的待刷缓冲（保序）。
- **覆盖的消息**：`message.complete`、`message.error`、`message.tool_call_*`、`message.bashResult`、`message.thinking_start/end`（thinking 结束也要 flush 前面的 thinking_delta）。
- **flush 失败（异常）**：`flush()` 内部 apply 若抛错，用 try/catch 逐 key 隔离，保证「一个 sid 失败不阻塞其他 sid 的 flush」；调度位 `scheduled` 无论如何复位。错误按 `useChat` 既有约定 `console.warn` 不 throw（对齐 `loadMoreHistory` 的 best-effort 策略）。

**（2）D-010 sealed 与 coalescing 的交互**：
- `text_delta` handler 开头的 `isLastAssistantStreaming` 守卫（`registry.ts:251`）是「finalize 后丢弃 delta」的唯一防线。coalescing 把 N 个 delta 合成一次 `text_delta{delta: joined}` 后，这条合成 delta 仍走同一个 handler、仍受同一个 sealed 守卫保护——**sealed 语义不变**。
- 时序保证：`message.complete`（非 delta）→ 先 `flush(sid)` 把前面 delta 合成提交 → 再 apply complete → `finalizeSession` 翻终态。所以「complete 之前的所有 delta」在 sealed 判定前已落地，不会出现「delta 被吞、complete 先翻终态」的错序。

**（3）虚拟 session 动态建 key 的失败场景与恢复**：
- **场景**：`applySubagentStreamDelta(virtualId, lines)` 对一个陌生 `virtualId` 写 → `commitMessages` 走 `else` 分支建 key（替换外层 Map）。这一步是**稀疏的**——只有 subagent 首 token 到达、或 workflow 首次写 `agentcall:*` 时发生，不影响其他 session。
- **失败模式**：若 `virtualId` 永不复用（如 subagent 一次性），其 `ShallowRef` 与惰性 computed 条目会常驻 → 需 LRU/`disposeSession`/workflow store 的既有清理路径（`evictVirtualKey`，`store.ts:221`；`isVirtualKeyOf` 前缀同步驱逐，`lru.ts:141-146`）一并回收。这是**已有机制**，D-1 不改其语义，只需确认 `sessionStreamingFlags` 也随 `deleteMessageKey` 清（§3.3.2）。
- **恢复指引**：若观察到 subagent 面板消息残留（key 未清），排查 `evictVirtualKey`/`disposeSession` 是否都删了 `sessionStreamingFlags`；这是 D-3 新增状态最可能的漏点。

---

### 3.4 探针清单（运行时行为断言 + 验证手段）

> 每个「行为断言」都配一个探针；`✅`＝设计阶段已从代码推得并可静态确认，`⛔`＝实施期门槛（必须用 devtools 或单测 spy 实测，未过不得进下一批）。

| # | 探针 | 断言内容 | 验证手段 | 状态 |
|---|---|---|---|---|
| P1 | 同 sid commit 后外层 Map 恒等 | `commitMessages(messages, sid, next)` 后 `messages.value` 的引用不变（仅 `get(sid).value` 变） | 单测：`expect(store.messages).toBe(prevMapRef)` | ⛔ M1 |
| P2 | 首建 key 才替换 Map | 对陌生 sid commit → 外层 Map 引用变化 + 新增 key；已有 sid 不变化 | 单测 spy 外层 `.value` setter | ⛔ M1 |
| P3 | `isGenerating` 只依赖本 session ref | A 流式时 `isGenerating(B)` 的重算次数 = 0（B 的分区 ref 未动） | 单测用 `effect`+计数，或 devtools ref 依赖图 | ⛔ M1 |
| P4 | `streamingSessionIds` 已删除，无全局重扫 | grep 确认 `streamingSessionIds` 定义与引用归零 | 静态 grep | ✅ 设计期 |
| P5 | watcher 失效频率=单 session 变更 | `useFileChangeInvalidation` 在「B 流式、A 静止」时 watcher 回调不触发 | devtools Performance 或单测 spy `onInvalidate` | ⛔ M3 |
| P6 | coalescing 后 commit 次数=mu 秒级批量 | 连续 N 条 delta → `commitMessages` 调用次数 << N | 单测 spy `commitMessages` 计数 | ⛔ M2 |
| P7 | 终态即时（不依赖 microtask） | `message.complete` 到达时，前面 delta 已 flush + complete 已 apply | 单测按序断言 `getMessages` 终态 status | ⛔ M2 |
| P8 | sealed 幂等不因 coalescing 破坏 | finalize 后迟到 delta（含合成的）被丢弃，消息不串改 | 单测复现 D-010 场景 | ⛔ M2 |
| P9 | 虚拟 key 动态建 + 清理 | `applySubagentStreamDelta` 首写建 key；`evictVirtualKey` 后 `sessionStreamingFlags` 同步清 | 单测 + 内存断言 | ⛔ M4 |
| P10 | getMessages 13 消费方零改动 | `getMessages` 返回 `Message[]` 签名不变，13 处调用点编译通过 | 全仓 typecheck | ✅ 设计期 |

---

## §4 验收（真实场景）

**本节的结论：三个验收场景都是「真实 dev 环境 + 真实 session」而非单测/mock；每场都回溯 G1 或 G5。单测只作探针（§3.4），不作验收。**

> 验证环境：`pnpm dev` 启动的真实 Electron 应用（renderer 9222 / runtime 3310），真实 pi 会话；若无真实模型则用 mock 流标注缺口（父文档 §4 同款说明）。

| 场景 | 步骤 | 通过标准 | 回溯 |
|---|---|---|---|
| **V1-01 长 session 流式（失效收敛）** | ① 在一条 200+ 消息的 session 里让 AI 生成一段带代码块的回复；② 流式期间用 devtools Performance 录 token 密集段；③ 在另一 panel 打开第二个 session（静止）；④ 观察 devtools 里 store 提交链 | 流式期间每个 token 的 commit 只触发「目标 sid」的 computed 重算；第二个 session 的 `isGenerating`/渲染/watch 不随第一个 session 的 token 重算（devtools ref 依赖图或 Performance 火焰图确认无来源第二个 session 的长任务） | G1 |
| **V1-02 双 session 并行互不干扰** | ① 两个 panel 各开一个 session，同时各自发消息触发流式；② 交替观察两个 panel 的流式进度；③ 在 A 流式时切走 B，再切回 B | 两个 session 的消息互不串分区；A 的 token 不动 B 的消息；切走再切回 B，B 历史与流式进度完整（无 LRU 误驱逐） | G1、G5 |
| **V1-03 切 session 后迟到消息不串分区** | ① A 流式中途，快速切到 B；② 观察 A 的收尾 delta 是否误写进 B | 迟到的 A delta 只写 A 分区（若 A 已 finalize 则被 sealed 丢弃），B 分区无任何 A 的 token | G5（结构性竞态消除，ADR-0049 同款） |

**验证缺口**：V1-01 若真实模型不可用，mock 流（70ms/chunk）可验证「失效收敛」结构但无法覆盖真实 token 速率下的「coalescing 合并窗口上限」（§3.3.1 [待验证]）——实施时优先争取真实 pi 会话；V1-03 依赖真实流式收尾时序，可用「人为延迟 finalize」的临时探针辅助，不编造通过。

---

## §5 下一层拆分

**本节的结论：下一层是「实现计划」——按 §3.3.1 接口落地，文件改动地图已明确到每个文件，5 个测试文件各有适配策略，实施顺序 M1→M2→M3→M4，每步结束跑对应探针。**

### 5.1 实施路径（依赖序）

```
M1 容器骨架（D-1）──┬→ mutations.ts 新签名 + store.ts 声明/getMessages/isGenerating 惰性化
                    ├→ 删 streamingSessionIds（D-3 与 D-1 合并，父文档 §3.4）
                    └→ lru.ts messagesValue 适配
M2 合帧（D-2）──────  core useChat coalescer + registry delta handler 不变
M3 watcher 收敛验证 ──  确认 useFileChangeInvalidation / useSearch 失效频率下降（不改逻辑）
M4 清理/测试收口 ────  disposeSession/LRU 增补 sessionStreamingFlags 清理 + 5 测试适配
```

依赖：M2 依赖 M1（coalescer flush 后走新 `commitMessages`）；M3 是 M1/M2 的验证；M4 可与 M2 并行（清理归属是 D-3 的一部分）。

### 5.2 拆分单元清单 + justification

| 单元 | 内容 | 文件改动地图 | justification |
|---|---|---|---|
| **U1 容器骨架（D-1）** | `MessagesRef` 升级 + `commitMessages`/`deleteMessages` 新实现 + `store.ts` 声明 + `getMessages` 加 `.value` | `mutations.ts`（23-29、40-44、`MessagesRef` 类型）；`store.ts`（83 声明、206-208） | F1（证伪拷贝）后 D-1 收益=失效收敛，必须先把失效粒度切开；接口 `getMessages` 不变保 13 消费方零改（F9） |
| **U2 惰性派生（D-3）** | 删 `streamingSessionIds` + 新增 `sessionStreamingFlags` Map + `isGenerating` 惰性化 | `store.ts`（178-189 删、196-198 改、570-625 返回对象不变） | R2 全 Map 重扫是长期卡顿放大器；SSOT 仍是消息数组，零 drift（父文档 G5） |
| **U3 LRU 适配（D-1 伴生）** | `messagesValue` 类型 + `deleteMessageKey` 不变语义 | `lru.ts`（89、200-210） | 整 Map 直接消费者之一（F9），改类型不改遍历语义 |
| **U4 coalescer（D-2）** | `ensureStreamSubscription` 回调加缓冲 + microtask flush + 非 delta 先 flush | `core/useChat.ts`（177-192 回调内）；`registry.ts` 不改 | 真实 handler 位置已确认在 core（§2.3.4）；store 不担调度职责（D-2 被否方案 B 的教训） |
| **U5 测试适配** | 5 文件「直接断言 `messages.value`」改为「经 getMessages / `.value`」 | 见 §5.3 | F9；测试是「接口变化的消费方」，不随代码正确性自动对 |
| **U6 清理收口** | `disposeSession`/LRU 驱逐增补 `sessionStreamingFlags.delete` | `store.ts`（529-568）、`lru.ts`（131-147） | D-3 新增惰性 computed 的唯一生命周期状态，漏删即慢泄漏 |

### 5.3 5 个测试文件的适配策略

父文档 F9 列出 5 个直接断言 `messages.value` 的测试文件，逐一给策略（按「断言了什么」分类）：

1. **`core/src/domain/chat/__tests__/streaming-state-machine.test.ts`**：断言 `finalizeMessages`/`applySubagentStreamDelta` 后 `messages.value` 内容。策略：断言改经 `getMessages(sid)`（等价、不依赖内部 `.value` 结构），或把 `messages.value.get(sid)` 改为 `messages.value.get(sid).value`。优先前者（更黑盒）。
2. **`lru.test.ts`**：断言驱逐后 Map key 变化。策略：`messagesValue()` 类型的 mock 从 `Map<string, Message[]>` 改为 `Map<string, {value: Message[]}>`（浅对象即可，不必真 shallowRef），驱动逻辑不变。
3. **`effects.test.ts`**：断言 `text_delta` 后最后一条 assistant content 拼接。策略：读侧改 `.value`；若有「同步 commit 后立即断言」的用例，注意 coalescer 只影响 useChat 层，直接调 `applyMessageEvent` 的用例不受 D-2 影响（合帧在更上层）。
4. **`changeset.test.ts`**：断言 `applyFileChanges` 后消息的 fileChanges。策略：读侧改 `.value`；`commitMessages` 调用若被 spy，需适配新签名（`messages, sid, next` 三元不变，只内部实现变）。
5. **`renderer/src/__tests__/stores/chat-chunk-content-blocks.test.ts`**：断言 contentBlocks 顺序。策略：读侧改 `.value`；此用例直接驱动 store，不涉及 coalescer。

> 通用原则：**读侧一律改 `getMessages(sid)` 或 `.value`，写侧（`commitMessages` spy）签名三元不变**。凡能改经 `getMessages` 的更黑盒，优先黑盒——减少测试对内部 `.value` 结构的耦合，未来再改实现测试不连坐。

### 5.4 待验证检查点（设计阶段诚实标注，不编造结论）

1. **真实 pi token 到达率**（父文档 §5 检查点 1）：决定 D-2 的 `queueMicrotask` 合并窗口是否够宽，若不够需加 rAF 级上限（§3.3.1 [待验证]）。影响 D-2 收益上界，不影响方案选择。
2. **V1-01/V1-03 的真实模型可用性**（父文档 §5 检查点 3）：mock 只能验证结构，不能验证真实速率与迟到时机。
3. **`sessionStreamingFlags` 是否与 `messages` 同生共死**：唯一新增生命周期状态（§3.3.2），探针 P9 覆盖，实施期重点回归。

---

## 附录：与父文档术语/事实/决策的一致性对照

- **事实复用**：F1（拷贝证伪 → D-1 收益=失效扇出收敛）、F8（status 写入点 3+1 处）、F9（整 Map 消费者 3 处/watch 2 处/getMessages 13 处/测试 5 文件）、F12（ADR-0039/0049 兼容）、F13（token 速率区间）均直接引用，未改结论。
- **决策对齐**：D-1 选定 `Map<sid, ShallowRef<Message[]>>`（Map 恒等稳定 + 每 session 独立 ref）；D-3 选定 per-session 惰性 computed，否决显式计数器/维持全局；D-2 选定 useChat 层 microtask 批量，否决 store 层/仅渲染层——三处均与父文档 §3.2 一致，被否方案均写明「若用了它会怎样」。
- **目标回溯**：本层只接 G1/G5（父文档已定 D-1/D-2/D-3 → G1/G5），§1.3 表格 + §4 验收场景均回溯。

---

## 附录：变更历史

- 2026-08-15：初版。基于父文档 00 + 8 个必读文件真实代码片段实读成文；D-2 落点经确认在 core `useChat.ts` 的 `ensureStreamSubscription`；5 测试适配策略按断言性质分类给出。
