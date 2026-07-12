// @xyz-agent/extension-protocol
// Extension GUI 渲染协议：类型 + helper 函数，零运行时依赖。
//
// 包结构：
// - core/          通用协议层（所有 extension 共用：GuiComponent + 布局原语 + 传输编码）
// - extensions/    特定 extension 的渲染契约 + 定制 helper
//   - pi-todo/     task-list 组件子类型
//   - pi-goal/     goal-status 组件子类型
//   - pi-workflow/  workflow-runs 组件子类型
//   - pi-subagents/ subagent-trace 组件子类型
//   - ask-user/     富交互（select 通道 + marker）
//
// extension 以 dependencies 引入此包，在 execute 中按 ctx.mode 分支：
// - ctx.mode === 'rpc' → 构造 details.__gui__ = guiResult(component)
// - ctx.mode === 'tui' → 返回纯 details（pi TUI 调 renderResult）

// ── core：通用类型 ──
export type {
  GuiComponent,
  GuiComponentType,
  GuiComponentProps,
  GuiRenderResult,
  StatItem,
  TreeItem,
  TreeItemIcon,
} from './core/types'

// ── core：通用常量 ──
export { PROTOCOL_VERSION } from './core/types'
export { GUI_WIDGET_MARKER } from './core/markers'

// ── core：通用 helper ──
export {
  isGuiCapable,
  isGuiComponent,
  guiResult,
  guiComponent,
  guiSetWidget,
  extractGui,
} from './core/helpers'

// ── core：ctx 接口 ──
export type { GuiContext } from './core/gui-context'

// ── extensions/pi-todo ──
export type { TaskItem, TaskStatus } from './extensions/pi-todo/types'

// ── extensions/pi-goal ──
export type { GoalStatusValue, MetricBar } from './extensions/pi-goal/types'

// ── extensions/pi-workflow ──
export type { WorkflowRunItem } from './extensions/pi-workflow/types'

// ── extensions/pi-subagents ──
export type { SubagentStatusValue, EventLogEntry } from './extensions/pi-subagents/types'

// ── extensions/ask-user ──
export type { AskUserQuestion, AskUserOption, AskUserAnswers } from './extensions/ask-user/types'
export { ASK_USER_MARKER } from './extensions/ask-user/marker'
export {
  askUserInteract,
  getAskUserAnswer,
  getAskUserOther,
  getAskUserComment,
} from './extensions/ask-user/helpers'
