/**
 * useExtensionHostBridge.test.ts —— createWsPluginMessageSource 过滤条件单测（FR1/AC1）。
 *
 * 链路：getRawMessageTap().emit（模拟 transport 层 routeInbound 前的只读旁路）→ source →
 * MessageBusBridge → bus。不 mock tap 层——AC1 明确要求经 raw tap 全链路验证
 * （source 数据源已从 onGlobal 改为 raw message tap：routeInbound 用 payload.sessionId 路由，
 * 有 sid 的 plugin:/extension: 下行走 dispatchSession 不触发 onGlobal，故改用 routeInbound
 * 前的只读旁路 tap 捕获不分通道的全部下行）。
 *
 * 覆盖：TC1 plugin:uiRequest 前缀放行 / TC2 extension.ui_request 白名单放行（归一 kind=ui-request）/
 * TC3 extension.error 非白名单拒绝 / TC4 plugin:statusBarUpdate 前缀回归 /
 * TC5 白名单 5 项字面量 + 行为级验证（防与 core EXTENSION_HANDLERS 漂移）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { InternalEventBus, MessageBusBridge, getRawMessageTap } from '@xyz-agent/core'
import type { InternalEvent } from '@xyz-agent/core'
import { createWsPluginMessageSource, EXTENSION_BRIDGE_TYPES, initExtensionHostBridge } from '../useExtensionHostBridge'
import { DIALOG_REQUEST_SOURCE_KEY, UI_RESPONSE_TRANSPORT_KEY } from '@xyz-agent/ui/extension-host'

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

    getRawMessageTap().emit({
      type: 'plugin:uiRequest',
      payload: { sessionId: 's1', requestId: 'r1', method: 'select', options: ['a', 'b'] },
    })

    expect(emitted).toHaveLength(1)
    expect(emitted[0]).toMatchObject({ kind: 'ui-request', sessionId: 's1' })
    expect(emitted[0]).not.toMatchObject({ kind: 'error' })
  })

  it('TC2: extension.ui_request 白名单放行 → bus 收到 kind=ui-request（与 plugin:uiRequest 归一）', () => {
    const { bus, bridge: b } = makeBridge()
    bridge = b
    const { emitted } = spyEmit(bus)

    getRawMessageTap().emit({
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

    getRawMessageTap().emit({ type: 'extension.error', payload: { sessionId: 's1', code: 'boom' } })

    expect(emitted).toHaveLength(0)
  })

  it('TC4: plugin:statusBarUpdate 前缀放行不回归', () => {
    const { bus, bridge: b } = makeBridge()
    bridge = b
    const { emitted } = spyEmit(bus)

    getRawMessageTap().emit({
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
      getRawMessageTap().emit({ type: s.type, payload: s.payload } as never)
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
