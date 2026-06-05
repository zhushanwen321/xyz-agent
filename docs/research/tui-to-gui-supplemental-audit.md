# TUI→GUI 转换的配套审查：测试、架构与性能

> 审查日期：2026-06-05
> 范围：前端（renderer）测试覆盖、整体架构健康度、性能瓶颈

---

## 目录

1. [单元测试现状与规范](#一单元测试现状与规范)
2. [前端架构健康度审查](#二前端架构健康度审查)
3. [前端性能审查](#三前端性能审查)
4. [三者对 TUI→GUI 工作的影响](#四三者对-tuigui-工作的影响)
5. [行动建议汇总](#五行动建议汇总)

---

## 一、单元测试现状与规范

### 1.1 测试基础设施

| 项目 | 当前状态 |
|------|---------|
| 测试框架 | **vitest v4** + vue-test-utils |
| DOM 模拟 | **happy-dom**（轻量，无真实渲染） |
| Runtime 测试环境 | vitest + Node.js |
| 测试命令 | `npm test`（= `vitest run`）作用于 frontend 和 runtime 两个子包 |
| CI 集成 | 未发现 CI 配置（无 `.github/workflows/`） |

**现状**：
- **Runtime（sidecar）**: 57 源文件 / **49 测试文件**（85% 覆盖），测试充分
- **Frontend（renderer）**: 100+ 源文件 / **11 测试文件**（~10% 覆盖），测试严重不足

### 1.2 前端测试覆盖现状

| 模块 | 源文件数 | 测试文件数 | 覆盖率 |
|------|---------|-----------|--------|
| stores | 9 | 1（navigation.test.ts） | **~11%** |
| composables | 11 | 6 | **~55%** ✅（相对较好） |
| lib | 6 | 1 | **~17%** |
| components | 74 | 3 | **~4%** ❌ 极低 |
| **总计** | **~131** | **~11** | **~8%** ❌ |

**有测试的 composables**：
- `useChat.test.ts`（118 行）— 覆盖 sendMessage subagent 参数
- `useSlashCommands.test.ts`（129 行）— 基础测试
- `__tests__/useChat-subagent.test.ts`（118 行）
- `__tests__/useChat-subagent-boundary.test.ts`（166 行）
- `__tests__/useSlashCommands.test.ts`（129 行）
- `__tests__/useSlashCommands-boundary.test.ts`（212 行）

**完全没有测试的模块**（高优补测列表）：

| 模块 | 文件 | 风险等级 | 理由 |
|------|------|---------|------|
| Stores | chat.ts（339 行） | 🔴 最高 | 核心状态管理，TUI→GUI 新增 5 个字段 |
| Stores | session.ts | 🔴 最高 | Session CRUD，数据流入口 |
| Stores | plugin.ts（287 行） | 🟠 高 | 与 extension status bar 交互 |
| Stores | settings/, provider/ 相关 | 🟡 中 | 配置读写 |
| Lib | ws-client.ts | 🔴 最高 | 所有 WS 通信的基础设施 |
| Lib | event-bus.ts（30 行） | 🟠 高 | 全局事件分发，无报错保护 |
| Components | ChatPanel.vue（243 行） | 🟠 高 | TUI→GUI 的主要改动目标 |
| Components | ExtensionUIDialog.vue | 🟠 高 | 新增 editor 分支 |
| Components | AppStatusbar.vue | 🟡 中 | 新增数据源合并 |
| Components | ChatInput.vue（312 行） | 🟡 中 | 预填充逻辑 |
| Components | MessageBubble.vue（361 行） | 🟡 中 | 自定义消息渲染 |

### 1.3 为何不写测试

根因分析（从代码和文档推断）：

1. **无测试规范/标准** — `docs/standards.md` 中提到"自动化检查"（ESLint、行数上限）但没有一条关于测试覆盖率或测试方法论的要求
2. **无 CI 拦截** — 没有 CI pipeline 强制测试通过，写不写测试不影响合并
3. **EDA 风格的 event-bus 难测** — `event-bus.ts` 基于 string-type 事件分发，没有编译时检查 handler 签名的能力
4. **Vue 组件测试成本高** — 需要 mock Pinia store、WS client、event-bus，setup 代码量大
5. **项目早期压力** — Phase 0/1 阶段优先交付功能，测试被推迟

### 1.4 推荐的测试规范

#### P0（关键路径 — 必须有测试）

TUI→GUI 工作引入的 EventAdapter 修改、useChat handler 新增、ChatStore 字段扩展必须测试：

| 测试目标 | 类型 | 说明 |
|---------|------|------|
| EventAdapter 新增 case | 单元测试 | 每个新 case 至少 1 个输入→输出测试 |
| useChat 新增 handler | 单元测试 | handler 收到 mock 事件后 store 状态变化验证 |
| ChatStore 新增字段 | 单元测试 | get/set 行为、JSON 序列化、restore 默认值 |

**标准**：新增代码的测试覆盖率 ≥ 80%。使用 `vitest --coverage` 衡量。

#### P1（核心基础设施 — 逐步补测）

| 测试目标 | 优先级 | 说明 |
|---------|--------|------|
| ws-client.ts | 🔴 高 | 所有 WS 通信入口，mock WebSocket 验证 send/onMessage |
| event-bus.ts | 🟠 中 | 简单，测试 handler 注册/反注册/异常隔离 |
| ChatStore existing operations | 🔴 高 | 消息 CRUD、streaming 状态机、session 分区 |
| SessionStore | 🟠 中 | session 创建/删除/切换/重命名 |

#### 测试代码组织规范

```
src/composables/__tests__/           # composable 边界/集成测试
src/composables/useFoo.test.ts       # composable 核心测试（直接同目录）
src/stores/__tests__/                # store 测试
src/components/__tests__/            # 组件测试（若交互简单可同目录）
src/components/chat/__tests__/       # 复杂组件的子目录
src/lib/__tests__/                   # lib 测试
```

**建议统一规范**（当前已有两种风格混用，建议定一种）：

> **Standard**: `src/<module>/<name>.test.ts`（核心测试同目录）
> **Boundary**: `src/<module>/__tests__/<name>-boundary.test.ts`（边界/集成测试放在 __tests__）

#### 测试模板（供参考）

```typescript
// EventAdapter 测试模板
import { describe, it, expect } from 'vitest'
import { EventAdapter } from '../event-adapter'

describe('EventAdapter — extension_ui_request editor', () => {
  it('should forward editor method as extension.ui_request', () => {
    const messages: unknown[] = []
    const adapter = new EventAdapter('sid-1', (msg) => messages.push(msg))
    
    adapter.handleEvent({
      type: 'extension_ui_request',
      id: 'req-1',
      method: 'editor',
      title: 'Edit code',
      prefill: 'const x = 1',
    })
    
    expect(messages).toHaveLength(1)
    const msg = messages[0] as { type: string; payload: Record<string, unknown> }
    expect(msg.type).toBe('extension.ui_request')
    expect(msg.payload.method).toBe('editor')
    expect(msg.payload.title).toBe('Edit code')
  })
})
```

```typescript
// useChat handler 测试模板
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ref } from 'vue'

vi.mock('../../lib/ws-client', () => ({ send: vi.fn() }))
vi.mock('../../lib/event-bus', () => ({ on: vi.fn(), off: vi.fn() }))

describe('useChat — auto_retry_start handler', () => {
  // mock store, event-bus
  // trigger handler with mock event
  // verify store state change
})
```

### 1.5 对 TUI→GUI 的测试要求

| TUI→GUI 改动 | 必须测试 | 建议测试 |
|-------------|---------|---------|
| EventAdapter 15 处修改 | ✅ 每个 case 至少 1 个测试 | ✅ |
| useChat 10+ 新 handler | ✅ 核心 handler（auto_retry, queue_update, compaction） | ✅ 全部 |
| ChatStore 5 个新字段 | ✅ get/set/default/restore | ✅ |
| EditorDialog.vue | — | ✅ 渲染测试 |
| ExtensionUIDialog editor 分支 | ✅ Dialog 交互（打开/确认/取消） | — |
| ChatPanel auto_retry 渲染 | — | ✅ 条件渲染 |
| AppStatusbar extension status | — | ✅ 数据源合并 |
| WidgetDock placement | — | ✅ prop 渲染 |

---

## 二、前端架构健康度审查

### 2.1 当前架构总览

```
src-electron/renderer/src/
├── App.vue                      # 根组件，359 行（偏大）
├── design-system/               # 设计系统（Button/Input/Dialog 组件）
├── stores/                      # Pinia stores（9 文件）
│   ├── chat.ts                  # 339 行（核心，但无测试）
│   ├── session.ts               # Session 管理
│   ├── plugin.ts                # 287 行（Plugin 状态）
│   ├── panel.ts                 # 面板布局状态
│   ├── tree.ts                  # 437 行（Session Tree 数据，偏大）
│   ├── navigation.ts            # 导航
│   ├── settings.ts              # 设置
│   ├── provider.ts              # Provider 配置
│   └── window.ts                # 窗口
├── composables/                 # 可组合逻辑（11 文件）
│   ├── useChat.ts               # 310 行（核心，TUI→GUI 目标）
│   ├── useSession.ts            # Session 操作
│   ├── useConnection.ts         # WS 连接
│   ├── useExtensionUI.ts        # Extension UI 交互
│   ├── useExtensionWidget.ts    # Widget 状态
│   ├── usePlugin.ts             # Plugin 交互
│   ├── ... (5 more)
├── components/                  # 组件（74 文件，分成 12 个子目录）
│   ├── chat/                    # 13 文件（消息列表、SlashMenu、ToolRenderers）
│   ├── panel/                   # 9 文件（ChatPanel、PanelBar、SplitDivider 等）
│   ├── settings/                # 17 文件（最多，但与其他模块解耦）
│   ├── layout/                  # 4 文件（AppHeader、AppSidebar、AppFooter 等）
│   └── ... (extension, toast, panel-grid, sidebar, 等)
├── lib/                         # 基础设施（6 文件）
│   ├── ws-client.ts             # WS 通信（核心）
│   ├── event-bus.ts             # 事件总线（核心，仅 30 行）
│   └── markdown/                # Markdown 渲染
└── mock/                        # Mock 数据（725 行 data.ts，偏大）
```

### 2.2 架构健康度评分（每项 1-10）

| 维度 | 评分 | 说明 |
|------|------|------|
| 分层清晰度 | 7/10 | Stores / Composables / Components 三层分明，但边界模糊（部分 composable 直接操作 store） |
| 模块间耦合 | 6/10 | ChatPanel 强依赖 useChat + ChatStore + SessionStore，无接口抽象 |
| 可测试性 | 4/10 | event-bus 基于 string type 无法编译检查，组件高度依赖 Pinia |
| 代码复用 | 7/10 | composable 模式良好，部分逻辑（如 tool renderer registry）可复用 |
| 行数规范 | 6/10 | 多个文件 > 300 行（tree.ts 437, PanelBar 412, MessageBubble 361） |
| 文件组织 | 8/10 | 按功能模块分目录清晰，命名一致 |
| 类型安全 | 6/10 | `protocol.ts` 的类型定义和共享良好，但 event-bus 无类型安全 |
| 渐进增强能力 | 8/10 | 增量改动友好，大部分改动不需要修改多个文件 |

**总体评分：6.5/10 — 健康但需改进**

### 2.3 核心架构问题

#### 问题 1：event-bus 类型不安全（🟠 中）

```typescript
// 当前：string type，handler (...args: any[]) → 无编译检查
export function on(event: string, handler: EventHandler): () => void
export function emit(event: string, ...args: any[]): void
```

**后果**：
- emit('message.text_delta', { payload: { delta: 'hello' } }) vs emit('message.text_delta', 'hello') — 编译器不报错
- handler 参数个数不匹配时静默失败
- TUI→GUI 新增 10+ 事件类型后，风险放大

**方案 A（推荐）**：用 TypeScript 类型约束 event → payload 映射：

```typescript
// 方案 A：带映射的 typed event bus
interface EventMap {
  'message.text_delta': { sessionId: string; delta: string }
  'message.auto_retry_start': { sessionId: string; attempt: number; maxAttempts: number }
  // ... 其余事件
}
export function on<E extends keyof EventMap>(event: E, handler: (payload: EventMap[E]) => void): () => void
export function emit<E extends keyof EventMap>(event: E, payload: EventMap[E]): void
```

**方案 B（轻量）**：保留 string type，但 handler 接收统一 `ServerMessage`，减少参数传递错误：

```typescript
export function on(event: ServerMessageType, handler: (msg: ServerMessage) => void): () => void
export function emit(event: ServerMessageType, msg: ServerMessage): void
```

> **推荐方案 B** — 现有代码中已有 `on(evt, handler)` 且 handler 签名是 `(msg: ServerMessage) => void`（`useChat.ts` 的 `createGlobalHandlers` 中所有 handler 都是这个签名）。将 event-bus 改为约束 `ServerMessageType` 即可获得编译时类型安全。

#### 问题 2：ChatPanel 组件膨胀（🟡 中）

当前 ChatPanel.vue 243 行（`<template>` + `<script setup>`），包含 **7 个独立渲染区域**：

```
ChatPanel 渲染区域：
├── PanelBar（会话栏）
├── MessageList（消息列表，含加载态/空态/消息流）
│   ├── SystemNotification × N
│   ├── MessageBubble × N
│   ├── StreamingMessage（流式消息）
│   └── Thinking indicator（思考中...）
├── WidgetDock (aboveEditor)
├── ApprovalCard（工具审批）
└── ChatInput（输入区）
```

TUI→GUI 新增 3 个区域后将达到 10 个区域，330+ 行。

**建议**：在当前规模（243 行）还在规范内（400 行上限），但**预计在 Phase 2 完成后**达到 400 行时，应提取子组件：

```
ChatPanel.vue（收束为编排角色）→
  原有 + 新增渲染区域逐步提取为独立组件：
  ├── ChatMessageArea.vue（消息列表+流式消息+重试指示器+排队提示）
  ├── ChatInputArea.vue（ChatInput + ApprovalCard）
  └── WidgetDock × 2（已有，只加 placement）
```

> **不是现在做** — ChatPanel 按兵不动，等 Phase 2 完成后达到 400 行阈值再拆。

#### 问题 3：ChatStore 与 SessionStore 责任边界模糊（🟡 中）

当前：
- **ChatStore** 管理：消息列表、流式状态、agent views、pending approvals、context info、done/alert count
- **SessionStore** 管理：session 列表、current session、分组

**边界问题**：
- `doneCount` / `alertCount` 放在 ChatStore（按 session 分区），而它们本质上是 Session 元数据
- `contextUsagePercent` 也是 Session 元数据（与 token 使用相关），放在 ChatStore
- TUI→GUI 新增的 `autoRetryState` / `queueState` / `thinkingLevel` / `responseModel` 是 Session 级状态

**建议**：短期不做重构（TUI→GUI 新增字段放入 ChatStore 分区即可），长期考虑：

```typescript
// 长期：SessionStore 持有 session 元数据
interface SessionMeta {
  autoRetryState?: AutoRetryState
  queueState?: QueueState
  thinkingLevel?: ThinkingLevel
  contextUsagePercent: number
  tokenUsage: number
}

// ChatStore 只管理消息流
interface ChatSessionState {
  completedMessages: ChatMessage[]
  streamingMessage: Message | null
  isGenerating: boolean
  // ... 消息相关的字段
}
```

> **需要 DDD 角度建模**：一个 Session 的"消息流"和"元数据"是不同职责，分开后 ChatPanel 可订阅不同的 store。但是当前架构中 ChatStore 已经混合，**需要大规模重构**，建议不在 TUI→GUI 范围中做。

#### 问题 4：44 kB mock 数据文件（🟢 低）

- `src/mock/data.ts` 725 行，包含大量 mock 数据
- 生产构建时未自动剔除（通过 `VITE_MOCK` 环境变量控制，但代码中 `mock-ws.ts` 仍然被引入）

**建议**：`VITE_MOCK=true` 时通过 vite 的 `define` 条件编译排除 mock 代码（使用 `if (import.meta.env.VITE_MOCK) { ... }`），确保生产包不含 mock 数据。

#### 问题 5：useChat.ts 全局注册机制的初始化时机（🟢 低）

```typescript
queueMicrotask(safeRegisterGlobalListeners)
```

当前使用 `queueMicrotask` 延迟注册全局事件监听器。如果 Pinia 在下一个微任务仍未就绪，监听器永远不会注册。

**建议**：改为 `App.vue` 的 `onMounted` 中显式调用注册，保证 Pinia 已就绪：

```typescript
// App.vue
onMounted(() => {
  if (typeof registerChatListeners === 'function') registerChatListeners()
})
```

#### 问题 6：无 lazy loading / code splitting（🟢 低）

当前构建配置 `target: 'esnext'`，但没有任何代码分割。
- 一个 `settings.html` 独立入口（已分割 settings）
- 但主入口 `index.html` 没有按路由/视图分割

**建议**：settings.html 已有独立入口 ✅。主入口目前功能紧凑（单页应用），code splitting 收益较低，**当前不做**。

### 2.4 推荐的分层模型（长期）

```
当前：三层                    长期建议：四层（领域层）

Presentation (Vue Components)  Presentation (Vue Components)
    ↓                                ↓
Composables (Business Logic)     Application (Composables + event-bus)
    ↓                                ↓
Stores (State Management)        Domain (Stores 按领域拆分)
                                     ↓
                                  Infrastructure (ws-client, event-bus, localStorage)
```

**核心变化**：
- **新增 Infrastructure 层**：ws-client（通信）、event-bus（事件）、localStorage（持久化）从 lib/ 提升为独立基础设施层
- **Domain 层**：ChatStore 拆分为 ChatStore（消息流）+ SessionMetaStore（元数据）+ ContextStore（上下文）
- **Application 层**：composables 作为编排层，负责调用 store action 和基础设施

> ⚠️ **不做推荐的**：这个四层模型是长期愿景，当前实施成本高（需要改 ~30 个文件）。**TUI→GUI 工作在现有三层架构上进行，所有改动在现有架构内增量。** 该重构在 Phase 5（树形引擎）之前完成即可。

---

## 三、前端性能审查

### 3.1 性能评分（每项 1-10）

| 维度 | 评分 | 说明 |
|------|------|------|
| 渲染性能 | 7/10 | Vue 3 reactive 追踪良好，无显著次优渲染 |
| 内存占用 | 7/10 | 消息列表持续增长无裁剪（长对话可能有内存问题） |
| 包体积 | 6/10 | 无代码分割，shiki + mermaid 可能较大 |
| 网络/WS 效率 | 8/10 | WS 消息体小，事件驱动模型高效 |
| 响应式细粒度 | 6/10 | `reactive(new Map())` 做分区，但 `streamingMessage` 整个替换导致全量触发 |
| 构建产物 | ? | 未验证生产包体积 |

### 3.2 已识别的性能风险

#### 风险 1：streamingMessage 全量替换 → 子组件全量重渲染（🟠 中）

```typescript
// stores/chat.ts
s.streamingMessage = { ...s.streamingMessage, content: s.streamingMessage.content + delta }
```

每次 `text_delta` 更新（每秒可能几十次），`streamingMessage` 被替换为新对象。虽然 Vue 3 的虚拟 DOM diff 可以处理，但：

- `MessageBubble.vue` 中 `v-for="block in message.contentBlocks"` 会重新计算每个 block
- `ThinkingBlock.vue` 中 `v-for="block in message.thinking"` 重新遍历所有 thinking blocks
- `ToolCallCard.vue` 中 `v-for="tc in message.toolCalls"` 重新遍历所有 tool calls

**长对话性能数据估算**：

| 场景 | 消息数 | 每次 delta 触发的组件重渲染 | 影响 |
|------|--------|---------------------------|------|
| 短对话 | ~10 | 10 个 MessageBubble + 1 个 StreamingMessage | 🟢 无压力 |
| 中对话 | ~50 | 50 + 1，MessageList 全部遍历 DOM diff | 🟡 轻微卡顿 |
| 长对话 | ~200 | 200 + 1，大量 DOM 节点 diff | 🟠 明显卡顿 |

**缓解方案**：

| 方案 | 成本 | 效果 | 说明 |
|------|------|------|------|
| `shallowRef` 包裹 streamingMessage | 低（~5 行） | 🟡 | 避免 reactive 深度追踪，但 MessageBubble props 仍然是新对象 |
| `v-memo` 指令 | 低（~5 行） | 🟡 | 缓存不变的 message 块，只在消息 ID 变化时重渲染 |
| 虚拟列表（@tanstack/vue-virtual） | 中（~100 行） | 🟠 最高 | 只渲染可见区域的消息，200+ 消息时收益显著 |
| rAF 节流 text_delta | 低（~20 行） | 🟡 | 限制每秒最多更新 30 帧 |

**首选**：`v-memo` 在 MessageBubble 上 + `:key` 按 message.id 绑定，最便宜且效果明显。

```vue
<!-- MessageBubble.vue 加入 v-memo -->
<template v-for="msg in completedMessages" :key="msg.id">
  <MessageBubble v-memo="[msg.id, msg.content, msg.status]" :message="msg" />
</template>
```

#### 风险 2：ChatStore 序列化/反序列化（🟡 低）

当前使用 `reactive(new Map<string, ChatSessionState>())` 做分区。Pinia 的 `pinia-plugin-persistedstate` 可能将整个 Map 序列化为 JSON。

- Map 在 JSON 序列化时默认丢失键值对（需要自定义 serializer）
- 长对话的 completedMessages 数组可能很大（1000+ 条消息）

**当前状态**：测试代码中未看到 persistedstate 的配置。如果启用了持久化，Session 消息数量大时会有性能问题。

**建议**：确认是否启用了持久化。如果启用了，考虑只持久化 session 元数据（不持久化消息列表），消息列表通过 `session.history` 从 sidecar 按需加载。

#### 风险 3：shiki 体积（🟡 低）

`shiki` 在 dependencies 中（~5MB）。首次加载时会初始化语法高亮引擎。

**当前**：shiki 用于 Markdown 代码高亮。由于项目使用 `markdown-it` + `shiki`，shiki 在渲染第一个代码块时初始化。

**建议**：
- 如果高亮效果良好，不需要改
- 如果感觉初始加载慢，使用 `shiki` 的 `lazy` 模式（只加载需要的高亮语言）

#### 风险 4：mermaid 体积 + 渲染开销（🟢 低）

`mermaid` ~1.5MB，只在 Markdown 中有 Mermaid 图表时渲染。正常对话中很少触发。

**建议**：使用 `mermaid` 的 `lazy` 加载（`defineAsyncComponent` 在检测到 mermaid 代码块时再加载），当前不改。

#### 风险 5：Bash 流式输出性能（TUI→GUI 新增风险）

**已在 `tui-to-gui-impact-analysis.md` 中详细分析**（见该文档第 12 章）。核心：

- `tool_execution_update` 每 100-500ms 推送完整输出快照
- 长输出（10000+ 行）导致 DOM 全量替换
- **缓解**：差值更新 + rAF 节流

### 3.3 构建产物分析

```bash
# 待执行 — 检查生产构建产物大小
npm run build:vite   # 生产构建
ls -lh renderer/dist/assets/  # 查看产物体积
```

> **建议**：TUI→GUI 工作开始前做一次基线测量，避免事后无法判断性能退化。

### 3.4 性能优化优先级

| 优先级 | 优化项 | 场景 | 收益 |
|--------|--------|------|------|
| 🟠 中 | `v-memo` + `:key` 消息列表 | 长对话（50+ 消息） | 减少 streaming 时的 DOM diff 范围 |
| 🟠 中 | Bash 流式输出差值更新 + rAF | 长 bash 输出（1000+ 行） | 避免每 100ms 全量渲染 |
| 🟡 低 | streamingMessage `shallowRef` | 持续流式对话 | 减少 reactive 追踪开销 |
| 🟡 低 | shiki lazy load | 启动性能 | 减小首次加载体积 |
| 🟢 低 | 确认持久化策略 | 对话历史 | 避免序列化大量消息 |
| 🟢 低 | 生产构建基线测量 | 产物体积 | 建立基线 |

---

## 四、三者对 TUI→GUI 工作的影响

### 4.1 测试对 TUI→GUI 的影响

| 影响点 | 说明 | 行动 |
|--------|------|------|
| EventAdapter 新 case 必须有测试 | 15 个修改点中 12 个是新增 case，是测试覆盖的底线 | **TUI→GUI Phase 0 中包含** |
| useChat 新 handler + ChatStore 新字段必须有测试 | 确保 handler 正确路由、store 状态正确变化 | **TUI→GUI Phase 1-2 中包含** |
| 新增组件的渲染测试可选 | EditorDialog、CustomMessageRenderer 可加渲染测试，但不强求 | **TUI→GUI Phase 1 可选** |
| 现有测试不能 break | 新增 case 不影响现有 event-adapter-extension.test.ts 和 useChat.test.ts | **回归验证** |

**结论**：测试不是 TUI→GUI 的阻塞项，但新增 EventAdapter/useChat/ChatStore 改动必须附带测试。

### 4.2 架构优化对 TUI→GUI 的影响

| 架构问题 | 是否阻塞 TUI→GUI | 说明 |
|---------|-----------------|------|
| event-bus 类型不安全 | ❌ 不阻塞，但建议先修 | 10+ 新事件 + 现有 50+ 事件，string type 的风险放大。方案 B 改动极小（~30 行） |
| ChatPanel 组件膨胀 | ❌ 不阻塞 | 243 行 → 330 行，在当前 400 行上限内 |
| ChatStore/SessionStore 边界模糊 | ❌ 不阻塞 | TUI→GUI 新增字段继续放入 ChatStore 分区，短期可接受 |
| 四层架构重构 | ❌ 不阻塞 | 长期愿景，改造成本高，不在 scope 内 |
| mock 数据剔除 | ❌ 不阻塞 | 不影响功能，可后续优化 |

**唯一建议先修的**：event-bus 类型安全（方案 B，改动极小的前置工作）。

### 4.3 性能优化对 TUI→GUI 的影响

| 性能问题 | 是否阻塞 TUI→GUI | 说明 |
|---------|-----------------|------|
| streamingMessage 全量替换 | ❌ 不阻塞 | 现有问题，TUI→GUI 不恶化 |
| Bash 流式输出性能 | 🟡 建议在 Phase 2 中一并处理 | TUI→GUI Phase 2 的 BashToolRenderer 增强正好包含此项 |
| shiki/mermaid 体积 | ❌ 不阻塞 | 独立优化 |
| 生产构建基线 | ❌ 不阻塞 | 建议 TUI→GUI 前做一次基线 |

**唯一与 TUI→GUI 相关的性能优化**：BashToolRenderer 差值更新 + rAF 节流（在 Phase 2 中一并完成）。

---

## 五、行动建议汇总

### 5.1 总体策略

```
TUI→GUI 工作 + 配套优化的关系：

Phase 0 (EventAdapter) ──────────→ 附带 EventAdapter 测试
         │
         ▼
Phase 1 (新建组件) ──────────────→ EditorDialog 渲染测试（可选）
         │
         ▼
Phase 2 (增强组件) ──────────┬──→ 附带 useChat/ChatStore 测试（必须）
                             └──→ Bash 流式输出性能优化（推荐）
         │
         ▼
独立优化（可并行） ──────────┬──→ event-bus 类型安全（方案 B，~30 行）
                             ├──→ v-memo 消息列表（~5 行）
                             └──→ 生产构建基线 + 构建优化（~30min）
```

### 5.2 优先级速查表

| # | 行动 | 优先级 | 工作量 | 依赖 | 关联 |
|---|------|--------|--------|------|------|
| 1 | EventAdapter 15 处修改 | 🔴 P0 | ~200 行 | 无 | TUI→GUI Phase 0 |
| 2 | EventAdapter 新 case 测试 | 🔴 P0 | ~200 行 | 1 | 与 1 同时完成 |
| 3 | event-bus 类型安全（方案 B） | 🟡 P1 | ~30 行 | 无 | 可独立做，建议在 4 之前 |
| 4 | useChat 新增 handler + 测试 | 🟡 P1 | ~200 行 | 1, 3 | TUI→GUI Phase 1-2 |
| 5 | ChatStore 新增字段 + 测试 | 🟡 P1 | ~100 行 | 1 | 与 4 同时完成 |
| 6 | v-memo 消息列表 | 🟡 P1 | ~5 行 | 无 | 可独立做 |
| 7 | BashToolRenderer 差值更新 | 🟡 P1 | ~80 行 | 1 | TUI→GUI Phase 2 |
| 8 | 生产构建基线 | 🟢 P2 | ~30min | 无 | TUI→GUI 前做 |
| 9 | 补齐已有模块测试 | 🟢 P2 | ~500 行 | 无 | 持续改进 |
| 10 | ChatPanel 提取子组件 | 🟢 P3 | ~100 行 | 4 | 等达到 400 行时 |
| 11 | ChatStore/SessionStore 拆分 | 🟢 P3 | ~500 行 | 4, 5 | Phase 5 前完成 |
| 12 | 四层架构重构 | 🟢 P3 | ~1000 行 | 10, 11 | Phase 5 后考虑 |
| 13 | shiki/mermaid lazy load | 🟢 P4 | ~50 行 | 无 | 优化启动性能 |

### 5.3 关键风险

- **测试文化缺乏**是最根本问题：当前 8% 的测试覆盖率意味着任何重构都伴随着回归风险
- **没有 CI 集成**意味着没有自动化质量门禁
- **event-bus 类型不安全**在 TUI→GUI 新增 10+ 事件时风险放大，建议先修
- **性能基线缺失**意味着 TUI→GUI 引入的新性能问题无法被感知
