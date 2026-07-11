# Extension GUI 协议接入指南

> **面向**：pi extension 开发者
> **目标**：将现有 TUI-only extension 改造为 TUI/GUI 双模，在 xyz-agent 桌面端获得结构化 GUI 渲染
> **协议规范全文**：[docs/architecture/extension-gui-protocol.md](../architecture/extension-gui-protocol.md)（内部设计文档，含链路验证、审查修正日志）

---

## 1. 问题：为什么需要改造

xyz-agent 以 `--mode rpc` 运行 pi。RPC 模式下，pi 的 5 个渲染入口全部失效：

| pi 渲染入口 | 用途 | RPC 模式行为 |
|---|---|---|
| `ToolDefinition.renderResult` | tool 结果展示 | **no-op**（从不调用） |
| `ctx.ui.setWidget(factory)` | editor 上下方面板 | **factory 被丢弃**，仅 `string[]` 生效 |
| `ctx.ui.setStatus(key, text)` | 状态栏 | 有效（但 stripAnsi 丢色） |
| `registerMessageRenderer` | 自定义消息卡片 | **no-op**（从不调用） |
| `ctx.ui.custom(factory)` | 交互式组件 | **返回 undefined**（崩溃） |

原因：pi 的 `Component { render(width): string[] }` 返回 ANSI 文本行，不可序列化进 JSON-RPC。

**解决思路**：extension 在 `execute()` 内部按 `ctx.mode` 分支——TUI 走原生 `Component`，RPC 走结构化 `GuiComponent`（可序列化的 `{ type, props }`）。代码只写一版，运行时自动路由。

---

## 2. 快速开始

### 2.1 安装协议包

```bash
npm install @xyz-agent/extension-protocol
# 或
pnpm add @xyz-agent/extension-protocol
```

协议包是纯 TypeScript 类型 + helper 函数，零运行时依赖。

### 2.2 最小改造模板

改造前（TUI-only）：

```typescript
export const myTool: ToolDefinition = {
  name: 'my_tool',
  description: 'Do something',
  async execute(toolCallId, params, signal, onUpdate, ctx) {
    const result = doWork(params)
    // TUI 模式下 pi 调 renderResult 渲染 Component
    return {
      content: [{ type: 'text', text: result.summary }],
      details: { data: result.data },
    }
  },
  // renderResult 返回 ANSI Component —— RPC 模式下从不调用
  renderResult(result) {
    return new MyTuiComponent(result.details.data)
  },
}
```

改造后（TUI/GUI 双模）：

```typescript
import {
  isGuiCapable,
  guiResult,
  guiComponent,
  type GuiContext,
} from '@xyz-agent/extension-protocol'

export const myTool: ToolDefinition = {
  name: 'my_tool',
  description: 'Do something',
  async execute(toolCallId, params, signal, onUpdate, ctx) {
    const result = doWork(params)

    const details: { data: unknown; __gui__?: unknown } = { data: result.data }

    // ★ RPC 模式：构造结构化 GUI 组件放进 details.__gui__
    if (isGuiCapable(ctx as GuiContext)) {
      details.__gui__ = guiResult(
        guiComponent('task-list', {
          items: result.tasks.map(t => ({
            id: t.id,
            text: t.label,
            status: t.done ? 'completed' : 'pending',
          })),
          summary: `${result.tasks.filter(t => t.done).length}/${result.tasks.length} done`,
        })
      )
    }
    // TUI 模式：details 不含 __gui__，pi 调 renderResult 渲染 Component

    return {
      content: [{ type: 'text', text: result.summary }],
      details,
    }
  },
  renderResult(result) {
    // TUI 模式下仍走原生 Component 渲染，不受影响
    return new MyTuiComponent(result.details.data)
  },
}
```

核心模式只有三步：
1. `isGuiCapable(ctx)` 检测 RPC 模式
2. `guiComponent(type, props)` 构造结构化组件
3. `guiResult(component)` 包装后放进 `details.__gui__`

---

## 3. 渲染入口点适配

五个渲染入口点各有不同的适配方式。下表是快速索引，后续逐节详解。

| 入口点 | 适配方式 | 数据通道 | 双向交互 |
|---|---|---|---|
| renderResult（tool 结果） | `details.__gui__` | tool_execution_end → WS | 否 |
| setWidget（持久面板） | `guiSetWidget(ctx, key, component)` | NUL marker 编码 → `extension:widgetGui` | 否 |
| setStatus（状态栏） | pi 原生，无需改造 | `extension:status`（含 textRaw） | 否 |
| ctx.ui.custom（交互式） | `guiInteract(ctx, questions)` | 降级为 dialog 序列 | 是 |
| registerMessageRenderer（消息卡片） | `message.details.__gui__` | customMessage → WS | 否 |

### 3.1 renderResult：tool 结果结构化渲染

最常用的入口。extension 在 `execute()` 返回时构造 `details.__gui__`，前端在 tool 结果块展开态检测到 `__gui__` 后渲染结构化组件。

```typescript
import { isGuiCapable, guiResult, guiComponent, type GuiContext } from '@xyz-agent/extension-protocol'

async execute(toolCallId, params, signal, onUpdate, ctx) {
  const data = await fetchData(params)

  const details: Record<string, unknown> = { source: 'api' }

  if (isGuiCapable(ctx as GuiContext)) {
    details.__gui__ = guiResult(
      guiComponent('stats-line', {
        items: [
          { label: '总数', value: String(data.total) },
          { label: '成功', value: String(data.success), severity: 'ok' },
          { label: '失败', value: String(data.failed), severity: data.failed > 0 ? 'danger' : 'ok' },
        ],
      })
    )
  }

  return {
    content: [{ type: 'text', text: `Fetched ${data.total} items` }],
    details,
  }
}
```

**注意事项**：
- `__gui__` 必须放在 `result.details` 下（整体透传），不能放在 `result.content` 内（content 会被 runtime 过滤成 text/image，`__gui__` 丢失）
- `content` 里的 text 仍然会展示给 LLM（content 是 LLM 可见的），`details` 里的 `__gui__` 只给前端渲染用
- 重开 session 后 `__gui__` 仍可见——runtime 已修复历史路径透传（message-converter.ts F1 修复）

### 3.2 setWidget：持久化面板

Widget 是 editor 上下方持续存在的面板（如 pi-todo 的任务列表）。RPC 模式下 `ctx.ui.setWidget` 的 factory 参数被丢弃，只有 `string[]` 生效。

`guiSetWidget()` helper 把 GuiComponent 编码为 NUL 标记前缀的 JSON 字符串，runtime event-adapter 检测标记后解码为结构化 WS 帧。

```typescript
import { guiSetWidget, guiComponent, type GuiContext } from '@xyz-agent/extension-protocol'

// 在 tool execute 或 event handler 中：
async execute(toolCallId, params, signal, onUpdate, ctx) {
  const tasks = await getTasks()

  // ★ RPC 模式：编码 GuiComponent 进 string[]
  guiSetWidget(ctx as GuiContext, 'my-widget', guiComponent('task-list', {
    items: tasks.map(t => ({ id: t.id, text: t.text, status: t.status })),
    summary: `${tasks.length} tasks`,
  }))

  // TUI 模式：guiSetWidget 无操作，需自行调原生 ctx.ui.setWidget
  if (ctx.mode === 'tui') {
    ctx.ui.setWidget('my-widget', new MyWidgetComponent(tasks))
  }

  return { content: [{ type: 'text', text: 'Widget updated' }], details: {} }
}
```

**清除 widget**：

```typescript
guiSetWidget(ctx as GuiContext, 'my-widget', undefined)
```

**注意事项**：
- TUI 模式下 `guiSetWidget()` 是 no-op，extension 必须自行调原生 `ctx.ui.setWidget` 传 Component factory
- 不需要手动拼接 NUL 标记或 JSON.stringify——helper 已封装
- 前端通过 `extension:widgetGui` WS 消息接收，路由到对应 widgetKey 的面板

### 3.3 setStatus：状态栏

**无需改造**。pi 的 `ctx.ui.setStatus(key, text)` 在 RPC 模式下已有效，runtime 会广播 `extension:status` 消息。

唯一改进：runtime 现在同时保留 `text`（stripAnsi 纯文本，向后兼容）和 `textRaw`（原始 ANSI 文本，前端可做 ANSI 着色）。extension 不需要改代码即可获益。

```typescript
// 现有代码无需改动
ctx.ui.setStatus('my-ext:status', '\x1b[32m● Running\x1b[0m')
// 前端收到 { text: '● Running', textRaw: '\x1b[32m● Running\x1b[0m' }
```

### 3.4 ctx.ui.custom：交互式组件

`ctx.ui.custom()` 在 RPC 模式下返回 undefined（崩溃）。`guiInteract()` helper 在 RPC 模式降级为 `ctx.ui.select()` / `input()` / `confirm()` 序列，前端通过 ExtensionUIDialog 渲染标准对话框。

```typescript
import { guiInteract, type InteractionQuestion, type GuiContext } from '@xyz-agent/extension-protocol'

async execute(toolCallId, params, signal, onUpdate, ctx) {
  const questions: InteractionQuestion[] = [
    {
      header: '部署目标',
      question: '选择部署环境',
      options: [
        { label: '生产环境', value: 'prod', description: '正式环境，需审批' },
        { label: '预发环境', value: 'staging', description: '预发布验证' },
        { label: '测试环境', value: 'dev', description: '开发测试' },
      ],
    },
    {
      header: '确认信息',
      question: '输入发布说明',
    },
  ]

  const answers = await guiInteract(ctx as GuiContext, questions, { signal })

  if (answers === null) {
    return {
      content: [{ type: 'text', text: '用户取消' }],
      details: { cancelled: true },
    }
  }

  // answers = { '部署目标': 'prod', '确认信息': '修复登录bug' }
  return {
    content: [{ type: 'text', text: `部署到 ${answers['部署目标']}` }],
    details: { answers },
  }
}
```

**RPC 模式降级行为**：

| 问题类型 | RPC 降级方式 | 前端渲染 |
|---|---|---|
| 单选（有 options，无 multiSelect） | `ctx.ui.select()` | Select 下拉 |
| 多选（有 options + multiSelect） | 逐项 `ctx.ui.confirm()` | 多个确认对话框（体验有限） |
| 自由输入（无 options） | `ctx.ui.input()` | Input 文本框 |

**TUI 模式**：`guiInteract` 调 `ctx.ui.custom()`，extension 需自行提供 TUI Component（与改造前一致）。

**当前限制**（P3 会扩展）：
- 多选降级为逐项 confirm，无 checkbox UI
- 无 tab/分屏/freeform 等富交互（前端 ExtensionUIDialog 只支持 confirm/select/input/editor/notify）

### 3.5 registerMessageRenderer：自定义消息卡片

extension 通过 `ctx.sendMessage()` 发送自定义消息时，在 `details.__gui__` 附带 GuiComponent，前端会渲染为自定义消息卡片。

```typescript
import { isGuiCapable, guiResult, guiComponent, type GuiContext } from '@xyz-agent/extension-protocol'

// 在 event handler 或 tool execute 中：
async onMessage(msg, ctx) {
  if (msg.type === 'some_event') {
    const details: Record<string, unknown> = { event: msg.type }

    if (isGuiCapable(ctx as GuiContext)) {
      details.__gui__ = guiResult(
        guiComponent('card', {
          variant: 'elevated',
          header: '事件通知',
          body: [
            guiComponent('stats-line', {
              items: [
                { label: '类型', value: msg.type },
                { label: '时间', value: new Date().toLocaleTimeString() },
              ],
            }),
          ],
        })
      )
    }

    ctx.sendMessage({
      role: 'user',
      content: [{ type: 'text', text: `Event: ${msg.type}` }],
      customMessageType: 'my-event',
      details,
    })
  }
}
```

---

## 4. GuiComponent 类型参考

13 个内置类型，按用途分组。当前前端渲染状态见每类型标注。

### 4.1 数据展示类

#### ansi-text — ANSI 文本兜底

```typescript
guiComponent('ansi-text', {
  lines: ['\x1b[32m成功\x1b[0m: 操作完成', '\x1b[31m失败\x1b[0m: 2 个错误'],
})
```

**渲染状态**：已实现。使用 ansi_up 库渲染，escape_html=true（XSS 安全）。

适用于不改造的第三方 extension——runtime 保留 tool 结果的原始 ANSI 文本（`outputRaw` 字段），前端自动用 AnsiText 渲染。

#### task-list — 任务列表

```typescript
guiComponent('task-list', {
  items: [
    { id: 1, text: '读取配置', status: 'completed' },
    { id: 2, text: '执行迁移', status: 'in_progress' },
    { id: 3, text: '验证结果', status: 'pending' },
  ],
  summary: '1/3 done',
})
```

**渲染状态**：P2 待实现。当前降级为 JSON 文本展示。

#### goal-status — Goal 状态卡片

```typescript
guiComponent('goal-status', {
  status: 'active',           // 'active' | 'paused' | 'blocked' | 'complete' | 'budget_limited' | 'time_limited' | 'cancelled'
  title: '重构认证模块',
  slug: 'auth-refactor',
  turn: 5,
  metrics: [
    { label: '预算', current: 45000, total: 100000, unit: 'tokens', severity: 'ok' },
    { label: '用时', current: 12, total: 30, unit: 'min', severity: 'warn' },
  ],
})
```

**渲染状态**：P2 待实现。

#### workflow-runs — 工作流 run 列表

```typescript
guiComponent('workflow-runs', {
  runs: [
    { runId: 'r1', name: 'CI Build', status: 'done', reason: 'completed', durationMs: 45000 },
    { runId: 'r2', name: 'Deploy', status: 'running' },
    { runId: 'r3', name: 'Rollback', status: 'done', reason: 'failed', error: 'Connection refused' },
  ],
})
```

**渲染状态**：P2 待实现。

#### subagent-trace — Subagent 执行轨迹

```typescript
guiComponent('subagent-trace', {
  agent: 'code-reviewer',
  status: 'done',             // 'running' | 'done' | 'failed' | 'cancelled' | 'crashed'
  stats: { turns: 8, tokens: 12300, durationMs: 32000, toolCount: 5 },
  eventLog: [
    { type: 'tool_start', label: 'Read file.ts', status: 'done' },
    { type: 'tool_end', label: 'Read file.ts', status: 'done' },
    { type: 'error', label: 'File not found', status: 'failed' },
  ],
  result: 'Review complete: 3 issues found',
})
```

**渲染状态**：P2 待实现。

### 4.2 布局原语类

用于组合其他组件，替代 TUI 的 ASCII 布局（`┌─┐││└─┘` box 边框、`│` 列分隔等）。

#### card — 卡片容器

```typescript
guiComponent('card', {
  variant: 'elevated',        // 'default' | 'elevated' | 'danger' | 'success'（可选）
  header: '构建结果',          // GuiComponent | string（可选）
  body: [
    guiComponent('stats-line', { items: [...] }),
    guiComponent('progress-bar', { current: 8, total: 10, label: '测试' }),
  ],
})
```

#### stats-line — 统计行

```typescript
guiComponent('stats-line', {
  items: [
    { label: '通过', value: '80', severity: 'ok' },
    { label: '失败', value: '3', severity: 'danger' },
    { label: '跳过', value: '7', severity: 'warn' },
    { value: '120ms', icon: 'check' },  // label 和 severity 可选
  ],
})
```

#### progress-bar — 进度条

```typescript
guiComponent('progress-bar', {
  label: '下载进度',
  current: 75,
  total: 100,
  unit: '%',                  // 可选
  severity: 'ok',             // 'ok' | 'warn' | 'danger'（可选）
})
```

#### list-tree — 列表树

```typescript
guiComponent('list-tree', {
  items: [
    { label: 'src/', icon: 'branch', children: [
      { label: 'index.ts', icon: 'check', depth: 1 },
      { label: 'utils/', icon: 'branch', depth: 1, children: [
        { label: 'helpers.ts', icon: 'cross', depth: 2, status: 'failed' },
      ]},
    ]},
    { label: 'package.json', icon: 'check', status: 'done' },
  ],
})
// icon: 'arrow' | 'check' | 'cross' | 'circle' | 'dot' | 'pause' | 'branch'
// status: 'running' | 'done' | 'failed'
```

#### columns — 双列网格

```typescript
guiComponent('columns', {
  children: [
    guiComponent('task-list', { items: [...] }),
    guiComponent('stats-line', { items: [...] }),
  ],
  ratios: [3, 2],   // 可选，默认等宽
})
```

#### tab-bar — 标签栏

```typescript
guiComponent('tab-bar', {
  tabs: [
    { label: '概览', active: true },
    { label: '日志', status: 'pending' },
    { label: '结果', status: 'done' },
  ],
})
```

### 4.3 交互类

#### interaction — 交互式组件

```typescript
guiComponent('interaction', {
  questions: [
    {
      header: '确认操作',
      question: '确定要删除这 10 个文件吗？',
      context: '此操作不可撤销',
      options: [
        { label: '确认删除', value: 'delete', description: '永久删除' },
        { label: '移到回收站', value: 'trash' },
      ],
      multiSelect: false,
      allowOther: false,
      allowComment: true,
    },
  ],
  allowCancel: true,
})
```

通常不直接构造此组件，而是用 `guiInteract()` helper（§3.4）。

### 4.4 custom — 自定义组件逃生口

```typescript
guiComponent('custom', {
  component: 'pi-todo:board',   // 注册名（仅 xyz-agent 内置 extension 可注册）
  props: { boardId: 'sprint-1' },
})
```

**限制**：custom 组件的 Vue 组件定义无法通过 WS 传输。仅 xyz-agent 内置 extension 可在编译期注册（通过 `provide('gui-custom-registry', { ... })`）。外部 extension 的 custom 组件会降级为 JSON 文本展示。

---

## 5. Helper API 参考

### isGuiCapable(ctx): boolean

检测当前环境是否支持 GUI 渲染。RPC 模式返回 true。

```typescript
function isGuiCapable(ctx: GuiContext): boolean
```

`GuiContext` 是 pi ExtensionContext 的结构化子集（`{ mode, hasUI, ui }`），pi 的 ctx 天然满足。无需 import pi SDK。

### guiResult(component): GuiRenderResult

构造 `GuiRenderResult`，放进 `details.__gui__`。自动递归删除 undefined 字段。

```typescript
function guiResult(component: GuiComponent): GuiRenderResult
// 返回 { v: 1, component: { type, props } }
```

### guiComponent(type, props): GuiComponent

构造 GuiComponent，带类型推断（类型参数约束 props 形状）。

```typescript
function guiComponent<T extends GuiComponentType>(
  type: T,
  props: GuiComponentProps[T]
): GuiComponent<T>
```

### guiSetWidget(ctx, key, component): void

设置 GUI widget。RPC 模式下用 NUL 标记编码 JSON 进 string[]，TUI 模式下 no-op。传 undefined 清除。

```typescript
function guiSetWidget(
  ctx: GuiContext,
  key: string,
  component: GuiComponent | undefined
): void
```

### guiInteract(ctx, questions, options?): Promise\<answers | null\>

交互式组件，TUI/GUI 双模路由。用户取消返回 null。

```typescript
function guiInteract(
  ctx: GuiContext,
  questions: InteractionQuestion[],
  options?: { signal?: AbortSignal }
): Promise<Record<string, string | string[]> | null>
```

### extractGui(details): GuiRenderResult | undefined

从 details 中提取 `__gui__`，带版本校验。前端消费侧使用，extension 一般不需要。

```typescript
function extractGui(details: Record<string, unknown> | undefined): GuiRenderResult | undefined
```

---

## 6. 完整迁移示例：pi-todo 改造

以下是一个任务管理 extension 从 TUI-only 改造为双模的完整示例。

### 改造前（TUI-only）

```typescript
export const todoTool: ToolDefinition = {
  name: 'todo',
  description: 'Manage tasks',
  async execute(toolCallId, params, signal, onUpdate, ctx) {
    const tasks = await loadTasks()

    // 更新 widget（TUI 专属）
    ctx.ui.setWidget('todo', new TodoWidget(tasks))

    return {
      content: [{ type: 'text', text: `${tasks.length} tasks` }],
      details: { tasks },
    }
  },
  renderResult(result) {
    // TUI 渲染
    return new TodoResultComponent(result.details.tasks)
  },
}
```

### 改造后（双模）

```typescript
import {
  isGuiCapable,
  guiResult,
  guiComponent,
  guiSetWidget,
  type GuiContext,
  type TaskItem,
} from '@xyz-agent/extension-protocol'

function toGuiItems(tasks: Task[]): TaskItem[] {
  return tasks.map(t => ({
    id: t.id,
    text: t.title,
    status: t.status,  // 'pending' | 'in_progress' | 'completed' | 'cancelled'
  }))
}

export const todoTool: ToolDefinition = {
  name: 'todo',
  description: 'Manage tasks',
  async execute(toolCallId, params, signal, onUpdate, ctx) {
    const tasks = await loadTasks()
    const guiCtx = ctx as GuiContext

    // ── Widget（持久面板）──
    if (isGuiCapable(guiCtx)) {
      // RPC 模式：guiSetWidget 编码 GuiComponent
      guiSetWidget(guiCtx, 'todo', guiComponent('task-list', {
        items: toGuiItems(tasks),
        summary: `${tasks.filter(t => t.status === 'completed').length}/${tasks.length}`,
      }))
    } else if (ctx.ui?.setWidget) {
      // TUI 模式：原生 Component
      ctx.ui.setWidget('todo', new TodoWidget(tasks))
    }

    // ── Tool result（结果展示）──
    const details: Record<string, unknown> = { tasks }

    if (isGuiCapable(guiCtx)) {
      details.__gui__ = guiResult(
        guiComponent('task-list', {
          items: toGuiItems(tasks),
          summary: `${tasks.filter(t => t.status === 'completed').length}/${tasks.length} completed`,
        })
      )
    }

    return {
      content: [{ type: 'text', text: `${tasks.length} tasks` }],
      details,
    }
  },
  renderResult(result) {
    // TUI 模式仍走原生 Component，RPC 模式从不调用
    return new TodoResultComponent(result.details.tasks)
  },
}
```

---

## 7. 当前实现状态

### 已实现（P0+P1）

| 能力 | 状态 | 说明 |
|---|---|---|
| 协议包类型 + helpers | 已完成 | `@xyz-agent/extension-protocol`，零依赖 |
| tool 结果 `__gui__` 透传 | 已完成 | 实时链路 + 历史链路（重开 session 不丢） |
| widget NUL 标记编解码 | 已完成 | `guiSetWidget()` → event-adapter 解码 → `extension:widgetGui` |
| status `textRaw` 保留 | 已完成 | ANSI 着色信息不再丢失 |
| ExtensionUIDialog（交互） | 已完成 | confirm/select/input/editor/notify |
| `guiInteract()` RPC 降级 | 已完成 | select/input/confirm 序列 |
| AnsiText 组件渲染 | 已完成 | ansi_up + XSS 安全 |
| 前端 `__gui__` 检测 + 路由骨架 | 已完成 | GuiComponentRenderer，未知类型降级 AnsiText |

### 待实现（P2+）

| 能力 | 阶段 | 说明 |
|---|---|---|
| 11 个内置 Vue 组件 | P2 | task-list/goal-status/workflow-runs/subagent-trace/card/stats-line/progress-bar/list-tree/columns/tab-bar/interaction |
| custom 组件注册表 | P2 | `provide('gui-custom-registry')` |
| widgetGui 前端路由 | P2 | widgetKey → 面板组件 |
| 富交互组件 | P3 | tab/分屏/freeform（替代 dialog 降级） |
| 推荐扩展迁移 | P4 | pi-todo/goal/workflow/subagents/ask-user |

**当前降级行为**：P2 组件未实现前，非 `ansi-text` 类型的 GuiComponent 会在前端降级为 JSON 序列化文本展示（不会崩溃）。extension 现在就可以接入协议，待 P2 组件实现后自动获得完整 GUI 渲染。

---

## 8. 常见陷阱

### 8.1 `__gui__` 放错位置

`__gui__` 必须放在 `result.details.__gui__`，不能放在 `result.content` 内。

```typescript
// 错误 —— content 内的 __gui__ 会被 runtime 过滤成 text，丢失结构化数据
return {
  content: [{ type: 'text', text: '...', __gui__: guiResult(...) }],
  details: {},
}

// 正确
return {
  content: [{ type: 'text', text: '...' }],
  details: { __gui__: guiResult(...) },
}
```

### 8.2 忘记 TUI 分支

`guiSetWidget()` 在 TUI 模式下是 no-op。如果 extension 只调 `guiSetWidget()` 不调原生 `ctx.ui.setWidget()`，TUI 用户会丢失 widget。

```typescript
// 错误 —— TUI 模式下 widget 消失
guiSetWidget(ctx, 'key', component)

// 正确 —— 双模都覆盖
if (isGuiCapable(ctx)) {
  guiSetWidget(ctx, 'key', component)
} else if (ctx.ui?.setWidget) {
  ctx.ui.setWidget('key', new MyTuiComponent(...))
}
```

同理 `guiInteract()` —— TUI 模式下它调 `ctx.ui.custom()`，extension 需提供自己的 TUI Component factory。

### 8.3 content 与 details 的分工

| 字段 | LLM 可见 | 前端渲染 | 用途 |
|---|---|---|---|
| `result.content` | 是 | 是（text/image） | 给 LLM 的工具结果摘要 |
| `result.details.__gui__` | 否 | 是（结构化组件） | 给前端的结构化渲染数据 |

`content` 里的文本是给 LLM 看的——保持简洁摘要。结构化展示数据放 `details.__gui__`。

### 8.4 undefined 字段

`guiResult()` 内部调 `stripUndefined()` 递归删除 undefined 字段。但如果 extension 手动构造对象（不经过 helper），需自行确保 JSON.stringify 不含 undefined（JSON.stringify 会丢弃 undefined 字段，但数组中的 undefined 会变成 null）。

### 8.5 ctx 类型断言

协议包用结构化类型 `GuiContext`（零依赖），不 import pi SDK。pi 的 ExtensionContext 天然满足此结构，但 TypeScript 需要 `ctx as GuiContext` 断言。这是设计取舍——避免协议包依赖 pi SDK 版本。

---

## 9. 协议数据流（参考）

完整的端到端链路，帮助排查问题：

```
extension execute()
  │
  ├─ details.__gui__ = guiResult(guiComponent('task-list', {...}))
  │
  ▼
pi agent-core (agent-session.js)
  │ result 原样引用，零过滤
  ▼
pi RPC stdout (rpc-mode.js)
  │ JSON.stringify(event) 原样输出
  ▼
xyz-agent runtime
  │
  ├─ event-adapter.ts: details 原样透传（零白名单过滤）
  ├─ event-interpreter.ts: tool_call_end WS 帧携带 details
  ├─ message-converter.ts: 历史路径也透传 details（F1 修复）
  │
  ▼
前端 WS
  │
  ├─ Block.vue: extractGui(tool.details) → GuiComponent
  ├─ GuiComponentRenderer.vue: 按 component.type 路由
  │   ├─ 'ansi-text' → AnsiText.vue（已实现）
  │   ├─ 'task-list' → TaskList.vue（P2）
  │   └─ 未知类型 → AnsiText（JSON 序列化降级）
  │
  └─ 重开 session: message-converter 历史路径同样提取 details.__gui__
```

Widget 链路（setWidget）：

```
extension: guiSetWidget(ctx, key, component)
  │
  ├─ ctx.ui.setWidget(key, ['\x00XYZ_GUI_WIDGET:' + JSON])
  │
  ▼
pi RPC stdout
  │ extension_ui_request 事件
  ▼
xyz-agent runtime event-adapter.ts
  │
  ├─ 检测 NUL marker 前缀 → JSON.parse 解码
  ├─ 发 extension:widgetGui WS 帧 { widgetKey, gui }
  │
  ▼
前端: extension:widgetGui handler（P2 路由到面板）
```

交互链路（guiInteract）：

```
extension: await guiInteract(ctx, questions)
  │
  ├─ RPC 模式: ctx.ui.select() / input() / confirm()
  │   │
  │   ▼
  │   pi extension_ui_request → runtime → 前端 ExtensionUIDialog
  │   │
  │   ▼
  │   用户操作 → extension.ui_response → runtime → pi stdin
  │   │
  │   ▼
  │   ctx.ui.select() Promise resolve
  │
  └─ 返回 answers / null
```

---

## 10. 检查清单

改造 extension 前对照确认：

- [ ] 安装 `@xyz-agent/extension-protocol`
- [ ] `execute()` 内用 `isGuiCapable(ctx)` 做 RPC 分支判断
- [ ] RPC 分支构造 `guiComponent(type, props)` + `guiResult()` 放进 `details.__gui__`
- [ ] TUI 分支保留原有 `renderResult` / `ctx.ui.setWidget` / `ctx.ui.custom` 逻辑
- [ ] widget 用 `guiSetWidget()`（RPC）+ 原生 `ctx.ui.setWidget`（TUI）双覆盖
- [ ] 交互用 `guiInteract()`（内部自动 TUI/RPC 路由）
- [ ] `content` 只放 LLM 可见的摘要文本，结构化数据放 `details`
- [ ] `details.__gui__` 放在 `result.details` 下，不在 `content` 内
- [ ] 确认重开 session 后 `__gui__` 仍可见（依赖 runtime F1 修复，已落地）
