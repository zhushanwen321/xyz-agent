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
export { default as GuiComponentRenderer } from './GuiComponentRenderer.vue'
export {
  GUI_CUSTOM_REGISTRY_KEY,
  EMPTY_CUSTOM_REGISTRY,
  isCustomRegistered,
} from '@xyz-agent/core/rendering-protocol/custom-registry'
