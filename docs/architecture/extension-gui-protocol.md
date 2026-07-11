# Extension GUI 渲染协议规范

> **版本**: v1-draft-rev2
> **状态**: 设计中（经 4 路技术审查修正）
> **日期**: 2026-07-11
> **审查记录**: 见文末 §13「审查修正日志」
> **目标**: 为 pi extension 提供一套结构化 GUI 渲染协议，在 pi TUI 渲染契约基础上扩展，使 extension 一套代码根据运行环境（TUI / GUI）自动路由渲染逻辑。

---

## 1. 问题陈述

### 1.1 现状

pi extension 有 5 个渲染入口，全部返回 `Component { render(width): string[] }`——ANSI 文本行：

| pi 渲染入口 | 用途 | RPC 模式行为 |
|---|---|---|
| `ToolDefinition.renderCall` | tool 调用标题行 | **no-op**（从不调用） |
| `ToolDefinition.renderResult` | tool 结果展示 | **no-op**（从不调用） |
| `ctx.ui.setWidget(factory)` | editor 上下方面板 | **factory 被丢弃**，仅 `string[]` 生效 |
| `registerMessageRenderer` | 自定义消息卡片 | **no-op**（从不调用） |
| `ctx.ui.custom(factory)` | 交互式自定义组件 | **返回 undefined**（崩溃） |

xyz-agent 以 `--mode rpc` 运行 pi。RPC 模式下 `Component` 无法序列化进 JSON-RPC，上述渲染入口全部失效。extension 精心编写的 TUI 渲染（带色、布局、spinner）全部丢失。

### 1.2 目标

提供一套**可序列化的结构化渲染协议**，作为 pi `Component` 的 GUI 镜像。extension 通过 `ctx.mode` 判断运行环境，TUI 走原生 `Component` 渲染，GUI 走结构化 `GuiComponent` 渲染。

**设计原则**：
1. **兼容 pi 协议**——不修改 pi 源码，不覆盖 pi 原有行为。TUI 模式下零影响。
2. **镜像 pi 概念**——每个 pi 渲染入口有对应的 GUI 数据通道，概念对齐。
3. **一套接口两套实现**——extension 只写一版 `execute`，内部按 `ctx.mode` 分支。
4. **不改 pi 的 result.content**——`content` 是 LLM 可见的，协议数据只放 `details`。

---

## 2. 架构总览

```
extension execute() / event handler
  │
  ├─ ctx.mode === 'tui'
  │   └─ 返回 details（无 __gui__）
  │      pi TUI 调用 renderResult(render) → Component → ANSI string[]
  │
  └─ ctx.mode === 'rpc'
      └─ 返回 details.__gui__ = GuiComponent
         pi RPC 原样透传 result（agent-session.js:451 零过滤）
         xyz-agent event-adapter 原样透传 details（零白名单）
         前端检测 __gui__.type → 路由到 Vue 组件
```

### 数据流链路（已验证）

| 环节 | 位置 | 行为 |
|---|---|---|
| extension 构造 | extension execute() | `details.__gui__ = { type, props }` |
| pi agent-core | `agent-session.js:451-460` | `result: event.result` 原样引用，零过滤 |
| pi RPC stdout | `rpc-mode.js:264` + `jsonl.js:8` | `JSON.stringify(event)` 原样输出 |
| xyz-agent runtime | `event-adapter.ts:147-151` | `details as Record<string, unknown>` 原样透传 |
| 前端 Block.vue | `tool.details.__gui__` | 按 `.type` 路由到 Vue 组件 |

**边界约束**：`__gui__` 必须放在 `result.details` 下（整体透传），不能放在 `result.content` 内（会被 event-adapter 过滤成 text/image）。

---

## 3. 核心类型定义

### 3.1 GuiComponent——pi Component 的可序列化镜像

pi 的 `Component` 接口是 `{ render(width: number): string[] }`——返回 ANSI 文本行，不可序列化。

`GuiComponent` 是可序列化的结构化数据，前端有对应的 Vue 组件把它渲染成 GUI：

```typescript
/**
 * GUI 渲染组件——pi Component 的可序列化镜像。
 *
 * pi:  Component { render(width): string[] }   ← ANSI 文本行
 * gui: GuiComponent = { type, props }           ← 结构化数据
 *
 * 两者概念对齐：pi 的 renderResult 返回 Component 给 TUI 渲染，
 * xyz-agent 的 details.__gui__ 返回 GuiComponent 给 Vue 渲染。
 */
export interface GuiComponent<T extends GuiComponentType = GuiComponentType> {
  /** 组件类型，前端按此路由到 Vue 组件 */
  type: T
  /** 组件 props，类型由 type 决定 */
  props: GuiComponentProps[T]
}
```

### 3.2 内置组件类型

```typescript
/**
 * 协议内置组件类型。
 * 覆盖通用渲染场景。custom 是逃生口，允许 extension 完全自定义。
 */
export type GuiComponentType = keyof GuiComponentProps

export interface GuiComponentProps {
  /** ANSI 文本兜底——保留原始 ANSI 序列，前端用 ansi_up 渲染 */
  'ansi-text': {
    lines: string[]
  }

  /** 任务列表——pi-todo 等 */
  'task-list': {
    items: TaskItem[]
    summary?: string
  }

  /** Goal 状态卡片——pi-goal */
  'goal-status': {
    status: GoalStatusValue
    title: string
    slug?: string
    turn?: number
    metrics?: MetricBar[]
  }

  /** 工作流 run 列表——pi-workflow */
  'workflow-runs': {
    runs: WorkflowRunItem[]
  }

  /** Subagent 执行轨迹——pi-subagents */
  'subagent-trace': {
    agent: string
    status: SubagentStatusValue
    stats?: { turns?: number; tokens?: number; durationMs?: number; toolCount?: number }
    eventLog?: EventLogEntry[]
    result?: string
    error?: string
  }

  /** 交互式组件——ask-user 等（见 §6） */
  'interaction': {
    questions: InteractionQuestion[]
    allowCancel: boolean
  }

  // ── 布局原语（替代 TUI ASCII 布局，见 §14）──

  /** 卡片容器——替代 TUI 的 ┌─┐││└─┘ / ╭╮╰╯ box 边框 */
  'card': {
    variant?: 'default' | 'elevated' | 'danger' | 'success'
    header?: GuiComponent | string       // 标题区（可为文本或嵌套组件）
    body: GuiComponent[]                 // 内容区子组件数组
  }

  /** 统计行——替代 TUI 的 "N turns · Nk · Ns" 分隔行 */
  'stats-line': {
    items: StatItem[]
  }

  /** 进度条——替代 TUI 的 ████░░░░ 字符 */
  'progress-bar': {
    label?: string
    current: number
    total: number
    unit?: string
    severity?: 'ok' | 'warn' | 'danger'  // 不提供则按百分比推导
  }

  /** 列表树——替代 TUI 的 ⎿ ├─ └─ 缩进 */
  'list-tree': {
    items: TreeItem[]
  }

  /** 双列网格——替代 TUI 的 │ 列分隔 */
  'columns': {
    children: GuiComponent[]  // 每个子组件占一列，CSS grid 等分
    ratios?: number[]         // 可选列宽比例（如 [1,2]），默认等分
  }

  /** 标签栏——替代 TUI 的 tab │ 分隔 */
  'tab-bar': {
    tabs: { label: string; active?: boolean; status?: 'done' | 'pending' }[]
  }

  /** 自定义组件——逃生口（仅限内置 extension 编译期注册，见 §9.1） */
  'custom': {
    /** extension 自定义的组件名，前端需在编译期注册同名组件 */
    component: string
    /** 任意 props，由 extension 和前端约定 */
    props: Record<string, unknown>
  }
}
```

### 3.3 内置类型的子类型

```typescript
// ── task-list ──
export interface TaskItem {
  id: string | number
  text: string
  status: 'pending' | 'in_progress' | 'completed' | 'cancelled'
}
export type TaskStatus = TaskItem['status']

// ── goal-status ──
export type GoalStatusValue =
  | 'active' | 'paused' | 'blocked'
  | 'complete' | 'budget_limited' | 'time_limited' | 'cancelled'

export interface MetricBar {
  label: string          // "Token" | "Time" | "Cost"
  current: number
  total?: number         // 有预算时提供；无预算时省略，只显当前值
  unit?: string          // "k" | "min" | "$"
  severity?: 'ok' | 'warn' | 'danger'  // 颜色：绿/黄/红，不提供则按百分比推导
}

// ── workflow-runs ──
export interface WorkflowRunItem {
  runId: string
  name: string
  status: 'running' | 'paused' | 'done'
  reason?: 'completed' | 'failed' | 'aborted' | 'budget_limited' | 'time_limited'
  durationMs?: number
  error?: string
}

// ── subagent-trace ──
export type SubagentStatusValue = 'running' | 'done' | 'failed' | 'cancelled' | 'crashed'

export interface EventLogEntry {
  type: 'tool_start' | 'tool_end' | 'turn_end' | 'error'
  label: string
  status?: 'running' | 'done' | 'failed'
}

// ── interaction ──（见 §6 详述）
export interface InteractionQuestion {
  header: string
  question: string
  context?: string
  options?: InteractionOption[]
  multiSelect?: boolean
  allowOther?: boolean      // 允许自由输入
  allowComment?: boolean    // 允许附加评论
  default?: string | string[]
}
export interface InteractionOption {
  label: string
  value: string
  description?: string
}

// ── 布局原语子类型（见 §14 ASCII→结构化映射）──

/** stats-line 的单项 */
export interface StatItem {
  label?: string         // "turns" | "tokens" | "duration"（可选，有则 label: value 格式）
  value: string          // "3" | "12.4k" | "47s"（已格式化的显示文本）
  severity?: 'ok' | 'warn' | 'danger'  // 语义色
  icon?: string          // 可选 lucide 图标名（如 "Clock"）
}

/** list-tree 的节点 */
export interface TreeItem {
  icon?: TreeItemIcon     // 语义图标（替代 → ✓ ✗ ∘ 等 glyph）
  label: string
  status?: 'running' | 'done' | 'failed'  // 语义色
  depth?: number          // 缩进层级（0=根，替代 ⎿ 嵌套深度）
  children?: TreeItem[]   // 嵌套子节点
}
export type TreeItemIcon = 'arrow' | 'check' | 'cross' | 'circle' | 'dot' | 'pause' | 'branch'
```

### 3.4 GuiRenderResult——带协议版本号

```typescript
export const PROTOCOL_VERSION = 1 as const

/**
 * tool result / message details 中 __gui__ 字段的完整类型。
 * 前端检测 v 字段做版本协商，不认识的版本降级为 ansi-text。
 */
export interface GuiRenderResult {
  v: typeof PROTOCOL_VERSION
  component: GuiComponent
}
```

---

## 4. 五个渲染入口的 GUI 镜像

### 4.1 映射总表

| pi 渲染入口 | GUI 数据通道 | 数据载体 | 传输方向 |
|---|---|---|---|
| `renderCall(args)` | extension 在 execute 中构造 | `details.__gui__.call` | 单向 |
| `renderResult(result)` | extension 在 execute 中构造 | `details.__gui__.result` | 单向 |
| `setWidget(key, factory)` | `guiSetWidget()` helper（直编码） | extension_ui_request（marker 编码进 string[]） | 单向 |
| `setStatus(key, text)` | 复用 pi 原生（已有效） | extension_ui_request | 单向 |
| `registerMessageRenderer` | extension 在 sendMessage 中构造 | `message.details.__gui__` | 单向 |
| `ctx.ui.custom(factory)` | `guiInteract()` helper | `details.__gui__.interact` + dialog 回传 | **双向** |

### 4.2 tool result（renderCall + renderResult）

extension 在 `execute` 中根据 `ctx.mode` 分支：

```typescript
execute(toolCallId, params, signal, onUpdate, ctx) {
  const result = doWork(params)

  // ── 给 LLM 的 content（两模式相同）──
  const content = [{ type: 'text' as const, text: formatForLLM(result) }]

  if (ctx.mode === 'rpc') {
    // GUI 模式：结构化渲染数据放进 details.__gui__
    return {
      content,
      details: {
        ...result,  // extension 自身的 details 字段（如 action/todos）
        __gui__: {
          v: PROTOCOL_VERSION,
          component: {
            type: 'task-list',
            props: {
              summary: `${result.todos.filter(t => t.status === 'completed').length}/${result.todos.length} completed`,
              items: result.todos.map(t => ({ id: t.id, text: t.text, status: t.status })),
            },
          },
        },
      },
    }
  }

  // TUI 模式：renderResult 会被 pi TUI 调用
  return { content, details: { ...result } }
}

// TUI 实现（已有，保持不变）
renderResult(result, options, theme) {
  return buildTodoListText(result.details.todos, theme, options.expanded)
}
```

**streaming 进度**（`onUpdate`）：RPC 模式下 `onUpdate(partialResult)` 的 `partialResult.details.__gui__` 会被 `tool_execution_update` 事件透传。**注意**：当前 event-adapter 的 handleToolExecutionUpdate 把整个 `partialResult` 塞进 `detail`（单数），未提取 `partialResult.details`——需改为提取 `partialResult.details`（见 §8.1 修正项）。

### 4.3 widget（setWidget）

widget 通过 `guiSetWidget()` helper **直接编码进 string[]**——不需要 shim extension，不需要 monkey-patch。

#### 原理

pi 的 `ctx.ui.setWidget(key, string[])` 在 RPC 模式下原样输出 `widgetLines`（rpc-mode.js:122-135 零预处理）。helper 把 GuiComponent 的 JSON 用协议 marker 前缀编码进单行 string[]，runtime event-adapter 检测 marker 后解码。

#### helper 实现

```typescript
// @xyz-agent/extension-protocol
const GUI_WIDGET_MARKER = '\x00XYZ_GUI_WIDGET:'  // NUL 开头，不会出现在正常文本中

function guiSetWidget(
  ctx: ExtensionContext,
  key: string,
  component: GuiComponent | undefined
): void {
  if (component) {
    // RPC 模式：编码进 string[]（pi 原样透传）
    const encoded = [GUI_WIDGET_MARKER + JSON.stringify(stripUndefined(component))]
    ctx.ui.setWidget(key, encoded)
  } else {
    ctx.ui.setWidget(key, undefined)  // 清除
  }
}
```

**为什么不需要 shim**（审查结论）：extension 本就要改代码调 `guiSetWidget()`，helper 内部直接调原生 `ctx.ui.setWidget(key, [MARKER+JSON])` 就能走通整条链路。shim 的唯一潜在价值是透明拦截未引入协议包的第三方 extension，但第三方传的是 string[]（ANSI 文本），不触发 GuiComponent 分支，shim 无所作为。

**runtime 侧解码**：event-adapter.ts 的 setWidget 分支检测 marker 前缀（详见 §8.1）。


#### extension 怎么用

协议包提供 `guiSetWidget()` helper，extension 开发者不需要知道底层编码：

```typescript
import { guiSetWidget, guiComponent } from '@xyz-agent/extension-protocol'

function refreshDisplay(ctx: ExtensionContext, todos: Todo[]) {
  if (ctx.mode === 'rpc') {
    // GUI 模式：结构化 widget
    guiSetWidget(ctx, 'todo', {
      type: 'task-list',
      props: {
        summary: `${todos.filter(t => t.status === 'completed').length}/${todos.length} completed`,
        items: todos.map(t => ({ id: t.id, text: t.text, status: t.status })),
      },
    })
  } else {
    // TUI 模式：Component factory（已有）
    ctx.ui.setWidget('todo', (tui, theme) => buildTodoWidget(todos, theme))
  }
}
```

### 4.4 status（setStatus）

**复用 pi 原生**，无需改动。`ctx.ui.setStatus()` 在 RPC 模式下已有效（fire-and-forget），event-adapter 已正确翻译。

修复点仅在前端：将 status 从 SideDrawer footer 提升为全局底栏，并恢复 ANSI 着色（不再 stripAnsi）。

### 4.5 custom message（registerMessageRenderer）

extension 在 `sendMessage` 时把 `__gui__` 放进 details：

```typescript
import { sendMessage } from '@mariozechner/pi-coding-agent'

// extension 推送自定义消息
sendMessage({
  customType: 'workflow-node-completed',
  content: '部署到 staging 完成',
  details: {
    node: 'deploy',
    status: 'done',
    duration: 45000,
    __gui__: {
      v: PROTOCOL_VERSION,
      component: {
        type: 'custom',
        props: {
          component: 'workflow-node-card',
          props: { node: 'deploy', status: 'done', durationMs: 45000 },
        },
      },
    },
  },
})
```

前端 `message.customStart` handler 检测 `details.__gui__`，按 `component.type` 路由。TUI 模式下 `registerMessageRenderer` 照常工作。

### 4.6 交互式组件（ctx.ui.custom）—— 见 §6

---

## 5. 协议包 API（@xyz-agent/extension-protocol）

独立 npm 包，只含类型定义和辅助函数，零运行时依赖。extension 以 `dependencies` 引入。

### 5.1 导出清单

```typescript
// @xyz-agent/extension-protocol

// ── 类型 ──
export { type GuiComponent, type GuiComponentType, type GuiComponentProps }
export { type GuiRenderResult }
export { type PROTOCOL_VERSION }
export {
  type TaskItem, type GoalStatusValue, type MetricBar,
  type WorkflowRunItem, type EventLogEntry,
  type InteractionQuestion, type InteractionOption,
}

// ── 常量 ──
export { PROTOCOL_VERSION as PROTOCOL_VERSION_VALUE }
export { GUI_WIDGET_MARKER }

// ── 辅助函数 ──
export { guiResult }       // 构造 GuiRenderResult
export { guiComponent }    // 构造 GuiComponent（带类型推断）
export { guiSetWidget }    // 设置 GUI widget（shim 增强）
export { guiInteract }     // 交互式组件（TUI/GUI 双模）
export { isGuiCapable }    // 检测当前环境是否支持 GUI 渲染
```

### 5.2 辅助函数签名

```typescript
/** 检测当前环境是否支持 GUI 渲染（RPC 模式 + shim 已加载） */
function isGuiCapable(ctx: ExtensionContext): boolean

/** 构造 GuiRenderResult，放进 details.__gui__ */
function guiResult(component: GuiComponent): GuiRenderResult

/** 构造 GuiComponent，带类型推断 */
function guiComponent<T extends GuiComponentType>(
  type: T,
  props: GuiComponentProps[T]
): GuiComponent

/** 设置 GUI widget（内部调被 shim 增强的 ctx.ui.setWidget） */
function guiSetWidget(
  ctx: ExtensionContext,
  key: string,
  component: GuiComponent | undefined
): void

/** 交互式组件——TUI 走 ctx.ui.custom，RPC 走 dialog 序列（见 §6） */
function guiInteract(
  ctx: ExtensionContext,
  questions: InteractionQuestion[],
  options?: { signal?: AbortSignal }
): Promise<Record<string, string | string[]> | null>
```

---

## 6. 交互层（interaction）

### 6.1 技术约束

`ctx.ui.custom()` 在 RPC 模式下返回 `undefined`（no-op），且：
- factory 参数（questions/options）在闭包内，shim 无法提取
- pi 的 execute 在 `await ctx.ui.custom()` 处阻塞，RPC 返回 undefined 后直接崩溃
- runtime 无法截断已 return 的 tool result 注入用户答案

**但 `ctx.ui.select()` / `ctx.ui.input()` / `ctx.ui.confirm()` 在 RPC 模式下有效**——它们走 `extension_ui_request` / `extension_ui_response` 通道，runtime 已有完整的请求-回复路由（`extension-message-handler.ts:75-91` 处理 `extension.ui_response` → 注入回 pi stdin；`extension-timeout-manager.ts` 管理 5 分钟超时兜底）。

**致命约束**：runtime 路由完整≠端到端可用。**前端完全没有 `extension.ui_request` 的 handler**——`chat-message-effects.ts` 的 22 个 handler 无一处理它。select() 的 Promise 会卡 5 分钟后返回 null（超时兜底）。**因此 ExtensionUIDialog 必须在 P1 阶段与协议包同期交付**，否则 guiInteract 的 RPC 分支是死代码。

### 6.2 设计：guiInteract() 双模路由

```typescript
async function guiInteract(
  ctx: ExtensionContext,
  questions: InteractionQuestion[],
  options?: { signal?: AbortSignal }
): Promise<Record<string, string | string[]> | null> {
  // json/print 模式无 UI 能力，直接返回 null
  if (!ctx.hasUI) return null

  if (ctx.mode === 'tui') {
    // ── TUI 模式：富交互组件 ──
    // extension 提供自己的 AskUserComponent（或类似 TUI 组件）
    return ctx.ui.custom((tui, theme, kb, done) => {
      return new AskUserComponent(questions, tui, theme, done)
    }, { signal: options?.signal } as any)
  }

  // ── RPC 模式：降级为 dialog 序列 ──
  // 前提：前端已实现 ExtensionUIDialog（P1 同期交付）
  const answers: Record<string, string | string[]> = {}

  for (const q of questions) {
    if (q.options && q.options.length > 0) {
      if (q.multiSelect) {
        // 多选：逐选项 confirm（Phase 1 降级，体验有限）
        const selected: string[] = []
        for (const opt of q.options) {
          const yes = await ctx.ui.confirm(q.header, `选择 ${opt.label}?`, { signal: options?.signal })
          if (yes) selected.push(opt.value)
        }
        answers[q.header] = selected
      } else {
        // 单选：ctx.ui.select（RPC 原生支持）
        const choice = await ctx.ui.select(
          q.header,
          q.options.map(o => o.label),
          { signal: options?.signal }
        )
        if (choice === undefined) return null  // 用户取消
        answers[q.header] = q.options.find(o => o.label === choice)?.value ?? choice
      }
    } else {
      // 自由输入
      const text = await ctx.ui.input(q.header, q.question, { signal: options?.signal })
      if (text === undefined) return null
      answers[q.header] = text
    }
  }

  return answers
}
```

### 6.3 extension 怎么用

ask-user extension 改为：

```typescript
import { guiInteract, type InteractionQuestion } from '@xyz-agent/extension-protocol'

execute(toolCallId, params, signal, onUpdate, ctx) {
  if (!ctx.hasUI) {
    return { content: [{ type: 'text', text: 'Error: UI not available' }], details: {}, isError: true }
  }

  const questions: InteractionQuestion[] = params.questions.map(q => ({
    header: q.header,
    question: q.question,
    context: q.context,
    options: q.options?.map(o => ({ label: o.label, value: o.value })),
    multiSelect: q.multiSelect,
    allowOther: q.allowOther,
  }))

  const answers = await guiInteract(ctx, questions, { signal })

  if (answers === null) {
    return { content: [{ type: 'text', text: 'User cancelled' }], details: { cancelled: true } }
  }

  const summary = Object.entries(answers)
    .map(([q, a]) => `${q} = ${a}`)
    .join('\n')

  return {
    content: [{ type: 'text', text: summary }],
    details: { questions, answers },
  }
}
```

**TUI 模式**：`guiInteract` 调 `ctx.ui.custom()`，ask-user 的 `AskUserComponent` 完整渲染（tab/分屏/inline 编辑器）。
**RPC 模式**：`guiInteract` 调 `ctx.ui.select()` 序列，前端 `ExtensionUIDialog` 渲染标准对话框。丢失 tab/分屏，但功能完整。

### 6.4 Phase 2：前端富交互组件

Phase 1 走 dialog 降级后，Phase 2 可在前端实现富交互：
1. extension 检测 `ctx.mode === 'rpc'` 时，在 `details.__gui__` 附带 `interaction` 组件数据
2. 前端识别到 interaction 组件，渲染富交互 UI（tab/选项卡片/freeform）
3. 用户操作后，前端通过 `extension_ui_response` 发送结构化答案
4. `guiInteract` 内部不再调 `ctx.ui.select()`，而是等待前端的 response

这需要 runtime 层在检测到 interaction 组件时，把它转化为一个特殊的 `extension_ui_request`（method=`gui_interaction`），前端渲染富 UI 后通过 `extension_ui_response` 回复。

---

## 7. ~~shim extension 设计~~（已移除）

> **审查修正（S1）**：v1-draft 的 shim extension 方案经审查判定为多此一举。`guiSetWidget()` helper 内部直接调原生 `ctx.ui.setWidget(key, [MARKER+JSON])` 即可走通整条链路，不需要 monkey-patch `ctx.ui`。
>
> 已验证的事实（备查）：
> - `ctx.ui` 是所有 extension 共享的同一对象（`runner.js:411-480`，getter 返回 `runner.uiContext`），monkey-patch 技术上可行
> - `runner.uiContext` 无 `Object.freeze/seal`（全文件扫描确认），patch 不会静默失败
> - `session_start` handler 确实传 ctx（`runner.js:531`），且在 `bindExtensions` 后触发
> - 但 shim 的唯一潜在价值（透明覆盖第三方 extension 的原生 setWidget）不成立——第三方传 string[] 不触发 GuiComponent 分支
>
> 结论：砍掉 shim extension，消除 monkey-patch 风险面、session_start 时序依赖、加载顺序讨论三个复杂度来源。widget 传输改为 helper 直编码（§4.3）。

---

## 8. runtime 侧改动

### 8.1 event-adapter.ts

**setWidget 分支增强**（检测协议标记）：

```typescript
const GUI_WIDGET_MARKER = '\x00XYZ_GUI_WIDGET:'  // NUL 字符开头，不会出现在正常文本中

if (method === 'setWidget') {
  const rawLines = Array.isArray(event.widgetLines) ? event.widgetLines as unknown[] : []

  // 检测 GUI 协议标记
  if (rawLines.length === 1 && typeof rawLines[0] === 'string' && rawLines[0].startsWith(GUI_WIDGET_MARKER)) {
    try {
      const json = (rawLines[0] as string).slice(GUI_WIDGET_MARKER.length)
      const gui = JSON.parse(json)
      // 发结构化 WS 帧（不走 stripAnsi）
      return [{
        kind: 'message',
        message: {
          type: EXTENSION_EVENTS.WIDGET_GUI as ServerMessageType,
          payload: { sessionId: sid, widgetKey: String(event.widgetKey ?? ''), gui },
        },
      }]
    } catch {
      // JSON 解析失败，降级为纯文本
    }
  }

  // 原有行为：stripAnsi + string[]
  const lines = rawLines.map(l => stripAnsi(String(l)))
  return [{
    kind: 'message',
    message: {
      type: EXTENSION_EVENTS.WIDGET as ServerMessageType,
      payload: { sessionId: sid, widgetKey: String(event.widgetKey ?? ''), lines },
    },
  }]
}
```

**setStatus 分支**：不再 stripAnsi（保留颜色信息），或提供 `textRaw` 字段。

**handleToolExecutionUpdate 修正**（审查 S5）：当前把整个 `partialResult` 塞进 `detail`（单数），需改为提取 `partialResult.details`：

```typescript
// event-adapter.ts handleToolExecutionUpdate（约 381-394 行）
// 修正前：detail = partialResult（整个对象）
// 修正后：提取 partialResult.details，与 tool_execution_end 路径对齐
const detail: Record<string, unknown> | string | undefined =
  partialResult != null && typeof partialResult === 'object'
    ? ((partialResult as Record<string, unknown>).details as Record<string, unknown> | undefined)
      ?? (partialResult as Record<string, unknown>)  // fallback：无 details 时用整个对象（兼容 subagent 的 progress 形态）
    : (partialResult as string | undefined)
```

### 8.2 历史路径修复（审查 F1——致命）

**这是最关键的修复**。`message-converter.ts:73-95` 的 toolResult 分支完全不读 `details`，重开 session 后 `__gui__` 全丢。

```typescript
// message-converter.ts toolResult 分支（约 73-95 行）
if (tc) {
  const textParts = (Array.isArray(toolResult.content) ? toolResult.content : [])
    .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
    .map(p => p.text ?? '')
    .join('\n')
  tc.output = textParts
  if (toolResult.isError) tc.status = 'error'
  // ★ 新增：透传 details（含 __gui__），与实时路径 event-interpreter.ts:209 对齐
  const d = (toolResult as Record<string, unknown>).details
  if (d && typeof d === 'object' && !Array.isArray(d)) {
    tc.details = d as Record<string, unknown>
  }
}
```

同步修类型——`PiHistoryToolResult` 补 `details` 字段：

```typescript
// pi-protocol.ts PiHistoryToolResult（约 360-366 行）
export interface PiHistoryToolResult extends PiHistoryMessage {
  role: 'toolResult'
  toolCallId: string
  toolName: string
  isError?: boolean
  details?: Record<string, unknown>  // ★ 新增：pi 实际持久化了 details，类型声明补齐
}
```

### 8.3 新增 WS 消息类型（审查 S4——三处缺一不可）

```typescript
// shared/src/extension.ts
export const EXTENSION_EVENTS = {
  WIDGET: 'extension:widget',
  WIDGET_GUI: 'extension:widgetGui',  // 新增：结构化 widget
  STATUS: 'extension:status',
} as const
```

```typescript
// shared/src/protocol.ts —— 三处必须同步改，否则 TS 编译报错

// 1. ServerMessageType 联合（约 183 行）加入：
| 'extension:widgetGui'

// 2. ServerMessageMap（约 245 行）加入 payload 映射：
'extension:widgetGui': { sessionId: string; widgetKey: string; gui: GuiComponent }
```

### 8.4 Message 类型补 details（审查 S3）

custom message 方案（§4.5）前端拿不到 `__gui__`，因为 Message 类型没有 details 字段，customStart handler 读了但没存。

```typescript
// shared/src/message.ts Message 接口（约 189-230 行）
export interface Message {
  // ... 已有字段
  customType?: string
  bgNotify?: BgNotifyDetails
  details?: Record<string, unknown>  // ★ 新增：透传 pi customMessage details（含 __gui__）
}
```

同步改 `chat-message-effects.ts` 的 customStart handler（约 400-407 行）：构造 msg 时把 raw details 存进去：

```typescript
const msg: Message = {
  id: `cm-${crypto.randomUUID()}`,
  role: 'system',
  content,
  status: 'complete',
  customType,
  details,  // ★ 新增：保留原始 details（含 __gui__）
  timestamp: Date.now(),
}
```

### 8.5 ToolCall 类型（不改，但提供 helper）

`ToolCall.details` 已是 `Record<string, unknown>`，不需改。但前端读 `__gui__` 需类型守卫（审查 S7/C3）：

```typescript
// @xyz-agent/extension-protocol 提供
export function extractGui(details: Record<string, unknown> | undefined): GuiRenderResult | undefined {
  const g = details?.__gui__
  if (g && typeof g === 'object' && 'v' in g && 'component' in g) {
    return g as GuiRenderResult
  }
  return undefined
}
```

前端统一用 `extractGui(tool.details)` 读取，集中校验版本号，避免散落的 `as` 断言。

**命名陷阱提醒**（审查 C4）：ToolCall 同时有 `details`（复数，来自 tool_call_end 的 result.details）和 `detail`（单数，来自 tool_call_update 的 partialResult）。`__gui__` 在 `details`（复数）里。streaming 期间从 `detail`（单数）读，但修正后（§8.1）也提取了 details，路径统一。

---

## 9. 前端侧改动

### 9.1 GuiComponent 渲染路由（审查 S2——custom 注册机制）

```typescript
// renderer/src/components/panel/message-stream/GuiComponentRenderer.vue
<script setup lang="ts">
import type { GuiComponent } from '@xyz-agent/extension-protocol'
import AnsiText from './gui/AnsiText.vue'
import TaskList from './gui/TaskList.vue'
import GoalStatus from './gui/GoalStatus.vue'
import WorkflowRuns from './gui/WorkflowRuns.vue'
import SubagentTrace from './gui/SubagentTrace.vue'
import CustomFallback from './gui/CustomFallback.vue'  // 通用 key-value 渲染器

// 内置类型映射。custom 类型不在此映射中——见下方说明。
const BUILTIN_MAP: Record<string, any> = {
  'ansi-text': AnsiText,
  'task-list': TaskList,
  'goal-status': GoalStatus,
  'workflow-runs': WorkflowRuns,
  'subagent-trace': SubagentTrace,
}

// 运行时注册表：xyz-agent 内置 extension 的 custom 组件在编译期注册
// 外部 extension 的 custom 组件无法注册（Vue 组件定义无法通过 WS 传输）
const CUSTOM_MAP = inject<Record<string, Component>>('gui-custom-registry', {})

const props = defineProps<{ component: GuiComponent }>()

const resolved = computed(() => {
  if (props.component.type === 'custom') {
    const name = (props.component.props as { component?: string }).component
    return CUSTOM_MAP[name ?? ''] ?? CustomFallback  // 未注册 → 通用渲染器
  }
  return BUILTIN_MAP[props.component.type] ?? AnsiText
})
</script>

<template>
  <component :is="resolved" v-bind="props.component.props" />
</template>
```

**custom 类型约束**（审查 S2）：外部（用户安装的）extension 的 custom 组件无法在前端注册——Vue 组件定义需要编译期打包，不能通过 WS 传输。因此：
- **内置 extension**（pi-todo/goal/workflow/subagents）的 custom 组件在 xyz-agent 编译期注册到 `CUSTOM_MAP`
- **外部 extension** 用内置类型（task-list/goal-status 等），或降级到 `CustomFallback`（通用 key-value 卡片渲染器，类似 BgNotifyCard）

### 9.2 Block.vue 集成（审查 S6——不能直接落地）

Block.vue 当前结构：折叠态 header（1 行）+ 展开态详情（`<template v-if="toolExpanded">`），且 subagent 有独立分支。GuiComponentRenderer 插入在**展开态详情内**，替换原来的纯文本 result：

```vue
<!-- 普通 tool 块展开态（Block.vue 约 101-116 行） -->
<template v-if="toolExpanded">
  <div class="mt-1 font-mono text-[12px] text-fg">
    <span :class="isFailed ? 'text-danger' : 'text-info'">{{ toolName }}</span>
    <span class="text-muted">({{ argPath }})</span>
  </div>
  <!-- ★ __gui__ 优先 → 结构化渲染 -->
  <GuiComponentRenderer
    v-if="guiComponent"
    :component="guiComponent"
  />
  <!-- ★ 无 __gui__ → ANSI 渲染（需先加 outputRaw 字段，见下方）-->
  <div
    v-else-if="result"
    class="mt-1 inline-flex items-start gap-1 pl-0.5 font-mono text-[12px] leading-snug whitespace-pre-wrap"
    :class="isFailed ? 'border-l-2 border-danger pl-2 text-danger' : 'text-muted'"
  >
    <Check v-if="!isFailed" class="mt-0.5 size-3 shrink-0 text-success" />
    <XCircle v-else class="mt-0.5 size-3 shrink-0 text-danger" />
    <AnsiText v-if="ansiContent" :content="ansiContent" />
    <span v-else>{{ result }}</span>
  </div>
</template>
```

```typescript
// Block.vue script 新增 computed
import { extractGui } from '@xyz-agent/extension-protocol'

const guiComponent = computed(() => extractGui(props.tool?.details)?.component)

// ANSI 兜底：ToolCall 需新增 outputRaw 字段（保留原始 ANSI）
// shared/src/message.ts: ToolCall 加 outputRaw?: string
// event-adapter handleToolExecutionEnd: output 不 stripAnsi，额外存 outputRaw
const ansiContent = computed(() => props.tool?.outputRaw)
```

### 9.3 SideDrawer widget 渲染

- 新增 `extension:widgetGui` WS 订阅（SideDrawer.vue 约 288 行旁加 `onMessage`）
- 新增 `activeGuiComponent` ref，与 `activeLines` 互斥
- `mapWidgetKeyToTab` 扩展：识别 pi-todo/goal/workflow 的 widgetKey 路由到对应 tab
- 模板加 `v-else-if="activeGuiComponent"` 分支渲染 `<GuiComponentRenderer>`

### 9.4 全局 Status Bar（审查 C5——状态提升）

当前 status 绑死在 SideDrawer footer（SideDrawer.vue:104-116），SideDrawer 用 v-if 卸载时 status 丢失。需提取 composable：

```typescript
// renderer/src/composables/useExtensionStatus.ts
const statusMaps = new Map<string, Ref<Map<string, string>>>()  // 按 sessionId 分区

export function useExtensionStatus(sessionId: Ref<string | null>) {
  // 从 SideDrawer 移出订阅逻辑 + statusMap
  // 注册 extension:status 订阅（useSessionEvents）
  // 返回 computed statusEntries
}
```

挂载点：`Workspace.vue` 底部（PanelContainer 的兄弟节点），不依赖 SideDrawer 开关。

### 9.5 ExtensionUIDialog（审查 F2——P1 同期交付）

实现 `extension.ui_request` 的 handler，渲染 confirm/select/input/notify 对话框。xyz-ui 基建已齐全：
- confirm → `ConfirmDialog.vue`（已封装）
- select → `Select.vue` + Dialog 壳
- input/editor → `Input.vue` / `Textarea.vue` + Dialog 壳
- notify → `ToastContainer.vue`

**回复通道**（审查遗漏）：用户操作后前端发 `extension.ui_response` WS 帧：

```typescript
// renderer/src/api/domains/extension.ts 新增
export function sendExtensionUIResponse(sessionId: string, requestId: string, result: boolean | string | null) {
  ws.send({
    type: 'extension.ui_response',
    payload: { sessionId, requestId, result },
  })
}
```

runtime 的 `extension-message-handler.ts:75-91` 已处理此消息 → 注入回 pi stdin → pi 的 select/confirm/input Promise resolve。

---

## 10. extension 编写指南

### 10.1 迁移步骤

以 pi-todo 为例：

1. **安装协议包**：`npm install @xyz-agent/extension-protocol`
2. **execute 分支**：在 execute 返回处加 `if (ctx.mode === 'rpc')` 分支，构造 `details.__gui__`
3. **widget 分支**：refreshDisplay 加 `if (ctx.mode === 'rpc')` 分支，调 `guiSetWidget()`
4. **renderResult 保持**：TUI 的 renderResult 不动，RPC 模式下不会被调用

### 10.2 最小改动模板

```typescript
import { guiResult, guiSetWidget, isGuiCapable, PROTOCOL_VERSION } from '@xyz-agent/extension-protocol'

execute(toolCallId, params, signal, onUpdate, ctx) {
  const data = doWork(params)
  const content = [{ type: 'text' as const, text: formatForLLM(data) }]

  if (isGuiCapable(ctx)) {
    return {
      content,
      details: {
        ...data,
        __gui__: guiResult({
          type: 'task-list',  // 或其他内置类型 / custom
          props: { /* ... */ },
        }),
      },
    }
  }

  return { content, details: { ...data } }
}
```

### 10.3 不使用协议包的 extension

不引入协议包的 extension 不受影响——`details.__gui__` 不存在，前端走纯文本 / ANSI 兜底。协议是渐进增强，不是强制要求。

---

## 14. ASCII 布局→结构化映射

### 14.1 问题：extension 自画 ASCII 布局

pi 的 Box 组件**不画 Unicode 边框**（只做 padding + 背景），所以 extension 被迫在代码里手写 `┌─┐││└─┘` / `╭╮╰╯` 拼接逻辑（含 ANSI 安全截断、宽度计算、padding 对齐）。

已确认的自画边框实例：
- `ask-user/src/component.ts:124-129`——box `┌┐└┘─│`
- `subagents/src/tui/bg-notify-render.ts:114-177`——`╭╮╰╯─│`（注释明确「为何不用 Box 组件：Box 不画 Unicode 边框」）
- `subagents/src/tui/list-component.ts:255-361`——`│├┬┴┤─` 双列表格
- `workflow/src/interface/views/WorkflowsView.ts:107-109,547-599`——完整 `╭╮╰╯├┤│─` + sidebar divider
- `todo/src/render.ts:88-107`——双列 `│` 分隔
- `goal/src/projection/widget.ts:76-80`——progress bar `█░`

### 14.2 TUI 字符三类映射

extension 的 TUI 字符分三类，每类有不同的 GUI 处理方式：

#### A 类：语义 glyph（~50%）→ lucide 图标 + 语义色

有语义含义的字符，GUI 下用图标库替代，**完全不保留 ASCII**：

| TUI glyph | 语义 | GUI 曠代 | 出现的 extension |
|-----------|------|---------|-----------------|
| `✓` | 完成/成功 | `<Check>` text-success | 全部 |
| `✗` `✕` | 失败/取消 | `<XCircle>` text-danger | subagents/todo/workflow |
| `●` | 进行中 | `<CircleDot>` text-warning | todo/workflow |
| `○` | 待办 | `<Circle>` text-subtle | todo |
| `■` | cancelled | `<Square>` text-muted | subagents |
| `◆` | goal 标识 | `<Target>` text-accent | goal |
| `☑` | todo 标识 | `<ListChecks>` text-accent | todo |
| `⏸` | paused | `<Pause>` text-warning | goal/workflow |
| `⊘` | blocked | `<OctagonX>` text-danger | goal |
| `⊗` | 预算耗尽 | `<CircleSlash>` text-danger | goal |
| `⏱` | 时间耗尽 | `<Timer>` text-danger | goal |
| `→` | tool 调用 | `<ArrowRight>` text-info | subagents/workflow |
| `∘` | turn 摘要 | `<Circle>` text-subtle | workflow |
| `❯` `>` | 选中指针 | CSS（active 项样式） | workflow/ask-user |
| `[✓]` `[ ]` | checkbox | `<Checkbox>` 组件 | ask-user |
| `⠋⠙⠹…` | spinner 动画 | `<Loader2 class="animate-spin">` | subagents |

协议处理方式：这些 glyph 不出现在 GuiComponent 的 props 数据里——前端组件内部按 status/icon 字段渲染对应图标。extension 侧只需传语义数据（如 `{status: 'completed'}`），前端组件自动映射到 Check 图标。

#### B 类：布局字符（~30%）→ CSS 布局，完全不保留

纯视觉排版字符，GUI 下用 CSS 替代：

| TUI 字符 | 用途 | GUI 替代 | 协议组件 |
|---------|------|---------|---------|
| `┌─┐││└─┘` `╭╮╰╯` | box 边框 | CSS `border` + `rounded-md` | `card` |
| `─` `═══` | 水平分隔线 | CSS `border-t` 或 `<hr>` | `card.header` 分隔 |
| `│` | 列分隔 | CSS `grid` / `gap` | `columns` |
| `  ⎿ ` | 层级缩进 | CSS `padding-left` / `border-l` | `list-tree`（depth 字段）|
| `████░░░░` | progress bar | CSS `<progress>` 或 div+width | `progress-bar` |
| `├┤┬┴┼` | T 型连接 | CSS grid 边框 | `columns` + `card` |
| `tab │ tab` | 标签栏分隔 | CSS `gap` + active 样式 | `tab-bar` |

协议处理方式：这些字符不出现在 GuiComponent 的 props 数据里。前端组件用 CSS 实现：
- `card`：`rounded-md border border-border` + variant 淡底色（`color-mix`）
- `columns`：`grid` + `gap`，`ratios` 转为 `grid-template-columns`
- `list-tree`：递归渲染，每层 `padding-left` + 左 `border-l`
- `progress-bar`：`<div>` + inner `<div style="width: pct%">`

#### C 类：数据格式化（~20%）→ 结构化字段

信息编码字符串，GUI 下拆成数据字段：

| TUI 格式 | 数据结构 | 协议字段 |
|---------|---------|---------|
| `N turns · Nk · Ns` | `{turns, tokens, duration}` | `stats-line.items[]` |
| ` | N% tokens` | `{tokenPct}` | `progress-bar`（current/total 算出 pct）|
| `Token: Nk/Mk (P%)` | `{used, total, percent}` | `progress-bar` + `MetricBar` |
| `N/M agents` | `{completed, total}` | `task-list.summary` 或 `stats-line` |

协议处理方式：extension 不格式化文本，直接传数值字段。前端组件负责格式化显示（`12.4k tokens` 等）。

### 14.3 嵌套组合

布局原语可嵌套组合表达复杂布局。例：pi-workflow 的 WorkflowsView（sidebar + main + footer）：

```typescript
// extension 构造的 GuiComponent
{
  type: 'card',
  props: {
    variant: 'default',
    body: [
      {
        type: 'columns',
        props: {
          ratios: [1, 2],  // sidebar 窄、main 宽
          children: [
            // 左列：phase 列表
            { type: 'list-tree', props: { items: phaseItems } },
            // 右列：agent 列表（可滚动）
            { type: 'list-tree', props: { items: agentItems } },
          ],
        },
      },
      {
        type: 'stats-line',
        props: { items: [{ value: '↑↓ navigate · ⏎ enter · esc back' }] },
      },
    ],
  },
}
```

### 14.4 各 extension 的结构化覆盖度

| Extension | 覆盖度 | 主组件 | 需要的布局原语 |
|-----------|--------|--------|--------------|
| pi-todo | 100% | `task-list` | 双列 `columns`（>8 项时）|
| pi-goal | 100% | `goal-status` + `progress-bar` | — |
| pi-subagents | 95% | `subagent-trace` | `card`(bg-notify) + `list-tree`(eventLog) + `stats-line` |
| pi-workflow | 90% | `card` + `columns` + `list-tree` | sidebar+main 双列 + 滚动区 |
| pi-ask-user | 85%（渲染）/ 需原生交互 | `interaction` | `card` + `tab-bar` + `columns`(分屏) |
| pi-statusline | 100% | `stats-line` | — |

**无法结构化的残留**（~5%）：
- pi-workflow 的三级虚拟滚动 viewport（TUI 手动管理 scrollOffset）——GUI 用 CSS `overflow-y: auto` 原生处理
- pi-ask-user 的键盘交互逻辑（光标导航、freeform 编辑）——必须 GUI 原生实现，不能靠单向数据描述

---

## 15. GUI 渲染映射——各入口当前能力与协议对接

### 15.1 当前渲染能力总览

| 渲染入口 | 当前能力 | DOM 结构 | 协议对接改动 |
|---------|---------|---------|-------------|
| **tool result** | 纯文本 `{{ result }}` | Block.vue: `<span>{{ result }}</span>` + `font-mono whitespace-pre-wrap` | 加 `GuiComponentRenderer` 分支 + `AnsiRenderer` 兜底 |
| **widget** | 纯文本每行 `<code>` | SideDrawer.vue: `v-for line in activeLines` → `<code>{{ line }}</code>` | 加 `extension:widgetGui` 订阅 + `GuiComponentRenderer` 分支 |
| **status** | 纯文本 footer | SideDrawer.vue: `<footer><span>key</span><span>text</span></footer>` | 提取 `useExtensionStatus()` composable + 挂载到 Workspace 底部 |
| **custom message** | BgNotifyCard（结构化）/ SystemNotice（纯文本）| MessageStream.vue: `v-else-if="bgNotify"` | 加 `message.details.__gui__` 检测 + `GuiComponentRenderer` |
| **dialog** | **不存在** | — | 新建 `ExtensionUIDialog` + `extension.ui_request` handler |

### 15.2 已有结构化范例的 CSS 约定（协议前端组件必须遵循）

xyz-agent 已有 3 个结构化渲染范例，协议新增组件必须对齐其 CSS 约定：

| 约定 | 范例来源 | 具体用法 |
|------|---------|---------|
| Tailwind 工具类内联 | 全部 | `flex flex-wrap items-center gap-x-3` |
| CSS 变量语义色 | BgNotifyCard | `text-danger`、`text-success`、`text-info`、`text-reasoning` |
| `color-mix` 状态淡底 | BgNotifyCard | `bg-[color-mix(in_oklch,var(--danger)_5%,transparent)]` |
| lucide-vue-next 图标 | BgNotifyCard / Block.vue | `size-3`（12px）尺寸约定 |
| `font-mono` 等宽小字 | Block.vue stats 行 | `text-[11px]` 或 `text-[12px]` |
| 卡片形态 | BgNotifyCard / ChangeSetCard | `rounded-md border px-3 py-2` |

### 15.3 前端组件清单与设计

协议需要新增的前端 Vue 组件（`packages/renderer/src/components/panel/message-stream/gui/`）：

| 组件 | 对应 GuiComponent type | CSS 布局核心 | 设计参考 |
|------|----------------------|-------------|---------|
| `AnsiText.vue` | `ansi-text` | `ansi_up` → `<span>` 着色 | 新建（引入 ansi_up 依赖）|
| `TaskList.vue` | `task-list` | `flex flex-col` + 状态 icon/色 + progress bar | Block.vue subagentProgressDetail 的 flex 模式 |
| `GoalStatus.vue` | `goal-status` | header + MetricBar[] flex | BgNotifyCard 的 header+body 模式 |
| `WorkflowRuns.vue` | `workflow-runs` | run 列表 + status badge | ChangeSetCard 的列表模式 |
| `SubagentTrace.vue` | `subagent-trace` | stats-line + list-tree(eventLog) + delivery | Block.vue subagent 分支增强 |
| `Card.vue` | `card` | `rounded-md border` + variant + header/body slots | BgNotifyCard 的卡片容器 |
| `StatsLine.vue` | `stats-line` | `flex flex-wrap gap-x-3` | Block.vue:63-69 的 stats 行 |
| `ProgressBar.vue` | `progress-bar` | `<div>` + inner `<div style="width%">` | 新建 |
| `ListTree.vue` | `list-tree` | 递归组件 + `padding-left` depth | 新建 |
| `Columns.vue` | `columns` | `grid` + `grid-template-columns` | 新建 |
| `TabBar.vue` | `tab-bar` | `flex gap-1` + active 样式 | 新建 |
| `CustomFallback.vue` | `custom`（未注册时）| 通用 key-value 渲染 | 新建 |

### 15.4 渲染挂载点

| 渲染入口 | 挂载位置 | 文件:行号 |
|---------|---------|----------|
| tool result GuiComponent | Block.vue 展开态详情内 | Block.vue:101-116（替换纯文本 `<span>`）|
| widget GuiComponent | SideDrawer.vue activeLines 区 | SideDrawer.vue:73-90（新增 `activeGuiComponent` 分支）|
| custom message GuiComponent | MessageStream.vue system 消息分支 | MessageStream.vue:25（新增 `v-else-if`）|
| 全局 status bar | **Workspace.vue 底部** | Workspace.vue:8（PanelContainer 之后新增兄弟元素）|
| ExtensionUIDialog | **全局 portal** | 新建，reka-ui Dialog portal 到 body |
| ask-user overlay | **Composer.vue composer 区** | Composer.vue:10-13（`<div class="composer">` 内 RetryIndicator 之前）|

---

## 11. 实施分阶段

> **审查修正**：ExtensionUIDialog 从 P3 提升为 P1（审查 F2）——否则 guiInteract RPC 分支是死代码。

| Phase | 范围 | 工作量 |
|---|---|---|
| **P0: ANSI 兜底 + 历史路径修复** | tool output ANSI 渲染（ansi_up + Block.vue + outputRaw 字段）+ message-converter.ts details 透传修复（F1）+ handleToolExecutionUpdate details 提取（S5） | ~2 天 |
| **P1: 协议包 + ExtensionUIDialog** | @xyz-agent/extension-protocol 包（类型 + helpers）+ event-adapter widget marker 解码 + shared/protocol.ts 三处类型（S4）+ Message.details 字段（S3）+ ExtensionUIDialog 组件 + extension.ui_request handler + extension.ui_response 回传通道 | ~4 天 |
| **P2: 前端渲染器** | GuiComponentRenderer + 5 个内置组件 Vue 组件 + custom 注册机制（S2）+ widgetGui 路由 + useExtensionStatus composable + 全局 status bar | ~3 天 |
| **P3: 富交互** | interaction 组件 + multiSelect 结构化 response + 前端富交互 UI | ~3 天 |
| **P4: extension 迁移** | pi-todo / pi-goal / pi-workflow / pi-subagents / ask-user 逐个迁移 | ~1 天/extension |

---

## 12. 与 pi 协议的关系

本协议**不修改 pi 源码**，**不覆盖 pi 原有行为**。具体：

- TUI 模式下 extension 的 renderResult/renderCall/setWidget(custom factory)/registerMessageRenderer 照常工作
- RPC 模式下 pi 原有的 setWidget(string[]) / setStatus / select / confirm / input 行为不变
- `details.__gui__` 是 extension 自主放入的额外字段，pi 原样透传（agent-session.js `result: event.result` 零过滤），不与 pi 的任何逻辑冲突
- 协议包是纯类型 + helper，零运行时副作用，不引入对 pi 的依赖

**如果 pi 未来原生支持结构化 GUI 渲染**（如 RPC 模式透传 renderResult 的结构化数据），本协议可以平滑迁移——extension 只需把 `details.__gui__` 的构造逻辑移到 pi 原生支持的通道里。

---

## 13. 审查修正日志

v1-draft 经 4 路并行技术审查（shim 可行性 / 交互层 / 数据链路 / 前端路由），修正如下：

### 致命问题（阻塞落地）

| ID | 问题 | 修正 |
|---|---|---|
| **F1** | `message-converter.ts:73-95` toolResult 分支不读 details，重开 session 后 `__gui__` 全丢，违反 [HISTORICAL] 规则 7.5 | §8.2 补 details 透传 + `PiHistoryToolResult` 类型补 `details?` 字段 |
| **F2** | 前端无 `extension.ui_request` handler，guiInteract RPC 分支不可用，select() 卡 5 分钟超时 | §6.1 明确标注致命约束；ExtensionUIDialog 从 P3 提为 P1（§11）|

### 严重问题（需改设计/文档）

| ID | 问题 | 修正 |
|---|---|---|
| **S1** | shim extension 对 widget 场景多此一举——helper 直编码即可 | §7 整节移除，§4.3 改为 `guiSetWidget()` helper 直编码 |
| **S2** | custom 组件注册机制完全空白，外部 extension 自定义组件名无法路由 | §9.1 明确约束：内置 extension 编译期注册，外部用内置类型或 CustomFallback |
| **S3** | Message 类型无 details 字段，custom message 方案前端拿不到 `__gui__` | §8.4 Message 加 `details?` + customStart handler 改造 |
| **S4** | shared/protocol.ts 三处类型缺失（ServerMessageType / ServerMessageMap / EXTENSION_EVENTS） | §8.3 补全三处 |
| **S5** | handleToolExecutionUpdate 把整个 partialResult 塞进 detail（单数），没提取 details | §8.1 补提取逻辑 |
| **S6** | Block.vue 集成代码不能直接落地（outputRaw 不存在 + 渲染结构假设错误）| §9.2 重写，明确插入位置和 ToolCall.outputRaw 新增 |

### 可简化项

| ID | 问题 | 修正 |
|---|---|---|
| **C1** | shim extension | 砍掉（见 S1）|
| **C2** | undefined 序列化约定缺失 | guiResult() helper strip undefined（协议层约定）|
| **C3** | extractGui() 类型守卫 helper | §8.5 提供 |
| **C4** | ToolCall.details vs detail 命名陷阱 | §8.5 显式标注 |
| **C5** | statusMap 绑死 SideDrawer | §9.4 提取 useExtensionStatus() composable |
| **C6** | WS payload 大小防御 | 协议层约定 GuiComponent 体积上限 |

### 行号引用修正

文档中行号引用（agent-session.js:451 / rpc-mode.js:264 / jsonl.js:8 等）会随 pi 版本漂移。实现时应以函数名为准（`_emitExtensionEvent` / `serializeJsonLine` / `createExtensionUIContext`）。
