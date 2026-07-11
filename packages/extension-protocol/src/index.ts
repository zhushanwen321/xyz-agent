// @xyz-agent/extension-protocol
// Extension GUI 渲染协议：类型 + helper 函数，零运行时依赖。
//
// extension 以 dependencies 引入此包，在 execute 中按 ctx.mode 分支：
// - ctx.mode === 'rpc' → 构造 details.__gui__ = guiResult(component)
// - ctx.mode === 'tui' → 返回纯 details（pi TUI 调 renderResult）

// ── 类型 ──
export type {
  GuiComponent,
  GuiComponentType,
  GuiComponentProps,
  GuiRenderResult,
  TaskItem,
  TaskStatus,
  GoalStatusValue,
  MetricBar,
  WorkflowRunItem,
  SubagentStatusValue,
  EventLogEntry,
  InteractionQuestion,
  InteractionOption,
  StatItem,
  TreeItem,
  TreeItemIcon,
} from './types'

// ── 常量 ──
export { PROTOCOL_VERSION } from './types'
export { GUI_WIDGET_MARKER } from './helpers'

// ── helper 函数 ──
export {
  isGuiCapable,
  guiResult,
  guiComponent,
  guiSetWidget,
  guiInteract,
  extractGui,
} from './helpers'

// ── ctx 接口 ──
export type { GuiContext } from './helpers'
