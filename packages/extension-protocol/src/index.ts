// @xyz-agent/extension-protocol
// Extension GUI 渲染协议：类型 + helper 函数，零运行时依赖。
//
// 包结构：
// - core/          通用协议层（所有 extension 共用：GuiComponent + 布局原语 +
//                  extension 专属组件的纯类型契约 + 传输编码）
// - extensions/    有运行时定制逻辑的 extension（marker + helper）
//   - ask-user/    富交互（select 通道 + marker）
//
// 纯类型的渲染契约（TaskItem/GoalStatusValue/WorkflowRunItem/...）归 core，
// 因为它们只是 GuiComponentProps 的内联子类型，无运行时代码、无需隔离。
// 只有需要 marker + 运行时 helper 的 extension（如 ask-user 的双向交互）
// 才在 extensions/ 下建子目录。

// ── core：通用类型 + extension 专属组件子类型 ──
export type {
  GuiComponent,
  GuiComponentType,
  GuiComponentProps,
  GuiRenderResult,
  StatItem,
  TreeItem,
  TreeItemIcon,
  TaskItem,
  TaskStatus,
  GoalStatusValue,
  MetricBar,
  WorkflowRunItem,
  SubagentStatusValue,
  EventLogEntry,
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

// ── extensions/ask-user：富交互（select 通道 + marker）──
export type { AskUserQuestion, AskUserOption, AskUserAnswers } from './extensions/ask-user/types'
export { ASK_USER_MARKER } from './extensions/ask-user/marker'
export {
  askUserInteract,
  getAskUserAnswer,
  getAskUserOther,
  getAskUserComment,
} from './extensions/ask-user/helpers'
