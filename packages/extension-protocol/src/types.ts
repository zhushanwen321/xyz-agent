/**
 * Extension GUI 渲染协议类型定义。
 *
 * GuiComponent 是 pi Component { render(width): string[] } 的可序列化镜像。
 * extension 按 ctx.mode 分支：TUI 走原生 Component，RPC 走 GuiComponent（放进 details.__gui__）。
 *
 * @see docs/architecture/extension-gui-protocol.md
 */

// ── 协议版本 ──

export const PROTOCOL_VERSION = 1 as const

// ── 核心：GuiComponent ──

/**
 * GUI 渲染组件——pi Component 的可序列化镜像。
 *
 * pi:  Component { render(width): string[] }   ← ANSI 文本行
 * gui: GuiComponent = { type, props }           ← 结构化数据
 */
export interface GuiComponent<T extends GuiComponentType = GuiComponentType> {
  /** 组件类型，前端按此路由到 Vue 组件 */
  type: T
  /** 组件 props，类型由 type 决定 */
  props: GuiComponentProps[T]
}

export type GuiComponentType = keyof GuiComponentProps

// ── 内置组件 props 映射 ──

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

  // ── 布局原语（替代 TUI ASCII 布局）──

  /** 卡片容器——替代 TUI 的 ┌─┐││└─┘ box 边框 */
  'card': {
    variant?: 'default' | 'elevated' | 'danger' | 'success'
    header?: GuiComponent | string
    body: GuiComponent[]
  }

  /** 统计行——替代 TUI 的 "N turns · Nk · Ns" */
  'stats-line': {
    items: StatItem[]
  }

  /** 进度条——替代 TUI 的 ████░░░░ */
  'progress-bar': {
    label?: string
    current: number
    total: number
    unit?: string
    severity?: 'ok' | 'warn' | 'danger'
  }

  /** 列表树——替代 TUI 的 ⎿ ├─ └─ 缩进 */
  'list-tree': {
    items: TreeItem[]
  }

  /** 双列网格——替代 TUI 的 │ 列分隔 */
  'columns': {
    children: GuiComponent[]
    ratios?: number[]
  }

  /** 标签栏——替代 TUI 的 tab │ 分隔 */
  'tab-bar': {
    tabs: { label: string; active?: boolean; status?: 'done' | 'pending' }[]
  }

  /** 自定义组件——逃生口（仅限内置 extension 编译期注册） */
  'custom': {
    component: string
    props: Record<string, unknown>
  }
}

// ── tool result / message details 中 __gui__ 字段的完整类型 ──

export interface GuiRenderResult {
  /** 版本协商，前端检测，不认识降级 ansi-text */
  v: typeof PROTOCOL_VERSION
  component: GuiComponent
}

// ── task-list 子类型 ──

export interface TaskItem {
  id: string | number
  text: string
  status: 'pending' | 'in_progress' | 'completed' | 'cancelled'
}
export type TaskStatus = TaskItem['status']

// ── goal-status 子类型 ──

export type GoalStatusValue =
  | 'active' | 'paused' | 'blocked'
  | 'complete' | 'budget_limited' | 'time_limited' | 'cancelled'

export interface MetricBar {
  label: string
  current: number
  total?: number
  unit?: string
  severity?: 'ok' | 'warn' | 'danger'
}

// ── workflow-runs 子类型 ──

export interface WorkflowRunItem {
  runId: string
  name: string
  status: 'running' | 'paused' | 'done'
  reason?: 'completed' | 'failed' | 'aborted' | 'budget_limited' | 'time_limited'
  durationMs?: number
  error?: string
}

// ── subagent-trace 子类型 ──

export type SubagentStatusValue = 'running' | 'done' | 'failed' | 'cancelled' | 'crashed'

export interface EventLogEntry {
  type: 'tool_start' | 'tool_end' | 'turn_end' | 'error'
  label: string
  status?: 'running' | 'done' | 'failed'
}

// ── 布局原语子类型 ──

export interface StatItem {
  label?: string
  value: string
  severity?: 'ok' | 'warn' | 'danger'
  icon?: string
}

export interface TreeItem {
  icon?: TreeItemIcon
  label: string
  status?: 'running' | 'done' | 'failed'
  depth?: number
  children?: TreeItem[]
}
export type TreeItemIcon = 'arrow' | 'check' | 'cross' | 'circle' | 'dot' | 'pause' | 'branch'

// ── 富交互（InteractionOverlay）──
//
// custom() 在 RPC 模式不可用（Component 是代码不是数据），但 custom 的「表单类」
// 常见用法可以用结构化数据描述。InteractionQuestion 声明交互需求，
// 前端 InteractionOverlay 按此渲染表单 UI，用户提交后回传 InteractionAnswers。
//
// @see spec.md §3 types 定义；helpers.ts guiInteract() 为入口

/**
 * 富交互问题声明。
 *
 * 设计参考 ask-user 的 Question 结构，但不依赖 ask-user。
 * 任何 extension 都可以用 InteractionQuestion 声明富交互。
 */
export interface InteractionQuestion {
  /** Tab 标签 / 简短标题。多问题时用于 tab 切换，≤12 字符。
   *  可选——未提供时前端用 question 文本截断（前 12 字符）作为 tab 标签和 answers key。
   *  answers 的 key 优先用 header，header 缺失时用截断后的 question 文本。 */
  header?: string
  /** 完整问题文本。也作为 answers 的 fallback key（header 缺失时） */
  question: string
  /** 上下文摘要（可选）。显示在问题上方，帮用户理解背景 */
  context?: string
  /** 互斥选项列表（可选）。无 options = 纯自由文本输入 */
  options?: InteractionOption[]
  /** 是否允许多选。仅 options 存在时有效 */
  multiSelect?: boolean
  /** 是否允许自由文本输入（Other）。
   *  - 有 options 时：默认 true，前端在选项末尾追加 Other 输入框；设 false 则不追加
   *  - 无 options 时：整个问题就是自由输入，此字段被忽略 */
  allowOther?: boolean
  /** 是否允许附加评论。选中后可追加短文本 */
  allowComment?: boolean
}

export interface InteractionOption {
  /** 显示标签 */
  label: string
  /** 回传值。未提供时用 label */
  value?: string
  /** 描述（可选）。显示在 label 下方，解释 tradeoff */
  description?: string
}

/**
 * 富交互回传结果。key = question.header（header 缺失时用 question 文本）。
 *
 * 答案编码规则（避免逗号歧义）：
 * - 单选：value = 选中项的 value string（或 label）
 * - 多选：value = JSON.stringify(选中项 value 数组)，如 '["pg","mysql"]'
 *   （不用逗号 join——option value 可能含逗号导致 split 歧义）
 * - Other 文本：单独 key `${header}__other`，value = 自由文本（不混进选中项数组）
 * - comment：单独 key `${header}__comment`，value = 评论文本
 *
 * extension 解析示例：
 *   const selected = JSON.parse(answers[header])  // 多选 → string[]
 *   const other = answers[`${header}__other`]     // Other 自由文本
 *   const comment = answers[`${header}__comment`] // 评论
 */
export type InteractionAnswers = Record<string, string>

/**
 * 富交互请求的 title marker。runtime event-adapter 和前端 useExtensionUI
 * 检测此 marker 区分富交互请求与普通 select。
 *
 * NUL 前缀确保不会与 extension 正常的 select title 冲突。
 * 与 GUI_WIDGET_MARKER 同理（见 helpers.ts GUI_WIDGET_MARKER）。
 */
export const GUI_INTERACT_MARKER = '\x00XYZ_GUI_INTERACT'
