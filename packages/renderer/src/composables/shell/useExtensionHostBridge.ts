/**
 * useExtensionHostBridge —— ExtensionHost renderer 接线（audit §12.1，P5 wiring）。
 *
 * 职责：打通 plugin panels 渲染链路最后一公里——
 * - 把 renderer 的 WS 消息流（plugin:* 下行广播）适配成 PluginMessageSource
 *   （core/extension-host/plugin-message-source.ts 注释明确「壳把 transport 层适配成 source 注入」）
 * - 创建 InternalEventBus + MessageBusBridge（归一 plugin:* → bus 事件）
 * - 创建 ViewHostStore + StatusBarController（消费 bus，ui 组件数据源）
 * - 注入 MountPointRegistry/ContributionRegistry 到 core bootstrap（setExtensionRegistries）+ 触发注册
 * - app.provide ViewHost/StatusBar 的 inject key
 *
 * 消息流：WS plugin:viewUpdate → events global 通道 → 本适配器 → MessageBusBridge →
 * bus 'extension-widget' → ViewHostStore → <ViewHost> getView。
 * （runtime 广播 plugin:* 的 ServerMessage 无顶层 sid（payload 含 sessionId）→ 走 route-inbound
 * FALLBACK → dispatchGlobal → events.onGlobal 可订阅。）
 *
 * CompanionBand（plugin:uiRequest dialog）完整接线（DialogRequestQueue + UiResponseTransport）
 * 属 audit §12.3，本次不 provide（组件 inject 缺失自隐藏，不崩）。
 */
import type { App } from 'vue'
import {
  ContributionRegistry,
  createSessionScopedMap,
  InternalEventBus,
  MessageBusBridge,
  MountPointRegistry,
  registerMountPoints,
  scanContributions,
  setExtensionRegistries,
  StatusBarController,
  ViewHostStore,
  type IncomingPluginMessage,
  type PluginMessageSource,
  type ViewCacheEntry,
} from '@xyz-agent/core'
import {
  STATUS_BAR_SOURCE_KEY,
  VIEW_HOST_SOURCE_KEY,
} from '@xyz-agent/ui/extension-host'
import type { ServerMessage } from '@xyz-agent/shared'
import { onGlobal } from '@/api/events'

/** 把 renderer 的 WS 消息流（events global 通道的 plugin:* 下行）适配成 PluginMessageSource。 */

/**
 * extension:* 下行进 bridge 的精确白名单（与 core MessageBusBridge 的 EXTENSION_HANDLERS
 * 5 个 key 一致，见 message-bus-bridge.ts）。plugin:* 前缀全放行，extension:* 只放行白名单内 type——
 * 其余（如 extension.error）由 source filter 静默丢弃，不进 bridge（source 职责边界）。
 */
export const EXTENSION_BRIDGE_TYPES: readonly string[] = [
  'extension:widget',
  'extension:widgetGui',
  'extension:status',
  'extension:notify',
  'extension.ui_request',
]

/** 过滤条件：plugin:* 前缀 OR EXTENSION_BRIDGE_TYPES 精确白名单。 */
export function createWsPluginMessageSource(): PluginMessageSource {
  return {
    subscribe(handler: (msg: IncomingPluginMessage) => void): () => void {
      return onGlobal((msg: ServerMessage) => {
        if (
          typeof msg.type === 'string' &&
          (msg.type.startsWith('plugin:') || EXTENSION_BRIDGE_TYPES.includes(msg.type))
        ) {
          const payload = (msg.payload ?? {}) as { sessionId?: string }
          handler({
            type: msg.type,
            sessionId: typeof payload.sessionId === 'string' ? payload.sessionId : undefined,
            payload: msg.payload,
          })
        }
      })
    },
  }
}

/**
 * 模块级共享 bus（IF1，slice companion-band-mount TC1）：惰性单例。
 * 首次调用 new InternalEventBus() 缓存，后续返回同一实例。
 * initExtensionHostBridge 与 useExtensionUI（ui-request 订阅）以及 sibling slice
 * （bridge-ui-request-wiring 的 DialogRequestSource 适配）共享同一实例——
 * 若各自 new，消息流分裂（bridge 的事件进不了消费方的 bus）。
 */
let sharedBus: InternalEventBus | null = null
export function getExtensionBus(): InternalEventBus {
  if (!sharedBus) sharedBus = new InternalEventBus()
  return sharedBus
}

/**
 * 装配 ExtensionHost bridge（main.ts 挂载前调用一次，app.provide 全局注入）。
 *
 * 返回 stores/registries 供调试与后续接线（§12.3 dialog 闭环复用同一 bus）。
 */
export function initExtensionHostBridge(app: App): {
  bridge: MessageBusBridge
  viewHostStore: ViewHostStore
  statusBarController: StatusBarController
  mountPoints: MountPointRegistry
  contributions: ContributionRegistry
} {
  const bus = getExtensionBus() // IF1：复用模块级惰性单例（不再局部 new）
  const source = createWsPluginMessageSource()
  // bridge 构造即订阅 source（source.subscribe → handleMessage → bus.emit）
  const bridge = new MessageBusBridge({ source, bus })
  const viewHostStore = new ViewHostStore({
    bus,
    sessionScoped: createSessionScopedMap(() => new Map<string, ViewCacheEntry>()),
  })
  viewHostStore.subscribe()
  const statusBarController = new StatusBarController({
    bus,
    // 分区值须满足 StatusBarSessionState 全字段（setEntries 必填，items/setEntries 后续 update push）
    sessionScoped: createSessionScopedMap(() => ({ items: [], setEntries: [] })),
  })
  const mountPoints = new MountPointRegistry()
  const contributions = new ContributionRegistry(bus)
  setExtensionRegistries({ mountPoints, contributions })
  // fire-and-forget：注册失败由 bootstrap 内部 warn 降级（ES2），不阻塞启动
  void registerMountPoints()
  void scanContributions()

  // ui 组件数据源（ViewHost/StatusBar 经 inject 取，壳 provide 真实实现；形状对齐 IF10/IF5）
  app.provide(VIEW_HOST_SOURCE_KEY, {
    getView: (sessionId, viewId) => viewHostStore.getView(sessionId, viewId),
  })
  app.provide(STATUS_BAR_SOURCE_KEY, {
    // 两 scope 重载（ui 契约）：直接委托 StatusBarController（签名对齐 IF8）
    getItems: statusBarController.getItems.bind(statusBarController),
  })

  return { bridge, viewHostStore, statusBarController, mountPoints, contributions }
}
