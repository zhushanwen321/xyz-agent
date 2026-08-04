/**
 * useDrawerWidgetBuffers —— SideDrawer 的 widget/status 缓冲壳层接线（W2 迁移后 core 为 SSOT）。
 *
 * W2 迁移（drawer 域向 core 归位第二步）：widget/status 缓冲的状态容器（per-session 分区 +
 * computed 派生 + 1000 行截断 + mapWidgetKeyToTab 路由 + gui:null 清除 + status 聚合）整体迁入
 * @xyz-agent/core/domain/drawer（createDrawerBuffers 工厂）。本文件不再持有任何缓冲状态，只做两件事：
 *
 * 1. 订阅编排（D3 留壳注入）：useSessionEvents.onMessage 接 extension:widget/widgetGui/status
 *    事件，handler 内调 core 容器的 update 方法喂数据（core 零事件总线依赖——事件类型
 *    ServerMessage 留在壳层，不跨界）。
 * 2. 兼容形状：useDrawerWidgetBuffers() 返回 { activeGuiComponent, activeLines, activeLinesMeta,
 *    statusEntries } 与旧版逐字段一致，SideDrawer.vue 消费方零改动。
 *
 * 范式（ADR-0049 W4：Map 分区派，[HISTORICAL]）：分区逻辑在 core createDrawerBuffers 内
 * （useSessionScopedState 按 sessionIdRef 分区），onMessage handler 调 updateFor(sid) 写订阅时
 * sid 分区（M1 竞态修复的核心——退订窗口内旧 sid 迟到消息不污染新 sid）。
 *
 * 依赖方向：useSessionEvents（订阅）+ core createDrawerBuffers（缓冲容器）+ @xyz-agent/extension-protocol（类型）。
 * 不依赖任何 store。
 *
 * 旧 SideDrawer 删除后（W4 shell-integration）本壳层可一并移除，订阅编排随 PanelContainer 重接。
 */
import type { Ref } from 'vue'
import type { GuiComponent } from '@xyz-agent/extension-protocol'
import type { SideDrawerTab } from '@/composables/features/useSideDrawer'
import { useSessionEvents } from '@/composables/features/useSessionEvents'
import { createDrawerBuffers } from '@xyz-agent/core/domain/drawer'
import type { DrawerBuffersView } from '@xyz-agent/core/domain/drawer'

/**
 * @param sessionIdRef session id 的 ref（useSessionEvents 按 sessionId 订阅 + 切换重订；
 *        core 容器按此分区——切 sid 切分区，切回恢复 AC-4）
 * @param activeTabRef active tab 的 ref（决定 activeGuiComponent / activeLines 取哪个 tab 的数据）
 */
export function useDrawerWidgetBuffers(
  sessionIdRef: Ref<string | null>,
  activeTabRef: Ref<SideDrawerTab>,
): DrawerBuffersView {
  // core 纯状态容器（工厂实例，per-instance 分区）——本文件不持有任何缓冲状态
  const buffers = createDrawerBuffers(sessionIdRef, activeTabRef)

  // widget/status 订阅编排（壳层，D3）：handler 收第二参数 sid（订阅时捕获的消息所属 session），
  // 调 updateFor(sid) 写入该 sid 分区——即使 watch flush:pre 异步退订窗口内有旧 sid 迟到消息，
  // 也只写旧 sid 分区，不污染新 sid（M1 竞态修复）
  const onMessage = useSessionEvents(sessionIdRef)
  // extension:widget：按 widgetKey 路由到 terminal/browser tab，未匹配走 fallback
  onMessage('extension:widget', (msg, sid) => {
    const payload = msg.payload
    buffers.updateWidget(sid, payload.widgetKey, payload.lines)
  })
  // extension:widgetGui（spec §9.1）：结构化 GUI 组件，按 widgetKey 路由到 tab，覆盖纯文本 lines。
  // gui === null 表示清除（guiSetWidget(key, undefined) → event-adapter 发 gui:null），
  // core 容器内删 guiWidgetsByTab 条目 + 清对应 tab 的纯文本 lines
  onMessage('extension:widgetGui', (msg, sid) => {
    const payload = msg.payload
    buffers.updateWidgetGui(sid, payload.widgetKey, payload.gui as GuiComponent | null)
  })
  // extension:status：statusKey 维度聚合，同 key 覆盖（透传 textRaw 供 AnsiText 着色）
  onMessage('extension:status', (msg, sid) => {
    const payload = msg.payload
    buffers.updateStatus(sid, payload.statusKey, payload.text, payload.textRaw)
  })

  // 兼容形状：逐字段委托 core 容器 computed（SideDrawer.vue 零改动）
  return {
    activeGuiComponent: buffers.activeGuiComponent,
    activeLines: buffers.activeLines,
    activeLinesMeta: buffers.activeLinesMeta,
    statusEntries: buffers.statusEntries,
  }
}
