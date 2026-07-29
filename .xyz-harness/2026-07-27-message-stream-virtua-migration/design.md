# message-stream 虚拟滚动迁移设计：手写协调循环 → virtua/vue

> **文档性质**：设计文档（spec/plan 前置）。本文不写实现代码（除接口签名级别 TypeScript 片段用于 API 映射）。
> **方向**：方向 A（接入 virtua/vue 库）。已由用户拍板，本文不回头比较 A vs B vs C。
> **基调**：彻底退出"自己维护滚动协调循环"的游戏——把动态测量、视口锚定、`overflow-anchor`、`$fixScrollJump` 全部下放给 virtua，应用层只保留**领域语义**（stick-to-bottom 状态机、streaming pin、rail jump、瞬时块定位）。

---

## 1. 现状摘要：为什么必须迁移

### 1.1 核心矛盾：两个 `scrollTop` 写入者并存

当前 message-stream 的滚动位置由两套**互不感知**的机制争夺：

| 机制 | 文件 | 干的事 |
|------|------|--------|
| **A. delta 补偿** | `useVirtualTurnList.ts:287-318`（计算 `scrollAdjustDelta`）+ `MessageStream.vue:407-421`（watch flush:'post' 施加 `scrollTop += delta`） | 上方 turn 从估算→实测时，把 `scrollTop` 往下推 `measured − estimated`，防视口跳 |
| **B. RO scrollToBottom** | `useChatScroll.ts:106-131`（ResizeObserver 观察 contentEl）+ `:218-255`（`scrollToBottom` → `el.scrollTo({ top: scrollHeight })`） | 内容增高时，贴底态下直接滚到绝对底部 |

两套机制都写 `scrollTop`/调用 `scrollTo`，且都依赖 `stickToBottom` 做分派器（`MessageStream.vue:412-413` 的 `[fix-scroll-jump]` 注释明确承认旧 guard 在**负 delta**——trace 收起——场景与 scrollToBottom 冲突致跳变）。`stickToBottom` 是个**布尔**，承载不了「正在补偿」「正在 settling」「正在 follow 到底」等并发状态，guard 越打越脆。

业界共识（react-virtuoso / TanStack Virtual / message-list 一致原则）：**`scrollTop` 必须单一 owner**。两个 owner 并存是公认反模式——手写 `scrollAdjustDelta` + `stickToBottom` guard 补偿这条路已走入死胡同。

### 1.2 已知 11 个症状点

handoff 的 P1–P9 之外，仓库内还有两个 handoff 遗漏的 `scrollTop` 写入点：

- `useMessageStreamRail.ts:116-124` `onJump(idx)` **直接写 `scrollEl.scrollTop`**，绕过所有 guard
- `MessageStream.vue:77-141` 的瞬时块（compacting / handoff / forkNotices）显隐 watch 触发 `scrollToBottom`，是第 5 个 scrollToBottom 触发源（其余 4 个见 `useMessageStreamScroll.ts`）

加在一起，`scrollTop` 共有 **5 类写入源**（delta watch / RO scrollToBottom / rail onJump / 瞬时块 watch / 程序性 force 滚动），分散在 4 个文件。

### 1.3 其他结构性债务

- `overflow-anchor` 全局 grep 零命中（已确认）——浏览器原生 anchoring 与 JS 补偿**二次叠加**，是潜在跳变源。virtua 在 `Virtualizer.tsx` 内联样式自动声明 `overflowAnchor: "none"`，迁移后此问题自动消失。
- `useChatScroll` 的 `stickGuardPaused` 是**布尔**而非计数器（`useChatScroll.ts:146`）——多个并发 transition（多 turn 同帧折叠）会互相 resume，是 P5 的根因。
- `useSettlingGuard` 的存在本身就是补丁味——session 切换后要靠 2-rAF 窗口抑制 delta，证明「delta 补偿」与「scrollToBottom 跟随」在切换瞬间无法和平共处。
- 末项钉扎 `[KNOWN-LIMIT]`（`useVirtualTurnList.ts:235-241`）——`endIndex` 恒为 `n-1`，底部虚拟化失效，靠它保 sticky-bottom 准确。这是手写协调的妥协，virtua 的「测量随窗口走」机制不需要。
- 三套 ResizeObserver 实例并存（`useChatScroll` contentEl RO / `useResizeReport` per-Turn RO / `useConstantHeightAssert` dev-only 常量 RO），生命周期与防死循环逻辑各写一份。

### 1.4 迁移的根本收益

不是"少写代码"，是**把一个无法用 if/else 决策解决的连续数据流融合问题**（measurement → layout → scroll compensation，三者必须同帧原子）交给专门为此建模的库。virtua 内部用状态版本号 + `$fixScrollJump`（`Virtualizer.tsx` watch `stateVersion` flush:post）把这条链路收敛成单 owner；应用层只声明"我要 stick to bottom"或"我要跳到第 N 项"。

---

## 2. virtua/vue API 调研结论

### 2.1 仓库成熟度（核实通过）

- 仓库 `inokawa/virtua`，**MIT License**，3635 stars，最近 push 2026-07-25（调研日 2026-07-27），活跃维护
- 最新版本 **0.50.0**（2026-07-25）
- Vue 绑定成熟：与 React/Solid/Svelte/Angular 同级一等公民，源码在 `src/vue/`（与 `src/react/` 等并列），非包装层
- 要求 `vue >= 3.2`，xyz-agent 当前 `vue: ^3.5`（满足）
- npm 包名 `virtua`，Vue 入口 `virtua/vue`
- xyz-agent 当前未安装 virtua；`@tanstack/vue-virtual` / `@tanstack/virtual-core` 在 node_modules 中但是**间接依赖**（无任何 package.json 直接依赖），不构成"已有替代品"

### 2.2 组件选型：三个导出

virtua/vue 导出三个组件（`src/vue/index.ts`）：

| 组件 | 渲染滚动容器？ | 适用场景 | 我们的选择 |
|------|----------------|----------|------------|
| `VList` | ✅ 自带 `overflow:auto` + `contain:strict` 的 div | drop-in 替换 `<div style="overflow:auto">` | ❌ |
| `Virtualizer` | ❌ 用 **`container.parentElement`**（或 `scrollRef` prop 指定）作滚动容器 | 嵌入既有滚动结构、自定义滚动条样式、与外层 flex 布局组合 | ✅ **选这个** |
| `WindowVirtualizer` | ❌ 用 **window** 作滚动容器 | 全页滚动 | ❌ |

**选 `Virtualizer` 的理由**：
1. `MessageStream.vue:10-14` 的 `scrollEl` 承载了自定义 `::-webkit-scrollbar` 样式（`MessageStream.vue:426-431`）、`pt-5` 顶部留白、`@scroll.passive` 事件绑定。`VList` 会接管这些，迁移摩擦大。
2. `Virtualizer` 把 `container.parentElement` 当滚动容器——现有 `scrollEl` 直接复用，`MessageStream.vue` 的外层 DOM 结构（`scrollEl` > `contentEl`）几乎不动。
3. 官方 Vue 聊天 story（`stories/vue/advanced/Chat.vue`）用的就是 `Virtualizer`，证明这是 chat/消息流的推荐用法。
4. 瞬时块（compacting/handoff/forkNotices）当前 absolute 定位在 `contentEl` 内部（`MessageStream.vue:77-141`），依赖 `totalHeight`——用 `Virtualizer` 时这些块仍可挂在 `Virtualizer` 同级/外层，不被虚拟化收编（见 §4.7）。

### 2.3 动态测量机制（关键收益点）

- **零配置**：不需要 `estimateSize` + `measureElement` 协作（TanStack Virtual 那套）。`itemSize` prop 仅是**初始 hint**，不传则从已测项自动估算。
- virtua 内部用 `createResizer`（`src/vue/Virtualizer.tsx` 调用）给每个 ListItem 挂 ResizeObserver，turn 高度变化（trace 展开/收起/streaming 追加）**自动捕获**，无需应用层 `reportHeight`。
- `ListItem.tsx` 用 `position: absolute` + `top: offset` 定位（与现有手写方案同构），offset 来自 store 的前缀和——**与现有 `useVirtualTurnList` 的 layout computed 思路一致**，但所有权交给库。
- 测量与滚动补偿的**同帧原子性**由 virtua 内部保证：`Virtualizer.tsx` watch `stateVersion`（`{ flush: "post" }`）调 `scroller.$fixScrollJump()`，这是手写方案最难做对的部分。

**直接替换**：现有 `useVirtualTurnList.ts`（363 行）+ `useResizeReport.ts`（180 行）+ `useConstantHeightAssert.ts`（106 行）三套手写机制，合并成 virtua 一个 `<Virtualizer>` 组件。

### 2.4 滚动位置保持（reverse scroll adjustment）

virtua 内置 **`shift` prop**（`Virtualizer.tsx` props 定义）：
> While true is set, scroll position will be maintained from the **end** not usual start when items are added to/removed from **start**. It's recommended to set false if you add to/remove from mid/end of the list.

**注意**：`shift` 是**反向无限滚动**（load-more-history 往顶部插入时保持视口）专用，**不是** chat 的 stick-to-bottom。chat 的 follow-to-bottom 由应用层显式调用 `scrollToIndex(lastIndex, { align: "end" })`（见 §4.2）。官方 Vue Chat.vue 正是这样做的：`shift` 只在 `isPrepend`（顶部插入）时置 true。

这对我们**完美匹配** load-more-history 场景（`useLoadMoreHistory.ts` 往头部插历史消息）——现有手写方案的 delta 补偿在头部插入时极易跳变，virtua 的 `shift` 是为此原生设计的。

### 2.5 Imperative API（`VListHandle` / `VirtualizerHandle`）

来自 `src/vue/Virtualizer.tsx` 的 `VirtualizerHandle` 定义（`VList` 通过 `VListHandle` 透传同一组方法）：

```ts
interface VirtualizerHandle {
  readonly cache: CacheSnapshot
  readonly scrollOffset: number        // 当前 scrollTop
  readonly scrollSize: number          // 当前 scrollHeight
  readonly viewportSize: number        // 当前 clientHeight
  findItemIndex(offset: number): number
  getItemOffset(index: number): number
  getItemSize(index: number): number
  scrollToIndex(index: number, opts?: ScrollToIndexOpts): void
  scrollTo(offset: number): void
  scrollBy(offset: number): void
}

interface ScrollToIndexOpts {
  align?: "start" | "center" | "end" | "nearest"  // default "start"
  smooth?: boolean
  offset?: number  // default 0
}
```

**映射到我们的场景**：
- `scrollToIndex(lastIndex, { align: "end" })` → stick-to-bottom follow（替代 RO scrollToBottom）
- `scrollToIndex(turnIdx, { align: "start" })` → rail jump（替代 `useMessageStreamRail.ts:124` 的 `scrollTop = offsetOf(...)`）
- `findItemIndex(scrollOffset)` → rail activeTurnIndex（替代 `useMessageStreamRail.ts:100-109` 的比例推算）
- `getItemOffset(idx)` → 瞬时块 absolute 定位（替代 `offsetOf`）
- `scrollSize - scrollOffset - viewportSize <= threshold` → stick-to-bottom 判定（官方 Chat.vue 用 `>= -1.5`，我们保留 `BOTTOM_THRESHOLD = 40` 的宽松阈值以容纳末项未实测误差）

### 2.6 与 Vue `<Transition>` 的兼容性

**这是迁移的最大风险点**，单独在 §6.1 详述。简版结论：

- virtua 用 ResizeObserver 监测 item 高度变化，turn 内部 trace 折叠/展开的 `<Transition :css="false">`（`Turn.vue:33`）在 height 动画过程中会被 RO 逐步上报，virtua 的 `$fixScrollJump` 会持续补偿——**比当前手写"pauseStickGuard + 200ms 后 resume"的离散模型更平滑**。
- 但 virtua 的 `position: absolute` item 在高度剧烈变化（trace 瞬间从 600px → 60px）时，仍可能触发浏览器 `scrollTop` clamp，需要应用层配合（保留 stick guard 的概念，但作用域缩小到 transition 窗口）。
- `leave-active` 期间 `position: absolute` 致 scrollHeight 塌缩的风险（业界共识第 4 条）需要审计——当前 `useStickGuard.ts:78-91` 的 `onTraceLeave` 已经用 JS hooks 控制 height 过渡，不依赖 `position: absolute`，迁移后这套 hooks **保留**。

### 2.7 License / 成熟度评估结论

| 维度 | 结论 |
|------|------|
| License | MIT ✅（无商业风险） |
| Vue 绑定成熟度 | 一等公民，源码并列 ✅ |
| 维护活跃度 | 最新版 0.50.0（2026-07-25）✅ |
| API 匹配度 | Virtualizer + scrollToIndex + shift + keepMounted 覆盖所有需求 ✅ |
| Electron/Chromium | virtua 目标现代浏览器（需 ResizeObserver），Electron Chromium 完全支持 ✅；无 iOS/Safari 顾虑 |
| 版本 | 0.50.0（尚未 1.0，但 star 数 + 维护频率表明稳定）⚠️ 锁版本，minor 升级走代码审查 |

**结论：virtua/vue 适合，方向 A 前提成立，继续。** 未发现重大缺陷。

---

## 3. 目标架构

### 3.1 拓扑

```
┌─────────────────────────────────────────────────────────────────────┐
│  MessageStream.vue（编排容器，script setup ≤300 行规范）             │
│                                                                     │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │  scrollEl (ref, overflow-y-auto, ::-webkit-scrollbar)         │  │
│  │  @scroll.passive → handleScroll                                │  │
│  │  ┌─────────────────────────────────────────────────────────┐ │  │
│  │  │  contentEl (spacer, flex-grow:1 把列表推到底)            │ │  │
│  │  │                                                         │ │  │
│  │  │  ┌───────────────────────────────────────────────────┐ │ │  │
│  │  │  │  <Virtualizer>  ← virtua/vue (单一 scrollTop owner)│ │ │  │
│  │  │  │   :data="renderItems"                              │ │ │  │
│  │  │  │   :itemSize="ESTIMATED_TURN_HEIGHT"                │ │ │  │
│  │  │  │   :shift="isPrepend"                               │ │ │  │
│  │  │  │   :keepMounted="pinnedIndexes"                     │ │ │  │
│  │  │  │   ref="vlistRef"                                   │ │ │  │
│  │  │  │   <template #default="{ item, index }">            │ │ │  │
│  │  │  │     <Turn v-if="item.kind==='turn'" .../>          │ │ │  │
│  │  │  │     <SystemNotice v-else .../>                     │ │ │  │
│  │  │  │   </template>                                      │ │ │  │
│  │  │  │  (virtua 内部: RO 测量 + absolute 定位 + fixScrollJump)│ │  │
│  │  │  └───────────────────────────────────────────────────┘ │ │  │
│  │  │                                                         │ │  │
│  │  │  瞬时块 (absolute, top 依赖 vlistRef.getItemOffset)   │ │  │
│  │  │  - compacting / handoff / dispatching / forkNotices    │ │  │
│  │  └───────────────────────────────────────────────────────┘ │  │
│  └───────────────────────────────────────────────────────────┘  │
│                                                                     │
│  <Transition name="fade">  回到底部浮层 (v-if showJumpButton)       │
│  <TurnRail ... @jump @toggle />                                    │
└─────────────────────────────────────────────────────────────────────┘

应用层 composables（只持领域语义，不动 scrollTop）：
┌──────────────────────┐  ┌──────────────────────┐  ┌──────────────────┐
│ useVirtuaFollow       │  │ useStreamingPin       │  │ useMessageStream  │
│ (stick-to-bottom      │  │ (streaming/editing    │  │ Rail (改造)       │
│  状态机)              │  │  → keepMounted[])     │  │ scrollToIndex    │
└──────────────────────┘  └──────────────────────┘  └──────────────────┘
         │                          │                        │
         └──────────┬───────────────┴────────────────────────┘
                    ▼
          vlistRef.scrollToIndex / findItemIndex / getItemOffset
```

### 3.2 数据流

```
events (WS/用户)
  → chat store (messages)
  → renderItems (computed, toRenderItems)
  → <Virtualizer :data="renderItems">          // virtua 自动测高 + 窗口化
  → virtua RO 回调 (内部)                       // 不再走应用层 reportHeight
  → virtua store.$fixScrollJump (flush:post)   // 自动补偿，单一 owner

stick-to-bottom 决策（应用层）：
  @scroll(offset) → useVirtuaFollow.evaluate(offset)
    → 若贴底 + renderItems 变化 → vlistRef.scrollToIndex(last, {align:"end"})

rail jump（应用层）：
  @jump(idx) → useMessageStreamRail.onJump
    → vlistRef.scrollToIndex(turnIdx, {align:"start"})
```

### 3.3 模块映射表（决策摘要）

| 现有模块 | 决策 | 理由 |
|----------|------|------|
| `useVirtualTurnList.ts` | **删除** | virtua 的 `createVirtualStore` + `createScroller` 替代。heights Map / layout computed / visibleRange 二分查找 / scrollAdjustDelta / streamingPinIndex 全部由库持有 |
| `useResizeReport.ts` | **删除** | virtua ListItem 内部 RO 替代 per-Turn 上报。provide/inject registry 不再需要 |
| `useConstantHeightAssert.ts` | **保留** | dev-only 常量漂移检测仍然有用（瞬时块像素常量未消失），与 virtua 无冲突 |
| `useChatScroll.ts` | **重写为 `useVirtuaFollow`** | RO scrollToBottom + scrollToBottom + stickGuardPaused 全删；保留 stickToBottom 状态机 + onWheel + onScroll 的 distance 判定，但 `scrollToBottom` 改为调 `vlistRef.scrollToIndex(lastIndex, {align:"end"})` |
| `useStickGuard.ts` | **保留 + 计数器化** | 仍需 trace transition 期间暂停 onScroll 误判，但 `pause/resume` 改成计数器（修 P5）；`useTraceTransition` JS hooks 保留（控制 transition） |
| `useSettlingGuard.ts` | **删除** | session 切换不再有 delta 与 scrollToBottom 竞争——切到新 session 直接 `scrollToIndex(lastIndex, {align:"end", smooth:false})`，无 settling 窗口 |
| `useStreamingPin.ts` | **重写** | 不再写 `pinStreaming(idx)`，改输出 `keepMounted` 索引数组给 `<Virtualizer :keepMounted>`。streaming turn 恒挂载，RO 不断，无需 startIndex 钉扎 |
| `useMessageStreamRail.ts` | **保留改造** | `onJump` 改用 `vlistRef.scrollToIndex`（替代 `:124` 直接写 scrollTop）；`updateActiveTurnIndex` 改用 `vlistRef.findItemIndex(scrollOffset)`（替代比例推算 `:100-109`）；`offsetOf` 调用改 `getItemOffset` |
| `useMessageStreamScroll.ts` | **保留改造** | 5 个滚动触发器不变，`scrollToBottom` 实现换成 follow 状态机的 `followIfStuck()` |
| `useTurnElapsed.ts` | **保留 + 批量化** | session 结束 collapse 逻辑保留；`:96-103` 的 watch 改为汇总所有 turn 在单帧内串行 collapse（见 §4.9） |
| `MessageStream.vue` | **重写 template 中段** | 移除手写 spacer / absolute visibleItems / `:407-421` delta watch / `:376-382` scrollEl watch；改用 `<Virtualizer>`。瞬时块定位改用 `getItemOffset` |
| `Turn.vue` | **保留** | 仅移除 `useResizeReport(rootEl, ...)`（`:127`）——virtua 内部测高；trace `<Transition>` JS hooks 保留 |

---

## 4. 关键设计决策

> 每个决策标注「长期方案」或「短期方案」（按全局 AGENTS.md 失败模式防护规则 2）。

### 4.1 【长期】virtua 组件选型：`Virtualizer`（非 `VList`）

- **选项**：A. `VList`（自带滚动容器） / B. `Virtualizer`（复用外层 `scrollEl`）
- **推荐**：**B. `Virtualizer`**
- **理由**：
  1. 复用 `MessageStream.vue:10-14` 的 `scrollEl`，保住自定义 `::-webkit-scrollbar`（`:426-431`）与 `pt-5` 顶部留白
  2. 官方 Vue Chat.vue 用 `Virtualizer`
  3. 瞬时块（compacting/handoff）需挂在 `Virtualizer` 外层、依赖 `getItemOffset` 定位，`VList` 的封装会挡路
- **代价**：需在 `scrollEl` 上手动声明 `overflow-anchor: none`（virtua `Virtualizer` 不像 `VList` 那样自动管外层容器样式）——见 §4.11

### 4.2 【长期】follow 状态机：virtua 内置？自建？现有 `useChatScroll` 改造？

- **选项**：
  - A. 依赖 virtua 内置 follow（不存在）
  - B. 用社区 `use-stick-to-bottom`（与 virtua 无官方集成，且 virtua 已提供 imperative API，引入是多余依赖）
  - C. **改造现有 `useChatScroll` 为 `useVirtuaFollow`**（推荐）
- **推荐**：**C**
- **理由**：
  1. virtua **不内置** follow（已确认 README/源码/stories）——官方 Chat.vue 的做法就是应用层自建状态机
  2. 现有 `useChatScroll` 的**状态判定逻辑是对的**（`onWheel` deltaY<0 → false / onScroll distance≤40 → true，见文件头不变量说明），错的只是"用 RO + scrollTo 触发滚动"这条副作用通路
  3. 改造点最小：删 RO（`:105-131`）+ 删 `scrollToBottom` 内 rAF trailing（`:218-255`），保留 stickToBottom/unreadBelow/showJumpButton/onWheel/onScroll
- **接口签名（API 映射，非实现）**：

```ts
// useVirtuaFollow.ts（重写自 useChatScroll）
export function useVirtuaFollow(opts: {
  vlistRef: Ref<VirtualizerHandle | null>
  onStickChange?: (stuck: boolean) => void  // 供 showJumpButton 派生
}): {
  stickToBottom: Ref<boolean>
  unreadBelow: Ref<boolean>
  showJumpButton: ComputedRef<boolean>
  onScroll: (offset: number) => void         // 接 virtua @scroll
  onWheel: (e: WheelEvent) => void           // 接 scrollEl @wheel
  followIfStuck: () => void                  // 触发器调：scrollToIndex(last, {align:"end"})
  followToBottom: (force?: boolean) => void  // 回到底部浮层调（force=true）
  pauseStickGuard: () => void                // 计数器化，见 §4.10
  resumeStickGuard: () => void
}
```

- **关键约束**：`followIfStuck` 在 rAF 内重读 `stickToBottom`（保留 `useChatScroll.ts:209-228` 的 INVAR-M4-2「执行时重检」语义），避免调用时贴底→用户上滑→仍被扯回。

### 4.3 【长期】streaming pin 映射：`keepMounted` 替代 `useStreamingPin`

- **选项**：
  - A. 保留 `pinStreaming` 改写 virtua 的 `range.startIndex`（virtua 不暴露 startIndex 写入）
  - B. **用 `:keepMounted="pinnedIndexes"`**（推荐）
- **推荐**：**B**
- **理由**：
  1. virtua `Virtualizer` 暴露 `keepMounted: readonly number[]` prop（`Virtualizer.tsx` props 定义 + 渲染逻辑 `:159-167`）——"List of indexes that should be always mounted, even when off screen"，正是 streaming/editing pin 的语义
  2. `useStreamingPin` 改造：不写 `pinStreaming(idx)`，改维护 `pinnedIndexes: ComputedRef<number[]>`（streaming turn idx + editing turn idx），输出给 `<Virtualizer :keepMounted>`
  3. **原生解决 RO 断开问题**：keepMounted 的项 virtua 仍挂 RO，不会因滚出视口而停止测量，从根上消除 streaming turn 高度不更新的隐患（现有 `useVirtualTurnList.ts:251-256` 的 streaming 钉扎注释描述的痛点）
- **接口签名**：

```ts
// useStreamingPin.ts（重写）
export function useStreamingPin(opts: {
  items: ComputedRef<RenderItem[]>
  sessionId: () => string
  editingTurnIdx: ComputedRef<number>  // -1 表示无
}): {
  pinnedIndexes: ComputedRef<number[]>  // 喂给 <Virtualizer :keepMounted>
}
```

### 4.4 【长期】展开/收起保位：virtua `$fixScrollJump` 替代 delta 补偿

- **用户原话视觉契约（验收基线）**：
  > 「展开后，当前页面的位置应该是从上到下计算停留的，不会滚动的，只不过当前行内容向下展开了。期望是，无论何时展开，当前展开行的上半部分在页面上是不动的，然后向下展开。」

- **现有手写方案**：`useVirtualTurnList.ts:287-318` 计算 `scrollAdjustDelta`（上方 turn 实测化时 delta = measured − estimated）→ `MessageStream.vue:407-421` watch 施加 `scrollTop += delta`。负 delta（trace 收起）与 scrollToBottom 冲突致跳变（`[fix-scroll-jump]` 补丁来源）。

- **迁移后**：**完全删除 `scrollAdjustDelta` 通路**。virtua 的 `$fixScrollJump`（`Virtualizer.tsx` watch stateVersion flush:post）在 item 高度变化时**自动**调整 scrollOffset 保持视口锚定——这正是用户视觉契约描述的"上半部分不动，向下展开"。virtua 的锚定是**连续 RO 驱动**（transition 每一帧都补偿），比手写"离散 200ms 后 resume"更贴合契约。

- **`Block.vue` / `Turn.vue` 改动**：
  - `Turn.vue:127` 移除 `useResizeReport(rootEl, ...)`——virtua 内部测高
  - `Turn.vue:33` 的 `<Transition :css="false">` + `useTraceTransition` JS hooks **保留**（见 §4.8）——height 动画过程由 RO 持续上报给 virtua，virtua 持续 fixScrollJump，视觉上就是平滑下推
  - `Block.vue` 不动（无滚动逻辑）

- **保位失效场景的兜底**：如果 virtua 在极端情况（item 同时增删 + 高度变）下锚定漂移，应用层**不应**自建补偿（重蹈覆辙），而应：① 报 issue 给 virtua 上游；② 短期在 trace leave 期间用 `pauseStickGuard` 让 follow 暂停（见 §4.10），等 transition 结束后 `followIfStuck` 重新贴底。

### 4.5 【长期】session 切换：`key` 重置 + `scrollToIndex(last)`

- **选项**：
  - A. `<Virtualizer :key="sessionId">` 强制重建（最干净）
  - B. 复用同一 Virtualizer，靠 `:data` 全换 + `scrollToIndex(lastIndex)`
- **推荐**：**A（`key` 重置）**
- **理由**：
  1. 不同 session 的 measurement cache 应彻底隔离——virtua 的 `cache` 按 index 存高度，跨 session 复用会张冠李戴（与现有 `useVirtualTurnList.ts:330-350` `resetSession` 同款理由）
  2. `:key` 重置让 Vue 销毁旧 Virtualizer 实例（`Virtualizer.tsx` 的 `onUnmounted` 调 `store/resizer/scroller.$dispose()`，干净释放），新实例从空 cache 起
  3. **settling guard 可删**（§4.6）——`key` 重置后新 Virtualizer 首帧即 `scrollToIndex(lastIndex, {align:"end"})`，无 delta 与 scrollToBottom 竞争窗口
- **代价**：session 切换瞬间有一次 Virtualizer 重挂（微秒级，比 RO 重测廉价），可接受

### 4.6 【删除】settling guard：不再需要

- **现状**：`useSettlingGuard.ts` 2-rAF 窗口抑制 delta 施加，因为切换瞬间 delta 补偿与 scrollToBottom 跟随竞争
- **迁移后**：**整模块删除**。`<Virtualizer :key="sessionId">` + 首帧 `scrollToIndex`，没有 delta 补偿通路就没有竞争。session 切换 watch 简化为：

```ts
watch(() => props.sessionId, () => {
  // Virtualizer 因 :key 变化自动重建；nextTick 后 follow 到底
  nextTick(() => followToBottom(true))
})
```

### 4.7 【长期】瞬时块（compacting/handoff/dispatching/forkNotices）：放虚拟化外

- **现状**：`MessageStream.vue:77-141` 的 4 类瞬时块 absolute 定位在 `contentEl` 内，top 依赖 `totalHeight`（+ topOffset + 占位叠加）。它们**不进 chat store messages**（transient，非持久化），不参与虚拟化渲染，靠 `useMessageStreamNotices` + `useForkNoticeStream` 编排。
- **选项**：
  - A. 塞进 `renderItems` 参与虚拟化（与 turn 同列）
  - B. **保持在外层 absolute 定位**，top 改用 `vlistRef.getItemOffset(lastIndex) + vlistRef.getItemSize(lastIndex)`
- **推荐**：**B**
- **理由**：
  1. 这些块是**瞬时的、非数据的**（isCompacting 是 store boolean，不是 message），塞进 `renderItems` 会污染 `toRenderItems` 的纯函数契约（`messageTurns.ts`）
  2. 绝对定位语义不变，只是 top 计算从 `totalHeight`（即将删除）改读 `vlistRef` 的位置查询 API
  3. `getItemOffset(lastIndex) + getItemSize(lastIndex)` = virtua 已知的"列表底部"坐标，比手写 `totalHeight` 更准（virtua 的 totalSize 在测量过程中持续更新）
- **改动**：`useMessageStreamNotices.ts` / `useForkNoticeStream.ts` 的 `totalHeight` 入参改为 `vlistBottom: ComputedRef<number>`（由 `getItemOffset(lastIndex)+getItemSize(lastIndex)` 派生）。`topOffset`（load-more 占位）改用 `startMargin` prop 喂给 virtua（见 §4.11）。

### 4.8 【长期 + 风险】Transition 处理：JS hooks 保留，但需验证

- **现状**：`Turn.vue:33` `<Transition :css="false">` + `useTraceTransition`（`useStickGuard.ts:70-111`）的 `onTraceBeforeLeave` 锁高度 / `onTraceLeave` 过渡到 0 + setTimeout(done, 200) / `onTraceEnter` 对称展开。
- **迁移后**：**JS hooks 全部保留**。逻辑不变（高度过渡 + pause/resume stickGuard），只把 `pauseStickGuard`/`resumeStickGuard` 的实现换成计数器版（§4.10）。
- **为什么保留**：virtua 不提供 transition 包装；turn 内部 trace 的折叠动画是**产品视觉**（不是技术债），不能因为迁移库就丢。
- **与 virtua 的交互**：transition 期间 height 从 600→0，virtua 的 RO 每帧上报新高度，`$fixScrollJump` 每帧补偿 scrollOffset。**预期行为**：贴底态下 trace 收起，列表底部跟随上移，视觉上"内容平滑上滑"——比当前手写离散补偿更平滑。
- **风险**（见 §6.1）：如果 virtua 的 RO 在 transition 中段采样不准（happy-dom 测不出，需 Electron 内验证），可能短暂跳变。验证方法见 §6.1。

### 4.9 【长期】streaming 结束批量收起：`useTurnElapsed` 改为单帧串行

- **现状**：`useTurnElapsed.ts:96-103` 每个 turn 各自 watch `isSessionActive` true→false 触发 `onComplete`（→ `collapse`）。session 结束瞬间所有 turn 同帧触发，N 个独立 `<Transition>` 并发，放大 clamp。
- **业界共识**（researcher 结论第 7 条）：应合并到单 rAF。
- **推荐改造**：把"完成时 collapse 所有 turn"的触发点**上提到 MessageStream 层**，集中编排在一个 rAF 内串行 collapse（一个 collapse 完再触发下一个），避免 N 个 transition 并发。
- **接口签名**（保留 `useTurnElapsed` 的计时职责，剥离 collapse 编排）：

```ts
// useTurnCollapseOrchestrator.ts（新增，或并入 useMessageStreamScroll）
export function useTurnCollapseOrchestrator(opts: {
  sessionId: () => string
  railTurns: ComputedRef<MessageTurn[]>
  isSessionActive: ComputedRef<boolean>
  collapse: (turnIdx: number) => void
}): void
// session 结束时：收集所有需 collapse 的 turn，rAF 内逐个 setTimeout(0) 串行
```

- **为什么是长期方案**：符合业界共识，根除并发 clamp 放大；不是迁移强制项，可与主迁移解耦（见 §8 wave 划分）。

### 4.10 【长期】`stickGuardPaused` 计数器化（顺手修 P5）

- **现状 bug**：`useChatScroll.ts:146` `let stickGuardPaused = false` 是布尔。多个 turn 同时 trace 折叠时，A 的 `resumeStickGuard` 可能把 B 仍在进行的 transition 窗口提前 resume，导致 B 中段的 scrollTop clamp 被 onScroll 误判为用户上滑 → stickToBottom 翻 false → 跟随断。
- **改造**：改成计数器——`pauseStickGuard()` 做 `++count`，`resumeStickGuard()` 做 `--count`，onScroll 的 guard 判定改为 `count > 0`。
- **接口**：`useVirtuaFollow`（§4.2）暴露的 `pauseStickGuard`/`resumeStickGuard` 即用此实现。
- **归属**：本迁移**必须顺手修**——迁移后 trace transition 仍调 pause/resume（§4.8），不修则 P5 复现。

### 4.11 【长期】`overflow-anchor: none` + `startMargin` 显式声明

- **现状**：`scrollEl` 无 `overflow-anchor` 声明（已确认 grep 零命中）——浏览器原生 anchoring 与 virtua 的 `$fixScrollJump` 二次叠加。
- **virtua 行为**：`Virtualizer.tsx` 给**自己的 container div** 加 `overflowAnchor: "none"`，但**不给外层 `scrollEl` 加**（`Virtualizer` 不接管外层）。
- **改造**：
  1. 在 `scrollEl` 的 class 或 style 上显式加 `overflow-anchor: none`（Tailwind 无此 utility，用 `<style scoped>` 或 inline style）
  2. load-more 占位（`LOAD_MORE_RESERVED_HEIGHT = 44`，`MessageStream.vue:254`）改用 virtua 的 `startMargin` prop（`Virtualizer.tsx` props 定义：「The offset to the scrollable parent before virtualizer in pixels. If you put an element before virtualizer, you have to set its height to this prop.」）——virtua 内部 `ACTION_START_OFFSET_CHANGE` 会把 startMargin 计入偏移，`getItemOffset` 返回的坐标已含它
- **`topOffset` 派生**：现有 `topOffset` computed（`MessageStream.vue:266-268`）语义合并进 `startMargin`，瞬时块的 top 不再加 `topOffset`（virtua 已含）。

---

## 5. 迁移映射表（逐文件，含 file:line）

| 现有文件 | 新文件 / 改动 | 动作 |
|----------|---------------|------|
| `packages/renderer/src/composables/effects/useVirtualTurnList.ts`（整文件 363 行） | — | **删除**。heights/visibleRange/offsetOf/reportHeight/scrollAdjustDelta/pinEditing/pinStreaming/resetSession/onScrollUpdate 全由 virtua 接管 |
| `packages/renderer/src/composables/effects/useResizeReport.ts`（整文件 180 行） | — | **删除**。provide/inject registry + per-Turn RO 全由 virtua ListItem 内部 RO 替代 |
| `packages/renderer/src/composables/effects/useChatScroll.ts`（整文件 269 行） | `packages/renderer/src/composables/effects/useVirtuaFollow.ts` | **重写**。保留 `stickToBottom`/`unreadBelow`/`showJumpButton`/`onWheel`（`:72-94`）/onScroll distance 判定（`:185-198`）；删除 RO scrollToBottom（`:105-131`）、`scrollToBottom` rAF trailing（`:218-255`）；新增 `followIfStuck`/`followToBottom` 调 `vlistRef.scrollToIndex(last, {align:"end"})`；`stickGuardPaused` 改计数器（`:146`） |
| `packages/renderer/src/composables/effects/useStickGuard.ts`（整文件 112 行） | 同位置 | **保留 + 计数器化**。`STICK_GUARD_KEY`/`provideStickGuard`/`useStickGuard` 不变；`useTraceTransition`（`:70-111`）JS hooks 不变；`StickGuard.pause/resume` 实现由消费侧 `useVirtuaFollow` 提供计数器版 |
| `packages/renderer/src/composables/effects/useSettlingGuard.ts`（整文件 42 行） | — | **删除**。session 切换用 `<Virtualizer :key="sessionId">` + `scrollToIndex`，无 settling 窗口 |
| `packages/renderer/src/composables/effects/useConstantHeightAssert.ts`（106 行） | 同位置 | **保留**。瞬时块像素常量漂移检测仍需要，与 virtua 无冲突 |
| `packages/renderer/src/composables/panel/useStreamingPin.ts`（78 行） | 同位置 | **重写**。删 `pinStreaming` 调用（`:32`/`:73`）；输出 `pinnedIndexes: ComputedRef<number[]>`（streaming turn idx + editing turn idx），喂给 `<Virtualizer :keepMounted>` |
| `packages/renderer/src/composables/panel/useMessageStreamRail.ts`（167 行） | 同位置 | **保留改造**。`onJump`（`:116-125`）改 `vlistRef.scrollToIndex(renderIdx, {align:"start"})`（删 `scrollEl.scrollTop = ...`）；`updateActiveTurnIndex`（`:100-109`）改 `vlistRef.findItemIndex(scrollOffset)`；`offsetOf` 调用（`:124`/`:36`）改 `vlistRef.getItemOffset(idx)`；`topOffset` 入参删除（virtua `startMargin` 接管） |
| `packages/renderer/src/composables/panel/useMessageStreamScroll.ts`（90 行） | 同位置 | **保留改造**。5 个 watch 触发器不变（`:34-89`）；`scrollToBottom` 入参类型改为 `followIfStuck: () => void`（`force=true` 的两处 → `followToBottom(true)`） |
| `packages/renderer/src/composables/panel/useTurnElapsed.ts`（109 行） | 同位置 | **保留**。计时机理不变；`onComplete` 触发的 collapse 改由 `useTurnCollapseOrchestrator`（新）集中编排，`useTurnElapsed` 只负责通知"我完成了" |
| — | `packages/renderer/src/composables/panel/useTurnCollapseOrchestrator.ts` | **新增**（可选 wave 5）。单 rAF 串行 collapse 所有 turn，替代 N 个独立 watch 并发 |
| `packages/renderer/src/components/panel/MessageStream.vue`（436 行） | 同位置 | **重写 template 中段 + script 接线**。template：删 spacer/absolute visibleItems（`:29-72`）/delta watch（script `:407-421`）/`scrollEl` watch（`:376-382`）；改 `<Virtualizer>`。瞬时块 top 改 `getItemOffset(last)+getItemSize(last)`。`overflow-anchor:none` 加到 scrollEl |
| `packages/renderer/src/components/panel/message-stream/Turn.vue`（194 行） | 同位置 | **小改**。删 `useResizeReport(rootEl, ...)`（`:127`）；`useStickGuard`/`useTraceTransition` 保留；其余不变 |
| `packages/renderer/src/components/panel/message-stream/Block.vue`（373 行） | 同位置 | **不动**。无滚动逻辑 |
| `packages/renderer/package.json` | 同位置 | **新增依赖** `virtua`（锁 `^0.50.0`，pnpm workspace） |

---

## 6. 风险与取舍

### 6.1 【高风险】Transition 与 virtua RO 的交互

- **风险描述**：`Turn.vue:33` 的 trace `<Transition :css="false">` 在 height 动画过程中（200ms）每帧改变 item 高度。virtua 的 RO 会持续上报，`$fixScrollJump` 持续补偿。理论上比手写离散补偿更平滑，但：
  - virtua 的 RO 回调时机与 transition 的 requestAnimationFrame 是否对齐，未实测
  - 多 turn 同时 collapse（§4.9 场景）时 N 个 item 同帧高度变，virtua 的批量补偿是否漂移，未实测
- **验证方法**（标注「待验证」）：
  1. 在 dev Electron 内（连 9222 端口，按 AGENTS.md「前端调试」节）跑真实 streaming session，trace 收起瞬间录屏对比"当前手写方案 vs virtua 方案"的视口稳定性
  2. 专项测试：mount 含 10 turn 的 MessageStream，触发 `isSessionActive` true→false（全量 collapse），断言 `scrollOffset` 在 transition 期间单调变化（不跳变）
- **降级策略**：若 virtua 在 transition 期间锚定漂移超过容忍值（>8px），短期保留 `pauseStickGuard` 在 transition 全程暂停 follow（不锚定、不跟随），transition 结束后 `followToBottom(true)`——这是退化为"离散模型"的短期方案，长期仍是 virtua 平滑补偿。

### 6.2 【中风险】Electron Chromium 差异

- virtua 的 RO + `scrollTo({behavior})` 在 Electron Chromium（v4x）行为应与 Chrome 一致，但有两个已知点：
  1. **ResizeObserver loop warning**：virtua ListItem 若在 RO 回调内同步触发布局变化，Chromium 会抛 "ResizeObserver loop completed with undelivered notifications" warning（不致命但污染 console）。virtua 主线已处理（用 rAF trailing），但需验证。
  2. **`contain: strict` 性能**：virtua `Virtualizer.tsx` 用 `contain: "size style"`，Electron 下长列表（>1000 turn）的 GPU 合成层表现需验证。
- **验证方法**：打包后（非 dev）跑含 500 turn 的 session，开发者工具 Performance tab 录制滚动 5 秒，看 FPS 与 warning。

### 6.3 【中风险】streaming 高频 token 更新性能

- **现状**：streaming 每 token 触发 `messages` 变 → `renderItems` 重算 → virtua `:data` 变 → virtua `watch(data.length)`（`Virtualizer.tsx`）触发 `ACTION_ITEMS_LENGTH_CHANGE`。但 token 追加是**末项内容变**而非 length 变，virtua 不会重排窗口——只 RO 上报末项高度变。
- **风险**：末项 RO 高频回调（每 token 一次）是否触发 `$fixScrollJump` 高频计算，需验证。virtua 内部有 `range` computed 的 `isSameRange` 短路（`Virtualizer.tsx`），窗口不变时跳过，预期 OK。
- **验证**：dev 内 streaming 长回复（>2000 token）期间 FPS 不掉 < 30。

### 6.4 【低风险】未覆盖边界 case

- **fork/branch 场景**：forkNotice 是瞬时块（不进 renderItems），其定位依赖 `getItemOffset(last)`。fork 后若末项 turn 立刻变化（truncateFrom 重排），瞬时块 top 可能在 1 帧内滞后——现有手写方案同样有此问题，迁移不引入新风险。
- **空态**：`renderItems.length === 0` 时 `<Virtualizer :data="[]">` 渲染空，瞬时块 top = `getItemOffset(0)`（virtua 空态返回 0）。空态欢迎语（`MessageStream.vue:17-20`）保留在 scrollEl 直接子节点（独立于 Virtualizer），不受影响。
- **load-more-history 头部插入**：用 `:shift="isPrepend"`（`isPrepend` 在插历史时 true，post 后 false，照搬官方 Chat.vue `:1-10` 模式），virtua 原生保位。

### 6.5 【策略】双轨并存？

- **结论**：**不做双轨并存**。message-stream 是单一容器组件，新旧两套虚拟滚动机制无法同时作用于同一 DOM。迁移**单 PR 切换**（wave 3，见 §8）。
- **降低单 PR 风险的手段**：
  1. wave 1–2 先删/重写无副作用的 effects 层（`useChatScroll`→`useVirtuaFollow` 单测可独立验证）
  2. wave 3 切换前，新旧 MessageStream 各保留一份 git 历史，灰度不行可单 commit revert
  3. wave 3 必须配套手工验证清单（见 §7.3）

---

## 7. 测试影响面

### 7.1 6 个现有测试文件逐个评估

| 测试文件 | 行数 | 迁移后动作 | 理由 |
|----------|------|-----------|------|
| `packages/renderer/src/__tests__/effects/use-chat-scroll.test.ts` | 589 | **重写为 `use-virtua-follow.test.ts`** | 被测对象改名+接口变（`scrollToBottom` → `followIfStuck`/`followToBottom`，`onScroll(el)` → `onScroll(offset)`）。U13–U40 的**状态机断言语义保留**（onWheel→false、distance≤40→true、showJumpButton 不变量、stickGuard 暂停），但 mock 方式从"操作 el.scrollHeight"改为"调 `vlistRef.scrollOffset` getter mock"。约 30 用例，重写工作量中等 |
| `packages/renderer/src/__tests__/effects/message-stream-scroll-guard.test.ts` | 398 | **废弃** | 整文件测的是 `scrollAdjustDelta` guard——delta 补偿通路在迁移后**删除**，AC1/AC2/AC3/AC3b/TC3/TC4/TC5（7 用例）所防护的 bug **物理消失**（virtua 单 owner，无 guard 冲突）。保留作为历史参考即可，不迁移。**反回归目标**（防流式跳变）由 §7.2 的新集成测试覆盖 |
| `packages/renderer/src/__tests__/effects/virtual-scroll-integration.test.ts` | 359 | **重写** | 场景 1（mount 不崩）/场景 3（空态）的断言保留但改测 virtua 渲染；场景 2（核心收益：DOM 节点数 << 全量）保留——但断言方式从读 `vm.visibleRange`（即将删除）改为读 virtua 内部 range（通过 `findItemIndex`/`getItemOffset` 间接）或 DOM `[data-testid^="turn-stub-"]` 计数。末项钉扎断言（`:253-254`）改为"streaming 时末项在 DOM"（靠 keepMounted） |
| `packages/renderer/src/__tests__/effects/use-message-stream-scroll.test.ts` | 199 | **保留小改** | 被测 composable（`useMessageStreamScroll`）保留，5 个触发器不变（`MS1`–`MS6`）。只改 `scrollToBottom` mock 的类型签名（`followIfStuck`/`followToBottom`）。语义断言全保留 |
| `packages/renderer/src/components/panel/message-stream/__tests__/MessageStream.wire.test.ts` | 436 | **部分保留 + 改 rail jump 断言** | TC-w4-1/2/7/8（Turn.vue 接线）、TC-w4-3b/4/6（useMessageStreamRail 事件路由）保留；**TC-w4-6 的 `scrollTop` 断言（`:348,351`）必须改**——`onJump` 不再直接写 `scrollEl.scrollTop`，而是调 `vlistRef.scrollToIndex`。改为断言 `vlistRef.scrollToIndex` 被以正确参数调用。TC-w4-9（首屏冒烟）保留，验证 `<Virtualizer>` 接线 |
| `packages/renderer/src/composables/panel/__tests__/useTurnExpansion.test.ts` | 219 | **全保留不动** | 测的是 `useTurnExpansion` store 契约（折叠态隔离），与虚拟滚动无关。迁移零影响 |

### 7.2 迁移后的测试矩阵（应用层契约必须保留）

**A. virtua 内部能力——不再测**（库已保证，测了是浪费）：
- 动态测量精度
- visibleRange 二分查找正确性
- `$fixScrollJump` 同帧原子性
- `overflow-anchor` 声明

**B. 应用层契约——必须保留**：

| 契约 | 来源 | 迁移后测试 |
|------|------|-----------|
| stickToBottom 状态机不变量（onScroll 永不翻 false） | 现 U13–U40 | `use-virtua-follow.test.ts` 全量重写 |
| 用户上滑 → showJumpButton 出现 | 现 virtual-scroll-integration 场景 1 | 保留，集成测试 |
| 流式期间不跳变（delta guard 防 AC1/AC3b） | 现 message-stream-scroll-guard | **新集成测试**：mount + streaming + 上滑，断言 scrollOffset 单调 |
| rail jump 落到目标 turn | 现 wire TC-w4-6 | 改断言 `scrollToIndex(idx, {align:"start"})` 被调 |
| streaming turn 不被卸载（pin 语义） | 现 useStreamingPin + 末项钉扎 | 新单测：`keepMounted` 含 streaming idx 时断言 DOM 有该 turn |
| 空态不崩 + 欢迎语 | 现 virtual-scroll-integration 场景 3 | 保留 |
| session 切换不串台 | 现 virtual-scroll-integration 隐含 | 新集成：切 session 后 `vlistRef.cache` 不含旧 session 高度 |

### 7.3 手工验证清单（wave 3 DoD，按 AGENTS.md「测试规范」三视角）

> 用户视角（黑盒）+ 观察者视角（形态）必须手工验，单测覆盖不了。

- [ ] **用户视觉契约**（用户原话）：展开任一 turn 的 trace，该 turn 上半部分不动，内容向下展开（不滚屏）
- [ ] streaming 期间用户上滑 → 浮层出现 → 点浮层回到底部 → 继续跟随
- [ ] session 结束时 trace 自动折叠，列表平滑上滑（不跳变、不停中间）
- [ ] 切换 session → 新 session 从底部最新内容显示（不显示旧 session 滚动位置）
- [ ] rail jump 点击 → 平滑滚到目标 turn 顶部
- [ ] load-more-history 点顶部按钮 → 历史消息从头部插入 → 当前视口位置不动（shift 生效）
- [ ] 长对话（>100 turn）滚动 FPS ≥ 30（Electron 打包版）

---

## 8. 实施阶段拆分（wave 划分）

> 原则：**每个 wave 可独立合入 main 且不破坏现有功能**。参考 `.xyz-harness/` 历史 harness 的 wave 模式（如 `fix-scroll-jump-during-streaming/changes/` 的 plan/review/retrospect 三段式）。

### Wave 0：依赖接入（无功能影响）

- **范围**：`packages/renderer/package.json` 加 `virtua: ^0.50.0`；pnpm install；新建空 `MessageStreamVirtua.vue` 占位（不接入），里面只 mount 一个 `<Virtualizer :data="[]" />` 验证导入链路通
- **DoD**：`npx vitest run` 全绿（占位文件不参与渲染）；`vue-tsc` EXIT 0；打包不报错
- **风险隔离**：占位文件不被任何路由引用，零运行时影响
- **依赖前置**：无

### Wave 1：`useVirtuaFollow` 单测先行（TDD）

- **范围**：新建 `useVirtuaFollow.ts`（基于 §4.2 接口）+ `use-virtua-follow.test.ts`。**不动 `useChatScroll.ts`**（新旧并存）
- **DoD**：
  - 单测覆盖 stickToBottom 状态机不变量（从 use-chat-scroll.test.ts U13–U40 迁移并适配新接口）
  - `followIfStuck`/`followToBottom` 用 mock 的 `vlistRef` 断言 `scrollToIndex` 调用
  - `pauseStickGuard`/`resumeStickGuard` 计数器行为单测（多 transition 并发不互相 resume）
- **风险隔离**：纯新文件，不触碰线上 composable
- **依赖前置**：Wave 0

### Wave 2：rail + streaming pin + 瞬时块定位改造（不动 MessageStream 接线）

- **范围**：
  - `useMessageStreamRail.ts`：`onJump`/`updateActiveTurnIndex`/`offsetOf` 改为接收 `vlistRef`（向后兼容：新增可选 `vlistRef` 入参，有则用 virtua API，无则走旧路径）
  - `useStreamingPin.ts`：重写输出 `pinnedIndexes`（同时保留旧 `pinStreaming` 调用路径，由 flag 切换）
  - `useMessageStreamNotices.ts` / `useForkNoticeStream.ts`：`totalHeight` 入参改为可选，新增 `vlistBottom` 可选入参
- **DoD**：现有 6 个测试全绿（向后兼容路径）；新增单测覆盖 virtua API 调用路径
- **风险隔离**：所有改动向后兼容，MessageStream.vue 仍走旧路径
- **依赖前置**：Wave 1

### Wave 3：MessageStream.vue 切换到 virtua（核心 PR）

- **范围**：
  - `MessageStream.vue` template 中段重写为 `<Virtualizer>`
  - 删除 `useVirtualTurnList`/`useResizeReport`/`useSettlingGuard` 的引用（文件本身 Wave 4 删）
  - `Turn.vue` 移除 `useResizeReport` 调用
  - 切换 `useChatScroll` → `useVirtuaFollow`
  - 切换 rail/streaming pin/notices 到 virtua API 路径
  - `<Virtualizer :key="sessionId">` + session 切换 `scrollToIndex`
  - `overflow-anchor: none` 加到 scrollEl
- **DoD**：
  - §7.3 手工验证清单全过
  - 重写后的 3 个测试文件（virtua-follow / virtual-scroll-integration / MessageStream.wire TC-w4-6）全绿
  - vue-tsc EXIT 0
  - Electron 打包版手工跑 500 turn session
- **风险隔离**：单 PR，git 历史清晰，可 revert
- **依赖前置**：Wave 0–2

### Wave 4：清理（删旧文件）

- **范围**：删除 `useVirtualTurnList.ts`/`useResizeReport.ts`/`useSettlingGuard.ts`/`useChatScroll.ts`（旧版）/`message-stream-scroll-guard.test.ts`（废弃）。移除 wave 2 的向后兼容 flag
- **DoD**：无残留引用；`grep -r useVirtualTurnList packages/renderer/src` 零命中；全测试绿
- **风险隔离**：纯删除，不改行为
- **依赖前置**：Wave 3 合入并观察 1–2 天

### Wave 5（可选，长期）：streaming 结束批量收起

- **范围**：新增 `useTurnCollapseOrchestrator.ts`（§4.9），把 `useTurnElapsed` 的 collapse 触发上提
- **DoD**：session 结束时所有 turn 在单 rAF 内串行 collapse，无并发 clamp
- **风险隔离**：与主迁移解耦，可独立合入
- **依赖前置**：Wave 3

---

## 9. 不做什么（scope 边界）

本次迁移**不触碰**：

- **`Block.vue` 内部 UI**（thinking/tool/text 渲染逻辑、merged 卡片、ChangeSetCard）——与滚动无关
- **message-stream 视觉样式**（颜色、间距、字号、动画曲线、`::-webkit-scrollbar` 样式）——保留原样，只是容器结构换
- **其他 panel 组件**（Composer / Sidebar / SideDrawer / Rail 视觉）——零影响
- **`messageTurns.ts` 的 `toRenderItems`/`renderKey`/`filterDisplayableMessages`**——纯函数，仍是 virtua `:data` 的数据源，不改
- **`useTurnExpansion` store**（折叠态 per-session 隔离）——与虚拟滚动正交，不动
- **`useLoadMoreHistory`**——`handleLoadMore` 不变，只是插入后靠 virtua `:shift` 保位而非手写补偿
- **`useMessageStreamNotices`/`useForkNoticeStream` 的状态机**（isCompacting/isHandingOff 编排）——只改定位计算（top 公式），不改状态流转
- **`useTurnElapsed` 的计时逻辑**（elapsed/formatElapsed/start-stop timer）——只剥离 collapse 触发（wave 5），计时不动
- **任何 runtime/主进程/preload 代码**——纯 renderer 改动
- **国际化文案、testid 命名**——保持向后兼容（现有 Playwright E2E 不应破坏）

**例外**：若迁移过程中发现 `Turn.vue` 的 trace `<Transition>` JS hooks 因 virtua RO 交互需要微调（如 transition 时长从 200ms 调整以匹配 RO 采样频率），允许在该文件内最小改动——但必须 §6.1 验证清单通过。

---

## 附录 A：virtua API 速查（迁移实施时参考）

```ts
import { Virtualizer, type VirtualizerHandle } from 'virtua/vue'

// template
<Virtualizer
  ref="vlistRef"
  :data="renderItems"           // 必需，turn + system 项数组
  :itemSize="200"               // 估算 hint（ESTIMATED_TURN_HEIGHT），可选
  :bufferSize="200"             // 视口外缓冲 px（默认 200，对应现有 buffer=2 turns）
  :shift="isPrepend"            // load-more-history 头部插入时 true
  :keepMounted="pinnedIndexes"  // streaming/editing turn idx，恒挂载
  :startMargin="loadMoreOffset" // load-more 占位高度（44px）
  @scroll="onVirtuaScroll"      // offset: number（scrollTop）
  @scrollEnd="onVirtuaScrollEnd"
>
  <template #default="{ item, index }">
    <Turn v-if="item.kind === 'turn'" ... />
    <SystemNotice v-else ... />
  </template>
</Virtualizer>

// script
const vlistRef = ref<VirtualizerHandle | null>(null)
vlistRef.value?.scrollToIndex(lastIndex, { align: 'end' })   // follow 到底
vlistRef.value?.scrollToIndex(turnIdx, { align: 'start' })   // rail jump
vlistRef.value?.findItemIndex(scrollOffset)                  // activeTurnIndex
vlistRef.value?.getItemOffset(lastIndex) + vlistRef.value?.getItemSize(lastIndex)  // 瞬时块 top
vlistRef.value?.scrollSize - vlistRef.value?.scrollOffset - vlistRef.value?.viewportSize  // distance-to-bottom
```

## 附录 B：决策一句话摘要

1. 组件选 `Virtualizer`（非 `VList`），复用现有 `scrollEl`
2. follow 状态机自建（改造 `useChatScroll` → `useVirtuaFollow`），virtua 不内置
3. streaming/editing pin 用 `:keepMounted` 替代 `pinStreaming`
4. 展开/收起保位靠 virtua `$fixScrollJump`，**删除 `scrollAdjustDelta` 整条通路**
5. session 切换用 `<Virtualizer :key="sessionId">`，**删除 settling guard**
6. rail jump / activeTurnIndex 用 `scrollToIndex` / `findItemIndex`
7. 瞬时块仍在外层 absolute，top 改读 `getItemOffset(last)+getItemSize(last)`
8. trace `<Transition>` JS hooks 保留，`stickGuardPaused` 改计数器
9. streaming 结束批量收起单 rAF 串行（wave 5 可选）
10. `scrollEl` 显式 `overflow-anchor: none`，load-more 占位用 `startMargin`
