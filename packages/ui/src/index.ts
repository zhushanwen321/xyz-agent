export const UI_PACKAGE_NAME = '@xyz-agent/ui'

// ── RenderingProtocol 层：7 原语 + 渲染协议 key（W1 re-home 自 renderer） ──
export { default as AnsiText } from './rendering-protocol/primitives/AnsiText.vue'
export { default as Card } from './rendering-protocol/primitives/Card.vue'
export { default as Columns } from './rendering-protocol/primitives/Columns.vue'
export { default as ListTree } from './rendering-protocol/primitives/ListTree.vue'
export { default as ProgressBar } from './rendering-protocol/primitives/ProgressBar.vue'
export { default as StatsLine } from './rendering-protocol/primitives/StatsLine.vue'
export { default as TabBar } from './rendering-protocol/primitives/TabBar.vue'
export { default as PrimitiveRouter } from './rendering-protocol/primitives/PrimitiveRouter.vue'
export { GUI_CUSTOM_REGISTRY_KEY } from './rendering-protocol/registry'
export { PRIMITIVE_RENDER_KEY, PrimitiveFallback } from './rendering-protocol/primitive-render-key'
