/**
 * useExtensionHostBridge.test.ts —— createWsPluginMessageSource 过滤条件单测（FR1/AC1）。
 *
 * 链路：events.dispatchCrossSession（模拟 route-inbound crossSession 通道分发）→ source →
 * MessageBusBridge → bus。经 events 正规通道全链路验证（ADR-0060：source 双订阅 onGlobal +
 * onCrossSession，crossSession 通道注入可触发 source adapt，与 global 等价）。
 *
 * 覆盖：TC1 plugin:uiRequest 前缀放行 / TC2 extension.ui_request 白名单放行（归一 kind=ui-request）/
 * TC3 extension.error 非白名单拒绝 / TC4 plugin:statusBarUpdate 前缀回归 /
 * TC5 白名单 5 项字面量 + 行为级验证（防与 core EXTENSION_HANDLERS 漂移）。
 * M17 追加：TC7 VIEW_HOST_SOURCE_KEY provide 值的 getViewIds 纯透传
 * （extension:widgetGui 帧 → ViewHostStore → provide 枚举一致）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { computed, nextTick } from 'vue'
import { InternalEventBus, MessageBusBridge, providePlatform } from '@xyz-agent/core'
import type { InternalEvent } from '@xyz-agent/core'
import { dispatchCrossSession, dispatchGlobal } from '@/api/events'
import { createWsPluginMessageSource, EXTENSION_BRIDGE_TYPES, initExtensionHostBridge } from '../useExtensionHostBridge'
import {
  DIALOG_REQUEST_SOURCE_KEY,
  UI_RESPONSE_TRANSPORT_KEY,
  VIEW_HOST_SOURCE_KEY,
  STATUS_BAR_SOURCE_KEY,
  type ViewHostSource,
  type StatusBarSource,
} from '@xyz-agent/ui/extension-host'
import { connect, disconnect } from '@/lib/ws-client'
import { createMockPlatform } from '@/mock/mock-ws'

// mock transport：MF-4 断言 mountPoints.sync 发送（真实 transport.send 在单测环境不可观测、
// 且会裸调 ws-client）。模式对齐 usePermissionRequest.test.ts（顶层 vi.fn + 工厂转发）。
const transportSendSpy = vi.fn()
vi.mock('@/api/transport', () => ({
  send: (...args: unknown[]) => transportSendSpy(...args),
  connect: vi.fn(),
  on: vi.fn(),
}))

function makeBridge() {
  const bus = new InternalEventBus()
  const source = createWsPluginMessageSource()
  const bridge = new MessageBusBridge({ source, bus })
  return { bus, bridge }
}

/** emit 后收集 bus 上所有事件（对齐 core message-bus-bridge.test.ts 范式）。 */
function spyEmit(bus: InternalEventBus) {
  const emitted: InternalEvent[] = []
  const spy = vi.spyOn(bus, 'emit')
  spy.mockImplementation((e) => {
    emitted.push(e)
    return
  })
  return { emitted, spy }
}

describe('createWsPluginMessageSource 过滤条件（FR1/AC1）', () => {
  let bridge: MessageBusBridge | null = null

  beforeEach(() => {
    vi.restoreAllMocks()
  })

  afterEach(() => {
    bridge?.dispose()
    bridge = null
  })

  it('TC1: plugin:uiRequest 前缀放行 → bus 收到 kind=ui-request（sessionId 透传）', () => {
    const { bus, bridge: b } = makeBridge()
    bridge = b
    const { emitted } = spyEmit(bus)

    dispatchCrossSession({
      type: 'plugin:uiRequest',
      payload: { sessionId: 's1', requestId: 'r1', method: 'select', options: ['a', 'b'] },
    })

    expect(emitted).toHaveLength(1)
    expect(emitted[0]).toMatchObject({ kind: 'ui-request', sessionId: 's1' })
    expect(emitted[0]).not.toMatchObject({ kind: 'error' })
  })

  it('TC1b: plugin:viewUpdate 前缀放行 → bus 收到 kind=extension-widget（MF-1 链路）', () => {
    const { bus, bridge: b } = makeBridge()
    bridge = b
    const { emitted } = spyEmit(bus)

    dispatchCrossSession({
      type: 'plugin:viewUpdate',
      payload: { sessionId: 's1', viewId: 'sidebar.tab', pluginId: 'p1', guiTree: [{ type: 'ansi-text', props: { lines: ['hi'] } }], updatedAt: 1 },
    })

    expect(emitted).toHaveLength(1)
    expect(emitted[0]).toMatchObject({
      kind: 'extension-widget',
      sessionId: 's1',
      widget: { viewId: 'sidebar.tab', pluginId: 'p1', guiTree: [{ type: 'ansi-text', props: { lines: ['hi'] } }] },
    })
    expect(emitted[0]).not.toMatchObject({ kind: 'error' })
  })

  it('TC2: extension.ui_request 白名单放行 → bus 收到 kind=ui-request（与 plugin:uiRequest 归一）', () => {
    const { bus, bridge: b } = makeBridge()
    bridge = b
    const { emitted } = spyEmit(bus)

    dispatchCrossSession({
      type: 'extension.ui_request',
      payload: { sessionId: 's1', requestId: 'r1', method: 'confirm', title: '确认?' },
    })

    expect(emitted).toHaveLength(1)
    expect(emitted[0]).toMatchObject({ kind: 'ui-request', sessionId: 's1' })
    expect(emitted[0]).not.toMatchObject({ kind: 'error' })
  })

  it('TC3: extension.error 非白名单 → bridge 零感知（bus 零事件）', () => {
    const { bus, bridge: b } = makeBridge()
    bridge = b
    const { emitted } = spyEmit(bus)

    dispatchCrossSession({ type: 'extension.error', payload: { sessionId: 's1', code: 'boom' } })

    expect(emitted).toHaveLength(0)
  })

  it('TC4: plugin:statusBarUpdate 前缀放行不回归', () => {
    const { bus, bridge: b } = makeBridge()
    bridge = b
    const { emitted } = spyEmit(bus)

    dispatchCrossSession({
      type: 'plugin:statusBarUpdate',
      payload: {
        items: [{ id: 'sb1', pluginId: 'tasks', text: 'ready', priority: 100, scope: 'per-session', sessionId: 's1' }],
      },
    })

    expect(emitted).toHaveLength(1)
    // 事件级 sessionId 来自 payload 顶层（statusBarUpdate 无，故 undefined）；item 级 sessionId 保留在 items 内
    expect(emitted[0]).toMatchObject({ kind: 'plugin-status-bar-update', items: [{ id: 'sb1', sessionId: 's1' }] })
  })

  it('TC5: EXTENSION_BRIDGE_TYPES 字面量 5 项 + 每项行为级验证（进 bridge 产出非 error 事件）', () => {
    // 字面量锁：与 core EXTENSION_HANDLERS（message-bus-bridge.ts）的 5 个 key 精确一致
    expect(EXTENSION_BRIDGE_TYPES).toEqual([
      'extension:widget',
      'extension:widgetGui',
      'extension:status',
      'extension:notify',
      'extension.ui_request',
    ])

    // 行为级一致性：白名单每项经全链路都产出对应 kind 事件（非 kind=error）。
    // samples 的 type 是宽泛 string，无法静态收窄到 ServerMessage union 成员，做受控擦除
    // （运行时 tap emit 只按 type 路由 + 透传 payload，形状正确性由 core parser 校验）。
    const samples: Array<{ type: string; payload: Record<string, unknown> }> = [
      { type: 'extension:widget', payload: { sessionId: 's1', widgetKey: 'w1', lines: ['line'] } },
      { type: 'extension:widgetGui', payload: { sessionId: 's1', widgetKey: 'w1', gui: ['g'] } },
      { type: 'extension:status', payload: { sessionId: 's1', statusKey: 'k', text: 'ready' } },
      { type: 'extension:notify', payload: { sessionId: 's1', message: 'hi', level: 'info' } },
      { type: 'extension.ui_request', payload: { sessionId: 's1', requestId: 'r1', method: 'select' } },
    ]
    for (const s of samples) {
      const { bus, bridge: b } = makeBridge()
      bridge = b
      const { emitted } = spyEmit(bus)
      dispatchCrossSession({ type: s.type, payload: s.payload } as never)
      expect(emitted).toHaveLength(1)
      expect(emitted[0].kind).not.toBe('error')
    }
  })
})

describe('initExtensionHostBridge provide CompanionBand 契约（FR2/FR7，TC10）', () => {
  let bridge: MessageBusBridge | null = null

  afterEach(() => {
    bridge?.dispose()
    bridge = null
  })

  it('TC10: provide DIALOG_REQUEST_SOURCE_KEY + UI_RESPONSE_TRANSPORT_KEY（形状正确）', () => {
    const provided: Array<{ key: unknown; value: unknown }> = []
    const app = {
      provide(key: unknown, value: unknown) {
        provided.push({ key, value })
        return app
      },
    }

    const result = initExtensionHostBridge(app as never)
    bridge = result.bridge

    const sourceProvided = provided.find((p) => p.key === DIALOG_REQUEST_SOURCE_KEY)
    const transportProvided = provided.find((p) => p.key === UI_RESPONSE_TRANSPORT_KEY)

    expect(sourceProvided).toBeDefined()
    const source = sourceProvided?.value as { onUiRequest: unknown; onUiTimeout: unknown }
    expect(typeof source.onUiRequest).toBe('function')
    expect(typeof source.onUiTimeout).toBe('function')

    expect(transportProvided).toBeDefined()
    const transport = transportProvided?.value as { sendPiResponse: unknown; sendPluginResponse: unknown }
    expect(typeof transport.sendPiResponse).toBe('function')
    expect(typeof transport.sendPluginResponse).toBe('function')
  })
})

describe('MF-2 响应式桥（分区后建时序 + global scope）', () => {
  let bridge: MessageBusBridge | null = null

  afterEach(() => {
    bridge?.dispose()
    bridge = null
  })

  /** 装配真实 bridge 链（events → source → bus → store → provide），返回注入的数据源。 */
  function initBridgeSources(): { viewHostSource: ViewHostSource; statusBarSource: StatusBarSource } {
    const provided: Array<{ key: unknown; value: unknown }> = []
    const app = {
      provide(key: unknown, value: unknown) {
        provided.push({ key, value })
        return app
      },
    }
    const result = initExtensionHostBridge(app as never)
    bridge = result.bridge
    const viewHostSource = provided.find((p) => p.key === VIEW_HOST_SOURCE_KEY)?.value as ViewHostSource
    const statusBarSource = provided.find((p) => p.key === STATUS_BAR_SOURCE_KEY)?.value as StatusBarSource
    return { viewHostSource, statusBarSource }
  }

  it('case B: 分区后建时序——computed 首次求值无分区，首个 viewUpdate 到达后重算命中', async () => {
    const { viewHostSource } = initBridgeSources()
    // 模拟 ViewHost.vue 的 computed 读路径：先于任何事件求值（分区尚不存在 → 短路 undefined）
    const view = computed(() => viewHostSource.getView('s1', 'sidebar.tab'))
    expect(view.value).toBeUndefined()

    // 首个 viewUpdate 到达 → ViewHostStore 惰性建分区 + setView（R1 修复前外层普通 Map，
    // set 不触发 → 此 computed 永久 stale，panel.header 常挂组件时序直接命中）
    dispatchCrossSession({
      type: 'plugin:viewUpdate',
      payload: {
        sessionId: 's1',
        viewId: 'sidebar.tab',
        pluginId: 'p1',
        guiTree: [{ type: 'ansi-text', props: { lines: ['hello'] } }],
        updatedAt: 1,
      },
    })
    await nextTick()
    expect(view.value).toMatchObject({ viewId: 'sidebar.tab', pluginId: 'p1' })
  })

  it('global scope: statusBarUpdate 广播 → getItems("global") computed 重算（不再 stale）', async () => {
    const { statusBarSource } = initBridgeSources()
    // 模拟 StatusBar.vue 的 visibleItems computed：global 项读路径
    const items = computed(() => statusBarSource.getItems('global'))
    expect(items.value).toHaveLength(0)

    dispatchGlobal({
      type: 'plugin:statusBarUpdate',
      payload: {
        items: [{ id: 'g1', pluginId: 'statusline', text: '3 tasks', alignment: 'left', priority: 100, scope: 'global' }],
      },
    })
    await nextTick()
    // R1 前：controller 私有 raw 数组 replaceAllWith 原地 mutate 不经 proxy → 永不更新
    expect(items.value.map((i) => i.id)).toEqual(['g1'])
  })

  it('TC7 (M17): extension:widgetGui 帧 → provide 的 getViewIds 纯透传 ViewHostStore 枚举', async () => {
    const { viewHostSource } = initBridgeSources()
    // 初始该 session 无 widget：枚举为空
    expect(viewHostSource.getViewIds('s1')).toEqual([])

    // 经 bridge 的 WS 消息源推一条 extension:widgetGui（widgetKey=todo + 合法 GuiComponent）：
    // events crossSession 通道 → source filter（白名单）→ MessageBusBridge 归一
    // extension-widget（viewId←widgetKey）→ ViewHostStore setView
    dispatchCrossSession({
      type: 'extension:widgetGui',
      payload: {
        sessionId: 's1',
        widgetKey: 'todo',
        gui: { type: 'ansi-text', props: { lines: ['buy milk'] } },
      },
    })
    await nextTick()

    // provide 出的 getViewIds 返回该 widget 的 viewId（widgetKey 裸值），与 store 一致
    expect(viewHostSource.getViewIds('s1')).toEqual(['todo'])
    // 枚举出的 id 可经同一 source.getView 查到缓存条目（透传链路自洽）
    expect(viewHostSource.getView('s1', 'todo')).toMatchObject({ viewId: 'todo', pluginId: '' })

    // 其他 session 分区不受污染
    expect(viewHostSource.getViewIds('s2')).toEqual([])
  })
})

describe('MF-1 挂载点上报时序（mountPoints.sync 连接就绪后发送）', () => {
  let bridge: MessageBusBridge | null = null

  beforeEach(() => {
    vi.useFakeTimers()
    transportSendSpy.mockClear()
    providePlatform(createMockPlatform())
  })

  afterEach(() => {
    bridge?.dispose()
    bridge = null
    disconnect() // 复位 ws-client 状态（防泄漏到后续用例）
    vi.useRealTimers()
  })

  function initBridge() {
    const provided: Array<{ key: unknown; value: unknown }> = []
    const app = {
      provide(key: unknown, value: unknown) {
        provided.push({ key, value })
        return app
      },
    }
    const result = initExtensionHostBridge(app as never)
    bridge = result.bridge
  }

  it('TC11: 初始未连接不发送；首次建连进入 connected 后补发全量挂载点', async () => {
    initBridge()

    // init 时 WS 未建连（main.ts 模块体同步执行先于 App.vue onMounted 建连）：不得发送
    // （旧实现此处 send 被 ws-client 非 OPEN return false 静默丢弃）
    expect(transportSendSpy).not.toHaveBeenCalled()

    connect('mock://extension-host-test')
    await vi.advanceTimersByTimeAsync(200) // mock WS connecting→connected（200ms）

    expect(transportSendSpy).toHaveBeenCalledTimes(1)
    expect(transportSendSpy).toHaveBeenCalledWith({
      type: 'plugin.mountPoints.sync',
      payload: { mountPoints: ['sidebar.tab', 'panel.header', 'composer.toolbar', 'statusbar'] },
    })
  })

  it('TC12: runtime 重启重连（断开→重连）→ connected 再次补发（overwrite 幂等）', async () => {
    initBridge()

    connect('mock://extension-host-test')
    await vi.advanceTimersByTimeAsync(200)
    expect(transportSendSpy).toHaveBeenCalledTimes(1)

    // runtime 重启：旧 WS 断开 → 重连 → 再次 connected → 补发（syncMountPoints overwrite 幂等）
    disconnect()
    expect(transportSendSpy).toHaveBeenCalledTimes(1)
    connect('mock://extension-host-test')
    await vi.advanceTimersByTimeAsync(200)

    expect(transportSendSpy).toHaveBeenCalledTimes(2)
    expect(transportSendSpy).toHaveBeenLastCalledWith({
      type: 'plugin.mountPoints.sync',
      payload: { mountPoints: ['sidebar.tab', 'panel.header', 'composer.toolbar', 'statusbar'] },
    })
  })
})
