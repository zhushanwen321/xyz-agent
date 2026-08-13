/**
 * @xyz-agent/ui features/chat barrel（w6 chat-ui-and-shell）。
 *
 * 导出 chat 域展示组件（ChatView 顶层 + 迁移的展示/编排组件）+ deps inject token +
 * 纯函数（block-icon/format-utils）+ 类型（MarkdownSegment）。
 *
 * 消费方（renderer 壳 MessageStream.vue）经 @xyz-agent/ui 子路径或顶层 barrel 消费。
 */
// 顶层薄壳 + 组装
export { default as ChatView } from './ChatView.vue'
// deps inject token（ChatViewDeps）。trace 折叠 stick-guard 通路已随 <Transition> 删除退役
//（useVirtuaFollow INVAR-M4-2：onScroll 只单向翻真，永不翻 false，guarded 回归结构上不可能）。
export { ChatViewDepsKey, useChatViewDeps } from './chat-view-deps'
export type { ChatViewDeps, DrawerOpenOptions } from './chat-view-deps'
// 纯函数（图标决策 + 耗时格式化）
export * from './block-icon'
export * from './format-utils'
export * from './slash-icons'
// 类型
export type { MarkdownSegment } from './markdown-types'
// 展示组件
export { default as SystemNotice } from './SystemNotice.vue'
export { default as ImageThumb } from './ImageThumb.vue'
export { default as AmbiguousFilePopover } from './AmbiguousFilePopover.vue'
export { default as TurnRail } from './TurnRail.vue'
// 编排组件
export { default as Turn } from './Turn.vue'
export { default as UserBubble } from './UserBubble.vue'
export { default as TurnMeta } from './TurnMeta.vue'
export { default as TurnSummary } from './TurnSummary.vue'
export { default as Block } from './Block.vue'
export { default as BlockSubagent } from './BlockSubagent.vue'
export { default as MarkdownRenderer } from './MarkdownRenderer.vue'
export { default as MermaidRenderer } from './MermaidRenderer.vue'
export { default as BashOutputBlock } from './BashOutputBlock.vue'
export { default as ChangeSetCard } from './ChangeSetCard.vue'
