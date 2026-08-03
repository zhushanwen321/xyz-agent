/**
 * composer input 模块入口 —— core/domain/composer/input/ 的公开 API 聚合（W2）。
 *
 * 定位：p3-strangler-domains::composer W2 产物。承接 slice design review TC1/IF1/IF2/IF9/IF10——
 * useContenteditableInput（873 行）+ useComposerChipCommands + useComposerRestore + useComposerHistory +
 * useComposerDragDrop 五个 composable + input-dom.ts DOM 收敛层迁入 core。
 *
 * 公开 API（5 composable + DOM 辅助函数 + 类型）：
 * - useContenteditableInput：contenteditable 输入组合逻辑（委托 input-dom）
 * - useComposerChipCommands：chip DOM 创建/删除（getSlashIcon/t 注入）
 * - useComposerRestore：发送后清空/失败恢复
 * - useComposerHistory：历史导航状态机（getHistoryEntries 注入，per-session 经 useSessionScopedState）
 * - useComposerDragDrop：拖拽落位（pasteImage 注入）
 * - getSegmentsFromEl/findImageChipEl/findImageChipElById：DOM 辅助（外部消费）
 *
 * deps 注入契约（clarify C1）：所有跨域能力（IPC pasteImage / chatStore getHistoryEntries /
 * slashIcons / i18n）经 deps 回调注入，core input 模块零 renderer import（AC10）。
 *
 * 后续 wave：W3 dispatch/context 消费本模块的 Segment/ComposerInputInstance 类型；
 * W4 壳接入时删除 renderer 侧 5 个 re-export shim，壳层组件直接 import core。
 */
export { useContenteditableInput } from './contenteditable'
export { useComposerChipCommands } from './chip-commands'
export { useComposerRestore } from './restore'
export { useComposerHistory } from './history'
export { useComposerDragDrop } from './dragdrop'

// DOM 辅助函数（外部消费：ContextChipsBar 删除回调用 findImageChipElById，send 链路用 getSegmentsFromEl）
export {
  getSegmentsFromEl,
  getTextFromEl,
  detectHashTriggerFromEl,
  moveCaretVerticalOf,
  pickClipboardImageItem,
  findImageChipEl,
  findImageChipElById,
  isSpacerNode,
  placeCursorAfter,
  removeChipNode,
  CHIP_SPACER_ZWSP,
} from './input-dom'

// 类型（外部消费：壳层 ComposerInput 组装 deps、W3 dispatch 消费 ComposerInputInstance）
export type {
  ContenteditableCallbacks,
  ChipCallbacks,
  ComposerInputInstance,
  ComposerRestoreDeps,
  HistoryDeps,
  DragDropDeps,
  ComposerNavState,
  HandleImagePasteResult,
  VerticalMoveResult,
} from './types'
