/**
 * ui 包 rendering-protocol 层导出面（IF2）。
 *
 * 导出 GuiComponentRenderer（7 原语渲染路由器）+ 透传 core 的注册表机制
 * （GUI_CUSTOM_REGISTRY_KEY / EMPTY_CUSTOM_REGISTRY / isCustomRegistered，
 * 权威定义在 @xyz-agent/core/rendering-protocol/custom-registry）。
 *
 * TODO(renderer-rebuild-v2 P2)：core-rendering-protocol slice 的 w2-resolve/w3-index-integration
 * 落地后，在此透传 resolve/ResolvedGui：
 *   export { resolve, type ResolvedGui } from '@xyz-agent/core/rendering-protocol'
 * （当前 core 无 resolve.ts，透传会 typecheck 失败，按 td-1 注释 TODO）
 */
// AnsiText 例外暴露：它是通用 ANSI 文本渲染器（GuiComponentRenderer 的 ansi-text type
// 与 ansi-fallback 均用它），外部原始 ANSI 文本消费（Block bash output / SideDrawer
// status text）是其合法第二用途（IF3：优先复用 rendering-protocol 消费面，行为一致优先）。
// 其余 6 原语（Card/Columns/ListTree/ProgressBar/StatsLine/TabBar）不暴露，仅经 barrel
// 供 GuiComponentRenderer 内部消费（TC2 总则：原语是 RenderingProtocol 内部实现细节）。
export { default as AnsiText } from './primitives/AnsiText.vue'
export { default as GuiComponentRenderer } from './GuiComponentRenderer.vue'
export {
  GUI_CUSTOM_REGISTRY_KEY,
  EMPTY_CUSTOM_REGISTRY,
  isCustomRegistered,
} from '@xyz-agent/core/rendering-protocol/custom-registry'
