// @xyz-agent/extension-protocol
// Extension GUI 渲染协议：类型 + helper 函数，零运行时依赖。
//
// 包结构：
// - core/          通用协议层（所有 extension 共用：GuiComponent + 布局原语 + 传输编码）
// - extensions/    有运行时定制逻辑的 extension（marker + helper）
//   - ask-user/    富交互（select 通道 + marker）
//
// core 只保留结构性、中性的通用原语（card/stats-line/progress-bar/list-tree/
// columns/tab-bar/ansi-text）。特定 extension 的领域数据结构不进协议层——
// extension 用通用原语组合表达，形状太特殊时走 custom 通道。

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

// ── extensions/ask-user：富交互（select 通道 + marker）──
export type { AskUserQuestion, AskUserOption, AskUserAnswers } from './extensions/ask-user/types'
export { ASK_USER_MARKER } from './extensions/ask-user/marker'
export {
  askUserInteract,
  getAskUserAnswer,
  getAskUserOther,
  getAskUserComment,
} from './extensions/ask-user/helpers'
