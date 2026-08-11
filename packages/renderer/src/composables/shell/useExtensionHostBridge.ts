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
 * 消息流：WS 下行 → route-inbound（events 正规通道）→ 本适配器 →
 * MessageBusBridge → bus 'extension-widget' → ViewHostStore → <ViewHost> getView。
 * （ADR-0060：数据源从 raw-message-tap 旁路改为 events 双订阅——onGlobal 收无 sid 的 plugin:*，
 * onCrossSession 收带 sid 的 extension:*。route-inbound 成为消息分发单一真相源。）
 *
 * OverlayLifecycle（IF9）装配：订阅同一 bus 的 ui-request 事件，per-session/per-requestId
 * 维护 overlay 状态机（expanded→minimized→restored）+ session-destroyed cleanup。状态机就绪
 * 供 CompanionBand 后续多 overlay z-index 编排（当前 CompanionBand 单 dialog 队首渲染，
 * z-index 消费依赖多 overlay 渲染能力，见 02-extension-host-wiring.md）。
 *
 * CompanionBand（plugin:uiRequest dialog）接线：createDialogRequestSource/createUiResponseTransport
 * 适配（见 extension-host-dialog.ts）经 DIALOG_REQUEST_SOURCE_KEY/UI_RESPONSE_TRANSPORT_KEY 注入。
 */
import type { App } from 'vue'
import { reactive, shallowReactive, watch } from 'vue'
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
  NotificationHostController,
  ViewHostStore,
  OverlayLifecycle,
  type OverlayState,
  type IncomingPluginMessage,
  type PluginMessageSource,
  type SessionScopedMap,
  type ViewCacheEntry,
  type StatusBarSessionState,
} from '@xyz-agent/core'
import { getState as getWsState } from '@/lib/ws-client'
import {
  DIALOG_REQUEST_SOURCE_KEY,
  STATUS_BAR_SOURCE_KEY,
  UI_RESPONSE_TRANSPORT_KEY,
  VIEW_HOST_SOURCE_KEY,
  OVERLAY_LIFECYCLE_KEY,
} from '@xyz-agent/ui/extension-host'
import { createDialogRequestSource, createUiResponseTransport } from './extension-host-dialog'
import type { ServerMessage } from '@xyz-agent/shared'
import { onCrossSession, onGlobal } from '@/api/events'
import * as transport from '@/api/transport'
import { useToast } from '@/composables/useToast'

/** 把 renderer 的 WS 消息流（events 通道的 plugin:/extension: 下行）适配成 PluginMessageSource。 */

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

/**
 * 过滤条件：plugin:* 前缀 OR EXTENSION_BRIDGE_TYPES 精确白名单。
 *
 * ADR-0060：数据源从 raw-message-tap 旁路改为 events 正规双订阅（route-inbound 单一真相源）：
 * - onGlobal：收无 sid 的 plugin:*（statusBarUpdate/notification/uiRequest 等走 global 通道）
 * - onCrossSession：收带 sid 的 extension:*（widget/widgetGui/status/notify/ui_request/ui_timeout
 *   + plugin:uiRequest/plugin:viewUpdate，route-inbound CROSS_SESSION_TYPES 白名单分发，
 *   全局单例消费者 ExtensionHost 接收）
 * 经 source filter 后消息集合与旧 raw-tap 全量订阅等价（plugin:* 无 sid + extension.* 带 sid）。
 */
export function createWsPluginMessageSource(): PluginMessageSource {
  return {
    subscribe(handler: (msg: IncomingPluginMessage) => void): () => void {
      // 适配 raw ServerMessage → IncomingPluginMessage（source filter：plugin:* 前缀 OR 白名单 type）
      const adapt = (msg: ServerMessage): void => {
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
      }
      const offGlobal = onGlobal(adapt)
      const offCrossSession = onCrossSession(adapt)
      return () => {
        offGlobal()
        offCrossSession()
      }
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
 * 壳层响应式 SessionScopedMap（MF-2 R2 修复，ADR-0049 范式的响应式版）。
 *
 * core 的 createSessionScopedMap 是 headless 纯 Map（刻意零 Vue 依赖）：外层 partitions 是
 * 普通 Map，computed 读路径 `get(sid)?.get(vid)` 在分区尚不存在时短路 undefined、零依赖建立，
 * 之后首个 viewUpdate 惰性建分区 + set 不触发 → 值永久 stale（panel.header 常挂组件时序直接命中）。
 * 本实现保持 SessionScopedMap 接口契约（core 零改动），外层 shallowReactive Map 的 get/set 被 Vue
 * 追踪：分区后建 → SET/ITERATE trigger → computed 重算。分区值仍由 init 工厂返回 reactive
 * 容器（in-place mutate 走 proxy set trap）——故外层用 shallowReactive（值已是 reactive，
 * 避免 reactive(Map) 的 deep unwrap 类型噪音与二次包装）。
 */
function createReactiveSessionScopedMap<T>(init: () => T): SessionScopedMap<T> {
  const partitions = shallowReactive(new Map<string, T>())

  return {
    get(sessionId: string): T | undefined {
      return partitions.get(sessionId)
    },
    getOrDefault(sessionId: string): T {
      let partition = partitions.get(sessionId)
      if (!partition) {
        partition = init()
        partitions.set(sessionId, partition)
      }
      return partition
    },
    update(sessionId: string, fn: (t: T) => void): void {
      const partition = this.getOrDefault(sessionId)
      fn(partition)
    },
    cleanup(sessionId: string): void {
      partitions.delete(sessionId)
    },
    has(sessionId: string): boolean {
      return partitions.has(sessionId)
    },
    keys(): Iterable<string> {
      return partitions.keys()
    },
  }
}

/**
 * mountPoints.sync 上报的模块级单例注册（MF-1 R2 修复）。
 *
 * 不能在 initExtensionHostBridge 时立即 send：main.ts 模块体同步执行先于 app.mount，WS 唯一
 * 连接入口在 App.vue onMounted（异步建连），send 时 readyState 必非 OPEN → core ws-client
 * 非 OPEN 时 return false 静默丢弃（W4 fast-fail 契约，无缓冲队列）→ runtime mountPoints 恒 []。
 * 改为 watch connectionState：每次进入 connected（首次建连 + runtime 重启重连）补发；
 * runtime syncMountPoints 为 overwrite 语义（DM3），重复发送幂等。模块级守卫防重复注册
 * （HMR / 测试多次 init 只挂一个 watcher，避免重复发送）。
 */
let mountPointsSyncWatchRegistered = false
function ensureMountPointsSync(mountPoints: MountPointRegistry): void {
  if (mountPointsSyncWatchRegistered) return
  mountPointsSyncWatchRegistered = true
  const sendSync = (): void => {
    transport.send({ type: 'plugin.mountPoints.sync', payload: { mountPoints: mountPoints.list() } })
  }
  // immediate：init 时若已 connected（防御）立即发送；否则等待首次建连 / 重连进入 connected
  watch(getWsState(), (s) => {
    if (s === 'connected') sendSync()
  }, { immediate: true })
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
  overlayLifecycle: OverlayLifecycle
  notificationController: NotificationHostController
  mountPoints: MountPointRegistry
  contributions: ContributionRegistry
} {
  const bus = getExtensionBus() // IF1：复用模块级惰性单例（不再局部 new）
  const source = createWsPluginMessageSource()
  // bridge 构造即订阅 source（source.subscribe → handleMessage → bus.emit）
  const bridge = new MessageBusBridge({ source, bus })
  // MF-4 响应式桥（R2 补齐）：core store 是 headless 纯 Map 容器（刻意零 Vue 依赖），事件到达
  // mutate 纯 Map 不被 Vue computed 追踪 → ViewHost/StatusBar 永不重渲染。壳层两层 reactive 化：
  // ①外层 partitions 容器 reactive（createReactiveSessionScopedMap——分区后建也触发重算，
  //   修复「computed 首次求值短路 → 永久 stale」）；②分区值由 init 工厂返回 reactive 容器
  // （get/set 走 reactive proxy）。ViewHost.vue computed 的 getView/getItems 调用面即被追踪
  // （core 代码零改动）。
  const viewHostStore = new ViewHostStore({
    bus,
    sessionScoped: createReactiveSessionScopedMap(() => reactive(new Map<string, ViewCacheEntry>())),
  })
  viewHostStore.subscribe()
  const statusBarController = new StatusBarController({
    bus,
    // 分区值须满足 StatusBarSessionState 全字段（setEntries 必填，items/setEntries 后续 update push）
    sessionScoped: createReactiveSessionScopedMap(() => reactive<StatusBarSessionState>({ items: [], setEntries: [] })),
  })
  statusBarController.subscribe()
  const mountPoints = new MountPointRegistry()
  const contributions = new ContributionRegistry(bus)
  setExtensionRegistries({ mountPoints, contributions })
  // fire-and-forget：注册失败由 bootstrap 内部 warn 降级（ES2），不阻塞启动
  void registerMountPoints()
  void scanContributions()
  // MF-3：把挂载点整表上报 runtime（AC10）——插件 views.listMountPoints() 依赖此中继查询，
  // 不上报则恒返回 []（registerMountPoints 内部同步注册，list() 已含全部挂载点）。
  // MF-1（R2）：发送时点见 ensureMountPointsSync——init 时 WS 未建连，send 必被静默丢弃。
  ensureMountPointsSync(mountPoints)

  // ui 组件数据源（ViewHost/StatusBar 经 inject 取，壳 provide 真实实现；形状对齐 IF10/IF5）
  app.provide(VIEW_HOST_SOURCE_KEY, {
    getView: (sessionId, viewId) => viewHostStore.getView(sessionId, viewId),
  })
  app.provide(STATUS_BAR_SOURCE_KEY, {
    // 两 scope 重载（ui 契约）：直接委托 StatusBarController（签名对齐 IF8）。
    // MF-2（R2）：global scope 经 controller 的 sessionScoped 保留分区（GLOBAL_SCOPE_KEY）存储，
    // 壳注入 reactive 分区容器 → getItems 返回的 items 数组本身 reactive，computed 追踪有效
    // （旧实现 reactive() 包装 controller 私有 raw 数组，replaceAllWith 原地 mutate 不经 proxy
    // set trap → global 状态栏永不更新）。
    getItems: (scope: 'global' | 'per-session', sessionId?: string) => {
      if (scope === 'global') return statusBarController.getItems('global')
      // sessionId 可能 undefined：controller 实现签名内部 `sessionId ?? GLOBAL_STATUS_KEY` 兜底
      // （重载签名要求 string，受控断言仅类型擦除，运行时 undefined 走兜底分区）
      return statusBarController.getItems('per-session', sessionId as string)
    },
  })
  // CompanionBand 数据源：bus 'ui-request' 适配（无 sid 跳过 / askUser 过滤）+ 回传双通道（FR2/FR7）
  app.provide(DIALOG_REQUEST_SOURCE_KEY, createDialogRequestSource(bus))
  app.provide(UI_RESPONSE_TRANSPORT_KEY, createUiResponseTransport())

  // OverlayLifecycle（IF9，audit §12.1 接线闭环）：订阅同一 bus 的 ui-request → 自动建 per-session
  // per-requestId 分区（expanded 初始态）+ session-destroyed cleanup（ERR4）。bus 亶久持有 listener
  // 闭包（闭包捕获 deps.sessionScoped），实例即便不被外部引用也不会被 GC 丢失订阅。subscribe 返回
  // dispose，正常应用生命周期不调（跟随 app 存活）。CompanionBand 多 overlay z-index 消费待后续。
  const overlayLifecycle = new OverlayLifecycle({
    bus,
    sessionScoped: createSessionScopedMap(() => new Map<string, OverlayState>()),
  })
  overlayLifecycle.subscribe()
  // OverlayLifecycle（IF9 状态机）provide 给 CompanionBand 消费（arch-fix-v2 闭环）：
  // minimize/restore → transition 驱动状态机迁移；getState 派生 z-index。实例结构兼容
  // ui 包 OverlayLifecycleSource 接口（getState/transition 签名一致，结构型适配无需手写包装）。
  app.provide(OVERLAY_LIFECYCLE_KEY, overlayLifecycle)

  // NotificationHostController（DM3 消费端补齐）：订阅同一 bus 的 6 类通知/生命周期事件。
  // toast 经 deps 注入——core 零 UI 依赖，壳用 useToast（模块级单例，命令式 API）实现 showToast。
  // level 映射对齐旧线 useExtensionNotify（error→error / warn|warning→warning / 其余→info）。
  const { error: toastError, info: toastInfo, warning: toastWarning } = useToast()
  const notificationController = new NotificationHostController({
    bus,
    deps: {
      showToast: (message, level) => {
        if (level === 'error') toastError(message)
        else if (level === 'warning' || level === 'warn') toastWarning(message)
        else toastInfo(message)
      },
      log: console.warn,
    },
  })
  notificationController.subscribe()

  return { bridge, viewHostStore, statusBarController, overlayLifecycle, notificationController, mountPoints, contributions }
}
