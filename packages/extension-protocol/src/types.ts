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
