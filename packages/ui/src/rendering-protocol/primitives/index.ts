/**
 * 7 原语统一出口（DM2 barrel）。
 *
 * 消费方（GuiComponentRenderer / renderer 消费点）只从本 barrel 导入原语，
 * 不直接 import 单个 .vue 文件。新增原语时在此追加导出。
 * PrimitiveRouter 是内部递归路由，不进 barrel（Card/Columns 内部相对路径引用）。
 */
export { default as AnsiText } from './AnsiText.vue'
export { default as Card } from './Card.vue'
export { default as Columns } from './Columns.vue'
export { default as ListTree } from './ListTree.vue'
export { default as ProgressBar } from './ProgressBar.vue'
export { default as StatsLine } from './StatsLine.vue'
export { default as TabBar } from './TabBar.vue'
